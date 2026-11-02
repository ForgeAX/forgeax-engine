import type { Tuple3 } from '../geom';

interface MeshLike {
  faces(): Iterable<number>;
  faceVertices(f: number): readonly number[];
  position(v: number): Tuple3;
  readonly labelNames: readonly unknown[];
  readonly fLabel: ArrayLike<number>;
}

export interface Measured {
  readonly editMesh: MeshLike;
}

export interface Tube {
  readonly origin: Tuple3;
  readonly axis: Tuple3;
  readonly radius: number;
}

type V = Tuple3;
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V): V => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));

/**
 * Rolling-ball centres between a fat tube and a thin branch: the locus at distance
 * radius + rho from both axes, on the branch side, sampled around the thin tube.
 */
export function spine(fat: Tube, thin: Tube, rho: number, samples = 20000): V[] {
  const u = norm(thin.axis);
  const a = norm(fat.axis);
  const helper: V = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm(cross(u, helper));
  const e2 = cross(u, e1);
  const out: V[] = [];
  const target = (fat.radius + rho) ** 2;
  for (let i = 0; i < samples; i++) {
    const th = (2 * Math.PI * i) / samples;
    const ring = mul(add(mul(e1, Math.cos(th)), mul(e2, Math.sin(th))), thin.radius + rho);
    const p0 = add(thin.origin, ring);
    const w0 = sub(p0, fat.origin);
    const uPerp = sub(u, mul(a, dot(u, a)));
    const w0Perp = sub(w0, mul(a, dot(w0, a)));
    const qa = dot(uPerp, uPerp);
    const qb = 2 * dot(uPerp, w0Perp);
    const qc = dot(w0Perp, w0Perp) - target;
    const disc = qb * qb - 4 * qa * qc;
    if (qa < 1e-12 || disc < 0) continue;
    const t = (-qb + Math.sqrt(disc)) / (2 * qa);
    out.push(add(p0, mul(u, t)));
  }
  return out;
}

export function weldVertices(model: Measured): V[] {
  const mesh = model.editMesh;
  const seen = new Set<number>();
  const out: V[] = [];
  for (const f of mesh.faces()) {
    if (!String(mesh.labelNames[mesh.fLabel[f] as number]).startsWith('weld:')) continue;
    for (const v of mesh.faceVertices(f)) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(mesh.position(v) as V);
    }
  }
  return out;
}

/** Largest |distance to the spine - rho| / rho over weld vertices that lie in the fillet band. */
export function spineDeviation(model: Measured, centres: readonly V[], rho: number): number {
  return Math.max(0, ...spineDeviations(model, centres, rho));
}

export function spineDeviations(model: Measured, centres: readonly V[], rho: number): number[] {
  const all: number[] = [];
  for (const p of weldVertices(model)) {
    let d = Infinity;
    for (let i = 0; i < centres.length; i++) {
      d = Math.min(d, Math.hypot(...sub(p, centres[i] as V)));
    }
    if (d > 2 * rho) continue;
    all.push(Math.abs(d - rho) / rho);
  }
  return all;
}

function kasa(pts: readonly [number, number][]): number | undefined {
  if (pts.length < 3) return undefined;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, pts.length],
  ];
  const b = [sxz, syz, sz];
  const det = (M: number[][]) =>
    ((M[0] as number[])[0] as number) *
      (((M[1] as number[])[1] as number) * ((M[2] as number[])[2] as number) -
        ((M[1] as number[])[2] as number) * ((M[2] as number[])[1] as number)) -
    ((M[0] as number[])[1] as number) *
      (((M[1] as number[])[0] as number) * ((M[2] as number[])[2] as number) -
        ((M[1] as number[])[2] as number) * ((M[2] as number[])[0] as number)) +
    ((M[0] as number[])[2] as number) *
      (((M[1] as number[])[0] as number) * ((M[2] as number[])[1] as number) -
        ((M[1] as number[])[1] as number) * ((M[2] as number[])[0] as number));
  const D = det(A);
  if (Math.abs(D) < 1e-30) return undefined;
  const sol = [0, 1, 2].map(
    (c) => det(A.map((row, r) => row.map((v, k) => (k === c ? (b[r] as number) : v)))) / D,
  );
  const cx = (sol[0] as number) / 2;
  const cy = (sol[1] as number) / 2;
  return Math.sqrt((sol[2] as number) + cx * cx + cy * cy);
}

/**
 * Circle fits of the weld surface in planes normal to the spine at evenly spaced stations:
 * the relative radius error (r - rho) / rho of each station that has enough section points.
 */
export function sectionDeviations(
  model: Measured,
  centres: readonly V[],
  rho: number,
  stations = 32,
): number[] {
  const mesh = model.editMesh;
  const segments: [V, V][] = [];
  for (const f of mesh.faces()) {
    if (!String(mesh.labelNames[mesh.fLabel[f] as number]).startsWith('weld:')) continue;
    const loop = Array.from(mesh.faceVertices(f), (v) => mesh.position(v) as V);
    for (let i = 0; i < loop.length; i++)
      segments.push([loop[i] as V, loop[(i + 1) % loop.length] as V]);
  }
  const out: number[] = [];
  for (let s = 0; s < stations; s++) {
    const i = Math.floor((s * centres.length) / stations);
    const c = centres[i] as V;
    const at = (k: number) => centres[(i + k + centres.length) % centres.length] as V;
    const step = Math.max(2, Math.floor(centres.length / 400));
    const tangent = norm(sub(at(step), at(-step)));
    const before = norm(sub(at(0), at(-4 * step)));
    const after = norm(sub(at(4 * step), at(0)));
    if (dot(before, after) < 0.995) continue;
    const helper: V = Math.abs(tangent[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = norm(cross(tangent, helper));
    const e2 = cross(tangent, e1);
    const pts: [number, number][] = [];
    for (const [p, q] of segments) {
      const da = dot(sub(p, c), tangent);
      const db = dot(sub(q, c), tangent);
      if (!((da <= 0 && db > 0) || (da > 0 && db <= 0))) continue;
      const t = da / (da - db);
      const x = sub(add(p, mul(sub(q, p), t)), c);
      if (Math.hypot(...x) > 2 * rho) continue;
      pts.push([dot(x, e1), dot(x, e2)]);
    }
    const r = kasa(pts);
    if (r !== undefined && pts.length >= 4) out.push((r - rho) / rho);
  }
  return out;
}
