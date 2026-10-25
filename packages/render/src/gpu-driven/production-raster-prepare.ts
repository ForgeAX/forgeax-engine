import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import {
  materialArtifactProgramIdentity,
  sameMaterialArtifactProgram,
} from '../assembly/material/artifact-program-identity';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { reflectedRenderState } from '../material-render-state';
import { getOpaqueResourceIdentity, worldEntityKey } from '../record/frame-snapshot';
import { geometryRenderStateForTopology } from '../record/main-pass-material';
import type { MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { SceneSlotFrame, SlotIdentityKeys } from '../scene/scene-slots';
import { type BatchExecution, captureBatchLod } from './batch-execution';
import { batchVisibleSpan, GPU_DRIVEN_LOD_LEVEL_CAPACITY } from './batch-layout';
import { MemberCandidates } from './batch-members';
import type {
  GpuDrivenBatch,
  GpuDrivenBatchLod,
  GpuDrivenBatchMember,
  GpuDrivenCandidate,
  SubmissionPlan,
} from './batch-topology';
import { GpuDrawSelection } from './draw-selection';
import { fixedTaskPlan } from './fixed-task-plan';
import { capturedPreparedMaterialArtifactKey } from './prepared-draw';
import {
  lodCoverageMayFade,
  lodCrossfadeCapable,
  prepareLodProjectionPlan,
} from './production-raster-lod';
import type { PreparedAssemblyInputs } from './retained-batch-inputs';

export interface PreparedBatch {
  readonly batch: GpuDrivenBatch;
  readonly rasterClassKey: string;
  /** Stock recording binds the current resident mesh, independently of graph resources. */
  readonly recordingRasterClassKey: string;
  readonly mesh: MeshGpuHandles;
  readonly meshContentEpoch: number;
  /** Exact producer artifact selected by every draw in this homogeneous batch. */
  readonly artifact: MaterialShaderArtifact;
  readonly renderState: MaterialRenderState | undefined;
  readonly standardTextureMask: number | undefined;
  readonly materialBindingClass: string;
  /** Stable World attachment key used to join same-submit GPU counters. */
  readonly worldKey: number;
}

export function meshSupportsBatch(mesh: MeshGpuHandles, batch: GpuDrivenBatch): boolean {
  // A missing lower-detail GPU range is a readiness fact, not a root-mesh
  // incompatibility. Keep the selector candidate admitted so it can choose a
  // physically resident finer level or fall back to LOD0.
  return batch.key.drawKind === 'indexed'
    ? mesh.indexed && mesh.indexBuffer !== null
    : !mesh.indexed;
}

export interface PreparedBatchFacts {
  readonly mesh: MeshGpuHandles;
  readonly artifact: MaterialShaderArtifact;
  readonly material: Pick<MaterialSnapshot, 'materialHandle' | 'standardTextureMask'>;
  readonly renderState: MaterialRenderState | undefined;
  readonly worldKey: number;
  readonly rasterClassKey: string;
  readonly recordingRasterClassKey: string;
}

/**
 * Everything a compiled raster encoder captures. Candidate membership,
 * visible windows, indirect offsets, LOD ranges and material slots are live
 * data and cannot invalidate this identity. Texture/sampler bindings and
 * coverage admission still split source batches; encoding reads their current
 * material group, while the shadow owner selects its coverage variant.
 * Pass routing is live; vertex layout and the selected shader's UV ABI already
 * describe pipeline inputs independently of mesh UV-count metadata.
 */
function rasterClassKeys(
  batch: GpuDrivenBatch,
  mesh: MeshGpuHandles,
  artifact: MaterialShaderArtifact,
  material: MaterialSnapshot,
  worldKey: number,
  renderState: MaterialRenderState | undefined,
) {
  const key = batch.key;
  const fields = [
    worldKey,
    key.drawKind,
    key.topology,
    key.pipelineClass,
    key.preparedIdentity ?? '',
    batch.prepared?.identity.deformation ?? 'rigid',
    material.standardTextureMask ?? -1,
    renderState ?? null,
    getOpaqueResourceIdentity(mesh.vertexBuffer.handle as object),
    mesh.indexBuffer === null ? 0 : getOpaqueResourceIdentity(mesh.indexBuffer.handle as object),
    mesh.layoutProjection.digest,
    mesh.vboBytes,
    mesh.iboBytes,
    mesh.indexFormat,
    artifact.material,
    artifact.pass,
    artifact.receipt?.sceneIndexEntry ?? '',
    artifact.vertexEntry ?? artifact.receipt?.sceneIndexEntry ?? '',
    artifact.fragmentEntry ?? '',
    artifact.layoutIdentity,
    artifact.receipt?.receiptIdentity ?? '',
    artifact.receipt?.generation ?? 0,
    artifact.variantSet ?? '',
    artifact.uvSetCount ?? -1,
    artifact.reflectionFallbackOutputAvailable === true,
    materialArtifactProgramIdentity(artifact),
    // Selects the Standard surface's LOD coverage discard specialization.
    lodCoverageMayFade(batch),
  ];
  const rasterClassKey = JSON.stringify(fields);
  // Main-pass direct draws already bind residency-owned mesh buffers outside
  // the graph. Stock indirect recording follows the same lifetime authority;
  // inter-pass Scene/visibility/indirect buffers remain graph declarations.
  fields[8] = fields[9] = fields[11] = fields[12] = 0;
  return { rasterClassKey, recordingRasterClassKey: JSON.stringify(fields) };
}

/** One geometry × accepted material × Pass join, never one record per instance. */
export interface PreparedBatchRows {
  readonly source: GpuDrivenBatch;
  readonly lod: GpuDrivenBatchLod | undefined;
  readonly fact: PreparedBatchFacts | undefined;
  readonly mesh: MeshGpuHandles | undefined;
  readonly meshContentEpoch: number | undefined;
}

export interface PreparationInputs {
  readonly mesh: MeshGpuHandles | undefined;
  readonly worldKeys: readonly number[] | undefined;
  readonly execution: BatchExecution;
}

/** Observe bounded raw task columns on reuse without allocating a comparison graph. */
export function samePreparedBatchLod(
  captured: GpuDrivenBatchLod | undefined,
  batch: GpuDrivenBatch,
  mesh: MeshGpuHandles | undefined,
): boolean {
  const lod = batch.lod;
  if (captured === undefined || lod === undefined) return captured === lod;
  if (
    captured.hysteresis !== lod.hysteresis ||
    captured.crossfade !== lod.crossfade ||
    captured.coverages.length !== Math.min(lod.coverages.length, GPU_DRIVEN_LOD_LEVEL_CAPACITY)
  )
    return false;
  for (let i = 0; i < captured.coverages.length; i++)
    if (!Object.is(captured.coverages[i], lod.coverages[i])) return false;
  const count = Math.max(
    0,
    Math.min(
      mesh?.lodRanges === undefined ? (lod.ranges?.length ?? 0) : mesh.lodRanges.length - 1,
      GPU_DRIVEN_LOD_LEVEL_CAPACITY - 1,
    ),
  );
  if (
    (captured.ranges?.length ?? 0) !== count ||
    (captured.ranges === undefined) !== (lod.ranges === undefined && mesh?.lodRanges === undefined)
  )
    return false;
  for (let i = 0; i < count; i++) {
    const before = captured.ranges?.[i];
    let next: NonNullable<GpuDrivenBatchLod['ranges']>[number];
    if (mesh?.lodRanges === undefined) next = lod.ranges?.[i];
    else {
      if (batch.binding === undefined) return false;
      next = mesh.lodRanges[i + 1]?.[batch.binding.drawItemIndex];
    }
    if (before === undefined || next === undefined) {
      if (before !== next) return false;
    } else if (
      !Object.is(before.first, next.first) ||
      !Object.is(before.count, next.count) ||
      !Object.is(before.baseVertex, next.baseVertex)
    )
      return false;
  }
  return true;
}

export function prepareBatchRows(
  batch: GpuDrivenBatch,
  inputs: PreparationInputs,
): PreparedBatchRows {
  const mesh = inputs.mesh;
  const execution = inputs.execution;
  const artifact = execution.route === 'gpu' ? execution.artifact : undefined;
  const binding = batch.binding;
  if (binding === undefined)
    throw new Error('Batch preparation requires a shared geometry binding');
  const lod = captureBatchLod(batch, mesh);
  let fact: PreparedBatchFacts | undefined;
  if (
    mesh !== undefined &&
    meshSupportsBatch(mesh, batch) &&
    artifact !== undefined &&
    execution.route === 'gpu'
  ) {
    const material = execution.material;
    const worldKey = inputs.worldKeys?.[binding.worldId] ?? binding.worldId;
    const renderState = geometryRenderStateForTopology(
      batch.key.topology,
      reflectedRenderState(execution.pass.renderState, batch.key.reflected === true),
    );
    fact = Object.freeze({
      mesh,
      artifact,
      worldKey,
      renderState,
      material: Object.freeze({
        ...(material.materialHandle === undefined
          ? {}
          : { materialHandle: material.materialHandle }),
        ...(material.standardTextureMask === undefined
          ? {}
          : { standardTextureMask: material.standardTextureMask }),
      }),
      ...rasterClassKeys(batch, mesh, artifact, material, worldKey, renderState),
    });
  }
  return Object.freeze({ source: batch, lod, fact, mesh, meshContentEpoch: mesh?.contentEpoch });
}

export function assemblePreparedPlan(
  source: SubmissionPlan,
  batchRows: readonly PreparedBatchRows[],
  worldKeys: readonly number[] | undefined,
  lodPlan = prepareLodProjectionPlan(source),
) {
  return { source, worldKeys, batchRows: Object.freeze([...batchRows]), lodPlan };
}

export type PreparedProductionPlan = ReturnType<typeof assemblePreparedPlan>;

/** A geometry partition contains only membership and object-specific binding facts. */
export interface BatchPartition {
  readonly key: string;
  readonly candidates: FrameList<GpuDrivenCandidate>;
  readonly members: FrameList<GpuDrivenBatchMember> | undefined;
  readonly materialBindingClass: string;
}

/** Called when source membership or object bindings change, independently of material execution. */
export function partitionBatch(
  source: GpuDrivenBatch,
  bindings: ReadonlyMap<string, string> | undefined,
): readonly BatchPartition[] {
  if ((bindings?.size ?? 0) === 0)
    return Object.freeze([
      {
        key: '',
        candidates: source.candidates,
        members: source.members,
        materialBindingClass: '',
      },
    ]);
  const binding = source.binding;
  const members = source.members;
  if (binding === undefined || members === undefined)
    throw new Error('Object selection requires native geometry membership');
  const groups = new Map<
    string,
    {
      key: string;
      candidates: GpuDrivenCandidate[];
      members: GpuDrivenBatchMember[];
      materialBindingClass: string;
    }
  >();
  const candidates = source.candidates[Symbol.iterator]();
  for (const member of members) {
    const materialBindingClass = bindings?.get(`${binding.worldId}:${member.entityKey}`) ?? '';
    const key = materialBindingClass;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        candidates: [],
        members: [],
        materialBindingClass,
      };
      groups.set(key, group);
    }
    group.members.push(member);
    for (let index = 0; index < member.instanceCount; index++) {
      const candidate = candidates.next();
      if (candidate.done) throw new Error('Geometry member exceeds its candidate range');
      group.candidates.push(candidate.value);
    }
  }
  return Object.freeze(
    [...groups.values()].map((group) =>
      Object.freeze({
        ...group,
        candidates:
          group.candidates.length === source.candidates.length
            ? source.candidates
            : Object.freeze(group.candidates),
        members: Object.freeze(group.members),
      }),
    ),
  );
}

