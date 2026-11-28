import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import type { ModelingError } from '../errors';
import { EditMesh } from '../mesh';
import { curvePoint } from './curves';
import { faceLoops, type GridFace, type GridSide, gridOf } from './faces';
import { type CountSolveResult, type RingConstraint, solveRowCounts } from './quad-count-solve';
import { opposingEdgePairs } from './quad-counts';
import { curveSpanLength } from './quad-curve-length';
import { hexQuads } from './quad-hex';
import {
  isoFarEdges,
  isoHoleRaises,
  isoOpposingEdgePairs,
  isoOuterBalance,
  isoQuadricFace,
} from './quad-iso-quadric';
import { analyzeRect, planRects, type RectPlan, rectQuads, settleRect } from './quad-rect';
import { relaxSingleFaceVertices } from './quad-relax';
import { roundRectArcEdges, roundRectPairs, roundRectQuads } from './quad-rrect';
import { THIN_MIN_ROWS, thinWallEdges } from './quad-thin';
import { triQuads, triRaises } from './quad-tri';
import { quadrangulateTrimmed } from './quad-trimmed';
import { structureError } from './structure';
import { surfacePoint } from './surfaces';
import { flagCreases, stampFaceNames } from './tessellate';
import type { TrimRing } from './tessellate-trimmed';
import {
  brepFail,
  type Coedge,
  type Curve,
  type Edge,
  type Face,
  type Frame,
  type Shape,
  type Surface,
  type Vertex,
} from './types';
import {
  add3,
  cross3,
  dist3,
  dot3,
  len3,
  type P2,
  type P3,
  scale3,
  sub3,
  TWO_PI,
  unit3,
} from './vec';

export type QuadSource = 'analytic' | 'boolean' | 'cut' | 'trim' | 'merge';

export interface QuadOptions {
  /** Target quad edge length, in metres. */
  readonly size: number;
  /** Edges whose adjacent face normals differ by more than this, in radians, are `EDGE_SHARP` (default pi / 6). */
  readonly crease?: number;
  /** Provenance of the Shape (default `analytic`); every other value is unsupported until E1c. */
  readonly source?: QuadSource;
  /**
   * Planar faces with holes: `blossom` (default) pairs the trim triangulation into quads; `reject`
   * keeps the earlier behaviour of failing those faces with `trimmed-loop`. `blossom-penalty` is an
   * opt-in best effort: folded quads are split where possible and the rest kept, with per-face
   * `faceQuality` in the result instead of a failure. `quad-dominant` is opt-in too: it pairs as many
   * convex triangles as possible and emits the leftover triangles as triangles, never a fold.
   */
  readonly trimmed?: 'blossom' | 'blossom-penalty' | 'quad-dominant' | 'blossom-row' | 'reject';
  /**
   * Opt-in: trimmed faces on a developable quadric (a holed or non-rectangular cylinder face) are meshed in the
   * developed plane with boundary rows, so hole loops get rings and rows follow the iso lines. Other quadrics fail
   * closed with an `iso-*` reason. Off by default.
   */
  readonly isoQuadric?: boolean;
  /**
   * Opt-in, trimmed faces only: when a face has no perfect matching, split each triangle into three
   * quads (Blossom-Quad fallback). Every shared edge of a trimmed planar face gets an even sample count,
   * so the split conforms to neighbours by edge id. Faces that fail the split keep a named reason.
   */
  readonly fallback?: 'split-3';
  /**
   * Opt-in, `trimmed: 'quad-dominant'` only: a pair whose scaled Jacobian is below 0.3 stays two triangles.
   * Trades sliver quads (rim fans on dense-sampled flange caps) for extra triangles. Off by default.
   */
  readonly dominantSjFloor?: boolean;
}

/**
 * Quality of one trimmed planar face under `blossom-penalty` or `quad-dominant`. `minSj` is over the
 * quads only (0 when there are none); `triangles` counts leftover triangles (quad-dominant only).
 */
export interface FaceQuality {
  readonly face: number;
  readonly minSj: number;
  readonly foldedPairs: number;
  readonly unresolved: number;
  readonly quads: number;
  readonly triangles: number;
  /** Row-front mode only: rings kept as boundary (thin web), and whether the interior fell back to quad-dominant. */
  readonly rowSkipped: number;
  readonly fallback: boolean;
  /** Row-front mode only: quads from the boundary row (the first `rowQuads` quads of the face). */
  readonly rowQuads: number;
  /** True when the split-3 fallback produced this face's interior quads (strict matching had no perfect matching). */
  readonly split3: boolean;
}

export interface QuadReport {
  readonly faces: number;
  readonly quads: number;
  /** Triangle faces (quad-dominant leftovers); their scaled Jacobian is not in `scaledJacobian`. */
  readonly triangles: number;
  readonly degenerate: number;
  readonly scaledJacobian: { readonly min: number; readonly mean: number };
  readonly openEdges: number;
  readonly nonManifoldEdges: number;
  readonly singularities: number;
}

export interface QuadResult {
  readonly mesh: EditMesh;
  /** Mesh face ids emitted by each source B-rep face, in face order (inclusive-exclusive ranges). */
  readonly faceRanges: readonly (readonly [number, number])[];
  readonly report: QuadReport;
  /** Per trimmed face, only in `blossom-penalty` and `quad-dominant` modes; empty otherwise. */
  readonly faceQuality: readonly FaceQuality[];
  /** Curved-edge count multiplier that produced this layout: 1, or the split-3 retry density. */
  readonly curvedDensity: number;
}

/** Least scaled Jacobian of a hexagon patch quad for the centre split to stand. */
const HEX_SJ_FLOOR = 0.15;
const DEFAULT_CREASE = Math.PI / 6;
const FULL_TURN_TOL = 1e-9;
const DEGENERATE_REL = 1e-12;

