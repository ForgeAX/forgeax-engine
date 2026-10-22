import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { afterEach, expect, it, vi } from 'vitest';
import { SkinTasks } from '../../../render/src/record/skin-tasks';
import { extractFrames } from '../../../render/src/render-system-extract-tail';
import { PersistentRenderScene } from '../../../render/src/scene/render-scene';

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
  const tasks = new SkinTasks(device, true),
    scene = new PersistentRenderScene(),
    lease = createRenderReadLease(world);
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
    const owner = { cameraOwner: 0, resourceOwner: 0 };
    const frame = scene.extractComposition(
      [world],
      owner,
      assets,
      (renderables) =>
        extractFrames([world], owner, assets, scene.materialSnapshotCacheStore(), {
          cull: 'none',
          renderables,
        }),
      [lease],
    );
    const fixed = scene.skinRecordingFrame();
    if (fixed === undefined) throw new Error('Missing accepted Skin frame');
    tasks.begin(fixed);
    return frame;
  };
  return {
    assets,
    world,
    tasks,
    scene,
    joint,
    spawn,
    extract,
    async dispose() {
      await tasks.complete();
      await tasks.dispose();
      scene.dispose();
      lease.dispose();
      assets.dispose();
    },
  };
}

it('resolves distinct actual task windows from shared managed geometry', async () => {
  const f = await fixture();
  try {
    f.spawn(2, [f.joint(), f.joint()]);
    f.spawn(2, [f.joint(), f.joint()]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const frame = f.extract();
    expect(error).not.toHaveBeenCalled();
    expect(frame.renderables).toHaveLength(2);
    const tasks = frame.renderables.map((row) => {
      const slot = f.scene.compositionSlot(row.worldId, row.entityKey);
      if (slot === undefined) throw new Error('Missing accepted Skin slot');
      return f.tasks.demand(slot);
    });
    expect(tasks.every((task) => task !== undefined && task.auxiliaryOffset % 16 === 0)).toBe(true);
    // Two tasks x two joints, current and previous matrices each.
    expect(f.tasks.paletteUploadBytes).toBe(2 * 2 * 128);
    expect(tasks[0]?.auxiliaryOffset).not.toBe(tasks[1]?.auxiliaryOffset);
  } finally {
    await f.dispose();
  }
});

it.each([
  'joint-count-mismatch',
  'joint-entity-dangling',
] as const)('isolates %s at actual demand while a valid sibling remains drawable', async (code) => {
  const f = await fixture();
  try {
    const joint = f.joint();
    f.spawn(code === 'joint-count-mismatch' ? 2 : 1, [joint]);
    f.spawn(1, [f.joint()]);
    if (code === 'joint-entity-dangling') f.world.despawn(joint).unwrap();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const frame = f.extract();
    if (code === 'joint-count-mismatch') {
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toMatchObject({ code });
    } else expect(error).not.toHaveBeenCalled();
    const resolved = frame.renderables.map((row) => {
      const slot = f.scene.compositionSlot(row.worldId, row.entityKey);
      if (slot === undefined) throw new Error('Missing accepted Skin slot');
      return f.tasks.demand(slot);
    });
    expect(frame.renderables).toHaveLength(2);
    expect(resolved[0]).toBeUndefined();
    expect(resolved[1]).toBeDefined();
    expect(f.tasks.paletteUploadBytes).toBe(128);
  } finally {
    await f.dispose();
  }
});
