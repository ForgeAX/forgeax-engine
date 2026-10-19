import { World } from '@forgeax/engine-ecs';
import { Camera, MeshRenderer, TONEMAP_NONE } from '@forgeax/engine-render';
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

it('atomically replaces the rendered material, rejects invalid settings, and releases all owned resources', async () => {
  const world = new World();
  const unrelated = world.spawn().unwrap();
  const preview = createTextureWorkspacePreview(world, asset);
  const original = preview.binding.materialHandle;
  await preview.texture.set({ channels: [false, true, false, false], exposure: -2 });
  expect(world.get(preview.binding.entityKey, MeshRenderer).unwrap().materials[0]).toBe(
    preview.binding.materialHandle,
  );
  expect(world.sharedRefs.resolve(original).ok).toBe(false);
  expect(world.sharedRefs.resolve(preview.binding.materialHandle).unwrap()).toMatchObject({
    values: { channels: [0, 1, 0, 0], display: [0, 0, 1, 0.25] },
  });
  const accepted = await preview.texture.get();
  expect(() => preview.texture.set({ mip: 2 })).toThrow();
  expect(await preview.texture.get()).toEqual(accepted);
  expect(world.sharedRefs._liveCount()).toBe(3);
  preview.close();
  preview.close();
  expect(world.sharedRefs._liveCount()).toBe(0);
  expect(world.despawn(unrelated).ok).toBe(true);
  expect(() => preview.texture.get()).toThrow('disposed');
});

it('rolls back setup allocations when a World write fails', () => {
  const world = new World();
  vi.spyOn(world, 'spawn').mockImplementationOnce(() => {
    throw new Error('world-write-failed');
  });
  expect(() => createTextureWorkspacePreview(world, asset)).toThrow('world-write-failed');
  expect(world.sharedRefs._liveCount()).toBe(0);
});

it('uses the same texture owner for transparent thumbnails and rejects invalid initial options before allocation', async () => {
  const world = new World();
  expect(() => createTextureWorkspacePreview(world, asset, { mip: 1 })).toThrow();
  expect(world.sharedRefs._liveCount()).toBe(0);
  const preview = createTextureWorkspacePreview(world, asset, { background: 'transparent' });
  expect((await preview.texture.get()).options.background).toBe('transparent');
  expect(world.sharedRefs.resolve(preview.binding.materialHandle).unwrap()).toMatchObject({
    values: { background: [3, 0, 0, 0] },
  });
  const camera = world.get(preview.camera, Camera).unwrap();
  expect(Array.from(camera.clearColor)).toEqual([0, 0, 0, 0]);
  expect(camera).toMatchObject({
    tonemap: TONEMAP_NONE,
    bloom: 0,
    antialias: 0,
  });
  preview.close();
  expect(world.sharedRefs._liveCount()).toBe(0);
});
