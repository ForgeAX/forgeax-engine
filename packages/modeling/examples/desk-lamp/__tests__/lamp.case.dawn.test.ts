import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, type Model, model, sel } from '@forgeax/engine-modeling';
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
import { buildLamp, LAMP_DEFAULTS, type LampParameters } from '../lamp';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step and
 * the finished lamp; with FORGEAX_CASE_OUT set it writes the case output
 * directory: one image per step, final views, history.json, validate.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../lamp.ts', import.meta.url));
const TALL: LampParameters = { height: 0.32, reach: 25, shadeRadius: 0.09 };
const LOW: LampParameters = { height: 0.15, reach: 55, shadeRadius: 0.06 };
/** Lamp views look from the front-right, slightly above, so the shade mouth shows. */
const DIRECTION = [0.75, 0.35, 0.56];

const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  metal: [0.3, 0.31, 0.34],
  rubber: [0.1, 0.1, 0.11],
  enamel: [0.12, 0.36, 0.3],
  reflector: [0.92, 0.9, 0.84],
  glass: [0.98, 0.93, 0.7],
  brass: [0.78, 0.6, 0.25],
  highlight: [0.95, 0.2, 0.55],
} as const;

const STABLE: readonly [string, FaceSelector][] = [
  ["createdBy('vent-depth','top')", sel.createdBy('vent-depth', 'top')],
  ["createdBy('grip','top')", sel.createdBy('grip', 'top')],
  ["createdBy('clip-end','cap')", sel.createdBy('clip-end', 'cap')],
  ["createdBy('socket','top')", sel.createdBy('socket', 'top')],
  ["createdBy('switch','top')", sel.createdBy('switch', 'top')],
  ["thin(0.003) and createdBy('liner','top')", sel.thin(0.003).and(sel.createdBy('liner', 'top'))],
  ["tag('joint')", sel.tag('joint')],
  ["material('enamel')", sel.material('enamel')],
];

const stable = STABLE.slice(0, 5).reduce<FaceSelector>((acc, [, s]) => acc.or(s), sel.createdBy('vent-depth', 'top'));

/** Design 10.1 product reuse as a view: both lamps lifted from their exports and placed. */
function pair(): Model {
  const m = model();
  for (const [p, x] of [[LAMP_DEFAULTS, -0.2], [TALL, 0.2]] as const) {
    const out = buildLamp(p).toMesh({ normals: { mode: 'weighted' } });
    if (!out.ok) throw out.error;
    m.lift(out.value.mesh, { label: x < 0 ? 'desk' : 'tall' });
    m.translate(sel.createdBy(x < 0 ? 'desk' : 'tall'), [x, 0, 0]);
  }
  return m;
}

describe('C-002 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step and the final views', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const lamp = buildLamp(LAMP_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(lamp, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['metal', 'brass'],
      view: main,
    });
    try {
      // Every step is framed on its own state: parts and the early stand are small.
      const stepCamera = (step: RecordedStep) => frameSnapshot(step.snapshot, DIRECTION);
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(stepCamera(step));
        const png = await r.render(stateMesh(step.snapshot, touched(step)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      r.aim(main);
      const exported = lamp.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const tall = buildLamp(TALL);
      const low = buildLamp(LOW);
      const reuse = pair();
      const labels = labelMesh(lamp);
      const shadeView = frameModel(recording.sessions.get('shade') as Model, [0.2, -0.6, 0.8]);
      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const reuseMesh = reuse.toMesh({ normals: { mode: 'weighted' } });
      if (!reuseMesh.ok) throw reuseMesh.error;
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel': await r.render(highlighted(lamp, stable)),
        'V-thin': await r.render(highlighted(lamp, sel.thin(0.003))),
        'V-mouth': await at(shadeView, highlighted(recording.sessions.get('shade') as Model, sel.createdBy('liner'))),
        'V-diff-tall': await at(frameModel(tall, DIRECTION), highlighted(tall, stable)),
        'V-diff-low': await at(frameModel(low, DIRECTION), highlighted(low, stable)),
        'V-reuse': await at(frameModel(reuse, [0.3, 0.35, 0.9]), reuseMesh.value.mesh),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['lamp.ts', 'lamp.pack.ts', 'lamp-tall.pack.json', 'lamp-pair.pack.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file));
      }
      const validation = lamp.validate({ minThickness: 0.0005 });
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const inspection = lamp.inspect();
      const history = {
        case: 'C-002',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/desk-lamp/lamp.ts',
        },
        parameters: LAMP_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; final views frame the finished lamp (variants and the reuse pair on their own bounds)',
          lamp: main,
        },
        highlight: 'each step image shows the faces the step touched (its label, or its selector re-evaluated on the result) in magenta',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        stability: {
          variants: { tall: TALL, low: LOW },
          selections: Object.fromEntries(
            STABLE.map(([name, selector]) => [
              name,
              { base: lamp.count(selector), tall: tall.count(selector), low: low.count(selector) },
            ]),
          ),
        },
        reuse: {
          function: 'lamp.pack.ts statically imports buildLamp from lamp.ts',
          variant: 'lamp-tall.pack.json: parent lamp.pack.ts, values tall',
          product: 'lamp-pair.pack.ts: readByGuid both mesh/lamp outputs, lift, place (V-reuse renders the same composition)',
          pairFaces: reuse.inspect().faces,
          pairTags: reuse.inspect().tags,
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': labels.legend,
          'V-sel': STABLE.slice(0, 5).map(([n]) => n).join(' or '),
          'V-thin': 'thin(0.003): faces whose wall behind them is thinner than 3 mm (the lined shade and the cable clip)',
          'V-mouth': "shade session from below: createdBy('liner') (inner reflector, lip) highlighted",
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
