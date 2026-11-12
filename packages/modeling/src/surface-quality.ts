import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import { atan2 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  type Field,
  fieldOf,
  type HighlightOptions,
  type HighlightPoint,
  longEnough,
  traceHighlights,
} from './highlight-lines';
import {
  basisFunctions,
  checkCurve,
  checkSurface,
  curveCurvature,
  curvePoint,
  domain,
  findSpan,
  type NurbsCurve,
  type NurbsSurface,
  normalCurvature,
  type SurfaceCurvature,
  surfaceClosest,
  surfaceCurvature,
  surfaceDerivatives,
  surfaceDomain,
} from './nurbs';
import type { PatchSide } from './nurbs-surface';
import type { Point2 } from './primitives';
import { type Coverage, coverageOf, type Issue, type UncheckedReason } from './report';

export type { PatchSide };

/**
 * Surface-quality checks: continuity along the shared edges of NURBS
 * patches, control-net density, and the fairness of feature curves. Everything is
 * measured on the exact evaluated geometry and reported with its location.
 */
export type Continuity = 'G0' | 'G1' | 'G2' | 'G3';

/**
 * What makes a patch a transition: `kind` 'blend' a fillet or blend band, 'corner' a quad of
 * a setback corner fill; `continuity` what it holds at its contact edges (the blend's or
 * corner's continuity option, default G1).
 */
export interface PatchTransition {
  readonly kind: 'blend' | 'corner';
  readonly continuity: 'G1' | 'G2';
  /**
   * Largest gap its contact edges hold (a blend's fit target, `tolerance / 2`): the position
   * limit there when tighter than its class's, so a fit that stopped short is a finding.
   */
  readonly gap?: number;
}

/** One seam of a surface call, as `m.diagnostics().surfaces` and the surface diagnostic report it (`surface-seams.ts`). */
export interface SurfaceSeam {
  /** The owner patch (emitted first, its points are the seam's) and its side. */
  readonly a: string;
  readonly sideA: PatchSide;
  /** The other patch, which emits the owner's points along its side. */
  readonly b: string;
  /** `b`'s side, or `trimK`: the seam runs along `b`'s trim K (a blend's contact). */
  readonly sideB: PatchSide | `trim${number}`;
  /** Largest distance between the owner's seam points and `b`'s own side (measureEdge's gap), m. */
  readonly gap: number;
  /** Largest positional merge between the two patches' vertices, m (0: the seam joins by identity alone). */
  readonly weldMove: number;
  /** Where that merge happened. */
  readonly weldAt?: Tuple3;
}

export interface NamedSurface {
  readonly name: string;
  readonly surface: NurbsSurface;
  /**
   * Designed S-shapes: inflections allowed on this patch's isoparms running along u
   * (`u`) or along v (`v`), for example 1 in v for a wheel-arch flare. Overrides the
   * global `fairness.maxInflections` for this patch only; spikes and the rate still apply.
   */
  readonly inflections?: { readonly u?: number; readonly v?: number };
  /**
   * A transition patch, whose edges are of class 'blend' (see `PatchTransition`), and so are
   * the trim edges along it: corner quads' edges to other corner quads (the spokes) require at
   * most G1, the designed interior continuity; a `G1` blend band declares its contact edges
   * tangent breaks for highlight lines. A blend band's net counts only across it for density.
   */
  readonly transition?: PatchTransition;
  /**
   * Boundary loops of the regions trimmed away, in the normalized domain ([0, 1] x [0, 1]):
   * their edges are sampled too, as class 'trim' (class 'blend' along a transition patch).
   */
  readonly trims?: readonly (readonly Point2[])[];
  /**
   * The seams this patch owns (it was emitted first in its `m.surface` call): each shared
   * side pair with its measured gap and largest positional weld move.
   */
  readonly seams?: readonly SurfaceSeam[];
}

/** Which limits an edge is judged by: patch sides, edges of a transition patch, trim edges. */
export type EdgeClass = 'primary' | 'blend' | 'trim';

/** Per-class limits: gap (m), kink (degrees), curvature and curvature-rate jumps relative to the larger side. */
export interface EdgeLimits {
  readonly position?: number;
  readonly angle?: number;
  readonly curvatureRatio?: number;
  readonly rateRatio?: number;
}

/**
 * Surface-quality limits: G2 edges between primary and secondary surfaces 0.01 mm / 0.1 degree / 2 %
 * (G3 rate within 10 %), fillet edges 5 % with no G3 requirement, trim edges as primary.
 */
export const D09_CLASSES: Readonly<Record<EdgeClass, Required<EdgeLimits>>> = {
  primary: { position: 1e-5, angle: 0.1, curvatureRatio: 0.02, rateRatio: 0.1 },
  blend: { position: 1e-5, angle: 0.1, curvatureRatio: 0.05, rateRatio: Number.POSITIVE_INFINITY },
  trim: { position: 1e-5, angle: 0.1, curvatureRatio: 0.02, rateRatio: 0.1 },
};

/**
 * A styling feature line. `continuity`, when given, is what the shared edges lying on
 * it must reach: `G0` tags them a designed break (a crease, later blended), `G1` or
 * `G2` a smooth crossing. Every feature line is checked for fairness.
 */
export interface FeatureLine {
  readonly name: string;
  readonly curve: NurbsCurve;
  readonly continuity?: Continuity;
  /**
   * Designed S-curves: normalized parameter ranges `[t0, t1]` (0 to 1 along the curve)
   * that each hold one designed inflection. An inflection in a range is reported as
   * `designed`; a second one there, or any outside every range, still fails.
   */
  readonly inflections?: readonly (readonly [number, number])[];
}

export interface FairnessOptions {
  /** Curvature samples along each curve (default 256, 16 to 4096). */
  readonly samples?: number;
  /** Inflections allowed per curve (default 0). */
  readonly maxInflections?: number;
  /**
   * A curvature spike is a local peak that rises above both neighbouring valleys by
   * more than `spike` times the curve's median curvature (at least 1 / length) and is
   * narrower than a fifth of the curve (default 0.5).
   */
  readonly spike?: number;
  /** Largest curvature rate |dk/ds|, 1/m^2 (per scene; default none). */
  readonly maxCurvatureRate?: number;
  /**
   * Largest rate ratio |dk/ds| x length / max curvature, dimensionless (default 15): a
   * quarter ellipse of axis ratio 3.3 reaches 8, a fair arc under 1, a densely
   * interpolated noisy trace over 50. Near-straight curves (max curvature x length below
   * 0.05, a sagitta of about a hundredth of the length) count as straight (ratio 0).
   */
  readonly maxRateRatio?: number;
}

export interface SurfaceQualityOptions {
  /** G0: largest gap along a shared edge, meters (default 1e-4). */
  readonly position?: number;
  /** G1: largest kink across a shared edge, degrees (default 0.5). */
  readonly angle?: number;
  /**
   * G2: largest jump of the cross-edge normal curvature, 1/m. Default per scene: 5 % of
   * the larger of the two curvatures, at least 0.01.
   */
  readonly curvature?: number;
  /** Floor of the per-scene G2 limit, 1/m (default 0.01; ignored with `curvature`). */
  readonly curvatureFloor?: number;
  /**
   * G3: largest jump of the cross-edge curvature rate dk/ds relative to the larger side
   * (default 0.1, floor 0.01 1/m^2).
   */
  readonly rate?: number;
  /**
   * Limits per edge class, overriding the ones above for that class (`D09_CLASSES` holds the
   * surface-quality values): 'primary' patch sides, 'blend' edges of a transition patch,
   * 'trim' edges along a trim loop.
   */
  readonly classes?: Partial<Readonly<Record<EdgeClass, EdgeLimits>>>;
  /** Continuity a shared edge must reach unless a feature line on it says otherwise (default G1). */
  readonly continuity?: Continuity;
  /** Sides closer than this are adjacent and get measured (default 1e-3 m, at least 10 x position). */
  readonly adjacency?: number;
  /** Samples per patch side (default 16, 2 to 256). */
  readonly samples?: number;
  /**
   * Control net limit: [longer direction, shorter direction] (default [8, 6]); a blend
   * transition's net is judged across only (its shorter direction).
   */
  readonly maxNet?: readonly [number, number];
  readonly fairness?: FairnessOptions;
  /**
   * Interior isoparms per direction checked for fairness on every patch (default 5, at
   * 1/6 ... 5/6 of the domain; 0 turns the check off). A panel whose control net ripples
   * shows inflections, spikes or a high rate ratio on them (`surface-fairness`).
   */
  readonly isoparms?: number;
  /**
   * Extract highlight lines (`highlightLines`, same options) and judge each traced line on
   * its exact points by `fairness` (curvature from the circle through neighbouring points;
   * spike width and rate ratio over the line's curved length); each failing line is a
   * `highlight` issue. Lines chain across patch joints (ends within half a point spacing),
   * and the field is sampled on both sides of every joint the lines must cross smoothly
   * (shared edges and full-multiplicity interior knots): a jump above 1/50 of a line spacing
   * is a `highlight` issue with `jump` and its located `point`, whether or not a traced line
   * crosses there. Designed shapes are exempt only by declaration: a crossed patch's
   * `inflections` allow that many inflections over the part of the line on it (in the
   * direction the line runs there), each feature-line `inflections` range whose middle
   * lies on a patch (within `adjacency`) one more there, and a blend band one per turn of
   * its width law (a run-out's S) along it; a band's run-out tip, where all its lines
   * converge, is not traced. A line is split (each side judged alone), and the joint not
   * sampled, where it crosses a shared edge that a feature line declares `G0`/`G1`, or a
   * contact edge of a blend band whose `transition.continuity` is `G1` or that holds a
   * feature line declared `G0`/`G1` (a blended crease). Every other joint must keep the
   * lines continuous and fair, so a kink on a G2 joint is reported.
   */
  readonly highlights?: HighlightOptions;
}

export interface SurfaceDensity {
  readonly name: string;
  /** Control points along u and v. */
  readonly net: readonly [number, number];
  readonly pass: boolean;
}

/** Where the largest deviation of one measure occurs: side parameter (normalized) and point. */
export interface Worst {
  readonly value: number;
  readonly t: number;
  readonly point: Tuple3;
}

export interface ContinuityEdge {
  readonly a: string;
  /** `a`'s side, or 'trim' for an edge along `a`'s trim loop number `trim`. */
  readonly sideA: PatchSide | 'trim';
  readonly trim?: number;
  readonly b: string;
  readonly sideB: PatchSide;
  /** Normalized parameter range of the shared part along `a`'s side. */
  readonly range: readonly [number, number];
  readonly samples: number;
  /** Samples left out at a run-out tip (a transition band under 1 % of its widest station). */
  readonly skipped: number;
  /** Largest gap (m), kink (degrees) and cross-edge curvature jump (1/m). */
  readonly gap: Worst;
  readonly angle: Worst;
  readonly curvature: Worst;
  /** Largest jump of the cross-edge curvature rate (1/m^2), measured where the edge is G2. */
  readonly rate: Worst;
  readonly class: EdgeClass;
  readonly achieved: Continuity | 'none';
  readonly required: Continuity;
  /** The feature line that sets `required`, when one runs along the edge. */
  readonly feature?: string;
  /** True when that feature line declares a designed break (G0). */
  readonly designedBreak: boolean;
  readonly pass: boolean;
}

export interface CurvePlace {
  readonly t: number;
  readonly point: Tuple3;
}

export interface CurveFairness {
  readonly name: string;
  readonly length: number;
  readonly maxCurvature: number;
  /** Inflections the line does not declare (see `FeatureLine.inflections`). */
  readonly inflections: readonly CurvePlace[];
  /** Inflections inside the line's declared ranges, one per range. */
  readonly designed: readonly CurvePlace[];
  readonly spikes: readonly (CurvePlace & {
    readonly curvature: number;
    readonly prominence: number;
  })[];
  /** Largest |dk/ds| (1/m^2), its ratio to max curvature / length, and where it occurs. */
  readonly curvatureRate: number;
  readonly rateRatio: number;
  readonly rateAt: CurvePlace;
  readonly pass: boolean;
}

