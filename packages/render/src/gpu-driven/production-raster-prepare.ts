import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { isFiniteBounds3 } from '@forgeax/engine-types';
import {
  materialArtifactProgramIdentity,
  sameMaterialArtifactProgram,
} from '../assembly/material/artifact-program-identity';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenDrawKey, gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { transformRenderState } from '../material-render-state';
import { isStandardPbrMaterialShader, SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import { FirstEntryMap } from '../record/first-entry-map';
import { getOpaqueResourceIdentity, worldEntityKey } from '../record/frame-snapshot';
import { geometryRenderStateForTopology } from '../record/main-pass-material';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import {
  batchLodLevelCount,
  batchVisibleSpan,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
  type GpuDrivenBatch,
  type GpuDrivenBatchLod,
  type GpuDrivenCandidate,
  type SubmissionPlan,
} from './batch-topology';
import { materialBindingKey } from './material-bindings';
import { capturedPreparedMaterialArtifactKey } from './prepared-draw';
import { lodCrossfadeCapable, prepareLodProjectionPlan } from './production-raster-lod';
import { type ShadowClaimTable, sourceDrawForCandidate } from './shadow-claims';

export interface PreparedBatch {
  readonly batch: GpuDrivenBatch;
  readonly rasterClassKey: string;
  /** Stock recording binds the current resident mesh, independently of graph resources. */
  readonly recordingRasterClassKey: string;
  readonly mesh: MeshGpuHandles;
  /** Exact producer artifact selected by every draw in this homogeneous batch. */
  readonly artifact: MaterialShaderArtifact;
  readonly renderState: MaterialRenderState | undefined;
  readonly standardTextureMask: number | undefined;
  /** Stable World attachment key used to join same-submit GPU counters. */
  readonly worldKey: number;
  /** Stable representative slot identity for this homogeneous batch. */
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
}

export function skinLaneReason(
  snapshot: RenderableSnapshot,
): 'skin-bounds-missing' | 'skin-address-missing' | undefined {
  if (snapshot.skin === undefined) return undefined;
  if (!isFiniteBounds3(snapshot.skin.bounds)) return 'skin-bounds-missing';
  if (
    snapshot.skin.storageOrUniform !== 'storage' ||
    !Number.isInteger(snapshot.skin.customDataStart) ||
    snapshot.skin.customDataStart < 0 ||
    snapshot.skin.buffer === undefined
  ) {
    return 'skin-address-missing';
  }
  return undefined;
}

export function preparedPbrCandidateEligible(
  snapshot: RenderableSnapshot,
  batch: GpuDrivenBatch,
  artifact: MaterialShaderArtifact | undefined,
): boolean {
  const material = snapshot.materials[batch.key.materialSlot] ?? snapshot.material;
  const prepared = batch.prepared;
  if (prepared === undefined) return false;
  const receipt = artifact?.receipt;
  const publishedAbiMatches =
    receipt !== undefined &&
    artifact?.material === prepared.identity.material &&
    (prepared.receiptIdentity === undefined ||
      (prepared.receiptIdentity === receipt.receiptIdentity &&
        prepared.receiptGeneration === receipt.generation)) &&
    receipt.reflection.layoutIdentity === artifact?.layoutIdentity;
  const alphaBlend = material.transparent === true || material.renderState?.blend !== undefined;
  const cpuOnlyMaterialResources =
    (material.textureSources?.size ?? 0) > 0 || (material.videoTextureFields?.size ?? 0) > 0;
  // Transmission has a separate CPU semantic pass today. Keep it out of the
  // GPU-owned candidate set so the residual transmission draw is not swallowed
  // by the generic Standard PBR lane.
  const transmission =
    isStandardPbrMaterialShader(prepared.identity.material) &&
    typeof material.paramSnapshot?.transmission === 'number' &&
    material.paramSnapshot.transmission > 0;
  const skinReady =
    prepared.identity.deformation !== 'skin' ||
    (artifact?.receipt?.skinPaletteAddress !== undefined &&
      snapshot.skin?.storageOrUniform === 'storage' &&
      snapshot.skin.customDataStart >= 0 &&
      Number.isInteger(snapshot.skin.customDataStart) &&
      snapshot.skin.buffer !== undefined &&
      isFiniteBounds3(snapshot.skin.bounds));
  return (
    publishedAbiMatches &&
    !alphaBlend &&
    !cpuOnlyMaterialResources &&
    !transmission &&
    (prepared.identity.deformation === 'rigid' || prepared.identity.deformation === 'skin') &&
    skinReady
  );
}

export function meshSupportsBatch(mesh: MeshGpuHandles, batch: GpuDrivenBatch): boolean {
  // A missing lower-detail GPU range is a readiness fact, not a root-mesh
  // incompatibility. Keep the selector candidate admitted so it can choose a
  // physically resident finer level or fall back to LOD0.
  return batch.key.drawKind === 'indexed'
    ? mesh.indexed && mesh.indexBuffer !== null
    : !mesh.indexed;
}

export interface PreparedDrawFacts {
  readonly drawKey: string;
  readonly activeKey: number;
  /** Content facts only (entity, materials); per-frame facts come from `slotAt`. */
  readonly slot: PersistentGpuDrivenState['slots'][number];
  /** Batch LOD metadata with the mesh's physical ranges for this draw item. */
  readonly lod: GpuDrivenBatchLod | undefined;
  readonly mesh: MeshGpuHandles;
  readonly artifact: MaterialShaderArtifact;
  readonly material: MaterialSnapshot;
  readonly renderState: MaterialRenderState | undefined;
  readonly worldKey: number;
  readonly groupKey: string;
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
  // Preserve the borrowed logical-handle read at its original boundary.
  // Its value is not a dependency of this physical raster class.
  void key.assetHandle;
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
  ];
  const rasterClassKey = JSON.stringify(fields);
  // Main-pass direct draws already bind residency-owned mesh buffers outside
  // the graph. Stock indirect recording follows the same lifetime authority;
  // inter-pass Scene/visibility/indirect buffers remain graph declarations.
  fields[8] = fields[9] = fields[11] = fields[12] = 0;
  return { rasterClassKey, recordingRasterClassKey: JSON.stringify(fields) };
}

