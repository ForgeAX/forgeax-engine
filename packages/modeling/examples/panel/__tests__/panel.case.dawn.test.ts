import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FaceSelector, type Model, model, sel } from '@forgeax/engine-modeling';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frameModel,
  frameSnapshot,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { buildPanel, PANEL_DEFAULTS, type PanelParameters } from '../panel';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step and
 * the finished panel; with FORGEAX_CASE_OUT set it writes the case output
 * directory: one image per step, final views, history.json, validate.json (the
 * `forgeax model validate` report) and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../panel.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WIDE: PanelParameters = { width: 0.4, depth: 0.26, thickness: 0.016 };
const THIN: PanelParameters = { width: 0.28, depth: 0.18, thickness: 0.008 };
const DIRECTION = [0.62, 0.62, 0.48];

const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  aluminum: [0.7, 0.72, 0.74],
  anodized: [0.16, 0.32, 0.55],
  bore: [0.32, 0.33, 0.35],
  rubber: [0.08, 0.08, 0.09],
  knob: [0.75, 0.16, 0.12],
  cover: [0.85, 0.62, 0.2],
  around: [0.2, 0.75, 0.4],
  highlight: [0.95, 0.2, 0.55],
} as const;

const BOOLEAN_LABELS = ['drill', 'vent', 'pocket', 'boss', 'bore', 'handle', 'knob', 'cover'];

const STABLE: readonly [string, FaceSelector][] = [
  ["createdBy('drill','cutB')", sel.createdBy('drill', 'cutB')],
  ["createdBy('vent','cutB')", sel.createdBy('vent', 'cutB')],
  ["createdBy('bore','cutB')", sel.createdBy('bore', 'cutB')],
  ["createdBy('boss','cutB')", sel.createdBy('boss', 'cutB')],
  ["createdBy('knob','cutB')", sel.createdBy('knob', 'cutB')],
  ["createdBy('cover','piece')", sel.createdBy('cover', 'piece')],
  ["tag('handle')", sel.tag('handle')],
  ["material('aluminum')", sel.material('aluminum')],
];

const walls = STABLE.slice(0, 3).reduce<FaceSelector>(
  (acc, [, s]) => acc.or(s),
  sel.createdBy('drill', 'cutB'),
);

function slotted(m: Model, slots: readonly [FaceSelector, string][]) {
  const view = model();
  view.append(m.snapshot());
  for (const [selector, slot] of slots) if (view.count(selector) > 0) view.assign(selector, slot);
  view.uv.project({ mode: 'box', scale: 0.1 });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/**
 * Target faces the cuts touch (green; they keep their own label) and operand faces
 * the booleans brought in (magenta).
 */
function cutMesh(m: Model) {
  const cutB = BOOLEAN_LABELS.reduce<FaceSelector>(
    (acc, label) => acc.or(sel.createdBy(label, 'cutB')),
    sel.createdBy('drill', 'cutB'),
  );
  return slotted(m, [
    [sel.all(), 'Default'],
    [cutB.grow(1).minus(cutB), 'around'],
    [cutB, 'highlight'],
  ]);
}

describe('C-011 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step and the final views', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const panel = buildPanel(PANEL_DEFAULTS, recording.session);
    expect(panel.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(panel, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['aluminum', 'bore'],
      view: main,
    });
    try {
      const stepCamera = (step: RecordedStep) => frameSnapshot(step.snapshot, DIRECTION);
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(stepCamera(step));
        const png = await r.render(stateMesh(step.snapshot, touched(step)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      r.aim(main);
      const exported = panel.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      const cuts = await r.render(cutMesh(panel));
      expect(r.covered(cuts)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const wide = buildPanel(WIDE);
      const thin = buildPanel(THIN);
      const labels = labelMesh(panel);
      // The lights come from above, so the underside is shown on a copy turned over.
      const underside = model();
      underside.append(panel.snapshot());
      underside.rotate(sel.all(), 'x', 180);
      const at = async (
        view: ReturnType<typeof frameModel>,
        mesh: Parameters<typeof r.render>[0],
        legend?: readonly string[],
      ) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-back': await at(frameModel(underside, DIRECTION), slotted(underside, [])),
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-cut': cuts,
        'V-sel': await r.render(slotted(panel, [[walls, 'highlight']])),
        'V-cover': await at(
          frameModel(panel, [0.2, 0.9, 0.38]),
          slotted(panel, [[sel.createdBy('cover', 'piece'), 'highlight']]),
        ),
        'V-diff-wide': await at(frameModel(wide, DIRECTION), slotted(wide, [[walls, 'highlight']])),
        'V-diff-thin': await at(frameModel(thin, DIRECTION), slotted(thin, [[walls, 'highlight']])),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['panel.ts', 'panel.pack.ts', '__tests__/panel.case.dawn.test.ts']) {
        copyFileSync(
          fileURLToPath(new URL(`../${file}`, import.meta.url)),
          join(OUT, 'source', file.replace('__tests__/', '')),
        );
      }
      const validate = createModelingTools({ projectRoot: ROOT }).find(
        (t) => t.descriptor.id === 'model.validate',
      );
      const report = (await validate?.execute(
        { source: 'examples/panel/panel.pack.ts' } as never,
        {} as never,
      )) as { ok: boolean; value?: { status: string } };
      expect(report.ok).toBe(true);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(report.value, null, 2)}\n`);
      const inspection = panel.inspect();
      const booleans = steps.filter((s) =>
        ['union', 'difference', 'intersection', 'splitBy'].includes(s.entry.op),
      );
      const history = {
        case: 'C-011',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/panel/panel.ts',
        },
        parameters: PANEL_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; final views frame the finished panel (variants on their own bounds)',
          panel: main,
        },
        highlight:
          'each step image shows the faces the step touched (its label: the cutB faces of a boolean or the splitBy piece, or its selector re-evaluated on the result) in magenta',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        jobs: booleans.map((step) => {
          const info = step.entry.diagnostics?.find((d) => d.severity === 'info');
          return { line: step.line, op: step.entry.op, label: step.entry.label, ...info?.detail };
        }),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          volume: panel.validate().volume,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        stability: {
          variants: { wide: WIDE, thin: THIN },
          selections: Object.fromEntries(
            STABLE.map(([name, selector]) => [
              name,
              {
                base: panel.count(selector),
                wide: wide.count(selector),
                thin: thin.count(selector),
              },
            ]),
          ),
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': labels.legend,
          'V-cut': 'green: target faces next to a cut (they keep their own label); magenta: faces the operands brought in (role cutB)',
          'V-sel': STABLE.slice(0, 3)
            .map(([n]) => n)
            .join(' or '),
          'V-back': 'the underside (a copy turned over about X): through holes, vent slots and the bore exit',
          'V-cover': "the access cover split out with splitBy and lifted 4 mm: createdBy('cover','piece')",
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
