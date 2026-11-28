import { describe, expect, it } from 'vitest';
import { type FlowProblem, minCostFlow } from '../min-cost-flow';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Exhaustive search over every flow vector within capacity; returns best [shipped-feasible cost]. */
function brute(p: FlowProblem): { feasible: boolean; cost: number } {
  const m = p.from.length;
  const balance = Array.from(p.supply as ArrayLike<number>);
  let best = Number.POSITIVE_INFINITY;
  const rec = (k: number, cost: number): void => {
    if (cost >= best) return;
    if (k === m) {
      if (balance.every((b) => b === 0)) best = cost;
      return;
    }
    const cap = p.capacity[k] as number;
    const a = p.from[k] as number;
    const b = p.to[k] as number;
    for (let f = 0; f <= cap; f++) {
      balance[a] = (balance[a] as number) - f;
      balance[b] = (balance[b] as number) + f;
      rec(k + 1, cost + f * (p.cost[k] as number));
      balance[a] = (balance[a] as number) + f;
      balance[b] = (balance[b] as number) - f;
    }
  };
  rec(0, 0);
  return { feasible: best !== Number.POSITIVE_INFINITY, cost: best };
}

function randomProblem(rand: () => number): FlowProblem {
  const n = 2 + Math.floor(rand() * 5);
  const m = 1 + Math.floor(rand() * 8);
  const from: number[] = [];
  const to: number[] = [];
  const capacity: number[] = [];
  const cost: number[] = [];
  for (let k = 0; k < m; k++) {
    from.push(Math.floor(rand() * n));
    to.push(Math.floor(rand() * n));
    capacity.push(Math.floor(rand() * 4));
    cost.push(Math.floor(rand() * 6));
  }
  const supply = new Array<number>(n).fill(0);
  const units = Math.floor(rand() * 4);
  for (let u = 0; u < units; u++) {
    const up = Math.floor(rand() * n);
    supply[up] = (supply[up] ?? 0) + 1;
    const down = Math.floor(rand() * n);
    supply[down] = (supply[down] ?? 0) - 1;
  }
  return { nodeCount: n, from, to, capacity, cost, supply };
}

function checkSolution(p: FlowProblem, flow: Int32Array): number {
  const balance = Array.from(p.supply as ArrayLike<number>);
  let cost = 0;
  for (let k = 0; k < flow.length; k++) {
    const f = flow[k] as number;
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(p.capacity[k] as number);
    balance[p.from[k] as number] = (balance[p.from[k] as number] as number) - f;
    balance[p.to[k] as number] = (balance[p.to[k] as number] as number) + f;
    cost += f * (p.cost[k] as number);
  }
  return balance.every((b) => b === 0) ? cost : Number.NaN;
}

describe('minCostFlow', () => {
  it('matches exhaustive search on 3000 random small networks', () => {
    const rand = rng(12345);
    let feasibleCases = 0;
    let infeasibleCases = 0;
    for (let c = 0; c < 3000; c++) {
      const p = randomProblem(rand);
      const r = minCostFlow(p);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      const want = brute(p);
      expect(r.value.feasible, `case ${c}`).toBe(want.feasible);
      if (want.feasible) {
        feasibleCases++;
        expect(r.value.cost, `case ${c}`).toBe(want.cost);
        expect(checkSolution(p, r.value.flow), `case ${c}`).toBe(want.cost);
      } else infeasibleCases++;
    }
    expect(feasibleCases).toBeGreaterThan(500);
    expect(infeasibleCases).toBeGreaterThan(100);
  });

  it('prefers the cheap route and spills to the expensive one at capacity', () => {
    const r = minCostFlow({
      nodeCount: 3,
      from: [0, 0, 1],
      to: [2, 1, 2],
      capacity: [2, 5, 5],
      cost: [1, 2, 2],
      supply: [3, 0, -3],
    });
    if (!r.ok) throw new Error('flow failed');
    expect(Array.from(r.value.flow)).toEqual([2, 1, 1]);
    expect(r.value.cost).toBe(2 + 2 + 2);
  });

  it('solves a 20000-node unit-cost chain network and is deterministic', () => {
    const n = 20000;
    const from: number[] = [];
    const to: number[] = [];
    for (let i = 0; i + 1 < n; i++) {
      from.push(i);
      to.push(i + 1);
    }
    const supply = new Array<number>(n).fill(0);
    supply[0] = 50;
    supply[n - 1] = -50;
    const p: FlowProblem = {
      nodeCount: n,
      from,
      to,
      capacity: from.map(() => 50),
      cost: from.map(() => 1),
      supply,
    };
    const a = minCostFlow(p);
    const b = minCostFlow(p);
    if (!a.ok || !b.ok) throw new Error('flow failed');
    expect(a.value.feasible).toBe(true);
    expect(a.value.cost).toBe(50 * (n - 1));
    expect(Array.from(a.value.flow)).toEqual(Array.from(b.value.flow));
  });

  it('rejects malformed input with a reason', () => {
    const base = { nodeCount: 2, from: [0], to: [1], capacity: [1], cost: [1], supply: [0, 0] };
    const reason = (p: FlowProblem) => {
      const r = minCostFlow(p);
      return r.ok ? 'ok' : (r.error.detail as { reason?: string }).reason;
    };
    expect(reason({ ...base, cost: [-1] })).toBe('flow-arc-cost');
    expect(reason({ ...base, capacity: [1.5] })).toBe('flow-arc-capacity');
    expect(reason({ ...base, to: [7] })).toBe('flow-arc-endpoint');
    expect(reason({ ...base, supply: [0] })).toBe('flow-supply-length');
    expect(reason({ ...base, cost: [Number.NaN] })).toBe('flow-arc-cost');
  });
});
