import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, replaceAll } from './arrays';
import { segmentDistance2 } from './compute/mesh-query';
import { CONTOUR_POINT_LIMIT, type ContourKind, contourPoints, signedArea } from './contour';
import { mergeFlags } from './crease';
import { cos, hypot2, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  cross,
  dot,
  faceArea,
  faceCentroid,
  length,
  normalize,
  scale,
  sub,
  type Tuple3,
} from './geom';
import { EditMesh, NONE } from './mesh';
import { approximate, checkCurve, curvePoint, type NurbsCurve } from './nurbs';
import { requireFinite, requirePositive } from './ops';
import type { Point2 } from './primitives';
import {
  fromView,
  isOrthoView,
  lookFrame,
  ORTHO_VIEW_NAMES,
  ORTHO_VIEWS,
  type OrthoView,
  type ViewFrame,
} from './views';

/**
 * Presentation geometry for engineering views of a session state: section
 * outlines with even-odd caps and hatching, and exploded copies. Everything here
 * reads a mesh and returns new data; the session is never changed.
 */

/** Right-handed frame of a plane: `u x v = normal`. */
export interface PlaneFrame {
  readonly origin: Tuple3;
  readonly u: Tuple3;
  readonly v: Tuple3;
  readonly normal: Tuple3;
}

export function planeFrame(point: Tuple3, normal: Tuple3): PlaneFrame {
  const n = normalize(normal);
  const a: Tuple3 =
    Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2])
      ? [1, 0, 0]
      : Math.abs(n[1]) <= Math.abs(n[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const u = normalize(cross(a, n));
  return { origin: point, u, v: cross(n, u), normal: n };
}

export function fromPlane(frame: PlaneFrame, p: Point2, lift = 0): Tuple3 {
  return add(
    add(add(frame.origin, scale(frame.u, p[0])), scale(frame.v, p[1])),
    scale(frame.normal, lift),
  );
}

/** A 2D segment `[a, b]`. */
export type Segment2 = readonly [Point2, Point2];

/**
 * Boundary edges of `mesh` that lie on the plane (both ends within `tolerance`),
 * in plane coordinates: after a plane cut they outline the section.
 */
export function sectionSegments(mesh: EditMesh, frame: PlaneFrame, tolerance: number): Segment2[] {
  const out: Segment2[] = [];
  for (const e of mesh.edges()) {
    if (!mesh.isBoundaryEdge(e)) continue;
    const [a, b] = mesh.edgeVertices(e).map((v) => mesh.position(v)) as [Tuple3, Tuple3];
    if (Math.abs(dot(sub(a, frame.origin), frame.normal)) > tolerance) continue;
    if (Math.abs(dot(sub(b, frame.origin), frame.normal)) > tolerance) continue;
    const project = (p: Tuple3): Point2 => {
      const d = sub(p, frame.origin);
      return [dot(d, frame.u), dot(d, frame.v)];
    };
    out.push([project(a), project(b)]);
  }
  return out;
}

/** Work bound of the scanline fill (slabs x crossing segments). */
export const FILL_WORK_LIMIT = 4_000_000;

/**
 * Even-odd fill of a set of closed outlines given as unordered segments, as
 * counter-clockwise triangles (flattened `[a, b, c, ...]`). Nested outlines
 * become holes and islands. Slab decomposition: exact for non-crossing outlines,
 * robust for any nesting; T-junctions between slabs do not matter for a view.
 */
export function evenOddFill(segments: readonly Segment2[]): Result<Point2[], ModelingError> {
  const ys = [...new Set(segments.flatMap(([a, b]) => [a[1], b[1]]))].sort((p, q) => p - q);
  const spanning = segments.filter(([a, b]) => a[1] !== b[1]);
  if ((ys.length - 1) * spanning.length > FILL_WORK_LIMIT) {
    return err(
      modelingError(
        'model-work-budget',
        `the section fill stays within ${FILL_WORK_LIMIT} slab crossings`,
        {
          slabs: ys.length - 1,
          segments: spanning.length,
        },
      ),
    );
  }
  const xAt = ([a, b]: Segment2, y: number) => a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]);
  const triangles: Point2[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i] as number;
    const y1 = ys[i + 1] as number;
    const ym = (y0 + y1) / 2;
    const crossing = spanning
      .filter(([a, b]) => Math.min(a[1], b[1]) <= y0 && Math.max(a[1], b[1]) >= y1)
      .map((s) => ({ x0: xAt(s, y0), x1: xAt(s, y1), xm: xAt(s, ym) }))
      .sort((p, q) => p.xm - q.xm);
    for (let k = 0; k + 1 < crossing.length; k += 2) {
      const l = crossing[k] as (typeof crossing)[number];
      const r = crossing[k + 1] as (typeof crossing)[number];
      const quad: Point2[] = [
        [l.x0, y0],
        [r.x0, y0],
        [r.x1, y1],
        [l.x1, y1],
      ];
      for (const [p, q, s] of [
        [0, 1, 2],
        [0, 2, 3],
      ] as const) {
        const a = quad[p] as Point2;
        const b = quad[q] as Point2;
        const c = quad[s] as Point2;
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0)
          triangles.push(a, b, c);
      }
    }
  }
  return ok(triangles);
}

