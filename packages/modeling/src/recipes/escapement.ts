import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { Point2 } from '../primitives';
import {
  checkAll,
  circle,
  degrees,
  finishPart,
  inRange,
  type Range,
  type RecipePart,
} from './common';
import {
  checkSeat,
  type LockingOptions,
  leverModel,
  locking,
  releaseAngle,
  restingAngle,
  scaled,
  wheelModel,
  wheelOutline,
} from './locking';

/** Standard gravity (m/s^2), the value used by the moment balance of `steelyardStop`. */
export const STANDARD_GRAVITY = 9.80665;
/** Default lever length, in tip radii: the middle of the declared 2.5 to 3.5 range. */
const DEFAULT_LEVER_TIPS = 3;
/** Rim wall between the spoke openings and the tooth roots, as a share of the tooth depth. */
const RIM_WALL_SHARE = 0.5;
/** Samples per spoke-opening arc. */
const ARC_SAMPLES = 8;

/** Declared ranges, relative to the tip radius. */
export const ESCAPEMENT_RANGES = {
  hubTips: [0.1, 0.8],
  spokeWidthTips: [0.02, 0.4],
  leverTips: [2.5, 3.5],
} as const satisfies Record<string, Range>;

export interface EscapementWheelOptions extends LockingOptions {
  /** Hub radius where the spoke openings start, meters. */
  readonly hubRadius: number;
  /** Spoke width at mid radius, meters (the solid between two openings). */
  readonly spokeWidth: number;
}

/** Drive hand: the wheel is driven ccw into the stop, which releases only for a cw turn. */
const DRIVE_DIRECTION = 'cw';

export interface SteelyardStopOptions extends LockingOptions {
  /** Pivot to nose length, in tip radii (default 3). */
  readonly leverTips?: number;
  /** Driving torque the wheel applies at the nose, N*m. */
  readonly torque: number;
}

/**
 * Single-lever detent: the steelyard stop lifts, passes one tooth, and drops, so it locks and releases
 * one tooth per lift. There are no pallets, and it does not time itself (the beat is the wheel pitch
 * and the lever geometry).
 *
 * Escapement wheel about +Z: the locking-tooth outline shared with `ratchet`, plus spoke openings
 * between the hub and the rim wall under the tooth roots. The stop is a separate recipe
 * (`steelyardStop`) built in the same frame. Dimensions: teeth, pitch, rootRadius, tipRadius,
 * toothDepth, toothLand, hubRadius, spokeWidth, width, bore. Anchor: `hub` (origin). Parts: `<name>`.
 */
export function escapementWheel(
  options: EscapementWheelOptions,
): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'escapement-wheel';
  const o = wheelOutline({ direction: DRIVE_DIRECTION, ...options, name }, name);
  if (!o.ok) return o;
  const g = o.value;
  const { hubRadius: hub, spokeWidth } = options;
  const rimWall = g.root - RIM_WALL_SHARE * g.depth;
  const checked = checkAll([
    () => inRange('hubRadius', hub, scaled(g.tip, ESCAPEMENT_RANGES.hubTips)),
    () => inRange('spokeWidth', spokeWidth, scaled(g.tip, ESCAPEMENT_RANGES.spokeWidthTips)),
  ]);
  if (!checked.ok) return checked;
  if (!(hub < rimWall)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the hub must lie inside the rim wall under the tooth roots',
        { hubRadius: hub, rimWallRadius: rimWall },
        'reduce the hub radius or the tooth depth',
      ),
    );
  }
  const spokeHalf = spokeWidth / (2 * ((hub + rimWall) / 2));
  // Each opening spans one half-pitch on either side of its tooth, less the spoke web.
  const span = g.pitch / 2 - spokeHalf;
  if (!(span > 0.02)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the spokes leave no room for the spoke openings',
        { teeth: g.teeth, spokeWidth },
        'use fewer teeth or a narrower spoke',
      ),
    );
  }
  if (g.bore > 0 && !(g.bore / 2 < hub)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the bore reaches the spoke openings',
        { bore: g.bore, hubRadius: hub },
        'reduce the bore',
      ),
    );
  }
  const holes: Point2[][] = [];
  for (let k = 0; k < g.teeth; k++) {
    const centre = g.pitch * (k + 0.5);
    const opening: Point2[] = [];
    for (let j = 0; j <= ARC_SAMPLES; j++) {
      const phi = centre - span + (2 * span * j) / ARC_SAMPLES;
      opening.push([rimWall * cos(phi), rimWall * sin(phi)]);
    }
    for (let j = ARC_SAMPLES; j >= 0; j--) {
      const phi = centre - span + (2 * span * j) / ARC_SAMPLES;
      opening.push([hub * cos(phi), hub * sin(phi)]);
    }
    holes.push(opening);
  }
  if (g.bore > 0) holes.push(circle(g.bore / 2, 32));
  return finishPart(
    wheelModel(g, name, holes),
    name,
    { hub: [0, 0, 0] },
    {
      teeth: g.teeth,
      pitch: degrees(g.pitch),
      rootRadius: g.root,
      tipRadius: g.tip,
      toothDepth: g.depth,
      toothLand: degrees(g.landAngle),
      hubRadius: hub,
      spokeWidth,
      width: g.width,
      bore: g.bore,
    },
  );
}