export interface FilteredGroup {
  readonly row: PreparedBatchRows;
  readonly lod: GpuDrivenBatchLod | undefined;
  readonly partition: BatchPartition;
  readonly allocation?: {
    readonly batchId: number;
    readonly generation: number;
    readonly visibleBase: number;
    readonly visibleAllocationCapacity: number;
    readonly indirectOffset: number;
  };
}

export function assembleFilteredBatch(group: FilteredGroup): PreparedBatch {
  const { row, partition } = group;
  const { source, fact, meshContentEpoch } = row;
  if (fact === undefined || meshContentEpoch === undefined)
    throw new Error('Filtered execution requires captured prepared Mesh facts');
  const { lod: _lod, members: _members, ...base } = source;
  const filtered: GpuDrivenBatch = Object.freeze({
    ...base,
    ...(group.lod === undefined ? {} : { lod: group.lod }),
    ...(partition.members === undefined ? {} : { members: partition.members }),
    ...(group.allocation ?? {}),
    candidates: partition.candidates,
    visibleCapacity: partition.candidates.length,
  });
  return Object.freeze({
    batch: filtered,
    rasterClassKey: fact.rasterClassKey,
    recordingRasterClassKey: fact.recordingRasterClassKey,
    mesh: fact.mesh,
    meshContentEpoch,
    artifact: fact.artifact,
    renderState: fact.renderState,
    standardTextureMask: fact.material.standardTextureMask,
    materialBindingClass: partition.materialBindingClass,
    worldKey: fact.worldKey,
  });
}

