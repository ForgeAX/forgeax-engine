// rng.test.ts — seeded generator contract: pinned sfc32 stream, string-seed
// hashing, bounded helpers, and position-independent fork sub-streams.

import { describe, expect, it } from 'vitest';
import { rng } from '../index';

/** Independent BigInt reference of splitmix32 seeding + sfc32 stepping. */
function referenceStream(seed32: number, count: number): number[] {
  const M = 0xffffffffn;
  let s = BigInt(seed32);
  const splitmix = (): bigint => {
    s = (s + 0x9e3779b9n) & M;
    let t = s ^ (s >> 16n);
    t = (t * 0x21f0aaadn) & M;
    t ^= t >> 15n;
    t = (t * 0x735a2d97n) & M;
    return t ^ (t >> 15n);
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = (((a + b) & M) + d) & M;
    d = (d + 1n) & M;
    a = b ^ (b >> 9n);
    b = (c + ((c << 3n) & M)) & M;
    c = ((c << 21n) & M) | (c >> 11n);
    c = (c + t) & M;
    out.push(Number(t) / 2 ** 32);
  }
  return out;
}

describe('rng.create', () => {
  it('matches an independent sfc32 reference and pinned first outputs', () => {
    const r = rng.create(42);
    const first = Array.from({ length: 64 }, () => r.next());
    expect(first).toEqual(referenceStream(42, 64));
    // Pinned uint32 outputs: a change here is a deliberate, reviewed stream break.
    expect(first.slice(0, 3).map((v) => v * 2 ** 32)).toEqual([3730666837, 1786513705, 1450338100]);
    expect(rng.create(42).seed).toBe(42);
    expect(rng.create(0).next()).toBe(referenceStream(0, 1)[0]);
  });

  it('is deterministic across instances and differs across seeds', () => {
    const a = rng.create(7);
    const b = rng.create(7);
    const c = rng.create(8);
    const sa = Array.from({ length: 100 }, () => a.next());
    expect(Array.from({ length: 100 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 100 }, () => c.next())).not.toEqual(sa);
  });

  it('hashes string seeds deterministically and distinctly', () => {
    expect(rng.create('forest').seed).toBe(rng.create('forest').seed);
    expect(rng.create('forest').seed).not.toBe(rng.create('desert').seed);
    expect(rng.create('').seed).not.toBe(rng.create('\u0000').seed);
    // Pinned FNV-1a + fmix32 value; a change here is a deliberate stream break.
    expect(rng.create('forest').seed).toBe(430764192);
  });

  it('reduces number seeds with ToUint32 and degrades non-finite seeds to 0', () => {
    expect(rng.create(-1).seed).toBe(0xffffffff);
    expect(rng.create(2 ** 32 + 5).seed).toBe(5);
    expect(rng.create(3.9).seed).toBe(3);
    expect(rng.create(Number.NaN).seed).toBe(0);
    expect(rng.create(Number.POSITIVE_INFINITY).seed).toBe(0);
  });

  it('keeps next in [0, 1) with a flat distribution', () => {
    const r = rng.create('distribution');
    const bins = new Array<number>(10).fill(0);
    const n = 100_000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = r.next();
      expect(v >= 0 && v < 1).toBe(true);
      sum += v;
      bins[Math.floor(v * 10)] = (bins[Math.floor(v * 10)] as number) + 1;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
    // Chi-square with 9 degrees of freedom; 27.9 is the p = 0.001 critical value.
    const expected = n / 10;
    const chi = bins.reduce((acc, count) => acc + (count - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(27.9);
  });

  it('int covers the inclusive integer interval uniformly', () => {
    const r = rng.create(1234);
    const counts = new Map<number, number>();
    for (let i = 0; i < 60_000; i++) {
      const v = r.int(1, 6);
      expect(Number.isInteger(v)).toBe(true);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const count of counts.values()) expect(Math.abs(count - 10_000)).toBeLessThan(500);
    expect(r.int(5, 5)).toBe(5);
    expect(r.int(9, 2)).toBe(9);
  });

  it('range stays in [min, max) and pick returns members or undefined', () => {
    const r = rng.create(99);
    for (let i = 0; i < 1000; i++) {
      const v = r.range(-2, 3);
      expect(v >= -2 && v < 3).toBe(true);
    }
    const items = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const v = r.pick(items);
      expect(items).toContain(v);
      if (v !== undefined) seen.add(v);
    }
    expect(seen.size).toBe(3);
    expect(r.pick([])).toBeUndefined();
  });

  it('fork yields labelled sub-streams independent of parent draw position', () => {
    const parent = rng.create('world-1');
    const trees = parent.fork('trees');
    const treeStream = Array.from({ length: 32 }, () => trees.next());
    for (let i = 0; i < 17; i++) parent.next();
    const again = parent.fork('trees');
    expect(Array.from({ length: 32 }, () => again.next())).toEqual(treeStream);

    const rocks = rng.create('world-1').fork('rocks');
    const rockStream = Array.from({ length: 32 }, () => rocks.next());
    expect(rockStream).not.toEqual(treeStream);
    expect(rng.create('world-2').fork('trees').seed).not.toBe(trees.seed);
    expect(parent.fork('a').fork('b').seed).not.toBe(parent.fork('ab').seed);

    // Forking does not perturb the parent stream.
    const plain = rng.create(5);
    const forked = rng.create(5);
    forked.fork('x');
    expect(forked.next()).toBe(plain.next());

    // Weak cross-correlation between sibling streams.
    const xs = rng.create(1).fork('x');
    const ys = rng.create(1).fork('y');
    let sxy = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sxy += (xs.next() - 0.5) * (ys.next() - 0.5);
    expect(Math.abs(sxy / n / (1 / 12))).toBeLessThan(0.05);
  });
});