export interface PreparedDrawFactsLookup extends Iterable<[number, PreparedDrawFacts | undefined]> {
  get(index: number): PreparedDrawFacts | undefined;
  values(): IterableIterator<PreparedDrawFacts | undefined>;
  forEach(callback: (value: PreparedDrawFacts | undefined, index: number) => void): void;
}

/** Scene-owned admission facts of one source batch, independent of every view. */
export interface PreparedBatchRows {
  readonly source: GpuDrivenBatch;
  /** One immutable fact record per primitive and draw item, shared by its instances. */
  readonly facts: ReadonlyMap<number, PreparedDrawFactsLookup>;
  readonly draws: readonly PreparedDrawFacts[];
  /** Every consulted primitive, including ineligible ones, retains its resident mesh identity. */
  readonly meshes: ReadonlyMap<
    number,
    { readonly mesh: MeshGpuHandles; readonly contentEpoch: number } | undefined
  >;
}

export function sameBatchMeshes(
  prepared: PreparedBatchRows,
  meshBySlot: ReadonlyMap<number, MeshGpuHandles>,
  changed?: Set<number>,
): boolean {
  let same = true;
  for (const [primitive, previous] of prepared.meshes) {
    const mesh = meshBySlot.get(primitive);
    if (mesh === previous?.mesh && mesh?.contentEpoch === previous?.contentEpoch) continue;
    same = false;
    if (previous !== undefined) changed?.add(primitive);
  }
  return same;
}

export interface PreparationInputs {
  readonly slotAt: PersistentGpuDrivenState['slotAt'];
  readonly meshBySlot: ReadonlyMap<number, MeshGpuHandles>;
  readonly worldKeys: readonly number[] | undefined;
  readonly materialArtifact: MaterialShaderArtifact | undefined;
  readonly skinArtifact: MaterialShaderArtifact | undefined;
  readonly materialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
}

