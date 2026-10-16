import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { LensEffectsInvalidParameterError } from '../errors/render';

/** Independent camera effects combined into one output-resolution pass. */
export const LensEffects = defineComponent('LensEffects', {
  vignetteIntensity: { type: 'f32', default: 0 },
  vignetteRadius: { type: 'f32', default: 0.5 },
  vignetteSoftness: { type: 'f32', default: 0.5 },
  vignetteColor: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
  chromaticAberration: { type: 'f32', default: 0 },
  chromaticAberrationAngle: { type: 'f32', default: 0 },
  grainIntensity: { type: 'f32', default: 0 },
  grainSize: { type: 'f32', default: 1 },
});
export type LensEffectsData = ShapeOf<SchemaOf<typeof LensEffects>>;
export type LensEffectsSnapshot = Omit<LensEffectsData, 'vignetteColor'> & {
  readonly vignetteColor: readonly number[];
};

/** Validate before graph admission; omitted and all-zero effects have no work. */
export function resolveLensEffects(
  input: LensEffectsData | undefined,
): Result<LensEffectsSnapshot | undefined, LensEffectsInvalidParameterError> {
  if (input === undefined) return ok(undefined);
  for (const [field, minimum, maximum] of [
    ['vignetteIntensity', 0, 1],
    ['vignetteRadius', 0, 1],
    ['vignetteSoftness', 0.001, 1],
    ['chromaticAberration', 0, 32],
    ['chromaticAberrationAngle', -Math.fround(Math.PI), Math.fround(Math.PI)],
    ['grainIntensity', 0, 1],
    ['grainSize', 1, 8],
  ] as const) {
    const value = input[field];
    if (!Number.isFinite(value) || value < minimum || value > maximum)
      return err(new LensEffectsInvalidParameterError(field, value, minimum, maximum));
  }
  for (const value of input.vignetteColor)
    if (!Number.isFinite(value) || value < 0 || value > 1)
      return err(new LensEffectsInvalidParameterError('vignetteColor', value, 0, 1));
  if (
    input.vignetteIntensity === 0 &&
    input.chromaticAberration === 0 &&
    input.grainIntensity === 0
  )
    return ok(undefined);
  return ok({ ...input, vignetteColor: Array.from(input.vignetteColor) });
}
