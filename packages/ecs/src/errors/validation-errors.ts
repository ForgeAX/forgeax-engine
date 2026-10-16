import type { Component, ComponentSchema, FieldReflection } from '../component';
import { componentDefinition } from '../component-schema';

export class TimeDeltaInvalidError extends Error {
  override readonly name = 'TimeDeltaInvalidError';
  readonly code = 'time-delta-invalid' as const;
  readonly expected = 'a finite delta greater than or equal to 0';
  readonly hint = 'Call world.update(deltaSeconds) with a finite non-negative delta.';
  readonly detail: { readonly received: number };

  constructor(received: number) {
    super(
      `Invalid world.update delta: ${received}.\n  expected: a finite delta greater than or equal to 0\n  hint: Call world.update(deltaSeconds) with a finite non-negative delta.`,
    );
    this.detail = { received };
  }
}

export class TimeConfigInvalidError extends Error {
  override readonly name = 'TimeConfigInvalidError';
  readonly code = 'time-config-invalid' as const;
  readonly expected: string;
  readonly hint = 'Increase maxDeltaSeconds or decrease maxStepsPerUpdate or fixedDeltaSeconds.';
  readonly detail: {
    readonly fixedDeltaSeconds: number;
    readonly maxStepsPerUpdate: number;
    readonly maxDeltaSeconds: number;
  };

  constructor(detail: TimeConfigInvalidError['detail']) {
    const expected = 'maxDeltaSeconds >= (maxStepsPerUpdate + 1) * fixedDeltaSeconds';
    super(
      `Invalid World time policy.\n  expected: ${expected}\n  hint: Increase maxDeltaSeconds or decrease maxStepsPerUpdate or fixedDeltaSeconds.`,
    );
    this.expected = expected;
    this.detail = detail;
  }
}

export class ScheduleScopeMismatchError extends Error {
  override readonly name = 'ScheduleScopeMismatchError';
  readonly code = 'schedule-scope-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly sourceSchedule: string;
    readonly targetSchedule: string;
    readonly reference?: string;
  };

  constructor(sourceSchedule: string, targetSchedule: string, reference?: string) {
    const expected = `a reference owned by ${sourceSchedule}`;
    const hint = `The referenced item belongs to ${targetSchedule}; register and order it in ${sourceSchedule}.`;
    super(`Schedule scope mismatch.\n  expected: ${expected}\n  hint: ${hint}`);
    this.expected = expected;
    this.hint = hint;
    this.detail = { sourceSchedule, targetSchedule, ...(reference ? { reference } : {}) };
  }
}

/**
 * Returned when a closed enum field receives a value outside its reflected
 * labels. The write owner runs this before any archetype or column mutation.
 */
export class ComponentFieldInvalidValueError extends Error {
  override readonly name = 'ComponentFieldInvalidValueError';
  readonly code = 'component-field-invalid-value' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly entity: number | undefined;
    readonly component: string;
    readonly field: string;
    readonly received: unknown;
    readonly allowedValues: Readonly<Record<string, number>>;
  };

  constructor(
    entity: number | undefined,
    component: string,
    field: string,
    received: unknown,
    allowedValues: Readonly<Record<string, number>>,
  ) {
    const entries = Object.entries(allowedValues)
      .map(([label, value]) => `${label}=${value}`)
      .join(', ');
    const expected = `${component}.${field} in { ${entries} }`;
    const hint = `Set ${component}.${field} to one of the reflected enum values: ${entries}`;
    super(
      `${component}.${field} received an invalid enum value.\n` +
        `  code: component-field-invalid-value\n` +
        `  component: ${component}\n` +
        `  field: ${field}\n` +
        `  received: ${String(received)}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { entity, component, field, received, allowedValues };
  }
}

export class ComponentNumericValueInvalidError extends Error {
  override readonly name = 'ComponentNumericValueInvalidError';
  readonly code = 'component-numeric-value-invalid' as const;
  readonly expected = 'a numeric value other than NaN';
  readonly hint: string;
  readonly detail: {
    readonly entity: number | undefined;
    readonly component: string;
    readonly field: string;
    readonly received: number;
    readonly index?: number;
  };

  constructor(
    entity: number | undefined,
    component: string,
    field: string,
    received: number,
    index?: number,
  ) {
    const location =
      index === undefined ? `${component}.${field}` : `${component}.${field}[${index}]`;
    const hint = `Replace NaN at ${location} with an authored numeric value; Number.POSITIVE_INFINITY remains valid where the component domain permits it.`;
    super(
      `${location} received NaN.\n` +
        `  code: component-numeric-value-invalid\n` +
        `  expected: a numeric value other than NaN\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.detail = {
      entity,
      component,
      field,
      received,
      ...(index === undefined ? {} : { index }),
    };
  }
}

