import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frame,
  frameModel,
  historyStep,
  type View,
} from '../../case/render';
import { wireMesh } from '../../quality-body/views';
import {
  buildManifold,
  C121,
  CROSS,
  FIVE,
  MANIFOLD,
  NODE_CENTERS,
  sectionTable,
  TEE,
} from '../body';

/**
 * Case evidence on the real Renderer (Dawn): a tee, a cross and a 5-way node built by
 * pipeNetwork alone and as one connected manifold. In CI it renders small frames and checks
 * they are non-empty; with FORGEAX_CASE_OUT set it writes the case output directory:
 * one image per recorded step, the manifold shaded and as wireframe, a shaded and a wireframe
 * close-up per node, history.json and the section radius table.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 800;
const SOURCE = fileURLToPath(new URL('../body.ts', import.meta.url));
const SLOTS = {
  Default: [0.62, 0.64, 0.68],
  node: [0.9, 0.45, 0.2],
  strut: [0.3, 0.55, 0.85],
  cap: [0.85, 0.8, 0.25],
} as const;
const png = (image: PNG) => PNG.sync.write(image);

function shown(m: Model): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  for (const l of m.inspect().labels) {
    for (const role of ['node', 'strut', 'cap']) {
      if ((l.roles[role] ?? 0) > 0) view.assign(sel.createdBy(l.label, role), role);
    }
  }
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function plain(m: Model): MeshAsset {
  const out = m.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

describe('C-121 case evidence on the real renderer (Dawn)', () => {
  it('renders the manifold, its wireframe and a close-up per node', {
    timeout: 900000,
  }, async () => {
    const recording = recordingSessions();
    const m = buildManifold(recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main: View = frameModel(m, [0.35, 0.55, 1]);
    const closeOf = (
      at: readonly number[],
      direction: readonly number[],
    ): { view: View; box: number[] } => {
      const box = [
        (at[0] as number) - 0.2,
        (at[1] as number) - 0.2,
        (at[2] as number) - 0.2,
        (at[0] as number) + 0.2,
        (at[1] as number) + 0.2,
        (at[2] as number) + 0.2,
      ];
      return { view: frame({ min: box.slice(0, 3), max: box.slice(3) }, CASE_FOV, direction), box };
    };
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: main });
    try {
      const views: Record<string, PNG> = {};
      r.aim(main);
      views['V-shaded'] = await r.render(shown(m));
      views['V-wire'] = await r.render(plain(m), [], 3, [wireMesh(m)]);
      const closes = NODE_CENTERS.map((n) => ({ ...n, ...closeOf(n.at, [0.45, 0.4, 1]) }));
      for (const c of closes) {
        r.aim(c.view);
        views[`V-node-${c.name}`] = await r.render(shown(m));
        views[`V-node-${c.name}-wire`] = await r.render(plain(m), [], 3, [wireMesh(m, c.box)]);
      }
      expect(
        Object.entries(views)
          .filter(([, image]) => r.covered(image) === 0)
          .map(([view]) => view),
      ).toEqual([]);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      mkdirSync(OUT, { recursive: true });
      for (const [view, image] of Object.entries(views))
        writeFileSync(join(OUT, `view-${view}.png`), png(image));
      r.aim(main);
      const stepImages: string[] = [];
      for (const [i, step] of steps.entries()) {
        const name = `step-${String(i + 1).padStart(2, '0')}.png`;
        const state = model();
        state.append(step.snapshot);
        await Promise.resolve();
        writeFileSync(join(OUT, name), png(await r.render(shown(state))));
        stepImages.push(name);
      }
      mkdirSync(join(OUT, 'source'), { recursive: true });
      copyFileSync(SOURCE, join(OUT, 'source', 'body.ts'));
      const sessions = { tee: TEE, cross: CROSS, 'five-way': FIVE, manifold: MANIFOLD } as const;
      const table = Object.entries(sessions).flatMap(([name, net]) =>
        sectionTable(recording.sessions.get(name) as Model, net).map((row) => ({
          session: name,
          ...row,
        })),
      );
      const validate = Object.fromEntries(
        Object.keys(sessions).map((name) => [
          name,
          (recording.sessions.get(name) as Model).validate({ watertight: true }),
        ]),
      );
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      writeFileSync(join(OUT, 'section-table.json'), `${JSON.stringify(table, null, 2)}\n`);
      writeFileSync(join(OUT, 'manifold.fxem'), m.snapshot());
      const worst = Math.max(...table.map((row) => row.maxDeviation));
      const history = {
        case: 'C-121',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/pipe-manifold/body.ts',
        },
        parameters: C121,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          main,
          rule: 'steps and V-shaded share one camera on the manifold (a node built alone appears at its place in the manifold frame); node close-ups are 0.4 m boxes around each node',
          closeups: closes.map((c) => ({ node: c.name, view: c.view, box: c.box })),
        },
        steps: steps.map((step, i) => ({ ...historyStep(step, i + 1), image: stepImages[i] })),
        sectionRadius: {
          requested: C121.radius,
          tolerance: 0.03,
          worstDeviation: worst,
          table: 'section-table.json',
        },
        validate: 'validate.json',
        snapshots: { manifold: 'manifold.fxem' },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
      expect(worst).toBeLessThanOrEqual(0.03);
    } finally {
      await r.dispose();
    }
  });
});
