import { mat4 } from '@forgeax/engine-math';
import { computeViewProjectionMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';

/**
 * The 24-float `StandardPlanarReflection` uniform: mirrored view-projection
 * (0..15), unit plane normal and distance (16..19), capture enabled (20) and
 * normal distortion strength (21). A missing capture writes zeros (disabled).
 */
export function encodePlanarReflectionUniform(reflected: CameraSnapshot | undefined): Float32Array {
  const planarUniform = new Float32Array(24);
  const config = reflected?.planarReflection;
  if (reflected === undefined || config === undefined) return planarUniform;
  planarUniform.set(computeViewProjectionMatrix(reflected, mat4.create()));
  const length = Math.hypot(...config.normal);
  planarUniform.set(
    [...config.normal].map((x) => x / length),
    16,
  );
  planarUniform[19] = config.distance / length;
  planarUniform[20] = 1;
  planarUniform[21] = config.distortion;
  return planarUniform;
}
