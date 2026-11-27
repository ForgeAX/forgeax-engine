import { definePack, gpuTextureOutputs } from '@forgeax/engine-pack/source';
import { ok, type TextureGenerationRasterPass } from '@forgeax/engine-types';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS } from '../../src/ids.ts';

const size = 256;
const levelCount = 9;
const shape = { viewDimension: '2d', extent: { width: size, height: size } } as const;
const mips = { kind: 'custom', levelCount } as const;
const writes = ['noise', 'average'];
const passes: TextureGenerationRasterPass[] = [
  {
    kind: 'raster',
    program: { module: 'forgeax::water_impulse_field', fragmentEntry: 'impulseField' },
    reads: {},
    writes,
  },
];
for (let mipLevel = 1; mipLevel < levelCount; mipLevel++)
  passes.push({
    kind: 'raster',
    mipLevel,
    program: { module: 'forgeax::water_impulse_mip', fragmentEntry: 'impulseMip' },
    reads: { previous: { kind: 'local', name: 'average', mipLevel: mipLevel - 1 } },
    writes,
  });

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.waterImpulse,
  name: 'Engine Content / Default Fluid Impulse Noise',
  build() {
    const generated = gpuTextureOutputs(CONTENT_PACKAGE_IDS.waterImpulse, 'impulse', {
      values: {},
      inputs: {},
      outputs: { noise: { shape, mips, format: 'rgba8unorm-srgb', colorSpace: 'srgb' } },
      transient: { average: { shape, mips, format: 'r32float' } },
      passes,
    });
    return ok(Object.fromEntries(Object.entries(generated).map(([key, asset]) => [
      asset.kind === 'gpu-texture' ? CONTENT_SOURCE_KEYS.waterTexture('impulse-noise') : key,
      asset,
    ])));
  },
});
