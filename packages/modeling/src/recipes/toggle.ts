import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, hypot2 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { sel } from '../selectors';
import {
  checkAll,
  degrees,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export interface OverCenterLockOptions extends RecipeNaming {
  /** Distance between the ground pivot A (origin) and the end pivot B (+X), meters. */
  readonly span: number;
  /**
   * How far the middle pivot M rests past the line A-B (meters, toward -Y): the lock. A
   * toggle at or before the line is pushed open by its load, so it must be positive.
   */
  readonly overCentre: number;
  /** Link width (in the plane) and thickness (along Z). */
  readonly width: number;
  readonly thickness: number;
  /** Gap between link A and the stop at the locked pose (default 0.0002 m). */
  readonly stopGap?: number;
}

/** Declared ranges; link sizes scale with the span. */
export const OVER_CENTER_LOCK_RANGES = {
  span: [0.02, 2],
  overCentreSpans: [0.005, 0.2],
  widthSpans: [0.03, 0.3],
  thicknessSpans: [0.01, 0.15],
  stopGap: [0, 0.0005],
} as const satisfies Record<string, Range>;

/**
 * An over-centre (toggle) lock at its locked pose (R3 3.1 and 3.8): link A from the ground
 * pivot A to the middle pivot M, link B from M to B one thickness above it, and a ground stop
 * under M that link A rests on. Load on B pushes M further past the line A-B, onto the stop,
 * so the lock holds; unlocking turns link A back over the line (+Z about A). It holds compression
 * only: a tensile load on B turns link A back over the line too, so reversed loads need a latch
 * or a spring. Parts:
 * `<name>-a`, `<name>-b`, `<name>-stop`. For a rig, put a revolute joint about +Z at anchor
 * `a` with limits [0, open] and `stops: { min: { stop: '<name>-stop', against: '<name>-a' } }`.
 */
export function overCenterLock(options: OverCenterLockOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'lock';
  const { span, overCentre, width, thickness } = options;
  const stopGap = options.stopGap ?? 0.0002;
  if (!(overCentre > 0)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'an over-centre lock rests past the line A-B: overCentre > 0',
        { overCentre },
        'a toggle at or before its centre line is pushed open by its load; move M past the line',
      ),
    );
  }
  const checked = checkAll([
    () => inRange('span', span, OVER_CENTER_LOCK_RANGES.span),
    () => inRange('overCentre', overCentre, [span * 0.005, span * 0.2]),
    () => inRange('width', width, [span * 0.03, span * 0.3]),
    () => inRange('thickness', thickness, [span * 0.01, span * 0.15]),
    () => inRange('stopGap', stopGap, OVER_CENTER_LOCK_RANGES.stopGap),
  ]);
  if (!checked.ok) return checked;
  const half = span / 2;
  const length = hypot2(half, overCentre);
  const turn = degrees(atan2(overCentre, half));
  const m = model();
  // Each link a box between its pivots, extended half a width past each (pivot bosses).
  const link = (label: string, angle: number, centre: Tuple3) => {
    m.box({ size: [length + width, width, thickness], label });
    m.rotate(sel.createdBy(label), 'z', angle);
    m.translate(sel.createdBy(label), centre);
  };
  link(`${name}-a`, -turn, [half / 2, -overCentre / 2, 0]);
  link(`${name}-b`, turn, [half + half / 2, -overCentre / 2, thickness]);
  // Link A's bottom edge falls toward M, so its lowest point is the boss corner past M.
  const low = -overCentre - (overCentre / length) * (width / 2) - (half / length) * (width / 2);
  const block = width;
  m.box({
    size: [block, block, thickness],
    center: [half, low - stopGap - block / 2, 0],
    label: `${name}-stop`,
  });
  for (const part of ['a', 'b', 'stop']) m.tag(sel.createdBy(`${name}-${part}`), `${name}-${part}`);
  m.assign(sel.all(), 'steel');
  const part = finishPart(
    m,
    name,
    {
      a: [0, 0, 0],
      m: [half, -overCentre, 0],
      b: [span, 0, 0],
      stop: [half, low - stopGap, 0],
    },
    { linkLength: length, overCentre, lockAngle: turn, stopGap, stopSize: block },
  );
  // The links overlap at M, one on the other: a designed seat (the pin is the rig's joint).
  return part.ok
    ? ok({
        ...part.value,
        contacts: [{ parts: [`${name}-a`, `${name}-b`], kind: 'seat' as const }],
      })
    : part;
}
