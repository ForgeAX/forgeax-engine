import { err, ok, type Result } from '@forgeax/engine-types';
import { acos } from '../brep/dmath-acos';
import { atan2, cos, hypot2, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import { checkAll, circle, degrees, inRange, type Range, type RecipeNaming } from './common';

/** Nose clearance from the root corner along the stop face (m): 0.02 mm. */
const NOSE_CLEARANCE = 2e-5;
/** Flank clearance past the previous tooth's tip, in tip radii. */
const FLANK_CLEARANCE_TIPS = 0.01;
/** Smallest share of the tooth stop face the lever bears on. */
const BEARING_SHARE = 0.4;
/** Lever beak beyond the tooth tip, in tooth depths. */
const BEAK_DEPTHS = 0.3;
/** Pivot boss radius, in tip radii. */
const BOSS_TIPS = 0.14;
/** Bar foot width as a share of the boss radius: the foot ends inside the boss. */
const FOOT_SHARE = 0.8;
/** Lever rotation bracket about the pivot (radians): every lifted pose lies outside it. */
const BRACKET = (25 * Math.PI) / 180;
/** Resting-angle search step (radians): 0.05 degrees. */
const SEARCH_STEP = (0.05 * Math.PI) / 180;
/** Bisection iterations after the first overlapping step. */
const BISECT = 60;
/** Wheel angle grid across one pitch (radians): 0.25 degrees. */
const GRID_STEP = (0.25 * Math.PI) / 180;
/** Release circle beyond the tip radius, as a share of the tip radius. */
const RELEASE_MARGIN = 0.02;
/** Pivot-to-nose length of the lever, in tip radii; with the boss radius it keeps the boss outside the wheel. */
export const LEVER_TIPS = 1.2;
/** Seat contact tolerance (m): the seat is flush, so a seated lever penetrates by ~0. */
export const SEAT_TOLERANCE = 1e-6;
/** Largest resting angle at wheel angle 0 (radians) that still counts as the built seat. */
const SEAT_ANGLE_TOLERANCE = 1e-9;

/** Declared ranges; tooth depth and width scale with the tip radius. */
export const LOCKING_RANGES = {
  teeth: [8, 16],
  toothDepthTips: [0.05, 0.25],
  widthTips: [0.2, 1],
  toothLandPitches: [0, 0.15],
  boreRootDiameters: [0, 1],
} as const satisfies Record<string, Range>;

/** A locking ratchet wheel: its teeth and the stop face their lever bears on. */
export interface LockingOptions extends RecipeNaming {
  /** Number of teeth around the wheel. */
  readonly teeth: number;
  /** Tooth tip radius, meters. */
  readonly tipRadius: number;
  /** Radial depth of a tooth from tip to root, meters. */
  readonly toothDepth: number;
  /** Wheel thickness along Z, meters (the lever matches it). */
  readonly width: number;
  /** Flat land at each tip as a fraction of the pitch (default 0.05). */
  readonly toothLand?: number;
  /** Bore diameter, meters (default 0: a solid wheel). */
  readonly bore?: number;
  /** Free drive direction; the lever blocks the opposite turn (default 'ccw'). */
  readonly direction?: 'ccw' | 'cw';
}

export function scaled(unit: number, [min, max]: Range): Range {
  return [min * unit, max * unit];
}

/** Wheel outline; tooth 0's stop face lies on ray 0 and the free turn is ccw (before mirroring). */
export interface Outline {
  readonly name: string;
  readonly teeth: number;
  readonly tip: number;
  readonly depth: number;
  readonly root: number;
  readonly width: number;
  readonly bore: number;
  readonly pitch: number;
  readonly landAngle: number;
  readonly sign: 1 | -1;
  /** Length of the tooth stop face the lever bears on (m). */
  readonly bearing: number;
  /** Nose corner at the seat: the inner end of the bearing face. */
  readonly noseRadius: number;
  /** Wheel outline, closed by the tooth ramps. */
  readonly profile: Point2[];
}

/** Lever geometry hanging from tooth 0's stop face, its pivot on the stop-face normal. */
export interface Lever {
  /** Pivot to nose distance (m). */
  readonly length: number;
  /** Nose at the seat. */
  readonly nose: Point2;
  /** Lever pivot. */
  readonly pivot: Point2;
  /** Lever bar outline at the seat: foot at the pivot, bearing face and beak on ray 0. */
  readonly bar: Point2[];
  /** Pivot boss outline. */
  readonly boss: Point2[];
}

export type Locking = Outline & Lever;

/** Mirrors an outline for the cw hand; the mirrored winding is reversed to keep it counter-clockwise. */
function mirrored(points: readonly Point2[], sign: 1 | -1): Point2[] {
  return sign === 1 ? [...points] : points.map(([x, y]): Point2 => [x, -y]).reverse();
}

export function wheelOutline(
  options: LockingOptions,
  defaultName: string,
): Result<Outline, ModelingError> {
  const name = options.name ?? defaultName;
  const { teeth, tipRadius: tip, toothDepth: depth, width } = options;
  const bore = options.bore ?? 0;
  const direction = options.direction ?? 'ccw';
  const land = options.toothLand ?? 0.05;
  const checked = checkAll([
    () => inRange('teeth', teeth, LOCKING_RANGES.teeth, true),
    () => inRange('tipRadius', tip, [0.002, 0.5]),
    () => inRange('toothDepth', depth, scaled(tip, LOCKING_RANGES.toothDepthTips)),
    () => inRange('width', width, scaled(tip, LOCKING_RANGES.widthTips)),
    () => inRange('toothLand', land, LOCKING_RANGES.toothLandPitches),
    () => inRange('bore', bore, scaled(tip - depth, LOCKING_RANGES.boreRootDiameters)),
  ]);
  if (!checked.ok) return checked;
  if (direction !== 'ccw' && direction !== 'cw') {
    return err(
      modelingError(
        'model-invalid-argument',
        "direction is 'ccw' or 'cw'",
        { direction },
        'choose the free drive direction',
      ),
    );
  }
  const sign: 1 | -1 = direction === 'ccw' ? 1 : -1;
  const root = tip - depth;
  const pitch = (2 * Math.PI) / teeth;
  const landAngle = land * pitch;

  // Tooth k: radial stop face at k * pitch (root to tip), tip land to k * pitch + land, then a
  // ramp down to the root at (k + 1) * pitch.
  const points: Point2[] = [];
  for (let k = 0; k < teeth; k++) {
    const a = k * pitch;
    points.push(
      [root * cos(a), root * sin(a)],
      [tip * cos(a), tip * sin(a)],
      [tip * cos(a + landAngle), tip * sin(a + landAngle)],
    );
  }

  // The lever hangs from tooth 0's stop face (ray 0) into the notch below it. Its pivot lies on
  // the stop-face normal through the nose, so every point of the bearing face leaves the tooth
  // when the lever lifts and the locking force passes through the pivot. The wheel-side flank is
  // that same normal: it clears the previous tooth when the nose sits outside both the root corner
  // and that tooth's tip, whose largest reach along the stop face is tip * cos(pitch - land).
  const reach = tip * cos(pitch - landAngle);
  const noseRadius = Math.max(root + NOSE_CLEARANCE, reach + FLANK_CLEARANCE_TIPS * tip);
  const bearing = tip - noseRadius;
  if (bearing < BEARING_SHARE * depth) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the previous tooth leaves the pawl too little of the stop face to bear on',
        { teeth, toothDepth: depth, bearing, required: BEARING_SHARE * depth },
        'use fewer teeth or a shallower tooth',
      ),
    );
  }
  return ok({
    name,
    teeth,
    tip,
    depth,
    root,
    width,
    bore,
    pitch,
    landAngle,
    sign,
    bearing,
    noseRadius,
    profile: mirrored(points, sign),
  });
}