const NUMERIC_FIELD_TYPES = new Set(['f32', 'f64', 'i32', 'u32', 'i16', 'u16', 'i8', 'u8', 'enum']);

export function validateNumericFieldValues<S extends ComponentSchema>(
  component: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
  entity?: number,
): ComponentNumericValueInvalidError | null {
  if (raw === undefined) return null;
  const fields = componentDefinition(component).fields as Readonly<Record<string, FieldReflection>>;
  const rawValues = raw as Record<string, unknown>;
  for (const fieldName of Object.keys(rawValues)) {
    const reflection = fields[fieldName];
    if (reflection === undefined) continue;
    const value = rawValues[fieldName];
    if (NUMERIC_FIELD_TYPES.has(reflection.type)) {
      if (typeof value === 'number' && Number.isNaN(value)) {
        return new ComponentNumericValueInvalidError(entity, component.name, fieldName, value);
      }
      continue;
    }
    if (
      reflection.arrayMeta === undefined ||
      !NUMERIC_FIELD_TYPES.has(reflection.arrayMeta.elementType)
    ) {
      continue;
    }
    const length =
      Array.isArray(value) || ArrayBuffer.isView(value)
        ? (value as { readonly length?: number }).length
        : undefined;
    if (length === undefined) continue;
    const values = value as ArrayLike<unknown>;
    for (let index = 0; index < length; index++) {
      const received = values[index];
      if (typeof received === 'number' && Number.isNaN(received)) {
        return new ComponentNumericValueInvalidError(
          entity,
          component.name,
          fieldName,
          received,
          index,
        );
      }
    }
  }
  return null;
}

/**
 * Returned before an ECS write when a managed `array<T>` field receives a
 * value that the storage boundary cannot interpret as an array payload. The
 * old column writer treated arbitrary objects as an empty payload, which
 * silently changed the row while retaining no evidence of the caller error.
 */
export class ManagedArrayInvalidValueError extends Error {
  override readonly name = 'ManagedArrayInvalidValueError';
  readonly code = 'managed-array-invalid-value' as const;
  readonly expected = 'an Array or TypedArray payload (or null/undefined to clear it)';
  readonly hint: string;
  readonly detail: {
    readonly component: string;
    readonly field: string;
    readonly fieldType: string;
    readonly actualValue: unknown;
  };

