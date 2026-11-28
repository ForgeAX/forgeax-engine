import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, CHECKER_SLOT, checkerMesh, checkerTexture, createCaseRenderer, layoutView, type Rgb, uvLayoutMesh } from '../../case/render';
import { buildTurretAsset, unwrapLow } from '../asset';
import { fitView, meshPositions, TURRET_AMBIENT } from '../frame';

/**
 * C-600 turret asset, stage 1: the low game mesh with its UV atlas on the real Renderer (Dawn).
 * With FORGEAX_CASE_OUT set it writes the checker render, the shaded low and the UV layout at
 * 1600x1200 on the board background.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 320 : 1600;
const HEIGHT = OUT === undefined ? 240 : 1200;
const CLEAR: [number, number, number, number] = [0.1095, 0.1195, 0.1413, 1];
const DIRECTION = [0.56, 0.42, 0.71];
const SHADE: Record<string, Rgb> = {
  armor: [0.4, 0.43, 0.47],
  plate: [0.32, 0.35, 0.4],
  steel: [0.5, 0.5, 0.54],
  barrel: [0.3, 0.31, 0.34],
  frame: [0.16, 0.17, 0.19],
  marking: [0.86, 0.86, 0.82],
  glass: [0.04, 0.09, 0.12],
  hazard: [0.78, 0.5, 0.06],
  atlas: [0.1, 0.1, 0.11],
  'atlas-border': [0.55, 0.55, 0.58],
  Default: [0.5, 0.52, 0.55],
};

describe('C-600 turret asset: low mesh and UV (Dawn)', () => {
  it('renders the checker, the shaded low mesh and the UV layout', { timeout: 1800000 }, async () => {
    const asset = buildTurretAsset();
    unwrapLow(asset.low);
    const snapshot = asset.low.snapshot();
    const shaded = asset.low.toMesh({ normals: { mode: 'autoSmooth', angle: 45 } });
    if (!shaded.ok) throw shaded.error;
    const ASPECT = WIDTH / HEIGHT;
    const main = fitView(meshPositions(shaded.value.mesh), DIRECTION, ASPECT, CASE_FOV, 0.84);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: { ...SHADE, [CHECKER_SLOT]: [1, 1, 1] }, metallic: ['steel', 'barrel', 'frame'], view: main, clearColor: CLEAR, far: 400, ambientIrradiance: TURRET_AMBIENT, checker: checkerTexture(2048, 256) });
    try {
      r.aim(main);
      const views: Record<string, PNG> = {};
      views['V-low-shaded'] = await r.render(shaded.value.mesh);
      views['V-checker'] = await r.render(checkerMesh(snapshot));
      for (const [name, direction] of [['V-checker-rear', [-0.56, 0.42, -0.71]], ['V-checker-top', [0, 1, 0.001]]] as const) {
        r.aim(fitView(meshPositions(shaded.value.mesh), direction, ASPECT, CASE_FOV, 0.84));
        views[name] = await r.render(checkerMesh(snapshot));
      }
      const layout = uvLayoutMesh(snapshot);
      r.aim(layoutView(ASPECT));
      views['V-uv-layout'] = await r.render(layout.mesh, layout.legend);
      expect(r.covered(views['V-checker'] as PNG)).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;
      mkdirSync(OUT, { recursive: true });
      for (const [name, png] of Object.entries(views)) writeFileSync(join(OUT, `${name}.png`), PNG.sync.write(png));
    } finally {
      await r.dispose();
    }
  });
});