export type SurfaceQualityCode =
  | 'surface-density'
  | 'surface-continuity'
  | 'curve-inflection'
  | 'curve-spike'
  | 'curve-curvature-rate'
  | 'surface-fairness'
  | 'highlight'
  | 'nothing-checked';

export interface SurfaceQualityReport {
  readonly pass: boolean;
  readonly thresholds: {
    readonly position: number;
    readonly angle: number;
    /** Absolute G2 limit, or undefined for the per-scene default. */
    readonly curvature?: number;
    readonly rate: number;
    readonly classes: Partial<Readonly<Record<EdgeClass, EdgeLimits>>>;
    readonly continuity: Continuity;
    readonly adjacency: number;
    readonly maxNet: readonly [number, number];
    readonly maxInflections: number;
    readonly spike: number;
    readonly maxCurvatureRate?: number;
    readonly maxRateRatio: number;
  };
  readonly surfaces: readonly SurfaceDensity[];
  readonly edges: readonly ContinuityEdge[];
  readonly curves: readonly CurveFairness[];
  /** Each failing measure; `detail.subject` is the surface, edge (`a:side|b:side`) or curve id. */
  readonly issues: readonly Issue<SurfaceQualityCode>[];
  /**
   * Subjects checked per code and subjects left out with a reason. Subjects: surfaces
   * (`surface-density`), patch sides and trim loops (`surface-continuity`), feature lines
   * (`curve-*`), isoparm directions (`surface-fairness`), joints and full-multiplicity knot lines
   * (`highlight`, `not-requested` without `highlights`).
   */
  readonly coverage: Coverage<SurfaceQualityCode>;
}

export interface SurfaceQualityInput {
  readonly surfaces?: readonly NamedSurface[];
  readonly curves?: readonly FeatureLine[];
}

const SIDES: readonly PatchSide[] = ['u0', 'u1', 'v0', 'v1'];

/** The exact isoparm of `s` at normalized `f` across direction `along` ('u' runs along u, v fixed). */
export function isoparm(s: NurbsSurface, along: 'u' | 'v', f: number): NurbsCurve {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const nu = s.points.length;
  const nv = (s.points[0] as readonly Tuple3[]).length;
  // Fix the other parameter: combine the rows (or columns) with its basis functions.
  const fixedU = along === 'v';
  const p = fixedU ? s.degreeU : s.degreeV;
  const knots = fixedU ? s.knotsU : s.knotsV;
  const n = fixedU ? nu : nv;
  const x = fixedU ? u0 + (u1 - u0) * f : v0 + (v1 - v0) * f;
  const span = findSpan(n, p, x, knots);
  const basis = basisFunctions(span, x, p, knots);
  const count = fixedU ? nv : nu;
  const points: Tuple3[] = [];
  const weights: number[] = [];
  for (let k = 0; k < count; k++) {
    let w = 0;
    const h: Tuple3 = [0, 0, 0];
    for (let r = 0; r <= p; r++) {
      const i = span - p + r;
      const [a, b] = fixedU ? [i, k] : [k, i];
      const q = (s.points[a] as readonly Tuple3[])[b] as Tuple3;
      const wq = s.weights?.[a]?.[b] ?? 1;
      const c = (basis[r] as number) * wq;
      h[0] += c * q[0];
      h[1] += c * q[1];
      h[2] += c * q[2];
      w += c;
    }
    points.push([h[0] / w, h[1] / w, h[2] / w]);
    weights.push(w);
  }
  const rational = s.weights !== undefined;
  return {
    degree: fixedU ? s.degreeV : s.degreeU,
    points,
    knots: [...(fixedU ? s.knotsV : s.knotsU)],
    ...(rational ? { weights } : {}),
  };
}
const LEVEL: Readonly<Record<Continuity | 'none', number>> = {
  none: -1,
  G0: 0,
  G1: 1,
  G2: 2,
  G3: 3,
};
const ACHIEVED = ['none', 'G0', 'G1', 'G2', 'G3'] as const;
const DEGREES = 180 / Math.PI;

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Tuple3) => Math.sqrt(dot(a, a));
const unit = (a: Tuple3): Tuple3 => {
  const l = norm(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const angleBetween = (a: Tuple3, b: Tuple3) => atan2(norm(cross(a, b)), dot(a, b)) * DEGREES;

function invalid(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

/** Parameters (u, v) of normalized position `f` along a side. */
export function sideParameters(s: NurbsSurface, side: PatchSide, f: number): [number, number] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const u = u0 + (u1 - u0) * f;
  const v = v0 + (v1 - v0) * f;
  switch (side) {
    case 'u0':
      return [u0, v];
    case 'u1':
      return [u1, v];
    case 'v0':
      return [u, v0];
    case 'v1':
      return [u, v1];
  }
}

/** Derivative along the side and toward the patch interior at a curvature frame. */
function sideVectors(c: SurfaceCurvature, side: PatchSide): { along: Tuple3; inward: Tuple3 } {
  switch (side) {
    case 'u0':
      return { along: c.sv, inward: c.su };
    case 'u1':
      return { along: c.sv, inward: [-c.su[0], -c.su[1], -c.su[2]] };
    case 'v0':
      return { along: c.su, inward: c.sv };
    case 'v1':
      return { along: c.su, inward: [-c.sv[0], -c.sv[1], -c.sv[2]] };
  }
}

interface SideSampler {
  readonly side: PatchSide;
  readonly points: readonly Tuple3[];
  readonly length: number;
}

const SIDE_SAMPLES = 32;

function sideSampler(s: NurbsSurface, side: PatchSide): SideSampler {
  const points: Tuple3[] = [];
  let length = 0;
  for (let k = 0; k <= SIDE_SAMPLES; k++) {
    const [u, v] = sideParameters(s, side, k / SIDE_SAMPLES);
    const p = (surfaceDerivatives(s, u, v, 0)[0] as Tuple3[])[0] as Tuple3;
    if (k > 0) length += norm(sub(p, points[k - 1] as Tuple3));
    points.push(p);
  }
  return { side, points, length };
}

/** Closest point of a side to `p`: sampled start, then Newton on the squared distance. */
function closestOnSide(
  s: NurbsSurface,
  sampler: SideSampler,
  p: Tuple3,
): { f: number; distance: number } {
  let best = 0;
  let bestD = Infinity;
  for (const [k, q] of sampler.points.entries()) {
    const d = norm(sub(q, p));
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  let f = best / SIDE_SAMPLES;
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const span = sampler.side === 'u0' || sampler.side === 'u1' ? v1 - v0 : u1 - u0;
  for (let it = 0; it < 30; it++) {
    const [u, v] = sideParameters(s, sampler.side, f);
    const d = surfaceDerivatives(s, u, v, 2);
    const S = (d[0] as Tuple3[])[0] as Tuple3;
    const along = sampler.side === 'u0' || sampler.side === 'u1';
    const d1 = (along ? (d[0] as Tuple3[])[1] : (d[1] as Tuple3[])[0]) as Tuple3;
    const d2 = (along ? (d[0] as Tuple3[])[2] : (d[2] as Tuple3[])[0]) as Tuple3;
    const r = sub(S, p);
    const g = dot(d1, r) * span;
    const h = (dot(d1, d1) + dot(d2, r)) * span * span;
    if (!(h > 0)) break;
    const next = Math.min(1, Math.max(0, f - g / h));
    const done = Math.abs(next - f) < 1e-14;
    f = next;
    if (done) break;
  }
  const [u, v] = sideParameters(s, sampler.side, f);
  const q = (surfaceDerivatives(s, u, v, 0)[0] as Tuple3[])[0] as Tuple3;
  return { f, distance: norm(sub(q, p)) };
}

/** Closest point of `s`'s side to `p`: normalized position along the side and distance. */
export function closestSidePoint(
  s: NurbsSurface,
  side: PatchSide,
  p: Tuple3,
): { readonly f: number; readonly distance: number } {
  return closestOnSide(s, sideSampler(s, side), p);
}

/** Polyline of a feature curve for distance queries. */
function curvePolyline(curve: NurbsCurve, count: number): Tuple3[] {
  const [t0, t1] = domain(curve);
  return Array.from({ length: count + 1 }, (_, k) => {
    const t = t0 + ((t1 - t0) * k) / count;
    return curveCurvature(curve, t).point;
  });
}

function polylineDistance(polyline: readonly Tuple3[], p: Tuple3): number {
  let best = Infinity;
  for (let k = 1; k < polyline.length; k++) {
    const a = polyline[k - 1] as Tuple3;
    const ab = sub(polyline[k] as Tuple3, a);
    const l2 = dot(ab, ab);
    const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
    best = Math.min(best, norm(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])));
  }
  return best;
}

function bounds(s: NurbsSurface): [Tuple3, Tuple3] {
  const lo: Tuple3 = [Infinity, Infinity, Infinity];
  const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const row of s.points)
    for (const p of row)
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c] as number, p[c] as number);
        hi[c] = Math.max(hi[c] as number, p[c] as number);
      }
  return [lo, hi];
}

interface Thresholds {
  readonly position: number;
  readonly angle: number;
  readonly curvature: number | undefined;
  readonly curvatureFloor: number;
  readonly rate: number;
  readonly adjacency: number;
  readonly samples: number;
  readonly classes: Partial<Readonly<Record<EdgeClass, EdgeLimits>>>;
}

/** The limits one edge class is judged by. */
interface ClassLimits {
  readonly position: number;
  readonly angle: number;
  /** G2 limit at one sample from the two curvatures (1/m). */
  readonly curvature: (ka: number, kb: number) => number;
  /** G3 limit at one sample from the two curvature rates (1/m^2). */
  readonly rate: (ra: number, rb: number) => number;
}

/**
 * Limits of an edge class: the class's own values when declared, else the global ones (G2:
 * absolute when given, else 5 % of the larger curvature, at least the floor).
 */
function classLimits(t: Thresholds, cls: EdgeClass): ClassLimits {
  const c = t.classes[cls] ?? {};
  const ratio = c.curvatureRatio;
  const rate = c.rateRatio ?? t.rate;
  return {
    position: c.position ?? t.position,
    angle: c.angle ?? t.angle,
    curvature: (ka, kb) =>
      ratio === undefined && t.curvature !== undefined
        ? t.curvature
        : Math.max(t.curvatureFloor, (ratio ?? 0.05) * Math.max(Math.abs(ka), Math.abs(kb))),
    rate: (ra, rb) => Math.max(0.01, rate * Math.max(Math.abs(ra), Math.abs(rb))),
  };
}

interface EdgeMeasure {
  readonly a: number;
  readonly sideA: PatchSide | 'trim';
  readonly trim?: number;
  readonly b: number;
  readonly sideB: PatchSide;
  readonly fs: number[];
  /** Samples left out at a run-out tip; with no `fs`, nothing was measured. */
  readonly skipped?: number;
  readonly gap: Worst;
  readonly angle: Worst;
  readonly curvature: Worst;
  readonly rate: Worst;
  readonly achieved: Continuity | 'none';
  readonly points: Tuple3[];
}

/** Whether some side other than `a`'s own `sideA` and `b`'s lies nearer to `p`. */
function closerSide(
  surfaces: readonly NamedSurface[],
  samplers: readonly (readonly SideSampler[])[],
  a: number,
  sideA: PatchSide,
  b: number,
  p: Tuple3,
  distance: number,
): boolean {
  for (const [c, sides] of samplers.entries()) {
    if (c === b) continue;
    for (const sampler of sides) {
      if (c === a && sampler.side === sideA) continue;
      // Cheap reject: every sample farther than the distance plus the sampling chord.
      const near = sampler.points.some(
        (q) => norm(sub(q, p)) <= distance + sampler.length / SIDE_SAMPLES,
      );
      if (!near) continue;
      if (closestOnSide((surfaces[c] as NamedSurface).surface, sampler, p).distance < distance)
        return true;
    }
  }
  return false;
}

