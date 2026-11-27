import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { packSdfScene } from '../../raytracing/sdf-query';
import {
  type SdfPlacementBounds,
  SdfTransformCertificate,
} from '../../raytracing/sdf-transform-certificate';
import { compare, rational, residualNorm, transformed } from './exact-affine.fixture';
import {
  authoredFarWorldBounds,
  authoredMissingBounds,
  envelopeContains,
  placementCorners,
  placementSegmentCases,
  segmentIntersectsBox,
} from './sdf-placement-bounds.fixture';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function enclosure(forward: Float32Array, box: SdfPlacementBounds) {
  const inverse = mat4.invert(mat4.create(), forward),
    certificate = SdfTransformCertificate.create(forward, inverse).unwrap();
  return certificate.encloseBounds(forward, inverse, box);
}

it('encloses original binary64 authored bounds under the actual canonical forward', () => {
  const boxes: SdfPlacementBounds[] = [
    authoredMissingBounds,
    { min: [-0.1 - 2 ** -30, -0.3, -1], max: [0.1 + 2 ** -30, 0.7, 2] },
    { min: [0, 0, 0], max: [0, 0, 0] },
  ];
  let checked = 0,
    refused = 0;
  for (const angle of [0, 0.37, Math.PI / 2])
    for (const scale of [
      [1, 1, 1],
      [-2, 0.5, 4],
      [2 ** 20, 2 ** -20, 8],
    ]) {
      const forward = identity(),
        c = Math.cos(angle),
        s = Math.sin(angle);
      forward[0] = c * (scale[0] ?? NaN);
      forward[1] = s * (scale[0] ?? NaN);
      forward[4] = -s * (scale[1] ?? NaN);
      forward[5] = c * (scale[1] ?? NaN);
      forward[10] = scale[2] ?? NaN;
      forward[12] = 4;
      forward[14] = 3;
      const inverse = mat4.invert(mat4.create(), forward),
        admitted = SdfTransformCertificate.create(forward, inverse);
      if (!admitted.ok) {
        // Existing transform admission is not weakened to qualify a box.
        expect(compare(residualNorm(forward, inverse), rational(1)) >= 0n).toBe(true);
        refused++;
        continue;
      }
      for (const box of boxes) {
        const result = admitted.value.encloseBounds(forward, inverse, box).unwrap();
        expect(envelopeContains(result, placementCorners(forward, box))).toBe(true);
        expect(
          Object.isFrozen(result) && Object.isFrozen(result.min) && Object.isFrozen(result.max),
        ).toBe(true);
        for (const value of [...result.min, ...result.max]) {
          expect(Number.isFinite(value) && Math.fround(value) === value).toBe(true);
          expect(value === 0 || Math.abs(value) >= 2 ** -126).toBe(true);
        }
        checked++;
      }
    }
  expect(checked).toBe(24);
  expect(refused).toBe(1);
});

it('rounds subnormal, zero, binade and maximum-finite boundaries outwards', () => {
  const maximum = Math.fround(3.4028234663852886e38);
  for (const value of [0, -0, Number.MIN_VALUE, -(2 ** -149), 2 ** -126, 1 + 2 ** -24, maximum]) {
    const box: SdfPlacementBounds = { min: [value, -value, 0], max: [value, -value, 0] },
      bounds = enclosure(identity(), box).unwrap();
    expect(envelopeContains(bounds, placementCorners(identity(), box))).toBe(true);
    for (const endpoint of [...bounds.min, ...bounds.max])
      expect(endpoint === 0 || Math.abs(endpoint) >= 2 ** -126).toBe(true);
  }
  const tiny = enclosure(identity(), {
    min: [Number.MIN_VALUE, 0, 0],
    max: [Number.MIN_VALUE, 0, 0],
  }).unwrap();
  expect(tiny.min[0]).toBe(0);
  expect(tiny.max[0]).toBe(2 ** -126);
  const overflow: SdfPlacementBounds = { min: [0, 0, 0], max: [Number.MAX_VALUE, 1, 1] };
  expect(enclosure(identity(), overflow).ok).toBe(false);
});

