import type { BindGroupEntry, Buffer, TextureView } from '@forgeax/engine-rhi';
import {
  STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
  STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
} from '@forgeax/engine-shader';
import { getAdmittedParamSchemaInterface, type ParamSchemaEntry } from '@forgeax/engine-types';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  PLANAR_REFLECTION_DISABLED_UNIFORM_OFFSET,
  PLANAR_REFLECTION_UNIFORM_OFFSET,
  PLANAR_REFLECTION_UNIFORM_SIZE,
} from '../record/view-ubo';

/** The real u32 Standard parameter owns the optional PlanarReflection shader/resource contract. */
export function materialUsesPlanarReflection(
  schema: readonly { readonly name: string; readonly type: string }[] | undefined,
): boolean {
  if (schema === undefined) return false;
  const admitted = getAdmittedParamSchemaInterface(schema as readonly ParamSchemaEntry[]);
  if (admitted !== undefined) return admitted.parameterTypes.get('planarReflection') === 'u32';
  return schema.some((entry) => entry.name === 'planarReflection' && entry.type === 'u32');
}

export const PLANAR_REFLECTION_MATERIAL_LAYOUT_ENTRIES = [
  {
    binding: STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
  },
  {
    binding: STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    buffer: { type: 'uniform' as const, hasDynamicOffset: false },
  },
] as const;

/**
 * Bind the current capture with its projection, or any 2D view with the
 * never-written (disabled) projection slot. Captures and passes without a
 * current reflection take the second form, so no draw samples a target it writes.
 */
export function planarReflectionMaterialEntries(
  viewUniformBuffer: Buffer,
  capture: TextureView | undefined,
  fallback: TextureView,
): BindGroupEntry[] {
  return [
    {
      binding: STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
      resource: { kind: 'textureView', value: capture ?? fallback },
    },
    {
      binding: STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
      resource: {
        kind: 'buffer',
        value: {
          buffer: viewUniformBuffer,
          offset:
            capture === undefined
              ? PLANAR_REFLECTION_DISABLED_UNIFORM_OFFSET
              : PLANAR_REFLECTION_UNIFORM_OFFSET,
          size: PLANAR_REFLECTION_UNIFORM_SIZE,
        },
      },
    },
  ];
}
