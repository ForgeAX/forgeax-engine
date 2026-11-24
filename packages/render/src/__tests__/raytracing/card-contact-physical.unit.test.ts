import { writeFileSync } from 'node:fs';
import { assert, expect, it } from 'vitest';
import {
  executeReceiver,
  receiverIdentity,
} from '../../../../shader/src/__tests__/canonical-receiver-reconstruction.fixture';
import {
  CARD_SHADOW_CASES,
  cardShadowSource,
  triangleOnSegment,
  type V3,
} from './card-contact-physical.fixture';
import { executeCardLightSegment, rayNumbers } from './card-light-segment.fixture';

// Keep the original 14 authored inputs, but derive physical truth from the
// receiver, not from its displaced legacy query. No old segment expectation is used.
const cases = CARD_SHADOW_CASES.map((row, index) => {
  const shift = (p: V3): V3 => [p[0], p[1] + index * 2, p[2]];
  return {
    ...row,
    receiver: shift(row.receiver ?? [0, 0, 0]),
    light: shift(row.light),
    triangle: row.triangle.map(shift) as [V3, V3, V3],
  };
}).filter(
  (row) =>
    row.light.every(Number.isFinite) &&
    row.light.some((v, axis) => v !== row.receiver[axis]) &&
    (row.energy ?? [1, 1, 1]).some((v) => v !== 0),
);

it.each(
  cases,
)('encloses the true receiver-to-light segment from the actual producer for $name', (row) => {
  const source = cardShadowSource();
  // The real light uniform and authored canonical vertices upload f32 values.
  // Keep the authored row above unchanged and record this boundary separately.
  const light: V3 = [
    Math.fround(row.light[0]),
    Math.fround(row.light[1]),
    Math.fround(row.light[2]),
  ];
  const triangle = row.triangle.map(
    (v): V3 => [Math.fround(v[0]), Math.fround(v[1]), Math.fround(v[2])],
  ) as [V3, V3, V3];
  const direction: V3 =
    row.kind < 2
      ? [0, 0, 1]
      : [light[0] - row.receiver[0], light[1] - row.receiver[1], light[2] - row.receiver[2]];
  const expectedMask = Number(
    !triangleOnSegment(row.receiver, direction, row.kind < 2 ? 4 : 1, triangle),
  );
  const p = row.receiver;
  const point = executeReceiver({
    name: row.name,
    vertices: [
      [p[0] - 1, p[1] - 1, p[2]],
      [p[0] + 1, p[1] - 1, p[2]],
      [p[0], p[1] + 1, p[2]],
    ],
    forward: receiverIdentity,
    viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], 0.5 - p[2], 1],
    pixel: [0, 0],
    extent: [1, 1],
    sampleOffset: [0.5, 0.5],
  });
  expect(point.state, row.name).toBe(1);
  // Raster coverage and World intersection remain separate GPU gates. This
  // checks the actual endpoint producer against the independent physical ray.
  const actual = executeCardLightSegment(point.point, light, row.kind, direction, 4, source);
  const output = process.env.FORGEAX_CARD_CONTACT_EVIDENCE;
  if (output)
    writeFileSync(
      `${output}/${row.name}.json`,
      JSON.stringify(
        { row, uploadedLight: light, uploadedGeometry: triangle, expectedMask, actual },
        null,
        2,
      ),
    );
  expect(actual.state, row.name).toBe(2);
  const ray = rayNumbers(actual.world);
  expect(ray.range).toEqual([0, row.kind < 2 ? 4 : 1]);
  for (let axis = 0; axis < 3; axis++) {
    const coordinate = p[axis],
      delta = direction[axis];
    assert(coordinate !== undefined && delta !== undefined);
    expect(ray.originLo[axis]).toBeLessThanOrEqual(coordinate);
    expect(ray.originHi[axis]).toBeGreaterThanOrEqual(coordinate);
    expect(ray.directionLo[axis]).toBeLessThanOrEqual(delta);
    expect(ray.directionHi[axis]).toBeGreaterThanOrEqual(delta);
  }
});

it('keeps endpoint shortening and bias-direction source mutations observable', () => {
  const source = cardShadowSource(),
    point = { axis: [0, 0, 0].map((v) => ({ lo: v, hi: v, valid: 1 })) };
  const original = executeCardLightSegment(point, [1, 0, 1], 2, [1, 0, 1], 4, source);
  expect(rayNumbers(original.world).range).toEqual([0, 1]);
  const shortened = executeCardLightSegment(
    point,
    [1, 0, 1],
    2,
    [1, 0, 1],
    4,
    source.replace('var last=1.0', 'var last=0.75'),
  );
  expect(rayNumbers(shortened.world).range).toEqual([0, 0.75]);
  const direction = executeCardLightSegment(
    point,
    [1, 0, 1],
    2,
    [1, 0, 1],
    4,
    source.replace(
      'sdfIntervalVectorSubtract(endpoint,receiver.point)',
      'sdfIntervalVectorSubtract(endpoint,endpoint)',
    ),
  );
  expect(direction.state).toBe(0);
});

it('distinguishes true empty, nonfinite and nonempty underflow inputs without a NaN sentinel', () => {
  const point = { axis: [0, 0, 0].map((v) => ({ lo: v, hi: v, valid: 1 })) };
  expect(executeCardLightSegment(point, [-0, 0, -0], 2, [0, 0, 1], 4).state).toBe(1);
  for (const light of [
    [1e-40, 0, 0],
    [Number.NaN, 0, 1],
    [Number.POSITIVE_INFINITY, 0, 1],
  ])
    expect(executeCardLightSegment(point, light, 2, [0, 0, 1], 4).state).toBe(0);
});
