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
import { buildDoorHinge, DOOR_HINGE_DEFAULTS, type DoorHingeParameters } from '../hinge';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step, the
 * finished hinge and the V-diff pair; with FORGEAX_CASE_OUT set it writes the Modeling
 * case output directory: one image per step, final views, history.json, validate.json,
 * data/diff.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../hinge.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLOSED: DoorHingeParameters = { openAngle: 180 };
const OPEN: DoorHingeParameters = { openAngle: 110 };
/** In front of the hinge (+Z), from the body side and above. */
const DIRECTION = [0.45, 0.35, 0.82];

const SLOT_COLORS = {
  Default: [0.7, 0.7, 0.7],
  bracket: [0.24, 0.3, 0.4],
  trim: [0.46, 0.48, 0.52],
  spring: [0.85, 0.62, 0.1],
  chrome: [0.88, 0.89, 0.92],
  steel: [0.62, 0.64, 0.67],
  section: [0.93, 0.9, 0.82],
  highlight: [0.95, 0.2, 0.55],
} as const;

const DOOR = ['door', 'door-bolt-1', 'door-bolt-2', 'door-nut-1', 'door-nut-2', 'hinge-b'];
const FASTENERS = ['body-bolt-1', 'body-bolt-2', 'body-nut-1', 'body-nut-2', 'door-bolt-1', 'door-bolt-2', 'door-nut-1', 'door-nut-2'];

function any(tags: readonly string[]): FaceSelector {
  return tags.slice(1).reduce<FaceSelector>((acc, t) => acc.or(sel.tag(t)), sel.tag(tags[0] as string));
}

/** Exploded copy: bolts out to the front, nuts out to the back, door side pulled away. */
function exploded(m: Model): Model {
  const copy = model();
  copy.append(m.snapshot());
  copy.translate(any(FASTENERS.filter((t) => t.includes('bolt'))), [0, 0, 0.05]);
  copy.translate(any(FASTENERS.filter((t) => t.includes('nut'))), [0, 0, -0.05]);
  copy.translate(sel.tag('spring'), [0, 0.06, 0]);
  copy.translate(sel.tag('cover'), [0, 0, 0.03]);
  return copy;
}

/** The hinge cut through the pin axis (z = 0), keeping the back half, cut faces capped. */
function section(m: Model): Model {
  const copy = model();
  copy.append(m.snapshot());
  copy.planeCut({ point: [0, 0, 0.00001], normal: [0, 0, -1], keep: 'positive', fillHoles: true, material: 'section' });
  return copy;
}

function diffTool() {
  const contribution = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === 'model.diff');
  if (contribution === undefined) throw new Error('model.diff');
  return contribution;
}

describe('C-103 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step, the final views and the V-diff pair', { timeout: 1800000 }, async () => {
    const recording = recordingSessions();
    const hinge = buildDoorHinge(DOOR_HINGE_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(hinge, DIRECTION);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOT_COLORS, metallic: ['chrome', 'steel'], view: main });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        const png = await r.render(stateMesh(step.snapshot, touched(step as RecordedStep)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      const exported = hinge.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);

      const executed = await diffTool().execute(
        { source: 'examples/door-hinge/hinge.pack.ts', values: { ...CLOSED }, against: { values: { ...OPEN } } } as never,
        {} as never,
      );
      const result = executed as { ok: boolean; value?: ModelDiffReport; error?: unknown };
      expect(result.error).toBeUndefined();
      const report = result.value as ModelDiffReport;
      const diff: MeshDiff = report.diff;
      expect(diff.faces.moved).toBeGreaterThan(0);
      const shared = frame({ min: diff.bounds.frame.slice(0, 3), max: diff.bounds.frame.slice(3) }, CASE_FOV, DIRECTION);
      const retracted = buildDoorHinge(CLOSED);
      const extended = buildDoorHinge(OPEN);
      const moving = any(DOOR);
      r.aim(shared);
      const diffA = await r.render(highlighted(retracted, moving));
      const diffB = await r.render(highlighted(extended, moving));
      expect(r.covered(diffA)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.covered(diffB)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      r.aim(main);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const labels = labelMesh(hinge);
      const cut = section(hinge);
      const apart = exploded(hinge);
      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const panels = sel.createdBy('cover-seam').or(sel.createdBy('cover-band'));
      const coverBox = hinge.bounds(sel.tag('cover'));
      if (!coverBox.ok) throw coverBox.error;
      const cover = frame(coverBox.value, CASE_FOV, [0.25, 0.3, 0.92]);
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel': await r.render(highlighted(hinge, any(DOOR))),
        'V-panel': await at(cover, highlighted(hinge, panels)),
        'V-panel-shaded': await at(cover, exported.value.mesh),
        'V-section': await at(frameModel(cut, [0.3, 0.3, 0.9]), highlighted(cut, sel.tag('spring').or(sel.createdBy('hinge-pin')))),
        'V-explode': await at(frameModel(apart, [0.55, 0.3, 0.78]), highlighted(apart, any(FASTENERS))),
        'V-diff-a': diffA,
        'V-diff-b': diffB,
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      for (const [i, png] of images.entries()) writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      for (const [view, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      for (const file of ['hinge.ts', 'hinge.pack.ts', '__tests__/hinge.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      writeFileSync(join(OUT, 'data', 'diff.json'), `${JSON.stringify(report, null, 2)}\n`);
      const validation = hinge.validate();
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const inspection = hinge.inspect();
      const history = {
        case: 'C-103',
        source: { repo: 'ForgeAX/forgeax-modeling', commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', file: 'examples/door-hinge/hinge.ts' },
        parameters: DOOR_HINGE_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step and the final views share the finished hinge camera from one fixed direction; V-panel, V-section and V-explode use their own cameras, the V-diff pair shares the model.diff frame',
          hinge: main,
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
          command: "forgeax model diff --source examples/door-hinge/hinge.pack.ts --values '{\"openAngle\":180}' --against '{\"values\":{\"openAngle\":110}}' --json",
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
          'V-sel': 'the door side that turns about the pin: leaf B, its knuckles, the door bracket and its bolts and nuts',
          'V-panel': "trim cover close-up: panel lines createdBy('cover-seam') (U groove along a closed edge loop) and createdBy('cover-band') (V seam cut by a plane) highlighted",
          'V-panel-shaded': 'the same close-up shaded',
          'V-section': 'planeCut through the pin axis (z = 0) keeping the back half, cut faces capped (cream); pin and spring highlighted',
          'V-explode': 'bolts out to the front, nuts to the back, spring lifted off the pin, cover pulled forward; fasteners highlighted',
          'V-diff-a': `openAngle ${CLOSED.openAngle} (door flush), model.diff frame, door side highlighted`,
          'V-diff-b': `openAngle ${OPEN.openAngle}, same frame and camera`,
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
