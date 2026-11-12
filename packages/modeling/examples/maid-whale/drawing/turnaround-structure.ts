import { type Drawing, type DrawingItem, type EditMesh, type Model, ORTHO_VIEWS, silhouetteIoU, toView } from '@forgeax/engine-modeling';
import PLAN from '../facet-plan.json' with { type: 'json' };
import { PLAN_UNITS, type PlanUnit, planFaces } from '../plan-units.ts';
import { BOARD, LANDMARK, outline, type PartExtent, REF, type SheetView, SHEET_VIEWS, silhouette, spans } from '../reference.ts';
import { TURNAROUND } from '../turnaround.ts';

/**
 * Case C-200 (F2, maid-whale): the turnaround with structure lines and the G6 facet plan per
 * unit, as one kernel `Drawing` to check the G6 remodel against.
 *
 * - From `TURNAROUND`: the measured silhouettes, centre lines, the proportion grid in heads, the
 *   landmark guides, part outlines, trim borders, the facet swatches and plan notes.
 * - From `BOARD` (G1): the landmark and span dimensions, ids prefixed `G1 `.
 * - plane-change lines: where the torso and the skirt turn
 *   from their front (back) plane to their side plane, at the height-wise section ellipse
 *   point whose normal is 45 deg from the view axis. Links `plane:<zone>:<front|back>-<l|r>`;
 *   the front and right views of one link share y, so `drawingCurve3` lifts it.
 * - Facet-plan unit lines as `feature` items, link `unit:<part>/<unit>:<key>`: the skirt gores
 *   and hem rows and columns, the bang partings and tips, the back-hair split and lobe
 *   borders, the apron ruffle teeth and the trim band rows. A facet edge must run along each.
 * - One `construction` note per plan unit: faces, edge, counts and its unit lines.
 *
 * The model is checked with `measureTurnaroundStructure`: silhouette IoU per view and, per
 * unit line, the share of it a facet edge of the unit runs along. Every number derives from
 * reference.json, facet-plan.json or the turnaround; nothing reads the model to draw.
 */

type Point = readonly [number, number];
type Item = DrawingItem;
type Curve = Extract<Item, { kind: 'curve' }>;

const lm = (name: string): number => {
  const v = LANDMARK[name];
  if (v === undefined) throw new Error(`maid-whale structure: no landmark ${name}`);
  return v;
};
const partOf = (view: SheetView, name: string): PartExtent | undefined => (REF.views[view].parts as unknown as Record<string, PartExtent | undefined>)[name];
const bounds = (view: SheetView, name: string): readonly [number, number, number, number] => {
  const p = partOf(view, name);
  if (p === undefined) throw new Error(`maid-whale structure: no part ${name} in the ${view} view`);
  return p.bounds;
};

const polyline = (id: string, view: SheetView, role: Item['role'], points: readonly Point[], extra: Partial<Curve> = {}): Item =>
  ({ id, view, role, kind: 'curve', curve: { kind: 'polyline', points }, basis: 'derived', ...extra }) as Item;

/** A unit line's link. */
export const unitLink = (part: string, unit: string, key: string) => `unit:${part}/${unit}:${key}`;
const unitOf = (link: string | undefined): string | undefined => (link?.startsWith('unit:') ? link.slice(5, link.lastIndexOf(':')) : undefined);

// ---- TURNAROUND items re-read as unit lines ----------------------------------------------

/** TURNAROUND structure items that are a plan unit's lines: [id pattern, part/unit, key]. */
const UNIT_ITEMS: readonly [RegExp, string, (m: RegExpMatchArray) => string][] = [
  [/^gore border (\d+) \((\w+)\)$/, 'skirt/gores', (m) => `gore-${m[1]}`],
  [/^hem band row border \((\w+)\)$/, 'skirt/hem', () => 'row-1'],
  [/^bang parting (\d+) \(front\)$/, 'bangs/clumps', (m) => `parting-${m[1]}`],
  [/^bang tips \(front\)$/, 'bangs/clumps', () => 'tips'],
  [/^back hair split \(back\)$/, 'back-hair/outer-lobes', () => 'split'],
  [/^back lobe border (\d+) \(back\)$/, 'back-hair/outer-lobes', (m) => `border-${m[1]}`],
  [/^apron ruffle teeth \(front\)$/, 'apron/ruffle', () => 'teeth'],
];

