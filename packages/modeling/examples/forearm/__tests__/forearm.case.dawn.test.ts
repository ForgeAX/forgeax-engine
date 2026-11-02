import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, type Model, model, sel } from '@forgeax/engine-modeling';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frame,
  frameSnapshot,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { buildForearm, compareFits, ELBOW, FOREARM_DEFAULTS, WRIST_Y, ZONES } from '../forearm';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step and the
 * fitted, bent and blank guards on the posed arm; with FORGEAX_CASE_OUT set it writes the
 * case output directory: one image per step, final views, history.json,
 * validate.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../forearm.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIRECTION = [1, 0.12, 0.1];

const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  paint: [0.85, 0.55, 0.08],
  trim: [0.12, 0.12, 0.13],
  bone: [0.3, 0.5, 0.75],
  chest: [0.2, 0.75, 0.4],
  highlight: [0.95, 0.2, 0.55],
} as const;

const rows = (y: readonly [number, number]) => sel.inBox([-1, y[0] + ELBOW[1], -1], [2, y[1] + ELBOW[1], 1]);

/** Pose-preview arm (not part of the asset): upper arm, forearm bone and hand, posed in the forearm frame. */
function arm(): Model {
  const a = model();
  const p = FOREARM_DEFAULTS;
  a.cylinder({ radiusTop: 0.075, radiusBottom: 0.075, height: 0.55, radialSegments: 16, center: [0, 0.275, 0], tag: 'upper', material: 'bone' });
  a.rotate(sel.tag('upper'), 'x', p.elbow, [0, 0, 0]);
  a.cylinder({ radiusTop: 0.06, radiusBottom: 0.05, height: -WRIST_Y, radialSegments: 16, center: [0, WRIST_Y / 2, 0], tag: 'bone', material: 'bone' });
  a.sphere({ radius: 0.085, widthSegments: 16, heightSegments: 10, center: [0, 0, 0], tag: 'joint', material: 'bone' });
  a.box({ size: [0.09, 0.2, 0.13], center: [0, WRIST_Y - 0.12, 0], tag: 'hand', material: 'bone' });
  a.rotate(sel.tag('hand'), 'x', -p.wrist, [0, WRIST_Y, 0]);
  a.translate(sel.all(), [...ELBOW]);
  return a;
}

function slotted(snapshot: Uint8Array, slots: readonly [FaceSelector, string][], withArm: boolean): MeshAsset {
  const view = model();
  view.append(snapshot);
  for (const [selector, slot] of slots) if (view.count(selector) > 0) view.assign(selector, slot);
  if (withArm) view.append(arm());
  view.uv.project({ mode: 'box', scale: 0.25 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** A snapshot placed on the elbow like the finished sessions (the blank is built in the forearm frame). */
function placed(snapshot: Uint8Array): Uint8Array {
  const m = model();
  m.append(snapshot);
  m.translate(sel.all(), [...ELBOW]);
  return m.snapshot();
}

function changedPixels(a: PNG, b: PNG): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs((a.data[i] as number) - (b.data[i] as number)) > 12) changed++;
  }
  return changed;
}