/** Internal route result: the error is a reason string, attached to its face by `layoutFace`. */
type Step<T> = Result<T, string>;

interface Cx {
  readonly shape: Shape;
  readonly mesh: EditMesh;
  readonly size: number;
  readonly vertexIds: Map<number, number>;
  /** Mesh vertex ids of each sampled edge, in parameter order; shared by both faces using the edge. */
  readonly samples: Map<number, number[]>;
  readonly trimmed: boolean;
  readonly penalty: boolean;
  readonly dominant: boolean;
  readonly rowFront: boolean;
  readonly iso: boolean;
  readonly fallback: 'split-3' | undefined;
  readonly dominantSjFloor: boolean;
  readonly faceQuality: FaceQuality[];
  /** Per-edge sample count from the count solve; shared by every face that uses the edge. */
  readonly counts: ReadonlyMap<number, number>;
  /** Rectilinear holeless planar faces laid as lattice blocks (iso only), and their shared edge sample fractions. */
  readonly rects: ReadonlyMap<number, RectPlan>;
  readonly fractions: ReadonlyMap<number, readonly number[]>;
}

interface Sides {
  readonly bottom: number[];
  readonly right: number[];
  readonly top: number[];
  readonly left: number[];
}

export function quadrangulate(
  shape: Shape,
  options: QuadOptions,
): Result<QuadResult, ModelingError> {
  const { size } = options;
  const crease = options.crease ?? DEFAULT_CREASE;
  if (!Number.isFinite(size) || size <= 0) {
    return brepFail('brep-bad-argument', 'size is a finite number greater than 0', { size });
  }
  if (!Number.isFinite(crease) || crease < 0 || crease > Math.PI) {
    return brepFail('brep-bad-argument', 'crease in [0, pi]', { crease });
  }
  // Booleans are supported: their result is an ordinary analytic Shape with loops. Cuts, trims and merges keep
  // their own source tags until their owners wire them into the same per-face path.
  const source = options.source ?? 'analytic';
  if (source !== 'analytic' && source !== 'boolean') {
    return brepFail(
      'brep-quad-unsupported-source',
      'an analytic or boolean Shape (cuts, trims and merges are not wired yet)',
      { source },
    );
  }
  const broken = structureError(shape);
  if (broken !== undefined) return err(broken);

  const mode = options.trimmed ?? 'blossom';
  const trimmed = mode !== 'reject';
  const iso = options.isoQuadric === true;
  const split3 = options.fallback === 'split-3';
  const thin = iso ? thinWallEdges(shape, size) : NO_THIN;
  const lay = (density: number): Result<QuadResult, ModelingError> => {
    const holed = iso && isoFarEdges(shape).size > 0;
    const ratios = holed ? ISO_FAR_RATIOS : [1];
    const attempts: (readonly [number, boolean])[] = ratios.map((r) => [r, false] as const);
    if (holed)
      pushAll(
        attempts,
        ratios.map((r) => [r, true] as const),
      );
    let last: Result<QuadResult, ModelingError> | undefined;
    // The thin-wall floor is tried first; a shape whose counts it makes unsatisfiable keeps the plain layout.
    const floors = thin.size > 0 ? [thin, NO_THIN] : [NO_THIN];
    const run = (shortFirst: boolean): Result<QuadResult, ModelingError> | undefined => {
      let failed: Result<QuadResult, ModelingError> | undefined;
      for (const floor of floors) {
        for (const [ratio, balanced] of attempts) {
          failed = laySurface(
            shape,
            size,
            trimmed,
            iso,
            options,
            split3,
            density,
            crease,
            ratio,
            balanced,
            floor,
            shortFirst,
          );
          if (failed.ok) return failed;
        }
      }
      return failed;
    };
    last = run(false);
    // Lattice intervals are raised in edge order; a notched rectilinear face can chase its own counts that way and keep
    // its triangles, so a result with triangles is retried with the short edges raised first and the cleaner one stands.
    if (iso && last?.ok && last.value.report.triangles > 0) {
      const again = run(true);
      if (again?.ok && again.value.report.triangles < last.value.report.triangles) return again;
    }
    return last as Result<QuadResult, ModelingError>;
  };
  const first = lay(1);
  if (first.ok || !split3 || first.error.detail?.reason !== 'split-3-fold') return first;
  return lay(SPLIT3_CURVED_DENSITY);
}

/**
 * The outer edges of a holed plane are sampled this many times coarser than the element size, tried in order: the
 * hole strips keep the hole resolution, so the far field is graded between them and the plate edge by the grid itself.
 * A ratio whose layout fails closed (a block overlap, a distorted strip) falls to the next. The ladder ends below the
 * plain size: a hole a thin wall from the plate edge needs plate-edge nodes as close as the hole samples (plate-grid3x4,
 * wall 1.04: sizes 5 and 3 lay out only at 0.75 or 0.5 of the size).
 */
const NO_THIN: ReadonlySet<number> = new Set<number>();

const ISO_FAR_RATIOS: readonly number[] = [2, 1.5, 1, 0.75, 0.5];

/** Curved-ring density for the split-3 retry: fold-free on plate-grid3x4, housing and box-minus-cyl (measured). */
const SPLIT3_CURVED_DENSITY = 4;

