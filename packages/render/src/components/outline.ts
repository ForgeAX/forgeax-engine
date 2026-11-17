import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { OutlineInvalidParameterError } from '../errors/render';

/** Camera-local selection. Entity handles refer to the camera's World. */
export const Outline = defineComponent('Outline', {
  entities: 'array<entity>',
  visibleColor: { type: 'array<f32, 3>', default: new Float32Array([1, 0.5, 0]) },
  hiddenColor: { type: 'array<f32, 3>', default: new Float32Array([0.15, 0.05, 0.02]) },
  width: { type: 'f32', default: 2 },
  occlusion: { type: 'u32', default: 0 },
  distanceField: { type: 'bool', default: false },
  accentColor: { type: 'array<f32, 3>', default: new Float32Array([1, 0.7, 0.26]) },
  coreIntensity: { type: 'f32', default: 0.8 },
  coreOpacity: { type: 'f32', default: 0.5 },
  glowRadius: { type: 'f32', default: 3 },
  glowStrength: { type: 'f32', default: 0.08 },
  accentIntensity: { type: 'f32', default: 1.9 },
  accentOpacity: { type: 'f32', default: 0.9 },
  accentWidth: { type: 'f32', default: 1.6 },
  accentGlowRadius: { type: 'f32', default: 9 },
  accentGlowStrength: { type: 'f32', default: 0.3 },
  accentBreathe: { type: 'f32', default: 0.3 },
  focusScale: { type: 'f32', default: 1.3 },
  focusBrightness: { type: 'f32', default: 1.2 },
  focusOpacity: { type: 'f32', default: 0.85 },
  largeScale: { type: 'f32', default: 2 },
  distanceNear: { type: 'f32', default: 15 },
  distanceFar: { type: 'f32', default: 80 },
  distanceMinScale: { type: 'f32', default: 0.35 },
  occlusionBias: { type: 'f32', default: 0.4 },
  focusedEntities: 'array<entity>',
  accentEntities: 'array<entity>',
  largeEntities: 'array<entity>',
  // World AABBs and fades, one six-float box per value, maximum sixteen.
  objectBounds: 'array<f32>',
  fadeBounds: 'array<f32>',
  fadeValues: 'array<f32>',
  time: { type: 'f32', default: 0 },
});
export const OutlineOcclusionValue = Object.freeze({ visible: 0, hidden: 1, all: 2 } as const);
export type OutlineData = ShapeOf<SchemaOf<typeof Outline>>;
export interface OutlineDistanceStyle {
  readonly accentColor: readonly number[];
  readonly coreIntensity: number;
  readonly coreOpacity: number;
  readonly glowRadius: number;
  readonly glowStrength: number;
  readonly accentIntensity: number;
  readonly accentOpacity: number;
  readonly accentWidth: number;
  readonly accentGlowRadius: number;
  readonly accentGlowStrength: number;
  readonly accentBreathe: number;
  readonly focusScale: number;
  readonly focusBrightness: number;
  readonly focusOpacity: number;
  readonly largeScale: number;
  readonly distanceNear: number;
  readonly distanceFar: number;
  readonly distanceMinScale: number;
  readonly occlusionBias: number;
}
export interface OutlineSnapshot {
  readonly distanceStyle?: OutlineDistanceStyle;
  readonly distanceField?: boolean;
  readonly focusedEntities?: readonly number[];
  readonly accentEntities?: readonly number[];
  readonly largeEntities?: readonly number[];
  readonly objectBounds?: readonly number[];
  readonly fadeBounds?: readonly number[];
  readonly fadeValues?: readonly number[];
  readonly time?: number;
  readonly entities: readonly number[];
  readonly visibleColor: readonly number[];
  readonly hiddenColor: readonly number[];
  readonly width: number;
  readonly occlusion: number;
}
export function resolveOutline(
  input: OutlineData | undefined,
): Result<OutlineSnapshot | undefined, OutlineInvalidParameterError> {
  if (input === undefined) return ok(undefined);
  if (
    !Number.isFinite(input.width) ||
    (!input.distanceField && !Number.isInteger(input.width)) ||
    input.width < 0 ||
    input.width > 8
  )
    return err(
      new OutlineInvalidParameterError('width', input.width, 'integer physical pixels in [0, 8]'),
    );
  if (![0, 1, 2].includes(input.occlusion))
    return err(
      new OutlineInvalidParameterError(
        'occlusion',
        input.occlusion,
        'OutlineOcclusionValue.visible, hidden or all',
      ),
    );
  for (const field of ['visibleColor', 'hiddenColor'] as const) {
    for (const value of input[field])
      if (!Number.isFinite(value) || value < 0 || value > 1)
        return err(new OutlineInvalidParameterError(field, value, 'linear RGB channels in [0, 1]'));
  }
  const styleError = validateDistanceStyle(input);
  if (styleError !== undefined) return err(styleError);
  if (input.width === 0 || input.entities.length === 0) return ok(undefined);
  const boundsError = validateDistanceBounds(input);
  if (boundsError !== undefined) return err(boundsError);
  return ok({
    ...(input.distanceField
      ? {
          distanceField: true,
          distanceStyle: {
            accentColor: Array.from(input.accentColor),
            coreIntensity: input.coreIntensity,
            coreOpacity: input.coreOpacity,
            glowRadius: input.glowRadius,
            glowStrength: input.glowStrength,
            accentIntensity: input.accentIntensity,
            accentOpacity: input.accentOpacity,
            accentWidth: input.accentWidth,
            accentGlowRadius: input.accentGlowRadius,
            accentGlowStrength: input.accentGlowStrength,
            accentBreathe: input.accentBreathe,
            focusScale: input.focusScale,
            focusBrightness: input.focusBrightness,
            focusOpacity: input.focusOpacity,
            largeScale: input.largeScale,
            distanceNear: input.distanceNear,
            distanceFar: input.distanceFar,
            distanceMinScale: input.distanceMinScale,
            occlusionBias: input.occlusionBias,
          },
          focusedEntities: Array.from(input.focusedEntities),
          accentEntities: Array.from(input.accentEntities),
          largeEntities: Array.from(input.largeEntities),
          objectBounds: Array.from(input.objectBounds),
          fadeBounds: Array.from(input.fadeBounds),
          fadeValues: Array.from(input.fadeValues),
          time: input.time,
        }
      : {}),
    entities: Array.from(new Set(input.entities)),
    visibleColor: Array.from(input.visibleColor),
    hiddenColor: Array.from(input.hiddenColor),
    width: input.width,
    occlusion: input.occlusion,
  });
}

