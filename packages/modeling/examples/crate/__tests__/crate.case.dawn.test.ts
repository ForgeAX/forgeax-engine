import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, type Model, sel } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frameModel,
  frameSnapshot,
  highlighted,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { buildCrate, CRATE_DEFAULTS, type CrateParameters } from '../crate';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders small frames and
 * checks each is non-empty; with FORGEAX_CASE_OUT set it writes the
 * case directory: one image per step from a fixed camera, final views, history.json,
 * validate.json and a source snapshot.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 800;
const SOURCE = fileURLToPath(new URL('../crate.ts', import.meta.url));
const VARIANT: CrateParameters = { width: 1.1, height: 0.65, depth: 0.6 };

const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  metal: [0.32, 0.33, 0.36],
  panel: [0.2, 0.36, 0.3],
  trim: [0.85, 0.5, 0.14],
  highlight: [0.95, 0.2, 0.55],
} as const;

describe('C-001 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step and the final views', { timeout: 600000 }, async () => {
    const recording = recordingSessions();
    const crate = buildCrate(CRATE_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const variant = buildCrate(VARIANT);
    const main = frameModel(recording.sessions.get('crate') as Model);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['metal'],
      view: main,
    });
    try {
      // Parts are small pieces assembled elsewhere: frame each of their steps on its own state.
      const stepCamera = (step: RecordedStep) =>
        step.session === 'crate' ? main : frameSnapshot(step.snapshot);
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(stepCamera(step));
        const png = await r.render(stateMesh(step.snapshot, touched(step)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      r.aim(main);
      const exported = crate.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.04);
      // Feature Lab parity (Engine apps/feature-lab editable-modeling): 60 completed
      // frames of the default and the variant crate differ by the Lab's mean threshold.
      const variantMesh = variant.toMesh({ normals: { mode: 'weighted' } });
      if (!variantMesh.ok) throw variantMesh.error;
      const settled = await r.render(exported.value.mesh, [], 60);
      const resized = await r.render(variantMesh.value.mesh, [], 60);
      let difference = 0;
      for (let i = 0; i < settled.data.length; i += 4)
        for (let c = 0; c < 3; c++)
          difference += Math.abs((settled.data[i + c] as number) - (resized.data[i + c] as number));
      expect(difference / ((settled.data.length / 4) * 3 * 255)).toBeGreaterThan(0.004);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const labels = labelMesh(crate);
      const stable = sel.createdBy('recess', 'top').or(sel.createdBy('lid-boss', 'top'));
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel': await r.render(highlighted(crate, stable)),
        'V-diff': await (async () => {
          r.aim(frameModel(variant));
          const png = await r.render(highlighted(variant, stable));
          r.aim(main);
          return png;
        })(),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      copyFileSync(SOURCE, join(OUT, 'source', 'crate.ts'));
      const validation = crate.validate();
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const count = (m: Model, selector: FaceSelector) => m.count(selector);
      const history = {
        case: 'C-001',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/crate/crate.ts',
        },
        parameters: CRATE_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: "crate steps and final views share one fixed camera framing the finished crate; part sessions (handle, rivet, lidPlate, hinge) are framed per step on their own state",
          crate: main,
        },
        highlight: 'each step image shows the faces the step touched (its label, or its selector re-evaluated on the result) in magenta',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        final: {
          verts: crate.inspect().vertices,
          edges: crate.inspect().edges,
          faces: crate.inspect().faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          labels: crate.inspect().labels,
          tags: crate.inspect().tags,
          validate: 'validate.json',
        },
        stability: {
          variant: VARIANT,
          selections: Object.fromEntries(
            [
              ["createdBy('recess','top')", sel.createdBy('recess', 'top')],
              ["createdBy('lid-boss','top')", sel.createdBy('lid-boss', 'top')],
              ["createdBy('skirt','top')", sel.createdBy('skirt', 'top')],
              ["createdBy('panel','rim')", sel.createdBy('panel', 'rim')],
              ["tag('metal')", sel.tag('metal')],
              ["material('panel')", sel.material('panel')],
            ].map(([name, selector]) => [
              name as string,
              {
                base: count(crate, selector as FaceSelector),
                variant: count(variant, selector as FaceSelector),
              },
            ]),
          ),
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: { 'V-tags': labels.legend, 'V-sel': "createdBy('recess','top') or createdBy('lid-boss','top')" },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
