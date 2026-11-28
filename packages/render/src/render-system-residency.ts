import { STANDARD_OBJECT_SPACE_NORMAL_BIT, standardMaskHasBit } from '@forgeax/engine-shader';
import type { AssetHandle } from '@forgeax/engine-types';
import {
  type MaterialAsset,
  type SamplerAsset,
  type SampledTextureAsset as TextureAsset,
  validateTextureShape,
} from '@forgeax/engine-types';
import { ownedMaterialValues } from './material-resource';
import { type MaterialSourceSnapshot, materialSourceScope } from './material-source';
import {
  type MeshMaterialBindingPreparationFailure,
  type MeshMaterialBindingResidency,
  publishMeshMaterialBindingResidency,
} from './mesh-material-bindings';
import type { RenderResourceScope } from './publication/resource-scope';
import type { DrawRows } from './record/frame-snapshot';
import type { RenderSystemInternals } from './record/render-context';
import type { MaterialSnapshot } from './render-system-extract';
import type { MaterialFrame } from './scene/material-dispatch';

/**
 * Keep the missing-texture sentinel out of residency preparation. A zero
 * handle is the same absent-reference value used by materialHandle; resolving
 * it as a real TextureAsset would otherwise pass an undefined pod to the GPU
 * store and fail before the renderer can produce a structured readiness
 * result.
 */
export function materialTextureHandlesForResidency(
  candidates: Iterable<AssetHandle<'texture' | 'gpu-texture'> | undefined>,
): readonly AssetHandle<'texture' | 'gpu-texture'>[] {
  let occupied = false;
  let firstKey = 0;
  let firstValue = 0 as AssetHandle<'texture' | 'gpu-texture'>;
  let overflow: Map<number, AssetHandle<'texture' | 'gpu-texture'>> | undefined;
  for (const handle of candidates) {
    if (handle === undefined || Number(handle) === 0) continue;
    const key = Number(handle);
    if (overflow !== undefined) overflow.set(key, handle);
    else if (!occupied) {
      occupied = true;
      firstKey = key;
      firstValue = handle;
    } else if (key === firstKey || Object.is(key, firstKey)) firstValue = handle;
    else {
      overflow = new Map();
      overflow.set(firstKey, firstValue);
      overflow.set(key, handle);
    }
  }
  return overflow === undefined ? (occupied ? [firstValue] : []) : [...overflow.values()];
}

const EMPTY_TEXTURE_HANDLES: readonly AssetHandle<'texture' | 'gpu-texture'>[] = Object.freeze([]);
const EMPTY_SAMPLER_HANDLES: readonly AssetHandle<'sampler'>[] = Object.freeze([]);

export function materialTextureHandles(
  material: MaterialSnapshot,
): readonly AssetHandle<'texture' | 'gpu-texture'>[] {
  const textureHandles = material.textureHandles;
  if (textureHandles === undefined || textureHandles.size === 0) {
    const baseColor = material.baseColorTexture;
    const metallicRoughness = material.metallicRoughnessTexture;
    const normal = material.normalTexture;
    const emissive = material.emissiveTexture;
    const occlusion = material.occlusionTexture;
    if (
      (baseColor === undefined || baseColor === 0) &&
      (metallicRoughness === undefined || metallicRoughness === 0) &&
      (normal === undefined || normal === 0) &&
      (emissive === undefined || emissive === 0) &&
      (occlusion === undefined || occlusion === 0)
    )
      return EMPTY_TEXTURE_HANDLES;
    return materialTextureHandlesForResidency([
      baseColor,
      metallicRoughness,
      normal,
      emissive,
      occlusion,
    ]);
  }
  return materialTextureHandlesForResidency([
    ...textureHandles.values(),
    material.baseColorTexture,
    material.metallicRoughnessTexture,
    material.normalTexture,
    material.emissiveTexture,
    material.occlusionTexture,
  ]);
}

