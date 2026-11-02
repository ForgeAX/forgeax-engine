import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import { compareLines, outlineDeviation, spanDeviation } from './contour';
import { planeCut } from './cut';
import { atan2, hypot2, hypot3 } from './dmath';
import {
  type BaseView,
  chain,
  type DrawingView,
  type DrawnDimension,
  type DrawnNote,
  drawingBaseView,
  drawingViewFrame,
  type ResolvedDrawing,
  sectionSegments,
} from './drawing';
import { LINE_COVERAGE } from './edge-flow';
import { type ModelingError, modelingError } from './errors';
import { decodeSnapshot } from './fxem';
import type { Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import type { Model } from './model';
import { curvePoint } from './nurbs';
import type { Point2 } from './primitives';
import { SurfaceQuery } from './shrinkwrap';
import type { FeatureLine } from './surface-quality';
import {
  fromView,
  type OrthoView,
  type PerspectiveView,
  perspectiveFrame,
  toView,
  type ViewFrame,
} from './views';

/**
 * 3D against the session's design drawings (`validate({ drawing })`): drawn sections against
 * the state cut at their station, closed silhouettes against the state's projection (IoU),
 * feature curves against the session feature line their `link` names, and dimensions against
 * the span their refs draw. Tolerances live on the items.
 */

export type DrawingCheck = 'section' | 'silhouette' | 'feature' | 'dimension' | 'material';

export interface DrawingCheckOptions {
  /** How far (m) a cut or projected point may lie from a drawn piece and still count against it (default 0.05). */
  readonly reach?: number;
  /** Least share of a drawn feature curve (inside its insets) the session line must cover (default 0.98). */
  readonly coverage?: number;
}

/** One failed drawing check, in the `detail` of a `drawing` validation warning. */
export interface DrawingFinding {
  readonly check: DrawingCheck;
  readonly drawing: string;
  readonly item: string;
  readonly view: string;
  readonly tolerance: number;
  /** section: largest drawn-to-3D distance (m); feature: the same over the span both share. */
  readonly max?: number;
  /** section, feature: largest 3D-to-drawn distance (m), inside the piece's span. */
  readonly back?: number;
  /** section: share of drawn samples beyond the tolerance. */
  readonly outside?: number;
  /** feature: share of the drawn curve (inside its insets) the session line covers. */
  readonly coverage?: number;
  /** silhouette: intersection over union of the drawn outline and the projection. */
  readonly iou?: number;
  /** dimension: the span measured from the refs (m or radians). */
  readonly measured?: number;
  readonly value?: number;
  /** material: the slot the callout names. */
  readonly expected?: string;
  /** material: the slot of the face under the point; absent when the point could not be measured. */
  readonly found?: string;
}

/** IoU floor of a silhouette (C-100 criterion 9). */
const SILHOUETTE_IOU = 0.93;
const DEFAULT_TOLERANCE = 0.002;

/** Overlap of two equal-size boolean masks (nonzero = inside): IoU and the cells only one holds. */
export interface MaskIoU {
  readonly iou: number;
  readonly onlyA: number;
  readonly onlyB: number;
}

/** Intersection over union of two boolean masks of equal size; two empty masks score 1. */
export function maskIoU(a: Uint8Array, b: Uint8Array): Result<MaskIoU, ModelingError> {
  if (a.length !== b.length) {
    return err(
      modelingError('model-invalid-argument', 'masks of equal size', { a: a.length, b: b.length }),
    );
  }
  let both = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] !== 0;
    const y = b[i] !== 0;
    if (x && y) both++;
    else if (x) onlyA++;
    else if (y) onlyB++;
  }
  const union = both + onlyA + onlyB;
  return ok({ iou: union === 0 ? 1 : both / union, onlyA, onlyB });
}

interface Grid {
  readonly u0: number;
  readonly v0: number;
  readonly w: number;
  readonly h: number;
  readonly cell: number;
}

/** Even-odd fill of a polygon into a mask by cell centres (OR into existing cells). */
function fill(mask: Uint8Array, g: Grid, poly: readonly Point2[]): void {
  if (poly.length < 3) return;
  const vs = poly.map((p) => p[1]);
  const j0 = Math.max(0, Math.floor((minOf(vs) - g.v0) / g.cell));
  const j1 = Math.min(g.h - 1, Math.ceil((maxOf(vs) - g.v0) / g.cell));
  for (let j = j0; j <= j1; j++) {
    const y = g.v0 + (j + 0.5) * g.cell;
    const xs: number[] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k] as Point2;
      const b = poly[(k + 1) % poly.length] as Point2;
      if (a[1] > y === b[1] > y) continue;
      xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(((xs[k] as number) - g.u0) / g.cell - 0.5));
      const i1 = Math.min(g.w - 1, Math.floor(((xs[k + 1] as number) - g.u0) / g.cell - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * g.w + i] = 1;
    }
  }
}

