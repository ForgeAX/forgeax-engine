import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import type { EditMesh } from '../mesh';
import { measure } from './measure';
import { tessellateSampled } from './tessellate';
import { brepError, type Shape } from './types';
import { cross3, len3, type P3, sub3 } from './vec';

/**
 * Data-only fit of a B-rep shape by simple collider primitives. Nothing here
 * creates a physics collider; consumers decide whether a candidate is usable.
 * Volumes are exact (`measure`); deviations are measured over tessellated
 * surface samples, so they carry the tessellation error of `angle`.
 */
export interface ColliderFitOptions {
  /** Tessellation angle in radians; default pi / 64 (the normals-contract step). */
  readonly angle?: number;
  readonly chord?: number;
}

/**
 * `maxDeviation` is measured over the tessellated surface samples only. It is a sampled
 * diagnostic, not a Hausdorff bound: surface between samples is not measured, and it never
 * bounds the distance from the shape to the primitive. A box reports the largest distance from a
 * sample to its nearest box face, one-sided because the samples lie inside the box they define.
 * A sphere or capsule reports the largest absolute radial error. Do not use it as a guaranteed
 * fit tolerance.
 */
export type ColliderCandidate =
  | {
      readonly kind: 'box';
      readonly center: P3;
      readonly half: P3;
      readonly volumeRatio: number;
      readonly maxDeviation: number;
    }
  | {
      readonly kind: 'sphere';
      readonly center: P3;
      readonly radius: number;
      readonly volumeRatio: number;
      readonly maxDeviation: number;
    }
  | {
      readonly kind: 'capsule';
      readonly center: P3;
      readonly axis: 0 | 1 | 2;
      readonly radius: number;
      readonly halfLength: number;
      readonly volumeRatio: number;
      readonly maxDeviation: number;
    }
  | {
      /** Hull of the surface samples. Deviation is not reported: every sample is a hull generator. */
      readonly kind: 'convex-hull';
      readonly faces: number;
      readonly volumeRatio: number;
    };

export interface ColliderFitReport {
  readonly shapeVolume: number;
  readonly sampleCount: number;
  readonly candidates: readonly ColliderCandidate[];
}

const FOUR_THIRDS_PI = (4 / 3) * Math.PI;

export function colliderFit(
  shape: Shape,
  options: ColliderFitOptions = {},
): Result<ColliderFitReport, ModelingError> {
  const m = measure(shape);
  if (!m.ok) return err(m.error);
  const shapeVolume = m.value.volume;
  if (!(shapeVolume > 0)) {
    return err(brepError('brep-bad-argument', 'a solid with positive volume'));
  }
  const sampled = tessellateSampled(shape, {
    angle: options.angle ?? Math.PI / 64,
    ...(options.chord === undefined ? {} : { chord: options.chord }),
  });
  if (!sampled.ok) return err(sampled.error);
  const mesh = sampled.value.mesh;
  const vertices: P3[] = [];
  for (const v of mesh.vertices()) vertices.push(mesh.position(v));
  // The hull of the vertices contains every triangle, so vertices alone define it.
  const hull = hullOf(vertices);
  if (!hull.ok) return err(hull.error);
  // Straight triangle interiors carry no vertices; deviation must see them.
  const samples = surfaceSamples(mesh);
  const { lo, hi } = boundsOf(samples);
  const candidates: ColliderCandidate[] = [
    fitBox(samples, lo, hi, shapeVolume),
    fitSphere(samples, lo, hi, shapeVolume),
    fitCapsule(samples, lo, hi, shapeVolume),
    {
      kind: 'convex-hull',
      faces: hull.value.faces,
      volumeRatio: hull.value.volume / shapeVolume,
    },
  ];
  return ok({ shapeVolume, sampleCount: samples.length, candidates });
}

/** Barycentric grid points over every mesh triangle, vertices included. */
const TRIANGLE_DIVISIONS = 4;

function surfaceSamples(mesh: EditMesh): P3[] {
  const out: P3[] = [];
  const n = TRIANGLE_DIVISIONS;
  for (const f of mesh.faces()) {
    const loop = mesh.faceVertices(f);
    const v0 = loop[0];
    if (v0 === undefined) continue;
    for (let k = 1; k + 1 < loop.length; k++) {
      const v1 = loop[k];
      const v2 = loop[k + 1];
      if (v1 === undefined || v2 === undefined) continue;
      const a = mesh.position(v0);
      const b = mesh.position(v1);
      const c = mesh.position(v2);
      for (let i = 0; i <= n; i++) {
        for (let j = 0; i + j <= n; j++) {
          const s = i / n;
          const t = j / n;
          const w = 1 - s - t;
          out.push([
            w * a[0] + s * b[0] + t * c[0],
            w * a[1] + s * b[1] + t * c[1],
            w * a[2] + s * b[2] + t * c[2],
          ]);
        }
      }
    }
  }
  return out;
}