/**
 * Whether `p`, nearest to an end of `side`, lies past that end along the side: a curve that
 * continues the side end to end (a blend's end section leaving its contact) is not beside it.
 */
function beyondEnd(s: NurbsSurface, side: PatchSide, f: number, p: Tuple3): boolean {
  if (f > 1e-9 && f < 1 - 1e-9) return false;
  const [u, v] = sideParameters(s, side, f);
  const c = surfaceCurvature(s, u, v);
  if (c === undefined) return false;
  const along = sideVectors(c, side).along;
  const outward = f <= 1e-9 ? -1 : 1;
  return (outward * dot(sub(p, c.point), along)) / Math.max(norm(along), 1e-300) > 1e-9;
}

const OPPOSITE: Readonly<Record<PatchSide, PatchSide>> = { u0: 'u1', u1: 'u0', v0: 'v1', v1: 'v0' };

/**
 * Share of a transition band's widest station below which it counts as a run-out tip: there
 * the band narrows to nothing and its normals and curvature are fit noise, not continuity.
 */
const TIP_SHARE = 0.01;

/** Width of a patch across from `side` (to the opposite side) at `f`. */
function bandWidth(s: NurbsSurface, side: PatchSide, f: number): number {
  const [u, v] = sideParameters(s, side, f);
  const [uo, vo] = sideParameters(s, OPPOSITE[side], f);
  const p = (surfaceDerivatives(s, u, v, 0)[0] as Tuple3[])[0] as Tuple3;
  const q = (surfaceDerivatives(s, uo, vo, 0)[0] as Tuple3[])[0] as Tuple3;
  return norm(sub(p, q));
}

const tips = new WeakMap<NurbsSurface, Map<PatchSide, readonly [number, number]>>();

/**
 * The run-out tips of a blend band along `side`: from each end where the band collapses to a
 * point (its radius run out to zero), the stretch over which it stays under `TIP_SHARE` of
 * its widest station, as [up to f, from f]; [-1, 2] without a run-out. A band that only
 * narrows (a ramp that never reaches zero) has none.
 */
function tipsOf(s: NurbsSurface, side: PatchSide): readonly [number, number] {
  const cache = tips.get(s) ?? new Map<PatchSide, readonly [number, number]>();
  tips.set(s, cache);
  const known = cache.get(side);
  if (known !== undefined) return known;
  const n = 512;
  const widths = Array.from({ length: n + 1 }, (_, k) => bandWidth(s, side, k / n));
  const max = maxOf(widths);
  const collapsed = (w: number) => w <= 1e-9 * (1 + max);
  let lo = -1;
  if (collapsed(widths[0] as number))
    for (let k = 0; k <= n && (widths[k] as number) < TIP_SHARE * max; k++) lo = k / n;
  let hi = 2;
  if (collapsed(widths[n] as number))
    for (let k = n; k >= 0 && (widths[k] as number) < TIP_SHARE * max; k--) hi = k / n;
  const out = [lo, hi] as const;
  cache.set(side, out);
  return out;
}

/**
 * Whether a blend band is at a run-out tip across from `side` at `f` (`tipsOf`) and lies
 * flat there: its middle within `position` of the chord between its two sides (a bulge in
 * the tip is a defect, not fit noise).
 */
function runOutTip(
  entry: NamedSurface,
  side: PatchSide,
  f: number,
  /** Flatness bound of the tip; without one (joint and highlight checks) any run-out tip counts. */
  position = Infinity,
): boolean {
  if (entry.transition?.kind !== 'blend') return false;
  const [lo, hi] = tipsOf(entry.surface, side);
  if (!(f <= lo || f >= hi)) return false;
  const s = entry.surface;
  const point = (u: number, v: number) =>
    (surfaceDerivatives(s, u, v, 0)[0] as Tuple3[])[0] as Tuple3;
  const [u0, v0] = sideParameters(s, side, f);
  const [u1, v1] = sideParameters(s, OPPOSITE[side], f);
  const p0 = point(u0, v0);
  const d = sub(point(u1, v1), p0);
  const pm = point((u0 + u1) / 2, (v0 + v1) / 2);
  const w = Math.max(0, Math.min(1, dot(sub(pm, p0), d) / Math.max(dot(d, d), 1e-300)));
  return norm(sub(pm, [p0[0] + d[0] * w, p0[1] + d[1] * w, p0[2] + d[2] * w])) <= position;
}

/** Whether a patch is a blend band that runs out to a point (`tipsOf`). */
function runsOut(entry: NamedSurface): boolean {
  if (entry.transition?.kind !== 'blend') return false;
  return SIDES.some((side) => {
    const [lo, hi] = tipsOf(entry.surface, side);
    return lo >= 0 || hi <= 1;
  });
}

/** Samples along an edge: a run-out band's needs four times as many (at least 64) near its tip. */
function samplesFor(
  surfaces: readonly NamedSurface[],
  a: number,
  b: number,
  t: Thresholds,
): number {
  return runsOut(surfaces[a] as NamedSurface) || runsOut(surfaces[b] as NamedSurface)
    ? Math.max(4 * t.samples, 64)
    : t.samples;
}

/** Measure the shared part of side `sideA` of `a` against every side of `b`. */
function measureSide(
  surfaces: readonly NamedSurface[],
  samplers: readonly (readonly SideSampler[])[],
  a: number,
  sideA: PatchSide,
  b: number,
  t: Thresholds,
  limits: ClassLimits,
): EdgeMeasure[] {
  const A = (surfaces[a] as NamedSurface).surface;
  const B = (surfaces[b] as NamedSurface).surface;
  const h = rateStep((samplers[a] as readonly SideSampler[])[SIDES.indexOf(sideA)] as SideSampler);
  const groups = new Map<PatchSide, { f: number; fb: number }[]>();
  const skipped = new Map<PatchSide, number>();
  const samples = samplesFor(surfaces, a, b, t);
  for (let k = 0; k < samples; k++) {
    const f = (k + 0.5) / samples;
    // A side's part inside a trimmed region is not there.
    if (trimmed(surfaces[a] as NamedSurface, sideA, f)) continue;
    const [u, v] = sideParameters(A, sideA, f);
    const ca = surfaceCurvature(A, u, v);
    if (ca === undefined) continue;
    let best: { side: PatchSide; f: number; distance: number } | undefined;
    for (const sampler of samplers[b] as readonly SideSampler[]) {
      if (a === b && sampler.side === sideA) continue;
      if (sampler.length < t.adjacency) continue;
      const hit = closestOnSide(B, sampler, ca.point);
      if (hit.distance <= t.adjacency && (best === undefined || hit.distance < best.distance))
        best = { side: sampler.side, ...hit };
    }
    if (best === undefined) continue;
    if (trimmed(surfaces[b] as NamedSurface, best.side, best.f)) continue;
    // A gap side pairs only with its nearest neighbour: a blend between two patches
    // leaves their sides close but not adjacent.
    // A sample beyond the end of b's side continues it end to end; it is not beside it.
    if (best.distance > t.position && (best.f <= 1e-9 || best.f >= 1 - 1e-9)) continue;
    if (beyondEnd(B, best.side, best.f, ca.point)) continue;
    // Inside the position limit too: where a blend runs out, its faces' sides close in on
    // each other, but the blend's side, clearly nearer, is the neighbour.
    if (
      best.distance > t.position * 1e-4 &&
      closerSide(surfaces, samplers, a, sideA, b, ca.point, best.distance / 2)
    )
      continue;
    // Where a blend runs out to a point, its normals there carry no continuity; it still has
    // to stay on its neighbour.
    if (
      best.distance <= limits.position &&
      (runOutTip(surfaces[a] as NamedSurface, sideA, f, limits.position) ||
        runOutTip(surfaces[b] as NamedSurface, best.side, best.f, limits.position))
    ) {
      skipped.set(best.side, (skipped.get(best.side) ?? 0) + 1);
      continue;
    }
    const [ub, vb] = sideParameters(B, best.side, best.f);
    const cb = surfaceCurvature(B, ub, vb);
    if (cb === undefined) continue;
    // Sides that merely cross at a corner are not a shared edge.
    const ta = unit(sideVectors(ca, sideA).along);
    const tb = unit(sideVectors(cb, best.side).along);
    if (Math.abs(dot(ta, tb)) < 0.866) continue;
    const list = groups.get(best.side) ?? [];
    list.push({ f, fb: best.f });
    groups.set(best.side, list);
  }
  const out: EdgeMeasure[] = [];
  const none: Worst = { value: 0, t: 0, point: [0, 0, 0] };
  // Tip samples with no measured part of `b` beside them: that shared part went unmeasured
  // (where some side of `b` was measured, the tip's other pairings are its far contact).
  const measured = [...groups.values()].some((list) => list.length >= 2);
  for (const [sideB, count] of skipped)
    if (!measured)
      out.push({
        a,
        sideA,
        b,
        sideB,
        fs: [],
        skipped: count,
        gap: none,
        angle: none,
        curvature: none,
        rate: none,
        achieved: 'none',
        points: [],
      });
  for (const [sideB, list] of groups) {
    if (list.length < 2) continue;
    let gap: Worst = { value: 0, t: list[0]?.f as number, point: [0, 0, 0] };
    let angle: Worst = gap;
    let curvature: Worst = gap;
    let rate: Worst = gap;
    let level = 3;
    const points: Tuple3[] = [];
    for (const { f, fb } of list) {
      const [u, v] = sideParameters(A, sideA, f);
      const [ub, vb] = sideParameters(B, sideB, fb);
      const ca = surfaceCurvature(A, u, v) as SurfaceCurvature;
      const cb = surfaceCurvature(B, ub, vb) as SurfaceCurvature;
      points.push(ca.point);
      const e = compareAt(ca, sideA, cb, sideB);
      const s = judge(e, limits, f, ca.point, A, u, v, B, ub, vb, h);
      if (e.gap > gap.value) gap = { value: e.gap, t: f, point: ca.point };
      if (e.kink > angle.value) angle = { value: e.kink, t: f, point: ca.point };
      const jump = Math.abs(e.ka - e.kb);
      if (jump > curvature.value) curvature = { value: jump, t: f, point: ca.point };
      if (s.rate !== undefined && s.rate.value > rate.value) rate = s.rate;
      level = Math.min(level, s.level);
    }
    out.push({
      a,
      sideA,
      b,
      sideB,
      fs: list.map((x) => x.f),
      skipped: skipped.get(sideB) ?? 0,
      gap,
      angle,
      curvature,
      rate,
      achieved: ACHIEVED[level + 1] as Continuity | 'none',
      points,
    });
  }
  return out;
}

/** Whether normalized position `f` along `side` lies in a region the patch trims away. */
function trimmed(entry: NamedSurface, side: PatchSide, f: number): boolean {
  if (entry.trims === undefined || entry.trims.length === 0) return false;
  const p: Point2 =
    side === 'u0' ? [0, f] : side === 'u1' ? [1, f] : side === 'v0' ? [f, 0] : [f, 1];
  return insideLoops(p, entry.trims);
}

/** Whether normalized point `p` lies in an odd number of the loops (trimmed away). */
function insideLoops(p: Point2, loops: readonly (readonly Point2[])[]): boolean {
  let inside = false;
  for (const loop of loops)
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i] as Point2;
      const b = loop[j] as Point2;
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
    }
  return inside;
}

