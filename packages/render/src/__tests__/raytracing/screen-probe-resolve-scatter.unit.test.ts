import { expect, it } from 'vitest';
import { type ResolveRayInput, resolveRayCells } from './screen-probe-resolve.fixture';

const ray = (cell: number, status = 0, used = true, value = 1): ResolveRayInput => ({
  info: cell | (used ? 512 : 0) | (status << 12),
  direction: [0, 0, 1],
  radiance: [value, value * 2, 0],
  hitDistance: 2,
});
const empty = () => Array.from({ length: 64 }, (_, slot) => ray(slot, 3, false));

it('bounds actual storage-ray selection to one classification and one matched read per used slot', () => {
  const result = resolveRayCells(Array.from({ length: 64 }, (_, slot) => ray(slot)));
  expect(result.output).toHaveLength(64);
  expect(result.output.every((value) => value.age === 1 && value.weighted[0] === 1)).toBe(true);
  // A source-control work bound, not a GPU bandwidth or performance measurement.
  expect(result.loaded.length).toBeLessThanOrEqual(128);
});

it('retains physical order across slots zero, thirty-one, thirty-two and sixty-three', () => {
  const input = empty();
  for (const [i, slot] of [0, 31, 32, 63].entries()) input[slot] = ray(7, 0, true, i + 1);
  const result = resolveRayCells(input);
  expect(result.output[7]?.age).toBe(1);
  expect(result.output[7]?.weighted).toEqual([2.5, 5, 0, 1]);
  expect(result.output[6]?.age).toBe(0);
  expect(result.loaded.slice(64)).toEqual([0, 31, 32, 63]);
});

it('keeps overflow-before-status, incomplete and strict fallback semantics', () => {
  const input = empty();
  for (let slot = 0; slot < 4; slot++) input[slot] = ray(20);
  input[63] = ray(20, 1);
  expect(resolveRayCells(input).output[20]?.age).toBe(-1);
  input[63] = ray(20, 1, false);
  expect(resolveRayCells(input).output[20]?.age).toBe(1);
  const unknown = empty();
  unknown[31] = ray(20, 4);
  expect(resolveRayCells(unknown).output[20]?.age).toBe(-2);
  unknown[32] = ray(20);
  expect(resolveRayCells(unknown).output[20]?.age).toBe(-1);
  unknown[32] = ray(20, 3, false);
  unknown[31] = ray(20, 2);
  expect(resolveRayCells(unknown, true).output[20]?.age).toBe(0);
  const strict = resolveRayCells(unknown, false, [2, 0, 0, 1]).output[20];
  expect((strict?.weighted[0] ?? 0) / (strict?.weighted[3] ?? 0)).toBe(2);
});

it('retains known black and guards inactive or out-of-range workgroups', () => {
  const input = empty();
  input[62] = ray(31, 0, true, 0);
  const black = resolveRayCells(input).output[31];
  expect(black?.age).toBe(1);
  expect(black?.weighted).toEqual([0, 0, 0, 1]);
  const inactive = resolveRayCells(input, true, [0, 0, 0, 0], false);
  expect(inactive.output.every((value) => value.age === 0)).toBe(true);
  expect(inactive.loaded).toHaveLength(0);
  const outside = resolveRayCells(input, true, [0, 0, 0, 0], true, 0);
  expect(outside.output).toHaveLength(0);
  expect(outside.loaded).toHaveLength(0);
});