/** Hatch lines (`spacing` apart, at `angle` degrees) clipped to the even-odd interior. */
export function evenOddHatch(
  segments: readonly Segment2[],
  spacing: number,
  angle: number,
): Result<Segment2[], ModelingError> {
  const c = cos((angle * Math.PI) / 180);
  const s = sin((angle * Math.PI) / 180);
  const rotate = (p: Point2): Point2 => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
  const back = (p: Point2): Point2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  const turned = segments.map(([a, b]) => [rotate(a), rotate(b)] as const);
  const ys = turned.flatMap(([a, b]) => [a[1], b[1]]);
  if (ys.length === 0) return ok([]);
  const lo = Math.ceil(minOf(ys) / spacing);
  const hi = Math.floor(maxOf(ys) / spacing);
  if ((hi - lo + 1) * turned.length > FILL_WORK_LIMIT) {
    return err(
      modelingError('model-work-budget', 'the hatch stays within the fill work bound', {
        lines: hi - lo + 1,
        segments: turned.length,
      }),
    );
  }
  const out: Segment2[] = [];
  for (let k = lo; k <= hi; k++) {
    const y = k * spacing;
    const xs: number[] = [];
    for (const [a, b] of turned) {
      // Half-open rule: a vertex on the line counts once.
      if (a[1] <= y === b[1] <= y) continue;
      xs.push(a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      out.push([back([xs[i] as number, y]), back([xs[i + 1] as number, y])]);
    }
  }
  return ok(out);
}

/** How faces group into explode parts. `island`: connected through shared edges. */
export type ExplodeGrouping = 'tag' | 'label' | 'material' | 'island';

export interface ExplodeOptions {
  readonly by: ExplodeGrouping;
  /** Offset length per part, meters. */
  readonly distance: number;
  /** Authored unit-free directions by part name; others move away from the subject center. */
  readonly directions?: Readonly<Record<string, readonly [number, number, number]>>;
  /** `order[k]` lists the parts placed at step k + 1, k + 1 times `distance` along their direction; unlisted parts stay at step 0. */
  readonly order?: readonly (readonly string[])[];
}

export interface ExplodedPart {
  readonly name: string;
  readonly faces: number;
  readonly centroid: Tuple3;
  readonly offset: Tuple3;
  readonly authored: boolean;
  /** The step of `ExplodeOptions.order` this part sits at; 0 when unlisted or when no order is given. */
  readonly order: number;
}

function partNames(mesh: EditMesh, by: ExplodeGrouping): Map<number, string> {
  const names = new Map<number, string>();
  if (by === 'island') {
    for (const start of mesh.faces()) {
      if (names.has(start)) continue;
      const name = `island-${names.size === 0 ? 0 : new Set(names.values()).size}`;
      const stack = [start];
      names.set(start, name);
      while (stack.length > 0) {
        const f = stack.pop() as number;
        for (const h of mesh.faceHalves(f)) {
          const g = mesh.hFace[h ^ 1] as number;
          if (g !== NONE && !names.has(g)) {
            names.set(g, name);
            stack.push(g);
          }
        }
      }
    }
    return names;
  }
  for (const f of mesh.faces()) {
    let name = '';
    if (by === 'label') name = mesh.labelNames[mesh.fLabel[f] as number] ?? '';
    else if (by === 'material') name = mesh.materialNames[mesh.fMaterial[f] as number] ?? '';
    else name = mesh.tagNames.find((_, t) => mesh.hasTag(f, t)) ?? '';
    names.set(f, name === '' ? `(no ${by})` : name);
  }
  return names;
}

/**
 * Copy the mesh with every part moved along its direction: authored directions
 * win, others point from the area-weighted subject center to the part center.
 * Parts that shared vertices are split apart in the copy.
 */
export function explodeMesh(
  mesh: EditMesh,
  options: ExplodeOptions,
): Result<{ readonly mesh: EditMesh; readonly parts: readonly ExplodedPart[] }, ModelingError> {
  const r = explodeInner(mesh, options);
  return r.ok ? ok({ mesh: r.value.mesh, parts: r.value.parts }) : r;
}

/** @internal */
export interface ExplodeInner {
  readonly mesh: EditMesh;
  readonly parts: readonly ExplodedPart[];
  readonly faces: ReadonlyMap<string, readonly number[]>;
}

function explodeSteps(
  order: unknown,
  groups: ReadonlyMap<string, unknown>,
): Result<ReadonlyMap<string, number>, ModelingError> {
  const steps = new Map<string, number>();
  if (order === undefined) return ok(steps);
  if (!Array.isArray(order) || order.some((step) => !Array.isArray(step))) {
    return invalidDrawing('explode.order is a list of steps, each a list of part names', {});
  }
  for (const [k, step] of (order as readonly (readonly unknown[])[]).entries()) {
    for (const name of step) {
      if (typeof name !== 'string') {
        return invalidDrawing('explode.order names parts by string', { step: k + 1 });
      }
      if (!groups.has(name)) {
        return err(
          modelingError('model-selection-empty', `explode order '${name}' names a part`, {
            parts: [...groups.keys()],
          }),
        );
      }
      if (steps.has(name)) {
        return invalidDrawing(`explode order lists part '${name}' in two steps`, {
          name,
          steps: [steps.get(name), k + 1],
        });
      }
      steps.set(name, k + 1);
    }
  }
  return ok(steps);
}

/** @internal */
export function explodeInner(
  mesh: EditMesh,
  options: ExplodeOptions,
): Result<ExplodeInner, ModelingError> {
  if (!['tag', 'label', 'material', 'island'].includes(options.by)) {
    return err(
      modelingError(
        'model-invalid-argument',
        "explode.by is 'tag', 'label', 'material' or 'island'",
        {
          by: options.by,
        },
      ),
    );
  }
  if (!Number.isFinite(options.distance) || options.distance < 0) {
    return err(
      modelingError('model-invalid-argument', 'explode.distance is a finite length >= 0', {
        distance: options.distance,
      }),
    );
  }
  const names = partNames(mesh, options.by);
  const groups = new Map<string, number[]>();
  for (const [f, name] of names) groups.set(name, [...(groups.get(name) ?? []), f]);
  const weighted = (faces: readonly number[]): Tuple3 => {
    let total = 0;
    let sum: Tuple3 = [0, 0, 0];
    for (const f of faces) {
      const area = faceArea(mesh, f);
      total += area;
      sum = add(sum, scale(faceCentroid(mesh, f), area));
    }
    if (faces.length === 0) return [0, 0, 0];
    return total === 0 ? faceCentroid(mesh, faces[0] as number) : scale(sum, 1 / total);
  };
  const center = weighted(mesh.faces());
  for (const [name, direction] of Object.entries(options.directions ?? {})) {
    if (!groups.has(name)) {
      return err(
        modelingError('model-selection-empty', `explode direction '${name}' names a part`, {
          parts: [...groups.keys()],
        }),
      );
    }
    if (!direction.every(Number.isFinite) || length(direction as Tuple3) === 0) {
      return err(
        modelingError('model-invalid-argument', 'explode directions are finite and non-zero', {
          name,
        }),
      );
    }
  }
  const steps = explodeSteps(options.order, groups);
  if (!steps.ok) return steps;
  const out = new EditMesh();
  const outFaces = new Map<string, number[]>();
  for (const name of mesh.tagNames) out.tagIndex(name, true);
  replaceAll(out.labelNames, mesh.labelNames);
  replaceAll(out.roleNames, mesh.roleNames);
  replaceAll(out.materialNames, mesh.materialNames);
  const parts: ExplodedPart[] = [];
  for (const [name, faces] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const centroid = weighted(faces);
    const authored = options.directions?.[name];
    const away = sub(centroid, center);
    const direction =
      authored !== undefined
        ? normalize(authored as Tuple3)
        : length(away) > 1e-9
          ? normalize(away)
          : ([0, 1, 0] as Tuple3);
    const step = options.order === undefined ? 1 : (steps.value.get(name) ?? 0);
    const offset = scale(direction, options.distance * step);
    const placed: number[] = [];
    outFaces.set(name, placed);
    const map = new Map<number, number>();
    for (const f of faces) {
      const loop = mesh.faceVertices(f).map((v) => {
        let mapped = map.get(v);
        if (mapped === undefined) {
          mapped = out.addVertex(...add(mesh.position(v), offset));
          map.set(v, mapped);
        }
        return mapped;
      });
      const added = out.addFace(loop, mesh.fMaterial[f] as number);
      if (!added.ok) return added;
      placed.push(added.value);
      mesh.copyFaceAttributesTo(f, out, added.value);
      const halves = mesh.faceHalves(f);
      const copied = out.faceHalves(added.value);
      for (const [i, h] of halves.entries()) {
        const target = copied[i] as number;
        for (const channel of mesh.channels.keys()) {
          const value = mesh.corner(channel, h);
          if (value !== undefined) out.setCorner(channel, target, value);
        }
        out.eFlags[target >> 1] = mergeFlags(
          out.eFlags[target >> 1] as number,
          mesh.eFlags[h >> 1] as number,
        );
      }
    }
    parts.push({
      name,
      faces: faces.length,
      centroid,
      offset,
      authored: authored !== undefined,
      order: options.order === undefined ? 0 : step,
    });
  }
  return ok({ mesh: out, parts, faces: outFaces });
}

/*
 * Design drawings as structured data (B21): views plus items in a view's 2D coordinates
 * (meters), each with a closed role. The drawing is the source of 2D design intent: the
 * package and hard points, feature lines in several views, sections at stations, panel
 * breaks, pivots and links, structure lines. It holds no image data. Items in different
 * views with the same `link` are one 3D element.
 */

/** Where a drawing fact comes from; drawings store links and notes, never images. */
export interface DrawingSource {
  readonly title: string;
  readonly url?: string;
  readonly note?: string;
}

export type BaseView =
  | { readonly id: string; readonly ortho: OrthoView }
  /** A station: the plane `axis` = `at`. Across z it reads like the front view, across x like the right view, across y like the top view. */
  | {
      readonly id: string;
      readonly section: { readonly axis: 'x' | 'y' | 'z'; readonly at: number };
    }
  /** A viewer standing on the `toward` side (3/4 and axonometric views); `up` defaults to +Y. */
  | { readonly id: string; readonly toward: Tuple3; readonly up?: Tuple3 };

/**
 * An enlarged window of another view: `box` is [minU, minV, maxU, maxV] in the parent's
 * coordinates (meters) and `scale` the sheet millimeters per meter the detail is drawn at
 * (1:2 is 500). Items of the parent show inside the box; the detail holds no items of its own.
 */
export interface DetailView {
  readonly id: string;
  readonly of: string;
  readonly detail: {
    readonly box: readonly [number, number, number, number];
    readonly scale: number;
    readonly label?: string;
  };
}

/**
 * The parent view's plane with its parts moved apart by `explodeDrawing`: the view's items are
 * derived (outlines painted back to front, balloons, bill of materials) and it holds no hidden-line removal.
 */
export interface ExplodeView {
  readonly id: string;
  readonly of: string;
  readonly explode: ExplodeOptions;
}

export type DrawingView = BaseView | DetailView | ExplodeView;

/** What an item is for; export layers and line types derive from it. */
export type DrawingRole =
  | 'package'
  | 'silhouette'
  | 'visible'
  | 'hidden'
  | 'feature'
  | 'section'
  | 'break'
  | 'pivot'
  | 'linkage'
  | 'structure'
  | 'guide'
  | 'construction'
  | 'material';

export const DRAWING_ROLES: readonly DrawingRole[] = [
  'package',
  'silhouette',
  'visible',
  'hidden',
  'feature',
  'section',
  'break',
  'pivot',
  'linkage',
  'structure',
  'guide',
  'construction',
  'material',
];

/**
 * A 2D curve (open or closed): points as a polyline, an interpolating spline or a fit of dense samples, a circular arc
 * (radians, counter-clockwise from `from` to `to`), or a planar NURBS curve (z = 0).
 */
export type CurveSpec =
  | (ContourKind & { readonly points: readonly Point2[] })
  | {
      readonly kind: 'arc';
      readonly center: Point2;
      readonly radius: number;
      readonly from: number;
      readonly to: number;
    }
  | { readonly kind: 'nurbs'; readonly curve: NurbsCurve };

interface DrawingItemBase {
  readonly id: string;
  readonly view: string;
  readonly role: DrawingRole;
  /** Items in other views with the same link are the same 3D element. */
  readonly link?: string;
  /** `public`: published data; `blueprint`: measured from a reference drawing; `estimate`: chosen; `derived`: computed from other items. */
  readonly basis?: 'public' | 'blueprint' | 'estimate' | 'derived';
  /** Meters: how far the 3D may deviate from the item (checks), or the sampling and fit tolerance of a curve (default 0.002). */
  readonly tolerance?: number;
  readonly note?: string;
}

/** A hard point or pivot; `depth` (along the view's toward axis) makes it a 3D point. */
export interface DrawnPoint extends DrawingItemBase {
  readonly kind: 'point';
  readonly at: Point2;
  readonly depth?: number;
}

export interface DrawnLine extends DrawingItemBase {
  readonly kind: 'curve';
  readonly curve: CurveSpec;
  readonly closed?: boolean;
  readonly continuity?: 'G0' | 'G1' | 'G2';
  /**
   * Designed shortfall (meters) of the 3D counterpart at each end of an open line, such as a
   * feature line inset at a panel shut: the ends are left out of the checks (default 0).
   */
  readonly inset?: number;
}

/**
 * A measured value. `refs` name the items it spans: two points (distance, dx, dy), one point
 * (dx / dy from the view's axis), an arc (radius), three points `[a, vertex, b]` in the
 * dimension's view (angle: the unsigned angle at the vertex, in [0, pi]), or none (a recorded
 * value). `value` and `tolerance` are meters, or radians for an angle.
 */
export interface DrawnDimension extends DrawingItemBase {
  readonly kind: 'dimension';
  readonly measure: 'distance' | 'dx' | 'dy' | 'angle' | 'radius';
  readonly refs: readonly string[];
  readonly value: number;
}

export interface DrawnNote extends DrawingItemBase {
  readonly kind: 'note';
  readonly refs: readonly string[];
  readonly text: string;
  /** Where a sheet places the text, in view coordinates (meters), with a leader from the first ref; absent: listed under the view. */
  readonly at?: Point2;
  /** The text is drawn in a circle at `at` and must key (column 0) a row of a table of the same view. */
  readonly balloon?: boolean;
  /**
   * Signed deviation in meters a balloon reports under its text (for example the distance of a
   * measured point from the model); such a balloon keys no table row. It is drawn red when its
   * magnitude exceeds the note's `tolerance`.
   */
  readonly deviation?: number;
}

/**
 * A table listed under its view like notes. Cells are text or numbers; every row has one cell
 * per column. Derive rows from their owners with `drawingTable` rather than copying them.
 */
export interface DrawnTable extends DrawingItemBase {
  readonly kind: 'table';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number)[])[];
}

