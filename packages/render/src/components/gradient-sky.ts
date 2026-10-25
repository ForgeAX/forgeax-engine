import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Procedural gradient sky drawn as the camera background (no geometry to build).
 *
 * Above the horizon the sky blends `horizon` -> `zenith` by `pow(elevation, exponent)`
 * (the Three.js gradient-dome law); below it, `horizon` -> `ground`. The main
 * `DirectionalLight` places a sun or moon disc of angular radius `sunSize` with a
 * `sunGlow` halo in its colour toward `-direction`. With a `Fog`, the sky fades to the
 * fog colour at and below the horizon over `fogBlend` (sine of elevation).
 *
 * Colours are linear RGB. `toneMapped: false` (default) is display-referred like
 * Three.js `scene.background`: the colour set is the colour shown, composited behind
 * the tone-mapped scene. `toneMapped: true` renders scene-referred radiance into the
 * HDR scene, so exposure, tone curve and bloom apply and reflections see it.
 */
export const GradientSky = defineComponent(
  'GradientSky',
  {
    zenith: { type: 'array<f32, 3>', default: new Float32Array([0.12, 0.33, 0.75]) },
    horizon: { type: 'array<f32, 3>', default: new Float32Array([0.7, 0.8, 0.9]) },
    ground: { type: 'array<f32, 3>', default: new Float32Array([0.3, 0.3, 0.28]) },
    exponent: { type: 'f32', default: 0.6 },
    sunSize: { type: 'f32', default: 0.04 },
    sunGlow: { type: 'f32', default: 0.5 },
    fogBlend: { type: 'f32', default: 0.15 },
    toneMapped: { type: 'bool', default: false },
  },
  {
    meta: {
      quickStart:
        'One GradientSky per World replaces the clear colour: world.spawn({ component: GradientSky, data: { zenith, horizon, ground } }). Like Three.js scene.background the colours show as set; the sun disc follows the DirectionalLight.',
      diagnostics:
        'An invalid GradientSky, a second one, or one beside Atmosphere / SkyboxBackground reports environment-selection-invalid naming the field.',
      recovery:
        'Use finite linear colour channels >= 0 (display-referred skies clamp to 1), exponent in [0.001, 64], sunSize in [0, 0.5] radians (0 hides the disc), sunGlow in [0, 16], fogBlend in [0, 1].',
      boundaries:
        'Background only: it does not light the scene (set Skylight color / groundColor to match). Display-referred skies are not seen by reflections or transmission; use toneMapped: true for those.',
    },
  },
);
