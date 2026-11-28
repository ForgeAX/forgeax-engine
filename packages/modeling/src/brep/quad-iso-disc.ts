import { err, ok } from '@forgeax/engine-types';
import type { IsoStep } from './quad-iso-quadric';
import type { P2 } from './vec';

/**
 * A circular outer loop on a lattice. The loop's `n` samples pair one for one with `n` lattice nodes of a closed
 * path that hugs a circle `DISC_BAND` cells inside the loop; the lattice cells inside the path fill the disc, and the
 * strip between path and loop is a structured annulus. The path is the cheapest closed 4-connected walk whose node k
 * stays within `REACH` cells of the circle point at sample k, so it jogs where the loop outruns the lattice.
 */
export interface DiscGrid {
  readonly xs: number[];
  readonly ys: number[];
  /** Lattice index of path node k, the partner of loop sample k. */
  readonly path: readonly (readonly [number, number])[];
  /** Whether the cell [i, i + 1] x [j, j + 1] lies inside the path. */
  readonly inside: (i: number, j: number) => boolean;
}

const DISC_BAND = 2.5;
const REACH = 3;
const MIN_COUNT = 16;

interface Candidate {
  readonly i: number;
  readonly j: number;
  readonly cost: number;
}

export function discGrid(loop: readonly P2[], center: P2, radius: number): IsoStep<DiscGrid> {
  const n = loop.length;
  if (n < MIN_COUNT || n % 4 !== 0) return err('iso-outer-count-odd');
  // per-sample spacing of the loop and the lattice cell it implies
  const h = (8 * radius) / (n + 8 * DISC_BAND);
  const rho = radius - DISC_BAND * h;
  if (!(rho > 4 * h)) return err('iso-outer-disc-unfit');
  const inner = loop.map((p): P2 => {
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    return [center[0] + (dx / d) * rho, center[1] + (dy / d) * rho];
  });
  const span = Math.ceil(radius / h) + 2;
  let best: { cost: number; path: [number, number][]; x0: number; y0: number } | undefined;
  for (const px of [0, 0.5]) {
    for (const py of [0, 0.5]) {
      const x0 = center[0] - (span + px) * h;
      const y0 = center[1] - (span + py) * h;
      const found = trace(inner, x0, y0, h, REACH);
      if (found !== undefined && (best === undefined || found.cost < best.cost))
        best = { ...found, x0, y0 };
    }
  }
  if (best === undefined) return err('iso-outer-disc-unfit');
  const m = 2 * span + 3;
  const xs = Array.from({ length: m }, (_, i) => best.x0 + i * h);
  const ys = Array.from({ length: m }, (_, j) => best.y0 + j * h);
  const path = best.path;
  const cross: number[][] = Array.from({ length: m }, () => []);
  for (let k = 0; k < n; k++) {
    const a = path[k] as [number, number];
    const b = path[(k + 1) % n] as [number, number];
    if (a[0] === b[0]) (cross[Math.min(a[1], b[1])] as number[]).push(a[0]);
  }
  for (const row of cross) row.sort((p, q) => p - q);
  const inside = (i: number, j: number): boolean => {
    const row = cross[j];
    if (row === undefined) return false;
    let count = 0;
    for (const c of row) if (c <= i) count++;
    return count % 2 === 1;
  };
  return ok({ xs, ys, path, inside });
}

/** Cheapest closed 4-connected path of n nodes with node k within `reach` cells of target k, or undefined. */
function trace(
  targets: readonly P2[],
  x0: number,
  y0: number,
  h: number,
  reach: number,
): { cost: number; path: [number, number][] } | undefined {
  const n = targets.length;
  const near = (p: P2): Candidate[] => {
    const gi = (p[0] - x0) / h;
    const gj = (p[1] - y0) / h;
    const out: Candidate[] = [];
    const r = Math.ceil(reach);
    for (let i = Math.floor(gi) - r; i <= Math.ceil(gi) + r; i++) {
      for (let j = Math.floor(gj) - r; j <= Math.ceil(gj) + r; j++) {
        const d2 = (i - gi) * (i - gi) + (j - gj) * (j - gj);
        if (d2 <= reach * reach) out.push({ i, j, cost: d2 });
      }
    }
    return out;
  };
  const cands = targets.map(near);
  const first = cands[0] as Candidate[];
  let bestCost = Infinity;
  let bestPath: [number, number][] | undefined;
  for (const start of first) {
    let layer = [{ at: start, total: start.cost, from: -1 }];
    const trail: { at: Candidate; total: number; from: number }[][] = [layer];
    for (let k = 1; k < n && layer.length > 0; k++) {
      const next: { at: Candidate; total: number; from: number }[] = [];
      for (const c of cands[k] as Candidate[]) {
        let low = Infinity;
        let from = -1;
        layer.forEach((p, q) => {
          if (Math.abs(p.at.i - c.i) + Math.abs(p.at.j - c.j) !== 1) return;
          if (p.total < low) {
            low = p.total;
            from = q;
          }
        });
        if (from >= 0) next.push({ at: c, total: low + c.cost, from });
      }
      layer = next;
      trail.push(layer);
    }
    if (layer.length === 0) continue;
    let pick = -1;
    let cost = Infinity;
    layer.forEach((p, q) => {
      if (Math.abs(p.at.i - start.i) + Math.abs(p.at.j - start.j) !== 1) return;
      if (p.total < cost) {
        cost = p.total;
        pick = q;
      }
    });
    if (pick < 0 || cost >= bestCost) continue;
    const path: [number, number][] = new Array(n);
    for (let k = n - 1; k >= 0; k--) {
      const node = (trail[k] as { at: Candidate; from: number }[])[pick] as {
        at: Candidate;
        from: number;
      };
      path[k] = [node.at.i, node.at.j];
      pick = node.from;
    }
    const seen = new Set(path.map((p) => `${p[0]},${p[1]}`));
    if (seen.size !== n) continue;
    bestCost = cost;
    bestPath = path;
  }
  return bestPath === undefined ? undefined : { cost: bestCost, path: bestPath };
}

