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
  highlighted,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { buildJoint, JOINT_DEFAULTS, type JointParameters } from '../joint';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step, the
 * finished joint and the V-diff pair; with FORGEAX_CASE_OUT set it writes the Modeling
 * case output directory: one image per step, final views, history.json, validate.json,
 * data/diff.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../joint.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RETRACTED: JointParameters = { extension: 0.1 };
const EXTENDED: JointParameters = { extension: 0.95 };
/** In front of the mechanism plane (+Z), from the right and above. */
const DIRECTION = [0.42, 0.38, 0.82];

const SLOT_COLORS = {
  Default: [0.7, 0.7, 0.7],
  frame: [0.24, 0.3, 0.4],
  arm: [0.9, 0.62, 0.12],
  paint: [0.78, 0.2, 0.14],
  chrome: [0.88, 0.89, 0.92],
  steel: [0.62, 0.64, 0.67],
  section: [0.93, 0.9, 0.82],
  highlight: [0.95, 0.2, 0.55],
} as const;

const FASTENERS = ['pivot-bolt', 'pivot-washer', 'base-pin', 'arm-pin'];
const NUTS = ['pivot-nut', 'base-nut', 'arm-nut'];

function any(tags: readonly string[]): FaceSelector {
  return tags.slice(1).reduce<FaceSelector>((acc, t) => acc.or(sel.tag(t)), sel.tag(tags[0] as string));
}

/** Exploded copy: pins and nuts pulled out along their axes, front and back parts apart. */
function exploded(m: Model): Model {
  const copy = model();
  copy.append(m.snapshot());
  const front = ['tower', 'clevis', 'arm'].reduce<FaceSelector>((acc, l) => acc.or(sel.createdBy(l)), sel.tag('bearing-front'));
  const back = ['tower-back', 'clevis-back', 'arm-back'].reduce<FaceSelector>((acc, l) => acc.or(sel.createdBy(l)), sel.tag('bearing-back'));
  copy.translate(any(FASTENERS), [0, 0, 0.16]);
  copy.translate(any(NUTS), [0, 0, -0.16]);
  copy.translate(front, [0, 0, 0.08]);
  copy.translate(back, [0, 0, -0.08]);
  return copy;
}

/** The joint cut at its mid plane, keeping the back half: cylinder bore, bearings, pins. */
function section(m: Model): Model {
  const copy = model();
  copy.append(m.snapshot());
  copy.planeCut({ point: [0, 0, 0.0001], normal: [0, 0, -1], keep: 'positive', fillHoles: true, material: 'section' });
  return copy;
}

function diffTool() {
  const contribution = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === 'model.diff');
  if (contribution === undefined) throw new Error('model.diff');
  return contribution;
}

describe('C-102 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step, the final views and the V-diff pair', { timeout: 1800000 }, async () => {
    const recording = recordingSessions();
    const joint = buildJoint(JOINT_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(joint, DIRECTION);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOT_COLORS, metallic: ['chrome', 'steel'], view: main });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        const png = await r.render(stateMesh(step.snapshot, touched(step as RecordedStep)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      const exported = joint.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);

      const executed = await diffTool().execute(
        { source: 'examples/hydraulic-joint/joint.pack.ts', values: { ...RETRACTED }, against: { values: { ...EXTENDED } } } as never,
        {} as never,
      );
      const result = executed as { ok: boolean; value?: ModelDiffReport; error?: unknown };
      expect(result.error).toBeUndefined();
      const report = result.value as ModelDiffReport;
      const diff: MeshDiff = report.diff;
      expect(diff.faces.moved).toBeGreaterThan(0);
      const shared = frame({ min: diff.bounds.frame.slice(0, 3), max: diff.bounds.frame.slice(3) }, CASE_FOV, DIRECTION);
      const retracted = buildJoint(RETRACTED);
      const extended = buildJoint(EXTENDED);
      const moving = sel.tag('arm').or(sel.tag('cylinder-rod'));
      r.aim(shared);
      const diffA = await r.render(highlighted(retracted, moving));
      const diffB = await r.render(highlighted(extended, moving));
      expect(r.covered(diffA)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.covered(diffB)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      r.aim(main);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const labels = labelMesh(joint);
      const cut = section(joint);
      const apart = exploded(joint);
      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const parts = any(['bearing-front', 'bearing-back', ...FASTENERS, ...NUTS, 'anchor', 'spacer']);
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel': await r.render(highlighted(joint, parts)),
        'V-section': await at(frameModel(cut, [0.3, 0.3, 0.9]), highlighted(cut, sel.tag('cylinder-rod').or(sel.tag('bearing-back')))),
        'V-explode': await at(frameModel(apart, [0.75, 0.35, 0.56]), highlighted(apart, parts)),
        'V-diff-a': diffA,
        'V-diff-b': diffB,
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      for (const [i, png] of images.entries()) writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      for (const [view, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      for (const file of ['joint.ts', 'joint.pack.ts', '__tests__/joint.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      writeFileSync(join(OUT, 'data', 'diff.json'), `${JSON.stringify(report, null, 2)}\n`);
      const validation = joint.validate();
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const inspection = joint.inspect();
      const history = {
        case: 'C-102',
        source: { repo: 'ForgeAX/forgeax-modeling', commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', file: 'examples/hydraulic-joint/joint.ts' },
        parameters: JOINT_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step and the final views share the finished joint camera from one fixed direction; V-section and V-explode use their own cameras, the V-diff pair shares the model.diff frame',
          joint: main,
          diff: shared,
        },
        highlight: 'each step image shows the faces the step touched (its label, the tag of an appended part, or its selector re-evaluated on the result) in magenta',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        parts: steps
          .filter((s) => s.entry.op === 'append')
          .map((s) => ({ step: steps.indexOf(s) + 1, tag: (s.entry.args as { tag?: string }).tag, faces: s.entry.roles })),
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
        diff: {
          command: "forgeax model diff --source examples/hydraulic-joint/joint.pack.ts --values '{\"extension\":0.1}' --against '{\"values\":{\"extension\":0.95}}' --json",
          data: 'data/diff.json',
          faces: diff.faces,
          counts: diff.counts,
          volume: diff.volume,
          hausdorff: diff.hausdorff,
          frame: diff.bounds.frame,
          images: ['view-V-diff-a.png', 'view-V-diff-b.png'],
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': labels.legend,
          'V-sel': 'recipe parts: bearings, pins, washers, nuts, anchors and spacers',
          'V-section': 'planeCut at z = 0 keeping the back half, cut faces capped (cream): piston, rod, chamber, gland and the back bearing (rod and bearing highlighted)',
          'V-explode': 'pins and nuts pulled out along their axes, front and back plates and bearings apart; recipe parts highlighted',
          'V-diff-a': `extension ${RETRACTED.extension}, model.diff frame (arm and rod highlighted)`,
          'V-diff-b': `extension ${EXTENDED.extension}, same frame and camera`,
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
