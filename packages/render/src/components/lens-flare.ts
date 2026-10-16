import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { LensFlareInvalidParameterError } from '../errors/render';

export const LENS_FLARE_GHOST_COUNT = 8;

// Unreal Engine's default flare tints. Its alpha a places a ghost at viewport
// scale (7a - 3.5) * 2 over a guard band of 2, so a source at screen offset X
// images at X * (7a - 3.5).
const DEFAULT_GHOST_TINTS = new Float32Array([
  1, 0.8, 0.4, 1, 1, 0.6, 0.8, 0.8, 1, 0.5, 1, 0.4, 0.5, 0.8, 1, 0.9, 1, 0.8, 1, 0.8, 0.4, 0.9, 0.7,
  0.7,
]);
const DEFAULT_GHOST_SCALES = new Float32Array(
  [0.6, 0.53, 0.46, 0.39, 0.31, 0.27, 0.22, 0.15].map((alpha) => alpha * 7 - 3.5),
);

/**
 * Image-based camera lens flare. Bright HDR pixels are blurred by a disc
 * bokeh and re-imaged as ghosts mirrored through the screen center.
 */
export const LensFlare = defineComponent('LensFlare', {
  intensity: { type: 'f32', default: 1 },
  /** Linear HDR `r + g + b` where a pixel starts to contribute. */
  threshold: { type: 'f32', default: 8 },
  /** Bokeh diameter as a percentage of twice the view width (Unreal's guard band). */
  bokehSize: { type: 'f32', default: 3 },
  tint: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  /** Linear RGB per ghost, eight triples. */
  ghostTints: { type: 'array<f32, 24>', default: DEFAULT_GHOST_TINTS },
  /**
   * Signed image scale per ghost: a source at screen offset X appears at
   * `scale * X`. Negative scales mirror through the center; 0 disables it.
   */
  ghostScales: { type: 'array<f32, 8>', default: DEFAULT_GHOST_SCALES },
});
export type LensFlareData = ShapeOf<SchemaOf<typeof LensFlare>>;
export interface LensFlareSnapshot {
  readonly intensity: number;
  readonly threshold: number;
  readonly bokehSize: number;
  readonly tint: readonly number[];
  readonly ghostTints: readonly number[];
  readonly ghostScales: readonly number[];
}

/** Validate before graph admission; zero intensity or no live ghost has no work. */
export function resolveLensFlare(
  input: LensFlareData | undefined,
): Result<LensFlareSnapshot | undefined, LensFlareInvalidParameterError> {
  if (input === undefined) return ok(undefined);
  for (const [field, minimum, maximum] of [
    ['intensity', 0, 64],
    ['threshold', 0, 65504],
    ['bokehSize', 0.1, 10],
  ] as const) {
    const value = input[field];
    if (!Number.isFinite(value) || value < minimum || value > maximum)
      return err(new LensFlareInvalidParameterError(field, value, minimum, maximum));
  }
  for (const [field, minimum, maximum] of [
    ['tint', 0, 64],
    ['ghostTints', 0, 64],
    ['ghostScales', -8, 8],
  ] as const) {
    for (const value of input[field])
      if (!Number.isFinite(value) || value < minimum || value > maximum)
        return err(new LensFlareInvalidParameterError(field, value, minimum, maximum));
  }
  const ghostTints = Array.from(input.ghostTints);
  const ghostScales = Array.from(input.ghostScales);
  const live = ghostScales.some(
    (scale, ghost) =>
      scale !== 0 &&
      (ghostTints[ghost * 3] ?? 0) +
        (ghostTints[ghost * 3 + 1] ?? 0) +
        (ghostTints[ghost * 3 + 2] ?? 0) >
        0,
  );
  const tint = Array.from(input.tint);
  if (input.intensity === 0 || !live || tint.every((value) => value === 0)) return ok(undefined);
  return ok({
    intensity: input.intensity,
    threshold: input.threshold,
    bokehSize: input.bokehSize,
    tint,
    ghostTints,
    ghostScales,
  });
}
