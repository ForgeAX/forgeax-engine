import { solveSideCounts } from './quad-counts';

/** A trimmed face whose boundary sample total must be even: triangle pairing needs it (T = B + 2I + 2h - 2). */
export interface RingConstraint {
  /** Stable identity, `face:<index>`, shared by every reader of the constraint. */
  readonly id: string;
  readonly face: number;
  /** Every edge bounding the face, outer and holes. An edge may repeat when a loop uses it twice. */
  readonly edges: readonly number[];
}

export interface RingSatisfied {
  readonly id: string;
  readonly face: number;
  readonly total: number;
}

export type CountSolveReason = 'ring-count-parity' | 'constraint-unsatisfiable';

export interface CountSolveFailure {
  readonly reason: CountSolveReason;
  readonly constraint: string;
}

export interface RowCounts {
  /** One solved sample count per B-rep edge id; shared by every face that uses the edge. */
  readonly rowCounts: Map<number, number>;
  readonly satisfied: readonly RingSatisfied[];
}

export type CountSolveResult =
  | { readonly ok: true; readonly value: RowCounts }
  | { readonly ok: false; readonly error: CountSolveFailure };

export interface CountSolveOptions {
  /** Hard cap on parity raises. Each raise is one edge +1; the default is twice the edge count. */
  readonly maxRaises?: number;
  /** Edges of holed faces: an odd forced count rounds up to even, as the existing holed-face rule requires. */
  readonly evenEdges?: Iterable<number>;
}

/**
 * The one owner of boundary counts. Opposite sides share one count (class maximum), then each odd ring total
 * raises its cheapest edge by one and the classes are re-solved. Floors only grow, so the loop terminates;
 * the cap makes non-convergence fail closed as `constraint-unsatisfiable`.
 */
export function solveRowCounts(
  forced: readonly number[],
  pairs: readonly (readonly [number, number])[],
  rings: readonly RingConstraint[],
  options: CountSolveOptions = {},
): CountSolveResult {
  const cap = options.maxRaises ?? 2 * forced.length;
  const floor = forced.slice();
  for (const e of options.evenEdges ?? []) {
    if ((floor[e] as number) % 2 === 1) floor[e] = (floor[e] as number) + 1;
  }
  let counts = solveSideCounts(floor, pairs);
  let raises = 0;
  for (;;) {
    const odd = rings.find((r) => total(r.edges, counts) % 2 !== 0);
    if (odd === undefined) break;
    if (raises >= cap) {
      return {
        ok: false,
        error: { reason: 'constraint-unsatisfiable', constraint: odd.id },
      };
    }
    const edge = cheapestRaise(odd.edges, counts, forced);
    floor[edge] = (counts[edge] as number) + 1;
    counts = solveSideCounts(floor, pairs);
    raises++;
  }
  const rowCounts = new Map<number, number>();
  for (let e = 0; e < counts.length; e++) rowCounts.set(e, counts[e] as number);
  const satisfied = rings.map((r) => ({
    id: r.id,
    face: r.face,
    total: total(r.edges, counts),
  }));
  return { ok: true, value: { rowCounts, satisfied } };
}

function total(edges: readonly number[], counts: readonly number[]): number {
  let sum = 0;
  for (const e of edges) sum += counts[e] as number;
  return sum;
}

/**
 * Edge whose one-sample raise changes spacing least: spacing L/c becomes L/(c+1), so the change is
 * L/(c(c+1)). Forced count stands in for L/size. Ties go to the lower edge id.
 */
function cheapestRaise(
  edges: readonly number[],
  counts: readonly number[],
  forced: readonly number[],
): number {
  let best = -1;
  let bestCost = Infinity;
  for (const e of [...new Set(edges)].sort((a, b) => a - b)) {
    const c = Math.max(1, counts[e] as number);
    const cost = Math.max(1, forced[e] as number) / (c * (c + 1));
    if (cost < bestCost) {
      bestCost = cost;
      best = e;
    }
  }
  return best;
}
