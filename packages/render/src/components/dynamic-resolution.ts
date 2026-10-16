import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type DynamicResolutionError,
  DynamicResolutionInvalidParameterError,
  DynamicResolutionRequiresTaaError,
} from '../errors/render';
import type { Antialias } from './camera';

/** Optional Camera companion that enables fixed or adaptive internal scaling. */
export const DynamicResolution = defineComponent('DynamicResolution', {
  targetGpuMs: { type: 'f32', default: 16.67 },
  minScale: { type: 'f32', default: 0.67 },
  maxScale: { type: 'f32', default: 1.0 },
});

export type DynamicResolutionData = ShapeOf<SchemaOf<typeof DynamicResolution>>;

const DEFAULT_DYNAMIC_RESOLUTION: DynamicResolutionData = Object.freeze({
  targetGpuMs: 16.67,
  minScale: 0.67,
  maxScale: 1,
});

function invalid(
  field: 'targetGpuMs' | 'minScale' | 'maxScale',
  value: number,
  expected: string,
): DynamicResolutionInvalidParameterError {
  return new DynamicResolutionInvalidParameterError({ field, value, expected });
}

/** Validate one detached DynamicResolution authoring POD before graph work. */
export function validateDynamicResolutionParameters(
  input: Partial<DynamicResolutionData> | undefined,
): Result<DynamicResolutionData, DynamicResolutionInvalidParameterError> {
  const value = input ?? {};
  const targetGpuMs = value.targetGpuMs ?? DEFAULT_DYNAMIC_RESOLUTION.targetGpuMs;
  const minScale = value.minScale ?? DEFAULT_DYNAMIC_RESOLUTION.minScale;
  const maxScale = value.maxScale ?? DEFAULT_DYNAMIC_RESOLUTION.maxScale;
  if (!Number.isFinite(targetGpuMs) || targetGpuMs <= 0) {
    return err(invalid('targetGpuMs', targetGpuMs, 'finite and greater than 0'));
  }
  if (!Number.isFinite(minScale) || minScale < 0.5 || minScale > 1) {
    return err(invalid('minScale', minScale, 'finite and in [0.5, 1.0]'));
  }
  if (!Number.isFinite(maxScale) || maxScale < 0.5 || maxScale > 1) {
    return err(invalid('maxScale', maxScale, 'finite and in [0.5, 1.0]'));
  }
  if (minScale > maxScale) {
    return err(invalid('minScale', minScale, 'less than or equal to maxScale'));
  }
  return ok(Object.freeze({ targetGpuMs, minScale, maxScale }));
}

/** Validate the Camera companion relationship at the extraction boundary. */
export function validateDynamicResolutionCamera(
  input: Partial<DynamicResolutionData> | undefined,
  antialias: Antialias,
): Result<DynamicResolutionData | undefined, DynamicResolutionError> {
  if (input === undefined) return ok(undefined);
  const parameters = validateDynamicResolutionParameters(input);
  if (!parameters.ok) return parameters;
  if (antialias !== 'taa') {
    return err(new DynamicResolutionRequiresTaaError({ antialias }));
  }
  return parameters;
}
