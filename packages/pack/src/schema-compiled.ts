import { err, ok, type PackV2, type PackV2Error, type Result } from '@forgeax/engine-types';
import type { ValidateFunction } from 'ajv';
import {
  validateMeta as metaValidator,
  validatePack as packValidator,
} from './generated/schema-validators.cjs';
export const validateMeta: ValidateFunction = metaValidator;
export const validatePack: ValidateFunction = packValidator;
export function validatePackV2(value: unknown): value is PackV2 {
  if (!validatePack(value) || !isPackV2Shape(value)) return false;

  const seenGuids = new Set<string>();
  for (const asset of value.assets) {
    if (seenGuids.has(asset.guid)) return false;
    seenGuids.add(asset.guid);
  }
  return true;
}

function isPackV2Shape(value: unknown): value is PackV2 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === '2.0.0'
  );
}

export function parsePackV2(value: unknown): Result<PackV2, PackV2Error> {
  if (!validatePackV2(value)) {
    return err({
      code: 'pack-v2-envelope-invalid',
      expected: 'a Pack v2 envelope with unique asset GUIDs and valid descriptors',
      hint: 'validate the pack against packages/pack/schema/pack.schema.json and re-cook it',
      detail: { observed: 'invalid pack', expected: 'schemaVersion 2.0.0' },
    });
  }

  return ok(value);
}
