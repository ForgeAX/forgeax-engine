import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ParityProvenance,
  PipelineEvidenceArtifact,
  PipelineEvidenceNormalization,
  PipelineEvidenceObservation,
  PipelineEvidencePipelineId,
  PipelineEvidenceRuntimeId,
  SceneCase,
} from '../contracts/types';

export interface PipelineEvidenceObservationInput {
  readonly bytes?: Uint8Array | readonly number[];
  readonly format?: string;
  readonly size?: { readonly width: number; readonly height: number };
  readonly frameId?: number;
  readonly pipelineId?: string;
  readonly backendId?: string;
}

export interface CreatePipelineEvidenceInput {
  readonly invocationId: string;
  readonly sceneCase: SceneCase | Record<string, unknown>;
  readonly pipelineId: PipelineEvidencePipelineId;
  readonly runtimeId: PipelineEvidenceRuntimeId;
  readonly backendId: string;
  readonly frameId: number;
  readonly copySrc: boolean;
  readonly lifetime: 'active' | 'retired';
  readonly provenance: ParityProvenance & { readonly adapterId: string };
  readonly normalization: PipelineEvidenceNormalization;
  readonly linearHdr: PipelineEvidenceObservationInput & { readonly format: string; readonly size: { readonly width: number; readonly height: number } };
  readonly finalDisplay: PipelineEvidenceObservationInput & { readonly format: string; readonly size: { readonly width: number; readonly height: number } };
}

function fail(message: string): never {
  throw new Error(`PipelineEvidence artifact rejected: ${message}`);
}

function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) fail('canonical input contains a non-finite number');
  if (value instanceof Uint8Array) return canonicalize(Array.from(value));
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail('canonical input contains an unsupported value');
  return serialized;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashCanonical(value: unknown): string {
  return sha256(canonicalJsonBytes(value));
}

function semanticSceneCase(sceneCase: Record<string, unknown>): Record<string, unknown> {
  const { caseId: _caseId, pipeline: _pipeline, ...semantic } = sceneCase;
  return semantic;
}

function toBytes(bytes: Uint8Array | readonly number[] | undefined, field: string): number[] {
  if (bytes === undefined || bytes.length === 0) fail(`${field}.bytes must contain live producer bytes`);
  const result = Array.from(bytes);
  if (result.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    fail(`${field}.bytes must contain byte values`);
  }
  return result;
}

function validateIdentity(input: CreatePipelineEvidenceInput): void {
  if (input.invocationId.length === 0) fail('invocationId is required');
  if (input.backendId.length === 0 || input.provenance.adapterId.length === 0) fail('producer provenance is incomplete');
  if (!Number.isInteger(input.frameId) || input.frameId < 0) fail('frameId is invalid');
  if (!input.copySrc || input.lifetime !== 'active') fail('the observation lease is not a live COPY_SRC attachment');
  if (input.normalization.authorityId !== 'threeR184SquaredWindow' || input.normalization.intensityScale !== 1 || input.normalization.rangeModel !== 'squared-finite' || input.normalization.coneModel !== 'radians-to-degrees') {
    fail('normalization does not match the frozen authority');
  }
}

function observation(
  input: PipelineEvidenceObservationInput & { readonly format: string; readonly size: { readonly width: number; readonly height: number } },
  kind: PipelineEvidenceObservation['kind'],
  owner: CreatePipelineEvidenceInput,
  bytes: number[],
): PipelineEvidenceObservation {
  if (input.frameId !== undefined && input.frameId !== owner.frameId) fail(`${kind}.frameId does not match producer frame`);
  if (input.pipelineId !== undefined && input.pipelineId !== owner.pipelineId) fail(`${kind}.pipelineId does not match producer pipeline`);
  if (input.backendId !== undefined && input.backendId !== owner.backendId) fail(`${kind}.backendId does not match producer backend`);
  if (input.size.width <= 0 || input.size.height <= 0 || !Number.isInteger(input.size.width) || !Number.isInteger(input.size.height)) fail(`${kind}.size is invalid`);
  return {
    kind,
    status: 'ready',
    bytes,
    format: input.format,
    size: input.size,
    rawHash: sha256(Uint8Array.from(bytes)),
    frameId: owner.frameId,
    pipelineId: owner.pipelineId,
    backendId: owner.backendId,
  };
}

export async function createPipelineEvidenceArtifact(
  input: CreatePipelineEvidenceInput,
): Promise<PipelineEvidenceArtifact> {
  validateIdentity(input);
  const sceneCase = { ...input.sceneCase } as Record<string, unknown>;
  const caseId = sceneCase.caseId;
  if (typeof caseId !== 'string' || caseId.length === 0) fail('sceneCase.caseId is required');
  const linearBytes = toBytes(input.linearHdr.bytes, 'linearHdr');
  const finalBytes = toBytes(input.finalDisplay.bytes, 'finalDisplay');
  if (input.linearHdr.format !== 'rgba16float') fail('linearHdr.format must be rgba16float');
  if (!/^(rgba|bgra)8unorm$/.test(input.finalDisplay.format)) fail('finalDisplay.format must be an 8-bit unorm format');
  const artifact: PipelineEvidenceArtifact = {
    schemaVersion: 1,
    invocationId: input.invocationId,
    caseId,
    sceneCase,
    sourceHash: hashCanonical(sceneCase),
    semanticHash: hashCanonical(semanticSceneCase(sceneCase)),
    pipelineId: input.pipelineId,
    runtimeId: input.runtimeId,
    backendId: input.backendId,
    frameId: input.frameId,
    copySrc: true,
    lifetime: 'active',
    semantic: 'linear-hdr',
    source: 'live-producer',
    provenance: input.provenance,
    normalization: input.normalization,
    linearHdr: observation(input.linearHdr, 'linearHdr', input, linearBytes),
    finalDisplay: observation(input.finalDisplay, 'finalDisplay', input, finalBytes),
  };
  if (artifact.linearHdr.rawHash === artifact.finalDisplay.rawHash) fail('linearHdr and finalDisplay must have independent bytes');
  return artifact;
}

export async function writePipelineEvidence(path: string, artifact: PipelineEvidenceArtifact): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const bytes = canonicalJsonBytes(artifact);
  await writeFile(path, `${new TextDecoder().decode(bytes)}\n`, 'utf8');
}