/** Start independent generated textures for the already selected draw rows. */
export function prepareGeneratedDrawTextures(
  draws: DrawRows,
  materials: MaterialFrame,
  source: RenderResourceScope,
  store: RenderSystemInternals['gpuStore'],
): void {
  const seen = new Map<RenderResourceScope, Set<MaterialSnapshot>>();
  for (const { mesh, source: row, submeshIndices, world } of draws) {
    const count = submeshIndices?.length ?? mesh.submeshes.length;
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const submesh = mesh.submeshes[submeshIndices?.[ordinal] ?? ordinal];
      if (submesh === undefined) continue;
      const accepted = materials.get(row.materials[submesh.materialSlot] ?? row.material);
      if (accepted === undefined) continue;
      const material = accepted.snapshot;
      const scope = materialSourceScope(world ?? source, material.sourceAssets);
      let prepared = seen.get(scope);
      if (prepared === undefined) {
        prepared = new Set();
        seen.set(scope, prepared);
      }
      if (prepared.has(material)) continue;
      prepared.add(material);
      for (const handle of materialTextureHandles(material)) {
        if (store.getTextureGpuView(handle, scope) !== undefined) continue;
        const resolved = scope.resolveAsset<TextureAsset>(handle);
        if (resolved.ok && resolved.value.kind === 'gpu-texture') {
          // Submission, error reporting, and accepted output stay in the usual
          // residency owner. Do not wait for generation in this recording.
          store.ensureResident(handle, resolved.value, scope);
        }
      }
    }
  }
}

export function materialSamplerHandles(
  material: MaterialSnapshot,
): readonly AssetHandle<'sampler'>[] {
  const candidates = material.samplerHandles;
  if (candidates === undefined || candidates.size === 0) return EMPTY_SAMPLER_HANDLES;
  if (candidates.size === 1) return [...candidates.values()];
  const handles = new Map<number, AssetHandle<'sampler'>>();
  for (const handle of candidates.values()) {
    handles.set(Number(handle), handle);
  }
  return [...handles.values()];
}

// Object-space normals read .b; tangent space reconstructs Z from RG instead.
const NO_BLUE_FORMATS: ReadonlySet<GPUTextureFormat> = new Set<GPUTextureFormat>([
  'r8unorm',
  'rg8unorm',
  'bc4-r-unorm',
  'bc5-rg-unorm',
  'eac-r11unorm',
  'eac-rg11unorm',
]);

function objectSpaceNormalHandle(
  material: MaterialSnapshot,
): AssetHandle<'texture' | 'gpu-texture'> | undefined {
  const mask = material.standardTextureMask ?? 0;
  if (!standardMaskHasBit(mask, STANDARD_OBJECT_SPACE_NORMAL_BIT)) return undefined;
  return material.textureHandles?.get('normalTexture') ?? material.normalTexture;
}

