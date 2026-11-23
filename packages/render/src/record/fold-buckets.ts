import { RhiError } from '@forgeax/engine-rhi';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import type { MeshSsboCapacity } from '../assembly/mesh-ssbo-grow';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { directMorphGeometry } from '../device/morph-geometry';
import { capturedGpuMaterialLayout } from '../gpu-driven/captured-material-bindings';
import type { GpuDrivenMaterialBinding } from '../gpu-driven/production-raster';
import {
  disposeInstanceBuffers,
  disposeTransientInstanceBuffers,
  type InstanceBufferCacheKey,
} from '../instance-buffer-cache';
import { type MaterialResource, materialUsesSpriteGeometry } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import { renderAsset } from '../publication/resource-scope';
import type { DispatchList, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import { meshDrawSnapshot } from '../scene/mesh-draw';
import type { MeshFrame } from '../scene/mesh-frame';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import {
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../systems/transparent-sort-config';
import { captureDispatchOverlays, type DispatchOverlays } from './dispatch-overlays';
import type { DrawRows } from './frame-snapshot';
import {
  getOpaqueResourceIdentity,
  instanceCollectionCacheKey,
  type RenderFrameState,
  type ValidatedRenderable,
} from './frame-snapshot';
import {
  acceptedMaterialSnapshot,
  canRetainMaterialBindings,
  type MaterialBindingIndex,
  type MaterialRelationFrame,
} from './material-binding-index';
import { materialGeometry } from './material-geometry';
import { prepareMaterialUniformFrame } from './material-uniforms';
import {
  buildFoldDispatchPlan,
  ensureMeshSsboCapacity,
  FOLD_UNIFORM_INSTANCE_CAP,
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
import type { ScenePassPreparation } from './scene-pass-work';

function unacceptedGeometryMaterial(
  input: RenderableSnapshot,
  r: RenderableSnapshot,
  materials: MaterialFrame | undefined,
  meshes: MeshFrame | undefined,
): RhiError {
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'geometry preparation uses a material from the captured MaterialFrame',
    hint: 'inspect detail.error.detail to identify the source binding and accepted frame; retain preparation materials until every visible or hidden preparation owner retires',
    detail: {
      error: {
        code: 'geometry-material-not-accepted',
        message: 'Geometry preparation has no accepted material',
        detail: {
          entityKey: r.entityKey,
          meshHandle: r.assetHandle,
          materialHandle: r.material.snapshot.materialHandle,
          materialIdentity: getOpaqueResourceIdentity(r.material),
          sourceMaterialIdentity: getOpaqueResourceIdentity(input.material),
          materialFrameIdentity:
            materials === undefined ? undefined : getOpaqueResourceIdentity(materials),
          meshFrameIdentity: meshes === undefined ? undefined : getOpaqueResourceIdentity(meshes),
          sourceMaterialAccepted: materials?.get(input.material) !== undefined,
          authorVisible: r.authorVisible !== false,
          pipelinePreparation: r.pipelinePreparation !== undefined,
        },
      },
    },
  });
}

/**
 * A frame-local material table. Repeated snapshot objects share one UBO slot;
 * each renderable keeps only the slot index used by each authored material.
 */
export interface MaterialBinding {
  readonly material: MaterialResource;
  readonly resourceClass: string;
  readonly world?: RenderResourceScope;
  /** Present only when native resources are tied to an actual draw (video/probe selection). */
  readonly entityKey?: number;
}

/** A retained phase proves the exact row roster whose relations it publishes. */
interface RetainedMaterialRows {
  readonly owner: MaterialBindingIndex;
  readonly renderables: DrawRows;
  readonly rows: readonly MaterialRelationFrame[] | undefined;
}

/** Canonical lookup of the slots in one accepted material table. */
export type MaterialBindingSlots = ReadonlyMap<MaterialResource, ReadonlyMap<string, number>>;

export interface MaterialSlotPlan<T extends object> {
  readonly slotIndices: readonly (readonly number[])[];
  readonly slots: readonly T[];
  /** Index of the first renderable that referenced each slot. */
  readonly slotOwners: readonly number[];
  readonly resourceClasses: readonly string[];
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
  // A singleton row reads one immutable slot vector, shared by that binding.
  // Still observe every authored member and owner-specific resource class.
  const singletons: (readonly number[] | undefined)[] = [];
  const slotIndices = materialGroups.map((materials, ownerIndex) => {
    if (
      materials.length !== 1 ||
      !(0 in materials) ||
      Object.getPrototypeOf(materials) !== Array.prototype ||
      Object.hasOwn(materials, 'map')
    )
      return materials.map(intern, ownerIndex);
    const slot = intern.call(ownerIndex, materials[0] as T);
    singletons[slot] ??= Object.freeze([slot]);
    return singletons[slot];
  });
  return { slotIndices, slots, slotOwners, resourceClasses };
}

/**
 * Return the largest complete row prefix supported by the material capacity.
 * Repeated materials reuse their first-seen slots, regardless of mesh row count.
 */
export function findRenderablePrefixForSlotCapacity(
  materialSlotIndices: FrameList<readonly number[]>,
  slotCapacity: number,
): number {
  const capacity = Math.max(0, Math.floor(slotCapacity));
  const maxRenderableCount = materialSlotIndices.length;
  let renderableCount = 0;
  while (renderableCount < maxRenderableCount) {
    const slots = materialSlotIndices.at(renderableCount) ?? [];
    if (slots.some((slot) => slot >= capacity)) break;
    renderableCount += 1;
  }
  return renderableCount;
}

/** Count material slots reachable from a prefix of a first-seen slot plan. */
export function materialSlotCountForPrefix(
  materialSlotIndices: FrameList<readonly number[]>,
  renderableCount: number,
): number {
  let maxSlot = -1;
  for (let index = 0; index < renderableCount; index += 1) {
    for (const slot of materialSlotIndices.at(index) ?? []) maxSlot = Math.max(maxSlot, slot);
  }
  return maxSlot + 1;
}

/** Resolve geometry residency without mixing it with frame admission. */
function prepareMeshResidency(
  internals: RenderSystemInternals,
  renderableWorld: RenderResourceScope,
  r: RenderableSnapshot,
  meshAsset: MeshAsset,
  profilePhase: RecordProfileRunner | undefined,
): MeshGpuHandles | undefined {
  const meshAssetHandle = r.assetHandle as AssetHandle<'mesh'>;
  let meshHandles =
    r.generatedMesh === undefined
      ? internals.gpuStore.getMeshGpuHandles(meshAssetHandle, renderableWorld)
      : undefined;
  const lodMeshes = runRecordProfilePhase(profilePhase, 'record/validation/lod-assets', () =>
    r.lods?.map((lod) => renderAsset<MeshAsset>(renderableWorld, lod.mesh)),
  );
  const resolvedLodMeshes = lodMeshes?.map((lod) => (lod?.kind === 'mesh' ? lod : undefined));
  const needsLodResidency = resolvedLodMeshes?.some(
    (mesh, level) => mesh !== undefined && (meshHandles?.lodRanges?.[level + 1]?.length ?? 0) === 0,
  );
  if (meshHandles === undefined || needsLodResidency) {
    const residentRes = runRecordProfilePhase(profilePhase, 'record/validation/residency', () =>
      r.generatedMesh !== undefined
        ? internals.gpuStore.ensureGeneratedMesh(r.generatedMesh)
        : internals.gpuStore.ensureResident(
            meshAssetHandle,
            meshAsset,
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
  return meshHandles;
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
  sourceScope: RenderResourceScope,
  _pipelineState: PipelineState,
  _frameState: RenderFrameState,
  renderables: FrameList<RenderableSnapshot>,
  transparentDispatch: DispatchList,
  excludedEntityKeys: ReadonlySet<number> = new Set<number>(),
  profilePhase?: RecordProfileRunner,
  retainedOverlays?: DispatchOverlays,
  materials?: import('../scene/material-dispatch').MaterialFrame,
  meshes?: MeshFrame,
  rows?: Pick<import('../scene/scene-slots').SceneSlotFrame, 'lookup'>,
): ValidatedRenderable[] {
  // One captured overlay per index preserves last-dispatch authority for all
  // three fields. Capture before residency callbacks can edit borrowed entries.
  const overlays =
    retainedOverlays?.dispatch === transparentDispatch
      ? retainedOverlays.values
      : captureDispatchOverlays(transparentDispatch).values;
  const validated: ValidatedRenderable[] = [];
  for (let rIdx = 0; rIdx < renderables.length; rIdx++) {
    const input = renderables.at(rIdx);
    if (input === undefined) continue;
    const r =
      meshes === undefined ? input : meshDrawSnapshot(input, meshes, rows?.lookup(input.entityKey));
    if (excludedEntityKeys.has(r.entityKey)) continue;
    // The CPU shadow path reads the complete persistent projection. Ordinary
    // hidden rows own no geometry work once their explicit preparation retires.
    if (r.authorVisible === false && r.pipelinePreparation === undefined) continue;
    const renderableWorld = sourceScope ?? world;
    if (r.generatedMesh === undefined && r.assetHandle === undefined) continue;
    const assetRes = runRecordProfilePhase(profilePhase, 'record/validation/asset', () =>
      r.generatedMesh === undefined
        ? renderableWorld.resolveAsset<MeshAsset>(r.assetHandle as AssetHandle<'mesh'>)
        : { ok: true as const, value: r.generatedMesh },
    );
    if (!assetRes.ok) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'MeshFilter.assetHandle in AssetRegistry',
          hint: 'bind a live mesh created or loaded by the World asset service',
          detail: { assetHandle: r.assetHandle ?? 0 },
        }),
      );
      continue;
    }
    const meshHandles = prepareMeshResidency(
      internals,
      renderableWorld,
      r,
      assetRes.value,
      profilePhase,
    );
    if (meshHandles === undefined) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'GPU mesh buffers uploaded for assetHandle',
          hint: 'await renderer.initialization before draw({ source: lease }); ensure AssetRegistry.configureGpuDevice ran so user meshes are uploaded',
          detail: { assetHandle: r.assetHandle ?? 0 },
        }),
      );
      continue;
    }
    const material =
      materials === undefined ? r.material.snapshot : materials.get(r.material)?.snapshot;
    if (material === undefined) throw unacceptedGeometryMaterial(input, r, materials, meshes);
    let effectiveMeshHandles = materialGeometry(meshHandles, material, () =>
      internals.gpuStore.ensureNineSliceGeometry().unwrap(),
    );
    if (r.morph !== undefined)
      effectiveMeshHandles = directMorphGeometry(internals, sourceScope, r, effectiveMeshHandles);
    const overlay = overlays.get(rIdx);
    validated.push({
      meshSlot: rIdx,
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
  validated: DrawRows,
  transparentDispatch: DispatchList,
  foldBuckets: readonly FoldBucket[],
  shadowValidated: DrawRows = [],
  materialBindingClasses?: ReadonlyMap<string, string>,
  shadowGeometryGpuOwned = false,
  sharedMaterials?: SharedMaterialFrame,
  meshDraws?: MeshDrawRoster,
  /** The primary rows are immutable native Phase output. */
  ownedRows = false,
  retainedMaterials?: RetainedMaterialRows,
  phase?: Pick<ScenePassPreparation, 'rows' | 'dispatchOrdered' | 'nativeStart' | 'nativeEnd'>,
): {
  /** The actual submitted rows when addressing preserved the native phase order. */
  phaseOrderedRows?: DrawRows | undefined;
  validatedOrdered: DrawRows;
  shadowValidatedOrdered: DrawRows;
  foldDispatchPlan: FoldDispatchPlan | null;
  materialSlotIndices: FrameList<readonly number[]>;
  materialSlots: readonly MaterialSnapshot[];
  materialBindings: readonly MaterialBinding[];
  materialBindingSlots: MaterialBindingSlots;
  materialSlotCount: number;
} {
  const capturedPhase = phase?.rows === validated ? phase : undefined;
  const phaseOrdered = capturedPhase?.dispatchOrdered === true;
  if (ownedRows && meshDraws !== undefined)
    meshDraws.beginOwnedMeshDrawFrame(
      validated,
      shadowValidated,
      capturedPhase?.nativeStart,
      capturedPhase?.nativeEnd,
    );
  else if (meshDraws !== undefined) {
    // Validation already selected the output rows. Consume them directly;
    // the view retains only detached native membership facts across frames.
    const sources = function* () {
      for (const row of validated) yield row.source;
      for (const row of shadowValidated) yield row.source;
    };
    meshDraws.beginMeshDrawFrame(sources());
  }
  const sharedUniformSlots =
    sharedMaterials === undefined
      ? undefined
      : prepareMaterialUniformFrame(internals, sharedMaterials.frame);
  const sharedBindingCount = sharedMaterials?.bindings.length ?? 0;
  // A production GPU-owned frame has no CPU validated rows by design. The
  // dispatch list can still contain one entry per authored entity, but no
  // CPU plan, material table, or fold bucket is consumed in that lane. Return
  // the empty plan without walking that list so a steady 100k scene remains
  // bounded by the persistent GPU batches rather than per-entity record work.
  if (validated.length === 0 && shadowValidated.length === 0 && sharedBindingCount === 0) {
    retainedMaterials?.owner.clear();
    return {
      validatedOrdered: [],
      shadowValidatedOrdered: [],
      foldDispatchPlan: null,
      materialSlotIndices: [],
      materialSlots: [],
      materialBindings: [],
      materialBindingSlots: EMPTY_BINDING_SLOTS,
      materialSlotCount: 0,
    };
  }
  let validatedOrdered = phaseOrdered
    ? validated
    : dispatchOrderedRenderables(validated, transparentDispatch, ownedRows);
  // Shadow-only/off-camera CPU residuals consume the same material UBO as
  // visible draws. Their preparation must not depend on main-view visibility.
  const materials = buildFrameMaterialTable(
    validated,
    validatedOrdered,
    shadowValidated,
    materialBindingClasses,
    sharedMaterials,
    retainedMaterials,
  );

  // Mesh rows include independent shadow transforms; material rows refer to the
  // interned table. Neither demand is a capacity estimate for the other stream.
  const shadowMeshRows = shadowGeometryGpuOwned ? [] : shadowValidated;
  let shadowValidatedOrdered = shadowMeshRows;
  // A native roster's addresses are allocated once, by addressPhysicalRows
  // below; its physical demand is checked there. Only a compact roster's row
  // count can degrade here.
  const meshRowDemand =
    meshDraws === undefined ? validatedOrdered.length + shadowMeshRows.length : 0;
  const uniformSlotCount = sharedUniformSlots ?? materials.slotCount;
  const capacity = ensureMeshSsboCapacity(internals, meshRowDemand, uniformSlotCount);
  if (!capacity.ok) {
    assertCapacityDegradable(capacity.degradedTo, uniformSlotCount, sharedBindingCount, meshDraws);
    const retained = truncateToDegradedCapacity(
      materials,
      capacity.degradedTo,
      validatedOrdered.length,
      shadowValidated.length,
      shadowGeometryGpuOwned,
      sharedBindingCount,
    );
    validatedOrdered = validatedOrdered.slice(0, retained.primaryCount);
    shadowValidatedOrdered = shadowMeshRows.slice(0, retained.shadowCount);
  }

  // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap
  // (D-1): build the fold dispatch plan once `validatedOrdered` is final
  // (post truncation by mesh-SSBO capacity gate). Empty plan (no fold-eligible
  // buckets) is a byte-identical no-op for the dispatch loops below.
  let foldDispatchPlan = buildUniformCappedFoldPlan(internals, foldBuckets, validatedOrdered);

  const addressed = addressPhysicalRows(
    validatedOrdered,
    shadowValidatedOrdered,
    foldDispatchPlan,
    meshDraws,
    ownedRows,
  );
  validatedOrdered = addressed.validatedOrdered;
  shadowValidatedOrdered = addressed.shadowValidatedOrdered;
  const physicalUniformSlots = sharedUniformSlots ?? materials.slotCount;
  const physicalCapacity = ensureMeshSsboCapacity(
    internals,
    addressed.physicalDemand,
    physicalUniformSlots,
  );
  if (!physicalCapacity.ok) {
    // An optional fold can fall back without moving the ordinary addresses
    // needed by independent captures; anything else exceeds the budget.
    if (
      foldDispatchPlan === null ||
      addressed.sourceCapacity > physicalCapacity.degradedTo.meshSlotCount ||
      physicalUniformSlots > physicalCapacity.degradedTo.materialSlotCount
    )
      throw physicalDrawCapacityError();
    if (!ensureMeshSsboCapacity(internals, addressed.sourceCapacity, physicalUniformSlots).ok)
      throw physicalDrawCapacityError();
    foldDispatchPlan = null;
    validatedOrdered = addressed.ordinaryOrdered;
    meshDraws?.beginMeshDrawFrame();
  }
  if (foldDispatchPlan !== null) incrementFoldedDrawsMetric(foldDispatchPlan, internals.metrics);

  return {
    validatedOrdered,
    phaseOrderedRows: phaseOrdered ? validatedOrdered : undefined,
    shadowValidatedOrdered,
    foldDispatchPlan,
    materialSlotIndices: materials.slotIndices,
    materialSlots: materials.slots,
    materialBindings: materials.bindings,
    materialBindingSlots: materials.bindingSlots,
    materialSlotCount: materials.slotCount,
  };
}

type SharedMaterialFrame = {
  readonly bindings: readonly GpuDrivenMaterialBinding[];
  readonly sourceScope: RenderResourceScope;
  readonly frame: MaterialFrame;
};

const EMPTY_BINDING_SLOTS: MaterialBindingSlots = new Map();

type MeshDrawRoster = PersistentShadowCasterProjection['meshDraws'];

/** The frame-local material UBO table, truncated in step with its rows. */
export interface MaterialTable {
  slotIndices: FrameList<readonly number[]>;
  slots: readonly MaterialSnapshot[];
  bindings: readonly MaterialBinding[];
  bindingSlots: MaterialBindingSlots;
  slotCount: number;
}

function physicalDrawCapacityError(): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'capacity for every physical draw address in the submission',
    hint: 'increase the draw buffer budget before submitting independent pass rosters',
  });
}

