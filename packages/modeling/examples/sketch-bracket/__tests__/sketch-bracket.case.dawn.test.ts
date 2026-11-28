import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frameModel,
  frameSnapshot,
  historyStep,
  labelMesh,
  stateMesh,
} from '../../case/render';
import { BRACKET_DEFAULTS, type BracketParameters, buildBracket, solveBracket } from '../sketch-bracket';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the finished bracket;
 * with FORGEAX_CASE_OUT set it writes the output directory: one image per recorded
 * step, final views, a slant sweep, history.json, validate.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../sketch-bracket.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIRECTION = [0.4, 0.55, 1];
const FACE_ON = [0.02, 0.03, 1];
const SWEEP: readonly BracketParameters[] = [60, 70, 85].map((slantDegrees) => ({
  ...BRACKET_DEFAULTS,
  slantDegrees,
}));

describe('sketch-bracket case evidence on the real renderer (Dawn)', () => {
  it('renders the recorded steps, final views and a slant sweep', { timeout: 900000 }, async () => {
    const recording = recordingSessions();
    const bracket = buildBracket(BRACKET_DEFAULTS, recording.session);
    expect(bracket.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(bracket, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: { Default: [0.62, 0.64, 0.68] },
      metallic: [],
      view: main,
    });
    try {
      const exported = bracket.toMesh({ normals: { mode: 'weighted' } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const at = async (view: ReturnType<typeof frameModel>, mesh: Parameters<typeof r.render>[0]) => {
        r.aim(view);
        const png = await r.render(mesh);
        r.aim(main);
        return png;
      };
      const meshOf = (m: ReturnType<typeof buildBracket>) => {
        const out = m.toMesh({ normals: { mode: 'weighted' } });
        if (!out.ok) throw out.error;
        return out.value.mesh;
      };
      const labels = labelMesh(bracket);
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-top': await at(frameModel(bracket, FACE_ON), meshOf(bracket)),
        'V-low': await at(frameModel(bracket, [1, 0.2, 0.7]), meshOf(bracket)),
        'V-tags': await r.render(labels.mesh, labels.legend),
      };
      for (const p of SWEEP) {
        const variant = buildBracket(p);
        views[`V-slant-${p.slantDegrees}`] = await at(
          frameModel(variant, FACE_ON),
          meshOf(variant),
        );
      }
      const stepImages: PNG[] = [];
      for (const step of steps) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        stepImages.push(await r.render(stateMesh(step.snapshot, undefined)));
      }
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of stepImages.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of [
        'sketch-bracket.ts',
        'sketch-bracket.pack.ts',
        '__tests__/sketch-bracket.case.dawn.test.ts',
      ]) {
        copyFileSync(
          fileURLToPath(new URL(`../${file}`, import.meta.url)),
          join(OUT, 'source', file.replace('__tests__/', '')),
        );
      }
      const validate = createModelingTools({ projectRoot: ROOT }).find(
        (t) => t.descriptor.id === 'model.validate',
      );
      const report = (await validate?.execute(
        { source: 'examples/sketch-bracket/sketch-bracket.pack.ts' } as never,
        {} as never,
      )) as { ok: boolean; value?: { status: string } };
      expect(report.ok).toBe(true);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(report.value, null, 2)}\n`);
      const inspection = bracket.inspect();
      const solution = solveBracket();
      const history = {
        case: 'sketch-bracket',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/sketch-bracket/sketch-bracket.ts',
        },
        parameters: BRACKET_DEFAULTS,
        cameras: { fov: CASE_FOV, width: WIDTH, height: HEIGHT, bracket: main },
        sketch: { residual: solution.residual, dof: solution.dof, free: solution.free },
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          volume: bracket.validate().volume,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});
