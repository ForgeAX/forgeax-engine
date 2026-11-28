import { dot3, sub3 } from '../vec';
import { bezierPieces, clipToBox, type HullNode, hullNode, splitNode } from './hull';
import type { Problem } from './problem';
import type { AnalyticSide, NurbsSide } from './side';

const MAX_NODES = 2_000_000;

export interface SeedSet {
  readonly seeds: number[][];
  readonly leaves: number;
  /** Subdivision stopped early (node budget); some regions were not examined. */
  readonly truncated: boolean;
}

/** No point of the node's hull is on B: the convex hull of the net lies strictly on one side. */
function excluded(n: HullNode, b: AnalyticSide, margin: number): boolean {
  if (b.linear) {
    const f = b.surface.frame;
    let pos = false;
    let neg = false;
    for (const row of n.s.points) {
      for (const p of row) {
        const d = dot3(sub3(p, f.o), f.z);
        if (d > -margin) pos = true;
        if (d < margin) neg = true;
        if (pos && neg) return false;
      }
    }
    return true;
  }
  return Math.abs(b.f(n.c)) > n.r + margin;
}

/**
 * Subdivide face A (Bezier pieces, then halving) while its control net may touch B; at every leaf of
 * radius at most `resolution`, run a minimum-norm Newton from the leaf centre and keep the converged
 * states that lie on both faces.
 */
export function implicitSeeds(
  a: NurbsSide,
  b: AnalyticSide,
  problem: Problem,
  resolution: number,
): SeedSet {
  const clipped = clipToBox(a.surface, a.box);
  const seeds: number[][] = [];
  if (clipped === undefined) return { seeds, leaves: 0, truncated: true };
  const stack: HullNode[] = bezierPieces(clipped).map(hullNode);
  const margin = 10 * problem.ptTol;
  let leaves = 0;
  let visited = 0;
  while (stack.length > 0) {
    const n = stack.pop() as HullNode;
    if (++visited > MAX_NODES) return { seeds, leaves, truncated: true };
    if (excluded(n, b, margin)) continue;
    const parts = n.r > resolution ? splitNode(n) : undefined;
    if (parts !== undefined) {
      stack.push(parts[0], parts[1]);
      continue;
    }
    leaves++;
    const x = problem.correct(
      [0.5 * (n.box[0][0] + n.box[0][1]), 0.5 * (n.box[1][0] + n.box[1][1])],
      { kind: 'none' },
    );
    if (x !== undefined && problem.inside(x)) seeds.push(x);
  }
  return { seeds, leaves, truncated: false };
}
