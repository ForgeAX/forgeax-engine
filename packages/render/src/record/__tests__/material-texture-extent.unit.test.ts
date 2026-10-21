import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import type { TextureAsset } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { worldRenderResources } from '../../publication/resource-scope';
import { deriveTextureExtent, deriveTextureUvScale } from '../../render-data';
import { applyMaterialTextureUvScales, materialTextureUvScale } from '../main-pass-material';

it('preserves block-rounded UV scales, including asymmetric compressed blocks and detached results', () => {
  for (const format of ['rgba8unorm', 'bc7-rgba-unorm', 'astc-5x4-unorm'] as const) {
    for (const [width, height] of [
      [1, 1],
      [5, 7],
      [16, 32],
      [127, 65],
      [0, 0],
    ] as const) {
      expect(deriveTextureUvScale(format, width, height)).toEqual(
        deriveTextureExtent(format, width, height).uvScale,
      );
    }
  }
  expect(deriveTextureUvScale('bc7-rgba-unorm', 5, 7)).toEqual([5 / 8, 7 / 8]);
  expect(deriveTextureUvScale('astc-5x4-unorm', 7, 5)).toEqual([7 / 10, 5 / 8]);
  const first = deriveTextureUvScale('bc7-rgba-unorm', 5, 7);
  Reflect.set(first, 0, 0);
  expect(deriveTextureUvScale('bc7-rgba-unorm', 5, 7)).toEqual([5 / 8, 7 / 8]);
});

it('writes live source extent changes through both schema and legacy material packing', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const extent = { width: 5, height: 7 };
  const texture: TextureAsset = {
    kind: 'texture',
    format: 'bc7-rgba-unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent },
    mips: { kind: 'packed', levelCount: 1 },
    data: new Uint8Array(64),
  };
  const handle = assets.create(texture).unwrap();
  const schema = [{ name: 'albedo', type: 'texture2d' }] as const;
  const record = derive(schema).coordinateRecords[0];
  if (record === undefined) throw new Error('missing coordinate ABI');
  const base = { passes: [], baseColor: vec3.create(1, 1, 1), metallic: 0, roughness: 1 };
  const material = {
    ...base,
    materialParamSchema: schema,
    textureHandles: new Map([['albedo', handle]]),
  };
  const legacy = { ...base, textureHandles: new Map([['baseColorTexture', handle]]) };
  const payload = new Float32Array(512);
  for (const width of [5, 7]) {
    assets
      .update(handle, { shape: { viewDimension: '2d', extent: { width, height: 7 } } })
      .unwrap();
    applyMaterialTextureUvScales(payload, material, worldRenderResources(world));
    expect(Array.from(payload.slice(record.offset / 4 + 6, record.offset / 4 + 8))).toEqual([
      width / 8,
      7 / 8,
    ]);
    applyMaterialTextureUvScales(payload, legacy, worldRenderResources(world));
    expect(Array.from(payload.slice(20, 22))).toEqual([width / 8, 7 / 8]);
  }
});

it('keeps raw texture getter order and reads each dimension at the call boundary', () => {
  const observed: string[] = [];
  const texture = {
    get format() {
      observed.push('format');
      return 'bc7-rgba-unorm' as const;
    },
    get shape() {
      observed.push('shape');
      return {
        viewDimension: '2d' as const,
        extent: {
          get width() {
            observed.push('width');
            return 5;
          },
          get height() {
            observed.push('height');
            return 7;
          },
        },
      };
    },
  };
  expect(materialTextureUvScale(texture)).toEqual([5 / 8, 7 / 8]);
  expect(observed).toEqual(['format', 'shape', 'width', 'shape', 'height']);
});
