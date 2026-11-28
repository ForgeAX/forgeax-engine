import { surfacePoint } from '../surfaces';
import type { Surface } from '../types';
import type { P2, P3 } from '../vec';
import type { TrimIndex } from './trim-index';

/** A polyline traced on one face: `uv` and the surface points at those parameters. */
export interface FaceCurve {
  readonly face: number;
  readonly uv: readonly P2[];
  readonly points: readonly P3[];
  readonly closed: boolean;
}

export interface FaceContours {
  readonly curves: FaceCurve[];
  /** True when the scalar field is within `flatTol` of zero at every examined node (the face lies in the level set). */
  readonly flat: boolean;
  /** Largest |value| over the emitted vertices (bisected onto the level set, so near rounding). */
  readonly residual: number;
  /**
   * Largest |value| at the parameter midpoint of every chord: a sag indicator of the polyline
   * between vertices (not a proven bound); it shrinks with `res`.
   */
  readonly chordResidual: number;
}

const BISECT = 44;

function lerp(a: P2, b: P2, t: number): P2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * The zero level set of `value(u, v)` over the trimmed region of one face, by marching squares on a
 * `res x res` grid of the trim's parameter box. Every crossing vertex is bisected onto the level set
 * along its grid edge; the polylines are cut where they leave the trim (the cut is bisected too).
 * Cells that the trim cannot touch are never evaluated. A level-set component that fits inside
 * one grid cell (a loop smaller than `extent / res`) can be missed; that is the stated blind spot.
 */
export function contourFace(
  face: number,
  surface: Surface,
  trim: TrimIndex,
  value: (u: number, v: number) => number,
  res: number,
  flatTol: number,
): FaceContours {
  const [u0, v0] = trim.lo;
  const [u1, v1] = trim.hi;
  const nu = res;
  const nv = res;
  const du = (u1 - u0) / nu;
  const dv = (v1 - v0) / nv;
  const nodes = new Float64Array((nu + 1) * (nv + 1)).fill(Number.NaN);
  const at = (i: number, j: number): number => {
    const k = j * (nu + 1) + i;
    let x = nodes[k] as number;
    if (Number.isNaN(x)) {
      x = value(u0 + i * du, v0 + j * dv);
      nodes[k] = x;
    }
    return x;
  };
  const edgePoints = new Map<number, P2>();
  const hKey = (i: number, j: number): number => j * nu + i;
  const vBase = (nv + 1) * nu;
  const vKey = (i: number, j: number): number => vBase + i * nv + j;
  const cross = (key: number, a: P2, b: P2, fa: number): number => {
    if (!edgePoints.has(key)) {
      let lo = 0;
      let hi = 1;
      let flo = fa;
      for (let n = 0; n < BISECT; n++) {
        const mid = (lo + hi) / 2;
        const p = lerp(a, b, mid);
        const fm = value(p[0], p[1]);
        if (fm > 0 === flo > 0) {
          lo = mid;
          flo = fm;
        } else hi = mid;
      }
      edgePoints.set(key, lerp(a, b, (lo + hi) / 2));
    }
    return key;
  };

  const segments: [number, number][] = [];
  let flat = true;
  let examined = 0;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      if (!trim.mayTouch([u0 + i * du, v0 + j * dv], [u0 + (i + 1) * du, v0 + (j + 1) * dv]))
        continue;
      const f0 = at(i, j);
      const f1 = at(i + 1, j);
      const f2 = at(i + 1, j + 1);
      const f3 = at(i, j + 1);
      examined++;
      if (Math.max(Math.abs(f0), Math.abs(f1), Math.abs(f2), Math.abs(f3)) > flatTol) flat = false;
      const s = [f0 > 0, f1 > 0, f2 > 0, f3 > 0];
      const p0: P2 = [u0 + i * du, v0 + j * dv];
      const p1: P2 = [u0 + (i + 1) * du, v0 + j * dv];
      const p2: P2 = [u0 + (i + 1) * du, v0 + (j + 1) * dv];
      const p3: P2 = [u0 + i * du, v0 + (j + 1) * dv];
      const e: (number | undefined)[] = [
        s[0] !== s[1] ? cross(hKey(i, j), p0, p1, f0) : undefined,
        s[1] !== s[2] ? cross(vKey(i + 1, j), p1, p2, f1) : undefined,
        s[3] !== s[2] ? cross(hKey(i, j + 1), p3, p2, f3) : undefined,
        s[0] !== s[3] ? cross(vKey(i, j), p0, p3, f0) : undefined,
      ];
      const hit = e.filter((x): x is number => x !== undefined);
      if (hit.length === 2) segments.push([hit[0] as number, hit[1] as number]);
      else if (hit.length === 4) {
        const centre = (f0 + f1 + f2 + f3) / 4 > 0;
        if (centre === s[0]) {
          segments.push([e[0] as number, e[1] as number], [e[2] as number, e[3] as number]);
        } else {
          segments.push([e[3] as number, e[0] as number], [e[1] as number, e[2] as number]);
        }
      }
    }
  if (examined === 0) flat = false;

  const curves: FaceCurve[] = [];
  let residual = 0;
  let chordResidual = 0;
  for (const chain of joinSegments(segments)) {
    const uv: P2[] = chain.keys.map((k) => edgePoints.get(k) as P2);
    for (const run of trimRuns(uv, chain.closed, trim)) {
      const n = run.uv.length;
      for (let i = 0; i < n; i++) {
        const p = run.uv[i] as P2;
        residual = Math.max(residual, Math.abs(value(p[0], p[1])));
        if (i + 1 < n || run.closed) {
          const m = lerp(p, run.uv[(i + 1) % n] as P2, 0.5);
          chordResidual = Math.max(chordResidual, Math.abs(value(m[0], m[1])));
        }
      }
      const points = run.uv.map((p) => surfacePoint(surface, p[0], p[1]));
      curves.push({ face, uv: run.uv, points, closed: run.closed });
    }
  }
  return { curves, flat, residual, chordResidual };
}

