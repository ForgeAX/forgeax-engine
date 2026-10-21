import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, orthographic, perspective } from '../components';
import type { GpuDrivenBatch } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { Materials } from '../materials';
import type { ExtractedFrame } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { meshDrawSnapshot } from '../scene/mesh-draw';
import { PersistentRenderScene } from '../scene/render-scene';
import { testAssets } from './helpers/runtime-assets';

function spawnCamera(world: World, data: ReturnType<typeof perspective>): void {
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data })
    .unwrap();
}

function spawnCube(world: World, x: number) {
  return world
    .spawn(
      { component: Transform, data: { pos: [x, 0, 0] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
        },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [
            testAssets(world)
              .create(Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1 }))
              .unwrap(),
          ],
        },
      },
    )
    .unwrap();
}

function renderableKeys(frame: ExtractedFrame): number[] {
  return frame.renderables.map((renderable) => renderable.entityKey);
}

describe('CameraSnapshot frustum consumers', () => {
  it('keeps direct extraction and persistent-scene culling equivalent', () => {
    const world = new World();
    const assets = testAssets(world);
    registerPropagateTransforms(world);
    spawnCamera(world, perspective({ fov: Math.PI / 3, aspect: 1 }));
    const inside = spawnCube(world, 0);
    const outside = spawnCube(world, 100);
    world.update(0).unwrap();

    const direct = extractFrames([world], 0, assets);
    const uncull = extractFrames([world], 0, assets, undefined, undefined, {
      cull: 'none',
      retainHidden: true,
    });
    expect(renderableKeys(uncull)).toEqual([inside, outside]);
    expect(uncull.frustumStats).toEqual({ culled: 0, total: 2 });
    const lease = createRenderReadLease(world);
    const scene = new PersistentRenderScene({ assets });
    try {
      const persistent = scene.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        assets,
        () => uncull,
        [lease],
      );

      expect(renderableKeys(direct)).toEqual([inside]);
      expect(renderableKeys(persistent)).toEqual([inside]);
      expect(renderableKeys(direct)).not.toContain(outside);
      expect(direct.frustumStats).toEqual({ culled: 1, total: 2 });
      expect(persistent.frustumStats).toEqual(direct.frustumStats);
    } finally {
      lease.dispose();
      scene.dispose();
      assets.dispose();
    }
  });

  it('leaves only GPU-raster-owned renderables to the GPU cull while the GPU raster owns the frame', () => {
    const world = new World();
    const assets = testAssets(world);
    registerPropagateTransforms(world);
    spawnCamera(world, perspective({ fov: Math.PI / 3, aspect: 1 }));
    const inside = spawnCube(world, 0);
    const outside = spawnCube(world, 100);
    // Its draw stays on the CPU (for example a blended pass), so no GPU cull
    // stands behind it and the CPU cull must still reject it off screen.
    const outsideResidual = spawnCube(world, -100);
    world.update(0).unwrap();
    const uncull = extractFrames([world], 0, assets, undefined, undefined, {
      cull: 'none',
      retainHidden: true,
    });
    const gpuDriven: ExtractedFrame = {
      ...uncull,
      renderables: uncull.renderables.map<import('../render-system-extract').RenderableSnapshot>(
        (renderable) => ({
          ...renderable,
          gpuDrivenDraws: [
            {
              kind: 'indexed',
              first: 0,
              count: 36,
              baseVertex: 0,
              materialSlot: 0,
              topology: 'triangle-list',
              pipelineClass: 'opaque-pbr',
              materialResourceClass: 'plain',
              geometry: {
                receipt: {
                  identity: 'cube',
                  vertexInputs: [],
                  topology: 'triangle-list',
                  indexed: true,
                },
                draw: {
                  kind: 'indexed',
                  first: 0,
                  count: 36,
                  baseVertex: 0,
                  topology: 'triangle-list',
                },
                deformation: 'rigid',
              },
            },
          ],
        }),
      ),
    };
    const device = new RhiNullDevice(
      new RhiNullQueue(),
      (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
    );
    const lease = createRenderReadLease(world);
    const scene = new PersistentRenderScene({
      assets,
      getDevice: () => device,
      onGpuError: (error) => {
        throw error;
      },
    });
    const extract = () =>
      scene.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        assets,
        () => gpuDriven,
        [lease],
      );
    try {
      expect(renderableKeys(extract())).toEqual([inside]);
      const fixed = scene.shadowCasterProjection();
      if (fixed === undefined) throw new Error('Missing fixed mesh frame');
      const candidates = scene
        .compositionSlots()
        .map((slot) => meshDrawSnapshot(slot.snapshot, fixed.content.meshes));
      const selection = new GpuDrawSelection(
        candidates
          .filter((row) => row.entityKey !== outsideResidual)
          .map((row) => ({
            visibleCapacity: 1,
            binding: {
              material: row.material,
              worldId: row.worldId,
              assetHandle: row.assetHandle,
              drawItemIndex: 0,
              geometry: row.gpuDrivenDraws?.[0]?.geometry,
            },
          })) as GpuDrivenBatch[],
      );
      expect(scene.inspect().gpu.status).toBe('resident');
      const selected = candidates.find((row) => row.entityKey === outside);
      expect(selected?.localAabb).toBeDefined();
      expect(selected && selection.ownsAll(selected)).toBe(true);
      scene.setGpuDrivenRasterLane({ selection });
      const gpuOwned = extract();
      expect(renderableKeys(gpuOwned)).toEqual([inside, outside]);
      expect(gpuOwned.frustumStats).toEqual({ culled: 2, total: 3 });
      scene.setGpuDrivenRasterLane(undefined);
      expect(renderableKeys(extract())).toEqual([inside]);
    } finally {
      lease.dispose();
      scene.dispose();
      assets.dispose();
    }
  });

  it('keeps persistent culling on the valid orthographic fov=0 path', () => {
    const world = new World();
    const assets = testAssets(world);
    registerPropagateTransforms(world);
    spawnCamera(world, orthographic({ left: -1, right: 1, bottom: -1, top: 1 }));
    const inside = spawnCube(world, 0);
    const outside = spawnCube(world, 4);
    world.update(0).unwrap();

    const uncull = extractFrames([world], 0, assets, undefined, undefined, {
      cull: 'none',
      retainHidden: true,
    });
    const lease = createRenderReadLease(world);
    const scene = new PersistentRenderScene({ assets });
    try {
      const persistent = scene.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        assets,
        () => uncull,
        [lease],
      );

      expect(renderableKeys(persistent)).toEqual([inside]);
      expect(renderableKeys(persistent)).not.toContain(outside);
      expect(persistent.frustumStats).toEqual({ culled: 1, total: 2 });
    } finally {
      lease.dispose();
      scene.dispose();
      assets.dispose();
    }
  });

  it('keeps valid orthographic cameras on the culling path when fov is zero', () => {
    const world = new World();
    const assets = testAssets(world);
    registerPropagateTransforms(world);
    spawnCamera(world, orthographic({ left: -1, right: 1, bottom: -1, top: 1 }));
    const inside = spawnCube(world, 0);
    const outside = spawnCube(world, 4);
    world.update(0).unwrap();

    const frame = extractFrames([world], 0, assets);

    expect(renderableKeys(frame)).toEqual([inside]);
    expect(renderableKeys(frame)).not.toContain(outside);
    expect(frame.frustumStats).toEqual({ culled: 1, total: 2 });
    assets.dispose();
  });
});