/**
 * M3 / w26: dispatch-ordered render. The dispatch list is pre-sorted by queue
 * (ascending, stable) by the extract stage per plan-strategy D-3. Reorder
 * validated renderables to follow the dispatch order, falling back to extract
 * order for renderables with no matching dispatch entry. ShadowCaster entries
 * order the shadow plan only: every caster pass sits in the opaque queue, so
 * letting it place a row would pin blended draws to spawn order ahead of their
 * sorted view entries.
 */
function dispatchOrderedRenderables(
  validated: DrawRows,
  transparentDispatch: DispatchList,
  ownedRows: boolean,
): DrawRows {
  if (validated.length === 0) return validated;
  const retained = ownedRows ? nativeDispatchOrders.get(validated) : undefined;
  if (retained?.dispatch === transparentDispatch) return retained.rows;
  const rows =
    dispatchOrderMatches(validated, transparentDispatch) || transparentDispatch.length === 0
      ? validated
      : orderDrawRows(validated, transparentDispatch);
  if (ownedRows) nativeDispatchOrders.set(validated, { dispatch: transparentDispatch, rows });
  return rows;
}

/** Native phase output replaces both operands when the submitted order changes. */
const nativeDispatchOrders = new WeakMap<
  DrawRows,
  { readonly dispatch: DispatchList; readonly rows: DrawRows }
