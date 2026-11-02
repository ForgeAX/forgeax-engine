import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from '../arrays';
import { cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import type { DesignedContact } from '../interference';
import type { Model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';

/**
 * A recipe result: an ordinary modeling session holding the part, named points for
 * assembly (pin axes, mounting faces) and the derived dimensions of the part.
 */
export interface RecipePart {
  readonly model: Model;
  readonly anchors: Readonly<Record<string, Tuple3>>;
  readonly dimensions: Readonly<Record<string, number>>;
  /**
   * Multi-part recipes: the designed contacts between their labeled parts, for `validate`
   * as is and for a rig whose parts are bound under the same names.
   */
  readonly contacts?: readonly DesignedContact[];
}

/** Every recipe names its labels `<name>` and `<name>-<feature>` and tags all faces `<name>`. */
export interface RecipeNaming {
  /** Label prefix and tag of the part (default: the recipe name). */
  readonly name?: string;
}

/** Inclusive bounds of one recipe parameter, in the parameter's own unit (relative slack 1e-9). */
export type Range = readonly [min: number, max: number];

export function inRange(
  name: string,
  value: number,
  [min, max]: Range,
  integer = false,
): Result<number, ModelingError> {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min - Math.abs(min) * 1e-9 ||
    value > max + Math.abs(max) * 1e-9 ||
    (integer && !Number.isInteger(value))
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        `${name} is ${integer ? 'an integer' : 'a number'} within [${min}, ${max}]`,
        { [name]: value, min, max },
        'pass a value inside the declared range; dependent limits follow from the other parameters',
      ),
    );
  }
  return ok(value);
}

/** Check parameters in order; the first violation is the recipe's error. */
export function checkAll(
  checks: readonly (() => Result<number, ModelingError>)[],
): Result<void, ModelingError> {
  for (const check of checks) {
    const done = check();
    if (!done.ok) return done;
  }
  return ok(undefined);
}

export function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** `n` points of a circle, counter-clockwise from angle `phase` (radians). */
export function circle(radius: number, n: number, center: Point2 = [0, 0], phase = 0): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return [center[0] + radius * cos(a), center[1] + radius * sin(a)] as Point2;
  });
}

/** Circle points in the order the revolve uses after an extrusion turned to +Y. */
export function revolveCircle(radius: number, n: number): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const phi = (((i * 360) / n) * Math.PI) / 180;
    return [radius * sin(phi), -radius * cos(phi)] as Point2;
  });
}

/**
 * Vertex radius of a regular n-gon (revolve or `revolveCircle`) whose flats lie at `flat`:
 * fits are measured across flats, which pins and bores of one segment count share.
 */
export function vertexRadius(flat: number, n: number): number {
  return flat / cos(Math.PI / n);
}

/** Mark crease edges sharp, tag the whole part, box-project UVs and close the result. */
export function finishPart(
  m: Model,
  name: string,
  anchors: Record<string, Tuple3>,
  dimensions: Record<string, number>,
  sharpAngle = 30,
): Result<RecipePart, ModelingError> {
  if (m.count(sel.edges.dihedral('>', sharpAngle)) > 0) {
    m.markSharp(sel.edges.dihedral('>', sharpAngle));
  }
  m.tag(sel.all(), name);
  const box = m.bounds(sel.all());
  if (!box.ok) return box;
  const extent = maxOf(box.value.max.map((v, k) => v - (box.value.min[k] as number)));
  m.uv.project({ mode: 'box', scale: extent / 2 });
  if (m.poisoned !== undefined) return err(m.poisoned);
  return ok({ model: m, anchors, dimensions });
}
