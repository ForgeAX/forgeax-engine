import type { BindGroupEntry, Buffer, TextureView } from '@forgeax/engine-rhi';
import {
  STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
  STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
} from '@forgeax/engine-shader';
import {
  getAdmittedParamSchemaInterface,
  type MaterialPass,
  type ParamSchemaEntry,
} from '@forgeax/engine-types';
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

/**
 * Planar receivers keep their authored Deferred pass so that, wherever no
 * PlanarReflection capture is published, they enter the G-buffer like any
 * other opaque Standard surface and receive screen-space reflections. A
 * world that publishes a capture this frame routes them forward only, where
 * the mirror projection is bound. The extract stage owns this per-world fact;
 * material preparation reads it and the snapshot caches key on it.
 */
const planarCaptureWorlds = new WeakSet<object>();

export function setPlanarCaptureDemand(world: object, demanded: boolean): void {
  if (demanded) planarCaptureWorlds.add(world);
  else planarCaptureWorlds.delete(world);
}

export function planarCaptureDemanded(world: object | undefined): boolean {
  return world !== undefined && planarCaptureWorlds.has(world);
}

function passLightMode(pass: MaterialPass): string {
  return String(
    (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
  );
}

/**
 * The passes a material contributes in `world` this frame. Returns `routed`
 * for a planar receiver (so caches can key on it) and the input array
 * otherwise.
 */
export function planarRoutedPasses(
  passes: readonly MaterialPass[],
  parameters: readonly { readonly name: string; readonly type: string }[] | undefined,
  world: object | undefined,
): { readonly passes: readonly MaterialPass[]; readonly routed: boolean | undefined } {
  if (!materialUsesPlanarReflection(parameters)) return { passes, routed: undefined };
  if (!planarCaptureDemanded(world)) return { passes, routed: false };
  return { passes: passes.filter((pass) => passLightMode(pass) !== 'Deferred'), routed: true };
}
