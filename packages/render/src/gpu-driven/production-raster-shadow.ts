import { vertexLayoutHasColor } from '@forgeax/engine-geometry';
import type { BindGroup, Buffer, Result } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuScene } from '../gpu-scene';
import type { SceneContentCursor } from '../gpu-scene-content-boxes';
import { reflectedRenderState } from '../material-render-state';
import type { RecordProfileRunner } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type { MaterialSnapshot } from '../render-system-extract';
import { FrameSet } from '../scene/frame-set';
import { type ShadowMaterialContent, sameShadowMaterial } from '../scene/material-shadow-content';
import { slotContent } from '../scene/mesh-draw';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import type { BatchPass } from './batch-execution';
import { batchLevelStride, batchLodLevelCount } from './batch-layout';
import type { GpuDrivenBatch, GpuDrivenBatchBinding, SubmissionPlan } from './batch-topology';
import type { BatchExecutions } from './material-artifacts';
import { PreparedRasterBundleCache } from './prepared-raster-bundle';
import type { ShadowViewRequest } from './production-raster';
import type { MaterialAbiRasterAdapter } from './production-raster-material';
import { type FilteredProductionPlan, sameMaterialArtifact } from './production-raster-prepare';
import { type ShadowArtifactObservations, shadowMaterialKey } from './production-raster-support';
import {
  restrictShadowCasterClasses,
  type ShadowCasterClasses,
  ShadowSlotSelection,
} from './shadow-caster-classes';
import { filteredRows, type ShadowProjectionDiffs } from './shadow-projection-diffs';
import { publishReadonlyMap } from './shadow-projection-publication';
import { staticShadowViewIdentity } from './shadow-view-identity';
import type { ShadowViewStatePool } from './shadow-views';
import { shadowViewHasStaticLayer } from './shadow-views';
import type { GpuDrivenOcclusionCamera } from './view-gpu';

export interface GpuDrivenShadowBatchProjection {
  /** Batch-owned command closure; retained projection edits validate its physical inputs. */
  readonly bundles: PreparedRasterBundleCache;
  readonly mesh: MeshGpuHandles;
  readonly meshContentEpoch: number;
  readonly meshBindGroup: BindGroup;
  /** One visible-segment window per LOD level command, in level order. */
  readonly visibleBindGroups: readonly BindGroup[];
  readonly deformation: 'rigid' | 'skin';
  /** Actual producer-selected shadow-pass artifact for this batch. */
  readonly shadowArtifact: MaterialShaderArtifact;
  /** Pass entry points selected by the authored ShadowCaster dispatch. */
  readonly shadowVertexEntry?: string;
  readonly shadowFragmentEntry?: string;
  readonly shadowRenderState?: MaterialRenderState;
  /** Material snapshot used to assemble the receipt-owned alpha-mask BG. */
  readonly material: MaterialSnapshot;
  /** Geometry-owned COLOR_0 fact shared by main and shadow ABI variants. */
  readonly vertexColorAvailable: boolean;
}

export type ShadowBatchProjections = ReadonlyMap<number, GpuDrivenShadowBatchProjection>;

/** A shadow view request without the camera-cull and layer-mode selectors. */
export type ShadowViewCacheRequest = Omit<ShadowViewRequest, 'cameraCull' | 'staticLayer'>;

/** The physical draw bindings of one shadow view. */
export interface ShadowViewBindings {
  readonly visibleBuffer: Buffer;
  readonly meshBinding: BindGroup;
  readonly skinMeshBinding: BindGroup | undefined;
}

/** Draw bindings follow physical resources and topology, independently of depth invalidation. */
export interface ShadowProjectionSource extends ShadowViewBindings {
  readonly plan: SubmissionPlan;
  filtered: FilteredProductionPlan;
  /** Executions every projected material was validated against. */
  executions?: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>;
  artifacts: ShadowArtifactObservations;
  readonly visibleBindingIdentity: object;
  readonly skinVisibleBindingIdentity: object | undefined;
}

