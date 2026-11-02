import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, model, sel } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frame,
  frameModel,
  historyStep,
  labelMesh,
  stateMesh,
  type View,
} from '../../case/render';
import { buildTunic, TUNIC } from '../tunic';

/**
 * Case evidence on the real Renderer (Dawn). Every step is drawn from a close-up
 * camera on the region it edits; the artist operators (soft move, layer, shrinkwrap,
 * both knives) are also drawn before the step from the same camera. In CI it renders
 * small frames and checks they are non-empty; with FORGEAX_CASE_OUT set it writes the
 * case output directory.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 180 : 900;
const SOURCE = fileURLToPath(new URL('../tunic.ts', import.meta.url));

const SLOT_COLORS = {
  Default: [0.78, 0.66, 0.58],
  cloth: [0.22, 0.27, 0.45],
  highlight: [0.95, 0.2, 0.55],
} as const;

/** Per operation index: the region shown (and highlighted) and the camera direction. */
const FOCUS: readonly { readonly region: FaceSelector; readonly direction: readonly number[] }[] = [
  { region: sel.tag('body'), direction: [0.56, 0.42, 0.71] },
  { region: sel.tag('body').and(sel.inBox([-0.1, 0.25, 0.05], [0.1, 0.36, 1], { by: 'centroid' })), direction: [0.97, 0.1, 0.2] },
  { region: sel.createdBy('bodice'), direction: [0.7, 0.25, 0.67] },
  { region: sel.tag('skirt'), direction: [0.6, 0.35, 0.72] },
  { region: sel.tag('skirt').and(sel.inBox([-1, 0.1, -1], [1, 1, 1], { by: 'any' })), direction: [0.95, 0.15, 0.3] },
  { region: sel.tag('dress').and(sel.inBox([-0.1, 0.25, 0], [0.1, 0.4, 1], { by: 'any' })), direction: [0.15, 0.2, 0.97] },
  { region: sel.tag('dress').and(sel.inBox([-0.1, 0.25, 0], [0.1, 0.4, 1], { by: 'any' })), direction: [0.35, 0.3, 0.89] },
  { region: sel.tag('skirt').and(sel.inBox([0.05, -1, 0], [1, 0.2, 1], { by: 'any' })), direction: [0.8, 0.1, 0.6] },
  { region: sel.all(), direction: [0.56, 0.42, 0.71] },
];
/** Operation indices drawn before and after (tool cards). */
const ARTIST = new Map([
  [1, 'T-soft'],
  [2, 'T-layer'],
  [4, 'T-shrinkwrap'],
  [5, 'T-knife'],
  [7, 'T-knife'],
]);

function closeUp(snapshot: Uint8Array, focus: (typeof FOCUS)[number]): View {
  const state = model();
  state.append(snapshot);
  const bounds = state.bounds(state.count(focus.region) > 0 ? focus.region : sel.all());
  if (!bounds.ok) throw bounds.error;
  return frame(bounds.value, CASE_FOV, focus.direction);
}

describe('C-113 case evidence on the real renderer (Dawn)', () => {
  it('renders every step from its close-up camera, before and after', { timeout: 600000 }, async () => {
    const recording = recordingSessions();
    const tunic = buildTunic(recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps).toHaveLength(FOCUS.length);
    const main = frameModel(tunic);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOT_COLORS, view: main });
    try {
      const images: PNG[] = [];
      const before = new Map<number, PNG>();
      let previous: RecordedStep | undefined;
      for (const [i, step] of steps.entries()) {
        const focus = FOCUS[i] as (typeof FOCUS)[number];
        if (OUT === undefined && i !== steps.length - 2) {
          previous = step;
          continue;
        }
        const camera = closeUp(step.snapshot, focus);
        r.aim(camera);
        if (ARTIST.has(i) && previous !== undefined) {
          before.set(i, await r.render(stateMesh(previous.snapshot, focus.region)));
        }
        const png = await r.render(stateMesh(step.snapshot, focus.region));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
        previous = step;
      }
      r.aim(main);
      const exported = tunic.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.04);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const labels = labelMesh(tunic);
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-tags': await r.render(labels.mesh, labels.legend),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [i, png] of before) {
        writeFileSync(join(OUT, `before-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      copyFileSync(SOURCE, join(OUT, 'source', 'tunic.ts'));
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(tunic.validate(), null, 2)}\n`);
      const inspection = tunic.inspect();
      const history = {
        case: 'C-113',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/tunic/tunic.ts',
        },
        parameters: TUNIC,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'each step is framed on the region it edits (FOCUS in the generator) after the step; artist operators also show the state before the step from the same camera (before-NN.png)',
          final: main,
        },
        highlight: 'the region each step edits in magenta, cloth slots dark blue',
        steps: steps.map((step, i) => ({
          ...historyStep(step, i + 1),
          ...(before.has(i) ? { before: `before-${String(i + 1).padStart(2, '0')}.png`, tool: ARTIST.get(i) } : {}),
        })),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: { 'V-tags': labels.legend },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
