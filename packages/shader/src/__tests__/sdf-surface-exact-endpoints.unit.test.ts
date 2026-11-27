import { expect, it } from 'vitest';
import { exactEndpointCases } from './sdf-surface-exact-endpoints.data';
import {
  assessExactEndpoints,
  exactEndpointDyadic,
  exactEndpointFraction,
  exactEndpointInput,
} from './sdf-surface-exact-endpoints.fixture';

it('checks every authored point with independent complete dyadic fractions', () => {
  for (const row of exactEndpointCases) {
    if (row.expected !== 'point') continue;
    const [numerator, denominator] = exactEndpointFraction(row);
    expect(exactEndpointDyadic(row.point) * denominator).toBe(numerator * (1n << 149n));
  }
  expect(exactEndpointInput().byteLength).toBe(exactEndpointCases.length * 16);
});

it('distinguishes a power-of-two numerator from a power-of-two denominator', () => {
  const row = exactEndpointCases.find(
    (entry) => entry.name === 'divide-numerator-unit-not-sufficient',
  );
  expect(row).toBeDefined();
  if (!row) return;
  const [numerator, denominator] = exactEndpointFraction(row);
  expect(exactEndpointDyadic(0x3eaaaaab) * denominator).not.toBe(numerator * (1n << 149n));
});

it('rejects a fabricated point that discards the nonzero low sum bit', () => {
  const raw = new Uint32Array(exactEndpointCases.length * 4),
    at = exactEndpointCases.findIndex((row) => row.name === 'sum-delta-seven-dropped-bit');
  raw.set([1, 0x3f810000, 0x3f810000, 0], at * 4);
  const assessment = assessExactEndpoints(raw).rows[at];
  expect(assessment?.failures).toContain('exact real result outside interval');
  expect(assessment?.failures).toContain('required outward fallback absent');
});

it('covers the aligned unsigned carry beyond the signed magnitude range', () => {
  const raw = new Uint32Array(exactEndpointCases.length * 4),
    at = exactEndpointCases.findIndex((row) => row.name === 'sum-aligned-unsigned-carry');
  expect((0xffffffn << 7n) + 0x800080n).toBe(0x80800000n);
  expect(0x80800000n).toBeGreaterThan(0x7fffffffn);
  raw.set([1, 0x3fff0000, 0x3fff0000, 0], at * 4);
  expect(assessExactEndpoints(raw).rows[at]?.failures).toContain(
    'exact real result outside interval',
  );
  expect(new Set(exactEndpointCases.map((row) => row.name)).size).toBe(exactEndpointCases.length);
});

it('proves the shared-edge sum and its sign symmetry with complete BigInt dyadics', () => {
  const shared = exactEndpointCases.find((row) => row.name === 'sum-native-shared-edge-dyadics');
  const mirrored = exactEndpointCases.find(
    (row) => row.name === 'sum-native-shared-edge-negative-symmetry',
  );
  expect(shared).toBeDefined();
  expect(mirrored).toBeDefined();
  if (!shared || !mirrored) return;
  const [p, pd] = exactEndpointFraction(shared);
  const [n, nd] = exactEndpointFraction(mirrored);
  expect(exactEndpointDyadic(0x37800000) * 65536n).toBe(1n << 149n);
  expect(exactEndpointDyadic(0x3d800000) * 16n).toBe(1n << 149n);
  expect(p * 65536n).toBe(-4095n * pd);
  expect(n * pd).toBe(-p * nd);
});

it('keeps adjacent nonrepresentable wide sums between consecutive canonical points', () => {
  for (const [name, lo, hi] of [
    ['sum-delta-twenty-four-fallback', 0x3f800000, 0x3f800001],
    ['sum-wide-shift-thirty-two-fallback', 0x3f800000, 0x3f800001],
    ['sum-wide-alignment-capacity-fallback', 0x3f800001, 0x3f800002],
    ['sum-wide-unsigned-overflow-fallback', 0x40007fff, 0x40008000],
  ] as const) {
    const row = exactEndpointCases.find((entry) => entry.name === name);
    expect(row).toBeDefined();
    if (!row) continue;
    const [numerator, denominator] = exactEndpointFraction(row);
    expect(hi - lo).toBe(1);
    expect(exactEndpointDyadic(lo) * denominator).toBeLessThan(numerator * (1n << 149n));
    expect(exactEndpointDyadic(hi) * denominator).toBeGreaterThan(numerator * (1n << 149n));
  }
});