export function groupForPartition(
  row: PreparedBatchRows,
  partition: BatchPartition,
): FilteredGroup | undefined {
  const fact = row.fact;
  if (fact === undefined || partition.candidates.length === 0) return undefined;
  const lod = row.lod;
  const crossfade = lodCrossfadeCapable(row.source);
  return {
    row,
    partition,
    lod:
      crossfade && lod !== undefined && lod.coverages.length > 1
        ? Object.freeze({ ...lod, crossfade: true })
        : lod,
  };
}

export function assembleFilteredGroups(
  source: SubmissionPlan,
  batches: readonly PreparedBatch[],
  topology: FrameList<GpuDrivenBatch> = batches.map((batch) => batch.batch),
) {
  const materialBatches = new Map<string, PreparedBatch>();
  let candidateCount = 0;
  let visibleCapacity = 0;
  let fixedMembership = true;
  for (const batch of batches) {
    const prepared = batch.batch.prepared;
    if (prepared !== undefined) {
      const key =
        capturedPreparedMaterialArtifactKey(prepared) ??
        gpuDrivenMaterialArtifactKey({
          material: prepared.identity.material,
          deformation: prepared.identity.deformation,
          receiptIdentity: prepared.receiptIdentity,
          receiptGeneration: prepared.receiptGeneration,
        });
      if (!materialBatches.has(key)) materialBatches.set(key, batch);
    }
  }
  for (const batch of topology) {
    const nativeMembership = MemberCandidates.is(batch.candidates);
    fixedMembership &&= nativeMembership;
    candidateCount += batch.candidates.length;
    visibleCapacity = Math.max(visibleCapacity, batch.visibleBase + batchVisibleSpan(batch));
  }
  const captured: SubmissionPlan = Object.freeze({
    revision: source.revision,
    batches: Object.freeze([...topology]),
    candidateCount,
    visibleCapacity,
  });
  const plan = fixedMembership ? fixedTaskPlan(captured) : captured;
  return {
    plan,
    batches: Object.freeze([...batches]),
    materialBatches: Object.freeze([...materialBatches.values()]),
    selection: new GpuDrawSelection(batches.map((batch) => batch.batch)),
  };
}