function boundsOf(pts: readonly P3[]): { lo: P3; hi: P3 } {
  let lx = Infinity;
  let ly = Infinity;
  let lz = Infinity;
  let hx = -Infinity;
  let hy = -Infinity;
  let hz = -Infinity;
  for (const [x, y, z] of pts) {
    lx = Math.min(lx, x);
    ly = Math.min(ly, y);
    lz = Math.min(lz, z);
    hx = Math.max(hx, x);
    hy = Math.max(hy, y);
    hz = Math.max(hz, z);
  }
  return { lo: [lx, ly, lz], hi: [hx, hy, hz] };
}

function fitBox(pts: readonly P3[], lo: P3, hi: P3, shapeVolume: number): ColliderCandidate {
  const center: P3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const half: P3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  // Samples lie inside the box they define, so the nearest-face gap is the distance to its surface.
  let maxDeviation = 0;
  for (const p of pts) {
    const gap = Math.min(
      half[0] - Math.abs(p[0] - center[0]),
      half[1] - Math.abs(p[1] - center[1]),
      half[2] - Math.abs(p[2] - center[2]),
    );
    maxDeviation = Math.max(maxDeviation, gap);
  }
  const volume = 8 * half[0] * half[1] * half[2];
  return { kind: 'box', center, half, volumeRatio: volume / shapeVolume, maxDeviation };
}

function fitSphere(pts: readonly P3[], lo: P3, hi: P3, shapeVolume: number): ColliderCandidate {
  const center: P3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let radius = 0;
  for (const p of pts) radius = Math.max(radius, len3(sub3(p, center)));
  let maxDeviation = 0;
  for (const p of pts)
    maxDeviation = Math.max(maxDeviation, Math.abs(len3(sub3(p, center)) - radius));
  const volume = FOUR_THIRDS_PI * radius * radius * radius;
  return { kind: 'sphere', center, radius, volumeRatio: volume / shapeVolume, maxDeviation };
}

function longestAxis(lo: P3, hi: P3): 0 | 1 | 2 {
  const ex = hi[0] - lo[0];
  const ey = hi[1] - lo[1];
  const ez = hi[2] - lo[2];
  if (ex >= ey && ex >= ez) return 0;
  if (ey >= ez) return 1;
  return 2;
}

function component(v: P3, axis: 0 | 1 | 2): number {
  if (axis === 0) return v[0];
  if (axis === 1) return v[1];
  return v[2];
}

function fitCapsule(pts: readonly P3[], lo: P3, hi: P3, shapeVolume: number): ColliderCandidate {
  const center: P3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const axis = longestAxis(lo, hi);
  // Decompose each sample into axial and radial parts about the centre.
  const axial: number[] = [];
  const radial: number[] = [];
  let radius = 0;
  let halfAxial = 0;
  for (const p of pts) {
    const q = sub3(p, center);
    const a = component(q, axis);
    const perp = Math.sqrt(Math.max(0, len3(q) * len3(q) - a * a));
    axial.push(a);
    radial.push(perp);
    radius = Math.max(radius, perp);
    halfAxial = Math.max(halfAxial, Math.abs(a));
  }
  const halfLength = Math.max(0, halfAxial - radius);
  let maxDeviation = 0;
  for (let i = 0; i < axial.length; i++) {
    const a = axial[i] ?? 0;
    const perp = radial[i] ?? 0;
    const beyond = a - Math.max(-halfLength, Math.min(halfLength, a));
    const dist = Math.sqrt(perp * perp + beyond * beyond);
    maxDeviation = Math.max(maxDeviation, Math.abs(dist - radius));
  }
  const volume =
    Math.PI * radius * radius * 2 * halfLength + FOUR_THIRDS_PI * radius * radius * radius;
  return {
    kind: 'capsule',
    center,
    axis,
    radius,
    halfLength,
    volumeRatio: volume / shapeVolume,
    maxDeviation,
  };
}

interface HullFace {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly n: P3;
}

