import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import { length, sub, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';

const distanceBetween = (p: Tuple3, q: Tuple3) => length(sub(p, q));

/** Weight profile over the normalized distance `x = 1 - d / radius`. */
export type FalloffCurve = 'smooth' | 'linear' | 'sharp' | 'constant';

/** `euclidean`: straight-line distance; `connected`: shortest path along edges (surface-geodesic). */
export type FalloffDistance = 'euclidean' | 'connected';

/**
 * Soft selection: selected vertices have weight 1; other vertices closer than `radius`
 * to a selected vertex get `curve(1 - d / radius)`, all others 0.
 */
export interface Falloff {
  /** Influence radius in meters (> 0). */
  readonly radius: number;
  /** Default 'smooth' (3x^2 - 2x^3). */
  readonly curve?: FalloffCurve;
  /** Default 'euclidean'. */
  readonly distance?: FalloffDistance;
}

const CURVES: Readonly<Record<FalloffCurve, (x: number) => number>> = {
  smooth: (x) => x * x * (3 - 2 * x),
  linear: (x) => x,
  sharp: (x) => x * x,
  constant: () => 1,
};

export function checkFalloff(falloff: Falloff): Result<Required<Falloff>, ModelingError> {
  const radius = falloff?.radius;
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    return err(
      modelingError('model-invalid-argument', 'falloff.radius is a finite length > 0', {
        radius,
      }),
    );
  }
  const curve = falloff.curve ?? 'smooth';
  if (!Object.hasOwn(CURVES, curve)) {
    return err(
      modelingError(
        'model-invalid-argument',
        "falloff.curve is 'smooth', 'linear', 'sharp' or 'constant'",
        { curve },
      ),
    );
  }
  const distance = falloff.distance ?? 'euclidean';
  if (distance !== 'euclidean' && distance !== 'connected') {
    return err(
      modelingError('model-invalid-argument', "falloff.distance is 'euclidean' or 'connected'", {
        distance,
      }),
    );
  }
  return ok({ radius, curve, distance });
}

/** Distance of every vertex closer than `radius` to a seed (seeds at 0). */
function euclidean(mesh: EditMesh, seeds: readonly number[], radius: number): Map<number, number> {
  const cell = (x: number) => Math.floor(x / radius);
  const key = (i: number, j: number, k: number) => `${i},${j},${k}`;
  const grid = new Map<string, number[]>();
  for (const s of seeds) {
    const p = mesh.position(s);
    const k = key(cell(p[0]), cell(p[1]), cell(p[2]));
    const list = grid.get(k);
    if (list === undefined) grid.set(k, [s]);
    else list.push(s);
  }
  const out = new Map<number, number>();
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    const [ci, cj, ck] = [cell(p[0]), cell(p[1]), cell(p[2])];
    let best = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          for (const s of grid.get(key(ci + di, cj + dj, ck + dk)) ?? []) {
            const q = mesh.position(s);
            const d = distanceBetween(p, q);
            if (d < best) best = d;
          }
        }
      }
    }
    if (best < radius) out.set(v, best);
  }
  return out;
}

/** Multi-source Dijkstra along edges, cut off at `radius` (ties broken by vertex id). */
function connected(mesh: EditMesh, seeds: readonly number[], radius: number): Map<number, number> {
  const neighbours = new Map<number, number[]>();
  for (const e of mesh.edges()) {
    const [a, b] = mesh.edgeVertices(e);
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = neighbours.get(x);
      if (list === undefined) neighbours.set(x, [y]);
      else list.push(y);
    }
  }
  const distance = new Map<number, number>();
  const heap: [number, number][] = [];
  const less = (x: [number, number], y: [number, number]) =>
    x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i] as [number, number], heap[parent] as [number, number])) break;
      [heap[i], heap[parent]] = [heap[parent] as [number, number], heap[i] as [number, number]];
      i = parent;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0] as [number, number];
    const last = heap.pop() as [number, number];
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l] as [number, number], heap[m] as [number, number]))
          m = l;
        if (r < heap.length && less(heap[r] as [number, number], heap[m] as [number, number]))
          m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m] as [number, number], heap[i] as [number, number]];
        i = m;
      }
    }
    return top;
  };
  for (const s of seeds) {
    distance.set(s, 0);
    push([0, s]);
  }
  const done = new Set<number>();
  while (heap.length > 0) {
    const [d, v] = pop();
    if (done.has(v)) continue;
    done.add(v);
    const p = mesh.position(v);
    for (const w of neighbours.get(v) ?? []) {
      const q = mesh.position(w);
      const next = d + distanceBetween(p, q);
      if (next >= radius || next >= (distance.get(w) ?? Infinity)) continue;
      distance.set(w, next);
      push([next, w]);
    }
  }
  return distance;
}

/**
 * Soft-selection weights: 1 at the seeds, `curve(1 - d / radius)` for vertices closer
 * than `radius`, absent beyond it. Without a falloff only the seeds weigh (1).
 */
export function falloffWeights(
  mesh: EditMesh,
  seeds: readonly number[],
  falloff: Required<Falloff> | undefined,
): Map<number, number> {
  if (falloff === undefined) return new Map(seeds.map((s) => [s, 1]));
  const distances =
    falloff.distance === 'connected'
      ? connected(mesh, seeds, falloff.radius)
      : euclidean(mesh, seeds, falloff.radius);
  const curve = CURVES[falloff.curve];
  const out = new Map<number, number>();
  for (const [v, d] of [...distances].sort((a, b) => a[0] - b[0])) {
    out.set(v, d === 0 ? 1 : curve(1 - d / falloff.radius));
  }
  for (const s of seeds) out.set(s, 1);
  return out;
}
