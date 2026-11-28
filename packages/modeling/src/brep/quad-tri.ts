import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import { faceLoops } from './faces';
import type { Coedge, Curve, Face, Shape, Surface } from './types';
import { add3, type P3, scale3, sub3 } from './vec';

/**
 * Planar triangles bounded by three straight edges as three quad patches around one centre point. With edge counts
 * n0, n1, n2 the spoke from the sample of edge k at index y(k-1) has y(k) = (n(k+1) + n(k+2) - n(k)) / 2 samples, so
 * the counts need an even sum and every y(k) >= 1; the corner patches are y(k-1) x y(k) grids that share their
 * spokes. `triRaises` gives the edge floors that make a triangle's counts satisfy this.
 */

type Step<T> = Result<T, string>;

export interface TriHost {
  readonly shape: Shape;
  readonly edgeSamples: (edge: number) => Step<number[]>;
  readonly position: (id: number) => P3;
  readonly vertex: (p: P3) => number;
}

function triangleEdges(shape: Shape, f: number): number[] | undefined {
  const face = shape.faces[f] as Face;
  if ((shape.surfaces[face.surface] as Surface).kind !== 'plane') return undefined;
  const { outer, holes } = faceLoops(shape, f);
  if (outer.length !== 3 || holes.length > 0) return undefined;
  const edges: number[] = [];
  for (const c of outer) {
    const e = shape.edges[(shape.coedges[c] as Coedge).edge];
    if (e === undefined || e.curve < 0 || (shape.curves[e.curve] as Curve).kind !== 'line') {
      return undefined;
    }
    edges.push((shape.coedges[c] as Coedge).edge);
  }
  return edges;
}

/** Edge floors that give every straight planar triangle counts the centre split can use; empty when all fit. */
export function triRaises(shape: Shape, counts: ReadonlyMap<number, number>): Map<number, number> {
  const raises = new Map<number, number>();
  for (let f = 0; f < shape.faces.length; f++) {
    const edges = triangleEdges(shape, f);
    if (edges === undefined) continue;
    const n = edges.map((e) => raises.get(e) ?? counts.get(e) ?? 0);
    if (n.some((x) => x <= 0)) continue;
    // Raise the shortest edge by 2 (parity stays) until the longest is at most the other two minus 2.
    for (let guard = 0; guard < 64; guard++) {
      const sorted = n.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
      const [lo, mid, hi] = sorted as [
        readonly [number, number],
        readonly [number, number],
        readonly [number, number],
      ];
      if (hi[0] <= lo[0] + mid[0] - 2) break;
      n[lo[1]] = lo[0] + 2;
      raises.set(edges[lo[1]] as number, n[lo[1]] as number);
    }
  }
  return raises;
}

/** Sample ids of the straight run from sample `a` to sample `b` in `m` steps, new vertices between. */
export function sampleLine(
  host: Pick<TriHost, 'position' | 'vertex'>,
  a: number,
  b: number,
  m: number,
): number[] {
  const pa = host.position(a);
  const pb = host.position(b);
  const out = [a];
  for (let k = 1; k < m; k++) out.push(host.vertex(add3(pa, scale3(sub3(pb, pa), k / m))));
  out.push(b);
  return out;
}

/** Quads of one triangle face wound with its outline, or an error when its counts do not fit the split. */
export function triQuads(host: TriHost, f: number): Step<number[][]> {
  const { shape } = host;
  const edges = triangleEdges(shape, f);
  if (edges === undefined) return err('tri-shape');
  const { outer } = faceLoops(shape, f);
  const seq: number[][] = [];
  for (let k = 0; k < 3; k++) {
    const sampled = host.edgeSamples(edges[k] as number);
    if (!sampled.ok) return sampled;
    const co = shape.coedges[outer[k] as number] as Coedge;
    seq.push(co.reversed ? sampled.value.slice().reverse() : sampled.value.slice());
  }
  return splitTriangle(host, seq);
}

