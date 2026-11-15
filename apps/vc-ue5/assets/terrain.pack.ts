import { createBoxGeometry, meshFromInterleaved } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok, type SamplerAsset, type TextureAsset } from '@forgeax/engine/types';

const terrainPackage = definePackageId('019a50a5-0000-7000-8000-000000000002');
const terrainKeys = {
  ground: 'mesh/ground',
  occluder: 'mesh/occluder',
  groundMaterial: 'material/ground',
  occluderMaterial: 'material/occluder',
} as const;
const guid = (key: string) => AssetGuid.derive(terrainPackage, key);
export const terrainRefs = Object.fromEntries(
  Object.entries(terrainKeys).map(([name, key]) => [name, { $asset: AssetGuid.format(guid(key)) }]),
);

/** Flat, two-meter repeats. Independent geometry and texture authored for this demo. */
function groundMesh() {
  const extent = 40_000;
  const repeats = extent;
  return meshFromInterleaved(
    new Float32Array([
      -extent, 0,  extent, 0, 1, 0, 0, 0,
       extent, 0,  extent, 0, 1, 0, repeats, 0,
       extent, 0, -extent, 0, 1, 0, repeats, repeats,
      -extent, 0, -extent, 0, 1, 0, 0, repeats,
    ]),
    new Uint16Array([0, 1, 2, 0, 2, 3]),
  );
}

function groundTile(): TextureAsset {
  const width = 128;
  const half = width / 2;
  const data = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const joint = x % half < 2 || y % half < 2;
      const gray = joint ? 71 : (x < half) === (y < half) ? 105 : 115;
      data.set([gray + 5, gray + 3, gray, 255], 4 * (y * width + x));
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height: width } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    mips: { kind: 'generate' },
    data,
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: terrainPackage,
  build: () => ok({
    [terrainKeys.ground]: groundMesh().unwrap(),
    [terrainKeys.occluder]: createBoxGeometry(1.25, 1.9, 0.6).unwrap(),
    'texture/concrete-grid': groundTile(),
    'sampler/concrete-grid': {
      kind: 'sampler',
      minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8,
    } satisfies SamplerAsset,
    [terrainKeys.groundMaterial]: Materials.standard({
      baseColor: [1, 1, 1, 1],
      baseColorTexture: { texture: guid('texture/concrete-grid'), sampler: guid('sampler/concrete-grid') },
      roughness: 0.86,
      metallic: 0,
    }),
    [terrainKeys.occluderMaterial]: Materials.standard({
      baseColor: [0.35, 0.09, 0.038, 1],
      roughness: 0.85,
      metallic: 0,
    }),
  }),
});
