import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { cameraLensProjection, jitterCameraProjection } from '../camera-projection';
import { perspective } from '../components/camera';
import { activeFrustum, occlusionCamera } from '../gpu-driven/production-raster-camera';
import type { CameraSnapshot } from '../render-contract';
import { projectTemporalView } from '../temporal/temporal-view';

it.each([
  0,
  -1,
  Math.PI,
  74,
  180,
  NaN,
  Infinity,
])('rejects invalid perspective angles before building an inverted lens: %s', (fov) => {
  const error = expect.objectContaining({
    code: 'camera-projection-invalid',
    detail: expect.objectContaining({ field: 'fov' }),
  });
  expect(() => perspective({ fov, aspect: 1 })).toThrowError(error);
  expect(() => cameraLensProjection({ ...camera('perspective'), fov }, mat4.create())).toThrowError(
    error,
  );
});

it('accepts a degree value explicitly converted to radians and leaves orthographic sentinels alone', () => {
  const fov = (74 * Math.PI) / 180;
  expect(perspective({ fov, aspect: 1 }).fov).toBe(fov);
  const projection = cameraLensProjection({ ...camera('perspective'), fov }, mat4.create());
  expect(projection[0]).toBeGreaterThan(0);
  expect(projection[5]).toBeGreaterThan(0);
  expect(() =>
    cameraLensProjection({ ...camera('orthographic'), fov: 0 }, mat4.create()),
  ).not.toThrow();
});

it('applies clip jitter to dense and perspective matrices with aliased output', () => {
  const dense = mat4.create();
  for (let index = 0; index < 16; index++) dense[index] = (index - 7) * 0.31;
  const perspective = mat4.perspectiveReverseZ(mat4.create(), 1.1, 1.7, 0.1, 500);
  for (const projection of [dense, perspective]) {
    for (const jitter of [
      [0, 0],
      [1 / 1234, -1 / 765],
      [-0.2, 0.3],
    ] as const) {
      const shift = mat4.identity(mat4.create());
      shift[12] = jitter[0] * 2;
      shift[13] = jitter[1] * -2;
      const expected = mat4.multiply(mat4.create(), shift, projection);
      const result = jitterCameraProjection(mat4.create(), projection, jitter);
      const alias = mat4.clone(projection);
      expect(jitterCameraProjection(alias, alias, jitter)).toBe(alias);
      for (let index = 0; index < 16; index++) {
        expect(result[index]).toBeCloseTo(expected[index] ?? 0, 6);
        expect(alias[index]).toBe(result[index]);
      }
    }
    expect(jitterCameraProjection(mat4.create(), projection, undefined)).toEqual(projection);
  }
});

function camera(projection: CameraSnapshot['projection']): CameraSnapshot {
  const world = mat4.identity(mat4.create());
  world[12] = 3;
  world[14] = 7;
  return {
    entityKey: 1,
    worldId: 0,
    historyVersion: 0,
    position: vec3.create(3, 0, 7),
    world,
    fov: Math.PI / 3,
    aspect: 1.7,
    near: 0.1,
    far: 100,
    projection,
    projectionOffset: [0.13, -0.08],
    orthoLeft: -2,
    orthoRight: 2,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: [0, 0, 0, 1],
  };
}

it.each([
  'perspective',
  'orthographic',
] as const)('keeps %s culling outputs independent through nested and throwing camera getters', (projection) => {
  const source = camera(projection);
  const expected = activeFrustum(source);
  const expectedOcclusion = occlusionCamera(source);
  const retained = new Float32Array(expectedOcclusion.viewProjection);
  const other = camera('perspective');
  other.world[12] = -23;
  let nested = 0;
  const borrowed = {
    ...source,
    get world() {
      nested++;
      occlusionCamera(other);
      return source.world;
    },
  };
  expect(activeFrustum(borrowed)).toEqual(expected);
  expect(nested).toBe(1);
  expect(occlusionCamera(borrowed)).toEqual(expectedOcclusion);
  expect(expectedOcclusion.viewProjection).toEqual(retained);
  expect(activeFrustum(other)).not.toBe(expected);
  const fault = new Error('camera getter failed');
  expect(() =>
    activeFrustum({
      ...source,
      get world(): Float32Array {
        throw fault;
      },
    }),
  ).toThrow(fault);
  expect(activeFrustum(source)).toEqual(expected);
  const projectionMatrix = cameraLensProjection(source, mat4.create());
  const view = mat4.invert(mat4.create(), source.world);
  expect(expected).toEqual(
    frustum.fromViewProjection(
      frustum.create(),
      mat4.multiply(mat4.create(), projectionMatrix, view),
    ),
  );
});

it('keeps temporal outputs and history independent through reentry and restores scratch after throws', () => {
  const source = camera('perspective');
  const input = { camera: source, temporalFrameIndex: 3, surfaceWidth: 1280, surfaceHeight: 720 };
  const expected = projectTemporalView(input);
  const retained = new Float32Array(expected.currentJitteredViewProjection);
  const other = camera('orthographic');
  other.world[14] = -9;
  const borrowed = {
    ...source,
    get near() {
      projectTemporalView({ ...input, camera: other });
      return source.near;
    },
  };
  expect(projectTemporalView({ ...input, camera: borrowed })).toEqual(expected);
  expect(expected.currentJitteredViewProjection).toEqual(retained);
  const fault = new Error('temporal getter failed');
  expect(() =>
    projectTemporalView({
      ...input,
      camera: {
        ...source,
        get near(): number {
          throw fault;
        },
      },
    }),
  ).toThrow(fault);
  const next = projectTemporalView(input);
  expect(next).toEqual(expected);
  expect(next.currentJitteredViewProjection).not.toBe(expected.currentJitteredViewProjection);
  expect(next.currentUnjitteredViewProjection).not.toBe(expected.currentUnjitteredViewProjection);
});