/**
 * Quads of a triangle whose three sides are sample id runs `seq[k]` joined end to start (side k ends where side k+1
 * begins); the runs share their corner samples. Errors when the run lengths do not fit the centre split.
 */
export function splitTriangle(
  host: Pick<TriHost, 'position' | 'vertex'>,
  seq: readonly (readonly number[])[],
): Step<number[][]> {
  const n = seq.map((s) => s.length - 1);
  const sum = (n[0] as number) + (n[1] as number) + (n[2] as number);
  if (sum % 2 !== 0) return err('tri-odd');
  const y = [0, 1, 2].map(
    (k) => ((n[(k + 1) % 3] as number) + (n[(k + 2) % 3] as number) - (n[k] as number)) / 2,
  );
  if (y.some((v) => v < 1)) return err('tri-inequality');
  // Edge k splits at p(k) = y(k-1) from its start; the sample is shared with patch k and patch k+1.
  const mid = [0, 1, 2].map((k) => (seq[k] as number[])[y[(k + 2) % 3] as number] as number);
  const centre = host.vertex(
    scale3(
      add3(
        add3(host.position(mid[0] as number), host.position(mid[1] as number)),
        host.position(mid[2] as number),
      ),
      1 / 3,
    ),
  );
  const spokes = [0, 1, 2].map((k) => sampleLine(host, mid[k] as number, centre, y[k] as number));
  const quads: number[][] = [];
  for (let k = 0; k < 3; k++) {
    const prev = (k + 2) % 3;
    const patch = patchQuads(
      host,
      (seq[k] as number[]).slice(0, (y[prev] as number) + 1),
      spokes[k] as number[],
      spokes[prev] as number[],
      (seq[prev] as number[]).slice(y[(prev + 2) % 3] as number).reverse(),
    );
    if (!patch.ok) return patch;
    pushAll(quads, patch.value);
  }
  return ok(quads);
}

/**
 * Quads of one four-sided patch whose boundary samples are given bottom and top left to right, left and right bottom
 * to top, sharing their corner samples; the interior is the transfinite blend of the four sides.
 */
export function patchQuads(
  host: Pick<TriHost, 'position' | 'vertex'>,
  bottom: readonly number[],
  right: readonly number[],
  top: readonly number[],
  left: readonly number[],
): Step<number[][]> {
  const nu = bottom.length - 1;
  const nv = right.length - 1;
  if (top.length - 1 !== nu || left.length - 1 !== nv) return err('tri-patch-mismatch');
  const at = (ids: readonly number[], i: number): P3 => host.position(ids[i] as number);
  const corner = [at(bottom, 0), at(bottom, nu), at(right, nv), at(left, nv)] as [P3, P3, P3, P3];
  const grid: number[][] = [];
  for (let i = 0; i <= nu; i++) {
    grid.push([]);
    for (let j = 0; j <= nv; j++) {
      const row = grid[i] as number[];
      if (j === 0) row.push(bottom[i] as number);
      else if (j === nv) row.push(top[i] as number);
      else if (i === 0) row.push(left[j] as number);
      else if (i === nu) row.push(right[j] as number);
      else {
        const u = i / nu;
        const v = j / nv;
        const blend = add3(
          add3(scale3(at(bottom, i), 1 - v), scale3(at(top, i), v)),
          add3(scale3(at(left, j), 1 - u), scale3(at(right, j), u)),
        );
        const bil = add3(
          add3(scale3(corner[0], (1 - u) * (1 - v)), scale3(corner[1], u * (1 - v))),
          add3(scale3(corner[2], u * v), scale3(corner[3], (1 - u) * v)),
        );
        row.push(host.vertex(sub3(blend, bil)));
      }
    }
  }
  const quads: number[][] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      quads.push([
        (grid[i] as number[])[j] as number,
        (grid[i + 1] as number[])[j] as number,
        (grid[i + 1] as number[])[j + 1] as number,
        (grid[i] as number[])[j + 1] as number,
      ]);
    }
  }
  return ok(quads);
}
