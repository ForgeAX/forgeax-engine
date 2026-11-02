import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '@forgeax/engine/image/png';
import type { AssetHandle } from '@forgeax/engine/types';
import { describe, expect, it } from 'vitest';
import panelsPack from '../../../packages/modeling/examples/body-panels/panels.pack.ts';
import limbPack from '../../../packages/modeling/examples/transforming-limb/limb.pack.ts';
import { C111_SEGMENTS, C111_SUBJECTS } from '../assets/show/c111.ts';
import { cueAt, type ShowSegmentKind, type StagePose, stagePose, timelineSeconds } from '../assets/show/director.ts';
import showPack from '../assets/show.pack.ts';
import { createShow, SHOW_DISC_KEY, SHOW_PACKAGE_ID, type Show, showDiscMaterial } from '../assets/show/show.ts';
import { packGuid, resolveSubjects } from '../assets/show/subjects.ts';
import { createDawnStage, type DawnStage, type PackOutputs, publishPackOutputs } from '../scripts/dawn-stage.ts';

/**
 * The Show on the real Renderer (Dawn): C-111 = the C-107 limb and the C-106 panels.
 * Falsifiers seek fixed cues with the camera and turntable held, so each compared pair
 * differs only in its beat's own variable (a beat whose owner does nothing compares
 * equal); then 60 completed frames play the whole timeline with the real choreography.
 * With FORGEAX_SHOW_OUT set it writes the evidence cues, the frame sequence and the cue
 * of every frame.
 */
const OUT = process.env.FORGEAX_SHOW_OUT;
const WIDTH = OUT === undefined ? 320 : 960;
const HEIGHT = OUT === undefined ? 180 : 540;
const SEQUENCE = Number(process.env.FORGEAX_SHOW_FRAMES ?? 60);

function build(pack: typeof limbPack | typeof panelsPack): PackOutputs {
  const values = Object.fromEntries(
    ('parameters' in pack ? pack.parameters : []).map((p: { name: string; default: unknown }) => [p.name, p.default]),
  );
  const result = (pack.build as (c: unknown) => { ok: boolean; value?: PackOutputs; error?: unknown })({
    packageId: pack.packageId,
    values,
  });
  if (!result.ok) throw result.error;
  return result.value as PackOutputs;
}

/** Mean absolute RGB difference per pixel, 0..1. */
function difference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs((a[i] as number) - (b[i] as number));
    sum += Math.abs((a[i + 1] as number) - (b[i + 1] as number));
    sum += Math.abs((a[i + 2] as number) - (b[i + 2] as number));
  }
  return sum / (a.length / 4) / 3 / 255;
}

