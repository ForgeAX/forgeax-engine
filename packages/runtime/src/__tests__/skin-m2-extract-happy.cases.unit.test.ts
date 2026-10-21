import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { afterEach, expect, it, vi } from 'vitest';
import { createSkinPaletteOwner } from '../../../render/src/assembly/skin-palette-owner';
import { extractFrames } from '../../../render/src/render-system-extract-tail';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const base = createPrimitiveMesh('triangle').unwrap();
  const attributes = {
    ...base.attributes,
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  };
  const mesh = assets
    .create({
      ...base,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, 3).unwrap().vertices,
    })
    .unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const allocator = createSkinPaletteOwner(device, true);
  const joint = () => world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
  const spawn = (count: number, joints: EntityHandle[]) => {
    const inverseBindMatrices = new Float32Array(count * 16);
    for (let index = 0; index < count; index++)
      for (const diagonal of [0, 5, 10, 15]) inverseBindMatrices[index * 16 + diagonal] = 1;
    const skeleton = assets
      .create({ kind: 'skeleton', jointCount: count, inverseBindMatrices })
      .unwrap();
    return world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
        { component: Skin, data: { skeleton, joints } },
      )
      .unwrap();
  };
  const extract = () => {
    propagateTransforms(world);
    return extractFrames(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      { skinPaletteAllocator: allocator },
      undefined,
      { cull: 'none' },
    );
  };
  return {
    assets,
    world,
    allocator,
    joint,
    spawn,
    extract,
    dispose() {
      allocator.dispose();
      assets.dispose();
    },
  };
}

it('allocates distinct aligned palettes for two entities sharing managed geometry', async () => {
  const f = await fixture();
  try {
    f.spawn(2, [f.joint(), f.joint()]);
    f.spawn(2, [f.joint(), f.joint()]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const frame = f.extract();
    expect(error).not.toHaveBeenCalled();
    expect(frame.renderables).toHaveLength(2);
    const skins = frame.renderables.map((row) => row.skin);
    expect(skins.every((skin) => skin?.jointCount === 2 && skin.byteOffset % 256 === 0)).toBe(true);
    expect(skins[0]?.byteOffset).not.toBe(skins[1]?.byteOffset);
  } finally {
    f.dispose();
  }
});

it.each([
  'joint-count-mismatch',
  'joint-entity-dangling',
] as const)('isolates %s while a valid sibling keeps its palette', async (code) => {
  const f = await fixture();
  try {
    const joint = f.joint();
    f.spawn(code === 'joint-count-mismatch' ? 2 : 1, [joint]);
    f.spawn(1, [f.joint()]);
    if (code === 'joint-entity-dangling') f.world.despawn(joint).unwrap();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const frame = f.extract();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ code });
    expect(frame.renderables.filter((row) => row.skin !== undefined)).toHaveLength(1);
  } finally {
    f.dispose();
  }
});
