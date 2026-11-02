import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '@forgeax/engine/image/png';
import type { PackageId } from '@forgeax/engine/pack/guid';
import { describe, expect, it } from 'vitest';
import { packFiles, packOutputs } from '../mech-gt/scripts/outputs.mts';
import { FILM_FPS, FILM_SECONDS, FILM_SEGMENTS, filmCue, filmPose } from '../assets/show/cinematic.ts';
import { MECH_GT_SUBJECTS } from '../assets/show/mech-gt.ts';
import { createShow } from '../assets/show/show.ts';
import { resolveSubjects } from '../assets/show/subjects.ts';
import { createDawnStage, type PackOutputs, publishPackOutputs } from '../scripts/dawn-stage.ts';

/**
 * Renders the mech-gt film (`assets/show/cinematic.ts`) on the real Renderer (Dawn)
 * offscreen, without UI: frame n shows film time n / FILM_FPS. Skipped unless
 * FORGEAX_MECH_GT_RECORD=<dir> is set. FORGEAX_MECH_GT_FRAMES picks frames as `a-b` (a
 * range, so parallel processes split the film) or `a,b,c` (stills); default all.
 * FORGEAX_MECH_GT_SIZE=<w>x<h> (default 1280x720). Every frame is validated: not blank or
 * near-uniform, not a stale duplicate of its predecessor, exposure within bounds.
 * Pack outputs come from `mech-gt/scripts/outputs.mts` (cached).
 */
const OUT = process.env.FORGEAX_MECH_GT_RECORD;
const TOTAL = Math.round(FILM_SECONDS * FILM_FPS);
const SPEC = process.env.FORGEAX_MECH_GT_FRAMES ?? `0-${TOTAL - 1}`;
const FRAMES = SPEC.includes('-')
  ? (([a, b]) => Array.from({ length: (b as number) - (a as number) + 1 }, (_, i) => (a as number) + i))(SPEC.split('-').map(Number))
  : SPEC.split(',').map(Number);
const [WIDTH, HEIGHT] = (process.env.FORGEAX_MECH_GT_SIZE ?? '1280x720').split('x').map(Number) as [number, number];

/** Mean and standard deviation of luminance, 0..1. */
function luminance(rgba: Uint8Array): { mean: number; deviation: number } {
  let sum = 0;
  let squares = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    const y = (0.2126 * (rgba[i] as number) + 0.7152 * (rgba[i + 1] as number) + 0.0722 * (rgba[i + 2] as number)) / 255;
    sum += y;
    squares += y * y;
  }
  const mean = sum / n;
  return { mean, deviation: Math.sqrt(Math.max(0, squares / n - mean * mean)) };
}

