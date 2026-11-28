import { curvePoint, pcurvePoint } from '../../curves';
import { faceLoops } from '../../faces';
import { surfaceDomain, surfacePoint } from '../../surfaces';
import { inTrim, type TrimLoop } from '../../trim';
import type { Coedge, Edge, Shape, Surface } from '../../types';
import { dist3, type P2, type P3 } from '../../vec';

/** A tiny seeded generator (mulberry32) so every corpus is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RING_SAMPLES = 160;

function loopsOf(shape: Shape, f: number): TrimLoop[] {
  const { outer, holes } = faceLoops(shape, f);
  const ring = (coedges: readonly number[], isOuter: boolean): TrimLoop => {
    const points: P2[] = [];
    for (const c of coedges) {
      const co = shape.coedges[c] as Coedge;
      const e = shape.edges[co.edge] as Edge;
      const pts: P2[] = [];
      for (let k = 0; k < RING_SAMPLES; k++)
        pts.push(pcurvePoint(co.pcurve, e.t0 + ((e.t1 - e.t0) * k) / RING_SAMPLES));
      if (co.reversed) pts.reverse();
      points.push(...pts);
    }
    return { points, outer: isOuter };
  };
  return [ring(outer, true), ...holes.map((h) => ring(h, false))];
}

interface FaceGrid {
  readonly surface: Surface;
  readonly loops: readonly TrimLoop[];
  readonly periods: { u: number; v: number };
  readonly du: number;
  readonly dv: number;
  /** In-trim grid nodes with their surface points; independent of the probe, so computed once. */
  readonly nodes: readonly { u: number; v: number; q: P3 }[];
}

function faceGrid(shape: Shape, f: number, grid: number): FaceGrid {
  const surface = shape.surfaces[(shape.faces[f] as Shape['faces'][number]).surface] as Surface;
  const loops = loopsOf(shape, f);
  const dom = surfaceDomain(surface);
  const periods = { u: dom.uPeriod, v: dom.vPeriod };
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const l of loops)
    for (const q of l.points) {
      u0 = Math.min(u0, q[0]);
      u1 = Math.max(u1, q[0]);
      v0 = Math.min(v0, q[1]);
      v1 = Math.max(v1, q[1]);
    }
  const nodes: { u: number; v: number; q: P3 }[] = [];
  for (let i = 0; i <= grid; i++)
    for (let j = 0; j <= grid; j++) {
      const u = u0 + ((u1 - u0) * i) / grid;
      const v = v0 + ((v1 - v0) * j) / grid;
      if (inTrim(loops, [u, v], periods)) nodes.push({ u, v, q: surfacePoint(surface, u, v) });
    }
  return { surface, loops, periods, du: (u1 - u0) / grid, dv: (v1 - v0) / grid, nodes };
}

function zoom(g: FaceGrid, p: P3, seeds: { d: number; u: number; v: number }[]): number {
  let cells = seeds;
  let hu = g.du;
  let hv = g.dv;
  for (let round = 0; round < 4; round++) {
    const next: { d: number; u: number; v: number }[] = [];
    for (const c of cells)
      for (let i = -6; i <= 6; i++)
        for (let j = -6; j <= 6; j++) {
          const u = c.u + (hu * i) / 6;
          const v = c.v + (hv * j) / 6;
          if (!inTrim(g.loops, [u, v], g.periods)) continue;
          next.push({ d: dist3(surfacePoint(g.surface, u, v), p), u, v });
        }
    next.sort((a, b) => a.d - b.d);
    cells = next.slice(0, 3);
    hu /= 6;
    hv /= 6;
  }
  return (cells[0] as { d: number } | undefined)?.d ?? Infinity;
}

function edgeBest(shape: Shape, p: P3): number {
  let best = Infinity;
  for (const e of shape.edges) {
    if (e.curve < 0) continue;
    const c = shape.curves[e.curve] as Shape['curves'][number];
    const n = 4000;
    let bt = e.t0;
    let bd = Infinity;
    for (let k = 0; k <= n; k++) {
      const t = e.t0 + ((e.t1 - e.t0) * k) / n;
      const d = dist3(curvePoint(c, t), p);
      if (d < bd) {
        bd = d;
        bt = t;
      }
    }
    let h = (e.t1 - e.t0) / n;
    for (let round = 0; round < 4; round++) {
      let nb = bt;
      for (let k = -20; k <= 20; k++) {
        const t = Math.min(e.t1, Math.max(e.t0, bt + (h * k) / 10));
        const d = dist3(curvePoint(c, t), p);
        if (d < bd) {
          bd = d;
          nb = t;
        }
      }
      bt = nb;
      h /= 10;
    }
    best = Math.min(best, bd);
  }
  return best;
}

/**
 * Brute-force distance oracle for one shape. Faces: a dense (u, v) grid filtered by an independently
 * sampled trim polygon, then four zoom rounds around the best 3 nodes. Edges: 4000 samples plus zoom.
 * Every candidate is a real surface or curve point, so the oracle can only over-estimate (up to the
 * trim polygon's sagitta, which `edgeBest` makes irrelevant where the minimum lies on a trim curve).
 */
export function bruteForce(shape: Shape, grid = 120): (p: P3) => number {
  const grids = shape.faces.map((_, f) => faceGrid(shape, f, grid));
  return (p) => {
    let best = edgeBest(shape, p);
    for (const g of grids) {
      const seeds = g.nodes
        .map((n) => ({ d: dist3(n.q, p), u: n.u, v: n.v }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      best = Math.min(best, zoom(g, p, seeds));
    }
    return best;
  };
}