export type DrawingItem = DrawnPoint | DrawnLine | DrawnDimension | DrawnNote | DrawnTable;

/** Cells (headers included) of all tables of one drawing. */
export const TABLE_CELL_LIMIT = 4000;

export interface Drawing {
  readonly name: string;
  readonly sources?: readonly DrawingSource[];
  readonly views: readonly DrawingView[];
  readonly items: readonly DrawingItem[];
}

/** A drawing with every curve sampled in its view and every dimension's drawn span. */
export interface ResolvedDrawing {
  readonly name: string;
  readonly sources: readonly DrawingSource[];
  readonly views: readonly DrawingView[];
  readonly items: readonly DrawingItem[];
  readonly curves: readonly {
    readonly id: string;
    readonly view: string;
    readonly role: DrawingRole;
    readonly closed: boolean;
    readonly points: readonly Point2[];
  }[];
  /** Section hatching per base view (sorted by view id): lines at `hatchSpacing`, 45 degrees, over the even-odd interior of its closed section curves. */
  readonly hatches: readonly { readonly view: string; readonly segments: readonly Segment2[] }[];
  readonly dimensions: readonly {
    readonly id: string;
    readonly view: string;
    readonly measure: DrawnDimension['measure'];
    readonly value: number;
    readonly basis?: DrawnDimension['basis'];
    /** The span drawn as a dimension line, when the refs give one. */
    readonly from?: Point2;
    readonly to?: Point2;
  }[];
}

/**
 * Work bound of a drawing: sampled curve points in total.
 * @internal
 */
export const DRAWING_POINT_LIMIT = 50_000;
const DEFAULT_CURVE_TOLERANCE = 0.002;
const MEASURES: readonly DrawnDimension['measure'][] = ['distance', 'dx', 'dy', 'angle', 'radius'];
const BASES = ['public', 'blueprint', 'estimate', 'derived'] as const;
const AXIS = { x: 0, y: 1, z: 2 } as const;