/** Measure the part of `a`'s trim loop `k` that runs beside a side of `b`. */
function measureTrim(
  surfaces: readonly NamedSurface[],
  samplers: readonly (readonly SideSampler[])[],
  a: number,
  k: number,
  loop: readonly Point2[],
  b: number,
  t: Thresholds,
  limits: ClassLimits,
): EdgeMeasure[] {
  const A = (surfaces[a] as NamedSurface).surface;
  const B = (surfaces[b] as NamedSurface).surface;
  const loops = (surfaces[a] as NamedSurface).trims ?? [];
  // Along a blend its declared gap is the trim edge's position limit; a run-out tip still lies
  // flat within the class position (a round band's own sagitta is not a bulge).
  const gaps = [surfaces[a], surfaces[b]].flatMap((x) =>
    x?.transition?.gap === undefined ? [] : [x.transition.gap],
  );
  const held = { ...limits, position: Math.min(limits.position, ...gaps) };
  const [[u0, u1], [v0, v1]] = surfaceDomain(A);
  const n = loop.length;
  if (n < 3) return [];
  const lengths: number[] = [0];
  for (let i = 0; i < n; i++) {
    const p = loop[i] as Point2;
    const q = loop[(i + 1) % n] as Point2;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    lengths.push((lengths[i] as number) + Math.sqrt(dx * dx + dy * dy));
  }
  const total = lengths[n] as number;
  if (!(total > 0)) return [];
  const count = 2 * samplesFor(surfaces, a, b, t);
  const h = Math.max(
    1e-6,
    1e-4 * maxOf(SIDES.map((_, i) => ((samplers[a] as SideSampler[])[i] as SideSampler).length)),
  );
  type Sample = {
    f: number;
    fb: number;
    side: PatchSide;
    u: number;
    v: number;
    frame: { along: Tuple3; inward: Tuple3 };
  };
  const groups = new Map<PatchSide, Sample[]>();
  const skipped = new Map<PatchSide, number>();
  for (let k2 = 0; k2 < count; k2++) {
    const f = (k2 + 0.5) / count;
    const at = f * total;
    let i = 0;
    while (i + 1 < n && (lengths[i + 1] as number) < at) i++;
    const p = loop[i] as Point2;
    const q = loop[(i + 1) % n] as Point2;
    const seg = (lengths[i + 1] as number) - (lengths[i] as number);
    const w = seg > 0 ? (at - (lengths[i] as number)) / seg : 0;
    const x: Point2 = [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w];
    // Loop parts on (or beyond) the patch's own boundary are open edges, not trim edges.
    if (x.some((c) => c <= 1e-9 || c >= 1 - 1e-9)) continue;
    const d: Point2 = [(q[0] - p[0]) / seg, (q[1] - p[1]) / seg];
    // The kept side: the normal of the loop direction that leaves the trimmed region.
    let normal: Point2 = [d[1], -d[0]];
    if (insideLoops([x[0] + 1e-6 * normal[0], x[1] + 1e-6 * normal[1]], loops))
      normal = [-normal[0], -normal[1]];
    const u = u0 + (u1 - u0) * x[0];
    const v = v0 + (v1 - v0) * x[1];
    const ca = surfaceCurvature(A, u, v);
    if (ca === undefined) continue;
    const vec = (m: Point2): Tuple3 => [
      ca.su[0] * m[0] * (u1 - u0) + ca.sv[0] * m[1] * (v1 - v0),
      ca.su[1] * m[0] * (u1 - u0) + ca.sv[1] * m[1] * (v1 - v0),
      ca.su[2] * m[0] * (u1 - u0) + ca.sv[2] * m[1] * (v1 - v0),
    ];
    let best: { side: PatchSide; f: number; distance: number } | undefined;
    for (const sampler of samplers[b] as readonly SideSampler[]) {
      if (sampler.length < t.adjacency) continue;
      const hit = closestOnSide(B, sampler, ca.point);
      if (hit.distance <= t.adjacency && (best === undefined || hit.distance < best.distance))
        best = { side: sampler.side, ...hit };
    }
    if (best === undefined) continue;
    if (best.distance > t.position && (best.f <= 1e-9 || best.f >= 1 - 1e-9)) continue;
    if (trimmed(surfaces[b] as NamedSurface, best.side, best.f)) continue;
    // Where a blend runs out to a point, its normals there carry no continuity; it still has
    // to stay on the trim edge.
    if (
      best.distance <= held.position &&
      runOutTip(surfaces[b] as NamedSurface, best.side, best.f, limits.position)
    ) {
      skipped.set(best.side, (skipped.get(best.side) ?? 0) + 1);
      continue;
    }
    const [ub, vb] = sideParameters(B, best.side, best.f);
    const cb = surfaceCurvature(B, ub, vb);
    if (cb === undefined) continue;
    const along = vec(d);
    if (Math.abs(dot(unit(along), unit(sideVectors(cb, best.side).along))) < 0.866) continue;
    const list = groups.get(best.side) ?? [];
    list.push({ f, fb: best.f, side: best.side, u, v, frame: { along, inward: vec(normal) } });
    groups.set(best.side, list);
  }
  const out: EdgeMeasure[] = [];
  const none: Worst = { value: 0, t: 0, point: [0, 0, 0] };
  const measured = [...groups.values()].some((list) => list.length >= 2);
  for (const [sideB, count] of skipped)
    if (!measured)
      out.push({
        a,
        sideA: 'trim',
        trim: k,
        b,
        sideB,
        fs: [],
        skipped: count,
        gap: none,
        angle: none,
        curvature: none,
        rate: none,
        achieved: 'none',
        points: [],
      });
  for (const [sideB, list] of groups) {
    if (list.length < 2) continue;
    let gap: Worst = { value: 0, t: list[0]?.f as number, point: [0, 0, 0] };
    let angle: Worst = gap;
    let curvature: Worst = gap;
    let rate: Worst = gap;
    let level = 3;
    const points: Tuple3[] = [];
    for (const sample of list) {
      const ca = surfaceCurvature(A, sample.u, sample.v) as SurfaceCurvature;
      const [ub, vb] = sideParameters(B, sideB, sample.fb);
      const cb = surfaceCurvature(B, ub, vb) as SurfaceCurvature;
      points.push(ca.point);
      const e = compareFrames(ca, sample.frame, cb, sideVectors(cb, sideB));
      const s = judge(e, held, sample.f, ca.point, A, sample.u, sample.v, B, ub, vb, h);
      if (e.gap > gap.value) gap = { value: e.gap, t: sample.f, point: ca.point };
      if (e.kink > angle.value) angle = { value: e.kink, t: sample.f, point: ca.point };
      const jump = Math.abs(e.ka - e.kb);
      if (jump > curvature.value) curvature = { value: jump, t: sample.f, point: ca.point };
      if (s.rate !== undefined && s.rate.value > rate.value) rate = s.rate;
      level = Math.min(level, s.level);
    }
    out.push({
      a,
      sideA: 'trim',
      trim: k,
      b,
      sideB,
      fs: list.map((x) => x.f),
      skipped: skipped.get(sideB) ?? 0,
      gap,
      angle,
      curvature,
      rate,
      achieved: ACHIEVED[level + 1] as Continuity | 'none',
      points,
    });
  }
  return out;
}

/** Worst cross-edge deviations along one known pair of sides (`measureEdge`). */
export interface EdgeResidual {
  /** Largest gap, meters. */
  readonly gap: number;
  /** Largest kink between the cross-edge tangents, degrees. */
  readonly angle: number;
  /** Largest jump of the cross-edge normal curvature, 1/m, and relative to the larger side (at least 0.01 1/m). */
  readonly curvature: number;
  readonly curvatureRatio: number;
  /** Largest jump of the cross-edge curvature rate dk/ds, 1/m^2, and relative (at least 0.01 1/m^2): G3. */
  readonly rate: number;
  readonly rateRatio: number;
  readonly samples: number;
}

/** One cross-edge comparison of two curvature frames. */
interface EdgeSample {
  readonly gap: number;
  readonly kink: number;
  readonly ka: number;
  readonly kb: number;
  /** Unit cross-edge directions into each patch, in its tangent plane. */
  readonly da: Tuple3;
  readonly db: Tuple3;
  /** -1 when the two normals face opposite ways (curvatures of b are negated). */
  readonly sign: number;
}

function compareAt(
  ca: SurfaceCurvature,
  sideA: PatchSide,
  cb: SurfaceCurvature,
  sideB: PatchSide,
): EdgeSample {
  return compareFrames(ca, sideVectors(ca, sideA), cb, sideVectors(cb, sideB));
}

/** One cross-edge comparison given each side's tangent along the edge and toward its patch. */
function compareFrames(
  ca: SurfaceCurvature,
  fa: { readonly along: Tuple3; readonly inward: Tuple3 },
  cb: SurfaceCurvature,
  fb: { readonly along: Tuple3; readonly inward: Tuple3 },
): EdgeSample {
  const T = unit(fa.along);
  const across = (w: Tuple3) => {
    const along = dot(w, T);
    return unit([w[0] - T[0] * along, w[1] - T[1] * along, w[2] - T[2] * along]);
  };
  const da = across(fa.inward);
  const db = across(fb.inward);
  const sign = dot(ca.normal, cb.normal) < 0 ? -1 : 1;
  return {
    gap: norm(sub(ca.point, cb.point)),
    kink: angleBetween(da, [-db[0], -db[1], -db[2]]),
    ka: normalCurvature(ca, da),
    kb: normalCurvature(cb, db) * sign,
    da,
    db,
    sign,
  };
}

/** Step (m) of the curvature-rate difference along a side of this length. */
function rateStep(sampler: SideSampler): number {
  return Math.max(1e-6, 1e-4 * sampler.length);
}

/**
 * The level one sample reaches under `limits` (-1 gap, 0 G0, 1 G1, 2 G2, 3 G3); the curvature
 * rate is evaluated only where the sample is G2.
 */
function judge(
  e: EdgeSample,
  limits: ClassLimits,
  f: number,
  point: Tuple3,
  A: NurbsSurface,
  u: number,
  v: number,
  B: NurbsSurface,
  ub: number,
  vb: number,
  h: number,
): { level: number; rate?: Worst } {
  if (e.gap > limits.position) return { level: -1 };
  if (e.kink > limits.angle) return { level: 0 };
  if (Math.abs(e.ka - e.kb) > limits.curvature(e.ka, e.kb)) return { level: 1 };
  const ra = curvatureRate(A, u, v, e.da, h);
  const rb = curvatureRate(B, ub, vb, e.db, h);
  if (ra === undefined || rb === undefined) return { level: 2 };
  const jump = Math.abs(ra + e.sign * rb);
  return { level: jump > limits.rate(ra, rb) ? 2 : 3, rate: { value: jump, t: f, point } };
}

/**
 * Rate of the normal curvature along `w` moving into the patch from (u, v), 1/m^2:
 * a one-sided second-order difference over steps of `h` meters along the surface.
 */
function curvatureRate(
  s: NurbsSurface,
  u: number,
  v: number,
  w: Tuple3,
  h: number,
): number | undefined {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const at = (step: number): number | undefined => {
    let uu = u;
    let vv = v;
    // Walk in two half steps so the parameter offset follows the surface.
    for (let k = 0; k < 2; k++) {
      const c = surfaceCurvature(s, uu, vv);
      if (c === undefined) return undefined;
      const [E, F, G] = c.first;
      const a = dot(c.su, w) * (step / 2);
      const b = dot(c.sv, w) * (step / 2);
      const det = E * G - F * F;
      uu += (G * a - F * b) / det;
      vv += (E * b - F * a) / det;
    }
    if (uu < u0 - 1e-12 || uu > u1 + 1e-12 || vv < v0 - 1e-12 || vv > v1 + 1e-12) return undefined;
    const c = surfaceCurvature(s, Math.min(u1, Math.max(u0, uu)), Math.min(v1, Math.max(v0, vv)));
    return c === undefined ? undefined : normalCurvature(c, w);
  };
  const k0 = at(0);
  const k1 = at(h);
  const k2 = at(2 * h);
  if (k0 === undefined || k1 === undefined || k2 === undefined) return undefined;
  return (-3 * k0 + 4 * k1 - k2) / (2 * h);
}

/**
 * Measure the edge between `a`'s `sideA` and `b`'s `sideB`: each sample of `a`'s side is
 * paired with the closest point of `b`'s side (no adjacency guess), and the worst gap,
 * kink, curvature jump and curvature-rate jump are reported.
 */
export function measureEdge(
  a: NurbsSurface,
  sideA: PatchSide,
  b: NurbsSurface,
  sideB: PatchSide,
  samples = 32,
): Result<EdgeResidual, ModelingError> {
  return measureEdgeTo(a, sideA, [{ surface: b, side: sideB }], samples);
}

