import type { Drawing, DrawingItem } from '@forgeax/engine-modeling';
import PLAN from './facet-plan.json' with { type: 'json' };
import { TRUNK } from './body.ts';
import { BANGS } from './hair.ts';
import { LANDMARK, outline, type PartExtent, REF, type SheetView, SHEET_VIEWS, silhouette, spans } from './reference.ts';

/**
 * Case C-200 (F2, maid-whale): the turnaround as a design drawing (design drawing). Three ortho
 * views (front, right = the sheet's SIDE with u = -z, back) share one proportion grid in head
 * units and one set of horizontal landmark guides (the turnaround alignment rule: a landmark
 * has the same height in every view). Structure lines and part outlines are drawn where the
 * data gives 2D positions (reference.json outlines and part bounds, the bang edges, the
 * facet plan's gore count and ruffle teeth); the facet plan's per-unit target facets are
 * swatches (one equilateral facet at the unit's target edge) with notes and recorded values.
 * Every number is read from reference.json, facet-plan.json or the builder constants.
 */

type Point = readonly [number, number];
type Item = DrawingItem;

const lm = (name: string): number => {
  const v = LANDMARK[name];
  if (v === undefined) throw new Error(`maid-whale turnaround: no landmark ${name}`);
  return v;
};

/** Part bounds of a view, or undefined when the view does not show the part. */
function partOf(view: SheetView, name: string): PartExtent | undefined {
  return (REF.views[view].parts as unknown as Record<string, PartExtent | undefined>)[name];
}

function outlineNames(view: SheetView): string[] {
  return Object.keys(REF.views[view].outlines);
}

/** Head unit (crown - chin), heads to the crown (the sheet's `headsTall`) and overall (to the ahoge tip). */
export function headUnits(): { readonly head: number; readonly headsTall: number; readonly headsOverall: number } {
  const head = lm('crown') - lm('chin');
  return { head, headsTall: lm('crown') / head, headsOverall: lm('ahoge-tip') / head };
}

/** Landmarks drawn as guides across all views; the per-view tail tips (pitch-biased, R-2) are not shared heights. */
const SHARED_LANDMARKS = REF.landmarks.filter((l) => !l.name.startsWith('tail-tip-'));

const MARGIN = 0.05;
/** The u extent of a view's guides: its silhouette plus a margin. */
function viewSpan(view: SheetView): [number, number] {
  const us = silhouette(view).map((p) => p[0]);
  return [Math.min(...us) - MARGIN, Math.max(...us) + MARGIN];
}

const hline = (id: string, view: SheetView, role: Item['role'], v: number, u0: number, u1: number, extra: Partial<Item> = {}): Item =>
  ({ id, view, role, kind: 'curve', curve: { kind: 'polyline', points: [[u0, v], [u1, v]] }, basis: 'derived', ...extra }) as Item;

const polyline = (id: string, view: SheetView, role: Item['role'], points: readonly Point[], extra: Partial<Item> = {}): Item =>
  ({ id, view, role, kind: 'curve', curve: { kind: 'polyline', points }, basis: 'derived', ...extra }) as Item;

/** The widest inside span of a closed outline at height v. */
function widest(points: readonly Point[], v: number): [number, number] | undefined {
  return spans(points, v).sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
}

/** Lowest v of a closed outline on the vertical line at u. */
function lowestAt(points: readonly Point[], u: number): number | undefined {
  const swapped = points.map((p): Point => [p[1], p[0]]);
  const s = spans(swapped, u);
  return s.length === 0 ? undefined : Math.min(...s.map((x) => x[0]));
}

/** Proportion grid: ground + k head for k = 0..ceil(total / head), the same heights in every view. */
function grid(): Item[] {
  const { head } = headUnits();
  const n = Math.ceil(lm('ahoge-tip') / head);
  return SHEET_VIEWS.flatMap((view) => {
    const [u0, u1] = viewSpan(view);
    return Array.from({ length: n + 1 }, (_, k) => hline(`grid ${k} H (${view})`, view, 'guide', k * head, u0, u1, { link: `grid:${k}` }));
  });
}