export function worldKeyForSlot(
  worldKeys: readonly number[] | undefined,
  slot: PersistentGpuDrivenState['slots'][number],
): number {
  return worldKeys?.[slot.snapshot.worldId] ?? slot.snapshot.worldId;
}

export function prepareBatchRows(
  batch: GpuDrivenBatch,
  inputs: PreparationInputs,
): PreparedBatchRows {
  const batchKey = JSON.stringify(batch.key);
  const meshSupport = new Map<MeshGpuHandles, boolean>();
  const facts = new Map<number, FirstEntryMap<number, PreparedDrawFacts | undefined>>();
  const draws: PreparedDrawFacts[] = [];
  const meshes = new Map<
    number,
    { readonly mesh: MeshGpuHandles; readonly contentEpoch: number } | undefined
  >();
  const artifact = artifactForPreparedBatch(
    batch,
    inputs.materialArtifacts,
    inputs.materialArtifact,
    inputs.skinArtifact,
  );
  for (const candidate of batch.candidates) {
    let byDraw = facts.get(candidate.primitiveIndex);
    if (byDraw === undefined) {
      byDraw = new FirstEntryMap();
      facts.set(candidate.primitiveIndex, byDraw);
      const mesh = inputs.meshBySlot.get(candidate.primitiveIndex);
      meshes.set(
        candidate.primitiveIndex,
        mesh === undefined ? undefined : { mesh, contentEpoch: mesh.contentEpoch },
      );
    }
    if (byDraw.has(candidate.drawItemIndex)) continue;
    // Missing admission is a retained result too; further instances cannot repair it.
    byDraw.set(candidate.drawItemIndex, undefined);
    const slot = inputs.slotAt(candidate.primitiveIndex);
    if (slot === undefined || artifact === undefined) continue;
    const mesh = inputs.meshBySlot.get(slot.slot);
    const draw = sourceDrawForCandidate(slot, candidate);
    if (
      draw === undefined ||
      mesh === undefined ||
      !preparedPbrCandidateEligible(slot.snapshot, batch, artifact)
    )
      continue;
    let supportsBatch = meshSupport.get(mesh);
    if (supportsBatch === undefined) {
      supportsBatch = meshSupportsBatch(mesh, batch);
      meshSupport.set(mesh, supportsBatch);
    }
    if (!supportsBatch) continue;
    const drawMaterial = slot.snapshot.materials[draw.materialSlot] ?? slot.snapshot.material;
    const worldKey = worldKeyForSlot(inputs.worldKeys, slot);
    const activeKey = worldEntityKey(worldKey, slot.snapshot.entityKey);
    const drawKey = gpuDrivenDrawKey(
      activeKey,
      drawMaterial.materialHandle ?? -1,
      candidate.drawItemIndex,
    );
    const material = slot.snapshot.materials[batch.key.materialSlot] ?? slot.snapshot.material;
    const residentLodRanges = mesh.lodRanges
      ?.slice(1)
      .map((ranges) => ranges[candidate.drawItemIndex]);
    const lod =
      batch.lod === undefined
        ? undefined
        : Object.freeze({
            coverages: batch.lod.coverages,
            ...(batch.lod.hysteresis === undefined ? {} : { hysteresis: batch.lod.hysteresis }),
            ...(batch.lod.crossfade === undefined ? {} : { crossfade: batch.lod.crossfade }),
            ...(residentLodRanges === undefined
              ? {}
              : { ranges: Object.freeze(residentLodRanges) }),
          });
    // These facts survive a local edit to another batch. Serialize them once
    // here instead of escaping the complete identity again in every view plan.
    const groupKey =
      batchKey +
      JSON.stringify({
        standardTextureMask: material.standardTextureMask,
        artifact: [
          artifact.material,
          artifact.layoutIdentity,
          artifact.receipt?.receiptIdentity ?? '',
          artifact.receipt?.generation ?? 0,
          artifact.variantSet ?? '',
          materialArtifactProgramIdentity(artifact),
        ],
        worldKey,
        lodCoverages: lod?.coverages ?? null,
        lodHysteresis: lod?.hysteresis ?? null,
        lodRanges: lod?.ranges ?? null,
      });
    const renderState = geometryRenderStateForTopology(
      batch.key.topology,
      transformRenderState(material.renderState, slot.snapshot.transform.world),
    );
    const fact: PreparedDrawFacts = Object.freeze({
      drawKey,
      activeKey,
      slot,
      lod,
      mesh,
      artifact,
      material,
      worldKey,
      groupKey,
      ...rasterClassKeys(batch, mesh, artifact, material, worldKey, renderState),
      renderState,
    });
    byDraw.set(candidate.drawItemIndex, fact);
    draws.push(fact);
  }
  return Object.freeze({
    source: batch,
    facts,
    draws: Object.freeze(draws),
    meshes,
  });
}

