import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import type { SurfaceBlend, SurfaceCorner } from './blend';
import type { ComputeOptions } from './compute/job';
import type { Region2, Shape2 } from './compute/region-ts';
import { atan2, hypot2 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { add, cross, dot, length, normalize, scale, sub, type Tuple3 } from './geom';
import { type EditMesh, FACE_EDGE_ROUND } from './mesh';
import {
  checkCurve,
  checkSurface,
  curveDerivatives,
  domain as curveDomain,
  type NurbsCurve,
  type NurbsSurface,
  surfaceClosest,
  surfaceDerivatives,
  surfaceDomain,
} from './nurbs';
import { surfaceSplit } from './nurbs-surface';
import { type Attribution, addFaces, type OpDiagnostic, type RoleCounts } from './ops';
import { triangulatePolygon } from './polygon2d';
import { orient2d } from './predicates';
import type { Point2 } from './primitives';
import { type RegionInput, region2d, toRegion } from './region2d';
import { removeSlivers } from './repair';
import type { PatchTransition, SurfaceSeam } from './surface-quality';
import {
  at,
  type DeclaredSeam,
  SeamTable,
  type SideSplits,
  sidesOf,
  Welder3,
} from './surface-seams';
import { isOrthoView, ORTHO_VIEWS, type OrthoView, toView } from './views';

/**
 * A region of a patch's parameter domain: `uv` in normalized domain coordinates
 * ([0, 1] x [0, 1] covers the patch), or `view`: an outline in that orthographic view
 * (view meters) projected along the view axis onto the patch.
 */
export type DomainRegion = (
  | { readonly uv: RegionInput }
  | { readonly view: OrthoView; readonly region: RegionInput }
) & {
  /** As a trim: the depth of its ring in meters, instead of the call's `trimRing` (0: none). */
  readonly ring?: number;
};

/** Faces of a patch inside a region, kept as their own role, tag and material slot. */
export interface SurfaceImprint {
  readonly region: DomainRegion;
  /** Role of the imprinted faces (default 'imprint'). */
  readonly role?: string;
  readonly tag?: string;
  readonly material?: string;
}

export interface SurfacePatch {
  readonly surface: NurbsSurface;
  /** Role and tag of the patch faces (default role 'surface', no tag). */
  readonly name?: string;
  /** Holes cut from the domain (wheel arches, intakes). */
  readonly trims?: readonly DomainRegion[];
  readonly imprints?: readonly SurfaceImprint[];
  /** Reverse the face orientation (default: normals along dS/du x dS/dv). */
  readonly flip?: boolean;
  /**
   * Inflections this patch's isoparms may have by design, per direction (`u`: isoparms
   * running along u; `v`: along v), for `validate({ surfaceQuality })`'s surface fairness:
   * a wheel-arch flare is `{ v: 1 }`. Ripples elsewhere on the patch still fail.
   */
  readonly inflections?: { readonly u?: number; readonly v?: number };
  /**
   * Support isoparms (subdivision support loops): one isoparm at each
   * `offset` (meters, mean distance along the surface, typically 0.002 to 0.003) from
   * each listed side. Faces in the strips they bound get the tag `support`.
   */
  /**
   * A thin transition patch: kind `'blend'` a fillet or blend band (which `blends` mark). Its
   * faces get the tag `support`, exempt from the edge-flow shape limits, and `spacing: 'even'`
   * keeps its refined isoparms across the band. Kind `'corner'` marks a quad of a setback corner
   * fill (`corners`, `nurbs.surface.fillN`, layout role 'corner'): a transition patch whose
   * edges to the other corner quads (the spokes) are designed G1, so surface-quality checks
   * require at most G1 there. `continuity` is what the blend or corner holds at its contact
   * edges (its option, default G1); a G1 blend declares tangent breaks for highlight lines.
   */
  readonly transition?: PatchTransition;
  readonly support?: {
    readonly sides: readonly ('u0' | 'u1' | 'v0' | 'v1')[];
    readonly offset: number | readonly number[];
  };
}

export interface SurfaceOptions {
  readonly patches: readonly SurfacePatch[];
  /** Largest distance between the surface and its mesh, in meters (default 0.001). */
  readonly chord?: number;
  /** Largest tangent turn across one segment, in degrees (default 12). */
  readonly angle?: number;
  /** Segment cap per direction and patch (default 256). */
  readonly maxSegments?: number;
  /**
   * Distance within which coincident vertices of different patches that no seam pairs merge,
   * capped at the model tolerance (default the model tolerance). Patch sides that share a
   * part within the larger of `weld` and `snap` are found to be one seam: the patch emitted
   * first samples it once and the other emits the same vertices (see `sew`).
   */
  readonly weld?: number;
  /**
   * Vertices of one patch closer than this merge, so a trim or imprint passing near a grid
   * node leaves no sliver face (default a quarter of `chord`; at least `weld`). Never across
   * patches.
   */
  readonly snap?: number;
  /**
   * Largest measured seam gap to sew, meters, capped at a tenth of the seam length. A seam
   * whose sides lie within the model tolerance is valid; within twice the tolerance (or this
   * bound) it is sewn with a warning naming it; a larger gap is `model-precondition`.
   */
  readonly sew?: number;
  /**
   * Quads that bend out of plane by more than five times the model tolerance (half the validate limit): 'split'
   * (default) along the shorter diagonal, as validation expects, or 'keep' them as
   * quads for later editing and subdivision.
   */
  readonly nonPlanar?: 'split' | 'keep';
  /**
   * Isoparm spacing: 'adaptive' (default) refines where the chord or angle demands;
   * 'even' keeps the refined count per direction but spaces the isoparms evenly in arc
   * length between C0 knot lines, then refines again where a tolerance still fails, so
   * neighbouring faces stay within a size ratio of about 2 (edge flow).
   */
  readonly spacing?: 'adaptive' | 'even';
  /**
   * Depth in meters of a ring of quads along every trim loop (default 0: none). Each cut
   * vertex gets one ring edge along its inward miter (the direction a flange or shell
   * insets it), so no face at the cut has a vertex just above a slanted edge; the grid
   * cells meet the ring's outer loop. Ring faces carry the tags `trim` and `support`.
   */
  readonly trimRing?: number;
  /**
   * Fillets applied before tessellation (`blendSurfaces`): each replaces two named
   * patches by their trimmed versions and adds the blend patch, so all three weld.
   */
  readonly blends?: readonly SurfaceBlend[];
  /**
   * Setback corners where three or more of `blends` meet at a vertex: the faces are split,
   * the strips blended, and the hole filled with G1-interior quads (see `SurfaceCorner`).
   */
  readonly corners?: readonly SurfaceCorner[];
}

const DEG = Math.PI / 180;

/** @internal A patch being tessellated: its normalized isoparm lists `s` and `t`. */
export interface Patch {
  readonly spec: SurfacePatch;
  readonly surface: NurbsSurface;
  readonly u: readonly [number, number];
  readonly v: readonly [number, number];
  s: number[];
  t: number[];
}

/** First partial derivatives in normalized coordinates. */
function partials(patch: Patch, s: number, t: number): [Tuple3, Tuple3, Tuple3] {
  const d = surfaceDerivatives(
    patch.surface,
    patch.u[0] + s * (patch.u[1] - patch.u[0]),
    patch.v[0] + t * (patch.v[1] - patch.v[0]),
    1,
  );
  const du = patch.u[1] - patch.u[0];
  const dv = patch.v[1] - patch.v[0];
  const su = (d[1] as Tuple3[])[0] as Tuple3;
  const sv = (d[0] as Tuple3[])[1] as Tuple3;
  return [
    (d[0] as Tuple3[])[0] as Tuple3,
    [su[0] * du, su[1] * du, su[2] * du],
    [sv[0] * dv, sv[1] * dv, sv[2] * dv],
  ];
}

function segmentDistance(p: Tuple3, a: Tuple3, b: Tuple3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  return length(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

function turn(a: Tuple3, b: Tuple3): number {
  if (length(a) === 0 || length(b) === 0) return 0;
  return atan2(length(cross(a, b)), dot(a, b));
}

interface Criteria {
  readonly chord: number;
  readonly angle: number;
  readonly maxSegments: number;
}

/** Whether the isoparm segment [a, b] along one direction needs a split at one probe. */
function needsSplit(
  patch: Patch,
  along: 's' | 't',
  a: number,
  b: number,
  probe: number,
  criteria: Criteria,
): boolean {
  const point = (x: number) => (along === 's' ? at(patch, x, probe) : at(patch, probe, x));
  const pa = point(a);
  const pb = point(b);
  for (const f of [0.25, 0.5, 0.75]) {
    if (segmentDistance(point(a + (b - a) * f), pa, pb) > criteria.chord) return true;
  }
  const tangent = (x: number) => {
    const [, su, sv] = along === 's' ? partials(patch, x, probe) : partials(patch, probe, x);
    return along === 's' ? su : sv;
  };
  return turn(tangent(a), tangent(b)) > criteria.angle;
}

function probes(list: readonly number[]): number[] {
  const mids = list.slice(1).map((x, i) => ((list[i] as number) + x) / 2);
  const all = [...list, ...mids].sort((x, y) => x - y);
  if (all.length <= 17) return all;
  const step = (all.length - 1) / 16;
  return Array.from({ length: 17 }, (_, k) => all[Math.round(k * step)] as number);
}

/** Refine one direction's isoparm list until every interval passes at every probe. */
function refineDirection(patch: Patch, along: 's' | 't', criteria: Criteria): boolean {
  const list = along === 's' ? patch.s : patch.t;
  const across = probes(along === 's' ? patch.t : patch.s);
  const out: number[] = [list[0] as number];
  let changed = false;
  const split = (a: number, b: number, depth: number) => {
    if (
      depth < 16 &&
      out.length + list.length < criteria.maxSegments &&
      across.some((probe) => needsSplit(patch, along, a, b, probe, criteria))
    ) {
      changed = true;
      const m = (a + b) / 2;
      split(a, m, depth + 1);
      split(m, b, depth + 1);
      return;
    }
    out.push(b);
  };
  for (let i = 0; i + 1 < list.length; i++) split(list[i] as number, list[i + 1] as number, 0);
  if (along === 's') patch.s = out;
  else patch.t = out;
  return changed;
}

/**
 * Cells whose center is farther than the chord from either diagonal's midpoint split
 * in both directions, so the triangles a cell may become also meet the tolerance.
 */
function refineCells(patch: Patch, criteria: Criteria): boolean {
  const splitS = new Set<number>();
  const splitT = new Set<number>();
  const nt = patch.t.length;
  const nodes = patch.s.flatMap((s) => patch.t.map((t) => at(patch, s, t)));
  const node = (i: number, j: number) => nodes[i * nt + j] as Tuple3;
  const mid = (a: Tuple3, b: Tuple3): Tuple3 => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
  ];
  for (let i = 0; i + 1 < patch.s.length; i++) {
    for (let j = 0; j + 1 < nt; j++) {
      // Measure along the surface normal: a flat patch with a curved parameterization
      // has diagonal midpoints off its centre but no deviation from the surface.
      const [c, su, sv] = partials(
        patch,
        ((patch.s[i] as number) + (patch.s[i + 1] as number)) / 2,
        ((patch.t[j] as number) + (patch.t[j + 1] as number)) / 2,
      );
      const n = cross(su, sv);
      const nl = length(n);
      const off = (q: Tuple3) => {
        const d = sub(c, q);
        return nl === 0 ? length(d) : Math.abs(dot(d, n)) / nl;
      };
      const error = Math.max(
        off(mid(node(i, j), node(i + 1, j + 1))),
        off(mid(node(i + 1, j), node(i, j + 1))),
      );
      if (error > criteria.chord) {
        splitS.add(i);
        splitT.add(j);
      }
    }
  }
  const grow = (list: number[], marked: Set<number>) => {
    if (marked.size === 0 || list.length + marked.size > criteria.maxSegments + 1) return list;
    const out: number[] = [];
    for (let i = 0; i < list.length; i++) {
      out.push(list[i] as number);
      if (marked.has(i)) out.push(((list[i] as number) + (list[i + 1] as number)) / 2);
    }
    return out;
  };
  const s = grow(patch.s, splitS);
  const t = grow(patch.t, splitT);
  const changed = s.length !== patch.s.length || t.length !== patch.t.length;
  patch.s = s;
  patch.t = t;
  return changed;
}

function initialList(knots: readonly number[], range: readonly [number, number]): number[] {
  const values = new Set<number>([0, 1]);
  for (const k of knots) {
    if (k > range[0] && k < range[1]) values.add((k - range[0]) / (range[1] - range[0]));
  }
  return [...values].sort((a, b) => a - b);
}

// ---- domain regions ----------------------------------------------------------------------

/** Domain coordinates of a view point: Newton on the projected surface map. */
function invertView(
  patch: Patch,
  view: OrthoView,
  target: Point2,
  grid: readonly { s: number; t: number; q: Tuple3 }[],
): Point2 {
  let best = grid[0] as { s: number; t: number; q: Tuple3 };
  let bestD = Infinity;
  for (const g of grid) {
    const d = hypot2(g.q[0] - target[0], g.q[1] - target[1]);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  let { s, t } = best;
  for (let it = 0; it < 40; it++) {
    const [p, su, sv] = partials(patch, s, t);
    const q = toView(view, p);
    const a = toView(view, su);
    const b = toView(view, sv);
    const rx = q[0] - target[0];
    const ry = q[1] - target[1];
    const det = a[0] * b[1] - a[1] * b[0];
    if (det === 0) break;
    const ds = (b[1] * rx - b[0] * ry) / det;
    const dt = (a[0] * ry - a[1] * rx) / det;
    const ns = Math.max(0, Math.min(1, s - ds));
    const nt = Math.max(0, Math.min(1, t - dt));
    const done = Math.abs(ns - s) < 1e-14 && Math.abs(nt - t) < 1e-14;
    s = ns;
    t = nt;
    if (done) break;
  }
  return [s, t];
}

/** `at` with the point clamped to the domain: trim outlines may reach past its sides. */
function atClamped(patch: Patch, [s, t]: Point2): Tuple3 {
  return at(patch, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, t)));
}

/** Insert midpoints into each ring edge until its surface image is within the chord. */
function refineRing(patch: Patch, ring: readonly Point2[], chord: number): Point2[] {
  const out: Point2[] = [];
  const split = (a: Point2, b: Point2, depth: number) => {
    const m: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (
      depth < 12 &&
      segmentDistance(atClamped(patch, m), atClamped(patch, a), atClamped(patch, b)) > chord
    ) {
      split(a, m, depth + 1);
      out.push(m);
      split(m, b, depth + 1);
    }
  };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point2;
    out.push(a);
    split(a, ring[(i + 1) % ring.length] as Point2, 0);
  }
  return out;
}

