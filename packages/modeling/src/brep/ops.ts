/**
 * Operation counters for the exact stage: how many times each costly primitive ran, independent of
 * the host clock and heap. A count is a pure function of the inputs, so a regression bound on it is
 * stable on a loaded machine. Nothing is counted outside `countOps`.
 */
export interface OpCounts {
  /** Segment pairs of a planar region the ring precondition examined (one per inner iteration, so an early exit counts only what ran). */
  segmentPairs: number;
  /** Segment-segment gap computations (the intersection call) that survived the box test. */
  segmentGaps: number;
  surfaceEvals: number;
  curveEvals: number;
  /** Integrand evaluations of the composite Gauss-Legendre rule. */
  quadratureEvals: number;
  /** Planar faces that need the general triangulator (a convex outline without holes takes a fan). */
  triangulations: number;
  /** Outline and hole points handed to those triangulations. */
  triangulationPoints: number;
  /** `ShapeAssembler.vertex` calls. */
  vertexCalls: number;
  /** Welded-vertex candidates a vertex call compared (the spatial-hash bucket entries it visited). */
  vertexProbes: number;
  /** Numbers visited by the finite-value scan of structural validation. */
  finiteChecks: number;
}

export type OpKind = keyof OpCounts;

export const OP_KINDS: readonly OpKind[] = [
  'segmentPairs',
  'segmentGaps',
  'surfaceEvals',
  'curveEvals',
  'quadratureEvals',
  'triangulations',
  'triangulationPoints',
  'vertexCalls',
  'vertexProbes',
  'finiteChecks',
];

let active: OpCounts | undefined;

export function tally(kind: OpKind, n = 1): void {
  if (active !== undefined) active[kind] += n;
}

/** Runs `run` and returns its value with the operations it performed; a nested call counts into both. */
export function countOps<T>(run: () => T): { value: T; counts: OpCounts } {
  const outer = active;
  const counts: OpCounts = {
    segmentPairs: 0,
    segmentGaps: 0,
    surfaceEvals: 0,
    curveEvals: 0,
    quadratureEvals: 0,
    triangulations: 0,
    triangulationPoints: 0,
    vertexCalls: 0,
    vertexProbes: 0,
    finiteChecks: 0,
  };
  active = counts;
  try {
    const value = run();
    if (outer !== undefined) for (const k of OP_KINDS) outer[k] += counts[k];
    return { value, counts };
  } finally {
    active = outer;
  }
}
