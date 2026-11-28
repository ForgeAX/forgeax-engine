import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import { model } from '../model';
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
import {
  checkSeat,
  LEVER_TIPS,
  type LockingOptions,
  leverModel,
  locking,
  restingAngle,
  SEAT_TOLERANCE,
  scaled,
  wheelModel,
} from './locking';

export interface PawlOptions extends RecipeNaming {
  /** Pivot to tip distance, meters: the bar from the pivot boss to the engaging end. */
  readonly length: number;
  /** Bar width across its length, meters. */
  readonly width: number;
  /** Extrusion depth along Z, meters. */
  readonly thickness: number;
  /** Pivot boss radius, meters (default 0.6 width). */
  readonly pivotRadius?: number;
}

/** Declared ranges, relative to the bar width (absolute for the width itself). */
export const PAWL_RANGES = {
  width: [0.0001, 0.2],
  lengthWidths: [2, 50],
  thicknessWidths: [0.1, 50],
  pivotWidths: [0.6, 1.5],
} as const satisfies Record<string, Range>;

/**
 * A pawl bar in its own frame: pivot boss at the origin, bar along +X to the engaging end at
 * `length`, centred on Y and Z. Parts: `<name>`.
 */
export function pawl(options: PawlOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'pawl';
  const { length, width, thickness } = options;
  const pivotRadius = options.pivotRadius ?? 0.6 * width;
  const checked = checkAll([
    () => inRange('width', width, PAWL_RANGES.width),
    () => inRange('length', length, scaled(width, PAWL_RANGES.lengthWidths)),
    () => inRange('thickness', thickness, scaled(width, PAWL_RANGES.thicknessWidths)),
    () => inRange('pivotRadius', pivotRadius, scaled(width, PAWL_RANGES.pivotWidths)),
  ]);
  if (!checked.ok) return checked;
  const half = width / 2;
  const bar: Point2[] = [
    [0, -half],
    [length, -half],
    [length, half],
    [0, half],
  ];
  const m = model();
  m.extrudePolygon({ points: bar, holes: [], depth: thickness, label: name });
  m.translate(sel.all(), [0, 0, -thickness / 2]);
  const boss = model();
  boss.extrudePolygon({
    points: circle(pivotRadius, 32),
    holes: [],
    depth: thickness,
    label: name,
  });
  boss.translate(sel.all(), [0, 0, -thickness / 2]);
  m.union(boss);
  return finishPart(
    m,
    name,
    { pivot: [0, 0, 0], tip: [length, 0, 0] },
    { length, width, thickness, pivotRadius },
  );
}

/** A ratchet wheel and its pawl; the same options as the locking tooth geometry. */
export type RatchetOptions = LockingOptions;

/** Declared ranges, re-exported for the ratchet recipe. */
export { LOCKING_RANGES as RATCHET_RANGES } from './locking';

/**
 * Pawl joint angle (degrees, ccw about the pivot; zero is the built seat) at which the pawl rests
 * on the wheel when the wheel is at `wheelAngle` (degrees, ccw).
 */
export function ratchetPawlAngle(
  options: RatchetOptions,
  wheelAngle: number,
): Result<number, ModelingError> {
  const l = locking(options, LEVER_TIPS, 'ratchet');
  if (!l.ok) return l;
  const beta = restingAngle(l.value, (wheelAngle * Math.PI) / 180);
  if (beta === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the pawl finds no resting contact on the wheel at this angle',
        { wheelAngle, teeth: options.teeth, toothDepth: options.toothDepth },
        'use fewer teeth, a shallower tooth or a smaller land',
      ),
    );
  }
  return ok(degrees(beta));
}

/**
 * A ratchet wheel and its pawl. The pawl hangs below tooth 0: its bearing face lies flush on the
 * tooth's radial stop face and its pivot sits on the stop-face normal through the nose, so a turn
 * against the free direction loads the pawl along its length and the pawl lifts out of the notch
 * without crossing the tooth. `ratchet` proves that the built pose is the resting pose at wheel
 * angle 0 and that every wheel angle across one pitch admits a resting contact; otherwise it
 * returns `model-invalid-argument`. Parts: `<name>-wheel` (revolute about +Z at `hub`) and
 * `<name>-pawl` (revolute about +Z at `pawlPivot`, built at the seat). They touch at the stop face.
 */
export function ratchet(options: RatchetOptions): Result<RecipePart, ModelingError> {
  const l = locking(options, LEVER_TIPS, 'ratchet');
  if (!l.ok) return l;
  const g = l.value;
  const seat = checkSeat(g, options);
  if (!seat.ok) return seat;

  const wheel = wheelModel(g, `${g.name}-wheel`, g.bore > 0 ? [circle(g.bore / 2, 32)] : []);
  wheel.append(leverModel(g, `${g.name}-pawl`).snapshot(), { tag: `${g.name}-pawl` });

  const pivot: Tuple3 = [g.pivot[0], g.pivot[1], 0];
  const part = finishPart(
    wheel,
    g.name,
    { hub: [0, 0, 0], pawlPivot: pivot, pawlNose: [g.nose[0], g.nose[1], 0] },
    {
      teeth: options.teeth,
      pitch: degrees(g.pitch),
      rootRadius: g.tip - g.depth,
      tipRadius: g.tip,
      toothDepth: g.depth,
      toothLand: degrees(g.landAngle),
      width: g.width,
      bore: g.bore,
      bearing: g.bearing,
      pawlLength: g.length,
    },
  );
  return part.ok
    ? ok({
        ...part.value,
        contacts: [
          {
            parts: [`${g.name}-wheel`, `${g.name}-pawl`],
            kind: 'seat' as const,
            tolerance: SEAT_TOLERANCE,
          },
        ],
      })
    : part;
}
