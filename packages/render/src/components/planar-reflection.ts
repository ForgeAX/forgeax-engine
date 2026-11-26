import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';

/**
 * Reflection owned by this display Camera. Plane uses dot(normal, worldPosition) + distance = 0.
 *
 * `distortion` warps the reflection lookup by the receiving material's shading
 * normal (normal map, Surface ripples), as Unreal's PlanarReflection
 * NormalDistortionStrength (PlanarReflectionShared.ush ComputePlanarReflections):
 * the view ray reflects off the shading normal and the capture is sampled where
 * that ray meets a virtual sphere of radius `distortion` (world units) around the
 * pixel. The warp therefore scales with perspective and the tilt's real reflected
 * direction; a flat normal, or zero, keeps the undistorted mirror. Unreal's
 * default radius is 500 cm.
 *
 * Distance (metres from either side of the plane) and shading-normal angle
 * (degrees from the plane normal) attenuate the capture between their start and
 * end. Defaults follow Unreal's 60–100 cm and 20–30 degree intervals.
 * `captureCullMask` further restricts the display's visible layers for the mirror
 * view, for example to exclude a displaced receiver from its own capture.
 * `captureExtraFovDegrees` widens the vertical half-angle of a perspective
 * capture to preserve samples when distortion reaches beyond the main view.
 *
 * Without `target` (0) the Renderer owns the capture: a sampled 2D rgba16float
 * texture sized round(display drawing-buffer size * `resolutionScale`), at least
 * 1x1, recreated when either changes and released with this component. A game
 * `target` keeps its own size and format; `resolutionScale` is then ignored.
 *
 * `generateMipmaps` builds the capture's mip chain on the GPU after every update
 * (full chain for the engine-owned target; a game target's own `mipLevels`, so
 * only when it has more than one). Planar receivers then sample trilinearly at
 * lod = roughness * (levels - 1), blurring the mirror with roughness instead of
 * fading it out. Three.js reference: `reflector({ resolutionScale,
 * generateMipmaps })` with `textureBicubic(reflection, roughness)`.
 */
export const PlanarReflection = defineComponent('PlanarReflection', {
  target: { type: 'shared<RenderTarget>', simulationTransient: true },
  normal: { type: 'array<f32, 3>', default: new Float32Array([0, 1, 0]) },
  distance: { type: 'f32', default: 0 },
  clipBias: { type: 'f32', default: 0.001 },
  distortion: { type: 'f32', default: 0 },
  distanceFadeStartM: { type: 'f32', default: 0.6 },
  distanceFadeEndM: { type: 'f32', default: 1 },
  angleFadeStartDegrees: { type: 'f32', default: 20 },
  angleFadeEndDegrees: { type: 'f32', default: 30 },
  captureCullMask: { type: 'u32', default: 0xffffffff },
  captureExtraFovDegrees: { type: 'f32', default: 0 },
  resolutionScale: { type: 'f32', default: 1 },
  generateMipmaps: { type: 'bool', default: false },
  updateIntervalFrames: { type: 'u32', default: 1 },
  requestVersion: { type: 'u32', default: 0 },
});
export type PlanarReflectionData = ShapeOf<SchemaOf<typeof PlanarReflection>>;

export class PlanarReflectionInvalidError extends Error {
  readonly code = 'planar-reflection-invalid' as const;
  readonly expected =
    'a finite nonzero plane, nonnegative clip bias and distortion, ordered distance and angle fade ranges, finite positive resolution scale, positive update interval, and a distinct sampled 2D reflection target (or none, for an engine-owned one) on a display Camera';
  readonly hint = 'repair the PlanarReflection field and its output target before drawing again';
  readonly detail: { readonly field: string };
  constructor(field: string) {
    super(`Invalid planar reflection ${field}`);
    this.name = 'PlanarReflectionInvalidError';
    this.detail = { field };
  }
}
