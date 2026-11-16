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
  const definition = componentDefinition(component);
  if (!definition.plan.hasLabeledEnum) return null;
  const fields = definition.fields as Readonly<Record<string, FieldReflection>>;
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
