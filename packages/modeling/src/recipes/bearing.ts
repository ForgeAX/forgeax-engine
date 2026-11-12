import type { Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export interface BallBearingOptions extends RecipeNaming {
  /** Inner (bore) diameter (meters). */
  readonly bore: number;
  readonly outer: number;
  /** Width along +Y, centred on y = 0. */
  readonly width: number;
  /** Number of balls (default: as many as fit with a 10% gap). */
  readonly balls?: number;
  /** Segments around the axis (default 48). */
  readonly segments?: number;
}

/** Declared ranges; `outer` is a multiple of the bore and `width` of the radial section. */
export const BALL_BEARING_RANGES = {
  bore: [0.003, 0.3],
  outerBores: [1.6, 3.2],
  widthSections: [0.65, 1.4],
  segments: [24, 96],
} as const satisfies Record<string, Range>;

/** Points of the groove arc around (cx, 0) from angle `from` to `to` (radians), ends included. */
function arc(cx: number, radius: number, from: number, to: number, n: number): Point2[] {
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = from + ((to - from) * k) / n;
    return [cx + radius * cos(a), radius * sin(a)] as Point2;
  });
}

/**
 * Deep-groove ball bearing about +Y: inner and outer races with a ball groove
 * (labels `<name>-inner`, `<name>-outer`, slot `steel`) and balls on the pitch circle
 * (`<name>-ball`, slot `chrome`). Balls clear the grooves by 3% of their diameter.
 * Anchors: `center`; dimensions: `ballDiameter`, `pitchRadius`, `balls`.
 */
export function ballBearing(options: BallBearingOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'bearing';
  const { bore, outer, width } = options;
  const segments = options.segments ?? 48;
  const section = (outer - bore) / 2;
  const pitch = (outer + bore) / 4;
  const ball = 0.6 * section;
  const fit = Math.floor((2 * Math.PI * pitch) / (1.1 * ball));
  const balls = options.balls ?? fit;
  const checked = checkAll([
    () => inRange('bore', bore, BALL_BEARING_RANGES.bore),
    () => inRange('outer', outer, [bore * 1.6, bore * 3.2]),
    () => inRange('width', width, [section * 0.65, section * 1.4]),
    () => inRange('balls', balls, [3, fit], true),
    () => inRange('segments', segments, BALL_BEARING_RANGES.segments, true),
  ]);
  if (!checked.ok) return checked;
  const groove = 0.53 * ball;
  const shoulder = 0.35 * ball;
  const opening = atan2(Math.sqrt(groove * groove - shoulder * shoulder), shoulder);
  const ri = pitch - shoulder;
  const ro = pitch + shoulder;
  const h = width / 2;
  const n = 10;
  const m = model();
  m.revolve({
    points: [
      [bore / 2, -h],
      [ri, -h],
      ...arc(pitch, groove, Math.PI + opening, Math.PI - opening, n),
      [ri, h],
      [bore / 2, h],
      [bore / 2, -h],
    ],
    segments,
    label: `${name}-inner`,
  });
  m.revolve({
    points: [
      [ro, -h],
      [outer / 2, -h],
      [outer / 2, h],
      [ro, h],
      ...arc(pitch, groove, opening, -opening, n),
      [ro, -h],
    ],
    segments,
    label: `${name}-outer`,
  });
  for (let k = 0; k < balls; k++) {
    const a = (2 * Math.PI * k) / balls;
    m.sphere({
      radius: ball / 2,
      widthSegments: 16,
      heightSegments: 10,
      center: [pitch * sin(a), 0, pitch * cos(a)],
      label: `${name}-ball`,
    });
  }
  m.assign(sel.createdBy(`${name}-inner`).or(sel.createdBy(`${name}-outer`)), 'steel');
  m.assign(sel.createdBy(`${name}-ball`), 'chrome');
  return finishPart(
    m,
    name,
    { center: [0, 0, 0] },
    { ballDiameter: ball, pitchRadius: pitch, balls, bore, outer, width },
  );
}