function fromTurnaround(): Item[] {
  return TURNAROUND.items.map((item): Item => {
    if (item.kind !== 'curve') return item;
    for (const [pattern, unit, key] of UNIT_ITEMS) {
      const m = item.id.match(pattern);
      if (m === null) continue;
      const [part, name] = unit.split('/') as [string, string];
      return { ...item, role: 'feature', link: unitLink(part, name, key(m)) };
    }
    return item;
  });
}

/** BOARD's dimensions and their guide points, ids prefixed `G1 ` (its silhouettes are TURNAROUND's). */
function fromBoard(): Item[] {
  const rename = (id: string) => `G1 ${id}`;
  return BOARD.items
    .filter((i) => i.kind === 'point' || i.kind === 'dimension')
    .map((i): Item => (i.kind === 'dimension' ? { ...i, id: rename(i.id), refs: i.refs.map(rename) } : { ...i, id: rename(i.id) }));
}

// ---- plane-change lines ---------------------------------------------------------------

/** A body section as an ellipse: front half width a about xc, side half depth b about zc (the right view's u is -z). */
interface Ring {
  readonly y: number;
  readonly xc: number;
  readonly a: number;
  readonly zc: number;
  readonly b: number;
}

/** The outer extent of the dress outline of a view at height y (its holes are arms and sleeves). */
function envelope(view: SheetView, y: number): readonly [number, number] {
  const s = spans(outline(view, 'dress'), y);
  if (s.length === 0) throw new Error(`maid-whale structure: the ${view} dress outline misses y ${y}`);
  return [Math.min(...s.map((x) => x[0])), Math.max(...s.map((x) => x[1]))];
}

/** The ring measured at height `at`, placed at height y. */
function ring(y: number, at = y): Ring {
  const [f0, f1] = envelope('front', at);
  const [s0, s1] = envelope('right', at);
  return { y, xc: (f0 + f1) / 2, a: (f1 - f0) / 2, zc: -(s0 + s1) / 2, b: (s1 - s0) / 2 };
}

/**
 * Body rings from the outer extent of the dress outlines at heights where no hand or cuff
 * crosses them (the hands widen the front skirt from 0.30 to 0.42): the collar's bottom, the
 * waist landmark and the hem band's top. Sections between them interpolate linearly (a
 * low-poly bell and torso have straight generators); the waistband is a short cylinder, so
 * its top and bottom take the waist ring.
 */
const RINGS = {
  collar: () => ring(bounds('front', 'collar')[1]),
  waistTop: () => ring(bounds('front', 'waistband')[3], lm('waist')),
  waistBottom: () => ring(bounds('front', 'waistband')[1], lm('waist')),
  hemBand: () => ring(lm('hem-band-top')),
  hemMid: () => ring((lm('hem') + lm('hem-band-top')) / 2),
} as const;

/** Zones whose plane change is drawn: the torso (waistband to collar), the skirt (hem band to waistband). */
const ZONES = {
  torso: { from: RINGS.waistTop, to: RINGS.collar },
  skirt: { from: RINGS.hemBand, to: RINGS.waistBottom },
} as const;
export type PlaneZone = keyof typeof ZONES;
const SAMPLES = 4;

const lerpRing = (p: Ring, q: Ring, y: number): Ring => {
  const t = (y - p.y) / (q.y - p.y);
  const l = (k: 'xc' | 'a' | 'zc' | 'b') => p[k] + (q[k] - p[k]) * t;
  return { y, xc: l('xc'), a: l('a'), zc: l('zc'), b: l('b') };
};

/**
 * The front/side plane change of a ring is the point whose normal is 45 deg from +z:
 * tan(theta) = a / b, at x = xc +- a sin(theta), z = zc +- b cos(theta).
 */
