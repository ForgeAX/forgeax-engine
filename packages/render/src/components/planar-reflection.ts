import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';

/** Reflection owned by this display Camera. Plane uses dot(normal, worldPosition) + distance = 0. */
export const PlanarReflection = defineComponent('PlanarReflection', {
  target: { type: 'shared<RenderTarget>', simulationTransient: true },
  normal: { type: 'array<f32, 3>', default: new Float32Array([0, 1, 0]) },
  distance: { type: 'f32', default: 0 },
  clipBias: { type: 'f32', default: 0.001 },
  updateIntervalFrames: { type: 'u32', default: 1 },
  requestVersion: { type: 'u32', default: 0 },
});
export type PlanarReflectionData = ShapeOf<SchemaOf<typeof PlanarReflection>>;

export class PlanarReflectionInvalidError extends Error {
  readonly code = 'planar-reflection-invalid' as const;
  readonly expected =
    'a finite nonzero plane, nonnegative clip bias, positive update interval, and a distinct sampled 2D reflection target on a display Camera';
  readonly hint = 'repair the PlanarReflection field and its output target before drawing again';
  readonly detail: { readonly field: string };
  constructor(field: string) {
    super(`Invalid planar reflection ${field}`);
    this.name = 'PlanarReflectionInvalidError';
    this.detail = { field };
  }
}