/** Grid labels on the right of the back view, landmark labels on the left of the front view. */
function labels(): Item[] {
  const { head } = headUnits();
  const n = Math.ceil(lm('ahoge-tip') / head);
  const [, backRight] = viewSpan('back');
  const [frontLeft] = viewSpan('front');
  return [
    ...Array.from({ length: n + 1 }, (_, k): Item => ({ id: `${k} H = ${(k * head).toFixed(3)} m`, view: 'back', role: 'guide', kind: 'point', at: [backRight, k * head] })),
    ...SHARED_LANDMARKS.map((l): Item => ({ id: `${l.name} ${l.v.toFixed(3)} m = ${(l.v / head).toFixed(2)} H`, view: 'front', role: 'guide', kind: 'point', at: [frontLeft - 0.17, l.v] })),
  ];
}

function landmarkGuides(): Item[] {
  return SHEET_VIEWS.flatMap((view) => {
    const [u0, u1] = viewSpan(view);
    return SHARED_LANDMARKS.map((l) =>
      hline(`${l.name} (${view})`, view, 'guide', l.v, u0, u1, { link: `landmark:${l.name}`, basis: 'blueprint', note: `${l.note} (measured in the ${l.view} view)` }),
    );
  });
}

/** Tail tips: one per view at its own height (the sheet's pitch, R-2), so they are not linked guides. */
function tailTips(): Item[] {
  return REF.landmarks
    .filter((l) => l.name.startsWith('tail-tip-'))
    .map((l): Item => {
      const view = l.view as SheetView;
      const tail = partOf(view, 'fluke') as PartExtent;
      return { id: `${l.name} (pitch-biased, R-2)`, view, role: 'construction', kind: 'point', at: [tail.center[0], l.v], basis: 'blueprint', note: l.note };
    });
}

/** Centre line in front and back; the leg axis (u = 0) in the side view. Same vertical extent in every view. */
function centreLines(): Item[] {
  const { head } = headUnits();
  const top = Math.ceil(lm('ahoge-tip') / head) * head + MARGIN;
  return SHEET_VIEWS.map((view): Item =>
    polyline(view === 'right' ? 'leg axis (right)' : `centre line (${view})`, view, 'construction', [[0, -MARGIN], [0, top]], { link: 'axis' }),
  );
}

function silhouettes(): Item[] {
  return SHEET_VIEWS.map((view): Item => ({ id: `${view} silhouette`, view, role: 'silhouette', kind: 'curve', closed: true, curve: { kind: 'polyline', points: silhouette(view) }, basis: 'blueprint' }));
}

/** Measured part outlines (calibrate OUTLINES) as structure curves; the same part name links views. */
function partOutlines(): Item[] {
  const shared = (name: string) => SHEET_VIEWS.filter((v) => outlineNames(v).includes(name)).length > 1;
  return SHEET_VIEWS.flatMap((view) =>
    outlineNames(view).map((name): Item => ({
      id: `${name} outline (${view})`,
      view,
      role: 'structure',
      kind: 'curve',
      closed: true,
      curve: { kind: 'polyline', points: outline(view, name) },
      basis: 'blueprint',
      ...(shared(name) ? { link: `outline:${name}` } : {}),
    })),
  );
}

/** Trim band borders (collar, waistband, cuffs, socks, the white hem band) at their part bounds. */
const TRIMS = ['collar', 'waistband', 'cuff-l', 'cuff-r', 'sock-l', 'sock-r', 'socks', 'skirt-hem'] as const;
function trimBorders(): Item[] {
  return SHEET_VIEWS.flatMap((view) =>
    TRIMS.flatMap((name) => {
      const p = partOf(view, name);
      if (p === undefined) return [];
      const [u0, v0, u1, v1] = p.bounds;
      return [
        hline(`${name} top (${view})`, view, 'structure', v1, u0, u1, { link: `trim:${name}:top`, basis: 'blueprint' }),
        hline(`${name} bottom (${view})`, view, 'structure', v0, u0, u1, { link: `trim:${name}:bottom`, basis: 'blueprint' }),
      ];
    }),
  );
}

type FacetPart = (typeof PLAN.parts)[number];
const planPart = (name: string): FacetPart => {
  const found = PLAN.parts.find((p) => p.name === name);
  if (found === undefined) throw new Error(`maid-whale facet plan: no part ${name}`);
  return found;
};
type FacetUnit = { readonly name: string; readonly faces: string; readonly edge: number; readonly count?: number; readonly split?: number; readonly columns?: number | string; readonly rows?: number | string };
const unitsOf = (p: FacetPart): readonly FacetUnit[] => ('units' in p ? (p.units as readonly FacetUnit[]) : []);
const planUnit = (part: string, unit: string): FacetUnit => {
  const found = unitsOf(planPart(part)).find((u) => u.name === unit);
  if (found === undefined) throw new Error(`maid-whale facet plan: no unit ${part}/${unit}`);
  return found;
};

