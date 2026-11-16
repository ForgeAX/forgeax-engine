import { AssetGuid } from '@forgeax/engine/pack/source';
import { err, type MaterialAsset, resolveMaterialAsset } from '@forgeax/engine/types';
import { validateWaterAsset } from '@forgeax/engine/water';
import { expect, it } from 'vitest';
import {
  LAKE_CENTER,
  lakeOutline,
  lakeShoreDistance,
  RIVER_PATH,
  watershedHeight,
} from '../../src/watershed';
import pack from '../water-mesh.pack';

it('cooks one connected river and all four domain-valid watershed Body products', async () => {
  const result = await pack.build({
    packageId: pack.packageId,
    readByGuid: async () => err(new Error('All geometry dependencies belong to this Pack')),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  for (const variant of ['a', 'b']) {
    const terrain = result.value[`terrain/${variant}/terrain`];
    if (terrain?.kind !== 'terrain') throw new Error(`Missing Terrain ${variant}`);
    expect((terrain.columns - 1) * terrain.spacing).toBeCloseTo(960);
    expect((terrain.rows - 1) * terrain.spacing).toBeCloseTo(960);
    expect(terrain.spacing).toBeLessThanOrEqual(4);
    expect(terrain.sections).toHaveLength(16);
  }
  for (const key of ['ocean', 'lake', 'river', 'custom']) {
    const body = result.value[`body/${key}`];
    expect(body?.kind, key).toBe('water-body');
    const valid = validateWaterAsset(body);
    expect(valid.ok, `${key}: ${JSON.stringify(valid.ok ? undefined : valid.error)}`).toBe(true);
    if (body?.kind !== 'water-body') throw new Error(`Missing cooked ${key}`);
    expect(body.zoneGuid, `${key} must admit the shared Zone material publication`).toBeDefined();
  }
  const river = result.value['body/river'];
  if (river?.kind !== 'water-body') throw new Error('Missing cooked river');
  expect(river.geometrySnapshot?.queryFootprint.outer.length).toBeGreaterThan(3);
  expect(river.riverSegmentMeshGuids?.length).toBe(6);
  const table: Record<string, MaterialAsset> = {};
  for (const [key, value] of Object.entries(result.value))
    if (value.kind === 'material')
      table[AssetGuid.format(AssetGuid.derive(pack.packageId, key))] = value;
  const near = resolveMaterialAsset(
    AssetGuid.format(AssetGuid.derive(pack.packageId, 'material/ocean')),
    table,
  ).unwrap();
  const far = resolveMaterialAsset(
    AssetGuid.format(AssetGuid.derive(pack.packageId, 'material/far')),
    table,
  ).unwrap();
  for (const parameter of [
    'absorptionPerM',
    'scatteringPerM',
    'roughness',
    'normalStrength',
    'distantNormalStrength',
  ])
    expect(
      far.asset.values?.[parameter] ??
        far.asset.parameters?.find((p) => p.name === parameter)?.default,
      parameter,
    ).toEqual(
      near.asset.values?.[parameter] ??
        near.asset.parameters?.find((p) => p.name === parameter)?.default,
    );
  expect(far.asset.staticSwitches?.waterWaves).toBe(false);
  expect(far.asset.staticSwitches?.waterInfo).toBe(false);
  expect(near.asset.staticSwitches?.waterWaves).toBe(true);
  expect(near.asset.staticSwitches?.waterInfo).toBe(true);
  const lake = result.value['body/lake'];
  if (lake?.kind !== 'water-body') throw new Error('Missing lake');
  expect(lake.baseHeightM).toBe(30);
  expect(lake.queryFootprint).toEqual([
    [-244, -117],
    [-136, -117],
    [-136, -33],
    [-244, -33],
  ]);
  const shore = lakeOutline();
  const radii = shore.map(([x, z]) =>
    Math.hypot((x - LAKE_CENTER[0]) / 53, (z - LAKE_CENTER[2]) / 41),
  );
  expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.12);
  for (const [x, z] of shore) {
    expect(lakeShoreDistance(x, z)).toBeCloseTo(1);
    expect(watershedHeight(x, z)).toBeLessThan(LAKE_CENTER[1]);
  }
  for (const [x, y, z] of RIVER_PATH) expect(watershedHeight(x, z)).toBeLessThan(y);
});
