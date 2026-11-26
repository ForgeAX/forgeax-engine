import type { AssetHandle, GpuTextureAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { expectTypeOf, test } from 'vitest';
import type { AssetRegistry } from '../asset-registry';

declare const assets: AssetRegistry;
declare const mesh: AssetHandle<'mesh'>;
declare const texture: AssetHandle<'texture'>;
declare const gpuTexture: AssetHandle<'gpu-texture'>;
declare const custom: AssetHandle<'palette', { data: readonly number[]; name: string }>;

test('infers selected fields from the same typed asset handle', () => {
  expectTypeOf(assets.read(mesh).unwrap()).toEqualTypeOf<MeshAsset>();
  expectTypeOf(assets.read(mesh, ['materialSlots', 'aabb']).unwrap()).toEqualTypeOf<
    Pick<MeshAsset, 'materialSlots' | 'aabb'>
  >();
  expectTypeOf(assets.read(texture, ['shape', 'data']).unwrap()).toEqualTypeOf<
    Pick<TextureAsset, 'shape' | 'data'>
  >();
  expectTypeOf(assets.read(gpuTexture, ['format']).unwrap()).toEqualTypeOf<
    Pick<GpuTextureAsset, 'format'>
  >();
  expectTypeOf(assets.read(custom, ['data']).unwrap()).toEqualTypeOf<{
    data: readonly number[];
  }>();
  // @ts-expect-error An imported pixel buffer is not part of a GPU texture asset.
  assets.read(gpuTexture, ['data']);
  // @ts-expect-error A field from another asset kind is not a Mesh field.
  assets.read(mesh, ['format']);
});