function planeLines(): Item[] {
  const out: Item[] = [];
  for (const [zone, z] of Object.entries(ZONES) as [PlaneZone, (typeof ZONES)[PlaneZone]][]) {
    const [r0, r1] = [z.from(), z.to()];
    const rings = Array.from({ length: SAMPLES + 1 }, (_, i) => lerpRing(r0, r1, r0.y + ((r1.y - r0.y) * i) / SAMPLES));
    const at = (fn: (s: Ring, t: number) => number): Point[] => rings.map((s): Point => [fn(s, Math.atan2(s.a, s.b)), s.y]);
    const line = (id: string, view: SheetView, key: string, points: Point[], note: string) =>
      polyline(`${zone} ${id} (${view})`, view, 'structure', points, { link: `plane:${zone}:${key}`, basis: 'derived', tolerance: 0.005, note });
    const why = `the ${zone}'s plane change, where its section's normal is 45 deg from the view axis (sections between rings of the dress outlines' outer extent)`;
    out.push(
      line('front-left break', 'front', 'front-l', at((s, t) => s.xc + s.a * Math.sin(t)), why),
      line('front-right break', 'front', 'front-r', at((s, t) => s.xc - s.a * Math.sin(t)), why),
      line('front-left break', 'right', 'front-l', at((s, t) => -(s.zc + s.b * Math.cos(t))), why),
      line('back-left break', 'right', 'back-l', at((s, t) => -(s.zc - s.b * Math.cos(t))), why),
      line('back-left break', 'back', 'back-l', at((s, t) => -(s.xc + s.a * Math.sin(t))), why),
      line('back-right break', 'back', 'back-r', at((s, t) => -(s.xc - s.a * Math.sin(t))), why),
    );
  }
  return out;
}

// ---- facet-plan unit lines ---------------------------------------------------------------

const planUnit = (part: string, unit: string): PlanUnit => {
  const u = PLAN_UNITS.find((x) => x.part === part && x.name === unit);
  if (u === undefined) throw new Error(`maid-whale facet plan: no unit ${part}/${unit}`);
  return u;
};
const rawUnit = (part: string, unit: string): Record<string, unknown> =>
  ((PLAN.parts.find((p) => p.name === part) as { units?: Record<string, unknown>[] } | undefined)?.units ?? []).find((u) => u.name === unit) ?? {};

/**
 * The hem band's block columns (facet-plan skirt/hem `columnWidth`): column borders every
 * `columnWidth` of the band's mid-height ellipse perimeter, drawn on the near half of the front
 * view from the hem to the band top.
 */
