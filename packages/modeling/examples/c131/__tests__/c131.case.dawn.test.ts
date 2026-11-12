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
import { buildCombo, C131, cornerQuality, coverShutLine, hemAttempt, scanKit } from '../body';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders small frames and checks they
 * are non-empty; with FORGEAX_CASE_OUT set it writes the case output directory.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 800;
const SOURCE = fileURLToPath(new URL('../body.ts', import.meta.url));
const SLOTS = {
  Default: [0.62, 0.64, 0.68],
  node: [0.9, 0.45, 0.2],
  strut: [0.3, 0.55, 0.85],
  weld: [0.35, 0.8, 0.4],
  cap: [0.85, 0.8, 0.25],
} as const;
const png = (image: PNG) => PNG.sync.write(image);
const SESSIONS = ['cover', 'corner', 'kit'] as const;

function shown(m: Model): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  for (const l of m.inspect().labels) {
    for (const role of ['node', 'strut', 'cap', 'weld']) {
      if ((l.roles[role] ?? 0) > 0) view.assign(sel.createdBy(l.label, role), role);
    }
  }
  view.uv.project({ mode: 'box', scale: 0.5 });
  view.uv.project({ mode: 'box', scale: 0.5, channel: 'uv1' });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function plain(m: Model): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  view.uv.project({ mode: 'box', scale: 0.5 });
  view.uv.project({ mode: 'box', scale: 0.5, channel: 'uv1' });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

describe('C-131 case evidence on the real renderer (Dawn)', () => {
  it('renders each session shaded and as wireframe', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const combo = buildCombo(recording.session);
    const get = (name: string) => recording.sessions.get(name) as Model;
    const steps = attachSourceLines(recording.steps, SOURCE);
    const framed: Record<string, View> = {
      kit: frameModel(get('kit'), [0.15, 0.2, 1]),
      cover: frameModel(get('cover'), [0.3, 0.5, 1]),
      corner: frameModel(get('corner'), [-1, -0.8, -1]),
    };
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: framed.kit as View });
    try {
      const views: Record<string, PNG> = {};
      for (const name of SESSIONS) {
        r.aim(framed[name] as View);
        views[`V-${name}`] = await r.render(shown(get(name)));
        views[`V-${name}-wire`] = await r.render(plain(get(name)), [], 3, [wireMesh(get(name))]);
      }
      expect(
        Object.entries(views)
          .filter(([view, image]) => r.covered(image) === 0 && view !== 'V-corner')
          .map(([view]) => view),
      ).toEqual([]);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      mkdirSync(OUT, { recursive: true });
      for (const [view, image] of Object.entries(views))
        writeFileSync(join(OUT, `view-${view}.png`), png(image));
      const stepImages: string[] = [];
      r.aim(framed.kit as View);
      for (const [i, step] of steps.entries()) {
        const name = `step-${String(i + 1).padStart(2, '0')}.png`;
        const state = model();
        state.append(step.snapshot);
        await Promise.resolve();
        r.aim(framed[step.session] as View);
        writeFileSync(join(OUT, name), png(await r.render(shown(state))));
        stepImages.push(name);
      }
      mkdirSync(join(OUT, 'source'), { recursive: true });
      copyFileSync(SOURCE, join(OUT, 'source', 'body.ts'));
      const kit = get('kit');
      const scan = scanKit(kit, combo.joints);
      const measurements = {
        weld: combo.joints.map((j) => ({
          joint: j.name,
          expected: j.expect,
          result: j.weld,
          reason: j.reason ?? null,
          detail: j.detail ?? null,
          watertight: j.watertight,
          faces: j.faces,
          ms: j.ms,
          fallback: j.fallback,
        })),
        interference: scan.result,
        shutLine: coverShutLine(kit),
        hem: hemAttempt(),
        cornerQuality: cornerQuality(),
      };
      writeFileSync(join(OUT, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
      const validate = {
        kit: kit.validate({ watertight: true }),
        cover: get('cover').validate({ watertight: true }),
        corner: get('corner').validate({ watertight: true }),
      };
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      writeFileSync(join(OUT, 'kit.fxem'), kit.snapshot());
      const history = {
        case: 'C-131',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/c131/body.ts',
        },
        parameters: C131,
        cameras: { fov: CASE_FOV, width: WIDTH, height: HEIGHT, main: framed.kit },
        steps: steps.map((step, i) => ({ ...historyStep(step, i + 1), image: stepImages[i] })),
        measurements: 'measurements.json',
        validate: 'validate.json',
        snapshots: { kit: 'kit.fxem' },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
