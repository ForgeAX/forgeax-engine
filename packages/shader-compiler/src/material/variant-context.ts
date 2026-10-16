import {
  type MaterialCookRasterContext,
  validateMaterialCookProgramContext,
} from '@forgeax/engine-pack/material-cook';
import { err, ok, type Result } from '@forgeax/engine-types';

export type MaterialBackend = MaterialCookRasterContext['backend'];
export type MaterialCapability = MaterialCookRasterContext['capability'];
export type MaterialPipeline = MaterialCookRasterContext['pipeline'];
export type MaterialGeometry = MaterialCookRasterContext['geometry'];
export type MaterialPass = MaterialCookRasterContext['pass'];
export type MaterialInstrumentation = MaterialCookRasterContext['instrumentation'];
export type MaterialVariantContextInput = MaterialCookRasterContext;
export type MaterialVariantContext = MaterialCookRasterContext;

export const DEFAULT_MATERIAL_VARIANT_CONTEXT: MaterialVariantContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};

export interface MaterialVariantContextError {
  readonly code: 'material-variant-context-invalid' | 'material-variant-axis-reserved';
  readonly field: string;
  readonly expected: string;
  readonly actual: unknown;
  readonly action: 'use-domain-owner-field' | 'remove-material-override';
}

const RESERVED_AXES = new Set([
  'STORAGE_BUFFER_AVAILABLE',
  'ATMOSPHERE_AVAILABLE',
  'WEBGL2_COMPAT',
  'CLUSTER_FORWARD_AVAILABLE',
  'EXTENDED_LIGHTING_AVAILABLE',
  'PROBE_BLEND_AVAILABLE',
  'PROJECTOR_AVAILABLE',
  'CLOUD_SHADOW_LOW_LIMIT',
  'POINT_SHADOW_AVAILABLE',
  'PER_INSTANCE_REGION',
  'VISIBLE_SURFACE_AVAILABLE',
  'TERRAIN_GEOMETRY_AVAILABLE',
]);

function invalid(field: string, actual: unknown): Result<never, MaterialVariantContextError> {
  return err({
    code: 'material-variant-context-invalid',
    field,
    expected: 'a closed MaterialVariantContext field',
    actual,
    action: 'use-domain-owner-field',
  });
}

export function createMaterialVariantContext(
  value: unknown,
): Result<MaterialVariantContext, MaterialVariantContextError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('context', value);
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (RESERVED_AXES.has(field)) {
      return err({
        code: 'material-variant-axis-reserved',
        field,
        expected: 'the corresponding domain-owned context field',
        actual: record[field],
        action: 'remove-material-override',
      });
    }
  }
  const validated = validateMaterialCookProgramContext(value);
  if (!validated.ok) {
    return invalid(
      validated.error.detail.field.replace(/^context\./, ''),
      validated.error.detail.actual,
    );
  }
  if (validated.value.pipeline === 'ray') return invalid('pipeline', 'ray');
  return ok(validated.value);
}

/**
 * Lower a validated domain snapshot to the compiler's private boolean selectors.
 * Material callers cannot provide or merge this map themselves.
 */
export function lowerMaterialVariantContext(
  context: MaterialVariantContext,
): Readonly<Record<string, boolean>> {
  return Object.freeze({
    STORAGE_BUFFER_AVAILABLE: context.capability !== 'uniform-fallback',
    // Standard local lights use the same membership and records through storage
    // buffers or an integer texture, including WebGL2 and uniform fallback.
    CLUSTER_FORWARD_AVAILABLE: true,
    PROBE_BLEND_AVAILABLE: context.capability !== 'uniform-fallback',
    // Cooked Standard writers consume the same storage-capable lighting
    // domain as builtin writers, including rect lights and projector cookies.
    EXTENDED_LIGHTING_AVAILABLE:
      context.capability === 'storage-buffer' || context.capability === 'storage-buffer-atmosphere',
    PROJECTOR_AVAILABLE:
      context.capability !== 'uniform-fallback' && context.capability !== 'storage-buffer-minimum',
    ...(['uniform-fallback', 'storage-buffer-minimum'].includes(context.capability)
      ? { CLOUD_SHADOW_LOW_LIMIT: true }
      : {}),
    ATMOSPHERE_AVAILABLE: context.capability === 'storage-buffer-atmosphere',
    WEBGL2_COMPAT: context.backend === 'webgl2',
    PER_INSTANCE_REGION: context.geometry === 'sprite-instances',
    TERRAIN_GEOMETRY_AVAILABLE: context.geometry === 'terrain',
    SKINNING_DISABLED: context.geometry !== 'skinned',
    POINT_SHADOW_AVAILABLE: false,
    MATERIAL_VALIDATION_ENABLED: context.instrumentation === 'validation',
    VISIBLE_SURFACE_AVAILABLE: context.visibleSurface === true,
  });
}
