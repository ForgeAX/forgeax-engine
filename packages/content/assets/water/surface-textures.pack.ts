import { definePack, gpuTextureOutputs } from '@forgeax/engine-pack/source';
import {
  type Asset,
  type GeneratedTextureDescriptor,
  ok,
  type TextureGenerationRasterPass,
  type TextureGeneratorAsset,
} from '@forgeax/engine-types';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS, type ContentWaterTextureName } from '../../src/ids.ts';

type SurfaceName = Exclude<ContentWaterTextureName, 'volume-noise' | 'impulse-noise'>;
type Recipe = Omit<TextureGeneratorAsset, 'kind' | 'outputs' | 'inputs'> & {
  readonly outputs: Readonly<Partial<Record<SurfaceName, GeneratedTextureDescriptor>>>;
};

const shape = (size: number) =>
  ({ viewDimension: '2d', extent: { width: size, height: size } }) as const;

const output = (size: number, colorSpace: 'srgb' | 'linear' = 'linear'): GeneratedTextureDescriptor => ({
  shape: shape(size),
  format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
  colorSpace,
  mips: { kind: 'generate' },
});

const scalar = (size: number) => ({ shape: shape(size), format: 'r32float' }) as const;

function raster(
  module: string,
  fragmentEntry: string,
  writes: readonly string[],
  field?: string,
): TextureGenerationRasterPass {
  return {
    kind: 'raster',
    program: { module: `forgeax::${module}`, fragmentEntry },
    reads: field === undefined ? {} : { sourceField: { kind: 'local', name: field } },
    writes,
  };
}

// Two transposed passes form one separable periodic box blur.
const soften = [
  raster('water_field_blur', 'blur', ['scratch'], 'field'),
  raster('water_field_blur', 'blur', ['field'], 'scratch'),
  raster('water_field_blur', 'blur', ['scratch'], 'field'),
  raster('water_field_blur', 'blur', ['field'], 'scratch'),
];

const recipes: Readonly<Record<string, Recipe>> = {
  foam: {
    values: {
      radius: 8,
      strength: 9,
      _blurPad: 0,
      _padding: [0, 0],
      mean: [127.500418, 127.499643],
      deviation: [6.80428636, 6.72820384],
      center: [127.51, 127.51],
      spread: [17.28, 16.36],
    },
    outputs: { foam: output(2048, 'srgb'), 'foam-normal': output(2048) },
    transient: { field: scalar(2048), scratch: scalar(2048) },
    passes: [
      raster('water_foam_field', 'foamField', ['field', 'foam']),
      ...soften,
      raster('water_field_normal', 'fieldNormal', ['foam-normal'], 'field'),
    ],
  },
  river: {
    values: {
      strength: 4,
      _padding: [0, 0],
      mean: [127.498538, 127.502481],
      deviation: [13.329364, 13.509888],
      center: [126.97, 126.85],
      spread: [22.39, 30.17],
    },
    outputs: { 'river-diffuse': output(512, 'srgb'), 'river-normal': output(512) },
    transient: { field: scalar(512) },
    passes: [
      raster('water_river_field', 'riverField', ['field', 'river-diffuse']),
      raster('water_field_normal', 'fieldNormal', ['river-normal'], 'field'),
    ],
  },
  normal: {
    values: { radius: 3, _blurPad: 0, _padding: [0, 0] },
    outputs: { normal: output(1024) },
    transient: { field: scalar(1024), scratch: scalar(1024) },
    passes: [
      raster('water_normal_field', 'normalField', ['field']),
      ...soften,
      raster('water_tiling_texture', 'tilingNormal', ['normal'], 'field'),
    ],
  },
  noise: {
    values: {},
    outputs: { noise: output(64) },
    transient: {},
    passes: [raster('water_flow_noise', 'flowNoise', ['noise'])],
  },
};

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.waterSurface,
  name: 'Engine Content / Water Surface Textures',
  build: () => {
    const assets: Record<string, Asset> = {};
    for (const [name, recipe] of Object.entries(recipes)) {
      const generatorName = `water-surface-${name}`;
      const generated = gpuTextureOutputs(CONTENT_PACKAGE_IDS.waterSurface, generatorName, {
        ...recipe,
        inputs: {},
      });
      for (const [key, asset] of Object.entries(generated)) {
        const sourceKey =
          asset.kind === 'gpu-texture'
            ? CONTENT_SOURCE_KEYS.waterTexture(asset.source.output as SurfaceName)
            : key;
        assets[sourceKey] = asset;
      }
    }
    return ok(assets);
  },
});