>();

function orderDrawRows(validated: DrawRows, transparentDispatch: DispatchList): DrawRows {
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
  return ordered;
}

/** Whether the view entries of the dispatch list already follow `validated`. */
function dispatchOrderMatches(validated: DrawRows, transparentDispatch: DispatchList): boolean {
  if (validated.length === 0) return true;
  let viewEntries = 0;
  for (const de of transparentDispatch) {
    if (de.tags.LightMode === 'ShadowCaster') continue;
    if (de.renderableIndex !== validated.at(viewEntries)?.renderableIndex) return false;
    viewEntries += 1;
  }
  return viewEntries === validated.length;
}

function materialGroupOf(
  entry: ValidatedRenderable,
  sharedMaterials: SharedMaterialFrame | undefined,
): readonly MaterialResource[] {
  if (
    materialUsesSpriteGeometry(
      acceptedMaterialSnapshot(entry.source.material, sharedMaterials?.frame, entry.source),
    )
  ) {
    return [entry.source.material];
  }
  return entry.source.materials.length > 0 ? entry.source.materials : [entry.source.material];
}

/** Intern the material rows of every CPU draw, then append shared GPU-driven bindings. */
function buildMaterialTable(
  materialRows: DrawRows,
  materialBindingClasses: ReadonlyMap<string, string> | undefined,
  sharedMaterials: SharedMaterialFrame | undefined,
): MaterialTable {
  const materialGroups = materialRows.map((entry) => materialGroupOf(entry, sharedMaterials));
  const materialSlotPlan = buildMaterialSlotPlan(materialGroups, (_material, owner) => {
    const source = materialRows.at(owner)?.source;
    return source === undefined ? '' : (materialBindingClasses?.get(`${source.entityKey}`) ?? '');
  });
  const slots = materialSlotPlan.slots.map((material, slot) =>
    acceptedMaterialSnapshot(
      material,
      sharedMaterials?.frame,
      materialRows.at(materialSlotPlan.slotOwners[slot] ?? -1)?.source,
    ),
  );
  const bindings: MaterialBinding[] = materialSlotPlan.slots.map((material, slot) => {
    const owner = materialRows.at(materialSlotPlan.slotOwners[slot] ?? -1);
    if (owner === undefined) throw new Error('material binding has no resource scope');
    return {
      material,
      resourceClass: materialSlotPlan.resourceClasses[slot] ?? '',
      ...(owner.world === undefined ? {} : { world: owner.world }),
      entityKey: owner.source.entityKey,
    };
  });
  const table = {
    bindingSlots: materialSlotsByClass(bindings),
    slotIndices: materialSlotPlan.slotIndices,
    slots,
    bindings,
    slotCount: slots.length,
  };
  if (sharedMaterials !== undefined)
    appendSharedMaterialBindings(table, sharedMaterials, table.bindingSlots);
  return table;
}

