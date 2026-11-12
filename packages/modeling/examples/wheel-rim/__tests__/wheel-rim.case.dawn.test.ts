import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, type MeshDiff, type Model, model, sel } from '@forgeax/engine-modeling';
import { createModelingTools, type ModelDiffReport } from '@forgeax/engine-modeling/tools';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frame,
  frameModel,
  frameSnapshot,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { buildWheelRim, WHEEL_RIM_DEFAULTS, type WheelRimParameters } from '../wheel-rim';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step, the
 * finished rim and the V-diff pair; with FORGEAX_CASE_OUT set it writes the Modeling
 * case output directory: one image per step, final views, history.json, validate.json
 * (the `forgeax model validate` report), data/diff.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../wheel-rim.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The diff variant: seven spokes, everything else at the defaults. */
const SEVEN: WheelRimParameters = { ...WHEEL_RIM_DEFAULTS, spokes: 7 };
/** The C-100 rear wheel: 21 in x 12.5 J for its 345 tire. */
const REAR: WheelRimParameters = { diameter: 0.5334, width: 0.3175, spokes: 5, offset: 0.05 };
/** In front of the outboard face and above, so the dish, the windows and the hub show. */
const DIRECTION = [0.42, 0.82, 0.66];

const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  barrel: [0.6, 0.62, 0.64],
  painted: [0.24, 0.25, 0.27],
  machined: [0.88, 0.89, 0.9],
  bore: [0.42, 0.43, 0.45],
  section: [0.95, 0.55, 0.15],
  highlight: [0.95, 0.2, 0.55],
} as const;

const WINDOWS = sel.createdBy('windows', 'cutB').or(sel.createdBy('window-chamfer'));
const HUB = sel.createdBy('lug-seats', 'cutB').or(sel.createdBy('lugs', 'cutB')).or(sel.createdBy('bore', 'cutB'));

const STABLE: readonly [string, FaceSelector][] = [
  ["createdBy('windows','cutB')", sel.createdBy('windows', 'cutB')],
  ["createdBy('window-chamfer','bevel')", sel.createdBy('window-chamfer', 'bevel')],
  ["tag('window-array:0')", sel.tag('window-array:0')],
  ["createdBy('lip-round','bevel')", sel.createdBy('lip-round', 'bevel')],
  ["createdBy('lug-seats','cutB')", sel.createdBy('lug-seats', 'cutB')],
  ["createdBy('lugs','cutB')", sel.createdBy('lugs', 'cutB')],
  ["createdBy('bore','cutB')", sel.createdBy('bore', 'cutB')],
  ["createdBy('valve','cutB')", sel.createdBy('valve', 'cutB')],
  ["material('machined')", sel.material('machined')],
  ["tag('face')", sel.tag('face')],
];

function slotted(m: Model, slots: readonly [FaceSelector, string][]) {
  const view = model();
  view.append(m.snapshot());
  for (const [selector, slot] of slots) if (view.count(selector) > 0) view.assign(selector, slot);
  view.uv.project({ mode: 'box', scale: 0.1 });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** A copy of the rim cut through the axle (x <= 0 kept, the section facing the light) and capped. */
function section(m: Model): Model {
  const cut = model();
  cut.append(m.snapshot());
  cut.planeCut({ point: [0, 0, 0], normal: [-1, 0, 0], keep: 'positive', fillHoles: true, material: 'section' });
  return cut;
}

function tool(id: string) {
  const contribution = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === id);
  if (contribution === undefined) throw new Error(id);
  return contribution;
}

