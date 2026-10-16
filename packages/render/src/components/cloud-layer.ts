import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';

/** Closed quality lane for the renderer-owned procedural cloud producer. */
export type CloudQuality = 'low' | 'medium' | 'high';

export const CloudQualityValue = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
} as const);

/**
 * A single World-authored cloud layer.
 *
 * The component contains only source facts. Cache resolution, optical step
 * counts, temporal history and GPU handles are derived by Render and never
 * written back into ECS.
 */
export const CloudLayer = defineComponent('CloudLayer', {
  /** Stable integer seed for the periodic 3D density field. */
  seed: { type: 'u32', default: 1337 },
  /** World-space lower edge of the layer, in metres. */
  baseHeight: { type: 'f32', default: 120 },
  /** World-space thickness of the layer, in metres. */
  thickness: { type: 'f32', default: 80 },
  /** Horizontal noise scale, in cycles per metre. */
  scale: { type: 'f32', default: 0.004 },
  /** Coverage threshold in [0, 1]. */
  coverage: { type: 'f32', default: 0.48 },
  /** Extinction multiplier in inverse metres. */
  density: { type: 'f32', default: 1 },
  /** World-space wind velocity in metres per second. */
  wind: { type: 'array<f32, 3>', default: new Float32Array([8, 0, 2]) },
  /** Quality controls cache resolution and bounded ray steps. */
  quality: { type: 'f32', default: CloudQualityValue.medium },
  /** Maximum world-space distance represented by the light-space shadow map. */
  shadowRange: { type: 'f32', default: 512 },
});

export type CloudLayerData = ShapeOf<SchemaOf<typeof CloudLayer>>;

export function cloudQualityFromF32(value: number): CloudQuality | undefined {
  if (value === CloudQualityValue.low) return 'low';
  if (value === CloudQualityValue.medium) return 'medium';
  if (value === CloudQualityValue.high) return 'high';
  return undefined;
}
