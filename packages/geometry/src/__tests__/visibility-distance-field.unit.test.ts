import { assert, expect, it } from 'vitest';
import { buildMeshDistanceField } from '../distance-field';
import {
  decodeMeshDistanceField,
  encodeMeshDistanceField,
  validateMeshDistanceField,
} from '../distance-field-artifact';
import { distanceFieldTexel } from '../distance-field-bricks';
import { createTriangleQuery } from '../triangle-query';
import { buildVisibilityDistanceField } from '../visibility-distance-field';

const positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
const indices = [0, 1, 2, 0, 2, 3];

it('round-trips a field above the previous f32 ceiling within the packed query capacity', async () => {
  // A tilted sheet exercises all three axes without expensive sign voting.
  const field = (
    await buildVisibilityDistanceField([-81, -81, -81, 81, -81, 81, 0, 81, 0], [0, 1, 2], {
      voxelSize: 1,
      triangleSidedness: [1],
    })
  ).unwrap();
  expect(field.dimensions).toEqual([167, 167, 167]);
  expect(field.dimensions.reduce((a, b) => a * b)).toBe(4_657_463);
  // The sheet lies on x=z. These central samples project into its interior.
  const at = (x: number, y: number, z: number) => distanceFieldTexel(field, x + 83, y + 83, z + 83);
  expect(at(0, 0, 0)).toBe(0);
  expect(at(2, 0, 0)).toBeCloseTo(Math.SQRT2, 6);
  const artifact = (await encodeMeshDistanceField(field)).unwrap();
  expect(artifact.length).toBeLessThan(16 * 1024 * 1024);
  expect(Math.ceil(field.values.length / 2) * 4).toBeLessThan(16 * 1024 * 1024);
  const decoded = (await decodeMeshDistanceField(artifact, field.meshDigest)).unwrap();
  expect(decoded.dimensions).toEqual(field.dimensions);
  expect(decoded.bricks).toEqual(field.bricks);
  expect(decoded.values.length).toBe(field.values.length);
  expect(decoded.values.every((value, index) => value === field.values[index])).toBe(true);
  expect(decoded.policy).toEqual(field.policy);
}, 30000);

it('round-trips an extended axis and rejects the first oversized axis', async () => {
  const field = (
    await buildVisibilityDistanceField([0, 0, 0, 509, 0, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 1,
      triangleSidedness: [1],
    })
  ).unwrap();
  expect(field.dimensions).toEqual([514, 6, 6]);
  const artifact = (await encodeMeshDistanceField(field)).unwrap();
  const decoded = (await decodeMeshDistanceField(artifact, field.meshDigest)).unwrap();
  expect(decoded.dimensions).toEqual(field.dimensions);
  expect(decoded.values.every((value, index) => value === field.values[index])).toBe(true);
  const oversized = await buildVisibilityDistanceField([0, 0, 0, 510, 0, 0, 0, 1, 0], [0, 1, 2], {
    voxelSize: 1,
    triangleSidedness: [1],
  });
  assert(!oversized.ok);
  expect(oversized.error.code).toBe('distance-field-limit');
});

it('builds open mixed-sided visibility without claiming a geometric interior or bound', async () => {
  expect((await buildMeshDistanceField(positions, indices)).ok).toBe(false);
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.25,
      triangleSidedness: [0, 1],
    })
  ).unwrap();
  assert(field.policy.kind === 'sampled-visibility');
  expect(field.policy.mostlyTwoSided).toBe(true);
  expect(field.bounds.min[2]).toBe(0);
  expect(field.bounds.max[2]).toBe(0);
  expect(field.policy.traceBounds.min[2]).toBeLessThan(0);
  expect(field.origin[2]).toBeLessThan(field.policy.traceBounds.min[2]);
  expect('errorBound' in field.policy).toBe(false);
  expect(validateMeshDistanceField(field).ok).toBe(true);
  const artifact = (await encodeMeshDistanceField(field)).unwrap();
  expect((await decodeMeshDistanceField(artifact, field.meshDigest)).unwrap()).toEqual(field);
  expect(
    validateMeshDistanceField({ ...field, policy: { kind: 'signed-solid', errorBound: 0 } }).ok,
  ).toBe(false);
  expect(
    validateMeshDistanceField({ ...field, policy: { ...field.policy, traceBounds: field.bounds } })
      .ok,
  ).toBe(false);
});