/** Lever geometry for a pivot `leverTips` tip radii from the nose, in the wheel's own frame. */
export function leverOf(o: Outline, leverTips: number): Lever {
  const length = leverTips * o.tip;
  const bossRadius = BOSS_TIPS * o.tip;
  const nr = o.noseRadius;
  const bar: Point2[] = [
    [nr, -length],
    [nr + FOOT_SHARE * bossRadius, -length],
    [o.tip + BEAK_DEPTHS * o.depth, 0],
    [nr, 0],
  ];
  return {
    length,
    nose: [nr, 0],
    pivot: [nr, o.sign * -length],
    bar: mirrored(bar, o.sign),
    boss: mirrored(circle(bossRadius, 32, [nr, -length]), o.sign),
  };
}

export function locking(
  options: LockingOptions,
  leverTips: number,
  defaultName: string,
): Result<Locking, ModelingError> {
  const o = wheelOutline(options, defaultName);
  if (!o.ok) return o;
  return ok({ ...o.value, ...leverOf(o.value, leverTips) });
}

/** Lever outline at joint angle `beta` (radians) about the pivot. */
function barAt(l: Locking, beta: number): Point2[] {
  const [px, py] = l.pivot;
  return l.bar.map(([x, y]) => {
    const dx = x - px;
    const dy = y - py;
    return [px + dx * cos(beta) - dy * sin(beta), py + dx * sin(beta) + dy * cos(beta)];
  });
}

function rotate([x, y]: Point2, angle: number): Point2 {
  return [x * cos(angle) - y * sin(angle), x * sin(angle) + y * cos(angle)];
}

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Proper crossing only: touching or collinear segments do not count. */
function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Even-odd point-in-polygon; a point on an edge is not inside. */
function inside(p: Point2, poly: readonly Point2[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Point2;
    const b = poly[j] as Point2;
    if (
      cross(a, b, p) === 0 &&
      Math.min(a[0], b[0]) <= p[0] &&
      p[0] <= Math.max(a[0], b[0]) &&
      Math.min(a[1], b[1]) <= p[1] &&
      p[1] <= Math.max(a[1], b[1])
    ) {
      return false;
    }
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      hit = !hit;
    }
  }
  return hit;
}