/**
 * Assemble scene-owned admission and ownership from per-batch rows. Only the
 * batches in `rebuilt` were re-derived; the rest are the retained rows of an
 * unchanged `(batchId, generation, contentEpoch)`.
 */
export function assemblePreparedPlan(
  source: SubmissionPlan,
  batchRows: readonly PreparedBatchRows[],
  slots: PersistentGpuDrivenState['slots'],
  worldKeys: readonly number[] | undefined,
) {
  const admissionByPrimitive = new Map<number, { count: number; admitted: boolean }>();
  const drawKeys = new Set<string>();
  const cacheEntityKeys = new Set<number>();
  // BatchTopology emits each (primitive, source draw, instance) once. The
  // retained facts already prove draw/resource admission; ownership only
  // joins that proof with the complete authored draw × instance cardinality.
  for (const [index, batch] of source.batches.entries()) {
    const prepared = batchRows[index] as PreparedBatchRows;
    for (const candidate of batch.candidates) {
      const admitted =
        prepared.facts.get(candidate.primitiveIndex)?.get(candidate.drawItemIndex) !== undefined;
      const admission = admissionByPrimitive.get(candidate.primitiveIndex);
      if (admission === undefined)
        admissionByPrimitive.set(candidate.primitiveIndex, { count: 1, admitted });
      else {
        admission.count += 1;
        admission.admitted &&= admitted;
      }
    }
    for (const draw of prepared.draws) {
      drawKeys.add(draw.drawKey);
      if (Number.isSafeInteger(draw.activeKey)) cacheEntityKeys.add(draw.activeKey);
    }
  }
  const ownership = slots.map((slot) => {
    const draws = slot.snapshot.gpuDrivenDraws ?? [];
    const admission = admissionByPrimitive.get(slot.slot);
    const activeKey = worldEntityKey(worldKeyForSlot(worldKeys, slot), slot.snapshot.entityKey);
    const ownsAllDrawItems =
      draws.length > 0 &&
      (admission?.count ?? 0) === draws.length * (slot.snapshot.instances?.instanceCount ?? 1) &&
      (admission?.admitted ?? true);
    return { activeKey, ownsAllDrawItems };
  });
  return {
    source,
    worldKeys,
    batchRows: Object.freeze([...batchRows]),
    drawKeys,
    cacheEntityKeys,
    ownership,
    lodPlan: prepareLodProjectionPlan(source),
  };
}

export type PreparedProductionPlan = ReturnType<typeof assemblePreparedPlan>;

function preparedMaterialBindingClass(
  row: PreparedDrawFacts,
  classes: ReadonlyMap<string, string> | undefined,
  bindingReads?: Map<string, string>,
): string {
  if (classes === undefined) return '';
  const key = materialBindingKey(row.slot.snapshot, row.material.materialHandle ?? -1);
  const bindingClass = classes.get(key) ?? '';
  bindingReads?.set(key, bindingClass);
  return bindingClass;
}

/**
 * Project LOD and bindings over prepared rows. Membership covers every
 * resident candidate: per-view admission is a GPU bitmap
 * (`suppressedPrimitiveWords`), so visibility changes never rebuild this plan.
 */