/** The retained Scene membership and borrowed live preparation meet at this boundary. */
function buildFrameMaterialTable(
  validated: DrawRows,
  validatedOrdered: DrawRows,
  shadowValidated: DrawRows,
  materialBindingClasses: ReadonlyMap<string, string> | undefined,
  sharedMaterials: SharedMaterialFrame | undefined,
  retainedMaterials: RetainedMaterialRows | undefined,
): MaterialTable {
  const retained = retainedMaterials?.rows;
  const fixedMaterials = sharedMaterials?.frame;
  const useRetained =
    retained !== undefined &&
    fixedMaterials !== undefined &&
    !fixedMaterials.hasBorrowedValues &&
    canRetainMaterialBindings(materialBindingClasses) &&
    retainedMaterials?.renderables === validated &&
    validatedOrdered === validated &&
    retained.reduce((count, rows) => count + rows.length, 0) === validated.length;
  let materials: MaterialTable;
  if (useRetained && retainedMaterials !== undefined) {
    try {
      materials = retainedMaterials.owner.build(
        retained,
        shadowValidated,
        fixedMaterials,
        validatedOrdered,
      );
      if (sharedMaterials !== undefined) appendSharedMaterialBindings(materials, sharedMaterials);
    } catch (error) {
      retainedMaterials.owner.clear();
      throw error;
    }
  } else {
    retainedMaterials?.owner.clear();
    materials = buildMaterialTable(
      [...validatedOrdered, ...shadowValidated],
      materialBindingClasses,
      sharedMaterials,
    );
  }

  return materials;
}

