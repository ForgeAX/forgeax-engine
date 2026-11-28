import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import { type NurbsSurface, surfaceDomain as nurbsDomain } from '../nurbs';
import { surfaceNormalize, surfaceSplit } from '../nurbs-surface';
import type { Point2 } from '../primitives';
import { pcurvePoint } from './curves';
import { tan } from './dmath-explog';
import { structureError } from './structure';
import type { Face, PCurve, Shape, Surface } from './types';
import type { P2 } from './vec';

/**
 * One face patch. It has the shape of the kernel's `NamedSurface`, so the list goes straight into
 * `checkSurfaceQuality`, `highlightLines`, `surfaceDeviation` and the other surface views.
 */
export interface ShapePatch {
  readonly name: string;
  readonly surface: NurbsSurface;
  /** Boundary loops of the regions trimmed away, in the normalized domain ([0, 1] x [0, 1]). */
  readonly trims?: readonly (readonly Point2[])[];
}

/** Exact NURBS views of Shape faces, with the source face index for every emitted patch. */
export interface ShapeSurfaces {
  readonly surfaces: ShapePatch[];
  readonly faces: number[];
  readonly skipped: { readonly face: number; readonly reason: string }[];
}

/** Circular carrier spans are split into exact rational arcs no wider than this angle. */
export interface ShapeSurfacesOptions {
  readonly arcDegrees?: 90 | 120;
}

interface Bounds {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
}

interface Arc {
  readonly a0: number;
  readonly a1: number;
  readonly points: readonly (readonly [number, number])[];
  readonly weights: readonly [number, number, number];
}

const U2: readonly number[] = [0, 0, 1, 1];
const U3: readonly number[] = [0, 0, 0, 1, 1, 1];
const TAU = 2 * Math.PI;

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

function patch(
  points: readonly (readonly Tuple3[])[],
  degreeU: 1 | 2,
  degreeV: 1 | 2,
  weights?: readonly (readonly number[])[],
): NurbsSurface {
  return {
    degreeU,
    degreeV,
    points,
    knotsU: degreeU === 1 ? U2 : U3,
    knotsV: degreeV === 1 ? U2 : U3,
    ...(weights === undefined ? {} : { weights }),
  };
}

function arc(a0: number, a1: number): Arc {
  const half = (a1 - a0) / 2;
  const middle = (a0 + a1) / 2;
  const weight = cos(half);
  return {
    a0,
    a1,
    points: [
      [cos(a0), sin(a0)],
      [cos(middle) / weight, sin(middle) / weight],
      [cos(a1), sin(a1)],
    ],
    weights: [1, weight, 1],
  };
}

function splitRange(lo: number, hi: number, maxDegrees: number): Arc[] {
  const count = Math.max(1, Math.ceil(((hi - lo) * 180) / (Math.PI * maxDegrees) - 1e-12));
  return Array.from({ length: count }, (_, i) =>
    arc(lo + ((hi - lo) * i) / count, lo + ((hi - lo) * (i + 1)) / count),
  );
}

function arcParameter(a: Arc, angle: number): number {
  const half = (a.a1 - a.a0) / 2;
  const q = tan((angle - a.a0) / 2);
  const denominator = sin(half) + q * (1 - cos(half));
  return denominator === 0 ? 0 : q / denominator;
}

function framePoint(
  frame: Extract<Surface, { readonly frame: unknown }>['frame'],
  x: number,
  y: number,
  z: number,
): Tuple3 {
  return [
    frame.o[0] + frame.x[0] * x + frame.y[0] * y + frame.z[0] * z,
    frame.o[1] + frame.x[1] * x + frame.y[1] * y + frame.z[1] * z,
    frame.o[2] + frame.x[2] * x + frame.y[2] * y + frame.z[2] * z,
  ];
}