/** Projected face loops of a mesh in an ortho view. */
function projectedFaces(mesh: EditMesh, view: OrthoView | ViewFrame): Point2[][] {
  return mesh.faces().map((f) =>
    mesh.faceVertices(f).map((v) => {
      const q = toView(view, mesh.position(v));
      return [q[0], q[1]] as Point2;
    }),
  );
}

/** A session or an FXEM snapshot as its mesh. */
function meshOf(subject: Model | Uint8Array): Result<EditMesh, ModelingError> {
  return subject instanceof Uint8Array ? decodeSnapshot(subject) : ok(subject.editMesh);
}

/** Nearest image depth of a perspective view (fraction of the eye-target distance). */
const NEAR = 1e-3;

/**
 * Silhouette overlap of a session (or FXEM snapshot) with a reference: an outline drawn in
 * an ortho view, or another session or snapshot (the high a low is checked against).
 * Ortho views rasterise on one grid of `cell` meters (default 5 mm) over the joint bounds;
 * a perspective view rasterises both meshes into its own `pixels` square image (`cell`
 * unused), and needs a mesh reference and every vertex in front of the eye.
 */
export function silhouetteIoU(
  subject: Model | Uint8Array,
  view: OrthoView | PerspectiveView,
  reference: readonly Point2[] | Model | Uint8Array,
  cell = 0.005,
): Result<MaskIoU, ModelingError> {
  const mesh = meshOf(subject);
  if (!mesh.ok) return mesh;
  const other = Array.isArray(reference) ? undefined : meshOf(reference as Model | Uint8Array);
  if (other !== undefined && !other.ok) return other;
  if (typeof view !== 'string') {
    if (other === undefined) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a perspective silhouette compares against a session or snapshot',
          {},
          'pass the reference model; drawn outlines belong to ortho views',
        ),
      );
    }
    return perspectiveIoU(mesh.value, other.value, view);
  }
  const outlines =
    other === undefined ? [reference as readonly Point2[]] : projectedFaces(other.value, view);
  return meshSilhouetteIoU(mesh.value, view, outlines, cell);
}

/** Both meshes' faces filled into one perspective image. */
function perspectiveIoU(
  a: EditMesh,
  b: EditMesh,
  view: PerspectiveView,
): Result<MaskIoU, ModelingError> {
  const camera = perspectiveFrame(view);
  if (camera === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a perspective view has eye != target, an up not along the view, fovY in (0, 170) and integer pixels in [8, 4096]',
        { view },
      ),
    );
  }
  const { frame, eye, half, pixels } = camera;
  const dist = hypot3(view.target[0] - eye[0], view.target[1] - eye[1], view.target[2] - eye[2]);
  const g: Grid = { u0: -half, v0: -half, w: pixels, h: pixels, cell: (2 * half) / pixels };
  const masks: Uint8Array[] = [];
  for (const mesh of [b, a]) {
    const mask = new Uint8Array(pixels * pixels);
    for (const f of mesh.faces()) {
      const loop: Point2[] = [];
      for (const v of mesh.faceVertices(f)) {
        const p = mesh.position(v);
        const d: Tuple3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
        const q = toView(frame, d);
        const z = -q[2];
        if (!(z > NEAR * dist)) {
          return err(
            modelingError(
              'model-precondition',
              'every vertex lies in front of the perspective eye',
              { vertex: p, eye },
              'move the eye back or aim it at the subject',
            ),
          );
        }
        loop.push([q[0] / z, q[1] / z]);
      }
      fill(mask, g, loop);
    }
    masks.push(mask);
  }
  return maskIoU(masks[0] as Uint8Array, masks[1] as Uint8Array);
}

