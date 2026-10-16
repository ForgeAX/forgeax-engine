import { err, ok, type Result } from '@forgeax/engine-types';
import { invalidInput, type NavigationError } from './errors';

/** Allocation bound for graph construction and reusable query workspace. */
export const NAVIGATION_MAX_NODES = 1_048_576;
export const NAVIGATION_MAX_EDGES = NAVIGATION_MAX_NODES * 8;

export interface NavigationEdge {
  readonly from: number;
  readonly to: number;
  /** Non-negative directed traversal cost; defaults to Euclidean distance. */
  readonly cost?: number;
}
export interface NavigationGraphSource {
  /** XYZ triples; XY graphs use z=0. Source arrays are copied. */
  readonly positions: ArrayLike<number>;
  readonly edges: readonly NavigationEdge[];
  /** Non-zero means blocked. Length must equal nodeCount. */
  readonly blocked?: ArrayLike<number>;
}
export interface NavigationPath {
  readonly nodes: readonly number[];
  /** Independently owned XYZ triples, including start and goal. */
  readonly points: Float32Array;
  readonly cost: number;
  /** Expanded nodes, including the goal. */
  readonly visited: number;
}

/** Immutable topology with private, synchronously reused search storage. */
type DistanceMetric = 'euclidean' | 'manhattan' | 'octile';

class NavigationGraph {
  readonly nodeCount: number;
  readonly edgeCount: number;
  #positions: Float32Array;
  #blocked: Uint8Array;
  #offsets: Uint32Array;
  #targets: Uint32Array;
  #costs: Float64Array;
  #scale: number;
  #metric: DistanceMetric;
  #stamp: Uint32Array;
  #epoch = 0;
  #scores: Float64Array;
  #priority: Float64Array;
  #parent: Int32Array;
  #heap: Uint32Array;
  #heapPosition: Int32Array;
  #heapSize = 0;

  /** Construct through createNavigationGraph/createNavigationGrid. */
  private constructor(
    positions: Float32Array,
    blocked: Uint8Array,
    offsets: Uint32Array,
    targets: Uint32Array,
    costs: Float64Array,
    scale: number,
    metric: DistanceMetric,
  ) {
    this.nodeCount = positions.length / 3;
    this.edgeCount = targets.length;
    this.#positions = positions;
    this.#blocked = blocked;
    this.#offsets = offsets;
    this.#targets = targets;
    this.#costs = costs;
    this.#scale = scale;
    this.#metric = metric;
    this.#stamp = new Uint32Array(this.nodeCount);
    this.#scores = new Float64Array(this.nodeCount);
    this.#priority = new Float64Array(this.nodeCount);
    this.#parent = new Int32Array(this.nodeCount);
    this.#heap = new Uint32Array(this.nodeCount);
    this.#heapPosition = new Int32Array(this.nodeCount);
  }