function domainRegion(
  patch: Patch,
  spec: DomainRegion,
  chord: number,
  grid: readonly { s: number; t: number; q: Tuple3 }[] | undefined,
  viewGrid: (view: OrthoView) => { s: number; t: number; q: Tuple3 }[],
): Result<Region2, ModelingError> {
  let input: Region2;
  if ('uv' in spec) input = toRegion(spec.uv);
  else {
    if (!isOrthoView(spec.view)) {
      return err(
        modelingError('model-invalid-argument', 'view is an orthographic view name', {
          view: spec.view,
        }),
      );
    }
    const samples = grid ?? viewGrid(spec.view);
    input = toRegion(spec.region).map((shape) => {
      const map = (ring: readonly Point2[]) =>
        ring.map((p) => invertView(patch, spec.view, p, samples));
      const holes = shape.holes?.map(map);
      return holes === undefined ? { outer: map(shape.outer) } : { outer: map(shape.outer), holes };
    });
  }
  for (const shape of input) {
    for (const ring of [shape.outer, ...(shape.holes ?? [])]) {
      for (const p of ring) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
          return err(
            modelingError('model-invalid-argument', 'domain region points are finite', {
              point: p,
            }),
          );
        }
      }
    }
  }
  return ok(
    input.map((shape): Shape2 => {
      const holes = shape.holes?.map((h) => refineRing(patch, h, chord));
      const outer = refineRing(patch, shape.outer, chord);
      return holes === undefined ? { outer } : { outer, holes };
    }),
  );
}

// ---- assembly ----------------------------------------------------------------------------

function arcLength(patch: Patch, along: 's' | 't'): number {
  let total = 0;
  for (const across of [0.25, 0.5, 0.75]) {
    let prev = along === 's' ? at(patch, 0, across) : at(patch, across, 0);
    for (let k = 1; k <= 32; k++) {
      const p = along === 's' ? at(patch, k / 32, across) : at(patch, across, k / 32);
      total += length(sub(p, prev));
      prev = p;
    }
  }
  return total / 3;
}

/** Normalized C0 lines of one direction: interior knots of full multiplicity. */
function breaks(patch: Patch, along: 's' | 't'): number[] {
  const knots = along === 's' ? patch.surface.knotsU : patch.surface.knotsV;
  const degree = along === 's' ? patch.surface.degreeU : patch.surface.degreeV;
  const [a, b] = along === 's' ? patch.u : patch.v;
  const out = [0, 1];
  for (const k of new Set(knots)) {
    if (!(k > a && k < b)) continue;
    if (knots.filter((x) => x === k).length >= degree) out.push((k - a) / (b - a));
  }
  return out.sort((x, y) => x - y);
}

/** Cumulative arc length along the middle isoparm of a direction, sampled evenly. */
function arcTable(patch: Patch, along: 's' | 't', samples: number): number[] {
  const table = [0];
  let prev = along === 's' ? at(patch, 0, 0.5) : at(patch, 0.5, 0);
  for (let k = 1; k <= samples; k++) {
    const x = k / samples;
    const p = along === 's' ? at(patch, x, 0.5) : at(patch, 0.5, x);
    table.push((table[k - 1] as number) + length(sub(p, prev)));
    prev = p;
  }
  return table;
}

/** Parameter where the arc table reaches `target`, linearly between samples. */
function paramAt(table: readonly number[], target: number): number {
  const n = table.length - 1;
  for (let k = 1; k <= n; k++) {
    const a = table[k - 1] as number;
    const b = table[k] as number;
    if (b >= target) return (k - 1 + (b > a ? (target - a) / (b - a) : 0)) / n;
  }
  return 1;
}

/**
 * At least as many intervals as `list` has and about `cell` meters long, evenly spaced
 * in arc length between the C0 lines.
 */
