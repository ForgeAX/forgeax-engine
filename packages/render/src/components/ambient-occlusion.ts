// @forgeax/engine-render - AmbientOcclusion authoring component.
//
// An opt-in camera companion. Its presence asks the renderer to run the
// Standard deferred lane with screen-space AO for this camera; parameter
// validation and graph/resource ownership stay renderer-side.

import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { PostProcessError } from '../post-process-errors';
import {
  resolveSsaoParameters,
  SSAO_DEFAULT_BIAS,
  SSAO_DEFAULT_INTENSITY,
  SSAO_DEFAULT_RADIUS,
  type SsaoParameterConfig,
} from '../ssao-config';

/** Closed f32 encodings for `AmbientOcclusion.algorithm`. */
export const AMBIENT_OCCLUSION_ALGORITHMS = ['ssao', 'gtao'] as const;
/** Closed f32 encodings for `AmbientOcclusion.quality`. */
export const AMBIENT_OCCLUSION_QUALITIES = ['low', 'medium', 'high'] as const;

export const AMBIENT_OCCLUSION_SSAO = AMBIENT_OCCLUSION_ALGORITHMS.indexOf('ssao');
export const AMBIENT_OCCLUSION_GTAO = AMBIENT_OCCLUSION_ALGORITHMS.indexOf('gtao');

export const AmbientOcclusion = defineComponent('AmbientOcclusion', {
  algorithm: { type: 'f32', default: AMBIENT_OCCLUSION_GTAO },
  radius: { type: 'f32', default: SSAO_DEFAULT_RADIUS },
  bias: { type: 'f32', default: SSAO_DEFAULT_BIAS },
  intensity: { type: 'f32', default: SSAO_DEFAULT_INTENSITY },
  directLightingStrength: { type: 'f32', default: 0 },
  quality: { type: 'f32', default: AMBIENT_OCCLUSION_QUALITIES.indexOf('high') },
});

export type AmbientOcclusionData = ShapeOf<SchemaOf<typeof AmbientOcclusion>>;

/**
 * Project component data into the renderer AO parameter vocabulary. Enum
 * values outside the closed tables and invalid numeric parameters return the
 * same structured PostProcessError the profile route reports.
 */
export function ambientOcclusionParameters(
  data: AmbientOcclusionData,
): Result<SsaoParameterConfig, PostProcessError> {
  const algorithm = AMBIENT_OCCLUSION_ALGORITHMS[data.algorithm];
  if (algorithm === undefined) {
    return err(
      new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName: 'algorithm', value: data.algorithm },
      }),
    );
  }
  const quality = AMBIENT_OCCLUSION_QUALITIES[data.quality];
  if (quality === undefined) {
    return err(
      new PostProcessError({
        code: 'ssao-parameter-invalid',
        detail: { paramName: 'quality', value: data.quality },
      }),
    );
  }
  const config: SsaoParameterConfig = {
    algorithm,
    radius: data.radius,
    bias: data.bias,
    intensity: data.intensity,
    directLightingStrength: data.directLightingStrength,
    quality,
  };
  const resolved = resolveSsaoParameters(config);
  return resolved.ok ? ok(config) : resolved;
}