function laySurface(
  shape: Shape,
  size: number,
  trimmed: boolean,
  iso: boolean,
  options: QuadOptions,
  splitEven: boolean,
  curvedDensity: number,
  crease: number,
  farRatio = 1,
  balanced = false,
  thin: ReadonlySet<number> = NO_THIN,
  shortFirst = false,
): Result<QuadResult, ModelingError> {
  const mode = options.trimmed ?? 'blossom';
  const counts = edgeCounts(
    shape,
    size,
    trimmed,
    iso,
    splitEven,
    curvedDensity,
    farRatio,
    balanced,
    thin,
    shortFirst,
  );
  if (!counts.ok) {
    return brepFail('brep-face-unsupported', 'a quad layout for this face', {
      reason: counts.error.reason,
      constraint: counts.error.constraint,
    });
  }
  const planned = iso
    ? planRects(shape, size, counts.value.rowCounts, shortFirst)
    : { plans: new Map<number, RectPlan>(), fractions: new Map<number, number[]>() };
  const cx: Cx = {
    shape,
    mesh: new EditMesh(),
    size,
    vertexIds: new Map(),
    samples: new Map(),
    trimmed,
    penalty: mode === 'blossom-penalty',
    dominant: mode === 'quad-dominant',
    rowFront: mode === 'blossom-row',
    iso,
    fallback: options.fallback,
    dominantSjFloor: options.dominantSjFloor === true,
    faceQuality: [],
    counts: counts.value.rowCounts,
    rects: planned.plans,
    fractions: planned.fractions,
  };
  const faceRanges: [number, number][] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const laid = layoutFace(cx, f);
    if (!laid.ok) return laid;
    const first = cx.mesh.faceHighWater;
    const emitted = emitFace(cx, f, laid.value);
    if (!emitted.ok) return emitted;
    faceRanges.push([first, cx.mesh.faceHighWater]);
  }
  // The iso layouts are exact O-grids: relaxing them moves the rows off the hole boundary normals.
  if (cx.rowFront && !cx.iso) relaxSingleFaceVertices(cx.mesh, faceRanges, scaledJacobian);
  // Quality rows were measured before the pass; rebuild each source face's row from the final mesh.
  for (let k = 0; cx.rowFront && k < cx.faceQuality.length; k++) {
    const row = cx.faceQuality[k] as FaceQuality;
    const [lo, hi] = faceRanges[row.face] ?? [0, 0];
    let min = Infinity;
    for (let f = lo; f < hi; f++) {
      if (!cx.mesh.isFaceAlive(f)) continue;
      const v = cx.mesh.faceVertices(f);
      if (v.length === 4)
        min = Math.min(min, scaledJacobian(v.map((x) => cx.mesh.position(x) as P3)));
    }
    if (min !== Infinity) cx.faceQuality[k] = { ...row, minSj: min };
  }
  flagCreases(shape, cx.mesh, cx.samples, crease);
  return ok({
    mesh: cx.mesh,
    faceRanges,
    report: measure(cx.mesh, shape.faces.length),
    faceQuality: cx.faceQuality,
    curvedDensity,
  });
}

function layoutFace(cx: Cx, f: number): Result<number[][], ModelingError> {
  const r = layoutSteps(cx, f);
  if (r.ok) return r;
  const face = cx.shape.faces[f] as Face;
  const surface = cx.shape.surfaces[face.surface] as Surface;
  return brepFail('brep-face-unsupported', 'a quad layout for this face', {
    face: f,
    surface: surface.kind,
    reason: r.error,
  });
}

function layoutSteps(cx: Cx, f: number): Step<number[][]> {
  const { shape } = cx;
  const face = shape.faces[f] as Face;
  const surface = shape.surfaces[face.surface] as Surface;
  const { outer, holes } = faceLoops(shape, f);
  if (cx.iso && (holes.length > 0 || (surface.kind !== 'plane' && !gridOf(shape, f).ok))) {
    const iso = isoQuadric(cx, f);
    // A holed plane whose outer loop is not a rectangle or one circle has no iso lattice; its generic trimmed layout stands.
    if (
      iso.ok ||
      iso.error !== 'iso-outer-not-rectangle' ||
      !cx.trimmed ||
      surface.kind !== 'plane'
    )
      return iso;
  }
  if (holes.length > 0) {
    if (!cx.trimmed || surface.kind !== 'plane') return err('trimmed-loop');
    return trimmedPlane(cx, f, surface, outer, holes);
  }
  if (outer.length === 0) return err('no-outer-loop');
  if (surface.kind === 'plane') {
    if (outer.length === 4 && outer.every((c) => isLine(shape, c))) return quad4(cx, outer);
    if (outer.length === 1 && isFullCircle(shape, outer[0] as number)) {
      return disk(cx, outer[0] as number);
    }
    if (cx.iso && outer.length === 3) {
      const tri = triQuads(
        {
          shape,
          edgeSamples: (e) => edgeSamples(cx, e),
          position: (id) => cx.mesh.position(id) as P3,
          vertex: (p) => newVertex(cx, p),
        },
        f,
      );
      if (tri.ok) return tri;
    }
    const plan = cx.rects.get(f);
    if (plan !== undefined) {
      const quads = rectQuads(plan, {
        shape,
        edgeSamples: (e) => edgeSamples(cx, e),
        vertex: (p) => newVertex(cx, p),
      });
      if (quads.ok) return quads;
    }
    if (cx.iso) {
      const hex = hexQuads(
        {
          shape,
          edgeSamples: (e) => edgeSamples(cx, e),
          position: (id) => cx.mesh.position(id) as P3,
          vertex: (p) => newVertex(cx, p),
        },
        f,
        (ids) => scaledJacobian(ids.map((id) => cx.mesh.position(id) as P3)),
        HEX_SJ_FLOOR,
      );
      if (hex.ok) return hex;
      const rounded = roundRectQuads(
        {
          shape,
          size: cx.size,
          edgeSamples: (e) => edgeSamples(cx, e),
          position: (id) => cx.mesh.position(id) as P3,
          vertex: (p) => newVertex(cx, p),
        },
        f,
      );
      if (rounded.ok) return rounded;
    }
    if (cx.trimmed && outerOnlyTrimmed(shape, f)) return trimmedPlane(cx, f, surface, outer, []);
  }
  const grid = gridOf(shape, f);
  if (!grid.ok) return err('trimmed-loop');
  return gridPatch(cx, grid.value, surface);
}

