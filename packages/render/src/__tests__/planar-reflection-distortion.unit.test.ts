import { World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { encodePlanarReflectionUniform } from '../capture/planar-uniform';
import { Camera } from '../components/camera';
import { PlanarReflection } from '../components/planar-reflection';
import { projectAuxiliaryCamerasForView, selectCameraRoles } from '../render-system-extract';
import { createRenderTargetOwner } from '../targets/owner';

function planarWorld(distortion?: number) {
  const world = new World();
  const target = createRenderTargetOwner({ rendererId: Symbol(), getGeneration: () => 1 }).create({
    shape: '2d',
    width: 64,
    height: 32,
    format: 'rgba16float',
    mipLevels: 1,
    sampleCount: 1,
    sampled: true,
    readback: true,
  });
  if (!target.ok) throw target.error;
  const display = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 3, 5],
          quat: quat.fromLookAt(quat.create(), [0, 3, 5], [0, 0, 0], [0, 1, 0]),
        },
      },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 2, near: 0.1, far: 100 } },
    )
    .unwrap();
  world
    .addComponent(display, {
      component: PlanarReflection,
      data: {
        target: world.allocSharedRef('RenderTarget', target.value),
        normal: [0, 2, 0],
        distance: 1,
        ...(distortion === undefined ? {} : { distortion }),
      },
    })
    .unwrap();
  propagateTransforms(world).unwrap();
  return world;
}

function reflectedCamera(world: World) {
  const raw = selectCameraRoles(world);
  return projectAuxiliaryCamerasForView(raw.display[0], raw.auxiliary)[0];
}

describe('PlanarReflection normal distortion', () => {
  it('defaults to an undistorted mirror', () => {
    const reflected = reflectedCamera(planarWorld());
    expect(reflected?.planarReflection?.distortion).toBe(0);
    expect(encodePlanarReflectionUniform(reflected)[21]).toBe(0);
  });

  it('carries the authored strength into the shader uniform next to the unit plane', () => {
    const uniform = encodePlanarReflectionUniform(reflectedCamera(planarWorld(0.04)));
    expect(Array.from(uniform.slice(16, 21))).toEqual([0, 1, 0, 0.5, 1]);
    expect(uniform[21]).toBeCloseTo(0.04, 6);
  });

  it('writes a disabled uniform when no capture is current', () => {
    expect(Array.from(encodePlanarReflectionUniform(undefined))).toEqual(new Array(24).fill(0));
  });

  // NaN never reaches extraction: the ECS write rejects it (ComponentNumericValueInvalidError).
  it.each([-0.1, Number.POSITIVE_INFINITY])('rejects distortion %s', (bad) => {
    const world = planarWorld(bad);
    expect(() => selectCameraRoles(world)).toThrow(
      expect.objectContaining({
        code: 'planar-reflection-invalid',
        detail: { field: 'distortion' },
      }),
    );
  });
});
