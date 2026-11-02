import { type Drawing, type DrawingItem, type EditMesh, type Model, model, sel, silhouetteIoU, toView } from '@forgeax/engine-modeling';
import { BANGS, CAP } from '../hair.ts';
import { OMBRE_STOPS } from '../materials.ts';
import { LANDMARK, outline, REF, type SheetView, SHEET_VIEWS, spans } from '../reference.ts';

/**
 * Sheet HAIR-01 rev A: the maid-whale hair as numbered clumps, before the
 * G4 remodel builds it. Parent TURN-01 (turnaround.ts TURNAROUND), whose measured hair
 * silhouettes it repeats; child HAIR-02 (clump sections, not yet issued).
 *
 * - Clumps 1..9 (the major groups): 1 bangs (owner 87, hair.ts BANGS), 2-3 the front side locks
 *   over the shoulders, 4-8 the back groups from the crown to their split tips, 9 the ahoge.
 *   Each clump has a root on the scalp (cap ellipsoid, hair.ts CAP), a 3D flow line projected
 *   into every view (link `clump:<n>:flow`), its tips (link `clump:<n>:tip-<k>`) and a note.
 * - Ombre bands at the dark end and the fully light start (materials.ts OMBRE_STOPS), the
 *   flare width and the hair length as dimensions.
 *
 * The back tips are the minima of the reference back hair outline (reference.json), the flow
 * lines run inside its spans and the depth inside the side view's hair spans; nothing here reads
 * a model. `measureHairDesign` checks a model's hair against the sheet.
 */

type Point = readonly [number, number];
type P3 = readonly [number, number, number];
type View = SheetView | 'top';
const VIEWS: readonly View[] = [...SHEET_VIEWS, 'top'];

/** Sheet id and revision (`<area>-<nn>`, letters A, B, ...). */
export const HAIR_SHEET = { id: 'HAIR-01', revision: 'A', parent: 'TURN-01' } as const;

/** Head centre in plan (head bounds centre, hair.ts buildHair) at the cap's centre height. */
const HEAD: P3 = [0, CAP.centerY, -0.0035];

/** A point on the scalp: azimuth (degrees from +z toward +x) at height y on the cap ellipsoid. */
function scalp(az: number, y: number): P3 {
  const [rx, ry, rz] = CAP.radii;
  const k = Math.sqrt(Math.max(0, 1 - ((y - HEAD[1]) / ry) ** 2));
  const a = (az * Math.PI) / 180;
  return [HEAD[0] + rx * k * Math.sin(a), y, HEAD[2] + rz * k * Math.cos(a)];
}

/** Outer extent of a reference outline at height v (first span's start to last span's end). */
function extent(view: SheetView, v: number): Point | undefined {
  const s = spans(outline(view, 'hair'), v);
  return s.length === 0 ? undefined : [(s[0] as Point)[0], (s.at(-1) as Point)[1]];
}

/** Lowest height the side view still has hair spans at (its tips run to 0.307). */
const SIDE_FLOOR = 0.32;
/** Back clumps hang this far inside the side view's back hair edge. */
const INSIDE = 0.04;

/** Back-clump centre-line depth at y: inside the side view's back edge, nearer the body toward the sides. */
function backDepth(y: number, side: number): number {
  const e = extent('right', Math.max(y, SIDE_FLOOR)) as Point;
  return -(e[1] - INSIDE) * (1 - 0.45 * side * side);
}

export interface Clump {
  readonly n: number;
  readonly name: string;
  readonly owner?: string;
  /** Root on the scalp: azimuth and height. */
  readonly root: { readonly az: number; readonly y: number };
  /** The flow line in 3D, root first, ending at its last tip's fork. */
  readonly flow: readonly P3[];
  /** Tip points (3D); a back clump splits into one or two pointed locks. */
  readonly tips: readonly P3[];
  readonly note: string;
}

