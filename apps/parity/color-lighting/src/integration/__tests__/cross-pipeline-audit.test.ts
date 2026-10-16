import { describe, expect, it } from 'vitest';
import type { ObservationCapture } from '../../capture/attachment-readback';
import type { CrossPipelineAuditInput, PipelineAuditObservation } from '../../report/status';
import { auditCrossPipelineEvidence } from '../../report/status';

const REQUIRED_SIZE = { width: 1, height: 1 } as const;

function capture(kind: ObservationCapture['kind'], seed: number, pipelineId: PipelineAuditObservation['pipelineId']): ObservationCapture {
  return {
    kind,
    status: 'ready',
    bytes: new Uint8Array([seed, seed + 1]),
    format: kind === 'linearHdr' ? 'rgba16float' : 'rgba8unorm',
    size: REQUIRED_SIZE,
    rawHash: `${kind}-${pipelineId}-${seed}`,
    frameId: 3,
    pipelineId,
    backendId: 'dawn',
  };
}

function makeObservation(
  pipelineId: PipelineAuditObservation['pipelineId'],
  seed: number,
): PipelineAuditObservation {
  return {
    caseId: 'direct-directional',
    pipelineId,
    evidence: {
      linearHdr: capture('linearHdr', seed, pipelineId),
      finalDisplay: capture('finalDisplay', seed + 2, pipelineId),
    },
    semantic: 'linear-hdr',
    source: 'live-producer',
    copySrc: true,
    lifetime: 'active',
    size: REQUIRED_SIZE,
    normalization: {
      authorityId: 'threeR184SquaredWindow',
      intensityScale: 1,
      rangeModel: 'squared-finite',
      coneModel: 'radians-to-degrees',
    },
  };
}

function makeAuditInput(): CrossPipelineAuditInput {
  return {
    caseId: 'direct-directional',
    size: REQUIRED_SIZE,
    missingPipelineIds: [],
    urp: makeObservation('forgeax::standard', 1),
    hdrp: makeObservation('forgeax::standard', 11),
  };
}

describe('cross-pipeline evidence audit', () => {
  it('accepts independent live URP and HDRP producer evidence', () => {
    expect(auditCrossPipelineEvidence(makeAuditInput())).toMatchObject({
      ok: true,
      missingPipelineIds: [],
      firstDivergence: { owner: 'cross-pipeline', metric: 'linearHdr.rawHash' },
    });
  });

  it.each([
    ['missing pipeline', (input: CrossPipelineAuditInput) => ({ ...input, missingPipelineIds: ['forgeax::standard'] })],
    ['COPY_SRC removal', (input: CrossPipelineAuditInput) => ({ ...input, urp: { ...input.urp, copySrc: false } })],
    ['stale lifetime', (input: CrossPipelineAuditInput) => ({ ...input, hdrp: { ...input.hdrp, lifetime: 'retired' as const } })],
    ['replay substitution', (input: CrossPipelineAuditInput) => ({ ...input, hdrp: { ...input.hdrp, source: 'replay' as const } })],
    ['same producer evidence', (input: CrossPipelineAuditInput) => ({ ...input, hdrp: input.urp })],
    ['guessed multiplier', (input: CrossPipelineAuditInput) => ({ ...input, urp: { ...input.urp, normalization: { ...input.urp.normalization, intensityScale: 2 } } })],
    ['unsquared curve', (input: CrossPipelineAuditInput) => ({ ...input, hdrp: { ...input.hdrp, normalization: { ...input.hdrp.normalization, rangeModel: 'unsquared' as const } } })],
    ['bad format', (input: CrossPipelineAuditInput) => ({ ...input, urp: { ...input.urp, evidence: { ...input.urp.evidence, linearHdr: { ...input.urp.evidence.linearHdr, format: 'rgba8unorm' } } } })],
    ['bad size', (input: CrossPipelineAuditInput) => ({ ...input, hdrp: { ...input.hdrp, size: { width: 2, height: 1 } } })],
    ['self comparison', (input: CrossPipelineAuditInput) => ({ ...input, hdrp: input.urp })],
  ])('%s fails closed', (_name, mutate) => {
    const result = auditCrossPipelineEvidence(mutate(makeAuditInput()));
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