describe('C-016 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step and the fit comparison', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const guard = buildForearm(FOREARM_DEFAULTS, recording.session);
    expect(guard.poisoned).toBeUndefined();
    const bent = recording.sessions.get('bent') as Model;
    expect(bent.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    const stepOf = (session: string, op: string) => steps.find((s) => s.session === session && s.entry.op === op) as RecordedStep & { line: number };
    const blank = placed(stepOf('forearm', 'markSharp').snapshot);
    const fitted = stepOf('forearm', 'arap');
    const faired = stepOf('forearm', 'smooth.implicit');
    const main = frameSnapshot(guard.snapshot(), DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['trim'],
      view: main,
    });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        const png = await r.render(stateMesh(step.snapshot, touched(step)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      const armView = frame(
        { min: [ELBOW[0] - 0.35, ELBOW[1] - 1.05, ELBOW[2] - 0.35], max: [ELBOW[0] + 0.35, ELBOW[1] + 0.5, ELBOW[2] + 0.55] },
        CASE_FOV,
        DIRECTION,
      );
      r.aim(armView);
      const fitPng = await r.render(slotted(guard.snapshot(), [], true));
      const bendPng = await r.render(slotted(bent.snapshot(), [], true));
      const blankPng = await r.render(slotted(blank, [], true));
      expect(r.covered(fitPng)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      // Falsifiers: the ARAP fit visibly differs from the blank and from the plain bend.
      expect(changedPixels(fitPng, blankPng)).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
      expect(changedPixels(fitPng, bendPng)).toBeGreaterThan(WIDTH * HEIGHT * 0.002);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const at = async (view: ReturnType<typeof frameSnapshot>, mesh: MeshAsset, legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      // The fitted and faired states are still in the forearm frame (the guard is placed on the elbow later).
      const panelView = frame({ min: [-0.2, WRIST_Y - 0.12, -0.2], max: [0.2, -0.35, 0.3] }, CASE_FOV, [1, -0.1, 0.15]);
      const panel = sel.inBox([-1, ZONES.wristPanel[0], -1], [1, ZONES.wristPanel[1], 1]);
      const labels = labelMesh(guard);
      const views: Record<string, PNG> = {
        'V-shaded': await at(main, slotted(guard.snapshot(), [], false)),
        'V-tags': await at(main, labels.mesh, labels.legend),
        'V-sel': await at(
          armView,
          slotted(
            blank,
            [
              [rows(ZONES.elbowCuff).or(rows(ZONES.wristCuff)), 'highlight'],
              [rows(ZONES.pinned), 'chest'],
            ],
            false,
          ),
        ),
        'V-diff-blank': blankPng,
        'V-diff-arap': fitPng,
        'V-diff-bend': bendPng,
        'V-diff-fair-before': await at(panelView, slotted(fitted.snapshot, [[panel, 'highlight']], false)),
        'V-diff-fair-after': await at(panelView, slotted(faired.snapshot, [[panel, 'highlight']], false)),
      };
      for (const [view, png] of Object.entries(views)) {
        expect([view, r.covered(png) > WIDTH * HEIGHT * 0.02]).toEqual([view, true]);
      }
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['forearm.ts', 'forearm.pack.ts', '__tests__/forearm.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.replace('__tests__/', '')));
      }
      const validate = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === 'model.validate');
      const report = (await validate?.execute({ source: 'examples/forearm/forearm.pack.ts' } as never, {} as never)) as {
        ok: boolean;
        value?: { status: string };
      };
      expect(report.ok).toBe(true);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(report.value, null, 2)}\n`);
      const exported = guard.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const inspection = guard.inspect();
      const infoOf = (step: RecordedStep) => step.entry.diagnostics?.find((d) => d.severity === 'info')?.detail ?? {};
      const fits = compareFits(stepOf('forearm', 'markSharp').snapshot);
      const history = {
        case: 'C-016',
        title: 'ARAP: fitting a mech forearm guard to a posed arm',
        stage: 'C-100 part (forearm guard between elbow-l and wrist-l, joints.json)',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/forearm/forearm.ts',
        },
        parameters: FOREARM_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; V-diff-blank/arap/bend share the arm camera, V-diff-fair-* share the panel camera',
          part: main,
          arm: armView,
          panel: panelView,
        },
        highlight: 'each step image shows the faces the step touched (its label, or its selector re-evaluated on the result) in magenta',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        arap: {
          step: fitted.line,
          zones: ZONES,
          pose: { elbow: FOREARM_DEFAULTS.elbow, wrist: FOREARM_DEFAULTS.wrist },
          ...infoOf(fitted),
        },
        fairing: { step: faired.line, ...infoOf(faired) },
        comparison: {
          rule: 'both fits applied to copies of the blank (step markSharp) and measured on the same vertex ids; cuff error = largest distance of a cuff vertex from its rigid rotation about the joint pivot',
          arap: fits.arap,
          bend: fits.bend,
        },
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          volume: guard.validate().volume,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': labels.legend,
          'V-sel': 'the blank on the elbow: magenta, the two ARAP handles (elbow cuff above the elbow pivot, wrist cuff below the wrist pivot); green, the pinned band over the forearm bone',
          'V-diff-blank': 'the unfitted guard on the posed arm preview (blue, not part of the asset): the cuffs cut through the upper arm and hand',
          'V-diff-arap': `the ARAP fit (arap, ${FOREARM_DEFAULTS.elbow} and ${FOREARM_DEFAULTS.wrist} degree cuffs, 30 iterations) after smooth.implicit, same camera`,
          'V-diff-bend': 'the same blank fitted with two plain bend calls over the same transitions, same camera: the cuffs turn by the right angles but land off the joints',
          'V-diff-fair-before': 'the wrist panel (magenta) right after ARAP',
          'V-diff-fair-after': 'the wrist panel after smooth.implicit (lambda 0.1, 2 steps, sharp outline, band and cuff pinned, volume kept)',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
