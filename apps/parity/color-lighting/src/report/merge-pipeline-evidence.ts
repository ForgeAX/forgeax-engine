import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import pipelineEvidenceSchema from '../../schemas/pipeline-evidence.schema.json' with { type: 'json' };
import type {
  CrossRuntimeCaseReport,
  CrossRuntimeProducerReport,
  PipelineEvidenceArtifact,
} from '../contracts/types';

export type { PipelineEvidence, PipelineEvidenceArtifact } from '../contracts/types';

export type PipelineMergeErrorCode =
  | 'artifact-missing'
  | 'artifact-invalid'
  | 'artifact-hash-mismatch'
  | 'artifact-invocation-mismatch'
  | 'artifact-identity-mismatch'
  | 'artifact-pipeline-duplicate'
  | 'artifact-substitution'
  | 'artifact-read-failed';

export interface PipelineMergeError {
  readonly code: PipelineMergeErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly artifactIndex?: number;
    readonly field?: string;
    readonly pipelineId?: string;
    readonly reason?: string;
  };
}

export type PipelineMergeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PipelineMergeError };

export interface PipelineEvidenceArtifactResult {
  readonly ok: true;
  readonly value: PipelineEvidenceArtifact;
}

export interface MergePipelineEvidenceOptions {
  readonly invocationId: string;
  readonly artifacts: readonly unknown[];
}

export interface MergePipelineEvidenceValue {
  readonly report: CrossRuntimeCaseReport;
  readonly artifacts: readonly PipelineEvidenceArtifact[];
}

const REQUIRED_RUNTIME_IDS = ['browser', 'dawn'] as const;
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(pipelineEvidenceSchema);