/**
 * The frame of a drawing view and the depth of its plane: section planes read like the
 * matching ortho view and sit at their station along its toward axis, so
 * `fromView(frame, p, depth)` is the world point of view coordinates `p` and
 * `toView(frame, q)` the inverse.
 */
export function drawingViewFrame(view: BaseView): {
  readonly frame: ViewFrame;
  readonly depth: number;
} {
  if ('ortho' in view) return { frame: ORTHO_VIEWS[view.ortho], depth: 0 };
  if ('toward' in view)
    return { frame: lookFrame(view.toward, view.up) ?? ORTHO_VIEWS.front, depth: 0 };
  return {
    frame: ORTHO_VIEWS[({ z: 'front', x: 'right', y: 'top' } as const)[view.section.axis]],
    depth: view.section.at,
  };
}

/** Join unordered segments into polylines by shared end points (within `tolerance`). @internal */
export function chain(segments: readonly Segment2[], tolerance: number): Point2[][] {
  const key = (p: Point2) => `${Math.round(p[0] / tolerance)},${Math.round(p[1] / tolerance)}`;
  const ends = new Map<string, number[]>();
  segments.forEach(([a, b], i) => {
    for (const p of [a, b]) ends.set(key(p), [...(ends.get(key(p)) ?? []), i]);
  });
  const used = new Uint8Array(segments.length);
  const lines: Point2[][] = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const [a, b] = segments[s] as Segment2;
    const line: Point2[] = [a, b];
    for (const forward of [true, false]) {
      for (;;) {
        const tip = (forward ? line.at(-1) : line[0]) as Point2;
        const next = (ends.get(key(tip)) ?? []).find((i) => !used[i]);
        if (next === undefined) break;
        used[next] = 1;
        const [p, q] = segments[next] as Segment2;
        const far = key(p) === key(tip) ? q : p;
        if (forward) line.push(far);
        else line.unshift(far);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The view whose plane `view` shows: itself, or a detail's parent. */
export function drawingBaseView(view: DrawingView, views: readonly DrawingView[]): BaseView {
  if (!('of' in view)) return view;
  const parent = views.find((v) => v.id === view.of);
  return parent === undefined || 'of' in parent ? ORTHO_FALLBACK : parent;
}

const ORTHO_FALLBACK: BaseView = { id: '', ortho: 'front' };

const ITEM_KINDS = ['point', 'curve', 'dimension', 'note', 'table'] as const;
const BASE_KEYS = ['id', 'view', 'role', 'kind', 'link', 'basis', 'tolerance', 'note'];
const DRAWING_KEYS: Readonly<Record<string, readonly string[]>> = {
  drawing: ['name', 'sources', 'views', 'items'],
  source: ['title', 'url', 'note'],
  view: ['id', 'ortho', 'section', 'toward', 'up', 'of', 'detail', 'explode'],
  explode: ['by', 'distance', 'directions', 'order'],
  detail: ['box', 'scale', 'label'],
  point: [...BASE_KEYS, 'at', 'depth'],
  curve: [...BASE_KEYS, 'curve', 'closed', 'continuity', 'inset'],
  dimension: [...BASE_KEYS, 'measure', 'refs', 'value'],
  note: [...BASE_KEYS, 'refs', 'text', 'at', 'balloon', 'deviation'],
  table: [...BASE_KEYS, 'columns', 'rows'],
};

/** Only the known fields: a drawing holds data, never image payloads or ad-hoc extras. */
function onlyKeys(kind: string, value: unknown, at: string): Result<void, ModelingError> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidDrawing(`${at} is a ${kind} object`, { at });
  }
  const allowed = DRAWING_KEYS[kind] as readonly string[];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  return extra.length === 0
    ? ok(undefined)
    : invalidDrawing(
        `${at} has only the ${kind} fields ${allowed.join(', ')} (drawings hold no image data)`,
        { at, extra },
      );
}

/** @internal */
export function invalidDrawing(
  expected: string,
  detail: Record<string, unknown>,
  hint?: string,
): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail, hint));
}

/** Views and items share one id namespace: the error names the first holder of `id`. */
/** @internal */
export function duplicateId(
  at: string,
  id: string,
  first: { readonly kind: 'view' | 'item'; readonly at: string },
): Result<never, ModelingError> {
  return invalidDrawing(
    `drawing ids are unique across views and items: ${at}.id '${id}' is already the id of ${first.kind} ${first.at}`,
    { at, id, first: first.at },
    `rename one of them; an item cannot share its view's id (e.g. view 'side', item 'side profile')`,
  );
}

function finitePoint(value: unknown, at: string): Result<Point2, ModelingError> {
  if (!Array.isArray(value) || value.length !== 2) return invalidDrawing(`${at} is [u, v]`, { at });
  for (const c of value) {
    const checked = requireFinite(at, c as number);
    if (!checked.ok) return checked;
  }
  return ok([value[0], value[1]] as Point2);
}

function finiteVector(value: unknown, at: string): Result<Tuple3, ModelingError> {
  if (!Array.isArray(value) || value.length !== 3)
    return invalidDrawing(`${at} is [x, y, z]`, { at });
  for (const c of value) {
    const checked = requireFinite(at, c as number);
    if (!checked.ok) return checked;
  }
  return ok([value[0], value[1], value[2]] as Tuple3);
}

function label(value: unknown, at: string, max = 200): Result<string, ModelingError> {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? ok(value)
    : invalidDrawing(`${at} is a non-empty string of at most ${max} characters`, { at });
}

/** Planar NURBS sampled until each parameter interval's chord error is within `tolerance`. */
function sampleNurbs(curve: NurbsCurve, tolerance: number): Point2[] {
  const k = curve.knots;
  const t0 = k[curve.degree] as number;
  const t1 = k[k.length - curve.degree - 1] as number;
  // Start from the knot spans (each split in 4) so a span never hides between samples.
  const ts = [...new Set(k.filter((t) => t >= t0 && t <= t1))];
  const seeds: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    for (let j = 0; j < 4; j++)
      seeds.push((ts[i - 1] as number) + (((ts[i] as number) - (ts[i - 1] as number)) * j) / 4);
  }
  seeds.push(t1);
  const at = (t: number): Point2 => {
    const p = curvePoint(curve, t);
    return [p[0], p[1]];
  };
  const out: Point2[] = [at(seeds[0] as number)];
  const split = (a: number, pa: Point2, b: number, pb: Point2, depth: number) => {
    const m = (a + b) / 2;
    const pm = at(m);
    const [dx, dy] = [pb[0] - pa[0], pb[1] - pa[1]];
    const len = hypot2(dx, dy);
    const error =
      len === 0
        ? hypot2(pm[0] - pa[0], pm[1] - pa[1])
        : Math.abs((pm[0] - pa[0]) * dy - (pm[1] - pa[1]) * dx) / len;
    if (depth < 12 && error > tolerance) {
      split(a, pa, m, pm, depth + 1);
      out.push(pm);
      split(m, pm, b, pb, depth + 1);
    }
  };
  for (let i = 1; i < seeds.length; i++) {
    const [a, b] = [seeds[i - 1] as number, seeds[i] as number];
    const pb = at(b);
    split(a, out.at(-1) as Point2, b, pb, 0);
    out.push(pb);
  }
  return out;
}