const SMOOTH_DEPTH = 5;
const SMOOTH_PASSES = 40;

/**
 * Relaxes the staircase away. The path nodes, the lattice nodes within `SMOOTH_DEPTH` edges inside it and the strip's
 * blend layers move together under plain neighbour averaging, so the strip's shear spreads over the belt instead of
 * landing on its last row. The loop, the boundary row and the hole blocks stay fixed. Rewrites `layers` (the strip's
 * node positions, last layer = the path) and returns the new position of each moved lattice node by `i * columns + j`.
 */
export function smoothDisc(
  disc: DiscGrid,
  layers: P2[][],
  inBlock: (i: number, j: number) => boolean,
): Map<number, P2> {
  const { xs, ys, path } = disc;
  const m = ys.length;
  const key = (i: number, j: number): number => i * m + j;
  const live = (i: number, j: number): boolean => disc.inside(i, j) && !inBlock(i, j);
  const dirs: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const linked = (i: number, j: number, di: number, dj: number): boolean => {
    if (di === 0) return live(i - 1, Math.min(j, j + dj)) || live(i, Math.min(j, j + dj));
    return live(Math.min(i, i + di), j - 1) || live(Math.min(i, i + di), j);
  };
  const onBlock = (i: number, j: number): boolean =>
    inBlock(i, j) || inBlock(i - 1, j) || inBlock(i, j - 1) || inBlock(i - 1, j - 1);
  const pos = new Map<number, P2>();
  const at = (i: number, j: number): P2 => pos.get(key(i, j)) ?? [xs[i] as number, ys[j] as number];
  const last = layers.length - 1;
  const onPath = new Map<number, number>();
  path.forEach((p, k) => {
    onPath.set(key(p[0], p[1]), k);
  });
  const free = new Set<number>(onPath.keys());
  let frontier = [...path];
  for (let d = 0; d < SMOOTH_DEPTH; d++) {
    const next: [number, number][] = [];
    for (const [i, j] of frontier) {
      for (const [di, dj] of dirs) {
        const a = i + di;
        const b = j + dj;
        if (!linked(i, j, di, dj) || free.has(key(a, b)) || onBlock(a, b)) continue;
        free.add(key(a, b));
        next.push([a, b]);
      }
    }
    frontier = next;
  }
  const n = path.length;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    for (let l = 2; l < last; l++) {
      const layer = layers[l] as P2[];
      const below = layers[l - 1] as P2[];
      const above = layers[l + 1] as P2[];
      for (let k = 0; k < n; k++) {
        const a = layer[(k + n - 1) % n] as P2;
        const b = layer[(k + 1) % n] as P2;
        const c = below[k] as P2;
        const d = l + 1 === last ? at(...(path[k] as [number, number])) : (above[k] as P2);
        layer[k] = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4];
      }
    }
    for (const id of free) {
      const i = Math.floor(id / m);
      const j = id % m;
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (const [di, dj] of dirs) {
        if (!linked(i, j, di, dj)) continue;
        const q = at(i + di, j + dj);
        sx += q[0];
        sy += q[1];
        count++;
      }
      const k = onPath.get(id);
      if (k !== undefined && last >= 2) {
        const q = (layers[last - 1] as P2[])[k] as P2;
        sx += q[0];
        sy += q[1];
        count++;
      }
      if (count > 0) pos.set(id, [sx / count, sy / count]);
    }
  }
  for (let k = 0; k < n; k++) (layers[last] as P2[])[k] = at(...(path[k] as [number, number]));
  return pos;
}
