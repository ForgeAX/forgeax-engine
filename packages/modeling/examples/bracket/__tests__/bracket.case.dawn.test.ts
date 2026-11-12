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
  frame,
  frameModel,
  frameSnapshot,
  highlighted,
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { BRACKET_DEFAULTS, type BracketParameters, buildBracket } from '../bracket';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step and
 * the finished bracket; with FORGEAX_CASE_OUT set it writes the case output
 * directory: one image per step, final views, history.json, validate.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../bracket.ts', import.meta.url));
const VARIANT: BracketParameters = { length: 0.2, height: 0.08, thickness: 0.02, depth: 0.12, fillet: 0.004 };
/** The base, slot and fillet face the camera from the front-right, above. */
const DIRECTION = [0.62, 0.6, 0.5];
/**
 * The case renderer keeps one directional light (from +X+Y+Z), so the boss on the
 * outer (-X) face is shown on a copy turned 180 degrees about Y.
 */
function turned(m: Model): Model {
  const copy = model();
  copy.append(m.snapshot());
  copy.rotate(sel.all(), 'y', 180);
  return copy;
}

const SLOT_COLORS = {
  Default: [0.6, 0.62, 0.66],
  machined: [0.82, 0.78, 0.68],
  highlight: [0.95, 0.2, 0.55],
} as const;

const BEVELS: readonly [string, FaceSelector][] = [
  ['fillet', sel.createdBy('fillet')],
  ['boss-chamfer', sel.createdBy('boss-chamfer')],
  ['slot-round', sel.createdBy('slot-round')],
  ['edge-round', sel.createdBy('edge-round')],
  ['boss-fillet', sel.createdBy('boss-fillet')],
];
const bevelled = BEVELS.slice(1).reduce<FaceSelector>((acc, [, s]) => acc.or(s), sel.createdBy('fillet'));

describe('C-010 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step and the final views', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const bracket = buildBracket(BRACKET_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(bracket, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['machined'],
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
      const exported = bracket.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const variant = buildBracket(VARIANT);
      const labels = labelMesh(bracket);
      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const back = turned(bracket);
      const boss = frameModel(back, DIRECTION);
      const backMesh = back.toMesh({ normals: { mode: 'weighted' } });
      if (!backMesh.ok) throw backMesh.error;
      const floor = bracket.bounds(sel.createdBy('slot-cut', 'top'));
      if (!floor.ok) throw floor.error;
      const corner: [number, number, number] = [floor.value.max[0], BRACKET_DEFAULTS.thickness, floor.value.max[2]];
      const reach = BRACKET_DEFAULTS.thickness * 0.7;
      const cornerView = frame(
        { min: corner.map((c) => c - reach), max: corner.map((c) => c + reach) },
        CASE_FOV,
        [0.55, 0.75, 0.45],
      );
      const variantMesh = variant.toMesh({ normals: { mode: 'weighted' } });
      if (!variantMesh.ok) throw variantMesh.error;
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-boss': await at(boss, backMesh.value.mesh),
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel': await r.render(highlighted(bracket, bevelled)),
        'V-sel-boss': await at(boss, highlighted(back, bevelled)),
        'V-corner': await at(cornerView, highlighted(bracket, sel.createdBy('slot-round', 'corner'))),
        'V-clamp': await at(boss, highlighted(back, sel.createdBy('boss-fillet'))),
        'V-variant': await at(frameModel(variant, DIRECTION), variantMesh.value.mesh),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['bracket.ts', 'bracket.pack.ts', '__tests__/bracket.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validation = bracket.validate({ minThickness: 0.002 });
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const inspection = bracket.inspect();
      const bevels = bracket.journal
        .filter((entry) => entry.op === 'bevel')
        .map((entry) => ({
          label: entry.label,
          args: entry.args,
          roles: entry.roles,
          diagnostics: entry.diagnostics ?? [],
        }));
      const history = {
        case: 'C-010',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/bracket/bracket.ts',
        },
        parameters: BRACKET_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; final views frame the finished bracket (boss views on a copy turned 180 degrees about Y, the corner view on one slot corner, the variant on its own bounds)',
          bracket: main,
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
        bevels,
        stability: {
          variant: VARIANT,
          selections: Object.fromEntries(
            BEVELS.map(([name, selector]) => [name, { base: bracket.count(selector), variant: variant.count(selector) }]),
          ),
          variantValidate: variant.validate().pass,
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': labels.legend,
          'V-sel': BEVELS.map(([name]) => `createdBy('${name}')`).join(' or '),
          'V-corner': "createdBy('slot-round', 'corner'): patterned three-sided patches where the convex slot rim meets the concave walls and floor",
          'V-clamp': "createdBy('boss-fillet'): asked for 0.1 x thickness, clamped to the room the rounded boss corners leave (bevels[4].diagnostics)",
          'V-variant': 'the same source with the variant parameters (thicker, deeper, a 4 mm fillet)',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
