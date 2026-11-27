import { expect, it } from 'vitest';
import {
  assessCorrelatedTriangle,
  correlatedTriangleCases,
  correlatedTriangleInput,
  correlatedTriangleOracle,
} from './sdf-surface-correlated-triangle.fixture';

it('proves the actual uncertain ray strictly inside over its full local origin and direction box', () => {
  for (const row of correlatedTriangleCases.slice(0, 2)) {
    const result = correlatedTriangleOracle(row);
    expect(result.universalHit).toBe(true);
    expect(result.corners.every((corner) => corner.u > 0n && corner.v > 0n && corner.w > 0n)).toBe(
      true,
    );
  }
  // The actual old GPU result remains a failing required-hit observation, not a CPU GPU simulation.
  expect(assessCorrelatedTriangle(0, new Uint32Array([2, 0, 0, 1]))).toEqual([
    'required universal interior hit absent',
  ]);
});

it('retains genuine edge, endpoint, parallel and disabled negative controls', () => {
  for (const [index, row] of correlatedTriangleCases.entries()) {
    expect(correlatedTriangleOracle(row).universalHit, row.name).toBe(row.requiredHit);
    if (!row.requiredHit)
      expect(assessCorrelatedTriangle(index, new Uint32Array([1, 0, 0, 1]))).toContain(
        'false universal primitive hit',
      );
  }
  expect(correlatedTriangleInput().byteLength).toBe(correlatedTriangleCases.length * 128);
});

it('independently proves the correlated triangle-outside and segment-outside controls clear', () => {
  const outside = correlatedTriangleCases.find((row) => row.name === 'correlated-outside-W');
  const endpoint = correlatedTriangleCases.find((row) => row.name === 'correlated-beyond-endpoint');
  if (!outside || !endpoint) throw new Error('Both separating controls required');
  expect(correlatedTriangleOracle(outside).corners.every((corner) => corner.w < 0n)).toBe(true);
  expect(correlatedTriangleOracle(endpoint).corners.every((corner) => corner.afterRange)).toBe(
    true,
  );
});
it('rejects clear mutations with a real hit witness even when every box corner misses', () => {
  for (const name of ['edge-crossing', 'center-only-witness']) {
    const index = correlatedTriangleCases.findIndex((row) => row.name === name);
    expect(assessCorrelatedTriangle(index, new Uint32Array([0, 0, 0, 1]))).toContain(
      'false universal primitive clear',
    );
  }
  const centerCase = correlatedTriangleCases.find((row) => row.name === 'center-only-witness');
  if (!centerCase) throw new Error('Center witness required');
  const oracle = correlatedTriangleOracle(centerCase);
  expect(oracle.corners.every((point) => !point.hit)).toBe(true);
  expect(oracle.center.hit).toBe(true);
  expect(assessCorrelatedTriangle(0, new Uint32Array([3, 0, 0, 1]))).toContain(
    'invalid primitive result state',
  );
});