/**
 * Back groups 4-8, each over a fraction of the back view's hair span (back view u = -x), its tips
 * the back outline's minima (u, y); clump 6 ends behind the back bow (its outline notch at 0.376).
 */
const BACK = [
  { n: 4, name: 'back outer right', az: -125, f: 0.9, tips: [[0.245, 0.38], [0.177, 0.296]] },
  { n: 5, name: 'back inner right', az: -152, f: 0.7, tips: [[0.134, 0.312], [0.103, 0.291]] },
  { n: 6, name: 'back centre', az: 180, f: 0.5, tips: [[0.03, 0.376]] },
  { n: 7, name: 'back inner left', az: 152, f: 0.3, tips: [[-0.042, 0.292], [-0.096, 0.291]] },
  { n: 8, name: 'back outer left', az: 125, f: 0.1, tips: [[-0.147, 0.315], [-0.235, 0.385]] },
] as const;
/** Back roots on the crown row; the flow passes these heights inside the back span. */
const BACK_ROOT_Y = 0.82;
const BACK_LEVELS = [0.7, 0.6, 0.5, 0.45] as const;
/** Height the back groups split into their locks (the back outline divides at 0.42). */
export const BACK_SPLIT = 0.42;

function backClump(c: (typeof BACK)[number]): Clump {
  const root = scalp(c.az, BACK_ROOT_Y);
  const along = (y: number): P3 => {
    const [lo, hi] = extent('back', y) as Point;
    const u = lo + c.f * (hi - lo);
    const side = (2 * c.f - 1) ** 2;
    return [-u, y, backDepth(y, side)];
  };
  const mean = c.tips.reduce((s, t) => s + t[0], 0) / c.tips.length;
  const side = (2 * c.f - 1) ** 2;
  const fork: P3 = [-mean, BACK_SPLIT, backDepth(BACK_SPLIT, side)];
  const tips = c.tips.map(([u, y]): P3 => [-u, y, backDepth(y, side)]);
  return {
    n: c.n,
    name: c.name,
    root: { az: c.az, y: BACK_ROOT_Y },
    flow: [root, ...BACK_LEVELS.map(along), fork],
    tips,
    note: `${c.tips.length === 1 ? 'one lock, ending behind the back bow' : `splits at ${BACK_SPLIT} into ${c.tips.length} pointed locks`}; tips at y ${c.tips.map((t) => t[1]).join(', ')}; ombre light below ${OMBRE_LIGHT}`,
  };
}

/** Front side locks over the shoulders (front view spans, their tips the front outline's minimum). */
const SIDES = [
  { n: 2, name: 'side lock right', az: -65, path: [[-0.15, 0.68, 0.04], [-0.15, 0.55, 0.02], [-0.19, 0.45, 0]], tip: [-0.207, 0.402, 0] },
  { n: 3, name: 'side lock left', az: 65, path: [[0.15, 0.68, 0.04], [0.15, 0.55, 0.02], [0.19, 0.46, 0]], tip: [0.2, 0.42, 0] },
] as const;
/** Side-lock roots: the temple row of hair.ts SIDE. */
const SIDE_ROOT_Y = 0.756;

function sideClump(c: (typeof SIDES)[number]): Clump {
  return {
    n: c.n,
    name: c.name,
    root: { az: c.az, y: SIDE_ROOT_Y },
    flow: [scalp(c.az, SIDE_ROOT_Y), ...c.path],
    tips: [c.tip],
    note: `from the temple over the shoulder, waving, to y ${c.tip[1]} (front outline); roots at |az| 60..75, outside the bangs`,
  };
}

const [AX0 = 0, AY0 = 0, AX1 = 0, AY1 = 0] = REF.views.front.parts.ahoge.bounds;
/** Ombre: dark down to the first stop, fully light from the last (materials.ts OMBRE_STOPS). */
const OMBRE_DARK = (OMBRE_STOPS[0] as readonly [number, number])[0];
const OMBRE_LIGHT = (OMBRE_STOPS.at(-1) as readonly [number, number])[0];

