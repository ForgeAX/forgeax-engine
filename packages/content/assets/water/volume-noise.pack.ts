import { definePack } from '@forgeax/engine-pack/source';
import { err, ok, sha256Bytes, type TextureAsset } from '@forgeax/engine-types';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS, contentGuid } from '../../src/ids.ts';

const SIZE = 128;
const COLUMNS = 8;
const ATLAS_WIDTH = SIZE * COLUMNS;
const ATLAS_HEIGHT = SIZE * SIZE / COLUMNS;
const ATLAS_RGBA_SHA256 = 'e171190f5b1b80bde5837b97cf29625bc44aee1b472614777ac043f817889359';
const VOLUME_RGBA_SHA256 = '1625417c60cf9e1a713c423428e411fe08c297532d5a0c3ba1ad00f3296e48f0';

/** The PNG is a lossless build input; runtime sampling uses a native 3D texture. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.waterVolume,
  name: 'Engine Content / Water Volume Noise',
  build: async ({ readByGuid }) => {
    const source = await readByGuid<TextureAsset>(contentGuid(CONTENT_PACKAGE_IDS.textures, CONTENT_SOURCE_KEYS.waterVolumeNoiseAtlas));
    if (!source.ok) return source;
    const atlas = source.value;
    const invalid = () => err({
      code: 'water-volume-source-invalid' as const,
      expected: 'the lossless linear RGBA8 1024x2048 VolumeNoise128 slice atlas with one source mip',
      hint: 'restore the verified source PNG and linear/no-mip/uncompressed Meta; see provenance.json for slice and channel mapping',
    });
    if (atlas.kind !== 'texture' || atlas.shape.viewDimension !== '2d'
      || atlas.shape.extent.width !== ATLAS_WIDTH || atlas.shape.extent.height !== ATLAS_HEIGHT
      || atlas.format !== 'rgba8unorm' || atlas.colorSpace !== 'linear' || atlas.encoding !== undefined
      || atlas.mips.kind !== 'none' || atlas.data.length !== ATLAS_WIDTH * ATLAS_HEIGHT * 4
      || sha256Bytes(atlas.data) !== ATLAS_RGBA_SHA256) return invalid();
    const data = new Uint8Array(SIZE ** 3 * 4);
    for (let z = 0; z < SIZE; z++) {
      for (let y = 0; y < SIZE; y++) {
        const from = ((Math.floor(z / COLUMNS) * SIZE + y) * ATLAS_WIDTH + z % COLUMNS * SIZE) * 4;
        data.set(atlas.data.subarray(from, from + SIZE * 4), (z * SIZE + y) * SIZE * 4);
      }
    }
    if (sha256Bytes(data) !== VOLUME_RGBA_SHA256) return invalid();
    return ok({
      [CONTENT_SOURCE_KEYS.waterTexture('volume-noise')]: {
        kind: 'texture',
        shape: { viewDimension: '3d', extent: { width: SIZE, height: SIZE, depth: SIZE } },
        format: 'rgba8unorm', colorSpace: 'linear', data, mips: { kind: 'none' },
      } satisfies TextureAsset,
    });
  },
});