/** Slot index of each (material, resource class) pair already in the table. */
export function materialSlotsByClass(
  bindings: readonly MaterialBinding[],
): Map<MaterialResource, Map<string, number>> {
  const slots = new Map<MaterialResource, Map<string, number>>();
  for (let index = 0; index < bindings.length; index++) {
    const binding = bindings[index];
    if (binding === undefined) continue;
    let classes = slots.get(binding.material);
    if (classes === undefined) {
      classes = new Map();
      slots.set(binding.material, classes);
    }
    classes.set(binding.resourceClass, index);
  }
  return slots;
}

function appendSharedMaterialBindings(
  table: MaterialTable,
  sharedMaterials: SharedMaterialFrame,
  writable?: Map<MaterialResource, Map<string, number>>,
): void {
  const captured =
    table.slotCount === 0 ? capturedGpuMaterialLayout(sharedMaterials.bindings) : undefined;
  if (captured?.layout !== undefined) {
    for (const binding of captured.layout.unique)
      appendSharedMaterialValue(table, sharedMaterials, binding);
    table.bindingSlots = captured.layout.slots;
    table.slotCount = table.slots.length;
    return;
  }
  const base = table.bindingSlots;
  let slots: Map<MaterialResource, ReadonlyMap<string, number>> | undefined = writable;
  for (const binding of sharedMaterials.bindings) {
    const existing = (slots ?? base).get(binding.material);
    if (existing?.has(binding.resourceClass)) continue;
    slots ??= new Map(base);
    // An accepted CPU layout may also belong to other views and earlier frames.
    // Detach only the class map extended by this submission.
    const classes =
      existing === undefined || (writable === undefined && existing === base.get(binding.material))
        ? new Map(existing)
        : (existing as Map<string, number>);
    classes.set(binding.resourceClass, table.slots.length);
    slots.set(binding.material, classes);
    appendSharedMaterialValue(table, sharedMaterials, binding);
  }
  table.bindingSlots = slots ?? base;
  if (captured !== undefined) {
    captured.layout = {
      unique: uniqueSharedMaterialBindings(
        sharedMaterials.bindings,
        table.bindingSlots,
        table.slots.length,
      ),
      slots: table.bindingSlots,
    };
  }
  table.slotCount = table.slots.length;
}

