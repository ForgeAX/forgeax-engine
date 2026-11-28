import { surfaceDomain, surfaceInverse, surfacePoint } from '../../surfaces';
import { cross3, dist3, dot3, len3, madd3, type P3, sub3, TWO_PI } from '../../vec';
import {
  type AnalyticSurface,
  classify,
  E1_TOL,
  E1_WINDOW,
  type E1Pair,
  type RefBranch,
} from './corpus';

/**
 * Checks of the corpus against facts that do not come from the intersection code: implicit surface
 * equations written from each surface's definition, a closed-form tangency discriminant, and counts of
 * seam crossings taken on the reference curve itself.
 */

function axial(s: AnalyticSurface, p: P3): { w: number; rho: number } {
  const d = sub3(p, s.frame.o);
  const w = dot3(d, s.frame.z);
  return { w, rho: len3(madd3(d, s.frame.z, -w)) };
}

/** Zero exactly on the surface; the sign flips across it. */
export function implicit(s: AnalyticSurface, p: P3): number {
  const { w, rho } = axial(s, p);
  switch (s.kind) {
    case 'plane':
      return w;
    case 'cylinder':
      return rho - s.radius;
    case 'sphere':
      return Math.hypot(rho, w) - s.radius;
    case 'cone':
      return rho - Math.abs(s.radius + w * Math.tan(s.halfAngle));
    case 'torus':
      return Math.hypot(rho - s.major, w) - s.minor;
  }
}

const SAMPLES = 1500;

function sampleBranch(b: RefBranch, n: number): P3[] {
  const out: P3[] = [];
  for (let i = 0; i <= n; i++) out.push(b.at(b.t0 + ((b.t1 - b.t0) * i) / n));
  return out;
}

/** Largest implicit residual of any reference sample on either surface. */
export function referenceResidual(pair: E1Pair): number {
  let worst = 0;
  for (const b of pair.branches) {
    for (const p of sampleBranch(b, SAMPLES)) {
      worst = Math.max(worst, Math.abs(implicit(pair.a, p)), Math.abs(implicit(pair.b, p)));
    }
  }
  return worst;
}

function segDistance(p: P3, a: P3, b: P3): number {
  const ab = sub3(b, a);
  const l2 = dot3(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot3(sub3(p, a), ab) / l2));
  return dist3(p, madd3(a, ab, t));
}

const GRID = 160;
const COMPLETE_TOL = 4e-3;

/**
 * Walks a grid over surface `a` inside the window, finds every grid edge where the implicit equation of
 * `b` changes sign, bisects to the crossing point and returns the largest distance from such a point to
 * the reference polylines: a branch missing from the reference leaves a crossing far from all of them.
 */
export function referenceGap(pair: E1Pair, grid = GRID): { crossings: number; worst: number } {
  const lines = pair.branches.filter((b) => b.t1 > b.t0).map((b) => sampleBranch(b, SAMPLES * 2));
  const dom = surfaceDomain(pair.a);
  const home = surfaceInverse(pair.a, pair.window.c);
  const span = pair.window.r;
  const uLo = dom.uPeriod > 0 ? 0 : home.u - span;
  const uHi = dom.uPeriod > 0 ? dom.uPeriod : home.u + span;
  const vLo = Number.isFinite(dom.vMin) ? dom.vMin : home.v - span;
  const vHi = Number.isFinite(dom.vMax) ? dom.vMax : home.v + span;
  const vl = pair.a.kind === 'torus' ? 0 : vLo;
  const vh = pair.a.kind === 'torus' ? TWO_PI : vHi;
  const at = (i: number, j: number): [number, number] => [
    uLo + ((uHi - uLo) * i) / grid,
    vl + ((vh - vl) * j) / grid,
  ];
  const f = (u: number, v: number): number => implicit(pair.b, surfacePoint(pair.a, u, v));
  const val: number[][] = [];
  for (let i = 0; i <= grid; i++) {
    const row: number[] = [];
    for (let j = 0; j <= grid; j++) row.push(f(...at(i, j)));
    val.push(row);
  }
  let crossings = 0;
  let worst = 0;
  const probe = (u0: number, v0: number, f0: number, u1: number, v1: number, f1: number) => {
    if (!(f0 * f1 < 0)) return;
    let lo = 0;
    let hi = 1;
    let flo = f0;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      const fm = f(u0 + (u1 - u0) * mid, v0 + (v1 - v0) * mid);
      if (fm * flo > 0) {
        lo = mid;
        flo = fm;
      } else hi = mid;
    }
    const t = (lo + hi) / 2;
    const p = surfacePoint(pair.a, u0 + (u1 - u0) * t, v0 + (v1 - v0) * t);
    if (dist3(p, pair.window.c) > span) return;
    crossings++;
    let best = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      for (let k = 0; k + 1 < line.length; k++) {
        best = Math.min(best, segDistance(p, line[k] as P3, line[k + 1] as P3));
      }
    }
    for (const b of pair.branches) if (b.t1 === b.t0) best = Math.min(best, dist3(p, b.at(0)));
    worst = Math.max(worst, best);
  };
  for (let i = 0; i <= grid; i++) {
    for (let j = 0; j <= grid; j++) {
      const [u, v] = at(i, j);
      const here = (val[i] as number[])[j] as number;
      if (i < grid) {
        const [u1, v1] = at(i + 1, j);
        probe(u, v, here, u1, v1, (val[i + 1] as number[])[j] as number);
      }
      if (j < grid) {
        const [u1, v1] = at(i, j + 1);
        probe(u, v, here, u1, v1, (val[i] as number[])[j + 1] as number);
      }
    }
  }
  return { crossings, worst };
}