function hemColumns(): Item[] {
  const width = rawUnit('skirt', 'hem').columnWidth as number;
  const [y0, y1] = [lm('hem'), lm('hem-band-top')];
  const mid = RINGS.hemMid();
  // Ramanujan's ellipse perimeter.
  const h = ((mid.a - mid.b) / (mid.a + mid.b)) ** 2;
  const perimeter = Math.PI * (mid.a + mid.b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  const n = Math.round(perimeter / width);
  const out: Item[] = [];
  const ys = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  for (let k = 0; k < n; k++) {
    const az = (2 * Math.PI * (k + 0.5)) / n;
    if (Math.cos(az) <= 0.05) continue;
    const pts = ys.map((y): Point => [mid.xc + mid.a * Math.sin(az), y]);
    if (pts.length >= 2)
      out.push(
        polyline(`hem column border ${k} (front)`, 'front', 'feature', pts, {
          link: unitLink('skirt', 'hem', `column-${k}`),
          basis: 'estimate',
          tolerance: 0.004,
          note: `${n} block columns of about ${width} m around the hem band (perimeter ${perimeter.toFixed(3)} m of the hem band's mid-height ring, from the dress outlines)`,
        }),
      );
  }
  return out;
}

/** Trim band rows (facet-plan trims cuffs/socks/collar): the inner row borders across each band's front bounds. */
function trimRows(): Item[] {
  const bands: readonly { unit: string; parts: readonly string[]; rows: number; v?: readonly [number, number] }[] = [
    { unit: 'cuffs', parts: ['cuff-l', 'cuff-r'], rows: 3 },
    // Socks: 3 rows from 0.075 (inside the shoe) to the sock top (facet-plan trims/socks).
    { unit: 'socks', parts: ['sock-l', 'sock-r'], rows: 3, v: [0.075, lm('sock-top')] },
  ];
  return [...bands.flatMap((b) =>
    b.parts.flatMap((name) => {
      const [u0, v0, u1, v1] = bounds('front', name);
      const [lo, hi] = b.v ?? [v0, v1];
      return Array.from({ length: b.rows - 1 }, (_, k): Item => {
        const v = lo + ((hi - lo) * (k + 1)) / b.rows;
        return polyline(`${name} row border ${k + 1} (front)`, 'front', 'feature', [[u0, v], [u1, v]], {
          link: unitLink('trims', b.unit, `${name}-row-${k + 1}`),
          basis: 'estimate',
          tolerance: 0.004,
          note: `${b.rows} rows (facet-plan trims/${b.unit})`,
        });
      });
    }),
  ), collarRow()];
}

/**
 * The G6 collar's inner row border (facet-plan trims/collar, 2 rows of `COLLAR_G6` columns):
 * a tilted ring through the band's middle-row vertices at azimuth 18 + 36 j deg about the neck
 * axis. Its heights and front-view half extent are the G3 collar's (garments.ts facetCollar
 * lays the band on the G3 collar sheet, `COLLAR_G6.offset` off the collar region), narrower
 * than the reference collar bounds since the G3 collar sits inside the bib frills. Measured by
 * the F2 builder on the G6 model (2026-10-25); the ring's front view is R sin(azimuth).
 */
export const COLLAR_ROW = {
  /** Front-view half extent (m) of the ring at the sides (azimuth +-90). */
  halfWidth: 0.048,
  /** Ring height (m) by azimuth (deg) of its vertices on the near half. */
  heights: [
    [18, 0.593],
    [54, 0.599],
    [90, 0.6025],
  ],
  /** The collar's whole front extent, x and y (m). */
  extent: { x: 0.052, y: [0.572, 0.616] },
} as const;

function collarRow(): Item {
  const half = COLLAR_ROW.heights.map(([az, y]): Point => [COLLAR_ROW.halfWidth * Math.sin((az * Math.PI) / 180), y]);
  const points = [...half.map(([u, y]): Point => [-u, y]).reverse(), ...half];
  return polyline('collar row border 1 (front)', 'front', 'feature', points, {
    link: unitLink('trims', 'collar', 'collar-row-1'),
    basis: 'derived',
    tolerance: 0.004,
    note: `tilted ring between the 2 rows (facet-plan trims/collar): the G3 collar sheet under garments.ts facetCollar, ${COLLAR_ROW.extent.y[0]}-${COLLAR_ROW.extent.y[1]} m high, x +-${COLLAR_ROW.extent.x}`,
  });
}

/** One note per plan unit: its faces, edge and counts, referring to its unit lines. */
function unitNotes(items: readonly Item[]): Item[] {
  return PLAN_UNITS.map((u): Item => {
    const key = `${u.part}/${u.name}`;
    const lines = items.filter((i) => unitOf(i.link) === key).map((i) => i.id);
    const swatch = TURNAROUND.items.find((i) => i.kind === 'curve' && i.id.startsWith(`facet ${key} (`));
    const raw = rawUnit(u.part, u.name);
    const text = [
      `${u.faces}${u.except === undefined ? '' : ` minus ${u.except}`}`,
      u.edge === undefined ? 'built as facets' : `edge ${u.edge} m`,
      u.count === undefined ? undefined : `${u.count} units`,
      raw.columns === undefined ? undefined : `columns ${raw.columns}`,
      raw.rows === undefined ? undefined : `rows ${raw.rows}`,
      u.facetsPerUnit === undefined ? undefined : `${u.facetsPerUnit[0]}-${u.facetsPerUnit[1]} facets a unit`,
      `${lines.length} unit lines`,
      u.pending === undefined ? undefined : 'pending (not built)',
      u.tilingOpen === undefined ? undefined : 'mesh-quality tiling open',
      u.densityGap === undefined ? undefined : 'density gap recorded',
    ]
      .filter((x) => x !== undefined)
      .join('; ');
    return { id: `unit ${key}`, view: (swatch?.view as SheetView | undefined) ?? 'front', role: 'construction', kind: 'note', refs: [...(swatch === undefined ? [] : [swatch.id]), ...lines].slice(0, 40), text };
  });
}

const unitLines = [...hemColumns(), ...trimRows()];
const turnaround = fromTurnaround();

export const TURNAROUND_STRUCTURE: Drawing = {
  name: 'C-200 maid-whale turnaround: structure lines and the G6 facet plan per unit',
  sources: [...(TURNAROUND.sources ?? []), { title: 'stylized-character proportion and plane-change conventions' }],
  views: TURNAROUND.views,
  items: [...turnaround, ...fromBoard(), ...planeLines(), ...unitLines, ...unitNotes([...turnaround, ...unitLines])],
};

// ---- the check against a model -----------------------------------------------------------

/** How close (m) a facet edge must run to a unit line, and how parallel (deg), to count along it. */
export const ALONG = { distance: 0.004, angle: 25, reach: 0.05, step: 0.005 } as const;

export type Segment = readonly [Point, Point];

/**
 * Edges of the selected faces projected into an ortho view, kept where a selected face beside
 * them faces the viewer (the near side, ignoring occlusion by other parts).
 */
export function projectedEdges(mesh: EditMesh, faces: readonly number[], view: SheetView): Segment[] {
  const toward = ORTHO_VIEWS[view].toward;
  const chosen = new Set(faces);
  const facing = new Map<number, boolean>();
  const faces3 = (f: number): boolean => {
    let v = facing.get(f);
    if (v === undefined) {
      const p = mesh.faceVertices(f).map((x) => mesh.position(x));
      let [nx, ny, nz] = [0, 0, 0];
      for (let i = 0; i < p.length; i++) {
        const a = p[i] as readonly number[];
        const b = p[(i + 1) % p.length] as readonly number[];
        nx += ((a[1] as number) - (b[1] as number)) * ((a[2] as number) + (b[2] as number));
        ny += ((a[2] as number) - (b[2] as number)) * ((a[0] as number) + (b[0] as number));
        nz += ((a[0] as number) - (b[0] as number)) * ((a[1] as number) + (b[1] as number));
      }
      v = nx * toward[0] + ny * toward[1] + nz * toward[2] > 0;
      facing.set(f, v);
    }
    return v;
  };
  const seen = new Set<number>();
  const out: Segment[] = [];
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const e = h >> 1;
      if (seen.has(e)) continue;
      seen.add(e);
      const g = mesh.hFace[h ^ 1] as number;
      if (!faces3(f) && !(chosen.has(g) && faces3(g))) continue;
      const [a, b] = mesh.edgeVertices(e).map((v) => toView(view, mesh.position(v))) as unknown as [readonly number[], readonly number[]];
      out.push([
        [a[0] as number, a[1] as number],
        [b[0] as number, b[1] as number],
      ]);
    }
  }
  return out;
}