/**
 * @internal `measureEdge` against a side made of several neighbour sides (or parts of
 * them): each sample pairs with the closest point over all of them.
 */
export function measureEdgeTo(
  a: NurbsSurface,
  sideA: PatchSide,
  targets: readonly { readonly surface: NurbsSurface; readonly side: PatchSide }[],
  samples = 32,
): Result<EdgeResidual, ModelingError> {
  for (const s of [a, ...targets.map((t) => t.surface)]) {
    const c = checkSurface(s);
    if (!c.ok) return c;
  }
  if (!SIDES.includes(sideA) || targets.some((t) => !SIDES.includes(t.side)))
    return err(
      invalid("sides are 'u0', 'u1', 'v0' or 'v1'", {
        sideA,
        sideB: targets.length === 1 ? targets[0]?.side : targets.map((t) => t.side),
      }),
    );
  if (!Number.isInteger(samples) || samples < 2 || samples > 1024)
    return err(invalid('samples is an integer from 2 to 1024', { samples }));
  const samplers = targets.map((t) => ({ b: t.surface, sampler: sideSampler(t.surface, t.side) }));
  const h = Math.max(1e-6, 1e-4 * sideSampler(a, sideA).length);
  let gap = 0;
  let angle = 0;
  let curvature = 0;
  let curvatureRatio = 0;
  let rate = 0;
  let rateRatio = 0;
  let measured = 0;
  for (let k = 0; k < samples; k++) {
    const f = (k + 0.5) / samples;
    const [u, v] = sideParameters(a, sideA, f);
    const ca = surfaceCurvature(a, u, v);
    if (ca === undefined) continue;
    let best: { b: NurbsSurface; side: PatchSide; f: number; distance: number } | undefined;
    for (const { b, sampler } of samplers) {
      const hit = closestOnSide(b, sampler, ca.point);
      if (best === undefined || hit.distance < best.distance)
        best = { b, side: sampler.side, ...hit };
    }
    if (best === undefined) continue;
    const { b, side: sideB } = best;
    const [ub, vb] = sideParameters(b, sideB, best.f);
    const cb = surfaceCurvature(b, ub, vb);
    if (cb === undefined) continue;
    const e = compareAt(ca, sideA, cb, sideB);
    measured++;
    gap = Math.max(gap, e.gap);
    angle = Math.max(angle, e.kink);
    const jump = Math.abs(e.ka - e.kb);
    curvature = Math.max(curvature, jump);
    curvatureRatio = Math.max(
      curvatureRatio,
      jump / Math.max(Math.abs(e.ka), Math.abs(e.kb), 0.01),
    );
    const ra = curvatureRate(a, u, v, e.da, h);
    const rb = curvatureRate(b, ub, vb, e.db, h);
    if (ra === undefined || rb === undefined) continue;
    const rateJump = Math.abs(ra + e.sign * rb);
    rate = Math.max(rate, rateJump);
    rateRatio = Math.max(rateRatio, rateJump / Math.max(Math.abs(ra), Math.abs(rb), 0.01));
  }
  return ok({ gap, angle, curvature, curvatureRatio, rate, rateRatio, samples: measured });
}

const finitePositive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Arc length, curvature and fairness facts of one feature curve. */
/** A feature line's designed inflection ranges, checked. */
export function inflectionRanges(
  line: FeatureLine,
): Result<readonly (readonly [number, number])[], ModelingError> {
  const ranges = line.inflections ?? [];
  const valid =
    Array.isArray(ranges) &&
    ranges.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 2 &&
        r.every((x) => Number.isFinite(x)) &&
        0 <= r[0] &&
        r[0] < r[1] &&
        r[1] <= 1,
    );
  return valid
    ? ok(ranges)
    : err(
        invalid('inflections are ranges [t0, t1] with 0 <= t0 < t1 <= 1', {
          name: line.name,
          inflections: line.inflections,
        }),
      );
}

/** Checked fairness limits. */
interface FairnessLimits {
  readonly maxInflections: number;
  readonly spikeRatio: number;
  readonly maxRate: number;
  readonly maxRatio: number;
}

function fairnessLimits(options: FairnessOptions): Result<FairnessLimits, ModelingError> {
  const maxInflections = options.maxInflections ?? 0;
  const spikeRatio = options.spike ?? 0.5;
  const maxRate = options.maxCurvatureRate ?? Infinity;
  const maxRatio = options.maxRateRatio ?? 15;
  if (!(Number.isInteger(maxInflections) && maxInflections >= 0))
    return err(invalid('maxInflections is a non-negative integer', { maxInflections }));
  if (
    !finitePositive(spikeRatio) ||
    !finitePositive(maxRatio) ||
    !(maxRate === Infinity || finitePositive(maxRate))
  )
    return err(
      invalid('spike, maxCurvatureRate and maxRateRatio are positive', {
        spike: spikeRatio,
        maxCurvatureRate: maxRate,
        maxRateRatio: maxRatio,
      }),
    );
  return ok({ maxInflections, spikeRatio, maxRate, maxRatio });
}

/** Curvature samples along a line: normalized position, curvature, arc length, point, binormal. */
interface CurvatureSamples {
  readonly ts: readonly number[];
  readonly ks: readonly number[];
  readonly ss: readonly number[];
  readonly points: readonly Tuple3[];
  readonly binormals: readonly Tuple3[];
}

export function curveFairness(
  line: FeatureLine,
  options: FairnessOptions = {},
): Result<CurveFairness, ModelingError> {
  const checked = checkCurve(line.curve);
  if (!checked.ok) return checked;
  const samples = options.samples ?? 256;
  if (!Number.isInteger(samples) || samples < 16 || samples > 4096)
    return err(invalid('fairness samples is an integer from 16 to 4096', { samples }));
  const limits = fairnessLimits(options);
  if (!limits.ok) return limits;
  const ranges = inflectionRanges(line);
  if (!ranges.ok) return ranges;
  const [t0, t1] = domain(line.curve);
  const ts: number[] = [];
  const ks: number[] = [];
  const ss: number[] = [];
  const points: Tuple3[] = [];
  const binormals: Tuple3[] = [];
  let previousSpeed = 0;
  let previousT = t0;
  for (let k = 0; k < samples; k++) {
    const t = t0 + ((t1 - t0) * k) / (samples - 1);
    const c = curveCurvature(line.curve, t);
    ts.push((t - t0) / (t1 - t0));
    ks.push(c.curvature);
    points.push(c.point);
    binormals.push(c.binormal);
    ss.push(
      k === 0 ? 0 : (ss[k - 1] as number) + ((previousSpeed + c.speed) / 2) * (t - previousT),
    );
    previousSpeed = c.speed;
    previousT = t;
  }
  return judgeFairness(line.name, { ts, ks, ss, points, binormals }, ranges.value, limits.value);
}

/**
 * Fairness of a traced line judged on its exact points (no fitted curve, whose smoothing
 * rings at curvature steps): curvature and binormal from the circle through each point and
 * its neighbours, positions by chord length, and the rate ratio over the curved length.
 */
function pointFairness(
  name: string,
  points: readonly Tuple3[],
  ranges: readonly (readonly [number, number])[],
  limits: FairnessLimits,
): Result<CurveFairness, ModelingError> {
  const ss: number[] = [0];
  for (let k = 1; k < points.length; k++)
    ss.push((ss[k - 1] as number) + norm(sub(points[k] as Tuple3, points[k - 1] as Tuple3)));
  const length = ss.at(-1) as number;
  const ks: number[] = [];
  const binormals: Tuple3[] = [];
  for (let k = 1; k < points.length - 1; k++) {
    const a = points[k - 1] as Tuple3;
    const b = points[k] as Tuple3;
    const c = points[k + 1] as Tuple3;
    const turn = cross(sub(b, a), sub(c, b));
    const chords = norm(sub(b, a)) * norm(sub(c, b)) * norm(sub(c, a));
    ks.push(chords > 0 ? (2 * norm(turn)) / chords : 0);
    binormals.push(unit(turn));
  }
  // The end points take their neighbour's curvature.
  ks.unshift(ks[0] ?? 0);
  ks.push(ks.at(-1) ?? 0);
  binormals.unshift(binormals[0] ?? [0, 0, 0]);
  binormals.push(binormals.at(-1) ?? [0, 0, 0]);
  const ts = ss.map((x) => (length > 0 ? x / length : 0));
  return judgeFairness(name, { ts, ks, ss, points, binormals }, ranges, limits, true);
}

function judgeFairness(
  name: string,
  data: CurvatureSamples,
  ranges: readonly (readonly [number, number])[],
  limits: FairnessLimits,
  curved = false,
): Result<CurveFairness, ModelingError> {
  const { ts, ks, ss, points, binormals } = data;
  const { maxInflections, spikeRatio, maxRate, maxRatio } = limits;
  const samples = ks.length;
  const length = ss[samples - 1] as number;
  if (!(length > 0))
    return err(modelingError('model-degenerate', 'the curve has length', { name }));
  const place = (k: number): CurvePlace => ({ t: ts[k] as number, point: points[k] as Tuple3 });
  const maxCurvature = maxOf(ks);
  // Curvature below 1 % of the maximum is noise around a flat point, not a side.
  const floor = Math.max(1e-2 * maxCurvature, 1e-6 / length);
  // A traced line's scale is its curved part: a straight run beside a bend neither
  // dilutes nor inflates how narrow or abrupt the bend is.
  let scale = length;
  if (curved) {
    scale = 0;
    for (let k = 1; k < samples; k++)
      if ((ks[k] as number) > floor || (ks[k - 1] as number) > floor)
        scale += (ss[k] as number) - (ss[k - 1] as number);
  }
  const found: CurvePlace[] = [];
  let last = -1;
  for (let k = 0; k < samples; k++) {
    if ((ks[k] as number) <= floor) continue;
    if (last >= 0 && dot(binormals[last] as Tuple3, binormals[k] as Tuple3) < 0) {
      const mid = place(Math.round((last + k) / 2));
      // A flip within 1 % of an end is the end's own flat point, not an interior inflection.
      if (mid.t > 0.01 && mid.t < 0.99) found.push(mid);
    }
    last = k;
  }
  const used = new Set<number>();
  const designed: CurvePlace[] = [];
  const inflections: CurvePlace[] = [];
  for (const place of found) {
    const r = ranges.findIndex(([a, b], i) => !used.has(i) && a <= place.t && place.t <= b);
    if (r < 0) {
      inflections.push(place);
      continue;
    }
    used.add(r);
    designed.push(place);
  }
  const sorted = [...ks].sort((x, y) => x - y);
  const median = sorted[samples >> 1] as number;
  const spikeFloor = spikeRatio * Math.max(median, 1 / length);
  const spikes: CurveFairness['spikes'][number][] = [];
  for (let k = 1; k < samples - 1; k++) {
    const kv = ks[k] as number;
    if (!(kv > (ks[k - 1] as number) && kv >= (ks[k + 1] as number))) continue;
    let l = k;
    while (l > 0 && (ks[l - 1] as number) <= (ks[l] as number)) l--;
    let r = k;
    while (r < samples - 1 && (ks[r + 1] as number) <= (ks[r] as number)) r++;
    const prominence = kv - Math.max(ks[l] as number, ks[r] as number);
    const width = (ss[r] as number) - (ss[l] as number);
    if (prominence > spikeFloor && width < scale / 5)
      spikes.push({ ...place(k), curvature: kv, prominence });
  }
  let curvatureRate = 0;
  let rateIndex = 0;
  for (let k = 1; k < samples - 1; k++) {
    const ds = (ss[k + 1] as number) - (ss[k - 1] as number);
    if (!(ds > 0)) continue;
    const rate = Math.abs((ks[k + 1] as number) - (ks[k - 1] as number)) / ds;
    if (rate > curvatureRate) {
      curvatureRate = rate;
      rateIndex = k;
    }
  }
  const rateRatio = maxCurvature * scale < 0.05 ? 0 : (curvatureRate * scale) / maxCurvature;
  return ok({
    name,
    length,
    maxCurvature,
    inflections,
    designed,
    spikes,
    curvatureRate,
    rateRatio,
    rateAt: place(rateIndex),
    pass:
      inflections.length <= maxInflections &&
      spikes.length === 0 &&
      curvatureRate <= maxRate &&
      rateRatio <= maxRatio,
  });
}

