import { CONTENT_PACKAGE_IDS } from '@forgeax/engine/content';
import { AssetGuid, type PackBuildReadContext } from '@forgeax/engine/pack/source';
import { err, type MaterialAsset, ok, resolveMaterialAsset } from '@forgeax/engine/types';
import { buildWaterMaterialFamily } from '@forgeax/engine/water';
import { expect, it } from 'vitest';
import pack from '../r5-gpu-mesh-async-pontoons/assets/estuary.pack';

type XZ = readonly [number, number];

function inRing(point: XZ, ring: readonly XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) throw new Error('Expected a closed footprint');
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

it('keeps the open harbor and river outlet at the Ocean mean level', async () => {
  const family = buildWaterMaterialFamily(CONTENT_PACKAGE_IDS.water);
  const dependencies = Object.fromEntries(
    Object.entries(family.outputs).map(([key, asset]) => [
      AssetGuid.format(AssetGuid.derive(CONTENT_PACKAGE_IDS.water, key)),
      asset,
    ]),
  );
  const readByGuid: PackBuildReadContext['readByGuid'] = async <TAsset>(guid: AssetGuid) => {
    const asset = dependencies[AssetGuid.format(guid)];
    return asset === undefined
      ? err(new Error('Expected Engine Water material'))
      : ok(asset as TAsset);
  };
  const assets = (await pack.build({ packageId: pack.packageId, readByGuid })).unwrap();
  const lake = assets['body/lake'];
  const ocean = assets['body/ocean'];
  const river = assets['body/river'];
  if (lake?.kind !== 'water-body' || ocean?.kind !== 'water-body' || river?.kind !== 'water-body')
    throw new Error('Expected the three connected estuary bodies');
  expect(lake.baseHeightM).toBe(ocean.baseHeightM);
  expect(river.spline.points.at(-1)?.positionM[1]).toBe(lake.baseHeightM);
  // These exposed bed locations are below the minimum wave, near both shores.
  for (const point of [
    [20, 38],
    [20, -38],
    [-75, -9.5],
    [-75, -26.5],
  ] as const) {
    expect(
      [river, lake, ocean].some((body) => {
        const footprint = body.geometrySnapshot?.queryFootprint;
        return (
          footprint &&
          inRing(point, footprint.outer) &&
          !footprint.holes.some((hole) => inRing(point, hole))
        );
      }),
      `wet bed at ${point.join(',')} needs water coverage`,
    ).toBe(true);
  }
  const harborFootprint = lake.geometrySnapshot?.queryFootprint;
  const riverFootprint = river.geometrySnapshot?.queryFootprint;
  if (!harborFootprint || !riverFootprint) throw new Error('Expected cooked estuary footprints');
  // The whole tidal reach uses River flow with the harbor's incident wave field.
  for (const point of riverFootprint.outer)
    expect(inRing(point, harborFootprint.outer), `tidal reach at ${point.join(',')}`).toBe(true);
  const materials = { ...dependencies } as Record<string, MaterialAsset>;
  for (const [key, asset] of Object.entries(assets))
    if (asset.kind === 'material')
      materials[AssetGuid.format(AssetGuid.derive(pack.packageId, key))] = asset;
  for (const material of [river.surfaceMaterialGuid, river.riverToLakeTransitionMaterialGuid]) {
    if (!material) throw new Error('Expected connected River materials');
    const resolved = resolveMaterialAsset(material, materials).unwrap();
    expect(resolved.asset.staticSwitches?.waterWaves, material).toBe(true);
  }
}, 30_000);