/** Resample a polyline every `step`, with each sample's unit tangent. */
function samples(points: readonly Point[], step: number): { p: Point; t: Point }[] {
  const out: { p: Point; t: Point }[] = [];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1] as Point, points[i] as Point];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const t: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push({ p: [a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n], t });
  }
  return out;
}

function segmentDistance(p: Point, [a, b]: Segment): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const s = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + s * dx), p[1] - (a[1] + s * dy));
}

export interface AlongMeasure {
  /** Samples of the drawn line(s), every `ALONG.step`. */
  readonly samples: number;
  /** Share of the samples a facet edge runs along (within `ALONG.distance`, `ALONG.angle`). */
  readonly along: number;
  /** Distance to the nearest parallel facet edge (within `ALONG.reach`): median and 90th percentile, m. */
  readonly p50: number;
  readonly p90: number;
}

const percentile = (xs: number[], q: number) => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};

/** How far a set of drawn lines has a facet edge running along it. */
export function alongEdges(lines: readonly (readonly Point[])[], edges: readonly Segment[]): AlongMeasure {
  const cos = Math.cos((ALONG.angle * Math.PI) / 180);
  const all = lines.flatMap((l) => samples(l, ALONG.step));
  // Bucket the edges on a grid of `reach` for the near search.
  const cell = ALONG.reach;
  const grid = new Map<string, Segment[]>();
  for (const s of edges) {
    const [i0, i1] = [Math.floor(Math.min(s[0][0], s[1][0]) / cell), Math.floor(Math.max(s[0][0], s[1][0]) / cell)];
    const [j0, j1] = [Math.floor(Math.min(s[0][1], s[1][1]) / cell), Math.floor(Math.max(s[0][1], s[1][1]) / cell)];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) grid.set(`${i},${j}`, [...(grid.get(`${i},${j}`) ?? []), s]);
  }
  const near: number[] = [];
  let along = 0;
  for (const { p, t } of all) {
    let best = Number.POSITIVE_INFINITY;
    const [i, j] = [Math.floor(p[0] / cell), Math.floor(p[1] / cell)];
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const s of grid.get(`${i + di},${j + dj}`) ?? []) {
          const [dx, dy] = [s[1][0] - s[0][0], s[1][1] - s[0][1]];
          const len = Math.hypot(dx, dy);
          if (len === 0 || Math.abs((dx * t[0] + dy * t[1]) / len) < cos) continue;
          best = Math.min(best, segmentDistance(p, s));
        }
    if (best <= ALONG.reach) near.push(best);
    if (best <= ALONG.distance) along++;
  }
  return { samples: all.length, along: all.length === 0 ? 0 : along / all.length, p50: percentile(near, 0.5), p90: percentile(near, 0.9) };
}