/** The patch side a normalized point lies on (within 1e-6), and its parameter along it. */
function sideAt(s: NurbsSurface, q: HighlightPoint): { side: PatchSide; f: number } | undefined {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const a = (q.u - u0) / (u1 - u0);
  const b = (q.v - v0) / (v1 - v0);
  const sides: [PatchSide, number, number][] = [
    ['u0', a, b],
    ['u1', 1 - a, b],
    ['v0', b, a],
    ['v1', 1 - b, a],
  ];
  sides.sort((x, y) => x[1] - y[1]);
  const [side, d, f] = sides[0] as [PatchSide, number, number];
  return d <= 1e-6 ? { side, f } : undefined;
}

/**
 * Turns of a transition band's width law along `along` (sign changes of its second
 * difference): a run-out's lines follow its width, so each turn is a designed inflection
 * of the lines running along the band.
 */
function widthTurns(entry: NamedSurface, along: 'u' | 'v'): number {
  if (entry.transition?.kind !== 'blend') return 0;
  const side: PatchSide = along === 'u' ? 'v0' : 'u0';
  const w = Array.from({ length: 65 }, (_, k) => bandWidth(entry.surface, side, k / 64));
  const d2 = w.slice(1, -1).map((x, k) => (w[k] as number) - 2 * x + (w[k + 2] as number));
  const largest = maxOf(d2.map(Math.abs));
  if (!(largest > 1e-6 * maxOf(w))) return 0;
  let turns = 0;
  let sign = 0;
  for (const x of d2) {
    if (Math.abs(x) <= 1e-2 * largest) continue;
    if (sign !== 0 && Math.sign(x) !== sign) turns++;
    sign = Math.sign(x);
  }
  return turns;
}

/**
 * Largest highlight-field jump across a joint, in line spacings: 1/50 of the stripe pitch is
 * below what the eye resolves in a zebra, yet a 0.25 degree kink at the zebra stripe widths exceeds it.
 */
const JOINT_JUMP = 0.02;

/** Sample positions per joint for the highlight break check. */
const JOINT_SAMPLES = 64;

/** Point and unit normal (dS/du x dS/dv) of `s` at (u, v), when the normal is defined. */
function frameAt(s: NurbsSurface, u: number, v: number): { p: Tuple3; n: Tuple3 } | undefined {
  const d = surfaceDerivatives(s, u, v, 1);
  const c = cross((d[1] as Tuple3[])[0] as Tuple3, (d[0] as Tuple3[])[1] as Tuple3);
  const l = norm(c);
  if (!(l > 1e-14)) return undefined;
  return { p: (d[0] as Tuple3[])[0] as Tuple3, n: [c[0] / l, c[1] / l, c[2] / l] };
}

/** Name of an edge in the issues' `subject` and in coverage: `a:side|b:side`, a trim loop numbered. */
function edgeId(e: ContinuityEdge): string {
  return `${e.a}:${e.sideA}${e.trim === undefined ? '' : e.trim}|${e.b}:${e.sideB}`;
}

/** Interior knots of full multiplicity along one direction of a patch, where it may kink. */
function fullKnots(s: NurbsSurface, along: 'u' | 'v'): number[] {
  const knots = along === 'u' ? s.knotsU : s.knotsV;
  const degree = along === 'u' ? s.degreeU : s.degreeV;
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const [t0, t1] = along === 'u' ? [u0, u1] : [v0, v1];
  return [...new Set(knots)].filter(
    (t) => t > t0 && t < t1 && knots.filter((x) => x === t).length >= degree,
  );
}

/** Name of a knot line in coverage. */
function knotId(name: string, along: 'u' | 'v', t: number): string {
  return `${name}:${along}@${t}`;
}

/** Every joint the highlight check owns, listed from the edges and knots before it runs. */
function jointSubjects(
  surfaces: readonly NamedSurface[],
  edges: readonly ContinuityEdge[],
): string[] {
  const out = edges.map(edgeId);
  for (const { name, surface } of surfaces)
    for (const along of ['u', 'v'] as const)
      for (const t of fullKnots(surface, along)) out.push(knotId(name, along, t));
  return out;
}

/** The largest highlight-field jump across one joint, in line spacings, and where. */
interface JointJump {
  readonly a: number;
  readonly b: number;
  readonly jump: number;
  readonly point: Tuple3;
}

/**
 * Jumps of the highlight field across the joints the lines must cross smoothly: shared
 * edges not declared breaks, and interior knot lines of full multiplicity (where a patch
 * may kink). Both sides are evaluated at the joint itself, so a kink shows as a stripe
 * offset there whether or not a traced line crosses it.
 */
function jointJumps(
  surfaces: readonly NamedSurface[],
  edges: readonly ContinuityEdge[],
  field: Field,
  exemptPatch: (k: number) => boolean,
  exemptEdge: (e: ContinuityEdge) => boolean,
  exemptPoint: (p: Tuple3) => boolean,
  adjacency: number,
  evaluated: Set<string>,
): JointJump[] {
  const index = new Map(surfaces.map((s, k) => [s.name, k]));
  const out: JointJump[] = [];
  const compare = (x: { p: Tuple3; n: Tuple3 }, y: { p: Tuple3; n: Tuple3 }): number => {
    const flip = dot(x.n, y.n) < 0;
    const ny: Tuple3 = flip ? [-y.n[0], -y.n[1], -y.n[2]] : y.n;
    const d = Math.abs(field.coordinate(x.p, x.n) - field.coordinate(y.p, ny));
    return Math.min(d, field.period - d);
  };
  const record = (a: number, b: number, worst: { jump: number; point: Tuple3 } | undefined) => {
    if (worst !== undefined) out.push({ a, b, ...worst });
  };
  const keep = (worst: { jump: number; point: Tuple3 } | undefined, jump: number, point: Tuple3) =>
    Number.isNaN(jump) || (worst !== undefined && worst.jump >= jump) ? worst : { jump, point };
  for (const e of edges) {
    const a = index.get(e.a);
    const b = index.get(e.b);
    if (a === undefined || b === undefined) continue;
    if (exemptEdge(e) || exemptPatch(a) || exemptPatch(b)) {
      evaluated.add(edgeId(e));
      continue;
    }
    const A = surfaces[a] as NamedSurface;
    const B = surfaces[b] as NamedSurface;
    let worst: { jump: number; point: Tuple3 } | undefined;
    let designed = false;
    if (e.sideA === 'trim') {
      for (let k = 0; k < JOINT_SAMPLES; k++) {
        const f = (k + 0.5) / JOINT_SAMPLES;
        if (trimmed(B, e.sideB, f) || runOutTip(B, e.sideB, f)) continue;
        const [ub, vb] = sideParameters(B.surface, e.sideB, f);
        const y = frameAt(B.surface, ub, vb);
        if (y === undefined) continue;
        if (exemptPoint(y.p)) {
          designed = true;
          continue;
        }
        const hit = surfaceClosest(A.surface, y.p);
        if (hit.distance > adjacency) continue;
        const x = frameAt(A.surface, hit.u, hit.v);
        if (x !== undefined) worst = keep(worst, compare(x, y), y.p);
      }
      if (worst !== undefined || designed) evaluated.add(edgeId(e));
      record(a, b, worst);
      continue;
    }
    const sampler = sideSampler(B.surface, e.sideB);
    const [r0, r1] = e.range;
    for (let k = 0; k < JOINT_SAMPLES; k++) {
      const f = r0 + ((r1 - r0) * (k + 0.5)) / JOINT_SAMPLES;
      if (trimmed(A, e.sideA, f) || runOutTip(A, e.sideA, f)) continue;
      const [u, v] = sideParameters(A.surface, e.sideA, f);
      const x = frameAt(A.surface, u, v);
      if (x === undefined) continue;
      if (exemptPoint(x.p)) {
        designed = true;
        continue;
      }
      const hit = closestOnSide(B.surface, sampler, x.p);
      if (hit.distance > adjacency || trimmed(B, e.sideB, hit.f) || runOutTip(B, e.sideB, hit.f))
        continue;
      const [ub, vb] = sideParameters(B.surface, e.sideB, hit.f);
      const y = frameAt(B.surface, ub, vb);
      if (y !== undefined) worst = keep(worst, compare(x, y), x.p);
    }
    if (worst !== undefined || designed) evaluated.add(edgeId(e));
    record(a, b, worst);
  }
  for (const [k, entry] of surfaces.entries()) {
    const s = entry.surface;
    if (exemptPatch(k)) {
      for (const along of ['u', 'v'] as const)
        for (const t of fullKnots(s, along)) evaluated.add(knotId(entry.name, along, t));
      continue;
    }
    const [[u0, u1], [v0, v1]] = surfaceDomain(s);
    for (const along of ['u', 'v'] as const) {
      const [t0, t1] = along === 'u' ? [u0, u1] : [v0, v1];
      const eps = 1e-9 * (t1 - t0);
      let worst: { jump: number; point: Tuple3 } | undefined;
      for (const t of fullKnots(s, along)) {
        let sampled = false;
        for (let j = 0; j < JOINT_SAMPLES; j++) {
          const g = (j + 0.5) / JOINT_SAMPLES;
          const tn = (t - t0) / (t1 - t0);
          const normalized: Point2 = along === 'u' ? [tn, g] : [g, tn];
          if (entry.trims !== undefined && insideLoops(normalized, entry.trims)) continue;
          const w = along === 'u' ? v0 + (v1 - v0) * g : u0 + (u1 - u0) * g;
          const at = (x: number) => (along === 'u' ? frameAt(s, x, w) : frameAt(s, w, x));
          const x = at(t - eps);
          const y = at(t + eps);
          if (x === undefined || y === undefined) continue;
          sampled = true;
          if (exemptPoint(x.p)) continue;
          worst = keep(worst, compare(x, y), x.p);
        }
        if (sampled) evaluated.add(knotId(entry.name, along, t));
      }
      record(k, k, worst);
    }
  }
  return out;
}

/** What the highlight check found, the joints it evaluated and why it left the others out. */
interface HighlightOutcome {
  readonly issues: Issue<SurfaceQualityCode>[];
  readonly joints: ReadonlySet<string>;
  readonly unevaluated: UncheckedReason;
}