export { COMPLETE_TOL };

/**
 * A plane through a cone apex cuts two generators at azimuths phi with cos(phi - psi) = -n.z cos(al) /
 * (sin(al) |n_perp|). Their separation at the window radius is the length gap; zero is a tangent plane.
 */
function apexChord(
  plane: AnalyticSurface,
  cone: AnalyticSurface & { kind: 'cone' },
): number | null {
  const apex = madd3(cone.frame.o, cone.frame.z, -cone.radius / Math.tan(cone.halfAngle));
  if (Math.abs(dot3(sub3(apex, plane.frame.o), plane.frame.z)) > 1e-9) return null;
  const n = plane.frame.z;
  const sa = Math.sin(cone.halfAngle);
  const r = Math.hypot(dot3(n, cone.frame.x), dot3(n, cone.frame.y));
  const x = (-dot3(n, cone.frame.z) * Math.cos(cone.halfAngle)) / (sa * r);
  if (Math.abs(x) > 1) return null;
  return 2 * E1_WINDOW * sa * Math.sqrt(1 - x * x);
}

/**
 * Distance of the pair from the nearest tangent configuration of its family, from the final surfaces and
 * the closed-form condition of each family; null where the corpus pair has no tangent family nearby.
 *
 * Limitation (Audit 10 A10-4): these closed forms are the same expressions the builders use to choose
 * their gap, so agreement checks the builder's arithmetic against itself for the families listed here,
 * not against an independent derivation. An equation-only window minimum cannot replace them: intersecting
 * pairs have a near-zero minimum too, so it does not discriminate tangent from transversal contact.
 */
export function tangentGap(pair: E1Pair): number | null {
  const { a, b } = pair;
  const kinds = `${a.kind}-${b.kind}`;
  const close = (x: number, y: number): number => Math.abs(x - y);
  switch (kinds) {
    case 'plane-sphere':
      return b.kind === 'sphere'
        ? b.radius - Math.abs(dot3(sub3(b.frame.o, a.frame.o), a.frame.z))
        : null;
    case 'plane-cylinder': {
      if (b.kind !== 'cylinder') return null;
      const side = Math.abs(dot3(b.frame.z, a.frame.z));
      if (side > 1e-9) return null;
      return b.radius - Math.abs(dot3(sub3(b.frame.o, a.frame.o), a.frame.z));
    }
    case 'plane-torus': {
      if (b.kind !== 'torus') return null;
      const h = Math.abs(dot3(sub3(b.frame.o, a.frame.o), a.frame.z));
      if (Math.abs(dot3(b.frame.z, a.frame.z)) > 1 - 1e-9) return b.minor - h;
      if (Math.abs(dot3(b.frame.z, a.frame.z)) < 1e-9)
        return Math.min(close(h, b.major - b.minor), close(h, b.major + b.minor));
      return null;
    }
    case 'plane-cone':
      return a.kind === 'plane' && b.kind === 'cone' ? apexChord(a, b) : null;
    case 'cone-plane':
      return a.kind === 'cone' && b.kind === 'plane' ? apexChord(b, a) : null;
    case 'cylinder-sphere': {
      if (a.kind !== 'cylinder' || b.kind !== 'sphere') return null;
      const o = sub3(b.frame.o, a.frame.o);
      const off = len3(madd3(o, a.frame.z, -dot3(o, a.frame.z)));
      return off < 1e-9 ? Math.abs(b.radius - a.radius) : null;
    }
    case 'cylinder-torus': {
      if (a.kind !== 'cylinder' || b.kind !== 'torus') return null;
      const o = sub3(b.frame.o, a.frame.o);
      const off = len3(madd3(o, a.frame.z, -dot3(o, a.frame.z)));
      if (off > 1e-9 || Math.abs(dot3(a.frame.z, b.frame.z)) < 1 - 1e-9) return null;
      return b.minor - Math.abs(a.radius - b.major);
    }
    case 'sphere-sphere': {
      if (a.kind !== 'sphere' || b.kind !== 'sphere') return null;
      const d = dist3(a.frame.o, b.frame.o);
      return Math.min(close(d, a.radius + b.radius), close(d, Math.abs(a.radius - b.radius)));
    }
    case 'cylinder-cylinder': {
      if (a.kind !== 'cylinder' || b.kind !== 'cylinder') return null;
      const n = cross3(a.frame.z, b.frame.z);
      const o = sub3(b.frame.o, a.frame.o);
      const e =
        len3(n) < 1e-9
          ? len3(madd3(o, a.frame.z, -dot3(o, a.frame.z)))
          : Math.abs(dot3(o, n)) / len3(n);
      if (len3(n) > 1e-9 && Math.abs(dot3(a.frame.z, b.frame.z)) > 1e-9) return null;
      return Math.min(
        close(e, a.radius + b.radius),
        close(e, Math.abs(a.radius - b.radius)),
        len3(n) < 1e-9 ? Number.POSITIVE_INFINITY : close(a.radius, e + b.radius),
        len3(n) < 1e-9 ? Number.POSITIVE_INFINITY : close(a.radius, Math.abs(e - b.radius)),
      );
    }
    default:
      return null;
  }
}

