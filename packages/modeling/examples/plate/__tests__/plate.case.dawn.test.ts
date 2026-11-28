import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as exact from '@forgeax/engine-modeling/brep';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  checkerMesh,
  checkerTexture,
  createCaseRenderer,
  frameModel,
  frameSnapshot,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { buildPlate, PLATE_DEFAULTS, PLATE_EXPORT, PLATE_SLOTS } from '../plate';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step; with
 * FORGEAX_CASE_OUT set it writes the case output directory: one image per step that
 * has a mesh (per-step renders start at fromShape, because brep.box changes no face),
 * the final views, history.json, validate.json and the sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../plate.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIRECTION = [0.55, 0.7, 0.9] as const;

const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  [PLATE_SLOTS.face]: [0.72, 0.74, 0.77],
  [PLATE_SLOTS.rim]: [0.85, 0.5, 0.2],
  highlight: [0.95, 0.2, 0.55],
} as const;

function differing(a: PNG, b: PNG): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs((a.data[i] as number) - (b.data[i] as number)) + Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)) > 24) changed++;
  }
  return changed;
}

function contactSheet(images: readonly PNG[], factor: number, columns: number): PNG {
  const w = Math.floor(WIDTH / factor);
  const h = Math.floor(HEIGHT / factor);
  const rows = Math.ceil(images.length / columns);
  const sheet = new PNG({ width: w * columns, height: h * rows });
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data[i + 3] = 255;
  for (const [i, image] of images.entries()) {
    const ox = (i % columns) * w;
    const oy = Math.floor(i / columns) * h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let dy = 0; dy < factor; dy++) {
            for (let dx = 0; dx < factor; dx++) sum += image.data[((y * factor + dy) * WIDTH + x * factor + dx) * 4 + c] as number;
          }
          sheet.data[((oy + y) * sheet.width + ox + x) * 4 + c] = Math.round(sum / (factor * factor));
        }
      }
    }
  }
  return sheet;
}

describe('C-700 steps 1 to 3 case evidence on the real renderer (Dawn)', () => {
  it('renders every step that has a mesh and the final views', { timeout: 600000 }, async () => {
    const recording = recordingSessions({ exact });
    const plate = buildPlate(PLATE_DEFAULTS, recording.session);
    expect(plate.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    const meshed = steps.filter((s) => s.faces > 0);
    expect(meshed.map((s) => s.entry.op)).toEqual(['fromShape', 'assign', 'assign']);
    const main = frameModel(plate, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      view: main,
      checker: checkerTexture(),
    });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? meshed.slice(-1) : meshed) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        const png = await r.render(stateMesh(step.snapshot, touched(step as RecordedStep)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      r.aim(main);
      const exported = plate.toMesh(PLATE_EXPORT);
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      const checker = await r.render(checkerMesh(plate.snapshot()));
      // Falsifier: the checker texture is sampled through the plate's uv0 (the image changes), and the plate still covers the frame.
      expect(differing(shaded, checker)).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const labels = labelMesh(plate);
      const views = {
        'V-shaded': shaded,
        'V-uv': checker,
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-history': contactSheet(images, 2, 3),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      const first = steps.indexOf(meshed[0] as (typeof steps)[number]);
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(first + i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      for (const file of ['plate.ts', 'plate.pack.ts', '__tests__/plate.case.dawn.test.ts', '../case/render.ts', '../case/record.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validate = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === 'model.validate');
      const report = (await validate?.execute({ source: 'examples/plate/plate.pack.ts' } as never, {} as never)) as { ok: boolean; value?: unknown };
      expect(report.ok).toBe(true);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(report.value, null, 2)}\n`);
      const shape = plate.shape('plate');
      const measure = shape === undefined ? undefined : exact.measure(shape);
      const inspection = plate.inspect();
      const history = {
        case: 'C-700',
        stage: 'exact steps 1-3 (primitive, tessellated, textured); chained holes (B-E1e) and fillet (B-E2d) follow',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/plate/plate.ts',
        },
        parameters: PLATE_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; final views frame the finished plate',
          plate: main,
        },
        highlight: 'geometry steps show the faces the step touched in magenta; fromShape highlights nothing, and each assign highlights the faces it assigned',
        note: 'Per-step renders start at fromShape: step 1 (brep.box) changes no face, so it has no image; its evidence is shape.step1',
        shape: { step1: { op: 'brep.box', name: 'plate', faces: shape?.faces.length, edges: shape?.edges.length, measure: measure?.ok ? measure.value : undefined } },
        steps: steps.map((step, i) => ({ ...historyStep(step, i + 1), image: step.faces > 0 ? `step-${String(i + 1).padStart(2, '0')}.png` : null })),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          labels: inspection.labels,
          validate: 'validate.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-shaded': 'the finished plate: large faces and rim in their own material slots (exported MeshAsset, auto-smooth 40 degrees)',
          'V-uv': 'checker on the plate uv0: equal-size cells on all six faces (one metric texel density)',
          'V-tags': labels.legend,
          'V-history': 'every step with a mesh, in order (contact sheet of the step images)',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