function evenList(patch: Patch, along: 's' | 't', cell: number, maxSegments: number): number[] {
  const list = along === 's' ? patch.s : patch.t;
  const table = arcTable(patch, along, 512);
  const total = table[512] as number;
  const lines = breaks(patch, along);
  if (!(total > 0)) return list;
  const out: number[] = [0];
  const intervals = Math.min(
    maxSegments,
    Math.max(list.length - 1, cell > 0 ? Math.round(total / cell) : 0),
  );
  for (let k = 1; k < lines.length; k++) {
    const a = lines[k - 1] as number;
    const b = lines[k] as number;
    const la = table[Math.round(a * 512)] as number;
    const lb = table[Math.round(b * 512)] as number;
    const n = Math.max(1, Math.round((intervals * (lb - la)) / total));
    for (let i = 1; i < n; i++) out.push(paramAt(table, la + ((lb - la) * i) / n));
    out.push(b);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

/** Mean parameter at arc distance `d` from a side, measured along five crossing isoparms. */
function supportParam(patch: Patch, side: 'u0' | 'u1' | 'v0' | 'v1', d: number): number {
  const along = side[0] === 'u' ? 's' : 't';
  const reverse = side[1] === '1';
  let sum = 0;
  for (const across of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const point = (x: number) => {
      const y = reverse ? 1 - x : x;
      return along === 's' ? at(patch, y, across) : at(patch, across, y);
    };
    let travelled = 0;
    let prev = point(0);
    let found = 1;
    for (let k = 1; k <= 1024; k++) {
      const p = point(k / 1024);
      const step = length(sub(p, prev));
      if (travelled + step >= d) {
        found = (k - 1 + (step > 0 ? (d - travelled) / step : 0)) / 1024;
        break;
      }
      travelled += step;
      prev = p;
    }
    sum += found;
  }
  const x = sum / 5;
  return reverse ? 1 - x : x;
}

/** Insert the support isoparms of a patch; offsets must stay inside its first interval. */
function addSupport(patch: Patch, index: number): Result<void, ModelingError> {
  const support = patch.spec.support;
  if (support === undefined) return ok(undefined);
  const offsets = typeof support.offset === 'number' ? [support.offset] : [...support.offset];
  if (
    offsets.length === 0 ||
    offsets.length > 3 ||
    !offsets.every((o) => Number.isFinite(o) && o > 0) ||
    !Array.isArray(support.sides) ||
    support.sides.length === 0 ||
    !support.sides.every((side) => ['u0', 'u1', 'v0', 'v1'].includes(side))
  )
    return err(
      modelingError(
        'model-invalid-argument',
        'support has sides among u0, u1, v0, v1 and one to three positive offsets',
        { patch: index, support: support as unknown as Record<string, unknown> },
      ),
    );
  for (const side of support.sides) {
    const along = side[0] === 'u' ? 's' : 't';
    const params = offsets.map((o) => supportParam(patch, side, o));
    const list = along === 's' ? patch.s : patch.t;
    if (params.some((x) => !(x > 0 && x < 1)))
      return err(
        modelingError('model-precondition', 'every support offset lies inside the patch', {
          patch: index,
          side,
          offsets,
        }),
      );
    // The support isoparms replace grid isoparms closer to the side than the outermost.
    const far = side[1] === '0' ? maxOf(params) : minOf(params);
    const kept = list.filter((x) =>
      side[1] === '0' ? x === 0 || x > far * 1.5 : x === 1 || 1 - x > (1 - far) * 1.5,
    );
    const next = [...new Set([...kept, ...params])].sort((a, b) => a - b);
    if (along === 's') patch.s = next;
    else patch.t = next;
  }
  return ok(undefined);
}

/** Tag `support` on new faces whose centroid lies within the largest offset of a support side. */
function tagSupport(mesh: EditMesh, patches: readonly Patch[], before: ReadonlySet<number>): void {
  const sides: { points: Tuple3[]; reach: number }[] = [];
  for (const patch of patches) {
    const support = patch.spec.support;
    if (support === undefined) continue;
    const offsets = typeof support.offset === 'number' ? [support.offset] : support.offset;
    const reach = maxOf(offsets) * 1.01;
    for (const side of support.sides) {
      const points = Array.from({ length: 129 }, (_, k) => {
        const x = k / 128;
        const fixed = side[1] === '0' ? 0 : 1;
        return side[0] === 'u' ? at(patch, fixed, x) : at(patch, x, fixed);
      });
      sides.push({ points, reach });
    }
  }
  if (sides.length === 0) return;
  const tag = mesh.tagIndex('support', true);
  for (const f of mesh.faces()) {
    if (before.has(f)) continue;
    const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
    const c: Tuple3 = [0, 1, 2].map(
      (k) => loop.reduce((sum, p) => sum + (p[k] as number), 0) / loop.length,
    ) as Tuple3;
    if (
      sides.some((side) =>
        side.points.some(
          (_, k) =>
            k > 0 &&
            segmentDistance(c, side.points[k - 1] as Tuple3, side.points[k] as Tuple3) <=
              side.reach,
        ),
      )
    )
      mesh.addTag(f, tag);
  }
}

interface Piece {
  readonly loop: Point2[];
  readonly imprint: number;
  /** The piece lies along a trim or imprint boundary (its cell was cut). */
  readonly trim: boolean;
  /** A quad of the ring along a trim (`trimRing`): kept a quad and tagged `support`. */
  readonly band?: boolean;
}

/**
 * Tessellate NURBS patches into the editable mesh (design 13): adaptive isoparm grids
 * per patch within the chord and angle tolerances; trims and imprints cut cells
 * through the `region` job in the normalized parameter domain; vertices on shared
 * boundaries coincide and weld, so adjacent patches join watertight. Full cells stay
 * quads; cut cells become Delaunay-flipped triangles. uv0 is the domain scaled to meters (mean
 * isoparm length), uv1 the normalized domain (decals and text).
 */
export function appendSurface(
  mesh: EditMesh,
  options: SurfaceOptions,
  attribution: Attribution,
  tolerance: number,
  compute: ComputeOptions,
  diagnostics: OpDiagnostic[],
  io: {
    /** Patch names for the seam report (default each patch's `name`, else 'surface'). */
    readonly names?: readonly string[];
    /** Side pairs a patch layout declares shared. */
    readonly declared?: readonly DeclaredSeam[];
    /** Receives each patch's trim loops (normalized domain), by patch index. */
    readonly trimLoops?: Point2[][][];
    /** Receives the seam report, each with its owner patch's index. */
    readonly seams?: { owner: number; seam: SurfaceSeam }[];
  } = {},
): Result<RoleCounts, ModelingError> {
  if (!Array.isArray(options.patches) || options.patches.length === 0) {
    return err(modelingError('model-invalid-argument', 'patches has at least one patch', {}));
  }
  const chord = options.chord ?? 0.001;
  const angle = options.angle ?? 12;
  const maxSegments = options.maxSegments ?? 256;
  const weld = options.weld ?? Math.max(tolerance, 1e-9);
  const snap = options.snap ?? chord / 4;
  const sew = options.sew;
  const ring = options.trimRing ?? 0;
  if (!(Number.isFinite(ring) && ring >= 0))
    return err(
      modelingError('model-invalid-argument', 'trimRing is a finite number >= 0', {
        trimRing: ring,
      }),
    );
  for (const [name, value] of [
    ['chord', chord],
    ['angle', angle],
    ['weld', weld],
    ['snap', snap],
    ['sew', sew ?? 1],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      return err(
        modelingError('model-invalid-argument', `${name} is a finite number > 0`, {
          [name]: value,
        }),
      );
    }
  }
  if (!Number.isInteger(maxSegments) || maxSegments < 1) {
    return err(
      modelingError('model-invalid-argument', 'maxSegments is an integer >= 1', { maxSegments }),
    );
  }
  const criteria: Criteria = { chord, angle: angle * DEG, maxSegments };
  const patches: Patch[] = [];
  for (const [index, spec] of options.patches.entries()) {
    const checked = checkSurface(spec.surface);
    if (!checked.ok) {
      const cause = checked.error;
      return err(
        modelingError(cause.code, cause.expected, { ...cause.detail, patch: index }, cause.hint),
      );
    }
    const [u, v] = surfaceDomain(spec.surface);
    const patch: Patch = {
      spec,
      surface: spec.surface,
      u,
      v,
      s: initialList(spec.surface.knotsU, u),
      t: initialList(spec.surface.knotsV, v),
    };
    for (let round = 0; round < 3; round++) {
      const a = refineDirection(patch, 's', criteria);
      const b = refineDirection(patch, 't', criteria);
      if (!a && !b) break;
    }
    for (let round = 0; round < 4 && refineCells(patch, criteria); round++);
    patches.push(patch);
  }
  const given: Region2[][] = [];
  for (const [index, patch] of patches.entries()) {
    const trims = patchTrims(patch, index, criteria.chord);
    if (!trims.ok) return trims;
    given.push(trims.value);
  }
  const reach = Math.max(weld, snap);
  const seams = SeamTable.find(patches, reach, io.declared, given);
  if (options.spacing === 'even') {
    // One cell size for the call: the finest arc spacing of its ordinary patches, so
    // neighbours meet at similar sizes. A transition band keeps its refined count across
    // (its shorter direction) and takes the cell along.
    const finest = (patch: Patch) =>
      Math.min(
        arcLength(patch, 's') / (patch.s.length - 1),
        arcLength(patch, 't') / (patch.t.length - 1),
      );
    const ordinary = patches.filter((p) => p.spec.transition === undefined);
    const cell = minOf((ordinary.length > 0 ? ordinary : patches).map(finest));
    for (const patch of patches) {
      const ls = arcLength(patch, 's');
      const lt = arcLength(patch, 't');
      const band = patch.spec.transition !== undefined;
      if (!band || ls >= lt) patch.s = evenList(patch, 's', cell, maxSegments);
      if (!band || lt > ls) patch.t = evenList(patch, 't', cell, maxSegments);
      refineDirection(patch, 's', criteria);
      refineDirection(patch, 't', criteria);
      for (let round = 0; round < 4 && refineCells(patch, criteria); round++);
    }
    seams.adopt();
  }
  for (const [index, patch] of patches.entries()) {
    const support = addSupport(patch, index);
    if (!support.ok) return support;
    if (patch.s.length - 1 >= maxSegments || patch.t.length - 1 >= maxSegments) {
      diagnostics.push({
        severity: 'warn',
        message: 'a patch reached maxSegments before meeting the tolerances',
        detail: { patch: index, s: patch.s.length - 1, t: patch.t.length - 1 },
      });
    }
  }
  // Trim seams (a blend's contact sides on the faces it trims): the faces' isoparm crossings
  // of each outline pin the band's isoparms along it, until the side seams settle too.
  seams.findTrims(given, criteria.chord, Math.max(weld, 2 * tolerance));
  for (let round = 0; round < 4; round++) {
    const changed = seams.demandTrims(given, round === 0);
    if (round === 0)
      for (const patch of patches)
        if (patch.spec.transition !== undefined) {
          refineDirection(patch, 's', criteria);
          refineDirection(patch, 't', criteria);
        }
    seams.refine();
    if (!changed && round > 0) break;
  }
  seams.sample();
  const splits = patches.map((): SideSplits => ({ s0: [], s1: [], t0: [], t1: [] }));
  const conformed = seams.sampleTrims(given, splits, criteria.chord);
  const cuts: Cut[] = [];
  for (const [index, patch] of patches.entries()) {
    const cut = cutPatch(
      patch,
      index,
      conformed[index] as Region2[],
      given[index] as Region2[],
      seams,
      criteria.chord,
      ring,
      snap,
      compute,
    );
    if (!cut.ok) return cut;
    cuts.push(cut.value);
    io.trimLoops?.push(cut.value.trimLoops);
  }
  const off = seams.crossings(cuts, splits, reach, criteria.chord);
  if (off > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${off} trim or imprint crossing(s) lie within the chord of another patch's boundary but off it: that seam may crack`,
      detail: { points: off },
    });
  }
  if (options.spacing !== undefined && options.spacing !== 'adaptive' && options.spacing !== 'even')
    return err(
      modelingError('model-invalid-argument', "spacing is 'adaptive' or 'even'", {
        spacing: options.spacing,
      }),
    );
  const names = patches.map((p, k) => io.names?.[k] ?? p.spec.name ?? 'surface');
  const judged = seams.check(names, tolerance, sew);
  if (!judged.ok) return judged;
  seams.link(tolerance, sew);
  for (const c of seams.tolerantChains(names))
    diagnostics.push({
      severity: 'warn',
      message: `blend ${c.band} closes from side parameter ${c.from.toFixed(4)} to its end ${c.end}: ${c.vertices} tolerant vertices, moved up to ${c.move.toExponential(2)} m (narrower than snap)`,
      detail: c,
    });
  for (const v of seams.tolerantVertices(names))
    diagnostics.push({
      severity: 'warn',
      message: `seams ${v.seams.join(', ')} converge at a tolerant vertex: ends merged ${v.move.toExponential(2)} m apart`,
      detail: v,
    });
  for (const t of judged.value)
    diagnostics.push({
      severity: 'warn',
      message: `seam ${t.seam} is tolerant: gap ${t.gap.toExponential(2)} m above the model tolerance ${tolerance} m (sewn up to ${t.limit.toExponential(2)} m)`,
      detail: t,
    });
  const before = new Set(mesh.faces());
  const welder = new Welder3(mesh, Math.max(weld, snap), Math.min(weld, tolerance));
  const counts: RoleCounts = {};
  // Half the validate limit: offset copies (shell inner walls) stay under it.
  const flatness = options.nonPlanar === 'keep' ? Infinity : tolerance * 5;
  let split = 0;
  for (const [index, patch] of patches.entries()) {
    const added = emitPatch(
      mesh,
      patch,
      index,
      cuts[index] as Cut,
      splits[index] as SideSplits,
      seams,
      welder,
      attribution,
      flatness,
      counts,
    );
    if (!added.ok) return added;
    split += added.value;
  }
  const report = seams.report(names, welder);
  if (report.length > 0) {
    if (io.seams !== undefined) pushAll(io.seams, report);
    diagnostics.push({
      severity: 'info',
      message: `${report.length} seam(s), each sampled once by its owner: measured gap and largest weld move per seam`,
      detail: {
        seams: report.map((r) => r.seam),
        vertices: seams.tolerantVertices(names),
        chains: seams.tolerantChains(names),
      },
    });
  }
  if (split > 0) {
    diagnostics.push({
      severity: 'info',
      message: `${split} non-planar quad(s) were split into triangles along their shorter diagonal`,
      detail: { quads: split },
    });
  }
  tagSupport(mesh, patches, before);
  const bands = patches.flatMap((p) =>
    p.spec.transition !== undefined && p.spec.name !== undefined ? [p.spec.name] : [],
  );
  if (bands.length > 0) {
    const tag = mesh.tagIndex('support', true);
    const named = bands.map((name) => mesh.tagIndex(name, true));
    for (const f of mesh.faces())
      if (!before.has(f) && named.some((t) => mesh.hasTag(f, t))) mesh.addTag(f, tag);
  }
  // A trim passing a grid node at less than the snap leaves a needle or sliver there
  // (vertices apart, but nearly collinear); remove those narrower than a quarter snap.
  const width = snap / 4;
  const created = mesh.faces().filter((f) => !before.has(f));
  const slivers = removeSlivers(mesh, created, width, tolerance);
  if (!slivers.ok) return slivers;
  if (slivers.value.removed + slivers.value.kept.length > 0) {
    diagnostics.push({
      severity: slivers.value.kept.length > 0 ? 'warn' : 'info',
      message: `surface removed ${slivers.value.removed} sliver face(s) narrower than ${width} m${slivers.value.kept.length > 0 ? `; ${slivers.value.kept.length} stay` : ''}`,
      detail: { width, removed: slivers.value.removed, kept: slivers.value.kept.slice(0, 32) },
    });
  }
  return ok(counts);
}

