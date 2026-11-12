import type { Model } from '@forgeax/engine-modeling';
import blueprint from './reference/blueprint.json' with { type: 'json' };

/**
 * Case C-100 criterion 9 (code name mech-gt): reference alignment. `reference/blueprint.json`
 * holds the silhouettes, wheel circles and feature lines measured from the public three-view
 * blueprint (`reference/measure-blueprint.mjs`; the drawing is not stored), in meters in the
 * car frame. `silhouetteIoU` compares a model's orthographic silhouette with the reference on
 * one grid; `featureError` compares a model polyline with a reference feature line.
 */
export type View = 'right' | 'top' | 'front' | 'back';
type Point2 = readonly [number, number];

export interface Blueprint {
  readonly scale: { readonly metersPerUnit: number; readonly lengthMm: number; readonly heightMm: number };
  readonly wheels: { readonly rear: { z: number; y: number; r: number }; readonly front: { z: number; y: number; r: number }; readonly wheelbase: number };
  readonly silhouettes: Readonly<Record<View, readonly Point2[]>>;
  readonly features: Readonly<Record<string, { readonly view: View; readonly note: string; readonly polylines: readonly (readonly Point2[])[] }>>;
}

export const BLUEPRINT = blueprint as unknown as Blueprint;

/** The view-plane coordinates of a model-space point, as the blueprint stores them. */
export function project(view: View, p: readonly number[]): Point2 {
  const [x, y, z] = p as [number, number, number];
  return view === 'right' ? [z, y] : view === 'top' ? [x, z] : [x, y];
}

/** Grid cell size of the IoU raster (meters). */
export const IOU_CELL = 0.005;

interface Grid {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  readonly cells: Uint8Array;
}

function grid(bounds: readonly [number, number, number, number]): Grid {
  const pad = 4 * IOU_CELL;
  const x0 = bounds[0] - pad;
  const y0 = bounds[1] - pad;
  const w = Math.ceil((bounds[2] - bounds[0] + 2 * pad) / IOU_CELL);
  const h = Math.ceil((bounds[3] - bounds[1] + 2 * pad) / IOU_CELL);
  return { x0, y0, w, h, cells: new Uint8Array(w * h) };
}

/** Fill a polygon (even-odd) by cell centers. */
function fillPolygon(g: Grid, poly: readonly Point2[]): void {
  for (let j = 0; j < g.h; j++) {
    const y = g.y0 + (j + 0.5) * IOU_CELL;
    const xs: number[] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k] as Point2;
      const b = poly[(k + 1) % poly.length] as Point2;
      if ((a[1] > y) === (b[1] > y)) continue;
      xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(((xs[k] as number) - g.x0) / IOU_CELL - 0.5));
      const i1 = Math.min(g.w - 1, Math.floor(((xs[k + 1] as number) - g.x0) / IOU_CELL - 0.5));
      for (let i = i0; i <= i1; i++) g.cells[j * g.w + i] = 1;
    }
  }
}

/** Fill a triangle by cell centers (edge functions). */
function fillTriangle(g: Grid, a: Point2, b: Point2, c: Point2): void {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (area === 0) return;
  const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - g.x0) / IOU_CELL));
  const i1 = Math.min(g.w - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - g.x0) / IOU_CELL));
  const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - g.y0) / IOU_CELL));
  const j1 = Math.min(g.h - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - g.y0) / IOU_CELL));
  const s = Math.sign(area);
  for (let j = j0; j <= j1; j++) {
    const y = g.y0 + (j + 0.5) * IOU_CELL;
    for (let i = i0; i <= i1; i++) {
      const x = g.x0 + (i + 0.5) * IOU_CELL;
      const e0 = s * ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]));
      const e1 = s * ((c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]));
      const e2 = s * ((a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]));
      if (e0 >= 0 && e1 >= 0 && e2 >= 0) g.cells[j * g.w + i] = 1;
    }
  }
}

/**
 * Fill the holes of a mask: cells the outside cannot reach. A silhouette is an outline, so
 * shut lines, wheel spokes and openings through the body never show as background.
 */
