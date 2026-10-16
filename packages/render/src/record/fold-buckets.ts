import { HANDLE_NINESLICE_QUAD, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { deriveVertexCount } from '@forgeax/engine-geometry';
import { RhiError } from '@forgeax/engine-rhi';
import type { MeshAsset } from '@forgeax/engine-types';
import { handleSlot, toShared } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { materialBindingKey } from '../gpu-driven/material-bindings';
import { GpuBuffer } from '../gpu-resource';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_VERTEX } from '../gpu-usage';
import { disposeTransientInstanceBuffers } from '../instance-buffer-cache';
import type { RenderResourceScope } from '../publication/resource-scope';
import { renderAssetByGuid } from '../publication/resource-scope';
import type { DispatchEntry, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import {
  getTransparentSortConfig,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../systems/transparent-sort-config';
import { captureDispatchOverlays, type DispatchOverlays } from './dispatch-overlays';
import {
  instanceCollectionCacheKey,
  type RenderFrameState,
  type ValidatedRenderable,
  worldEntityKey,
} from './frame-snapshot';
import {
  buildFoldDispatchPlan,
  cleanPerEntityCache,
  ensureMeshSsboCapacity,
  evaluateFoldBucketUniformCap,
  type FoldBucket,
  type FoldDispatchPlan,
  foldDispatchBuckets,
  incrementFoldedDrawsMetric,
} from './mesh-ssbo';
import {
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from './render-context';

/**
 * A frame-local material table. Repeated snapshot objects share one UBO slot;
 * each renderable keeps only the slot index used by each authored material.
 */
export interface MaterialSlotPlan<T extends object> {
  readonly slotIndices: readonly (readonly number[])[];
  readonly slots: readonly T[];
  /** Index of the first renderable that referenced each slot. */
  readonly slotOwners: readonly number[];
}

/**
 * Intern identical material snapshots into one frame-local slot table.
 * Snapshot identity is the extract layer's invalidation token, so this keeps
 * the same correctness boundary while avoiding duplicate payload assembly and
 * upload for repeated scene instances.
 */
export function buildMaterialSlotPlan<T extends object>(
  materialGroups: readonly (readonly T[])[],
  bindingClass?: (material: T, owner: number) => string,
): MaterialSlotPlan<T> {
  const slotByMaterial = new Map<T, number>();
  const splitClasses = new Map<T, Map<string, number>>();
  const resourceClasses: string[] = [];
  const slots: T[] = [];
  const slotOwners: number[] = [];
  function intern(this: number, material: T): number {
    const resourceClass = bindingClass?.(material, this) ?? '';
    const first = slotByMaterial.get(material);
    let materialClasses: Map<string, number> | undefined;
    if (first !== undefined) {
      if (resourceClasses[first] === resourceClass) return first;
      materialClasses = splitClasses.get(material);
      if (materialClasses === undefined) {
        materialClasses = new Map();
        splitClasses.set(material, materialClasses);
      }
      const cached = materialClasses.get(resourceClass);
      if (cached !== undefined) return cached;
    }
    const slot = slots.length;
    slots.push(material);
    slotOwners.push(this);
    resourceClasses.push(resourceClass);
    if (first === undefined) slotByMaterial.set(material, slot);
    else materialClasses?.set(resourceClass, slot);
    return slot;
  }
  const slotIndices = materialGroups.map((materials, ownerIndex) =>
    materials.map(intern, ownerIndex),
  );
  return { slotIndices, slots, slotOwners };
}

/**
 * Return the largest complete row prefix supported by the material capacity.
 * Repeated materials reuse their first-seen slots, regardless of mesh row count.
 */
export function findRenderablePrefixForSlotCapacity(
  materialSlotIndices: readonly (readonly number[])[],
  slotCapacity: number,
): number {
  const capacity = Math.max(0, Math.floor(slotCapacity));
  const maxRenderableCount = materialSlotIndices.length;
  let renderableCount = 0;
  while (renderableCount < maxRenderableCount) {
    const slots = materialSlotIndices[renderableCount] ?? [];
    if (slots.some((slot) => slot >= capacity)) break;
    renderableCount += 1;
  }
  return renderableCount;
}

/** Count material slots reachable from a prefix of a first-seen slot plan. */
export function materialSlotCountForPrefix(
  materialSlotIndices: readonly (readonly number[])[],
  renderableCount: number,
): number {
  let maxSlot = -1;
  for (let index = 0; index < renderableCount; index += 1) {
    for (const slot of materialSlotIndices[index] ?? []) maxSlot = Math.max(maxSlot, slot);
  }
  return maxSlot + 1;
}

/**
 * feat-20260704 M3/w18: validate renderable handles + collect the render plan,
 * extracted verbatim from `recordFrame`. Empty `renderables` input or all-
 * unregistered handles both yield an empty result (the Case E clear-pass-only
 * path). Builds per-entry renderState / stencilReference overlays from the
 * transparent-dispatch entries, resolves each MeshFilter.assetHandle through
 * the AssetRegistry + GPU store (with the sprite 9-slice mesh swap), and fires
 * structured `asset-not-registered` errors for handles that fail to resolve.
 *
 * @internal
 */
export function validateRenderables(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2): the full
  // worlds[] list. Each renderable's mesh handle is a user-tier slot in its OWN
  // world's sharedRefs; resolving against a foreign world either misses
  // (asset-not-registered) or resolves the wrong slot payload. `world` (the
  // resource-owner) is retained as the fallback for renderables whose worldId
  // is out of range (defensive; extractFrames always stamps a valid index).
  worlds: readonly RenderResourceScope[],
  pipelineState: PipelineState,
  frameState: RenderFrameState,
  renderables: readonly RenderableSnapshot[],
  transparentDispatch: readonly DispatchEntry[],
  excludedEntityKeys: ReadonlySet<number> = new Set<number>(),
  worldKeys?: readonly number[],
  profilePhase?: RecordProfileRunner,
  retainedOverlays?: DispatchOverlays,
): ValidatedRenderable[] {
  // One captured overlay per index preserves last-dispatch authority for all
  // three fields. Capture before residency callbacks can edit borrowed entries.
  const overlays =
    retainedOverlays?.dispatch === transparentDispatch
      ? retainedOverlays.values
      : captureDispatchOverlays(transparentDispatch).values;
  const validated: ValidatedRenderable[] = [];
  for (let rIdx = 0; rIdx < renderables.length; rIdx++) {
    const r = renderables[rIdx];
    if (r === undefined) continue;
    if (excludedEntityKeys.has(worldEntityKey(worldKeys?.[r.worldId] ?? r.worldId, r.entityKey)))
      continue;
    // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2): resolve
    // this renderable's mesh against the world it was EXTRACTED from
    // (worlds[r.worldId]) — NOT the single resource-owner `world`. Builtin mesh
    // slots (< BUILTIN_BASE) resolve process-statically regardless of world, so
    // the per-world pick only matters for user-tier handles, but selecting it
    // unconditionally keeps a single code path. Falls back to the resource-owner
    // world if worldId is out of range (defensive; extractFrames always stamps
    // a valid index into worlds[]).
    const renderableWorld = worlds[r.worldId] ?? world;
    const assetRes = runRecordProfilePhase(profilePhase, 'record/validation/asset', () =>
      resolveAssetHandle<MeshAsset>(renderableWorld, toShared<'MeshAsset'>(r.assetHandle)),
    );
    if (!assetRes.ok) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'MeshFilter.assetHandle in AssetRegistry',
          hint: 'use HANDLE_CUBE / HANDLE_TRIANGLE imports; custom mesh register path: feat-future-asset-system',
          detail: { assetHandle: r.assetHandle },
        }),
      );
      continue;
    }
    // feat-20260601-device/gpu-residency-extraction M1 (D-1): builtin meshes
    // (slots through HANDLE_NINESLICE_QUAD) keep the createRenderer step-3
    // direct-upload + `pipelineState.meshes` path -- they are NOT routed
    // through `ensureResident`. User-registered meshes pull through the store
    // on first access (the register->upload push was severed in this M1);
    // the POD fetched above (assetRes.value) is passed in, store holds no
    // registry ref (D-2). A first-access miss builds the GPU buffers; later
    // frames hit the O(1) cache.
    const meshAssetHandle = toShared<'MeshAsset'>(r.assetHandle);
    let meshHandles = internals.gpuStore.getMeshGpuHandles(meshAssetHandle, renderableWorld);
    const lodMeshes = runRecordProfilePhase(profilePhase, 'record/validation/lod-assets', () =>
      r.lods?.map((lod) =>
        renderAssetByGuid<MeshAsset>(renderableWorld, internals.assets, lod.mesh),
      ),
    );
    const resolvedLodMeshes = lodMeshes?.map((lod) => (lod?.kind === 'mesh' ? lod : undefined));
    if (meshHandles === undefined && r.assetHandle > handleSlot(HANDLE_NINESLICE_QUAD)) {
      const residentRes = runRecordProfilePhase(profilePhase, 'record/validation/residency', () =>
        internals.gpuStore.ensureResident(
          meshAssetHandle,
          assetRes.value,
          renderableWorld,
          resolvedLodMeshes,
          profilePhase,
        ),
      );
      if (residentRes.ok) {
        meshHandles = residentRes.value;
      } else if (residentRes.error instanceof RhiError) {
        internals.errorRegistry.fire(residentRes.error);
      }
    }
    meshHandles = meshHandles ?? pipelineState.meshes.get(r.assetHandle);
    if (meshHandles === undefined) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'GPU mesh buffers uploaded for assetHandle',
          hint: 'await renderer.initialization before draw([world], { cameraOwner: 0, resourceOwner: 0 }); ensure AssetRegistry.configureGpuDevice ran so user meshes are uploaded',
          detail: { assetHandle: r.assetHandle },
        }),
      );
      continue;
    }
    // feat-20260527-sprite-nineslice M2 / w11 (plan-strategy section D-2):
    // sprite branch with non-zero `slicesAndMode` (post-w12 paramSnapshot
    // entry name) overrides the user-supplied mesh handle (typically
    // HANDLE_QUAD = 3) with the 16-vertex / 54-index HANDLE_NINESLICE_QUAD
    // (id=5) topology so the vertex shader sees the 4x4 grid required for
    // 9-region anchor mapping. Default slicesAndMode ([0, 0, 0, 0]) keeps
    // the legacy HANDLE_QUAD path; a flip from zero to non-zero on the
    // same entity routes here per-frame so AI users can toggle 9-slice
    // on the fly without re-spawning the entity (charter F1 minimum
    // surface). The HANDLE_NINESLICE_QUAD GPU buffers are seeded by
    // createRenderer step-3.
    //
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13: judgement
    // key migrated from `shadingModel === 'sprite'` to
    // `materialShaderId === 'forgeax::sprite'` (plan-strategy D-10); slices
    // sourced from `paramSnapshot.slicesAndMode` (post-w12 UBO-aligned
    // overlay path).
    //
    // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t7:
    // sprite-lit shares the sprite paramSchema (5 fields, t4 mirror) so
    // the 9-slices mesh swap applies identically.
    let effectiveMeshHandles = meshHandles;
    if (
      r.material.materialShaderId === 'forgeax::sprite' ||
      r.material.materialShaderId === 'forgeax::sprite-lit'
    ) {
      const slicesArr = r.material.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
      if (
        slicesArr !== undefined &&
        slicesArr.length >= 4 &&
        (slicesArr[0] !== 0 || slicesArr[1] !== 0 || slicesArr[2] !== 0 || slicesArr[3] !== 0)
      ) {
        const nineSliceHandles = pipelineState.meshes.get(handleSlot(HANDLE_NINESLICE_QUAD));
        if (nineSliceHandles !== undefined) {
          effectiveMeshHandles = nineSliceHandles;
        }
      }
    }
    if (r.morph !== undefined) {
      const morphed = prepareMorphMesh(
        internals,
        frameState,
        worldEntityKey(r.worldId, r.entityKey),
        effectiveMeshHandles,
        assetRes.value,
        r.morph,
      );
      if (morphed !== undefined) effectiveMeshHandles = morphed;
    }
    const overlay = overlays.get(rIdx);
    validated.push({
      source: r,
      world: renderableWorld,
      mesh: effectiveMeshHandles,
      renderableIndex: rIdx,
      renderState: overlay?.renderState,
      variantSet: overlay?.variantSet,
      stencilReference: overlay?.stencilReference,
    });
  }
  return validated;
}