interface Cut {
  readonly pieces: Piece[];
  /** Boundary loops of the removed regions (normalized domain), before any trim ring. */
  readonly trimLoops: Point2[][];
  readonly imprints: { region: Region2; spec: SurfaceImprint }[];
  readonly lu: number;
  readonly lv: number;
}

function patchFailure(index: number) {
  return (e: ModelingError) =>
    err(modelingError(e.code, e.expected, { ...e.detail, patch: index }, e.hint));
}

/** Whether a domain segment runs along a patch side. */
function onSide(p: Point2, q: Point2): boolean {
  return (
    (p[0] === q[0] && (p[0] === 0 || p[0] === 1)) || (p[1] === q[1] && (p[1] === 0 || p[1] === 1))
  );
}

/**
 * The loop without the cut vertices closer than `depth` to where the cut meets a patch
 * side, when the shortened edge passes within `snap` of them in the domain (the mean arc
 * lengths scale it): a fold along the cut would otherwise pass the side's ring edge just
 * beyond such a vertex.
 */
function clearSideEnds(
  loop: Point2[],
  patch: Patch,
  depth: number,
  lu: number,
  lv: number,
  snap: number,
): Point2[] {
  const n = loop.length;
  const side = loop.map((p, k) => onSide(p, loop[(k + 1) % n] as Point2));
  const point = (k: number) => {
    const p = loop[k] as Point2;
    return at(patch, p[0], p[1]);
  };
  const drop = new Set<number>();
  for (let e = 0; e < n; e++) {
    for (const dir of [1, -1] as const) {
      const away = dir === 1 ? side[(e - 1 + n) % n] : side[e];
      const toward = dir === 1 ? side[e] : side[(e - 1 + n) % n];
      if (away !== true || toward === true) continue;
      const end = point(e);
      const close: number[] = [];
      let j = (e + dir + n) % n;
      while (
        side[j] !== true &&
        side[(j - 1 + n) % n] !== true &&
        close.length < n - 3 &&
        length(sub(point(j), end)) < depth
      ) {
        close.push(j);
        j = (j + dir + n) % n;
      }
      const flat = (k: number): Tuple3 => {
        const p = loop[k] as Point2;
        return [p[0] * lu, p[1] * lv, 0];
      };
      if (close.every((k) => segmentDistance(flat(k), flat(e), flat(j)) <= snap))
        for (const k of close) drop.add(k);
    }
  }
  return drop.size === 0 ? loop : loop.filter((_, k) => !drop.has(k));
}

/**
 * The ring along one trim loop (`trimRing`): every loop vertex is offset away from the
 * trimmed region by `depth` meters (in the surface's tangent plane at the vertex)
 * along the miter of its two edge normals, w = (n1 + n2) / (1 + n1 . n2) capped at 4,
 * and each loop edge becomes a quad to its offset edge, so every ring edge leaving a cut
 * vertex runs along that vertex's inward offset. Returns the offset loop, which replaces
 * the trim loop for the grid cells; the offset edges carry the isoparm crossings the cells
 * get. Loop edges along a patch side get no ring: the cut vertices at their ends slide
 * along the side. Loops whose offset leaves the patch or folds over are `model-precondition`.
 */
function ringLoop(
  loop: readonly Point2[],
  outer: boolean,
  depth: number,
  lu: number,
  lv: number,
  patch: Patch,
  snap: number,
  out: Piece[],
): Result<Point2[], ModelingError> {
  const area2 = (l: readonly Point2[]) => {
    let a = 0;
    for (let k = 0; k < l.length; k++) {
      const p = l[k] as Point2;
      const q = l[(k + 1) % l.length] as Point2;
      a += (p[0] * q[1] - q[0] * p[1]) * lu * lv;
    }
    return a;
  };
  // Outer loops run counter-clockwise, holes clockwise: the trimmed region is on the left.
  const b = clearSideEnds(
    area2(loop) > 0 === outer ? [...loop] : [...loop].reverse(),
    patch,
    depth,
    lu,
    lv,
    snap,
  );
  const n = b.length;
  // Offsets follow the surface metric at each vertex, so every ring edge leaving a cut
  // vertex is perpendicular in 3D to the loop edges it joins.
  const right = (su: Tuple3, sv: Tuple3, p: Point2, q: Point2): Tuple3 =>
    normalize(cross(add(scale(su, q[0] - p[0]), scale(sv, q[1] - p[1])), cross(su, sv)));
  // Loop edges along a patch side are the patch boundary: no ring there, and the cut
  // vertices at their ends slide along the side to meet the offset cut edge.
  const side = b.map((p, k) => onSide(p, b[(k + 1) % n] as Point2));
  const o: Point2[] = b.map((p, k) => {
    const before = side[(k - 1 + n) % n] as boolean;
    const after = side[k] as boolean;
    const prev = b[(k - 1 + n) % n] as Point2;
    const next = b[(k + 1) % n] as Point2;
    if (before && after) return p;
    const [, su, sv] = partials(patch, p[0], p[1]);
    if (before || after) {
      const normal = after ? right(su, sv, prev, p) : right(su, sv, p, next);
      const from = after ? next : prev;
      const d: Point2 = [p[0] - from[0], p[1] - from[1]];
      const l = hypot2(d[0], d[1]);
      const along = l > 0 ? add(scale(su, d[0] / l), scale(sv, d[1] / l)) : [0, 0, 0];
      const unit = length(along as Tuple3);
      const cos = unit > 0 ? dot(along as Tuple3, normal) / unit : 0;
      if (!(cos > 0)) return [NaN, NaN];
      // The slid vertex moves on to a grid isoparm less than half the depth beyond it, so
      // no sliver of a cell lies between them along the side.
      const axis = d[0] !== 0 ? 0 : 1;
      const sign = Math.sign(d[axis]);
      const target = p[axis] + (sign * depth) / Math.max(cos, 1 / 4) / unit;
      let best = target;
      let off = depth / 2 / unit;
      for (const x of axis === 0 ? patch.s : patch.t) {
        const beyond = (x - target) * sign;
        if (beyond >= 0 && beyond < off) {
          best = x;
          off = beyond;
        }
      }
      return axis === 0 ? [best, p[1]] : [p[0], best];
    }
    const n1 = right(su, sv, prev, p);
    const n2 = right(su, sv, p, next);
    const c = 1 + dot(n1, n2);
    let w = c > 1e-9 ? scale(add(n1, n2), 1 / c) : scale(n2, 4);
    const len = length(w);
    if (len > 4) w = scale(w, 4 / len);
    const q = toDomain(su, sv, scale(w, depth));
    return [p[0] + q[0], p[1] + q[1]];
  });
  const inside = o.every((p, k) =>
    side[k] === true || side[(k - 1 + n) % n] === true
      ? p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1
      : p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 1,
  );
  const crosses = (): boolean => {
    for (let i = 0; i < n; i++)
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const [a, b2, c, d] = [o[i], o[(i + 1) % n], o[j], o[(j + 1) % n]] as Point2[];
        const side = (p: Point2, q: Point2, r: Point2) =>
          (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
        if (
          side(a as Point2, b2 as Point2, c as Point2) *
            side(a as Point2, b2 as Point2, d as Point2) <
            0 &&
          side(c as Point2, d as Point2, a as Point2) *
            side(c as Point2, d as Point2, b2 as Point2) <
            0
        )
          return true;
      }
    return false;
  };
  if (!inside || Math.sign(area2(o)) !== Math.sign(area2(b)) || crosses())
    return err(
      modelingError(
        'model-precondition',
        'the trim ring stays inside the patch and does not fold over',
        { trimRing: depth, insidePatch: inside },
        'lower trimRing, keep trims clear of the patch sides, or round tight concave corners',
      ),
    );
  /** Parameters along p -> q where an isoparm of the grid crosses. */
  const crossings = (p: Point2, q: Point2): number[] => {
    const us: number[] = [];
    const add = (list: readonly number[], axis: 0 | 1) => {
      for (const x of list) {
        const a = p[axis];
        const c = q[axis];
        if (x > Math.min(a, c) && x < Math.max(a, c)) us.push((x - a) / (c - a));
      }
    };
    add(patch.s, 0);
    add(patch.t, 1);
    return us.sort((x, y) => x - y);
  };
  const lerp = (p: Point2, q: Point2, u: number): Point2 => [
    p[0] + (q[0] - p[0]) * u,
    p[1] + (q[1] - p[1]) * u,
  ];
  for (let k = 0; k < n; k++) {
    if (side[k] === true) continue;
    const k1 = (k + 1) % n;
    const [b0, b1, o0, o1] = [b[k], b[k1], o[k], o[k1]] as Point2[];
    // One quad per grid column the offset edge crosses, so ring faces stay small and
    // planar; their outer corners are the crossings the grid cells get.
    const us = [0, ...crossings(o0 as Point2, o1 as Point2), 1];
    const last = us.length - 2;
    const start = side[(k - 1 + n) % n] === true;
    const end = side[k1] === true;
    const push = (loop: Point2[], trim: boolean) =>
      out.push({ loop: area2(loop) < 0 ? loop.reverse() : loop, imprint: -1, trim, band: true });
    for (let i = 0; i <= last; i++) {
      const [ua, ub] = [us[i] as number, us[i + 1] as number];
      const [ba, oa, ob, bb] = [
        lerp(b0 as Point2, b1 as Point2, ua),
        lerp(o0 as Point2, o1 as Point2, ua),
        lerp(o0 as Point2, o1 as Point2, ub),
        lerp(b0 as Point2, b1 as Point2, ub),
      ];
      // A quad at a patch side has its ring edge on the side: a triangle of its own, so
      // the faces along the cut (tag `trim`) own no side edge.
      if (i === 0 && start && !(end && last === 0)) {
        push([ba, oa, ob], false);
        push([ba, ob, bb], true);
      } else if (i === last && end && !(start && last === 0)) {
        push([ba, oa, bb], true);
        push([oa, ob, bb], false);
      } else push([ba, oa, ob, bb], true);
    }
  }
  return ok(o);
}

