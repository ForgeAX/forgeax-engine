import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { BarrelDistortionInvalidParameterError } from '../errors/render';

/** Camera companion that applies the bounded first-order barrel model. */
export const BarrelDistortion = defineComponent('BarrelDistortion', {
  strength: { type: 'f32', default: 0 },
  centerX: { type: 'f32', default: 0.5 },
  centerY: { type: 'f32', default: 0.5 },
});

export type BarrelDistortionData = ShapeOf<SchemaOf<typeof BarrelDistortion>>;

const DEFAULT_BARREL_DISTORTION: BarrelDistortionData = Object.freeze({
  strength: 0,
  centerX: 0.5,
  centerY: 0.5,
});

function invalid(
  field: 'strength' | 'centerX' | 'centerY',
  value: number,
  expected: string,
): BarrelDistortionInvalidParameterError {
  return new BarrelDistortionInvalidParameterError({ field, value, expected });
}

/** Validate and detach camera-owned barrel authoring data. */
export function validateBarrelDistortionParameters(
  input: Partial<BarrelDistortionData> | undefined,
): Result<BarrelDistortionData, BarrelDistortionInvalidParameterError> {
  const value = input ?? {};
  const strength = value.strength ?? DEFAULT_BARREL_DISTORTION.strength;
  const centerX = value.centerX ?? DEFAULT_BARREL_DISTORTION.centerX;
  const centerY = value.centerY ?? DEFAULT_BARREL_DISTORTION.centerY;
  if (!Number.isFinite(strength) || strength < 0 || strength > 0.35) {
    return err(invalid('strength', strength, 'finite and in [0, 0.35]'));
  }
  if (!Number.isFinite(centerX) || centerX < 0 || centerX > 1) {
    return err(invalid('centerX', centerX, 'finite and in [0, 1]'));
  }
  if (!Number.isFinite(centerY) || centerY < 0 || centerY > 1) {
    return err(invalid('centerY', centerY, 'finite and in [0, 1]'));
  }
  return ok(Object.freeze({ strength, centerX, centerY }));
}
