import { describe, expect, it } from 'vitest';
import { validateAttachmentEvidence } from '../../capture/attachment-readback';
import { deriveCoverageStatus } from '../../coverage/build-status-index';
import { parityError } from '../../errors';
import { deriveAttachmentReportStatus, deriveCaseStatus, type CaseStatusInput } from '../status';

describe('staged status derivation', () => {
  it.each<[CaseStatusInput, string]>([
    [{ capabilityStatus: 'missing', executionStatus: 'notExecuted', verdict: 'notRun' }, 'failed'],
    [{ capabilityStatus: 'unsupported', executionStatus: 'notExecuted', verdict: 'notRun' }, 'failed'],
    [{ capabilityStatus: 'supported', executionStatus: 'notExecuted', verdict: 'notRun' }, 'partial'],
    [{ capabilityStatus: 'supported', executionStatus: 'complete', verdict: 'passed', required: true, primary: false }, 'partial'],
    [{ capabilityStatus: 'supported', executionStatus: 'complete', verdict: 'passed', required: true, primary: true, matrixComplete: true }, 'complete'],
  ])('derives %s', (input, expected) => {
    expect(deriveCaseStatus(input)).toBe(expected);
  });

  it('keeps missing linear evidence blocked even when final display is present', () => {
    const result = validateAttachmentEvidence({
      linearHdr: { kind: 'linearHdr', status: 'blocked' },
      finalDisplay: {
        kind: 'finalDisplay',
        status: 'ready',
        bytes: new Uint8Array([1]),
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
        rawHash: 'display',
        frameId: 1,
        pipelineId: 'forgeax::standard',
        backendId: 'webgpu',
      },
    });
    expect(result.ok).toBe(false);
  });

  it('does not promote unsupported or not-executed attachment reports to complete', () => {
    const base = {
      linearHdr: { kind: 'linearHdr' as const, status: 'blocked' as const },
      finalDisplay: { kind: 'finalDisplay' as const, status: 'blocked' as const },
      attachmentReadbackStatus: 'blocked' as const,
      capabilityStatus: 'unsupported' as const,
      executionStatus: 'notExecuted' as const,
      verdict: 'notRun' as const,
      missingPipelineIds: ['forgeax::standard'],
    };
    expect(deriveAttachmentReportStatus(base)).toBe('failed');
  });

  it('routes stale lifetime to a structured producer observation error', () => {
    const error = parityError('observation-evidence-missing', {
      code: 'observation-evidence-missing',
      owner: 'lifetime',
      reason: 'stale',
    });
    expect(error.detail).toEqual({ code: 'observation-evidence-missing', owner: 'lifetime', reason: 'stale' });
    expect(error.expected).toContain('fresh');
    expect(error.hint).toContain('producer');
  });
});

describe('coverage status fail-closed mapping', () => {
  it('reports a partial stage when only the browser primary slice passes', () => {
    const result = deriveCoverageStatus({
      cases: [
        {
          caseId: 'default-alpha',
          required: true,
          requiredStatus: 'pass',
          primaryStatus: 'pass',
          matrixStatus: 'not-executed',
        },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.matrix.notExecuted).toBe(1);
  });

  it('does not turn unsupported fallback capability into a passing matrix', () => {
    const result = deriveCoverageStatus({
      cases: [
        {
          caseId: 'default-alpha',
          required: true,
          requiredStatus: 'pass',
          primaryStatus: 'pass',
          matrixStatus: 'unsupported',
        },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.matrix.unsupported).toBe(1);
  });
});
