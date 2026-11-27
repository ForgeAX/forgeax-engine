import { definePack, gpuTextureOutputs } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS } from '../../src/ids.ts';

const SIZE = 128;

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.waterVolume,
  name: 'Engine Content / Water Volume Noise',
  build: () => {
    const generated = gpuTextureOutputs(CONTENT_PACKAGE_IDS.waterVolume, 'water-volume-noise', {
      values: {},
      inputs: {},
      transient: {},
      outputs: {
        noise: {
          shape: { viewDimension: '3d', extent: { width: SIZE, height: SIZE, depth: SIZE } },
          format: 'r8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
        },
      },
      passes: [{
        kind: 'compute-volume',
        program: { module: 'forgeax::water_volume_noise' },
        reads: {},
        writes: ['noise'],
      }],
    });
    const generatorKey = 'generator/water-volume-noise';
    const generator = generated[generatorKey];
    const texture = generated['gpu-texture/water-volume-noise/noise'];
    if (generator === undefined || texture === undefined)
      throw new Error('Water volume generator declaration is incomplete');
    return ok({
      [generatorKey]: generator,
      [CONTENT_SOURCE_KEYS.waterTexture('volume-noise')]: texture,
    });
  },
});