/**
 * A trim reaching the patch sides, clipped to the domain: its edges along a side lie
 * exactly on it, so the trim ring treats them as patch boundary. Trims inside are kept.
 */
function clipToDomain(trim: Region2, compute: ComputeOptions): Result<Region2, ModelingError> {
  const box = region2d.bounds(trim);
  if (box === undefined || (box[0] > 0 && box[1] > 0 && box[2] < 1 && box[3] < 1)) return ok(trim);
  const cut = region2d.intersection(
    trim,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    { tolerance: 1e-10, compute },
  );
  if (!cut.ok) return cut;
  const snap = (x: number) => (Math.abs(x) <= 1e-9 ? 0 : Math.abs(x - 1) <= 1e-9 ? 1 : x);
  const ring = (r: readonly Point2[]) => r.map((p): Point2 => [snap(p[0]), snap(p[1])]);
  return ok(
    cut.value.region.map((shape) =>
      shape.holes === undefined
        ? { outer: ring(shape.outer) }
        : { outer: ring(shape.outer), holes: shape.holes.map(ring) },
    ),
  );
}

/** A view grid: the patch's isoparm grid points in that view, the inversion's seeds. */
function viewGridOf(patch: Patch): (view: OrthoView) => { s: number; t: number; q: Tuple3 }[] {
  const spec = patch.spec;
  const viewGrids = new Map<OrthoView, { s: number; t: number; q: Tuple3 }[]>();
  return (view: OrthoView) => {
    let grid = viewGrids.get(view);
    if (grid === undefined) {
      // Seed only from the side that faces the viewer: a panel that folds over in
      // projection (a fender crest) has a hidden branch at the same view point.
      const all: { s: number; t: number; q: Tuple3; facing: boolean }[] = [];
      const toward = ORTHO_VIEWS[view].toward;
      for (const s of patch.s) {
        for (const t of patch.t) {
          const [p, su, sv] = partials(patch, s, t);
          const facing = dot(cross(su, sv), toward) * (spec.flip === true ? -1 : 1) > 0;
          all.push({ s, t, q: toView(view, p), facing });
        }
      }
      const facing = all.filter((g) => g.facing);
      grid = facing.length > 0 ? facing : all;
      viewGrids.set(view, grid);
    }
    return grid;
  };
}

/** The trims of one patch in its normalized domain, rings refined to the chord. */
function patchTrims(patch: Patch, index: number, chord: number): Result<Region2[], ModelingError> {
  const viewGrid = viewGridOf(patch);
  const trims: Region2[] = [];
  for (const trim of patch.spec.trims ?? []) {
    const r = domainRegion(patch, trim, chord, undefined, viewGrid);
    if (!r.ok) return patchFailure(index)(r.error);
    trims.push(r.value);
  }
  return ok(trims);
}

/**
 * Cells of one patch cut by its trims (`trims`: with the trim seams' points) and split by its
 * imprints, in the normalized domain.
 */
function cutPatch(
  patch: Patch,
  index: number,
  conformed: Region2[],
  given: readonly Region2[],
  seams: SeamTable,
  chord: number,
  ring: number,
  snap: number,
  compute: ComputeOptions,
): Result<Cut, ModelingError> {
  const spec = patch.spec;
  const viewGrid = viewGridOf(patch);
  const fail = patchFailure(index);
  const trims = [...conformed];
  const regionOptions = { tolerance: 1e-10, compute };
  // Overlapping trims (a blend's and a shut line's, a corner's square) count once: record the
  // outline of their union, so an inside test by crossing parity sees the region they remove.
  let removed: Region2 = given[0] ?? [];
  for (const trim of given.slice(1)) {
    const union = region2d.union(removed, trim, regionOptions);
    if (!union.ok) return fail(union.error);
    removed = union.value.region;
  }
  const trimLoops = removed.flatMap((shape) =>
    [shape.outer, ...(shape.holes ?? [])].map((loop) => [...loop]),
  );
  const lu = arcLength(patch, 's');
  const lv = arcLength(patch, 't');
  const ringPieces: Piece[] = [];
  const ringed = new Set<number>();
  for (const [k, trim] of trims.entries()) {
    // A trim seam's outline (a blend's contact strip) takes no ring.
    const depth = seams.hostsTrimSeam(index, k) ? 0 : (spec.trims?.[k]?.ring ?? ring);
    if (!(typeof depth === 'number' && Number.isFinite(depth) && depth >= 0))
      return fail(
        modelingError('model-invalid-argument', 'a trim ring is a finite number >= 0', {
          trim: k,
          ring: depth,
        }),
      );
    if (depth > 0) {
      ringed.add(k);
      const clipped = clipToDomain(trim, compute);
      if (!clipped.ok) return fail(clipped.error);
      const grown: Region2[number][] = [];
      for (const shape of clipped.value) {
        const outer = ringLoop(shape.outer, true, depth, lu, lv, patch, snap, ringPieces);
        if (!outer.ok) return fail(outer.error);
        const holes = (shape.holes ?? []).map((h) =>
          ringLoop(h, false, depth, lu, lv, patch, snap, ringPieces),
        );
        for (const h of holes) if (!h.ok) return fail(h.error);
        grown.push({
          outer: outer.value,
          ...(shape.holes === undefined
            ? {}
            : { holes: holes.map((h) => (h as { value: Point2[] }).value) }),
        });
      }
      trims[k] = grown;
    }
  }
  const imprints: { region: Region2; spec: SurfaceImprint }[] = [];
  for (const imprint of spec.imprints ?? []) {
    const r = domainRegion(patch, imprint.region, chord, undefined, viewGrid);
    if (!r.ok) return fail(r.error);
    imprints.push({ region: r.value, spec: imprint });
  }
  const boxes = (list: readonly Region2[]) =>
    list.map((r) => region2d.bounds(r) ?? ([Infinity, Infinity, -Infinity, -Infinity] as const));
  const trimBoxes = boxes(trims);
  const imprintBoxes = boxes(imprints.map((i) => i.region));
  const overlaps = (b: readonly number[], s0: number, s1: number, t0: number, t1: number) =>
    (b[0] as number) <= s1 &&
    (b[2] as number) >= s0 &&
    (b[1] as number) <= t1 &&
    (b[3] as number) >= t0;
  const pieces: Piece[] = [...ringPieces];
  for (let i = 0; i + 1 < patch.s.length; i++) {
    for (let j = 0; j + 1 < patch.t.length; j++) {
      const s0 = patch.s[i] as number;
      const s1 = patch.s[i + 1] as number;
      const t0 = patch.t[j] as number;
      const t1 = patch.t[j + 1] as number;
      const cell: Point2[] = [
        [s0, t0],
        [s1, t0],
        [s1, t1],
        [s0, t1],
      ];
      const near = [...trims.keys()].filter((k) =>
        overlaps(trimBoxes[k] as readonly number[], s0, s1, t0, t1),
      );
      const nearTrims = near.map((k) => trims[k] as Region2);
      const nearImprints = imprints
        .map((imprint, k) => ({ imprint, k }))
        .filter(({ k }) => overlaps(imprintBoxes[k] as readonly number[], s0, s1, t0, t1));
      let shapes: Region2 = [{ outer: cell }];
      if (nearTrims.length > 0) {
        const cut = region2d.difference(cell, nearTrims.flat(), regionOptions);
        if (!cut.ok) return fail(cut.error);
        shapes = cut.value.region;
      }
      const labelled: { shapes: Region2; imprint: number }[] = [];
      let rest = shapes;
      for (const { imprint, k } of nearImprints) {
        if (rest.length === 0) break;
        const inside = region2d.intersection(rest, imprint.region, regionOptions);
        if (!inside.ok) return fail(inside.error);
        const outside = region2d.difference(rest, imprint.region, regionOptions);
        if (!outside.ok) return fail(outside.error);
        labelled.push({ shapes: inside.value.region, imprint: k });
        rest = outside.value.region;
      }
      labelled.push({ shapes: rest, imprint: -1 });
      // Cells a trim cuts into, or an imprint boundary crosses, line the cut: tag `trim`.
      // A ringed trim's cut is lined by its ring.
      // Intact: one quad (a cut quad along a trim seam lines the cut, though).
      const intact = (r: Region2) =>
        r.length === 1 &&
        (r[0] as Region2[number]).holes === undefined &&
        (r[0] as Region2[number]).outer.length === 4 &&
        !(r[0] as Region2[number]).outer.some((p) => seams.onTrimSeam(index, p));
      const along =
        (near.some((k) => !ringed.has(k)) && !intact(shapes)) ||
        labelled.filter((g) => g.shapes.length > 0).length > 1;
      for (const group of labelled) {
        for (const shape of group.shapes) {
          const plain =
            (nearTrims.length === 0 || seamQuad(shape, (p) => seams.onTrimSeam(index, p))) &&
            group.imprint < 0 &&
            shape.holes === undefined &&
            shape.outer.length === 4;
          if (plain) {
            pieces.push({ loop: [...shape.outer], imprint: -1, trim: along });
            continue;
          }
          const points = [...shape.outer, ...(shape.holes ?? []).flat()];
          let offset = shape.outer.length;
          const holes = (shape.holes ?? []).map((h) => {
            const ids = h.map((_, k) => offset + k);
            offset += h.length;
            return ids;
          });
          const parts = triangulatePolygon(
            points,
            shape.outer.map((_, k) => k),
            holes,
            [lu, lv],
          );
          if (!parts.ok) return fail(parts.error);
          for (const part of parts.value)
            pieces.push({
              loop: part.map((k) => points[k] as Point2),
              imprint: group.imprint,
              trim: along,
            });
        }
      }
    }
  }
  return ok({ pieces, imprints, lu, lv, trimLoops });
}