function analyticPatch(
  carrier: Exclude<Surface, { readonly kind: 'nurbs' }>,
  bounds: Bounds,
  uArc?: Arc,
  vArc?: Arc,
): NurbsSurface {
  const frame = carrier.frame;
  if (carrier.kind === 'plane') {
    const point = (u: number, v: number) =>
      framePoint(
        frame,
        bounds.u0 + (bounds.u1 - bounds.u0) * u,
        bounds.v0 + (bounds.v1 - bounds.v0) * v,
        0,
      );
    return patch(
      [
        [point(0, 0), point(0, 1)],
        [point(1, 0), point(1, 1)],
      ],
      1,
      1,
    );
  }
  const ua = uArc as Arc;
  if (carrier.kind === 'cylinder' || carrier.kind === 'cone') {
    const points = ua.points.map(([cx, cy]) =>
      [bounds.v0, bounds.v1].map((v) => {
        if (carrier.kind === 'cylinder')
          return framePoint(frame, carrier.radius * cx, carrier.radius * cy, v);
        const radius = carrier.radius + v * sin(carrier.halfAngle);
        return framePoint(frame, radius * cx, radius * cy, v * cos(carrier.halfAngle));
      }),
    );
    return patch(
      points,
      2,
      1,
      ua.weights.map((w) => [w, w]),
    );
  }
  const va = vArc as Arc;
  const weights = ua.weights.map((wu) => va.weights.map((wv) => wu * wv));
  if (carrier.kind === 'sphere') {
    const points = ua.points.map(([ux, uy]) =>
      va.points.map(([vc, vs]) =>
        framePoint(frame, carrier.radius * ux * vc, carrier.radius * uy * vc, carrier.radius * vs),
      ),
    );
    return patch(points, 2, 2, weights);
  }
  const points = ua.points.map(([ux, uy]) =>
    va.points.map(([vc, vs]) =>
      framePoint(
        frame,
        ux * (carrier.major + carrier.minor * vc),
        uy * (carrier.major + carrier.minor * vc),
        carrier.minor * vs,
      ),
    ),
  );
  return patch(points, 2, 2, weights);
}

function include(state: { u0: number; u1: number; v0: number; v1: number }, p: P2): void {
  state.u0 = Math.min(state.u0, p[0]);
  state.u1 = Math.max(state.u1, p[0]);
  state.v0 = Math.min(state.v0, p[1]);
  state.v1 = Math.max(state.v1, p[1]);
}

function pcurveBounds(pcurve: PCurve, t0: number, t1: number): P2[] {
  if (pcurve.kind === 'line') return [pcurvePoint(pcurve, t0), pcurvePoint(pcurve, t1)];
  if (pcurve.kind === 'nurbs') return pcurve.curve.points.map((p) => [p[0], p[1]]);
  const lo = Math.min(pcurve.phase + pcurve.dir * t0, pcurve.phase + pcurve.dir * t1);
  const hi = Math.max(pcurve.phase + pcurve.dir * t0, pcurve.phase + pcurve.dir * t1);
  const points = [pcurvePoint(pcurve, t0), pcurvePoint(pcurve, t1)];
  for (const base of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const first = Math.ceil((lo - base) / TAU);
    const last = Math.floor((hi - base) / TAU);
    for (let k = first; k <= last; k++) {
      const t = (base + k * TAU - pcurve.phase) / pcurve.dir;
      if (t >= Math.min(t0, t1) && t <= Math.max(t0, t1)) points.push(pcurvePoint(pcurve, t));
    }
  }
  return points;
}

function faceBounds(
  shape: Shape,
  face: Face,
  carrier: Exclude<Surface, { readonly kind: 'nurbs' }>,
): Bounds | undefined {
  const bounds = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
  const periodicU =
    carrier.kind === 'cylinder' ||
    carrier.kind === 'cone' ||
    carrier.kind === 'sphere' ||
    carrier.kind === 'torus';
  const periodicV = carrier.kind === 'torus';
  for (const loopId of face.loops) {
    const loop = shape.loops[loopId];
    if (loop === undefined) return undefined;
    for (const coedgeId of loop.coedges) {
      const coedge = shape.coedges[coedgeId];
      if (coedge === undefined) return undefined;
      const edge = shape.edges[coedge.edge];
      if (edge === undefined) return undefined;
      const t0 = coedge.reversed ? edge.t1 : edge.t0;
      const t1 = coedge.reversed ? edge.t0 : edge.t1;
      for (const p of pcurveBounds(coedge.pcurve, t0, t1)) include(bounds, p);
      if (coedge.pcurve.kind === 'line' && edge.curve >= 0) {
        const circle =
          edge.curve < shape.curves.length && shape.curves[edge.curve]?.kind === 'circle';
        if (
          periodicU &&
          circle &&
          Math.abs(edge.t1 - edge.t0 - TAU) < 1e-12 &&
          coedge.pcurve.d[0] !== 0
        ) {
          const u0 = pcurvePoint(coedge.pcurve, t0)[0];
          bounds.u0 = Math.min(bounds.u0, u0);
          bounds.u1 = Math.max(bounds.u1, u0 + TAU);
        }
        if (
          periodicV &&
          circle &&
          Math.abs(edge.t1 - edge.t0 - TAU) < 1e-12 &&
          coedge.pcurve.d[1] !== 0
        ) {
          const v0 = pcurvePoint(coedge.pcurve, t0)[1];
          bounds.v0 = Math.min(bounds.v0, v0);
          bounds.v1 = Math.max(bounds.v1, v0 + TAU);
        }
      }
    }
  }
  return Number.isFinite(bounds.u0 + bounds.u1 + bounds.v0 + bounds.v1) ? bounds : undefined;
}

