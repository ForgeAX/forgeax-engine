import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import sceneCaseSchema from '../../schemas/scene-case.schema.json' with { type: 'json' };
import type { SceneCase, ValidationError, ValidationResult } from './types';

const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
  sceneCaseSchema,
) as ValidateFunction;

function errorPath(error: ErrorObject): string[] {
  const path = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const property = error.params as {
    missingProperty?: string;
    additionalProperty?: string;
  };
  if (error.keyword === 'required' && property.missingProperty) path.push(property.missingProperty);
  if (error.keyword === 'additionalProperties' && property.additionalProperty)
    path.push(property.additionalProperty);
  return path;
}

function findNonFinite(value: unknown, path: string[] = []): string[] | undefined {
  if (typeof value === 'number' && !Number.isFinite(value)) return path;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findNonFinite(item, [...path, String(index)]);
      if (found) return found;
    }
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const found = findNonFinite(item, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

function invalid(error: ValidationError): ValidationResult<SceneCase> {
  return { ok: false, error };
}

export function validateSceneCase(input: unknown): ValidationResult<SceneCase> {
  const nonFinitePath = findNonFinite(input);
  if (nonFinitePath) {
    return invalid({
      code: 'non-finite-value',
      expected: 'finite JSON numbers',
      hint: 'replace NaN or Infinity at the reported field and rerun this case',
      detail: { path: nonFinitePath, message: 'value must be finite' },
    });
  }
  if (!validateSchema(input)) {
    const first = validateSchema.errors?.[0];
    const detail = {
      path: first ? errorPath(first) : [],
      message: first?.message ?? 'schema validation failed',
      ...(first?.keyword === undefined ? {} : { keyword: first.keyword }),
    };
    return invalid({
      code: 'schema-invalid',
      expected: 'a SceneCase matching scene-case.schema.json',
      hint: 'fix the reported field before starting any pixel comparison',
      detail,
    });
  }
  return { ok: true, value: input as SceneCase };
}