export interface FilteredGroup {
  readonly source: GpuDrivenBatch;
  readonly lod: GpuDrivenBatchLod | undefined;
  readonly mesh: MeshGpuHandles;
  readonly artifact: MaterialShaderArtifact;
  readonly renderState: MaterialRenderState | undefined;
  readonly standardTextureMask: number | undefined;
  readonly candidates: readonly GpuDrivenCandidate[];
  readonly first: PreparedDrawFacts;
  /** Physical windows assigned by the retained filtered contribution owner. */
  readonly allocation?: {
    readonly batchId: number;
    readonly generation: number;
    readonly visibleBase: number;
    readonly visibleAllocationCapacity: number;
    readonly indirectOffset: number;
  };
}

type MutableFilteredGroup = Omit<FilteredGroup, 'candidates'> & {
  candidates: GpuDrivenCandidate[];
};

/** Pure canonical projection; instance order and claim admission remain shared. */
export function buildFilteredGroups(
  batchRows: readonly PreparedBatchRows[],
  shadowClaims: ShadowClaimTable | undefined,
  materialBindingClasses: ReadonlyMap<string, string> | undefined,
  profilePart?: <T>(part: 'groups' | 'group-key' | 'batches', action: () => T) => T,
  bindingReads?: Map<string, string>,
) {
  const shadowSelectionProvided = shadowClaims !== undefined;
  const shadowDrawKeys = new Set<string>();
  const groups = new Map<string, MutableFilteredGroup>();
  // One row fixes the snapshot and draw item within this projection. Admission,
  // claim keys and the group therefore do not depend on the instance ordinal.
  const projectedGroups = new Map<PreparedDrawFacts, MutableFilteredGroup | null>();
  const buildGroups = () => {
    // Traverse the canonical candidates to preserve interleaved instance ordering.
    for (const preparedBatch of batchRows) {
      const batch = preparedBatch.source;
      for (const candidate of batch.candidates) {
        const row = preparedBatch.facts.get(candidate.primitiveIndex)?.get(candidate.drawItemIndex);
        if (row === undefined) continue;
        const projected = projectedGroups.get(row);
        if (projected !== undefined) {
          projected?.candidates.push(candidate);
          continue;
        }
        const { slot, material, lod } = row;
        const shadowClaim = shadowClaims?.claim(slot, candidate);
        if (shadowClaim !== undefined) {
          if (!shadowClaim.compatible) {
            projectedGroups.set(row, null);
            continue;
          }
          for (const key of shadowClaim.keys) shadowDrawKeys.add(key);
        }
        const shadowEntry = shadowClaim?.entry;
        const projectKey = () => {
          // The GPU cull picks each member's level; crossfade adds the adjacent
          // level across the transition band. Custom shadow casters and
          // non-Standard materials never read the fade, so they select hard.
          const crossfade =
            lodCrossfadeCapable(batch) &&
            !(
              shadowSelectionProvided &&
              shadowEntry !== undefined &&
              shadowEntry.materialShaderId !== SHADOW_CASTER_SHADER_ID
            );
          const batchLod =
            crossfade && lod !== undefined && lod.coverages.length > 1
              ? Object.freeze({ ...lod, crossfade: true })
              : lod;
          const groupKey =
            row.groupKey +
            JSON.stringify({
              shadowRenderState: shadowSelectionProvided ? shadowEntry?.renderState : undefined,
              bindingClass: preparedMaterialBindingClass(row, materialBindingClasses, bindingReads),
              lodCrossfade: batchLod?.crossfade ?? false,
            });
          return { batchLod, groupKey };
        };
        const { batchLod, groupKey } =
          profilePart === undefined ? projectKey() : profilePart('group-key', projectKey);
        let group = groups.get(groupKey);
        if (group === undefined) {
          group = {
            source: batch,
            lod: batchLod,
            mesh: row.mesh,
            artifact: row.artifact,
            renderState: row.renderState,
            standardTextureMask: material.standardTextureMask,
            candidates: [],
            first: row,
          };
          groups.set(groupKey, group);
        }
        projectedGroups.set(row, group);
        group.candidates.push(candidate);
      }
    }
  };
  if (profilePart === undefined) buildGroups();
  else profilePart('groups', buildGroups);

  for (const group of groups.values()) Object.freeze(group.candidates);
  return {
    groups: groups as ReadonlyMap<string, FilteredGroup>,
    shadowDrawKeys: shadowDrawKeys as ReadonlySet<string>,
  };
}