function error(
  code: PipelineMergeErrorCode,
  expected: string,
  hint: string,
  detail: PipelineMergeError['detail'] = {},
): PipelineMergeResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite canonical value');
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('unsupported canonical value');
  return serialized;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function hashBytes(bytes: readonly number[]): string {
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

function withoutSemanticIdentity(sceneCase: Record<string, unknown>): Record<string, unknown> {
  const { caseId: _caseId, pipeline: _pipeline, ...semanticCase } = sceneCase;
  return semanticCase;
}

function validateArtifactIdentity(artifact: PipelineEvidenceArtifact, index: number): PipelineMergeResult<null> {
  if (artifact.caseId !== artifact.sceneCase.caseId) {
    return error('artifact-identity-mismatch', 'caseId matching the original SceneCase', 'rerun the producer with the same SceneCase source', {
      artifactIndex: index,
      field: 'caseId',
    });
  }
  if (artifact.sourceHash !== hashCanonical(artifact.sceneCase)) {
    return error('artifact-hash-mismatch', 'sourceHash of the complete SceneCase source', 'discard the artifact and rerun the producer', {
      artifactIndex: index,
      field: 'sourceHash',
    });
  }
  if (artifact.semanticHash !== hashCanonical(withoutSemanticIdentity(artifact.sceneCase))) {
    return error('artifact-hash-mismatch', 'semanticHash excluding only caseId and pipeline', 'discard the artifact and rerun the producer', {
      artifactIndex: index,
      field: 'semanticHash',
    });
  }
  if (artifact.source !== 'live-producer' || artifact.semantic !== 'linear-hdr' || !artifact.copySrc || artifact.lifetime !== 'active') {
    return error('artifact-substitution', 'live producer linear-hdr evidence', 'rerun the producer; replay and final-canvas evidence cannot close M4', {
      artifactIndex: index,
      field: 'source',
    });
  }
  return { ok: true, value: null };
}

function validateArtifactObservations(artifact: PipelineEvidenceArtifact, index: number): PipelineMergeResult<null> {
  const observations = [artifact.linearHdr, artifact.finalDisplay];
  for (const observation of observations) {
    if (
      observation.pipelineId !== artifact.pipelineId
      || observation.backendId !== artifact.backendId
      || observation.frameId !== artifact.frameId
    ) {
      return error('artifact-identity-mismatch', 'observation pipeline/backend/frame provenance matching the producer', 'rerun the producer and preserve native provenance fields', {
        artifactIndex: index,
        field: observation.kind,
      });
    }
    if (observation.rawHash !== hashBytes(observation.bytes)) {
      return error('artifact-hash-mismatch', 'rawHash recomputed from canonical observation bytes', 'discard the artifact and rerun the producer', {
        artifactIndex: index,
        field: `${observation.kind}.rawHash`,
      });
    }
  }
  if (
    artifact.linearHdr.kind !== 'linearHdr'
    || artifact.linearHdr.format !== 'rgba16float'
    || artifact.finalDisplay.kind !== 'finalDisplay'
    || !/^(rgba|bgra)8unorm$/.test(artifact.finalDisplay.format)
    || artifact.linearHdr.rawHash === artifact.finalDisplay.rawHash
  ) {
    return error('artifact-substitution', 'independent native linear HDR and final display observations', 'rerun the live producer without final-canvas or replay substitution', {
      artifactIndex: index,
      field: 'observations',
    });
  }
  if (
    artifact.normalization.authorityId !== 'threeR184SquaredWindow'
    || artifact.normalization.intensityScale !== 1
    || artifact.normalization.rangeModel !== 'squared-finite'
    || artifact.normalization.coneModel !== 'radians-to-degrees'
  ) {
    return error('artifact-substitution', 'revision-pinned Three r184 normalization', 'remove guessed multipliers and rerun the producer', {
      artifactIndex: index,
      field: 'normalization',
    });
  }
  return { ok: true, value: null };
}

function validateArtifact(
  input: unknown,
  index: number,
  invocationId: string,
): PipelineMergeResult<PipelineEvidenceArtifact> {
  if (!validateSchema(input)) {
    const first = validateSchema.errors?.[0];
    return error('artifact-invalid', 'schema-valid PipelineEvidence', 'rerun the named producer and preserve its artifact schema', {
      artifactIndex: index,
      field: first?.instancePath ?? '/',
      reason: first?.message ?? 'schema validation failed',
    });
  }
  const artifact = input as unknown as PipelineEvidenceArtifact;
  if (artifact.invocationId !== invocationId) {
    return error('artifact-invocation-mismatch', 'one invocationId for all producer artifacts', 'rerun browser and Dawn with one fresh invocation', {
      artifactIndex: index,
      field: 'invocationId',
    });
  }
  const identity = validateArtifactIdentity(artifact, index);
  if (!identity.ok) return identity;
  const observations = validateArtifactObservations(artifact, index);
  if (!observations.ok) return observations;
  return { ok: true, value: artifact };
}

function producerReport(artifact: PipelineEvidenceArtifact): CrossRuntimeProducerReport {
  return {
    pipelineId: artifact.pipelineId,
    runtimeId: artifact.runtimeId,
    backendId: artifact.backendId,
    frameId: artifact.frameId,
    copySrc: artifact.copySrc,
    lifetime: artifact.lifetime,
    provenance: artifact.provenance,
    semantic: artifact.semantic,
    source: artifact.source,
    sourceHash: artifact.sourceHash,
    semanticHash: artifact.semanticHash,
    linearHdr: artifact.linearHdr,
    finalDisplay: artifact.finalDisplay,
  };
}

function mergeValidatedArtifacts(
  artifacts: readonly PipelineEvidenceArtifact[],
): PipelineMergeResult<MergePipelineEvidenceValue> {
  const first = artifacts[0];
  if (first === undefined) return error('artifact-missing', 'one browser and one Dawn artifact', 'run both producer environments before merging', { field: 'artifacts' });
  const runtimeIds = artifacts.map((artifact) => artifact.runtimeId);
  if (new Set(runtimeIds).size !== runtimeIds.length) {
    return error('artifact-pipeline-duplicate', 'one artifact for each required runtime', 'remove duplicate runtime artifacts and rerun both producers', { field: 'runtimeId' });
  }
  if (artifacts.length !== REQUIRED_RUNTIME_IDS.length || !REQUIRED_RUNTIME_IDS.every((runtimeId) => runtimeIds.includes(runtimeId))) {
    return error('artifact-missing', 'one forgeax::standard artifact from each runtime', 'run the missing browser or Dawn producer and pass its explicit artifact path', { field: 'runtimeId' });
  }
  if (artifacts.slice(1).some((artifact) => artifact === first)) {
    return error('artifact-substitution', 'independent producer artifact objects', 'do not compare one artifact object with itself', { field: 'artifacts' });
  }
  if (artifacts.some((artifact) => artifact.caseId !== first.caseId || artifact.sourceHash !== first.sourceHash || artifact.semanticHash !== first.semanticHash)) {
    return error('artifact-identity-mismatch', 'matching case, source, and semantic identity', 'rerun both producers from one invocation and one SceneCase source', { field: 'identity' });
  }
  const browser = artifacts.find((artifact) => artifact.runtimeId === 'browser');
  const dawn = artifacts.find((artifact) => artifact.runtimeId === 'dawn');
  if (browser === undefined || dawn === undefined) return error('artifact-missing', 'validated browser and Dawn entries', 'rerun both producer environments', { field: 'runtimeId' });
  const capturedPipelineIds = ['standard'] as const;
  const orderedArtifacts = [browser, dawn] as const;
  const report: CrossRuntimeCaseReport = {
    schemaVersion: 2,
    caseId: first.caseId,
    required: first.sceneCase.required === true,
    invocationId: first.invocationId,
    sceneCaseIdentity: { sourceHash: first.sourceHash, semanticHash: first.semanticHash },
    attachmentEvidence: {
      producers: orderedArtifacts.map(producerReport),
      attachmentReadbackStatus: 'complete',
      capabilityStatus: 'supported',
      executionStatus: 'complete',
      verdict: 'passed',
      capturedPipelineIds,
      missingPipelineIds: [],
    },
    verdict: 'passed',
    status: 'complete',
  };
  return { ok: true, value: { report, artifacts: orderedArtifacts } };
}

export function mergePipelineEvidence(options: MergePipelineEvidenceOptions): PipelineMergeResult<MergePipelineEvidenceValue> {
  if (options.artifacts.length === 0) return error('artifact-missing', 'one URP and one HDRP artifact', 'run both producer environments before merging', { field: 'artifacts' });
  const validated: PipelineEvidenceArtifact[] = [];
  for (const [index, artifact] of options.artifacts.entries()) {
    const result = validateArtifact(artifact, index, options.invocationId);
    if (!result.ok) return result;
    validated.push(result.value);
  }
  return mergeValidatedArtifacts(validated);
}

export async function readPipelineEvidence(path: string): Promise<PipelineMergeResult<PipelineEvidenceArtifact>> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const artifactInvocation = parsed !== null && typeof parsed === 'object' && 'invocationId' in parsed
      && typeof parsed.invocationId === 'string'
      ? parsed.invocationId
      : '';
    return validateArtifact(parsed, 0, artifactInvocation);
  } catch (cause) {
    return error('artifact-read-failed', 'readable JSON PipelineEvidence artifact', 'check the explicit producer artifact path and rerun that producer', {
      field: 'path',
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export async function mergePipelineEvidenceFromPaths(
  invocationId: string,
  paths: readonly string[],
): Promise<PipelineMergeResult<MergePipelineEvidenceValue>> {
  const artifacts: PipelineEvidenceArtifact[] = [];
  for (const path of paths) {
    const result = await readPipelineEvidence(path);
    if (!result.ok) return result;
    artifacts.push(result.value);
  }
  return mergePipelineEvidence({ invocationId, artifacts });
}
