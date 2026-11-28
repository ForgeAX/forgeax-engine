import { describe, expect, it } from 'vitest';
import { type MatchEdge, minCostPerfectMatching } from '../matching';

/** Brute-force minimum perfect matching cost (oracle, small n only). */
function bruteMin(n: number, edges: readonly MatchEdge[]): number | undefined {
  const cost = new Map<string, number>();
  for (const e of edges) {
    const k = e.a < e.b ? `${e.a},${e.b}` : `${e.b},${e.a}`;
    const prev = cost.get(k);
    if (prev === undefined || e.cost < prev) cost.set(k, e.cost);
  }
  const rec = (free: number): number | undefined => {
    if (free === 0) return 0;
    let v = 0;
    while ((free & (1 << v)) === 0) v++;
    let best: number | undefined;
    for (let u = v + 1; u < n; u++) {
      if ((free & (1 << u)) === 0) continue;
      const c = cost.get(`${v},${u}`);
      if (c === undefined) continue;
      const rest = rec(free & ~(1 << v) & ~(1 << u));
      if (rest === undefined) continue;
      const total = c + rest;
      if (best === undefined || total < best) best = total;
    }
    return best;
  };
  return rec((1 << n) - 1);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('minCostPerfectMatching', () => {
  it('matches the brute-force minimum on random general graphs', () => {
    const next = lcg(3);
    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 * (1 + Math.floor(next() * 4)); // 2, 4, 6, 8
      const edges: MatchEdge[] = [];
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          if (next() < 0.7) edges.push({ a, b, cost: Math.round(next() * 100) / 10 });
        }
      }
      const oracle = bruteMin(n, edges);
      const got = minCostPerfectMatching(n, edges);
      if (oracle === undefined) {
        expect(got.ok).toBe(false);
        continue;
      }
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.total).toBeCloseTo(oracle, 9);
      // The returned mate is a perfect matching on real edges.
      for (let v = 0; v < n; v++) expect(got.mate[got.mate[v] as number]).toBe(v);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('prefers the cheaper pairing where greedy would take the cheapest single edge', () => {
    // Greedy takes (1,2) at cost 1 and is forced into (0,3) at cost 100; the optimum is (0,1)+(2,3).
    const edges: MatchEdge[] = [
      { a: 1, b: 2, cost: 1 },
      { a: 0, b: 1, cost: 10 },
      { a: 2, b: 3, cost: 10 },
      { a: 0, b: 3, cost: 100 },
    ];
    const got = minCostPerfectMatching(4, edges);
    expect(got).toMatchObject({ ok: true, total: 20 });
  });

  it('fails closed without a perfect matching', () => {
    const got = minCostPerfectMatching(4, [{ a: 0, b: 1, cost: 1 }]);
    expect(got).toMatchObject({ ok: false, reason: 'no-perfect-matching' });
  });

  it('rejects self loops and out-of-range edges', () => {
    expect(minCostPerfectMatching(2, [{ a: 0, b: 0, cost: 1 }])).toMatchObject({
      ok: false,
      reason: 'bad-edge',
    });
    expect(minCostPerfectMatching(2, [{ a: 0, b: 5, cost: 1 }])).toMatchObject({
      ok: false,
      reason: 'bad-edge',
    });
  });
});
