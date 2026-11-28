// Min-cost flow with integer capacities and nonnegative integer costs.
// Primal-dual successive shortest paths: Dijkstra on reduced costs fixes the potentials,
// then Dinic-style blocking flows saturate every zero-reduced-cost path before the next
// Dijkstra (Ahuja, Magnanti, Orlin, Network Flows, ch. 9). The number of Dijkstra rounds is
// the number of distinct shortest path lengths, which stays small for unit-cost networks.
// Deterministic: arcs are visited in input order and ties never depend on hashing.

import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';

/** Largest capacity or cost accepted; keeps every path cost and potential an exact double. */
export const FLOW_VALUE_LIMIT = 1 << 30;

export interface FlowProblem {
  readonly nodeCount: number;
  /** Arc k goes from `from[k]` to `to[k]`. */
  readonly from: ArrayLike<number>;
  readonly to: ArrayLike<number>;
  readonly capacity: ArrayLike<number>;
  readonly cost: ArrayLike<number>;
  /** Positive = node supplies that much flow, negative = node demands it. */
  readonly supply: ArrayLike<number>;
}

export interface FlowSolution {
  /** True when every supply was shipped and every demand met (supplies must sum to zero). */
  readonly feasible: boolean;
  /** Flow on each input arc. */
  readonly flow: Int32Array;
  /** Sum of cost * flow over the input arcs. */
  readonly cost: number;
  readonly shipped: number;
  /** Total positive supply. */
  readonly required: number;
  readonly dijkstraRounds: number;
}

export interface FlowOptions {
  /** Cap on Dijkstra rounds plus blocking-flow phases; default 1e7. */
  readonly maxPhases?: number;
}

const INF = Number.POSITIVE_INFINITY;

function bad(reason: string, extra: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', 'a well-formed flow problem', {
    reason,
    ...extra,
  });
}

function boundedInt(v: number, lo: number): boolean {
  return Number.isInteger(v) && v >= lo && v <= FLOW_VALUE_LIMIT;
}

function validate(p: FlowProblem): ModelingError | undefined {
  const n = p.nodeCount;
  if (!Number.isInteger(n) || n < 0 || n > FLOW_VALUE_LIMIT) return bad('flow-node-count', { n });
  const m = p.from.length;
  if (p.to.length !== m || p.capacity.length !== m || p.cost.length !== m)
    return bad('flow-arc-arrays-differ');
  if (p.supply.length !== n) return bad('flow-supply-length', { n, got: p.supply.length });
  for (let k = 0; k < m; k++) {
    const a = p.from[k] as number;
    const b = p.to[k] as number;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n)
      return bad('flow-arc-endpoint', { arc: k });
    if (!boundedInt(p.capacity[k] as number, 0)) return bad('flow-arc-capacity', { arc: k });
    if (!boundedInt(p.cost[k] as number, 0)) return bad('flow-arc-cost', { arc: k });
  }
  for (let v = 0; v < n; v++) {
    const s = p.supply[v] as number;
    if (!Number.isInteger(s) || s < -FLOW_VALUE_LIMIT || s > FLOW_VALUE_LIMIT)
      return bad('flow-supply-value', { node: v });
  }
  return undefined;
}

