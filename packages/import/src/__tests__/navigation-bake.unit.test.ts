import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { bakeNavigationMesh, type NavigationBakeSource } from '../navigation-bake';

const settings = {
  radius: 0.3,
  height: 1.8,
  maxSlopeDeg: 45,
  maxStep: 0.3,
  cellSize: 0.1,
  cellHeight: 0.05,
};
const floor = createBoxGeometry(10, 0.2, 10).unwrap();
const source: NavigationBakeSource = {
  geometry: [{ mesh: floor, world: mat4.identity(mat4.create()) }],
  settings,
};
describe('Recast navigation producer', () => {
  it('bakes persistent world polygons and fingerprints all geometry/settings', async () => {
    const baked = (await bakeNavigationMesh(source)).unwrap();
    expect(baked.polygons.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(baked))).toEqual(baked);
    expect((await bakeNavigationMesh(source)).unwrap().sourceDigest).toBe(baked.sourceDigest);
    const larger = (
      await bakeNavigationMesh({ ...source, settings: { ...settings, radius: 0.6 } })
    ).unwrap();
    expect(larger.sourceDigest).not.toBe(baked.sourceDigest);
    const translated = mat4.identity(mat4.create());
    translated[12] = 12;
    translated[0] = 2;
    const placed = (
      await bakeNavigationMesh({ ...source, geometry: [{ mesh: floor, world: translated }] })
    ).unwrap();
    expect(Math.min(...placed.vertices.filter((_, i) => i % 3 === 0))).toBeGreaterThan(2);
    expect(placed.sourceDigest).not.toBe(baked.sourceDigest);
  });
  it('rejects invalid/empty data and cell/triangle limits before WASM allocation', async () => {
    expect((await bakeNavigationMesh({ ...source, geometry: [] })).ok).toBe(false);
    expect(
      (await bakeNavigationMesh({ ...source, settings: { ...settings, radius: NaN } })).ok,
    ).toBe(false);
    expect(await bakeNavigationMesh({ ...source, maxCells: 10 })).toMatchObject({
      ok: false,
      error: { code: 'navigation-bake-limit' },
    });
    expect(await bakeNavigationMesh({ ...source, maxTriangles: 1 })).toMatchObject({
      ok: false,
      error: { code: 'navigation-bake-limit' },
    });
  });
});