function canonicalPeriodicBounds(
  bounds: Bounds,
  carrier: Exclude<Surface, { readonly kind: 'plane' | 'nurbs' }>,
  shape: Shape,
  face: Face,
): Bounds {
  const fullTurn = (axis: 0 | 1, lo: number, hi: number): boolean => {
    if (hi - lo >= TAU - 1e-9) return true;
    return face.loops.some((loopId) =>
      (shape.loops[loopId]?.coedges ?? []).some((coedgeId) => {
        const coedge = shape.coedges[coedgeId];
        const edge = coedge === undefined ? undefined : shape.edges[coedge.edge];
        const curve = edge === undefined || edge.curve < 0 ? undefined : shape.curves[edge.curve];
        return (
          curve?.kind === 'circle' &&
          edge !== undefined &&
          Math.abs(edge.t1 - edge.t0 - TAU) < 1e-12 &&
          coedge?.pcurve.kind === 'line' &&
          (axis === 0 ? coedge.pcurve.d[0] : coedge.pcurve.d[1]) !== 0
        );
      }),
    );
  };
  const uFull = fullTurn(0, bounds.u0, bounds.u1);
  const vFull = carrier.kind === 'torus' && fullTurn(1, bounds.v0, bounds.v1);
  const u0 = bounds.u0;
  const u1 = uFull ? u0 + TAU : bounds.u1;
  const v0 = bounds.v0;
  const v1 = vFull ? v0 + TAU : bounds.v1;
  return { u0, u1, v0, v1 };
}

function loopPolygon(shape: Shape, loopId: number): Point2[] {
  const loop = shape.loops[loopId];
  if (loop === undefined) return [];
  const points: Point2[] = [];
  for (const coedgeId of loop.coedges) {
    const coedge = shape.coedges[coedgeId];
    if (coedge === undefined) continue;
    const edge = shape.edges[coedge.edge];
    if (edge === undefined) continue;
    const t0 = coedge.reversed ? edge.t1 : edge.t0;
    const t1 = coedge.reversed ? edge.t0 : edge.t1;
    const steps = coedge.pcurve.kind === 'line' ? 1 : 64;
    for (let k = 0; k < steps; k++) {
      const p = pcurvePoint(coedge.pcurve, t0 + ((t1 - t0) * k) / steps);
      if (
        points.length === 0 ||
        p[0] !== points[points.length - 1]?.[0] ||
        p[1] !== points[points.length - 1]?.[1]
      )
        points.push(p);
    }
  }
  return points;
}

function clipPolygon(points: readonly Point2[], bounds: Bounds): Point2[] {
  let polygon = [...points];
  const clip = (axis: 0 | 1, limit: number, greater: boolean): void => {
    const input = polygon;
    polygon = [];
    if (input.length === 0) return;
    const inside = (p: Point2) => (greater ? p[axis] >= limit : p[axis] <= limit);
    for (let i = 0; i < input.length; i++) {
      const a = input[i] as Point2;
      const b = input[(i + 1) % input.length] as Point2;
      const ia = inside(a);
      const ib = inside(b);
      if (ia) polygon.push(a);
      if (ia === ib) continue;
      const t = (limit - a[axis]) / (b[axis] - a[axis]);
      polygon.push(
        axis === 0 ? [limit, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, limit],
      );
    }
  };
  clip(0, bounds.u0, true);
  clip(0, bounds.u1, false);
  clip(1, bounds.v0, true);
  clip(1, bounds.v1, false);
  return polygon;
}

function normalizeNurbs(source: NurbsSurface, bounds: Bounds): NurbsSurface {
  let current = source;
  for (const [direction, lo, hi] of [
    ['u', bounds.u0, bounds.u1],
    ['v', bounds.v0, bounds.v1],
  ] as const) {
    let [start, end] = nurbsDomain(current)[direction === 'u' ? 0 : 1];
    if (lo > start) {
      const split = surfaceSplit(current, direction, lo);
      if (!split.ok) throw split.error;
      current = split.value[1];
      [start, end] = nurbsDomain(current)[direction === 'u' ? 0 : 1];
    }
    if (hi < end) {
      const split = surfaceSplit(current, direction, hi);
      if (!split.ok) throw split.error;
      current = split.value[0];
    }
    current = surfaceNormalize(current, direction);
  }
  return current;
}

