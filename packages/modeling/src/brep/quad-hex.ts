import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf, pushAll } from '../arrays';
import { faceLoops } from './faces';
import { analyzeRect } from './quad-rect';
import { patchQuads, sampleLine, type TriHost } from './quad-tri';
import type { Coedge, Curve, Face, Shape, Surface } from './types';
import { add3, cross3, dot3, type P3, scale3, sub3, unit3 } from './vec';

/**
 * Convex planar hexagons bounded by six straight edges whose solved sample counts already fit a quad layout, in the
 * best of two forms: one patch whose four sides are runs of consecutive edges (opposite run totals equal; a flat
 * trapezoid with chamfers takes this form), or three patches around a centre joining every second vertex (opposite
 * edges equal). Counts are never raised for a hexagon: faces whose counts fit neither form keep the generic route.
 * Rectilinear lattices keep their own owner.
 */

type Step<T> = Result<T, string>;

/** Outline edges of a convex straight-sided hexagon in loop order, or undefined. */
export function hexEdges(shape: Shape, f: number): number[] | undefined {
  const surface = shape.surfaces[(shape.faces[f] as Face).surface] as Surface;
  if (surface.kind !== 'plane') return undefined;
  const { outer, holes } = faceLoops(shape, f);
  if (outer.length !== 6 || holes.length > 0) return undefined;
  const normal = unit3(surface.frame.z);
  const dirs: P3[] = [];
  const edges: number[] = [];
  for (const c of outer) {
    const co = shape.coedges[c] as Coedge;
    const e = shape.edges[co.edge];
    if (e === undefined || e.curve < 0 || (shape.curves[e.curve] as Curve).kind !== 'line') {
      return undefined;
    }
    const a = (shape.vertices[co.reversed ? e.v1 : e.v0] as { p: P3 }).p;
    const b = (shape.vertices[co.reversed ? e.v0 : e.v1] as { p: P3 }).p;
    dirs.push(sub3(b, a));
    edges.push(co.edge);
  }
  for (let k = 0; k < 6; k++) {
    if (dot3(cross3(dirs[k] as P3, dirs[(k + 1) % 6] as P3), normal) <= 0) return undefined;
  }
  return analyzeRect(shape, f) === undefined ? edges : undefined;
}

/**
 * Quads of one hexagon face wound with its outline, or an error when no form reaches `floor`, the least acceptable
 * worst-quad scaled Jacobian.
 */
export function hexQuads(
  host: TriHost,
  f: number,
  quality: (ids: readonly number[]) => number,
  floor: number,
): Step<number[][]> {
  const { shape } = host;
  const edges = hexEdges(shape, f);
  if (edges === undefined) return err('hex-shape');
  const { outer } = faceLoops(shape, f);
  const seq: number[][] = [];
  for (let k = 0; k < 6; k++) {
    const sampled = host.edgeSamples(edges[k] as number);
    if (!sampled.ok) return sampled;
    const co = shape.coedges[outer[k] as number] as Coedge;
    seq.push(co.reversed ? sampled.value.slice().reverse() : sampled.value.slice());
  }
  let best: number[][] | undefined;
  let bestQuality = floor;
  for (const quads of [...runPatches(host, seq), ...centreSplits(host, seq)]) {
    const worst = minOf(quads.map((q) => quality(q)));
    if (worst >= bestQuality) {
      best = quads;
      bestQuality = worst;
    }
  }
  return best === undefined ? err('hex-no-layout') : ok(best);
}

/** One-patch layouts: the outline cut at four vertices into runs whose opposite sample totals agree. */
function runPatches(host: TriHost, seq: readonly number[][]): number[][][] {
  const out: number[][][] = [];
  const run = (from: number, to: number): number[] => {
    const ids: number[] = [];
    for (let k = from; k !== to; k = (k + 1) % 6) {
      const part = seq[k] as number[];
      pushAll(ids, ids.length === 0 ? part : part.slice(1));
    }
    return ids;
  };
  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) {
      for (let c = b + 1; c < 6; c++) {
        for (let d = c + 1; d < 6; d++) {
          const sides = [run(a, b), run(b, c), run(c, d), run(d, a)];
          if (sides[0]?.length !== sides[2]?.length || sides[1]?.length !== sides[3]?.length)
            continue;
          const patch = patchQuads(
            host,
            sides[0] as number[],
            sides[1] as number[],
            (sides[2] as number[]).slice().reverse(),
            (sides[3] as number[]).slice().reverse(),
          );
          if (patch.ok) out.push(patch.value);
        }
      }
    }
  }
  return out;
}

/** Three-patch layouts around a centre, for each of the two vertex parities. */
function centreSplits(host: TriHost, seq: readonly number[][]): number[][][] {
  const n = seq.map((s) => s.length - 1);
  for (let k = 0; k < 3; k++) if (n[k] !== n[k + 3]) return [];
  const out: number[][][] = [];
  for (const shift of [0, 1]) {
    const run = (k: number) => seq[(k + shift) % 6] as number[];
    const start = (k: number) => run(k)[0] as number;
    const centre = host.vertex(
      scale3(
        add3(add3(host.position(start(0)), host.position(start(2))), host.position(start(4))),
        1 / 3,
      ),
    );
    // spoke[k] runs from the start of run 2k to the centre, with the count of run 2k + 1.
    const spokes = [0, 1, 2].map((k) =>
      sampleLine(host, start(2 * k), centre, run(2 * k + 1).length - 1),
    );
    const quads: number[][] = [];
    let fits = true;
    for (let k = 0; k < 3 && fits; k++) {
      const patch = patchQuads(
        host,
        run(2 * k),
        run(2 * k + 1),
        (spokes[(k + 1) % 3] as number[]).slice().reverse(),
        spokes[k] as number[],
      );
      if (patch.ok) pushAll(quads, patch.value);
      else fits = false;
    }
    if (fits) out.push(quads);
  }
  return out;
}
