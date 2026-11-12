import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, pushAll, replaceAll } from './arrays';
import { bevel } from './bevel';
import { triangleDistance } from './compute/clearance';
import { PrimitiveGrid } from './compute/mesh-query';
import { mergeFlags } from './crease';
import { atan2 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  cross,
  dot,
  faceCentroid,
  faceNormal,
  length,
  newell,
  normalize,
  planeOffset,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import {
  components,
  crossingDiagnostic,
  faceContacts,
  pairKey,
  pointTriangleDistance,
} from './intersect';
import { EDGE_SHARP, type EditMesh, NONE } from './mesh';
import { markRole, type OpDiagnostic, type RoleCounts, requirePositive } from './ops';
import { type CornerSource, type FaceRewrite, rewriteFaces } from './rewrite';
import { rayGrid } from './thickness';

/** Which side of the selected surface the wall grows to: against its normals, along them, or half each. */
export type ShellDirection = 'in' | 'out' | 'both';

export interface ShellOptions {
  /** Wall thickness in meters (> 0). */
  readonly thickness: number;
  /** Default `in` (CadQuery convention: a positive thickness shells inward). */
  readonly direction?: ShellDirection;
  /**
   * When the thickness exceeds the local feature size, shell with the largest
   * thickness that fits (reported) instead of failing with `model-precondition`. With
   * direction `in` and several parts in one call, also relieve (thin, to at most a third)
   * the walls that come near another part's: they keep a third of the thickness apart, or
   * half the gap where the parts' outer surfaces are closer than that. Without it, walls
   * of two parts that cross fail with `model-precondition` at the crossing; walls that are
   * only near are a located warning.
   */
  readonly clamp?: boolean;
  /**
   * A return flange at open boundary edges (trims, panel edges): instead of a flat rim,
   * the wall folds down and runs `reach` back under the panel, its top `depth` below the
   * skin (more than the thickness; the gap is `depth - thickness`). The flange is the
   * panel's own faces within `reach` of the edge, offset along the shell's vertex offsets,
   * so it follows the tessellation (creases and tight trim corners included) and cannot
   * cross itself in-plane. Faces get role `flange`. An array gives each flange its own
   * settings; their open edges (`at`) must not overlap.
   */
  readonly flange?: ShellFlange | readonly ShellFlange[];
  /**
   * Thin the wall to nothing at open boundary edges, as stylized cloth and hair edges do:
   * every vertex's offset scales by its distance along the surface to the open boundary over
   * `taper` meters (at most 1), so boundary vertices stay put and the outer and inner walls
   * share the boundary loop, a sharp crease with no rim faces. The panel must reach full
   * thickness somewhere (its interior is farther than `taper` from every edge). Excludes
   * `flange`.
   */
  readonly taper?: number;
}

export interface ShellFlange {
  /** How far the flange runs back under the panel, in meters (> 0; whole faces, at least one ring). */
  readonly reach: number;
  /** Depth of the flange's top below the skin, in meters (> thickness). */
  readonly depth: number;
  /**
   * Inner radius of the fold, in meters (default 0, a square fold): both bends round
   * concentrically (outer radius `radius + thickness`), the skin side as an edge round. A
   * hem is the largest radius, half the gap between the panel and the flange less a
   * straight wall of 2% of the fold's height. Needs `reach > radius + thickness`.
   */
  readonly radius?: number;
  /**
   * Edge round of the skin edge before a square fold, in meters (tangent to the skin and the
   * fold wall); past the thickness the fold's inner corner rounds by `round - thickness`.
   * Excludes `radius`.
   */
  readonly round?: number;
}

/** A flange with its defaults and its `at` faces (undefined: every open edge). */
interface Fold {
  readonly reach: number;
  readonly depth: number;
  readonly radius: number;
  readonly round: number;
  readonly at: ReadonlySet<number> | undefined;
}

/** Smallest thickness share of a tapered vertex off the boundary. */
const MIN_SHARE = 1e-3;
/** Vertex displacement limit in multiples of the thickness, as for `offset`. */
const MITER_LIMIT = 4;
/** Fraction of the largest feasible thickness that `clamp` applies, so opposite walls keep a gap. */
const CLAMP_MARGIN = 0.95;
/** Located elements listed per diagnostic or failure. */
const LOCATION_LIMIT = 16;
/** Relative thickness slack of the soft assertion: curved walls solve their planes in least squares. */
const CURVED_TOLERANCE = 1e-3;
/** Growth rounds of a collapsing band before shell reports the collapse. */
const MITER_ROUNDS = 8;
/** Smallest angle between a band's bounding planes that it miters (radians). */
const ANGLE_EPSILON = 1e-6;
/** Faces per quarter turn of a rounded fold or skin round. */
const ROUND_SEGMENTS = 6;
/** Share of a rounded fold's height that stays a straight wall (both sides together). */
const FOLD_WALL = 0.04;
/** Thinnest relieved wall, as a share of the thickness (also the clearance kept between parts). */
const RELIEF_FLOOR = 1 / 3;
/** Bisection steps of a relieved share. */
const RELIEF_STEPS = 30;
/** Rounds that add the vertices a relief brings near another part. */
const RELIEF_ROUNDS = 8;
/** Outer surfaces of two parts closer than this share of the thickness touch by design. */
const CONTACT = 1e-6;

/** Roles of the faces a shell adds: its wall, never part of the panel's skin. */
export const SHELL_WALL_ROLES = ['inner', 'rim', 'flange'] as const;

const DIRECTIONS: Readonly<Record<ShellDirection, readonly [number, number]>> = {
  in: [0, -1],
  out: [1, 0],
  both: [0.5, -0.5],
};

interface Plan {
  readonly region: number[];
  readonly vertices: number[];
  /** Displacement per vertex for a unit thickness (angle-weighted pseudo-normal direction). */
  readonly unit: Map<number, Tuple3>;
  readonly mitered: number[];
  /** Region half-edges on an open boundary (no twin face, or an opening): one rim quad each. */
  readonly rims: number[];
  readonly normals: Map<number, Tuple3>;
  /** Faces of collapsing bands whose vertices take their bounding planes' miter. */
  readonly band?: readonly number[];
  /**
   * Displacements of the outer and the inner wall when they differ: a band that collapses on
   * one side of a 'both' shell takes the miter there, while the other side keeps `unit`'s own
   * offset before the miter.
   */
  readonly sides?: readonly [ReadonlyMap<number, Tuple3>, ReadonlyMap<number, Tuple3>];
}

/** Unit displacement of `v` on the outer (0, `factors[0]`) or inner (1) wall. */
function sideUnit(p: Plan, side: number, v: number): Tuple3 {
  return (p.sides?.[side] ?? p.unit).get(v) as Tuple3;
}

/**
 * Thicken a closed or open surface into a wall.
 * `faces` must be whole parts: no edge of them borders an unselected face. `open`
 * faces (a subset of `faces`) are removed first, so their outlines become openings.
 *
 * Each vertex moves along its angle-weighted pseudo-normal; the magnitude solves its
 * incident face planes so every planar wall keeps the exact thickness (least
 * squares where more than three plane directions meet, clamped at the miter limit).
 * The selected faces stay the outer surface and keep their identity (moved for
 * `out`/`both`), so earlier roles still select them; a reversed copy becomes
 * `inner` and one `rim` quad closes every open boundary edge, with sharp borders. When the thickness exceeds the local feature size (opposite
 * walls would meet, or an offset face would collapse or invert), the call fails with
 * `model-precondition` naming the largest thickness that fits, unless `clamp`.
 *
 * Effect assertions (design 7.4): each outer/inner face pair is the thickness apart
 * within `tolerance` plus 0.1% (soft, a warning lists the others); a new wall that crosses any
 * other face fails with `model-degenerate` (detail.at locates the crossings) and leaves the
 * mesh unchanged. Crossings between parts that already crossed before the shell (overlapping
 * layers) stay a located warning.
 */
export function shell(
  mesh: EditMesh,
  faces: readonly number[],
  open: readonly number[],
  options: ShellOptions,
  label: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
  /** Receives the faces the shell created (layer re-tags them). */
  created?: { readonly inner: number[]; readonly rims: number[] },
  /** With `options.flange`: per flange, the faces whose open boundary edges get it (default all). */
  flangeAt?: readonly (readonly number[] | undefined)[],
): Result<RoleCounts, ModelingError> {
  const thickness = requirePositive('thickness', options.thickness);
  if (!thickness.ok) return thickness;
  const flanges = (
    options.flange === undefined
      ? []
      : Array.isArray(options.flange)
        ? options.flange
        : [options.flange]
  ) as readonly ShellFlange[];
  for (const flange of flanges) {
    const reach = requirePositive('flange.reach', flange.reach);
    if (!reach.ok) return reach;
    if (!(Number.isFinite(flange.depth) && flange.depth > options.thickness)) {
      return err(
        modelingError(
          'model-invalid-argument',
          'flange.depth is finite and more than the thickness',
          {
            depth: flange.depth,
            thickness: options.thickness,
          },
        ),
      );
    }
    for (const name of ['radius', 'round'] as const) {
      const value = flange[name];
      if (value !== undefined && !(Number.isFinite(value) && value >= 0)) {
        return err(
          modelingError('model-invalid-argument', `flange.${name} is a finite number >= 0`, {
            [name]: value,
          }),
        );
      }
    }
    if ((flange.radius ?? 0) > 0 && (flange.round ?? 0) > 0) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a flange has a fold radius or a skin round, not both',
          { radius: flange.radius, round: flange.round },
          'a rounded fold already rounds the skin edge with radius + thickness',
        ),
      );
    }
  }
  if (options.taper !== undefined) {
    const taper = requirePositive('taper', options.taper);
    if (!taper.ok) return taper;
    if (flanges.length > 0) {
      return err(
        modelingError('model-invalid-argument', 'a shell has a taper or a flange, not both', {
          taper: options.taper,
        }),
      );
    }
  }
  const direction = options.direction ?? 'in';
  // A tapered face keeps one vertex off the boundary, or its two walls would coincide.
  let region: readonly number[] = faces;
  if (options.taper !== undefined) {
    const poked = pokeEdgeFaces(mesh, faces, open);
    if (!poked.ok) return poked;
    region = poked.value;
  }
  const factors = DIRECTIONS[direction];
  if (factors === undefined) {
    return err(
      modelingError('model-invalid-argument', "direction is 'in', 'out' or 'both'", {
        direction,
      }),
    );
  }
  for (const flange of flanges) {
    const radius = flange.radius ?? 0;
    if (radius === 0) continue;
    // The straight walls between the bends: the gap between panel and flange, and the gap
    // plus both walls; together they keep FOLD_WALL of the outer height.
    const gap = flange.depth - (1 - (factors[0] as number)) * options.thickness;
    const maxRadius = gap / 2 - (FOLD_WALL / 2) * (gap + 2 * options.thickness);
    if (radius > maxRadius || flange.reach <= radius + options.thickness) {
      return err(
        modelingError(
          'model-invalid-argument',
          `flange.radius fits the fold (at most ${maxRadius}) and reach is more than radius + thickness`,
          { radius, maxRadius, reach: flange.reach, thickness: options.thickness },
          'reduce flange.radius to at most detail.maxRadius, or deepen the flange (depth) or lengthen it (reach)',
        ),
      );
    }
  }
  const planned = plan(mesh, region, open);
  if (!planned.ok) return planned;
  let p = planned.value;
  let share: ((v: number) => number) | undefined;
  if (options.taper !== undefined) {
    const tapered = taperShare(mesh, p, options.taper);
    if (!tapered.ok) return tapered;
    share = tapered.value;
  }
  let limit = feasibleThickness(mesh, p, factors, options.thickness, tolerance, open, share);
  if (limit.by === 'collapse' && limit.thickness < options.thickness) {
    const banded = miterCollapse(
      mesh,
      p,
      factors,
      options.thickness,
      tolerance,
      share ?? (() => 1),
    );
    if (banded !== undefined) {
      const fits = feasibleThickness(
        mesh,
        banded,
        factors,
        options.thickness,
        tolerance,
        open,
        share,
      );
      if (fits.thickness >= options.thickness) {
        p = banded;
        limit = fits;
      }
    }
  }
  let applied = options.thickness;
  if (limit.thickness < options.thickness) {
    const where = {
      thickness: options.thickness,
      maxThickness: limit.thickness,
      limitedBy: limit.by,
      ...(limit.by === 'clearance' ? { vertices: limit.elements } : { faces: limit.elements }),
      ...(limit.point === undefined ? {} : { point: limit.point }),
    };
    if (options.clamp !== true) {
      return err(
        modelingError(
          'model-precondition',
          `the thickness fits the local feature size (at most ${limit.thickness})`,
          where,
          limit.by === 'clearance'
            ? 'opposite walls would meet: reduce thickness to at most detail.maxThickness, or pass clamp: true'
            : 'a small face would collapse or invert: reduce thickness to at most detail.maxThickness, remove the small feature, or pass clamp: true',
        ),
      );
    }
    applied = limit.thickness * CLAMP_MARGIN;
    diagnostics.push({
      severity: 'warn',
      message: `thickness ${options.thickness} exceeds the local feature size; shelled with ${applied}`,
      detail: { ...where, applied },
    });
  }
  if (p.band !== undefined) {
    diagnostics.push({
      severity: 'info',
      message: `${p.band.length} face(s) of a band tighter than the thickness took the miter of their bounding planes`,
      detail: { faces: p.band.slice(0, LOCATION_LIMIT), count: p.band.length },
    });
  }
  if (p.mitered.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${p.mitered.length} vertex displacement(s) clamped at the miter limit of ${MITER_LIMIT} x thickness`,
      detail: { vertices: p.mitered.slice(0, LOCATION_LIMIT), count: p.mitered.length },
    });
  }
  if (flanges.length > 0 && applied !== options.thickness) {
    return err(
      modelingError(
        'model-precondition',
        'a flanged shell keeps its thickness (no clamp)',
        { thickness: options.thickness, applied },
        'reduce the thickness so it fits, or shell without a flange',
      ),
    );
  }
  // Relief thins walls below the requested thickness: only on request (`clamp`), and only
  // inward, so the outer surface stays. A flanged shell keeps its thickness.
  const relieve = options.clamp === true && direction === 'in';
  const relief =
    flanges.length > 0 ? undefined : partRelief(mesh, p, factors, applied, share, relieve);
  if (relief !== undefined && relief.least < RELIEF_FLOOR) {
    const vertices = [...relief.share]
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])
      .map(([v]) => v)
      .slice(0, LOCATION_LIMIT);
    const first = vertices[0] as number;
    const maxThickness = applied * (relief.fits ?? relief.least);
    return err(
      modelingError(
        'model-precondition',
        `the thickness fits the local feature size (at most ${maxThickness})`,
        {
          thickness: options.thickness,
          maxThickness,
          limitedBy: 'clearance',
          vertices,
          point: mesh.position(first),
          partner: relief.partner.get(first),
          clearance: relief.clearance,
        },
        "another part's wall comes within a third of the thickness near detail.point even with the walls relieved to a third: widen the gap there or reduce thickness",
      ),
    );
  }
  if (relief?.crossing !== undefined) {
    const { point, faces } = relief.crossing;
    const parts = faces.map((face) => ({
      face,
      label: mesh.labelNames[mesh.fLabel[face] as number] ?? '',
    }));
    return err(
      modelingError(
        'model-precondition',
        "the walls of one part stay clear of another part's walls",
        {
          thickness: options.thickness,
          limitedBy: 'clearance',
          point,
          parts,
          clearance: relief.clearance,
        },
        relieve
          ? 'the relieved walls still cross near detail.point: widen the gap there or reduce thickness'
          : "the planned walls of detail.parts cross near detail.point: clamp: true (direction 'in') or less thickness here",
      ),
    );
  }
  const folds = flanges.map((flange, i): Fold => {
    const at = flangeAt?.[i];
    return {
      reach: flange.reach,
      depth: flange.depth,
      radius: flange.radius ?? 0,
      round: flange.round ?? 0,
      at: at === undefined ? undefined : new Set(at),
    };
  });
  const backup = mesh.clone();
  const built = build(
    mesh,
    backup,
    p,
    open,
    factors,
    applied,
    label,
    tolerance,
    diagnostics,
    created,
    folds,
    share,
    relief,
  );
  if (!built.ok) mesh.assign(backup);
  return built;
}

/**
 * Prepare a region for a tapered shell, whose walls share the boundary vertices: interior
 * edges between two boundary vertices get a midpoint, and faces with two boundary vertices
 * that are not loop neighbours (panel corners) split into a fan around their centroid, so the
 * two walls never share an edge or a diagonal but the boundary; attributes, corner values and edge flags
 * carry over (`rewriteFaces`). Returns the region's faces (and the opening faces as given).
 */
function pokeEdgeFaces(
  mesh: EditMesh,
  faces: readonly number[],
  open: readonly number[],
): Result<number[], ModelingError> {
  const opening = new Set(open);
  const walled = faces.filter((f) => !opening.has(f));
  const inRegion = new Set(walled);
  const boundaryOf = (list: readonly number[]) => {
    const on = new Set<number>();
    for (const f of list) {
      for (const h of mesh.faceHalves(f)) {
        const twin = mesh.hFace[h ^ 1] as number;
        if (twin !== NONE && !opening.has(twin)) continue;
        on.add(mesh.hVert[h] as number);
        on.add(mesh.hVert[mesh.hNext[h] as number] as number);
      }
    }
    return on;
  };
  // Chords: interior edges between two boundary vertices (narrow strips) get a midpoint, or
  // both walls would run that edge between the same shared vertices.
  let on = boundaryOf(walled);
  const middle = new Map<number, number>();
  const parent = new Map<number, readonly [number, number]>();
  for (const f of walled) {
    for (const h of mesh.faceHalves(f)) {
      const twin = mesh.hFace[h ^ 1] as number;
      const a = mesh.hVert[h] as number;
      const b = mesh.hVert[mesh.hNext[h] as number] as number;
      if (twin === NONE || !inRegion.has(twin) || !on.has(a) || !on.has(b) || middle.has(h >> 1))
        continue;
      const [pa, pb] = [mesh.position(a), mesh.position(b)];
      const m = mesh.addVertex((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2);
      middle.set(h >> 1, m);
      parent.set(m, [a, b]);
    }
  }
  let region = walled;
  if (middle.size > 0) {
    const touched = walled.filter((f) => mesh.faceHalves(f).some((h) => middle.has(h >> 1)));
    const rewrites: FaceRewrite[] = touched.map((f) => ({
      face: f,
      loops: [
        mesh.faceHalves(f).flatMap((h): CornerSource[] => {
          const m = middle.get(h >> 1);
          const own: CornerSource = { v: mesh.hVert[h] as number, corner: h };
          return m === undefined
            ? [own]
            : [own, { v: m, from: h, to: mesh.hNext[h] as number, t: 0.5 }];
        }),
      ],
    }));
    const split = rewriteFaces(mesh, rewrites, parent);
    if (!split.ok) return split;
    const changed = new Set(touched);
    region = [...walled.filter((f) => !changed.has(f)), ...split.value.flat()];
    on = boundaryOf(region);
  }
  // Faces with two boundary vertices that are not loop neighbours (panel corners, quads
  // spanning a narrow strip) become a fan around their centroid, so their two walls share at
  // most the boundary edges.
  const keep: number[] = [];
  const rewrites: FaceRewrite[] = [];
  for (const f of region) {
    const halves = mesh.faceHalves(f);
    // Two boundary vertices that are not neighbours in the loop (opposite corners of a quad)
    // would join both walls through the same diagonal once triangulated.
    const corners = halves.map((h) => on.has(mesh.hVert[h] as number));
    const n = halves.length;
    const across = corners.some(
      (x, i) =>
        x && corners.some((y, j) => y && j !== i && (j - i + n) % n !== 1 && (i - j + n) % n !== 1),
    );
    if (!across) {
      keep.push(f);
      continue;
    }
    const c = faceCentroid(mesh, f);
    const center = mesh.addVertex(c[0], c[1], c[2]);
    const mid: CornerSource = { v: center, weights: halves.map((h) => [h, 1 / n] as const) };
    rewrites.push({
      face: f,
      loops: halves.map((h, i) => {
        const next = halves[(i + 1) % n] as number;
        return [
          { v: mesh.hVert[h] as number, corner: h },
          { v: mesh.hVert[next] as number, corner: next },
          mid,
        ];
      }),
    });
  }
  const fanned = rewrites.length === 0 ? ok([] as number[][]) : rewriteFaces(mesh, rewrites);
  if (!fanned.ok) return fanned;
  return ok([...keep, ...fanned.value.flat(), ...faces.filter((f) => opening.has(f))]);
}

/**
 * Each vertex's share of the thickness in a tapered shell: its distance along the region to
 * the open boundary over `taper`, at most 1 (boundary vertices 0). The panel must have open
 * edges, reach full thickness somewhere, and keep a vertex off the boundary in every face.
 */
function taperShare(
  mesh: EditMesh,
  p: Plan,
  taper: number,
): Result<(v: number) => number, ModelingError> {
  const boundary = [
    ...new Set(
      p.rims.flatMap((h) => [
        mesh.hVert[h] as number,
        mesh.hVert[mesh.hNext[h] as number] as number,
      ]),
    ),
  ];
  if (boundary.length === 0) {
    return err(
      modelingError(
        'model-precondition',
        'a tapered shell has open boundary edges to taper to',
        { taper },
        'the faces form a closed surface: shell without taper, or open it first',
      ),
    );
  }
  const distance = surfaceDistance(mesh, p.region, boundary);
  const farthest = maxOf(p.vertices.map((v) => distance.get(v) ?? 0));
  if (farthest <= taper) {
    return err(
      modelingError(
        'model-precondition',
        'the taper is shorter than the distance from the boundary to the panel interior',
        { taper, maxTaper: farthest },
        'reduce taper below detail.maxTaper so the wall reaches full thickness somewhere',
      ),
    );
  }
  const edge = new Set(boundary);
  const flat = p.region.find((f) => mesh.faceVertices(f).every((v) => edge.has(v)));
  if (flat !== undefined) {
    return err(
      modelingError(
        'model-precondition',
        'every face has a vertex off the open boundary',
        { face: flat, point: faceCentroid(mesh, flat) },
        'a face lying entirely on the boundary would collapse onto its copy: subdivide that strip first',
      ),
    );
  }
  // Only boundary vertices are shared by both walls; one reached over a zero-length edge
  // still moves (a little), or an interior vertex would join the two walls.
  return ok((v) =>
    edge.has(v) ? 0 : Math.min(1, Math.max(MIN_SHARE, (distance.get(v) ?? taper) / taper)),
  );
}

/** Distance along the region's edges from every region vertex to the nearest of `sources`. */
function surfaceDistance(
  mesh: EditMesh,
  region: readonly number[],
  sources: readonly number[],
): Map<number, number> {
  const around = new Map<number, Set<number>>();
  for (const f of region) {
    const loop = mesh.faceVertices(f);
    for (const [i, v] of loop.entries()) {
      const next = loop[(i + 1) % loop.length] as number;
      for (const [x, y] of [
        [v, next],
        [next, v],
      ] as const) {
        const set = around.get(x);
        if (set === undefined) around.set(x, new Set([y]));
        else set.add(y);
      }
    }
  }
  const distance = new Map<number, number>();
  // Binary heap of [distance, vertex].
  const heap: [number, number][] = [];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const [a, b] = [heap[i] as [number, number], heap[parent] as [number, number]];
      if (a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1])) break;
      [heap[i], heap[parent]] = [b, a];
      i = parent;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        let m = i;
        for (const c of [l, l + 1]) {
          const [x, y] = [heap[c], heap[m] as [number, number]];
          if (x !== undefined && (x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]))) m = c;
        }
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m] as [number, number], heap[i] as [number, number]];
        i = m;
      }
    }
    return top;
  };
  for (const v of sources) {
    distance.set(v, 0);
    push([0, v]);
  }
  for (let item = pop(); item !== undefined; item = pop()) {
    const [d, v] = item;
    if (d > (distance.get(v) ?? Infinity)) continue;
    const p = mesh.position(v);
    for (const x of around.get(v) ?? []) {
      const q = mesh.position(x);
      const next = d + length(sub(p, q));
      if (next < (distance.get(x) ?? Infinity)) {
        distance.set(x, next);
        push([next, x]);
      }
    }
  }
  return distance;
}

/**
 * Unit-thickness displacement of every vertex of a whole part (`faces`), along the
 * angle-weighted pseudo-normal (the shell's offset; exact for up to three planes).
 */
export function unitOffsets(
  mesh: EditMesh,
  faces: readonly number[],
): Result<
  { readonly unit: ReadonlyMap<number, Tuple3>; readonly mitered: readonly number[] },
  ModelingError
> {
  const planned = plan(mesh, faces, []);
  if (!planned.ok) return planned;
  return ok({ unit: planned.value.unit, mitered: planned.value.mitered });
}

function plan(
  mesh: EditMesh,
  faces: readonly number[],
  open: readonly number[],
): Result<Plan, ModelingError> {
  const all = new Set(faces);
  const strays = open.filter((f) => !all.has(f));
  if (strays.length > 0) {
    return err(
      modelingError('model-invalid-argument', 'open faces are among the shelled faces', {
        faces: strays.slice(0, LOCATION_LIMIT),
      }),
    );
  }
  const opening = new Set(open);
  const region = faces.filter((f) => !opening.has(f));
  if (region.length === 0) {
    return err(
      modelingError('model-invalid-argument', 'faces remain after removing the open faces', {
        open: open.length,
      }),
    );
  }
  const attached: number[] = [];
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const other = mesh.hFace[h ^ 1] as number;
      if (other !== NONE && !all.has(other)) attached.push(other);
    }
  }
  if (attached.length > 0) {
    const neighbours = [...new Set(attached)].sort((a, b) => a - b);
    return err(
      modelingError(
        'model-precondition',
        'the shelled faces are whole parts: no edge borders an unselected face',
        { faces: neighbours.slice(0, LOCATION_LIMIT), count: neighbours.length },
        "select every face of the part (for example sel.tag('body').connected()), or disconnect() it first",
      ),
    );
  }
  const normals = new Map<number, Tuple3>();
  for (const f of region) {
    const n = faceNormal(mesh, f);
    if (length(n) === 0) {
      return err(modelingError('model-degenerate', 'every shelled face has a normal', { face: f }));
    }
    normals.set(f, n);
  }
  const corners = new Map<number, { normal: Tuple3; angle: number }[]>();
  const rims: number[] = [];
  for (const f of region) {
    for (const h of mesh.faceHalves(f)) {
      const v = mesh.hVert[h] as number;
      const here = mesh.position(v);
      const prev = sub(mesh.position(mesh.hVert[mesh.hPrev[h] as number] as number), here);
      const next = sub(mesh.position(mesh.hVert[mesh.hNext[h] as number] as number), here);
      const angle = atan2(length(cross(next, prev)), dot(next, prev));
      const list = corners.get(v) ?? [];
      list.push({ normal: normals.get(f) as Tuple3, angle });
      corners.set(v, list);
      const twin = mesh.hFace[h ^ 1] as number;
      if (twin === NONE || opening.has(twin)) rims.push(h);
    }
  }
  const unit = new Map<number, Tuple3>();
  const mitered: number[] = [];
  const vertices = [...corners.keys()].sort((a, b) => a - b);
  for (const v of vertices) {
    const list = corners.get(v) as { normal: Tuple3; angle: number }[];
    let d = vertexDisplacement(list);
    const reach = length(d);
    if (!(reach > 0) || !Number.isFinite(reach)) {
      return err(
        modelingError('model-degenerate', 'every shelled vertex has a defined offset direction', {
          vertex: v,
          point: mesh.position(v),
        }),
      );
    }
    if (reach > MITER_LIMIT) {
      d = scale(d, MITER_LIMIT / reach);
      mitered.push(v);
    }
    unit.set(v, d);
  }
  return ok({ region, vertices, unit, mitered, rims, normals });
}

/**
 * Unit-thickness displacement of a vertex. The direction is the angle-weighted
 * pseudo-normal; at most three distinct planes solve exactly (every incident plane
 * moves by one), more use the angle-weighted least-squares length along it.
 */
function vertexDisplacement(corners: readonly { normal: Tuple3; angle: number }[]): Tuple3 {
  const distinct: Tuple3[] = [];
  for (const { normal } of corners) {
    if (!distinct.some((n) => dot(n, normal) > 1 - 1e-12)) distinct.push(normal);
  }
  if (distinct.length <= 3) return planeOffset(distinct, 1);
  const pseudo = normalize(
    corners.reduce<Tuple3>((sum, c) => add(sum, scale(c.normal, c.angle)), [0, 0, 0]),
  );
  let numerator = 0;
  let denominator = 0;
  for (const { normal, angle } of corners) {
    const c = dot(pseudo, normal);
    numerator += angle * c;
    denominator += angle * c * c;
  }
  return denominator > 0 ? scale(pseudo, numerator / denominator) : [0, 0, 0];
}

/**
 * Largest thickness (up to `requested`) that keeps the walls apart: opposite moving
 * walls meet halfway along each vertex ray (clearance), and no offset face may
 * collapse or invert (found by bisection on the faces that do at `requested`).
 */
function feasibleThickness(
  mesh: EditMesh,
  p: Plan,
  factors: readonly [number, number],
  requested: number,
  tolerance: number,
  open: readonly number[],
  /** Tapered shells: each vertex's share of the thickness. */
  share: (v: number) => number = () => 1,
): {
  readonly thickness: number;
  readonly by: 'clearance' | 'collapse';
  readonly elements: number[];
  readonly point?: Tuple3;
} {
  const opening = new Set(open);
  const incident = new Map<number, Set<number>>();
  for (const f of p.region) {
    for (const v of mesh.faceVertices(f)) {
      const set = incident.get(v) ?? new Set<number>();
      set.add(f);
      incident.set(v, set);
    }
  }
  let reach = 0;
  for (const units of p.sides ?? [p.unit])
    for (const d of units.values()) reach = Math.max(reach, length(d));
  const grid = rayGrid(
    mesh,
    2 * requested * reach,
    mesh.faces().filter((f) => !opening.has(f)),
  );
  const inRegion = new Set(p.region);
  let clearance = Infinity;
  const tight: { vertex: number; limit: number }[] = [];
  for (const v of p.vertices) {
    const own = incident.get(v) as Set<number>;
    const part = share(v);
    if (part === 0) continue;
    for (const [side, k] of factors.entries()) {
      if (k === 0) continue;
      const d = sideUnit(p, side, v);
      const size = length(d);
      const ray = scale(d, Math.sign(k) / size);
      const travel = Math.abs(k) * size * part;
      // A shelled wall ahead moves toward this one, so they meet halfway; other faces stay.
      for (const [approach, skip] of [
        [2, (f: number) => own.has(f) || !inRegion.has(f)],
        [1, (f: number) => inRegion.has(f)],
      ] as const) {
        const span = approach * travel;
        const found = grid.cast(mesh.position(v), ray, span * requested, skip);
        if (found === undefined) continue;
        const vertexLimit = found.distance / span;
        tight.push({ vertex: v, limit: vertexLimit });
        clearance = Math.min(clearance, vertexLimit);
      }
    }
  }
  const collapsed = (t: number) => collapsedFaces(mesh, p, factors, t, tolerance, share);
  const atRequested = collapsed(Math.min(requested, clearance));
  let collapse = Infinity;
  if (atRequested.length > 0) {
    let lo = 0;
    let hi = Math.min(requested, clearance);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (collapsed(mid).length > 0) hi = mid;
      else lo = mid;
    }
    collapse = lo;
  }
  if (collapse < clearance - tolerance && collapse < requested) {
    const first = atRequested[0] as number;
    return {
      thickness: collapse,
      by: 'collapse',
      elements: atRequested.slice(0, LOCATION_LIMIT),
      point: faceCentroid(mesh, first),
    };
  }
  if (clearance < requested) {
    const limiting = tight
      .filter((t) => t.limit < requested)
      .sort((a, b) => a.limit - b.limit || a.vertex - b.vertex)
      .map((t) => t.vertex);
    const vertices = [...new Set(limiting)].slice(0, LOCATION_LIMIT);
    return {
      thickness: clearance,
      by: 'clearance',
      elements: vertices,
      point: mesh.position(vertices[0] as number),
    };
  }
  return { thickness: requested, by: 'clearance', elements: [] };
}

/** A planned shell triangle: inner and rim triangles are walls; `source` is the skin triangle it stands on. */
interface Wall {
  readonly corners: readonly number[];
  readonly part: number;
  readonly wall: boolean;
  readonly source: number;
}

/** Near and relieved walls of a multi-part shell (design note 2026-10-25, B16 corner relief). */
interface Relief {
  /** Thickness share of each relieved vertex (below 1; empty when not relieving). */
  readonly share: ReadonlyMap<number, number>;
  /** The lowest region face of the part each near vertex's wall comes close to. */
  readonly partner: ReadonlyMap<number, number>;
  /** Each near vertex's smallest wall distance to that part, before relief. */
  readonly distance: ReadonlyMap<number, number>;
  /** The smallest share: below `RELIEF_FLOOR` the walls cannot keep the clearance. */
  readonly least: number;
  readonly clearance: number;
  /** When `least` is below the floor: the largest share of the thickness that would fit. */
  readonly fits?: number;
  /** Walls of two parts that touch or cross as built: a point on them and each part's lowest face. */
  readonly crossing?: { readonly point: Tuple3; readonly faces: readonly [number, number] };
}

/** Two wall triangles of different parts and the distance their walls keep. */
type Pair = readonly [number, number, number];

/**
 * Where one shell call holds several parts, the planned walls (inner faces and rims) of one
 * part should stay `thickness / 3` from every planned wall of another, or half the gap of
 * their outer surfaces where those are closer (a tight shut; surfaces in contact are exempt).
 * Vertex rays miss a corner passing beside another part's corner,
 * so this compares the planned triangles face to face (`PrimitiveGrid` candidates, exact
 * `triangleDistance`). With `relieve`, the vertices of near pairs take a smaller share of the
 * thickness, found by bisection: first one share for all of them, then each raised as far as the
 * clearance allows; `fits` then bounds the thickness when the floor cannot keep it. Walls that
 * still touch or cross are the `crossing`.
 * Undefined when the call has one part or no near pair (the shell is unchanged).
 */
function partRelief(
  mesh: EditMesh,
  p: Plan,
  factors: readonly [number, number],
  thickness: number,
  taper: ((v: number) => number) | undefined,
  /** Thin the near walls (`clamp` with direction `in`); otherwise only locate them. */
  relieve: boolean,
): Relief | undefined {
  const root = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    for (let up = root.get(r) as number; up !== r; up = root.get(r) as number) {
      const top = root.get(up) as number;
      root.set(r, top);
      r = top;
    }
    return r;
  };
  for (const v of p.vertices) root.set(v, v);
  for (const f of p.region) {
    const loop = mesh.faceVertices(f);
    const r0 = find(loop[0] as number);
    for (const v of loop) {
      const r = find(v);
      if (r !== r0) root.set(r, r0);
    }
  }
  const partOf = new Map<number, number>();
  for (const f of p.region) {
    const r = find(mesh.faceVertices(f)[0] as number);
    partOf.set(r, Math.min(partOf.get(r) ?? f, f));
  }
  if (partOf.size < 2) return undefined;
  const clearance = thickness * RELIEF_FLOOR;
  const index = new Map(p.vertices.map((v, i) => [v, i]));
  const n = p.vertices.length;
  const base = new Float64Array(n * 3);
  /** Unit displacement of corner 2 i + side (see `corner`). */
  const unit = new Float64Array(n * 6);
  let reach = 0;
  for (const [i, v] of p.vertices.entries()) {
    base.set(mesh.position(v), i * 3);
    for (const side of [0, 1]) {
      const d = sideUnit(p, side, v);
      unit.set(d, (2 * i + side) * 3);
      reach = Math.max(reach, length(d));
    }
  }
  const taperOf = (v: number) => (taper === undefined ? 1 : taper(v));
  /** Corner point 2 i + side of vertex i: side 0 on the outer wall, 1 on the inner. */
  const corner = (v: number, side: 0 | 1) => 2 * (index.get(v) as number) + side;
  const moving = factors.map((k) => k !== 0);
  const triangles: Wall[] = [];
  const earsOf = new Map<number, number[]>();
  for (const f of p.region) {
    const loop = mesh.faceVertices(f);
    const part = partOf.get(find(loop[0] as number)) as number;
    const ears = triangulateLoop(loop.map((v) => mesh.position(v))) ?? [];
    const first = triangles.length;
    for (const side of [0, 1] as const) {
      for (let i = 0; i < ears.length; i += 3) {
        const corners = [0, 1, 2].map((k) => corner(loop[ears[i + k] as number] as number, side));
        triangles.push({ corners, part, wall: side === 1, source: first + i / 3 });
      }
    }
    earsOf.set(
      f,
      Array.from({ length: ears.length / 3 }, (_, i) => first + i),
    );
  }
  if (taper === undefined) {
    for (const h of p.rims) {
      const a = mesh.hVert[h] as number;
      const b = mesh.hVert[mesh.hNext[h] as number] as number;
      const part = partOf.get(find(a)) as number;
      const ears = earsOf.get(mesh.hFace[h] as number) ?? [];
      const edge = [corner(a, 0), corner(b, 0)];
      const source = ears.find((t) => edge.every((c) => triangles[t]?.corners.includes(c)));
      if (source === undefined) continue;
      const [b0, a0, a1, b1] = [corner(b, 0), corner(a, 0), corner(a, 1), corner(b, 1)];
      triangles.push({ corners: [b0, a0, a1], part, wall: true, source });
      triangles.push({ corners: [b0, a1, b1], part, wall: true, source });
    }
  }
  const relief = new Map<number, number>();
  const at = (c: number, override?: ReadonlyMap<number, number>): Tuple3 => {
    const i = c >> 1;
    const side = c & 1;
    const v = p.vertices[i] as number;
    const k = (factors[side] as number) * thickness;
    const s = Math.min(taperOf(v), override?.get(v) ?? relief.get(v) ?? 1);
    const t = k * s;
    return [
      (base[i * 3] as number) + (unit[c * 3] as number) * t,
      (base[i * 3 + 1] as number) + (unit[c * 3 + 1] as number) * t,
      (base[i * 3 + 2] as number) + (unit[c * 3 + 2] as number) * t,
    ];
  };
  const flat = (c: number): Tuple3 => [
    base[(c >> 1) * 3] as number,
    base[(c >> 1) * 3 + 1] as number,
    base[(c >> 1) * 3 + 2] as number,
  ];
  const shape = (t: number, point: (c: number) => Tuple3) =>
    (triangles[t] as Wall).corners.map(point);
  const points = new Float64Array(n * 6);
  for (let c = 0; c < 2 * n; c++) points.set(at(c), c * 3);
  const grid = new PrimitiveGrid(points, Int32Array.from(triangles.flatMap((t) => t.corners)));
  const radius = triangles.map((t) => {
    const ps = t.corners.map((c) => at(c));
    const mid = scale(add(add(ps[0] as Tuple3, ps[1] as Tuple3), ps[2] as Tuple3), 1 / 3);
    let r = 0;
    for (const q of ps) r = Math.max(r, length(sub(q, mid)));
    return { mid, r };
  });
  // Relief only shortens the offsets, so a pair this far apart now stays clear.
  const slack = 2 * reach * thickness * maxOf(factors.map(Math.abs));
  /** Two wall triangles of different parts and the distance they keep (at share 1). */
  const pairs: Pair[] = [];
  let near = false;
  for (const [i, t] of triangles.entries()) {
    if (!t.wall) continue;
    const { mid, r } = radius[i] as { mid: Tuple3; r: number };
    for (const j of grid.near(mid, r + clearance + slack)) {
      const u = triangles[j] as Wall;
      if (u.part === t.part || (u.wall && j < i)) continue;
      const now = triangleDistance(
        shape(i, (c) => at(c)),
        shape(j, (c) => at(c)),
      );
      if (now >= clearance + slack) continue;
      const [si, sj] = [(triangles[i] as Wall).source, u.source];
      const outer = triangleDistance(shape(si, flat), shape(sj, flat));
      // Outer surfaces in contact are one joint by design, not two walls.
      if (outer <= CONTACT * thickness) continue;
      // A shut tighter than the clearance (the author's design) keeps its walls half of it apart.
      const keep = outer < clearance ? outer / 2 : clearance;
      pairs.push([i, j, keep]);
      if (now < keep) near = true;
    }
  }
  if (!near) return undefined;
  const movable = (t: number) =>
    (triangles[t] as Wall).corners.flatMap((c) => {
      const v = p.vertices[c >> 1] as number;
      return moving[c & 1] === true && taperOf(v) > 0 ? [v] : [];
    });
  const touching = new Map<number, Pair[]>();
  for (const pair of pairs) {
    for (const v of new Set([...movable(pair[0]), ...movable(pair[1])])) {
      const list = touching.get(v);
      if (list === undefined) touching.set(v, [pair]);
      else list.push(pair);
    }
  }
  const gapOf = (pair: Pair, override?: ReadonlyMap<number, number>) => {
    const point = (c: number) => at(c, override);
    return triangleDistance(shape(pair[0], point), shape(pair[1], point));
  };
  /** Whether every pair keeps its distance, the shell `scale` times as thick. */
  const clear = (list: Iterable<Pair>, override?: ReadonlyMap<number, number>, scale = 1) => {
    for (const pair of list)
      if (gapOf(pair, override) < Math.min(pair[2], clearance * scale)) return false;
    return true;
  };
  /** The first pair whose walls touch or cross, located on the walls. */
  const crossing = (): Relief['crossing'] => {
    for (const pair of pairs) {
      if (gapOf(pair) > 0) continue;
      const [a, b] = [pair[0], pair[1]].map((t) => shape(t, (c) => at(c))) as [Tuple3[], Tuple3[]];
      let point = a[0] as Tuple3;
      let best = Infinity;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const)
        for (const q of from) {
          const d = pointTriangleDistance(q, to);
          if (d < best) [best, point] = [d, q];
        }
      const faces = [pair[0], pair[1]].map((t) => (triangles[t] as Wall).part);
      return { point, faces: faces as [number, number] };
    }
    return undefined;
  };
  const partner = new Map<number, number>();
  const distance = new Map<number, number>();
  const flagged = new Set<number>();
  const flag = (list: readonly Pair[]) => {
    let added = 0;
    for (const pair of list) {
      const [i, j, keep] = pair;
      const d = gapOf(pair);
      if (d >= keep) continue;
      for (const [t, other] of [
        [i, j],
        [j, i],
      ] as const) {
        for (const v of movable(t)) {
          if (!partner.has(v)) partner.set(v, (triangles[other] as Wall).part);
          distance.set(v, Math.min(distance.get(v) ?? d, d));
          if (!flagged.has(v)) added++;
          flagged.add(v);
        }
      }
    }
    return added;
  };
  const around = (vertices: Iterable<number>) => {
    const set = new Set<Pair>();
    for (const v of vertices) for (const pair of touching.get(v) ?? []) set.add(pair);
    return set;
  };
  /** Shares with every flagged vertex at most `s`. */
  const lowered = (s: number) => {
    const map = new Map(relief);
    for (const v of flagged) map.set(v, Math.min(map.get(v) ?? 1, s));
    return map;
  };
  /**
   * The largest share of the thickness at which the walls, the near ones relieved to the
   * floor, keep their distances: what `maxThickness` reports when relief cannot.
   */
  const fitting = () => {
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < RELIEF_STEPS; step++) {
      const mid = (lo + hi) / 2;
      const shares = new Map(p.vertices.map((v) => [v, mid]));
      for (const v of flagged) shares.set(v, mid * RELIEF_FLOOR);
      if (clear(pairs, shares, mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  flag(pairs);
  if (!relieve) {
    const crossed = crossing();
    return {
      share: new Map(),
      partner,
      distance,
      least: 1,
      clearance,
      ...(crossed === undefined ? {} : { crossing: crossed }),
    };
  }
  for (let round = 0; ; round++) {
    if (flagged.size === 0 || round === RELIEF_ROUNDS) {
      return { share: lowered(0), partner, distance, least: 0, clearance, fits: fitting() };
    }
    // Share 0 puts the walls on the skin, which keeps every pair's distance.
    const local = around(flagged);
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < RELIEF_STEPS; step++) {
      const mid = (lo + hi) / 2;
      if (clear(local, lowered(mid))) lo = mid;
      else hi = mid;
    }
    for (const [v, s] of lowered(lo)) relief.set(v, s);
    if (flag(pairs) === 0) break;
  }
  // Raise each vertex as far as the clearance allows, the others held.
  for (const v of [...relief.keys()].sort((a, b) => a - b)) {
    const local = touching.get(v) ?? [];
    let lo = relief.get(v) as number;
    if (clear(local, new Map([[v, 1]]))) {
      relief.delete(v);
      continue;
    }
    let hi = 1;
    for (let step = 0; step < RELIEF_STEPS; step++) {
      const mid = (lo + hi) / 2;
      if (clear(local, new Map([[v, mid]]))) lo = mid;
      else hi = mid;
    }
    relief.set(v, lo);
  }
  let least = 1;
  for (const s of relief.values()) least = Math.min(least, s);
  const crossed = crossing();
  return {
    share: new Map(relief),
    partner,
    distance,
    least,
    clearance,
    ...(least < RELIEF_FLOOR ? { fits: fitting() } : {}),
    ...(crossed === undefined ? {} : { crossing: crossed }),
  };
}

/**
 * Offsets for a shell whose faces collapse (a fillet band tighter than the thickness): the
 * collapsing faces, grown while faces next to them still collapse, take the miter of the
 * planes that bound them, blended with their own offset by the band's radius. When faces still
 * collapse after `MITER_ROUNDS` (the radius, measured to the bounding faces' vertices, overshoots
 * across long sliver faces), the band takes the pure miter instead, growing until nothing collapses
 * or folds. Undefined when neither converges.
 */
function miterCollapse(
  mesh: EditMesh,
  p: Plan,
  factors: readonly [number, number],
  thickness: number,
  tolerance: number,
  share: (v: number) => number,
): Plan | undefined {
  const band = new Set(collapsedFaces(mesh, p, factors, thickness, tolerance, share));
  // Of a 'both' shell, only the side that collapses takes the miter; the other keeps its offset.
  const [outer, inner] = [0, 1].map(
    (side) =>
      collapsedFaces(
        mesh,
        p,
        factors.map((k, s) => (s === side ? k : 0)) as [number, number],
        thickness,
        tolerance,
        share,
      ).length > 0,
  );
  const oneSided = factors.every((k) => k !== 0) && outer !== inner;
  for (const pure of [false, true]) {
    // The band only grows, so the pure rounds end within the region.
    for (let round = 0; pure || round < MITER_ROUNDS; round++) {
      const q = bandPlan(mesh, p, band, thickness, share, pure);
      const left = collapsedFaces(mesh, q, factors, thickness, tolerance, share, pure);
      if (left.length === 0) {
        if (!oneSided) return q;
        const split: Plan = { ...q, sides: outer ? [q.unit, p.unit] : [p.unit, q.unit] };
        const folds = collapsedFaces(mesh, split, factors, thickness, tolerance, share, pure);
        return folds.length === 0 ? split : q;
      }
      const size = band.size;
      for (const f of left) band.add(f);
      if (band.size === size) break;
    }
  }
  return undefined;
}

/**
 * `p` with every vertex of `band` displaced by `lerp(miter(n1, n2), own, w)`: among the
 * bounding faces within reach (outside the band, sharing a vertex with it), n2 turns most
 * from the nearest one and n1 most from n2; r is the distance across the band through the
 * vertex over their angle, and w = clamp(r / t - 1, 0, 1), or 0 when `pure`. Moving a band by the
 * miter translates it, so it cannot invert, and keeps the bounding planes' vertices on their offset
 * planes.
 */
function bandPlan(
  mesh: EditMesh,
  p: Plan,
  band: ReadonlySet<number>,
  thickness: number,
  share: (v: number) => number,
  pure: boolean,
): Plan {
  const region = new Set(p.region);
  const vertexFaces = new Map<number, number[]>();
  for (const f of p.region) {
    for (const v of mesh.faceVertices(f)) {
      const list = vertexFaces.get(v);
      if (list === undefined) vertexFaces.set(v, [f]);
      else list.push(f);
    }
  }
  // Connected parts of the band (through shared vertices), each with its bounding faces and
  // the band vertices those faces touch.
  const partOf = new Map<number, number>();
  const parts: { vertices: number[]; bounding: Map<number, number[]> }[] = [];
  for (const start of [...band].sort((a, b) => a - b)) {
    if (partOf.has(start)) continue;
    const index = parts.length;
    const part = { vertices: [] as number[], bounding: new Map<number, number[]>() };
    parts.push(part);
    const seen = new Set<number>();
    const queue = [start];
    partOf.set(start, index);
    while (queue.length > 0) {
      const f = queue.pop() as number;
      for (const v of mesh.faceVertices(f)) {
        if (seen.has(v)) continue;
        seen.add(v);
        part.vertices.push(v);
        for (const g of vertexFaces.get(v) ?? []) {
          if (!region.has(g)) continue;
          if (band.has(g)) {
            if (!partOf.has(g)) {
              partOf.set(g, index);
              queue.push(g);
            }
            continue;
          }
          const touched = part.bounding.get(g);
          if (touched === undefined) part.bounding.set(g, [v]);
          else touched.push(v);
        }
      }
    }
    part.vertices.sort((a, b) => a - b);
  }
  const unit = new Map(p.unit);
  const reach = MITER_LIMIT * thickness;
  for (const { vertices, bounding } of parts) {
    const faces = [...bounding.keys()].sort((a, b) => a - b);
    for (const v of vertices) {
      const t = thickness * share(v);
      if (t === 0) continue;
      const here = mesh.position(v);
      const near = faces.map((f) => {
        let d = Infinity;
        for (const b of bounding.get(f) as number[])
          d = Math.min(d, length(sub(mesh.position(b), here)));
        return { f, d };
      });
      let nearest: { f: number; d: number } | undefined;
      for (const c of near) if (nearest === undefined || c.d < nearest.d) nearest = c;
      if (nearest === undefined) continue;
      const farthestTurn = (from: { f: number; d: number }) => {
        const n0 = p.normals.get(from.f) as Tuple3;
        let best = { ...from, angle: 0 };
        for (const c of near) {
          if (c.d > reach) continue;
          const n = p.normals.get(c.f) as Tuple3;
          const angle = atan2(length(cross(n0, n)), dot(n0, n));
          if (angle > best.angle) best = { ...c, angle };
        }
        return best;
      };
      // The nearest face can be a band face past the band's end, between the two planes the
      // band joins; turning twice reaches both of them.
      const second = farthestTurn(nearest);
      const first = farthestTurn(second);
      if (!(first.angle > ANGLE_EPSILON)) continue;
      const n1 = p.normals.get(first.f) as Tuple3;
      const n2 = p.normals.get(second.f) as Tuple3;
      const miter = planeOffset([n1, n2], 1);
      const size = length(miter);
      if (!(size > 0) || !Number.isFinite(size)) continue;
      const radius = (first.d + second.d) / first.angle;
      const w = pure ? 0 : Math.min(1, Math.max(0, radius / t - 1));
      const own = p.unit.get(v) as Tuple3;
      unit.set(v, add(scale(miter, 1 - w), scale(own, w)));
    }
  }
  const clamped = new Set(p.mitered);
  const mitered: number[] = [];
  for (const v of p.vertices) {
    const d = unit.get(v) as Tuple3;
    const size = length(d);
    if (size > MITER_LIMIT) {
      unit.set(v, scale(d, MITER_LIMIT / size));
      mitered.push(v);
    } else if (clamped.has(v) && d === p.unit.get(v)) {
      mitered.push(v);
    }
  }
  return { ...p, unit, mitered, band: [...band].sort((a, b) => a - b) };
}

/**
 * Region faces whose offset copy collapses or inverts at thickness `t`; `folded` also counts a
 * copy twisted so far that one of its ear-clipped triangles turns against it (export fails on it).
 */
function collapsedFaces(
  mesh: EditMesh,
  p: Plan,
  factors: readonly [number, number],
  t: number,
  tolerance: number,
  share: (v: number) => number,
  folded = false,
): number[] {
  return p.region.filter((f) => {
    const loop = mesh.faceVertices(f);
    const normal = p.normals.get(f) as Tuple3;
    return factors.some((k, side) => {
      if (k === 0) return false;
      const points = loop.map((v) =>
        add(mesh.position(v), scale(sideUnit(p, side, v), k * t * share(v))),
      );
      const area = newell(points);
      if (dot(area, normal) <= tolerance * tolerance) return true;
      const triangles = triangulateLoop(points);
      if (triangles === undefined) return true;
      if (!folded) return false;
      for (let i = 0; i < triangles.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => points[triangles[i + k] as number] as Tuple3) as [
          Tuple3,
          Tuple3,
          Tuple3,
        ];
        if (dot(cross(sub(b, a), sub(c, a)), area) <= 0) return true;
      }
      return false;
    });
  });
}

function build(
  mesh: EditMesh,
  /** The mesh before the shell: crossings it already had are not the shell's. */
  before: EditMesh,
  p: Plan,
  open: readonly number[],
  factors: readonly [number, number],
  thickness: number,
  label: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
  created?: { readonly inner: number[]; readonly rims: number[] },
  folds: readonly Fold[] = [],
  /** Tapered shells: each vertex's share of the thickness (boundary vertices 0). */
  taper?: (v: number) => number,
  /** Walls relieved near another part (`partRelief`), within any taper. */
  relief?: Relief,
): Result<RoleCounts, ModelingError> {
  const tapered = taper ?? (() => 1);
  const share =
    relief === undefined || relief.share.size === 0
      ? tapered
      : (v: number) => Math.min(tapered(v), relief.share.get(v) ?? 1);
  const [outerFactor, innerFactor] = factors;
  const rimEdges = p.rims.map((h) => ({
    a: mesh.hVert[h] as number,
    b: mesh.hVert[mesh.hNext[h] as number] as number,
    face: mesh.hFace[h] as number,
  }));
  const foldOf = new Map<string, number>();
  const twice: number[] = [];
  for (const e of rimEdges) {
    const key = `${e.a}:${e.b}`;
    for (const [i, fold] of folds.entries()) {
      if (fold.at !== undefined && !fold.at.has(e.face)) continue;
      if (foldOf.has(key)) twice.push(e.a);
      else foldOf.set(key, i);
    }
  }
  if (twice.length > 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        "every open edge gets at most one flange (the flanges' at faces share no open edge)",
        { count: twice.length, point: mesh.position(twice[0] as number) },
        "narrow the flanges' at selectors so each open edge (detail.point) belongs to one",
      ),
    );
  }
  const idle = folds.findIndex((_, i) => ![...foldOf.values()].includes(i));
  if (idle >= 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        "every flange has an open boundary edge (its at faces include a panel's edge faces)",
        { flange: idle, openEdges: rimEdges.length },
        "select faces along the open edges with the flange's at (a trim or panel edge), or remove that flange",
      ),
    );
  }
  const flanged = new Set(foldOf.keys());
  const unfoldable = folds.length === 0 ? [] : unfoldableCorners(mesh, rimEdges, flanged);
  if (unfoldable.length > 0) {
    return err(
      modelingError(
        'model-precondition',
        'every flange end meets a plain rim at a convex or straight corner, and every flange corner turns its faces by at most 90 degrees',
        {
          vertices: unfoldable.slice(0, 32),
          count: unfoldable.length,
          point: mesh.position(unfoldable[0] as number),
        },
        'at detail.point: flange both edges of a concave corner or end the flange one face before it (flange.at); keep the flange off a corner on a crease past 90 degrees',
      ),
    );
  }
  // The bevel engine cannot end a round in a fold's cap: rounded folds end at other flanges.
  const rimFrom = new Map(rimEdges.map((e) => [e.a, e]));
  const rimTo = new Map(rimEdges.map((e) => [e.b, e]));
  const plainEnds = rimEdges.flatMap(({ a, b }) => {
    const i = foldOf.get(`${a}:${b}`);
    const fold = i === undefined ? undefined : folds[i];
    if (fold === undefined || (fold.radius === 0 && fold.round === 0)) return [];
    const before = rimTo.get(a);
    const after = rimFrom.get(b);
    return [
      ...(before !== undefined && !flanged.has(`${before.a}:${before.b}`) ? [a] : []),
      ...(after !== undefined && !flanged.has(`${after.a}:${after.b}`) ? [b] : []),
    ];
  });
  if (plainEnds.length > 0) {
    return err(
      modelingError(
        'model-precondition',
        'a rounded fold (radius or round) ends at another flange, not at a plain rim',
        { count: plainEnds.length, point: mesh.position(plainEnds[0] as number) },
        'flange the neighbouring open edges too (a square flange in the flange array), or round the whole open edge',
      ),
    );
  }
  const inset = foldInset(mesh, rimEdges, flanged, thickness);
  const narrow = narrowestFold(mesh, p.region, inset, tolerance);
  if (narrow !== undefined) {
    return err(
      modelingError(
        'model-precondition',
        'the faces along a folded edge are wider than the thickness, so the fold keeps it',
        { thickness, width: narrow.width, point: narrow.point, count: narrow.count },
        'remove the support loop or narrow ring along that edge (detail.point), thin the shell, or keep the flange off it with flange.at',
      ),
    );
  }
  const bands = folds.map((fold, i) =>
    flangeBand(
      mesh,
      p,
      rimEdges,
      new Set([...foldOf].flatMap(([key, j]) => (j === i ? [key] : []))),
      fold.reach,
      tolerance,
    ),
  );
  for (const [i, own] of bands.entries()) {
    const panel = connectedFaces(mesh, p.region, own);
    if (panel.length > own.length) continue;
    const distance = foldDistance(
      mesh,
      rimEdges.filter((e) => foldOf.get(`${e.a}:${e.b}`) === i),
    );
    let panelReach = 0;
    for (const f of panel) {
      panelReach = Math.max(panelReach, distance(faceCentroid(mesh, f)));
      for (const v of mesh.faceVertices(f))
        panelReach = Math.max(panelReach, distance(mesh.position(v)));
    }
    // Whole faces within reach join the band, so a coarse panel can fall inside it whole.
    if ((folds[i] as Fold).reach < panelReach) continue;
    return err(
      modelingError(
        'model-precondition',
        'a flange reaches less far than the panel extends from its edges (part of the panel stays outside the flange)',
        { flange: i, reach: (folds[i] as Fold).reach, panelReach },
        'reduce flange.reach below detail.panelReach: a flange as wide as the panel is a second skin, not a return',
      ),
    );
  }
  const band = [...new Set(bands.flat())].sort((x, y) => x - y);
  // Each band vertex's flange depth: flanges whose bands meet share one.
  const depthOf = new Map<number, number>();
  for (const [i, faces] of bands.entries()) {
    const depth = (folds[i] as Fold).depth;
    for (const v of faces.flatMap((f) => mesh.faceVertices(f))) {
      const known = depthOf.get(v);
      if (known !== undefined && known !== depth) {
        return err(
          modelingError(
            'model-invalid-argument',
            'flanges whose bands meet have the same depth',
            { depths: [known, depth], point: mesh.position(v) },
            'give the flanges meeting at detail.point one depth, or shorten their reach',
          ),
        );
      }
      depthOf.set(v, depth);
    }
  }
  for (const [i, flange] of folds.entries()) {
    const own = bands[i] as number[];
    if (own.length === 0) continue;
    // The flange bottom sits this far below the original surface; the band's offset must
    // not fold (tight blends) or reach other walls, as for the shell itself.
    const bottom = flange.depth + thickness - outerFactor * thickness;
    const vertices = [...new Set(own.flatMap((f) => mesh.faceVertices(f)))].sort((x, y) => x - y);
    const limit = feasibleThickness(
      mesh,
      { ...p, region: own, vertices, mitered: [], rims: [] },
      [0, -1],
      bottom,
      tolerance,
      open,
    );
    if (limit.thickness < bottom) {
      const maxDepth = Math.max(0, limit.thickness - thickness + outerFactor * thickness);
      return err(
        modelingError(
          'model-precondition',
          `the flange fits under the panel (depth at most ${maxDepth})`,
          {
            depth: flange.depth,
            maxDepth,
            limitedBy: limit.by,
            ...(limit.by === 'clearance'
              ? { vertices: limit.elements }
              : { faces: limit.elements }),
            ...(limit.point === undefined ? {} : { point: limit.point }),
          },
          maxDepth > thickness
            ? 'reduce flange.depth to at most detail.maxDepth, or keep the flange off tight blends with flange.at'
            : 'a tight blend or a nearby wall leaves no room: keep the flange off it with flange.at (for example the trim faces)',
        ),
      );
    }
  }
  const keep = new Set(p.vertices);
  const orphans = new Set<number>();
  for (const f of open) for (const v of mesh.faceVertices(f)) if (!keep.has(v)) orphans.add(v);
  for (const f of open) mesh.removeFace(f);
  for (const v of [...orphans].sort((a, b) => a - b)) mesh.removeVertex(v);
  const innerOf = new Map<number, number>();
  for (const v of p.vertices) {
    const base = mesh.position(v);
    const t = thickness * share(v);
    // A tapered boundary vertex is both walls' vertex.
    if (t === 0) {
      innerOf.set(v, v);
      continue;
    }
    const at = add(base, scale(sideUnit(p, 1, v), innerFactor * t));
    innerOf.set(v, mesh.addVertex(...add(at, inset.get(v) ?? [0, 0, 0])));
    if (outerFactor !== 0)
      mesh.setPosition(v, ...add(base, scale(sideUnit(p, 0, v), outerFactor * t)));
  }
  const inner: number[] = [];
  for (const f of p.region) {
    const halves = mesh.faceHalves(f);
    const n = halves.length;
    const loop = halves.map((_, j) => mesh.hVert[halves[(n - j) % n] as number] as number);
    const added = mesh.addFace(loop.map((v) => innerOf.get(v) as number));
    if (!added.ok) return added;
    const g = added.value;
    mesh.copyFaceAttributesTo(f, mesh, g);
    const copies = mesh.faceHalves(g);
    for (const name of mesh.channels.keys()) {
      for (let j = 0; j < n; j++) {
        const value = mesh.corner(name, halves[(n - j) % n] as number);
        if (value !== undefined) mesh.setCorner(name, copies[j] as number, value.slice());
      }
    }
    for (let j = 0; j < n; j++) {
      const a = loop[j] as number;
      const b = loop[(j + 1) % n] as number;
      const flags = mesh.eFlags[mesh.findHalf(b, a) >> 1] as number;
      if (flags !== 0) {
        mesh.eFlags[mesh.findHalf(innerOf.get(a) as number, innerOf.get(b) as number) >> 1] = flags;
      }
    }
    inner.push(g);
  }
  // A fold mitered across a crease moves its corner off one of the faces' planes.
  const untwisted = untwist(
    mesh,
    inner,
    new Set([...inset.keys()].map((v) => innerOf.get(v) as number)),
    tolerance,
  );
  if (!untwisted.ok) return untwisted;
  replaceAll(inner, untwisted.value);
  let split = 0;
  /** A quad wall (split along its shorter diagonal when it twists) with `face`'s attributes. */
  const wall = (
    quad: readonly number[],
    face: number,
    into: number[],
  ): Result<void, ModelingError> => {
    const [q0, q1, q2, q3] = quad as [number, number, number, number];
    const points = quad.map((v) => mesh.position(v));
    const normal = normalize(newell(points));
    const origin = points[0] as Tuple3;
    const deviation = maxOf(points.map((q) => Math.abs(dot(sub(q, origin), normal))));
    const loops =
      deviation <= tolerance * 10
        ? [quad]
        : length(sub(points[2] as Tuple3, points[0] as Tuple3)) <=
            length(sub(points[3] as Tuple3, points[1] as Tuple3))
          ? [
              [q0, q1, q2],
              [q0, q2, q3],
            ]
          : [
              [q0, q1, q3],
              [q1, q2, q3],
            ];
    if (loops.length > 1) split++;
    for (const loop of loops) {
      const added = mesh.addFace(loop);
      if (!added.ok) return added;
      mesh.copyFaceAttributesTo(face, mesh, added.value);
      mesh.fLabel[added.value] = 0;
      mesh.fRole[added.value] = 0;
      into.push(added.value);
    }
    return ok(undefined);
  };
  const sharpen = (x: number, y: number) => {
    const e = mesh.findHalf(x, y) >> 1;
    mesh.eFlags[e] = mergeFlags(mesh.eFlags[e] as number, EDGE_SHARP);
  };
  // The flange: the band's faces copied down along the vertex offsets, top `depth` below
  // the skin facing the panel, bottom one thickness lower facing away.
  const flangeFaces: number[] = [];
  const topOf = new Map<number, number>();
  const bottomOf = new Map<number, number>();
  if (folds.length > 0) {
    const bandVertices = [...new Set(band.flatMap((f) => mesh.faceVertices(f)))].sort(
      (x, y) => x - y,
    );
    for (const v of bandVertices) {
      const d = sideUnit(p, 1, v);
      const skin = mesh.position(v);
      const depth = depthOf.get(v) as number;
      const top = sub(skin, scale(d, depth));
      topOf.set(v, mesh.addVertex(...add(top, inset.get(v) ?? [0, 0, 0])));
      bottomOf.set(v, mesh.addVertex(...sub(skin, scale(d, depth + thickness))));
    }
    const inBand = new Set(band);
    for (const f of band) {
      const halves = mesh.faceHalves(f);
      const n = halves.length;
      const loop = halves.map((h) => mesh.hVert[h] as number);
      for (const [copies, reversed] of [
        [topOf, false],
        [bottomOf, true],
      ] as const) {
        const order = loop.map((_, j) => (reversed ? (n - j) % n : j));
        const added = mesh.addFace(order.map((j) => copies.get(loop[j] as number) as number));
        if (!added.ok) return added;
        const g = added.value;
        mesh.copyFaceAttributesTo(f, mesh, g);
        const made = mesh.faceHalves(g);
        for (const name of mesh.channels.keys()) {
          for (let j = 0; j < n; j++) {
            const value = mesh.corner(name, halves[order[j] as number] as number);
            if (value !== undefined) mesh.setCorner(name, made[j] as number, value.slice());
          }
        }
        flangeFaces.push(g);
      }
      // End walls close the band's free edges (not the folded edges).
      for (const h of halves) {
        const twin = mesh.hFace[h ^ 1] as number;
        const a = mesh.hVert[h] as number;
        const b = mesh.hVert[mesh.hNext[h] as number] as number;
        if ((twin !== NONE && inBand.has(twin)) || flanged.has(`${a}:${b}`)) continue;
        const aT = topOf.get(a) as number;
        const bT = topOf.get(b) as number;
        const aB = bottomOf.get(a) as number;
        const bB = bottomOf.get(b) as number;
        const done = wall([bT, aT, aB, bB], f, flangeFaces);
        if (!done.ok) return done;
        sharpen(bT, aT);
        sharpen(aB, bB);
      }
    }
  }
  const rims: number[] = [];
  const caps: { readonly skin: number; readonly inner: number }[] = [];
  for (const { a, b, face } of rimEdges) {
    const a2 = innerOf.get(a) as number;
    const b2 = innerOf.get(b) as number;
    if (taper !== undefined) {
      // The walls meet at the boundary: a crease, no rim.
      sharpen(b, a);
      continue;
    }
    if (!flanged.has(`${a}:${b}`)) {
      // A rim whose ends move along different normals twists; it splits like sweep sides.
      const done = wall([b, a, a2, b2], face, rims);
      if (!done.ok) return done;
      sharpen(b, a);
      sharpen(a2, b2);
      continue;
    }
    // A folded edge: the outer wall runs down to the flange bottom, the inner wall (inset by
    // the thickness) from the panel's inner surface to the flange top.
    const aT = topOf.get(a) as number;
    const bT = topOf.get(b) as number;
    const aB = bottomOf.get(a) as number;
    const bB = bottomOf.get(b) as number;
    // Where a plain rim goes on, a cap closes the fold's end: skin, inner surface, flange
    // top and bottom of that end's column.
    const startsHere = (() => {
      const before = rimTo.get(a);
      return before !== undefined && !flanged.has(`${before.a}:${before.b}`);
    })();
    const endsHere = (() => {
      const after = rimFrom.get(b);
      return after !== undefined && !flanged.has(`${after.a}:${after.b}`);
    })();
    const made = wall([b, a, aB, bB], face, flangeFaces);
    if (!made.ok) return made;
    for (const cap of [startsHere ? [a, a2, aT, aB] : [], endsHere ? [bB, bT, b2, b] : []]) {
      if (cap.length === 0) continue;
      const closed = wall(cap, face, flangeFaces);
      if (!closed.ok) return closed;
      caps.push({
        skin: startsHere && cap[0] === a ? a : b,
        inner: startsHere && cap[0] === a ? a2 : b2,
      });
    }
    const inner = wall([a2, b2, bT, aT], face, flangeFaces);
    if (!inner.ok) return inner;
    sharpen(b, a);
    sharpen(a2, b2);
    sharpen(aB, bB);
    sharpen(bT, aT);
  }
  // A cap must turn away from the plain rim it meets: a rim running back over the cap
  // (a fold ending where the panel's edge bends back toward the flange) would overlap it.
  const overlapping = caps.filter(({ skin, inner }) => {
    const h = mesh.findHalf(skin, inner);
    const sides = [mesh.hFace[h] as number, mesh.hFace[h ^ 1] as number];
    if (sides.some((f) => f === NONE)) return false;
    const [n1, n2] = sides.map((f) => faceNormal(mesh, f)) as [Tuple3, Tuple3];
    return dot(n1, n2) < -0.5;
  });
  if (overlapping.length > 0) {
    const ends = overlapping.map((c) => c.skin);
    return err(
      modelingError(
        'model-precondition',
        'every flange end turns away from the plain rim it meets',
        {
          vertices: ends.slice(0, 32),
          count: ends.length,
          point: mesh.position(ends[0] as number),
        },
        'end the flange where the open edge runs straight or turns away (flange.at), or flange the neighbouring edge too',
      ),
    );
  }
  if (split > 0) {
    diagnostics.push({
      severity: 'info',
      message: `${split} non-planar rim quad(s) were split into triangles along their shorter diagonal`,
      detail: { quads: split },
    });
  }
  const counts: RoleCounts = {};
  markRole(mesh, inner, label, SHELL_WALL_ROLES[0], counts);
  markRole(mesh, rims, label, SHELL_WALL_ROLES[1], counts);
  if (flangeFaces.length > 0) {
    const untwisted = untwist(
      mesh,
      flangeFaces,
      new Set([...inset.keys()].map((v) => topOf.get(v) as number)),
      tolerance,
    );
    if (!untwisted.ok) return untwisted;
    markRole(mesh, untwisted.value, label, SHELL_WALL_ROLES[2], counts);
    replaceAll(flangeFaces, untwisted.value);
  }
  if (created !== undefined) {
    pushAll(created.inner, inner);
    pushAll(created.rims, rims);
  }
  // Tapered walls are thinner by design near the boundary, and mitered bands thicker; the
  // rest keeps the thickness.
  const banded = new Set(p.band);
  const full = p.region.flatMap((f, i) =>
    !banded.has(f) && mesh.faceVertices(f).every((v) => share(v) === 1) ? [i] : [],
  );
  assertThickness(
    mesh,
    full.map((i) => p.region[i] as number),
    full.map((i) => inner[i] as number),
    thickness,
    tolerance,
    diagnostics,
    relief === undefined
      ? undefined
      : {
          clearance: relief.clearance,
          relieved: relief.share.size > 0,
          walls: [...(relief.share.size > 0 ? relief.share.keys() : relief.distance.keys())]
            .map((v) => ({
              vertex: innerOf.get(v) as number,
              thickness: thickness * share(v),
              distance: relief.distance.get(v) as number,
              partner: relief.partner.get(v) as number,
            }))
            .sort(
              (a, b) => a.thickness - b.thickness || a.distance - b.distance || a.vertex - b.vertex,
            ),
        },
  );
  const written = new Set([...p.region, ...inner, ...rims, ...flangeFaces]);
  const crossings = faceContacts(mesh, Number.MAX_SAFE_INTEGER, tolerance, written).contacts.filter(
    (c) => c.contact === 'cross',
  );
  if (crossings.length > 0) {
    // Parts that already crossed before the shell (an assembly of overlapping layers) may
    // cross anywhere afterwards; only crossings between parts that did not are the shell's.
    const parts = components(before);
    const skinOf = new Map<number, number>();
    for (const copies of [innerOf, topOf, bottomOf])
      for (const [v, copy] of copies) skinOf.set(copy, v);
    const partOfSkin = new Map<number, number>();
    for (const f of p.region)
      for (const v of before.faceVertices(f)) partOfSkin.set(v, parts.of.get(f) as number);
    const partOf = (f: number): number =>
      written.has(f)
        ? (partOfSkin.get(skinOf.get(mesh.faceVertices(f)[0] as number) ?? -1) ??
          partOfSkin.get(mesh.faceVertices(f)[0] as number) ??
          -1)
        : (parts.of.get(f) ?? -1);
    const crossed = new Set(
      faceContacts(before, Number.MAX_SAFE_INTEGER, tolerance, new Set(p.region))
        .contacts.filter((c) => c.contact === 'cross')
        .map(({ faces: [x, y] }) => pairKey(parts.of.get(x) as number, parts.of.get(y) as number)),
    );
    const fresh = crossings.filter(
      ({ faces: [x, y] }) => !crossed.has(pairKey(partOf(x), partOf(y))),
    );
    if (fresh.length > 0) {
      return err(
        modelingError(
          'model-degenerate',
          'no shell wall crosses another face',
          {
            pairs: fresh.length,
            at: fresh
              .slice(0, LOCATION_LIMIT)
              .map(({ faces: [a, b] }) =>
                scale(add(faceCentroid(mesh, a), faceCentroid(mesh, b)), 0.5),
              ),
          },
          'the walls run into nearby geometry near detail.at; reduce thickness, shell inward, or move the parts apart',
        ),
      );
    }
    const crossing = crossingDiagnostic(mesh, written, tolerance, 'shell', crossings);
    if (crossing !== undefined) diagnostics.push(crossing);
  }
  const rounded = roundFolds(
    mesh,
    rimEdges.flatMap(({ a, b }) => {
      const i = foldOf.get(`${a}:${b}`);
      if (i === undefined) return [];
      const fold = folds[i] as Fold;
      const radius = fold.radius;
      const pairs = (map: ReadonlyMap<number, number>) =>
        [map.get(a), map.get(b)] as [number, number];
      if (radius > 0) {
        return [
          { pair: [a, b] as [number, number], width: radius + thickness, skin: true },
          { pair: pairs(bottomOf), width: radius + thickness, skin: false },
          { pair: pairs(innerOf), width: radius, skin: false },
          { pair: pairs(topOf), width: radius, skin: false },
        ];
      }
      if (fold.round === 0) return [];
      const skin = { pair: [a, b] as [number, number], width: fold.round, skin: true };
      return fold.round - thickness > tolerance
        ? [skin, { pair: pairs(innerOf), width: fold.round - thickness, skin: false }]
        : [skin];
    }),
    label,
    tolerance,
    diagnostics,
    counts,
  );
  if (!rounded.ok) return rounded;
  return ok(counts);
}

/**
 * Rounded folds and skin rounds through the bevel engine in one call, each edge at its own
 * width: the skin edges keep role `bevel` (part of the skin), the fold's other bends get
 * role `flange`. One call, because a bevel re-partitions the planar walls it touches, and a
 * second pass would round edges of those pieces. A fold's radius is a dimension, so a width
 * the bevel would clamp fails.
 */
function roundFolds(
  mesh: EditMesh,
  bends: readonly {
    readonly pair: readonly [number, number];
    readonly width: number;
    readonly skin: boolean;
  }[],
  label: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
  counts: RoleCounts,
): Result<void, ModelingError> {
  if (bends.length === 0) return ok(undefined);
  const flangeRole = SHELL_WALL_ROLES[2];
  const flangeIndex = label === 0 ? -1 : mesh.nameIndex(mesh.roleNames, flangeRole);
  const flangeFaces = () => {
    let n = 0;
    for (const f of mesh.faces())
      if (mesh.fLabel[f] === label && mesh.fRole[f] === flangeIndex) n++;
    return n;
  };
  const before = label === 0 ? 0 : flangeFaces() - (counts.flange ?? 0);
  const perEdge = new Map(
    bends.map((b) => [
      mesh.findHalf(b.pair[0], b.pair[1]) >> 1,
      b.skin ? { width: b.width } : { width: b.width, role: flangeRole },
    ]),
  );
  const notes: OpDiagnostic[] = [];
  const done = bevel(
    mesh,
    [...perEdge.keys()],
    { width: maxOf(bends.map((b) => b.width)), segments: ROUND_SEGMENTS },
    { label, material: 0, tag: -1 },
    undefined,
    tolerance,
    notes,
    undefined,
    perEdge,
  );
  if (!done.ok) return done;
  const clamped = notes.find((d) => d.severity === 'warn' && d.detail?.clamped !== undefined);
  if (clamped !== undefined) {
    return err(
      modelingError(
        'model-precondition',
        'the rounded fold or skin round keeps its radius (no clamp)',
        { ...clamped.detail },
        'reduce flange.radius or flange.round to below detail.minWidth: the faces along the edge, the flange or the fold wall leave no more room',
      ),
    );
  }
  pushAll(diagnostics, notes);
  for (const [role, n] of Object.entries(done.value)) {
    if (role !== flangeRole) counts[role] = (counts[role] ?? 0) + n;
  }
  // The bevel rewrote some flange faces: labeled ones are counted again (unlabeled roles
  // are not stored).
  counts.flange =
    label === 0 ? (counts.flange ?? 0) + (done.value.flange ?? 0) : flangeFaces() - before;
  return ok(undefined);
}

/** `faces` with the twisted ones that use a `marked` vertex replaced by triangles. */
function untwist(
  mesh: EditMesh,
  faces: readonly number[],
  marked: ReadonlySet<number>,
  tolerance: number,
): Result<number[], ModelingError> {
  const rewrites: FaceRewrite[] = [];
  for (const g of faces) {
    const halves = mesh.faceHalves(g);
    const loop = halves.map((h) => mesh.hVert[h] as number);
    if (loop.length === 3 || !loop.some((v) => marked.has(v))) continue;
    const points = loop.map((v) => mesh.position(v));
    const normal = normalize(newell(points));
    const origin = points[0] as Tuple3;
    if (points.every((q) => Math.abs(dot(sub(q, origin), normal)) <= tolerance * 10)) continue;
    const indices = triangulateLoop(points);
    if (indices === undefined) continue;
    const corners = halves.map((h) => ({ v: mesh.hVert[h] as number, corner: h }));
    rewrites.push({
      face: g,
      loops: Array.from({ length: indices.length / 3 }, (_, t) =>
        [0, 1, 2].map((k) => corners[indices[t * 3 + k] as number] as CornerSource),
      ),
    });
  }
  if (rewrites.length === 0) return ok([...faces]);
  const rewritten = rewriteFaces(mesh, rewrites);
  if (!rewritten.ok) return rewritten;
  const replaced = new Set(rewrites.map((r) => r.face));
  return ok([...faces.filter((g) => !replaced.has(g)), ...rewritten.value.flat()]);
}

/**
 * Where a fold's inner side would pass the far side of a face along it (a ring narrower
 * than the thickness): the inset vertex must stay on its own side of every face edge
 * away from it.
 */
function narrowestFold(
  mesh: EditMesh,
  region: readonly number[],
  inset: ReadonlyMap<number, Tuple3>,
  tolerance: number,
): { readonly width: number; readonly point: Tuple3; readonly count: number } | undefined {
  let worst: { width: number; point: Tuple3 } | undefined;
  let count = 0;
  for (const f of region) {
    const loop = mesh.faceVertices(f);
    const normal = faceNormal(mesh, f);
    for (const v of loop) {
      const w = inset.get(v);
      if (w === undefined) continue;
      const from = mesh.position(v);
      const to = add(from, w);
      for (const [k, q1] of loop.entries()) {
        const q2 = loop[(k + 1) % loop.length] as number;
        if (q1 === v || q2 === v) continue;
        const a = mesh.position(q1);
        const edge = sub(mesh.position(q2), a);
        const side = (x: Tuple3) => dot(cross(edge, sub(x, a)), normal) / length(edge);
        const width = side(from);
        if (Math.sign(side(to)) === Math.sign(width) && Math.abs(side(to)) > tolerance) continue;
        count++;
        if (worst === undefined || Math.abs(width) < worst.width) {
          worst = { width: Math.abs(width), point: from };
        }
      }
    }
  }
  return worst === undefined ? undefined : { ...worst, count };
}

/** The direction across folded rim edge a -> b into its face, in the face's plane. */
function foldInto(mesh: EditMesh, a: number, b: number, face: number): Tuple3 {
  const side = normalize(cross(faceNormal(mesh, face), sub(mesh.position(b), mesh.position(a))));
  return dot(side, sub(faceCentroid(mesh, face), mesh.position(a))) < 0 ? scale(side, -1) : side;
}

/**
 * Fold corners the flange cannot turn: an end meeting a plain rim at a concave corner (the
 * cap would lie on the plain rim), or a corner between two folds whose faces turn by more
 * than 90 degrees (the mitered inner side leaves the panel).
 */
function unfoldableCorners(
  mesh: EditMesh,
  rimEdges: readonly { readonly a: number; readonly b: number; readonly face: number }[],
  flanged: ReadonlySet<string>,
): number[] {
  const rimFrom = new Map(rimEdges.map((e) => [e.a, e]));
  const rimTo = new Map(rimEdges.map((e) => [e.b, e]));
  const ends: number[] = [];
  for (const { a, b, face } of rimEdges) {
    if (!flanged.has(`${a}:${b}`)) continue;
    const into = foldInto(mesh, a, b, face);
    const before = rimTo.get(a);
    const after = rimFrom.get(b);
    if (
      before !== undefined &&
      flanged.has(`${before.a}:${before.b}`) &&
      dot(faceNormal(mesh, before.face), faceNormal(mesh, face)) < 0 &&
      dot(foldInto(mesh, before.a, before.b, before.face), into) < 0.9
    ) {
      ends.push(a);
    }
    for (const [v, plain] of [
      [a, before === undefined || flanged.has(`${before.a}:${before.b}`) ? undefined : before.a],
      [b, after === undefined || flanged.has(`${after.a}:${after.b}`) ? undefined : after.b],
    ] as const) {
      if (plain === undefined) continue;
      const away = normalize(sub(mesh.position(plain), mesh.position(v)));
      if (dot(away, into) < -0.3) ends.push(v);
    }
  }
  return ends.sort((x, y) => x - y);
}

/**
 * How far the inner side of each fold moves in from its outer wall so the fold keeps the
 * thickness: across each folded rim edge in its face's plane (so the inset stays in the
 * faces at a crease), mitered where two meet (limited to four thicknesses on hairpin corners).
 */
function foldInset(
  mesh: EditMesh,
  rimEdges: readonly { readonly a: number; readonly b: number; readonly face: number }[],
  flanged: ReadonlySet<string>,
  thickness: number,
): Map<number, Tuple3> {
  const across = new Map<number, Tuple3[]>();
  for (const { a, b, face } of rimEdges) {
    if (!flanged.has(`${a}:${b}`)) continue;
    const into = foldInto(mesh, a, b, face);
    for (const v of [a, b]) across.set(v, [...(across.get(v) ?? []), into]);
  }
  const inset = new Map<number, Tuple3>();
  for (const [v, dirs] of across) {
    const [n1, n2] = dirs as [Tuple3, Tuple3 | undefined];
    if (n2 === undefined) {
      inset.set(v, scale(n1, thickness));
      continue;
    }
    const sum = add(n1, n2);
    inset.set(v, scale(sum, thickness / Math.max(1 + dot(n1, n2), length(sum) / 4)));
  }
  return inset;
}

/** The distance from a point to the nearest of the folded edges. */
function foldDistance(
  mesh: EditMesh,
  folds: readonly { readonly a: number; readonly b: number }[],
): (q: Tuple3) => number {
  const segments = folds.map((e) => [mesh.position(e.a), mesh.position(e.b)] as const);
  return (q) => {
    let best = Infinity;
    for (const [a, b] of segments) {
      const ab = sub(b, a);
      const t = Math.min(1, Math.max(0, dot(sub(q, a), ab) / Math.max(dot(ab, ab), 1e-30)));
      best = Math.min(best, length(sub(q, add(a, scale(ab, t)))));
    }
    return best;
  };
}

/** The region faces edge-connected to `seeds`. */
function connectedFaces(
  mesh: EditMesh,
  region: readonly number[],
  seeds: readonly number[],
): number[] {
  const inside = new Set(region);
  const seen = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const f = queue.pop() as number;
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g === NONE || !inside.has(g) || seen.has(g)) continue;
      seen.add(g);
      queue.push(g);
    }
  }
  return [...seen];
}

/**
 * The flange band: region faces edge-connected to the folded edges whose vertices all lie
 * within `reach` of them (the faces along the edges always), plus the faces that keep it
 * manifold where it would touch itself at a vertex.
 */
function flangeBand(
  mesh: EditMesh,
  p: Plan,
  rimEdges: readonly { readonly a: number; readonly b: number; readonly face: number }[],
  flanged: ReadonlySet<string>,
  reach: number,
  tolerance: number,
): number[] {
  const folds = rimEdges.filter((e) => flanged.has(`${e.a}:${e.b}`));
  const distance = foldDistance(mesh, folds);
  const region = new Set(p.region);
  const band = new Set(folds.map((e) => e.face));
  const queue = [...band];
  while (queue.length > 0) {
    const f = queue.shift() as number;
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g === NONE || !region.has(g) || band.has(g)) continue;
      if (mesh.faceVertices(g).every((v) => distance(mesh.position(v)) <= reach + tolerance)) {
        band.add(g);
        queue.push(g);
      }
    }
  }
  closePinches(mesh, region, band);
  return [...band].sort((x, y) => x - y);
}

/**
 * Where `band` meets a vertex in several runs of faces (whole faces within reach on a
 * fan of long triangles), its end walls would share that vertex's column twice: the gaps
 * between the runs (all but the largest around a closed fan) join the band, while they
 * hold only `region` faces.
 */
function closePinches(mesh: EditMesh, region: ReadonlySet<number>, band: Set<number>): void {
  const outOf = new Map<number, number>();
  for (const f of mesh.faces())
    for (const h of mesh.faceHalves(f)) outOf.set(mesh.hVert[h] as number, h);
  for (let changed = true; changed; ) {
    changed = false;
    const vertices = new Set([...band].flatMap((f) => mesh.faceVertices(f)));
    for (const v of [...vertices].sort((x, y) => x - y)) {
      const { faces, closed } = vertexFan(mesh, outOf.get(v) as number);
      const first = faces.findIndex((f) => band.has(f));
      if (first < 0) continue;
      const order = closed ? [...faces.slice(first), ...faces.slice(0, first)] : faces;
      const gaps: number[][] = [];
      let current: number[] = [];
      let seen = false;
      for (const f of order) {
        if (!band.has(f)) {
          current.push(f);
          continue;
        }
        if (seen && current.length > 0) gaps.push(current);
        seen = true;
        current = [];
      }
      if (closed && current.length > 0) gaps.push(current);
      if (gaps.length < (closed ? 2 : 1)) continue;
      const largest = closed ? gaps.reduce((a, b) => (b.length > a.length ? b : a)) : undefined;
      for (const gap of gaps) {
        if (gap === largest || !gap.every((f) => region.has(f))) continue;
        for (const f of gap) band.add(f);
        changed = true;
      }
    }
  }
}

/** The faces around the vertex `start` leaves, in order, from an open edge when there is one. */
function vertexFan(mesh: EditMesh, start: number): { faces: number[]; closed: boolean } {
  let from = start;
  while (mesh.hFace[from ^ 1] !== NONE) {
    from = mesh.hNext[from ^ 1] as number;
    if (from === start) break;
  }
  const closed = mesh.hFace[from ^ 1] !== NONE;
  const faces: number[] = [];
  for (let h = from; ; ) {
    faces.push(mesh.hFace[h] as number);
    const next = (mesh.hPrev[h] as number) ^ 1;
    if (mesh.hFace[next] === NONE || next === from) break;
    h = next;
  }
  return { faces, closed };
}

/**
 * Soft effect assertion: every outer face plane is `thickness` from its inner copy,
 * within the model tolerance plus 0.1% of the thickness.
 */
function assertThickness(
  mesh: EditMesh,
  outer: readonly number[],
  inner: readonly number[],
  thickness: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
  /**
   * Inner vertices whose walls come within the clearance of another part's (`partRelief`),
   * thinnest then nearest first, relieved or as planned: always reported.
   */
  near?: {
    readonly clearance: number;
    readonly relieved: boolean;
    readonly walls: readonly {
      readonly vertex: number;
      readonly thickness: number;
      /** Smallest wall distance to the partner part as planned, before any relief. */
      readonly distance: number;
      readonly partner: number;
    }[];
  },
): void {
  const allowed = tolerance + thickness * CURVED_TOLERANCE;
  const off: { face: number; measured: number }[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const [i, f] of outer.entries()) {
    const measured = dot(
      sub(faceCentroid(mesh, f), faceCentroid(mesh, inner[i] as number)),
      faceNormal(mesh, f),
    );
    min = Math.min(min, measured);
    max = Math.max(max, measured);
    if (Math.abs(measured - thickness) > allowed) off.push({ face: f, measured });
  }
  if (off.length === 0 && near === undefined) return;
  const first = near?.walls[0];
  const sampled = `${off.length} of ${outer.length} sampled wall(s) differ from thickness ${thickness} by more than ${allowed}`;
  diagnostics.push({
    severity: 'warn',
    message:
      near === undefined || first === undefined
        ? sampled
        : near.relieved
          ? `${near.walls.length} wall vertex(es) relieved to as little as ${first.thickness} to keep ${near.clearance} from another part; ${sampled}`
          : `${near.walls.length} wall vertex(es) come within ${near.walls.reduce((d, w) => Math.min(d, w.distance), Infinity)} of another part's wall (clearance ${near.clearance}; clamp with direction 'in' relieves them); ${sampled}`,
    detail: {
      thickness,
      sampled: outer.length,
      off: off.length,
      minMeasured: min,
      maxMeasured: max,
      faces: off.slice(0, LOCATION_LIMIT).map((x) => x.face),
      point:
        first === undefined
          ? faceCentroid(mesh, (off[0] as { face: number }).face)
          : mesh.position(first.vertex),
      ...(near === undefined
        ? {}
        : {
            nearWalls: near.walls.slice(0, LOCATION_LIMIT),
            nearCount: near.walls.length,
            relieved: near.relieved,
            clearance: near.clearance,
          }),
    },
  });
}