it('keeps invalid candidate domains separate from existing geometry transform qualification', () => {
  const forward = identity(),
    inverse = identity(),
    certificate = SdfTransformCertificate.create(forward, inverse).unwrap();
  for (const box of [
    { min: [1, 0, 0], max: [0, 1, 1] },
    { min: [0, 0, 0], max: [Infinity, 1, 1] },
    { min: [NaN, 0, 0], max: [1, 1, 1] },
    { min: [0, 0, 0], max: [Number.MAX_VALUE, 1, 1] },
  ] as const) {
    expect(certificate.encloseBounds(forward, inverse, box).ok).toBe(false);
    expect(certificate.validate(forward, inverse).ok).toBe(true);
  }
  const original = certificate.encloseBounds(forward, inverse, authoredMissingBounds).unwrap();
  forward[12] = 4;
  expect(certificate.encloseBounds(forward, inverse, authoredMissingBounds).ok).toBe(false);
  expect(original).toEqual(authoredMissingBounds);
});

it('derives missing-field placement facts from the uploaded inverse and the original forward and bounds', () => {
  const forward = identity();
  forward[12] = 4;
  forward[14] = 3;
  const field = { missing: true as const, bounds: authoredMissingBounds },
    packed = packSdfScene([
      { instanceId: 7, geometryId: 9, mask: 255, transform: forward, field },
    ]).unwrap(),
    inverse = new Float32Array(packed.instances.buffer, packed.instances.byteOffset, 16),
    certificate = SdfTransformCertificate.create(forward, inverse).unwrap();
  expect(certificate.encloseBounds(forward, inverse, field.bounds).unwrap()).toEqual(
    authoredFarWorldBounds,
  );
  const words = new Uint32Array(packed.instances.buffer, packed.instances.byteOffset, 36);
  expect(words[20]).toBe(0xffffffff);
  expect(words[35]).toBe(0);
  // This does not turn the missing surface packet into qualified geometry.
  expect(Array.from(packed.surface.headers.subarray(4, 24))).toEqual(Array(20).fill(0));
});

it('distinguishes far, near, closed-endpoint and middle-only missing candidates without normalizing rays', () => {
  const forward = identity();
  forward[12] = 4;
  forward[14] = 3;
  const box = enclosure(forward, authoredMissingBounds).unwrap();
  expect(box).toEqual(authoredFarWorldBounds);
  const cases = placementSegmentCases();
  for (const row of cases) {
    expect(segmentIntersectsBox(row.ray, authoredFarWorldBounds), row.name).toBe(row.intersects);
    expect(segmentIntersectsBox(row.ray, box), row.name).toBe(row.intersects);
  }
  const middle = cases.find((row) => row.name === 'middle-only');
  if (!middle) throw Error('Authored crossing control required');
  // Wrong: the union of point candidates at the two ends is not a segment candidate set.
  for (const t of [middle.ray.first, middle.ray.last])
    expect(segmentIntersectsBox({ ...middle.ray, first: t, last: t }, box)).toBe(false);
  expect(segmentIntersectsBox(middle.ray, box)).toBe(true);
});

it('rejects inward-rounding and fabricated-inverse envelope controls with independent corners', () => {
  const forward = identity(),
    inverse = identity(),
    source: SdfPlacementBounds = { min: [0, 0, 0], max: [1 + 2 ** -24, 1, 1] },
    certificate = SdfTransformCertificate.create(forward, inverse).unwrap(),
    correct = certificate.encloseBounds(forward, inverse, source).unwrap(),
    corners = placementCorners(forward, source);
  expect(envelopeContains(correct, corners)).toBe(true);
  expect(
    envelopeContains({ min: source.min, max: [Math.fround(source.max[0]), 1, 1] }, corners),
  ).toBe(false);
  inverse[12] = -4;
  expect(certificate.encloseBounds(forward, inverse, source).ok).toBe(false);
  const wrongForward = identity();
  wrongForward[12] = 4;
  const wrongPoints = [transformed(wrongForward, [rational(1), rational(0), rational(0)])];
  expect(envelopeContains(correct, wrongPoints)).toBe(false);
});