interface Chain {
  readonly keys: number[];
  readonly closed: boolean;
}

function joinSegments(segments: readonly [number, number][]): Chain[] {
  const at = new Map<number, number[]>();
  segments.forEach((s, k) => {
    for (const key of s) {
      const list = at.get(key);
      if (list === undefined) at.set(key, [k]);
      else list.push(k);
    }
  });
  const used = new Uint8Array(segments.length);
  const walk = (start: number, from: number): number[] => {
    const keys = [from];
    let key = from;
    let k = start;
    for (;;) {
      used[k] = 1;
      const s = segments[k] as [number, number];
      key = s[0] === key ? s[1] : s[0];
      keys.push(key);
      const next = (at.get(key) as number[]).find((x) => !used[x]);
      if (next === undefined) break;
      k = next;
    }
    return keys;
  };
  const out: Chain[] = [];
  for (const [key, list] of at)
    if (list.length === 1 && !used[list[0] as number])
      out.push({ keys: walk(list[0] as number, key), closed: false });
  segments.forEach((s, k) => {
    if (!used[k]) {
      const keys = walk(k, s[0]);
      out.push({ keys: keys.slice(0, -1), closed: true });
    }
  });
  return out;
}

interface Run {
  readonly uv: P2[];
  readonly closed: boolean;
}

/** Split a polyline at its trim crossings; an entirely interior closed polyline stays closed. */
function trimRuns(uv: readonly P2[], closed: boolean, trim: TrimIndex): Run[] {
  const inside = uv.map((p) => trim.contains(p[0], p[1]));
  if (inside.every(Boolean)) return [{ uv: [...uv], closed }];
  if (!inside.some(Boolean)) return [];
  const edge = (a: P2, b: P2, aIn: boolean): P2 => {
    let lo = 0;
    let hi = 1;
    for (let n = 0; n < BISECT; n++) {
      const mid = (lo + hi) / 2;
      const p = lerp(a, b, mid);
      if (trim.contains(p[0], p[1]) === aIn) lo = mid;
      else hi = mid;
    }
    return lerp(a, b, aIn ? lo : hi);
  };
  const n = uv.length;
  const start = closed ? inside.findIndex((x) => !x) : 0;
  const order = closed ? Array.from({ length: n + 1 }, (_, k) => (start + k) % n) : [...uv.keys()];
  const runs: Run[] = [];
  let cur: P2[] = [];
  for (let k = 0; k < order.length; k++) {
    const i = order[k] as number;
    const p = uv[i] as P2;
    const here = inside[i] as boolean;
    if (k > 0) {
      const prev = order[k - 1] as number;
      const was = inside[prev] as boolean;
      if (was !== here) {
        const a = uv[prev] as P2;
        if (was) cur.push(edge(a, p, true));
        else cur = [edge(p, a, true)];
      }
    }
    if (here) cur.push(p);
    else if (cur.length > 1) {
      runs.push({ uv: cur, closed: false });
      cur = [];
    } else cur = [];
  }
  if (cur.length > 1) runs.push({ uv: cur, closed: false });
  return runs;
}