/** Judge every highlight line by `curveFairness` (see `SurfaceQualityOptions.highlights`). */
function highlightIssues(
  surfaces: readonly NamedSurface[],
  curves: readonly FeatureLine[],
  edges: readonly ContinuityEdge[],
  polylines: readonly (readonly Tuple3[])[],
  options: HighlightOptions,
  fairness: FairnessOptions,
  adjacency: number,
  samples: number,
): Result<HighlightOutcome, ModelingError> {
  const traced = traceHighlights(
    surfaces.map((s) => s.surface),
    options,
    (patch, s, t) => {
      const entry = surfaces[patch] as NamedSurface;
      const trims = entry.trims;
      if (trims !== undefined && trims.length > 0 && insideLoops([s, t], trims)) return true;
      // Every line of a band converges where it runs out to a point: not a line shape.
      return runOutTip(entry, 'v0', s) || runOutTip(entry, 'u0', t);
    },
  );
  if (!traced.ok) return traced;
  const { traces, degrees, diagonal } = traced.value;
  if (traces.length === 0)
    return ok({
      issues: [
        {
          code: 'nothing-checked',
          severity: 'warn',
          detail: { subject: '', reason: 'no highlight line extracted (check the view or field)' },
        },
      ],
      joints: new Set(),
      unevaluated: 'missing-input',
    });
  const field = fieldOf(options);
  if (!field.ok) return field;
  const limits = fairnessLimits(fairness);
  if (!limits.ok) return limits;
  const jumpLimit = JOINT_JUMP;
  if (!(Number.isFinite(jumpLimit) && jumpLimit >= 0))
    return err(invalid('jump is a non-negative number of line spacings', { jump: jumpLimit }));
  const declaredBreak = (line: FeatureLine) =>
    line.continuity !== undefined && LEVEL[line.continuity] <= LEVEL.G1;
  // Bands whose contact edges are declared breaks: a G1 blend, or a band realizing a
  // declared crease (a G0/G1 feature line runs inside it: nearer to most samples of its
  // middle isoparm than the band's sides are), whose own lines are the crease's rounding
  // and are not judged either.
  const g1Bands = new Set<number>();
  const creaseBands = new Set<number>();
  for (const [k, entry] of surfaces.entries()) {
    if (entry.transition === undefined) continue;
    if (entry.transition.kind === 'blend' && entry.transition.continuity === 'G1') g1Bands.add(k);
    for (const along of ['u', 'v'] as const) {
      const middle = curvePolyline(isoparm(entry.surface, along, 0.5), 32);
      const sides = [0, 1].map((f) => curvePolyline(isoparm(entry.surface, along, f), 32));
      const holds = curves.some((line, i) => {
        if (!declaredBreak(line)) return false;
        const inside = middle.filter(
          (p, j) =>
            polylineDistance(polylines[i] as Tuple3[], p) <
            minOf(sides.map((side) => norm(sub(side[j] as Tuple3, p)))),
        );
        return inside.length >= 0.75 * middle.length;
      });
      if (holds) creaseBands.add(k);
    }
  }
  const slack = 1 / samples;
  const exempt = (a: HighlightPoint, b: HighlightPoint): boolean => {
    for (const band of [g1Bands, creaseBands])
      if (band.has(a.patch) || band.has(b.patch)) return true;
    // Points closer than the trace's drop distance merge at a junction, so only one of
    // the two may lie on its side; the other patch's side is then found by projection.
    const onSide = [a, b]
      .map((q) => ({ q, at: sideAt((surfaces[q.patch] as NamedSurface).surface, q) }))
      .find((x) => x.at !== undefined);
    if (onSide === undefined || onSide.at === undefined) return false;
    const { q, at } = onSide;
    const other = (q === a ? b : a).patch;
    const nx = (surfaces[q.patch] as NamedSurface).name;
    const ny = (surfaces[other] as NamedSurface).name;
    return edges.some((e) => {
      let f: number;
      if (e.a === nx && e.sideA === at.side && e.b === ny) f = at.f;
      else if (e.b === nx && e.sideB === at.side && e.a === ny && e.sideA !== 'trim') {
        const projected = closestSidePoint((surfaces[other] as NamedSurface).surface, e.sideA, q.p);
        if (projected.distance > adjacency) return false;
        f = projected.f;
      } else return false;
      return (
        e.feature !== undefined &&
        LEVEL[e.required] <= LEVEL.G1 &&
        e.range[0] - slack <= f &&
        f <= e.range[1] + slack
      );
    });
  };
  // Designed feature-line ranges per patch: the range's middle lies on the patch.
  const rangesOn = surfaces.map(({ surface }) =>
    curves.reduce((count, line) => {
      const [c0, c1] = domain(line.curve);
      return (
        count +
        (line.inflections ?? []).filter(([t0, t1]) => {
          const middle = curvePoint(line.curve, c0 + ((c1 - c0) * (t0 + t1)) / 2);
          return surfaceClosest(surface, middle).distance <= adjacency;
        }).length
      );
    }, 0),
  );
  const issues: Issue<SurfaceQualityCode>[] = [];
  const breaks = curves.flatMap((line, i) =>
    declaredBreak(line) ? [polylines[i] as Tuple3[]] : [],
  );
  const joints = new Set<string>();
  for (const joint of jointJumps(
    surfaces,
    edges,
    field.value,
    (k) => g1Bands.has(k) || creaseBands.has(k),
    (e) => e.feature !== undefined && LEVEL[e.required] <= LEVEL.G1,
    (p) => breaks.some((line) => polylineDistance(line, p) <= adjacency),
    adjacency,
    joints,
  )) {
    if (!(joint.jump > jumpLimit)) continue;
    const names = [...new Set([joint.a, joint.b].map((k) => (surfaces[k] as NamedSurface).name))];
    issues.push({
      code: 'highlight',
      severity: 'warn',
      detail: {
        subject: `${names[0]}:highlight`,
        patches: names,
        point: joint.point,
        jump: joint.jump,
        limit: jumpLimit,
      },
    });
  }
  for (const trace of traces) {
    const pieces: HighlightPoint[][] = [[]];
    for (const [k, q] of trace.points.entries()) {
      const previous = trace.points[k - 1];
      if (previous !== undefined && previous.patch !== q.patch && exempt(previous, q))
        pieces.push([]);
      (pieces.at(-1) as HighlightPoint[]).push(q);
    }
    for (const piece of pieces) {
      if (creaseBands.has((piece[0] as HighlightPoint).patch) || !longEnough(piece, diagonal))
        continue;
      const ps = piece.map((q) => q.p);
      const chord = [0];
      for (let k = 1; k < ps.length; k++)
        chord.push((chord[k - 1] as number) + norm(sub(ps[k] as Tuple3, ps[k - 1] as Tuple3)));
      const t = chord.map((x) => x / (chord.at(-1) as number));
      // Designed inflections, per run of the piece on one patch.
      const allowances: [number, number][] = [];
      for (let start = 0; start < piece.length; ) {
        let end = start;
        while (
          end + 1 < piece.length &&
          (piece[end + 1] as HighlightPoint).patch === (piece[start] as HighlightPoint).patch
        )
          end++;
        const first = piece[start] as HighlightPoint;
        const last = piece[end] as HighlightPoint;
        const range: [number, number] = [t[start] as number, t[end] as number];
        start = end + 1;
        if (!(range[1] > range[0])) continue;
        const entry = surfaces[first.patch] as NamedSurface;
        const [[u0, u1], [v0, v1]] = surfaceDomain(entry.surface);
        const along =
          Math.abs(last.u - first.u) / (u1 - u0) >= Math.abs(last.v - first.v) / (v1 - v0)
            ? 'u'
            : 'v';
        const designed =
          (entry.inflections?.[along] ?? 0) +
          (rangesOn[first.patch] as number) +
          widthTurns(entry, along);
        for (let k = 0; k < designed; k++) allowances.push(range);
      }
      const names = [...new Set(piece.map((q) => (surfaces[q.patch] as NamedSurface).name))];
      const judged = pointFairness(names.join('+'), ps, allowances, limits.value);
      if (!judged.ok) return judged;
      const v = judged.value;
      if (v.pass) continue;
      const { inflections, spikes, rateAt } = v;
      issues.push({
        code: 'highlight',
        severity: 'warn',
        detail: {
          subject: `${names[0]}:highlight`,
          level: trace.level * degrees,
          patches: names,
          point: (inflections[0] ?? spikes[0] ?? rateAt).point,
          inflections,
          spikes,
          rateRatio: v.rateRatio,
          curvatureRate: v.curvatureRate,
          rateAt,
        },
      });
    }
  }
  return ok({ issues, joints, unevaluated: 'unsupported' });
}

/**
 * Check patches and feature lines: control-net density per surface, continuity of every
 * shared edge (G0 gap, G1 kink, G2 cross-edge curvature jump, against what the edge
 * requires), and the fairness of every feature line. Sides are paired by projecting
 * samples of one patch's sides onto the other patch's sides; a pair needs two samples
 * within `adjacency` running the same way. Seams of closed patches count as edges.
 */