/** The skirt's axis: x 0 and the depth centre of the trunk's waist ring (body.ts TRUNK), as `cutSkirtGores` takes it. */
export function skirtAxisZ(): number {
  const ring = TRUNK.find((r) => r[0] === lm('waist'));
  if (ring === undefined) throw new Error('maid-whale turnaround: no trunk ring at the waist');
  return (ring[2] + ring[3]) / 2;
}

/** Superellipse exponent of the skirt's section (garments.ts bell rows: |x/a|^n + |z/b|^n = 1). */
export const SKIRT_SECTION_EXPONENT = 2.6;

/** A skirt section about the axis: half widths toward -x and +x, depths toward +z (front) and -z (back). */
interface SkirtRing {
  readonly left: number;
  readonly right: number;
  readonly front: number;
  readonly back: number;
}

/** The outer extent of a view's dress outline at height y. */
function dressEnvelope(view: SheetView, y: number): readonly [number, number] {
  const s = spans(outline(view, 'dress'), y);
  if (s.length === 0) throw new Error(`maid-whale turnaround: the ${view} dress outline misses y ${y}`);
  return [Math.min(...s.map((x) => x[0])), Math.max(...s.map((x) => x[1]))];
}

/**
 * The skirt section the sheet gives at height y, measured from the axis on its unobstructed
 * sides and mirrored: the front view's -x side (the tail joins the +x side) and the right
 * view's front edge (the tail and the back bow cover the back). The bell is symmetric in x and,
 * as built, front to back.
 */
function sheetRing(y: number): SkirtRing {
  const z = skirtAxisZ();
  const [f0] = dressEnvelope('front', y);
  const [s0] = dressEnvelope('right', y);
  const [half, depth] = [-f0, -s0 - z];
  return { left: half, right: half, front: depth, back: depth };
}

/**
 * The skirt section at height y. The sheet gives it below the hands (up to the hand-bottom
 * landmark) and at the waist; between them the hands, cuffs, apron edge and back bow cover the
 * skirt's sides, so the section runs straight from the hand-bottom ring to the waist ring (the
 * bell's generators are straight).
 */
function skirtRing(y: number): SkirtRing {
  const clear = lm('hand-bottom');
  if (y <= clear) return sheetRing(y);
  const [lo, hi] = [sheetRing(clear), sheetRing(lm('waist'))];
  const t = (y - clear) / (lm('waist') - clear);
  const l = (k: keyof SkirtRing) => lo[k] + (hi[k] - lo[k]) * t;
  return { left: l('left'), right: l('right'), front: l('front'), back: l('back') };
}

/** Where the half-plane at azimuth `az` (radians, from +z toward +x) meets the section: [x, z] about the axis. */
function onSection(r: SkirtRing, az: number): readonly [number, number] {
  const [s, c] = [Math.sin(az), Math.cos(az)];
  const a = s >= 0 ? r.right : r.left;
  const b = c >= 0 ? r.front : r.back;
  const n = SKIRT_SECTION_EXPONENT;
  const radius = (Math.abs(s / a) ** n + Math.abs(c / b) ** n) ** (-1 / n);
  return [radius * s, radius * c];
}

/**
 * Skirt gore borders (the design rule of facet-plan skirt/gores): `count` gores, borders on the
 * half-planes at equal azimuth 360 k / count (from +z toward +x) about the skirt's axis (x 0,
 * z `skirtAxisZ`), between the waistband and the hem band, on the sheet's skirt section
 * (`skirtRing`, a superellipse per quadrant). Front: u = x; right: u = -(z + axis); back: u = -x.
 * Only the near half is drawn.
 */
