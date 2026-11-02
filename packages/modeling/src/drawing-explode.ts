import { err, ok, type Result } from '@forgeax/engine-types';
import { CONTOUR_POINT_LIMIT, signedArea } from './contour';
import { hypot2 } from './dmath';
import {
  chain,
  DRAWING_POINT_LIMIT,
  type Drawing,
  type DrawingItem,
  type DrawnLine,
  drawingViewFrame,
  duplicateId,
  type ExplodedPart,
  type ExplodeView,
  explodeInner,
  invalidDrawing,
  type Segment2,
} from './drawing';
import { drawingTable, rankParts } from './drawing-table';
import { type ModelingError, modelingError } from './errors';
import { add, dot, faceNormal } from './geom';
import { EDGE_SHARP, type EditMesh, NONE } from './mesh';
import type { Point2 } from './primitives';
import { toView, type ViewFrame } from './views';

const FRONT = 1e-9;
const JOIN = 1e-6;

function viewEdges(
  mesh: EditMesh,
  frame: ViewFrame,
  edges: readonly number[],
): { readonly outline: Segment2[]; readonly crease: Segment2[] } {
  const front = new Map<number, boolean>();
  const isFront = (f: number): boolean => {
    let v = front.get(f);
    if (v === undefined) {
      v = dot(faceNormal(mesh, f), frame.toward) > FRONT;
      front.set(f, v);
    }
    return v;
  };
  const outline: Segment2[] = [];
  const crease: Segment2[] = [];
  for (const e of edges) {
    const fa = mesh.hFace[e * 2] as number;
    const fb = mesh.hFace[e * 2 + 1] as number;
    const a = fa !== NONE && isFront(fa);
    const b = fb !== NONE && isFront(fb);
    if (!a && !b) continue;
    const [v0, v1] = mesh.edgeVertices(e);
    const p = toView(frame, mesh.position(v0));
    const q = toView(frame, mesh.position(v1));
    const segment: Segment2 = [
      [p[0], p[1]],
      [q[0], q[1]],
    ];
    if (a !== b) outline.push(segment);
    else if (((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0) crease.push(segment);
  }
  return { outline, crease };
}

/**
 * Front-facing contour, boundary and sharp edges of the mesh in the frame's view
 * coordinates (meters), chained into polylines. Hidden edges are not removed (no hidden-line removal; see `meshViewLines`).
 */
export function meshViewEdges(mesh: EditMesh, frame: ViewFrame): Point2[][] {
  const { outline, crease } = viewEdges(mesh, frame, mesh.edges());
  return chain([...outline, ...crease], JOIN);
}

/** @internal */
export function pieces(line: readonly Point2[]): { points: Point2[]; closed: boolean }[] {
  const first = line[0] as Point2;
  const last = line[line.length - 1] as Point2;
  const loop = line.length > 3 && hypot2(first[0] - last[0], first[1] - last[1]) < JOIN;
  if (loop && line.length - 1 <= CONTOUR_POINT_LIMIT) {
    const points = line.slice(0, -1);
    return Math.abs(signedArea(points)) > 1e-12
      ? [{ points, closed: true }]
      : [{ points, closed: false }];
  }
  const out: { points: Point2[]; closed: boolean }[] = [];
  for (let at = 0; at < line.length - 1; at += CONTOUR_POINT_LIMIT - 1) {
    out.push({ points: line.slice(at, at + CONTOUR_POINT_LIMIT), closed: false });
  }
  return out;
}

function anchorOf(points: readonly Point2[], closed: boolean): readonly Point2[] {
  if (closed) {
    const ccw = signedArea(points) < 0 ? [...points].reverse() : [...points];
    let best = 0;
    for (const [i, p] of ccw.entries()) {
      const b = ccw[best] as Point2;
      if (p[0] > b[0] || (p[0] === b[0] && p[1] > b[1])) best = i;
    }
    return [...ccw.slice(best), ...ccw.slice(0, best)];
  }
  const head = points[0] as Point2;
  const tail = points[points.length - 1] as Point2;
  return tail[0] > head[0] ? [...points].reverse() : points;
}

function explodeOne(
  mesh: EditMesh,
  view: ExplodeView,
  d: Drawing,
): Result<DrawingItem[], ModelingError> {
  const parent = d.views.find((v) => v.id === view.of);
  if (parent === undefined || 'of' in parent) {
    return invalidDrawing(`explode view '${view.id}' is of an ortho, section or toward view`, {
      view: view.id,
      of: view.of,
    });
  }
  const { frame } = drawingViewFrame(parent);
  const done = explodeInner(mesh, view.explode);
  if (!done.ok) return done;
  const depth = (p: ExplodedPart): number => dot(add(p.centroid, p.offset), frame.toward);
  const back = [...done.value.parts].sort(
    (a, b) => depth(a) - depth(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const rank = new Map(rankParts(done.value.parts).map((p, i) => [p.name, i + 1]));
  type Made = {
    id: string;
    part: string;
    role: 'silhouette' | 'feature';
    points: Point2[];
    closed: boolean;
  };
  const made: Made[] = [];
  const anchors = new Map<string, Point2>();
  let total = 0;
  for (const part of back) {
    const edges = new Set<number>();
    for (const f of done.value.faces.get(part.name) ?? [])
      for (const h of done.value.mesh.faceHalves(f)) edges.add(h >> 1);
    const { outline, crease } = viewEdges(
      done.value.mesh,
      frame,
      [...edges].sort((a, b) => a - b),
    );
    let longest = -1;
    for (const [role, segments] of [
      ['outline', outline],
      ['crease', crease],
    ] as const) {
      let k = 0;
      for (const line of chain(segments, JOIN)) {
        for (const piece of pieces(line)) {
          total += piece.points.length;
          if (total > DRAWING_POINT_LIMIT) {
            return err(
              modelingError(
                'model-work-budget',
                'an exploded view stays within the drawing point limit',
                {
                  limit: DRAWING_POINT_LIMIT,
                },
              ),
            );
          }
          const id = `${view.id}/${part.name}/${role}-${k++}`;
          made.push({
            id,
            part: part.name,
            role: role === 'outline' ? 'silhouette' : 'feature',
            points: piece.points,
            closed: piece.closed && role === 'outline',
          });
          if (role === 'outline' && piece.points.length > longest) {
            longest = piece.points.length;
            const first = anchorOf(piece.points, piece.closed)[0] as Point2;
            anchors.set(part.name, first);
          }
        }
      }
    }
  }
  const items: DrawingItem[] = [];
  const longestOf = new Map<string, Made>();
  for (const m of made) {
    if (m.role === 'silhouette' && m.points.length > (longestOf.get(m.part)?.points.length ?? 0))
      longestOf.set(m.part, m);
  }
  for (const m of made) {
    const points =
      m.id === longestOf.get(m.part)?.id ? [...anchorOf(m.points, m.closed)] : m.points;
    const line: DrawnLine = {
      id: m.id,
      view: view.id,
      role: m.role,
      kind: 'curve',
      curve: { kind: 'polyline', points },
      closed: m.closed,
      basis: 'derived',
    };
    items.push(line);
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const m of made)
    for (const [u, v] of m.points) {
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
  const span = Math.max(hi - lo, high - low, 1e-3);
  const placed: Point2[] = [];
  for (const part of rankParts(done.value.parts)) {
    const anchor =
      anchors.get(part.name) ??
      (() => {
        const w = toView(frame, add(part.centroid, part.offset));
        return [w[0], w[1]] as Point2;
      })();
    const u = anchor[0] + 0.04 * span;
    let v = anchor[1];
    for (let n = 0; n < 200; n++) {
      if (!placed.some((p) => hypot2(p[0] - u, p[1] - v) < 0.05 * span)) break;
      v += 0.06 * span;
    }
    placed.push([u, v]);
    items.push({
      id: `${view.id}/${part.name}/balloon`,
      view: view.id,
      role: 'guide',
      kind: 'note',
      refs: longestOf.has(part.name) ? [(longestOf.get(part.name) as Made).id] : [],
      text: String(rank.get(part.name)),
      at: [u, v],
      balloon: true,
      basis: 'derived',
    });
  }
  const table = drawingTable(`${view.id}/bom`, view.id, { kind: 'bom', parts: done.value.parts });
  if (!table.ok) return table;
  items.push({ ...table.value, basis: 'derived' });
  return ok(items);
}

/**
 * Fill every explode view of the drawing from the mesh: per part, its front-facing outline
 * (painted back to front) and sharp creases, a numbered balloon, and one bill of materials.
 * Items are derived and keyed `<view>/<part>/...`; running it on its own output is a duplicate id.
 */
export function explodeDrawing(mesh: EditMesh, d: Drawing): Result<Drawing, ModelingError> {
  const taken = new Map(d.items.map((item, i) => [item.id, i]));
  const added: DrawingItem[] = [];
  for (const view of d.views) {
    if (!('explode' in view)) continue;
    const made = explodeOne(mesh, view, d);
    if (!made.ok) return made;
    for (const item of made.value) {
      const first = taken.get(item.id);
      if (first !== undefined)
        return duplicateId(`views[${view.id}]`, item.id, { kind: 'item', at: `items[${first}]` });
      taken.set(item.id, -1);
      added.push(item);
    }
  }
  return ok({ ...d, items: [...d.items, ...added] });
}
