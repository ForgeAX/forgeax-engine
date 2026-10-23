import type { PersistentGpuDrivenState } from '../scene/render-scene';
import {
  type GBufferOrderDiagnosticConfig,
  type GBufferOrderDiagnosticInspection,
  gbufferBatchDepth,
  gbufferOrderInterfaceEvidence,
  gbufferProgramDigest,
} from './gbuffer-order-diagnostic';
import type { LiveRasterBatch } from './live-raster';
import type { ProjectedRasterClass } from './production-raster-classes';

/** Per-encode evidence accumulated while ordering one stock G-buffer pass. */
export interface GBufferOrderEvidence {
  readonly classes: NonNullable<GBufferOrderDiagnosticInspection['classes']>[number][];
  readonly batches: NonNullable<GBufferOrderDiagnosticInspection['batches']>[number][];
  readonly rejections: Record<string, number>;
  readonly indices: Map<ProjectedRasterClass, number>;
  selected: number;
}

/** Frame facts the diagnostic depth reads; any missing owner rejects every batch. */
export interface GBufferOrderSources {
  readonly view: Float32Array | undefined;
  readonly slotAt: PersistentGpuDrivenState['slotAt'] | undefined;
  readonly materials: import('../scene/material-dispatch').MaterialFrame | undefined;
}

/** The interface proof of one raster class, recorded once per encode. */
function gbufferClassEvidence(
  evidence: GBufferOrderEvidence,
  mode: GBufferOrderDiagnosticConfig,
  batch: ProjectedRasterClass,
  reasons: string[],
): number {
  batch.diagnosticSourceDigest ??= gbufferProgramDigest(batch.artifact.program.source);
  let classIndex = evidence.indices.get(batch);
  if (classIndex === undefined) {
    const gate = gbufferOrderInterfaceEvidence(
      batch.artifact,
      batch.orderDiagnosticState,
      batch.deformation,
      batch.raster.diagnosticGBufferVertexEntry(batch.artifact),
    );
    classIndex = evidence.classes.length;
    evidence.indices.set(batch, classIndex);
    evidence.classes.push({
      sourceDigest: batch.diagnosticSourceDigest,
      material: batch.artifact.material,
      specializationKey: batch.artifact.specializationKey,
      facts: gate.facts,
      checks: gate.checks,
      rejections: gate.rejections.map((reason) => `interface/${reason}`),
      auditedSource: mode.programDigests.includes(batch.diagnosticSourceDigest),
    });
  }
  const proof = evidence.classes[classIndex];
  if (proof !== undefined) {
    reasons.push(...proof.rejections);
    if (!proof.auditedSource) reasons.push('program-digest');
  }
  return classIndex;
}

/** View-space batch depth, or the rejected owner and bounds source. */
function gbufferSourceDepth(
  sources: GBufferOrderSources,
  live: LiveRasterBatch,
  reasons: string[],
): {
  readonly depth: number | undefined;
  readonly rejectedSource?: Readonly<Record<string, unknown>>;
} {
  const { view, slotAt } = sources;
  if (view === undefined) reasons.push('camera-view');
  if (slotAt === undefined) reasons.push('source-slot-owner');
  if (view === undefined || slotAt === undefined) return { depth: undefined };
  let rejectedSource: Readonly<Record<string, unknown>> | undefined;
  const binding = live.batch.binding;
  const depth = gbufferBatchDepth(
    live.batch,
    slotAt,
    view,
    (reason, source) => {
      reasons.push(`bounds/${reason}`);
      rejectedSource = source;
    },
    binding === undefined ? undefined : sources.materials?.get(binding.material)?.snapshot,
  );
  if (depth === undefined && !reasons.some((reason) => reason.startsWith('bounds/')))
    reasons.push('bounds/unavailable');
  return rejectedSource === undefined ? { depth } : { depth, rejectedSource };
}

/**
 * Admit one live batch into the diagnostic order. `selected` is the class the
 * pass draws with; `batch` is its compiled class even when the pass filter
 * rejects it. Returns the sort depth only when no gate rejected the batch.
 */
export function gbufferOrderBatchDepth(
  evidence: GBufferOrderEvidence,
  mode: GBufferOrderDiagnosticConfig,
  sources: GBufferOrderSources,
  live: LiveRasterBatch,
  selected: ProjectedRasterClass | undefined,
  batch: ProjectedRasterClass | undefined,
): number | undefined {
  const reasons: string[] = [];
  if (selected === undefined) reasons.push('pass-filter');
  else evidence.selected++;
  let classIndex: number | undefined;
  if (batch === undefined) reasons.push('missing-raster-class');
  else classIndex = gbufferClassEvidence(evidence, mode, batch, reasons);
  const { depth, rejectedSource } = gbufferSourceDepth(sources, live, reasons);
  for (const reason of reasons)
    evidence.rejections[reason] = (evidence.rejections[reason] ?? 0) + 1;
  evidence.batches.push({
    batchId: live.batch.batchId,
    classIndex,
    candidateCount: live.batch.candidates.length,
    visibleCapacity: live.batch.visibleCapacity,
    materialPass: live.batch.key.materialPass,
    meshHandle: live.batch.key.assetHandle,
    materialSlot: live.batch.key.materialSlot,
    depth,
    rejections: reasons,
    ...(rejectedSource === undefined ? {} : { rejectedSource }),
  });
  return reasons.length === 0 ? depth : undefined;
}