/**
 * A convex quad cut along a trim seam (four corners left, one of them a seam point): the seam
 * cell stays a quad.
 */
function seamQuad(shape: Shape2, seam: (p: Point2) => boolean): boolean {
  const ring = shape.outer;
  if (shape.holes !== undefined || ring.length !== 4 || !ring.some(seam)) return false;
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = ring[k] as Point2;
    const b = ring[(k + 1) % 4] as Point2;
    const c = ring[(k + 2) % 4] as Point2;
    const turn = Math.sign((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]));
    if (turn === 0 || (sign !== 0 && turn !== sign)) return false;
    sign = turn;
  }
  return true;
}

/** Split loop edges that run along a patch side at the inserted parameters. */
function splitSides(loop: readonly Point2[], splits: SideSplits): Point2[][] {
  const out: Point2[] = [];
  let inserted = false;
  for (let k = 0; k < loop.length; k++) {
    const p = loop[k] as Point2;
    const q = loop[(k + 1) % loop.length] as Point2;
    out.push(p);
    const b = sidesOf(q);
    const a = sidesOf(p).find((x) => b.some((y) => y.side === x.side));
    const bx = b.find((y) => y.side === a?.side);
    if (a === undefined || bx === undefined) continue;
    const lo = Math.min(a.x, bx.x);
    const hi = Math.max(a.x, bx.x);
    const inner = splits[a.side].filter((x) => x > lo + 1e-12 && x < hi - 1e-12);
    if (inner.length === 0) continue;
    inner.sort((x, y) => (a.x < bx.x ? x - y : y - x));
    for (const x of inner) {
      out.push(
        a.side === 's0' ? [0, x] : a.side === 's1' ? [1, x] : a.side === 't0' ? [x, 0] : [x, 1],
      );
    }
    inserted = true;
  }
  if (!inserted) return [[...loop]];
  // Pieces are convex in the domain: a fan from their centroid keeps every triangle proper.
  const c: Point2 = [
    loop.reduce((sum, p) => sum + p[0], 0) / loop.length,
    loop.reduce((sum, p) => sum + p[1], 0) / loop.length,
  ];
  return out.map((p, k) => [c, p, out[(k + 1) % out.length] as Point2]);
}

function emitPatch(
  mesh: EditMesh,
  patch: Patch,
  index: number,
  cut: Cut,
  splits: SideSplits,
  seams: SeamTable,
  welder: Welder3,
  attribution: Attribution,
  flatness: number,
  counts: RoleCounts,
): Result<number, ModelingError> {
  const spec = patch.spec;
  const fail = patchFailure(index);
  const { imprints, lu, lv } = cut;
  const role = spec.name ?? 'surface';
  const patchTag = spec.name === undefined ? -1 : mesh.tagIndex(spec.name, true);
  const pieces = cut.pieces.flatMap((piece) =>
    splitSides(piece.loop, splits).map((loop) => ({
      ring: piece.loop,
      loop,
      imprint: piece.imprint,
      trim: piece.trim,
      band: piece.band === true,
    })),
  );
  const stIds = new Map<string, number>();
  const vertex = (p: Point2) => {
    const key = `${p[0]},${p[1]}`;
    let id = stIds.get(key);
    if (id === undefined) {
      id = seams.vertex(index, p, welder);
      stIds.set(key, id);
    }
    return id;
  };
  const byGroup = new Map<
    number,
    { loops: number[][]; uvs: Point2[][]; trim: boolean[]; band: boolean[] }
  >();
  let split = 0;
  for (const piece of pieces) {
    // A closed band welds its piece rings to two vertices: its fan triangles would
    // retrace the welded edge.
    if (new Set(piece.ring.map(vertex)).size < 3) continue;
    const ids: number[] = [];
    const uvs: Point2[] = [];
    for (const p of piece.loop) {
      const id = vertex(p);
      if (ids[ids.length - 1] === id) continue;
      ids.push(id);
      uvs.push(p);
    }
    while (ids.length > 1 && ids[0] === ids[ids.length - 1]) {
      ids.pop();
      uvs.pop();
    }
    let group = byGroup.get(piece.imprint);
    if (group === undefined) {
      group = { loops: [], uvs: [], trim: [], band: [] };
      byGroup.set(piece.imprint, group);
    }
    // Snapping can pinch a piece at a repeated vertex: keep each simple sub-loop.
    for (const part of simpleLoops(ids, uvs)) {
      if (spec.flip === true) {
        part.ids.reverse();
        part.uvs.reverse();
      }
      // Ring quads stay quads: a diagonal would put a boundary vertex on a slanted edge.
      for (const [k, loop] of flatten(mesh, part.ids, piece.band ? Infinity : flatness).entries()) {
        if (k > 0) split++;
        group.loops.push(loop.map((c) => part.ids[c] as number));
        group.trim.push(piece.trim);
        group.band.push(piece.band);
        group.uvs.push(loop.map((c) => part.uvs[c] as Point2));
      }
    }
  }
  for (const [k, group] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
    const imprint = k < 0 ? undefined : imprints[k]?.spec;
    const groupAttribution: Attribution =
      imprint?.material === undefined
        ? attribution
        : { ...attribution, material: mesh.nameIndex(mesh.materialNames, imprint.material) };
    const faces = addFaces(
      mesh,
      group.loops,
      groupAttribution,
      imprint === undefined ? role : (imprint.role ?? 'imprint'),
      counts,
    );
    if (!faces.ok) {
      return fail(
        modelingError(
          faces.error.code,
          faces.error.expected,
          faces.error.detail ?? {},
          'adjacent patches must agree in orientation: set flip on one of them',
        ),
      );
    }
    const imprintTag = imprint?.tag === undefined ? -1 : mesh.tagIndex(imprint.tag, true);
    for (const [n, f] of faces.value.entries()) {
      if (patchTag >= 0) mesh.addTag(f, patchTag);
      if (group.trim[n] === true) mesh.addTag(f, mesh.tagIndex('trim', true));
      if (group.band[n] === true) mesh.addTag(f, mesh.tagIndex('support', true));
      if (spec.transition?.kind === 'blend')
        mesh.fFlags[f] = (mesh.fFlags[f] as number) | FACE_EDGE_ROUND;
      if (imprintTag >= 0) mesh.addTag(f, imprintTag);
      const uvs = group.uvs[n] as Point2[];
      for (const [c, h] of mesh.faceHalves(f).entries()) {
        const st = uvs[c] as Point2;
        mesh.setCorner('uv0', h, [st[0] * lu, st[1] * lv]);
        mesh.setCorner('uv1', h, st);
      }
    }
  }
  return ok(split);
}

/** Corner index loops of a face: a non-planar quad becomes two triangles on its shorter diagonal. */
function flatten(mesh: EditMesh, ids: readonly number[], flatness: number): number[][] {
  const all = ids.map((_, k) => k);
  if (ids.length !== 4) return [all];
  const points = ids.map((v) => mesh.position(v));
  const normal = normalize(
    cross(
      sub(points[2] as Tuple3, points[0] as Tuple3),
      sub(points[3] as Tuple3, points[1] as Tuple3),
    ),
  );
  const origin = points[0] as Tuple3;
  const deviation = maxOf(points.map((p) => Math.abs(dot(sub(p, origin), normal))));
  if (!(deviation > flatness)) return [all];
  const ac = length(sub(points[2] as Tuple3, points[0] as Tuple3));
  const bd = length(sub(points[3] as Tuple3, points[1] as Tuple3));
  return bd < ac
    ? [
        [0, 1, 3],
        [1, 2, 3],
      ]
    : [
        [0, 1, 2],
        [0, 2, 3],
      ];
}

/** Split a loop at repeated vertices into simple loops of at least three vertices. */
function simpleLoops(
  ids: readonly number[],
  uvs: readonly Point2[],
): { ids: number[]; uvs: Point2[] }[] {
  const out: { ids: number[]; uvs: Point2[] }[] = [];
  const stackIds: number[] = [];
  const stackUvs: Point2[] = [];
  const seen = new Map<number, number>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as number;
    const at = seen.get(id);
    if (at !== undefined) {
      const loopIds = stackIds.splice(at);
      const loopUvs = stackUvs.splice(at);
      for (const v of loopIds) seen.delete(v);
      if (loopIds.length >= 3) out.push({ ids: loopIds, uvs: loopUvs });
    }
    seen.set(id, stackIds.length);
    stackIds.push(id);
    stackUvs.push(uvs[i] as Point2);
  }
  if (stackIds.length >= 3) out.push({ ids: stackIds, uvs: stackUvs });
  return out;
}

/** Unit normal of a patch at normalized domain coordinates (undefined at a degenerate point). */
export function patchNormal(surface: NurbsSurface, s: number, t: number): Tuple3 | undefined {
  const [u, v] = surfaceDomain(surface);
  const patch: Patch = { spec: { surface }, surface, u, v, s: [], t: [] };
  const [, su, sv] = partials(patch, s, t);
  const n = cross(su, sv);
  return length(n) === 0 ? undefined : normalize(n);
}

// ---- splitAlong --------------------------------------------------------------------------

/** Where `splitAlong` cuts: an isoparm (`t` in the surface's own parameters) or a 3D curve on the patch. */
export type SplitCut =
  | { readonly iso: 'u' | 'v'; readonly t: number }
  | { readonly curve: NurbsCurve; readonly tolerance?: number };

export interface SplitAlongOptions {
  /** Shut-line gap, meters, measured across the line along the surface. */
  readonly gap: number;
  /** Names (role and tag) of the halves `a` and `b`. */
  readonly names: readonly [string, string];
  /**
   * Depth in meters of the ring of quads along each half's cut, as its trim's `ring`
   * (default: the `trimRing` of the surface call). A flange on the cut needs one: without
   * it the cut cells leave narrow faces along the fold.
   */
  readonly ring?: number;
}

export interface SplitAlongResult {
  readonly a: SurfacePatch;
  readonly b: SurfacePatch;
  /** Largest distance between the cut curve and the patch, m (0 for an isoparm). */
  readonly deviation: number;
}