const EMPTY_RESIDENCY_DETAILS = Object.freeze([]);
const READY_RESIDENCY = publishMeshMaterialBindingResidency({
  readiness: 'ready',
  samplers: EMPTY_RESIDENCY_DETAILS,
  textures: EMPTY_RESIDENCY_DETAILS,
});
const PENDING_RESIDENCY = publishMeshMaterialBindingResidency({
  readiness: 'pending',
  samplers: EMPTY_RESIDENCY_DETAILS,
  textures: EMPTY_RESIDENCY_DETAILS,
});

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
): MeshMaterialBindingResidency {
  if (world !== undefined) world = materialSourceScope(world, material.sourceAssets);
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
      const materialResult = world.resolveAsset<MaterialAsset>(
        materialHandle as AssetHandle<'material'>,
      );
      if (!materialResult.ok) {
        const error = materialResult.error;
        failure ??= preparationFailureFrom(error);
      }
    }

    const textureHandles = materialTextureHandles(material);
    for (let index = 0; index < textureHandles.length; index += 1) {
      const handle = textureHandles[index] as AssetHandle<'texture' | 'gpu-texture'>;
      const pod = world.resolveAsset<TextureAsset>(handle);
      if (!pod.ok) {
        const error = pod.error;
        failure ??= preparationFailureFrom(error);
        continue;
      }
      const prepared = internals.gpuStore.ensureResident(handle, pod.value, world);
      if (!prepared.ok) {
        if (prepared.error.code === 'asset-not-ready') {
          pending = true;
          continue;
        }
        const error = prepared.error;
        failure ??= preparationFailureFrom(error);
        continue;
      }
      const { receipt } = prepared.value;
      const { shape, format: sourceFormat, mips } = pod.value;
      if (
        receipt.fixedSourceMips === undefined ||
        receipt.shape !== shape ||
        receipt.fixedSourceMips !== mips ||
        receipt.format !== sourceFormat
      ) {
        const valid = validateTextureShape(shape, mips, sourceFormat);
        if (!valid.ok) {
          failure ??= preparationFailureFrom(valid.error);
          continue;
        }
      }
      const format = receipt.format;
      if (
        NO_BLUE_FORMATS.has(format) &&
        Number(objectSpaceNormalHandle(material)) === Number(handle)
      ) {
        failure ??= {
          code: 'asset-invalid-value',
          expected: `an object-space normal texture with a blue channel; ${format} carries no Z`,
          hint: "use normalMapSpace 'tangent' for RG normal maps (Z is reconstructed), or supply an RGB/RGBA object-space normal texture",
          detail: { field: 'normalMapSpace', value: format, reason: 'normal-texture-lacks-blue' },
        };
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
    const samplerHandles = materialSamplerHandles(material);
    for (let index = 0; index < samplerHandles.length; index += 1) {
      const handle = samplerHandles[index] as AssetHandle<'sampler'>;
      const pod = world.resolveAsset<SamplerAsset>(handle);
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
    const videos = material.videoTextureFields;
    if (videos) {
      for (const clip of videos.values()) {
        if (internals.dynamicTextureStore?.getView(clip) === undefined) pending = true;
        else resident = true;
      }
    }
  }

  // The observation still ran in full. These two detached results contain
  // no resource or failure data, so their immutable publication is reusable.
  if (failure === undefined && textures === undefined && samplers === undefined)
    return pending ? PENDING_RESIDENCY : READY_RESIDENCY;
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

type MaterialResidencyKey = number | MaterialSnapshot | MaterialSourceSnapshot;

/** Value-only clones observe their exact accepted source or the live handle in this scope. */
function materialResidencyKey(material: MaterialSnapshot): MaterialResidencyKey {
  if (
    (material.textureHandles?.size ?? 0) === 0 &&
    (material.samplerHandles?.size ?? 0) === 0 &&
    (material.videoTextureFields?.size ?? 0) === 0 &&
    (material.baseColorTexture ?? 0) === 0 &&
    (material.metallicRoughnessTexture ?? 0) === 0 &&
    (material.normalTexture ?? 0) === 0 &&
    (material.emissiveTexture ?? 0) === 0 &&
    (material.occlusionTexture ?? 0) === 0
  ) {
    const handle = material.materialHandle ?? 0;
    const source = material.sourceAssets;
    if (source === undefined) return handle;
    if (handle === source.root) return source;
  }
  return material;
}

/**
 * Share detached material observations only within one synchronous projection.
 * A new preparation/submission phase observes the resource owners again.
 */
export function createMaterialResidencyObserver(
  internals: RenderSystemInternals,
  includeDetails = true,
) {
  let scope:
    | {
        source: RenderResourceScope | undefined;
        materials: Map<MaterialResidencyKey, MeshMaterialBindingResidency>;
      }
    | undefined;
  let latestWorld: RenderResourceScope | undefined;
  let latestMaterial: MaterialSnapshot | undefined;
  let latestOwned = false;
  let latestObservation: MeshMaterialBindingResidency | undefined;
  const retainLatest = (
    world: RenderResourceScope | undefined,
    material: MaterialSnapshot,
    observation: MeshMaterialBindingResidency,
    fixedValues: boolean | undefined,
  ): MeshMaterialBindingResidency => {
    // Inspect ownership before publishing any part of the tuple: a proxy can
    // reenter this observer during metadata inspection. Borrowed values keep
    // their ordinary key reads, including after a previous owned consumer.
    const owned =
      material === latestMaterial
        ? latestOwned
        : fixedValues === true || ownedMaterialValues(material);
    latestWorld = world;
    latestMaterial = material;
    latestOwned = owned;
    latestObservation = observation;
    return observation;
  };
  return (
    world: RenderResourceScope | undefined,
    material: MaterialSnapshot,
    fixedValues?: boolean,
  ): MeshMaterialBindingResidency => {
    if (
      latestOwned &&
      latestMaterial === material &&
      latestWorld === world &&
      latestObservation !== undefined
    )
      return latestObservation;
    // Value-only clones share the same MaterialAsset readiness. Texture,
    // sampler and video overrides retain their exact snapshot observation.
    const key = materialResidencyKey(material);
    if (scope?.source !== world || scope === undefined)
      scope = { source: world, materials: new Map() };
    const materials = scope.materials;
    const cached = materials.get(key);
    if (cached !== undefined) return retainLatest(world, material, cached, fixedValues);
    const observation = observeMaterialResidency(world, material, internals, includeDetails);
    materials.set(key, observation);
    return retainLatest(world, material, observation, fixedValues);
  };
}
