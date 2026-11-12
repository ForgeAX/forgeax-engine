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
import { buildPipeBend, C129, ELBOW, sectionAlongBend } from '../body';

/**
 * Case evidence on the real Renderer (Dawn): the elbow, tight elbow, double bend and U pipe. In CI it renders small frames and checks they are non-empty; with
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
  bend: [0.9, 0.45, 0.2],
  strut: [0.3, 0.55, 0.85],
  cap: [0.85, 0.8, 0.25],
} as const;
const png = (image: PNG) => PNG.sync.write(image);
const SESSIONS = ['elbow', 'tight', 'double', 'u'] as const;

function shown(m: Model): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  for (const l of m.inspect().labels) {
    for (const role of ['node', 'bend', 'strut', 'cap']) {
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

describe('C-129 case evidence on the real renderer (Dawn)', () => {
  it('renders each pipe shaded and as wireframe', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    buildPipeBend(recording.session);
    const get = (name: string) => recording.sessions.get(name) as Model;
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main: View = frameModel(get('u'), [0, 0.1, 1]);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: main });
    try {
      const views: Record<string, PNG> = {};
      r.aim(main);
      for (const name of SESSIONS) {
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
      const section = sectionAlongBend(get('elbow'), ELBOW, C129.bendRadius, 'elbow');
      const validate = Object.fromEntries(
        SESSIONS.map((name) => [name, get(name).validate({ watertight: true })]),
      );
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      writeFileSync(join(OUT, 'section.json'), `${JSON.stringify(section, null, 2)}\n`);
      writeFileSync(join(OUT, 'u.fxem'), get('u').snapshot());
      const history = {
        case: 'C-129',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/pipe-bend/body.ts',
        },
        parameters: C129,
        cameras: { fov: CASE_FOV, width: WIDTH, height: HEIGHT, main },
        steps: steps.map((step, i) => ({ ...historyStep(step, i + 1), image: stepImages[i] })),
        sectionRadius: {
          requested: C129.radius,
          tolerance: 0.04,
          ...section,
          table: 'section.json',
        },
        validate: 'validate.json',
        snapshots: { u: 'u.fxem' },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
      expect(section.worstDeviation).toBeLessThanOrEqual(0.04);
    } finally {
      await r.dispose();
    }
  });
});
