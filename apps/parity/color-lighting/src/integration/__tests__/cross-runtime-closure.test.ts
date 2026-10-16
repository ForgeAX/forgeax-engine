import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import caseReportSchema from '../../../schemas/case-report.schema.json' with { type: 'json' };
import {
  mergePipelineEvidence,
  type PipelineEvidence,
  type PipelineEvidenceArtifact,
} from '../../report/merge-pipeline-evidence';

const validateCaseReport = new Ajv2020({ allErrors: true, strict: false }).compile(caseReportSchema);

const sceneCase = {
  caseId: 'direct-directional',
  required: true,
  colorDomain: 'linearHdr',
  pipeline: { identity: 'standard', engineId: 'forgeax::standard', renderPath: 'forward' },
  scene: { width: 1, height: 1, background: [0, 0, 0, 1] },
  budget: { analyticMax: 0.01, roiMax: 0.01, byteMax: 0 },
};

const invocationId = 'm4-invocation-1';
const size = { width: 1, height: 1 } as const;

function hashBytes(bytes: readonly number[]): string {
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function makeArtifact(
  pipelineId: PipelineEvidence['pipelineId'],
  runtimeId: PipelineEvidence['runtimeId'],
  seed: number,
): PipelineEvidenceArtifact {
  const linearBytes = [seed, seed + 1, seed + 2, seed + 3];
  const finalBytes = [seed + 4, seed + 5, seed + 6, seed + 7];
  const { caseId: _caseId, pipeline: _pipeline, ...semanticCase } = sceneCase;
  const sourceHash = hashCanonical(sceneCase);
  const semanticHash = hashCanonical(semanticCase);
  return {
    schemaVersion: 1,
    invocationId,
    caseId: sceneCase.caseId,
    sceneCase,
    sourceHash,
    semanticHash,
    pipelineId,
    runtimeId,
    backendId: runtimeId === 'browser' ? 'webgpu' : 'dawn',
    frameId: runtimeId === 'browser' ? 3 : 299,
    copySrc: true,
    lifetime: 'active',
    semantic: 'linear-hdr',
    source: 'live-producer',
    provenance: {
      implementation: 'forgeax',
      version: 'workspace',
      renderer: runtimeId === 'browser' ? 'webgpu' : 'wgpu',
      adapterId: `${runtimeId}-${pipelineId}`,
    },
    normalization: {
      authorityId: 'threeR184SquaredWindow',
      intensityScale: 1,
      rangeModel: 'squared-finite',
      coneModel: 'radians-to-degrees',
    },
    linearHdr: {
      kind: 'linearHdr',
      status: 'ready',
      bytes: linearBytes,
      format: 'rgba16float',
      size,
      rawHash: hashBytes(linearBytes),
      frameId: runtimeId === 'browser' ? 3 : 299,
      pipelineId,
      backendId: runtimeId === 'browser' ? 'webgpu' : 'dawn',
    },
    finalDisplay: {
      kind: 'finalDisplay',
      status: 'ready',
      bytes: finalBytes,
      format: 'rgba8unorm',
      size,
      rawHash: hashBytes(finalBytes),
      frameId: runtimeId === 'browser' ? 3 : 299,
      pipelineId,
      backendId: runtimeId === 'browser' ? 'webgpu' : 'dawn',
    },
  };
}

function validArtifacts(): readonly PipelineEvidenceArtifact[] {
  return [
    makeArtifact('forgeax::standard', 'browser', 1),
    makeArtifact('forgeax::standard', 'dawn', 11),
  ];
}

describe('cross-runtime closure contract', () => {
  it('fails before merge owner exists', () => {
    const result = mergePipelineEvidence({ invocationId, artifacts: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected missing artifacts to fail closed');
    expect(result.error.code).toBe('artifact-missing');
  });

  it('requires both independent producer identities for one invocation', () => {
    const result = mergePipelineEvidence({ invocationId, artifacts: validArtifacts() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.hint);
    expect(result.value.report.attachmentEvidence.producers).toHaveLength(2);
    expect(validateCaseReport(result.value.report), JSON.stringify(validateCaseReport.errors)).toBe(true);
    expect(result.value.report.attachmentEvidence.capturedPipelineIds).toEqual(['standard']);
    expect(result.value.report.attachmentEvidence.missingPipelineIds).toEqual([]);
    expect(result.value.report.attachmentEvidence.producers.map((entry) => entry.frameId)).toEqual([3, 299]);
  });

  it.each([
    ['stale invocation', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact) => ({ ...artifact, invocationId: 'old' }))],
    ['source identity mismatch', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact, index) => index === 1 ? { ...artifact, sourceHash: 'wrong' } : artifact)],
    ['semantic identity mismatch', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact, index) => index === 1 ? { ...artifact, semanticHash: 'wrong' } : artifact)],
    ['duplicate runtime', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact) => ({ ...artifact, runtimeId: 'browser' as const }))],
    ['Dawn relabeled as browser', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact, index) => index === 1 ? { ...artifact, runtimeId: 'browser' as const } : artifact)],
    ['hash tampering', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact, index) => index === 1 ? { ...artifact, linearHdr: { ...artifact.linearHdr, rawHash: 'wrong' } } : artifact)],
    ['replay substitution', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact, index) => index === 1 ? { ...artifact, source: 'replay' as const } : artifact)],
    ['guessed curve', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact, index) => index === 1 ? { ...artifact, normalization: { ...artifact.normalization, rangeModel: 'guessed' as const } } : artifact)],
    ['missing provenance', (artifacts: readonly PipelineEvidenceArtifact[]) => artifacts.map((artifact, index) => index === 1 ? { ...artifact, backendId: '' } : artifact)],
    ['self comparison', (artifacts: readonly PipelineEvidenceArtifact[]) => [artifacts[0], artifacts[0]]],
  ])('%s fails closed', (_name, mutate) => {
    const result = mergePipelineEvidence({ invocationId, artifacts: mutate(validArtifacts()) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid closure input');
    expect(result.error.code).toMatch(/artifact|identity|hash|pipeline|evidence/);
  });
});
