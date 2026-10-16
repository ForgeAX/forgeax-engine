import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  deriveTextureLayout,
  type TextureAsset,
  validateTextureShape,
} from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { errorCode, guid, installMemoryPack } from './fixtures/memory-pack';

const ARRAY = guid(0x721);
const VOLUME = guid(0x722);

function rawTexture(id: string, shape: unknown, mips: unknown, bytes: Uint8Array) {
  return {
    guid: id,
    kind: 'texture',
    payload: { kind: 'texture', colorSpace: 'linear', shape, format: 'rgba8unorm', mips },
    artifacts: {
      body: {
        path: `shapes/${id}.bin`,
        mediaType: 'application/octet-stream',
        bytes,
        assetCodec: { name: 'rgba8' },
      },
    },
  };
}

export default defineFeature({
  title: '2D-array/3D TextureAsset',
  catalog: '2D-array/3D TextureAsset',
  kind: 'headless',
  summary:
    'TextureShape is a closed 2d / 2d-array / 3d union; deriveTextureLayout computes the canonical mip-major, image-major, row-major byte layout, and Pack texture rows load layered and volume bodies into the same TextureAsset POD.',
  expect:
    'A 2x2x3 array is 48 bytes with 3 images per mip; a 4x4x4 volume with 3 packed levels is 292 bytes and halves depth per level; generate mips on 3d and a zero layer count fail with texture-mip-policy-invalid / texture-shape-invalid; both Pack rows load with their shape intact.',
  async run(checks) {
    const array = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 2, height: 2, layers: 3 } },
      format: 'rgba8unorm',
      mips: { kind: 'none' },
    });
    checks.equal(
      '2d-array layout',
      array.ok
        ? [array.value.byteLength, array.value.levels[0]?.imagesPerMip]
        : errorCode(array.error),
      [48, 3],
    );
    const volume = deriveTextureLayout({
      shape: { viewDimension: '3d', extent: { width: 4, height: 4, depth: 4 } },
      format: 'rgba8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });
    checks.equal(
      '3d packed layout',
      volume.ok
        ? [volume.value.byteLength, volume.value.levels.map((level) => level.imagesPerMip)]
        : errorCode(volume.error),
      [292, [4, 2, 1]],
    );
    const generated = validateTextureShape(
      { viewDimension: '3d', extent: { width: 4, height: 4, depth: 4 } },
      { kind: 'generate' },
    );
    checks.equal(
      '3d generate mips rejected',
      generated.ok ? 'ok' : errorCode(generated.error),
      'texture-mip-policy-invalid',
    );
    const empty = validateTextureShape({
      viewDimension: '2d-array',
      extent: { width: 2, height: 2, layers: 0 },
    });
    checks.equal(
      'zero layers rejected',
      empty.ok ? 'ok' : errorCode(empty.error),
      'texture-shape-invalid',
    );

    const registry = new AssetRegistry({} as never);
    installMemoryPack(
      registry,
      [
        rawTexture(
          ARRAY,
          { viewDimension: '2d-array', extent: { width: 2, height: 2, layers: 3 } },
          { kind: 'none' },
          new Uint8Array(48).fill(7),
        ),
        rawTexture(
          VOLUME,
          { viewDimension: '3d', extent: { width: 4, height: 4, depth: 4 } },
          { kind: 'packed', levelCount: 3 },
          new Uint8Array(292).fill(9),
        ),
      ],
      'https://feature-lab.invalid/asset-formats/shapes.pack.json',
    );
    for (const [name, id, bytes] of [
      ['2d-array', ARRAY, 48],
      ['3d', VOLUME, 292],
    ] as const) {
      const parsed = AssetGuid.parse(id);
      if (!parsed.ok) {
        checks.ok(`${name} GUID parses`, false);
        continue;
      }
      const loaded = await registry.loadByGuid<TextureAsset>(parsed.value);
      checks.equal(
        `${name} Pack row loads`,
        loaded.ok
          ? [loaded.value.shape.viewDimension, loaded.value.data.byteLength]
          : errorCode(loaded.error),
        [name, bytes],
      );
    }
  },
});
