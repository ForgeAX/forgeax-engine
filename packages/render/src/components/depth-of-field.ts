import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';

/** Closed quality budget used by the built-in camera depth-of-field pass. */
export type DepthOfFieldQuality = 'low' | 'medium' | 'high';

export const DepthOfFieldQualityValue = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
} as const);

/** Selects which signed circle-of-confusion side contributes to the image. */
export type DepthOfFieldSide = 'both' | 'near' | 'far';

export const DepthOfFieldSideValue = Object.freeze({
  both: 0,
  near: 1,
  far: 2,
} as const);

/** Active-camera physical depth-of-field authoring data; presence enables it. */
export const DepthOfField = defineComponent('DepthOfField', {
  focusDistance: { type: 'f32', default: 8 },
  fStop: { type: 'f32', default: 2.8 },
  sensorHeight: { type: 'f32', default: 0.024 },
  maxRadiusPixels: { type: 'f32', default: 16 },
  quality: { type: 'f32', default: DepthOfFieldQualityValue.medium },
  blurSide: { type: 'f32', default: DepthOfFieldSideValue.both },
});

export type DepthOfFieldData = ShapeOf<SchemaOf<typeof DepthOfField>>;

export function depthOfFieldQualityFromF32(value: number): DepthOfFieldQuality | undefined {
  if (value === DepthOfFieldQualityValue.low) return 'low';
  if (value === DepthOfFieldQualityValue.medium) return 'medium';
  if (value === DepthOfFieldQualityValue.high) return 'high';
  return undefined;
}

export function depthOfFieldSideFromF32(value: number): DepthOfFieldSide | undefined {
  if (value === DepthOfFieldSideValue.both) return 'both';
  if (value === DepthOfFieldSideValue.near) return 'near';
  if (value === DepthOfFieldSideValue.far) return 'far';
  return undefined;
}