function isLine(shape: Shape, c: number): boolean {
  const e = edgeOf(shape, c);
  return e !== undefined && e.curve >= 0 && (shape.curves[e.curve] as Curve).kind === 'line';
}

function isFullCircle(shape: Shape, c: number): boolean {
  const e = edgeOf(shape, c);
  if (e === undefined || e.curve < 0) return false;
  const curve = shape.curves[e.curve] as Curve;
  return curve.kind === 'circle' && Math.abs(Math.abs(e.t1 - e.t0) - TWO_PI) <= FULL_TURN_TOL;
}

function edgeOf(shape: Shape, c: number): Edge | undefined {
  const co = shape.coedges[c] as Coedge;
  return shape.edges[co.edge];
}

function newVertex(cx: Cx, p: P3): number {
  return cx.mesh.addVertex(p[0], p[1], p[2]);
}

function brepVertex(cx: Cx, v: number): number {
  const known = cx.vertexIds.get(v);
  if (known !== undefined) return known;
  const id = newVertex(cx, (cx.shape.vertices[v] as Vertex).p);
  cx.vertexIds.set(v, id);
  return id;
}

/** Sample counts per edge via the count-solve owner: opposite-side classes, then ring parity on trimmed faces. */
function edgeCounts(
  shape: Shape,
  size: number,
  trimmed: boolean,
  iso: boolean,
  splitEven: boolean,
  curvedDensity = 1,
  farRatio = 1,
  balanced = false,
  thin: ReadonlySet<number> = NO_THIN,
  shortFirst = false,
): CountSolveResult {
  const refined = curvedDensity !== 1 ? trimmedPlaneEdges(shape) : new Set<number>();
  const forced = shape.edges.map((e, i) => {
    if (e.curve < 0) return 0;
    const count = edgeCount(size, e, shape.curves[e.curve] as Curve);
    const base = count.ok ? count.value : 0;
    return refined.has(i) && base > 0 ? base * curvedDensity : base;
  });
  if (iso) {
    for (const e of isoFarEdges(shape)) {
      const edge = shape.edges[e] as Edge;
      const count = edgeCount(size * farRatio, edge, shape.curves[edge.curve] as Curve);
      if (count.ok) forced[e] = count.value;
    }
  }
  if (iso) for (const e of roundRectArcEdges(shape)) forced[e] = Math.max(forced[e] as number, 2);
  for (const e of thin) forced[e] = Math.max(forced[e] as number, THIN_MIN_ROWS);
  const rings = trimmed ? ringConstraints(shape, iso) : [];
  // split-3 halves every trimmed face's ring, so each of its edges needs an even count.
  const evenEdges = splitEven
    ? trimmedPlaneEdges(shape)
    : trimmed
      ? holedFaceEdges(shape)
      : new Set<number>();
  const pairs = iso
    ? [...opposingEdgePairs(shape), ...isoOpposingEdgePairs(shape), ...roundRectPairs(shape)]
    : opposingEdgePairs(shape);
  const rectFaces = iso ? rectFaceList(shape) : [];
  const lattice = new Set(rectFaces.map((r) => r.face));
  const latticeRings = rings.filter((r) => !lattice.has(r.face));
  // A rectilinear face whose edges equal their lattice sums has an even ring, so the settle search keeps only the other
  // faces' rings while the counts rise to the sums; a final solve with every ring checks the result. When no floors
  // settle, the plain counts stand and the faces whose lattice does not fit keep the generic route.
  const solveAll = (): CountSolveResult => {
    const plain = solveRowCounts(forced, pairs, rings, { evenEdges });
    if (!plain.ok || rectFaces.length === 0) return plain;
    const found = settleRect(
      {
        solve: (floor) => {
          const next = solveRowCounts(floor, pairs, [], { evenEdges });
          return next.ok ? next.value.rowCounts : undefined;
        },
        rects: rectFaces,
        size,
        rings: latticeRings,
      },
      forced,
      shortFirst,
    );
    if (found === undefined) return plain;
    const final = solveRowCounts(found.floor, pairs, rings, { evenEdges });
    return final.ok ? final : plain;
  };
  let settled = solveAll();
  for (let pass = 0; iso && settled.ok && pass < ISO_HOLE_PASSES; pass++) {
    const raises = balanced
      ? isoOuterBalance(shape, settled.value.rowCounts)
      : new Map<number, number>();
    for (const [e, n] of isoHoleRaises(shape, settled.value.rowCounts)) raises.set(e, n);
    for (const [e, n] of triRaises(shape, settled.value.rowCounts)) raises.set(e, n);
    if (raises.size === 0) break;
    for (const [e, n] of raises) forced[e] = n;
    settled = solveAll();
  }
  return settled;
}

function rectFaceList(shape: Shape) {
  const out = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const rect = analyzeRect(shape, f);
    if (rect !== undefined) out.push(rect);
  }
  return out;
}

