import { describe, expect, it } from 'vitest';
import { tsBackend } from '../compute/boolean-ts';
import { TriangleBvh } from '../compute/bvh';
import { computeCacheKey, runComputeJob, WorkMeter } from '../compute/job';
import { solveSparse, TripletList } from '../compute/sparse';

const meter = () => new WorkMeter(1e9);
const diagonal = (n: number, v = 2) => {
  const t = new TripletList(n, n);
  for (let i = 0; i < n; i++) t.add(i, i, v);
  return t.toCsr();
};

describe('sparse solver rejects non-finite input (R-M9)', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const method of ['cg', 'pcg-jacobi', 'cgls'] as const) {
    for (const v of bad) {
      it(`${method}: rhs ${v}`, () => {
        const r = solveSparse(diagonal(3), new Float64Array([v, 1, 1]), { method }, meter());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
      });
      it(`${method}: matrix value ${v}`, () => {
        const t = new TripletList(2, 2);
        t.add(0, 0, v);
        t.add(1, 1, 1);
        const r = solveSparse(t.toCsr(), new Float64Array([1, 1]), { method }, meter());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
      });
      it(`${method}: initial guess ${v}`, () => {
        const r = solveSparse(
          diagonal(2),
          new Float64Array([1, 1]),
          { method },
          meter(),
          new Float64Array([v, 0]),
        );
        expect(r.ok).toBe(false);
      });
    }
  }

  it('still solves a finite system', () => {
    const r = solveSparse(diagonal(3), new Float64Array([2, 4, 6]), { method: 'cg' }, meter());
    expect(r.ok && Array.from(r.value.x)).toEqual([1, 2, 3]);
  });
});

describe('cache keys separate what JSON conflates (R-M10)', () => {
  const key = (params: unknown) =>
    computeCacheKey({ kind: 'solve.sparse', params, inputs: [] } as never, 'id');
  const distinct: [string, unknown, unknown][] = [
    ['0 / -0', { a: 0 }, { a: -0 }],
    ['NaN / null', { a: Number.NaN }, { a: null }],
    ['Infinity / null', { a: Number.POSITIVE_INFINITY }, { a: null }],
    ['Infinity / -Infinity', { a: Number.POSITIVE_INFINITY }, { a: Number.NEGATIVE_INFINITY }],
    ['NaN / "NaN"', { a: Number.NaN }, { a: 'NaN' }],
    ['Map / Set', { a: new Map([[1, 2]]) }, { a: new Set([1]) }],
    ['Float32Array / {}', { a: new Float32Array([1, 2]) }, { a: {} }],
    ['Date / string', { a: new Date(0) }, { a: '1970-01-01T00:00:00.000Z' }],
    ['[undefined] / [null]', { a: [undefined] }, { a: [null] }],
  ];
  for (const [name, a, b] of distinct) {
    it(`${name} get distinct keys`, () => expect(key(a)).not.toBe(key(b)));
  }

  it('keeps the key of plain params stable and order independent', () => {
    expect(key({ a: 1, b: [1.5, 'x', null, true] })).toBe(key({ b: [1.5, 'x', null, true], a: 1 }));
    expect(key({ a: 1, b: undefined })).toBe(key({ a: 1 }));
  });

  it('does not throw on bigint or cyclic params', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => key({ a: 1n })).not.toThrow();
    expect(() => key(cyc)).not.toThrow();
  });

  it('runComputeJob rejects params outside plain JSON with a Result', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    for (const params of [{ a: 1n }, cyc, { a: new Map() }, { a: new Float32Array(1) }]) {
      const r = runComputeJob({ kind: 'solve.sparse', params, inputs: [] } as never, tsBackend);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('model-invalid-argument');
        expect(r.error.expected).toContain('plain JSON');
      }
    }
  });
});

describe('BVH validates input (R-M11)', () => {
  const tri = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

  it('rejects an out-of-range index and a non-finite vertex at build', () => {
    expect(() => new TriangleBvh(tri, new Uint32Array([0, 1, 7]))).toThrow(RangeError);
    const nan = new Float64Array([0, 0, 0, 1, 0, 0, Number.NaN, 1, 0]);
    expect(() => new TriangleBvh(nan, new Uint32Array([0, 1, 2]))).toThrow(RangeError);
  });

  it('never reports a NaN distance for a non-finite query', () => {
    const bvh = new TriangleBvh(tri, new Uint32Array([0, 1, 2]));
    expect(bvh.nearest([Number.NaN, 0, 0])).toBeUndefined();
    expect(bvh.nearest([0, Number.POSITIVE_INFINITY, 0])).toBeUndefined();
  });

  it('hits a surface from a ray whose origin lies on it', () => {
    const bvh = new TriangleBvh(tri, new Uint32Array([0, 1, 2]));
    const up = bvh.raycast([0.2, 0.2, 0], [0, 0, 1], 10);
    const down = bvh.raycast([0.2, 0.2, 0], [0, 0, -1], 10);
    expect(up?.t).toBe(0);
    expect(down?.t).toBe(0);
  });

  it('still returns the far surface for a ray from above', () => {
    const bvh = new TriangleBvh(tri, new Uint32Array([0, 1, 2]));
    expect(bvh.raycast([0.2, 0.2, 1], [0, 0, -1], 10)?.t).toBeCloseTo(1, 12);
    expect(bvh.raycast([0.2, 0.2, 1], [0, 0, 1], 10)).toBeUndefined();
  });
});