/** The shared facts of one `updateShadowViews` call and its per-call caches. */
export interface ShadowProjectionPass {
  /** Only fresh private recorder requests can transfer into the pool read domain. */
  readonly ownedRequests: boolean;
  readonly filtered: FilteredProductionPlan;
  readonly executions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>;
  readonly artifacts: ShadowArtifactObservations;
  readonly diffs: ShadowProjectionDiffs;
  readonly scene: PersistentGpuDrivenState;
  readonly pool: ShadowViewStatePool;
  readonly sourcePlan: SubmissionPlan;
  readonly projectionSource: FilteredProductionPlan['projectionSource'];
  readonly shadowScene: PersistentGpuDrivenState['scene'];
  readonly inputReads: import('../gpu-scene-inputs').GpuInputReadFrame;
  readonly camera: CameraSnapshot;
  readonly capsuleShadowDirectional: boolean;
  readonly directMaterials: import('../scene/material-dispatch').MaterialFrame | undefined;
  readonly shadowMaterials: ShadowMaterialContent | undefined;
  readonly profilePhase: RecordProfileRunner | undefined;
  readonly materialRaster: MaterialAbiRasterAdapter;
  readonly meshBinding: BindGroup;
  readonly visibleBindingIdentity: object;
  readonly skinVisibleBindingIdentity: object | undefined;
  cullCamera: GpuDrivenOcclusionCamera | undefined;
  preparedByBatch: ReadonlyMap<number, FilteredProductionPlan['batches'][number]> | undefined;
  /** Projections published by this call, keyed by view identity. */
  readonly next: Map<string, ShadowBatchProjections>;
}

/** The physical draw facts a GPU shadow batch projects in one view. */
export interface ShadowBatchFacts {
  readonly raster: MaterialAbiRasterAdapter;
  readonly mesh: MeshGpuHandles;
  readonly meshContentEpoch: number;
  readonly meshBindGroup: BindGroup;
  readonly deformation: 'rigid' | 'skin';
  readonly shadowArtifact: MaterialShaderArtifact;
  readonly shadowRenderState: MaterialRenderState | undefined;
  readonly shadowEntry: BatchPass;
  readonly material: MaterialSnapshot;
}

type ChannelScene = Pick<GpuScene, 'contentCursor' | 'changedSlotsSince'>;
type ChannelSource = Pick<PersistentGpuDrivenState, 'slots' | 'slotAt'>;

interface ChannelSlots {
  readonly scene: ChannelScene;
  readonly content: SceneContentCursor;
  readonly slots: FrameSet;
}

function admitsChannels(row: RenderSceneSlot | undefined, mask: number): boolean {
  if (row === undefined) return false;
  const content = slotContent(row);
  return (
    content.shadowCaster !== false &&
    content.authorVisible !== false &&
    (mask === 0xffffffff || ((content.shadowChannels ?? 0xffffffff) & mask) !== 0)
  );
}

/**
 * Per-mask caster channel membership. Scene journal changes patch each
 * retained set; only the first request of a mask or lost history enumerates.
 */
export class ShadowChannelSlots {
  #masks = new Map<number, ChannelSlots>();
  #requested = new Set<number>();

  select(mask: number, source: ChannelSource, scene: ChannelScene): FrameSet {
    this.#requested.add(mask);
    const retained = this.#masks.get(mask);
    const content = scene.contentCursor;
    if (retained?.scene === scene && retained.content === content) return retained.slots;
    const changed =
      retained?.scene === scene ? scene.changedSlotsSince(retained.content) : undefined;
    let slots = retained?.slots ?? new FrameSet();
    if (changed === undefined) {
      slots = FrameSet.from(
        (function* () {
          for (const row of source.slots) if (admitsChannels(row, mask)) yield row.slot;
        })(),
      );
    } else {
      let edits: Map<number, boolean> | undefined;
      for (const slot of changed) {
        const admitted = admitsChannels(source.slotAt(slot), mask);
        if (slots.has(slot) === admitted) continue;
        edits ??= new Map();
        edits.set(slot, admitted);
      }
      if (edits !== undefined) slots = slots.edit(edits);
    }
    this.#masks.set(mask, { scene, content, slots });
    return slots;
  }

