import { mat4, vec3 } from '@forgeax/engine-math';
import { assert, describe, expect, it } from 'vitest';
import {
  type CsmCameraData,
  computeDirectionalCsm,
} from '../../../render/src/render-system-extract';

const camera: CsmCameraData = {
  world: mat4.create(),
  fov: Math.PI / 4,
  aspect: 16 / 9,
  near: 0.1,
  far: 100,
  projection: 'perspective',
  orthoLeft: -1,
  orthoRight: 1,
  orthoBottom: -1,
  orthoTop: 1,
};
const config = {
  cascadeCount: 4,
  splitLambda: 0.75,
  cascadeBlend: 0.2,
  mapSize: 2048,
  shadowDistance: 200,
};

describe('directional cascade receiver coverage', () => {
  it('includes an upstream caster behind a camera looking down into its shadow', () => {
    const world = mat4.create();
    mat4.invert(
      world,
      mat4.lookAt(mat4.create(), vec3.create(0, 1, 1), vec3.create(0, 0, 2), vec3.create(0, 1, 0)),
    );
    const result = computeDirectionalCsm(
      vec3.create(0, -1, 1),
      { ...config, shadowDistance: 35 },
      {
        ...camera,
        world,
        fov: Math.PI / 3,
        aspect: 1,
        near: 0.05,
      },
    );
    assert(result);
    const matrix = result.lightViewProj[0];
    assert(matrix);
    const receiver = mat4.transformVec3(vec3.create(), matrix, vec3.create(0, 0, 2));
    const caster = mat4.transformVec3(vec3.create(), matrix, vec3.create(0, 2, 0));
    expect(Math.abs(receiver[0] ?? Number.NaN)).toBeLessThan(1);
    expect(Math.abs(receiver[1] ?? Number.NaN)).toBeLessThan(1);
    expect(receiver[2] ?? Number.NaN).toBeGreaterThan(0);
    expect(receiver[2] ?? Number.NaN).toBeLessThan(1);
    expect(caster[0] ?? Number.NaN).toBeCloseTo(receiver[0] ?? Number.NaN);
    expect(caster[1] ?? Number.NaN).toBeCloseTo(receiver[1] ?? Number.NaN);
    expect(
      caster[2] ?? Number.NaN,
      'caster on the receiver-to-light ray must survive near clipping',
    ).toBeGreaterThanOrEqual(0);
  });
  it('reports the depth span actually used by each projection', () => {
    const result = computeDirectionalCsm(vec3.create(0.18, -0.18, 1), config, camera);
    assert(result);
    for (let index = 0; index < 4; index++) {
      const m = result.lightViewProj[index];
      assert(m);
      const span = 1 / Math.hypot(m[2] ?? Number.NaN, m[6] ?? Number.NaN, m[10] ?? Number.NaN);
      expect(result.splitPlanes[index * 4 + 2]).toBeCloseTo(span, 3);
    }
  });
  it('fits the next cascade over the entire receiver fade band', () => {
    const result = computeDirectionalCsm(vec3.create(1, -1, 0), config, camera);
    assert(result);
    for (let next = 1; next < 4; next++) {
      const fadeStart =
        (result.splitPlanes[(next - 1) * 4] ?? Number.NaN) * (1 - config.cascadeBlend);
      const corners = [fadeStart, result.splitPlanes[next * 4] ?? Number.NaN].flatMap((depth) =>
        [-1, 1].flatMap((x) =>
          [-1, 1].map((y) =>
            vec3.create(
              x * depth * Math.tan(camera.fov / 2) * camera.aspect,
              y * depth * Math.tan(camera.fov / 2),
              -depth,
            ),
          ),
        ),
      );
      const projection = result.lightViewProj[next];
      assert(projection);
      for (const corner of corners) {
        const clip = mat4.transformVec3(vec3.create(), projection, corner);
        expect(Math.abs(clip[0] ?? Number.NaN)).toBeLessThanOrEqual(1.0001);
        expect(Math.abs(clip[1] ?? Number.NaN)).toBeLessThanOrEqual(1.0001);
        expect(clip[2] ?? Number.NaN).toBeGreaterThanOrEqual(-0.0001);
        expect(clip[2] ?? Number.NaN).toBeLessThanOrEqual(1.0001);
      }
    }
  });
});