/** True when the two closed polygons share interior area; flush contact is free. */
function overlaps(a: readonly Point2[], b: readonly Point2[]): boolean {
  if (a.some((p) => inside(p, b)) || b.some((p) => inside(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (
        segmentsCross(
          a[i] as Point2,
          a[(i + 1) % a.length] as Point2,
          b[j] as Point2,
          b[(j + 1) % b.length] as Point2,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether the lever at joint angle `beta` overlaps the turned wheel outline. The boss is left
 * out: it turns about its own centre and lies outside the tip circle (lever - boss > 1 tip).
 */
function hits(l: Locking, wheel: readonly Point2[], beta: number): boolean {
  return overlaps(barAt(l, beta), wheel);
}

/**
 * Lever joint angle (radians) at which the lever rests on the wheel turned by `wheelAngle`
 * (radians). The search starts from the clear side of the bracket, steps toward the wheel in
 * `SEARCH_STEP` increments until the first overlap, then bisects between the last free and first
 * overlapping angles. The last free angle is the resting contact.
 */
export function restingAngle(l: Locking, wheelAngle: number): number | undefined {
  const wheel = l.profile.map((p) => rotate(p, wheelAngle));
  const clear = (beta: number): boolean => !hits(l, wheel, beta);
  const lowClear = clear(-BRACKET);
  const highClear = clear(BRACKET);
  if (lowClear === highClear) return undefined;
  const from = lowClear ? -BRACKET : BRACKET;
  const to = lowClear ? BRACKET : -BRACKET;
  const steps = Math.ceil(Math.abs(to - from) / SEARCH_STEP);
  let prev = from;
  for (let i = 1; i <= steps; i++) {
    const beta = from + ((to - from) * i) / steps;
    if (!clear(beta)) {
      let free = prev;
      let blocked = beta;
      for (let k = 0; k < BISECT; k++) {
        const mid = (free + blocked) / 2;
        if (clear(mid)) free = mid;
        else blocked = mid;
      }
      return free;
    }
    prev = beta;
  }
  return undefined;
}

/**
 * Proves that the built seat is the resting pose at wheel angle 0 and that every wheel angle
 * across one pitch admits a resting contact. `options` supplies the detail of a refusal.
 */
export function checkSeat(l: Locking, options: LockingOptions): Result<void, ModelingError> {
  const seat = restingAngle(l, 0);
  if (seat === undefined || Math.abs(seat) > SEAT_ANGLE_TOLERANCE) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the pawl does not rest flush on the stop face at wheel angle 0',
        { teeth: options.teeth, toothDepth: options.toothDepth, restingAngle: seat },
        'use fewer teeth, a shallower tooth or a smaller land',
      ),
    );
  }
  for (let k = 1; k * GRID_STEP < l.pitch; k++) {
    if (restingAngle(l, k * GRID_STEP) === undefined) {
      return err(
        modelingError(
          'model-invalid-argument',
          'the pawl finds no resting contact on the wheel across one pitch',
          {
            teeth: options.teeth,
            toothDepth: options.toothDepth,
            wheelAngle: degrees(k * GRID_STEP),
          },
          'use fewer teeth, a shallower tooth or a smaller land',
        ),
      );
    }
  }
  return ok(undefined);
}

function wrapAngle(a: number): number {
  return atan2(sin(a), cos(a));
}

/**
 * Closed-form lever angle (radians, ccw about the pivot, zero at the seat) that carries the nose
 * out to the release radius `tip * (1 + RELEASE_MARGIN)`. The nose moves on a circle of radius
 * `length` about the pivot; the release circle about the wheel centre meets it where the law of
 * cosines puts the angle `gamma` from the pivot-to-centre direction, on the side the nose already
 * sits. `undefined` when the two circles do not meet.
 */
export function releaseAngle(l: Locking): number | undefined {
  const radius = l.tip * (1 + RELEASE_MARGIN);
  const [px, py] = l.pivot;
  const d = hypot2(px, py);
  const cosGamma = (l.length * l.length + d * d - radius * radius) / (2 * l.length * d);
  if (!(cosGamma >= -1 && cosGamma <= 1)) return undefined;
  const gamma = acos(cosGamma);
  const toCentre = atan2(-py, -px);
  const start = atan2(l.nose[1] - py, l.nose[0] - px);
  const side = wrapAngle(start - toCentre) >= 0 ? 1 : -1;
  return wrapAngle(toCentre + side * gamma - start);
}

/** The wheel model: the outline extruded across the face width, with the given holes. */
export function wheelModel(g: Outline, label: string, holes: Point2[][]): Model {
  const m = model();
  m.extrudePolygon({ points: g.profile, holes, depth: g.width, label });
  m.translate(sel.all(), [0, 0, -g.width / 2]);
  return m;
}

/** The lever model: bar and boss extruded across the face width and unioned. */
export function leverModel(l: Locking, label: string): Model {
  const m = model();
  m.extrudePolygon({ points: l.bar, holes: [], depth: l.width, label });
  const boss = model();
  boss.extrudePolygon({ points: l.boss, holes: [], depth: l.width, label });
  m.union(boss);
  m.translate(sel.all(), [0, 0, -l.width / 2]);
  return m;
}
