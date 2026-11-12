import { type FaceSelector, type Model, model, SurfaceQuery, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { buildBody, centerOf } from './body.ts';
import { type GarmentStyle, UNTAPERED, walled } from './garments.ts';
import { LANDMARK } from './reference.ts';

/**
 * Case C-200 stage G4 (hair, structure-first): the hair is its own session grown from the
 * G2 skull. The scalp (the head above the hairline, and the forehead down to the brows) is
 * layered into a sheet, swollen out to the sheet's hair volume and shelled into a closed cap
 * whose front is the bangs (pointed clumps cut from it, grooves pressed in between). The side
 * masses and their locks, the back mass and the ahoge are root patches of the cap extruded
 * along paths; strips of the cap top radiating from the crown swell into clumps. The body is
 * removed at the end.
 */

const lm = (name: string): number => LANDMARK[name] as number;
const box = (lo: Tuple3, hi: Tuple3) => sel.inBox(lo, hi, { by: 'centroid' });

/**
 * Cap volume around the skull (G1 hair extents: top 0.95 in front, half-width about 0.165
 * above the ears, back of the hair mass about 0.17 behind the head's centre): ellipsoid
 * radii and centre height, the sheet's lift off the scalp, the shell thickness and the
 * height of the cap's face rows after one subdivision.
 */
export const CAP = { radii: [0.165, 0.17, 0.165] as const, centerY: 0.775, lift: 0.008, thickness: 0.006, row: 0.01 } as const;

/**
 * The scalp: the head above the hairline. The hairline runs across the forehead above
 * the eyes, down the temples in front of the ears and around the nape.
 */
export function scalp(): FaceSelector {
  const head = sel.tag('head').minus(sel.createdBy('neck'));
  // The bangs are the cap's front: it reaches down over the forehead to the brows, and between
  // the eyes for the middle strand.
  const [w, c] = [0.11, BANGS.middleWidth];
  const face = box([-w, -1, 0.04], [-c, BANGS.edge, 1]).or(box([c, -1, 0.04], [w, BANGS.edge, 1])).or(box([-c, -1, 0.04], [c, BANGS.middle, 1]));
  // Above the jaw's curve, where the subdivided sheet would shrink into the head; the back clumps cover the nape.
  return head.and(box([-1, lm('chin') + 0.08, -1], [1, 1, 1])).minus(face);
}

/**
 * A front lock: one clump of a side mass, its root the patch `faces` (normal `n` at `root`).
 * It drapes `gap` off the outermost surface of the figure (cheek, collar, shoulder, sleeve,
 * arm) found from the lock's azimuth `az`, waving `wave` across from phase `phase`, down to
 * `end`; its section scales by `scale`.
 */
interface Lock {
  readonly name: string;
  readonly az: number;
  readonly end: number;
  readonly gap: number;
  readonly wave: number;
  readonly phase: number;
  /** Extra reach outward along the azimuth at the tip (grows with the square of the path fraction). */
  readonly flare?: number;
  /** Ring spacing along the facet lock (default `LOCK_FACETS.row`), longer for a longer lock to stay inside its plan band. */
  readonly row?: number;
  readonly width: number;
  readonly scale: readonly number[];
}

/**
 * Side masses (sheet front view: one wide, wavy face-framing mass per side from the temple,
 * draping over the shoulders and sleeves to about 0.36, its outer edge irregular): the cap's
 * temple row at `y` between `from` and `to` (degrees from +z toward the side; one row, its
 * height becomes the mass's thickness once it hangs) extruded as one mass down to the cheek at `split`, its end then split into `locks` clumps
 * of equal count. Alternate clumps drape one layer further out and widen over their
 * neighbours; lengths and waves differ, so the edge is irregular.
 */
const SIDE = { from: 46, to: 102, y: 0.756, split: 0.68, out: 0.012, scale: [1, 1.04, 1.08] } as const;
const SIDE_LOCKS: Record<'l' | 'r', readonly Omit<Lock, 'name' | 'az'>[]> = {
  // x > 0: the sheet's hair is asymmetric. On this side (right of the front view) it hangs lower
  // and spreads wider than on x < 0: its outer edge reaches x 0.32 and its lowest tips y 0.27.
  l: [
    { end: 0.35, gap: 0.006, wave: 0.01, phase: 0, width: 0.065, scale: [1, 0.85, 0.9, 1, 1, 0.7, 0.08] },
    { end: 0.27, gap: 0.042, wave: 0.012, phase: 1.3, row: 0.031, width: 0.065, scale: [1, 0.95, 1, 1.2, 1.25, 0.8, 0.08] },
    { end: 0.34, gap: 0.012, wave: 0.009, phase: 2.4, width: 0.065, scale: [1, 0.85, 0.95, 1.1, 1.1, 1, 0.08] },
  ],
  r: [
    { end: 0.37, gap: 0.006, wave: 0.01, phase: 0, width: 0.065, scale: [1, 0.85, 0.9, 1, 1, 0.7, 0.08] },
    { end: 0.345, gap: 0.042, wave: 0.012, phase: 1.3, flare: -0.012, width: 0.065, scale: [1, 0.95, 1, 1.2, 1.25, 0.8, 0.08] },
    { end: 0.42, gap: 0.012, wave: 0.009, phase: 2.4, width: 0.065, scale: [1, 0.85, 0.95, 1.1, 1.1, 1, 0.08] },
  ],
};

/** Ahoge root size (crown cap faces) and its taper along the crescent. */
const AHOGE = { faces: 8, scale: [1, 1.4, 1.6, 1.4, 0.9, 0.06] } as const;
/**
 * Remodel ahoge (facet-plan.json ahoge): a closed solid of explicit facets along the crescent's
 * path, never remeshed. Its section is a triangle (3 columns): the crest toward the curl's
 * outside `depth` out, the two lower corners `width` either side and half that deep, all scaled
 * by `scale` along the path. Rings every `row` (closer where it narrows), the root `tuck` up inside
 * the cap, the last `spike` a point of 3 facets tagged `hair-spike`.
 */
export const AHOGE_FACETS = { width: 0.015, depth: 0.014, scale: [1, 1.35, 1.5, 1.3, 0.95, 0.5], row: 0.026, minRow: 0.014, tuck: 0.012, spike: 0.03 } as const;

/**
 * Cap clumps (sheet: the faceted dome breaks into clumps flowing from the crown down into the
 * bangs, side masses and back): `count` tapered strips of the cap at azimuths between `from`
 * and `to` (the front stays free for the ahoge), each from `polar` to `end` degrees off the
 * crown in `bands` steps, `half` degrees either side at the top narrowing to 0.4 of it.
 * Each strip swells `rise` out onto a slightly larger ellipsoid, its edges blending over
 * `falloff`: raised clumps that follow the skull, without new faces or square steps.
 */
const CROWN = { count: 9, from: 48, to: 312, polar: 12, end: 66, bands: 6, half: 8, rise: 0.007, falloff: 0.008 } as const;

/**
 * Back mass in layers (sheet side view: back edge at z -0.24 at y 0.6, -0.28 at 0.5, -0.30
 * at 0.45; back view width about +-0.24, clump tips at 0.28-0.36). Each layer is a band of
 * cap faces (heights `lo`..`hi`) between the azimuths, extruded down to `end` drifting
 * `back` (the arc wrapping the head gives the side view its depth), widened by `scale`
 * about the band's centre. The outer layer starts higher on the cap and drifts further back,
 * hanging over the inner one, and ends in `tips` long pointed clumps, each narrower than its
 * spacing so the separations between them run `tip` deep.
 */
interface MassLayer {
  readonly name: string;
  readonly lo: number;
  readonly hi: number;
  readonly from: number;
  readonly to: number;
  readonly end: number;
  readonly back: number;
  readonly scale: readonly number[];
  readonly tips: number;
  readonly tip: number;
}
/**
 * G6 remodel (facet-plan.json back-hair): one mass (the curtain, CURTAIN, thinning to its
 * lower edge) with broad lobes coming out from under its edge: `outer` long lobes (sheet back
 * view: 3 left of the bow, 1 behind it, 3 right) alternating with `inner` shorter, lighter ones
 * between them, centred on equal shares of the curtain's bottom around it. Each lobe is a closed
 * solid of explicit facets (backLobe): a lens section (`width` across, `depth`) narrowing from
 * the root to the end ring over `body` (one row of 8 facets), then a `spike` of 4 facets to one point
 * (tagged `hair-spike`). Each grows out of the curtain's end (a designed contact, lobeContacts):
 * centred on its mid-thickness, its root `tuck` up inside it. They are built `drop` lower, clear
 * of the curtain while it is faceted, and raised into place after (raiseLobes). Lobe centres are equally spaced in azimuth. Alternate outer
 * lobes have the longer spike. The inner mass (hidden under the outer one, its root wedged
 * against the cap) is not built.
 */
export const LOBES = {
  outer: 7,
  inner: 6,
  tuck: 0.015,
  drop: 0.03,
  // Half-widths across at the root and the end ring as shares of the spacing between lobe centres
  // (an outer and an inner lobe together fill 0.9 of it at the root), half-depths in meters.
  long: { width: [0.52, 0.37], depth: [0.019, 0.014], body: 0.036, spike: [0.059, 0.054] },
  short: { width: [0.38, 0.3], depth: [0.015, 0.011], body: 0.03, spike: [0.03, 0.03] },
} as const;

const MASS: readonly MassLayer[] = [
  { name: 'back-inner', lo: 0, hi: 0.035, from: 110, to: 250, end: 0.4, back: 0.08, scale: [1, 1.1, 1.2, 1.3, 1.38, 1.42, 1.45, 1.48, 1.5], tips: 0, tip: 0 },
  { name: 'back-outer', lo: 0.065, hi: 0.095, from: 112, to: 248, end: 0.39, back: 0.12, scale: [1, 1.08, 1.14, 1.2, 1.26, 1.32, 1.38, 1.42, 1.45], tips: 12, tip: 0.09 },
];

/**
 * G6 remodel curtain (facet-plan.json back-hair): the one outer mass fills the volume the G5
 * inner mass gave behind the body (right view y 0.40-0.62). Its band starts `lo` above the cap's
 * lowest row (the G5 outer layer's rows and most of the inner's), it drifts back only `back`
 * and swells by `scale`; below `narrow.range[1]` its width (x) eases to `narrow.factor` at
 * `narrow.range[0]`, so the swell thickens it toward the body without widening it in the front
 * and back views. The band's borders are knifed first, level at its two heights and radial at
 * its two azimuths (`snap` as the knife's), so the extruded walls are straight: the cap's rows
 * are not level, and a band of whole faces leaves a staircase whose 1 cm folds slivered every
 * remesh at the curtain's 0.05 edge.
 */
export const CURTAIN = {
  lo: 0.04,
  back: 0.105,
  scale: [1, 1.08, 1.14, 1.3, 1.5, 1.62, 1.68, 1.72, 1.73],
  narrow: { range: [0.36, 0.68] as const, factor: 0.82 },
  snap: 0.003,
} as const;

/**
 * Bangs (sheet front view: varied broad pointed clumps covering the forehead to the lash line,
 * broader in the middle and at the sides, the outer ones sweeping toward the temples, grown out
 * of the hair mass): the cap's own front. It reaches over the forehead to `edge` (to `middle`
 * between the eyes within `middleWidth`), lying `lift` off the skin there; the clumps between
 * the `edges` (x across the forehead) end in points at their `ends` heights, drifting `sweep`
 * toward the temples, and the notches between them reach up to `notches`, continuing as
 * `grooves` up the cap (deeper below `split`).
 */
export const BANGS = {
  edge: 0.735,
  middle: 0.7,
  middleWidth: 0.025,
  lift: 0.004,
  edges: [-0.104, -0.074, -0.054, -0.03, 0.03, 0.054, 0.074, 0.104],
  ends: [0.74, 0.733, 0.745, 0.707, 0.745, 0.733, 0.74],
  sweep: [-0.012, -0.004, 0, 0, 0, 0.004, 0.012],
  notches: [0.762, 0.752, 0.756, 0.756, 0.752, 0.762],
  grooves: { width: 0.002, top: 0.85, split: 0.79, depth: [0.0025, 0.0013] },
} as const;

/**
 * The G7 fringe's clumps below their notches (bangFringe): one station at the tip's ring, its x
 * closing on the tip's as u^power (full clumps curling into their sweep). A steeper power or a
 * wider sweep left over 3 % slivers (over6) at the tips.
 */
const CURL = { power: 1.7 } as const;

/**
 * The bang tips: each gap between neighbouring tips is knifed out of the cap's front from its
 * notch down, leaving pointed clumps at their end heights.
 */
function bangTips(m: Model): void {
  const B = BANGS;
  const tip = (i: number): [number, number] => [((B.edges[i] as number) + (B.edges[i + 1] as number)) / 2 + (B.sweep[i] as number), B.ends[i] as number];
  const below = 0.68;
  // Between neighbours only: past the outer tips the cap's front runs on into the side hair.
  const gaps: [number, number][][] = [];
  for (let k = 0; k + 1 < B.ends.length; k++) {
    const [a, b] = [tip(k), tip(k + 1)];
    gaps.push([[a[0], a[1]], [a[0], below], [b[0], below], [b[0], b[1]], [B.edges[k + 1] as number, B.notches[k] as number]]);
  }
  for (const [k, g] of gaps.entries()) {
    const label = `hair-bangs-gap-${k}`;
    m.knife({ points: g.map(([x, y]) => [x, y, 0.5] as Tuple3), direction: [0, 0, -1], closed: true, snap: 0.0005, faces: sel.tag('hair').and(box([-0.13, 0.6, 0.03], [0.13, 0.8, 1])), label });
    m.delete(sel.createdBy(label, 'inside'));
  }
}

/**
 * Grooves between the bangs: from each notch up the cap's outer wall, pressed in, and their part
 * below `split` pressed in again (deeper toward the tips; see BANGS).
 */
/**
 * G6 remodel (facet-plan.json bangs): the fringe is one closed solid of explicit facets laid over
 * the faceted forehead (bangFringe). The cap's front is cut away under it along the fringe's seams
 * (bangOpening): the cap's tapered crease runs `tuck` inside the fringe's root line and outer
 * edges, a straight structure line under the fringe's root.
 */
export const FRINGE = {
  root: BANGS.grooves.top,
  // The root line droops this much toward the outermost edges (fringeRoot), below the cap's
  // steeper rise over the temples.
  droop: 0.03,
  // The cap's cut runs this far inside the fringe's seams, so its crease lies under the fringe.
  tuck: 0.001,
  // The inner side's lift off the surface beneath (a chord's sag over the convex forehead too),
  // the crest's and the partings' heights over it and the rise from the root's crease.
  lift: 0.0025,
  // The root's crease and the outer edges lie on the cap's outer surface by its crease, and the
  // fringe rises out of it over `rise`; its seat (fringeContacts) accepts penetration up to `seat`.
  seat: 0.005,
  // The outermost clumps reach this much further out into the cap at the root, their crests
  // at this share of the height (no slab edge over the temples).
  flare: 0.012,
  outer: 0.4,
  crest: 0.005,
  parting: 0.002,
  rise: 0.06,
  // The highest surface under a station is sought this far around it (a chord's reach).
  near: 0.01,
  // Spikes: the last facets to each tip, a ring this far above it when the clump is longer.
  spike: 0.03,
  // Station spacing along a line as a share of the columns beside it (their geometric mean), and its bounds.
  seg: { share: 1.6, min: 0.015, max: 0.03 },
} as const;

/**
 * Opens the cap's front under the G6 fringe (see FRINGE): inside its root line and outer edges
 * (`tuck` in), and straight down from the outer edges' ends.
 */
function bangOpening(m: Model): void {
  const t = FRINGE.tuck;
  const [[lt, lb], [rt, rb]] = [fringeOuterEdge(0), fringeOuterEdge(1)];
  const root: [number, number][] = [];
  const n = Math.ceil((rt[0] - lt[0] - 2 * t) / 0.005);
  for (let k = 0; k <= n; k++) {
    const x = rt[0] - t - ((rt[0] - lt[0] - 2 * t) * k) / n;
    root.push([x, fringeRoot(x) - t]);
  }
  const corners: [number, number][] = [[lb[0] + t, lb[1]], [lb[0] + t, 0.6], [rb[0] - t, 0.6], [rb[0] - t, rb[1]]];
  const outline = [...corners, ...root].map(([x, y]): Tuple3 => [x, y, 0.5]);
  m.knife({ points: outline, direction: [0, 0, -1], closed: true, snap: 0.0005, faces: sel.tag('hair').and(box([-0.13, 0.6, 0.03], [0.13, 0.9, 1])), label: 'hair-bangs-opening' });
  m.delete(sel.createdBy('hair-bangs-opening', 'inside'));
}

/** Below this the cap lay `BANGS.lift` off the forehead (buildHair's shrinkwrap). */
const FOREHEAD = 0.79;

/** The fringe's clump labels, left to right (facet-plan.json bangs units). */
export function bangLabels(): string[] {
  return Array.from({ length: BANGS.ends.length }, (_, i) => `hair-bang-${i}`);
}

/**
 * The fringe's seams with the cap in the forehead's (x, y): its root line (fringeRoot, `root` in the
 * middle drooping `droop` to the outermost edges) and its
 * outer edges (side 0 left, 1 right), each from the root down to its clump's ring height. The
 * outermost clumps flare `flare` further out at the root (clear of the side masses below) and
 * sweep half as far as their crests, so the crest never closes on them.
 */
export function fringeRoot(x: number): number {
  const reach = (BANGS.edges.at(-1) as number) + FRINGE.flare;
  return FRINGE.root - FRINGE.droop * (x / reach) ** 2;
}

export function fringeOuterEdge(side: 0 | 1): [[number, number], [number, number]] {
  const B = BANGS;
  const F = FRINGE;
  const last = B.ends.length - 1;
  const i = side === 0 ? 0 : last;
  const [x, out] = side === 0 ? [B.edges[0] as number, -F.flare] : [B.edges[last + 1] as number, F.flare];
  const y = B.notches[side === 0 ? 0 : last - 1] as number;
  const tipY = B.ends[i] as number;
  const top = fringeRoot(x + out);
  const drift = ((B.sweep[i] as number) / 2) * ((top - y) / (top - tipY));
  return [[x + out, top], [x + drift, y]];
}

interface FringeLine {
  /** Stations in the forehead's (x, y), root first. */
  readonly at: readonly (readonly [number, number])[];
  /** Height of the outer side over the inner one at each station (0: one crease vertex). */
  readonly h: readonly number[];
  /** The inner side's offset at each station: 1 `lift` over the surface, 0 on the cap (seated). */
  readonly seat: readonly number[];
}

/**
 * The bangs (facet-plan.json bangs) as one closed solid of explicit facets over the faceted cap
 * and forehead, never remeshed: 7 clumps between BANGS.edges, each two columns a side (its edge
 * lines and crest), pointed at BANGS.ends. Above the notches the clumps are one piece: the
 * partings between them are facet edges `parting` lower than the crests; below, each clump's
 * sides are creases running to its tip, the notches between them open. The root is a crease
 * (fringeRoot) and the outermost clumps' outer edges (fringeOuterEdge) lie on the cap's outer
 * surface, touching it (a designed contact, fringeContacts), the fringe rising out of it flush
 * over `rise` to its full height; below that the inner side lies `lift` over the highest surface
 * around.
 * Each line carries stations about `seg.share` of the columns beside it apart, a crest's half a
 * station off its edges'; the strip between two lines is zipped along its shorter diagonals. The
 * last facets to each tip (from a ring `spike` above it, or the notches when they are lower) are
 * tagged `hair-spike`.
 */
export function bangFringe(m: Model): void {
  const B = BANGS;
  const F = FRINGE;
  const skin = sel.tag('head').minus(sel.tag('hair'));
  const capQ = SurfaceQuery.of(m.editMesh, sel.createdBy('hair-cap').or(sel.createdBy('hair-cap-wall')).evaluate(m.editMesh));
  const skinQ = SurfaceQuery.of(m.editMesh, skin.evaluate(m.editMesh));
  if (!capQ.ok) throw capQ.error;
  if (!skinQ.ok) throw skinQ.error;
  const head = m.bounds(skin);
  if (!head.ok) throw head.error;
  const center: Tuple3 = [(head.value.min[0] + head.value.max[0]) / 2, CAP.centerY, (head.value.min[2] + head.value.max[2]) / 2];
  const radius = (p: Tuple3) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
  const reach = (B.edges.at(-1) as number) + F.flare;
  // The cap's outer surface over (x, y), in front of the skin (a ray through the opening reaches
  // the cap behind the head).
  const capAt = (x: number, y: number): Tuple3 | undefined => {
    const hit = skinQ.value.project([x, y, 0.5], [0, 0, -1], 1)?.point;
    const cap = capQ.value.project([x, y, 0.5], [0, 0, -1], 1)?.point;
    return cap !== undefined && (hit === undefined || cap[2] > hit[2]) ? cap : undefined;
  };
  // The surface the fringe lies on at (x, y): the cap or, where it is opened, the cap's former
  // outer surface: its shell over its crease at the root, blending down to its shell over its
  // lift on the forehead below `FOREHEAD`.
  const surface = (x: number, y: number): Tuple3 => {
    const cap = capAt(x, y);
    if (cap !== undefined) return cap;
    const hit = skinQ.value.project([x, y, 0.5], [0, 0, -1], 1)?.point;
    if (hit === undefined) throw new Error(`bang fringe: no forehead at (${x}, ${y})`);
    const low = radius(hit) + BANGS.lift + CAP.thickness;
    const top = fringeRoot(Math.max(-reach, Math.min(reach, x)));
    const crease = capAt(x, top);
    const t = Math.min(1, Math.max(0, (y - FOREHEAD) / (top - FOREHEAD)));
    const r = crease === undefined ? low : low + (radius(crease) + CAP.thickness - low) * t;
    // Over (x, y), as the cap was: forward from the skin until it lies `r` from the head's centre.
    const d = sub3(hit, center);
    const b = dot3(d, [0, 0, 1]);
    return add3(hit, [0, 0, 1], -b + Math.sqrt(Math.max(0, b * b - dot3(d, d) + r * r)));
  };
  const clumps = B.ends.length;
  const mid = (i: number) => ((B.edges[i] as number) + (B.edges[i + 1] as number)) / 2;
  const tip = (i: number): [number, number] => [mid(i) + (B.sweep[i] as number), B.ends[i] as number];
  // Interior edge k (1..6) ends at its notch; each clump's ring height is its sides' mean.
  const apex = (k: number): [number, number] => [B.edges[k] as number, B.notches[k - 1] as number];
  const sideY = (i: number, s: 0 | 1) => {
    const k = i + s;
    return k === 0 || k === clumps ? apex(s === 0 ? 1 : clumps - 1)[1] : apex(k)[1];
  };
  const width = (xa: number, xb: number, y: number) => {
    const [a, b] = [surface(xa, y), surface(xb, y)];
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  const y0 = (sideY(3, 0) + F.root) / 2;
  const column = (i: number) => width(B.edges[i] as number, mid(i), y0);
  const seg = (w: number) => Math.min(F.seg.max, Math.max(F.seg.min, F.seg.share * w));
  // Stations from a to b about `step` apart; a crest's (`phase` 1/2) fall half a step off its edges'.
  const stations = (a: readonly [number, number], b: readonly [number, number], step: number, phase = 0) => {
    const n = Math.max(1, Math.round(Math.abs(a[1] - b[1]) / step + phase));
    return Array.from({ length: n + 1 }, (_, k) => {
      const t = k === 0 ? 0 : (k - phase) / (n - phase);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as [number, number];
    });
  };
  // The share of the full height a station `top - y` below its line's root has risen to.
  const rise = (top: number, y: number) => Math.min(1, (top - y) / F.rise);
  // A clump's ring (when its tip lies more than a spike below it) on the segment toward its tip.
  // Its share of the way from `p` to the tip.
  const ring = (i: number, p: readonly [number, number]): number | undefined => {
    const t = tip(i);
    if (p[1] - t[1] <= F.spike + 0.01) return undefined;
    return (p[1] - (t[1] + F.spike)) / (p[1] - t[1]);
  };
  // A short clump's sides (its notch less than a spike and a centimetre above its tip) take one
  // station halfway down from the notch, so its spike never reaches the notch its neighbour shares
  // (the two spikes would join there into one component).
  // Below the notches a clump's lines run from `p` to its tip curved (CURL): x closes on the tip's
  // as u^CURL.power, so its sides stay full and close in a point, and its crest falls straight and
  // flicks into the tip's sweep.
  const curved = (i: number, p: readonly [number, number], u: number): [number, number] => {
    const t = tip(i);
    return [p[0] + (t[0] - p[0]) * u ** CURL.power, p[1] + (t[1] - p[1]) * u];
  };
  // The edge lines: interior ones from the root to their notch (the parting, then 0 at the apex).
  const edgeLine = (k: number): FringeLine => {
    const beside = [k - 1, k].filter((i) => i >= 0 && i < clumps).map(column);
    const outer = k === 0 || k === clumps;
    const [top, bottom] = outer ? fringeOuterEdge(k === 0 ? 0 : 1) : [[B.edges[k] as number, fringeRoot(B.edges[k] as number)] as [number, number], apex(k)];
    const at = stations(top, bottom, seg(beside.reduce((p, w) => p * w, 1) ** (1 / beside.length)));
    // The outer edges lie on the cap along their length, so the outermost clumps blend into it.
    return { at, h: at.map(([, y], s) => (outer || s === 0 || s === at.length - 1 ? 0 : F.parting * rise(top[1], y))), seat: at.map(([, y]) => (outer ? 0 : rise(top[1], y))) };
  };
  const edges = Array.from({ length: clumps + 1 }, (_, k) => edgeLine(k));
  // A clump's side below its notch: a crease to the tip (through its ring).
  const side = (i: number, s: 0 | 1): FringeLine => {
    const e = edges[i + s] as FringeLine;
    const top = e.at.at(-1) as readonly [number, number];
    const below = [curved(i, top, ring(i, top) ?? 0.5)];
    const at = [...e.at, ...below, tip(i)];
    return { at, h: [...e.h, ...below.map(() => 0), 0], seat: [...e.seat, ...below.map(() => 1), 1] };
  };
  const crest = (i: number): FringeLine => {
    const t = tip(i);
    const ringY = (sideY(i, 0) + sideY(i, 1)) / 2;
    const top = fringeRoot(mid(i));
    const f = (top - ringY) / (top - t[1]);
    const bottom: [number, number] = [mid(i) + (t[0] - mid(i)) * f, ringY];
    const at = stations([mid(i), top], bottom, seg(column(i)), 1 / 2);
    const r = ring(i, bottom);
    const below = r === undefined ? [] : [curved(i, bottom, r)];
    const all = [...at, ...below, t];
    const k = i === 0 || i === clumps - 1 ? F.outer : 1;
    return { at: all, h: all.map(([, y], s) => (s === 0 || s === all.length - 1 ? 0 : k * F.crest * rise(top, y))), seat: all.map(([, y], s) => (s === all.length - 1 ? 1 : k * rise(top, y))) };
  };
  // Stations in 3D: the inner side `lift` over the highest surface within `near` around (blending
  // from the cap where `seat` < 1: the root and the outer edges lie on the cap and the fringe
  // rises from it), the outer side `h` further out, both along the radius from the head's centre.
  const cache = new Map<string, [Tuple3, Tuple3]>();
  const place = (x: number, y: number, h: number, seat: number): [Tuple3, Tuple3] => {
    const key = `${x},${y},${h},${seat}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const p = surface(x, y);
    const n = unit3(sub3(p, center));
    const r = F.near;
    let over = 0;
    for (const dx of [-r, 0, r]) for (const dy of [-r, 0, r]) over = Math.max(over, dot3(sub3(surface(x + dx, y + dy), p), n));
    // Seated on the cap: a seam station on the cap itself, a rising one on the cap at the root
    // above it (the cap tapers to its crease there, under the fringe's root).
    const low = seat === 0 ? capAt(x, y) : capAt(x, fringeRoot(x));
    const base = low === undefined ? radius(p) : radius(low);
    const inner = add3(center, n, (1 - seat) * base + seat * (radius(p) + over + F.lift));
    const placed: [Tuple3, Tuple3] = [inner, h > 0 ? add3(inner, n, h) : inner];
    cache.set(key, placed);
    return placed;
  };
  const fringe = model();
  const tris: { readonly points: [Tuple3, Tuple3, Tuple3]; readonly label: string; readonly spike: boolean }[] = [];
  // The strip between lines a (left) and b (right), root to tip: zipped along the shorter
  // diagonal, never into a triangle of three crease vertices (its two sides would coincide),
  // and into the common tip last.
  const strip = (a: FringeLine, b: FringeLine, label: string) => {
    const pa = a.at.map(([x, y], s) => place(x, y, a.h[s] as number, a.seat[s] as number));
    const pb = b.at.map(([x, y], s) => place(x, y, b.h[s] as number, b.seat[s] as number));
    const [ma, mb] = [a.at.length - 1, b.at.length - 1];
    const flat = (...v: number[]) => v.every((h) => h === 0);
    const d = (p: Tuple3, w: Tuple3) => Math.hypot(p[0] - w[0], p[1] - w[1], p[2] - w[2]);
    const emit = (u: [number, number], v: [number, number], w: [number, number], spike: boolean) => {
      const pt = (c: [number, number]) => (c[0] === 0 ? pa : pb)[c[1]] as [Tuple3, Tuple3];
      for (const side of [0, 1] as const) {
        const [p0, p1, p2] = [pt(u)[side], pt(v)[side], pt(w)[side]];
        tris.push({ points: side === 0 ? [p0, p1, p2] : [p0, p2, p1], label, spike });
      }
    };
    // A notch (a parting's last point, where both clumps' sides and both walls meet) fans no facet:
    // the zip moves on from it at once, so it keeps one crest neighbour a clump and wall.
    let [i, j] = [0, 0];
    while (i < ma - 1 || j < mb - 1) {
      const canA = i < ma - 1 && !flat(a.h[i] as number, a.h[i + 1] as number, b.h[j] as number);
      const canB = j < mb - 1 && !flat(a.h[i] as number, b.h[j] as number, b.h[j + 1] as number);
      const notchA = i > 0 && a.h[i] === 0 && (a.h[i - 1] as number) > 0;
      const notchB = j > 0 && b.h[j] === 0 && (b.h[j - 1] as number) > 0;
      const shorter = d((pa[i + 1] as [Tuple3, Tuple3])[1], (pb[j] as [Tuple3, Tuple3])[1]) <= d((pa[i] as [Tuple3, Tuple3])[1], (pb[j + 1] as [Tuple3, Tuple3])[1]);
      const takeA = canA && (!canB || notchA || (!notchB && shorter));
      if (!canA && !canB) throw new Error(`bang fringe ${label}: no triangle to zip at ${i}, ${j}`);
      if (takeA) {
        emit([0, i], [0, i + 1], [1, j], false);
        i++;
      } else {
        emit([0, i], [1, j + 1], [1, j], false);
        j++;
      }
    }
    emit([0, i], [0, ma], [1, j], true);
  };
  const labels = bangLabels();
  for (let i = 0; i < clumps; i++) {
    const c = crest(i);
    strip(side(i, 0), c, labels[i] as string);
    strip(c, side(i, 1), labels[i] as string);
  }
  // Outward: the signed volume decides the winding.
  const volume = tris.reduce((sum, { points: [p, w, r] }) => sum + dot3(p, cross3(w, r)), 0);
  for (const { points: [p, w, r], label, spike } of tris) fringe.polygon({ points: volume > 0 ? [p, w, r] : [p, r, w], label, material: 'hair', ...(spike ? { tag: 'hair-spike' } : {}) });
  fringe.weld({ distance: 1e-6 });
  m.append(fringe, { tag: 'hair' });
  m.tag(labels.reduce((s, l) => s.or(sel.createdBy(l)), sel.createdBy('__none__')), 'hair-fringe');
  const clump = (lo: number, hi: number, tag: string) => m.tag(sel.tag('hair-fringe').and(box([lo, -9, -9], [hi, 9, 9])), tag);
  clump(-9, center[0] - 0.04, 'hair-bang-l');
  clump(center[0] - 0.04, center[0] + 0.04, 'hair-bang-c');
  clump(center[0] + 0.04, 9, 'hair-bang-r');
}

/** The fringe (tag `hair-fringe`, one closed part) seated in the cap along its root and outer edges (see FRINGE). */
export function fringeContacts(): { parts: [string, string]; tolerance: number }[] {
  return [
    { parts: ['hair-fringe', 'hair-cap'], tolerance: FRINGE.seat },
    { parts: ['hair-fringe', 'hair-cap-wall'], tolerance: FRINGE.seat },
  ];
}

function bangGrooves(m: Model, style: GarmentStyle): void {
  const G = BANGS.grooves;
  for (let k = 1; k + 1 < BANGS.edges.length; k++) {
    const x = BANGS.edges[k] as number;
    // Clear of the notch's edge (the notch is the open end of the groove); on a tapered cap,
    // where the wall is thick enough for the groove's depth (60 % of the taper above the notch).
    const y0 = (BANGS.notches[k - 1] as number) + Math.max(0.004, 0.6 * (style.taper ?? 0));
    const label = `hair-bangs-groove-${k}`;
    const strip: Tuple3[] = [[x - G.width, y0, 0.5], [x + G.width, y0, 0.5], [x + G.width, G.top, 0.5], [x - G.width, G.top, 0.5]];
    m.knife({ points: strip, direction: [0, 0, -1], closed: true, snap: 0.0003, faces: sel.tag('hair').and(box([-0.13, 0.7, 0.03], [0.13, 0.9, 1])), label });
    m.offset(sel.createdBy(label, 'inside'), { distance: -(G.depth[1] as number), region: 'merged', label: `${label}-floor` });
    m.offset(sel.createdBy(`${label}-floor`, 'top').and(box([-1, -1, -1], [1, G.split, 1])), { distance: -((G.depth[0] as number) - (G.depth[1] as number)), region: 'merged', label: `${label}-deep` });
  }
}

/** A hair mass layer and its clump tips (see MassLayer): the back layers. */
function hairMass(m: Model, center: Tuple3, layers: readonly MassLayer[], style: GarmentStyle): void {
  const free = sel.createdBy('hair-cap', 'layer');
  const sector = (a0: number, a1: number) => {
    const [r0, r1] = [(a0 * Math.PI) / 180, (a1 * Math.PI) / 180];
    return sel.side(center, [Math.cos(r0), 0, -Math.sin(r0)], { by: 'centroid' }).and(sel.side(center, [-Math.cos(r1), 0, Math.sin(r1)], { by: 'centroid' }));
  };
  // Each layer's base: the cap's lowest row between its azimuths, measured before any layer grows.
  const bases = layers.map((layer) => {
    const b = m.bounds(free.and(sector(layer.from, layer.to)));
    if (!b.ok) throw b.error;
    return b.value.min[1];
  });
  for (const [li, layer] of layers.entries()) {
    const label = `hair-${layer.name}`;
    const bottom = bases[li] as number;
    if (style.facets === true) {
      // The band's borders as straight cuts (CURTAIN): level at its heights, radial at its azimuths.
      const near = free.and(sector(layer.from - 12, layer.to + 12));
      for (const y of [bottom + layer.lo, bottom + layer.hi]) {
        const cut = m.try((t) => t.knife({ faces: near, points: [[-0.6, y, center[2] - 0.6], [0.6, y, center[2] - 0.6]], direction: [0, 0, 1], through: true, snap: CURTAIN.snap }));
        if (!cut.ok && cut.error.code !== 'model-op-no-effect') throw cut.error;
      }
      for (const a of [layer.from, layer.to]) {
        const r = (a * Math.PI) / 180;
        const d: Tuple3 = [Math.sin(r), 0, Math.cos(r)];
        const o = (y: number): Tuple3 => [center[0] + 0.6 * d[0], y, center[2] + 0.6 * d[2]];
        const cut = m.try((t) => t.knife({ faces: near.and(sel.side(center, d, { by: 'centroid' })), points: [o(1.2), o(0.3)], direction: [-d[0], 0, -d[2]], through: true, snap: CURTAIN.snap }));
        if (!cut.ok && cut.error.code !== 'model-op-no-effect') throw cut.error;
      }
    }
    const band = free.and(sector(layer.from, layer.to)).and(box([-1, bottom + layer.lo, -1], [1, bottom + layer.hi, 1]));
    const c = centerOf(m, band);
    const stations = layer.scale.length - 1;
    // Down, drifting back as it falls (a smooth curve), so the widened sides stay behind the sleeves.
    const ctrl: Tuple3[] = [c, [c[0], c[1] - (c[1] - layer.end) * 0.3, c[2]], [c[0], layer.end + (c[1] - layer.end) * 0.4, c[2] - layer.back], [c[0], layer.end, c[2] - layer.back]];
    const path = Array.from({ length: stations + 1 }, (_, k) => {
      const t = k / stations;
      const w = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      return [0, 1, 2].map((j) => w.reduce((sum, x, i) => sum + x * ((ctrl[i] as Tuple3)[j] as number), 0)) as Tuple3;
    });
    m.extrude(band, { path, scale: [...layer.scale], label });
    if (style.facets === true) {
      // Narrower below (CURTAIN.narrow): a taper widening upward, then the whole mass scaled back,
      // so the root at the cap keeps its width exactly.
      const { range, factor } = CURTAIN.narrow;
      m.taper(sel.createdBy(label), { axis: 'y', range: [...range], factor: 1 / factor, axes: ['x'], origin: [0, 0, 0] });
      m.scale(sel.createdBy(label), [factor, 1, 1], [0, 0, 0]);
    }
    // Clump tips: the bottom's faces in order around its centre (the path's end), in `tips`
    // groups of equal count; the middle of each group is pulled into a point, so neighbours
    // never share an edge and the separations run the tip's length.
    const apex = path[stations] as Tuple3;
    const ends = sel
      .createdBy(label, 'top')
      .evaluate(m.editMesh)
      .map((f) => {
        const ps = m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v));
        const c3 = [0, 1, 2].map((k) => ps.reduce((t, p) => t + (p[k] as number), 0) / ps.length) as Tuple3;
        // Angle around the apex relative to the layer's middle azimuth, so the order never wraps.
        const mid = ((layer.from + layer.to) / 2) * (Math.PI / 180);
        let a = Math.atan2(c3[0] - apex[0], c3[2] - apex[2]) - mid;
        while (a <= -Math.PI) a += 2 * Math.PI;
        while (a > Math.PI) a -= 2 * Math.PI;
        return { c3, a };
      })
      .sort((x, y) => x.a - y.a);
    if (style.facets === true) {
      backLobes(m, label, center, ends);
      continue;
    }
    for (let i = 0; i < layer.tips; i++) {
      const group = ends.slice(Math.round((i * ends.length) / layer.tips), Math.round(((i + 1) * ends.length) / layer.tips));
      const margin = 0.2;
      const core = group.slice(Math.floor(group.length * margin), Math.ceil(group.length * (1 - margin)));
      if (core.length === 0) throw new Error(`back tip ${i} found no faces`);
      const tips = core.map(({ c3 }) => sel.near(c3, 1)).reduce((x, y) => x.or(y));
      const t = centerOf(m, tips);
      const len = layer.tip * (i % 3 === 1 ? 0.75 : 1);
      const label3 = `hair-tip-${i}`;
      m.extrude(tips, { path: [t, [t[0], t[1] - len * 0.4, t[2]], [t[0], t[1] - len * 0.75, t[2]], [t[0], t[1] - len, t[2]]], scale: [1, 0.8, 0.45, 0.06], label: label3 });
    }
  }
}

/** Raises the lobes `drop` into place, rooted in the curtain's end (see LOBES). */
export function raiseLobes(m: Model): void {
  m.translate(backLobeLabels().reduce((s, l) => s.or(sel.createdBy(l)), sel.createdBy('__none__')), [0, LOBES.drop, 0]);
}

/**
 * Each lobe grows out of the curtain's end (see LOBES): its root `tuck` deep, and up to its
 * half-width deeper where the curtain's end curves up across the outermost lobes.
 */
export function lobeContacts(): { parts: [string, string]; tolerance: number }[] {
  return backLobeLabels().map((l) => ({ parts: [l, 'hair-back-outer'], tolerance: LOBES.tuck + 0.005 }));
}

/** The lobe labels in order around the mass: outer and inner alternate (see LOBES). */
export function backLobeLabels(): string[] {
  return Array.from({ length: LOBES.outer + LOBES.inner }, (_, i) => (i % 2 === 0 ? `hair-back-lobe-${i / 2}` : `hair-back-inner-${(i - 1) / 2}`));
}

type V3 = readonly number[];
const add3 = (p: V3, v: V3, k = 1): Tuple3 => [(p[0] as number) + (v[0] as number) * k, (p[1] as number) + (v[1] as number) * k, (p[2] as number) + (v[2] as number) * k];
const sub3 = (a: V3, b: V3): Tuple3 => [(a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number), (a[2] as number) - (b[2] as number)];
const dot3 = (a: V3, b: V3) => (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);
const cross3 = (a: V3, b: V3): Tuple3 => [
  (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number),
  (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number),
  (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number),
];
const unit3 = (v: V3): Tuple3 => {
  const l = Math.hypot(v[0] as number, v[1] as number, v[2] as number) || 1;
  return [(v[0] as number) / l, (v[1] as number) / l, (v[2] as number) / l];
};

/**
 * The lobes (see LOBES) under the curtain `label` (around `center`), on its bottom faces `ends`:
 * lobe centres equally spaced in azimuth about `center` over the bottom, each at
 * its nearest bottom faces, which give it its edge height; its width scales with the distance to
 * its nearer neighbour. The lobes are built in their own
 * session, welded and appended, so the faceting never touches them.
 */
function backLobes(m: Model, label: string, center: Tuple3, ends: readonly { readonly c3: Tuple3 }[]): void {
  const q = SurfaceQuery.of(m.editMesh, sel.createdBy(label).evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  const names = backLobeLabels();
  const count = names.length;
  // Azimuth about the head's centre (the curtain is nearly round about it; about the curtain's
  // own end point the middle of the bottom would crowd), measured from straight back.
  const around = ends.map(({ c3 }) => ({ c3, a: Math.atan2(c3[0] - center[0], -(c3[2] - center[2])) }));
  const [a0, a1] = [Math.min(...around.map((e) => e.a)), Math.max(...around.map((e) => e.a))];
  const places = names.map((_, i) => {
    const at = a0 + ((i + 0.5) * (a1 - a0)) / count;
    const near = [...around].sort((x, y) => Math.abs(x.a - at) - Math.abs(y.a - at)).slice(0, 3);
    const c = near.reduce((t, { c3 }) => add3(t, c3, 1 / near.length), [0, 0, 0] as Tuple3);
    const edge = m.bounds(near.map(({ c3 }) => sel.near(c3, 1)).reduce((x, y) => x.or(y)));
    if (!edge.ok) throw edge.error;
    return { c, y: edge.value.min[1] + LOBES.tuck };
  });
  const lobes = model();
  for (const [i, { c, y }] of places.entries()) {
    const outward = unit3([c[0] - center[0], 0, c[2] - center[2]]);
    const u = cross3(outward, [0, 1, 0]);
    // The spacing: the horizontal distance to the nearer neighbour.
    const spacing = Math.min(...[places[i - 1], places[i + 1]].flatMap((p) => (p === undefined ? [] : [Math.hypot(p.c[0] - c[0], p.c[2] - c[2])])));
    const outer = i % 2 === 0;
    const kind = outer ? LOBES.long : LOBES.short;
    backLobe(lobes, q.value, [c[0], y, c[2]], u, outward, spacing, kind, kind.spike[outer ? (i / 2) % 2 : 0] as number, names[i] as string);
  }
  lobes.weld({ distance: 1e-6 });
  m.append(lobes, { tag: 'hair' });
}

/**
 * One lobe (14 facets), `spacing` from its neighbours, hanging straight down from its root ring at `root` height: the lens's four
 * lines (its two edges across `u`, its two crests) down `body` to the end ring, then four spike
 * facets to the point `spike` below; two facets close the root.
 */
function backLobe(target: Model, curtain: SurfaceQuery, root: Tuple3, u: Tuple3, outward: Tuple3, spacing: number, kind: typeof LOBES.long | typeof LOBES.short, spike: number, label: string): void {
  // Centred on the curtain's mid-thickness under the root, `drop` lower until raised (raiseLobes).
  const [outer, inner] = [0.2, -0.2].map((k) => curtain.project(add3(root, outward, k), outward, 0.3));
  if (outer === undefined || inner === undefined) throw new Error(`${label}: no curtain at its root`);
  const mid = (dot3(sub3(outer.point, root), outward) + dot3(sub3(inner.point, root), outward)) / 2;
  const c = add3(add3(root, outward, mid), [0, -1, 0], LOBES.drop);
  const lens = (k: 0 | 1, y: number) => {
    const [w, d] = [(kind.width[k] as number) * spacing, kind.depth[k] as number];
    const o: Tuple3 = [c[0], y, c[2]];
    return [add3(o, u, -w), add3(o, outward, d), add3(o, u, w), add3(o, outward, -d)];
  };
  const top = lens(0, c[1]);
  const end = lens(1, c[1] - kind.body);
  const apex: Tuple3 = [c[0], c[1] - kind.body - spike, c[2]];
  const tris: { readonly points: [Tuple3, Tuple3, Tuple3]; readonly spike: boolean }[] = [];
  for (let k = 0; k < 4; k++) {
    const [r0, r1, e0, e1] = [top[k], top[(k + 1) % 4], end[k], end[(k + 1) % 4]] as [Tuple3, Tuple3, Tuple3, Tuple3];
    tris.push({ points: [r0, e0, r1], spike: false }, { points: [e0, e1, r1], spike: false }, { points: [e0, apex, e1], spike: true });
  }
  const [l, f, r, b] = top as [Tuple3, Tuple3, Tuple3, Tuple3];
  tris.push({ points: [l, f, b], spike: false }, { points: [f, r, b], spike: false });
  // Outward: the signed volume decides the winding.
  const volume = tris.reduce((sum, { points: [p, q, w] }) => sum + dot3(p, cross3(q, w)), 0);
  for (const { points: [p, q, w], spike: tip } of tris) target.polygon({ points: volume > 0 ? [p, q, w] : [p, w, q], label, material: 'hair', ...(tip ? { tag: 'hair-spike' } : {}) });
}

/** A front lock's path (see Lock), draped on the figure from its root, and its section scale at each point. */
function lockPath(center: Tuple3, figure: SurfaceQuery, c: Lock, root: Tuple3, n: Tuple3): { readonly path: Tuple3[]; readonly scale: number[] } {
  const a = (c.az * Math.PI) / 180;
  const d: Tuple3 = [Math.sin(a), 0, Math.cos(a)];
  // The outermost figure surface from the lock's azimuth at height y, `gap` off it (the most
  // outward within 2 cm above and below, so the lock eases over collars, shoulders and cuffs).
  // Sampled across the lock's width too (its centre and both edges, on parallel rays), so a
  // flat lock clears a rounded sleeve at its edges.
  const across: Tuple3 = [d[2], 0, -d[0]];
  const drape = (y: number): Tuple3 => {
    let reach = -Infinity;
    for (const dy of [-0.02, -0.01, 0, 0.01, 0.02]) {
      for (const w of [-0.6, 0, 0.6].map((f) => f * c.width * 1.35)) {
        const from: Tuple3 = [center[0] + d[0] * 0.5 + across[0] * w, y + dy, center[2] + d[2] * 0.5 + across[2] * w];
        const h = figure.project(from, [-d[0], 0, -d[2]], 0.6);
        if (h === undefined) continue;
        reach = Math.max(reach, (h.point[0] - center[0]) * d[0] + (h.point[2] - center[2]) * d[2]);
      }
    }
    if (reach === -Infinity) throw new Error(`lock ${c.name} found no figure at ${y}`);
    return [center[0] + d[0] * (reach + c.gap), y, center[2] + d[2] * (reach + c.gap)];
  };
  const path: Tuple3[] = [root, [root[0] + n[0] * 0.012, root[1] + n[1] * 0.012, root[2] + n[2] * 0.012]];
  const stations = 22;
  const top = root[1] - 0.03;
  for (let k = 0; k <= stations; k++) {
    const t = k / stations;
    const y = top - (top - c.end) * t;
    const p = drape(y);
    // Never inside the cap's reach near the root, a wave across lower down.
    const r = Math.max(Math.hypot(p[0] - center[0], p[2] - center[2]), Math.hypot(root[0] - center[0], root[2] - center[2]) + 0.012 * (1 - t)) + (c.flare ?? 0) * t * t;
    const w = c.wave * Math.sin(t * Math.PI * 3 + c.phase) * t;
    path.push([center[0] + d[0] * r + d[2] * w, y, center[2] + d[2] * r - d[0] * w]);
  }
  const scale = path.map((_, k) => {
    const f = (k / (path.length - 1)) * (c.scale.length - 1);
    const i = Math.min(c.scale.length - 2, Math.floor(f));
    return (c.scale[i] as number) + ((c.scale[i + 1] as number) - (c.scale[i] as number)) * (f - i);
  });
  return { path, scale };
}

/** A front lock (see Lock): the patch extruded along a path draped on the figure. */
function lock(m: Model, center: Tuple3, figure: SurfaceQuery, c: Lock, patch: FaceSelector, root: Tuple3, n: Tuple3): void {
  const { path, scale } = lockPath(center, figure, c, root, n);
  m.extrude(patch, { path, scale, label: `hair-${c.name}` });
}

/**
 * G6 remodel (facet-plan.json side-locks): a lock as a closed solid of explicit facets along its
 * draped path (lockPath), never remeshed. Its section is a faceted lens of `LOCK_SIDES` corners:
 * the edges across the lock (`across`, `width` of the patch at the root) at its middle depth,
 * at least `thick` of its width deep below the root (the patch's `depth` at the root), scaled
 * along the path as the G5 lock and kept `clear` off the figure. Rings every `LOCK_FACETS.row`
 * from the root (closer where the lock narrows), `tuck` up inside the side mass's end (a designed
 * contact, lockContacts), the last `spike` a point of three facets tagged `hair-spike`.
 * Over the path's last `1 - twistFrom` the section turns by up to `twist` degrees and the lock
 * curls `curl` forward (the tip's flick).
 */
export const LOCK_FACETS = { row: 0.025, minRow: 0.012, tuck: 0.012, spike: 0.03, inset: 0.9, clear: 0.004, thick: 0.5, twist: 35, twistFrom: 0.6, curl: 0.015 } as const;
/** Corners of a side lock's lens section: the edges across (L, R), the crest (C) and the back (B). */
const LOCK_SIDES = 4;

function lockFacets(target: Model, center: Tuple3, figure: SurfaceQuery, c: Lock, root: Tuple3, n: Tuple3, width: number, depth: number, label: string): void {
  const L = LOCK_FACETS;
  const { path, scale } = lockPath(center, figure, c, root, n);
  const a = (c.az * Math.PI) / 180;
  const d: Tuple3 = [Math.sin(a), 0, Math.cos(a)];
  const across: Tuple3 = [d[2], 0, -d[0]];
  // Arc length along the path, and the point and scale at a distance s along it.
  const at = [0];
  for (let k = 1; k < path.length; k++) at.push((at[k - 1] as number) + Math.hypot(...sub3(path[k] as Tuple3, path[k - 1] as Tuple3)));
  const total = at.at(-1) as number;
  const sample = (s: number): { p: Tuple3; k: number } => {
    const i = Math.max(0, at.findIndex((x) => x >= s) - 1);
    const f = Math.min(1, Math.max(0, (s - (at[i] as number)) / Math.max(1e-9, (at[i + 1] as number) - (at[i] as number))));
    const [p0, p1] = [path[i] as Tuple3, path[i + 1] as Tuple3];
    return { p: add3(p0, sub3(p1, p0), f), k: (scale[i] as number) + ((scale[i + 1] as number) - (scale[i] as number)) * f };
  };
  // The tip curls forward (toward +z) over the twist's reach.
  const fwd: Tuple3 = across[2] >= 0 ? across : [-across[0], 0, -across[2]];
  const curlAt = (s: number) => {
    const u = Math.min(1, Math.max(0, (s / total - L.twistFrom) / (1 - L.twistFrom)));
    return { u: u * u * (3 - 2 * u), off: L.curl * u * u * u };
  };
  // A ring: a lens of `SIDES` corners, the edges across (L, R) at its middle depth, the outer
  // corners toward `d` and the inner toward the figure, turned by `turn` about the path, pushed
  // out until its back clears the figure by `clear` (the drape samples the figure at three
  // points across; a round sleeve between them reaches further).
  const ring = (p: Tuple3, k: number, clear = true, turn = 0): Tuple3[] => {
    const [w, t] = [((L.inset * width) / 2) * k, ((clear ? Math.max(depth, L.thick * width) : depth) / 2) * k];
    const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
    const [x, y] = [add3(add3([0, 0, 0], across, cos), d, sin), add3(add3([0, 0, 0], d, cos), across, -sin)];
    const corner = (o: Tuple3, j: number): Tuple3 => {
      const a = Math.PI - (2 * Math.PI * j) / LOCK_SIDES;
      return add3(add3(o, x, w * Math.cos(a)), y, t * Math.sin(a));
    };
    let push = 0;
    if (clear) {
      for (let j = 0; j <= 8; j++) {
        const u = j / 4 - 1;
        const b = add3(add3(p, x, w * u), y, -t * Math.sqrt(1 - u * u));
        const h = figure.project(add3(b, d, 0.1), [-d[0], 0, -d[2]], 0.3);
        if (h !== undefined) push = Math.max(push, dot3(sub3(h.point, b), d) + L.clear);
      }
    }
    const o = add3(p, d, push);
    return Array.from({ length: LOCK_SIDES }, (_, j) => corner(o, j));
  };
  // The spike at most twice its ring's shortest side (a narrow lock's point stays three facets, not needles).
  const tipRing = ring(sample(total - L.spike).p, sample(total - L.spike).k);
  const side = Math.min(...tipRing.map((q, j) => Math.hypot(...sub3(q, tipRing[(j + 1) % LOCK_SIDES] as Tuple3))));
  const body = total - Math.min(L.spike, 2 * side);
  // Stations `row` apart, closer where the lock narrows (at most its width apart), so no facet of
  // the taper grows long and thin.
  const at2: number[] = [];
  for (let s = 0; ; ) {
    at2.push(Math.min(s, body));
    if (s >= body) break;
    const step = Math.min(c.row ?? L.row, Math.max(L.minRow, L.inset * width * sample(s).k));
    s = body - s < 1.5 * step ? body : s + step;
  }
  // The first station is the side mass's end itself (no push off the figure there).
  const ringAt = (s: number) => {
    const { p, k } = sample(s);
    const c = curlAt(s);
    return ring(add3(p, fwd, c.off), k, s > 0, ((L.twist * Math.PI) / 180) * c.u);
  };
  const tuck = ring(add3(root, n, -L.tuck), 0.8 * (scale[0] as number), false);
  const stations = at2.map(ringAt);
  const mids = at2.slice(0, -1).map((s, i) => ringAt(i === 0 ? s : (s + (at2[i + 1] as number)) / 2));
  // The edges (L, R) at the stations, the crest and the back's middle (C, B) half a station
  // later, so the facets between the lines are near equilateral (aligned lines leave right
  // triangles); all four start at the root ring inside the side mass, L C R end at the spike's
  // ring and B one station before.
  const last = stations.at(-1) as Tuple3[];
  const [lineL, lineC, lineR, lineB] = [0, 1, 2, 3].map((j) => [tuck[j] as Tuple3, ...(j % 2 === 1 ? mids : stations).map((r) => r[j] as Tuple3), ...(j === 1 ? [last[1] as Tuple3] : [])]) as [Tuple3[], Tuple3[], Tuple3[], Tuple3[]];
  const apex = add3(path.at(-1) as Tuple3, fwd, curlAt(total).off);
  const tris: { readonly points: [Tuple3, Tuple3, Tuple3]; readonly spike: boolean }[] = [];
  const dist = (x: Tuple3, y: Tuple3) => Math.hypot(...sub3(x, y));
  // The strip between two lines, root to tip, along the shorter diagonals.
  const zip = (a: Tuple3[], b: Tuple3[]) => {
    let [i, j] = [0, 0];
    while (i < a.length - 1 || j < b.length - 1) {
      const takeA = j === b.length - 1 || (i < a.length - 1 && dist(a[i + 1] as Tuple3, b[j] as Tuple3) <= dist(a[i] as Tuple3, b[j + 1] as Tuple3));
      if (takeA) tris.push({ points: [a[i] as Tuple3, a[++i] as Tuple3, b[j] as Tuple3], spike: false });
      else tris.push({ points: [a[i] as Tuple3, b[++j] as Tuple3, b[j - 1] as Tuple3], spike: false });
    }
  };
  zip(lineL, lineC);
  zip(lineC, lineR);
  zip(lineR, lineB);
  zip(lineB, lineL);
  const [eL, eC, eR, eB] = [lineL.at(-1), lineC.at(-1), lineR.at(-1), lineB.at(-1)] as Tuple3[];
  tris.push({ points: [eR as Tuple3, eL as Tuple3, eB as Tuple3], spike: false });
  // The root: two facets from the crest; the tip: three into the apex.
  tris.push({ points: [tuck[1], tuck[2], tuck[3]] as [Tuple3, Tuple3, Tuple3], spike: false }, { points: [tuck[1], tuck[3], tuck[0]] as [Tuple3, Tuple3, Tuple3], spike: false });
  for (const [x, y] of [[eL, eC], [eC, eR], [eR, eL]] as [Tuple3, Tuple3][]) tris.push({ points: [x, apex, y], spike: true });
  // Outward: the signed volume decides the winding.
  const volume = tris.reduce((sum, { points: [p, q, w] }) => sum + dot3(p, cross3(q, w)), 0);
  for (const { points: [p, q, w], spike } of tris) target.polygon({ points: volume > 0 ? [p, q, w] : [p, w, q], label, material: 'hair', ...(spike ? { tag: 'hair-spike' } : {}) });
}

/** The ahoge's labels' contact with the cap (see AHOGE_FACETS): its root lies `tuck` inside the cap's wall. */
export function ahogeContacts(): { parts: [string, string]; tolerance: number }[] {
  return ['hair-cap', 'hair-cap-wall'].map((c) => ({ parts: ['hair-ahoge', c] as [string, string], tolerance: AHOGE_FACETS.tuck + 0.005 }));
}

/** The ahoge (see AHOGE_FACETS) as a closed solid of facets along `path`, rooted at its first point. */
function ahogeFacets(target: Model, path: readonly Tuple3[]): void {
  const A = AHOGE_FACETS;
  const n = path.length;
  const tangent = path.map((_, k) => unit3(sub3(path[Math.min(n - 1, k + 1)] as Tuple3, path[Math.max(0, k - 1)] as Tuple3)));
  // Section axes by parallel transport from the lateral axis, so the triangle never flips along the curl.
  const side: Tuple3[] = [];
  for (const [k, t] of tangent.entries()) {
    const ref = k === 0 ? ([1, 0, 0] as Tuple3) : (side[k - 1] as Tuple3);
    side.push(unit3(add3(ref, t, -dot3(ref, t))));
  }
  const up = tangent.map((t, k) => unit3(cross3(t, side[k] as Tuple3)));
  const at = [0];
  for (let k = 1; k < n; k++) at.push((at[k - 1] as number) + Math.hypot(...sub3(path[k] as Tuple3, path[k - 1] as Tuple3)));
  const total = at.at(-1) as number;
  const sample = (s: number) => {
    const i = Math.min(n - 2, Math.max(0, at.findIndex((x) => x >= s) - 1));
    const f = Math.min(1, Math.max(0, (s - (at[i] as number)) / ((at[i + 1] as number) - (at[i] as number))));
    const mix = (a: Tuple3, b: Tuple3): Tuple3 => add3(a, sub3(b, a), f);
    return { p: mix(path[i] as Tuple3, path[i + 1] as Tuple3), x: unit3(mix(side[i] as Tuple3, side[i + 1] as Tuple3)), y: unit3(mix(up[i] as Tuple3, up[i + 1] as Tuple3)), k: (A.scale[i] as number) + ((A.scale[i + 1] as number) - (A.scale[i] as number)) * f };
  };
  const ring = (s: number, shift = 0, grow = 1): Tuple3[] => {
    const { p, x, y, k } = sample(s);
    const o = add3(p, unit3(sub3(path[1] as Tuple3, path[0] as Tuple3)), shift);
    const [w, h] = [A.width * k * grow, A.depth * k * grow];
    return [add3(o, y, h), add3(add3(o, x, w), y, -h / 2), add3(add3(o, x, -w), y, -h / 2)];
  };
  const body = total - A.spike;
  const stations: number[] = [];
  for (let s = 0; ; ) {
    stations.push(Math.min(s, body));
    if (s >= body) break;
    const step = Math.min(A.row, Math.max(A.minRow, 2 * A.width * sample(s).k));
    s = body - s < 1.5 * step ? body : s + step;
  }
  const tuck = ring(0, -A.tuck, 0.8);
  const rings = stations.map((s) => ring(s));
  const mids = stations.slice(0, -1).map((s, i) => ring(i === 0 ? s : (s + (stations[i + 1] as number)) / 2));
  const last = rings.at(-1) as Tuple3[];
  const lines = [0, 1, 2].map((j) => [tuck[j] as Tuple3, ...(j === 1 ? mids : rings).map((r) => r[j] as Tuple3), ...(j === 1 ? [last[1] as Tuple3] : [])]);
  const tris: { readonly points: [Tuple3, Tuple3, Tuple3]; readonly spike: boolean }[] = [];
  const dist = (a: Tuple3, b: Tuple3) => Math.hypot(...sub3(a, b));
  const zip = (a: Tuple3[], b: Tuple3[]) => {
    let [i, j] = [0, 0];
    while (i < a.length - 1 || j < b.length - 1) {
      const takeA = j === b.length - 1 || (i < a.length - 1 && dist(a[i + 1] as Tuple3, b[j] as Tuple3) <= dist(a[i] as Tuple3, b[j + 1] as Tuple3));
      if (takeA) tris.push({ points: [a[i] as Tuple3, a[++i] as Tuple3, b[j] as Tuple3], spike: false });
      else tris.push({ points: [a[i] as Tuple3, b[++j] as Tuple3, b[j - 1] as Tuple3], spike: false });
    }
  };
  const [l0, l1, l2] = lines as [Tuple3[], Tuple3[], Tuple3[]];
  zip(l0, l1);
  zip(l1, l2);
  zip(l2, l0);
  const apex = path[n - 1] as Tuple3;
  const [e0, e1, e2] = [l0.at(-1), l1.at(-1), l2.at(-1)] as Tuple3[];
  tris.push({ points: [tuck[0], tuck[1], tuck[2]] as [Tuple3, Tuple3, Tuple3], spike: false });
  for (const [x, y] of [[e0, e1], [e1, e2], [e2, e0]] as [Tuple3, Tuple3][]) tris.push({ points: [x, apex, y], spike: true });
  const volume = tris.reduce((sum, { points: [p, q, w] }) => sum + dot3(p, cross3(q, w)), 0);
  for (const { points: [p, q, w], spike } of tris) target.polygon({ points: volume > 0 ? [p, q, w] : [p, w, q], label: 'hair-ahoge', material: 'hair', ...(spike ? { tag: 'hair-spike' } : {}) });
}

/** The side locks' labels (see SIDE_LOCKS), left then right. */
export function sideLockLabels(): string[] {
  return (['l', 'r'] as const).flatMap((side) => SIDE_LOCKS[side].map((_, i) => `hair-lock-${side}${i}`));
}

/** Each G6 lock grows out of its side mass's end (see LOCK_FACETS): its root `tuck` deep. */
export function lockContacts(): { parts: [string, string]; tolerance: number }[] {
  return sideLockLabels().map((l) => ({ parts: [l, `hair-side-${l.charAt(10)}`], tolerance: LOCK_FACETS.tuck + 0.005 }));
}

/** A side mass (see SIDE): the temple rows extruded to the cheek, then split into draped locks. */
function sideMass(m: Model, center: Tuple3, figure: SurfaceQuery, s: 1 | -1, style: GarmentStyle): void {
  const side = s > 0 ? 'l' : 'r';
  const label = `hair-side-${side}`;
  const [r0, r1] = [(s * SIDE.from * Math.PI) / 180, (s * SIDE.to * Math.PI) / 180];
  const [lo, hi] = s > 0 ? [r0, r1] : [r1, r0];
  const mid = (((SIDE.from + SIDE.to) / 2) * s * Math.PI) / 180;
  const d: Tuple3 = [Math.sin(mid), 0, Math.cos(mid)];
  const row = centerOf(m, sel.createdBy('hair-cap', 'layer').and(sel.near([center[0] + d[0] * 0.17, SIDE.y, center[2] + d[2] * 0.17], 1)))[1];
  const band = sel
    .createdBy('hair-cap', 'layer')
    .and(box([-1, row - CAP.row * 0.4, -1], [1, row + CAP.row * 0.4, 1]))
    .and(sel.side(center, [Math.cos(lo), 0, -Math.sin(lo)], { by: 'centroid' }))
    .and(sel.side(center, [-Math.cos(hi), 0, Math.sin(hi)], { by: 'centroid' }));
  const c = centerOf(m, band);
  // Out off the temple, then straight down past the cheek: the joined top of the mass.
  m.extrude(band, { path: [c, [c[0] + d[0] * SIDE.out, c[1], c[2] + d[2] * SIDE.out], [c[0] + d[0] * SIDE.out * 1.4, c[1] - (c[1] - SIDE.split) * 0.5, c[2] + d[2] * SIDE.out * 1.4], [c[0] + d[0] * SIDE.out * 1.6, SIDE.split, c[2] + d[2] * SIDE.out * 1.6]], scale: [...SIDE.scale, SIDE.scale.at(-1) as number], label });
  // Its end faces in order around the head, split into the locks.
  const ends = sel
    .createdBy(label, 'top')
    .evaluate(m.editMesh)
    .map((f) => {
      const ps = m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v));
      const p = [0, 1, 2].map((k) => ps.reduce((t, q) => t + (q[k] as number), 0) / ps.length) as Tuple3;
      return { p, a: Math.atan2(p[0] - center[0], p[2] - center[2]) * s };
    })
    .sort((x, y) => x.a - y.a);
  // G6: the locks are built as facets in their own session, welded and appended (see LOCK_FACETS).
  const locks = model();
  const locksOfSide = SIDE_LOCKS[side];
  for (const [i, l] of locksOfSide.entries()) {
    const group = ends.slice(Math.round((i * ends.length) / locksOfSide.length), Math.round(((i + 1) * ends.length) / locksOfSide.length));
    const patch = group.map(({ p }) => sel.near(p, 1)).reduce((x, y) => x.or(y));
    const root = centerOf(m, patch);
    const az = (Math.atan2(root[0] - center[0], root[2] - center[2]) * 180) / Math.PI;
    const c: Lock = { name: `lock-${side}${i}`, az, ...l };
    if (style.facets !== true) {
      lock(m, center, figure, c, patch, root, [0, -1, 0]);
      continue;
    }
    // The patch's extent across the lock and through it (radially), about its root.
    const a = (az * Math.PI) / 180;
    const [d, across] = [[Math.sin(a), 0, Math.cos(a)] as Tuple3, [Math.cos(a), 0, -Math.sin(a)] as Tuple3];
    const vs = [...new Set(patch.evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f)))].map((v) => sub3(m.editMesh.position(v) as Tuple3, root));
    const extent = (axis: Tuple3) => 2 * Math.max(...vs.map((v) => Math.abs(dot3(v, axis))));
    lockFacets(locks, center, figure, c, root, [0, -1, 0], extent(across), extent(d), `hair-${c.name}`);
  }
  if (style.facets === true) {
    locks.weld({ distance: 1e-6 });
    m.append(locks, { tag: 'hair' });
  }
}

/** The hair as its own session: cap, bangs, long clumps (checkpoints cap, bangs, clumps). */
/**
 * Clump tags for the design's nine clumps (3 bangs, 2 sides, 3 back, 1 ahoge) plus the scalp mass:
 * bangs and back clumps split by lateral position about the centre line, sides by label.
 */
function tagClumps(m: Model, cx: number): void {
  const put = (faces: FaceSelector, tag: string) => {
    if (faces.evaluate(m.editMesh).length > 0) m.tag(faces, tag);
  };
  const lateral = (from: FaceSelector, tags: [string, string, string], half: number) => {
    put(from.and(box([-9, -9, -9], [cx - half, 9, 9])), tags[0]);
    put(from.and(box([cx - half, -9, -9], [cx + half, 9, 9])), tags[1]);
    put(from.and(box([cx + half, -9, -9], [9, 9, 9])), tags[2]);
  };
  const back = ['hair-back-outer', ...backLobeLabels()].map((l) => sel.createdBy(l)).reduce((x, y) => x.or(y));
  put(back, 'hair-back');
  lateral(back, ['hair-back-l', 'hair-back-c', 'hair-back-r'], 0.07);
  for (const side of ['l', 'r']) {
    const lab = [`hair-side-${side}`, ...sideLockLabels().filter((l) => l.charAt(10) === side)].map((l) => sel.createdBy(l)).reduce((x, y) => x.or(y));
    put(lab, `hair-side-${side}`);
  }
  put(sel.createdBy('hair-cap').or(sel.createdBy('hair-cap-wall')), 'hair-cap');
}

export function buildHair(figure: Model, style: GarmentStyle = {}): Model {
  const m = buildBody();
  m.tag(sel.all(), 'g2-body');
  // Cap: a sheet over the scalp swollen to the hair volume (its hairline rim stays), then shelled.
  m.layer(scalp(), { offset: CAP.lift, conform: true, label: 'hair-cap', tag: 'hair', material: 'hair' });
  const sheet = sel.createdBy('hair-cap');
  const head = centerOf(m, sel.tag('head').minus(sel.createdBy('neck')));
  const center: Tuple3 = [head[0], CAP.centerY, head[2]];
  // The ellipsoid passes inside the cheeks, and the forehead keeps its lift too (the bangs lie
  // on it): only the cap behind and above them swells.
  m.spherize(sheet.shrink(1).minus(box([-1, -1, 0], [1, 0.74, 1])).minus(box([-0.12, -1, 0.06], [0.12, 0.86, 1])), { factor: 1, center, radii: [...CAP.radii], falloff: { radius: 0.03, distance: 'connected' } });
  // Where the swollen cap meets the forehead's lift the face selection leaves a jagged step (a
  // shelf over the bangs): halfway onto the ellipsoid there, pulling the proud corners in and
  // lifting the groove.
  m.spherize(sheet.and(box([-0.13, 0.835, 0.04], [0.13, 0.875, 1])), { factor: 0.5, center, radii: [...CAP.radii], falloff: { radius: 0.015, distance: 'connected' } });
  // Over the forehead the cap (the bangs) lies close: `lift` off the skin, blending into the cap's
  // lift above.
  const skin = sel.tag('head').minus(sel.tag('hair'));
  m.shrinkwrap(sheet.and(box([-0.12, -1, 0.04], [0.12, 0.79, 1])), { onto: skin, offset: BANGS.lift, falloff: { radius: 0.04, distance: 'connected' } });
  // Subdivided once: clump roots are single rows of its (now about 1 cm tall) faces.
  m.subdivide(sheet, { levels: 1 });
  // The remodel's fringe is built over the faceted cap (bangFringe): its front is opened instead.
  if (style.facets === true) bangOpening(m);
  else bangTips(m);
  walled(m, style.facets === true ? style : UNTAPERED, (t, taper) => t.shell(sel.tag('hair'), { thickness: CAP.thickness, direction: 'out', clamp: true, label: 'hair-cap-wall', ...taper }));
  if (style.facets !== true) bangGrooves(m, style);
  m.checkpoint('cap');
  // Unused outer cap faces: a grown clump's root faces leave this set.
  const free = () => sel.createdBy('hair-cap', 'layer');
  // Ahoge: a fat crescent (sheet: 7.7 cm across, 12.5 cm deep, 0.93-1.0 tall) extruded from a
  // patch in front of the crown, its thick root rising up and back to a point at the sheet's
  // tip and leaning to the figure's right.
  const at = (x: number, y: number, z: number): Tuple3 => [center[0] + x, y, center[2] + z];
  const root = centerOf(m, free().and(sel.near(at(0.01, 0.95, 0.09), 1)));
  const ahogePath = [root, at(0.01, 0.955, 0.088), at(-0.004, 0.978, 0.072), at(-0.022, 0.985, 0.044), at(-0.038, 0.988, 0.012), at(-0.046, 0.962, -0.018)];
  if (style.facets === true) {
    const tube = model();
    ahogeFacets(tube, ahogePath);
    tube.weld({ distance: 1e-6 });
    m.append(tube, { tag: 'hair' });
    // The part's tag, for the sheets' per-part measures (the extruded ahoge carried it from its label).
    m.tag(sel.createdBy('hair-ahoge'), 'hair-ahoge');
  } else {
    m.extrude(free().and(sel.near(root, AHOGE.faces)), { path: ahogePath, scale: AHOGE.scale, label: 'hair-ahoge' });
  }
  m.checkpoint('bangs');
  const q = SurfaceQuery.of(m.editMesh, free().evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  // The figure's outermost surface, for the locks to drape on.
  const figureQuery = SurfaceQuery.of(figure.editMesh, sel.all().evaluate(figure.editMesh));
  if (!figureQuery.ok) throw figureQuery.error;
  for (const s of [1, -1] as const) sideMass(m, center, figureQuery.value, s, style);
  // The remodel builds only the outer mass (see LOBES).
  hairMass(m, center, style.facets === true ? MASS.filter((l) => l.name === 'back-outer').map((l) => ({ ...l, lo: CURTAIN.lo, back: CURTAIN.back, scale: CURTAIN.scale })) : MASS, style);
  // Over the cap's outer wall (the shell grew it outward by its thickness).
  const out = CAP.thickness + CROWN.rise;
  const radii: Tuple3 = [CAP.radii[0] + out, CAP.radii[1] + out, CAP.radii[2] + out];
  const height = (polar: number) => center[1] + CAP.radii[1] * Math.cos((polar * Math.PI) / 180);
  for (let k = 0; k < CROWN.count; k++) {
    const az = CROWN.from + ((CROWN.to - CROWN.from) * k) / (CROWN.count - 1);
    let strip = sel.createdBy('__none__');
    for (let b = 0; b < CROWN.bands; b++) {
      const [p0, p1] = [CROWN.polar + ((CROWN.end - CROWN.polar) * b) / CROWN.bands, CROWN.polar + ((CROWN.end - CROWN.polar) * (b + 1)) / CROWN.bands];
      const half = CROWN.half * (1 - (0.6 * b) / (CROWN.bands - 1));
      const [a0, a1] = [((az - half) * Math.PI) / 180, ((az + half) * Math.PI) / 180];
      strip = strip.or(
        free()
          .and(box([-1, height(p1), -1], [1, height(p0), 1]))
          .and(sel.side(center, [Math.cos(a0), 0, -Math.sin(a0)], { by: 'centroid' }))
          .and(sel.side(center, [-Math.cos(a1), 0, Math.sin(a1)], { by: 'centroid' })),
      );
    }
    m.spherize(strip, { factor: 1, center, radii, falloff: { radius: CROWN.falloff, distance: 'connected' } });
  }
  m.checkpoint('clumps');
  tagClumps(m, center[0]);
  m.delete(sel.tag('g2-body').minus(sel.tag('hair')));
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}
