import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, TONEMAP_NONE } from '@forgeax/engine-render';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createTextureWorkspacePreview } from '../texture-preview';

const asset: TextureAsset = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
  format: 'rgba8unorm',
  colorSpace: 'linear',
  data: new Uint8Array(16),
  mips: { kind: 'none' },
};

it('updates the existing material, rejects invalid settings, and releases its own asset grants', async () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const source = assets.create(asset).unwrap();
  const unrelated = world.spawn().unwrap();
  const preview = createTextureWorkspacePreview(world, assets, source);
  const original = preview.binding.materialHandle;
  const mesh = world.get(preview.binding.entityKey, MeshFilter).unwrap().assetHandle;
  expect(preview.binding.textureHandle).toBe(source);
  assets.release(source).unwrap();
  const allocate = vi.spyOn(assets, 'create');
  const rebind = vi.spyOn(world, 'set');
  await preview.texture.set({ channels: [false, true, false, false], exposure: -2 });
  expect(preview.binding.materialHandle).toBe(original);
  expect(world.get(preview.binding.entityKey, MeshRenderer).unwrap().materials[0]).toBe(original);
  expect(assets.read(original).unwrap()).toMatchObject({
    values: { channels: [0, 1, 0, 0], display: [0, 0, 1, 0.25] },
  });
  expect(allocate).not.toHaveBeenCalled();
  expect(rebind).not.toHaveBeenCalled();
  const accepted = await preview.texture.get();
  expect(() => preview.texture.set({ mip: 2 })).toThrow();
  expect(await preview.texture.get()).toEqual(accepted);
  expect(assets.validate(source).ok).toBe(true);
  preview.close();
  preview.close();
  for (const handle of [source, original, mesh]) expect(assets.validate(handle).ok).toBe(false);
  expect(world.despawn(unrelated).ok).toBe(true);
  expect(() => preview.texture.get()).toThrow('disposed');
});

it('rolls back setup allocations and its borrowed source grant when a World write fails', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const source = assets.create(asset).unwrap();
  const allocations = vi.spyOn(assets, 'create');
  vi.spyOn(world, 'spawn').mockImplementationOnce(() => {
    throw new Error('world-write-failed');
  });
  expect(() => createTextureWorkspacePreview(world, assets, source)).toThrow('world-write-failed');
  for (const result of allocations.mock.results) {
    expect(result.type).toBe('return');
    expect(assets.validate(result.value.unwrap()).ok).toBe(false);
  }
  expect(assets.validate(source).ok).toBe(true);
  assets.release(source).unwrap();
  expect(assets.validate(source).ok).toBe(false);
});

it('borrows the same texture for transparent thumbnails and rejects initial options before allocation', async () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const source = assets.create(asset).unwrap();
  const allocations = vi.spyOn(assets, 'create');
  expect(() => createTextureWorkspacePreview(world, assets, source, { mip: 1 })).toThrow();
  expect(allocations).not.toHaveBeenCalled();
  const preview = createTextureWorkspacePreview(world, assets, source, {
    background: 'transparent',
  });
  expect(preview.binding.textureHandle).toBe(source);
  expect((await preview.texture.get()).options.background).toBe('transparent');
  expect(assets.read(preview.binding.materialHandle).unwrap()).toMatchObject({
    values: { background: [3, 0, 0, 0] },
  });
  const camera = world.get(preview.camera, Camera).unwrap();
  expect(Array.from(camera.clearColor)).toEqual([0, 0, 0, 0]);
  expect(camera).toMatchObject({ tonemap: TONEMAP_NONE, bloom: 0, antialias: 0 });
  preview.close();
  expect(assets.validate(source).ok).toBe(true);
  assets.release(source).unwrap();
  expect(assets.validate(source).ok).toBe(false);
});
