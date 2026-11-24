import { expect, it } from 'vitest';
import {
  assessAuthoredSurface,
  describeAuthoredSurface,
  type ExactAuthoredMesh,
  exactAuthoredSurfaces,
} from './world-silhouette-exact.fixture';

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const RAY = { origin: [0, 0, 0] as const, direction: [0, 0, 1] as const, end: 10 };

function triangle(z: number, id = 1): ExactAuthoredMesh {
  return {
    id,
    positions: Float32Array.from([-1, -1, z, 0, 1, z, 1, -1, z]),
    indices: Uint32Array.from([0, 1, 2]),
    transform: IDENTITY,
  };
}

function nearest(meshes: readonly ExactAuthoredMesh[]) {
  const result = exactAuthoredSurfaces(meshes, [RAY])[0];
  if (!result?.length) throw Error('An authored nearest surface is required');
  return result;
}

it('finds a canonical nearest surface using exact dyadic distances', () => {
  const faces = describeAuthoredSurface(nearest([triangle(2), triangle(3, 2)]));
  expect(faces).toHaveLength(1);
  expect(faces[0]?.instance).toBe(1);
  expect(faces[0]?.frontFace).toBe(true);
  expect(BigInt(faces[0]?.numerator ?? '0')).toBe(2n * BigInt(faces[0]?.denominator ?? '0'));
});

it('keeps all exact shared-edge faces without an epsilon tie', () => {
  const mesh: ExactAuthoredMesh = {
    id: 1,
    positions: Float32Array.from([-1, -1, 2, -1, 1, 2, 1, 1, 2, 1, -1, 2]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    transform: IDENTITY,
  };
  expect(describeAuthoredSurface(nearest([mesh])).map((face) => face.primitive)).toEqual([0, 1]);
});

it('does not merge distinct nearby Float32 planes', () => {
  const faces = describeAuthoredSurface(nearest([triangle(0.1), triangle(0.10000001, 2)]));
  expect(faces.map((face) => face.instance)).toEqual([1]);
});

it('preserves the original parameter for all three nonunit speeds', () => {
  const speeds = [0.5, 1, 2];
  const results = exactAuthoredSurfaces(
    [triangle(2)],
    speeds.map((speed) => ({ ...RAY, direction: [0, 0, speed] as const })),
  );
  for (const [i, rows] of results.entries()) {
    const face = describeAuthoredSurface(rows)[0];
    expect(Number(face?.numerator) / Number(face?.denominator)).toBe(2 / (speeds[i] ?? NaN));
  }
});

it('requires the actual instance, original primitive and facing marker', () => {
  const faces = nearest([triangle(2)]);
  const correct = assessAuthoredSurface(faces, [1, 0x80000001, 0, 1], [0, 0, -1]);
  expect(correct.identityCorrect && correct.facingCorrect && correct.normalCorrect).toBe(true);
  expect(assessAuthoredSurface(faces, [1, 0x80000000, 0, 1], [0, 0, -1]).facingCorrect).toBe(false);
  expect(assessAuthoredSurface(faces, [1, 0x80000001, 0, 2], [0, 0, -1]).identityCorrect).toBe(
    false,
  );
  expect(assessAuthoredSurface(faces, [1, 0x80000005, 0, 1], [0, 0, -1]).identityCorrect).toBe(
    false,
  );
  expect(assessAuthoredSurface(faces, [1, 1, 0, 1], [0, 0, -1]).identityCorrect).toBe(false);
});

it('rejects inverted, nonunit, nonfinite and distorted normals', () => {
  const faces = nearest([triangle(2)]);
  for (const normal of [
    [0, 0, 1],
    [0, 0, -0.5],
    [NaN, 0, -1],
    [0.5, 0, -Math.sqrt(0.75)],
  ] as const) {
    expect(assessAuthoredSurface(faces, [1, 0x80000001, 0, 1], normal).normalCorrect).toBe(false);
  }
});

it('rejects a behind primitive even when the old 0.12m time gate accepts its distance', () => {
  const front = triangle(2);
  const back = triangle(2.1);
  const mesh = {
    ...front,
    positions: Float32Array.from([...front.positions, ...back.positions]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
  };
  expect(Math.abs((mesh.positions[11] ?? NaN) - 2)).toBeLessThan(0.12);
  expect(
    assessAuthoredSurface(nearest([mesh]), [1, 0x80000005, 0, 1], [0, 0, -1]).identityCorrect,
  ).toBe(false);
});

it('does not silently use a coplanar ray as a certified clear prefix', () => {
  expect(() => exactAuthoredSurfaces([triangle(0)], [{ ...RAY, direction: [1, 0, 0] }])).toThrow(
    'Coplanar',
  );
});

it('refuses invalid source indices and nonfinite geometry', () => {
  const mesh = triangle(2);
  expect(() => nearest([{ ...mesh, indices: Uint32Array.from([0, 1, 100]) }])).toThrow();
  const positions = mesh.positions.slice();
  positions[0] = Infinity;
  expect(() => nearest([{ ...mesh, positions }])).toThrow();
});
