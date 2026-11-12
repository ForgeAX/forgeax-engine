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
  frameModel,
  historyStep,
  type View,
} from '../../case/render';
import { wireMesh } from '../../quality-body/views';
import { buildHairFork, C127, FORK, LOCK, sectionTable } from '../body';

/**
 * Case evidence on the real Renderer (Dawn): the equal fork, the 1:2 fork, the tapering
 * fork and the tapering lock. In CI it renders small frames and checks they are non-empty; with
 * FORGEAX_CASE_OUT set it writes the case output directory: one image per recorded
 * step, shaded and wireframe views per session, history.json and the section radius table.
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
const SESSIONS = { equal: FORK, fork: FORK, taper: FORK, lock: LOCK } as const;

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
  const view = model();
  view.append(m.snapshot());
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

describe('C-127 case evidence on the real renderer (Dawn)', () => {
  it('renders each fork shaded and as wireframe', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    buildHairFork(recording.session);
    const get = (name: string) => recording.sessions.get(name) as Model;
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main: View = frameModel(get('lock'), [0.2, 0.15, 1]);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: main });
    try {
      const views: Record<string, PNG> = {};
      r.aim(main);
      for (const name of Object.keys(SESSIONS)) {
        views[`V-${name}`] = await r.render(shown(get(name)));
        views[`V-${name}-wire`] = await r.render(plain(get(name)), [], 3, [wireMesh(get(name))]);
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
      const table = Object.entries(SESSIONS).flatMap(([name, net]) =>
        sectionTable(get(name), net).map((row) => ({ session: name, ...row })),
      );
      const validate = Object.fromEntries(
        Object.keys(SESSIONS).map((name) => [name, get(name).validate({ watertight: true })]),
      );
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      writeFileSync(join(OUT, 'section-table.json'), `${JSON.stringify(table, null, 2)}\n`);
      writeFileSync(join(OUT, 'lock.fxem'), get('lock').snapshot());
      const middle = table.filter((_, i) => i % 3 === 1);
      const history = {
        case: 'C-127',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/hair-fork/body.ts',
        },
        parameters: C127,
        cameras: { fov: CASE_FOV, width: WIDTH, height: HEIGHT, main },
        steps: steps.map((step, i) => ({ ...historyStep(step, i + 1), image: stepImages[i] })),
        sectionRadius: {
          tolerance: { middle: 0.03, nearNode: 0.1 },
          worstMiddleDeviation: Math.max(...middle.map((row) => row.maxDeviation)),
          worstDeviation: Math.max(...table.map((row) => row.maxDeviation)),
          table: 'section-table.json',
        },
        validate: 'validate.json',
        snapshots: { lock: 'lock.fxem' },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
      expect(history.sectionRadius.worstMiddleDeviation).toBeLessThanOrEqual(0.03);
    } finally {
      await r.dispose();
    }
  });
});
