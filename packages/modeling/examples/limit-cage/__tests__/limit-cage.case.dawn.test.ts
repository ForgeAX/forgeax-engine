import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frameModel,
  frameSnapshot,
  historyStep,
  stateMesh,
  touched,
} from '../../case/render';
import { buildLimitCage, LIMIT_CAGE } from '../body';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the finished cage; with
 * FORGEAX_CASE_OUT set it writes the case output directory: one image per recorded
 * step, history.json, validate.json and the sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1000;
const HEIGHT = OUT === undefined ? 160 : 750;
const SOURCE = fileURLToPath(new URL('../body.ts', import.meta.url));
const DIRECTION = [0.62, 0.6, 0.5];
const SLOTS = { Default: [0.72, 0.68, 0.62], highlight: [0.95, 0.2, 0.55] } as const;

describe('C-124 case evidence on the real renderer (Dawn)', () => {
  it('renders the cage, taper and limit steps', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const base = buildLimitCage(LIMIT_CAGE, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOTS,
      metallic: [],
      view: frameModel(base, DIRECTION),
    });
    try {
      const mesh = base.toMesh({ normals: { mode: 'weighted' } });
      if (!mesh.ok) throw mesh.error;
      r.aim(frameModel(base, DIRECTION));
      const final = await r.render(mesh.value.mesh);
      expect(r.covered(final)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      mkdirSync(join(OUT, 'source'), { recursive: true });
      const stepImages: string[] = [];
      for (const [i, step] of steps.entries()) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        const name = `step-${String(i + 1).padStart(2, '0')}.png`;
        writeFileSync(
          join(OUT, name),
          PNG.sync.write(await r.render(stateMesh(step.snapshot, touched(step)))),
        );
        stepImages.push(name);
      }
      writeFileSync(join(OUT, 'view-V-final.png'), PNG.sync.write(final));
      for (const file of [
        'body.ts',
        '__tests__/limit-cage.case.dawn.test.ts',
        '__tests__/limit-cage.unit.test.ts',
      ]) {
        copyFileSync(
          fileURLToPath(new URL(`../${file}`, import.meta.url)),
          join(OUT, 'source', file.split('/').at(-1) as string),
        );
      }
      const validate = base.validate({ minThickness: 0.002 });
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      const inspection = base.inspect();
      const history = {
        case: 'C-124',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/limit-cage/body.ts',
        },
        parameters: LIMIT_CAGE,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction',
        },
        highlight: 'each step image shows the faces the step touched in magenta',
        steps: steps.map((step, i) => ({
          ...historyStep(step, i + 1),
          selectors: step.entry.selectors ?? [],
          image: stepImages[i],
        })),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          labels: inspection.labels,
          validate: 'validate.json',
        },
        views: [{ view: 'V-final', image: 'view-V-final.png' }],
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
