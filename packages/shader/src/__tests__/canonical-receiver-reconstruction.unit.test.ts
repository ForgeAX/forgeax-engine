import { expect, it } from 'vitest';
import {
  CANONICAL_RECEIVER_REASON,
  CANONICAL_RECEIVER_RECONSTRUCTION_WGSL,
  CANONICAL_RECEIVER_STATE,
} from '../canonical-receiver-reconstruction-wgsl';
import {
  capturedReceiverCases,
  exactReceiverPoint,
  executeReceiver,
  type ReceiverCase,
  receiverCases,
  receiverContains,
  receiverIdentity,
  receiverTriangleSpans,
  receiverWideEdgeCase,
} from './canonical-receiver-reconstruction.fixture';

it('locates independent exact primary intersections without using depth or camera inverse', () => {
  const expected = [
    [0, 0, 0.5],
    [0, 0, 0.5],
    [0, 0, 2],
    [-0.25, 0.125, 2],
    [0.4, 0, 0.5],
  ];
  for (const [index, row] of receiverCases.entries()) {
    const point = exactReceiverPoint(row);
    expect(
      point.map((value) => Number(value.n) / Number(value.d)),
      row.name,
    ).toEqual(expected[index]);
  }
});

it('produces canonical strict-interior enclosures through the actual source composition', () => {
  for (const row of receiverCases) {
    const result = executeReceiver(row);
    expect(result.state, row.name).toBe(CANONICAL_RECEIVER_STATE.canonicalEnclosure);
    expect(receiverContains(result.point.axis, exactReceiverPoint(row)), row.name).toBe(true);
    expect(result.reason).toBe(CANONICAL_RECEIVER_REASON.none);
    expect(result.rasterQualified).toBe(0);
    expect(result.barycentric.every((value) => value.valid === 1 && value.lo > 0)).toBe(true);
  }
});

function unavailableCases(): ReceiverCase[] {
  const base = receiverCases[0];
  if (!base) throw Error('Explicit canonical baseline required');
  return [
    { ...base, name: 'outside pixel', pixel: [1, 0] },
    { ...base, name: 'zero extent', extent: [0, 1] },
    { ...base, name: 'sample outside', sampleOffset: [1, 0.5] },
    {
      ...base,
      name: 'nonfinite vertex',
      vertices: [
        [NaN, -1, 0.5],
        [1, -1, 0.5],
        [0, 1, 0.5],
      ],
    },
    {
      ...base,
      name: 'subnormal source',
      vertices: [
        [2 ** -149, -1, 0.5],
        [1, -1, 0.5],
        [0, 1, 0.5],
      ],
    },
    {
      ...base,
      name: 'invalid affine forward',
      forward: receiverIdentity.map((v, i) => (i === 3 ? 1 : v)),
    },
    {
      ...base,
      name: 'zero determinant',
      vertices: [
        [-1, 0, 0.5],
        [0, 0, 0.5],
        [1, 0, 0.5],
      ],
    },
    {
      ...base,
      name: 'shared edge',
      vertices: [
        [-1, -1, 0.5],
        [1, -1, 0.5],
        [1, 1, 0.5],
      ],
    },
    { ...base, name: 'outside triangle', pixel: [0, 0], sampleOffset: [0, 0.5] },
    {
      ...base,
      name: 'zero homogeneous w',
      viewProjection: receiverIdentity.map((v, i) => (i === 15 ? 0 : v)),
    },
    {
      ...base,
      name: 'negative homogeneous w',
      viewProjection: receiverIdentity.map((v, i) => (i === 15 ? -1 : v)),
    },
    {
      ...base,
      name: 'camera plane crosses w0',
      viewProjection: receiverIdentity.map((v, i) => (i === 3 ? 1 : i === 15 ? 0 : v)),
    },
    {
      ...base,
      name: 'outside clip depth',
      vertices: [
        [-1, -1, 2],
        [1, -1, 2],
        [0, 1, 2],
      ],
    },
    {
      ...base,
      name: 'overflow transform',
      forward: receiverIdentity.map((v, i) => (i === 0 ? 3e38 : v)),
      vertices: [
        [-3e38, -1, 0.5],
        [3e38, -1, 0.5],
        [0, 1, 0.5],
      ],
    },
  ];
}

it('keeps unsupported, projectively ambiguous, edge and clip cases closed unavailable', () => {
  for (const row of unavailableCases()) {
    const result = executeReceiver(row);
    expect(result.state, row.name).toBe(CANONICAL_RECEIVER_STATE.unavailable);
    expect(Object.values(CANONICAL_RECEIVER_REASON)).toContain(result.reason);
    expect(result.reason, row.name).toBeGreaterThan(0);
    expect(result.rasterQualified).toBe(0);
  }
});

