import { ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import type { ModelingError } from '../errors';
import { type Model, model } from '../model';
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

export interface HydraulicCylinderOptions extends RecipeNaming {
  /** Bore (piston) diameter (meters). */
  readonly bore: number;
  /** Piston rod diameter. */
  readonly rod: number;
  readonly stroke: number;
  /** Rod extension as a fraction of the stroke (default 0.5). */
  readonly extension?: number;
  /** Eye pin diameter (default: 0.85 x the eye radius). */
  readonly pin?: number;
  /** Segments around the axis (default 32). */
  readonly segments?: number;
}

/** Declared ranges; `rod` and `stroke` are given as multiples of the bore. */
export const HYDRAULIC_CYLINDER_RANGES = {
  bore: [0.01, 0.3],
  rodBores: [0.3, 0.7],
  strokeBores: [1, 20],
  extension: [0, 1],
  segments: [12, 64],
} as const satisfies Record<string, Range>;

/** A clevis eye in the XY plane: a lug from y = 0 down to a round end around (0, -radius). */
export function appendEye(
  m: Model,
  options: {
    readonly radius: number;
    readonly hole: number;
    readonly thickness: number;
    readonly label: string;
    readonly up?: boolean;
  },
): void {
  const { radius: a } = options;
  const outline: Point2[] = [
    [a, 0],
    [-a, 0],
  ];
  const arc = circle(a, 16, [0, -a], Math.PI);
  pushAll(
    outline,
    arc.slice(0, 9).map(([x, y]) => [x, y] as Point2),
  );
  m.extrudePolygon({
    points: outline,
    holes: [circle(options.hole / 2, 20, [0, -a])],
    depth: options.thickness,
    label: options.label,
  });
  m.translate(sel.createdBy(options.label), [0, 0, -options.thickness / 2]);
  if (options.up === true) m.rotate(sel.createdBy(options.label), 'z', 180);
}

/**
 * Double-acting hydraulic cylinder along +Y: a barrel closed at y = 0 with a gland
 * at the top (label `<name>-barrel`, slot `paint`), a piston with its rod at the
 * given extension (`<name>-rod`, `chrome`), clevis eyes with pin holes along Z at
 * both ends (`<name>-eye`, `<name>-rod-eye`, `steel`); the barrel profile carries a
 * V seam groove at the gland.
 * Anchors: `baseEye`, `rodEye` (pin axes); dimensions: `pinToPin`, `barrelLength`.
 */
export function hydraulicCylinder(
  options: HydraulicCylinderOptions,
): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'cylinder';
  const { bore, rod, stroke } = options;
  const extension = options.extension ?? 0.5;
  const segments = options.segments ?? 32;
  const checked = checkAll([
    () => inRange('bore', bore, HYDRAULIC_CYLINDER_RANGES.bore),
    () => inRange('rod', rod, [bore * 0.3, bore * 0.7]),
    () => inRange('stroke', stroke, [bore, bore * 20]),
    () => inRange('extension', extension, HYDRAULIC_CYLINDER_RANGES.extension),
    () => inRange('segments', segments, HYDRAULIC_CYLINDER_RANGES.segments, true),
  ]);
  if (!checked.ok) return checked;
  const wall = 0.12 * bore;
  const outer = bore / 2 + wall;
  const chamfer = 0.03 * bore;
  const cap = 0.25 * bore;
  const gland = 0.5 * bore;
  const pistonLength = 0.4 * bore;
  const end = 0.02 * bore;
  const length = cap + end + stroke + pistonLength + end + gland;
  const glandHole = rod / 2 + 0.03 * rod;
  const eye = 0.6 * outer;
  const pin = options.pin ?? 0.85 * eye;
  const pinOk = inRange('pin', pin, [0.3 * eye, 1.2 * eye]);
  if (!pinOk.ok) return pinOk;
  const seam = length - gland * 0.6;
  const m = model();
  m.revolve({
    points: [
      [0, 0],
      [outer - chamfer, 0],
      [outer, chamfer],
      [outer, seam - 0.02 * bore],
      [outer - 0.015 * bore, seam],
      [outer, seam + 0.02 * bore],
      [outer, length - chamfer],
      [outer - chamfer, length],
      [glandHole, length],
      [glandHole, length - gland],
      [bore / 2, length - gland],
      [bore / 2, cap],
      [0, cap],
    ],
    segments,
    label: `${name}-barrel`,
  });
  const piston = cap + end + extension * stroke;
  const exposed = 0.6 * bore;
  const top = length + exposed + extension * stroke;
  const rodChamfer = 0.04 * rod;
  m.revolve({
    points: [
      [0, piston],
      [bore / 2 - 0.01 * bore, piston],
      [bore / 2 - 0.01 * bore, piston + pistonLength],
      [rod / 2, piston + pistonLength],
      [rod / 2, top - rodChamfer],
      [rod / 2 - rodChamfer, top],
      [0, top],
    ],
    segments,
    label: `${name}-rod`,
  });
  const thickness = 1.2 * eye;
  // Eyes stand off their mounting faces by a hair, so a turned assembly never makes the
  // coplanar contact cross by rounding.
  const standoff = 0.002 * bore;
  appendEye(m, { radius: eye, hole: pin * 1.04, thickness, label: `${name}-eye` });
  m.translate(sel.createdBy(`${name}-eye`), [0, -standoff, 0]);
  appendEye(m, { radius: eye, hole: pin * 1.04, thickness, label: `${name}-rod-eye`, up: true });
  m.translate(sel.createdBy(`${name}-rod-eye`), [0, top + standoff, 0]);
  m.assign(sel.createdBy(`${name}-barrel`), 'paint');
  m.assign(sel.createdBy(`${name}-rod`), 'chrome');
  m.assign(sel.createdBy(`${name}-eye`).or(sel.createdBy(`${name}-rod-eye`)), 'steel');
  const done = finishPart(
    m,
    name,
    { baseEye: [0, -eye - standoff, 0], rodEye: [0, top + eye + standoff, 0] },
    {
      pinToPin: top + 2 * (eye + standoff),
      barrelLength: length,
      pin,
      eyeRadius: eye,
      eyeThickness: thickness,
    },
  );
  if (!done.ok) return done;
  return ok(done.value);
}