function validateDistanceStyle(input: OutlineData): OutlineInvalidParameterError | undefined {
  if (!input.distanceField) return undefined;
  for (const key of [
    'coreIntensity',
    'coreOpacity',
    'glowRadius',
    'glowStrength',
    'accentIntensity',
    'accentOpacity',
    'accentWidth',
    'accentGlowRadius',
    'accentGlowStrength',
    'accentBreathe',
    'focusScale',
    'focusBrightness',
    'focusOpacity',
    'largeScale',
    'distanceNear',
    'distanceFar',
    'distanceMinScale',
    'occlusionBias',
  ] as const)
    if (!Number.isFinite(input[key]) || input[key] < 0)
      return new OutlineInvalidParameterError(
        key,
        input[key],
        'finite nonnegative distance-field settings',
      );
  if (
    input.distanceFar <= input.distanceNear ||
    input.distanceMinScale > 1 ||
    input.coreOpacity > 1 ||
    input.accentOpacity > 1 ||
    input.focusOpacity > 1 ||
    input.accentBreathe > 1 ||
    !Array.from(input.accentColor).every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    )
  )
    return new OutlineInvalidParameterError(
      'distanceField',
      1,
      'ordered distance range and normalized colors/opacities',
    );

  return undefined;
}

function validateDistanceBounds(input: OutlineData): OutlineInvalidParameterError | undefined {
  if (
    input.distanceField &&
    (input.objectBounds.length % 6 !== 0 ||
      !input.objectBounds.every(Number.isFinite) ||
      input.fadeValues.length > 16 ||
      input.fadeBounds.length !== input.fadeValues.length * 6 ||
      !input.fadeBounds.every(Number.isFinite) ||
      !input.fadeValues.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
      !Number.isFinite(input.time))
  )
    return new OutlineInvalidParameterError(
      'fadeBounds',
      input.fadeBounds.length,
      'up to sixteen finite world AABBs with matching fades in [0,1]',
    );
  if (input.distanceField) {
    for (const boxes of [input.objectBounds, input.fadeBounds])
      for (let i = 0; i < boxes.length; i += 6)
        for (let axis = 0; axis < 3; axis++) {
          const lower = boxes[i + axis],
            upper = boxes[i + axis + 3];
          if (lower === undefined || upper === undefined || lower > upper)
            return new OutlineInvalidParameterError('objectBounds', i, 'ordered world AABBs');
        }
    const sizeError = validateDistanceLimits(input);
    if (sizeError !== undefined) return sizeError;
  }
  return undefined;
}

function validateDistanceLimits(input: OutlineData): OutlineInvalidParameterError | undefined {
  if (
    input.accentWidth > 8 ||
    input.glowRadius > 32 ||
    input.accentGlowRadius > 32 ||
    input.focusScale < 1 ||
    input.focusScale > 2 ||
    input.largeScale < 1 ||
    input.largeScale > 3
  )
    return new OutlineInvalidParameterError(
      'distanceField',
      1,
      'width <=8, glow radius <=32, focus scale in [1,2], large scale in [1,3]',
    );
  return undefined;
}