/** `silhouetteIoU` of a mesh against drawn outlines (the validate path, which holds the session's mesh). */
function meshSilhouetteIoU(
  mesh: EditMesh,
  view: OrthoView | ViewFrame,
  outlines: readonly (readonly Point2[])[],
  cell: number,
): Result<MaskIoU, ModelingError> {
  if (!(cell > 0)) return err(modelingError('model-invalid-argument', 'cell > 0', { cell }));
  const faces = projectedFaces(mesh, view);
  const pts = [...faces.flat(), ...outlines.flat()];
  if (pts.length === 0) return ok({ iou: 1, onlyA: 0, onlyB: 0 });
  let [uMin, vMin, uMax, vMax] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    uMin = Math.min(uMin, p[0]);
    vMin = Math.min(vMin, p[1]);
    uMax = Math.max(uMax, p[0]);
    vMax = Math.max(vMax, p[1]);
  }
  const u0 = uMin - 2 * cell;
  const v0 = vMin - 2 * cell;
  const w = Math.ceil((uMax - u0) / cell) + 2;
  const h = Math.ceil((vMax - v0) / cell) + 2;
  if (w * h > 16_000_000) {
    return err(
      modelingError('model-work-budget', 'a silhouette raster has at most 16M cells', {
        w,
        h,
        cell,
      }),
    );
  }
  const g: Grid = { u0, v0, w, h, cell };
  const drawn = new Uint8Array(w * h);
  const solid = new Uint8Array(w * h);
  for (const outline of outlines) fill(drawn, g, outline);
  for (const f of faces) fill(solid, g, f);
  return maskIoU(drawn, solid);
}

/** The plane frame of a section view in its own view coordinates (u, v as the drawing reads them). */
function sectionFrame(view: BaseView) {
  const { frame, depth } = drawingViewFrame(view);
  return {
    origin: [frame.toward[0] * depth, frame.toward[1] * depth, frame.toward[2] * depth] as Tuple3,
    u: frame.right,
    v: frame.up,
    normal: frame.toward,
  };
}

/** The material slot of the first face the callout's point sees along its view; undefined when unmeasurable. */
function materialUnder(
  note: DrawnNote,
  d: ResolvedDrawing,
  view: BaseView,
  mesh: EditMesh,
  query: SurfaceQuery | undefined,
): string | undefined {
  const point = d.items.find((x) => x.kind === 'point' && x.id === note.refs?.[0]);
  if (point === undefined || point.kind !== 'point' || point.depth === undefined) return undefined;
  if (query === undefined) return undefined;
  const { frame } = drawingViewFrame(view);
  const origin = fromView(frame, point.at, point.depth);
  const hit = query.cast(origin, [-frame.toward[0], -frame.toward[1], -frame.toward[2]]);
  if (hit === undefined) return undefined;
  return mesh.materialNames[mesh.fMaterial[hit.face] as number];
}

/** Two-sided deviation of a drawn open piece against measured polylines in its view. */
function compare(
  drawn: readonly Point2[],
  measured: readonly (readonly Point2[])[],
  reach: number,
  tolerance: number,
): { max: number; back: number; outside: number } | undefined {
  if (measured.length === 0) return undefined;
  const near = drawn.map((p) => minOf(measured.map((m) => outlineDeviation([p], m, false))));
  const back = spanDeviation(measured.flat(), drawn, reach);
  return {
    max: Math.max(0, ...near),
    back,
    outside: near.filter((d) => d > tolerance).length / Math.max(1, near.length),
  };
}

/** The unsigned angle (radians) at the vertex of a 3-point angle dimension. */
function angleAt(item: DrawnDimension, d: ResolvedDrawing): number | undefined {
  if (item.refs.length !== 3) return undefined;
  const at = item.refs.map((r) => {
    const p = d.items.find((i) => i.id === r);
    return p?.kind === 'point' ? p.at : undefined;
  });
  const [a, v, b] = at;
  if (a === undefined || v === undefined || b === undefined) return undefined;
  const [ux, uy, wx, wy] = [a[0] - v[0], a[1] - v[1], b[0] - v[0], b[1] - v[1]];
  return Math.abs(atan2(ux * wy - uy * wx, ux * wx + uy * wy));
}

function dimensionSpan(
  d: DrawnDimension,
  span: { readonly from?: Point2; readonly to?: Point2 },
): number | undefined {
  if (span.from === undefined || span.to === undefined) return undefined;
  const dx = span.to[0] - span.from[0];
  const dy = span.to[1] - span.from[1];
  switch (d.measure) {
    case 'distance':
    case 'radius':
      return hypot2(dx, dy);
    case 'dx':
      return Math.abs(dx);
    case 'dy':
      return Math.abs(dy);
    case 'angle':
      return undefined;
  }
}

/**
 * Check a session state against its resolved drawings. Every failed check is one finding;
 * a check whose subject is absent (a feature item linking no session feature line, a section
 * station the state does not cross) is a finding with no measures.
 * @internal
 */