/** Binary min-heap over (key, node) pairs with lazy deletion. */
class Heap {
  keys: number[] = [];
  nodes: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  clear(): void {
    this.keys.length = 0;
    this.nodes.length = 0;
  }
  push(key: number, node: number): void {
    let i = this.keys.length;
    this.keys.push(key);
    this.nodes.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(p, i)) break;
      this.swap(p, i);
      i = p;
    }
  }
  popNode(): number {
    const top = this.nodes[0] as number;
    const lastKey = this.keys.pop() as number;
    const lastNode = this.nodes.pop() as number;
    const n = this.keys.length;
    if (n > 0) {
      this.keys[0] = lastKey;
      this.nodes[0] = lastNode;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private less(a: number, b: number): boolean {
    const ka = this.keys[a] as number;
    const kb = this.keys[b] as number;
    return ka < kb || (ka === kb && (this.nodes[a] as number) < (this.nodes[b] as number));
  }
  private swap(a: number, b: number): void {
    const k = this.keys[a] as number;
    this.keys[a] = this.keys[b] as number;
    this.keys[b] = k;
    const v = this.nodes[a] as number;
    this.nodes[a] = this.nodes[b] as number;
    this.nodes[b] = v;
  }
}

/**
 * Ships every positive supply to the demands at minimum cost. An infeasible instance is a normal
 * outcome (`feasible: false`, flow is a maximum flow of minimum cost among maximum flows).
 */
export function minCostFlow(
  problem: FlowProblem,
  options: FlowOptions = {},
): Result<FlowSolution, ModelingError> {
  const invalid = validate(problem);
  if (invalid) return err(invalid);
  const n0 = problem.nodeCount;
  const m0 = problem.from.length;
  const source = n0;
  const sink = n0 + 1;
  const n = n0 + 2;

  let supplyArcs = 0;
  let required = 0;
  let demand = 0;
  for (let v = 0; v < n0; v++) {
    const s = problem.supply[v] as number;
    if (s !== 0) supplyArcs++;
    if (s > 0) required += s;
    else demand -= s;
  }
  const m = m0 + supplyArcs;
  // Arc 2k is forward and 2k+1 its reverse; arcs 0..m0-1 are the caller's.
  const head = new Int32Array(2 * m);
  const cap = new Int32Array(2 * m);
  const cost = new Float64Array(2 * m);
  const tail = new Int32Array(2 * m);
  for (let k = 0; k < m0; k++) {
    tail[2 * k] = problem.from[k] as number;
    head[2 * k] = problem.to[k] as number;
    cap[2 * k] = problem.capacity[k] as number;
    cost[2 * k] = problem.cost[k] as number;
    tail[2 * k + 1] = problem.to[k] as number;
    head[2 * k + 1] = problem.from[k] as number;
    cost[2 * k + 1] = -(problem.cost[k] as number);
  }
  let next = m0;
  for (let v = 0; v < n0; v++) {
    const s = problem.supply[v] as number;
    if (s === 0) continue;
    const a = s > 0 ? source : v;
    const b = s > 0 ? v : sink;
    tail[2 * next] = a;
    head[2 * next] = b;
    cap[2 * next] = Math.abs(s);
    tail[2 * next + 1] = b;
    head[2 * next + 1] = a;
    next++;
  }

  const adjStart = new Int32Array(n + 1);
  for (let a = 0; a < 2 * m; a++) {
    const t = (tail[a] as number) + 1;
    adjStart[t] = (adjStart[t] as number) + 1;
  }
  for (let v = 0; v < n; v++)
    adjStart[v + 1] = (adjStart[v + 1] as number) + (adjStart[v] as number);
  const adj = new Int32Array(2 * m);
  const fill = adjStart.slice(0, n);
  for (let a = 0; a < 2 * m; a++) {
    const t = tail[a] as number;
    adj[fill[t] as number] = a;
    fill[t] = (fill[t] as number) + 1;
  }

  const pot = new Float64Array(n);
  const dist = new Float64Array(n);
  const level = new Int32Array(n);
  const cursor = new Int32Array(n);
  const queue = new Int32Array(n);
  const stackArc = new Int32Array(n);
  const heap = new Heap();
  const maxPhases = options.maxPhases ?? 10_000_000;
  let phases = 0;
  let rounds = 0;
  let shipped = 0;

  const reduced = (a: number): number =>
    (cost[a] as number) + (pot[tail[a] as number] as number) - (pot[head[a] as number] as number);

  while (shipped < required) {
    if (++phases > maxPhases)
      return err(
        modelingError('model-work-budget', 'a flow solve within maxPhases', {
          reason: 'flow-phase-budget',
          maxPhases,
        }),
      );
    // Dijkstra on reduced costs, then clamp every distance at the sink distance.
    dist.fill(INF);
    dist[source] = 0;
    heap.clear();
    heap.push(0, source);
    while (heap.size > 0) {
      const dTop = heap.keys[0] as number;
      const u = heap.popNode();
      if (dTop > (dist[u] as number)) continue;
      for (let i = adjStart[u] as number; i < (adjStart[u + 1] as number); i++) {
        const a = adj[i] as number;
        if ((cap[a] as number) <= 0) continue;
        const v = head[a] as number;
        const nd = dTop + reduced(a);
        if (nd < (dist[v] as number)) {
          dist[v] = nd;
          heap.push(nd, v);
        }
      }
    }
    const dSink = dist[sink] as number;
    if (dSink === INF) break;
    rounds++;
    for (let v = 0; v < n; v++) pot[v] = (pot[v] as number) + Math.min(dist[v] as number, dSink);

    // Blocking flows over admissible (zero reduced cost) residual arcs, level by level.
    for (;;) {
      if (++phases > maxPhases)
        return err(
          modelingError('model-work-budget', 'a flow solve within maxPhases', {
            reason: 'flow-phase-budget',
            maxPhases,
          }),
        );
      level.fill(-1);
      level[source] = 0;
      let qh = 0;
      let qt = 0;
      queue[qt++] = source;
      while (qh < qt) {
        const u = queue[qh++] as number;
        for (let i = adjStart[u] as number; i < (adjStart[u + 1] as number); i++) {
          const a = adj[i] as number;
          const v = head[a] as number;
          if ((cap[a] as number) > 0 && (level[v] as number) < 0 && reduced(a) === 0) {
            level[v] = (level[u] as number) + 1;
            queue[qt++] = v;
          }
        }
      }
      if ((level[sink] as number) < 0) break;
      for (let v = 0; v < n; v++) cursor[v] = adjStart[v] as number;
      let depth = 0;
      let node = source;
      for (;;) {
        if (node === sink) {
          let push = Number.MAX_SAFE_INTEGER;
          for (let d = 0; d < depth; d++)
            push = Math.min(push, cap[stackArc[d] as number] as number);
          push = Math.min(push, required - shipped);
          for (let d = 0; d < depth; d++) {
            const a = stackArc[d] as number;
            cap[a] = (cap[a] as number) - push;
            cap[a ^ 1] = (cap[a ^ 1] as number) + push;
          }
          shipped += push;
          // Resume from the first saturated arc on the path.
          let cut = 0;
          while (cut < depth && (cap[stackArc[cut] as number] as number) > 0) cut++;
          depth = cut;
          node = depth === 0 ? source : (head[stackArc[depth - 1] as number] as number);
          if (shipped >= required) break;
          continue;
        }
        let advanced = false;
        const end = adjStart[node + 1] as number;
        while ((cursor[node] as number) < end) {
          const a = adj[cursor[node] as number] as number;
          const v = head[a] as number;
          if (
            (cap[a] as number) > 0 &&
            (level[v] as number) === (level[node] as number) + 1 &&
            reduced(a) === 0
          ) {
            stackArc[depth++] = a;
            node = v;
            advanced = true;
            break;
          }
          cursor[node] = (cursor[node] as number) + 1;
        }
        if (advanced) continue;
        if (depth === 0) break;
        // Dead end: retreat and skip the arc that led here.
        level[node] = -1;
        depth--;
        node = tail[stackArc[depth] as number] as number;
        cursor[node] = (cursor[node] as number) + 1;
      }
      if (shipped >= required) break;
    }
  }

  const flow = new Int32Array(m0);
  let total = 0;
  for (let k = 0; k < m0; k++) {
    const f = cap[2 * k + 1] as number;
    flow[k] = f;
    total += f * (problem.cost[k] as number);
  }
  return ok({
    feasible: shipped === required && shipped === demand,
    flow,
    cost: total,
    shipped,
    required,
    dijkstraRounds: rounds,
  });
}