/** Unique plans need no second walk or array; duplicate requirements keep their first World. */
function uniqueSharedMaterialBindings(
  bindings: readonly GpuDrivenMaterialBinding[],
  slots: MaterialBindingSlots,
  length: number,
): readonly GpuDrivenMaterialBinding[] {
  if (length === bindings.length) return bindings;
  const unique: GpuDrivenMaterialBinding[] = new Array(length);
  for (const binding of bindings) {
    const slot = slots.get(binding.material)?.get(binding.resourceClass);
    if (slot === undefined) throw new Error('Captured material binding has no submitted slot');
    unique[slot] ??= binding;
  }
  return Object.freeze(unique);
}

/** Resource scopes and accepted values belong to this submission, never the layout. */
function appendSharedMaterialValue(
  table: MaterialTable,
  sharedMaterials: SharedMaterialFrame,
  binding: GpuDrivenMaterialBinding,
): void {
  const world = sharedMaterials.sourceScope;
  if (world === undefined)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'the asset scope for every shared material',
      hint: 'keep prepared World indices aligned with the frame resource scopes',
    });
  (table.slots as MaterialSnapshot[]).push(
    acceptedMaterialSnapshot(binding.material, sharedMaterials.frame),
  );
  (table.bindings as MaterialBinding[]).push({
    material: binding.material,
    resourceClass: binding.resourceClass,
    world,
  });
}

/** Native addresses and complete GPU material tables cannot be truncated. */
function assertCapacityDegradable(
  degradedTo: Readonly<MeshSsboCapacity>,
  uniformSlotCount: number,
  sharedBindingCount: number,
  meshDraws: MeshDrawRoster | undefined,
): void {
  if (meshDraws !== undefined) throw physicalDrawCapacityError();
  if (sharedBindingCount > 0 && degradedTo.materialSlotCount < uniformSlotCount)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'capacity for the complete GPU material binding table',
      hint: 'increase the material budget or reduce distinct bindings before submitting the scene',
    });
}

/**
 * feat-20260608 mesh-SSBO capacity gate: truncate complete primary and shadow
 * rows against both degraded capacities, shrinking the material table in step.
 */