export function checkSurfaceQuality(
  input: SurfaceQualityInput,
  options: SurfaceQualityOptions = {},
): Result<SurfaceQualityReport, ModelingError> {
  const surfaces = input.surfaces ?? [];
  const curves = input.curves ?? [];
  const names = new Set<string>();
  for (const [index, entry] of [...surfaces, ...curves].entries()) {
    if (typeof entry?.name !== 'string' || entry.name.length === 0 || names.has(entry.name))
      return err(invalid('every surface and curve has a unique non-empty name', { index }));
    names.add(entry.name);
  }
  for (const entry of surfaces) {
    const checked = checkSurface(entry.surface);
    if (!checked.ok)
      return err({ ...checked.error, detail: { ...checked.error.detail, surface: entry.name } });
  }
  for (const entry of curves) {
    if (entry.continuity !== undefined && !(entry.continuity in LEVEL))
      return err(invalid('continuity is G0, G1, G2 or G3', { curve: entry.name }));
  }
  const position = options.position ?? 1e-4;
  const angle = options.angle ?? 0.5;
  const continuity = options.continuity ?? 'G1';
  const samples = options.samples ?? 16;
  const maxNet = options.maxNet ?? [8, 6];
  if (!finitePositive(position) || !finitePositive(angle))
    return err(invalid('position and angle thresholds are positive', { position, angle }));
  if (options.curvatureFloor !== undefined && !finitePositive(options.curvatureFloor))
    return err(invalid('curvatureFloor is positive', { curvatureFloor: options.curvatureFloor }));
  if (options.curvature !== undefined && !finitePositive(options.curvature))
    return err(invalid('the curvature threshold is positive', { curvature: options.curvature }));
  if (!(continuity in LEVEL) || continuity === ('none' as never))
    return err(invalid('continuity is G0, G1, G2 or G3', { continuity }));
  const rate = options.rate ?? 0.1;
  if (!finitePositive(rate)) return err(invalid('the rate threshold is positive', { rate }));
  const classes = options.classes ?? {};
  for (const [cls, limits] of Object.entries(classes)) {
    if (!['primary', 'blend', 'trim'].includes(cls))
      return err(invalid("classes are keyed by 'primary', 'blend' or 'trim'", { class: cls }));
    for (const [key, value] of Object.entries(limits ?? {}))
      if (
        !['position', 'angle', 'curvatureRatio', 'rateRatio'].includes(key) ||
        !(typeof value === 'number' && value > 0)
      )
        return err(
          invalid('class limits are positive position, angle, curvatureRatio, rateRatio', {
            class: cls,
            [key]: value,
          }),
        );
  }
  if (!Number.isInteger(samples) || samples < 2 || samples > 256)
    return err(invalid('samples is an integer from 2 to 256', { samples }));
  if (!maxNet.every((n) => Number.isInteger(n) && n >= 2))
    return err(invalid('maxNet holds two integers of at least 2', { maxNet }));
  const adjacency = options.adjacency ?? Math.max(1e-3, 10 * position);
  if (!finitePositive(adjacency)) return err(invalid('adjacency is positive', { adjacency }));
  const thresholds: Thresholds = {
    position,
    angle,
    curvature: options.curvature,
    curvatureFloor: options.curvatureFloor ?? 0.01,
    rate,
    adjacency,
    samples,
    classes,
  };
  const fairnessOptions = options.fairness ?? {};
  const issues: Issue<SurfaceQualityCode>[] = [];
  // Subjects are listed from the input before any check; each check marks what it evaluated.
  const sideIds = surfaces.flatMap(({ name }) => SIDES.map((side) => `${name}:${side}`));
  const trimIds = surfaces.flatMap(({ name, trims }) =>
    (trims ?? []).map((_, k) => `${name}:trim${k}`),
  );
  const directionIds = surfaces.flatMap(({ name }) => [`${name}:u`, `${name}:v`]);
  const done = {
    density: new Set<string>(),
    sides: new Set<string>(),
    fairness: new Set<string>(),
    lines: new Set<string>(),
    joints: new Set<string>(),
  };

  const [longest, shortest] = [maxOf(maxNet), minOf(maxNet)];
  const densities: SurfaceDensity[] = surfaces.map(({ name, surface, transition }) => {
    const nu = surface.points.length;
    const nv = (surface.points[0] as readonly Tuple3[]).length;
    // A blend band's net along its edge follows the fit to its contact curves: only across counts.
    const pass =
      transition?.kind === 'blend'
        ? Math.min(nu, nv) <= shortest
        : Math.max(nu, nv) <= longest && Math.min(nu, nv) <= shortest;
    if (!pass)
      issues.push({
        code: 'surface-density',

        severity: 'warn',
        detail: { subject: name, net: [nu, nv], limit: [longest, shortest] },
      });
    done.density.add(name);
    return { name, net: [nu, nv], pass };
  });

  const isoparms = options.isoparms ?? 5;
  if (!(Number.isInteger(isoparms) && isoparms >= 0 && isoparms <= 32))
    return err(invalid('isoparms is an integer from 0 to 32', { isoparms }));
  for (const { name, surface, inflections } of surfaces) {
    for (const along of ['u', 'v'] as const) {
      const allowed = inflections?.[along];
      if (allowed !== undefined && !(Number.isInteger(allowed) && allowed >= 0))
        return err(
          invalid('inflections are non-negative integers', { surface: name, along, allowed }),
        );
      const lineOptions =
        allowed === undefined ? fairnessOptions : { ...fairnessOptions, maxInflections: allowed };
      for (let k = 1; k <= isoparms; k++) {
        const f = k / (isoparms + 1);
        const line = curveFairness({ name, curve: isoparm(surface, along, f) }, lineOptions);
        if (line.ok) done.fairness.add(`${name}:${along}`);
        if (!line.ok || line.value.pass) continue;
        const v = line.value;
        issues.push({
          code: 'surface-fairness',

          severity: 'warn',
          detail: {
            subject: name,
            along,
            parameter: f,
            inflections: v.inflections,
            spikes: v.spikes,
            rateRatio: v.rateRatio,
            curvatureRate: v.curvatureRate,
            point: (v.inflections[0] ?? v.spikes[0] ?? v.rateAt).point,
          },
        });
        break;
      }
    }
  }

  const fair: CurveFairness[] = [];
  for (const line of curves) {
    const result = curveFairness(line, fairnessOptions);
    if (!result.ok)
      return err({ ...result.error, detail: { ...result.error.detail, curve: line.name } });
    fair.push(result.value);
    done.lines.add(line.name);
    const f = result.value;
    if (f.inflections.length > (fairnessOptions.maxInflections ?? 0))
      issues.push({
        code: 'curve-inflection',
        severity: 'warn',
        detail: { subject: f.name, inflections: f.inflections },
      });
    if (f.spikes.length > 0)
      issues.push({
        code: 'curve-spike',
        severity: 'warn',
        detail: { subject: f.name, spikes: f.spikes },
      });
    if (
      f.curvatureRate > (fairnessOptions.maxCurvatureRate ?? Infinity) ||
      f.rateRatio > (fairnessOptions.maxRateRatio ?? 15)
    )
      issues.push({
        code: 'curve-curvature-rate',

        severity: 'warn',
        detail: {
          subject: f.name,
          curvatureRate: f.curvatureRate,
          rateRatio: f.rateRatio,
          at: f.rateAt,
        },
      });
  }

  const polylines = curves.map((c) => curvePolyline(c.curve, 512));
  const samplers = surfaces.map(({ surface }) => SIDES.map((side) => sideSampler(surface, side)));
  const boxes = surfaces.map(({ surface }) => bounds(surface));
  const edges: ContinuityEdge[] = [];
  const record = (m: EdgeMeasure, cls: EdgeClass) => {
    if (m.fs.length === 0) {
      // Never a vacuous pass: a shared part left out entirely is reported.
      issues.push({
        code: 'nothing-checked',

        severity: 'warn',
        detail: {
          subject: `${(surfaces[m.a] as NamedSurface).name}:${m.sideA}|${(surfaces[m.b] as NamedSurface).name}:${m.sideB}`,
          reason: 'the transition band is at its run-out tip along the whole shared part',
          skipped: m.skipped ?? 0,
        },
      });
      return;
    }
    let feature: FeatureLine | undefined;
    for (const [i, line] of curves.entries()) {
      if (line.continuity === undefined) continue;
      const polyline = polylines[i] as Tuple3[];
      if (m.points.every((p) => polylineDistance(polyline, p) <= adjacency)) {
        feature = line;
        break;
      }
    }
    const A = surfaces[m.a] as NamedSurface;
    const B = surfaces[m.b] as NamedSurface;
    const spoke = A.transition?.kind === 'corner' && B.transition?.kind === 'corner';
    // A transition's contact edges require what it declares to hold there.
    const declared = A.transition?.continuity ?? B.transition?.continuity;
    const required =
      feature?.continuity ??
      (spoke ? (LEVEL[continuity] > LEVEL.G1 ? 'G1' : continuity) : (declared ?? continuity));
    const pass = LEVEL[m.achieved] >= LEVEL[required];
    const edge: ContinuityEdge = {
      a: (surfaces[m.a] as NamedSurface).name,
      sideA: m.sideA,
      ...(m.trim === undefined ? {} : { trim: m.trim }),
      b: (surfaces[m.b] as NamedSurface).name,
      sideB: m.sideB,
      range: [minOf(m.fs), maxOf(m.fs)],
      samples: m.fs.length,
      skipped: m.skipped ?? 0,
      gap: m.gap,
      angle: m.angle,
      curvature: m.curvature,
      rate: m.rate,
      class: cls,
      achieved: m.achieved,
      required,
      ...(feature === undefined ? {} : { feature: feature.name }),
      designedBreak: feature?.continuity === 'G0',
      pass,
    };
    edges.push(edge);
    if (!pass)
      issues.push({
        code: 'surface-continuity',

        severity: 'warn',
        detail: {
          subject: `${edge.a}:${edge.sideA}${edge.trim === undefined ? '' : edge.trim}|${edge.b}:${edge.sideB}`,
          achieved: edge.achieved,
          required,
          class: cls,
          gap: edge.gap,
          angle: edge.angle,
          curvature: edge.curvature,
          rate: edge.rate,
          range: edge.range,
          ...(feature === undefined ? {} : { feature: feature.name }),
          ...bandAt(m),
        },
      });
  };
  /** Width of the blend band beside an edge's worst sample, and its share of the widest station. */
  const bandAt = (m: EdgeMeasure) => {
    const blend = [m.b, m.a].find((i) => surfaces[i]?.transition?.kind === 'blend');
    if (blend === undefined) return {};
    const s = (surfaces[blend] as NamedSurface).surface;
    const side = blend === m.b ? m.sideB : (m.sideA as PatchSide);
    const worst = m.curvature.value > 0 ? m.curvature : m.angle.value > 0 ? m.angle : m.gap;
    const f = closestSidePoint(s, side, worst.point).f;
    let widest = 0;
    for (let k = 0; k <= 64; k++) widest = Math.max(widest, bandWidth(s, side, k / 64));
    const width = bandWidth(s, side, f);
    return { band: { width, widest, share: width / widest, f } };
  };
  // A side is examined when its surface is paired with another patch, or with itself for a seam.
  const examine = (k: number) => {
    const { name } = surfaces[k] as NamedSurface;
    for (const [i, side] of SIDES.entries())
      if (((samplers[k] as SideSampler[])[i] as SideSampler).length >= adjacency)
        done.sides.add(`${name}:${side}`);
  };
  for (let a = 0; a < surfaces.length; a++) {
    for (let b = a; b < surfaces.length; b++) {
      if (a !== b || surfaces[a]?.transition === undefined) {
        examine(a);
        examine(b);
      }
      const [la, ha] = boxes[a] as [Tuple3, Tuple3];
      const [lb, hb] = boxes[b] as [Tuple3, Tuple3];
      if (
        [0, 1, 2].some(
          (c) =>
            (la[c] as number) > (hb[c] as number) + adjacency ||
            (lb[c] as number) > (ha[c] as number) + adjacency,
        )
      )
        continue;
      for (const sideA of SIDES) {
        if (
          ((samplers[a] as SideSampler[])[SIDES.indexOf(sideA)] as SideSampler).length < adjacency
        )
          continue;
        // On one patch, a seam pairs u0 with u1 and v0 with v1 once; a transition band's sides
        // are its contacts, never a seam, though they close in at a run-out tip.
        if (a === b && (sideA === 'u1' || sideA === 'v1' || surfaces[a]?.transition !== undefined))
          continue;
        const cls: EdgeClass =
          (surfaces[a] as NamedSurface).transition !== undefined ||
          (surfaces[b] as NamedSurface).transition !== undefined
            ? 'blend'
            : 'primary';
        for (const m of measureSide(
          surfaces,
          samplers,
          a,
          sideA,
          b,
          thresholds,
          classLimits(thresholds, cls),
        )) {
          if (a === b && m.sideB !== (sideA === 'u0' ? 'u1' : 'v1')) continue;
          record(m, cls);
        }
      }
    }
  }
  // Trim edges: each trim loop's samples paired with the nearest side of another patch.
  for (const [a, entry] of surfaces.entries())
    for (const [k, loop] of (entry.trims ?? []).entries())
      for (let b = 0; b < surfaces.length; b++) {
        if (b === a) continue;
        done.sides.add(`${entry.name}:trim${k}`);
        // A trim edge along a blend band (its contact) is judged as the band's edges are.
        const cls: EdgeClass = surfaces[b]?.transition !== undefined ? 'blend' : 'trim';
        for (const m of measureTrim(
          surfaces,
          samplers,
          a,
          k,
          loop,
          b,
          thresholds,
          classLimits(thresholds, cls),
        ))
          record(m, cls);
      }
  const jointIds = jointSubjects(surfaces, edges);
  let unevaluatedJoints: UncheckedReason = 'not-requested';
  if (options.highlights !== undefined) {
    const found = highlightIssues(
      surfaces,
      curves,
      edges,
      polylines,
      options.highlights,
      fairnessOptions,
      adjacency,
      samples,
    );
    if (!found.ok) return found;
    pushAll(issues, found.value.issues);
    for (const joint of found.value.joints) done.joints.add(joint);
    unevaluatedJoints = found.value.unevaluated;
  }
  if (surfaces.length === 0 && curves.length === 0)
    issues.push({
      code: 'nothing-checked',

      severity: 'warn',
      detail: { subject: '', reason: 'no NURBS patches or feature lines to check' },
    });
  const left = (code: SurfaceQualityCode, ids: readonly string[], reason: UncheckedReason) =>
    ids.map((subject) => ({ code, subject, reason }));
  const coverage = coverageOf<SurfaceQualityCode>(
    {
      'surface-density': surfaces.map((x) => x.name),
      'surface-continuity': [...sideIds, ...trimIds],
      'curve-inflection': curves.map((x) => x.name),
      'curve-spike': curves.map((x) => x.name),
      'curve-curvature-rate': curves.map((x) => x.name),
      'surface-fairness': directionIds,
      highlight: jointIds,
    },
    {
      'surface-density': done.density,
      'surface-continuity': done.sides,
      'curve-inflection': done.lines,
      'curve-spike': done.lines,
      'curve-curvature-rate': done.lines,
      'surface-fairness': done.fairness,
      highlight: done.joints,
    },
    [
      ...left('surface-continuity', trimIds, 'missing-input'),
      ...(isoparms === 0 ? left('surface-fairness', directionIds, 'not-requested') : []),
      ...left('highlight', jointIds, unevaluatedJoints),
    ],
  );
  return ok({
    pass: issues.length === 0 && coverage.checked.length > 0,
    thresholds: {
      position,
      angle,
      ...(options.curvature === undefined ? {} : { curvature: options.curvature }),
      rate,
      classes,
      continuity,
      adjacency,
      maxNet: [longest, shortest],
      maxInflections: fairnessOptions.maxInflections ?? 0,
      spike: fairnessOptions.spike ?? 0.5,
      ...(fairnessOptions.maxCurvatureRate === undefined
        ? {}
        : { maxCurvatureRate: fairnessOptions.maxCurvatureRate }),
      maxRateRatio: fairnessOptions.maxRateRatio ?? 15,
    },
    surfaces: densities,
    edges,
    curves: fair,
    issues,
    coverage,
  });
}
