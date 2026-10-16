import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import { ok, standardSurfaceParameters, type Asset, type MaterialAsset } from '@forgeax/engine-types';

const packageId = definePackageId('019fcaf0-0000-7000-8000-000000000001');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
const layer: MaterialAsset = {
  kind: 'material', parameters: standardSurfaceParameters([]),
  values: { baseColor: [0.5, 0.5, 0.5, 1], roughness: 1 },
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
};

// Both author rows become the same y=x plane at LOD2. Their BA normals
// differ: near +Y in the first case and opposite the actual Ng in the second.
// A vertical light cannot legitimately self-occlude either heightfield.
export default definePack({
  schemaVersion: '2.0.0', packageId, name: 'Terrain receiver-plane regressions',
  build: () => {
    const outputs: Record<string, Asset> = {};
    for (const [prefix, row] of [
      ['', [0, 0, 0, 0, 7, 7, 7, 7]],
      ['orientation/', [0, -7, 0, 0, 7, 7, 14, 7]],
    ] as const) {
      const identify = (key: string) => guid(prefix + key);
      const built = buildTerrainAssets({
        columns: 8, rows: 8, spacing: 1, subsectionVertices: 8,
        heights: Float32Array.from({ length: 64 }, (_, i) => row[i % 8] ?? 0),
        weights: new Float32Array(64).fill(1),
        layers: [{ material: identify('layer'), blend: 'weight' }],
      }, identify, { [identify('layer')]: layer });
      if (!built.ok) return built;
      outputs[prefix + 'layer'] = layer;
      for (const [key, value] of Object.entries(built.value)) outputs[prefix + key] = value;
    }
    return ok(outputs);
  },
});
