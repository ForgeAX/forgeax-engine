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
 */
export const PlanarReflection = defineComponent('PlanarReflection', {
  target: { type: 'shared<RenderTarget>', simulationTransient: true },
  normal: { type: 'array<f32, 3>', default: new Float32Array([0, 1, 0]) },
  distance: { type: 'f32', default: 0 },
  clipBias: { type: 'f32', default: 0.001 },
  distortion: { type: 'f32', default: 0 },
  updateIntervalFrames: { type: 'u32', default: 1 },
  requestVersion: { type: 'u32', default: 0 },
});
export type PlanarReflectionData = ShapeOf<SchemaOf<typeof PlanarReflection>>;

export class PlanarReflectionInvalidError extends Error {
  readonly code = 'planar-reflection-invalid' as const;
  readonly expected =
    'a finite nonzero plane, nonnegative clip bias, finite nonnegative distortion, positive update interval, and a distinct sampled 2D reflection target on a display Camera';
  readonly hint = 'repair the PlanarReflection field and its output target before drawing again';
  readonly detail: { readonly field: string };
  constructor(field: string) {
    super(`Invalid planar reflection ${field}`);
    this.name = 'PlanarReflectionInvalidError';
    this.detail = { field };
  }
}
