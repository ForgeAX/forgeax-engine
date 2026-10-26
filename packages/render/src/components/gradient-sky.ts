import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Procedural gradient sky drawn as the camera background (no geometry to build).
 *
 * Above the horizon the sky blends `horizon` -> `zenith` by `pow(h, exponent)`, where
 * `h` is the view ray's elevation sine (the Three.js gradient-dome law). `exponent`
 * shapes how fast the colour leaves the horizon: 1 is linear in `h`, 0.5 is half-way at
 * `h` 0.25 (about 14 degrees), and below 0.3 the horizon colour collapses into a thin
 * line (0.13 is already 59 % zenith 1 degree up). With `midHeight > 0` the sky has three
 * stops: `horizon` -> `mid` over `h` in [0, midHeight], then `mid` -> `zenith` over
 * [midHeight, 1], each by `pow(t, exponent)` of its own span. A dusk blending orange
 * into violet needs that middle stop, because two complementary stops pass through grey
 * mauve. Below the horizon, `horizon` -> `ground`. The main `DirectionalLight` places a
 * sun or moon disc of angular radius `sunSize` with a `sunGlow` halo in its colour
 * toward `-direction`. With a `Fog`, the sky fades to the fog colour at and below the
 * horizon over `fogBlend` (sine of elevation).
 *
 * Colours are linear RGB, as Three's working colour space; convert a hex with
 * `color.linearRgb(0xRRGGBB)` from `@forgeax/engine/math` (Three's `Color.setHex`). `toneMapped: false` (default) is display-referred like
 * Three.js `scene.background`: the colour set is the colour shown, composited behind
 * the tone-mapped scene. `toneMapped: true` renders scene-referred radiance into the
 * HDR scene, so exposure, tone curve and bloom apply and reflections see it.
 * `GradientSkyPresets` holds tuned daylight, dusk, night and overcast skies.
 */
export const GradientSky = defineComponent(
  'GradientSky',
  {
    zenith: { type: 'array<f32, 3>', default: new Float32Array([0.12, 0.33, 0.75]) },
    horizon: { type: 'array<f32, 3>', default: new Float32Array([0.7, 0.8, 0.9]) },
    ground: { type: 'array<f32, 3>', default: new Float32Array([0.3, 0.3, 0.28]) },
    // Optional middle stop; midHeight 0 (default) keeps the two-stop law.
    mid: { type: 'array<f32, 3>' },
    midHeight: { type: 'f32', default: 0 },
    exponent: { type: 'f32', default: 0.6 },
    sunSize: { type: 'f32', default: 0.04 },
    sunGlow: { type: 'f32', default: 0.5 },
    fogBlend: { type: 'f32', default: 0.15 },
    toneMapped: { type: 'bool', default: false },
  },
  {
    meta: {
      quickStart:
        'One GradientSky per World replaces the clear colour: world.spawn({ component: GradientSky, data: GradientSkyPresets.dusk }) or your own { zenith, horizon, ground }. Like Three.js scene.background the colours show as set; the sun disc follows the DirectionalLight.',
      diagnostics:
        'An invalid GradientSky, a second one, or one beside Atmosphere / SkyboxBackground reports environment-selection-invalid naming the field.',
      recovery:
        'Use finite linear colour channels >= 0 (display-referred skies clamp to 1), exponent in [0.001, 64] (keep it >= 0.3 or the horizon colour becomes a thin line), midHeight in [0, 0.95] (0 = no mid stop), sunSize in [0, 0.5] radians (0 hides the disc), sunGlow in [0, 16], fogBlend in [0, 1].',
      boundaries:
        'Background only: it does not light the scene (set Skylight color / groundColor to match). Display-referred skies are not seen by reflections or transmission; use toneMapped: true for those.',
    },
  },
);

type Rgb = readonly [number, number, number];

/** Spawn data for one tuned GradientSky look. */
export interface GradientSkyPreset {
  readonly zenith: Rgb;
  readonly horizon: Rgb;
  readonly ground: Rgb;
  readonly mid?: Rgb;
  readonly midHeight?: number;
  readonly exponent?: number;
  readonly sunSize?: number;
  readonly sunGlow?: number;
}

/**
 * Tuned display-referred skies: spawn `{ component: GradientSky, data: GradientSkyPresets.dusk }`
 * and spread over it to adjust one field. Dusk is three stops, orange horizon (#fc9f5f)
 * -> rose mauve 15 degrees up -> violet zenith (#613895), with a wide warm sun glow;
 * pair it with a low warm DirectionalLight and a warm, bright Fog (`[1.2, 0.35, 0.12]`
 * under ACES shows as the horizon orange), never a dull or grey one.
 */
export const GradientSkyPresets = {
  daylight: {
    zenith: [0.2, 0.45, 0.85],
    horizon: [0.75, 0.85, 0.95],
    ground: [0.79, 0.83, 0.75],
  },
  dusk: {
    zenith: [0.12, 0.04, 0.3],
    horizon: [1, 0.36, 0.1],
    ground: [0.1, 0.07, 0.07],
    mid: [0.62, 0.16, 0.3],
    midHeight: 0.25,
    exponent: 1,
    sunSize: 0.05,
    sunGlow: 1,
  },
  night: {
    zenith: [0.005, 0.008, 0.025],
    horizon: [0.025, 0.035, 0.075],
    ground: [0.01, 0.012, 0.02],
    sunSize: 0.025,
    sunGlow: 0.25,
  },
  overcast: {
    zenith: [0.5, 0.53, 0.57],
    horizon: [0.74, 0.76, 0.78],
    ground: [0.4, 0.41, 0.39],
    sunSize: 0,
  },
} as const satisfies Record<'daylight' | 'dusk' | 'night' | 'overcast', GradientSkyPreset>;
