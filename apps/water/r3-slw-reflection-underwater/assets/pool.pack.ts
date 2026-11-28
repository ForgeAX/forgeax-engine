import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { type MaterialRootAsset, ok, type TextureAsset } from '@forgeax/engine/types';
import { POOL_GRID, POOL_PACKAGE, POOL_SIM_SIZE } from '../src/pool/identity';

function texture(size: number, data: Uint8Array): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  };
}

/** Glazed ceramic: cell layout, seeded color variation, grout and bevel shading. */
export function poolTilePixels(size = 768): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const cell = size / 24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / cell);
      const col = Math.floor(x / cell);
      const edge = Math.min(x % cell, y % cell, cell - 1 - (x % cell), cell - 1 - (y % cell));
      const seed = ((row * 92837111) ^ (col * 689287499)) >>> 0;
      const shade = (seed % 17) / 255;
      const grout = edge < 0.75;
      const bevel = edge < 2 ? 0.94 : 1;
      const offset = (y * size + x) * 4;
      data[offset] = Math.round((grout ? 0.18 : (0.69 + shade) * bevel) * 255);
      data[offset + 1] = Math.round((grout ? 0.19 : (0.7 + shade) * bevel) * 255);
      data[offset + 2] = Math.round((grout ? 0.19 : (0.7 + shade) * bevel) * 255);
      data[offset + 3] = 255;
    }
  }
  return data;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: POOL_PACKAGE,
  name: 'Procedural Interactive Pool',
  build: ({ packageId }) => {
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const flat = new Uint8Array(POOL_SIM_SIZE * POOL_SIM_SIZE * 4);
    const parameters = [
      { name: 'heightField', type: 'texture' as const, sampleType: 'unfilterable-float' as const },
      { name: 'sourceGrid', type: 'u32' as const, default: POOL_GRID },
      { name: 'lightDirection', type: 'vec3' as const, default: [0.666667, 0.666667, -0.333333] },
      { name: 'ball', type: 'vec4' as const, default: [-0.4, -0.65, 0.2, 0.24] },
    ];
    return ok({
      'texture/height': { ...texture(POOL_SIM_SIZE, flat), format: 'r32float' },
      'texture/tiles': { ...texture(768, poolTilePixels()), mips: { kind: 'generate' } },
      'material/field': {
        kind: 'material',
        parameters,
        values: { heightField: guid('texture/height') },
        passes: [
          {
            name: 'Forward',
            program: { module: 'water_pool::field', bindings: 'render-material' },
          },
        ],
      } satisfies MaterialRootAsset,
      'material/scene': {
        kind: 'material',
        parameters: [
          ...parameters,
          { name: 'tiles', type: 'texture' },
          { name: 'viewport', type: 'vec4', default: [1024, 768, 0.41421356, 1] },
          { name: 'appearance', type: 'vec4', default: [1, 1, 1, 0] },
        ],
        values: {
          heightField: guid('texture/height'),
          tiles: guid('texture/tiles'),
        },
        passes: [
          {
            name: 'Forward',
            program: {
              module: 'water_pool::scene',
              bindings: 'post-process',
              sceneDepth: 'before-pass',
              fragmentEntry: 'fs_main',
              postProcess: {
                placement: 'after-tonemap',
                input: 'current-output',
                output: 'current-output',
              },
            },
            outputs: [{ name: 'color', format: 'rgba16float' }],
            renderState: { tags: { LightMode: 'PostProcess' } },
          },
        ],
      } satisfies MaterialRootAsset,
    });
  },
});