/** A resolved curve: its points (counter-clockwise when closed) and how far they stay from the input. */
export interface ResolvedCurve {
  readonly kind: CurveSpec['kind'];
  readonly closed: boolean;
  readonly points: readonly Point2[];
  /** Largest distance from an input point to the resolved points (`fit`; 0 otherwise). */
  readonly deviation: number;
  readonly tolerance: number;
  /** `[minU, minV, maxU, maxV]`. */
  readonly bounds: readonly [number, number, number, number];
}

/** A curve item extruded or intersected by a session (`diagnostics().contours`). */
export interface Contour extends ResolvedCurve {
  readonly id: string;
  readonly view: OrthoView;
}

/**
 * Resolve a curve spec to points, open or `closed`, within `tolerance` (default 2 mm):
 * `polyline` keeps its points, `spline` samples the centripetal Catmull-Rom through them until
 * the chord error is within the tolerance, `fit` reduces dense samples (a traced outline) to
 * the fewest points within the tolerance of every sample (`smooth` passes a spline through the
 * kept points), `arc` and planar `nurbs` sample to the same chord tolerance. A closed curve
 * needs non-zero area and comes out counter-clockwise. The one curve resolver: drawings,
 * contour extrusion and examples share it.
 */
export function resolveCurveSpec(
  spec: CurveSpec,
  options: { readonly closed?: boolean; readonly tolerance?: number } = {},
): Result<ResolvedCurve, ModelingError> {
  const tolerance = requirePositive(
    'curve.tolerance',
    options.tolerance ?? DEFAULT_CURVE_TOLERANCE,
  );
  if (!tolerance.ok) return tolerance;
  const tol = tolerance.value;
  const closed = options.closed === true;
  let points: Point2[];
  let deviation = 0;
  switch (spec?.kind) {
    case 'polyline':
    case 'spline':
    case 'fit': {
      if (!Array.isArray(spec.points) || spec.points.length < 2) {
        return invalidDrawing('curve.points has at least 2 points', {
          count: spec.points?.length ?? 0,
        });
      }
      if (spec.points.length > CONTOUR_POINT_LIMIT) {
        return err(
          modelingError(
            'model-work-budget',
            `a curve has at most ${CONTOUR_POINT_LIMIT} input points`,
            {
              count: spec.points.length,
            },
          ),
        );
      }
      const input: Point2[] = [];
      for (const [i, p] of spec.points.entries()) {
        const checked = finitePoint(p, `curve.points[${i}]`);
        if (!checked.ok) return checked;
        const last = input.at(-1);
        if (last === undefined || last[0] !== checked.value[0] || last[1] !== checked.value[1])
          input.push(checked.value);
      }
      const head = input[0] as Point2;
      const tail = input.at(-1) as Point2;
      if (closed && input.length > 1 && head[0] === tail[0] && head[1] === tail[1]) input.pop();
      if (input.length < (closed ? 3 : 2)) {
        return invalidDrawing(`curve.points has at least ${closed ? 3 : 2} distinct points`, {});
      }
      const sampled = contourPoints(spec, input, tol, closed);
      points = sampled.points;
      deviation = spec.kind === 'fit' ? sampled.deviation : 0;
      if (spec.kind === 'fit' && points.length < (closed ? 3 : 2)) {
        return invalidDrawing('the fitted curve keeps enough points', {});
      }
      if (deviation > tol) {
        return err(
          modelingError('model-degenerate', `the fitted curve stays within ${tol} of its points`, {
            deviation,
          }),
        );
      }
      break;
    }
    case 'arc': {
      const center = finitePoint(spec.center, 'curve.center');
      if (!center.ok) return center;
      const radius = requirePositive('curve.radius', spec.radius);
      if (!radius.ok) return radius;
      for (const k of ['from', 'to'] as const) {
        const checked = requireFinite(`curve.${k}`, spec[k]);
        if (!checked.ok) return checked;
      }
      const sweep = spec.to - spec.from;
      if (sweep === 0 || Math.abs(sweep) > 2 * Math.PI) {
        return invalidDrawing('curve sweeps a non-zero angle of at most 2 pi', { sweep });
      }
      // Chord error r (1 - cos(h / 2)) <= tolerance; h = 2 sqrt(2 tolerance / r) is slightly below that bound.
      const step = 2 * Math.sqrt((2 * tol) / radius.value);
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3)) + 1);
      points = Array.from({ length: n }, (_, i): Point2 => {
        const a = spec.from + (sweep * i) / (n - 1);
        return [center.value[0] + radius.value * cos(a), center.value[1] + radius.value * sin(a)];
      });
      break;
    }
    case 'nurbs': {
      const checked = checkCurve(spec.curve);
      if (!checked.ok) return checked;
      if (spec.curve.points.some((p) => p[2] !== 0)) {
        return invalidDrawing('curve is planar (every control point has z = 0)', {});
      }
      points = sampleNurbs(spec.curve, tol);
      break;
    }
    default:
      return invalidDrawing("curve.kind is 'polyline', 'spline', 'fit', 'arc' or 'nurbs'", {});
  }
  if (closed) {
    const area = signedArea(points);
    if (area === 0)
      return err(modelingError('model-degenerate', 'a closed curve has non-zero area', {}));
    if (area < 0) points = [...points].reverse();
  }
  const us = points.map((p) => p[0]);
  const vs = points.map((p) => p[1]);
  return ok({
    kind: spec.kind,
    closed,
    points,
    deviation,
    tolerance: tol,
    bounds: [minOf(us), minOf(vs), maxOf(us), maxOf(vs)],
  });
}

function sampleCurve(item: DrawnLine): Result<readonly Point2[], ModelingError> {
  const r = resolveCurveSpec(item.curve, {
    closed: item.closed === true,
    ...(item.tolerance === undefined ? {} : { tolerance: item.tolerance }),
  });
  return r.ok ? ok(r.value.points) : r;
}

/**
 * Validate a drawing (unique ids, known views and refs, links on distinct views, closed
 * unions, finite geometry) and sample its curves.
 */
