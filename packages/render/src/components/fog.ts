import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Distance law of the analytic `Fog`.
 * - `exp` (default): `maxOpacity * (1 - exp(-opticalDepth))` along the camera
 *   ray, with optional `heightFalloff` density.
 * - `exp2`: Three.js `FogExp2`, `maxOpacity * (1 - exp(-(density * depth)^2))`.
 * - `linear`: Three.js `Fog(color, near, far)`,
 *   `maxOpacity * smoothstep(near, far, depth)`; nothing nearer than `near` is fogged.
 * `exp2` and `linear` use camera view depth, as Three.js does.
 */
export type FogMode = keyof typeof FogModeValue;

/** Numeric labels stored by the public Fog mode enum field. */
export const FogModeValue = Object.freeze({
  exp: 0,
  exp2: 1,
  linear: 2,
} as const);

/** Decode the Fog mode column without treating an unknown value as valid. */
export function fogModeFromU32(value: number): FogMode | undefined {
  switch (value) {
    case FogModeValue.exp:
      return 'exp';
    case FogModeValue.exp2:
      return 'exp2';
    case FogModeValue.linear:
      return 'linear';
    default:
      return undefined;
  }
}

/** Optional height-aware aerial fog, independent from environment source. */
export const Fog = defineComponent(
  'Fog',
  {
    /**
     * Fog light added to the scattered light, scene-linear. Black by default, as
     * Unreal's height fog: under an Atmosphere the sky and sun already light the
     * fog, so a bright color here whitens the horizon. Without an Atmosphere it is
     * the whole fog color; set it as for Three.js `Fog(color)`.
     */
    color: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
    density: { type: 'f32', default: 0.01 },
    heightFalloff: { type: 'f32', default: 0 },
    maxOpacity: { type: 'f32', default: 1 },
    mode: { type: 'enum', default: FogModeValue.exp, labels: FogModeValue },
    near: { type: 'f32', default: 0 },
    far: { type: 'f32', default: 100 },
    /**
     * Scale of the fog opacity on background pixels under an Atmosphere, in
     * [0, 1]: 1 is the physical distant fog over the sky, 0 leaves the sky
     * unfogged. Surfaces are unaffected; without an Atmosphere it has no effect.
     */
    skyOpacity: { type: 'f32', default: 1 },
  },
  {
    meta: {
      quickStart:
        'One Fog per World. Three.js Fog(color, near, far) is mode FogModeValue.linear with near/far; FogExp2(color, density) is mode FogModeValue.exp2 with the same density.',
      diagnostics:
        'An invalid Fog keeps the last valid fog frame and reports environment-selection-invalid naming the field.',
      recovery:
        'Use finite color channels >= 0 (scene-linear, HDR allowed), density >= 0, maxOpacity and skyOpacity in [0, 1]; linear needs 0 <= near < far; heightFalloff applies to exp only.',
      boundaries:
        'Without Atmosphere, Fog tints rendered surfaces and leaves the authored background unfogged. With Atmosphere, Fog also covers the sky as distant fog at the atmosphere boundary, so dense fog greys the sky; the fog source is color (default black, as in Unreal) plus the atmosphere distant sky light and in-scattered sunlight. skyOpacity scales that sky fog (1 physical, 0 sky unfogged) and has no effect without Atmosphere. VolumetricFog owns local lit media.',
    },
  },
);
