import { ok, type Result } from '@forgeax/engine-types';
import type { StandardDiffuseGi, StandardLiteReflections } from '../pipeline/standard-profile';
import { type RayReferenceError, rayReferenceFailure } from './scene';

/** UE r.Lumen.Reflections.MaxRoughnessToTrace (Scene.cpp) and RoughnessFadeLength. */
export const DEFAULT_LITE_REFLECTIONS: StandardLiteReflections = Object.freeze({
  maxRoughnessToTrace: 0.4,
  roughnessFadeLength: 0.1,
});

/** Every gather admits reflections: 'exact' traces dedicated world rays; the field
 * lanes trace the Global SDF/Card scene and fall back to the directional radiance cache. */
export function validateLiteReflections(gi: StandardDiffuseGi): Result<void, RayReferenceError> {
  const value: unknown = gi.gather === 'baked' ? undefined : gi.reflections;
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return rayReferenceFailure('Lite reflections require one configuration object');
  const reflections = value as Record<string, unknown>;
  const { maxRoughnessToTrace: limit, roughnessFadeLength: fade } = reflections;
  if (
    Object.keys(reflections).some(
      (key) => key !== 'maxRoughnessToTrace' && key !== 'roughnessFadeLength',
    ) ||
    typeof limit !== 'number' ||
    typeof fade !== 'number' ||
    !(limit >= 0 && limit <= 1) ||
    !(fade > 0 && fade <= 1)
  )
    return rayReferenceFailure(
      'Lite reflections require maxRoughnessToTrace in [0, 1] and roughnessFadeLength in (0, 1]',
    );
  return ok(undefined);
}

export function freezeLiteReflections(
  reflections: StandardLiteReflections,
): StandardLiteReflections {
  return Object.freeze({
    maxRoughnessToTrace: reflections.maxRoughnessToTrace,
    roughnessFadeLength: reflections.roughnessFadeLength,
  });
}