export const CLUMPS: readonly Clump[] = [
  {
    n: 1,
    name: 'bangs',
    owner: '87 (face session)',
    root: { az: 0, y: BANGS.grooves.top },
    flow: [scalp(0, BANGS.grooves.top), [0, BANGS.edge + 0.02, scalp(0, BANGS.edge)[2] + 0.01]],
    tips: [[0, BANGS.edge, scalp(0, BANGS.edge)[2] + 0.01]],
    note: `${BANGS.ends.length} fringe clumps between x ${BANGS.edges[0]} and ${BANGS.edges.at(-1)}; built by hair.ts BANGS (owner 87); roots |az| < 55`,
  },
  ...SIDES.map(sideClump),
  ...BACK.map(backClump),
  {
    n: 9,
    name: 'ahoge',
    root: { az: 0, y: 0.94 },
    flow: [scalp(0, 0.94), [(AX0 + AX1) / 2, (AY0 + AY1) / 2, 0]],
    tips: [[AX0, AY1, -0.01]],
    note: 'one crescent from the crown, curling forward; tip at the figure top (reference ahoge part)',
  },
];

// ---- the sheet ----------------------------------------------------------------------------

const project = (view: View, p: P3): Point => {
  const [u, v] = toView(view, p);
  return [u, v];
};
type Item = DrawingItem;

/** Projected points without consecutive repeats (a lock seen end-on collapses in that view). */
const distinct = (points: readonly Point[]): Point[] => points.filter((p, i) => i === 0 || Math.hypot(p[0] - (points[i - 1] as Point)[0], p[1] - (points[i - 1] as Point)[1]) > 1e-4);

/** The view a clump's points and note are drawn in (its tips' view); the top view shows every root. */
const primary = (c: Clump): SheetView => (c.n <= 3 || c.n === 9 ? 'front' : 'back');

function clumpItems(c: Clump): Item[] {
  const view = primary(c);
  const items: Item[] = [
    { id: `${c.n} root`, view, role: 'pivot', kind: 'point', at: project(view, c.flow[0] as P3), link: `clump:${c.n}:root`, basis: 'estimate' },
    { id: `${c.n} root (top)`, view: 'top', role: 'pivot', kind: 'point', at: project('top', c.flow[0] as P3), link: `clump:${c.n}:root`, basis: 'estimate' },
  ];
  for (const [k, t] of c.tips.entries())
    items.push({ id: `${c.n}.${k + 1}`, view, role: 'pivot', kind: 'point', at: project(view, t), link: `clump:${c.n}:tip-${k + 1}`, basis: c.n === 1 ? 'derived' : 'blueprint' });
  for (const v of VIEWS) {
    const flow = distinct(c.flow.map((p) => project(v, p)));
    if (flow.length >= 2) items.push({ id: `clump ${c.n} flow (${v})`, view: v, role: 'guide', kind: 'curve', curve: { kind: 'spline', points: flow }, link: `clump:${c.n}:flow`, basis: 'estimate' });
    for (const [k, t] of c.tips.entries()) {
      const lock = distinct([project(v, c.flow.at(-1) as P3), project(v, t)]);
      if (lock.length >= 2) items.push({ id: `clump ${c.n} lock ${k + 1} (${v})`, view: v, role: 'guide', kind: 'curve', curve: { kind: 'polyline', points: lock }, link: `clump:${c.n}:lock-${k + 1}`, basis: 'estimate' });
    }
  }
  items.push({
    id: `clump ${c.n} note`,
    view,
    role: 'construction',
    kind: 'note',
    refs: [`${c.n} root`],
    text: `${c.n} ${c.name}${c.owner === undefined ? '' : ` [owner ${c.owner}]`}: root az ${c.root.az} y ${c.root.y}; ${c.note}`,
  });
  return items;
}

