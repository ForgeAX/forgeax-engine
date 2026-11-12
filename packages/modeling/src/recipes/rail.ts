import type { Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  circle,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export interface SlideRailOptions extends RecipeNaming {
  /** Rail length along Z, centred on z = 0 (meters). */
  readonly length: number;
  /** Rail width along X. */
  readonly width: number;
  /** Rail height along +Y from y = 0 (default 0.9 x width). */
  readonly height?: number;
  /** Carriage length along Z (default 2 x width). */
  readonly carriage?: number;
  /** Carriage position along the rail, 0 = at -Z end, 1 = at +Z end (default 0.5). */
  readonly position?: number;
  /** Distance between mounting holes (default 3 x width). */
  readonly holePitch?: number;
}

/** Declared ranges; the other sizes scale with the rail width. */
export const SLIDE_RAIL_RANGES = {
  width: [0.005, 0.1],
  lengthWidths: [4, 200],
  heightWidths: [0.6, 1.2],
  carriageWidths: [1.2, 4],
  position: [0, 1],
  holePitchWidths: [2, 10],
} as const satisfies Record<string, Range>;

/**
 * Profiled linear guide along Z: a rail with chamfered mounting holes (role `bevel`
 * of `<name>-rail`) and U ball
 * tracks cut as panel lines along both sides (`<name>-rail`, `<name>-track`, slot
 * `steel`), and a carriage wrapping it with clearance (`<name>-carriage`, `paint`)
 * between two end seals (`<name>-seal`, `rubber`). Anchors: `carriageTop`.
 */
export function slideRail(options: SlideRailOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'rail';
  const { length, width } = options;
  const height = options.height ?? 0.9 * width;
  const carriage = options.carriage ?? 2 * width;
  const position = options.position ?? 0.5;
  const holePitch = options.holePitch ?? 3 * width;
  const checked = checkAll([
    () => inRange('width', width, SLIDE_RAIL_RANGES.width),
    () => inRange('length', length, [width * 4, width * 200]),
    () => inRange('height', height, [width * 0.6, width * 1.2]),
    () => inRange('carriage', carriage, [width * 1.2, Math.min(width * 4, length * 0.8)]),
    () => inRange('position', position, SLIDE_RAIL_RANGES.position),
    () => inRange('holePitch', holePitch, [width * 2, width * 10]),
  ]);
  if (!checked.ok) return checked;
  const rail = `${name}-rail`;
  const holes = Math.max(1, Math.floor(length / holePitch));
  const first = (length - (holes - 1) * holePitch) / 2;
  const hole = 0.18 * width;
  const m = model();
  m.extrudePolygon({
    points: [
      [-width / 2, 0],
      [width / 2, 0],
      [width / 2, length],
      [-width / 2, length],
    ],
    holes: Array.from({ length: holes }, (_, i) => circle(hole, 16, [0, first + i * holePitch])),
    depth: height,
    label: rail,
  });
  // Chamfered mouths on the mounting holes (top face; the rail stands on the bottom).
  m.bevel(
    sel
      .createdBy(rail, 'hole')
      .toEdges('touching')
      .and(sel.createdBy(rail, 'top').toEdges('touching')),
    { width: 0.35 * hole, segments: 1, label: rail },
  );
  m.rotate(sel.createdBy(rail), 'x', -90);
  m.translate(sel.createdBy(rail), [0, 0, length / 2]);
  for (const side of ['+x', '-x'] as const) {
    m.panelLine(
      {
        faces: sel.createdBy(rail, 'side').and(sel.facing(side)),
        point: [0, height * 0.62, 0],
        normal: [0, 1, 0],
      },
      { width: height * 0.2, depth: width * 0.1, profile: 'u', label: `${name}-track` },
    );
  }
  const c = 0.03 * width;
  const outer = width * 1.1;
  const bottom = height * 0.3;
  const top = height + 0.45 * width;
  const profile: Point2[] = [
    [-outer, bottom],
    [-width / 2 - c, bottom],
    [-width / 2 - c, height + c],
    [width / 2 + c, height + c],
    [width / 2 + c, bottom],
    [outer, bottom],
    [outer, top],
    [-outer, top],
  ];
  const seal = 0.06 * width;
  const gap = 0.004 * width;
  const span = carriage + 2 * (seal + gap);
  const center = -length / 2 + span / 2 + position * (length - span);
  m.extrudePolygon({ points: profile, depth: carriage, label: `${name}-carriage` });
  m.translate(sel.createdBy(`${name}-carriage`), [0, 0, center - carriage / 2]);
  for (const z of [center - carriage / 2 - gap - seal, center + carriage / 2 + gap]) {
    const label = `${name}-seal-${z < center ? 'a' : 'b'}`;
    m.extrudePolygon({ points: profile, depth: seal, label });
    m.translate(sel.createdBy(label), [0, 0, z]);
  }
  m.assign(sel.all(), 'steel');
  m.assign(sel.createdBy(`${name}-carriage`), 'paint');
  m.assign(sel.createdBy(`${name}-seal-a`).or(sel.createdBy(`${name}-seal-b`)), 'rubber');
  return finishPart(
    m,
    name,
    { carriageTop: [0, top, center], railTop: [0, height, 0] },
    { holes, carriageCenter: center, travel: length - span },
  );
}