function fillHoles(g: Grid): void {
  const outside = new Uint8Array(g.w * g.h);
  const stack: number[] = [];
  const push = (i: number, j: number) => {
    const k = j * g.w + i;
    if (i < 0 || j < 0 || i >= g.w || j >= g.h || outside[k] === 1 || g.cells[k] === 1) return;
    outside[k] = 1;
    stack.push(k);
  };
  for (let i = 0; i < g.w; i++) {
    push(i, 0);
    push(i, g.h - 1);
  }
  for (let j = 0; j < g.h; j++) {
    push(0, j);
    push(g.w - 1, j);
  }
  while (stack.length > 0) {
    const k = stack.pop() as number;
    const [i, j] = [k % g.w, Math.floor(k / g.w)];
    push(i + 1, j);
    push(i - 1, j);
    push(i, j + 1);
    push(i, j - 1);
  }
  for (let k = 0; k < g.cells.length; k++) if (outside[k] === 0) g.cells[k] = 1;
}

/** Orthographic silhouette IoU of the models against the reference outline of `view`. */
export function silhouetteIoU(models: readonly Model[], view: View): {
  iou: number;
  reference: number;
  model: number;
  intersection: number;
  /** The two masks on the IoU grid (row 0 at the bottom), for difference images. */
  mask: { width: number; height: number; reference: Uint8Array; model: Uint8Array; grid: { x0: number; y0: number } };
} {
  const ref = BLUEPRINT.silhouettes[view];
  const tris: [Point2, Point2, Point2][] = [];
  for (const m of models) {
    const mesh = m.editMesh;
    for (const f of mesh.faces()) {
      const p = mesh.faceVertices(f).map((v) => project(view, mesh.position(v)));
      for (let k = 1; k + 1 < p.length; k++) tris.push([p[0] as Point2, p[k] as Point2, p[k + 1] as Point2]);
    }
  }
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const q of [...ref, ...tris.flat()]) {
    bounds[0] = Math.min(bounds[0], q[0]);
    bounds[1] = Math.min(bounds[1], q[1]);
    bounds[2] = Math.max(bounds[2], q[0]);
    bounds[3] = Math.max(bounds[3], q[1]);
  }
  const a = grid(bounds);
  const b = grid(bounds);
  fillPolygon(a, ref);
  for (const [p, q, r] of tris) fillTriangle(b, p, q, r);
  fillHoles(b);
  let ra = 0;
  let mb = 0;
  let both = 0;
  for (let k = 0; k < a.cells.length; k++) {
    ra += a.cells[k] as number;
    mb += b.cells[k] as number;
    both += (a.cells[k] as number) & (b.cells[k] as number);
  }
  const cell = IOU_CELL * IOU_CELL;
  return { iou: both / (ra + mb - both), reference: ra * cell, model: mb * cell, intersection: both * cell, mask: { width: a.w, height: a.h, reference: a.cells, model: b.cells, grid: { x0: a.x0, y0: a.y0 } } };
}

// ---- the blueprint on the current car -------------------------------------------------

const right = BLUEPRINT.silhouettes.right;
const top = BLUEPRINT.silhouettes.top;
/** Blueprint stations along z: tail, rear axle, front axle, nose. */
const BP_STATIONS = [
  Math.min(...right.map((p) => p[0])),
  BLUEPRINT.wheels.rear.z,
  BLUEPRINT.wheels.front.z,
  Math.max(...right.map((p) => p[0])),
] as const;

/** Crossings of a closed outline with the line `coord = value` (coord 0: x = value, 1: y = value), as the other coordinate. */
function crossings(outline: readonly Point2[], coord: 0 | 1, value: number): number[] {
  const other = coord === 0 ? 1 : 0;
  const out: number[] = [];
  for (let k = 0; k < outline.length; k++) {
    const a = outline[k] as Point2;
    const b = outline[(k + 1) % outline.length] as Point2;
    if ((a[coord] - value) * (b[coord] - value) > 0 || a[coord] === b[coord]) continue;
    out.push(a[other] + ((value - a[coord]) * (b[other] - a[other])) / (b[coord] - a[coord]));
  }
  return out;
}

/** Outermost half-width of an outline at `value`, averaged over both sides. */
function outerHalf(outline: readonly Point2[], coord: 0 | 1, value: number): number {
  const xs = crossings(outline, coord, value);
  if (xs.length < 2) return 0;
  return (Math.max(...xs) - Math.min(...xs)) / 2;
}

