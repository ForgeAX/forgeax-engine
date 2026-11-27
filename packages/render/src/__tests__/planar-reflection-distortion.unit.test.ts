import { World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { encodePlanarReflectionUniform } from '../capture/planar-uniform';
import { Camera } from '../components/camera';
import { PlanarReflection, type PlanarReflectionData } from '../components/planar-reflection';
import { projectAuxiliaryCamerasForView, selectCameraRoles } from '../render-system-extract';
import { createRenderTargetOwner } from '../targets/owner';

function planarWorld(overrides: Partial<PlanarReflectionData> = {}) {
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
      {
        component: Camera,
        data: { fov: Math.PI / 3, aspect: 2, near: 0.1, far: 100, cullMask: 0b110 },
      },
    )
    .unwrap();
  world
    .addComponent(display, {
      component: PlanarReflection,
      data: {
        target: world.allocSharedRef('RenderTarget', target.value),
        normal: [0, 2, 0],
        distance: 1,
        ...overrides,
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
    const uniform = encodePlanarReflectionUniform(
      reflectedCamera(planarWorld({ distortion: 0.04 })),
    );
    expect(Array.from(uniform.slice(16, 21))).toEqual([0, 1, 0, 0.5, 1]);
    expect(uniform[21]).toBeCloseTo(0.04, 6);
  });

  it('writes a disabled uniform when no capture is current', () => {
    expect(Array.from(encodePlanarReflectionUniform(undefined))).toEqual(new Array(28).fill(0));
  });

  it.each([-0.1, Number.POSITIVE_INFINITY])('rejects distortion %s', (bad) => {
    const world = planarWorld({ distortion: bad });
    expect(() => selectCameraRoles(world)).toThrow(
      expect.objectContaining({
        code: 'planar-reflection-invalid',
        detail: { field: 'distortion' },
      }),
    );
  });

  it('packs Unreal distance and normal-angle fade intervals', () => {
    const uniform = encodePlanarReflectionUniform(reflectedCamera(planarWorld()));
    const distanceScale = uniform[24] ?? 0;
    const distanceBias = uniform[25] ?? 0;
    const angleScale = uniform[26] ?? 0;
    const angleBias = uniform[27] ?? 0;
    const distanceWeight = (metres: number) => 1 - (metres * distanceScale + distanceBias);
    const angleWeight = (degrees: number) =>
      Math.cos((degrees * Math.PI) / 180) * angleScale + angleBias;
    expect(distanceWeight(0.6)).toBeCloseTo(1);
    expect(distanceWeight(0.8)).toBeCloseTo(0.5);
    expect(distanceWeight(1)).toBeCloseTo(0);
    expect(angleWeight(20)).toBeCloseTo(1);
    expect(angleWeight(30)).toBeCloseTo(0);
  });

  it('validates fade endpoints at camera extraction', () => {
    expect(() => selectCameraRoles(planarWorld({ distanceFadeEndM: 0.25 }))).toThrow(
      expect.objectContaining({
        code: 'planar-reflection-invalid',
        detail: { field: 'distanceFade' },
      }),
    );
    expect(() => selectCameraRoles(planarWorld({ angleFadeEndDegrees: 120 }))).toThrow(
      expect.objectContaining({
        code: 'planar-reflection-invalid',
        detail: { field: 'angleFade' },
      }),
    );
  });

  it('filters only the mirror capture with an authored layer mask', () => {
    const raw = selectCameraRoles(planarWorld({ captureCullMask: 0b011 }));
    expect(raw.display[0]?.cullMask).toBe(0b110);
    expect(projectAuxiliaryCamerasForView(raw.display[0], raw.auxiliary)[0]?.cullMask).toBe(0b010);
  });
});
