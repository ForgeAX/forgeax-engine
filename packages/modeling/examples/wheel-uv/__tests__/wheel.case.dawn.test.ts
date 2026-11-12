import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Model, measureUv, model, sel } from '@forgeax/engine-modeling';
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
  highlighted,
  historyStep,
  labelMesh,
  layoutView,
  stateMesh,
  touched,
  uvLayoutMesh,
} from '../../case/render';
import { buildWheel, WHEEL_DEFAULTS } from '../wheel';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step, the
 * checker view and the UV layout; with FORGEAX_CASE_OUT set it writes the Modeling
 * case output directory: one image per step (UV steps with the checker texture on the
 * session's own uv0), the V-uv views (checker renders and atlas layouts, before and
 * after), history.json, uv.json (stretch / area / texel density per state),
 * validate.json (with the unique-UV overlap check) and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../wheel.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Three-quarter view from above the hub-cap side: upper sidewall, tread and cap. */
const DIRECTION = [0.5, 0.62, 0.6];

const SLOT_COLORS = {
  Default: [0.6, 0.62, 0.66],
  rubber: [0.13, 0.13, 0.14],
  chrome: [0.78, 0.8, 0.83],
  badge: [0.75, 0.15, 0.12],
  vent: [0.2, 0.21, 0.23],
  atlas: [0.1, 0.1, 0.11],
  'atlas-border': [0.55, 0.55, 0.58],
  highlight: [0.95, 0.2, 0.55],
} as const;

const isUv = (step: RecordedStep) => step.entry.op.startsWith('uv.');

function metricsOf(step: RecordedStep): Record<string, number> | undefined {
  const info = step.entry.diagnostics?.find((d) => d.severity === 'info');
  return (info?.detail as { metrics?: Record<string, number> } | undefined)?.metrics;
}

function measured(snapshot: Uint8Array) {
  const m = model();
  m.append(snapshot);
  const r = measureUv(m.editMesh);
  if (!r.ok) throw r.error;
  const overlap = m.validate({ uniqueUv: true }).issues.find((i) => i.code === 'uv-overlap');
  const { faceIsland: _faceIsland, islands, ...totals } = r.value;
  return { ...totals, islands: islands.length, overlapPairs: (overlap?.detail.pairs as number | undefined) ?? 0 };
}

