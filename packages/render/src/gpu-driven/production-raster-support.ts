import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import type { GpuDrivenPreparationFailureInspection } from '../inspection-types';
import type { GpuDrivenBatch } from './batch-topology';
import { capturedPreparedMaterialArtifactKey } from './prepared-draw';
import type { PreparedBatch } from './production-raster-prepare';

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

/** Scalar snapshots preserve the former JSON number equivalence. */
function jsonNumber(value: number): number | null {
  return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
}

interface ShadowArtifactFacts {
  readonly material: string;
  readonly pass: string;
  readonly layoutIdentity: string;
  readonly receiptIdentity: string;
  readonly receiptGeneration: number | null;
  readonly variantSet: string;
  readonly programIdentity: string;
  readonly specializationKey: string | null;
  readonly sceneIndexEntry: string;
  readonly vertexEntry: string;
  readonly fragmentEntry: string;
  readonly uvSetCount: number | null;
  readonly reflectionFallbackOutputAvailable: boolean;
}

interface ShadowArtifactObservation {
  readonly facts: ShadowArtifactFacts;
  /** Value identity also compares independently retained historical observations. */
  readonly key: string;
}

/** These are detached scalar records, not recursively structured author inputs. */
function sameShadowArtifactFacts(
  left: ShadowArtifactObservation['facts'],
  material: string,
  pass: string,
  layoutIdentity: string,
  receiptIdentity: string,
  receiptGeneration: number | null,
  variantSet: string,
  programIdentity: string,
  specializationKey: string | null,
  sceneIndexEntry: string,
  vertexEntry: string,
  fragmentEntry: string,
  uvSetCount: number | null,
  reflectionFallbackOutputAvailable: boolean,
): boolean {
  return (
    left.material === material &&
    left.pass === pass &&
    left.layoutIdentity === layoutIdentity &&
    left.receiptIdentity === receiptIdentity &&
    left.receiptGeneration === receiptGeneration &&
    left.variantSet === variantSet &&
    left.programIdentity === programIdentity &&
    left.specializationKey === specializationKey &&
    left.sceneIndexEntry === sceneIndexEntry &&
    left.vertexEntry === vertexEntry &&
    left.fragmentEntry === fragmentEntry &&
    left.uvSetCount === uvSetCount &&
    left.reflectionFallbackOutputAvailable === reflectionFallbackOutputAvailable
  );
}

export type ShadowArtifactObservations = ReadonlyMap<string, ShadowArtifactObservation | undefined>;

function observeShadowArtifact(
  previous: ShadowArtifactObservation | undefined,
  artifact: MaterialShaderArtifact | undefined,
): ShadowArtifactObservation | undefined {
  if (artifact === undefined) return undefined;
  // Keep the complete original getter/default order before comparing anything.
  const material = artifact.material;
  const pass = artifact.pass;
  const layoutIdentity = artifact.layoutIdentity;
  const receiptIdentity = artifact.receipt?.receiptIdentity ?? '';
  const receiptGeneration = jsonNumber(artifact.receipt?.generation ?? 0);
  const variantSet = artifact.variantSet ?? '';
  const programIdentity = artifact.program.identity;
  const specializationKey = artifact.specializationKey ?? null;
  const sceneIndexEntry = artifact.receipt?.sceneIndexEntry ?? '';
  const vertexEntry = artifact.vertexEntry ?? artifact.receipt?.sceneIndexEntry ?? '';
  const fragmentEntry = artifact.fragmentEntry ?? '';
  const uvSetCount = jsonNumber(artifact.uvSetCount ?? -1);
  const reflectionFallbackOutputAvailable = artifact.reflectionFallbackOutputAvailable === true;
  if (
    previous !== undefined &&
    sameShadowArtifactFacts(
      previous.facts,
      material,
      pass,
      layoutIdentity,
      receiptIdentity,
      receiptGeneration,
      variantSet,
      programIdentity,
      specializationKey,
      sceneIndexEntry,
      vertexEntry,
      fragmentEntry,
      uvSetCount,
      reflectionFallbackOutputAvailable,
    )
  )
    return previous;
  const facts: ShadowArtifactFacts = {
    material,
    pass,
    layoutIdentity,
    receiptIdentity,
    receiptGeneration,
    variantSet,
    programIdentity,
    specializationKey,
    sceneIndexEntry,
    vertexEntry,
    fragmentEntry,
    uvSetCount,
    reflectionFallbackOutputAvailable,
  };
  return Object.freeze({ facts: Object.freeze(facts), key: JSON.stringify(facts) });
}

/** Observed shadow artifact signatures; an unchanged observation keeps its identity. */
export function observeShadowArtifacts(
  previous: ShadowArtifactObservations,
  batches: readonly Pick<PreparedBatch, 'batch' | 'artifact'>[],
): ShadowArtifactObservations {
  const next = new Map<string, ShadowArtifactObservation | undefined>();
  // Batches sharing one material key and artifact observe it once per call.
  const observedFrom = new Map<string, PreparedBatch['artifact']>();
  let changed = false;
  for (const { batch, artifact } of batches) {
    const key = shadowMaterialKey(batch);
    if (observedFrom.has(key) && observedFrom.get(key) === artifact) continue;
    observedFrom.set(key, artifact);
    const observed = observeShadowArtifact(previous.get(key), artifact);
    next.set(key, observed);
    if (!previous.has(key) || previous.get(key)?.key !== observed?.key) changed = true;
  }
  return changed || previous.size !== next.size ? next : previous;
}
