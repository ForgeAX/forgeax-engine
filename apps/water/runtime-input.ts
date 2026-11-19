import type { InputShapeOf, SchemaOf } from '@forgeax/engine/ecs';
import type { WaterContactProbeSet, WaterPontoonSet } from '@forgeax/engine/scene';

/** A missing scene member is an authoring failure, not a silently usable value. */
export function requireDemoValue<T>(value: T | null | undefined, subject: string): T {
  if (value === undefined || value === null)
    throw new Error(`Missing required demo value: ${subject}`);
  return value;
}

/** Preserve native owner receivers when checking an optional capability. */
export function requireDemoMethod<T, K extends keyof T>(
  owner: T,
  key: K,
  subject: string,
): NonNullable<T[K]> {
  const method = owner[key];
  if (typeof method !== 'function') throw new Error(`Missing required demo method: ${subject}`);
  return method.bind(owner) as NonNullable<T[K]>;
}

/** Validate author input before writing the same Scene owner; invalid edits retain its prior value. */
export function pontoonInput(
  value: Record<string, unknown>,
): InputShapeOf<SchemaOf<typeof WaterPontoonSet>> {
  const array = (key: string) => {
    const input = value[key];
    if (!Array.isArray(input) && !ArrayBuffer.isView(input))
      throw new Error(`${key} requires a numeric array`);
    const values = Array.from(input as ArrayLike<number>);
    if (values.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry)))
      throw new Error(`${key} requires finite numbers`);
    return values;
  };
  const radii = array('radiiM'),
    anchors = array('anchorsM'),
    enabled = array('enabledPontoons');
  if (
    radii.length < 1 ||
    radii.length > 32 ||
    radii.some((radius) => radius <= 0) ||
    (Number(value.anchorMode) === 0 && anchors.length !== radii.length * 3) ||
    (Number(value.anchorMode) === 1 &&
      (!Array.isArray(value.socketEntities) || value.socketEntities.length !== radii.length)) ||
    (enabled.length !== 0 &&
      (enabled.length !== radii.length || enabled.some((item) => item !== 0 && item !== 1)))
  )
    throw new Error(
      'Pontoon cardinality: 1–32 positive radii, three anchors per radius and matching 0/1 enabled values',
    );
  if (
    !Number.isInteger(value.velocityPontoonIndex) ||
    Number(value.velocityPontoonIndex) < 0 ||
    Number(value.velocityPontoonIndex) >= radii.length
  )
    throw new Error('velocityPontoonIndex must reference an active pontoon');
  return value as InputShapeOf<SchemaOf<typeof WaterPontoonSet>>;
}

export function contactProbeInput(
  value: Record<string, unknown>,
): InputShapeOf<SchemaOf<typeof WaterContactProbeSet>> {
  const read = (key: string) => {
    const input = value[key];
    if (!Array.isArray(input) && !ArrayBuffer.isView(input))
      throw new Error(`${key} requires a numeric array`);
    const values = Array.from(input as ArrayLike<number>);
    if (values.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry)))
      throw new Error(`${key} requires finite numbers`);
    return values;
  };
  const radii = read('radiiM'),
    centers = read('centersM');
  if (
    radii.length < 1 ||
    radii.length > 128 ||
    centers.length !== radii.length * 3 ||
    radii.some((radius) => radius <= 0)
  )
    throw new Error(
      'Contact probes require 1–128 positive radii and three center coordinates per radius',
    );
  return value as InputShapeOf<SchemaOf<typeof WaterContactProbeSet>>;
}