it('preserves analytic unsigned magnitudes, per-triangle policy identity and owned inputs', async () => {
  const source = [...positions],
    topology = [...indices],
    flags = [1, 1];
  const pending = buildVisibilityDistanceField(source, topology, {
    voxelSize: 0.25,
    triangleSidedness: flags,
  });
  source.fill(100);
  topology.fill(0);
  flags.fill(0);
  const field = (await pending).unwrap();
  assert(field.policy.kind === 'sampled-visibility');
  expect(field.quality.negativeSamples).toBe(0);
  const [nx, ny, nz] = field.dimensions;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const p = [x, y, z].map((v, a) => (field.origin[a] ?? 0) + v * field.spacing);
        const distance = Math.hypot(
          Math.max(Math.abs(p[0] ?? 0) - 1, 0),
          Math.max(Math.abs(p[1] ?? 0) - 1, 0),
          p[2] ?? 0,
        );
        expect(distanceFieldTexel(field, x, y, z)).toBe(
          Math.fround(Math.min(distance, field.policy.distanceBand)),
        );
      }
  const single = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.25,
      triangleSidedness: [0, 0],
    })
  ).unwrap();
  const repeat = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.25,
      triangleSidedness: [1, 1],
    })
  ).unwrap();
  assert(
    single.policy.kind === 'sampled-visibility' && repeat.policy.kind === 'sampled-visibility',
  );
  expect(single.meshDigest).toBe(field.meshDigest);
  expect(single.policy.sourceDigest).not.toBe(field.policy.sourceDigest);
  expect(single.quality.negativeSamples).toBeGreaterThan(0);
  expect(repeat).toEqual(field);
});

it('rejects invalid source, precision, band and grid data before publication', async () => {
  for (const voxelSize of [0, -1, NaN, Infinity, 1e-10, 1e38])
    expect(
      (
        await buildVisibilityDistanceField(positions, indices, {
          voxelSize,
          triangleSidedness: [1, 1],
        })
      ).ok,
    ).toBe(false);
  for (const triangleSidedness of [[0], [0, 2], [NaN, 1]])
    expect(
      (
        await buildVisibilityDistanceField(positions, indices, {
          voxelSize: 0.25,
          triangleSidedness,
        })
      ).ok,
    ).toBe(false);
  expect(
    (
      await buildVisibilityDistanceField(positions, [0, 0, 0], {
        voxelSize: 0.25,
        triangleSidedness: [0],
      })
    ).ok,
  ).toBe(false);
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.25,
      triangleSidedness: [0, 0],
    })
  ).unwrap();
  assert(field.policy.kind === 'sampled-visibility');
  const invalid = field.values.slice();
  invalid[0] = field.policy.distanceBand + 1;
  expect(validateMeshDistanceField({ ...field, values: invalid }).ok).toBe(false);
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  bytes[bytes.length - 65] = (bytes[bytes.length - 65] ?? 0) ^ 1;
  expect((await decodeMeshDistanceField(bytes, field.meshDigest)).ok).toBe(false);
});

it('distinguishes sign-ray exhaustion from a miss or partial hit', () => {
  const q = createTriangleQuery([
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [1, 0, -1],
      [0, 1, -1],
    ],
  ]);
  const hit = { primitive: -1, distance: 0, frontFace: false };
  const budget = { remaining: 1 };
  expect(q.trace(hit, [0.2, 0.2, 1], [0, 0, -1], 0, 5, budget)).toBeNull();
  expect(budget.remaining).toBe(0);
  expect(q.trace(hit, [0.2, 0.2, 1], [0, 0, -1], 0, 5, { remaining: 2 })).toBe(true);
  expect(hit.distance).toBe(1);
  expect(q.trace(hit, [2, 2, 1], [0, 0, -1], 0, 5, { remaining: 0 })).toBe(false);
});

it('filters zero-area triangles without shifting surviving triangle sidedness', async () => {
  const expected = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.25,
      triangleSidedness: [1, 0],
    })
  ).unwrap();
  const filtered = (
    await buildVisibilityDistanceField(positions, [0, 0, 0, ...indices], {
      voxelSize: 0.25,
      triangleSidedness: [0, 1, 0],
    })
  ).unwrap();
  expect(filtered.quality.testedTriangles).toBe(2);
  expect(filtered.values).toEqual(expected.values);
  expect(filtered.meshDigest).not.toBe(expected.meshDigest);
});

it('rounds the stored border outward so f32 trace bounds still contain the source', async () => {
  const field = (
    await buildVisibilityDistanceField(
      [
        -271.2546081542969, -0.14010000228881836, -250.77699279785156, -219.32369995117188,
        -0.14010000228881836, -250.77699279785156, -271.2546081542969, 56.199501037597656,
        -198.78799438476562,
      ],
      [0, 1, 2],
      { voxelSize: 15.624999046325684, triangleSidedness: [0] },
    )
  ).unwrap();
  expect(validateMeshDistanceField(field).ok).toBe(true);
  expect((await encodeMeshDistanceField(field)).ok).toBe(true);
});