function goreBorders(): Item[] {
  const gores = planUnit('skirt', 'gores');
  const count = gores.count as number;
  const top = (partOf('front', 'waistband') as PartExtent).bounds[1];
  const bottom = lm('hem-band-top');
  const samples = 10;
  const ys = Array.from({ length: samples + 1 }, (_, i) => top + ((bottom - top) * i) / samples);
  const z0 = skirtAxisZ();
  const out: Item[] = [];
  for (let k = 0; k < count; k++) {
    const az = (360 * k) / count;
    const rad = (az * Math.PI) / 180;
    const [s, c] = [Math.sin(rad), Math.cos(rad)];
    const views: [SheetView, boolean, (p: readonly [number, number]) => number][] = [
      ['front', c > 1e-6, ([x]) => x],
      ['right', s > 1e-6, ([, z]) => -(z + z0)],
      ['back', c < -1e-6, ([x]) => -x],
    ];
    for (const [view, visible, u] of views) {
      if (!visible) continue;
      const pts = ys.map((y): Point => [u(onSection(skirtRing(y), rad)), y]);
      out.push(polyline(`gore border ${az} (${view})`, view, 'structure', pts, { link: `gore:${az}`, tolerance: 0.004, note: `skirt gore border at azimuth ${az} deg about the skirt axis (${count} gores, facet-plan skirt/gores)` }));
    }
  }
  return out;
}

/** The hem band's two rows: the border between them halfway up the band, across the band in every view. */
function hemRow(): Item[] {
  const rows = Number(planUnit('skirt', 'hem').rows);
  const v = lm('hem') + (lm('hem-band-top') - lm('hem')) / rows;
  return SHEET_VIEWS.map((view) => {
    const [u0, , u1] = (partOf(view, 'skirt-hem') as PartExtent).bounds;
    return hline(`hem band row border (${view})`, view, 'structure', v, u0, u1, { link: 'skirt:hem-row', note: `${rows} rows of block columns (facet-plan skirt/hem)` });
  });
}

/** Bangs (front): the clump edge zigzag through the tips and notches, and the partings from each notch up to the groove top. */
function bangs(): Item[] {
  const e = BANGS.edges;
  const zig: Point[] = [[e[0] as number, BANGS.edge]];
  for (let i = 0; i + 1 < e.length; i++) {
    zig.push([((e[i] as number) + (e[i + 1] as number)) / 2 + (BANGS.sweep[i] as number), BANGS.ends[i] as number]);
    if (i + 2 < e.length) zig.push([e[i + 1] as number, BANGS.notches[i] as number]);
  }
  zig.push([e[e.length - 1] as number, BANGS.edge]);
  const partings = Array.from({ length: e.length - 2 }, (_, k): Item =>
    polyline(`bang parting ${k + 1} (front)`, 'front', 'structure', [[e[k + 1] as number, BANGS.notches[k] as number], [e[k + 1] as number, BANGS.grooves.top]], { link: `bang-parting:${k + 1}`, basis: 'estimate' }),
  );
  return [polyline('bang tips (front)', 'front', 'structure', zig, { basis: 'estimate', note: `${planUnit('bangs', 'clumps').count} clumps between hair.ts BANGS.edges, tips at BANGS.ends` }), ...partings];
}

/**
 * Back-view u of the borders between neighbouring back-hair lobes (hair.ts LOBES: 7 outer and
 * 6 inner lobes alternating, centres equally spaced in azimuth about the head centre, so their
 * projections bunch toward the sides). Midway between the lobe centres the F2 builder measured
 * on the remodel model (2026-10-25); lobe tips there sit at y 0.30-0.36, the sheet's 0.29-0.33.
 */
const BACK_LOBE_BORDERS_U = [-0.203, -0.179, -0.15, -0.115, -0.069, -0.019, 0.024, 0.069, 0.115, 0.15, 0.179, 0.203] as const;

/** Back hair (back view): the dome/lobe split line and the borders of the lobes below it. */
function backHair(): Item[] {
  const lobes = planUnit('back-hair', 'outer-lobes');
  const split = lobes.split as number;
  const hair = outline('back', 'hair');
  const w = widest(hair, split);
  if (w === undefined) return [];
  const n = lobes.count as number;
  const borders = BACK_LOBE_BORDERS_U.map((u, k): Item | undefined => {
    const low = lowestAt(hair, u);
    return low === undefined || low >= split ? undefined : polyline(`back lobe border ${k + 1} (back)`, 'back', 'structure', [[u, split], [u, low]], { basis: 'derived', note: 'between equal-azimuth lobes (hair.ts LOBES), measured on the model' });
  }).filter((x): x is Item => x !== undefined);
  return [hline('back hair split (back)', 'back', 'structure', split, w[0], w[1], { link: 'hair:split', basis: 'estimate', note: `dome above, ${n} outer lobes below (facet-plan back-hair/outer-lobes split)` }), ...borders];
}