describe.skipIf(OUT === undefined)('mech-gt Show recording on the real Renderer', () => {
  it(`renders film frames ${SPEC}`, { timeout: 3_600_000 }, async () => {
    const out = OUT as string;
    mkdirSync(out, { recursive: true });
    // Only the subjects this frame range shows (memory: each full subject set is several GB).
    const used = [...new Set(FRAMES.map((n) => (FILM_SEGMENTS[filmCue(n / FILM_FPS).segment] as { subject: number }).subject))];
    const sources = MECH_GT_SUBJECTS.filter((_, i) => used.includes(i));
    const packages = new Map(sources.flatMap((s) => s.packs.map((p) => [p.packageId.replaceAll('-', ''), p] as const)));
    const packs: { packageId: PackageId; outputs: PackOutputs }[] = [];
    for (const file of packFiles()) {
      const { packageId, outputs } = await packOutputs(file);
      const wanted = packages.get(Buffer.from(packageId).toString('hex'));
      if (wanted === undefined) continue;
      // A Pack that only paints another subject's parts publishes its materials and textures, no meshes.
      const meshes = (wanted.meshes?.length ?? 0) + (wanted.scenes?.length ?? 0) > 0;
      // The recording draws base meshes; LOD levels (and the chain referencing them) stay out.
      const base = Object.entries(outputs)
        .filter(([key]) => !/\/lod\d+$/.test(key) && (meshes || !key.startsWith('mesh/')))
        .map(([key, asset]) => {
          if (asset.kind !== 'mesh' || !('lods' in asset)) return [key, asset];
          const { lods: _lods, lodHysteresis: _hysteresis, ...mesh } = asset as typeof asset & { lods?: unknown; lodHysteresis?: unknown };
          return [key, mesh];
        });
      packs.push({ packageId: packageId as PackageId, outputs: Object.fromEntries(base) as PackOutputs });
    }
    const stage = await createDawnStage(WIDTH, HEIGHT);
    try {
      const handles = await publishPackOutputs(stage.assets, packs, join(import.meta.dirname, '../mech-gt/.cache'));
      packs.length = 0;
      const resolved = await resolveSubjects(sources, async (guid) => {
        const handle = handles.get(guid);
        if (handle === undefined) throw new Error(`no published asset ${guid}`);
        return handle;
      });
      let azimuth: number | undefined;
      const show = createShow(stage.world, stage.assets, {
        subjects: resolved,
        // Segments of subjects left out point at a loaded one; this range never seeks them.
        segments: FILM_SEGMENTS.map((s) => ({ ...s, subject: Math.max(0, used.indexOf(s.subject)) })),
        aspect: WIDTH / HEIGHT,
        pose: (kind, u, index) => {
          const pose = filmPose(kind, u, index);
          return azimuth === undefined || pose.shot === undefined ? pose : { ...pose, shot: { ...pose.shot, azimuth } };
        },
      });
      const { createHash } = await import('node:crypto');
      const report: { frame: number; t: number; mean: number; deviation: number; hash: string }[] = [];
      for (const n of FRAMES) {
        const t = n / FILM_FPS;
        const cue = filmCue(t);
        show.command({ kind: 'pause' });
        show.command({ kind: 'seek', segment: cue.segment, u: cue.u });
        const rgba = await stage.frame(0, 2);
        expect(show.state().segment).toBe(cue.segment);
        report.push({ frame: n, t, ...luminance(rgba), hash: createHash('sha256').update(rgba).digest('hex') });
        writeFileSync(join(out, `frame-${String(n).padStart(4, '0')}.png`), encodePng(WIDTH, HEIGHT, rgba));
      }
      // FORGEAX_MECH_GT_PROBE=<deg,...>: the last frame again from each azimuth (subject frame).
      for (const degrees of (process.env.FORGEAX_MECH_GT_PROBE ?? '').split(',').filter(Boolean).map(Number)) {
        azimuth = (degrees * Math.PI) / 180;
        const cue = filmCue((FRAMES.at(-1) as number) / FILM_FPS);
        show.command({ kind: 'seek', segment: cue.segment, u: cue.u });
        writeFileSync(join(out, `probe-${degrees}.png`), encodePng(WIDTH, HEIGHT, await stage.frame(0, 2)));
      }
      // FORGEAX_MECH_GT_TONEMAPS=<name,...>: the last frame again under each tonemap (render TONEMAP_* names).
      const tonemaps = (process.env.FORGEAX_MECH_GT_TONEMAPS ?? '').split(',').filter(Boolean);
      if (tonemaps.length > 0) {
        const render = await import('@forgeax/engine/render');
        const [camera] = [...stage.world.query({ with: [render.Camera] }).unwrap()].map((row) => row.entity);
        const cue = filmCue((FRAMES.at(-1) as number) / FILM_FPS);
        for (const name of tonemaps) {
          const tonemap = (render as unknown as Record<string, number>)[`TONEMAP_${name.toUpperCase()}`];
          if (tonemap === undefined || camera === undefined) throw new Error(`no tonemap ${name}`);
          stage.world.set(camera, render.Camera, { tonemap } as never).unwrap();
          show.command({ kind: 'seek', segment: cue.segment, u: cue.u });
          writeFileSync(join(out, `tonemap-${name}.png`), encodePng(WIDTH, HEIGHT, await stage.frame(0, 2)));
        }
      }
      show.dispose();
      const blank = report.filter((r) => r.deviation < 0.02).map((r) => r.frame);
      const stale = report.filter((r, i) => i > 0 && r.hash === report[i - 1]?.hash).map((r) => r.frame);
      const exposure = report.filter((r) => r.mean < 0.04 || r.mean > 0.7).map((r) => r.frame);
      writeFileSync(join(out, `report-${FRAMES[0]}-${FRAMES.at(-1)}-${FRAMES.length}.json`), JSON.stringify({ blank, stale, exposure, frames: report }, null, 1));
      expect(stage.errors()).toEqual([]);
      expect({ blank, stale, exposure }).toEqual({ blank: [], stale: [], exposure: [] });
    } finally {
      await stage.dispose();
    }
  });
});
