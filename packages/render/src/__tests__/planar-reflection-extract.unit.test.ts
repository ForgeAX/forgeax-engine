import { World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../components/camera';
import { ClippingPlanes, clippingPlanesData } from '../components/clipping-planes';
import { PlanarReflection } from '../components/planar-reflection';
import { projectAuxiliaryCamerasForView, selectCameraRoles } from '../render-system-extract';
import { createRenderTargetOwner } from '../targets/owner';

describe('planar capture camera extraction', () => {
  it('copies the active view, keeps display authority and detaches authoring data', () => {
    const world = new World();
    const target = createRenderTargetOwner({ rendererId: Symbol(), getGeneration: () => 1 }).create(
      {
        shape: '2d',
        width: 64,
        height: 32,
        format: 'rgba16float',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: true,
      },
    );
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
        {
          component: ClippingPlanes,
          data: clippingPlanesData({ planes: [[1, 0, 0, 0]], clipShadows: true }),
        },
      )
      .unwrap();
    world
      .addComponent(display, {
        component: PlanarReflection,
        data: {
          target: world.allocSharedRef('RenderTarget', target.value),
          updateIntervalFrames: 3,
        },
      })
      .unwrap();
    propagateTransforms(world).unwrap();
    const raw = selectCameraRoles(world);
    const roles = {
      ...raw,
      auxiliary: projectAuxiliaryCamerasForView(raw.display[0], raw.auxiliary),
    };
    expect(roles.display[0]?.entityKey).toBe(display);
    expect(roles.auxiliary[0]?.position[1]).toBeCloseTo(-3);
    expect(roles.auxiliary[0]?.aspect).toBe(2);
    expect(roles.auxiliary[0]?.captureProjection).toBeInstanceOf(Float32Array);
    expect(roles.display[0]?.clipping?.clipShadows).toBe(true);
    expect(roles.auxiliary[0]?.clipping).toEqual({
      planes: [[1, 0, 0, 0]],
      intersection: false,
      clipShadows: false,
    });
    expect(roles.auxiliary[0]?.clipping?.planes).not.toBe(roles.display[0]?.clipping?.planes);
    world.set(display, PlanarReflection, { normal: [0, 0, 1] }).unwrap();
    expect(Array.from(roles.auxiliary[0]?.planarReflection?.normal ?? [])).toEqual([0, 1, 0]);
  });
});