/** Bottom teeth of the apron ruffle; the rest go up the two sides (facet-plan apron: 9-10 bottom, 4-5 per side). */
const RUFFLE_BOTTOM_TEETH = 9;
/**
 * Apron ruffle (front): the hem's U as a comb, one tick per tooth border. The measured front
 * apron bounds are skewed (x -0.151..0.102, centre -0.032, against the skirt hem's +0.003):
 * the left hand overlaps the apron's left edge on the sheet. The apron is symmetric, so its
 * extent is the unobstructed right half mirrored about the skirt hem's centre. Tooth width =
 * bottom width / bottom teeth; the sides carry the remaining teeth.
 */
function apronRuffle(): { item: Item; toothWidth: number } {
  const teeth = planUnit('apron', 'ruffle').count as number;
  const [, y0, right] = (partOf('front', 'apron') as PartExtent).bounds;
  const centre = (partOf('front', 'skirt-hem') as PartExtent).center[0];
  const [x0, x1] = [2 * centre - right, right];
  const w = (x1 - x0) / RUFFLE_BOTTOM_TEETH;
  const side = (teeth - RUFFLE_BOTTOM_TEETH) / 2;
  const tick = w * 0.6;
  const pts: Point[] = [];
  // Left side top to bottom, ticks pointing in (+u).
  for (let i = side; i > 0; i--) pts.push([x0, y0 + i * w], [x0 + tick, y0 + i * w], [x0, y0 + i * w]);
  pts.push([x0, y0]);
  for (let i = 1; i < RUFFLE_BOTTOM_TEETH; i++) pts.push([x0 + i * w, y0], [x0 + i * w, y0 + tick], [x0 + i * w, y0]);
  pts.push([x1, y0]);
  for (let i = 1; i <= side; i++) pts.push([x1, y0 + i * w], [x1 - tick, y0 + i * w], [x1, y0 + i * w]);
  return {
    item: polyline('apron ruffle teeth (front)', 'front', 'structure', pts, { basis: 'estimate', note: `${teeth} box teeth: ${RUFFLE_BOTTOM_TEETH} along the bottom, ${side} up each side, ${w.toFixed(4)} wide from the apron's right half mirrored about the skirt centre` }),
    toothWidth: w,
  };
}

/** Where each faceted facet-plan unit's swatch sits (smooth units have no target edge): a view, a reference part and a fraction of its bounds. */
const SWATCHES: readonly { part: string; unit: string; view: SheetView; ref: string; f: Point }[] = [
  { part: 'back-hair', unit: 'dome', view: 'back', ref: 'hair-total', f: [0.5, 0.8] },
  { part: 'back-hair', unit: 'outer-lobes', view: 'back', ref: 'hair-total', f: [0.2, 0.22] },
  { part: 'back-hair', unit: 'outer-locks', view: 'back', ref: 'hair-total', f: [0.08, 0.5] },
  { part: 'back-hair', unit: 'inner-lobes', view: 'back', ref: 'hair-total', f: [0.8, 0.22] },
  { part: 'bangs', unit: 'clumps', view: 'front', ref: 'face', f: [0.5, 0.97] },
  { part: 'side-locks', unit: 'locks', view: 'front', ref: 'hair-total', f: [0.1, 0.45] },
  { part: 'cap', unit: 'crown', view: 'right', ref: 'hair-total', f: [0.55, 0.85] },
  { part: 'ahoge', unit: 'ahoge', view: 'front', ref: 'ahoge', f: [0.5, 0.45] },
  { part: 'skin-limbs', unit: 'limbs', view: 'front', ref: 'leg-l', f: [0.5, 0.5] },
  { part: 'bodice-sleeves', unit: 'bodice', view: 'right', ref: 'waistband', f: [0.4, 2.6] },
  { part: 'bodice-sleeves', unit: 'sleeves', view: 'right', ref: 'sleeve', f: [0.5, 0.65] },
  { part: 'skirt', unit: 'gores', view: 'front', ref: 'skirt', f: [0.22, 0.6] },
  { part: 'skirt', unit: 'hem', view: 'back', ref: 'skirt-hem', f: [0.3, 0.5] },
  { part: 'apron', unit: 'panel', view: 'front', ref: 'apron', f: [0.4, 0.4] },
  { part: 'apron', unit: 'ruffle', view: 'front', ref: 'apron', f: [0.75, 0.12] },
  { part: 'apron', unit: 'bib', view: 'front', ref: 'apron', f: [0.5, 0.86] },
  { part: 'apron', unit: 'frills', view: 'front', ref: 'apron', f: [0.85, 0.75] },
  { part: 'trims', unit: 'bands', view: 'front', ref: 'waistband', f: [0.8, 0.5] },
  { part: 'tail', unit: 'body', view: 'right', ref: 'tail', f: [0.45, 0.6] },
];

