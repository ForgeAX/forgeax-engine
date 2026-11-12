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
import {
  buildSuspension,
  isolated,
  SUSPENSION_DEFAULTS,
  SUSPENSION_JOINTS,
  SUSPENSION_VARIANT,
  SWEPT,
} from '../suspension';
import { probeJoints, rangeProbes } from '../range';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step and
 * the finished corner; with FORGEAX_CASE_OUT set it writes the case output
 * directory: one image per step, final views, history.json, validate.json (the assembly
 * with its designed joints), data/range-endpoints.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../suspension.ts', import.meta.url));
/** Front three-quarter view from outboard and above: the hub face and the coil-over. */
const DIRECTION = [0.62, 0.48, 0.62];

/**
 * The case renderer keeps one directional light (from +X+Y+Z). Rear faces are shown on
 * a copy turned -90 degrees about Y, which brings the rear (-Z) and the outboard (+X)
 * sides into that light.
 */
function turned(m: Model): Model {
  const copy = model();
  copy.append(m.snapshot());
  copy.rotate(sel.all(), 'y', -90);
  return copy;
}

const SLOT_COLORS = {
  Default: [0.6, 0.62, 0.66],
  steel: [0.42, 0.45, 0.5],
  rubber: [0.12, 0.12, 0.13],
  alu: [0.78, 0.79, 0.8],
  hub: [0.55, 0.56, 0.58],
  disc: [0.66, 0.64, 0.62],
  damper: [0.85, 0.65, 0.15],
  spring: [0.8, 0.12, 0.1],
  highlight: [0.95, 0.2, 0.55],
} as const;

const SWEEP_LABELS = SWEPT.filter((label) => label !== 'upright' && label !== 'boot');
const ARRAYS: readonly [string, FaceSelector][] = [
  ['upper-bushes', sel.createdBy('upper-bushes', 'copy')],
  ['lower-bushes', sel.createdBy('lower-bushes', 'copy')],
  ['studs', sel.createdBy('studs', 'copy')],
  ['perches', sel.createdBy('perches', 'copy')],
];
const any = (labels: readonly string[]): FaceSelector =>
  labels.slice(1).reduce<FaceSelector>((acc, label) => acc.or(sel.createdBy(label)), sel.createdBy(labels[0] as string));

describe('C-104 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step and the final views', { timeout: 1800000 }, async () => {
    const recording = recordingSessions();
    const corner = buildSuspension(SUSPENSION_DEFAULTS, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(corner, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['steel', 'hub', 'disc', 'spring'],
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
      const exported = corner.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const exportOf = (m: Model) => {
        const out = m.toMesh({ normals: { mode: 'weighted' } });
        if (!out.ok) throw out.error;
        return out.value.mesh;
      };
      const sessionOf = (name: string) => recording.sessions.get(name) as Model;
      const back = turned(corner);
      const variant = buildSuspension(SUSPENSION_VARIANT);
      const labels = labelMesh(corner);
      const coilover = sessionOf('coilover');
      const knuckle = sessionOf('knuckle');
      const arrays = ARRAYS.slice(1).reduce<FaceSelector>((acc, [, s]) => acc.or(s), (ARRAYS[0] as [string, FaceSelector])[1]);
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-rear': await at(frameModel(back, DIRECTION), exportOf(back)),
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel-sweep': await r.render(highlighted(corner, any(SWEEP_LABELS))),
        'V-sel-loft': await at(frameModel(back, DIRECTION), highlighted(back, any(['upright', 'boot']))),
        'V-sel-array': await r.render(highlighted(corner, arrays)),
        'V-spring': await at(frameModel(coilover, DIRECTION), highlighted(coilover, sel.createdBy('spring'))),
        'V-upright': await at(frameModel(knuckle, DIRECTION), exportOf(knuckle)),
        'V-variant': await at(frameModel(variant, DIRECTION), exportOf(variant)),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['suspension.ts', 'suspension.pack.ts', 'range.ts', '__tests__/suspension.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validation = corner.validate({ contacts: SUSPENSION_JOINTS, minThickness: 0.002 });
      const parts = Object.fromEntries(
        SWEPT.map((label) => {
          const report = isolated(corner, label).validate();
          return [label, { closed: report.closed, volume: report.volume, issues: report.issues.filter((i) => i.severity !== 'info') }];
        }),
      );
      writeFileSync(
        join(OUT, 'validate.json'),
        `${JSON.stringify({ contacts: SUSPENSION_JOINTS, assembly: validation, swept: parts }, null, 2)}\n`,
      );
      const endpoints = rangeProbes().map(({ probe, parameters }) => ({ probe, parameters, ...probeJoints(parameters) }));
      expect(endpoints.every((e) => e.confirmedCrossings === 0 && e.errors === 0)).toBe(true);
      mkdirSync(join(OUT, 'data'), { recursive: true });
      writeFileSync(
        join(OUT, 'data', 'range-endpoints.json'),
        `${JSON.stringify({ case: 'C-104', semantics: 'validate({ contacts: SUSPENSION_JOINTS })', probes: endpoints }, null, 2)}\n`,
      );
      const inspection = corner.inspect();
      const generators = steps
        .filter((step) => step.entry.op === 'sweep' || step.entry.op === 'loft' || step.entry.op === 'array')
        .map((step) => ({
          session: step.session,
          op: step.entry.op,
          label: step.entry.label,
          sourceLine: step.line,
          roles: step.entry.roles,
          diagnostics: step.entry.diagnostics ?? [],
        }));
      const history = {
        case: 'C-104',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/suspension/suspension.ts',
        },
        parameters: SUSPENSION_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own session state from one fixed direction; final views frame the finished corner (rear views on a copy turned -90 degrees about Y, the spring and upright views on their part sessions, the variant on its own bounds)',
          corner: main,
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
          rangeEndpoints: 'data/range-endpoints.json',
        },
        generators,
        stability: {
          variant: SUSPENSION_VARIANT,
          selections: Object.fromEntries(
            [...SWEPT, ...ARRAYS.map(([name]) => name)].map((name) => {
              const selector = sel.createdBy(name);
              return [name, { base: corner.count(selector), variant: variant.count(selector) }];
            }),
          ),
          variantValidate: variant.validate({ contacts: SUSPENSION_JOINTS }).pass,
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-tags': labels.legend,
          'V-sel-sweep': SWEEP_LABELS.map((name) => `createdBy('${name}')`).join(' or '),
          'V-sel-loft': "createdBy('upright') or createdBy('boot'): lofts through sections with 4/8/6/4 and 16 vertices",
          'V-sel-array': ARRAYS.map(([name]) => `createdBy('${name}', 'copy')`).join(' or '),
          'V-spring': "the coil-over session, createdBy('spring'): a helix sweep with rotation-minimizing frames",
          'V-upright': 'the knuckle session: lofted upright and swept, tapering steering arm',
          'V-variant': 'the same source with the variant parameters (thicker arms, 8 coils of thinner wire, wider bends)',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