  /** Forget masks no view requested since the last call. */
  retainRequested(): void {
    for (const mask of this.#masks.keys()) if (!this.#requested.has(mask)) this.#masks.delete(mask);
    this.#requested.clear();
  }
}

/** Caster channels narrow the view's candidates to the slots sharing a channel bit. */
export function restrictShadowCasterChannels(
  requested: ShadowViewRequest,
  channels: ShadowChannelSlots,
  pass: Pick<ShadowProjectionPass, 'scene' | 'shadowScene'>,
): ShadowViewRequest {
  const mask = requested.casterChannels ?? 0xffffffff;
  if (mask === 0xffffffff && requested.staticLayer !== false) return requested;
  const slots = channels.select(mask, pass.scene, pass.shadowScene);
  const restriction = requested.candidatePrimitiveIndices;
  if (restriction === undefined) return { ...requested, candidatePrimitiveIndices: slots };
  let allowed: FrameSet | ShadowSlotSelection;
  if (FrameSet.isFixed(restriction) || ShadowSlotSelection.isFixed(restriction))
    allowed = restriction;
  else {
    allowed = FrameSet.from(
      (function* () {
        for (const slot of restriction) if (Number.isSafeInteger(slot) && slot >= 0) yield slot;
      })(),
    );
  }
  return { ...requested, candidatePrimitiveIndices: new ShadowSlotSelection(slots, allowed) };
}

/** Shared pure layer selection; execution/depth publication stays with the ordinary pool. */
export function shadowLayerRequests(
  input: ShadowViewRequest,
  classes: ShadowCasterClasses | undefined,
) {
  if (classes === undefined) return { final: input };
  if (!shadowViewHasStaticLayer(input.identity)) return { final: input };
  const selected = restrictShadowCasterClasses(classes, input.candidatePrimitiveIndices);
  if (input.staticLayer === false)
    return { final: { ...input, candidatePrimitiveIndices: selected.casterSlots } };
  return {
    static: {
      ...input,
      identity: staticShadowViewIdentity(input.identity),
      candidatePrimitiveIndices: selected.staticSlots,
      ignoredChangeSlots: classes.dynamicSlots,
    },
    final: { ...input, candidatePrimitiveIndices: selected.dynamicSlots },
  };
}

export function preparedShadowRows(
  pass: Pick<ShadowProjectionPass, 'filtered' | 'preparedByBatch'>,
): ReadonlyMap<number, FilteredProductionPlan['batches'][number]> {
  pass.preparedByBatch ??= filteredRows(pass.filtered);
  return pass.preparedByBatch;
}

export function sameShadowBindings(
  previous: ShadowProjectionSource,
  pass: ShadowProjectionPass,
  bindings: ShadowViewBindings,
): boolean {
  return (
    previous.visibleBuffer === bindings.visibleBuffer &&
    previous.meshBinding === bindings.meshBinding &&
    previous.skinMeshBinding === bindings.skinMeshBinding &&
    previous.visibleBindingIdentity === pass.visibleBindingIdentity &&
    previous.skinVisibleBindingIdentity === pass.skinVisibleBindingIdentity
  );
}

/**
 * An unchanged batch owner with unchanged prepared row, execution and
 * physical bindings keeps its projection without re-deriving it.
 */
export function retainedShadowOwners(
  pass: ShadowProjectionPass,
  boundSource: ShadowProjectionSource | undefined,
): ((batch: GpuDrivenBatch) => boolean) | undefined {
  if (boundSource === undefined || boundSource.artifacts !== pass.artifacts) return undefined;
  return pass.diffs.retainedOwners(boundSource.plan, boundSource.filtered, boundSource.executions);
}

/** The previous projection a retained owner keeps, if any. */
export function retainedShadowProjection(
  retainedOwners: ((batch: GpuDrivenBatch) => boolean) | undefined,
  previousProjections: ShadowBatchProjections | undefined,
  batch: GpuDrivenBatch,
): GpuDrivenShadowBatchProjection | undefined {
  if (retainedOwners === undefined || !retainedOwners(batch)) return undefined;
  return previousProjections?.get(batch.batchId);
}

/** A receipt this view consumed changed its observed publication fields. */
export function shadowArtifactsChanged(
  previous: ShadowProjectionSource,
  artifacts: ShadowArtifactObservations,
): boolean {
  if (previous.artifacts === artifacts) return false;
  return previous.plan.batches.some((batch) => {
    const key = shadowMaterialKey(batch);
    return artifacts.has(key) && previous.artifacts.get(key)?.key !== artifacts.get(key)?.key;
  });
}

/** A row this view projected now names another mesh or mesh content. */
export function shadowMeshesChanged(
  previous: ShadowProjectionSource,
  pass: ShadowProjectionPass,
  previousProjections: ShadowBatchProjections | undefined,
): boolean {
  if (previous.filtered === pass.filtered) return false;
  return pass.diffs.rowsChangedSince(previous.filtered).changed.some((prepared) => {
    const projection = previousProjections?.get(prepared.batch.batchId);
    return (
      projection !== undefined &&
      (projection.mesh !== prepared.mesh ||
        projection.meshContentEpoch !== prepared.meshContentEpoch)
    );
  });
}

/** A changed execution table replaced the material content of a projected GPU batch. */
export function shadowMaterialsChanged(
  previous: ShadowProjectionSource,
  pass: ShadowProjectionPass,
  previousProjections: ShadowBatchProjections | undefined,
): boolean {
  if (previous.executions === pass.executions) return false;
  if (
    previous.executions !== undefined &&
    pass.diffs.executionsChangedSince(previous.executions).size === 0
  )
    return false;
  return previous.plan.batches.some((batch) => {
    const execution =
      batch.binding === undefined ? undefined : pass.executions.get(batch.binding)?.shadow;
    return (
      execution?.route === 'gpu' &&
      !sameShadowMaterial(previousProjections?.get(batch.batchId)?.material, execution.material)
    );
  });
}

function sameRenderState(
  left: MaterialRenderState | undefined,
  right: MaterialRenderState | undefined,
): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** The retained projection still matches this batch's shadow execution and entries. */
export function sameShadowExecution(
  batch: GpuDrivenBatch,
  index: number,
  previous: ShadowProjectionSource,
  previousProjections: ShadowBatchProjections,
  executions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>,
): boolean {
  // The same retained row, validated against the same execution table.
  if (previous.executions === executions && previous.plan.batches.at(index) === batch) return true;
  if (batch.visibleCapacity === 0) return !previousProjections.has(batch.batchId);
  const execution = batch.binding === undefined ? undefined : executions.get(batch.binding)?.shadow;
  const projection = previousProjections.get(batch.batchId);
  if (execution?.route !== 'gpu' || projection?.material !== execution.material) return false;
  const entry = execution.pass;
  return (
    projection.shadowVertexEntry === entry.vertexEntry &&
    projection.shadowFragmentEntry === entry.fragmentEntry &&
    sameRenderState(
      projection.shadowRenderState,
      reflectedRenderState(entry.renderState, batch.key.reflected === true),
    )
  );
}

/** The batch's indirect command and visible window keep their retained addresses. */
function sameShadowCommandWindow(previous: GpuDrivenBatch | undefined, batch: GpuDrivenBatch) {
  return (
    previous?.batchId === batch.batchId &&
    previous.visibleBase === batch.visibleBase &&
    (previous.visibleAllocationCapacity ?? previous.visibleCapacity) ===
      (batch.visibleAllocationCapacity ?? batch.visibleCapacity) &&
    previous.indirectOffset === batch.indirectOffset &&
    batchLevelStride(previous) === batchLevelStride(batch)
  );
}

/** A retained projection whose physical closure equals the one this view would build. */
export function sameShadowBatchProjection(
  previousBatch: GpuDrivenBatch | undefined,
  batch: GpuDrivenBatch,
  previous: GpuDrivenShadowBatchProjection,
  facts: ShadowBatchFacts,
): boolean {
  return (
    sameShadowCommandWindow(previousBatch, batch) &&
    previous.mesh === facts.mesh &&
    previous.meshContentEpoch === facts.meshContentEpoch &&
    previous.meshBindGroup === facts.meshBindGroup &&
    previous.deformation === facts.deformation &&
    previous.visibleBindGroups.length === batchLodLevelCount(batch) &&
    previous.material === facts.material &&
    previous.shadowVertexEntry === facts.shadowEntry.vertexEntry &&
    previous.shadowFragmentEntry === facts.shadowEntry.fragmentEntry &&
    sameRenderState(previous.shadowRenderState, facts.shadowRenderState) &&
    sameMaterialArtifact(previous.shadowArtifact, facts.shadowArtifact)
  );
}

/** Unchanged observations prove the consumed receipt; otherwise compare this batch's key. */
export function sameConsumedArtifact(
  batch: GpuDrivenBatch,
  previous: ShadowArtifactObservations | undefined,
  artifacts: ShadowArtifactObservations,
): boolean {
  if (previous === artifacts) return true;
  const key = shadowMaterialKey(batch);
  return previous?.get(key)?.key === artifacts.get(key)?.key;
}

export function createShadowBatchProjection(
  batch: GpuDrivenBatch,
  facts: ShadowBatchFacts,
  visibleBuffer: Buffer,
  bundles: PreparedRasterBundleCache | undefined,
): Result<GpuDrivenShadowBatchProjection, RhiError> {
  const visibleBindGroups: BindGroup[] = [];
  const levelStride = batchLevelStride(batch);
  for (let level = 0; level < batchLodLevelCount(batch); level += 1) {
    const visibleBindGroup = facts.raster.shadowVisibleWindowBindGroupForBuffer(
      visibleBuffer,
      batch.visibleBase + level * levelStride,
      batch.visibleAllocationCapacity ?? batch.visibleCapacity,
    );
    if (!visibleBindGroup.ok) return visibleBindGroup;
    visibleBindGroups.push(visibleBindGroup.value);
  }
  const { shadowEntry, shadowRenderState } = facts;
  return ok({
    bundles: bundles ?? new PreparedRasterBundleCache(),
    mesh: facts.mesh,
    meshContentEpoch: facts.meshContentEpoch,
    meshBindGroup: facts.meshBindGroup,
    visibleBindGroups,
    deformation: facts.deformation,
    shadowArtifact: facts.shadowArtifact,
    ...(shadowRenderState === undefined ? {} : { shadowRenderState }),
    ...(shadowEntry.vertexEntry === undefined
      ? {}
      : { shadowVertexEntry: shadowEntry.vertexEntry }),
    ...(shadowEntry.fragmentEntry === undefined
      ? {}
      : { shadowFragmentEntry: shadowEntry.fragmentEntry }),
    material: facts.material,
    vertexColorAvailable: vertexLayoutHasColor(facts.mesh.layoutProjection),
  });
}

/** A kept projection set republishes as is; edited sets publish a frozen map. */
export function publishedShadowProjections(
  projections: Map<number, GpuDrivenShadowBatchProjection> | undefined,
  previous: ShadowBatchProjections | undefined,
): ShadowBatchProjections {
  if (projections === undefined && previous !== undefined) return previous;
  return publishReadonlyMap(projections ?? new Map());
}

/** One physical shadow recipe shared by ordinary projection and off-frame Source preparation. */
export function captureShadowBatchFacts(
  pass: Pick<
    ShadowProjectionPass,
    'filtered' | 'preparedByBatch' | 'executions' | 'materialRaster'
  >,
  batch: GpuDrivenBatch,
  viewBindings: ShadowViewBindings,
  skinRaster: MaterialAbiRasterAdapter | undefined,
): Result<ShadowBatchFacts, RhiError> {
  const prepared = preparedShadowRows(pass).get(batch.batchId);
  if (prepared === undefined) {
    return err(
      new RhiError({
        code: 'internal-error',
        expected: `prepared shadow mesh batch ${batch.batchId}`,
        hint: 'keep filtered shadow topology and per-view projection on one frame identity',
      }),
    );
  }
  const binding = batch.binding;
  const execution = binding === undefined ? undefined : pass.executions.get(binding)?.shadow;
  if (binding === undefined || execution?.route !== 'gpu') {
    return err(
      new RhiError({
        code: 'internal-error',
        expected: `accepted shared material execution for shadow batch ${batch.batchId}`,
        hint: 'retain the same geometry binding and material frame through shadow projection',
      }),
    );
  }
  const deformation = batch.prepared?.identity.deformation ?? 'rigid';
  const skin = deformation === 'skin';
  const raster = skin ? skinRaster : pass.materialRaster;
  const meshBindGroup = skin ? viewBindings.skinMeshBinding : viewBindings.meshBinding;
  const shadowArtifact = execution.artifact;
  if (
    raster === undefined ||
    meshBindGroup === undefined ||
    prepared.artifact === undefined ||
    shadowArtifact === undefined
  ) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: `${skin ? 'skinned ' : ''}selected shadow MaterialProgramAbi artifact`,
        hint: 'publish a matching shadow-pass program before entering the capable shadow lane',
      }),
    );
  }
  return ok({
    raster,
    mesh: prepared.mesh,
    meshContentEpoch: prepared.meshContentEpoch,
    meshBindGroup,
    deformation,
    shadowArtifact,
    shadowRenderState: reflectedRenderState(
      execution.pass.renderState,
      batch.key.reflected === true,
    ),
    shadowEntry: execution.pass,
    material: execution.material,
  });
}