const span = (id: string, view: SheetView, a: Point, b: Point, measure: 'dx' | 'dy', note: string): Item[] => [
  { id: `${id} a (${view})`, view, role: 'construction', kind: 'point', at: a, basis: 'blueprint' },
  { id: `${id} b (${view})`, view, role: 'construction', kind: 'point', at: b, basis: 'blueprint' },
  { id: `${id} (${view})`, view, role: 'construction', kind: 'dimension', measure, refs: [`${id} a (${view})`, `${id} b (${view})`], value: Math.abs(measure === 'dx' ? b[0] - a[0] : b[1] - a[1]), basis: 'blueprint', note },
];

/** Flare: the widest back hair span (reference back outline at 0.45). */
export const FLARE_Y = 0.45;
const flare = extent('back', FLARE_Y) as Point;
const tipY = Math.min(...CLUMPS.flatMap((c) => c.tips.map((t) => t[1])));

function sheetItems(): Item[] {
  const items: Item[] = [];
  for (const view of SHEET_VIEWS) items.push({ id: `hair outline (${view})`, view, role: 'guide', kind: 'curve', closed: true, curve: { kind: 'polyline', points: outline(view, 'hair') }, basis: 'blueprint' });
  for (const view of SHEET_VIEWS) {
    for (const [name, y] of [['ombre dark end', OMBRE_DARK], ['ombre light start', OMBRE_LIGHT], ['back split', BACK_SPLIT]] as const) {
      if (name === 'back split' && view === 'front') continue;
      const e = extent(view, y) ?? flare;
      items.push({ id: `${name} (${view})`, view, role: 'guide', kind: 'curve', curve: { kind: 'polyline', points: [[e[0] - 0.02, y], [e[1] + 0.02, y]] }, link: `band:${name.replaceAll(' ', '-')}`, basis: name === 'back split' ? 'blueprint' : 'estimate' });
    }
  }
  // Scalp ring at the back roots' height, in plan.
  const ring = Array.from({ length: 24 }, (_, i) => project('top', scalp(i * 15, BACK_ROOT_Y)));
  items.push({ id: 'scalp ring (top)', view: 'top', role: 'construction', kind: 'curve', closed: true, curve: { kind: 'polyline', points: ring }, basis: 'derived', note: `cap ellipsoid (hair.ts CAP) at y ${BACK_ROOT_Y}` });
  items.push({ id: 'roots parting (top)', view: 'top', role: 'construction', kind: 'note', refs: ['scalp ring (top)'], text: 'bangs |az| < 55 (87); side locks 60..75; back groups 125..180 on the crown row; ahoge at the crown' });
  items.push(...span('flare', 'back', [flare[0], FLARE_Y], [flare[1], FLARE_Y], 'dx', 'widest back span: the mass flares below the shoulders'));
  items.push(...span('hair length', 'back', [0.32, LANDMARK.crown as number], [0.32, tipY], 'dy', 'crown to the lowest tip (mid-thigh)'));
  items.push({
    id: 'sheet title',
    view: 'back',
    role: 'construction',
    kind: 'note',
    refs: [],
    text: `${HAIR_SHEET.id} rev ${HAIR_SHEET.revision}, parent ${HAIR_SHEET.parent}: ${CLUMPS.length} major clumps, ${CLUMPS.reduce((s, c) => s + c.tips.length, 0) - (CLUMPS[0]?.tips.length ?? 0)} tips outside the bangs; deep royal blue to sky blue from ${OMBRE_DARK} to ${OMBRE_LIGHT}; smooth quad ribbons, sharp only on lock borders`,
  });
  return items;
}