/** View visibility depends on the scene, never on material adoption. */
export function suppressedPrimitiveWords(
  slots: PersistentGpuDrivenState['slots'],
  worldKeys: readonly number[] | undefined,
  activeEntityKeys: ReadonlySet<number>,
  sceneCapacity: number,
): Uint32Array {
  const words = new Uint32Array(Math.max(1, Math.ceil(sceneCapacity / 32)));
  for (const slot of slots) {
    if (
      activeEntityKeys.has(
        worldEntityKey(
          worldKeys?.[slot.snapshot.worldId] ?? slot.snapshot.worldId,
          slot.snapshot.entityKey,
        ),
      )
    )
      continue;
    const word = slot.slot >>> 5;
    if (word < words.length) words[word] = (words[word] ?? 0) | (1 << (slot.slot & 31));
  }
  return words;
}

/** The inputs one suppression bitmap was derived from. */
export interface SuppressionSource {
  readonly slots: PersistentGpuDrivenState['slots'];
  readonly worldKeys: readonly number[] | undefined;
  readonly activeEntityKeys: ReadonlySet<number>;
  readonly words: Uint32Array;
}

/**
 * Words a patched bitmap changed relative to the bitmap it was patched from,
 * so each view uploading the earlier bitmap visits only those words.
 */