/** Triangles per square meter of an equilateral tiling at edge e (facet-plan densityRule). */
const tilingDensity = (e: number) => 4 / (Math.sqrt(3) * e * e);

/** The facet plan: one equilateral swatch per unit at its target edge, its recorded edge, and a note per unit and part. */
function facetPlan(): Item[] {
  const out: Item[] = [];
  for (const s of SWATCHES) {
    const unit = planUnit(s.part, s.unit);
    const ref = partOf(s.view, s.ref);
    if (ref === undefined) throw new Error(`maid-whale turnaround: no part ${s.ref} in the ${s.view} view`);
    const [u0, v0, u1, v1] = ref.bounds;
    const c: Point = [u0 + (u1 - u0) * s.f[0], v0 + (v1 - v0) * s.f[1]];
    const e = unit.edge;
    const h = (Math.sqrt(3) / 2) * e;
    const id = `facet ${s.part}/${s.unit}`;
    out.push(
      { id: `${id} (${s.view})`, view: s.view, role: 'construction', kind: 'curve', closed: true, basis: 'estimate', curve: { kind: 'polyline', points: [[c[0] - e / 2, c[1] - h / 3], [c[0] + e / 2, c[1] - h / 3], [c[0], c[1] + (2 * h) / 3]] } },
      { id: `${id} edge ${e}`, view: s.view, role: 'construction', kind: 'point', at: [c[0] + e / 2, c[1] - h / 3], basis: 'estimate' },
      { id: `${id} target edge`, view: s.view, role: 'construction', kind: 'dimension', measure: 'distance', refs: [], value: e, basis: 'estimate' },
      {
        id: `${id} plan`,
        view: s.view,
        role: 'construction',
        kind: 'note',
        refs: [`${id} (${s.view})`],
        text: [
          `${unit.faces}`,
          `edge ${e} m`,
          unit.count === undefined ? undefined : `${unit.count} units`,
          unit.columns === undefined ? undefined : `columns ${unit.columns}`,
          unit.rows === undefined ? undefined : `rows ${unit.rows}`,
          `density ${Math.round(tilingDensity(e))} tris/m2 (band ${Math.round(0.8 * tilingDensity(e))}-${Math.round(1.6 * tilingDensity(e))})`,
        ]
          .filter((x) => x !== undefined)
          .join('; '),
      },
    );
  }
  return out;
}

/** Facet-plan parts as notes: their form, structure-line rules and informational lines, referring to the drawn items. */
function planNotes(drawn: readonly Item[]): Item[] {
  const refsFor: Readonly<Record<string, (id: string) => boolean>> = {
    'back-hair': (id) => id.startsWith('back hair split') || id.startsWith('back lobe border') || id === 'hair outline (back)',
    bangs: (id) => id.startsWith('bang '),
    'side-locks': (id) => id === 'hair outline (front)',
    cap: (id) => id === 'hair outline (right)',
    ahoge: (id) => id === 'front silhouette',
    face: (id) => id === 'face outline (front)' || id === 'face outline (right)',
    'skin-limbs': (id) => /^(arm|leg)-[lr] outline \(front\)$/.test(id) || id === 'legs outline (right)',
    'bodice-sleeves': (id) => id === 'dress outline (front)' || id === 'dress outline (right)',
    skirt: (id) => id.startsWith('gore border') || id.startsWith('hem band row') || id.startsWith('skirt-hem '),
    apron: (id) => id.startsWith('apron ruffle'),
    trims: (id) => TRIMS.some((t) => t !== 'skirt-hem' && id.startsWith(`${t} `)),
    tail: (id) => id.startsWith('tail outline'),
    attachments: (id) => id === 'front silhouette',
  };
  const ids = drawn.map((i) => i.id);
  return PLAN.parts.map((p): Item => {
    const lines = 'structureLines' in p ? (p.structureLines as readonly { faces: readonly string[]; note: string }[]) : [];
    const info = 'informational' in p ? (p.informational as readonly string[]) : [];
    const text = [
      p.form,
      ...lines.map((l) => `structure: borders of ${l.faces.join(' + ')} (${l.note})`),
      ...info.map((l) => `informational: ${l}`),
    ].join(' | ');
    const pick = refsFor[p.name] ?? (() => false);
    return { id: `facet plan ${p.name}`, view: 'front', role: 'structure', kind: 'note', refs: ids.filter(pick).slice(0, 40), text: text.length <= 500 ? text : `${text.slice(0, 497)}...` };
  });
}