/** Every planar face whose boundary total must be even: its outer and hole loops, one constraint per face. */
function ringConstraints(shape: Shape, iso: boolean): RingConstraint[] {
  const out: RingConstraint[] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    if (gridOf(shape, f).ok) continue;
    const { outer, holes } = faceLoops(shape, f);
    if (outer.length === 0) continue;
    const surface = shape.surfaces[(shape.faces[f] as Face).surface] as Surface;
    if (surface.kind !== 'plane' && !iso) continue;
    const edges = [outer, ...holes].flat().map((c) => (shape.coedges[c] as Coedge).edge);
    out.push({ id: `face:${f}`, face: f, edges });
  }
  return out;
}

/** Sample count of an edge, from the edge alone so both faces agree: lines by length, full circles in multiples of 4. */
function edgeCount(size: number, e: Edge, curve: Curve): Step<number> {
  const span = Math.abs(e.t1 - e.t0);
  if (curve.kind === 'line') return ok(Math.max(1, Math.round((span * len3(curve.d)) / size)));
  if (curve.kind === 'nurbs') {
    return ok(Math.max(1, Math.round(curveSpanLength(curve, e.t0, e.t1) / size)));
  }
  if (curve.kind !== 'circle') return err('curve-kind');
  if (Math.abs(span - TWO_PI) > FULL_TURN_TOL) {
    return ok(Math.max(1, Math.round((span * curve.radius) / size)));
  }
  return ok(4 * Math.max(1, Math.round((TWO_PI * curve.radius) / (4 * size))));
}

function edgeSamples(cx: Cx, ei: number): Step<number[]> {
  const known = cx.samples.get(ei);
  if (known !== undefined) return ok(known);
  const e = cx.shape.edges[ei] as Edge;
  if (e.curve < 0) return err('degenerate-edge');
  const curve = cx.shape.curves[e.curve] as Curve;
  const count = edgeCount(cx.size, e, curve);
  if (!count.ok) return count;
  const n = cx.counts.get(ei) ?? 0;
  const planned = cx.fractions.get(ei);
  const ids: number[] = [];
  for (let k = 0; k <= n; k++) {
    if (k === 0) ids.push(brepVertex(cx, e.v0));
    else if (k === n) ids.push(brepVertex(cx, e.v1));
    else {
      const t =
        planned === undefined
          ? e.t0 + ((e.t1 - e.t0) * k) / n
          : e.t0 + (e.t1 - e.t0) * (planned[k] as number);
      ids.push(newVertex(cx, curvePoint(curve, t)));
    }
  }
  cx.samples.set(ei, ids);
  return ok(ids);
}

/** Mesh vertex ids of one side in traversal order; a multi-coedge side joins at shared vertices. */
function sideIds(cx: Cx, side: GridSide): Step<number[]> {
  if (side.degenerate) return err('degenerate-side');
  if (side.coedges.length === 0) return err('empty-side');
  const out: number[] = [];
  for (const c of side.coedges) {
    const co = cx.shape.coedges[c] as Coedge;
    const sampled = edgeSamples(cx, co.edge);
    if (!sampled.ok) return sampled;
    const seq = co.reversed ? sampled.value.slice().reverse() : sampled.value;
    if (out.length === 0) pushAll(out, seq);
    else {
      if (out[out.length - 1] !== seq[0]) return err('side-discontinuous');
      pushAll(out, seq.slice(1));
    }
  }
  return ok(out);
}

/**
 * Fills the lattice bounded by four increasing-parameter sides. A boundary vertex is the shared
 * mesh id from its edge, so a periodic side (a torus seam) wraps by reusing the same ids.
 */
function patch(s: Sides, interior: (i: number, j: number) => number): Step<number[][]> {
  const nu = s.bottom.length - 1;
  const nv = s.right.length - 1;
  if (s.top.length - 1 !== nu || s.left.length - 1 !== nv) return err('uneven-opposite-sides');
  const b0 = s.bottom[0];
  const bu = s.bottom[nu];
  const rv = s.right[nv];
  const tu = s.top[nu];
  const t0 = s.top[0];
  const lv = s.left[nv];
  if (b0 !== s.left[0] || bu !== s.right[0] || rv !== tu || t0 !== lv) {
    return err('side-discontinuous');
  }
  const at = (i: number, j: number): number => j * (nu + 1) + i;
  const ids: number[] = new Array((nu + 1) * (nv + 1)).fill(-1);
  for (let i = 0; i <= nu; i++) {
    ids[at(i, 0)] = s.bottom[i] as number;
    ids[at(i, nv)] = s.top[i] as number;
  }
  for (let j = 0; j <= nv; j++) {
    ids[at(0, j)] = s.left[j] as number;
    ids[at(nu, j)] = s.right[j] as number;
  }
  for (let i = 1; i < nu; i++) {
    for (let j = 1; j < nv; j++) ids[at(i, j)] = interior(i, j);
  }
  const quads: number[][] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      quads.push([
        ids[at(i, j)] as number,
        ids[at(i + 1, j)] as number,
        ids[at(i + 1, j + 1)] as number,
        ids[at(i, j + 1)] as number,
      ]);
    }
  }
  return ok(quads);
}

function gridPatch(cx: Cx, g: GridFace, surface: Surface): Step<number[][]> {
  const bottom = sideIds(cx, g.bottom);
  if (!bottom.ok) return bottom;
  const right = sideIds(cx, g.right);
  if (!right.ok) return right;
  const pole =
    g.top.degenerate && !g.bottom.degenerate && !g.left.degenerate && !g.right.degenerate;
  const top = pole ? poleSide(cx, g.top, bottom.value.length) : sideIds(cx, g.top);
  if (!top.ok) return top;
  const left = sideIds(cx, g.left);
  if (!left.ok) return left;
  const nu = bottom.value.length - 1;
  const nv = right.value.length - 1;
  const quads = patch(
    {
      bottom: bottom.value,
      right: right.value,
      top: top.value.slice().reverse(),
      left: left.value.slice().reverse(),
    },
    (i, j) =>
      newVertex(
        cx,
        surfacePoint(surface, g.u0 + ((g.u1 - g.u0) * i) / nu, g.v0 + ((g.v1 - g.v0) * j) / nv),
      ),
  );
  if (!quads.ok || !pole) return quads;
  return ok(quads.value.map((q) => (q.length === 4 && new Set(q).size < 4 ? collapsePole(q) : q)));
}