function truncateToDegradedCapacity(
  materials: MaterialTable,
  degradedTo: Readonly<MeshSsboCapacity>,
  primaryCount: number,
  shadowCount: number,
  shadowGeometryGpuOwned: boolean,
  sharedBindingCount: number,
): { readonly primaryCount: number; readonly shadowCount: number } {
  const materialPrefix = findRenderablePrefixForSlotCapacity(
    materials.slotIndices,
    degradedTo.materialSlotCount,
  );
  const retainedPrimaryCount = Math.min(primaryCount, materialPrefix, degradedTo.meshSlotCount);
  const retainedShadowCount = Math.min(
    shadowCount,
    Math.max(0, materialPrefix - primaryCount),
    shadowGeometryGpuOwned
      ? Number.POSITIVE_INFINITY
      : degradedTo.meshSlotCount - retainedPrimaryCount,
  );
  // Shadow material rows follow the retained primary prefix even when the
  // primary mesh capacity is exhausted. Preserve their original slot values.
  materials.slotIndices = [
    ...materials.slotIndices.slice(0, retainedPrimaryCount),
    ...materials.slotIndices.slice(primaryCount, primaryCount + retainedShadowCount),
  ];
  if (sharedBindingCount === 0)
    materials.slotCount = materialSlotCountForPrefix(
      materials.slotIndices,
      materials.slotIndices.length,
    );
  materials.slots = materials.slots.slice(0, materials.slotCount);
  materials.bindings = materials.bindings.slice(0, materials.slotCount);
  materials.bindingSlots = materialSlotsByClass(materials.bindings);
  return { primaryCount: retainedPrimaryCount, shadowCount: retainedShadowCount };
}

/**
 * Re-key each non-singleton fold bucket from `renderableIndex` to the
 * validated-ordered index consumed by the dispatch loops, which skip non-head
 * members and emit one instanced drawIndexed per bucket head.
 */
function buildUniformCappedFoldPlan(
  internals: RenderSystemInternals,
  foldBuckets: readonly FoldBucket[],
  validatedOrdered: DrawRows,
): FoldDispatchPlan | null {
  if (foldBuckets.length === 0) return null;
  const renderableToValidatedIdx = new Map<number, number>();
  for (let i = 0; i < validatedOrdered.length; i++) {
    const e = validatedOrdered.at(i);
    if (e === undefined) continue;
    renderableToValidatedIdx.set(e.renderableIndex, i);
  }
  return buildFoldDispatchPlan(
    foldBuckets,
    renderableToValidatedIdx,
    internals.device.caps.storageBuffer ? Number.POSITIVE_INFINITY : FOLD_UNIFORM_INSTANCE_CAP,
  );
}

/**
 * A compact pass roster never owns physical transform addresses. Native scenes
 * retain their allocations until source retirement; explicit borrowed frames
 * reserve one submission's source, shadow and folded ranges here. All ordinary
 * rows are allocated first so an optional fold can fall back without moving
 * the ordinary addresses needed by independent captures.
 */
function addressPhysicalRows(
  validatedOrdered: DrawRows,
  shadowValidatedOrdered: DrawRows,
  foldDispatchPlan: FoldDispatchPlan | null,
  meshDraws: MeshDrawRoster | undefined,
  ownedRows: boolean,
): {
  readonly validatedOrdered: DrawRows;
  readonly shadowValidatedOrdered: DrawRows;
  readonly ordinaryOrdered: DrawRows;
  readonly sourceCapacity: number;
  readonly physicalDemand: number;
} {
  let transientSlot = 0;
  let sourceCapacity = 0;
  const sourceAddress = (entry: ValidatedRenderable): ValidatedRenderable => {
    const meshSlot =
      meshDraws?.meshDrawSlot(entry.source, false, entry.sceneSlot) ?? transientSlot++;
    sourceCapacity = Math.max(sourceCapacity, meshSlot + 1);
    if (entry.meshSlot === meshSlot && entry.foldedMeshSlot === undefined) return entry;
    if (entry.foldedMeshSlot === undefined) return { ...entry, meshSlot };
    const { foldedMeshSlot: _previousFold, ...source } = entry;
    source.meshSlot = meshSlot;
    return source;
  };
  const retained =
    ownedRows && meshDraws !== undefined
      ? meshDraws.addressOwnedMeshDrawRows(validatedOrdered)
      : undefined;
  if (retained !== undefined) sourceCapacity = retained.capacity;
  const ordinaryOrdered = retained?.rows ?? validatedOrdered.map(sourceAddress);
  const shadowOrdered = shadowValidatedOrdered.map(sourceAddress);
  let physicalDemand = sourceCapacity;
  let foldedOrdered = ordinaryOrdered;
  if ((foldDispatchPlan?.headBuckets.size ?? 0) > 0) {
    foldedOrdered = ordinaryOrdered.map((entry, index) => {
      if (!foldDispatchPlan?.headBuckets.has(index)) return entry;
      const foldedMeshSlot =
        meshDraws?.meshDrawSlot(entry.source, true, entry.sceneSlot) ?? transientSlot++;
      physicalDemand = Math.max(physicalDemand, foldedMeshSlot + 1);
      return { ...entry, foldedMeshSlot };
    });
  }
  return {
    validatedOrdered: foldedOrdered,
    shadowValidatedOrdered: shadowOrdered,
    ordinaryOrdered,
    sourceCapacity,
    physicalDemand,
  };
}

