import { definePack } from '@forgeax/engine-pack/source';
import { ok, type TextureAsset } from '@forgeax/engine-types';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS } from '../../src/ids.ts';
import { waterVolumePixels } from './texture-pixels.ts';

const SIZE = 128;

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.waterVolume,
  name: 'Engine Content / Water Volume Noise',
  build: () =>
    ok({
      [CONTENT_SOURCE_KEYS.waterTexture('volume-noise')]: {
        kind: 'texture',
        shape: { viewDimension: '3d', extent: { width: SIZE, height: SIZE, depth: SIZE } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        data: waterVolumePixels(),
        mips: { kind: 'none' },
      } satisfies TextureAsset,
    }),
});