describe('modeling Show (C-111) on the real Renderer', () => {
  it('drives turntable, transformation, explode, section, X-ray and history through Engine owners', { timeout: 900_000 }, async () => {
    const stage: DawnStage = await createDawnStage(WIDTH, HEIGHT);
    let show: Show | undefined;
    try {
      const packs = [limbPack, panelsPack].map((pack) => ({ packageId: pack.packageId, outputs: build(pack) }));
      // The Show's own Pack contributes the cooked polished disc.
      packs.push({ packageId: showPack.packageId, outputs: { [SHOW_DISC_KEY]: showDiscMaterial() } as PackOutputs });
      const handles = await publishPackOutputs(stage.assets, packs);
      const disc = handles.get(packGuid(SHOW_PACKAGE_ID, SHOW_DISC_KEY)) as AssetHandle<'material'> | undefined;
      if (disc === undefined) throw new Error('no published Show disc');
      const subjects = await resolveSubjects(C111_SUBJECTS, async (guid) => {
        const handle = handles.get(guid);
        if (handle === undefined) throw new Error(`no published asset ${guid}`);
        return handle;
      });
      // Falsifiers hold one camera and keep the turntable still outside turntable beats.
      let held = true;
      const pose = (kind: ShowSegmentKind, u: number): StagePose => {
        const choreography = stagePose(kind, u);
        if (!held) return choreography;
        return { ...choreography, spin: kind === 'turntable' ? choreography.spin : 0, camera: { rail: 'orbit', u: 0.1 } };
      };
      show = createShow(stage.world, stage.assets, {
        subjects,
        segments: C111_SEGMENTS,
        aspect: WIDTH / HEIGHT,
        pose,
        disc,
        renderTargets: stage.renderTargets,
      });
      const cues: object[] = [];
      const at = async (segment: number, u: number) => {
        show?.command({ kind: 'pause' });
        show?.command({ kind: 'seek', segment, u });
        const rgba = await stage.frame(0, 3);
        expect(show?.state().segment).toBe(segment);
        if (OUT !== undefined && !held) {
          mkdirSync(join(OUT, 'cues'), { recursive: true });
          const name = `${segment}-${C111_SEGMENTS[segment]?.kind}-${Math.round(u * 100)}.png`;
          writeFileSync(join(OUT, 'cues', name), encodePng(WIDTH, HEIGHT, rgba));
          cues.push({ image: `cues/${name}`, ...(show?.state() as object) });
        }
        return rgba;
      };
      const checks: Record<string, number> = {};
      // The second subject before the first subject's beats have run.
      const panelsFirst = await at(6, 0);
      // Turntable: only the spin differs.
      const turn0 = await at(0, 0);
      checks.turntable = difference(turn0, await at(0, 0.25));
      // Transformation: the first form against the last.
      checks.transform = difference(await at(1, 0), await at(1, 1));
      // Explode: assembled against fully exploded.
      checks.explode = difference(await at(2, 0), await at(2, 0.55));
      // Section: the plane near the edge against the plane through the middle.
      checks.section = difference(await at(3, 0), await at(3, 0.5));
      // X-ray: same pose as the turntable at u = 0, shells swapped for the X-ray material.
      const xrayOn = await at(4, 0);
      checks.xray = difference(xrayOn, turn0);
      // Under X-ray the internals move: the robot form (u = 0.6, path held at 1).
      checks.xrayTransform = difference(xrayOn, await at(4, 0.6));
      // History: the first state against the finished build.
      const first = await at(5, 0);
      const firstStep = show.state().step;
      const last = await at(5, 0.999);
      const lastStep = show.state().step;
      checks.history = difference(first, last);
      // Second subject: it replaces the first, and nothing of the first stays on stage.
      const panels = await at(6, 0);
      checks.panels = difference(panels, turn0);
      checks.offStage = difference(panels, panelsFirst);
      console.log(JSON.stringify({ checks, firstStep, lastStep }, null, 1));
      // A beat whose owner does nothing compares exactly equal (0); intact beats measure 0.005-0.015 at 320x180.
      expect(checks.turntable).toBeGreaterThan(0.002);
      expect(checks.transform).toBeGreaterThan(0.002);
      expect(checks.explode).toBeGreaterThan(0.002);
      expect(checks.section).toBeGreaterThan(0.002);
      expect(checks.xray).toBeGreaterThan(0.002);
      expect(checks.xrayTransform).toBeGreaterThan(0.002);
      expect(checks.history).toBeGreaterThan(0.002);
      expect(checks.panels).toBeGreaterThan(0.004);
      expect(checks.offStage).toBeLessThan(0.0005);
      expect(firstStep?.index).toBe(0);
      expect(lastStep?.index).toBe((lastStep?.count ?? 0) - 1);
      expect(lastStep?.faces).toBeGreaterThan(firstStep?.faces ?? Infinity);
      // The history names the author line of the build source.
      expect(firstStep?.source?.path).toMatch(/transforming-limb\/limb\.ts$/);
      expect(firstStep?.source?.line).toBeGreaterThan(80);

      held = false;
      if (OUT !== undefined) {
        // Evidence: every beat with the real camera, the history at several steps, the second subject.
        const evidence: (readonly [number, number])[] = [
          [0, 0], [0, 0.25], [1, 0], [1, 0.5], [1, 1], [2, 0], [2, 0.55], [3, 0], [3, 0.5], [4, 0], [4, 0.6],
          [5, 0], [5, 0.15], [5, 0.3], [5, 0.45], [5, 0.6], [5, 0.75], [5, 0.9], [5, 0.999],
          [6, 0], [7, 0.5], [8, 0], [8, 0.5], [8, 0.999],
        ];
        for (const [segment, u] of evidence) await at(segment, u);
      }
      // Play: completed frames across the whole timeline (one frame per 1/SEQUENCE of it).
      show.command({ kind: 'seek', segment: 0, u: 0 });
      show.command({ kind: 'play' });
      const dt = timelineSeconds(C111_SEGMENTS) / SEQUENCE;
      const frames: { frame: number; time: number; segment: number; kind: string; subject: string; u: number; step?: unknown }[] = [];
      if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
      let previous: Uint8Array | undefined;
      let changed = 0;
      for (let frame = 0; frame < SEQUENCE; frame++) {
        const rgba = await stage.frame(frame === 0 ? 0 : dt);
        const state = show.state();
        frames.push({ frame, time: state.time, segment: state.segment, kind: state.kind, subject: state.subject, u: state.u, ...(state.step === undefined ? {} : { step: state.step }) });
        if (previous !== undefined && difference(previous, rgba) > 0.001) changed++;
        previous = rgba;
        if (OUT !== undefined) writeFileSync(join(OUT, `frame-${String(frame).padStart(4, '0')}.png`), encodePng(WIDTH, HEIGHT, rgba));
      }
      if (OUT !== undefined) writeFileSync(join(OUT, 'frames.json'), JSON.stringify({ width: WIDTH, height: HEIGHT, dt, checks, cues, frames }, null, 1));
      expect(frames).toHaveLength(SEQUENCE);
      expect(new Set(frames.map((f) => f.kind)).size).toBe(6);
      expect(changed).toBeGreaterThan(SEQUENCE * 0.8);
      expect(cueAt(C111_SEGMENTS, frames.at(-1)?.time ?? 0).index).toBe(C111_SEGMENTS.length - 1);
      expect(stage.errors()).toEqual([]);
    } finally {
      // A failed frame poisons the World; keep the original failure.
      try {
        show?.dispose();
      } catch (error) {
        console.error('show dispose:', String(error));
      }
      await stage.dispose();
    }
  });
});
