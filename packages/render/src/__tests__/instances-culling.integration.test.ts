import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../components/camera';
import { Instances } from '../components/instances';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { extractFrames } from '../render-system-extract-tail';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function translated(x: number): Float32Array {
  const matrix = new Float32Array(IDENTITY);
  matrix[12] = x;
  return matrix;
}

function spawnCamera(world: World): void {
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
}

function spawnInstancedCube(world: World, entityX: number, instanceX: number) {
  return world
    .spawn(
      { component: Transform, data: { pos: [entityX, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: translated(instanceX) } },
    )
    .unwrap();
}

describe('Instances CPU/GPU culling ownership', () => {
  it('keeps an instance visible when the entity origin is outside the camera frustum', () => {
    const world = new World();
    registerPropagateTransforms(world);
    spawnCamera(world);
    const entity = spawnInstancedCube(world, 20, -20);
    world.update(0).unwrap();

    const frame = extractFrames([world], 0);

    expect(frame.renderables.map((renderable) => renderable.entityKey)).toContain(entity);
    expect(frame.frustumStats).toEqual({ culled: 0, total: 1 });
  });

  it('recomputes the union after entity and instance transforms change', () => {
    const world = new World();
    registerPropagateTransforms(world);
    spawnCamera(world);
    const entity = spawnInstancedCube(world, 20, -20);
    world.update(0).unwrap();
    expect(extractFrames([world], 0).renderables).toHaveLength(1);

    world.set(entity, Transform, { pos: [40, 0, 0] }).unwrap();
    world.set(entity, Instances, { transforms: translated(-40) }).unwrap();
    world.update(0).unwrap();

    const frame = extractFrames([world], 0);
    expect(frame.renderables).toHaveLength(1);
    expect(frame.renderables[0]?.instances?.instanceCount).toBe(1);
  });

  it('does not make an empty instance array visible or feed it to the GPU as one identity instance', () => {
    const world = new World();
    registerPropagateTransforms(world);
    spawnCamera(world);
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [20, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
        { component: Instances, data: { transforms: new Float32Array() } },
      )
      .unwrap();
    world.update(0).unwrap();

    const frame = extractFrames([world], 0);
    expect(
      frame.renderables.find((renderable) => renderable.entityKey === entity)?.instances,
    ).toMatchObject({ instanceCount: 0 });
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('candidate.instanceOrdinal');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain(
      'rootWorld * transforms[instance.transformIndex].currentWorld',
    );
  });
});
