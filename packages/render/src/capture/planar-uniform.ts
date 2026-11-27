import { mat4 } from '@forgeax/engine-math';
import { computeViewProjectionMatrix } from '../record/helpers';
import { PLANAR_REFLECTION_UNIFORM_SIZE } from '../record/view-ubo';
import type { CameraSnapshot } from '../render-contract';

/**
 * The 28-float `PlanarReflectionUniform`: mirrored view-projection
 * (0..15), unit plane normal and distance (16..19), capture enabled (20),
 * normal distortion strength (21) and the capture's sampled mip level count
 * (22; 1 keeps the single-level mirror), and the distance/angle fade scale-bias
 * pairs (24..27). A missing capture writes zeros (disabled).
 */
export function encodePlanarReflectionUniform(
  reflected: CameraSnapshot | undefined,
  levels = 1,
): Float32Array {
  const planarUniform = new Float32Array(
    PLANAR_REFLECTION_UNIFORM_SIZE / Float32Array.BYTES_PER_ELEMENT,
  );
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
  planarUniform[22] = levels;
  const distanceScale = 1 / Math.max(config.distanceFadeEndM - config.distanceFadeStartM, 1e-5);
  const angleStart = Math.cos((config.angleFadeStartDegrees * Math.PI) / 180);
  const angleEnd = Math.cos((config.angleFadeEndDegrees * Math.PI) / 180);
  const angleScale = 1 / Math.max(angleStart - angleEnd, 1e-5);
  planarUniform[24] = distanceScale;
  planarUniform[25] = -config.distanceFadeStartM * distanceScale;
  planarUniform[26] = angleScale;
  planarUniform[27] = -angleEnd * angleScale;
  return planarUniform;
}