/** Reference-curve crossings of each periodic seam: surface `a` or `b`, branch, u-seam and torus v-seam. */
export interface SeamCounts {
  readonly a: readonly number[];
  readonly b: readonly number[];
  readonly aV: readonly number[];
  readonly bV: readonly number[];
}

/** Marker for a reference curve that lies in the seam half-plane itself: no transversal count exists. */
export const ON_SEAM = -1;

function crossings(s: AnalyticSurface, b: RefBranch, n: number, v: boolean): number {
  if (s.kind === 'plane') return 0;
  if (v && s.kind !== 'torus') return 0;
  const pts = sampleBranch(b, n);
  let count = 0;
  const side = (p: P3): { s: number; ok: boolean } => {
    const d = sub3(p, s.frame.o);
    if (!v) return { s: dot3(d, s.frame.y), ok: dot3(d, s.frame.x) > 0 };
    const { w, rho } = axial(s, p);
    return { s: w, ok: rho > (s as { major: number }).major };
  };
  if (!v && pts.every((p) => Math.abs(side(p).s) < 1e-9 && side(p).ok)) return ON_SEAM;
  // A sample exactly on the seam plane is not a side: compare the nearest nonzero neighbours, so a
  // reference that touches the seam and returns to the same side is not counted as a crossing.
  const sides = pts.map(side).filter((q) => q.s !== 0);
  for (let i = 0; i + 1 < sides.length; i++) {
    const p = sides[i] as { s: number; ok: boolean };
    const q = sides[i + 1] as { s: number; ok: boolean };
    if (p.s < 0 !== q.s < 0 && p.ok && q.ok) count++;
  }
  return count;
}

export function seamCounts(pair: E1Pair, n: number): SeamCounts {
  const per = (s: AnalyticSurface, v: boolean) => pair.branches.map((b) => crossings(s, b, n, v));
  return {
    a: per(pair.a, false),
    b: per(pair.b, false),
    aV: per(pair.a, true),
    bV: per(pair.b, true),
  };
}

/** Distance of the claimed pole or apex to the reference curve point at the claimed parameter. */
export function poleError(pair: E1Pair): number {
  let worst = 0;
  for (const claim of pair.poles) {
    const s = claim.on === 'a' ? pair.a : pair.b;
    const branch = pair.branches[claim.branch] as RefBranch;
    const p = branch.at(claim.t);
    if (claim.feature === 'apex' && s.kind === 'cone') {
      const apex = madd3(s.frame.o, s.frame.z, -s.radius / Math.tan(s.halfAngle));
      worst = Math.max(worst, dist3(p, apex));
    } else if (claim.feature === 'pole' && s.kind === 'sphere') {
      const north = madd3(s.frame.o, s.frame.z, s.radius);
      const south = madd3(s.frame.o, s.frame.z, -s.radius);
      worst = Math.max(worst, Math.min(dist3(p, north), dist3(p, south)));
    } else worst = Math.max(worst, Number.POSITIVE_INFINITY);
  }
  return worst;
}

export interface Labels {
  readonly [id: string]: string;
}

/** Everything wrong with the corpus as committed; empty when it is consistent. */
export function corpusProblems(pairs: readonly E1Pair[], labels: Labels): string[] {
  const out: string[] = [];
  const tol = E1_TOL;
  for (const p of pairs) {
    if (labels[p.id] !== p.expected)
      out.push(`${p.id}: committed label ${labels[p.id]} != ${p.expected}`);
    const independent = tangentGap(p);
    if (p.gap !== null && classify(p.gap, tol) !== p.expected)
      out.push(`${p.id}: builder gap ${p.gap} classifies ${classify(p.gap, tol)} != ${p.expected}`);
    if (independent !== null && classify(independent, tol) !== p.expected)
      out.push(
        `${p.id}: discriminant gap ${independent} classifies ${classify(independent, tol)} != ${p.expected}`,
      );
    const res = referenceResidual(p);
    if (!(res < 1e-10)) out.push(`${p.id}: reference residual ${res}`);
    const miss = referenceGap(p);
    if (!(miss.worst < COMPLETE_TOL))
      out.push(`${p.id}: crossing ${miss.worst} from the reference (${miss.crossings} found)`);
    if (!(poleError(p) < 1e-9)) out.push(`${p.id}: pole claim off by ${poleError(p)}`);
  }
  return out;
}