/** Retire GPU owners absent from this submission. Temporary membership is bounded
 * by resident resources even when a much larger scene changes every frame. */
export function cleanPerFrameCaches(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  validated: Iterable<ValidatedRenderable>,
  retainedEntityKeys?: ReadonlySet<number>,
  retainedFoldKeys?: Iterable<number>,
): void {
  const { errorRegistry } = internals;
  const {
    instanceBuffers,
    instanceBufferChunks,
    transientInstanceBuffers,
    materialBgPerEntity,
    instancesBgPerEntity,
  } = frameState;
  if (transientInstanceBuffers !== undefined)
    disposeTransientInstanceBuffers(transientInstanceBuffers, errorRegistry);
  let absentEntities: Set<number> | undefined;
  if (materialBgPerEntity.size !== 0 || instancesBgPerEntity.size !== 0) {
    absentEntities = new Set(materialBgPerEntity.keys());
    for (const key of instancesBgPerEntity.keys()) absentEntities.add(key);
  }
  let absentBuffers: Set<InstanceBufferCacheKey> | undefined;
  if (instanceBuffers.size !== 0 || (instanceBufferChunks?.size ?? 0) !== 0) {
    absentBuffers = new Set(instanceBuffers.keys());
    if (instanceBufferChunks !== undefined)
      for (const key of instanceBufferChunks.keys()) absentBuffers.add(key);
    if (retainedFoldKeys !== undefined)
      for (const key of retainedFoldKeys) absentBuffers.delete(key);
  }
  if (absentEntities === undefined && absentBuffers === undefined) return;
  if (retainedEntityKeys !== undefined)
    for (const key of retainedEntityKeys) {
      absentEntities?.delete(key);
      absentBuffers?.delete(key);
    }
  if ((absentEntities?.size ?? 0) + (absentBuffers?.size ?? 0) === 0) return;
  for (const { source } of validated) {
    absentEntities?.delete(source.entityKey);
    if (absentBuffers !== undefined && absentBuffers.size !== 0) {
      absentBuffers.delete(source.entityKey);
      if (source.instances !== undefined && absentBuffers.size !== 0)
        absentBuffers.delete(instanceCollectionCacheKey(source.instances));
    }
    if ((absentEntities?.size ?? 0) + (absentBuffers?.size ?? 0) === 0) return;
  }
  if (absentEntities !== undefined)
    for (const key of absentEntities) {
      materialBgPerEntity.delete(key);
      instancesBgPerEntity.delete(key);
    }
  if (absentBuffers === undefined) return;
  for (const key of absentBuffers) {
    const entry = instanceBuffers.get(key);
    if (entry !== undefined) {
      if (!entry.buffer.isDestroyed) {
        const result = entry.buffer.destroy();
        if (!result.ok) errorRegistry.fire(result.error);
      }
      instanceBuffers.delete(key);
    }
    const chunks = instanceBufferChunks?.get(key);
    if (chunks !== undefined) {
      disposeInstanceBuffers(chunks, errorRegistry);
      instanceBufferChunks?.delete(key);
    }
  }
}

/** Queue only admitted multi-draw Sprite runs; other work stays direct. */
export function computeFoldBuckets(
  world: RenderResourceScope,
  frameState: RenderFrameState,
  transparentDispatch: DispatchList,
  rows:
    | readonly import('./mesh-ssbo').FoldRenderableLike[]
    | (() => readonly import('./mesh-ssbo').FoldRenderableLike[]),
): readonly FoldBucket[] {
  if (transparentDispatch.length === 0) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }
  const transparentSortCfg = world.transparentSort;

  // Only layer-Z / layer-Y modes can produce non-singleton fold buckets.
  // The other modes have no fold work and need no source projection.
  if (
    transparentSortCfg.mode !== TRANSPARENT_SORT_MODE_LAYER_Z &&
    transparentSortCfg.mode !== TRANSPARENT_SORT_MODE_LAYER_Y
  ) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }

  // One row-level skip flag cannot represent multiple authored passes.
  // Preserve that conservative admission before asking the fold owner for
  // actual multi-draw runs. It leaves incompatible entries as ordering barriers.
  const renderables = typeof rows === 'function' ? rows() : rows;
  const drawn = new Set<number>();
  for (const entry of transparentDispatch) {
    if (drawn.has(entry.renderableIndex)) {
      frameState.lastFoldBucketCount = 0;
      return [];
    }
    drawn.add(entry.renderableIndex);
  }
  const foldBuckets = foldDispatchBuckets(
    transparentDispatch,
    transparentSortCfg.mode,
    renderables,
  );
  frameState.lastFoldBucketCount = foldBuckets.length;
  return foldBuckets;
}
