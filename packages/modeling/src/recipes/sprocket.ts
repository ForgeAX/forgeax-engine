import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import { acos } from '../brep/dmath-acos';
import { atan2, cos, hypot2, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  circle,
  degrees,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

/** Seat arc segments over the 2 * seatHalfAngle span; 24 keeps seat chords within ~2 um of the arc. */
const SEAT_SEGMENTS = 24;
/** ISO 606 minimum seat radius as a multiple of the roller diameter (radial clearance 0.005 d1). */
const SEAT_MIN_SHARE = 0.505;
/** Largest chord deviation of any sampled flank or tip arc, meters. */
const CHORD_TOLERANCE = 2e-6;
/** Pin radius as a share of the roller radius. */
const PIN_SHARE = 0.4;
/** Bore clearance between a pin and a roller or inner plate, as a share of the pitch. */
const BORE_CLEARANCE = 0.02;
/** Gap between an inner plate and an outer plate, as a share of the pitch. */
const PLATE_GAP = 0.05;
/** Plate end radius as a share of the pitch (plate height 0.6 pitch). */
const PLATE_END = 0.3;

export interface SprocketOptions extends RecipeNaming {
  /** Number of teeth (seats), each engaging one roller. */
  readonly teeth: number;
  /** Chain pitch, meters. */
  readonly pitch: number;
  /** Roller diameter, meters (default 0.5 pitch). */
  readonly rollerDiameter?: number;
  /** Face width along Z, meters. */
  readonly width: number;
  /** Bore diameter, meters (default 0: solid). */
  readonly bore?: number;
}

/** Declared ranges; roller and width scale with the chain pitch. */
export const SPROCKET_RANGES = {
  teeth: [6, 40],
  pitch: [0.0005, 0.1],
  rollerPitches: [0.3, 0.6],
  widthPitches: [0.2, 2],
} as const satisfies Record<string, Range>;

export interface ChainLinkOptions extends RecipeNaming {
  /** Chain pitch (pin to pin), meters. */
  readonly pitch: number;
  /** `outer` carries the pins, `inner` carries the rollers. */
  readonly kind: 'outer' | 'inner';
  /** Roller diameter, meters (default 0.5 pitch). */
  readonly rollerDiameter?: number;
  /** Link width across its pins, meters (the sprocket face sits between the inner plates). */
  readonly width: number;
  /** Plate thickness, meters (default 0.1 pitch). */
  readonly plateThickness?: number;
}

/** Declared ranges for the chain link (pitch-relative). */
export const CHAIN_LINK_RANGES = {
  pitch: [0.0005, 0.1],
  rollerPitches: [0.3, 0.6],
  widthPitches: [0.3, 2],
  plateThicknessPitches: [0.05, 0.15],
} as const satisfies Record<string, Range>;

function scaled(unit: number, [min, max]: Range): Range {
  return [min * unit, max * unit];
}

/** Samples on an arc so that no chord strays more than CHORD_TOLERANCE from it. */
export function arcSegments(sweep: number, radius: number): number {
  const step = 2 * acos(1 - CHORD_TOLERANCE / radius);
  return Math.max(1, Math.ceil(Math.abs(sweep) / step));
}

function foldAngle(angle: number): number {
  return atan2(sin(angle), cos(angle));
}

/** Counter-clockwise turn from `from` to `to`, in [0, 2 pi). */
function ccwTurn(from: number, to: number): number {
  return (((to - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function pointAt(c: Point2, r: number, angle: number): Point2 {
  return [c[0] + r * cos(angle), c[1] + r * sin(angle)];
}

function polarAbout(c: Point2, p: Point2): number {
  return atan2(p[1] - c[1], p[0] - c[0]);
}

/** Intersections of two circles; empty when they do not meet. */
function circleCircle(c1: Point2, r1: number, c2: Point2, r2: number): Point2[] {
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = hypot2(dx, dy);
  if (d === 0 || d > r1 + r2 || d < Math.abs(r1 - r2)) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1[0] + (a * dx) / d;
  const my = c1[1] + (a * dy) / d;
  return [
    [mx - (h * dy) / d, my + (h * dx) / d],
    [mx + (h * dy) / d, my - (h * dx) / d],
  ];
}

interface Flank {
  /** Sampled arc from the seat tangent point (first) to the tip-circle crossing (last). */
  readonly points: Point2[];
  /** Angle from the seat's pitch direction to the tip-circle crossing, in (0, step). */
  readonly edgeAngle: number;
  /** The tip-circle crossing. */
  readonly end: Point2;
}

/**
 * One flank of a seat: a concave arc of radius `flankRadius` internally tangent to the seat circle
 * at direction `psi` (about the pitch point). Its centre lies on the far side of the seat centre,
 * at distance flankRadius - seatRadius, so the arc bends away from the roller and runs outward to
 * the tip circle on the tooth side `ccw` (the tooth after the seat in ccw order, or before it).
 * Returns undefined when the tangent point is already outside the tip circle or the first
 * crossing lies on the wrong side.
 */
function flank(
  seat: Point2,
  seatAngle: number,
  psi: number,
  seatRadius: number,
  flankRadius: number,
  tipRadius: number,
  step: number,
  ccw: boolean,
): Flank | undefined {
  const origin: Point2 = [0, 0];
  const tangent = pointAt(seat, seatRadius, psi);
  if (hypot2(tangent[0], tangent[1]) >= tipRadius) return undefined;
  const centre = pointAt(seat, flankRadius - seatRadius, psi + Math.PI);
  const gammaT = psi;
  const hits = circleCircle(centre, flankRadius, origin, tipRadius);
  let best: { sweep: number; tau: 1 | -1; end: Point2; edge: number } | undefined;
  for (const tau of [1, -1] as const) {
    let first: { sweep: number; end: Point2 } | undefined;
    for (const end of hits) {
      const gammaE = polarAbout(centre, end);
      const sweep = tau === 1 ? ccwTurn(gammaT, gammaE) : ccwTurn(gammaE, gammaT);
      if (first === undefined || sweep < first.sweep) first = { sweep, end };
    }
    if (first === undefined) continue;
    const rel = foldAngle(polarAbout(origin, first.end) - seatAngle);
    const onSide = ccw ? rel > 0 && rel < step : rel < 0 && rel > -step;
    if (!onSide) continue;
    if (best === undefined || first.sweep < best.sweep) {
      best = { sweep: first.sweep, tau, end: first.end, edge: Math.abs(rel) };
    }
  }
  if (best === undefined) return undefined;
  const n = arcSegments(best.sweep, flankRadius);
  const points: Point2[] = [];
  for (let i = 0; i <= n; i++) {
    points.push(pointAt(centre, flankRadius, gammaT + (best.tau * best.sweep * i) / n));
  }
  points[0] = tangent;
  points[n] = best.end;
  return { points, edgeAngle: best.edge, end: best.end };
}

/**
 * Sprocket about +Z with ISO 606 proportions. One seat per tooth on the pitch circle
 * (pitch diameter d = p / sin(pi / z)): the roller seat is a circle of radius 0.505 d1 (the
 * minimum of the ISO range), centred on the roller's pitch point and open over 2 * seatHalfAngle
 * (ISO seating angle 120 - 90 / z, taken as the full seat arc). Each seat side continues into a
 * flank arc of radius re (geometric mean of the ISO range 0.12 d1 (z + 2) .. 0.008 d1 (z^2 + 180))
 * externally tangent to the seat, running out to the tip circle; the tip diameter is the
 * midpoint of the ISO range d + (1 - 1.6 / z) p - d1 .. d + 1.25 p - d1. The tooth tip is the
 * tip-circle arc between neighbouring flanks, so the flanks hold a roller in its seat. Every
 * arc is sampled to CHORD_TOLERANCE; the seat uses SEAT_SEGMENTS. Returns the `hub` anchor at the
 * origin with `pitchDiameter`, `tipDiameter`, `rootDiameter`, `seatRadius`, `flankRadius` and
 * `seatHalfAngle` (degrees) as dimensions. Parts: `<name>`.
 */
export function sprocket(options: SprocketOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'sprocket';
  const { teeth, pitch: p, width } = options;
  const roller = options.rollerDiameter ?? 0.5 * p;
  const bore = options.bore ?? 0;
  const checked = checkAll([
    () => inRange('teeth', teeth, SPROCKET_RANGES.teeth, true),
    () => inRange('pitch', p, SPROCKET_RANGES.pitch),
    () => inRange('rollerDiameter', roller, scaled(p, SPROCKET_RANGES.rollerPitches)),
    () => inRange('width', width, scaled(p, SPROCKET_RANGES.widthPitches)),
  ]);
  if (!checked.ok) return checked;
  const pitchRadius = p / (2 * sin(Math.PI / teeth));
  const seatRadius = SEAT_MIN_SHARE * roller;
  const tipRadius = pitchRadius + ((1 - 1.6 / teeth + 1.25) / 4) * p - roller / 2;
  const flankRadius = Math.sqrt(
    0.12 * roller * (teeth + 2) * (0.008 * roller * (teeth * teeth + 180)),
  );
  const seatHalf = (60 - 45 / teeth) * (Math.PI / 180);
  const rootRadius = pitchRadius - seatRadius;
  const bored = inRange('bore', bore, [0, 2 * rootRadius]);
  if (!bored.ok) return bored;
  const step = (2 * Math.PI) / teeth;
  const unfit = (land: string) =>
    err(
      modelingError(
        'model-invalid-argument',
        `tooth flanks reach the tip circle with ${land} and leave no tip between them`,
        { teeth, rollerDiameter: roller, pitch: p },
        'use fewer teeth or a smaller rollerDiameter; the flank follows the roller and tooth count',
      ),
    );
  const seats: { centre: Point2; theta: number; a: Flank; b: Flank }[] = [];
  for (let k = 0; k < teeth; k++) {
    const theta = k * step;
    const centre: Point2 = [pitchRadius * cos(theta), pitchRadius * sin(theta)];
    const inward = theta + Math.PI;
    const a = flank(
      centre,
      theta,
      inward - seatHalf,
      seatRadius,
      flankRadius,
      tipRadius,
      step,
      true,
    );
    const b = flank(
      centre,
      theta,
      inward + seatHalf,
      seatRadius,
      flankRadius,
      tipRadius,
      step,
      false,
    );
    if (a === undefined || b === undefined) return unfit('the flank out of the tip circle');
    seats.push({ centre, theta, a, b });
  }
  const land = step - (seats[0]?.a.edgeAngle ?? 0) - (seats[0]?.b.edgeAngle ?? 0);
  if (!(land > 0)) return unfit(`a land of ${(land * 180) / Math.PI} deg`);
  const outline: Point2[] = [];
  const extend = (piece: readonly Point2[]): void => {
    for (const q of piece) {
      const last = outline[outline.length - 1];
      if (last === undefined || hypot2(q[0] - last[0], q[1] - last[1]) > 1e-12) outline.push(q);
    }
  };
  const origin: Point2 = [0, 0];
  for (let k = teeth - 1; k >= 0; k--) {
    const seat = seats[k] as (typeof seats)[number];
    const prev = seats[(k - 1 + teeth) % teeth] as (typeof seats)[number];
    extend([...seat.a.points].reverse());
    const psiA = seat.theta + Math.PI - seatHalf;
    const arc: Point2[] = [];
    for (let i = 0; i <= SEAT_SEGMENTS; i++) {
      arc.push(pointAt(seat.centre, seatRadius, psiA + (2 * seatHalf * i) / SEAT_SEGMENTS));
    }
    extend(arc);
    extend(seat.b.points);
    const from = seat.b.end;
    const to = prev.a.end;
    const start = polarAbout(origin, from);
    const n = arcSegments(land, tipRadius);
    const tip: Point2[] = [];
    for (let i = 0; i <= n; i++) tip.push(pointAt(origin, tipRadius, start - (land * i) / n));
    tip[0] = from;
    tip[n] = to;
    extend(tip);
  }
  const m = model();
  const holes: Point2[][] = bore > 0 ? [circle(bore / 2, 32)] : [];
  m.extrudePolygon({ points: outline, holes, depth: width, label: name });
  m.translate(sel.all(), [0, 0, -width / 2]);
  return finishPart(
    m,
    name,
    { hub: [0, 0, 0] },
    {
      teeth,
      pitch: p,
      pitchDiameter: 2 * pitchRadius,
      tipDiameter: 2 * tipRadius,
      rootDiameter: 2 * rootRadius,
      seatRadius,
      flankRadius,
      seatHalfAngle: degrees(seatHalf),
      rollerDiameter: roller,
      width,
      bore,
    },
  );
}

/** Stadium plate outline along X: caps of radius `radius` centred on the pins at +-pitch / 2. */
function plateOutline(pitch: number, radius: number): Point2[] {
  const h = pitch / 2;
  const n = 16;
  const points: Point2[] = [];
  for (let k = 0; k <= n; k++) {
    const a = -Math.PI / 2 + (Math.PI * k) / n;
    points.push([h + radius * cos(a), radius * sin(a)]);
  }
  for (let k = 0; k <= n; k++) {
    const a = Math.PI / 2 + (Math.PI * k) / n;
    points.push([-h + radius * cos(a), radius * sin(a)]);
  }
  return points;
}

/**
 * One chain link along +X with pins at +-pitch / 2. An `outer` link has two outer plates and
 * two pins (press fit in the plate holes, spanning the full width); an `inner` link has two
 * inner plates (holes clear of its pins) and two rollers between them, each roller seating on
 * its pin with bore clearance. Parts: `<name>-plate-a`, `<name>-plate-b` and, per kind,
 * `<name>-pin-a`, `<name>-pin-b` or `<name>-roller-a`, `<name>-roller-b`. Contacts list the
 * designed seats between each plate and its pins or rollers.
 */
export function chainLink(options: ChainLinkOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? `${options.kind}-link`;
  const p = options.pitch;
  const width = options.width;
  const roller = options.rollerDiameter ?? 0.5 * p;
  const t = options.plateThickness ?? 0.1 * p;
  if (options.kind !== 'outer' && options.kind !== 'inner') {
    return err(
      modelingError(
        'model-invalid-argument',
        "a chain link is 'outer' or 'inner'",
        { kind: options.kind },
        'choose the link kind',
      ),
    );
  }
  const checked = checkAll([
    () => inRange('pitch', p, CHAIN_LINK_RANGES.pitch),
    () => inRange('rollerDiameter', roller, scaled(p, CHAIN_LINK_RANGES.rollerPitches)),
    () => inRange('width', width, scaled(p, CHAIN_LINK_RANGES.widthPitches)),
    () => inRange('plateThickness', t, scaled(p, CHAIN_LINK_RANGES.plateThicknessPitches)),
  ]);
  if (!checked.ok) return checked;
  const gap = PLATE_GAP * p;
  const length = width - 4 * t - 2 * gap;
  if (!(length > 0)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the link width holds two plates on each side of the rollers',
        { width, plateThickness: t, width_min: 4 * t + 2 * gap },
        'widen the link or thin its plates',
      ),
    );
  }
  const rollerR = roller / 2;
  const pinR = PIN_SHARE * rollerR;
  const clearance = BORE_CLEARANCE * p;
  const h = p / 2;
  const m = model();
  const piece = (label: string, at: Tuple3, build: (s: Model) => void) => {
    const s = model();
    build(s);
    s.translate(sel.all(), at);
    m.append(s.snapshot(), { tag: label });
  };
  const plate = (label: string, z: number, holeRadius: number) =>
    piece(label, [0, 0, z], (s) =>
      s.extrudePolygon({
        points: plateOutline(p, PLATE_END * p),
        holes: [circle(holeRadius, 32, [-h, 0]), circle(holeRadius, 32, [h, 0])],
        depth: t,
        label,
      }),
    );
  const contacts: { parts: [string, string]; kind: 'fit' | 'seat' }[] = [];
  if (options.kind === 'outer') {
    plate(`${name}-plate-a`, width / 2 - t, pinR);
    plate(`${name}-plate-b`, -width / 2, pinR);
    for (const [label, x] of [
      [`${name}-pin-a`, -h],
      [`${name}-pin-b`, h],
    ] as const) {
      piece(label, [x, 0, -width / 2], (s) =>
        s.extrudePolygon({ points: circle(pinR, 32), holes: [], depth: width, label }),
      );
      for (const plateName of [`${name}-plate-a`, `${name}-plate-b`]) {
        contacts.push({ parts: [plateName, label], kind: 'fit' });
      }
    }
  } else {
    plate(`${name}-plate-a`, length / 2, pinR + clearance);
    plate(`${name}-plate-b`, -length / 2 - t, pinR + clearance);
    for (const [label, x] of [
      [`${name}-roller-a`, -h],
      [`${name}-roller-b`, h],
    ] as const) {
      piece(label, [x, 0, -length / 2], (s) =>
        s.extrudePolygon({
          points: circle(rollerR, 32),
          holes: [circle(pinR + clearance, 32)],
          depth: length,
          label,
        }),
      );
      for (const plateName of [`${name}-plate-a`, `${name}-plate-b`]) {
        contacts.push({ parts: [plateName, label], kind: 'seat' });
      }
    }
  }
  const finished = finishPart(
    m,
    name,
    { pinA: [-h, 0, 0], pinB: [h, 0, 0] },
    {
      pitch: p,
      width,
      plateThickness: t,
      rollerDiameter: roller,
      pinRadius: pinR,
      rollerLength: options.kind === 'inner' ? length : 0,
    },
  );
  if (!finished.ok) return finished;
  return ok({ ...finished.value, contacts });
}

export interface ChainPlacement {
  /** Position in the loop, 0 to links - 1. */
  readonly index: number;
  /** Link centre in the sprocket frame (z = 0). */
  readonly center: Tuple3;
  /** Rotation of the link's +X axis about +Z, degrees. */
  readonly angle: number;
  /** World pin centres of this link (z = 0). */
  readonly pinA: Tuple3;
  readonly pinB: Tuple3;
}

/**
 * Placements of a closed chain of `links` links at `pitch` wrapped on a sprocket with the same
 * tooth count: pins sit on the regular polygon of circumradius pitch / (2 sin(pi / links)),
 * which is the sprocket's pitch radius. Returns placements only; the caller applies them with
 * `append` (translate and rotate) or a rig binding.
 */
export function chainPlacements(options: {
  readonly links: number;
  readonly pitch: number;
}): Result<ChainPlacement[], ModelingError> {
  const { links: n, pitch: p } = options;
  const checked = checkAll([
    () => inRange('links', n, SPROCKET_RANGES.teeth, true),
    () => inRange('pitch', p, SPROCKET_RANGES.pitch),
  ]);
  if (!checked.ok) return checked;
  const radius = p / (2 * sin(Math.PI / n));
  const vertex = (k: number): Tuple3 => {
    const a = (2 * Math.PI * k) / n;
    return [radius * cos(a), radius * sin(a), 0];
  };
  const placements: ChainPlacement[] = [];
  for (let k = 0; k < n; k++) {
    const pinA = vertex(k);
    const pinB = vertex((k + 1) % n);
    placements.push({
      index: k,
      center: [(pinA[0] + pinB[0]) / 2, (pinA[1] + pinB[1]) / 2, 0],
      angle: degrees(atan2(pinB[1] - pinA[1], pinB[0] - pinA[0])),
      pinA,
      pinB,
    });
  }
  return ok(placements);
}

/**
 * Largest mismatch, in model units, between each link's far pin and the next link's near pin,
 * including the wrap from the last link to the first. Zero for a closed pitch polygon.
 */
export function chainClosure(placements: readonly ChainPlacement[]): number {
  let worst = 0;
  for (let k = 0; k < placements.length; k++) {
    const link = placements[k] as ChainPlacement;
    const next = placements[(k + 1) % placements.length] as ChainPlacement;
    const dx = link.pinB[0] - next.pinA[0];
    const dy = link.pinB[1] - next.pinA[1];
    worst = Math.max(worst, Math.sqrt(dx * dx + dy * dy));
  }
  return worst;
}

export interface ChainDriveOptions {
  /** Teeth on the first sprocket, at the origin. */
  readonly teethA: number;
  /** Teeth on the second sprocket, on the +X axis at the centre distance. */
  readonly teethB: number;
  /** Total link count; must have the parity of teethA so the loop closes with whole runs. */
  readonly links: number;
  readonly pitch: number;
  /** Upper pin index on A and on B (default 2 and 5, the rig-verified pair for 12 and 18 teeth). */
  readonly pinA?: number;
  readonly pinB?: number;
}

export interface ChainDriveResult {
  /** Centre distance C from sprocket A to sprocket B, model units, on +X. */
  readonly centreDistance: number;
  /** Pitch radii of sprockets A and B. */
  readonly pitchRadiusA: number;
  readonly pitchRadiusB: number;
  /** Chords of whole pitches on each of the two straight runs. */
  readonly runPitches: number;
  /** Pins in loop order; link i joins pin i to pin i+1 (cyclic). */
  readonly placements: ChainPlacement[];
}

/**
 * Two-sprocket chain drive in closed form. Sprocket A sits at the origin and sprocket B at (C, 0).
 * Pins sit on each pitch circle; a is the upper pin index on A and b on B (pin angle a * 2 pi / z).
 * Each straight run is a chord of k whole pitches between the upper pins (and the mirrored lower
 * pins), so its interior pins fall exactly one pitch apart. The link count is then
 * links = zA - 2a + 2b + 2k, which fixes k, and C is the closed form for |B - A| = k p.
 * The pins a and b are caller-chosen; the rig measured (2, 5) for 12 and 18 teeth with 40 links:
 * zero confirmed interferences and every seated roller clear of its seat. The pair round(z / 4)
 * gave 2 confirmed roller penetrations at the run ends. The runs are chords between
 * pitch points, not common tangents, so they are not tangent to the pitch circles. The standard
 * ISO centre-distance formula is approximate and is reported by the caller only for comparison.
 */
export function chainDrive(options: ChainDriveOptions): Result<ChainDriveResult, ModelingError> {
  const { teethA: zA, teethB: zB, links: n, pitch: p } = options;
  const checked = checkAll([
    () => inRange('teethA', zA, SPROCKET_RANGES.teeth, true),
    () => inRange('teethB', zB, SPROCKET_RANGES.teeth, true),
    () => inRange('pitch', p, SPROCKET_RANGES.pitch),
  ]);
  if (!checked.ok) return checked;
  const a = options.pinA ?? 2;
  const b = options.pinB ?? 5;
  if (a < 0 || a >= zA || b < 0 || b >= zB || !Number.isInteger(a) || !Number.isInteger(b)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'pin indices within the tooth counts',
        { pinA: a, pinB: b },
        'choose integer pinA in [0, teethA) and pinB in [0, teethB)',
      ),
    );
  }
  const twiceK = n - zA + 2 * a - 2 * b;
  const refuse = (expected: string, hint: string) =>
    err(
      modelingError('model-invalid-argument', expected, { links: n, teethA: zA, teethB: zB }, hint),
    );
  if (twiceK % 2 !== 0 || twiceK / 2 < 1) {
    return refuse(
      'a link count with the parity of teethA and at least zA - 2a + 2b + 2',
      'choose links = teethA + 2 k - 2a + 2b for a whole run count k >= 1',
    );
  }
  const k = twiceK / 2;
  const RA = p / (2 * sin(Math.PI / zA));
  const RB = p / (2 * sin(Math.PI / zB));
  const thetaA = (2 * Math.PI * a) / zA;
  const thetaB = (2 * Math.PI * b) / zB;
  const dy = RB * sin(thetaB) - RA * sin(thetaA);
  const kp = k * p;
  const rootSq = kp * kp - dy * dy;
  if (!(rootSq > 0)) {
    return refuse(
      'a run chord of k pitches that spans the two pitch circles',
      'choose other teeth or links',
    );
  }
  const C = Math.sqrt(rootSq) - (RB * cos(thetaB) - RA * cos(thetaA));
  if (!(C > RA + RB)) {
    return refuse(
      'sprockets whose pitch circles do not overlap the run',
      'choose other teeth or links',
    );
  }
  const onA = (angle: number): Point2 => [RA * cos(angle), RA * sin(angle)];
  const onB = (angle: number): Point2 => [C + RB * cos(angle), RB * sin(angle)];
  const run = (from: Point2, to: Point2): Point2[] => {
    const span = hypot2(to[0] - from[0], to[1] - from[1]);
    const ux = (to[0] - from[0]) / span;
    const uy = (to[1] - from[1]) / span;
    const out: Point2[] = [];
    for (let i = 1; i < k; i++) out.push([from[0] + i * p * ux, from[1] + i * p * uy]);
    return out;
  };
  const sA = (2 * Math.PI) / zA;
  const sB = (2 * Math.PI) / zB;
  const upperA = onA(thetaA);
  const lowerA = onA(-thetaA);
  const upperB = onB(thetaB);
  const lowerB = onB(-thetaB);
  // Loop order: A upper -> upper run -> B upper -> B wrap (through 0) -> B lower -> lower run
  // -> A lower -> A wrap (through pi) -> A upper.
  const pins: Point2[] = [upperA, ...run(upperA, upperB), upperB];
  for (let j = 1; j < 2 * b; j++) pins.push(onB(thetaB - j * sB));
  pins.push(lowerB);
  pushAll(pins, run(lowerB, lowerA));
  pins.push(lowerA);
  for (let j = 1; j < zA - 2 * a; j++) pins.push(onA(-thetaA - j * sA));
  if (pins.length !== n) {
    return refuse(
      'a closed loop whose pin count equals links',
      'the pin walk disagrees with the link count',
    );
  }
  const placements: ChainPlacement[] = pins.map((pinA, i) => {
    const pinB = pins[(i + 1) % pins.length] as Point2;
    const v = [pinB[0] - pinA[0], pinB[1] - pinA[1]] as const;
    return {
      index: i,
      center: [(pinA[0] + pinB[0]) / 2, (pinA[1] + pinB[1]) / 2, 0],
      angle: degrees(atan2(v[1], v[0])),
      pinA: [pinA[0], pinA[1], 0],
      pinB: [pinB[0], pinB[1], 0],
    };
  });
  return ok({
    centreDistance: C,
    pitchRadiusA: RA,
    pitchRadiusB: RB,
    runPitches: k,
    placements,
  });
}