/**
 * Steelyard stop: a lever whose nose rests on the locking face of `escapementWheel`, built in the
 * wheel's frame. Its pivot is `leverTips` tip radii from the nose (default 3). The trip mass
 * balances the wheel torque T at the nose by `m * g * L = T`, so `tripMass = T / (g * L)` with
 * g = `STANDARD_GRAVITY`. Zero joint angle is the built seat. Anchors: `pivot`, `nose`.
 * Parts: `<name>`.
 */
export function steelyardStop(options: SteelyardStopOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'steelyard-stop';
  const leverTips = options.leverTips ?? DEFAULT_LEVER_TIPS;
  const { torque } = options;
  const checked = checkAll([
    () => inRange('leverTips', leverTips, ESCAPEMENT_RANGES.leverTips),
    () => inRange('torque', torque, [1e-9, 100]),
  ]);
  if (!checked.ok) return checked;
  const l = locking({ direction: DRIVE_DIRECTION, ...options, name }, leverTips, name);
  if (!l.ok) return l;
  const seat = checkSeat(l.value, options);
  if (!seat.ok) return seat;
  const g = l.value;
  return finishPart(
    leverModel(g, name),
    name,
    { pivot: [g.pivot[0], g.pivot[1], 0], nose: [g.nose[0], g.nose[1], 0] },
    {
      leverTips,
      length: g.length,
      width: g.width,
      torque,
      tripMass: torque / (STANDARD_GRAVITY * g.length),
    },
  );
}

/**
 * Lever joint angle (degrees, zero at the built seat) that lifts the nose clear of the tooth tips,
 * out to `tip * (1 + RELEASE_MARGIN)`. Closed form from the lever length and the pivot position.
 */
export function escapementReleaseAngle(
  options: SteelyardStopOptions,
): Result<number, ModelingError> {
  const leverTips = options.leverTips ?? DEFAULT_LEVER_TIPS;
  const l = locking(
    { direction: DRIVE_DIRECTION, ...options, name: options.name ?? 'steelyard-stop' },
    leverTips,
    'steelyard-stop',
  );
  if (!l.ok) return l;
  const beta = releaseAngle(l.value);
  if (beta === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the lever cannot be lifted clear of the tooth tips',
        { teeth: options.teeth, leverTips },
        'lengthen the lever or reduce the tooth depth',
      ),
    );
  }
  return ok(degrees(beta));
}

/**
 * Stop joint angle (degrees, zero at the built seat) at which the nose rests on the wheel turned by
 * `wheelAngle` (degrees). Mirrors `ratchetPawlAngle` for the escapement stop.
 */
export function escapementStopAngle(
  options: SteelyardStopOptions,
  wheelAngle: number,
): Result<number, ModelingError> {
  const leverTips = options.leverTips ?? DEFAULT_LEVER_TIPS;
  const l = locking(
    { direction: DRIVE_DIRECTION, ...options, name: options.name ?? 'steelyard-stop' },
    leverTips,
    'steelyard-stop',
  );
  if (!l.ok) return l;
  const beta = restingAngle(l.value, (wheelAngle * Math.PI) / 180);
  if (beta === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the stop finds no resting contact on the wheel at this angle',
        { wheelAngle, teeth: options.teeth },
        'use fewer teeth, a shallower tooth or a smaller land',
      ),
    );
  }
  return ok(degrees(beta));
}
