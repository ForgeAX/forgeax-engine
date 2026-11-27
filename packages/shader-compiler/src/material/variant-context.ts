import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import type { MaterialProgramBindingContract } from '@forgeax/engine-types';

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
    CLIPPING_PLANES: context.viewClipping === true,
    LOD_DITHER: context.lodCoverage === true,
  });
}

/**
 * Whether a program's declared binding contract carries the Render material
 * groups after group 0. The group-0 and View contracts stop at group 0: their
 * pipeline layouts have no cluster group, so nothing they compile may select a
 * resource that lives there.
 */
export function materialBindingsCarryClusterGroup(
  bindings: MaterialProgramBindingContract | undefined,
): boolean {
  const contract = bindings ?? 'render-material';
  return (
    contract === 'render-material' ||
    contract === 'render-material-with-scene-depth' ||
    contract === 'render-material-and-scene-depth' ||
    contract === 'render-lit-material-and-scene-depth'
  );
}

/**
 * Lower the context for one program. The declared binding contract narrows the
 * context selectors to the resources that contract can bind. The packed
 * Cluster and atmosphere records share the packed View texture. Compact
 * group-0 and View-only material contracts omit that texture: their fallback
 * fog is the same View-only fog its storage variants compile without the
 * group 0 atmosphere tables, and the same fog the packaged particle programs
 * compile, instead of importing a texture its layout cannot hold.
 */
export function lowerMaterialProgramVariantContext(
  context: MaterialVariantContext,
  bindings: MaterialProgramBindingContract | undefined,
): Readonly<Record<string, boolean>> {
  const lowered = lowerMaterialVariantContext(context);
  if (materialBindingsCarryClusterGroup(bindings)) return lowered;
  return Object.freeze({ ...lowered, CLUSTER_FORWARD_AVAILABLE: false });
}