export function resolveDrawing(d: Drawing): Result<ResolvedDrawing, ModelingError> {
  const shape = onlyKeys('drawing', d, 'drawing');
  if (!shape.ok) return shape;
  const name = label(d.name, 'drawing.name');
  if (!name.ok) return name;
  const sources: DrawingSource[] = [];
  for (const [i, source] of (d.sources ?? []).entries()) {
    const sourceShape = onlyKeys('source', source, `sources[${i}]`);
    if (!sourceShape.ok) return sourceShape;
    const title = label(source?.title, `sources[${i}].title`);
    if (!title.ok) return title;
    if (source.url !== undefined && !/^https?:\/\/\S+$/.test(source.url)) {
      return invalidDrawing(`sources[${i}].url is an http(s) link`, { at: `sources[${i}]` });
    }
    sources.push(source);
  }
  if (!Array.isArray(d.views) || !Array.isArray(d.items)) {
    return invalidDrawing('drawing.views and drawing.items are arrays', {});
  }
  const views = new Map<string, DrawingView>();
  for (const [i, view] of d.views.entries()) {
    const at = `views[${i}]`;
    const viewShape = onlyKeys('view', view, at);
    if (!viewShape.ok) return viewShape;
    const id = label(view.id, `${at}.id`, 80);
    if (!id.ok) return id;
    const firstView = d.views.findIndex((v) => v.id === view.id);
    if (firstView < i) return duplicateId(at, view.id, { kind: 'view', at: `views[${firstView}]` });
    if ('ortho' in view) {
      if (!isOrthoView(view.ortho))
        return invalidDrawing(`${at}.ortho is an ortho view`, { at, views: ORTHO_VIEW_NAMES });
    } else if ('of' in view) {
      if ('explode' in view) {
        if ('detail' in view)
          return invalidDrawing(`${at} is a detail or an explode view, not both`, { at });
        const optionsShape = onlyKeys('explode', view.explode, `${at}.explode`);
        if (!optionsShape.ok) return optionsShape;
        const checked = explodeInner(new EditMesh(), view.explode);
        if (!checked.ok && checked.error.code === 'model-invalid-argument') return checked;
        views.set(view.id, view);
        continue;
      }
      if (!('detail' in view)) {
        return invalidDrawing(`${at} with 'of' has a detail or an explode`, { at });
      }
      const detailShape = onlyKeys('detail', view.detail, `${at}.detail`);
      if (!detailShape.ok) return detailShape;
      const box: readonly unknown[] = view.detail.box;
      if (!Array.isArray(box) || box.length !== 4)
        return invalidDrawing(`${at}.detail.box is [minU, minV, maxU, maxV]`, { at });
      for (const c of box) {
        const checked = requireFinite(`${at}.detail.box`, c as number);
        if (!checked.ok) return checked;
      }
      if (!((box[2] as number) > (box[0] as number) && (box[3] as number) > (box[1] as number)))
        return invalidDrawing(`${at}.detail.box has positive width and height`, { at });
      if (!(view.detail.scale > 0) || !Number.isFinite(view.detail.scale))
        return invalidDrawing(`${at}.detail.scale is positive sheet millimeters per meter`, { at });
      if (view.detail.label !== undefined) {
        const text = label(view.detail.label, `${at}.detail.label`, 40);
        if (!text.ok) return text;
      }
    } else if ('section' in view) {
      if (!Object.hasOwn(AXIS, view.section?.axis))
        return invalidDrawing(`${at}.section.axis is 'x', 'y' or 'z'`, { at });
      const station = requireFinite(`${at}.section.at`, view.section.at);
      if (!station.ok) return station;
    } else if ('toward' in view) {
      const toward = finiteVector(view.toward, `${at}.toward`);
      if (!toward.ok) return toward;
      const up = view.up === undefined ? ok(undefined) : finiteVector(view.up, `${at}.up`);
      if (!up.ok) return up;
      if (lookFrame(toward.value, up.value) === undefined) {
        return err(
          modelingError(
            'model-degenerate',
            'a toward view has a non-zero direction that is not along its up',
            { at, toward: view.toward, ...(view.up === undefined ? {} : { up: view.up }) },
          ),
        );
      }
    } else {
      return invalidDrawing(`${at} is an ortho, section, toward or detail view`, { at });
    }
    views.set(view.id, view);
  }
  for (const [i, view] of d.views.entries()) {
    if (!('of' in view)) continue;
    const parent = views.get(view.of);
    if (parent === undefined || 'of' in parent) {
      return invalidDrawing(`views[${i}].of names an ortho, section or toward view`, {
        at: `views[${i}]`,
        of: view.of,
      });
    }
  }
  const items = new Map<string, DrawingItem>();
  const links = new Map<string, Set<string>>();
  const curves: ResolvedDrawing['curves'][number][] = [];
  let total = 0;
  let tableCells = 0;
  for (const [i, item] of d.items.entries()) {
    const at = `items[${i}]`;
    if (!(ITEM_KINDS as readonly unknown[]).includes(item?.kind)) {
      return invalidDrawing(`${at}.kind is 'point', 'curve', 'dimension', 'note' or 'table'`, {
        at,
      });
    }
    const itemShape = onlyKeys(item.kind, item, at);
    if (!itemShape.ok) return itemShape;
    const id = label(item.id, `${at}.id`, 80);
    if (!id.ok) return id;
    if (views.has(item.id))
      return duplicateId(at, item.id, {
        kind: 'view',
        at: `views[${d.views.findIndex((v) => v.id === item.id)}]`,
      });
    if (items.has(item.id))
      return duplicateId(at, item.id, {
        kind: 'item',
        at: `items[${d.items.findIndex((x) => x.id === item.id)}]`,
      });
    if (!views.has(item.view))
      return invalidDrawing(`${at}.view names a view of the drawing`, { at, view: item.view });
    if (!DRAWING_ROLES.includes(item.role))
      return invalidDrawing(`${at}.role is one of ${DRAWING_ROLES.join(', ')}`, { at });
    if (item.basis !== undefined && !BASES.includes(item.basis))
      return invalidDrawing(`${at}.basis is one of ${BASES.join(', ')}`, { at });
    if (item.note !== undefined) {
      const note = label(item.note, `${at}.note`, 500);
      if (!note.ok) return note;
    }
    if (item.link !== undefined) {
      const link = label(item.link, `${at}.link`, 80);
      if (!link.ok) return link;
      const members = links.get(item.link) ?? new Set<string>();
      if (members.has(item.view)) {
        return invalidDrawing('a link has at most one item per view', {
          at,
          link: item.link,
          view: item.view,
        });
      }
      members.add(item.view);
      links.set(item.link, members);
    }
    switch (item.kind) {
      case 'point': {
        const p = finitePoint(item.at, `${at}.at`);
        if (!p.ok) return p;
        if (item.depth !== undefined) {
          const depth = requireFinite(`${at}.depth`, item.depth);
          if (!depth.ok) return depth;
        }
        break;
      }
      case 'curve': {
        if (item.inset !== undefined) {
          const inset = requireFinite(`${at}.inset`, item.inset);
          if (!inset.ok) return inset;
          if (item.inset < 0) return invalidDrawing(`${at}.inset is at least 0`, { at });
        }
        const points = sampleCurve(item);
        if (!points.ok) return points;
        total += points.value.length;
        if (total > DRAWING_POINT_LIMIT) {
          return err(
            modelingError(
              'model-work-budget',
              `a drawing samples at most ${DRAWING_POINT_LIMIT} curve points`,
              { points: total },
            ),
          );
        }
        curves.push({
          id: item.id,
          view: item.view,
          role: item.role,
          closed: item.closed === true,
          points: points.value,
        });
        break;
      }
      case 'dimension': {
        if (!MEASURES.includes(item.measure))
          return invalidDrawing(`${at}.measure is one of ${MEASURES.join(', ')}`, { at });
        const value = requireFinite(`${at}.value`, item.value);
        if (!value.ok) return value;
        if (!Array.isArray(item.refs))
          return invalidDrawing(`${at}.refs is an array of item ids`, { at });
        if (item.measure === 'angle' && item.refs.length !== 0 && item.refs.length !== 3)
          return invalidDrawing(`${at}.refs names 3 points [a, vertex, b] for an angle`, { at });
        if (item.measure !== 'angle' && item.refs.length > 2)
          return invalidDrawing(`${at}.refs names at most 2 items`, { at });
        break;
      }
      case 'note': {
        const text = label(item.text, `${at}.text`, 500);
        if (!text.ok) return text;
        if (item.at !== undefined) {
          const placed = finitePoint(item.at, `${at}.at`);
          if (!placed.ok) return placed;
        }
        if (!Array.isArray(item.refs))
          return invalidDrawing(`${at}.refs is an array of item ids`, { at });
        if (item.balloon !== undefined && typeof item.balloon !== 'boolean')
          return invalidDrawing(`${at}.balloon is a boolean`, { at });
        if (item.balloon === true && item.at === undefined)
          return invalidDrawing(`${at} is a balloon, so it has a point 'at'`, { at });
        if (item.deviation !== undefined) {
          if (typeof item.deviation !== 'number' || !Number.isFinite(item.deviation))
            return invalidDrawing(`${at}.deviation is a finite number of meters`, { at });
          if (item.balloon !== true)
            return invalidDrawing(`${at} has a deviation, so it is a balloon`, { at });
        }
        break;
      }
      case 'table': {
        const cells = checkTable(item, at);
        if (!cells.ok) return cells;
        tableCells += cells.value;
        if (tableCells > TABLE_CELL_LIMIT) {
          return err(
            modelingError(
              'model-work-budget',
              `a drawing holds at most ${TABLE_CELL_LIMIT} table cells`,
              { cells: tableCells },
            ),
          );
        }
        break;
      }
      default:
        return invalidDrawing(`${at}.kind is 'point', 'curve', 'dimension', 'note' or 'table'`, {
          at,
        });
    }
    items.set(item.id, item);
  }
  const dimensions: ResolvedDrawing['dimensions'][number][] = [];
  for (const [i, item] of d.items.entries()) {
    if (item.kind !== 'dimension' && item.kind !== 'note') continue;
    for (const ref of item.refs) {
      if (!items.has(ref))
        return invalidDrawing(`items[${i}].refs name items of the drawing`, {
          at: `items[${i}]`,
          ref,
        });
    }
    if (item.kind === 'dimension' && item.measure === 'angle' && item.refs.length === 3) {
      const points: (DrawingItem | undefined)[] = item.refs.map((r: string) => items.get(r));
      if (
        points.some((p: DrawingItem | undefined) => p?.kind !== 'point' || p.view !== item.view)
      ) {
        return invalidDrawing(`items[${i}].refs are 3 points in the angle's own view`, {
          at: `items[${i}]`,
        });
      }
      const [a, v, b] = points.map((p: DrawingItem | undefined) => (p as DrawnPoint).at) as [
        Point2,
        Point2,
        Point2,
      ];
      if (hypot2(a[0] - v[0], a[1] - v[1]) === 0 || hypot2(b[0] - v[0], b[1] - v[1]) === 0) {
        return err(
          modelingError('model-degenerate', 'an angle has two rays of non-zero length', {
            at: `items[${i}]`,
          }),
        );
      }
    }
    if (item.kind === 'dimension')
      dimensions.push({
        id: item.id,
        view: item.view,
        measure: item.measure,
        value: item.value,
        ...(item.basis === undefined ? {} : { basis: item.basis }),
        ...dimensionSpan(item, items),
      });
  }
  for (const [i, item] of d.items.entries()) {
    if (item.kind !== 'note' || item.balloon !== true || item.deviation !== undefined) continue;
    const keyed = d.items.some(
      (t) =>
        t.kind === 'table' &&
        t.view === item.view &&
        t.rows.some((row: readonly (string | number)[]) => String(row[0]) === item.text),
    );
    if (!keyed) {
      return invalidDrawing(
        `items[${i}] is a balloon whose text keys column 0 of a table row in view '${item.view}'`,
        { at: `items[${i}]`, text: item.text, view: item.view },
        'add the row to a table item of the same view, or change the balloon text',
      );
    }
  }
  const hatches = sectionHatches(curves, views);
  if (!hatches.ok) return hatches;
  return ok({
    name: name.value,
    sources,
    views: [...views.values()],
    items: [...items.values()],
    curves,
    hatches: hatches.value,
    dimensions,
  });
}

