import { type Model, model, resolveCurveSpec, type NurbsCurve, nurbs, type Point2, sel, type SurfacePatch, type Tuple3 } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { type Angles, carFormFrames, carTable, rotation } from './pose.ts';
import { hardwareRadius } from './s5-joints.ts';
import { CAR, fitZ, MECH } from './proportions.ts';
import { rigOver, type TransformRig } from './s4-transform.ts';
import { BOARD, INTAKE, ON_CAR, SECTION_MARGIN, SPLITS, WHEELS } from './s2-body.ts';
import { featureLines, featureY } from './reference.ts';

/**
 * Case C-100 stage S3 (code name mech-gt), car form: the rough model. The S2 block is
 * divided into its main panels as NURBS patches. The hood and front fenders are the C-106
 * panels; every other panel is a patch of one body surface S(z, t): at station z the S2
 * front section, scaled to the S2 plan half-width and side-profile height, with t running
 * from the sill (0) over the shoulder and belt to the roof centerline (1). Panels leave a
 * shut line to their neighbours, wheel arches and intakes are side-view trims, and every
 * panel is a closed 3 mm part tagged with its `parts.json` part or S4 piece.
 */
export const NOSE = CAR.wheelbase.value / 2 + CAR.frontOverhang.value;
export const TAIL = NOSE - CAR.length.value;
const SHUT = 0.004;
const WALL = 0.003;
const ARCH_GAP = 0.035;

/**
 * Section parameter t: from the sill (t = 0) up the side and over the roof to the centerline
 * (t = 1). The section is the S2 hull's at station z: bounded by the side profile (sill, roof)
 * and, at each height y, by the smaller of the plan and section half-widths, with its corners
 * rounded (corner cutting) so the panel grids that interpolate it do not ring. t keeps the
 * meaning of the draft section keys below (share of the half-width u, share of the height
 * above the sill v): the point for t is where the ray from the section center through the
 * key point meets the hull section, so the panel lines (belt, shoulder, roof edge) sit at
 * the same place on every station.
 */
const SECTION: readonly { readonly t: number; readonly u: number; readonly v: number }[] = [
  { t: 0, u: 0.9, v: 0 },
  { t: 0.2, u: 1, v: 0.32 },
  { t: 0.4, u: 0.97, v: 0.67 },
  { t: 0.6, u: 0.79, v: 0.8 },
  { t: 0.8, u: 0.57, v: 0.96 },
  { t: 1, u: 0, v: 1 },
];
/** Section parameters of the panel lines: belt, upper shoulder, roof edge. */
export const T = { belt: 0.4, shoulder: 0.6, roofEdge: 0.8 } as const;
/** Height share of the section center the rays start from. */
const CENTER = 0.3;
const SECTION_SAMPLES = 160;
const Z_STEP = 0.01;

const sectionKeys: NurbsCurve = (() => {
  const c = nurbs.interpolate(SECTION.map((k): Tuple3 => [k.u, k.v, 0]), { parameters: SECTION.map((k) => k.t) });
  if (!c.ok) throw c.error;
  return c.value;
})();

/** Ray angle (from the section center, in units of the normalized box) of each t sample. */
const ANGLES = Array.from({ length: SECTION_SAMPLES + 1 }, (_, i) => {
  const k = nurbs.point(sectionKeys, i / SECTION_SAMPLES);
  return Math.atan2(k[1] - CENTER, k[0]);
});

/** A resolved S2 drawing contour ('profile', 'plan outline' or 'section'). */
const contour = (id: string) => {
  const item = BOARD.items.find((c) => c.id === id);
  if (item?.kind !== 'curve') throw new Error(`no ${id} contour`);
  const r = resolveCurveSpec(item.curve, { closed: true, ...(item.tolerance === undefined ? {} : { tolerance: item.tolerance }) });
  if (!r.ok) throw r.error;
  return r.value.points;
};
const PLAN_OUTLINE = contour('plan outline');

/** Largest `v` where a closed outline crosses the vertical line `u`. */
/** Width (meters) of the u bins that index an outline's segments for `topAt`. */
const TOP_BIN = 0.01;
const TOP_BINS = new WeakMap<readonly Point2[], { readonly lo: number; readonly bins: readonly (readonly number[])[] }>();

/**
 * The segments of a closed outline by u: bin j lists, in order, every segment whose u range
 * meets [lo + j TOP_BIN, lo + (j + 1) TOP_BIN], so a query reads only the segments that can
 * cross it (the profile is sampled millions of times by the deck fairing).
 */
function topBins(outline: readonly Point2[]) {
  let index = TOP_BINS.get(outline);
  if (index === undefined) {
    const lo = Math.min(...outline.map((p) => p[0]));
    const bins: number[][] = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i] as Point2;
      const b = outline[(i + 1) % outline.length] as Point2;
      const j0 = Math.floor((Math.min(a[0], b[0]) - lo) / TOP_BIN);
      const j1 = Math.floor((Math.max(a[0], b[0]) - lo) / TOP_BIN);
      for (let j = j0; j <= j1; j++) (bins[j] ??= []).push(i);
    }
    index = { lo, bins };
    TOP_BINS.set(outline, index);
  }
  return index;
}

function topAt(outline: readonly Point2[], u: number): number {
  let best = -Infinity;
  const { lo, bins } = topBins(outline);
  for (const i of bins[Math.floor((u - lo) / TOP_BIN)] ?? []) {
    const a = outline[i] as Point2;
    const b = outline[(i + 1) % outline.length] as Point2;
    if ((a[0] - u) * (b[0] - u) > 0 || a[0] === b[0]) continue;
    best = Math.max(best, a[1] + ((u - a[0]) * (b[1] - a[1])) / (b[0] - a[0]));
  }
  return best;
}

/** S2 side-profile height at station z (side view u = -z). */
export const profileY = (z: number): number => topAt(SIDE_OUTLINE, -z);