/** A pole side is one vertex at the degenerate end: `count` copies of it, so the corner checks still hold. */
function poleSide(cx: Cx, side: GridSide, count: number): Step<number[]> {
  const co = cx.shape.coedges[side.coedges[0] as number] as Coedge;
  const e = cx.shape.edges[co.edge] as Edge;
  const pole = brepVertex(cx, co.reversed ? e.v0 : e.v1);
  return ok(new Array<number>(count).fill(pole));
}

/** A quad with a repeated corner at the pole is the triangle of its three distinct corners. */
function collapsePole(q: number[]): number[] {
  const out: number[] = [];
  for (const v of q) if (out[out.length - 1] !== v) out.push(v);
  if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

/** Four straight line coedges of a plane: bilinear interior in the plane, which stays exactly planar. */
function quad4(cx: Cx, outer: readonly number[]): Step<number[][]> {
  const sides: number[][] = [];
  for (const c of outer) {
    const s = sideIds(cx, { coedges: [c], degenerate: false });
    if (!s.ok) return s;
    sides.push(s.value);
  }
  const [s0, s1, s2, s3] = sides as [number[], number[], number[], number[]];
  const nu = s0.length - 1;
  const nv = s1.length - 1;
  if (s2.length - 1 !== nu || s3.length - 1 !== nv) return err('uneven-opposite-sides');
  const corners = [s0[0], s0[nu], s1[nv], s3[0]].map(
    (id): P3 => cx.mesh.position(id as number),
  ) as [P3, P3, P3, P3];
  const lat: Sides = {
    bottom: s0,
    right: s1,
    top: s2.slice().reverse(),
    left: s3.slice().reverse(),
  };
  // A side graded by a neighbouring rectilinear face makes bilinear interiors skew: blend from the boundary nodes.
  if (outer.some((c) => cx.fractions.has((cx.shape.coedges[c] as Coedge).edge))) {
    const at = (ids: readonly number[], k: number): P3 => cx.mesh.position(ids[k] as number) as P3;
    return patch(lat, (i, j) => {
      const u = i / nu;
      const v = j / nv;
      const blend = add3(
        add3(scale3(at(lat.bottom, i), 1 - v), scale3(at(lat.top, i), v)),
        add3(scale3(at(lat.left, j), 1 - u), scale3(at(lat.right, j), u)),
      );
      return newVertex(cx, sub3(blend, bilinear(corners, u, v)));
    });
  }
  return patch(lat, (i, j) => newVertex(cx, bilinear(corners, i / nu, j / nv)));
}

/**
 * A planar disk bounded by one full circle: an m x m block (n = 4m ring samples) joined to the ring by
 * 4m quads. Block corners are the ring samples 0, m, 2m, 3m scaled by 1 / sqrt(2) toward the centre,
 * so the block is a square of apothem r / 2 whose orientation follows the circle's start angle; it is the
 * design note's axis-aligned square only when that start lies on a diagonal. Ring samples are never moved.
 */
function disk(cx: Cx, c: number): Step<number[][]> {
  const ring = sideIds(cx, { coedges: [c], degenerate: false });
  if (!ring.ok) return ring;
  const e = edgeOf(cx.shape, c) as Edge;
  const curve = cx.shape.curves[e.curve] as Curve;
  if (curve.kind !== 'circle') return err('curve-kind');
  const n = ring.value.length - 1;
  if (n < 4 || n % 4 !== 0) return err('ring-count');
  const m = n / 4;
  const centre = curve.frame.o;
  const ringPoint = (k: number): P3 => cx.mesh.position(ring.value[k] as number);
  const corner = (q: number): number =>
    newVertex(cx, add3(centre, scale3(sub3(ringPoint(q * m), centre), Math.SQRT1_2)));
  const corners: [number, number, number, number] = [corner(0), corner(1), corner(2), corner(3)];
  const cornerPoints = corners.map((id): P3 => cx.mesh.position(id)) as [P3, P3, P3, P3];

  const at = (i: number, j: number): number => j * (m + 1) + i;
  const block: number[] = new Array((m + 1) * (m + 1)).fill(-1);
  block[at(0, 0)] = corners[0];
  block[at(m, 0)] = corners[1];
  block[at(m, m)] = corners[2];
  block[at(0, m)] = corners[3];
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= m; j++) {
      if (block[at(i, j)] !== -1) continue;
      block[at(i, j)] = newVertex(cx, bilinear(cornerPoints, i / m, j / m));
    }
  }
  const perimeter = (k: number): number => {
    const q = Math.floor(k / m);
    const r = k % m;
    const [i, j] = q === 0 ? [r, 0] : q === 1 ? [m, r] : q === 2 ? [m - r, m] : [0, m - r];
    return block[at(i, j)] as number;
  };

  const quads: number[][] = [];
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      quads.push([
        block[at(i, j)] as number,
        block[at(i + 1, j)] as number,
        block[at(i + 1, j + 1)] as number,
        block[at(i, j + 1)] as number,
      ]);
    }
  }
  for (let k = 0; k < n; k++) {
    quads.push([
      ring.value[k] as number,
      ring.value[k + 1] as number,
      perimeter((k + 1) % n),
      perimeter(k),
    ]);
  }
  return ok(quads);
}