function checkTable(item: DrawnTable, at: string): Result<number, ModelingError> {
  if (!Array.isArray(item.columns) || item.columns.length === 0 || !Array.isArray(item.rows))
    return invalidDrawing(`${at} has columns (at least one) and rows arrays`, { at });
  for (const [c, column] of item.columns.entries()) {
    const text = label(column, `${at}.columns[${c}]`, 80);
    if (!text.ok) return text;
  }
  for (const [r, row] of item.rows.entries()) {
    if (!Array.isArray(row) || row.length !== item.columns.length) {
      return invalidDrawing(`${at}.rows[${r}] has one cell per column (${item.columns.length})`, {
        at: `${at}.rows[${r}]`,
        cells: Array.isArray(row) ? row.length : undefined,
      });
    }
    for (const [c, cell] of row.entries()) {
      const ok1 =
        typeof cell === 'number'
          ? Number.isFinite(cell)
          : typeof cell === 'string' && cell.length <= 200;
      if (!ok1) {
        return invalidDrawing(
          `${at}.rows[${r}][${c}] is a finite number or a string of at most 200 characters`,
          {
            at: `${at}.rows[${r}][${c}]`,
          },
        );
      }
    }
  }
  return ok((item.rows.length + 1) * item.columns.length);
}

/** Hatch spacing of a section: one fortieth of its larger extent. */
export function hatchSpacing(segments: readonly Segment2[]): number {
  const us = segments.flatMap(([a, b]) => [a[0], b[0]]);
  const vs = segments.flatMap(([a, b]) => [a[1], b[1]]);
  if (us.length === 0) return 0;
  return Math.max(maxOf(us) - minOf(us), maxOf(vs) - minOf(vs)) / 40;
}

function sectionHatches(
  curves: ResolvedDrawing['curves'],
  views: ReadonlyMap<string, DrawingView>,
): Result<ResolvedDrawing['hatches'][number][], ModelingError> {
  const groups = new Map<string, Segment2[]>();
  for (const c of curves) {
    if (c.role !== 'section' || !c.closed || c.points.length < 2) continue;
    const view = views.get(c.view) as DrawingView;
    const base = 'detail' in view ? view.of : view.id;
    const list = groups.get(base) ?? [];
    for (let i = 0; i < c.points.length; i++) {
      list.push([c.points[i] as Point2, c.points[(i + 1) % c.points.length] as Point2]);
    }
    groups.set(base, list);
  }
  const out: ResolvedDrawing['hatches'][number][] = [];
  for (const id of [...groups.keys()].sort(compareIds)) {
    const segments = groups.get(id) as Segment2[];
    const spacing = hatchSpacing(segments);
    if (!(spacing > 0)) continue;
    const hatched = evenOddHatch(segments, spacing, HATCH_ANGLE);
    if (!hatched.ok) return hatched;
    out.push({ view: id, segments: hatched.value });
  }
  return ok(out);
}

const HATCH_ANGLE = 45;

/** Code-unit order: independent of locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Liang-Barsky clip of a segment to [minU, minV, maxU, maxV].
 * @internal
 */