function normalizedTrims(
  shape: Shape,
  face: Face,
  bounds: Bounds,
  uArc?: Arc,
  vArc?: Arc,
  sourceBounds?: Bounds,
): Point2[][] {
  const out: Point2[][] = [];
  for (const loopId of face.loops) {
    if (shape.loops[loopId]?.outer !== false) continue;
    const source = sourceBounds ?? bounds;
    const clipped = clipPolygon(loopPolygon(shape, loopId), source);
    if (clipped.length < 3) continue;
    const selected =
      uArc === undefined && vArc === undefined
        ? clipPolygon(clipped, bounds)
        : clipped.filter(
            ([u, v]) => u >= bounds.u0 && u <= bounds.u1 && v >= bounds.v0 && v <= bounds.v1,
          );
    if (selected.length < 3) continue;
    const normalized = selected.map(
      ([u, v]) =>
        [
          uArc === undefined ? (u - bounds.u0) / (bounds.u1 - bounds.u0) : arcParameter(uArc, u),
          vArc === undefined ? (v - bounds.v0) / (bounds.v1 - bounds.v0) : arcParameter(vArc, v),
        ] as Point2,
    );
    if (normalized.every((p) => p.every(Number.isFinite))) out.push(normalized);
  }
  return out;
}

function label(face: Face, faceIndex: number): string {
  return face.label.length > 0 ? face.label : `face-${faceIndex}`;
}

/**
 * Convert analytic carriers and rectangular NURBS domains exactly into NURBS patches. Full periodic turns
 * are split into arcs of at most `arcDegrees`. Curved inner trims are sampled polylines; NURBS carrier trims
 * and non-rectangular outer boundaries are not masked because `trims` only represents removed regions.
 */
export function shapeSurfaces(
  shape: Shape,
  options: ShapeSurfacesOptions = {},
): Result<ShapeSurfaces, ModelingError> {
  if (options === null || typeof options !== 'object')
    return err(invalid('options is an object', { options }));
  const arcDegrees = options.arcDegrees ?? 90;
  if (arcDegrees !== 90 && arcDegrees !== 120)
    return err(invalid('arcDegrees is 90 or 120', { arcDegrees }));
  const broken = structureError(shape);
  if (broken !== undefined) return err(broken);

  const surfaces: ShapePatch[] = [];
  const faces: number[] = [];
  const skipped: { face: number; reason: string }[] = [];
  const counts = new Map<string, number>();
  shape.faces.forEach((face, i) => {
    const base = label(face, i);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  });

  for (const [faceIndex, face] of shape.faces.entries()) {
    const carrier = shape.surfaces[face.surface] as Surface;
    const base = label(face, faceIndex);
    const name = (counts.get(base) ?? 0) > 1 ? `${base}-face-${faceIndex}` : base;
    const rawBounds =
      carrier.kind === 'nurbs'
        ? (() => {
            const [[u0, u1], [v0, v1]] = nurbsDomain(carrier.surface);
            return { u0, u1, v0, v1 };
          })()
        : faceBounds(shape, face, carrier);
    const bounds =
      rawBounds === undefined || carrier.kind === 'plane' || carrier.kind === 'nurbs'
        ? rawBounds
        : canonicalPeriodicBounds(rawBounds, carrier, shape, face);
    if (bounds === undefined || !(bounds.u1 > bounds.u0 && bounds.v1 > bounds.v0)) {
      skipped.push({
        face: faceIndex,
        reason: 'trim loops do not enclose a finite parameter rectangle',
      });
      continue;
    }
    const uArcs =
      carrier.kind === 'plane' || carrier.kind === 'nurbs'
        ? [undefined]
        : splitRange(bounds.u0, bounds.u1, arcDegrees);
    const vArcs =
      carrier.kind === 'sphere' || carrier.kind === 'torus'
        ? splitRange(bounds.v0, bounds.v1, arcDegrees)
        : [undefined];
    const patchCount = uArcs.length * vArcs.length;
    for (const [ui, uArc] of uArcs.entries()) {
      for (const [vi, vArc] of vArcs.entries()) {
        const patchBounds: Bounds = {
          u0: uArc?.a0 ?? bounds.u0,
          u1: uArc?.a1 ?? bounds.u1,
          v0: vArc?.a0 ?? bounds.v0,
          v1: vArc?.a1 ?? bounds.v1,
        };
        let patchSurface: NurbsSurface;
        try {
          patchSurface =
            carrier.kind === 'nurbs'
              ? normalizeNurbs(carrier.surface, patchBounds)
              : analyticPatch(carrier, patchBounds, uArc, vArc);
        } catch {
          skipped.push({
            face: faceIndex,
            reason: 'the carrier parameter rectangle cannot be restricted exactly',
          });
          continue;
        }
        const trims =
          carrier.kind === 'nurbs'
            ? []
            : normalizedTrims(shape, face, patchBounds, uArc, vArc, bounds);
        surfaces.push({
          name: patchCount === 1 ? name : `${name}.u${ui}-v${vi}`,
          surface: patchSurface,
          ...(trims.length === 0 ? {} : { trims }),
        });
        faces.push(faceIndex);
      }
    }
  }
  return ok({ surfaces, faces, skipped });
}
