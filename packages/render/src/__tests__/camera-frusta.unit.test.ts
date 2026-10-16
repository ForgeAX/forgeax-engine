import { box3, frustum } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { buildCameraFrusta } from '../camera-frusta';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { CameraSnapshot } from '../render-contract';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function camera(overrides: Partial<CameraSnapshot> = {}): CameraSnapshot {
  return {
    ...makeZeroCameraFallbackSnapshot(),
    world: new Float32Array(IDENTITY),
    ...overrides,
  };
}

function bounds(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): ReturnType<typeof box3.create> {
  return box3.create(minX, minY, minZ, maxX, maxY, maxZ);
}

function expectPlaneValues(actual: Float32Array, expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    if (Number.isNaN(value)) {
      expect(actual[index]).toBeNaN();
    } else {
      expect(actual[index]).toBeCloseTo(value, 5);
    }
  });
}

describe('CameraSnapshot frustum policy', () => {
  it('preserves ordered normalized plane values for a perspective camera', () => {
    const planes = buildCameraFrusta([
      camera({ fov: Math.PI / 3, aspect: 1.5, near: 0.5, far: 50 }),
    ]);

    expectPlaneValues(
      planes[0] as Float32Array,
      [
        0.7559289336, 0, -0.6546536684, 0, -0.7559289336, 0, -0.6546536684, 0, 0, 0.8660253882,
        -0.5, 0, 0, -0.8660253882, -0.5, 0, 0, 0, 1, 50, 0, 0, -1, -0.5,
      ],
    );
  });

  it('preserves transformed camera plane values and singular inversion fallback', () => {
    const transformedWorld = new Float32Array([0, 0, -2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 5, 6, 7, 1]);
    const transformed = buildCameraFrusta([
      camera({
        fov: Math.PI / 3,
        aspect: 1.5,
        near: 0.5,
        far: 50,
        world: transformedWorld,
      }),
    ]);
    expectPlaneValues(
      transformed[0] as Float32Array,
      [
        -0.397359699, 0, -0.9176629186, 8.4104394913, -0.397359699, 0, 0.9176629186, -4.4368419647,
        -0.397359699, 0.9176629186, 0, -3.5191791058, -0.397359699, -0.9176629186, 0, 7.4927763939,
        1, 0, 0, 194.9999847412, -1, 0, 0, 3,
      ],
    );

    const singularWorld = new Float32Array(16);
    const singular = buildCameraFrusta([
      camera({
        fov: Math.PI / 3,
        aspect: 1.5,
        near: 0.5,
        far: 50,
        world: singularWorld,
      }),
    ]);
    expectPlaneValues(
      singular[0] as Float32Array,
      [
        0.7559289336, 0, -0.6546536684, 0, -0.7559289336, 0, -0.6546536684, 0, 0, 0.8660253882,
        -0.5, 0, 0, -0.8660253882, -0.5, 0, 0, 0, 1, 50, 0, 0, -1, -0.5,
      ],
    );
  });

  it('keeps camera order, transforms the view, and accepts orthographic fov=0', () => {
    const translatedWorld = new Float32Array(IDENTITY);
    translatedWorld[12] = 2;
    const planes = buildCameraFrusta([
      camera(),
      camera({
        projection: 'orthographic',
        fov: 0,
        orthoLeft: -1,
        orthoRight: 1,
        orthoBottom: -1,
        orthoTop: 1,
        world: translatedWorld,
      }),
    ]);

    expect(planes).toHaveLength(2);
    expect(planes[0]).toHaveLength(24);
    expect(planes[1]).toHaveLength(24);
    expect(
      frustum.intersectsBox(planes[1] as frustum.Frustum, bounds(1.5, -0.25, -1, 2.5, 0.25, -0.25)),
    ).toBe(true);
    expect(
      frustum.intersectsBox(
        planes[1] as frustum.Frustum,
        bounds(-0.5, -0.25, -1, 0.5, 0.25, -0.25),
      ),
    ).toBe(false);
  });

  it('uses an empty always-visible sentinel for invalid projection ranges', () => {
    const planes = buildCameraFrusta([
      camera({ fov: 0 }),
      camera({ aspect: 0 }),
      camera({ near: 10, far: 10 }),
      camera({ projection: 'orthographic', near: 11, far: 10 }),
    ]);

    expect(planes.map((plane) => plane.length)).toEqual([0, 0, 0, 0]);
    expect(
      frustum.intersectsBox(planes[0] as frustum.Frustum, bounds(100, 100, 100, 101, 101, 101)),
    ).toBe(true);
  });

  it('does not add validation for malformed camera input', () => {
    const malformed = buildCameraFrusta([camera({ aspect: Number.NaN })])[0];

    expect(malformed).toHaveLength(24);
    expect(malformed?.[0]).toBeNaN();
    expect(malformed?.[4]).toBeNaN();
    expectPlaneValues(malformed as Float32Array, [
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      0,
      0.9238795638,
      -0.3826834261,
      0,
      0,
      -0.9238795638,
      -0.3826834261,
      0,
      0,
      0,
      1,
      100,
      0,
      0,
      -1,
      -0.1,
    ]);
  });

  it('returns fresh per-camera storage on each invocation', () => {
    const first = buildCameraFrusta([camera()]);
    const second = buildCameraFrusta([camera()]);

    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    const firstPlane = first[0];
    const secondPlane = second[0];
    if (firstPlane === undefined || secondPlane === undefined) throw new Error('missing plane');
    const original = secondPlane[0];
    if (original === undefined) throw new Error('missing plane coefficient');
    firstPlane[0] = original + 1;
    expect(secondPlane[0]).toBe(original);
  });
});