  static create(
    source: NavigationGraphSource,
    metric: DistanceMetric,
  ): Result<NavigationGraph, NavigationError> {
    const count = source.positions.length / 3;
    if (!Number.isInteger(count) || count < 1 || count > NAVIGATION_MAX_NODES) {
      return err(
        invalidInput(
          'positions.length',
          source.positions.length,
          `1..${NAVIGATION_MAX_NODES} XYZ triples`,
        ),
      );
    }
    if (source.edges.length > NAVIGATION_MAX_EDGES)
      return err(
        invalidInput('edges.length', source.edges.length, `At most ${NAVIGATION_MAX_EDGES} edges`),
      );
    const positions = Float32Array.from(source.positions);
    for (let i = 0; i < positions.length; i++) {
      if (!Number.isFinite(positions[i]))
        return err(
          invalidInput(`positions[${i}]`, source.positions[i], 'Finite Float32 coordinate'),
        );
    }
    if (source.blocked !== undefined && source.blocked.length !== count)
      return err(invalidInput('blocked.length', source.blocked.length, `${count}`));
    const blocked = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const value = source.blocked?.[i] ?? 0;
      if (!Number.isFinite(value))
        return err(invalidInput(`blocked[${i}]`, value, 'Finite number'));
      blocked[i] = value === 0 ? 0 : 1;
    }
    const offsets = new Uint32Array(count + 1);
    const edgeCosts = new Float64Array(source.edges.length);
    let scale = Number.MAX_VALUE;
    for (let i = 0; i < source.edges.length; i++) {
      const edge = source.edges[i] as NavigationEdge;
      for (const node of [edge.from, edge.to]) {
        if (!Number.isInteger(node) || node < 0 || node >= count)
          return err({
            code: 'navigation-invalid-node',
            detail: { node, nodeCount: count },
            expected: 'Existing integer node index',
            hint: 'Use an index from this graph.',
          });
      }
      const distance = pointDistance(positions, edge.from, edge.to, metric);
      const cost = edge.cost ?? pointDistance(positions, edge.from, edge.to, 'euclidean');
      if (!Number.isFinite(cost) || cost < 0 || cost > Number.MAX_VALUE / NAVIGATION_MAX_NODES)
        return err(
          invalidInput(`edges[${i}].cost`, cost, 'Finite non-negative bounded traversal cost'),
        );
      edgeCosts[i] = cost;
      if (distance > 0) scale = Math.min(scale, cost / distance);
      offsets[edge.from + 1] = (offsets[edge.from + 1] ?? 0) + 1;
    }
    for (let i = 1; i <= count; i++) offsets[i] = (offsets[i] ?? 0) + (offsets[i - 1] ?? 0);
    const cursor = offsets.slice();
    const targets = new Uint32Array(source.edges.length);
    const costs = new Float64Array(source.edges.length);
    for (let i = 0; i < source.edges.length; i++) {
      const edge = source.edges[i] as NavigationEdge;
      const at = cursor[edge.from] ?? 0;
      cursor[edge.from] = at + 1;
      targets[at] = edge.to;
      costs[at] = edgeCosts[i] as number;
    }
    return ok(new NavigationGraph(positions, blocked, offsets, targets, costs, scale, metric));
  }

  /** A* with an admissible heuristic derived from actual edge cost/distance. */
  findPath(
    start: number,
    goal: number,
    options: { readonly maxVisited?: number } = {},
  ): Result<NavigationPath, NavigationError> {
    for (const node of [start, goal]) {
      if (!Number.isInteger(node) || node < 0 || node >= this.nodeCount)
        return err({
          code: 'navigation-invalid-node',
          detail: { node, nodeCount: this.nodeCount },
          expected: 'Existing integer node index',
          hint: 'Use an index from this graph.',
        });
    }
    const maxVisited = options.maxVisited ?? this.nodeCount;
    if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > this.nodeCount)
      return err(invalidInput('maxVisited', maxVisited, `Integer 1..${this.nodeCount}`));
    if (this.#blocked[start] || this.#blocked[goal]) return this.#unreachable(start, goal, 0);
    this.#epoch = (this.#epoch + 1) >>> 0;
    if (this.#epoch === 0) {
      this.#stamp.fill(0);
      this.#epoch = 1;
    }
    this.#heapSize = 0;
    this.#stamp[start] = this.#epoch;
    this.#scores[start] = 0;
    this.#parent[start] = -1;
    this.#priority[start] = this.#heuristic(start, goal);
    this.#push(start);
    let visited = 0;
    while (this.#heapSize > 0) {
      if (visited === maxVisited)
        return err({
          code: 'navigation-query-limit',
          detail: { start, goal, visited, maxVisited },
          expected: 'Goal reached within query budget',
          hint: 'Retry with a larger maxVisited or a smaller graph.',
        });
      const current = this.#pop();
      visited++;
      if (current === goal) {
        const nodes: number[] = [];
        for (let at = goal; at !== -1; at = this.#parent[at] as number) nodes.push(at);
        nodes.reverse();
        const points = new Float32Array(nodes.length * 3);
        for (let i = 0; i < nodes.length; i++)
          points.set(
            this.#positions.subarray((nodes[i] as number) * 3, (nodes[i] as number) * 3 + 3),
            i * 3,
          );
        return ok({ nodes, points, cost: this.#scores[goal] as number, visited });
      }
      for (
        let edge = this.#offsets[current] as number;
        edge < (this.#offsets[current + 1] as number);
        edge++
      ) {
        const next = this.#targets[edge] as number;
        if (this.#blocked[next]) continue;
        const score = (this.#scores[current] as number) + (this.#costs[edge] as number);
        const seen = this.#stamp[next] === this.#epoch;
        if (seen && score >= (this.#scores[next] as number)) continue;
        this.#stamp[next] = this.#epoch;
        this.#scores[next] = score;
        this.#parent[next] = current;
        this.#priority[next] = score + this.#heuristic(next, goal);
        if (seen && (this.#heapPosition[next] as number) >= 0)
          this.#up(this.#heapPosition[next] as number);
        else this.#push(next);
      }
    }
    return this.#unreachable(start, goal, visited);
  }

  #unreachable(start: number, goal: number, visited: number): Result<never, NavigationError> {
    return err({
      code: 'navigation-unreachable',
      detail: { start, goal, visited },
      expected: 'Connected unblocked endpoints',
      hint: 'Choose reachable nodes or rebuild the authored topology.',
    });
  }
  #heuristic(node: number, goal: number): number {
    return pointDistance(this.#positions, node, goal, this.#metric) * this.#scale;
  }
  #less(a: number, b: number): boolean {
    const priorityA = this.#priority[a] as number;
    const priorityB = this.#priority[b] as number;
    // Prefer deeper progress on an equal f-score, then stable node index.
    return (
      priorityA < priorityB ||
      (priorityA === priorityB &&
        ((this.#scores[a] as number) > (this.#scores[b] as number) ||
          (this.#scores[a] === this.#scores[b] && a < b)))
    );
  }
  #swap(a: number, b: number): void {
    const node = this.#heap[a] as number;
    this.#heap[a] = this.#heap[b] as number;
    this.#heap[b] = node;
    this.#heapPosition[this.#heap[a] as number] = a;
    this.#heapPosition[node] = b;
  }
  #up(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!this.#less(this.#heap[index] as number, this.#heap[parent] as number)) break;
      this.#swap(index, parent);
      index = parent;
    }
  }
  #push(node: number): void {
    this.#heap[this.#heapSize] = node;
    this.#heapPosition[node] = this.#heapSize;
    this.#up(this.#heapSize++);
  }
  #pop(): number {
    const node = this.#heap[0] as number;
    this.#heapPosition[node] = -1;
    this.#heapSize--;
    if (this.#heapSize > 0) {
      this.#heap[0] = this.#heap[this.#heapSize] as number;
      this.#heapPosition[this.#heap[0] as number] = 0;
      let at = 0;
      while (at * 2 + 1 < this.#heapSize) {
        let child = at * 2 + 1;
        if (
          child + 1 < this.#heapSize &&
          this.#less(this.#heap[child + 1] as number, this.#heap[child] as number)
        )
          child++;
        if (!this.#less(this.#heap[child] as number, this.#heap[at] as number)) break;
        this.#swap(at, child);
        at = child;
      }
    }
    return node;
  }
}
function pointDistance(
  positions: Float32Array,
  a: number,
  b: number,
  metric: DistanceMetric,
): number {
  if (metric !== 'euclidean') {
    const dx = Math.abs((positions[a * 3] as number) - (positions[b * 3] as number));
    const dy = Math.abs((positions[a * 3 + 1] as number) - (positions[b * 3 + 1] as number));
    const dz = Math.abs((positions[a * 3 + 2] as number) - (positions[b * 3 + 2] as number));
    if (metric === 'manhattan') return dx + dy + dz;
    // Grid octile distance; one axis is constant in either XY or XZ.
    const sum = dx + dy + dz;
    const maximum = Math.max(dx, dy, dz);
    return maximum + (Math.SQRT2 - 1) * (sum - maximum);
  }
  return Math.hypot(
    (positions[a * 3] as number) - (positions[b * 3] as number),
    (positions[a * 3 + 1] as number) - (positions[b * 3 + 1] as number),
    (positions[a * 3 + 2] as number) - (positions[b * 3 + 2] as number),
  );
}
export function createNavigationGraph(
  source: NavigationGraphSource,
): Result<NavigationGraph, NavigationError> {
  return NavigationGraph.create(source, 'euclidean');
}

export type { NavigationGraph };

/** Internal specialization for grid topology; not part of the public entry. */
export function compileNavigationGridGraph(
  source: NavigationGraphSource,
  diagonal: boolean,
): Result<NavigationGraph, NavigationError> {
  return NavigationGraph.create(source, diagonal ? 'octile' : 'manhattan');
}