/** Half the public body width: anything wider in the plan, front or back view is a mirror. */
const MIRROR_FREE = 2.033 / 2 + 0.003;
/** Profile samples every centimeter. */
const SAMPLE = 0.01;
/** Mirror stalks rise from the body this far beyond the part that is wider than the body. */
const MIRROR_MARGIN = 0.05;

interface Profile {
  readonly from: number;
  readonly values: readonly number[];
}

/**
 * Mirror-free half-width profile of an outline along `coord`: the outermost half-width per
 * sample, with every run wider than the body (a mirror) plus a margin either side replaced
 * by the straight line between its neighbors.
 */
function profile(outline: readonly Point2[], coord: 0 | 1): Profile {
  const lo = Math.min(...outline.map((p) => p[coord]));
  const hi = Math.max(...outline.map((p) => p[coord]));
  const n = Math.floor((hi - lo) / SAMPLE);
  const values = Array.from({ length: n + 1 }, (_, k) => outerHalf(outline, coord, lo + k * SAMPLE));
  const margin = Math.round(MIRROR_MARGIN / SAMPLE);
  const wide = values.map((v) => v > MIRROR_FREE);
  for (let k = 0; k < values.length; ) {
    if (!wide[k]) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < values.length && wide[e + 1]) e++;
    const a = Math.max(0, k - margin);
    const b = Math.min(values.length - 1, e + margin);
    for (let i = a + 1; i < b; i++) values[i] = (values[a] as number) + (((values[b] as number) - (values[a] as number)) * (i - a)) / (b - a);
    k = e + 1;
  }
  return { from: lo, values };
}

function at(p: Profile, value: number): number {
  const f = (value - p.from) / SAMPLE;
  if (f <= 0 || f >= p.values.length - 1) return 0;
  const i = Math.floor(f);
  return (p.values[i] as number) + ((p.values[i + 1] as number) - (p.values[i] as number)) * (f - i);
}

const PLAN = profile(top, 1);
const FRONT = profile(BLUEPRINT.silhouettes.front, 1);
const BACK = profile(BLUEPRINT.silhouettes.back, 1);
/** Widest mirror-free body half-width of the plan. */
const BP_HALF = Math.max(...PLAN.values);

/** A blueprint z on the current car: piecewise linear over tail, axles and nose. */
export function carZ(z: number, stations: readonly [number, number, number, number]): number {
  const k = z < BP_STATIONS[1] ? 0 : z < BP_STATIONS[2] ? 1 : 2;
  const a = BP_STATIONS[k] as number;
  const b = BP_STATIONS[k + 1] as number;
  return (stations[k] as number) + ((z - a) * ((stations[k + 1] as number) - (stations[k] as number))) / (b - a);
}

/** The blueprint mapped onto a car: its stations, body width and height. */
export interface BlueprintFit {
  readonly stations: readonly [number, number, number, number];
  readonly width: number;
  readonly height: number;
}

/** Side outline (z, y) on the car, clipped to y >= floor (the tires below the sill leave). */
export function sideOutline(car: BlueprintFit, floor: number): Point2[] {
  const sy = car.height / (BLUEPRINT.scale.heightMm / 1000);
  const pts = right.map((p): Point2 => [carZ(p[0], car.stations), p[1] * sy]);
  const out: Point2[] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k] as Point2;
    const b = pts[(k + 1) % pts.length] as Point2;
    const ina = a[1] >= floor;
    const inb = b[1] >= floor;
    if (ina) out.push(a);
    if (ina !== inb) out.push([a[0] + ((floor - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), floor]);
  }
  return out;
}

/** Plan half-width at car station z (mirror-free). */
export function planHalfWidth(car: BlueprintFit, z: number): number {
  // Invert the piecewise station map.
  const k = z < car.stations[1] ? 0 : z < car.stations[2] ? 1 : 2;
  const a = car.stations[k] as number;
  const b = car.stations[k + 1] as number;
  const bz = (BP_STATIONS[k] as number) + ((z - a) * ((BP_STATIONS[k + 1] as number) - (BP_STATIONS[k] as number))) / (b - a);
  return (at(PLAN, bz) * car.width) / 2 / BP_HALF;
}

