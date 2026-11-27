import { expect, it } from 'vitest';
import {
  assessClosedBoundary,
  closedBoundaryCases,
  closedBoundaryInput,
} from './sdf-surface-closed-boundary.fixture';

it('keeps all three edges and vertices across winding and authored scale domains', () => {
  const cases = closedBoundaryCases();
  expect(cases.filter((row) => row.name.includes('/')).length).toBe(36);
  expect(cases.filter((row) => row.required === 'hit').length).toBe(39);
  expect(new Set(cases.map((row) => row.name)).size).toBe(cases.length);
  expect(closedBoundaryInput().length).toBe(cases.length * 128);
});

it('rejects an invented universal hit for an interval crossing a geometric edge', () => {
  const cases = closedBoundaryCases();
  const i = cases.findIndex((row) => row.name === 'cross-AB');
  const raw = new Uint32Array(cases.length * 4);
  raw.set([1, 0, 0x40800000, 1], i * 4);
  expect(assessClosedBoundary(raw).rows[i]?.failures).toContain('false universal primitive hit');
});

it('does not mistake an interval overlap with the range for a universal in-range hit', () => {
  const cases = closedBoundaryCases();
  const i = cases.findIndex((row) => row.name === 'time-overlap');
  const raw = new Uint32Array(cases.length * 4);
  raw.set([1, 0x3f800000, 0x40000000, 1], i * 4);
  expect(assessClosedBoundary(raw).rows[i]?.failures).toContain('false universal primitive hit');
});
