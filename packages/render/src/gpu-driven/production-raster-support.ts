import type { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import type { GpuDrivenPreparationFailureInspection } from '../inspection-types';
import type { GpuDrivenBatch } from './batch-topology';
import { capturedPreparedMaterialArtifactKey } from './prepared-draw';
import { type PreparedBatch, shadowArtifactSignature } from './production-raster-prepare';

export function preparationFailureInspection(
  error: GpuDrivenPreparationError,
): GpuDrivenPreparationFailureInspection {
  return Object.freeze({
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
  });
}

export function sameEntityKeySet(
  left: ReadonlySet<number> | undefined,
  right: ReadonlySet<number> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export function shadowMaterialKey(batch: Pick<GpuDrivenBatch, 'prepared'>): string {
  const prepared = batch.prepared;
  const captured =
    prepared === undefined ? undefined : capturedPreparedMaterialArtifactKey(prepared);
  if (captured !== undefined) return captured;
  return gpuDrivenMaterialArtifactKey({
    material: prepared?.identity.material ?? '',
    deformation: prepared?.identity.deformation ?? 'rigid',
    receiptIdentity: prepared?.receiptIdentity ?? '',
    receiptGeneration: prepared?.receiptGeneration ?? 0,
  });
}

export type ShadowArtifactObservations = ReadonlyMap<string, string | undefined>;

/** Observed shadow artifact signatures; an unchanged observation keeps its identity. */
export function observeShadowArtifacts(
  previous: ShadowArtifactObservations,
  batches: readonly Pick<PreparedBatch, 'batch' | 'artifact'>[],
): ShadowArtifactObservations {
  const next = new Map<string, string | undefined>();
  let changed = false;
  for (const { batch, artifact } of batches) {
    const key = shadowMaterialKey(batch);
    const signature = shadowArtifactSignature(artifact);
    next.set(key, signature);
    if (!previous.has(key) || previous.get(key) !== signature) changed = true;
  }
  return changed || previous.size !== next.size ? next : previous;
}