describe('C-013 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step and the V-uv views', { timeout: 5400000 }, async () => {
    const recording = recordingSessions();
    const wheel = buildWheel(WHEEL_DEFAULTS, recording.session);
    expect(wheel.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(wheel, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['chrome'],
      view: main,
      checker: checkerTexture(),
    });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        const png = await r.render(isUv(step) ? checkerMesh(step.snapshot) : stateMesh(step.snapshot, touched(step)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      r.aim(main);
      const checker = await r.render(checkerMesh(wheel.snapshot()));
      expect(r.covered(checker)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      const layout = uvLayoutMesh(wheel.snapshot());
      const flat = layoutView(WIDTH / HEIGHT);
      r.aim(flat);
      const atlas = await r.render(layout.mesh, layout.legend);
      expect(r.covered(atlas)).toBeGreaterThan(WIDTH * HEIGHT * 0.2);
      r.aim(main);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const tireSteps = steps.filter((s) => s.session === 'tire');
      const projected = tireSteps.find((s) => s.entry.op === 'uv.project') as RecordedStep;
      const unwraps = tireSteps.filter((s) => s.entry.op === 'uv.unwrap');
      const firstUnwrap = unwraps[0] as RecordedStep;
      const tirePacked = tireSteps.find((s) => s.entry.op === 'uv.pack') as RecordedStep;
      const tire = recording.sessions.get('tire') as Model;
      const cap = recording.sessions.get('cap') as Model;
      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0], legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const tireView = frameModel(tire, DIRECTION);
      // Packed layouts frame the unit square; others frame their islands.
      const layoutOf = async (snapshot: Uint8Array, packed: boolean) => {
        const l = uvLayoutMesh(snapshot);
        return at(packed ? flat : layoutView(WIDTH / HEIGHT, l.bounds), l.mesh, l.legend);
      };
      const exported = wheel.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } });
      if (!exported.ok) throw exported.error;
      const labels = labelMesh(wheel);
      const views: Record<string, PNG> = {
        'V-shaded': await r.render(exported.value.mesh),
        'V-uv': checker,
        'V-uv-layout': atlas,
        'V-uv-before': await at(tireView, checkerMesh(projected.snapshot)),
        'V-uv-layout-before': await layoutOf(projected.snapshot, false),
        'V-uv-first': await at(tireView, checkerMesh(firstUnwrap.snapshot)),
        'V-uv-tire': await at(tireView, checkerMesh(tirePacked.snapshot)),
        'V-uv-layout-tire': await layoutOf(tirePacked.snapshot, true),
        'V-uv-cap': await at(frameModel(cap, [0.3, 0.9, 0.3]), checkerMesh(cap.snapshot())),
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-sel-seams': await at(tireView, highlighted(tire, sel.edges.seam().or(sel.edges.sharp()).toFaces())),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['wheel.ts', 'wheel.pack.ts', '__tests__/wheel.case.dawn.test.ts', '../case/render.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validate = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === 'model.validate');
      const report = (await validate?.execute({ source: 'examples/wheel-uv/wheel.pack.ts', uniqueUv: true } as never, {} as never)) as {
        ok: boolean;
        value?: unknown;
      };
      expect(report.ok).toBe(true);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(report.value, null, 2)}\n`);
      const uvData = {
        rule: 'measureUv on each state: islands are connected components of equal uv0 corner values; Sander L2 / L-infinity stretch normalized per island (1 = isometric up to scale); area distortion = max over triangles of max(rho, 1/rho), rho = relative UV area / relative 3D area, clipped at 100; texel density dispersion = area-weighted coefficient of variation of sqrt(areaUv / area3d) over the channel; overlapPairs from validate({ uniqueUv: true })',
        states: {
          'tire: box projection (before)': measured(projected.snapshot),
          'tire: LSCM with radial and sidewall seams only': measured(firstUnwrap.snapshot),
          'tire: LSCM with sharp edges as seams, packed': measured(tirePacked.snapshot),
          'cap: LSCM (sharp seams) + ExpMap badge, packed': measured(cap.snapshot()),
          'wheel: one shared atlas': measured(wheel.snapshot()),
        },
        jobs: steps.filter(isUv).map((s) => ({ session: s.session, op: s.entry.op, line: s.line, args: s.entry.args, metrics: metricsOf(s), islands: (s.entry.diagnostics?.find((d) => d.severity === 'info')?.detail as { islands?: unknown[] } | undefined)?.islands?.slice(0, 8), warnings: s.entry.diagnostics?.filter((d) => d.severity === 'warn').map((d) => d.message) ?? [] })),
      };
      writeFileSync(join(OUT, 'uv.json'), `${JSON.stringify(uvData, null, 2)}\n`);
      const inspection = wheel.inspect();
      const history = {
        case: 'C-013',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/wheel-uv/wheel.ts',
        },
        parameters: WHEEL_DEFAULTS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; UV views frame the tire or cap session; layouts look head-on at the unit UV square',
          wheel: main,
          layout: flat,
        },
        highlight:
          'geometry steps show the faces the step touched in magenta on a box-projected stand-in; uv.* steps show the 32 x 32 checker texture on the session own uv0 (light squares tinted red along u and green along v)',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        jobs: uvData.jobs,
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          labels: inspection.labels,
          tags: inspection.tags,
          uv: measured(wheel.snapshot()),
          validate: 'validate.json',
          uvData: 'uv.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-uv': 'the finished wheel with the checker texture on its packed uv0 (one 2048 texel atlas for tire and cap)',
          'V-uv-layout': 'the uv0 atlas of the finished wheel: one color per island over the dark unit square',
          'V-uv-before': 'the tire after uv.project box: stretched squares and seams across the tread',
          'V-uv-layout-before': 'the box projection layout: islands stacked on top of each other (uv-overlap)',
          'V-uv-first': 'the tire after the first LSCM unwrap (radial and sidewall seams only): pockets and groove walls keep the long tread strip from developing; the squares shrink towards the strip ends',
          'V-uv-tire': 'the tire after the second LSCM unwrap with sharp edges as seams and its own 1024 texel pack',
          'V-uv-layout-tire': 'the tire atlas: two sidewall rings, bead band, 3 rib strips, 6 groove pieces and 640 pocket walls and floors',
          'V-uv-cap': 'the hub cap: LSCM per sharp-edge island, ExpMap badge',
          'V-tags': labels.legend,
          'V-sel-seams': 'faces along the tire cuts of the final unwrap (marked seams: radial line and sidewall loops; sharp edges: groove and pocket edges) in magenta',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
