import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, type MeshDiff, model, sel } from '@forgeax/engine-modeling';
import { createModelingTools, type ModelDiffReport } from '@forgeax/engine-modeling/tools';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frame,
  frameModel,
  highlighted,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { buildHousing, HOUSING_DEFAULTS, type HousingParameters } from '../housing';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step,
 * the finished housing and the V-diff pair; with FORGEAX_CASE_OUT set it writes the
 * case output directory: one image per step, final views, history.json,
 * validate.json, data/diff.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../housing.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VARIANT: HousingParameters = { wall: 0.003, vents: 8 };
/** Front-right and above, so the open top, the vents and the floor features show. */
const DIRECTION = [0.55, 0.85, 0.75];

const SLOT_COLORS = {
  Default: [0.82, 0.83, 0.8],
  interior: [0.42, 0.47, 0.52],
  lip: [0.95, 0.55, 0.15],
  highlight: [0.95, 0.2, 0.55],
} as const;

const STABLE: readonly [string, FaceSelector][] = [
  ["createdBy('wall','rim')", sel.createdBy('wall', 'rim')],
  ["createdBy('vent','rim')", sel.createdBy('vent', 'rim')],
  ["createdBy('screw','top')", sel.createdBy('screw', 'top')],
  ["createdBy('rib','top')", sel.createdBy('rib', 'top')],
  ["createdBy('lip-up','top')", sel.createdBy('lip-up', 'top')],
  ["createdBy('wall','inner')", sel.createdBy('wall', 'inner')],
];

/** The housing cut open at the vent band's mid height for a section view. */
function section(p: HousingParameters) {
  const m = model();
  m.append(buildHousing(p).snapshot());
  m.planeCut({ point: [0, 0, 0.012], normal: [0, 0, -1], keep: 'positive' });
  return m;
}

function diffTool() {
  const contribution = createModelingTools({ projectRoot: ROOT }).find(
    (t) => t.descriptor.id === 'model.diff',
  );
  if (contribution === undefined) throw new Error('model.diff');
  return contribution;
}

describe('C-012 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step, the final views and the V-diff pair', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const housing = buildHousing(HOUSING_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(housing, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      view: main,
    });
    try {
      // Steps share the finished housing's camera: the outline never changes size.
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        const png = await r.render(stateMesh(step.snapshot, touched(step as RecordedStep)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      const exported = housing.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);

      const executed = await diffTool().execute(
        {
          source: 'examples/housing/housing.pack.ts',
          against: { values: { ...VARIANT } },
        } as never,
        {} as never,
      );
      const result = executed as { ok: boolean; value?: ModelDiffReport; error?: unknown };
      expect(result.error).toBeUndefined();
      const report = result.value as ModelDiffReport;
      const diff: MeshDiff = report.diff;
      expect(diff.counts.faces.delta).toBeGreaterThan(0);
      const shared = frame(
        { min: diff.bounds.frame.slice(0, 3), max: diff.bounds.frame.slice(3) },
        CASE_FOV,
        DIRECTION,
      );
      const variant = buildHousing(VARIANT);
      const stable = STABLE.slice(0, 5).reduce<FaceSelector>(
        (acc, [, s]) => acc.or(s),
        sel.createdBy('wall', 'rim'),
      );
      r.aim(shared);
      const diffA = await r.render(highlighted(housing, stable));
      const diffB = await r.render(highlighted(variant, stable));
      expect(r.covered(diffA)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.covered(diffB)).toBeGreaterThan(r.covered(diffA) * 0.9);
      r.aim(main);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const labels = labelMesh(housing);
      const cut = section(HOUSING_DEFAULTS);
      const cutView = frameModel(cut, [0.15, 0.55, 1]);
      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel': await r.render(highlighted(housing, stable)),
        'V-thin': await r.render(highlighted(housing, sel.thin(0.0025))),
        'V-section': await at(cutView, highlighted(cut, sel.createdBy('wall', 'inner'))),
        'V-diff-a': diffA,
        'V-diff-b': diffB,
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['housing.ts', 'housing.pack.ts', '__tests__/housing.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      writeFileSync(join(OUT, 'data', 'diff.json'), `${JSON.stringify(report, null, 2)}\n`);
      const validation = housing.validate({ minThickness: 0.0007 });
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const inspection = housing.inspect();
      const shellStep = steps.find((s) => s.entry.op === 'shell');
      const history = {
        case: 'C-012',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/housing/housing.ts',
        },
        parameters: HOUSING_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step and the final views share the finished housing camera from one fixed direction; V-section and the V-diff pair use their own cameras (the pair shares the model.diff frame)',
          housing: main,
          diff: shared,
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
          volume: validation.volume,
          closed: validation.closed,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        shell: {
          args: shellStep?.entry.args,
          roles: shellStep?.entry.roles,
          diagnostics: shellStep?.entry.diagnostics ?? [],
          rule: 'shell keeps the outer surface identity; inner copies and rims carry the wall label',
        },
        stability: {
          variant: VARIANT,
          selections: Object.fromEntries(
            STABLE.map(([name, selector]) => [
              name,
              { base: housing.count(selector), variant: variant.count(selector) },
            ]),
          ),
        },
        diff: {
          command: "forgeax model diff --source examples/housing/housing.pack.ts --against '{\"values\":{\"wall\":0.003,\"vents\":8}}' --json",
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
          'V-sel': STABLE.slice(0, 5).map(([n]) => n).join(' or '),
          'V-thin': 'thin(0.0025): faces whose wall behind them is thinner than 2.5 mm (shell walls, lip, boss rings)',
          'V-section': "planeCut at z = 12 mm through the bosses and vent band; createdBy('wall','inner') highlighted",
          'V-diff-a': `defaults ${JSON.stringify(HOUSING_DEFAULTS)}, model.diff frame`,
          'V-diff-b': `variant ${JSON.stringify(VARIANT)}, same frame and camera`,
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