/** Section half-width at height y (mirror-free), the larger of the front and back views; the tires show near the ground. */
export function sectionHalfWidth(car: BlueprintFit, y: number): number {
  const by = (y * (BLUEPRINT.scale.heightMm / 1000)) / car.height;
  const w = Math.max(at(FRONT, by), at(BACK, by));
  return (w * car.width) / 2 / BP_HALF;
}

/** A feature line of the blueprint on a car: side lines (z, y) through the station map, front and back lines (x, y) scaled. */
export function featureLines(name: string, car: BlueprintFit): Point2[][] {
  const f = BLUEPRINT.features[name];
  if (f === undefined) throw new Error(`unknown feature ${name}`);
  const sy = car.height / (BLUEPRINT.scale.heightMm / 1000);
  const sx = car.width / 2 / BP_HALF;
  return f.polylines.map((p) => p.map((q): Point2 => (f.view === 'right' ? [carZ(q[0], car.stations), q[1] * sy] : [q[0] * sx, q[1] * sy])));
}

/** The height of a side feature line at car station z (the highest crossing), or undefined outside it. */
export function featureY(name: string, car: BlueprintFit): (z: number) => number | undefined {
  const lines = featureLines(name, car);
  return (z) => {
    let best: number | undefined;
    for (const p of lines) {
      for (let k = 0; k + 1 < p.length; k++) {
        const [a, b] = [p[k] as Point2, p[k + 1] as Point2];
        if ((a[0] - z) * (b[0] - z) > 0 || a[0] === b[0]) continue;
        const y = a[1] + ((z - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
        best = best === undefined ? y : Math.max(best, y);
      }
    }
    return best;
  };
}

/**
 * Mean and largest distance (meters) from a model polyline to the feature line on the car, in
 * the feature's view, sampled every centimeter along the model line; for side features only
 * the samples over the feature's own z extent count.
 */
export function featureError(name: string, line: readonly (readonly number[])[], car: BlueprintFit): { mean: number; max: number } {
  const f = BLUEPRINT.features[name];
  if (f === undefined) throw new Error(`unknown feature ${name}`);
  const lines = featureLines(name, car);
  const segs = lines.flatMap((p) => p.slice(1).map((q, k) => [p[k] as Point2, q] as const));
  const dist = (q: Point2) =>
    Math.min(
      ...segs.map(([a, b]) => {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
      }),
    );
  const zs = lines.flat().map((q) => q[0]);
  const [lo, hi] = [Math.min(...zs), Math.max(...zs)];
  const pts = line.map((p) => project(f.view, p));
  const samples: Point2[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [a, b] = [pts[k] as Point2, pts[k + 1] as Point2];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.01));
    for (let i = 0; i < n; i++) samples.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  const kept = f.view === 'right' ? samples.filter((q) => q[0] >= lo && q[0] <= hi) : samples;
  const d = kept.map(dist);
  return { mean: d.reduce((s, v) => s + v, 0) / Math.max(1, d.length), max: d.reduce((a, b) => Math.max(a, b), 0) };
}

/**
 * Distance (meters) from the model's silhouette outline in `view` to the blueprint outline
 * (or to the lines `against`): mean and largest over the boundary cells of the model mask
 * (holes filled).
 */
export function contourError(models: readonly Model[], view: View, against?: readonly (readonly Point2[])[]): { mean: number; max: number } {
  const { mask } = silhouetteIoU(models, view);
  const ref = BLUEPRINT.silhouettes[view];
  const segs = against === undefined ? ref.map((p, k) => [p, ref[(k + 1) % ref.length] as Point2] as const) : against.flatMap((p) => p.slice(1).map((q, k) => [p[k] as Point2, q] as const));
  const g = mask.grid;
  const d: number[] = [];
  for (let j = 1; j + 1 < mask.height; j++) {
    for (let i = 1; i + 1 < mask.width; i++) {
      const k = j * mask.width + i;
      if (mask.model[k] !== 1) continue;
      if (mask.model[k - 1] === 1 && mask.model[k + 1] === 1 && mask.model[k - mask.width] === 1 && mask.model[k + mask.width] === 1) continue;
      const q: Point2 = [g.x0 + (i + 0.5) * IOU_CELL, g.y0 + (j + 0.5) * IOU_CELL];
      let best = Infinity;
      for (const [a, b] of segs) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)));
      }
      d.push(best);
    }
  }
  return { mean: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length), max: d.reduce((a, b) => Math.max(a, b), 0) };
}
