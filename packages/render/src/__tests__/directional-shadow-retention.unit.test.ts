import { mat4, vec3 } from '@forgeax/engine-math';
import { assert, describe, expect, it } from 'vitest';
import {
  type CsmCameraData,
  computeDirectionalCsm,
  type DirectionalCsmConfig,
} from '../render-system-extract';

const config: DirectionalCsmConfig = {
  cascadeCount: 3,
  splitLambda: 0.75,
  cascadeBlend: 0.2,
  mapSize: 1024,
  shadowDistance: 100,
  shadowFilter: 3,
  shadowAngularRadius: 0.00465,
  maxPenumbraTexels: 32,
};
const direction = vec3.create(0.18, -0.6, 1);
function camera(x = 0, yaw = 0): CsmCameraData {
  const world = mat4.identity(mat4.create());
  world[0] = Math.cos(yaw);
  world[2] = -Math.sin(yaw);
  world[8] = Math.sin(yaw);
  world[10] = Math.cos(yaw);
  world[12] = x;
  return {
    world,
    fov: (70 * Math.PI) / 180,
    aspect: 16 / 9,
    near: 0.1,
    far: 100,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
  };
}
function assertReceiverCoverage(
  view: CsmCameraData,
  matrices: readonly Float32Array[],
  splits: Float32Array,
) {
  for (let index = 0; index < config.cascadeCount; index++) {
    const near =
      index === 0 ? view.near : (splits[(index - 1) * 4] as number) * (1 - config.cascadeBlend);
    const far = splits[index * 4] as number;
    for (const depth of [near, far])
      for (const x of [-1, 1])
        for (const y of [-1, 1]) {
          const corner = mat4.transformVec3(
            vec3.create(),
            view.world as never,
            vec3.create(
              x * depth * Math.tan(view.fov / 2) * view.aspect,
              y * depth * Math.tan(view.fov / 2),
              -depth,
            ),
          );
          const clip = mat4.transformVec3(vec3.create(), matrices[index] as never, corner);
          expect(Math.abs(clip[0] as number)).toBeLessThanOrEqual(1);
          expect(Math.abs(clip[1] as number)).toBeLessThanOrEqual(1);
          expect(clip[2]).toBeGreaterThanOrEqual(0);
          expect(clip[2]).toBeLessThanOrEqual(1);
        }
  }
}

describe('directional shadow guard-band retention', () => {
  it('keeps translated and rotated receivers covered while crossing snapped page boundaries', () => {
    const first = computeDirectionalCsm(direction, config, camera());
    assert(first);
    let retained = first.lightViewProj;
    let snapped = first.lightViewProj;
    let retainedRebuilds = 0,
      snappedRebuilds = 0,
      retainedHits = 0;
    for (let frame = 1; frame <= 120; frame++) {
      const view = camera(frame * 0.04, Math.sin(frame * 0.025) * 0.12);
      const fresh = computeDirectionalCsm(direction, config, view);
      assert(fresh);
      const next = computeDirectionalCsm(direction, config, view, retained);
      assert(next);
      for (let cascade = 0; cascade < 3; cascade++) {
        if (next.lightViewProj[cascade] === retained[cascade]) retainedHits++;
        else retainedRebuilds++;
        if (String(fresh.lightViewProj[cascade]) !== String(snapped[cascade])) snappedRebuilds++;
      }
      assertReceiverCoverage(view, next.lightViewProj, next.splitPlanes);
      retained = next.lightViewProj;
      snapped = fresh.lightViewProj;
    }
    expect(retainedHits).toBeGreaterThan(300);
    expect(retainedRebuilds).toBeLessThan(snappedRebuilds);
  });

  it('rejects a retained page when the receiver normal offset exhausts its guard', () => {
    const first = computeDirectionalCsm(direction, config, camera());
    assert(first);
    const biased = computeDirectionalCsm(direction, config, camera(), first.lightViewProj, 1000);
    assert(biased);
    for (let cascade = 0; cascade < 3; cascade++)
      expect(biased.lightViewProj[cascade]).not.toBe(first.lightViewProj[cascade]);
  });

  it('refreshes uncovered translations, light rotations, and projection scale changes immediately', () => {
    const first = computeDirectionalCsm(direction, config, camera());
    assert(first);
    for (const [light, view] of [
      [direction, camera(1000)],
      [vec3.create(-0.6, -0.5, 1), camera()],
      [direction, { ...camera(), fov: Math.PI / 3 }],
      [direction, { ...camera(), aspect: 1 }],
    ] as const) {
      const next = computeDirectionalCsm(light, config, view, first.lightViewProj);
      assert(next);
      for (let cascade = 0; cascade < 3; cascade++)
        expect(next.lightViewProj[cascade]).not.toBe(first.lightViewProj[cascade]);
      assertReceiverCoverage(view, next.lightViewProj, next.splitPlanes);
    }
  });
});

it('keeps an explicit shadow camera independent of display movement and CSM retention', () => {
  const matrix = mat4.create();
  mat4.orthographicReverseZ(matrix, -5, 5, 5, -5, 0.5, 500);
  const fixed = { ...config, shadowViewProjection: new Float32Array(matrix) };
  const first = computeDirectionalCsm(direction, fixed, camera());
  const moved = computeDirectionalCsm(direction, fixed, camera(100, 1.2), first?.lightViewProj);
  assert(first && moved);
  expect(first.cascadeCount).toBe(1);
  expect(first.cascadeBlend).toBe(0);
  expect(first.lightViewProj[0]).toEqual(matrix);
  expect(moved.lightViewProj).toEqual(first.lightViewProj);
  expect(first.splitPlanes[0]).toBeGreaterThan(1e30);
  expect(first.splitPlanes[1]).toBeCloseTo(10 / config.mapSize);
  expect(first.splitPlanes[2]).toBeCloseTo(499.5);
});