function bilinear(c: readonly [P3, P3, P3, P3], s: number, t: number): P3 {
  const w0 = (1 - s) * (1 - t);
  const w1 = s * (1 - t);
  const w2 = s * t;
  const w3 = (1 - s) * t;
  const mix = (k: 0 | 1 | 2): number => w0 * c[0][k] + w1 * c[1][k] + w2 * c[2][k] + w3 * c[3][k];
  return [mix(0), mix(1), mix(2)];
}

/** Re-solves of the edge counts after hole blocks ask for more samples; each pass can move an outer grid. */
const ISO_HOLE_PASSES = 4;
const TRIM_ANGLE = Math.PI / 6;
const TRIM_MAX_POINTS = 4096;
const TRIM_MAX_TRIANGLES = 1500;

/** A planar outer-only face that is neither four lines, a disk, nor gridded takes the trimmed route with no holes. */
function outerOnlyTrimmed(shape: Shape, f: number): boolean {
  const surface = shape.surfaces[(shape.faces[f] as Face).surface] as Surface;
  const { outer, holes } = faceLoops(shape, f);
  if (surface.kind !== 'plane' || holes.length > 0 || outer.length === 0) return false;
  if (outer.length === 4 && outer.every((c) => isLine(shape, c))) return false;
  if (outer.length === 1 && isFullCircle(shape, outer[0] as number)) return false;
  return !gridOf(shape, f).ok;
}

/** Edges of every holed face: their counts round up to even so the trim triangle count has an even parity. */
/** Edges of every planar face that is not an iso-rectangle grid: the trimmed faces split-3 halves. */
export function trimmedPlaneEdges(shape: Shape): Set<number> {
  const out = new Set<number>();
  for (let f = 0; f < shape.faces.length; f++) {
    if (gridOf(shape, f).ok) continue;
    const { outer, holes } = faceLoops(shape, f);
    for (const loop of [outer, ...holes]) {
      for (const c of loop) out.add((shape.coedges[c] as Coedge).edge);
    }
  }
  return out;
}

function holedFaceEdges(shape: Shape): Set<number> {
  const out = new Set<number>();
  for (let f = 0; f < shape.faces.length; f++) {
    const { outer, holes } = faceLoops(shape, f);
    if (holes.length === 0) continue;
    for (const loop of [outer, ...holes]) {
      for (const c of loop) out.add((shape.coedges[c] as Coedge).edge);
    }
  }
  return out;
}

/** Uv of a point on a plane frame, solved through the frame's Gram matrix so non-orthonormal axes are exact. */
function planeUv(frame: Frame, p: P3): P2 {
  const d = sub3(p, frame.o);
  const xx = dot3(frame.x, frame.x);
  const xy = dot3(frame.x, frame.y);
  const yy = dot3(frame.y, frame.y);
  const bx = dot3(d, frame.x);
  const by = dot3(d, frame.y);
  const det = xx * yy - xy * xy;
  return [(bx * yy - by * xy) / det, (by * xx - bx * xy) / det];
}

function ringOf(cx: Cx, loop: readonly number[], frame: Frame): Step<TrimRing> {
  const ids: number[] = [];
  for (const c of loop) {
    const co = cx.shape.coedges[c] as Coedge;
    const samples = edgeSamples(cx, co.edge);
    if (!samples.ok) return err(samples.error);
    const seq = co.reversed ? samples.value.slice().reverse() : samples.value.slice();
    seq.pop();
    pushAll(ids, seq);
  }
  return ok({
    ids,
    uv: ids.map((id) => planeUv(frame, cx.mesh.position(id) as P3)),
  });
}

function trimmedPlane(
  cx: Cx,
  f: number,
  surface: Extract<Surface, { kind: 'plane' }>,
  outer: readonly number[],
  holes: readonly (readonly number[])[],
): Step<number[][]> {
  const rings: TrimRing[] = [];
  for (const loop of [outer, ...holes]) {
    const ring = ringOf(cx, loop, surface.frame);
    if (!ring.ok) return err(ring.error);
    rings.push(ring.value);
  }
  const rowFront = cx.rowFront || (!cx.penalty && !cx.dominant && holes.length > 0);
  const built = quadrangulateTrimmed(
    surface,
    rings,
    (id) => cx.mesh.position(id) as P3,
    (p) => newVertex(cx, p),
    {
      angle: TRIM_ANGLE,
      maxPoints: TRIM_MAX_POINTS,
      maxTriangles: TRIM_MAX_TRIANGLES,
      penalty: cx.penalty,
      dominant: cx.dominant,
      dominantSjFloor: cx.dominantSjFloor,
      rowFront,
      ...(cx.fallback === undefined ? {} : { fallback: cx.fallback }),
    },
  );
  if (!built.ok) return err(built.error.reason);
  if (rowFront && !cx.dominant && built.value.singles.length > 0) return err('row-front-odd-count');
  if (cx.penalty || cx.dominant || rowFront) {
    let minSj = Infinity;
    for (const q of built.value.quads) {
      minSj = Math.min(minSj, scaledJacobian(q.map((v) => cx.mesh.position(v) as P3)));
    }
    cx.faceQuality.push({
      face: f,
      minSj: built.value.quads.length === 0 ? 0 : minSj,
      foldedPairs: built.value.folded,
      unresolved: built.value.unresolved,
      quads: built.value.quads.length,
      triangles: built.value.singles.length,
      rowSkipped: built.value.rowSkipped,
      fallback: built.value.fallback,
      rowQuads: built.value.rowQuadCount,
      split3: built.value.split3,
    });
  }
  return ok([...built.value.quads.map((q) => [...q]), ...built.value.singles.map((t) => [...t])]);
}