it('does not certify raster/contact even when the canonical enclosure is available', () => {
  const row = receiverCases[0];
  if (!row) throw Error('Explicit canonical input required');
  expect(executeReceiver(row).rasterQualified).toBe(0);
  const result = executeReceiver(row, CANONICAL_RECEIVER_RECONSTRUCTION_WGSL, {
    sdfIntervalMultiply: () => ({ lo: 0, hi: 0, valid: 0 }),
  });
  expect(result.state).toBe(0);
  expect(result.rasterQualified).toBe(0);
});

it('detects omitted homogeneous division, edge admission and manufactured raster qualification', () => {
  const source = CANONICAL_RECEIVER_RECONSTRUCTION_WGSL;
  if (!source.includes('out.state=1u;')) return;
  const perspective = receiverCases[3];
  if (!perspective) throw Error('Jittered primary reference required');
  const changed = source.replace('let u=sdfIntervalDivide(uNumerator,det);', 'let u=uNumerator;');
  expect(changed).not.toBe(source);
  const altered = executeReceiver(perspective, changed);
  expect(
    altered.state !== 1 || !receiverContains(altered.point.axis, exactReceiverPoint(perspective)),
  ).toBe(true);
  const edge = unavailableCases().find((row) => row.name === 'shared edge');
  if (!edge) throw Error('Edge control required');
  const permissive = source.replace(
    'u.lo<=0 || v.lo<=0 || sum.hi>=1',
    'u.lo<0 || v.lo<0 || sum.hi>1',
  );
  expect(permissive).not.toBe(source);
  expect(executeReceiver(edge, permissive).state).toBe(1);
  const fabricated = source.replace('out.rasterQualified=0u;', 'out.rasterQualified=1u;');
  expect(fabricated).not.toBe(source);
  expect(executeReceiver(perspective, fabricated).rasterQualified).toBe(1);
});

it.each(
  capturedReceiverCases,
)('keeps captured receiver $name inside a geometry-relative enclosure', (row) => {
  const result = executeReceiver(row);
  expect(result.state).toBe(CANONICAL_RECEIVER_STATE.canonicalEnclosure);
  expect(receiverContains(result.point.axis, exactReceiverPoint(row))).toBe(true);
  expect(result.rasterQualified).toBe(0);
  const spans = receiverTriangleSpans(row);
  for (const [axis, interval] of result.point.axis.entries()) {
    const span = spans[axis];
    if (span === undefined || !(span > 0)) throw Error('Captured nonzero triangle extent required');
    // Precision regression target: at most 1/64 of the actual axis extent.
    // This is not a production epsilon or universal reconstruction guarantee.
    expect(interval.hi - interval.lo, `${row.name} axis${axis}`).toBeLessThanOrEqual(span / 64);
  }
});

it('retains the ideal-model fallback when an anchored world edge overflows f32', () => {
  const result = executeReceiver(receiverWideEdgeCase);
  expect(result.state).toBe(CANONICAL_RECEIVER_STATE.canonicalEnclosure);
  expect(receiverContains(result.point.axis, exactReceiverPoint(receiverWideEdgeCase))).toBe(true);
  expect(result.rasterQualified).toBe(0);
  const source = CANONICAL_RECEIVER_RECONSTRUCTION_WGSL;
  const noFallback = source.replace(
    'if(position.valid!=0u && anchored.valid!=0u && anchored.lo>=position.lo && anchored.hi<=position.hi){position=anchored;}',
    'position=anchored;',
  );
  expect(noFallback).not.toBe(source);
  expect(executeReceiver(receiverWideEdgeCase, noFallback).state).toBe(0);
});

it('contains the independent exact point after a large camera-matched world translation', () => {
  const base = receiverCases[0];
  if (!base) throw Error('Orthographic receiver required');
  const row: ReceiverCase = {
    ...base,
    name: 'translated-camera-matched',
    forward: receiverIdentity.map((value, index) =>
      index === 12 ? 1024 : index === 13 ? -512 : value,
    ),
    viewProjection: receiverIdentity.map((value, index) =>
      index === 12 ? -1024 : index === 13 ? 512 : value,
    ),
  };
  const result = executeReceiver(row);
  const exact = exactReceiverPoint(row);
  expect(exact.map((value) => Number(value.n) / Number(value.d))).toEqual([1024, -512, 0.5]);
  expect(result.state).toBe(1);
  expect(receiverContains(result.point.axis, exact)).toBe(true);
  expect(result.rasterQualified).toBe(0);
});
