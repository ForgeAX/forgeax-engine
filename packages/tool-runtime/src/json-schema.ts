import type { JsonValue, ToolSchema, ToolSchemaResult } from './types.js';

type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

/** The small JSON Schema vocabulary shared by command contracts. */
export interface ToolJsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly properties?: Readonly<Record<string, ToolJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: ToolJsonSchema;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly minLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

export interface ToolSchemaFailure {
  readonly path: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}

function typeMatches(type: ToolJsonSchema['type'], value: unknown): boolean {
  if (typeof type === 'object') return type.some((candidate) => typeMatches(candidate, value));
  switch (type) {
    case undefined:
      return true;
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

function validate(
  value: unknown,
  schema: ToolJsonSchema,
  path: string,
): ToolSchemaFailure | undefined {
  if (!typeMatches(schema.type, value))
    return { path, message: `expected ${schema.type ?? 'a value'}` };
  if (schema.enum !== undefined && !schema.enum.some((candidate) => sameJson(candidate, value))) {
    return { path, message: 'expected one of the declared enum values' };
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    return { path, message: 'expected the declared constant value' };
  }
  if (
    typeof value === 'string' &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  ) {
    return { path, message: `must contain at least ${schema.minLength} characters` };
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return { path, message: `must be at least ${schema.minimum}` };
    if (schema.maximum !== undefined && value > schema.maximum)
      return { path, message: `must be at most ${schema.maximum}` };
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return { path, message: `must contain at least ${schema.minItems} items` };
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return { path, message: `must contain at most ${schema.maxItems} items` };
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index += 1) {
        for (let previous = 0; previous < index; previous += 1) {
          if (sameJson(value[index], value[previous]))
            return { path: `${path}[${index}]`, message: 'must be unique' };
        }
      }
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = validate(value[index], schema.items, `${path}[${index}]`);
        if (failure !== undefined) return failure;
      }
    }
  }
  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) return { path: `${path}.${key}`, message: 'is required' };
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) return { path: `${path}.${key}`, message: 'is not declared' };
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const failure = validate(value[key], child, `${path}.${key}`);
      if (failure !== undefined) return failure;
    }
  }
  return undefined;
}

export function parseToolJsonSchema<T = unknown>(
  value: unknown,
  schema: ToolJsonSchema,
): ToolSchemaResult<T> {
  const failure = validate(value, schema, '$');
  return failure === undefined
    ? { ok: true, value: value as T }
    : { ok: false, error: `${failure.path}: ${failure.message}` };
}

export function toolJsonSchema<T = unknown>(schema: ToolJsonSchema): ToolSchema<T> {
  const describe = JSON.stringify(schema);
  const admitted: ToolJsonSchema = JSON.parse(describe);
  return {
    parse: (value) => parseToolJsonSchema<T>(value, admitted),
    describe,
  };
}