/** S2 plan half-width at station z (top view u = x, v = -z). */
export function planHalf(z: number): number {
  let best = 0;
  for (let i = 0; i < PLAN_OUTLINE.length; i++) {
    const a = PLAN_OUTLINE[i] as Point2;
    const b = PLAN_OUTLINE[(i + 1) % PLAN_OUTLINE.length] as Point2;
    if ((a[1] + z) * (b[1] + z) > 0 || a[1] === b[1]) continue;
    best = Math.max(best, a[0] + ((-z - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  return best;
}

const SECTION_OUTLINE = contour('section');

/** Measured half-width at height y: the S2 section contour less its boolean margin. */
function sectionHalf(y: number): number {
  let best = 0;
  for (let i = 0; i < SECTION_OUTLINE.length; i++) {
    const a = SECTION_OUTLINE[i] as Point2;
    const b = SECTION_OUTLINE[(i + 1) % SECTION_OUTLINE.length] as Point2;
    if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue;
    best = Math.max(best, Math.abs(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])));
  }
  return best - SECTION_MARGIN;
}

const SIDE_OUTLINE = contour('profile');

/** Lowest point of the side outline at station z (the sill line). */
function sillY(z: number): number {
  let best = Infinity;
  for (let i = 0; i < SIDE_OUTLINE.length; i++) {
    const a = SIDE_OUTLINE[i] as Point2;
    const b = SIDE_OUTLINE[(i + 1) % SIDE_OUTLINE.length] as Point2;
    if ((a[0] + z) * (b[0] + z) > 0 || a[0] === b[0]) continue;
    const s = (-z - a[0]) / (b[0] - a[0]);
    best = Math.min(best, a[1] + s * (b[1] - a[1]));
  }
  return best;
}

/** The body surface point at station z, section parameter t, on the side `sign` (+1 left). */
/** The hull section at station z, resampled to SECTION_SAMPLES + 1 points by arc length. */
/**
 * Roof height of the body surface: the side profile with peaks narrower than FIN removed
 * (an opening: the lowest value within FIN/2, then the highest of those), so the tail-lamp
 * fins of the outline do not fold the panels; the fins are their own detail parts.
 */
const FIN = 0.08;
function openedRoof(z: number): number {
  const n = 8;
  const low = (c: number) => Math.min(...Array.from({ length: n + 1 }, (_, k) => profileY(c - FIN / 2 + (FIN * k) / n)));
  return Math.max(...Array.from({ length: n + 1 }, (_, k) => low(z - FIN / 2 + (FIN * k) / n)));
}

/**
 * Over the engine cover the drawn roof line steps over its ribs: there the dips narrower than
 * DECK.dip close up (max, then min) and the line is averaged over DECK.fair, so the deck and the
 * haunches below it stay fair. Elsewhere the opened line is the roof.
 */
const DECK = { from: TAIL + 0.35, to: SPLITS.deck - 0.05, dip: 0.2, fair: 0.18, blend: 0.15 } as const;
const ROOF = new Map<number, number>();
function roofY(z: number): number {
  const w = Math.min(1, Math.max(0, Math.min(z - DECK.from, DECK.to - z) / DECK.blend + 1));
  if (w <= 0) return openedRoof(z);
  const key = Math.round((z - TAIL) / 0.005);
  let v = ROOF.get(key);
  if (v === undefined) {
    const span = (c: number, width: number, f: (x: number) => number) => Array.from({ length: 9 }, (_, k) => f(c - width / 2 + (width * k) / 8));
    const closed = (c: number) => Math.min(...span(c, DECK.dip, (x) => Math.max(...span(x, DECK.dip, openedRoof))));
    const fair = span(z, 2 * DECK.fair, closed);
    v = fair.reduce((a, b) => a + b, 0) / fair.length;
    ROOF.set(key, v);
  }
  return v * w + openedRoof(z) * (1 - w);
}

/** Spacing (meters) of the raw section samples before corner cutting. */
const SECTION_STEP = 0.012;

function hullSection(z: number): Point2[] {
  const half = planHalf(z);
  const floor = sillY(z);
  const top = roofY(z);
  // Samples at fixed heights and widths (not fractions of the section), so the corner cutting
  // below rounds the same corners the same way from one station to the next.
  const raw: Point2[] = [];
  for (let y = floor; y < top - SECTION_STEP / 2; y += SECTION_STEP) raw.push([Math.min(half, sectionHalf(y)), y]);
  raw.push([Math.min(half, sectionHalf(top)), top]);
  const xTop = (raw.at(-1) as Point2)[0];
  for (let x = xTop - SECTION_STEP; x > SECTION_STEP / 2; x -= SECTION_STEP) raw.push([x, top]);
  raw.push([0, top]);
  // Corner cutting (Chaikin), ends fixed.
  let line = raw;
  for (let it = 0; it < 4; it++) {
    const next: Point2[] = [line[0] as Point2];
    for (let k = 0; k + 1 < line.length; k++) {
      const [a, b] = [line[k] as Point2, line[k + 1] as Point2];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    next.push(line.at(-1) as Point2);
    line = next;
  }
  // Angles of the boundary points from the section center, measured in the box normalized by
  // the half-width and the height, so they compare with the key angles.
  const cy = floor + CENTER * (top - floor);
  const angle = line.map(([x, y]) => Math.atan2((y - cy) / Math.max(1e-9, top - floor), x / Math.max(1e-9, half)));
  // Where the section is not star-shaped about the center, rays would jump back and forth
  // along it; following the outline in order with non-decreasing angles keeps t monotone.
  for (let k = 1; k < angle.length; k++) angle[k] = Math.max(angle[k] as number, angle[k - 1] as number);
  // The keys' angle range maps onto this section's, so t = 0 and t = 1 are its ends.
  const [k0, k1] = [ANGLES[0] as number, ANGLES.at(-1) as number];
  const [s0, s1] = [angle[0] as number, angle.at(-1) as number];
  const out: Point2[] = [];
  let j = 0;
  for (const key of ANGLES) {
    const target = s0 + ((key - k0) * (s1 - s0)) / (k1 - k0);
    while (j + 2 < line.length && (angle[j + 1] as number) < target) j++;
    const [a0, a1] = [angle[j] as number, angle[j + 1] as number];
    const f = Math.min(1, Math.max(0, (target - a0) / ((a1 - a0) || 1)));
    const [a, b] = [line[j] as Point2, line[j + 1] as Point2];
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

const RAW_SECTIONS = new Map<number, Point2[]>();
const SECTIONS = new Map<number, Point2[]>();
/** Half-width (stations) of the moving average that fairs the body along z: the measured outlines are polylines. */
const SECTION_FAIR = 2;
function rawSection(i: number): Point2[] {
  let s = RAW_SECTIONS.get(i);
  if (s === undefined) {
    s = hullSection(Math.min(NOSE, Math.max(TAIL, TAIL + i * Z_STEP)));
    RAW_SECTIONS.set(i, s);
  }
  return s;
}
function sectionAt(i: number): Point2[] {
  let s = SECTIONS.get(i);
  if (s === undefined) {
    const last = Math.round((NOSE - TAIL) / Z_STEP);
    const ks: number[] = [];
    for (let d = -SECTION_FAIR; d <= SECTION_FAIR; d++) if (i + d >= 0 && i + d <= last) ks.push(i + d);
    const all = ks.map(rawSection);
    s = (all[0] as Point2[]).map((_, j): Point2 => [all.reduce((a, q) => a + (q[j] as Point2)[0], 0) / all.length, all.reduce((a, q) => a + (q[j] as Point2)[1], 0) / all.length]);
    SECTIONS.set(i, s);
  }
  return s;
}

/** The body surface point at station z, section parameter t, on the side `sign` (+1 left). */
export function bodyPoint(z: number, t: number, sign: 1 | -1): Tuple3 {
  const f = (z - TAIL) / Z_STEP;
  const i = Math.floor(f);
  const w = f - i;
  const c = Math.min(1, Math.max(0, t)) * SECTION_SAMPLES;
  const k = Math.min(SECTION_SAMPLES - 1, Math.floor(c));
  const u = c - k;
  const pick = (sec: Point2[]): Point2 => {
    const a = sec[k] as Point2;
    const b = sec[k + 1] as Point2;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  const p = pick(sectionAt(i));
  const q = pick(sectionAt(i + 1));
  const y = p[1] + (q[1] - p[1]) * w;
  return [sign * (p[0] + (q[0] - p[0]) * w - scoop(z, y)), y, z];
}

/**
 * The side scoop (form language from the blueprint): between the waist and sill creases the
 * flank sinks by SCOOP.depth from the door's front back to the rear fender, around the
 * side-intake opening; the steps at the two lines are the creases.
 */
/** The scoop lies between the blueprint's waist and sill creases, over the sill crease's z extent. */
const SCOOP = { depth: 0.03, front: [0.7, 0.4], rear: [-0.75, -0.9], crease: 0.03, floor: 0.05 } as const;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
let waistAt: ((z: number) => number | undefined) | undefined;
let sillAt: ((z: number) => number | undefined) | undefined;
function scoop(z: number, y: number): number {
  const wz = smooth((SCOOP.front[0] - z) / (SCOOP.front[0] - SCOOP.front[1])) * smooth((z - SCOOP.rear[1]) / (SCOOP.rear[0] - SCOOP.rear[1]));
  if (wz === 0) return 0;
  waistAt ??= heldFeatureY('waist');
  sillAt ??= heldFeatureY('sill');
  const wy = smooth(((waistAt(z) as number) - y) / SCOOP.crease) * smooth((y - (sillAt(z) as number)) / SCOOP.floor);
  return SCOOP.depth * wz * wy;
}

/** A side feature line's height on the car, held at its end values past its ends. */
function heldFeatureY(name: string): (z: number) => number {
  const yAt = featureY(name, ON_CAR);
  const zs = featureLines(name, ON_CAR).flat().map((q) => q[0]);
  const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
  return (z) => yAt(Math.min(z1, Math.max(z0, z))) as number;
}

/**
 * A panel: the body surface over [z0, z1] x [t0, t1], inset by the shut line, as a NURBS
 * patch through a grid. `lift` raises it off the body surface along the surface normal
 * (meters), for parts that sit on a panel.
 */
export function patch(name: string, z0: number, z1: number, t0: TLine, t1: TLine, sign: 1 | -1, extra: Partial<SurfacePatch> = {}, lift = 0): SurfacePatch {
  return grid(name, z0, z1, t0, t1, sign, [true, true], extra, lift);
}

/** One half of a part that spans the centerline: no shut line at t = 1, where it welds to its mirror. */
function centerPatch(name: string, z0: number, z1: number, t0: TLine, sign: 1 | -1): SurfacePatch {
  return grid(name, z0, z1, t0, 1, sign, [true, false], {});
}

/** A t boundary of a patch: a constant section parameter, or one that follows a feature line along z. */
export type TLine = number | ((z: number) => number);
const tAt = (line: TLine, z: number): number => (typeof line === 'number' ? line : line(z));

function grid(name: string, z0: number, z1: number, t0: TLine, t1: TLine, sign: 1 | -1, inset: readonly [boolean, boolean], extra: Partial<SurfacePatch>, lift = 0): SurfacePatch {
  const zm = (z0 + z1) / 2;
  const nz = Math.max(4, Math.ceil(Math.abs(z1 - z0) / 0.06));
  const nt = Math.max(4, Math.ceil(Math.abs(tAt(t1, zm) - tAt(t0, zm)) / 0.04));
  // Shut line along t: half of SHUT in meters, plus the wall's lean where the section turns
  // across the line (the inner walls of two panels meeting at an angle close in by
  // WALL x tan(angle / 2) each); the largest over the patch's stations, as a t offset.
  // A constant line takes the largest inset over the patch's stations; a feature line its own station's.
  const tInset = (line: TLine, zRow: number): number => {
    let best = 0;
    const stations = typeof line === 'number' ? Array.from({ length: 9 }, (_, k) => z0 + ((z1 - z0) * k) / 8) : [zRow];
    for (const z of stations) {
      const t = tAt(line, z);
      const at = (tt: number) => bodyPoint(z, Math.min(1, Math.max(0, tt)), 1);
      const dir = (tt: number): Tuple3 => {
        const [p, q] = [at(tt - 1e-3), at(tt + 1e-3)];
        const d: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        const l = Math.hypot(...d) || 1;
        return [d[0] / l, d[1] / l, d[2] / l];
      };
      const [p, q] = [at(t - 1e-3), at(t + 1e-3)];
      const speed = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / (Math.min(1, t + 1e-3) - Math.max(0, t - 1e-3)) || 1;
      const h = 0.01 / speed;
      // At the centerlines (t = 0, 1) the section continues on its mirror half.
      const u = dir(t - h);
      const w: Tuple3 = t >= 1 || t <= 0 ? [u[0], -u[1], u[2]] : dir(t + h);
      const angle = Math.acos(Math.min(1, Math.max(-1, u[0] * w[0] + u[1] * w[1] + u[2] * w[2])));
      best = Math.max(best, (SHUT / 2 + WALL * Math.tan(angle / 2)) / speed);
    }
    return best;
  };
  const a = (z: number) => tAt(t0, z) + (inset[0] ? tInset(t0, z) : 0);
  const b = (z: number) => tAt(t1, z) - (inset[1] ? tInset(t1, z) : 0);
  // Shut line across z: half of SHUT, plus the wall's reach along z where the surface turns
  // toward the ends (its inner wall leans over the cut by WALL times the normal's z share).
  const zInset = (z: number) => {
    let nz = 0;
    for (let j = 0; j <= 8; j++) {
      const t = a(z) + ((b(z) - a(z)) * j) / 8;
      const p = bodyPoint(z - 0.005, t, 1);
      const q = bodyPoint(z + 0.005, t, 1);
      const slope = Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.01;
      nz = Math.max(nz, slope / Math.hypot(1, slope));
    }
    return SHUT / 2 + WALL * nz;
  };
  const d0 = zInset(z0);
  const d1 = zInset(z1);
  const rows: Tuple3[][] = [];
  for (let i = 0; i <= nz; i++) {
    const z = z1 - d1 - ((z1 - z0 - d0 - d1) * i) / nz;
    const row: Tuple3[] = [];
    const [ra, rb] = [a(z), b(z)];
    for (let j = 0; j <= nt; j++) row.push(lifted(z, ra + ((rb - ra) * j) / nt, sign, lift));
    rows.push(row);
  }
  const s = nurbs.grid(sign > 0 ? rows : rows.map((r) => [...r].reverse()));
  if (!s.ok) throw s.error;
  return { surface: s.value, name, ...extra };
}

/** The body surface point at (z, t) moved `d` meters along its outward normal. */
export function lifted(z: number, t: number, sign: 1 | -1, d: number): Tuple3 {
  const p = bodyPoint(z, t, sign);
  if (d === 0) return p;
  const e = 1e-4;
  const diff = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dz = diff(bodyPoint(z + e, t, sign), bodyPoint(z - e, t, sign));
  const dt = diff(bodyPoint(z, t + e, sign), bodyPoint(z, t - e, sign));
  const n: Tuple3 = [dz[1] * dt[2] - dz[2] * dt[1], dz[2] * dt[0] - dz[0] * dt[2], dz[0] * dt[1] - dz[1] * dt[0]];
  // Outward: away from the section center line (x = 0, half the roof height).
  const s = (n[0] * p[0] + n[1] * (p[1] - profileY(z) / 2) >= 0 ? 1 : -1) / Math.hypot(...n);
  return [p[0] + d * s * n[0], p[1] + d * s * n[1], p[2] + d * s * n[2]];
}

function circle(cx: number, cy: number, r: number, n = 72): Point2[] {
  return Array.from({ length: n }, (_, k): Point2 => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);
}

/** Side-view trim of a wheel arch (right view u = -z, left view u = z). */
function archTrim(sign: 1 | -1, wheel: { readonly z: number; readonly d: number }): NonNullable<SurfacePatch['trims']> {
  const view = sign > 0 ? 'right' : 'left';
  const u = sign > 0 ? -wheel.z : wheel.z;
  return [{ view, region: circle(u, wheel.d / 2, wheel.d / 2 + ARCH_GAP) }];
}

/**
 * Open the side intakes: the blueprint outline knife-projected across the car onto the door
 * and side-intake panels it spans (it crosses their seam, where a per-patch trim leaves a
 * sliver), and the faces inside it removed.
 */
export function cutIntakes(m: Model): void {
  for (const sign of [1, -1] as const) {
    const side = sign > 0 ? 'l' : 'r';
    const label = `intake-cut-${side}`;
    m.knife({ points: INTAKE.map(([z, y]): Tuple3 => [sign * 2, y, z]), direction: [-sign, 0, 0], closed: true, faces: sel.tag(`part:door-${side}-outer`).or(sel.tag(`part:side-intake-${side}`)), label });
    m.delete(sel.createdBy(label, 'inside'));
  }
}


const REAR_AXLE = -CAR.wheelbase.value / 2;
const rearWheel = WHEELS.find((w) => w.name === 'rl') as (typeof WHEELS)[number];
const frontWheel = WHEELS.find((w) => w.name === 'fl') as (typeof WHEELS)[number];

/** Every panel of the car form, by part (or S4 piece) name: patches of the one body surface. */
/** Section parameter whose body point at station z has height y (bisection over the side, where height grows with t). */
export function tForY(z: number, y: number): number {
  let [lo, hi] = [0.02, 0.95];
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (bodyPoint(z, mid, 1)[1] < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Half-width (meters) of the moving average that fairs a feature line. */
const LINE_FAIR = 0.06;

/**
 * A panel boundary that follows a blueprint feature line (criterion 9): the section parameter
 * whose side height is the line's, held at the line's end values past its ends, clamped to
 * [lo, hi]; tabulated per centimeter.
 */
function featureT(name: string, lo: number, hi: number): (z: number) => number {
  const yAt = featureY(name, ON_CAR);
  const zs = featureLines(name, ON_CAR).flat().map((q) => q[0]);
  const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
  const raw = new Map<number, number>();
  const table = new Map<number, number>();
  const solve = (k: number): number => {
    let v = raw.get(k);
    if (v === undefined) {
      const zc = Math.min(z1, Math.max(z0, TAIL + k * Z_STEP));
      v = Math.min(hi, Math.max(lo, tForY(zc, yAt(zc) as number)));
      raw.set(k, v);
    }
    return v;
  };
  // The drawn line is a polyline: averaged over LINE_FAIR either side, so the panels it bounds stay fair.
  const n = Math.round(LINE_FAIR / Z_STEP);
  const get = (k: number) => {
    let v = table.get(k);
    if (v === undefined) {
      v = 0;
      for (let d = -n; d <= n; d++) v += solve(k + d);
      v /= 2 * n + 1;
      table.set(k, v);
    }
    return v;
  };
  return (z) => {
    const i = Math.floor((z - TAIL) / Z_STEP);
    const f = (z - TAIL) / Z_STEP - i;
    return get(i) * (1 - f) + get(i + 1) * f;
  };
}

/** The panel boundaries on blueprint feature lines: the rear shoulder crease and the side-glass lower edge. */
export const LINES = {
  shoulder: featureT('shoulder', T.belt + 0.08, T.roofEdge - 0.08),
  belt: featureT('belt', 0.25, T.roofEdge - 0.1),
} as const;

export function bodyPatches(): Record<string, SurfacePatch[]> {
  const s = SPLITS;
  const out: Record<string, SurfacePatch[]> = {};
  const add = (part: string, p: SurfacePatch) => {
    out[part] = [...(out[part] ?? []), p];
  };
  // Center pieces span both halves: one patch per side, tagged with the same part.
  for (const sign of [1, -1] as const) {
    const side = sign > 0 ? 'l' : 'r';
    add(`hood-${side}`, patch(`hood-${side}`, s.cowl, s.bumper, T.shoulder, 1, sign));
    add(`front-fender-${side}`, patch(`front-fender-${side}`, s.doorFront, s.bumper, 0, T.shoulder, sign, { trims: archTrim(sign, frontWheel) }));
    add('windshield', centerPatch(`windshield-${side}`, s.doorFront - 0.1, s.cowl, T.roofEdge + 0.04, sign));
    // A-pillar base between the front fender, the door glass and the windshield.
    add('windshield', patch(`a-pillar-${side}`, s.doorFront, s.cowl, T.shoulder, T.roofEdge + 0.04, sign));
    // The foot starts at the fixed belt: the measured belt line runs lower and wider here, into
    // the stowed arm's sweep (S7), so the door takes the strip below and leaves with the arm.
    add('windshield', patch(`a-pillar-${side}-foot`, s.doorFront - 0.1, s.doorFront, T.belt, T.roofEdge + 0.04, sign));
    add(`door-${side}-outer`, patch(`door-${side}-sail`, s.doorFront - 0.1, s.doorFront, LINES.belt, T.belt, sign));
    add('roof-front', centerPatch(`roof-front-${side}`, fitZ(0), s.doorFront - 0.1, T.roofEdge, sign));
    add('roof-rear', centerPatch(`roof-rear-${side}`, s.deck, 0, T.roofEdge, sign));
    add(`door-${side}-outer`, patch(`door-${side}-outer`, s.doorRear, s.doorFront, 0, LINES.belt, sign));
    add(`door-${side}-inner`, patch(`door-${side}-glass`, s.doorRear, s.doorFront - 0.1, LINES.belt, T.roofEdge, sign));
    add('roof-rear', patch(`c-pillar-${side}`, s.deck, s.doorRear, LINES.shoulder, T.roofEdge, sign));
    // One patch around the intake, up to the shoulder line; the S6 panels open it (`cutIntakes`).
    add(`side-intake-${side}`, patch(`side-intake-${side}`, s.intakeRear, s.doorRear, 0, LINES.shoulder, sign));
    add(`rear-fender-${side}-front`, patch(`rear-fender-${side}-front`, REAR_AXLE, s.intakeRear, 0, LINES.shoulder, sign, { trims: archTrim(sign, rearWheel) }));
    add(`rear-fender-${side}-rear`, patch(`rear-fender-${side}-rear`, s.tail, REAR_AXLE, 0, LINES.shoulder, sign, { trims: archTrim(sign, rearWheel) }));
    add(`engine-cover-${side}`, patch(`engine-cover-${side}`, s.tail, s.deck, LINES.shoulder, 1, sign));
    add(`bumper-corner-${side}`, patch(`bumper-corner-${side}`, s.bumper + 0.02, BODY_NOSE, 0, 0.5, sign));
    add('bumper-center', centerPatch(`bumper-center-${side}`, s.bumper + 0.02, BODY_NOSE, 0.5, sign));
    add(`diffuser-${side}`, patch(`diffuser-${side}`, TAIL + TAIL_END, s.tail, 0, 0.5, sign));
    add('diffuser-center', centerPatch(`diffuser-center-${side}`, TAIL + TAIL_END, s.tail, 0.5, sign));
  }
  return out;
}

/**
 * Closures of the body: what makes the panel set a closed silhouette in every view.
 * - a nose cap (the lower grille, `bumper-center`) and a tail cap (the diffuser face,
 *   `diffuser-center`): flat 3 mm plates filling the hull section where the panels end;
 * - the side-intake back walls (`side-intake-l/r`): 3 mm plates behind the intake opening;
 * - the wheel-arch liners: 3 mm cylinder bands behind each arch, over the tire, tagged with
 *   the fender piece they sit in (the rear ones split at the axle like the fenders).
 * Each is a closed part on its own, clear of the panels it closes.
 */
export interface Closure {
  readonly part: string;
  readonly kind: 'fascia' | 'intake-wall' | 'arch-liner';
  readonly build: () => Model;
}

const INSET = 0.01;
/** The rear panels stop this far ahead of the tail: the last centimeters are the lamp fins' jagged outline. */
const TAIL_END = 0.075;
/** Where the rear panels begin (the body's rear end; the tail lid closes it). */
export const BODY_TAIL = TAIL + TAIL_END;
/** The panels stop NOSE_END short of the nose, where the nose turns steep; the front fascia carries on. */
const NOSE_END = 0.05;
export const BODY_NOSE = NOSE - NOSE_END;
const LINER = { reach: 0.015, wall: 0.003, depth: 0.12 } as const;

/**
 * A lid on the open end of the panels at station z: the hull section there (shrunk by INSET),
 * 3 mm thick, 1 mm beyond the panel ends in the direction `outward` (+1 toward the nose).
 */
/** The body section at z, inset by INSET from the skin, as a closed outline (both sides). */
function insetOutline(z: number): Point2[] {
  const f = (z - TAIL) / Z_STEP;
  const i = Math.floor(f);
  const [a, b] = [sectionAt(i), sectionAt(i + 1)];
  const sec = a.map((p, j): Point2 => [p[0] + ((b[j] as Point2)[0] - p[0]) * (f - i), p[1] + ((b[j] as Point2)[1] - p[1]) * (f - i)]);
  const floor = (sec[0] as Point2)[1];
  const top = Math.max(...sec.map((p) => p[1]));
  const half = Math.max(...sec.map((p) => p[0]));
  const shrink = ([x, y]: Point2): Point2 => [x * (1 - INSET / half), floor + INSET + (y - floor) * (1 - (2 * INSET) / (top - floor))];
  const side = sec.map(shrink);
  return [...side, ...[...side].reverse().slice(1).map(([x, y]): Point2 => [-x, y])].filter((p, i, all) => i === 0 || Math.hypot(p[0] - (all[i - 1] as Point2)[0], p[1] - (all[i - 1] as Point2)[1]) > 1e-4);
}

/**
 * The fascias: solids lofted through the inset body sections from just beyond the panel
 * ends to the nose (`front`) or the tail (`rear`), where the sections turn too steep or
 * narrow too fast for shelled panels.
 */
function fasciaProfiles(end: 'front' | 'rear'): Tuple3[][] {
  const [from, step, limit] = end === 'front' ? [BODY_NOSE + 0.001, Z_STEP, NOSE] : [BODY_TAIL - 0.001, -Z_STEP, TAIL];
  const profiles: Tuple3[][] = [];
  for (let z = from; (limit - z) * Math.sign(step) > 0; z += step) {
    const outline = insetOutline(z);
    const ys = outline.map((p) => p[1]);
    // The last centimeters close to a sliver: a fascia ends where its section is still FASCIA_MIN tall.
    if (Math.max(...ys) - Math.min(...ys) < FASCIA_MIN) break;
    profiles.push(outline.map(([x, y]): Tuple3 => [x, y, z]));
  }
  return profiles;
}

/** The outer face of a fascia: its station and the height range of its section. */
export function fasciaEnd(end: 'front' | 'rear'): { readonly z: number; readonly y: readonly [number, number] } {
  const last = fasciaProfiles(end).at(-1) as Tuple3[];
  const ys = last.map((p) => p[1]);
  return { z: (last[0] as Tuple3)[2], y: [Math.min(...ys), Math.max(...ys)] };
}

function fascia(end: 'front' | 'rear', part: string, material: string): Model {
  const m = model();
  m.loft({ profiles: fasciaProfiles(end), match: 'index', label: `${end}-fascia`, tag: `part:${part}`, material });
  return m;
}

/**
 * The rear fascia in three pieces split along x: the outer two ride the toe caps
 * (diffuser-l/r) and leave with the feet, the center stays on the pelvis skirt.
 */
const FASCIA_SPLIT = { x: 0.25, gap: 0.003 } as const;
function rearFasciaPiece(piece: 'l' | 'center' | 'r'): Model {
  const part = piece === 'center' ? 'diffuser-center' : `diffuser-${piece}`;
  const half = FASCIA_SPLIT.gap / 2;
  const [x0, x1] = piece === 'l' ? [FASCIA_SPLIT.x + half, 2] : piece === 'r' ? [-2, -FASCIA_SPLIT.x - half] : [-FASCIA_SPLIT.x + half, FASCIA_SPLIT.x - half];
  const m = model();
  m.loft({ profiles: fasciaProfiles('rear'), match: 'index', label: `rear-fascia-${piece}`, material: 'carbon' });
  const slab = model();
  slab.box({ size: [x1 - x0, 2, 1], center: [(x0 + x1) / 2, 0.6, TAIL + 0.3] });
  m.intersection(slab, { label: `rear-fascia-${piece}-cut`, material: 'carbon' });
  m.tag(sel.all(), `part:${part}`);
  return m;
}
const FASCIA_MIN = 0.05;

/** The intake back wall on the side `sign`: the side-view intake outline as a 3 mm plate, LINER.depth inside the skin. */
function intakeWall(sign: 1 | -1): Model {
  const side = sign > 0 ? 'l' : 'r';
  const zs = INTAKE.map(([z]) => z);
  const x = Math.min(...zs.map((z) => planHalf(z))) - LINER.depth;
  const m = model();
  // Drawn in XY as (z, y), extruded along +Z, then turned so the plate lies in a z-y plane.
  m.extrudePolygon({ points: INTAKE.map(([z, y]): Point2 => [z, y]), depth: LINER.wall, label: `intake-wall-${side}`, tag: `part:side-intake-${side}`, material: 'intake' });
  m.rotate(sel.all(), 'y', -90);
  m.translate(sel.all(), [sign > 0 ? x : -x + LINER.wall, 0, 0]);
  return m;
}

/** The arch liner of a wheel: a cylinder band over the tire above the sill, split at the axle into `parts[0]` (ahead) and `parts[1]` (behind). */
function archLiner(w: (typeof WHEELS)[number], parts: readonly [string, string]): Model {
  const sign = w.x > 0 ? 1 : -1;
  const r = w.d / 2 + ARCH_GAP + LINER.wall;
  const cy = w.d / 2;
  const floor = CAR.groundClearance.value + 0.01;
  const phi0 = Math.asin(Math.max(-1, (floor - cy) / r));
  const inner = Math.abs(w.x) - w.w / 2 - LINER.reach;
  const m = model();
  for (const [k, part] of parts.entries()) {
    // Ahead of the axle: phi from phi0 to 90 degrees; behind it: 90 degrees to 180 - phi0.
    const [a0, a1] = k === 0 ? [phi0, Math.PI / 2] : [Math.PI / 2, Math.PI - phi0];
    const rows: Tuple3[][] = [];
    for (let i = 0; i <= 8; i++) {
      const phi = a0 + ((a1 - a0) * i) / 8;
      const [y, z] = [cy + r * Math.sin(phi), w.z + r * Math.cos(phi)];
      // Out to just inside the skin at this point of the arch (the body narrows higher up).
      const outer = Math.min(planHalf(z), sectionHalf(y)) - INSET - 2 * LINER.wall;
      rows.push([0, 1, 2, 3].map((j): Tuple3 => [sign * (inner + ((outer - inner) * j) / 3), y, z]));
    }
    const g = nurbs.grid(sign > 0 ? rows : rows.map((row) => [...row].reverse()));
    if (!g.ok) throw g.error;
    const piece = model();
    piece.surface({ patches: [{ surface: g.value, name: `liner-${part}` }], chord: 0.003, angle: 10, label: `liner-${part}`, tag: `part:${part}`, material: 'underside' });
    piece.shell(sel.all(), { thickness: LINER.wall, label: 'liner-wall' });
    m.append(piece);
  }
  return m;
}

export function closures(): Closure[] {
  const out: Closure[] = [
    { part: 'bumper-center', kind: 'fascia', build: () => fascia('front', 'bumper-center', 'paint') },
    ...(['l', 'center', 'r'] as const).map((piece): Closure => ({ part: piece === 'center' ? 'diffuser-center' : `diffuser-${piece}`, kind: 'fascia', build: () => rearFasciaPiece(piece) })),
  ];
  for (const sign of [1, -1] as const) {
    const side = sign > 0 ? 'l' : 'r';
    out.push({ part: `side-intake-${side}`, kind: 'intake-wall', build: () => intakeWall(sign) });
  }
  for (const w of WHEELS) {
    const side = w.x > 0 ? 'l' : 'r';
    const parts: readonly [string, string] = w.z > 0 ? [`front-fender-${side}`, `front-fender-${side}`] : [`rear-fender-${side}-front`, `rear-fender-${side}-rear`];
    out.push({ part: parts[0], kind: 'arch-liner', build: () => archLiner(w, parts) });
  }
  return out;
}

/** A tire and rim along X: lathed about +Y, then turned onto X and placed. */
function wheel(m: Model, part: string, w: (typeof WHEELS)[number]): void {
  const r = w.d / 2;
  const rim = w.rim / 2;
  m.revolve({ points: [[rim, -w.w / 2], [r - 0.02, -w.w / 2], [r, -w.w / 2 + 0.03], [r, w.w / 2 - 0.03], [r - 0.02, w.w / 2], [rim, w.w / 2], [rim, -w.w / 2]], segments: 48, label: `${part}-tire`, tag: part, material: 'tire' });
  m.cylinder({ radiusTop: rim - 0.004, radiusBottom: rim - 0.004, height: w.w * 0.8, radialSegments: 48, label: `${part}-rim`, tag: part, material: 'rim' });
  m.rotate(sel.tag(part), 'z', 90);
  m.translate(sel.tag(part), [w.x, r, w.z]);
}

/**
 * `closed` (default): every panel is a closed 3 mm part, for drawings and export.
 * `sheet`: the panels stay open surfaces; the interference scan uses this form, since a
 * closed panel's penetration depth cannot exceed half its wall and thin panels slicing
 * through each other would stay unconfirmed.
 */
export type PanelForm = 'closed' | 'sheet';

export function buildS3Car(session: SessionFactory = () => model(), form: PanelForm = 'closed'): Model {
  const m = session('car');
  const panels = session('panels');
  for (const [part, patches] of Object.entries(bodyPatches())) {
    panels.surface({ patches, chord: 0.003, angle: 12, label: part, tag: `part:${part}`, material: 'paint' });
  }
  panels.assign(sel.tag('part:windshield').minus(sel.tag('a-pillar-l')).minus(sel.tag('a-pillar-r')).minus(sel.tag('a-pillar-l-foot')).minus(sel.tag('a-pillar-r-foot')).or(sel.tag('part:door-l-inner')).or(sel.tag('part:door-r-inner')), 'glass');
  panels.cleanup.slivers(undefined, { width: 0.0002, quiet: true });
  if (form === 'closed') {
    panels.shell(sel.all(), { thickness: WALL, label: 'wall' });
    // The offset inner wall bends quads past the planarity tolerance where the panels curve
    // tightly (the nose corners; elsewhere on other proportions): its faces are triangles.
    panels.triangulate(sel.createdBy('wall', 'inner'));
    panels.uv.project({ mode: 'box', scale: 1, faces: sel.createdBy('wall', 'rim') });
    panels.uv.project({ mode: 'box', scale: 1, faces: sel.createdBy('wall', 'rim'), channel: 'uv1' });
  }
  if (panels.poisoned !== undefined) throw panels.poisoned;
  // Through a snapshot: a trim that meets a patch boundary leaves one unused vertex in the surface session (reported).
  m.append(panels.snapshot());
  m.checkpoint('panels');
  for (const c of closures()) {
    const part = c.build();
    for (const channel of ['uv0', 'uv1'] as const) part.uv.project({ mode: 'box', scale: 1, channel });
    m.append(part.snapshot());
  }
  m.checkpoint('closures');
  for (const w of WHEELS) wheel(m, `${w.z > 0 ? 'front' : 'rear'}-wheel-${w.x > 0 ? 'l' : 'r'}`, w);
  for (const w of WHEELS) m.tag(sel.tag(`${w.z > 0 ? 'front' : 'rear'}-wheel-${w.x > 0 ? 'l' : 'r'}`), `part:${w.z > 0 ? 'front' : 'rear'}-wheel-${w.x > 0 ? 'l' : 'r'}`);
  m.checkpoint('wheels');
  const wheels = sel.tag('front-wheel-l').or(sel.tag('front-wheel-r')).or(sel.tag('rear-wheel-l')).or(sel.tag('rear-wheel-r'));
  m.uv.project({ mode: 'box', scale: 1, faces: wheels });
  m.uv.project({ mode: 'box', scale: 1, faces: wheels, channel: 'uv1' });
  return m;
}

/**
 * Mech-form volumes: one lofted octagonal block per body segment, built in the mech frame
 * and placed at its joint's car-form frame (the rig rest pose), so in the car form every
 * block lies folded inside the body. The block rides `joint`, runs from `from` to `to`
 * and stops short of both ends: at least `clear`, and outside the S5 mechanism sphere
 * (`hardwareRadius`) of the joints at its ends, so the joint hardware fits in any pose.
 */
interface Segment {
  readonly part: string;
  readonly joint: string;
  readonly from: Tuple3;
  readonly to: Tuple3;
  /** Width (mech x) and depth (mech z) at the start and the end. */
  readonly size: readonly [number, number, number, number];
  readonly clear: number;
  /** Block offset from the bone axis, in the mech frame. */
  readonly offset?: Tuple3;
  /** Car-form shift of the stowed block (meters, car axes), so it clears the internals; rigid with its joint. */
  readonly stow?: Tuple3;
  /** The joints whose mechanisms sit at the start and the end (default `joint` and none). */
  readonly ends?: readonly [string | null, string | null];
}

/** Joint positions of the skeleton with its telescopes shut: the stowed blocks span the car-form bone lengths. */
export const STOWED = carTable();
const at = (name: string): Tuple3 => {
  const j = STOWED.joints.find((x) => x.name === name);
  if (j === undefined) throw new Error(name);
  return [...j.position];
};
const plus = (p: Tuple3, d: Tuple3): Tuple3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];

export function mechSegments(): Segment[] {
  const head = MECH.height / MECH.headsPerBody;
  const segs: Segment[] = [
    { part: 'head-unit', joint: 'head', from: plus(at('head'), [0, 0.04, 0]), to: plus(at('head'), [0, 0.04 + head * 0.7, 0]), size: [0.3, 0.18, 0.26, 0.16], clear: 0, offset: [0, 0, 0.15] },
  ];
  for (const s of ['l', 'r'] as const) {
    segs.push(
      { part: `core-upper-arm-${s}`, joint: `shoulder-${s}`, ends: [`shoulder-${s}`, `elbow-${s}`], from: at(`shoulder-${s}`), to: at(`elbow-${s}`), size: [0.14, 0.14, 0.12, 0.12], clear: 0.12 },
      { part: `core-forearm-${s}`, joint: `elbow-${s}`, ends: [`elbow-${s}`, `wrist-${s}`], from: at(`elbow-${s}`), to: at(`wrist-${s}`), size: [0.1, 0.1, 0.08, 0.08], clear: 0.05 },
      { part: `hand-${s}`, joint: `wrist-${s}`, from: at(`wrist-${s}`), to: plus(at(`wrist-${s}`), [0, -0.3, 0.03]), size: [0.07, 0.1, 0.05, 0.08], clear: 0.04 },
      { part: `core-thigh-${s}`, joint: `hip-${s}`, ends: [`hip-${s}`, `knee-${s}`], from: at(`hip-${s}`), to: at(`knee-${s}`), size: [0.18, 0.18, 0.14, 0.14], clear: 0.08 },
      { part: `core-shin-${s}`, joint: `knee-${s}`, ends: [`knee-${s}`, `ankle-${s}`], from: at(`knee-${s}`), to: at(`ankle-${s}`), size: [0.14, 0.14, 0.11, 0.11], clear: 0.07 },
      { part: `core-foot-${s}`, joint: `ankle-${s}`, ends: [`ankle-${s}`, `toe-${s}`], from: at(`ankle-${s}`), to: at(`toe-${s}`), size: [0.12, 0.08, 0.12, 0.06], clear: 0.05 },
      { part: `foot-${s}`, joint: `toe-${s}`, from: at(`toe-${s}`), to: plus(at(`toe-${s}`), [0, -0.03, 0.22]), size: [0.104, 0.05, 0.094, 0.04], clear: 0.03 },
    );
  }
  return segs;
}

/** An octagon of width w and depth d around `center` in the plane spanned by `a`, `b`. */
function octagon(center: Tuple3, a: Tuple3, b: Tuple3, w: number, d: number): Tuple3[] {
  const c = 0.3;
  const shape: Point2[] = [[w / 2 - c * w / 2, d / 2], [w / 2, d / 2 - c * d / 2], [w / 2, -d / 2 + c * d / 2], [w / 2 - c * w / 2, -d / 2], [-w / 2 + c * w / 2, -d / 2], [-w / 2, -d / 2 + c * d / 2], [-w / 2, d / 2 - c * d / 2], [-w / 2 + c * w / 2, d / 2]];
  return shape.map(([u, v]) => [center[0] + u * a[0] + v * b[0], center[1] + u * a[1] + v * b[1], center[2] + u * a[2] + v * b[2]] as Tuple3);
}

const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Tuple3, k: number): Tuple3 => [a[0] * k, a[1] * k, a[2] * k];

/** Car-form shift `stow` in the mech frame of a joint placed with `rotation` (`Rz * Ry * Rx`): its transpose applied. */
function toMech(stow: Tuple3, angles: Angles): Tuple3 {
  const r = rotation(angles);
  return [0, 1, 2].map((k) => (r[0][k] as number) * stow[0] + (r[1][k] as number) * stow[1] + (r[2][k] as number) * stow[2]) as unknown as Tuple3;
}

/**
 * Where a segment's block starts and ends on the shut skeleton (mech frame, offset applied),
 * and its section axes. `stowed` is the car-form shift as a mech-frame offset.
 */
export function segmentSpan(s: Segment, stowed: Tuple3 = [0, 0, 0]): { readonly start: Tuple3; readonly end: Tuple3; readonly a: Tuple3; readonly b: Tuple3 } {
  const d = sub(s.to, s.from);
  const l = Math.hypot(...d);
  const u = scale(d, 1 / l);
  // Section axes: mech x (width) made perpendicular to the segment, depth completes the frame.
  const ref: Tuple3 = Math.abs(u[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const ar = sub(ref, scale(u, dot(ref, u)));
  const a = scale(ar, 1 / Math.hypot(...ar));
  const b: Tuple3 = [u[1] * a[2] - u[2] * a[1], u[2] * a[0] - u[0] * a[2], u[0] * a[1] - u[1] * a[0]];
  const o = plus(s.offset ?? [0, 0, 0], stowed);
  // Distance from the bone axis to the nearest block point, and the axial clearance the end mechanism needs.
  const lateral = Math.hypot(...sub(o, scale(u, dot(o, u))));
  const [startJoint, endJoint] = s.ends ?? [s.joint, null];
  const need = (joint: string | null, w: number, depth: number, along: number): number => {
    if (joint === null) return s.clear;
    const r = hardwareRadius(joint) + HARDWARE_GAP;
    const off = lateral - Math.hypot(w / 2, depth / 2);
    return Math.max(s.clear, (off >= r ? 0 : Math.sqrt(r * r - Math.max(0, off) ** 2)) - along);
  };
  const c0 = need(startJoint, s.size[0], s.size[1], startJoint === null ? 0 : dot(sub(s.from, at(startJoint)), u));
  const c1 = need(endJoint, s.size[2], s.size[3], endJoint === null ? 0 : dot(sub(at(endJoint), s.to), u));
  return { start: plus(plus(s.from, scale(u, c0)), o), end: plus(plus(s.to, scale(u, -c1)), o), a, b };
}

/** The block of a segment in the mech frame. */
function segmentBlock(m: Model, s: Segment, stowed: Tuple3): void {
  const { start, end, a, b } = segmentSpan(s, stowed);
  m.loft({ profiles: [octagon(start, a, b, s.size[0], s.size[1]), octagon(end, a, b, s.size[2], s.size[3])], label: s.part, tag: `part:${s.part}`, material: 'core' });
}
/** Clearance kept outside a joint's mechanism sphere. */
const HARDWARE_GAP = 0.012;

export function buildS3Mech(session: SessionFactory = () => model()): Model {
  const frames = carFormFrames();
  const m = session('mech');
  for (const s of mechSegments()) {
    const block = session(`block-${s.part}`);
    // Mech frame -> car-form frame of the joint: undo the mech position, turn, place.
    const pm = at(s.joint);
    const frame = frames.get(s.joint);
    if (frame === undefined) throw new Error(s.joint);
    segmentBlock(block, s, toMech(s.stow ?? [0, 0, 0], frame.rotation));
    block.translate(sel.all(), [-pm[0], -pm[1], -pm[2]]);
    block.rotate(sel.all(), 'x', frame.rotation.x ?? 0);
    block.rotate(sel.all(), 'y', frame.rotation.y ?? 0);
    block.rotate(sel.all(), 'z', frame.rotation.z ?? 0);
    block.translate(sel.all(), [...frame.position]);
    m.append(block);
  }
  m.uv.project({ mode: 'box', scale: 0.5 });
  m.uv.project({ mode: 'box', scale: 0.5, channel: 'uv1' });
  return m;
}

/** Both forms: the car rough model with the mech volumes folded inside it, on the S4 rig. */
export function buildS3(session: SessionFactory = () => model(), form: PanelForm = 'closed'): TransformRig {
  const m = session('s3');
  m.append(buildS3Car(() => model(), form).snapshot());
  m.append(buildS3Mech().snapshot());
  const units = m.inspect().tags.filter((t) => t.startsWith('part:')).map((t) => t.slice(5));
  return rigOver(m, units);
}