export function clipSegment(
  a: Point2,
  b: Point2,
  box: readonly [number, number, number, number],
): Segment2 | undefined {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - box[0]],
    [dx, box[2] - a[0]],
    [-dy, a[1] - box[1]],
    [dy, box[3] - a[1]],
  ] as const) {
    if (p === 0) {
      if (q < 0) return undefined;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return undefined;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return undefined;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    t0 === 0 ? a : [a[0] + t0 * dx, a[1] + t0 * dy],
    t1 === 1 ? b : [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** The span a dimension draws: between two points, from the view's axis to one point, or an arc's radius. */
function dimensionSpan(
  item: DrawnDimension,
  items: ReadonlyMap<string, DrawingItem>,
): { from?: Point2; to?: Point2 } {
  const refs = item.refs.map((r) => items.get(r));
  const [a, b] = refs;
  if (a?.kind === 'point' && b?.kind === 'point') return { from: a.at, to: b.at };
  if (a?.kind === 'point' && b === undefined && item.measure === 'dy')
    return { from: [a.at[0], 0], to: a.at };
  if (a?.kind === 'point' && b === undefined && item.measure === 'dx')
    return { from: [0, a.at[1]], to: a.at };
  if (a?.kind === 'curve' && a.curve.kind === 'arc' && item.measure === 'radius') {
    const c = a.curve;
    const mid = (c.from + c.to) / 2;
    return {
      from: c.center,
      to: [c.center[0] + c.radius * cos(mid), c.center[1] + c.radius * sin(mid)],
    };
  }
  return {};
}

/** Options of `drawingCurve3`. */
export interface DrawingCurve3Options {
  /** Largest distance (m) of the fitted curve from the lifted points (default the items' tightest tolerance). */
  readonly tolerance?: number;
  /** Control points of the fit (default the fewest from 4 up to 32 that hold the tolerance). */
  readonly controlPoints?: number;
}

/**
 * The space curve of a link drawn in two ortho views that share one world axis (side and plan
 * share z, front and side y, front and plan x): each view's curve is read along the shared axis,
 * the third coordinates meet at common stations, and the points are fitted as a cubic NURBS
 * (`nurbs.approximate`). Register it with `m.featureLine({ name: link, curve })`.
 */
export function drawingCurve3(
  d: ResolvedDrawing,
  link: string,
  options: DrawingCurve3Options = {},
): Result<NurbsCurve, ModelingError> {
  type Read = {
    readonly item: DrawnLine;
    readonly axes: readonly [number, number];
    readonly points: Tuple3[];
  };
  const reads: Read[] = [];
  for (const item of d.items) {
    if (item.kind !== 'curve' || item.link !== link) continue;
    const view = d.views.find((v) => v.id === item.view);
    if (view === undefined || !('ortho' in view)) continue;
    const frame = ORTHO_VIEWS[view.ortho];
    const axis = (v: Tuple3) => v.findIndex((c) => c !== 0);
    const c = item.curve;
    const sampled: readonly Point2[] =
      c.kind === 'nurbs'
        ? Array.from({ length: 257 }, (_, i): Point2 => {
            const k = c.curve.knots;
            const t0 = k[c.curve.degree] as number;
            const t1 = k[k.length - c.curve.degree - 1] as number;
            const q = curvePoint(c.curve, t0 + ((t1 - t0) * i) / 256);
            return [q[0], q[1]];
          })
        : (d.curves.find((r) => r.id === item.id)?.points ?? []);
    reads.push({
      item,
      axes: [axis(frame.right), axis(frame.up)],
      points: sampled.map((p) => fromView(frame, p, 0)),
    });
  }
  let pair: [Read, Read, number] | undefined;
  for (let i = 0; i < reads.length && pair === undefined; i++)
    for (let j = i + 1; j < reads.length && pair === undefined; j++) {
      const a = reads[i] as Read;
      const b = reads[j] as Read;
      const shared = a.axes.find((k) => b.axes.includes(k));
      if (shared !== undefined && a.axes.some((k) => !b.axes.includes(k))) pair = [a, b, shared];
    }
  if (pair === undefined) {
    return invalidDrawing('the link is drawn in two ortho views that share one axis', { link });
  }
  const [a, b, k] = pair;
  const other = (r: Read) => r.axes.find((x) => x !== k) as number;
  // Each view's curve as a function of the shared axis: strictly monotonic along it.
  const along = (r: Read): { readonly s: number[]; readonly v: number[] } | undefined => {
    const s = r.points.map((p) => p[k] as number);
    const v = r.points.map((p) => p[other(r)] as number);
    const sign = Math.sign((s.at(-1) as number) - (s[0] as number));
    if (sign === 0) return undefined;
    for (let i = 1; i < s.length; i++)
      if (sign * ((s[i] as number) - (s[i - 1] as number)) <= 0) return undefined;
    return sign > 0 ? { s, v } : { s: s.reverse(), v: v.reverse() };
  };
  const fa = along(a);
  const fb = along(b);
  if (fa === undefined || fb === undefined) {
    return err(
      modelingError(
        'model-precondition',
        'each view of the link is single-valued along the shared axis',
        {
          link,
          items: [a.item.id, b.item.id],
        },
      ),
    );
  }
  const lo = Math.max(fa.s[0] as number, fb.s[0] as number);
  const hi = Math.min(fa.s.at(-1) as number, fb.s.at(-1) as number);
  if (!(hi > lo)) {
    return err(
      modelingError(
        'model-precondition',
        'the two views of the link overlap along the shared axis',
        { link },
      ),
    );
  }
  const read = (f: { readonly s: number[]; readonly v: number[] }, x: number): number => {
    let i = 1;
    while (i < f.s.length - 1 && (f.s[i] as number) < x) i++;
    const s0 = f.s[i - 1] as number;
    const s1 = f.s[i] as number;
    return (
      (f.v[i - 1] as number) +
      (((f.v[i] as number) - (f.v[i - 1] as number)) * (x - s0)) / (s1 - s0)
    );
  };
  const points: Tuple3[] = Array.from({ length: 129 }, (_, i) => {
    const x = lo + ((hi - lo) * i) / 128;
    const p: [number, number, number] = [0, 0, 0];
    p[k] = x;
    p[other(a)] = read(fa, x);
    p[other(b)] = read(fb, x);
    return p;
  });
  const tolerance =
    options.tolerance ??
    Math.min(
      a.item.tolerance ?? DEFAULT_CURVE_TOLERANCE,
      b.item.tolerance ?? DEFAULT_CURVE_TOLERANCE,
    );
  const counts =
    options.controlPoints === undefined
      ? Array.from({ length: 29 }, (_, i) => i + 4)
      : [options.controlPoints];
  let last: Result<NurbsCurve, ModelingError> | undefined;
  for (const controlPoints of counts) {
    const fit = approximate(points, { degree: 3, controlPoints });
    if (!fit.ok) return fit;
    last = fit;
    // Distance to the curve, not to its samples: to the segments of a dense polyline, whose
    // chord error is far below any useful tolerance.
    const dense = Array.from({ length: 1025 }, (_, i) => curvePoint(fit.value, i / 1024));
    let worst = 0;
    for (const p of points) {
      let near = Number.POSITIVE_INFINITY;
      for (let i = 1; i < dense.length && near > 0; i++) {
        const [e, f] = [dense[i - 1] as Tuple3, dense[i] as Tuple3];
        near = Math.min(
          near,
          Math.sqrt(segmentDistance2(p[0], p[1], p[2], e[0], e[1], e[2], f[0], f[1], f[2])),
        );
      }
      worst = Math.max(worst, near);
    }
    if (worst <= tolerance) return fit;
  }
  return options.controlPoints === undefined
    ? err(
        modelingError(
          'model-precondition',
          `a cubic of at most 32 control points fits the link within ${tolerance}`,
          { link },
        ),
      )
    : (last as Result<NurbsCurve, ModelingError>);
}
