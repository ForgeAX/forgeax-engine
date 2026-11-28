import { faceLoops, type GridSide, gridOf } from './faces';
import type { Coedge, Curve, Face, Shape, Surface } from './types';

function find(parent: Int32Array, i: number): number {
  let x = i;
  while (parent[x] !== x) {
    parent[x] = parent[parent[x] as number] as number;
    x = parent[x] as number;
  }
  return x;
}

function unite(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

/**
 * Opposite-side count solve: sides joined by a pair share one count, and each union class takes the
 * maximum forced count of its members. Union-find with path halving over the side indices.
 */
export function solveSideCounts(
  forced: readonly number[],
  pairs: readonly (readonly [number, number])[],
): number[] {
  const parent = new Int32Array(forced.length);
  for (let i = 0; i < forced.length; i++) parent[i] = i;
  for (const [a, b] of pairs) unite(parent, a, b);
  const classMax = new Array<number>(forced.length).fill(0);
  for (let i = 0; i < forced.length; i++) {
    const r = find(parent, i);
    classMax[r] = Math.max(classMax[r] as number, forced[i] as number);
  }
  return forced.map((_, i) => classMax[find(parent, i)] as number);
}

/**
 * Edge pairs that must carry one sample count: opposite single-edge sides of each face. A gridded face
 * contributes its bottom/top and right/left sides; a planar four-line loop contributes its opposite edges.
 * Multi-edge sides are not paired, so a face that still mismatches fails in the layout.
 */
export function opposingEdgePairs(shape: Shape): [number, number][] {
  const pairs: [number, number][] = [];
  const edgeOf = (c: number): number => (shape.coedges[c] as Coedge).edge;
  const pairSides = (a: GridSide, b: GridSide): void => {
    if (a.degenerate || b.degenerate || a.coedges.length !== 1 || b.coedges.length !== 1) return;
    pairs.push([edgeOf(a.coedges[0] as number), edgeOf(b.coedges[0] as number)]);
  };
  for (let f = 0; f < shape.faces.length; f++) {
    const grid = gridOf(shape, f);
    if (grid.ok) {
      pairSides(grid.value.bottom, grid.value.top);
      pairSides(grid.value.right, grid.value.left);
      continue;
    }
    const surface = shape.surfaces[(shape.faces[f] as Face).surface] as Surface | undefined;
    if (surface?.kind !== 'plane') continue;
    const { outer, holes } = faceLoops(shape, f);
    if (holes.length > 0 || outer.length !== 4) continue;
    if (!outer.every((c) => isLine(shape, edgeOf(c)))) continue;
    pairs.push([edgeOf(outer[0] as number), edgeOf(outer[2] as number)]);
    pairs.push([edgeOf(outer[1] as number), edgeOf(outer[3] as number)]);
  }
  return pairs;
}

function isLine(shape: Shape, e: number): boolean {
  const edge = shape.edges[e];
  if (edge === undefined || edge.curve < 0) return false;
  return (shape.curves[edge.curve] as Curve).kind === 'line';
}