const suppressionPatches = new WeakMap<
  Uint32Array,
  { readonly base: Uint32Array; readonly words: readonly number[] }
>();

export function suppressionPatchOf(
  words: Uint32Array,
): { readonly base: Uint32Array; readonly words: readonly number[] } | undefined {
  return suppressionPatches.get(words);
}

/**
 * Patch an earlier bitmap to `suppressedPrimitiveWords(slots, ...)`, visiting
 * only the slots whose rows or active identities entered or left since the
 * earlier inputs, read from the scene's row-change log. `undefined` when the
 * inputs are not fixed rosters of the same routing or the log cannot answer,
 * so only the complete derivation can answer.
 */
export function patchSuppressedPrimitiveWords(
  previous: SuppressionSource,
  slots: PersistentGpuDrivenState['slots'],
  worldKeys: readonly number[] | undefined,
  activeEntityKeys: ReadonlySet<number>,
  sceneCapacity: number,
): Uint32Array | undefined {
  if (
    !(slots instanceof SceneSlotFrame) ||
    !(previous.slots instanceof SceneSlotFrame) ||
    !(activeEntityKeys instanceof SlotIdentityKeys) ||
    !(previous.activeEntityKeys instanceof SlotIdentityKeys) ||
    previous.worldKeys?.length !== worldKeys?.length ||
    previous.worldKeys?.some((key, index) => key !== worldKeys?.[index]) === true ||
    // Capacity bounds which rows the earlier bitmap could address.
    previous.words.length !== Math.max(1, Math.ceil(sceneCapacity / 32))
  )
    return undefined;
  const words = previous.words.slice();
  const changed: number[] = [];
  const evaluate = (slot: number): void => {
    const word = slot >>> 5;
    if (word >= words.length) return;
    const record = slots.slotAt(slot);
    const suppressed =
      record !== undefined &&
      !activeEntityKeys.has(
        worldEntityKey(
          worldKeys?.[record.snapshot.worldId] ?? record.snapshot.worldId,
          record.snapshot.entityKey,
        ),
      );
    const bit = 1 << (slot & 31);
    const before = words[word] ?? 0;
    const after = suppressed ? before | bit : before & ~bit;
    if (after === before) return;
    // A word enters the list when it first diverges from the base bitmap.
    if (before === previous.words[word]) changed.push(word);
    words[word] = after;
  };
  // A row's bit depends only on its presence and identity, never on its content.
  if (
    !activeEntityKeys.changesSince(previous.activeEntityKeys, evaluate) ||
    !slots.changesSince(previous.slots, (slot, kind) => {
      if (kind !== 'update') evaluate(slot);
    })
  )
    return undefined;
  suppressionPatches.set(words, { base: previous.words, words: changed });
  return words;
}

export type FilteredProductionPlan = ReturnType<typeof assembleFilteredGroups> & {
  /** Exact projection assembled from captured rows by the production owner. */
  readonly projectionSource?: SubmissionPlan;
};

export function artifactForPreparedBatch(
  batch: Pick<GpuDrivenBatch, 'prepared'>,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  rigidFallback: MaterialShaderArtifact | undefined,
  skinFallback: MaterialShaderArtifact | undefined,
): MaterialShaderArtifact | undefined {
  const prepared = batch.prepared;
  if (prepared === undefined) return undefined;
  const exact = artifacts?.get(
    capturedPreparedMaterialArtifactKey(prepared) ??
      gpuDrivenMaterialArtifactKey({
        material: prepared.identity.material,
        deformation: prepared.identity.deformation,
        receiptIdentity: prepared.receiptIdentity,
        receiptGeneration: prepared.receiptGeneration,
      }),
  );
  if (exact !== undefined) return exact;
  // A map supplied by the real record path is authoritative. A receipt-backed
  // draw missing from it is a producer/load failure, not permission to pair
  // the draw with another material's artifact.
  if (artifacts !== undefined && prepared.receiptIdentity !== undefined) return undefined;
  const fallback = prepared.identity.deformation === 'skin' ? skinFallback : rigidFallback;
  return fallback?.material === prepared.identity.material ? fallback : undefined;
}