function findings(): Item[] {
  const refs: Readonly<Record<string, readonly string[]>> = {
    'R-1': ['tail outline (front)', 'tail outline (right)', 'tail outline (back)'],
    'R-2': ['tail-tip-front (pitch-biased, R-2)', 'tail-tip-side (pitch-biased, R-2)', 'tail-tip-back (pitch-biased, R-2)'],
    'R-3': ['hair outline (back)'],
  };
  return REF.findings.map((f): Item => ({ id: `finding ${f.id}`, view: 'back', role: 'construction', kind: 'note', refs: refs[f.id] ?? [], text: `${f.title}: ${f.decision}`.slice(0, 500) }));
}

function proportionItems(): Item[] {
  const { head, headsTall, headsOverall } = headUnits();
  const u = viewSpan('front')[0] - 0.03;
  return [
    { id: 'chin (head unit)', view: 'front', role: 'guide', kind: 'point', at: [u, lm('chin')] },
    { id: 'crown (head unit)', view: 'front', role: 'guide', kind: 'point', at: [u, lm('crown')] },
    { id: 'head unit', view: 'front', role: 'guide', kind: 'dimension', measure: 'distance', refs: ['chin (head unit)', 'crown (head unit)'], value: head, basis: 'derived' },
    {
      id: 'head count',
      view: 'front',
      role: 'guide',
      kind: 'note',
      refs: ['head unit'],
      text: `head unit = crown - chin = ${head.toFixed(4)} m; ${headsTall.toFixed(3)} heads to the crown (reference proportions.headsTall ${REF.proportions.headsTall}), ${headsOverall.toFixed(3)} to the ahoge tip`,
    },
  ];
}

const structure = [...partOutlines(), ...trimBorders(), ...goreBorders(), ...hemRow(), ...bangs(), ...backHair(), apronRuffle().item];

/** Ruffle tooth width from the apron bounds and the plan's tooth count (the plan text says about 0.022). */
export const RUFFLE_TOOTH_WIDTH = apronRuffle().toothWidth;

export const TURNAROUND: Drawing = {
  name: 'C-200 maid-whale turnaround (proportion grid, structure lines, facet plan)',
  sources: [
    {
      title: REF.source.title,
      note: `sha256 ${REF.source.sha256Prefix}; derived data only (reference.json, facet-plan.json ${PLAN.schema}). The sheet is pitched about ${REF.camera.pitchDeg} deg (R-2) and draws the tail mirrored in the back view (R-1); heights here are the sheet's landmark values.`,
    },
  ],
  views: SHEET_VIEWS.map((view) => ({ id: view, ortho: view })),
  items: [
    ...silhouettes(),
    ...centreLines(),
    ...grid(),
    ...landmarkGuides(),
    ...labels(),
    ...proportionItems(),
    ...tailTips(),
    ...structure,
    ...facetPlan(),
    ...planNotes(structure),
    ...findings(),
  ],
};

export interface TurnaroundLink {
  readonly link: string;
  /** Height of the horizontal item per view. */
  readonly heights: Readonly<Partial<Record<string, number>>>;
  readonly spread: number;
  readonly ok: boolean;
}