/** Assemble one admitted group, using retained windows when an owner supplies them. */
export function assembleFilteredBatch(
  group: FilteredGroup,
  worldKeys: readonly number[] | undefined,
  batchId = 0,
  visibleBase = 0,
  indirectOffset = 0,
): PreparedBatch {
  const admittedCount = group.candidates.length;
  const {
    lod: _sourceLod,
    visibleAllocationCapacity: _sourceReservation,
    ...sourceFacts
  } = group.source;
  const filtered: GpuDrivenBatch = Object.freeze(
    Object.assign(sourceFacts, {
      ...(group.lod === undefined ? {} : { lod: group.lod }),
      batchId,
      ...(group.allocation ?? {}),
      candidates: group.candidates,
      visibleBase: group.allocation?.visibleBase ?? visibleBase,
      visibleCapacity: admittedCount,
      indirectOffset: group.allocation?.indirectOffset ?? indirectOffset,
    }),
  );
  const firstSlot = group.first.slot;
  const preparedBatch: PreparedBatch = {
    batch: filtered,
    rasterClassKey: group.first.rasterClassKey,
    recordingRasterClassKey: group.first.recordingRasterClassKey,
    mesh: group.mesh,
    artifact: group.artifact,
    renderState: group.renderState,
    standardTextureMask: group.standardTextureMask,
    worldKey: worldKeyForSlot(worldKeys, firstSlot),
    primitiveSlot: firstSlot.slot,
    slotGeneration: firstSlot.generation,
  };
  return preparedBatch;
}

export function assembleFilteredGroups(
  source: SubmissionPlan,
  worldKeys: readonly number[] | undefined,
  drawKeys: ReadonlySet<string>,
  shadowDrawKeys: ReadonlySet<string>,
  groups: Iterable<FilteredGroup>,
  profilePart?: <T>(part: 'groups' | 'group-key' | 'batches', action: () => T) => T,
  preparedBatches?: readonly PreparedBatch[],
) {
  const buildBatches = () => {
    const batches: PreparedBatch[] = [];
    // Program dependencies share the filtered plan's exact admission and lifetime.
    // Retain one existing batch reference per selected receipt, not per mesh.
    const materialBatches = new Map<string, PreparedBatch>();
    let previousMaterial: string | undefined;
    let previousDeformation: string | undefined;
    let previousReceiptIdentity: string | undefined;
    let previousReceiptGeneration: number | undefined;
    let candidateCount = 0;
    let visibleBase = 0;
    const filteredBatches: GpuDrivenBatch[] = [];
    let batchId = 0;
    let indirectOffset = 0;
    for (const group of groups) {
      visibleBase = Math.ceil(visibleBase / 64) * 64;
      const preparedBatch =
        preparedBatches?.[batchId] ??
        assembleFilteredBatch(group, worldKeys, batchId, visibleBase, indirectOffset);
      const filtered = preparedBatch.batch;
      candidateCount += filtered.candidates.length;
      visibleBase = Math.max(visibleBase, filtered.visibleBase + batchVisibleSpan(filtered));
      indirectOffset += batchLodLevelCount(filtered) * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
      filteredBatches.push(filtered);
      batchId += 1;
      batches.push(preparedBatch);
      const prepared = filtered.prepared;
      if (prepared !== undefined) {
        // Observe every current receipt; adjacent equal values already have
        // their first representative and need no repeated key construction.
        const material = prepared.identity.material;
        const deformation = prepared.identity.deformation;
        const receiptIdentity = prepared.receiptIdentity;
        const receiptGeneration = prepared.receiptGeneration;
        if (
          material !== previousMaterial ||
          deformation !== previousDeformation ||
          receiptIdentity !== previousReceiptIdentity ||
          receiptGeneration !== previousReceiptGeneration
        ) {
          const key =
            capturedPreparedMaterialArtifactKey(prepared) ??
            gpuDrivenMaterialArtifactKey({
              material,
              deformation,
              receiptIdentity,
              receiptGeneration,
            });
          if (!materialBatches.has(key)) materialBatches.set(key, preparedBatch);
          previousMaterial = material;
          previousDeformation = deformation;
          previousReceiptIdentity = receiptIdentity;
          previousReceiptGeneration = receiptGeneration;
        }
      }
    }
    return {
      plan: Object.freeze({
        revision: source.revision,
        batches: Object.freeze(filteredBatches),
        candidateCount,
        visibleCapacity: visibleBase,
      }),
      batches: Object.freeze(batches),
      materialBatches: Object.freeze([...materialBatches.values()]),
      drawKeys,
      shadowDrawKeys,
    };
  };
  return profilePart === undefined ? buildBatches() : profilePart('batches', buildBatches);
}