function isoQuadric(cx: Cx, f: number): Step<number[][]> {
  const iso = isoQuadricFace(
    {
      shape: cx.shape,
      edgeSamples: (e) => edgeSamples(cx, e),
      position: (id) => cx.mesh.position(id) as P3,
      vertex: (v) => brepVertex(cx, v),
      addVertex: (p) => newVertex(cx, p),
      limits: { angle: TRIM_ANGLE, maxPoints: TRIM_MAX_POINTS, maxTriangles: TRIM_MAX_TRIANGLES },
    },
    f,
  );
  if (!iso.ok) return err(iso.error);
  let minSj = Infinity;
  for (const q of iso.value.quads) {
    minSj = Math.min(minSj, scaledJacobian(q.map((v) => cx.mesh.position(v) as P3)));
  }
  cx.faceQuality.push({
    face: f,
    minSj: iso.value.quads.length === 0 ? 0 : minSj,
    foldedPairs: 0,
    unresolved: 0,
    quads: iso.value.quads.length,
    triangles: iso.value.triangles.length,
    rowSkipped: 0,
    fallback: false,
    rowQuads: iso.value.rowQuads,
    split3: false,
  });
  return ok([...iso.value.quads.map((q) => [...q]), ...iso.value.triangles.map((t) => [...t])]);
}

function emitFace(cx: Cx, f: number, quads: readonly number[][]): Result<void, ModelingError> {
  const face = cx.shape.faces[f] as Face;
  const surface = cx.shape.surfaces[face.surface] as Surface;
  for (const quad of quads) {
    const ordered = face.reversed ? quad.slice().reverse() : quad.slice();
    const added = cx.mesh.addFace(ordered);
    if (!added.ok) {
      return brepFail<void>('brep-face-unsupported', 'a quad the mesh accepts', {
        face: f,
        surface: surface.kind,
        reason: 'mesh-rejected',
      });
    }
    const stamped = stampFaceNames(cx.mesh, added.value, face, f);
    if (!stamped.ok) return stamped;
  }
  return ok(undefined);
}

/** Scaled Jacobian of one quad: min over corners of dot(cross(a, b), N) with unit edges and N from the diagonals. */
export function scaledJacobian(p: readonly P3[]): number {
  const n = cross3(sub3(p[2] as P3, p[0] as P3), sub3(p[3] as P3, p[1] as P3));
  const length = len3(n);
  if (length === 0) return 0;
  const normal = scale3(n, 1 / length);
  let min = Infinity;
  for (let i = 0; i < 4; i++) {
    const here = p[i] as P3;
    const d1 = sub3(p[(i + 1) % 4] as P3, here);
    const d2 = sub3(p[(i + 3) % 4] as P3, here);
    if (len3(d1) === 0 || len3(d2) === 0) return 0;
    min = Math.min(min, dot3(cross3(unit3(d1), unit3(d2)), normal));
  }
  return min;
}

function measure(mesh: EditMesh, faces: number): QuadReport {
  const loops = mesh.faces().map((f) => mesh.faceVertices(f));
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const loop of loops) {
    for (const v of loop) {
      const p = mesh.position(v);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] as number, p[k] as number);
        hi[k] = Math.max(hi[k] as number, p[k] as number);
      }
    }
  }
  const diag = loops.length === 0 ? 0 : len3(sub3(hi, lo));
  const minEdge = DEGENERATE_REL * diag;
  const areaFloor = DEGENERATE_REL * diag * diag;

  let degenerate = 0;
  let sjMin = Infinity;
  let sjSum = 0;
  const undirected = new Map<string, { a: number; b: number; n: number }>();
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    let set = neighbours.get(a);
    if (set === undefined) {
      set = new Set();
      neighbours.set(a, set);
    }
    set.add(b);
  };
  for (const loop of loops) {
    const p = loop.map((v) => mesh.position(v));
    const n = loop.length;
    const area =
      n === 4
        ? 0.5 * len3(cross3(sub3(p[2] as P3, p[0] as P3), sub3(p[3] as P3, p[1] as P3)))
        : 0.5 * len3(cross3(sub3(p[1] as P3, p[0] as P3), sub3(p[2] as P3, p[0] as P3)));
    let bad = area < areaFloor || new Set(loop).size !== loop.length;
    for (let k = 0; k < n; k++) {
      const a = loop[k] as number;
      const b = loop[(k + 1) % n] as number;
      if (dist3(p[k] as P3, p[(k + 1) % n] as P3) < minEdge) bad = true;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = undirected.get(key) ?? {
        a: Math.min(a, b),
        b: Math.max(a, b),
        n: 0,
      };
      entry.n++;
      undirected.set(key, entry);
      link(a, b);
      link(b, a);
    }
    if (bad) degenerate++;
    if (n !== 4) continue;
    const sj = scaledJacobian(p);
    sjMin = Math.min(sjMin, sj);
    sjSum += sj;
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  const boundary = new Set<number>();
  for (const entry of undirected.values()) {
    if (entry.n === 1) {
      openEdges++;
      boundary.add(entry.a);
      boundary.add(entry.b);
    }
    if (entry.n > 2) nonManifoldEdges++;
  }
  let singularities = 0;
  for (const [v, nb] of neighbours) {
    if (!boundary.has(v) && nb.size !== 4) singularities++;
  }
  const quads = loops.filter((l) => l.length === 4).length;
  return {
    faces,
    quads,
    triangles: loops.length - quads,
    degenerate,
    scaledJacobian: {
      min: quads === 0 ? 0 : sjMin,
      mean: quads === 0 ? 0 : sjSum / quads,
    },
    openEdges,
    nonManifoldEdges,
    singularities,
  };
}
