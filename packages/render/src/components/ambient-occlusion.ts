import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { ok, type Result } from '@forgeax/engine-types';
import type { PostProcessError } from '../post-process-errors';
import { resolveSsaoParameters, type SsaoParameterConfig } from '../ssao-config';

export const AMBIENT_OCCLUSION_QUALITY_LOW = 25;
export const AMBIENT_OCCLUSION_QUALITY_MEDIUM = 50;
export const AMBIENT_OCCLUSION_QUALITY_HIGH = 100;
export const AMBIENT_OCCLUSION_INHERIT = -1;

/** An absent override inherits the project; zero is an authored numeric value. */
export const AmbientOcclusion = defineComponent('AmbientOcclusion', {
  enabled: { type: 'bool', default: true },
  radius: { type: 'f32', default: AMBIENT_OCCLUSION_INHERIT },
  bias: { type: 'f32', default: AMBIENT_OCCLUSION_INHERIT },
  intensity: { type: 'f32', default: AMBIENT_OCCLUSION_INHERIT },
  power: { type: 'f32', default: AMBIENT_OCCLUSION_INHERIT },
  fadeDistance: { type: 'f32', default: AMBIENT_OCCLUSION_INHERIT },
  fadeRadius: { type: 'f32', default: AMBIENT_OCCLUSION_INHERIT },
  quality: { type: 'f32', default: AMBIENT_OCCLUSION_INHERIT },
});

export type AmbientOcclusionData = ShapeOf<SchemaOf<typeof AmbientOcclusion>>;
const AMBIENT_OCCLUSION_CAMERA_FIELDS = [
  'radius',
  'bias',
  'intensity',
  'power',
  'fadeDistance',
  'fadeRadius',
  'quality',
] as const;

export function ambientOcclusionParameters(
  data: AmbientOcclusionData,
): Result<Omit<SsaoParameterConfig, 'method'>, PostProcessError> {
  const config: Omit<SsaoParameterConfig, 'method'> = Object.fromEntries(
    AMBIENT_OCCLUSION_CAMERA_FIELDS.flatMap((field) =>
      data[field] === AMBIENT_OCCLUSION_INHERIT ? [] : [[field, data[field]]],
    ),
  );
  const resolved = resolveSsaoParameters(config);
  return resolved.ok ? ok(config) : resolved;
}
