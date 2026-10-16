import assert from 'node:assert/strict';
import { test } from 'vitest';
import { inspectCardSupport } from '../raytracing/gltf/card-support.mjs';

// A tilted shading normal must not replace the geometric-normal eligibility test.
const fixture = () => ({
  projection: [-1, -1, 1, 0, 1, 0, 0, 2, 0, 1, 0, 2, 0, 0, 1, 2],
  position: [0, 0, 0],
  hitNormal: [0, 0, 1],
  allowance: 0,
  resolution: 2,
  width: 4,
  card: 0,
  texels: [0, 1, 4, 5],
  weights: [0.25, 0.25, 0.25, 0.25],
  readNormal: () => [0.5, 0, 0, 0],
  readDepth: () => 0.5,
  outputNormalDepth: [Math.SQRT1_2, 0, Math.SQRT1_2, 0.5],
});

test('accepts qualified taps and reconstructs shading normal independently', () => {
  const result = inspectCardSupport(fixture());
  assert.equal(result.borderline, false);
  assert.equal(result.taps.length, 4);
  assert(result.taps.every((tap) => tap.depthError === 0 && tap.geometricAlignment === 1));
  assert(result.reconstructionError < 1e-12);
  assert.deepEqual(result.samplePosition, [0, 0, 0]);
  assert.deepEqual(
    result.taps.map((tap) => tap.samplePosition),
    [
      [-0.5, -0.5, 0],
      [0.5, -0.5, 0],
      [-0.5, 0.5, 0],
      [0.5, 0.5, 0],
    ],
  );
});

test('reconstructs translated oblique Card samples from a nonzero atlas tile', () => {
  const c = Math.SQRT1_2;
  const result = inspectCardSupport({
    ...fixture(),
    projection: [10, 20, 30, 0, c, c, 0, 2, 0, 0, 1, 4, c, -c, 0, 6],
    position: [10 - 0.5 * c, 20 + 2.5 * c, 32],
    hitNormal: [c, -c, 0],
    card: 3,
    texels: [10, 11, 14, 15],
    weights: [0.1, 0.2, 0.3, 0.4],
    readNormal: () => [0.5, -0.5, 0.5, -0.5],
    readDepth: () => 0.25,
    outputNormalDepth: [c, -c, 0, 0.25],
  });
  const expected = [10 - 0.4 * c, 20 + 2.6 * c, 32.4];
  for (const [axis, value] of expected.entries())
    assert(Math.abs(result.samplePosition[axis] - value) < 1e-12);
  // Atlas placement and Card-space normal/depth sign must not become world axes.
  assert(Math.abs(result.taps[0].samplePosition[0] - (10 - c)) < 1e-12);
  assert(Math.abs(result.taps[0].samplePosition[1] - (20 + 2 * c)) < 1e-12);
  assert.equal(result.taps[0].samplePosition[2], 31);
});

for (const [name, change, failure] of [
  ['opposite geometric normal', { readNormal: () => [0.5, 0, 1, 1] }, /geometric normal/],
  ['different surface depth', { readDepth: () => 0 }, /Card depth rejects/],
  ['wrong reconstructed shading normal', { outputNormalDepth: [0, 0, 1, 0.5] }, /reconstruction/],
  [
    'wrong reconstructed depth',
    { outputNormalDepth: [Math.SQRT1_2, 0, Math.SQRT1_2, 0.25] },
    /reconstruction/,
  ],
  ['neighboring tile', { texels: [2, 3, 6, 7] }, /bilinear neighborhood/],
  ['nonfinite atlas', { readDepth: () => NaN }, /nonfinite/],
  ['outside silhouette', { position: [2, 0, 0] }, /silhouette/],
])
  test(`rejects ${name}`, () => {
    assert.throws(() => inspectCardSupport({ ...fixture(), ...change }), failure);
  });
