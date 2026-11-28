// Test-only stand-in for src/brep/planar-cross-merge.ts: every kept cell becomes its own face region, with no
// coplanar merge and no collinear-vertex trim. This reproduces the pre-#648 fragmented boolean result.
import type { MergedRegion, MergeInput } from '../../src/brep/planar-cross-merge.ts';

export type { KeptCell, MergedRegion, MergeInput } from '../../src/brep/planar-cross-merge.ts';

export function mergeCoplanarCells(input: MergeInput): MergedRegion[] {
  return input.cells.map((cell) => ({ group: cell.group, outer: cell.ring, holes: [] }));
}