export function checkDrawings(
  mesh: EditMesh,
  tolerance: number,
  drawings: readonly ResolvedDrawing[],
  featureLines: readonly FeatureLine[],
  options: DrawingCheckOptions = {},
): DrawingFinding[] {
  const reach = options.reach ?? 0.05;
  const minCoverage = options.coverage ?? LINE_COVERAGE;
  const out: DrawingFinding[] = [];
  for (const d of drawings) {
    const views = new Map(d.views.map((v) => [v.id, v]));
    const curves = new Map(d.curves.map((c) => [c.id, c]));
    const cuts = new Map<string, Point2[][]>();
    const cutAt = (view: BaseView): Point2[][] => {
      const cached = cuts.get(view.id);
      if (cached !== undefined) return cached;
      const copy = mesh.clone();
      const frame = sectionFrame(view);
      const done = planeCut(
        copy,
        { point: frame.origin, normal: frame.normal, keep: 'negative' },
        tolerance,
        { label: 0, material: 0, tag: 0 },
        undefined,
        [],
      );
      const lines = done.ok
        ? chain(sectionSegments(copy, frame, tolerance * 10), tolerance * 10)
        : [];
      cuts.set(view.id, lines);
      return lines;
    };
    let query: SurfaceQuery | undefined;
    const surface = (): SurfaceQuery | undefined => {
      if (query === undefined) {
        const made = SurfaceQuery.of(mesh, mesh.faces());
        if (made.ok) query = made.value;
      }
      return query;
    };
    for (const item of d.items) {
      if ('explode' in (views.get(item.view) as DrawingView)) continue;
      const view = drawingBaseView(views.get(item.view) as DrawingView, d.views);
      const tol = item.tolerance ?? DEFAULT_TOLERANCE;
      const base = { drawing: d.name, item: item.id, view: item.view, tolerance: tol };
      if (item.kind === 'curve') {
        const resolved = curves.get(item.id);
        const open = resolved?.points ?? [];
        // A closed piece is compared along its closing segment too.
        const points =
          resolved?.closed === true && open.length > 0 ? [...open, open[0] as Point2] : open;
        if (item.role === 'section' && 'section' in view) {
          const r = compare(points, cutAt(view), reach, tol);
          if (r === undefined) out.push({ check: 'section', ...base });
          else if (r.max > tol || r.back > tol) out.push({ check: 'section', ...base, ...r });
        } else if (
          item.role === 'silhouette' &&
          item.closed === true &&
          ('ortho' in view || 'toward' in view)
        ) {
          const cell = Math.min(0.01, Math.max(0.001, tol));
          const iou = meshSilhouetteIoU(
            mesh,
            'ortho' in view ? view.ortho : drawingViewFrame(view).frame,
            [open],
            cell,
          );
          if (iou.ok && iou.value.iou < SILHOUETTE_IOU)
            out.push({ check: 'silhouette', ...base, iou: iou.value.iou });
        } else if (item.role === 'feature' && item.link !== undefined) {
          const line = featureLines.find((f) => f.name === item.link);
          const frame: ViewFrame = drawingViewFrame(view).frame;
          if (line === undefined) {
            out.push({ check: 'feature', ...base });
            continue;
          }
          const k = line.curve.knots;
          const [t0, t1] = [
            k[line.curve.degree] as number,
            k[k.length - line.curve.degree - 1] as number,
          ];
          const projected = Array.from({ length: 257 }, (_, i): Point2 => {
            const q = toView(frame, curvePoint(line.curve, t0 + ((t1 - t0) * i) / 256));
            return [q[0], q[1]];
          });
          // Compared over the span both share; `coverage` guards against a line that stops short,
          // and `inset` declares a designed shortfall at each end (a line inset at a panel shut).
          const r = compareLines(points, projected, { reach, inset: item.inset ?? 0 });
          if (r.max > tol || r.back > tol || r.coverage < minCoverage) {
            out.push({ check: 'feature', ...base, ...r });
          }
        }
      } else if (item.kind === 'note' && item.role === 'material') {
        const found = materialUnder(item, d, view, mesh, surface());
        if (found === undefined || found !== item.text) {
          out.push({
            check: 'material',
            ...base,
            expected: item.text,
            ...(found === undefined ? {} : { found }),
          });
        }
      } else if (item.kind === 'dimension') {
        const span = d.dimensions.find((x) => x.id === item.id) ?? {};
        const measured = item.measure === 'angle' ? angleAt(item, d) : dimensionSpan(item, span);
        if (measured !== undefined && Math.abs(measured - item.value) > tol) {
          out.push({ check: 'dimension', ...base, measured, value: item.value });
        }
      }
    }
  }
  return out;
}
