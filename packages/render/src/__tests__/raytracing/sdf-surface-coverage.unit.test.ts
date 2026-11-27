import { expect, it } from 'vitest';
import {
  sameSdfSurfaceCoverage,
  sdfSurfaceCoveragePattern,
  snapshotSdfSurfaceCoverage,
} from '../../raytracing/sdf-surface-coverage';

it('represents complete coverage constants without allocating a placement bitmap', () => {
  for (const count of [1, 31, 32, 33, 262267, 1048576]) {
    expect(sdfSurfaceCoveragePattern('opaque', count).unwrap()).toEqual({
      mode: 0,
      bits: undefined,
    });
    expect(sdfSurfaceCoveragePattern('unavailable', count).unwrap()).toEqual({
      mode: 1,
      bits: undefined,
    });
  }
  expect(
    sdfSurfaceCoveragePattern(
      { kind: 'partial', opaquePrimitives: new Uint32Array([3]) },
      2,
    ).unwrap(),
  ).toEqual({ mode: 0, bits: undefined });
  expect(
    sdfSurfaceCoveragePattern(
      { kind: 'partial', opaquePrimitives: new Uint32Array([0]) },
      2,
    ).unwrap(),
  ).toEqual({ mode: 1, bits: undefined });
});

it('keeps partial canonical bits and rejects absent, oversized and nonzero padding words', () => {
  const bits = new Uint32Array([1]);
  expect(
    sdfSurfaceCoveragePattern({ kind: 'partial', opaquePrimitives: bits }, 2).unwrap(),
  ).toEqual({
    mode: 2,
    bits,
  });
  for (const invalid of [new Uint32Array(), new Uint32Array([1, 0]), new Uint32Array([5])])
    expect(sdfSurfaceCoveragePattern({ kind: 'partial', opaquePrimitives: invalid }, 2).ok).toBe(
      false,
    );
  for (const count of [0, 1.5, 1048577])
    expect(sdfSurfaceCoveragePattern('opaque', count).ok).toBe(false);
});

it('compares only accepted coverage rather than material root values or array identity', () => {
  const partial = { kind: 'partial' as const, opaquePrimitives: new Uint32Array([0xfc0]) };
  expect(
    sameSdfSurfaceCoverage(partial, {
      ...partial,
      opaquePrimitives: partial.opaquePrimitives.slice(),
    }),
  ).toBe(true);
  expect(
    sameSdfSurfaceCoverage(partial, { ...partial, opaquePrimitives: new Uint32Array([0x3f]) }),
  ).toBe(false);
  expect(sameSdfSurfaceCoverage('opaque', partial)).toBe(false);
  expect(sameSdfSurfaceCoverage(undefined, 'opaque')).toBe(true);
});

it('owns accepted coverage against caller mutation while sharing copies only inside that owner', () => {
  const source = { kind: 'partial' as const, opaquePrimitives: new Uint32Array([1]) };
  const copies = new WeakMap<Uint32Array, Uint32Array>();
  const left = snapshotSdfSurfaceCoverage(source, copies);
  const right = snapshotSdfSurfaceCoverage(source, copies);
  const otherOwner = snapshotSdfSurfaceCoverage(source, new WeakMap());
  if (typeof left === 'string' || typeof right === 'string' || typeof otherOwner === 'string')
    throw Error('Partial snapshots are required');
  expect(left.opaquePrimitives).toBe(right.opaquePrimitives);
  expect(left.opaquePrimitives).not.toBe(source.opaquePrimitives);
  expect(left.opaquePrimitives).not.toBe(otherOwner.opaquePrimitives);
  source.opaquePrimitives[0] = 2;
  expect(left.opaquePrimitives[0]).toBe(1);
  expect(sameSdfSurfaceCoverage(left, source)).toBe(false);
});
