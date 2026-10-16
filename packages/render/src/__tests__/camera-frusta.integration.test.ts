import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, orthographic, perspective } from '../components';
import { gpuDrivenDrawKey } from '../extract/gpu-driven';
import { worldEntityKey } from '../record/frame-snapshot';
import type { ExtractedFrame } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

function spawnCamera(world: World, data: ReturnType<typeof perspective>): void {
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data })
    .unwrap();
}

function spawnCube(world: World, x: number) {
  return world
    .spawn(
      { component: Transform, data: { pos: [x, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
}

function renderableKeys(frame: ExtractedFrame): number[] {
  return frame.renderables.map((renderable) => renderable.entityKey);
}

describe('CameraSnapshot frustum consumers', () => {
  it('keeps direct extraction and persistent-scene culling equivalent', () => {
    const world = new World();
    registerPropagateTransforms(world);
    spawnCamera(world, perspective({ fov: Math.PI / 3, aspect: 1 }));
    const inside = spawnCube(world, 0);
    const outside = spawnCube(world, 100);
    world.update(0).unwrap();

    const direct = extractFrames([world], 0);
    const uncull = extractFrames([world], 0, undefined, undefined, undefined, {
      cull: 'none',
      retainHidden: true,
    });
    expect(renderableKeys(uncull)).toEqual([inside, outside]);
    expect(uncull.frustumStats).toEqual({ culled: 0, total: 2 });
    const lease = createRenderReadLease(world);
    const scene = new PersistentRenderScene();
    try {
      const persistent = scene.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        0,
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
    }
  });

  it('leaves only GPU-raster-owned renderables to the GPU cull while the GPU raster owns the frame', () => {
    const world = new World();
    registerPropagateTransforms(world);
    spawnCamera(world, perspective({ fov: Math.PI / 3, aspect: 1 }));
    const inside = spawnCube(world, 0);
    const outside = spawnCube(world, 100);
    // Its draw stays on the CPU (for example a blended pass), so no GPU cull
    // stands behind it and the CPU cull must still reject it off screen.
    const outsideResidual = spawnCube(world, -100);
    world.update(0).unwrap();
    const uncull = extractFrames([world], 0, undefined, undefined, undefined, {
      cull: 'none',
      retainHidden: true,
    });
    const gpuDriven: ExtractedFrame = {
      ...uncull,
      renderables: uncull.renderables.map((renderable) => ({
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
          },
        ],
      })),
    };
    const device = new RhiNullDevice(
      new RhiNullQueue(),
      (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
    );
    const lease = createRenderReadLease(world);
    const scene = new PersistentRenderScene({ getDevice: () => device });
    const extract = (frame: number) =>
      scene.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        frame,
        () => gpuDriven,
        [lease],
      );
    const drawKeys = new Set(
      gpuDriven.renderables
        .filter((renderable) => renderable.entityKey !== outsideResidual)
        .map((renderable) =>
          gpuDrivenDrawKey(
            worldEntityKey(renderable.worldId, renderable.entityKey),
            renderable.material.materialHandle ?? -1,
            0,
          ),
        ),
    );
    try {
      expect(renderableKeys(extract(0))).toEqual([inside]);
      scene.setGpuDrivenRasterLane({ drawKeys, worldKeys: undefined });
      const gpuOwned = extract(1);
      expect(renderableKeys(gpuOwned)).toEqual([inside, outside]);
      expect(gpuOwned.frustumStats).toEqual({ culled: 2, total: 3 });
      scene.setGpuDrivenRasterLane(undefined);
      expect(renderableKeys(extract(2))).toEqual([inside]);
    } finally {
      lease.dispose();
      scene.dispose();
    }
  });

  it('keeps persistent culling on the valid orthographic fov=0 path', () => {
    const world = new World();
    registerPropagateTransforms(world);
    spawnCamera(world, orthographic({ left: -1, right: 1, bottom: -1, top: 1 }));
    const inside = spawnCube(world, 0);
    const outside = spawnCube(world, 4);
    world.update(0).unwrap();

    const uncull = extractFrames([world], 0, undefined, undefined, undefined, {
      cull: 'none',
      retainHidden: true,
    });
    const lease = createRenderReadLease(world);
    const scene = new PersistentRenderScene();
    try {
      const persistent = scene.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        0,
        () => uncull,
        [lease],
      );

      expect(renderableKeys(persistent)).toEqual([inside]);
      expect(renderableKeys(persistent)).not.toContain(outside);
      expect(persistent.frustumStats).toEqual({ culled: 1, total: 2 });
    } finally {
      lease.dispose();
      scene.dispose();
    }
  });

  it('keeps valid orthographic cameras on the culling path when fov is zero', () => {
    const world = new World();
    registerPropagateTransforms(world);
    spawnCamera(world, orthographic({ left: -1, right: 1, bottom: -1, top: 1 }));
    const inside = spawnCube(world, 0);
    const outside = spawnCube(world, 4);
    world.update(0).unwrap();

    const frame = extractFrames([world], 0);

    expect(renderableKeys(frame)).toEqual([inside]);
    expect(renderableKeys(frame)).not.toContain(outside);
    expect(frame.frustumStats).toEqual({ culled: 1, total: 2 });
  });
});