describe('C-101 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step, the final views and the V-diff pair', { timeout: 1800000 }, async () => {
    const recording = recordingSessions();
    const rim = buildWheelRim(WHEEL_RIM_DEFAULTS, recording.session);
    expect(rim.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(rim, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['barrel', 'machined', 'bore'],
      view: main,
    });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        const png = await r.render(stateMesh(step.snapshot, touched(step as RecordedStep)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      r.aim(main);
      const exported = rim.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.1);

      const executed = await tool('model.diff').execute(
        { source: 'examples/wheel-rim/wheel-rim.pack.ts', against: { values: { spokes: SEVEN.spokes } } } as never,
        {} as never,
      );
      const result = executed as { ok: boolean; value?: ModelDiffReport; error?: unknown };
      expect(result.error).toBeUndefined();
      const report = result.value as ModelDiffReport;
      const diff: MeshDiff = report.diff;
      expect(diff.counts.faces.delta).toBeGreaterThan(0);
      const shared = frame({ min: diff.bounds.frame.slice(0, 3), max: diff.bounds.frame.slice(3) }, CASE_FOV, DIRECTION);
      const seven = buildWheelRim(SEVEN);
      r.aim(shared);
      const diffA = await r.render(slotted(rim, [[WINDOWS, 'highlight']]));
      const diffB = await r.render(slotted(seven, [[WINDOWS, 'highlight']]));
      expect(r.covered(diffA)).toBeGreaterThan(WIDTH * HEIGHT * 0.1);
      expect(r.covered(diffB)).toBeGreaterThan(WIDTH * HEIGHT * 0.1);
      r.aim(main);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const rear = buildWheelRim(REAR);
      const labels = labelMesh(rim);
      // The lights come from the face side, so the inboard side is shown on a copy turned over.
      const inboard = model();
      inboard.append(rim.snapshot());
      inboard.rotate(sel.all(), 'x', 180);
      const cut = section(rim);
      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-inboard': await at(frameModel(inboard, DIRECTION), slotted(inboard, [])),
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel': await r.render(slotted(rim, [[WINDOWS, 'highlight']])),
        'V-sel-hub': await at(frameModel(rim, [0.12, 1, 0.2]), slotted(rim, [[HUB, 'highlight']])),
        'V-validate': await at(frameModel(cut, [1, 0.35, 0.3]), slotted(cut, [])),
        'V-diff-a': diffA,
        'V-diff-b': diffB,
        'V-rear': await at(frameModel(rear, DIRECTION), slotted(rear, [[WINDOWS, 'highlight']])),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['wheel-rim.ts', 'wheel-rim.pack.ts', '__tests__/wheel-rim.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      writeFileSync(join(OUT, 'data', 'diff.json'), `${JSON.stringify(report, null, 2)}\n`);
      const validated = (await tool('model.validate').execute(
        { source: 'examples/wheel-rim/wheel-rim.pack.ts' } as never,
        {} as never,
      )) as { ok: boolean; value?: { status: string } };
      expect(validated.ok).toBe(true);
      expect(validated.value?.status).toBe('pass');
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validated.value, null, 2)}\n`);
      const inspection = rim.inspect();
      const validation = rim.validate();
      const booleans = steps.filter((s) => ['union', 'difference'].includes(s.entry.op));
      const bevels = steps.filter((s) => s.entry.op === 'bevel');
      const history = {
        case: 'C-101',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/wheel-rim/wheel-rim.ts',
        },
        parameters: WHEEL_RIM_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own session state from one fixed direction; final views frame the finished rim (variants and the section on their own bounds, the V-diff pair on the model.diff frame)',
          rim: main,
          diff: shared,
        },
        highlight:
          'each step image shows the faces the step touched (its label: the cutB and piece faces of a boolean, or its selector re-evaluated on the result) in magenta',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        jobs: booleans.map((step) => {
          const info = step.entry.diagnostics?.find((d) => d.severity === 'info');
          return { line: step.line, session: step.session, op: step.entry.op, label: step.entry.label ?? null, ...info?.detail };
        }),
        bevels: bevels.map((step) => ({
          line: step.line,
          session: step.session,
          label: step.entry.label,
          args: step.entry.args,
          roles: step.entry.roles,
          diagnostics: step.entry.diagnostics ?? [],
        })),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          volume: validation.volume,
          closed: validation.closed,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        stability: {
          variants: { seven: SEVEN, rear: REAR },
          selections: Object.fromEntries(
            STABLE.map(([name, selector]) => [
              name,
              { base: rim.count(selector), seven: seven.count(selector), rear: rear.count(selector) },
            ]),
          ),
        },
        diff: {
          command: "forgeax model diff --source examples/wheel-rim/wheel-rim.pack.ts --against '{\"values\":{\"spokes\":7}}' --json",
          data: 'data/diff.json',
          faces: diff.faces,
          counts: diff.counts,
          volume: diff.volume,
          hausdorff: diff.hausdorff,
          frame: diff.bounds.frame,
          render: report.render,
          images: ['view-V-diff-a.png', 'view-V-diff-b.png'],
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': labels.legend,
          'V-sel': "createdBy('windows','cutB') or createdBy('window-chamfer'): the spoke window walls and their chamfered rims",
          'V-sel-hub': "createdBy('lug-seats','cutB') or createdBy('lugs','cutB') or createdBy('bore','cutB'), seen along the axle",
          'V-inboard': 'the inboard side (a copy turned over about X): barrel, drop center well, valve hole and mounting face',
          'V-validate': 'validate: closed, 0 errors; a planeCut through the axle with the section capped (orange) shows the barrel and face walls closed',
          'V-diff-a': `defaults ${JSON.stringify(WHEEL_RIM_DEFAULTS)}, model.diff frame`,
          'V-diff-b': `variant ${JSON.stringify(SEVEN)}, same frame and camera`,
          'V-rear': `the C-100 rear wheel ${JSON.stringify(REAR)}, windows highlighted`,
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