/** Full reference/fallback; no retained contribution authority is assumed. */
export function filteredPlan(
  prepared: PreparedProductionPlan,
  shadowClaims?: ShadowClaimTable,
  materialBindingClasses?: ReadonlyMap<string, string>,
  profilePart?: <T>(part: 'groups' | 'group-key' | 'batches', action: () => T) => T,
) {
  const { groups, shadowDrawKeys } = buildFilteredGroups(
    prepared.batchRows,
    shadowClaims,
    materialBindingClasses,
    profilePart,
  );
  return assembleFilteredGroups(
    prepared.source,
    prepared.worldKeys,
    shadowClaims === undefined ? prepared.drawKeys : new Set<string>(),
    shadowDrawKeys,
    groups.values(),
    profilePart,
  );
}

/**
 * Whether the GPU lane owns every draw item of every admitted entity. Entities
 * outside the active set submit nothing on either lane, so they never force
 * the direct path.
 */
export function ownsAllAdmittedDrawItems(
  prepared: PreparedProductionPlan,
  activeEntityKeys: ReadonlySet<number> | undefined,
): boolean {
  return prepared.ownership.every(
    (entry) =>
      (activeEntityKeys !== undefined && !activeEntityKeys.has(entry.activeKey)) ||
      entry.ownsAllDrawItems,
  );
}

/**
 * Per-view admission bitmap over GPU Scene primitive slots: a set bit marks a
 * prepared primitive outside the active entity set.
 */
export function suppressedPrimitiveWords(
  prepared: PreparedProductionPlan,
  activeEntityKeys: ReadonlySet<number>,
  sceneCapacity: number,
): Uint32Array {
  const words = new Uint32Array(Math.max(1, Math.ceil(sceneCapacity / 32)));
  let primitive = 0;
  const suppress = (row: PreparedDrawFacts | undefined) => {
    if (
      row === undefined ||
      activeEntityKeys.has(worldEntityKey(row.worldKey, row.slot.snapshot.entityKey))
    )
      return;
    const word = primitive >>> 5;
    if (word < words.length) words[word] = (words[word] ?? 0) | (1 << (primitive & 31));
  };
  const visitPrimitive = (byDraw: PreparedDrawFactsLookup, index: number) => {
    primitive = index;
    byDraw.forEach(suppress);
  };
  // These maps are the preparation owner's tables. Reuse two invocation-local
  // callbacks instead of allocating iterator results and entry tuples per row.
  for (const batch of prepared.batchRows) batch.facts.forEach(visitPrimitive);
  return words;
}

export const EMPTY_SHADOW_KEYS: ReadonlySet<string> = new Set();

export interface ShadowOwnershipSource {
  readonly casterKeys: ReadonlySet<string> | undefined;
  ownsAllFor: FilteredProductionPlan | undefined;
  ownsAll: boolean;
  /** Undefined when no shadow selection is provided. */
  readonly claims: ShadowClaimTable | undefined;
}

export type FilteredProductionPlan = ReturnType<typeof filteredPlan>;

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