export function shadowArtifactForPreparedBatch(
  batch: Pick<GpuDrivenBatch, 'prepared'>,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  fallback: MaterialShaderArtifact | undefined,
): MaterialShaderArtifact | undefined {
  const prepared = batch.prepared;
  if (prepared === undefined) return undefined;
  const exact = artifacts?.get(
    capturedPreparedMaterialArtifactKey(prepared) ??
      gpuDrivenMaterialArtifactKey({
        material: prepared.identity.material,
        deformation: prepared.identity.deformation,
        receiptIdentity: prepared.receiptIdentity,
        receiptGeneration: prepared.receiptGeneration,
      }),
  );
  if (exact !== undefined) return exact;
  // Direct production fixtures predate the separate shadow publication map.
  // They are allowed to reuse the already validated artifact; a real frame
  // passes the authoritative map and therefore fails closed on a missing
  // shadow program instead of silently selecting the forward program.
  return artifacts === undefined ? fallback : undefined;
}

/** The selected producer program, independent of unrelated frame materials. */
export function sameMaterialArtifact(
  left: MaterialShaderArtifact | undefined,
  right: MaterialShaderArtifact | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.material === right.material &&
    left.pass === right.pass &&
    left.layoutIdentity === right.layoutIdentity &&
    left.receipt?.receiptIdentity === right.receipt?.receiptIdentity &&
    left.receipt?.generation === right.receipt?.generation &&
    left.receipt?.sceneIndexEntry === right.receipt?.sceneIndexEntry &&
    left.variantSet === right.variantSet &&
    sameMaterialArtifactProgram(left, right) &&
    (left.vertexEntry ?? left.receipt?.sceneIndexEntry) ===
      (right.vertexEntry ?? right.receipt?.sceneIndexEntry) &&
    // Forward raster uses fs_main when no entry override is supplied.
    (left.fragmentEntry ?? 'fs_main') === (right.fragmentEntry ?? 'fs_main') &&
    left.uvSetCount === right.uvSetCount &&
    left.reflectionFallbackOutputAvailable === right.reflectionFallbackOutputAvailable
  );
}

export function shadowArtifactSignature(
  artifact: MaterialShaderArtifact | undefined,
): string | undefined {
  if (artifact === undefined) return undefined;
  return JSON.stringify([
    artifact.material,
    artifact.pass,
    artifact.layoutIdentity,
    artifact.receipt?.receiptIdentity ?? '',
    artifact.receipt?.generation ?? 0,
    artifact.variantSet ?? '',
    materialArtifactProgramIdentity(artifact),
    artifact.receipt?.sceneIndexEntry ?? '',
    artifact.vertexEntry ?? artifact.receipt?.sceneIndexEntry ?? '',
    artifact.fragmentEntry ?? '',
    artifact.uvSetCount ?? -1,
    artifact.reflectionFallbackOutputAvailable === true,
  ]);
}

export class BatchPreparation {
  readonly batches = new Map<
    number,
    {
      readonly source: GpuDrivenBatch;
      readonly signature: string;
      readonly artifact: MaterialShaderArtifact | undefined;
      readonly value: PreparedBatchRows;
      /** Identity facts that let a retained execution skip signature derivation. */
      readonly execution?: BatchExecution;
      readonly materialAddress?: number | undefined;
      readonly geometryAddress?: number | undefined;
      /** Scene geometry whose pinned version proved geometryAddress. */
      readonly geometry?: import('../scene/mesh-frame').MeshGeometry | undefined;
      /** Render state is author-mutable in place; its serialization stays observed. */
      readonly renderState?: string | undefined;
    }
  >();
  cached:
    | {
        readonly plan: SubmissionPlan;
        /** Current immutable frame lookup for attribution, independent of prepared geometry. */
        readonly slotAt: PersistentGpuDrivenState['slotAt'];
        readonly worldKeys: readonly number[] | undefined;
        readonly scene: PersistentGpuDrivenState['scene'];
        readonly batchRows: readonly PreparedBatchRows[];
        readonly value: PreparedProductionPlan;
        /** Exact inputs of an unchanged assembly; equal inputs skip the row walk. */
        readonly inputs?: PreparedAssemblyInputs;
      }
    | undefined;
}
