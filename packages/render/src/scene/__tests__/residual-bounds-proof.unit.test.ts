import { box3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { MeshFrame } from '../mesh-frame';
import { ResidualBoundsProof } from '../residual-bounds-proof';

function planes(center = 0, half = 1): Float32Array {
  return new Float32Array([
    1,
    0,
    0,
    half - center,
    -1,
    0,
    0,
    half + center,
    0,
    1,
    0,
    half,
    0,
    -1,
    0,
    half,
    0,
    0,
    1,
    half,
    0,
    0,
    -1,
    half,
  ]);
}
const source = receiptRow().source;
const meshes = new MeshFrame();

it('includes exact plane boundaries and rejects a box just beyond them', () => {
  const proof = new ResidualBoundsProof();
  proof.record(source, meshes, box3.create(-1, -1, -1, 1, 1, 1));
  expect(proof.enclosed([planes()])).toBe(true);
  const changed = new ResidualBoundsProof(proof);
  changed.record(source, meshes, box3.create(0, 0, 0, 1.0000001192092896, 0, 0));
  expect(changed.enclosed([planes()])).toBe(false);
  expect(proof.enclosed([planes()])).toBe(true);
});

it('requires one complete camera proof when several cameras split the extent', () => {
  const proof = new ResidualBoundsProof();
  proof.record(source, meshes, box3.create(-3, -1, -1, 3, 1, 1));
  expect(proof.enclosed([planes(-2, 2), planes(2, 2)])).toBe(false);
  expect(proof.enclosed([planes(0, 4)])).toBe(true);
});

it.each([
  Number.NaN,
  Infinity,
  -Infinity,
])('refuses an invalid numeric bound %s until a complete rebuild', (value) => {
  const proof = new ResidualBoundsProof();
  proof.record(source, meshes, box3.create(value, 0, 0, 1, 1, 1));
  proof.record(source, meshes, box3.create(0, 0, 0, 1, 1, 1));
  expect(proof.enclosed([planes()])).toBe(false);
  expect(proof.enclosed([])).toBe(true);
  expect(proof.enclosed([new Float32Array()])).toBe(true);
});

it('keeps unknown bounds visible and refuses invalid planes for bounded rows', () => {
  const proof = new ResidualBoundsProof();
  proof.record(source, meshes);
  expect(proof.enclosed([planes()])).toBe(true);
  proof.record(source, meshes, box3.create(-1, -1, -1, 1, 1, 1));
  const invalid = planes();
  invalid[0] = Number.NaN;
  expect(proof.enclosed([invalid])).toBe(false);
});