// Keep the primary record-stage name explicit at its call site while sharing
// the same owner implementation for the complete retained ShadowCaster view.

function prepareMorphMesh(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  cacheKey: number,
  base: MeshGpuHandles,
  mesh: MeshAsset,
  morph: RenderableSnapshot['morph'],
): MeshGpuHandles | undefined {
  if (morph === undefined || frameState.morphBuffers === undefined) return undefined;
  const targets = mesh.morphTargets;
  if (targets === undefined || targets.length !== morph.targetCount) return undefined;
  const position = base.layoutProjection.attributes.find(
    (attribute) => attribute.key === 'position',
  );
  if (
    position === undefined ||
    position.offset !== 0 ||
    position.shaderLocation !== 0 ||
    position.format !== 'float32x3' ||
    position.byteLength !== 12
  ) {
    return undefined;
  }
  const vertexCount = deriveVertexCount(mesh.vertices, base.layoutProjection);
  if (vertexCount === undefined || vertexCount !== base.vertexCount || vertexCount <= 0) {
    return undefined;
  }
  const stride = base.layoutProjection.arrayStride / Float32Array.BYTES_PER_ELEMENT;

  let active = false;
  for (const weight of morph.weights) {
    if (weight !== 0) {
      active = true;
      break;
    }
  }
  if (!active) {
    frameState.morphBuffers.get(cacheKey)?.buffer.destroy();
    frameState.morphBuffers.delete(cacheKey);
    return undefined;
  }

  const vertices = new Float32Array(mesh.vertices);
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const weight = morph.weights[targetIndex] ?? 0;
    const positions = targets[targetIndex]?.position;
    if (positions === undefined || positions.length !== base.vertexCount * 3) return undefined;
    for (let vertex = 0; vertex < base.vertexCount; vertex += 1) {
      const vertexBase = vertex * stride;
      const positionBase = vertex * 3;
      vertices[vertexBase] = (vertices[vertexBase] ?? 0) + (positions[positionBase] ?? 0) * weight;
      vertices[vertexBase + 1] =
        (vertices[vertexBase + 1] ?? 0) + (positions[positionBase + 1] ?? 0) * weight;
      vertices[vertexBase + 2] =
        (vertices[vertexBase + 2] ?? 0) + (positions[positionBase + 2] ?? 0) * weight;
    }
  }

  let cached = frameState.morphBuffers.get(cacheKey);
  if (cached === undefined || cached.byteLength !== vertices.byteLength) {
    if (cached !== undefined && !cached.buffer.isDestroyed) {
      const destroyed = cached.buffer.destroy();
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
    const created = internals.device.createBuffer({
      label: `morph-${cacheKey}-vbo`,
      size: vertices.byteLength,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!created.ok) {
      internals.errorRegistry.fire(created.error);
      frameState.morphBuffers.delete(cacheKey);
      return undefined;
    }
    const buffer = new GpuBuffer(internals.device, created.value);
    internals.deviceScope._adopt('buffer', buffer, (owned) => {
      if (!owned.isDestroyed) owned.destroy();
    });
    cached = {
      buffer,
      byteLength: vertices.byteLength,
    };
    frameState.morphBuffers.set(cacheKey, cached);
  }
  const written = internals.device.queue.writeBuffer(cached.buffer.handle, 0, vertices);
  if (!written.ok) {
    internals.errorRegistry.fire(written.error);
    return undefined;
  }
  return { ...base, vertexBuffer: cached.buffer };
}

/**
 * feat-20260704 M3/w18: build the dispatch-ordered render plan, extracted
 * verbatim from `recordFrame`. (1) M3/w26 dispatch-ordered reorder: reorder
 * `validated` to follow the transparent-dispatch order (extract-order fallback
 * for unmatched entries). (2) feat-20260608 mesh-SSBO capacity gate: size the
 * mesh and material buffers against their independent demands, truncating
 * complete rows against both capacities on ceiling. (3)
 * feat-20260622 fold dispatch plan: build + apply the WebGL2 uniform-cap
 * fallback + bump the folded-draws metric.
 *
 * @internal
 */
export function buildDispatchPlan(
  internals: RenderSystemInternals,
  validated: readonly ValidatedRenderable[],
  transparentDispatch: readonly DispatchEntry[],
  foldBuckets: readonly FoldBucket[],
  shadowValidated: readonly ValidatedRenderable[] = [],
  materialBindingClasses?: ReadonlyMap<string, string>,
  shadowGeometryGpuOwned = false,
): {
  validatedOrdered: readonly ValidatedRenderable[];
  shadowValidatedOrdered: readonly ValidatedRenderable[];
  foldDispatchPlan: FoldDispatchPlan | null;
  materialSlotIndices: readonly (readonly number[])[];
  materialSlots: readonly MaterialSnapshot[];
  materialSlotOwners: readonly ValidatedRenderable[];
  materialSlotCount: number;
} {
  // A production GPU-owned frame has no CPU validated rows by design. The
  // dispatch list can still contain one entry per authored entity, but no
  // CPU plan, material table, or fold bucket is consumed in that lane. Return
  // the empty plan without walking that list so a steady 100k scene remains
  // bounded by the persistent GPU batches rather than per-entity record work.
  if (validated.length === 0 && shadowValidated.length === 0) {
    return {
      validatedOrdered: [],
      shadowValidatedOrdered: [],
      foldDispatchPlan: null,
      materialSlotIndices: [],
      materialSlots: [],
      materialSlotOwners: [],
      materialSlotCount: 0,
    };
  }
  // M3 / w26: dispatch-ordered render. The dispatch list is pre-sorted
  // by queue (ascending, stable) by the extract stage per plan-strategy D-3.
  // Reorder validated renderables to follow the dispatch order, falling
  // back to extract order for renderables with no matching dispatch entry.
  // ShadowCaster entries order the shadow plan only: every caster pass sits in
  // the opaque queue, so letting it place a row would pin blended draws to
  // spawn order ahead of their sorted view entries.
  let dispatchOrderMatchesValidated = true;
  let viewEntries = 0;
  for (const de of transparentDispatch) {
    if (de.tags.LightMode === 'ShadowCaster') continue;
    if (de.renderableIndex !== validated[viewEntries]?.renderableIndex) {
      dispatchOrderMatchesValidated = false;
      break;
    }
    viewEntries += 1;
  }
  if (viewEntries !== validated.length) dispatchOrderMatchesValidated = false;
  let validatedOrdered: readonly ValidatedRenderable[] = dispatchOrderMatchesValidated
    ? validated
    : [...validated];
  if (transparentDispatch.length > 0 && !dispatchOrderMatchesValidated) {
    const validatedByRenderableIdx = new Map<number, ValidatedRenderable>();
    const seen = new Set<number>();
    for (const v of validated) {
      validatedByRenderableIdx.set(v.renderableIndex, v);
    }
    const ordered: ValidatedRenderable[] = [];
    for (const de of transparentDispatch) {
      if (de.renderableIndex === undefined || de.tags.LightMode === 'ShadowCaster') continue;
      const v = validatedByRenderableIdx.get(de.renderableIndex);
      if (v !== undefined && !seen.has(de.renderableIndex)) {
        seen.add(de.renderableIndex);
        ordered.push(v);
      }
    }
    // Append renderables not in the dispatch list (e.g. default-material entities)
    for (const v of validated) {
      if (!seen.has(v.renderableIndex)) {
        ordered.push(v);
      }
    }
    validatedOrdered = ordered;
  }

  // Shadow-only/off-camera CPU residuals consume the same material UBO as
  // visible draws. Their preparation must not depend on main-view visibility.
  const materialRows = [...validatedOrdered, ...shadowValidated];
  const materialGroups = materialRows.map((entry): readonly MaterialSnapshot[] => {
    const shaderId = entry.source.material.materialShaderId;
    if (shaderId === 'forgeax::sprite' || shaderId === 'forgeax::sprite-lit') {
      return [entry.source.material];
    }
    return entry.source.materials.length > 0 ? entry.source.materials : [entry.source.material];
  });
  const materialSlotPlan = buildMaterialSlotPlan(materialGroups, (material, owner) => {
    const row = materialRows[owner];
    return row === undefined
      ? ''
      : (materialBindingClasses?.get(
          materialBindingKey(row.source, material.materialHandle ?? -1),
        ) ?? '');
  });
  let materialSlotIndices = materialSlotPlan.slotIndices;
  let materialSlots = materialSlotPlan.slots;
  let materialSlotOwners = materialSlotPlan.slotOwners.map((index) => {
    const owner = materialRows[index];
    if (owner === undefined) throw new Error('material slot has no validated owner');
    return owner;
  });
  let materialSlotCount = materialSlots.length;

  // Mesh rows include independent shadow transforms; material rows refer to the
  // interned table. Neither demand is a capacity estimate for the other stream.
  const shadowMeshRows = shadowGeometryGpuOwned ? [] : shadowValidated;
  let shadowValidatedOrdered = shadowMeshRows;
  const capacity = ensureMeshSsboCapacity(
    internals,
    validatedOrdered.length + shadowMeshRows.length,
    materialSlotCount,
  );
  if (!capacity.ok) {
    const materialPrefix = findRenderablePrefixForSlotCapacity(
      materialSlotIndices,
      capacity.degradedTo.materialSlotCount,
    );
    const primaryCount = validatedOrdered.length;
    const retainedPrimaryCount = Math.min(
      primaryCount,
      materialPrefix,
      capacity.degradedTo.meshSlotCount,
    );
    const retainedShadowCount = Math.min(
      shadowValidated.length,
      Math.max(0, materialPrefix - primaryCount),
      shadowGeometryGpuOwned
        ? Number.POSITIVE_INFINITY
        : capacity.degradedTo.meshSlotCount - retainedPrimaryCount,
    );
    // Shadow material rows follow the retained primary prefix even when the
    // primary mesh capacity is exhausted. Preserve their original slot values.
    materialSlotIndices = [
      ...materialSlotIndices.slice(0, retainedPrimaryCount),
      ...materialSlotIndices.slice(primaryCount, primaryCount + retainedShadowCount),
    ];
    materialSlotCount = materialSlotCountForPrefix(materialSlotIndices, materialSlotIndices.length);
    materialSlots = materialSlots.slice(0, materialSlotCount);
    materialSlotOwners = materialSlotOwners.slice(0, materialSlotCount);
    validatedOrdered = validatedOrdered.slice(0, retainedPrimaryCount);
    shadowValidatedOrdered = shadowMeshRows.slice(0, retainedShadowCount);
  }

  // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap
  // (D-1): build the fold dispatch plan once `validatedOrdered` is final
  // (post truncation by mesh-SSBO capacity gate). The plan re-keys each
  // non-singleton bucket from `renderableIndex` to the validated-ordered
  // index `i` consumed by the dispatch loops; the loops use it to skip
  // non-head bucket members and emit one instanced drawIndexed per
  // bucket head. Empty plan (no fold-eligible buckets) is a byte-
  // identical no-op for the dispatch loops below (charter P3: silent
  // pass-through, no error path).
  let renderableToValidatedIdx: Map<number, number> | null = null;
  let foldDispatchPlan: FoldDispatchPlan | null = null;
  if (foldBuckets.length > 0) {
    renderableToValidatedIdx = new Map<number, number>();
    for (let i = 0; i < validatedOrdered.length; i++) {
      const e = validatedOrdered[i];
      if (e === undefined) continue;
      renderableToValidatedIdx.set(e.renderableIndex, i);
    }
    foldDispatchPlan = buildFoldDispatchPlan(foldBuckets, renderableToValidatedIdx);

    // feat-20260622 M2 / w11 (D-2 + D-9 + AC-05): WebGL2 uniform-fallback
    // per-bucket instance-count cap. When caps.storageBuffer===false AND
    // a fold bucket carries more than FOLD_UNIFORM_INSTANCE_CAP (128)
    // instances, fire RhiError({code:'instancing-exceeds-uniform-cap'})
    // AND remove the bucket from the dispatch plan so its members fall
    // through to the per-entity drawIndexed exit (the same exit the
    // mode-gate bypass uses — D-9 "shared fallback exit"). The frame
    // stays visually correct (charter proposition 9 graceful
    // degradation: no identity-collapse / black screen) while the cap
    // event surfaces structurally for AI users (proposition 4 explicit
    // failure on .code).
    //
    // Scope discrimination: tilemap-chunk-extract-system encodes
    // Layer.value = (layerOrder<<20) | (chunkIndex & 0xfffff), so a
    // bucket whose head entry carries non-zero low-20-bits is
    // definitively a tilemap-chunk dispatch site. Plain sprite buckets
    // use SPRITE_LAYER_VALUE = layerOrder<<20 (low-20 zero) by the
    // documented convention (apps/hello/asi-world main.ts pattern).
    // The chunkIndex===0 edge case maps to 'sprite' (the helper's
    // default branch) — a one-bucket ambiguity per layerOrder that is
    // acceptable for the AI-user affordance level (the error semantics
    // — "this bucket exceeded the cap" — is the actionable signal;
    // scope=sprite vs tilemap-chunk only refines the recovery hint).
    if (foldDispatchPlan.headBuckets.size > 0 && !internals.device.caps.storageBuffer) {
      const filteredHeads = new Map<number, FoldBucket>(foldDispatchPlan.headBuckets);
      const filteredSkips = new Set<number>(foldDispatchPlan.skipIndices);
      let filteredCount = foldDispatchPlan.foldedBucketCount;
      for (const [headIdx, bucket] of foldDispatchPlan.headBuckets) {
        const scope: 'sprite' | 'tilemap-chunk' =
          (bucket.layer & 0xfffff) !== 0 ? 'tilemap-chunk' : 'sprite';
        const decision = evaluateFoldBucketUniformCap(bucket, internals.device.caps, scope);
        if (decision.fallback && decision.error !== undefined) {
          internals.errorRegistry.fire(decision.error);
          filteredHeads.delete(headIdx);
          filteredCount -= 1;
          for (let j = 1; j < bucket.entries.length; j++) {
            const memberEntry = bucket.entries[j];
            if (memberEntry === undefined) continue;
            const memberValidatedIdx = renderableToValidatedIdx.get(memberEntry.renderableIndex);
            if (memberValidatedIdx !== undefined) {
              filteredSkips.delete(memberValidatedIdx);
            }
          }
        }
      }
      if (filteredCount !== foldDispatchPlan.foldedBucketCount) {
        foldDispatchPlan = {
          headBuckets: filteredHeads,
          skipIndices: filteredSkips,
          foldedBucketCount: filteredCount,
        };
      }
    }

    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M3 / w13 (D-3 +
    // AC-06): increment `render.instancing.foldedDraws` once per fold-
    // eligible head bucket retained after the cap-fallback filter above.
    // The metric tracks instanced drawIndexed call count for this frame
    // — cap-overrun buckets routed through the per-entity fallback exit
    // are removed from `foldDispatchPlan` and therefore not counted, by
    // construction (M2 / w11 cap-fallback + plan-strategy D-3 semantics).
    // Singleton buckets (mode-bypass under D-5, or non-foldable under
    // mode 0) carry `bucketSize === 1` and never enter `headBuckets`, so
    // the per-entity drawIndexed path correctly does not count.
    // SSOT helper lives in this record owner — engine code never
    // hardcodes the metric key string.
    incrementFoldedDrawsMetric(foldDispatchPlan, internals.metrics);
  }

  return {
    validatedOrdered,
    shadowValidatedOrdered,
    foldDispatchPlan,
    materialSlotIndices,
    materialSlots,
    materialSlotOwners,
    materialSlotCount,
  };
}

/**
 * feat-20260704 M3/w18: per-frame cache clean-up (despawn eviction), extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260531-per-frame-bind-group-cache M4 / w14 (D-5): drop per-entity BG
 * cache entries (materialBgPerEntity / instancesBgPerEntity) + instance buffers
 * whose outer-Map entityKey (packed Entity u32) is absent from the current
 * validated set, preventing unbounded growth after entity despawn. view + mesh
 * caches are frame-shared (keyed by GPU resource handle objects, WeakMap chains
 * naturally bounded) and are not touched. feat-20260619 M4 / F11: destroy the
 * GPU instance buffer before Map.delete (D-6 symmetric release); failure fires
 * errorRegistry + continues the sweep.
 *
 * @internal
 */
export function cleanPerFrameCaches(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  validated: readonly ValidatedRenderable[],
  retainedEntityKeys?: ReadonlySet<number>,
): void {
  if (frameState.transientInstanceBuffers !== undefined) {
    disposeTransientInstanceBuffers(frameState.transientInstanceBuffers, internals.errorRegistry);
  }
  // Build a Set<number> of worldEntityKey composites from the validated
  // renderables. D-1a #4: validatedEntityKeys are worldEntityKey(worldId, entityKey)
  // composites matching the write-side keys of #1-#3 — cross-world false eviction
  // is prevented because worldEntityKey(0, k) !== worldEntityKey(1, k).
  const validatedEntityKeys = new Set<number>(retainedEntityKeys);
  let instanceCollectionKeys: Set<number> | undefined;
  for (const v of validated) {
    const entityKey = worldEntityKey(v.source.worldId, v.source.entityKey);
    validatedEntityKeys.add(entityKey);
    instanceCollectionKeys?.add(entityKey);
    if (v.source.instances !== undefined) {
      const collection = instanceCollectionCacheKey(v.source.worldId, v.source.instances);
      if (!validatedEntityKeys.has(collection)) {
        instanceCollectionKeys ??= new Set(validatedEntityKeys);
        instanceCollectionKeys.add(collection);
      }
    }
  }

  const validatedInstanceKeys = instanceCollectionKeys ?? validatedEntityKeys;

  // Clean per-entity material BG cache: drop outer-Map entries whose
  // entityKey is absent from the current validated set. The shared and
  // singleton material caches have no entityKey and are not touched here.
  cleanPerEntityCache(frameState.materialBgPerEntity, validatedEntityKeys);

  // Clean per-entity instances BG cache.
  cleanPerEntityCache(frameState.instancesBgPerEntity, validatedEntityKeys);

  // D-5 retrofit: instanceBuffers clean-up. The instanceBuffers Map is
  // keyed by cacheKey (packed Entity u32, same as entityKey on
  // RenderableSnapshot). Drop entries whose key is no longer in the
  // validated set (OQ-3 / R-4). feat-20260619 M4 / F11: destroy the GPU
  // buffer before Map.delete so despawned entities release their
  // instance-buffer backing memory symmetrically (D-6).
  //
  // D-1a #1: instanceBuffers keys on the positive half (>= 0) are
  // worldEntityKey composites matching the write side. Negative half
  // fold-bucket keys (< 0) are NOT worldEntityKey; they are
  // material-handle-based and cross-world collision is semantically
  // correct (same material renders in same fold bucket).
  for (const [key, entry] of frameState.instanceBuffers.entries()) {
    if (!validatedInstanceKeys.has(key)) {
      if (!entry.buffer.isDestroyed) {
        const r = entry.buffer.destroy();
        if (!r.ok) internals.errorRegistry.fire(r.error);
      }
      frameState.instanceBuffers.delete(key);
    }
  }

  // Chunk starts belong to the collection owner; retire an absent owner
  // without parsing keys or visiting another collection's chunks.
  if (frameState.instanceBufferChunks !== undefined) {
    for (const [ownerKey, chunks] of frameState.instanceBufferChunks) {
      if (validatedInstanceKeys.has(ownerKey)) continue;
      for (const [start, entry] of chunks) {
        if (!entry.buffer.isDestroyed) {
          const r = entry.buffer.destroy();
          if (!r.ok) internals.errorRegistry.fire(r.error);
        }
        chunks.delete(start);
      }
      frameState.instanceBufferChunks.delete(ownerKey);
    }
  }

  if (frameState.morphBuffers !== undefined) {
    for (const [key, entry] of frameState.morphBuffers.entries()) {
      if (validatedEntityKeys.has(key)) continue;
      if (!entry.buffer.isDestroyed) {
        const result = entry.buffer.destroy();
        if (!result.ok) internals.errorRegistry.fire(result.error);
      }
      frameState.morphBuffers.delete(key);
    }
  }
}

/**
 * feat-20260704 M3/w18: record-stage fold operator linear scan, extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 + w5 (D-1, D-5):
 * groups transparent-sort-ordered dispatch entries with equal (Layer.value,
 * sortKey, materialHandle) into fold buckets. Mode-gate (D-5 extended): modes 0
 * (LAYER_Z) and 1 (LAYER_Y) fold using the pos z/y lanes; modes 2/3 bypass per-entity
 * (each entry a singleton bucket). Records `frameState.lastFoldBucketCount` =
 * fold-eligible buckets (bucketSize > 1) for the AC-06 metric. Empty dispatch
 * short-circuits (test fixtures pass null world).
 *
 * @internal
 */
export function computeFoldBuckets(
  world: RenderResourceScope,
  frameState: RenderFrameState,
  transparentDispatch: readonly DispatchEntry[],
  renderables: readonly RenderableSnapshot[],
): readonly FoldBucket[] {
  if (transparentDispatch.length === 0) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }
  const transparentSortCfg = getTransparentSortConfig(world);

  // Only layer-Z / layer-Y modes can produce non-singleton fold buckets.
  // The other modes make one inert singleton per entry, which is discarded by
  // buildFoldDispatchPlan. Returning the same empty plan here avoids allocating
  // a transform matrix for every renderable when folding is disabled by mode.
  if (
    transparentSortCfg.mode !== TRANSPARENT_SORT_MODE_LAYER_Z &&
    transparentSortCfg.mode !== TRANSPARENT_SORT_MODE_LAYER_Y
  ) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }

  // `transparentDispatch` is the legacy name for the complete sorted dispatch
  // list. Opaque entries can never participate in the transparent-only fold
  // plan, yet foldDispatchBuckets must preserve its general helper contract and
  // therefore materializes an inert singleton (including a Float32Array(16))
  // for each one. Filter only at this private production call site so the fold
  // helper keeps its testable semantics while record avoids work whose result
  // is provably discarded.
  let transparentCount = 0;
  for (const entry of transparentDispatch) {
    if (renderables[entry.renderableIndex]?.material.transparent === true) {
      transparentCount += 1;
    }
  }
  if (transparentCount === 0) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }
  const foldCandidates =
    transparentCount === transparentDispatch.length
      ? transparentDispatch
      : transparentDispatch.filter(
          (entry) => renderables[entry.renderableIndex]?.material.transparent === true,
        );
  const foldBuckets = foldDispatchBuckets(foldCandidates, transparentSortCfg.mode, renderables);
  // Count only fold-eligible buckets (bucketSize > 1) so the metric
  // surfaces fold actually reducing draws — singleton buckets under
  // mode bypass do not change draw count, so they do not contribute.
  let foldEligibleCount = 0;
  for (const b of foldBuckets) {
    if (b.bucketSize > 1) foldEligibleCount += 1;
  }
  frameState.lastFoldBucketCount = foldEligibleCount;
  return foldBuckets;
}
