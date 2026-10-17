import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import {
  type MaterialAsset,
  type SamplerAsset,
  type TextureAsset,
  toShared,
  validateTextureLayout,
} from '@forgeax/engine-types';
import {
  type MeshMaterialBindingPreparationFailure,
  type MeshMaterialBindingResidency,
  publishMeshMaterialBindingResidency,
} from './mesh-material-bindings';
import type { RenderResourceScope } from './publication/resource-scope';
import type { RenderSystemInternals } from './record/render-context';
import { materialSamplerHandles, materialTextureHandles } from './recovery/render-system-candidate';
import type { MaterialSnapshot } from './render-system-extract';

const EMPTY_RESIDENCY_DETAILS = Object.freeze([]);

function preparationFailureFrom(error: unknown): MeshMaterialBindingPreparationFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  if (
    typeof value.code !== 'string' ||
    typeof value.expected !== 'string' ||
    typeof value.hint !== 'string'
  ) {
    return undefined;
  }
  const detail =
    typeof value.detail === 'object' && value.detail !== null
      ? { ...(value.detail as Record<string, unknown>) }
      : undefined;
  return {
    code: value.code,
    expected: value.expected,
    hint: value.hint,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Project producer-owned material and GPU-store state into the renderer's one
 * observation surface. This is recomputed from detached frame snapshots; no
 * readiness map is retained by RenderSystem. A producer failure with an
 * already resident resource remains last-known-good. Presentation requests
 * readiness only, retaining the same validation and resource observations but
 * omitting unused detailed texture/sampler records.
 */
export function observeMaterialResidency(
  world: RenderResourceScope | undefined,
  material: MaterialSnapshot,
  internals: RenderSystemInternals,
  includeDetails = true,
  textureLayouts?: WeakMap<TextureAsset, ReturnType<typeof validateTextureLayout>>,
): MeshMaterialBindingResidency {
  let textures: Array<{ readonly handle: number; readonly mipLevelCount: number }> | undefined;
  let samplers: Array<{ readonly handle: number; readonly resident: boolean }> | undefined;
  let pending = false;
  let resident = false;
  let failure: MeshMaterialBindingPreparationFailure | undefined;

  if (world === undefined) {
    pending = true;
  } else {
    const materialHandle = material.materialHandle;
    if (materialHandle !== undefined && materialHandle !== 0) {
      const materialResult = resolveAssetHandle<MaterialAsset>(
        world,
        toShared<'MaterialAsset'>(materialHandle),
      );
      if (!materialResult.ok) {
        const error = materialResult.error;
        failure ??= preparationFailureFrom(error);
      } else {
        // A values-only child renders its accepted root publication. Its own
        // uncooked GUID is not a second program owner.
        const guid =
          material.materialPublication?.identity.materialGuid ??
          internals.assets.guidOf(materialResult.value);
        if (guid !== undefined) {
          const readiness = internals.assets.getMaterialReadiness(guid);
          if (readiness?.status === 'Error') {
            const error = readiness.error;
            failure ??= preparationFailureFrom(error);
          }
          const load = internals.assets.loadState.get(guid);
          if (load?.status === 'provisional') pending = true;
        }
      }
    }

    for (const handle of materialTextureHandles(material)) {
      const pod = resolveAssetHandle<TextureAsset>(world, handle);
      if (!pod.ok) {
        const error = pod.error;
        failure ??= preparationFailureFrom(error);
        continue;
      }
      const prepared = internals.gpuStore.ensureResident(handle, pod.value, world);
      if (!prepared.ok) {
        const error = prepared.error;
        failure ??= preparationFailureFrom(error);
        continue;
      }
      // Live author data remains observable after GPU admission. Validate it
      // without rebuilding mip records; allocation details belong to the store.
      let valid = textureLayouts?.get(pod.value);
      if (valid === undefined) {
        valid = validateTextureLayout({
          shape: pod.value.shape,
          format: pod.value.format,
          mips: pod.value.mips,
        });
        textureLayouts?.set(pod.value, valid);
      }
      if (!valid.ok) {
        const error = valid.error;
        failure ??= preparationFailureFrom(error);
        continue;
      }
      resident = true;
      if (includeDetails) {
        textures ??= [];
        textures.push({
          handle: Number(handle),
          mipLevelCount: prepared.value.receipt.mipLevelCount,
        });
      }
    }

    for (const handle of materialSamplerHandles(material)) {
      const pod = resolveAssetHandle<SamplerAsset>(world, handle);
      if (!pod.ok) {
        const error = pod.error;
        failure ??= preparationFailureFrom(error);
        const samplerId = Number(handle);
        if (includeDetails) {
          samplers ??= [];
          samplers.push({ handle: samplerId, resident: false });
        }
        continue;
      }
      const prepared = internals.gpuStore.ensureSamplerResident(handle, pod.value, world);
      if (!prepared.ok) {
        const error = prepared.error;
        failure ??= preparationFailureFrom(error);
        const samplerId = Number(handle);
        if (includeDetails) {
          samplers ??= [];
          samplers.push({ handle: samplerId, resident: false });
        }
      } else {
        resident = true;
        const samplerId = Number(handle);
        if (includeDetails) {
          samplers ??= [];
          samplers.push({ handle: samplerId, resident: true });
        }
      }
    }
    // Video views are supplied by the renderer-owned dynamic store at record
    // time. A previously uploaded view is a producer-owned last-known-good
    // fact; absence means the visible workset still needs a decodable frame.
    for (const clip of material.videoTextureFields?.values() ?? EMPTY_RESIDENCY_DETAILS) {
      if (internals.dynamicTextureStore?.getView(clip) === undefined) pending = true;
      else resident = true;
    }
  }

  const readiness =
    failure === undefined
      ? pending
        ? 'pending'
        : 'ready'
      : resident
        ? 'last-known-good'
        : 'failed';
  return publishMeshMaterialBindingResidency({
    readiness,
    samplers: samplers ?? EMPTY_RESIDENCY_DETAILS,
    textures: textures ?? EMPTY_RESIDENCY_DETAILS,
    ...(failure === undefined ? {} : { preparationFailure: failure }),
  });
}

/**
 * Share detached material observations only within one synchronous projection.
 * A new preparation/submission phase observes the resource owners again.
 */
export function createMaterialResidencyObserver(
  internals: RenderSystemInternals,
  includeDetails = true,
) {
  // One synchronous phase can encounter the same texture through thousands
  // of value clones. Pure layout validation belongs to that payload once;
  // GPU admission and mutable producer readiness remain per observation.
  const textureLayouts = new WeakMap<TextureAsset, ReturnType<typeof validateTextureLayout>>();
  const scopes = new Map<
    RenderResourceScope | undefined,
    Map<MaterialSnapshot | number, MeshMaterialBindingResidency>
  >();
  return (
    world: RenderResourceScope | undefined,
    material: MaterialSnapshot,
  ): MeshMaterialBindingResidency => {
    // Value-only clones share the same MaterialAsset readiness. Texture,
    // sampler and video overrides retain their exact snapshot observation.
    const key =
      (material.textureHandles?.size ?? 0) === 0 &&
      (material.samplerHandles?.size ?? 0) === 0 &&
      (material.videoTextureFields?.size ?? 0) === 0 &&
      (material.baseColorTexture ?? 0) === 0 &&
      (material.metallicRoughnessTexture ?? 0) === 0 &&
      (material.normalTexture ?? 0) === 0 &&
      (material.emissiveTexture ?? 0) === 0 &&
      (material.occlusionTexture ?? 0) === 0
        ? (material.materialHandle ?? 0)
        : material;
    let materials = scopes.get(world);
    const cached = materials?.get(key);
    if (cached !== undefined) return cached;
    const observation = observeMaterialResidency(
      world,
      material,
      internals,
      includeDetails,
      textureLayouts,
    );
    if (materials === undefined) {
      materials = new Map();
      scopes.set(world, materials);
    }
    materials.set(key, observation);
    return observation;
  };
}
