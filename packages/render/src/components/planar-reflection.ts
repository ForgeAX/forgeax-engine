import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';

/**
 * Reflection owned by this display Camera. Plane uses dot(normal, worldPosition) + distance = 0.
 *
 * `distortion` warps the reflection lookup by the receiving material's shading
 * normal (normal map, Surface ripples): the screen-UV offset is the normal's tilt
 * away from the plane (sine of the tilt angle) times `distortion`. Zero keeps the
 * undistorted mirror. Three.js reference: `screenUV.add(normal.xy.mul(normalWarp))`
 * in the webgpu_reflection_roughness example; Unreal: PlanarReflection
 * NormalDistortionStrength.
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
  resolutionScale: { type: 'f32', default: 1 },
  generateMipmaps: { type: 'bool', default: false },
  updateIntervalFrames: { type: 'u32', default: 1 },
  requestVersion: { type: 'u32', default: 0 },
});
export type PlanarReflectionData = ShapeOf<SchemaOf<typeof PlanarReflection>>;

export class PlanarReflectionInvalidError extends Error {
  readonly code = 'planar-reflection-invalid' as const;
  readonly expected =
    'a finite nonzero plane, nonnegative clip bias, finite nonnegative distortion, finite positive resolution scale, positive update interval, and a distinct sampled 2D reflection target (or none, for an engine-owned one) on a display Camera';
  readonly hint = 'repair the PlanarReflection field and its output target before drawing again';
  readonly detail: { readonly field: string };
  constructor(field: string) {
    super(`Invalid planar reflection ${field}`);
    this.name = 'PlanarReflectionInvalidError';
    this.detail = { field };
  }
}