function faceOf(pts: readonly P3[], a: number, b: number, c: number): HullFace | undefined {
  const pa = pts[a];
  const pb = pts[b];
  const pc = pts[c];
  if (!pa || !pb || !pc) return undefined;
  const n = cross3(sub3(pb, pa), sub3(pc, pa));
  const l = len3(n);
  if (!(l > 0)) return undefined;
  return { a, b, c, n: [n[0] / l, n[1] / l, n[2] / l] };
}

function signedDistance(f: HullFace, pts: readonly P3[], p: P3): number {
  const pa = pts[f.a] ?? p;
  const d = sub3(p, pa);
  return f.n[0] * d[0] + f.n[1] * d[1] + f.n[2] * d[2];
}

/** Incremental 3D hull; returns its volume measured from an interior point. */
function hullOf(pts: readonly P3[]): Result<{ volume: number; faces: number }, ModelingError> {
  const degenerate = (): Result<never, ModelingError> =>
    err(brepError('brep-bad-argument', 'surface samples spanning a non-degenerate hull'));
  const { lo, hi } = boundsOf(pts);
  const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(scale > 0)) return degenerate();
  const eps = scale * 1e-12;

  const i0 = indexOfExtreme(pts, (p) => -p[0]);
  const p0 = pts[i0];
  if (!p0) return degenerate();
  const i1 = indexOfExtreme(pts, (p) => len3(sub3(p, p0)));
  const p1 = pts[i1];
  if (!p1 || len3(sub3(p1, p0)) <= eps) return degenerate();
  const dir = sub3(p1, p0);
  const i2 = indexOfExtreme(pts, (p) => len3(cross3(sub3(p, p0), dir)));
  const p2 = pts[i2];
  if (!p2 || len3(cross3(sub3(p2, p0), dir)) <= eps) return degenerate();
  const n012 = cross3(dir, sub3(p2, p0));
  const i3 = indexOfExtreme(pts, (p) => Math.abs(dot(n012, sub3(p, p0))));
  const p3 = pts[i3];
  if (!p3 || Math.abs(dot(n012, sub3(p3, p0))) <= eps) return degenerate();

  const seed: readonly [number, number, number, number] = [i0, i1, i2, i3];
  const interior: P3 = [
    (p0[0] + p1[0] + p2[0] + p3[0]) / 4,
    (p0[1] + p1[1] + p2[1] + p3[1]) / 4,
    (p0[2] + p1[2] + p2[2] + p3[2]) / 4,
  ];
  let faces: HullFace[] = [];
  for (const [a, b, c] of [
    [seed[0], seed[1], seed[2]],
    [seed[0], seed[1], seed[3]],
    [seed[0], seed[2], seed[3]],
    [seed[1], seed[2], seed[3]],
  ] as const) {
    const f = faceOf(pts, a, b, c);
    if (!f) return degenerate();
    // Each seed face must point away from the interior point; flip its winding otherwise.
    faces.push(signedDistance(f, pts, interior) > 0 ? { a, b: c, c: b, n: negate(f.n) } : f);
  }

  for (let k = 0; k < pts.length; k++) {
    if (seed.includes(k)) continue;
    const p = pts[k];
    if (!p) continue;
    const visible = faces.filter((f) => signedDistance(f, pts, p) > eps);
    if (visible.length === 0) continue;
    const directed = new Set<string>();
    for (const f of visible) {
      directed.add(`${f.a},${f.b}`);
      directed.add(`${f.b},${f.c}`);
      directed.add(`${f.c},${f.a}`);
    }
    const visibleSet = new Set(visible);
    faces = faces.filter((f) => !visibleSet.has(f));
    for (const f of visible) {
      for (const [u, v] of [
        [f.a, f.b],
        [f.b, f.c],
        [f.c, f.a],
      ] as const) {
        if (directed.has(`${v},${u}`)) continue;
        const nf = faceOf(pts, u, v, k);
        if (nf) faces.push(nf);
      }
    }
  }

  let volume = 0;
  for (const f of faces) {
    const pa = sub3(pts[f.a] ?? interior, interior);
    const pb = sub3(pts[f.b] ?? interior, interior);
    const pc = sub3(pts[f.c] ?? interior, interior);
    volume += dot(pa, cross3(pb, pc)) / 6;
  }
  return ok({ volume, faces: faces.length });
}

function dot(a: P3, b: P3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function negate(v: P3): P3 {
  return [-v[0], -v[1], -v[2]];
}

function indexOfExtreme(pts: readonly P3[], score: (p: P3) => number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p) continue;
    const s = score(p);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}