export const HAIR_DESIGN: Drawing = {
  name: `${HAIR_SHEET.id} rev ${HAIR_SHEET.revision} maid-whale hair design: clumps, roots, flow, ombre`,
  sources: [
    { title: 'maid-whale turnaround reference', note: `measured silhouettes and parts (reference.json, sha256 ${REF.source.sha256Prefix}); never copied` },
    { title: 'design-sheet conventions', note: 'numbered sheet ids with a parent sheet and a revision letter' },
  ],
  views: VIEWS.map((view) => ({ id: view, ortho: view })),
  items: [...sheetItems(), ...CLUMPS.flatMap(clumpItems)],
};

// ---- the check against a model -------------------------------------------------------------

/** The model's hair alone (tag `hair`), for silhouettes and spans. */
export function hairOnly(m: Model): Model {
  const h = model();
  h.append(m.snapshot());
  h.delete(sel.all().minus(sel.tag('hair')));
  return h;
}

/** Spans of the faces' projection on the horizontal line v = y of a view (exact, per triangle). */
export function projectedSpans(mesh: EditMesh, faces: readonly number[], view: SheetView, y: number): Point[] {
  const cuts: Point[] = [];
  for (const f of faces) {
    const p = mesh.faceVertices(f).map((v) => project(view, mesh.position(v) as unknown as P3));
    const xs: number[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i] as Point;
      const b = p[(i + 1) % p.length] as Point;
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    if (xs.length >= 2) cuts.push([Math.min(...xs), Math.max(...xs)]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of cuts) {
    const last = out.at(-1);
    if (last !== undefined && a <= last[1] + 0.003) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Heights the spans are compared at: the flare, the split, through the locks, near the tips. */
export const SPAN_LEVELS = [0.55, FLARE_Y, 0.4, 0.36, 0.32] as const;

export interface HairDesignMeasure {
  readonly iou: Readonly<Record<SheetView, number>>;
  /** Per view and level: the reference spans and the model's (merged within 3 mm). */
  readonly spans: readonly { readonly view: SheetView; readonly y: number; readonly reference: readonly Point[]; readonly model: readonly Point[] }[];
  /** Lowest hair point per view (the reference's lowest outline point beside it). */
  readonly lowest: Readonly<Record<SheetView, { readonly model: number; readonly reference: number }>>;
  /** Per designed tip: the 3D distance to the nearest hair vertex. */
  readonly tips: readonly { readonly clump: number; readonly tip: number; readonly at: P3; readonly distance: number }[];
  /** Hair labels per clump (`hair-clump-<n>...`); a clump the model does not build yet counts 0. */
  readonly clumps: Readonly<Record<number, number>>;
}

export function measureHairDesign(m: Model): HairDesignMeasure {
  const h = hairOnly(m);
  const mesh = h.editMesh;
  const faces = mesh.faces();
  const iou = {} as Record<SheetView, number>;
  const lowest = {} as Record<SheetView, { model: number; reference: number }>;
  const vs = mesh.vertices().map((v) => mesh.position(v) as unknown as P3);
  for (const view of SHEET_VIEWS) {
    const r = silhouetteIoU(h, view, outline(view, 'hair'), 0.005);
    if (!r.ok) throw r.error;
    iou[view] = r.value.iou;
    lowest[view] = { model: Math.min(...vs.map((p) => p[1])), reference: Math.min(...outline(view, 'hair').map((p) => p[1])) };
  }
  const levels = SHEET_VIEWS.flatMap((view) => SPAN_LEVELS.map((y) => ({ view, y, reference: spans(outline(view, 'hair'), y), model: projectedSpans(mesh, faces, view, y) })));
  const tips = CLUMPS.filter((c) => c.n !== 1).flatMap((c) =>
    c.tips.map((at, k) => ({ clump: c.n, tip: k + 1, at, distance: Math.min(...vs.map((p) => Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]))) })),
  );
  const labels = h.inspect().labels.map((l) => l.label);
  const clumps = Object.fromEntries(CLUMPS.map((c) => [c.n, labels.filter((l) => l.startsWith(`hair-clump-${c.n}`)).length]));
  return { iou, spans: levels, lowest, tips, clumps };
}
