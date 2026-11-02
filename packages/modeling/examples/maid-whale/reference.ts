import type { CurveSpec, Drawing } from '@forgeax/engine-modeling';
import data from './reference.json' with { type: 'json' };

/**
 * Case C-200 (F2, code name maid-whale): the G1 calibration of the turnaround sheet as
 * data. `reference.json` is written by `calibrate/calibrate.mjs` from the sheet, which
 * stays outside every repository; this module only reads the derived numbers. Meters,
 * Y up, the character faces +Z, the leg axis on the origin, ground at y = 0. The sheet's
 * SIDE view is the kernel's `right` view (u = -z, the face on the left).
 */
export const REF = data;

export type SheetView = 'front' | 'right' | 'back';
export const SHEET_VIEWS: readonly SheetView[] = ['front', 'right', 'back'];

type Point = readonly [number, number];
type Bounds = readonly [number, number, number, number];

export interface PartExtent {
  /** `[minU, minV, maxU, maxV]` in view meters. */
  readonly bounds: Bounds;
  readonly size: Point;
  readonly center: Point;
}

/** Landmark heights (meters above the ground) by name. */
export const LANDMARK: Readonly<Record<string, number>> = Object.fromEntries(
  REF.landmarks.map((l) => [l.name, l.v]),
);

export function part(view: SheetView, name: string): PartExtent {
  const parts = REF.views[view].parts as unknown as Record<string, PartExtent | undefined>;
  const found = parts[name];
  if (found === undefined) throw new Error(`maid-whale reference: no part ${name} in the ${view} view`);
  return found;
}

export function silhouette(view: SheetView): readonly Point[] {
  return REF.views[view].silhouette.points as unknown as readonly Point[];
}

const RULER_U = -0.34;
type Item = Drawing['items'][number];
/** A landmark height: a guide point on a ruler at u, and its height above the ground (dy). */
const landmark = (name: string, view: SheetView, v: number, u = RULER_U): Item[] => [
  { id: `${name} (${view})`, view, role: 'guide', kind: 'point', at: [u, v] },
  { id: name, view, role: 'guide', kind: 'dimension', measure: 'dy', refs: [`${name} (${view})`], value: v, basis: 'estimate' },
];
/** A horizontal span between two guide points at height v. */
const span = (name: string, view: SheetView, u0: number, u1: number, v = -0.04): Item[] => [
  { id: `${name} start`, view, role: 'guide', kind: 'point', at: [u0, v] },
  { id: `${name} end`, view, role: 'guide', kind: 'point', at: [u1, v] },
  { id: name, view, role: 'guide', kind: 'dimension', measure: 'distance', refs: [`${name} start`, `${name} end`], value: u1 - u0, basis: 'estimate' },
];

/** The turnaround as a design drawing: provenance, landmark dimensions and the three measured silhouettes. */
export const BOARD: Drawing = {
  name: 'maid-whale turnaround (G1 calibration)',
  sources: [
    {
      title: REF.source.title,
      note: `sha256 ${REF.source.sha256Prefix}, ${REF.source.width} x ${REF.source.height}; silhouettes and landmarks measured by examples/maid-whale/calibrate (${REF.scale.pxPerMeter} px/m)`,
    },
  ],
  views: SHEET_VIEWS.map((view) => ({ id: view, ortho: view })),
  items: [
    ...SHEET_VIEWS.map((view): Item => ({ id: `${view} silhouette`, view, role: 'silhouette', kind: 'curve', closed: true, curve: { kind: 'polyline', points: silhouette(view) } })),
    ...landmark('total height (ahoge tip)', 'front', LANDMARK['ahoge-tip'] as number),
    ...landmark('crown', 'front', LANDMARK.crown as number, RULER_U + 0.03),
    ...landmark('chin', 'front', LANDMARK.chin as number, RULER_U + 0.06),
    ...landmark('waist', 'front', LANDMARK.waist as number, RULER_U + 0.09),
    ...landmark('hem', 'front', LANDMARK.hem as number, RULER_U + 0.12),
    ...landmark('eye line', 'right', LANDMARK['eye-line'] as number, -0.22),
    ...landmark('shoulder', 'right', LANDMARK.shoulder as number, -0.25),
    ...landmark('sock top', 'right', LANDMARK['sock-top'] as number, -0.28),
    ...span('tail reach (side)', 'right', 0, part('right', 'tail').bounds[2]),
    ...span('hem width (back)', 'back', part('back', 'skirt-hem').bounds[0], part('back', 'skirt-hem').bounds[2]),
  ],
};

/** A measured part outline of a view (calibrate OUTLINES). */
export function outline(view: SheetView, name: string): readonly Point[] {
  const outlines = REF.views[view].outlines as unknown as Record<string, { points: readonly Point[] } | undefined>;
  const found = outlines[name];
  if (found === undefined) throw new Error(`maid-whale reference: no outline ${name} in the ${view} view`);
  return found.points;
}

/** One closed construction curve per sheet view (item id = view), for `extrudeContour` and `threeView`. */
export function viewDrawing(name: string, curves: Partial<Record<SheetView, CurveSpec>>, tolerance?: number): Drawing {
  const views = SHEET_VIEWS.filter((view) => curves[view] !== undefined);
  return {
    name,
    views: views.map((view) => ({ id: `${view} view`, ortho: view })),
    items: views.map((view): Item => ({ id: view, view: `${view} view`, role: 'construction', kind: 'curve', closed: true, curve: curves[view] as CurveSpec, ...(tolerance === undefined ? {} : { tolerance }) })),
  };
}

/** Measured part outlines per view, fitted within `tolerance`. */
export function outlineDrawing(parts: Partial<Record<SheetView, string>>, tolerance = 0.004): Drawing {
  const curves: Partial<Record<SheetView, CurveSpec>> = {};
  for (const view of SHEET_VIEWS) {
    const name = parts[view];
    if (name !== undefined) curves[view] = { kind: 'fit', points: outline(view, name) };
  }
  return viewDrawing(Object.values(parts).join('/'), curves, tolerance);
}

/** Inside spans `[minU, maxU]` of a closed outline on the horizontal line at height `v`. */
export function spans(points: readonly Point[], v: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) {
      xs.push(a[0] + ((v - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i] as number, xs[i + 1] as number]);
  return out;
}