export interface TurnaroundCheck {
  readonly ok: boolean;
  /** Every linked guide (landmarks and the grid): the alignment rule, within `tolerance`. */
  readonly guides: readonly TurnaroundLink[];
  /** Linked horizontal structure lines (trim borders): their height spread across views, reported only. */
  readonly structure: readonly TurnaroundLink[];
  /** Landmark heights in head units. */
  readonly heads: Readonly<Record<string, number>>;
  /** Linked guides that are not one horizontal line per view. */
  readonly malformed: readonly string[];
}

/**
 * The turnaround alignment rule: every linked guide is a horizontal line with the same height
 * in all views (within `tolerance`, default 1 mm). Also reports landmark heights in head units
 * and the cross-view spread of linked horizontal structure lines.
 */
export function checkTurnaround(drawing: Drawing, tolerance = 0.001): TurnaroundCheck {
  const { head } = headUnits();
  const groups = new Map<string, { role: Item['role']; heights: Record<string, number>; malformed: boolean }>();
  for (const item of drawing.items) {
    if (item.kind !== 'curve' || item.link === undefined || (item.role !== 'guide' && item.role !== 'structure')) continue;
    const c = item.curve;
    const points = 'points' in c ? c.points : [];
    const v = points[0]?.[1];
    const horizontal = points.length >= 2 && points.every((p) => Math.abs(p[1] - (v as number)) <= 1e-9);
    const g = groups.get(item.link) ?? { role: item.role, heights: {}, malformed: false };
    if (!horizontal) g.malformed = true;
    else g.heights[item.view] = v as number;
    groups.set(item.link, g);
  }
  const guides: TurnaroundLink[] = [];
  const structureLinks: TurnaroundLink[] = [];
  const malformed: string[] = [];
  const heads: Record<string, number> = {};
  for (const [link, g] of groups) {
    if (g.malformed) {
      if (g.role === 'guide') malformed.push(link);
      continue;
    }
    const hs = Object.values(g.heights);
    const spread = Math.max(...hs) - Math.min(...hs);
    const entry = { link, heights: g.heights, spread, ok: spread <= tolerance };
    (g.role === 'guide' ? guides : structureLinks).push(entry);
    if (link.startsWith('landmark:')) heads[link.slice('landmark:'.length)] = (hs[0] as number) / head;
  }
  return { ok: malformed.length === 0 && guides.every((g) => g.ok), guides, structure: structureLinks, heads, malformed };
}

/** Per-view measured heights of landmarks against the sheet value: where the reference's own views disagree. */
const EVIDENCE: readonly { landmark: string; parts: readonly string[]; edge: 'top' | 'bottom' | 'middle' }[] = [
  { landmark: 'ahoge-tip', parts: ['ahoge'], edge: 'top' },
  { landmark: 'headdress-top', parts: ['headdress'], edge: 'top' },
  { landmark: 'eye-top', parts: ['eye-l'], edge: 'top' },
  { landmark: 'chin', parts: ['face'], edge: 'bottom' },
  { landmark: 'shoulder', parts: ['sleeve'], edge: 'top' },
  { landmark: 'waist', parts: ['waistband'], edge: 'middle' },
  { landmark: 'wrist', parts: ['cuff-l'], edge: 'bottom' },
  { landmark: 'hand-bottom', parts: ['hand-l'], edge: 'bottom' },
  { landmark: 'hem-band-top', parts: ['skirt-hem'], edge: 'top' },
  { landmark: 'hem', parts: ['skirt-hem'], edge: 'bottom' },
  { landmark: 'sock-top', parts: ['sock-l', 'socks'], edge: 'top' },
  { landmark: 'sole-top', parts: ['shoe-l', 'shoes'], edge: 'top' },
];

export function viewDisagreements(): { landmark: string; view: SheetView; part: string; sheet: number; measured: number; delta: number }[] {
  const out: ReturnType<typeof viewDisagreements> = [];
  for (const e of EVIDENCE) {
    for (const view of SHEET_VIEWS) {
      const name = e.parts.find((p) => partOf(view, p) !== undefined);
      if (name === undefined) continue;
      const b = (partOf(view, name) as PartExtent).bounds;
      const measured = e.edge === 'top' ? b[3] : e.edge === 'bottom' ? b[1] : (b[1] + b[3]) / 2;
      out.push({ landmark: e.landmark, view, part: name, sheet: lm(e.landmark), measured, delta: measured - lm(e.landmark) });
    }
  }
  return out;
}