  constructor(componentName: string, fieldName: string, fieldType: string, actualValue: unknown) {
    const hint =
      `Set ${componentName}.${fieldName} to a plain array or TypedArray matching ` +
      `${fieldType}; use null or undefined to clear the managed value.`;
    super(
      `${componentName}.${fieldName}: managed array received an invalid value.\n` +
        `  code: managed-array-invalid-value\n` +
        `  fieldType: ${fieldType}\n` +
        `  expected: an Array or TypedArray payload (or null/undefined to clear it)\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.detail = { component: componentName, field: fieldName, fieldType, actualValue };
  }
}

/**
 * Returned by `World.setArrayRange` when the written window does not fit the
 * field's current length, or the field is not a numeric array. The write
 * never resizes: a range write that would grow the array must use `set`.
 */
export class ArrayRangeOutOfBoundsError extends RangeError {
  override readonly name = 'ArrayRangeOutOfBoundsError';
  readonly code = 'array-range-out-of-bounds' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly component: string;
    readonly field: string;
    readonly offset: number;
    readonly length: number;
    readonly size: number;
  };

  constructor(
    componentName: string,
    fieldName: string,
    offset: number,
    length: number,
    size: number,
  ) {
    const expected = `an integer offset with offset + length <= ${size}`;
    const hint =
      size < 0
        ? `${componentName}.${fieldName} is not a numeric array field; use world.set for it.`
        : `Write within [0, ${size}) of ${componentName}.${fieldName}, or use world.set to resize the array.`;
    super(
      `${componentName}.${fieldName}: range [${offset}, ${offset + length}) is outside the array.\n` +
        `  code: array-range-out-of-bounds\n` +
        `  size: ${size}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.expected = expected;
    this.hint = hint;
    this.detail = { component: componentName, field: fieldName, offset, length, size };
  }
}

/**
 * Validate the closed enum fields present in a write payload. Enums without
 * labels remain open numeric fields for compatibility with existing schemas.
 */
export function validateEnumFieldValues<S extends ComponentSchema>(
  component: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
  entity?: number,
): ComponentFieldInvalidValueError | null {
  if (raw === undefined) return null;
  const fields = componentDefinition(component).fields as Readonly<Record<string, FieldReflection>>;
  const rawValues = raw as Record<string, unknown>;
  for (const fieldName of Object.keys(rawValues)) {
    const reflection = fields[fieldName];
    if (reflection?.type !== 'enum' || reflection.labels === undefined) continue;
    const value = rawValues[fieldName];
    const allowedValues = Object.values(reflection.labels);
    if (typeof value !== 'number' || !Number.isInteger(value) || !allowedValues.includes(value)) {
      return new ComponentFieldInvalidValueError(
        entity,
        component.name,
        fieldName,
        value,
        reflection.labels,
      );
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260519-light-casters-point-spot-pbr w2 — closed-union evolution +1.
//
// Adds 1 new member 'spawn-light-invalid-bounds' to EcsErrorCode (23 -> 24).
// AGENTS.md section Error model evolution contract: minor (add member only).
// Triggered by PointLight / SpotLight spawn-time payload validation
// (plan-strategy D-S3 a). detail.field three-branch
// ('range' | 'innerOuter' | 'outerNinety') keeps the four bound-violation
// shapes under one error code so callers narrow first on `.code` then on
// `.detail.field` (charter P3 progressive disclosure).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `world.spawn` when a PointLight or SpotLight
 * payload field is out of the documented bound. Four bound violations share
 * one `.code` and discriminate via `.detail.field`:
 *
 * - `range` — PointLight / SpotLight `range < 0` or `Number.isNaN(range)`.
 *   Use `Number.POSITIVE_INFINITY` for an unlimited range or a non-negative
 *   meter value.
 * - `innerOuter` — SpotLight `outerConeDeg <= innerConeDeg`. Inner cone is
 *   the saturated bright region; outer cone is the falloff edge.
 * - `outerNinety` — SpotLight `outerConeDeg > 90`. KHR_lights_punctual upper
 *   bound. A spot light cone wider than 90 degrees becomes a point light;
 *   use PointLight instead.
 * - `direction` — DirectionalLight / SpotLight `direction` is missing or a
 *   zero vector `[0, 0, 0]`. Direction has no default (there is no universal
 *   default direction): omitting it lands the array layer-3 all-zero, which is
 *   the same illegal state as an explicit zero vector. Supply a non-zero
 *   direction (feat-20260709 M2 / D-1, add-only union member).
 *
 * `.code = 'spawn-light-invalid-bounds'`
 * `.detail.field` is derived from `keyof typeof SPAWN_LIGHT_INVALID_BOUNDS_POLICY`;
 * `.detail.got` is `number | readonly number[]`.
 * `.hint` — names the offending field plus the valid replacement form.
 */
const SPAWN_LIGHT_INVALID_BOUNDS_POLICY = {
  intensity: {
    expected: 'intensity is finite and >= 0',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.intensity must be a finite non-negative number (got ${got})`,
  },
  color: {
    expected: 'color is a finite non-negative [r, g, b] vector',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.color must contain three finite non-negative channels (got ${JSON.stringify(got)})`,
  },
  width: {
    expected: 'width is finite and > 0',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.width must be a finite positive meter value (got ${got})`,
  },
  height: {
    expected: 'height is finite and > 0',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.height must be a finite positive meter value (got ${got})`,
  },
  irradiance: {
    expected: 'irradiance is a finite 27-value SH vector',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.irradiance must contain 27 finite SH values (got ${JSON.stringify(got)})`,
  },
  radius: {
    expected: 'radius is finite and >= R_MIN',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.radius must be a finite value >= R_MIN (got ${got})`,
  },
  range: {
    expected: 'range >= 0 or Number.POSITIVE_INFINITY',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.range = ${got} is invalid; use Number.POSITIVE_INFINITY for unlimited range, or a non-negative meter value`,
  },
  innerOuter: {
    expected: 'outerConeDeg > innerConeDeg',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.outerConeDeg <= innerConeDeg (got ${got}); inner cone is the saturated bright region, outer cone is the falloff edge; outerConeDeg > innerConeDeg required`,
  },
  outerNinety: {
    expected: 'outerConeDeg <= 90 (KHR_lights_punctual upper bound)',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.outerConeDeg = ${got} > 90; a spot light cone wider than 90 degrees becomes a point light; use PointLight instead`,
  },
  direction: {
    expected: 'direction is a non-zero [x, y, z] vector',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.direction is missing or a zero vector (got ${JSON.stringify(got)}); direction has no default, provide a non-zero direction, e.g. [-0.5, -1, -0.3]`,
  },
} satisfies Record<
  string,
  {
    readonly expected: string;
    readonly hint: (componentName: string, got: number | readonly number[]) => string;
  }
>;

export class SpawnLightInvalidBoundsError extends Error {
  override readonly name = 'SpawnLightInvalidBoundsError';
  readonly code = 'spawn-light-invalid-bounds' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly field: keyof typeof SPAWN_LIGHT_INVALID_BOUNDS_POLICY;
    readonly got: number | readonly number[];
  };

  constructor(
    componentName: string,
    field: keyof typeof SPAWN_LIGHT_INVALID_BOUNDS_POLICY,
    got: number | readonly number[],
  ) {
    const policy = SPAWN_LIGHT_INVALID_BOUNDS_POLICY[field];
    const hint = policy.hint(componentName, got);
    const expectedStr = policy.expected;
    super(
      `${componentName}: spawn payload bound violation.\n` +
        `  code: spawn-light-invalid-bounds\n` +
        `  component: ${componentName}\n` +
        `  field: ${field}\n` +
        `  got: ${got}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { field, got };
  }
}

/**
 * Returned via `Result.err` from resource-setter helpers (e.g.
 * `setTransparentSortConfig`) when a numeric payload field violates the
 * closed bound declared by the resource contract. The first consumer is
 * `TransparentSortConfig.mode ∈ {0, 1, 2}` (plan-strategy D-4); future
 * resource validators with the same shape reuse this code by routing
 * through `.detail.receivedKey` to disambiguate which resource validator
 * surfaced the failure.
 *
 * Closed-set kebab code consistent with `spawn-light-invalid-bounds`
 * (feat-20260519 / w2); AI users consume via `switch (err.code)` exhaustive
 * narrows + `err.detail.receivedMode` (or `err.detail.receivedKey` /
 * `err.expected`) property access — never string-parse the message.
 *
 * `.code = 'resource-invalid-value'`
 * `.detail = { receivedMode: number; receivedKey?: string }`
 * `.hint` — direct copy-paste recovery (e.g. "0=layer-z, 1=layer-y,
 *   2=layer-yz" for the sort-config case).
 * `.expected` — the bound contract literal (e.g. "mode ∈ {0, 1, 2}").
 *
 * @reuses RhiError structured shape — same `.code / .expected / .hint /
 *   .detail` quadruple AI users consume across rhi + ecs.
 */
export class ResourceInvalidValueError extends Error {
  override readonly name = 'ResourceInvalidValueError';
  readonly code = 'resource-invalid-value' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly receivedMode: number; readonly receivedKey?: string };

  constructor(
    expected: string,
    hint: string,
    detail: { readonly receivedMode: number; readonly receivedKey?: string },
  ) {
    const keyClause = detail.receivedKey === undefined ? '' : `  key: ${detail.receivedKey}\n`;
    super(
      `resource: invalid value.\n` +
        `  code: resource-invalid-value\n` +
        keyClause +
        `  receivedMode: ${detail.receivedMode}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = detail;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260521-sprite-atlas-animation M1 T-05 — closed-union evolution +1.
//
// Adds 1 new member 'sprite-animation-invalid' to EcsErrorCode (25 -> 26).
// AGENTS.md §Error model evolution contract: minor (add member only).
// Same-shape add-only mirror of SpawnLightInvalidBoundsError (feat-20260519
// w2 line 736-776) and ResourceInvalidValueError (feat-20260520 w13 line
// 862) — the kebab `'<noun>-invalid-...'` series keeps `switch (err.code)`
// exhaustive narrows visually consistent (charter P4 consistent abstraction;
// research F-7 candidate A).
//
// Triggered by `spriteAnimationTickSystem` (packages/runtime/src/systems/
// sprite-animation-tick.ts, landed in M4 T-23) when an entity's
// `SpriteAnimation` row violates one of two runtime invariants:
//
//   - field='regions-length' -> `regions.length !== frameCount * 4`
//   - field='frame-duration' -> `frameDuration <= 0`
//
// `.detail.field` two-branch (charter P3: AI users branch once on
// `err.code` and once on `err.detail.field` to reach the recovery hint
// without parsing the message). Plan-strategy section 2 D-1 binds the
// detail field shape; M4 T-19 / T-20 / T-21 cover the runtime fail-fast
// paths end-to-end.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `spriteAnimationTickSystem` (M4 T-23) when
 * an entity's `SpriteAnimation` row violates a runtime invariant.
 * Two invariants share one `.code` and discriminate via `.detail.field`:
 *
 * - `regions-length` — `SpriteAnimation.regions.length !== frameCount * 4`.
 *   `regions` packs `[uMin, vMin, uW, vH]` per frame so the length must be
 *   exactly `frameCount * 4`. Detail carries the offending `regionsLength`
 *   alongside the declared `frameCount` so the hint can spell the exact
 *   delta in callsite-friendly numbers.
 * - `frame-duration` — `SpriteAnimation.frameDuration <= 0` (covers both
 *   `frameDuration === 0` and `frameDuration < 0`; T-21 binds the negative
 *   case to the same arm so AI users handle both via a single
 *   `if (err.detail.field === 'frame-duration')` branch — charter P4
 *   consistent abstraction).
 *
 * `.code = 'sprite-animation-invalid'`
 * `.detail = { field: 'regions-length', regionsLength, frameCount } |
 *            { field: 'frame-duration', frameDuration }`
 *
 * Two top-level detail variants give each `.field` branch its own
 * required sub-field shape so AI users get strong narrowing inside
 * `switch (err.detail.field)` without optional sub-fields bleeding
 * across branches (mirrors `SpawnLightInvalidBoundsError`'s shared
 * `got: number` shape but adapted because regions-length /
 * frame-duration carry different sub-field counts).
 *
 * `.hint` — names the offending invariant plus the valid replacement form.
 */
export class SpriteAnimationInvalidError extends Error {
  override readonly name = 'SpriteAnimationInvalidError';
  readonly code = 'sprite-animation-invalid' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail:
    | {
        readonly field: 'regions-length';
        readonly regionsLength: number;
        readonly frameCount: number;
      }
    | {
        readonly field: 'frame-duration';
        readonly frameDuration: number;
      };

  private static resolvePolicy(detail: SpriteAnimationInvalidError['detail']): {
    readonly expected: string;
    readonly hint: string;
  } {
    switch (detail.field) {
      case 'regions-length':
        return {
          expected: 'SpriteAnimation.regions.length === frameCount * 4',
          hint: `SpriteAnimation.regions.length = ${detail.regionsLength} does not match frameCount * 4 = ${detail.frameCount * 4}; pack 4 floats [uMin, vMin, uW, vH] per frame (see <name>.atlas.meta.json sidecar 'regions' map)`,
        };
      case 'frame-duration':
        return {
          expected: 'SpriteAnimation.frameDuration > 0',
          hint: `SpriteAnimation.frameDuration = ${detail.frameDuration} is invalid; use a positive seconds-per-frame value (e.g. 0.1 = 10 fps)`,
        };
    }
  }

  constructor(detail: SpriteAnimationInvalidError['detail']) {
    const policy = SpriteAnimationInvalidError.resolvePolicy(detail);
    super(
      `SpriteAnimation: invariant violated.\n` +
        `  code: sprite-animation-invalid\n` +
        `  field: ${detail.field}\n` +
        `  expected: ${policy.expected}\n` +
        `  hint: ${policy.hint}`,
    );
    this.hint = policy.hint;
    this.expected = policy.expected;
    this.detail = detail;
  }
}
