import { definePack } from '@forgeax/engine/pack/source';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import { ok, standardSurfaceParameters, type Asset, type MaterialAsset } from '@forgeax/engine/types';
import { WATER_R0_TERRAIN_PACKAGE_NAMESPACE, waterR0TerrainGuid } from '../src/surface-standard-evidence-identity';

const packageId = WATER_R0_TERRAIN_PACKAGE_NAMESPACE;
const guid = (key: string) => waterR0TerrainGuid(key);
const layer: MaterialAsset = {
  kind: 'material',
  parameters: standardSurfaceParameters([]),
  values: { baseColor: [0.2, 0.35, 0.28, 1], roughness: 1 },
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
};

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  name: 'Water R0 base terrain',
  build: () => {
    const layerGuid = guid('terrain/layer');
    const built = buildTerrainAssets({
      columns: 8,
      rows: 8,
      spacing: 1,
      subsectionVertices: 8,
      heights: Float32Array.from({ length: 64 }, (_, index) => Math.sin((index % 8) * 0.2) * 0.15),
      weights: new Float32Array(64).fill(1),
      layers: [{ material: layerGuid, blend: 'weight' }],
    }, guid, { [layerGuid]: layer });
    if (!built.ok) return built;
    const { terrain, ...derivedOutputs } = built.value;
    const outputs: Record<string, Asset> = { 'terrain/layer': layer, 'terrain/base': terrain!, ...derivedOutputs };
    return ok(outputs);
  },
});