interface CutSample {
  readonly lambda: number;
  readonly uv: Point2;
  readonly tangent: Tuple3;
  readonly point: Tuple3;
  readonly distance: number;
  readonly offsets: readonly [Point2, Point2];
}

/** Box margin around the normalized domain that the offset lines extend to before clipping. */
const SPLIT_MARGIN = 0.05;
/** Largest distance between an offset line and its polyline (m): 1 micrometer. */
const SPLIT_CHORD = 1e-6;
const SPLIT_SAMPLES = 64;
const SPLIT_DEPTH = 10;

function toDomain(su: Tuple3, sv: Tuple3, d: Tuple3): Point2 {
  const e = dot(su, su);
  const f = dot(su, sv);
  const g = dot(sv, sv);
  const a = dot(su, d);
  const b = dot(sv, d);
  const det = e * g - f * f;
  return det === 0 ? [0, 0] : [(g * a - f * b) / det, (e * b - f * a) / det];
}

/**
 * Walk `distance` meters along the surface from `start`, leaving perpendicular to the cut
 * tangent in the tangent plane, to its left in the domain (`side` 1) or right (-1).
 * Midpoint steps keep the direction in each tangent plane, so the path is a geodesic.
 */
function walkAcross(
  patch: Patch,
  start: Point2,
  tangent: Tuple3,
  side: 1 | -1,
  distance: number,
): Point2 {
  const [, su0, sv0] = partials(patch, start[0], start[1]);
  let d = normalize(cross(cross(su0, sv0), tangent));
  d = [d[0] * side, d[1] * side, d[2] * side];
  const steps = 8;
  const h = distance / steps;
  let uv = start;
  const direction = (p: Point2, prev: Tuple3): [Point2, Tuple3] => {
    const [, su, sv] = partials(patch, p[0], p[1]);
    const n = normalize(cross(su, sv));
    const along = normalize(
      sub(prev, [n[0] * dot(prev, n), n[1] * dot(prev, n), n[2] * dot(prev, n)]),
    );
    const q = toDomain(su, sv, along);
    const l = length(add(scale(su, q[0]), scale(sv, q[1])));
    return [l > 0 ? [q[0] / l, q[1] / l] : [0, 0], along];
  };
  for (let k = 0; k < steps; k++) {
    const [q1, d1] = direction(uv, d);
    const mid: Point2 = [uv[0] + (q1[0] * h) / 2, uv[1] + (q1[1] * h) / 2];
    const [q2, d2] = direction(mid, d1);
    uv = [uv[0] + q2[0] * h, uv[1] + q2[1] * h];
    d = d2;
  }
  return uv;
}

/** Signed area of a domain ring (positive counter-clockwise). */
function ringArea(ring: readonly Point2[]): number {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k] as Point2;
    const q = ring[(k + 1) % ring.length] as Point2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * The polyline without repeated points (a cut overshooting the patch side clamps onto it):
 * of two points within 1e-12 the first point of the line and otherwise the later one stay.
 */
