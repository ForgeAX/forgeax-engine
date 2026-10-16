import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { box3, mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { MorphWeights, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MeshAsset, SkeletonAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createSkinPaletteOwner } from '../assembly/skin-palette-owner';
import { MeshFilter, MeshRenderer } from '../components';
import { extractFrames } from '../render-system-extract-tail';

function triangle(firstX = 0): MeshAsset {
  const attributes = {
    position: new Float32Array([firstX, 0, 0, 1, 0, 0, 0, 1, 0]),
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  };
  return {
    kind: 'mesh',
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, 3).unwrap().vertices,
    indices: new Uint16Array([0, 1, 2]),
    aabb: new Float32Array([Math.min(firstX, 0), 0, 0, Math.max(firstX, 1), 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'surface' }],
  };
}

describe('current Skin pose bounds in extraction', () => {
  it.each([
    true,
    false,
  ])('updates current bounds and retained palette receipts (storage=%s)', async (storage) => {
    const world = new World();
    registerPropagateTransforms(world);
    const mesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', triangle());
    const skeleton = world.allocSharedRef<'SkeletonAsset', SkeletonAsset>('SkeletonAsset', {
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: mat4.identity(mat4.create()),
      // This old producer envelope deliberately does not contain the current pose.
      bounds: new Float32Array([-2, -2, -2, 2, 2, 2]),
    });
    const joint = world.spawn({ component: Transform, data: { pos: [9, 0, 0] } }).unwrap();
    const surface = world
      .spawn(
        { component: Transform, data: { pos: [-5, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
        { component: Skin, data: { skeleton, joints: new Uint32Array([joint]) } },
      )
      .unwrap();
    const assets = new AssetRegistry({} as never);
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, storage);
    const extract = () => {
      world.update(0).unwrap();
      const snapshot = extractFrames([world], 0, assets, {
        skinPaletteAllocator: allocator,
      }).renderables.find((row) => row.entityKey === surface);
      expect(snapshot).toBeDefined();
      if (!snapshot) throw Error('surface omitted');
      return snapshot;
    };
    try {
      const first = extract();
      expect(extract().skinPose?.bounds).toEqual(first.skinPose?.bounds);
      expect(extract().skinPose?.bounds).toEqual(first.skinPose?.bounds);
      expect(first.skinPose?.bounds).toEqual(new Float32Array([14, 0, 0, 15, 1, 0]));
      expect(first.skin?.bounds).toEqual(first.localAabb);
      const worldBounds = box3.create();
      box3.transformBox3(worldBounds, first.localAabb ?? [], first.transform.world);
      expect(Array.from(worldBounds)).toEqual([9, 0, 0, 10, 1, 0]);
      world.set(joint, Transform, { pos: [12, 0, 0] }).unwrap();
      const moved = extract();
      expect(moved.skin?.buffer).toBe(first.skin?.buffer);
      expect(moved.skin?.bounds).toEqual(new Float32Array([17, 0, 0, 18, 1, 0]));
      expect(first.skin?.bounds).toEqual(new Float32Array([14, 0, 0, 15, 1, 0]));
      const replacement = triangle(-3);
      const newMesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', replacement);
      world.set(surface, MeshFilter, { assetHandle: newMesh }).unwrap();
      const rebound = extract();
      expect(rebound.skin?.buffer).toBe(first.skin?.buffer);
      expect(rebound.skin?.bounds).toEqual(new Float32Array([14, 0, 0, 18, 1, 0]));
      // A singular mesh node must not cull a valid world-space Skin pose.
      world.set(surface, Transform, { scale: [0, 1, 1] }).unwrap();
      const singular = extract();
      expect(singular.localAabb).toBeUndefined();
      expect(singular.skin?.bounds).toBeUndefined();
      expect(rebound.skin?.bounds).toEqual(new Float32Array([14, 0, 0, 18, 1, 0]));
      world.set(surface, Transform, { scale: [1, 1, 1] }).unwrap();
      expect(extract().skin?.bounds).toEqual(rebound.skin?.bounds);
      // Public IBM matrices are not restricted to affine values. With w=2,
      // raw XYZ spans x=21..25 while raster positions span x=10.5..12.5.
      const projectiveBind = mat4.identity(mat4.create());
      projectiveBind[15] = 2;
      const projectiveSkeleton = world.allocSharedRef<'SkeletonAsset', SkeletonAsset>(
        'SkeletonAsset',
        { kind: 'skeleton', jointCount: 1, inverseBindMatrices: projectiveBind },
      );
      world.set(surface, Skin, { skeleton: projectiveSkeleton }).unwrap();
      expect(extract().skin?.bounds).toEqual(new Float32Array([15.5, 0, 0, 30, 1, 0]));
      // A held palette may reuse only its bounds. Morph admission is still
      // derived from current weights and a newly bound source mesh.
      const morphMesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
        ...triangle(-3),
        morphTargets: [{ position: new Float32Array(9) }],
      });
      world.set(surface, MeshFilter, { assetHandle: morphMesh }).unwrap();
      world.addComponent(surface, { component: MorphWeights, data: { weights: [0.5] } }).unwrap();
      const morphed = extract();
      expect(morphed.morph?.weights).toEqual(new Float32Array([0.5]));
      expect(morphed.localAabb).toBeUndefined();
      world.get(surface, MorphWeights).unwrap().weights[0] = 0;
      const neutral = extract();
      expect(neutral.morph).toBeUndefined();
      expect(neutral.localAabb).toEqual(new Float32Array([15.5, 0, 0, 30, 1, 0]));
    } finally {
      allocator.dispose();
      assets.invalidateAll();
    }
  });
});

it('reads the public conservative MeshRenderer policy through source extraction', () => {
  const world = new World();
  registerPropagateTransforms(world);
  const geometry = triangle();
  const mesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', geometry);
  const skeleton = world.allocSharedRef<'SkeletonAsset', SkeletonAsset>('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: mat4.identity(mat4.create()),
  });
  const joint = world.spawn({ component: Transform, data: { pos: [10, 0, 0] } }).unwrap();
  const surface = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { conservativeSkinBounds: true } },
      { component: Skin, data: { skeleton, joints: [joint] } },
    )
    .unwrap();
  const assets = new AssetRegistry({} as never);
  const extract = () => {
    world.update(0).unwrap();
    const row = extractFrames([world], 0, assets).renderables.find(
      (row) => row.entityKey === surface,
    );
    if (!row?.localAabb) throw Error('missing conservative skin bounds');
    return row.localAabb;
  };
  try {
    const conservative = extract();
    expect(conservative[0]).toBeLessThan(10);
    expect(conservative[3]).toBeGreaterThan(11);
    world.set(surface, MeshRenderer, { conservativeSkinBounds: false }).unwrap();
    expect(extract()).toEqual(new Float32Array([10, 0, 0, 11, 1, 0]));
    world.set(surface, MeshRenderer, { conservativeSkinBounds: true }).unwrap();
    (geometry.attributes.position as Float32Array)[0] = -100;
    expect(extract()[0]).toBeLessThan(-90);
    world.set(joint, Transform, { pos: [20, 0, 0] }).unwrap();
    const moved = extract();
    expect(moved[0]).toBeLessThan(-80);
    expect(moved[3]).toBeGreaterThan(21);
  } finally {
    assets.invalidateAll();
  }
});