/** Sideways shift (m) of the control lines: about half a facet of the finest unit here. */
export const CONTROL_SHIFT = 0.012;

/**
 * `alongEdges` of the lines and its chance level: the mean share along the same lines shifted
 * +-`CONTROL_SHIFT` across the view (u). A dense tiling has some edges along any line; a unit
 * line the model builds as structure scores well above its control.
 */
function alongWithControl(lines: readonly (readonly Point[])[], edges: readonly Segment[]): AlongMeasure & { readonly control: number } {
  const shift = (du: number) => lines.map((l) => l.map((p): Point => [p[0] + du, p[1]]));
  const control = (alongEdges(shift(CONTROL_SHIFT), edges).along + alongEdges(shift(-CONTROL_SHIFT), edges).along) / 2;
  return { ...alongEdges(lines, edges), control };
}

/** The faces each plane zone's line belongs to. */
const ZONE_FACES: Readonly<Record<PlaneZone, string>> = { torso: 'tag:bodice', skirt: 'tag:skirt-gore-*' };

export interface StructureMeasure {
  /** Silhouette IoU per view (drawn sheet silhouette against the model's projection, 5 mm cells). */
  readonly iou: Readonly<Record<SheetView, number>>;
  /** Per plan unit with unit lines, per view; `control` is the share along the lines shifted +-CONTROL_SHIFT. */
  readonly units: readonly ({ readonly unit: string; readonly view: SheetView; readonly lines: number; readonly control: number } & AlongMeasure)[];
  /** Per plane-change zone and view. */
  readonly planes: readonly ({ readonly zone: PlaneZone; readonly view: SheetView; readonly lines: number; readonly control: number } & AlongMeasure)[];
}

/** Lines of a resolved-free drawing: polyline curve items only (all items here are polylines). */
const linePoints = (i: Item): readonly Point[] => (i.kind === 'curve' && 'points' in i.curve ? (i.curve.points as readonly Point[]) : []);

/** The turnaround's structure against a model: silhouette IoU per view and facet edges along the unit and plane lines. */
export function measureTurnaroundStructure(m: Model, drawing: Drawing = TURNAROUND_STRUCTURE): StructureMeasure {
  const iou = {} as Record<SheetView, number>;
  for (const view of SHEET_VIEWS) {
    const r = silhouetteIoU(m, view, silhouette(view), 0.005);
    if (!r.ok) throw r.error;
    iou[view] = r.value.iou;
  }
  const mesh = m.editMesh;
  const edgeCache = new Map<string, Segment[]>();
  const edgesOf = (spec: string, except: string | undefined, view: SheetView) => {
    const key = `${spec}|${except}|${view}`;
    let e = edgeCache.get(key);
    if (e === undefined) {
      const s = except === undefined ? planFaces(m, spec) : planFaces(m, spec).minus(planFaces(m, except));
      e = projectedEdges(mesh, s.evaluate(mesh), view);
      edgeCache.set(key, e);
    }
    return e;
  };
  const units: StructureMeasure['units'][number][] = [];
  const byUnit = new Map<string, Item[]>();
  for (const i of drawing.items) {
    const u = unitOf(i.link);
    if (u === undefined || i.kind !== 'curve') continue;
    const k = `${u}|${i.view}`;
    byUnit.set(k, [...(byUnit.get(k) ?? []), i]);
  }
  for (const [k, items] of byUnit) {
    const [unit, view] = k.split('|') as [string, SheetView];
    const [part, name] = unit.split('/') as [string, string];
    const u = planUnit(part, name);
    units.push({ unit, view, lines: items.length, ...alongWithControl(items.map(linePoints), edgesOf(u.faces, u.except, view)) });
  }
  const planes: StructureMeasure['planes'][number][] = [];
  for (const zone of Object.keys(ZONES) as PlaneZone[]) {
    for (const view of SHEET_VIEWS) {
      const items = drawing.items.filter((i) => i.view === view && i.link?.startsWith(`plane:${zone}:`));
      if (items.length === 0) continue;
      planes.push({ zone, view, lines: items.length, ...alongWithControl(items.map(linePoints), edgesOf(ZONE_FACES[zone], undefined, view)) });
    }
  }
  return { iou, units, planes };
}