function distinct(line: readonly Point2[]): Point2[] {
  const out: Point2[] = [];
  for (const p of line) {
    const q = out[out.length - 1];
    if (q !== undefined && Math.abs(q[0] - p[0]) <= 1e-12 && Math.abs(q[1] - p[1]) <= 1e-12) {
      if (out.length > 1) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** The line extended along its end segments to the box `SPLIT_MARGIN` around the domain. */
function extendToBox(line: readonly Point2[]): Point2[] {
  const lo = -SPLIT_MARGIN;
  const hi = 1 + SPLIT_MARGIN;
  const toBox = (p: Point2, q: Point2): Point2 => {
    const dx = p[0] - q[0];
    const dy = p[1] - q[1];
    let alpha = Infinity;
    if (dx > 0) alpha = Math.min(alpha, (hi - p[0]) / dx);
    if (dx < 0) alpha = Math.min(alpha, (lo - p[0]) / dx);
    if (dy > 0) alpha = Math.min(alpha, (hi - p[1]) / dy);
    if (dy < 0) alpha = Math.min(alpha, (lo - p[1]) / dy);
    return [p[0] + dx * alpha, p[1] + dy * alpha];
  };
  return [
    toBox(line[0] as Point2, line[1] as Point2),
    ...line,
    toBox(line[line.length - 1] as Point2, line[line.length - 2] as Point2),
  ];
}

/**
 * The pieces of a polyline inside the unit domain, each from its entry on a domain side to
 * its exit (Liang-Barsky per segment); clipped ends lie exactly on the side they cross.
 */
function insideRuns(line: readonly Point2[]): Point2[][] {
  const clip = (p: Point2, q: Point2) => {
    let t0 = 0;
    let t1 = 1;
    let at0: [0 | 1, number] | undefined;
    let at1: [0 | 1, number] | undefined;
    for (const axis of [0, 1] as const) {
      const d = q[axis] - p[axis];
      for (const [bound, sign] of [
        [0, -1],
        [1, 1],
      ] as const) {
        const room = sign * (bound - p[axis]);
        const rate = sign * d;
        if (rate === 0) {
          if (room < 0) return undefined;
          continue;
        }
        const t = room / rate;
        if (rate < 0) {
          if (t > t0) [t0, at0] = [t, [axis, bound]];
        } else if (t < t1) [t1, at1] = [t, [axis, bound]];
      }
    }
    if (t0 > t1) return undefined;
    const point = (t: number, on: [0 | 1, number] | undefined): Point2 => {
      if (t === 0) return p;
      if (t === 1) return q;
      const x: [number, number] = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      if (on !== undefined) x[on[0]] = on[1];
      return [Math.min(1, Math.max(0, x[0])), Math.min(1, Math.max(0, x[1]))];
    };
    return { t0, t1, a: point(t0, at0), b: point(t1, at1) };
  };
  const runs: Point2[][] = [];
  let run: Point2[] | undefined;
  for (let k = 0; k + 1 < line.length; k++) {
    const c = clip(line[k] as Point2, line[k + 1] as Point2);
    if (c === undefined) {
      if (run !== undefined) runs.push(run);
      run = undefined;
      continue;
    }
    if (run === undefined || c.t0 > 0) {
      if (run !== undefined) runs.push(run);
      run = [c.a];
    }
    run.push(c.b);
    if (c.t1 < 1) {
      runs.push(run);
      run = undefined;
    }
  }
  if (run !== undefined) runs.push(run);
  return runs.map(distinct).filter((r) => r.length > 1);
}

/**
 * The region to the right of a polyline from domain side to domain side, closed clockwise
 * along the sides: inside the unit domain, so its sides are the patch's own boundary.
 */
function rightOf(line: readonly Point2[]): Point2[] {
  const position = (p: Point2): number => {
    if (p[1] === 0) return p[0];
    if (p[0] === 1) return 1 + p[1];
    if (p[1] === 1) return 3 - p[0];
    return 4 - p[1];
  };
  const corners: [Point2, number][] = [
    [[0, 0], 0],
    [[1, 0], 1],
    [[1, 1], 2],
    [[0, 1], 3],
  ];
  const e = position(line[line.length - 1] as Point2);
  const span = (e - position(line[0] as Point2) + 4) % 4;
  const walk = corners
    .map(([c, at]) => ({ c, away: (e - at + 4) % 4 }))
    .filter((c) => c.away > 0 && c.away < span)
    .sort((x, y) => x.away - y.away)
    .map((c) => c.c);
  const ring: Point2[] = distinct([...line, ...walk]);
  return ringArea(ring) < 0 ? ring.reverse() : ring;
}

/** The first proper crossing of two non-adjacent segments of an open polyline. */
function selfCrossing(line: readonly Point2[]): Point2 | undefined {
  const n = line.length - 1;
  if (n < 3) return undefined;
  const cells = Math.max(1, Math.floor(Math.sqrt(n)));
  const grid = new Map<number, number[]>();
  const cellOf = (x: number) => Math.min(cells - 1, Math.max(0, Math.floor(x * cells)));
  for (let k = 0; k < n; k++) {
    const p = line[k] as Point2;
    const q = line[k + 1] as Point2;
    for (let i = cellOf(Math.min(p[0], q[0])); i <= cellOf(Math.max(p[0], q[0])); i++)
      for (let j = cellOf(Math.min(p[1], q[1])); j <= cellOf(Math.max(p[1], q[1])); j++) {
        const list = grid.get(i * cells + j);
        if (list === undefined) grid.set(i * cells + j, [k]);
        else list.push(k);
      }
  }
  const o = (a: Point2, b: Point2, c: Point2) =>
    Math.sign(orient2d(a[0], a[1], b[0], b[1], c[0], c[1]));
  for (const list of grid.values())
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x] as number;
        const j = list[y] as number;
        if (Math.abs(i - j) < 2) continue;
        const [a, b, c, d] = [line[i], line[i + 1], line[j], line[j + 1]] as Point2[];
        if (
          o(a as Point2, b as Point2, c as Point2) * o(a as Point2, b as Point2, d as Point2) < 0 &&
          o(c as Point2, d as Point2, a as Point2) * o(c as Point2, d as Point2, b as Point2) < 0
        )
          return a;
      }
  return undefined;
}

function mapRegion(region: DomainRegion, map: (p: Point2) => Point2): DomainRegion {
  if (!('uv' in region)) return region;
  return {
    ...region,
    uv: toRegion(region.uv).map((shape) => {
      const outer = shape.outer.map(map);
      return shape.holes === undefined
        ? { outer }
        : { outer, holes: shape.holes.map((h) => h.map(map)) };
    }),
  };
}

/**
 * Split a patch along a shut line into two named patches with a constant gap: an
 * isoparm cut splits the surface exactly and trims each half back by gap / 2; a curve cut
 * keeps the whole surface in each half and trims the other side plus its half of the gap.
 * The trim boundaries are offset lines of the cut, gap / 2 along the surface perpendicular
 * to the cut, sampled until each lies within 1 micrometer of its polyline. Half `a` lies
 * on the cut's lower-parameter side (iso) or left of the curve in the (u, v) domain.
 */
export function splitAlong(
  patch: SurfacePatch,
  cut: SplitCut,
  options: SplitAlongOptions,
): Result<SplitAlongResult, ModelingError> {
  const invalid = (expected: string, detail: Record<string, unknown>) =>
    err(modelingError('model-invalid-argument', expected, detail));
  const { gap, names } = options;
  const { ring } = options;
  if (!(typeof gap === 'number' && Number.isFinite(gap) && gap > 0))
    return invalid('gap is a finite number of meters > 0', { gap });
  if (ring !== undefined && !(typeof ring === 'number' && Number.isFinite(ring) && ring >= 0))
    return invalid('ring is a finite number of meters >= 0', { ring });
  const cutTrim = (line: readonly Point2[]): DomainRegion => ({
    uv: [{ outer: rightOf(line) }],
    ...(ring === undefined ? {} : { ring }),
  });
  if (
    !Array.isArray(names) ||
    names.length !== 2 ||
    !names.every((n) => typeof n === 'string' && n.length > 0) ||
    names[0] === names[1]
  )
    return invalid('names are two distinct non-empty strings', { names });
  const checked = checkSurface(patch.surface);
  if (!checked.ok) return checked;
  const surface = patch.surface;
  const [u, v] = surfaceDomain(surface);
  const whole: Patch = { spec: patch, surface, u, v, s: [], t: [] };
  const half = gap / 2;
  const named = (k: 0 | 1, extra: Partial<SurfacePatch>): SurfacePatch => ({
    ...patch,
    name: names[k],
    ...extra,
  });

  let sampleCut: (lambda: number) => Omit<CutSample, 'offsets'>;
  let iso: { dir: 'u' | 'v'; tau: number; t: number } | undefined;
  let tolerance = 0;
  if ('iso' in cut) {
    const range = cut.iso === 'u' ? u : cut.iso === 'v' ? v : undefined;
    if (range === undefined) return invalid("iso is 'u' or 'v'", { iso: cut.iso });
    const t = cut.t;
    if (!(typeof t === 'number' && Number.isFinite(t) && t > range[0] && t < range[1]))
      return invalid('the cut parameter lies strictly inside the domain', {
        iso: cut.iso,
        t,
        domain: range,
      });
    const tau = (t - range[0]) / (range[1] - range[0]);
    iso = { dir: cut.iso, tau, t };
    const dir = cut.iso;
    sampleCut = (lambda) => {
      const uv: Point2 = dir === 'u' ? [tau, lambda] : [1 - lambda, tau];
      const [point, su, sv] = partials(whole, uv[0], uv[1]);
      const tangent: Tuple3 = dir === 'u' ? sv : [-su[0], -su[1], -su[2]];
      return { lambda, uv, tangent, point, distance: 0 };
    };
  } else {
    const curve = cut.curve;
    const c = checkCurve(curve);
    if (!c.ok) return c;
    tolerance = cut.tolerance ?? 1e-4;
    if (!(Number.isFinite(tolerance) && tolerance > 0))
      return invalid('tolerance is a finite number of meters > 0', { tolerance });
    const [c0, c1] = curveDomain(curve);
    sampleCut = (lambda) => {
      const at3 = c0 + lambda * (c1 - c0);
      const d = curveDerivatives(curve, at3, 1);
      const p = d[0] as Tuple3;
      const hit = surfaceClosest(surface, p);
      const uv: Point2 = [(hit.u - u[0]) / (u[1] - u[0]), (hit.v - v[0]) / (v[1] - v[0])];
      return { lambda, uv, tangent: d[1] as Tuple3, point: p, distance: hit.distance };
    };
  }
  const sample = (lambda: number): CutSample => {
    const base = sampleCut(lambda);
    return {
      ...base,
      offsets: [
        walkAcross(whole, base.uv, base.tangent, 1, half),
        walkAcross(whole, base.uv, base.tangent, -1, half),
      ],
    };
  };
  const off = (a: Point2, b: Point2, m: Point2) =>
    length(sub(at(whole, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2), at(whole, m[0], m[1])));
  const samples: CutSample[] = [];
  const refine = (a: CutSample, b: CutSample, depth: number) => {
    const m = sample((a.lambda + b.lambda) / 2);
    const split =
      depth < SPLIT_DEPTH &&
      (off(a.uv, b.uv, m.uv) > SPLIT_CHORD ||
        off(a.offsets[0], b.offsets[0], m.offsets[0]) > SPLIT_CHORD ||
        off(a.offsets[1], b.offsets[1], m.offsets[1]) > SPLIT_CHORD);
    if (split) refine(a, m, depth + 1);
    samples.push(m);
    if (split) refine(m, b, depth + 1);
  };
  let prev = sample(0);
  samples.push(prev);
  for (let k = 1; k <= SPLIT_SAMPLES; k++) {
    const next = sample(k / SPLIT_SAMPLES);
    refine(prev, next, 0);
    samples.push(next);
    prev = next;
  }

  // A curve overshooting the patch side clamps onto it: its end samples repeat a side point.
  const onEdge = (uv: Point2) => uv.some((x) => x <= 1e-12 || x >= 1 - 1e-12);
  while (
    samples.length > 2 &&
    onEdge((samples[0] as CutSample).uv) &&
    onEdge((samples[1] as CutSample).uv)
  )
    samples.shift();
  while (
    samples.length > 2 &&
    onEdge((samples[samples.length - 1] as CutSample).uv) &&
    onEdge((samples[samples.length - 2] as CutSample).uv)
  )
    samples.pop();
  let deviation = 0;
  let worst = samples[0] as CutSample;
  for (const s of samples) {
    if (s.distance > deviation) {
      deviation = s.distance;
      worst = s;
    }
  }
  if (deviation > tolerance)
    return err(
      modelingError(
        'model-precondition',
        'the cut curve lies on the patch within tolerance',
        { at: worst.point, distance: deviation, tolerance, curveParameter: worst.lambda },
        'build the cut curve on the surface (points from surfacePoint, or an isoparm); splitAlong never projects a curve',
      ),
    );
  const lu = arcLength(whole, 's');
  const lv = arcLength(whole, 't');
  for (const [end, s] of [
    ['start', samples[0] as CutSample],
    ['end', samples[samples.length - 1] as CutSample],
  ] as const) {
    const [x, y] = s.uv;
    const away = Math.min(x * lu, (1 - x) * lu, y * lv, (1 - y) * lv);
    if (away > Math.max(tolerance, 1e-6))
      return err(
        modelingError(
          'model-precondition',
          'the cut runs from patch boundary to patch boundary',
          { end, at: s.point, uv: s.uv, distanceToBoundary: away },
          'extend the cut curve to the patch sides so it divides the patch in two',
        ),
      );
  }
  const precondition = (expected: string, detail: Record<string, unknown>, hint: string) =>
    err(modelingError('model-precondition', expected, { ...detail, gap }, hint));
  const metric = (uv: Point2, d: Point2): Tuple3 => {
    const [, su, sv] = partials(whole, uv[0], uv[1]);
    return add(scale(su, d[0]), scale(sv, d[1]));
  };
  for (const s of samples)
    for (const p of s.offsets) {
      if (!p.every(Number.isFinite))
        return precondition(
          'the offset lines beside the cut are finite',
          { at: s.point },
          'build the cut curve on the surface with a regular parametrization',
        );
      const inside: Point2 = [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))];
      const outside = length(metric(inside, [p[0] - inside[0], p[1] - inside[1]]));
      if (outside > half * 1.01 + Math.max(tolerance, 1e-6))
        return precondition(
          'half the gap fits inside the patch beside the cut',
          { at: s.point, outside },
          'reduce the gap or cut farther from the patch side',
        );
    }
  // An offset runs backwards where the cut turns tighter than half the gap: the trim folds.
  let fold: { sample: CutSample; speed: number } | undefined;
  for (let k = 0; k + 1 < samples.length; k++) {
    const s0 = samples[k] as CutSample;
    const s1 = samples[k + 1] as CutSample;
    const along = metric(s0.uv, [s1.uv[0] - s0.uv[0], s1.uv[1] - s0.uv[1]]);
    const l2 = dot(along, along);
    if (!(l2 > 0)) continue;
    for (const side of [0, 1] as const) {
      const a = s0.offsets[side];
      const b = s1.offsets[side];
      const speed = dot(metric(s0.uv, [b[0] - a[0], b[1] - a[1]]), along) / l2;
      if (speed < 0 && (fold === undefined || speed < fold.speed)) fold = { sample: s0, speed };
    }
  }
  if (fold !== undefined)
    return precondition(
      'the cut turns no tighter than half the gap (its offset trims do not fold)',
      {
        at: fold.sample.point,
        radius: half / (1 - fold.speed),
        minRadius: half,
        curveParameter: fold.sample.lambda,
      },
      'round the cut curve to a radius of at least gap / 2 at detail.at, or reduce the gap',
    );
  const lines: Point2[][] = [];
  for (const [k, raw] of [
    samples.map((s) => s.offsets[0]),
    samples.map((s) => s.offsets[1]).reverse(),
  ].entries()) {
    const line = distinct(raw);
    const runs = line.length < 2 ? [] : insideRuns(extendToBox(line));
    const name = names[k];
    if (runs.length !== 1) {
      const second = runs[1]?.[0];
      return precondition(
        'each half is one non-empty piece: its trim line crosses the patch once',
        {
          name,
          pieces: runs.length,
          ...(second === undefined ? {} : { at: at(whole, second[0], second[1]) }),
        },
        'move the cut away from the patch side by more than half the gap, or reduce the gap',
      );
    }
    const run = runs[0] as Point2[];
    const crossing = selfCrossing(run);
    if (crossing !== undefined)
      return precondition(
        'the trim line beside the cut does not cross itself',
        { name, at: at(whole, crossing[0], crossing[1]) },
        'keep the cut from coming back within the gap of itself',
      );
    const area = ringArea(rightOf(run));
    if (!(area > 1e-12 && area < 1 - 1e-12))
      return precondition(
        'each half is one non-empty piece: its trim line crosses the patch once',
        { name, pieces: 0 },
        'move the cut away from the patch side by more than half the gap, or reduce the gap',
      );
    lines.push(run);
  }
  const [left, right] = lines as [Point2[], Point2[]];
  if (iso === undefined)
    return ok({
      a: named(0, { trims: [...(patch.trims ?? []), cutTrim(left)] }),
      b: named(1, { trims: [...(patch.trims ?? []), cutTrim(right)] }),
      deviation,
    });
  const halves = surfaceSplit(surface, iso.dir, iso.t);
  if (!halves.ok) return halves;
  const { tau, dir } = iso;
  const axis = dir === 'u' ? 0 : 1;
  const into =
    (k: 0 | 1) =>
    (p: Point2): Point2 => {
      const x = k === 0 ? p[axis] / tau : (p[axis] - tau) / (1 - tau);
      return axis === 0 ? [x, p[1]] : [p[0], x];
    };
  const halfPatch = (k: 0 | 1, line: readonly Point2[]): SurfacePatch => {
    const map = into(k);
    return named(k, {
      surface: halves.value[k],
      trims: [...(patch.trims ?? []).map((r) => mapRegion(r, map)), cutTrim(line.map(map))],
      ...(patch.imprints === undefined
        ? {}
        : { imprints: patch.imprints.map((i) => ({ ...i, region: mapRegion(i.region, map) })) }),
    });
  };
  return ok({ a: halfPatch(0, left), b: halfPatch(1, right), deviation: 0 });
}
