import { describe, expect, it } from 'vitest';
import { validateVisualEvidence, type VisualEvidenceIndex } from '../build-status-index';
import { buildPublicParityStatusIndex, isPublicParityComplete, mergeInjectedVisualEvidenceStatuses, parityCommandExitCode } from '../public-status';
import { PARITY_CASE_AUTHORITY } from '../required-cases';

describe('status index visual association', () => {
  it('does not accept a visual index with fewer than the three required targets', () => {
    const input: VisualEvidenceIndex = {
      caseId: 'default-alpha',
      width: 32,
      height: 32,
      background: [0, 0, 0, 0],
      framing: 'orthographic-center',
      artifacts: [],
    };

    expect(validateVisualEvidence(input).ok).toBe(false);
  });

  it('rejects duplicate artifact kinds that could hide a missing target', () => {
    const artifact = {
      kind: 'forgeax-final' as const,
      url: 'artifact://forgeax',
      path: 'report/forgeax.png',
      caseId: 'default-alpha',
      width: 32,
      height: 32,
      background: [0, 0, 0, 0] as const,
      frameId: 1,
      rawHash: 'abcdef12345678',
      expected: 'same case framing and output dimensions',
      observed: 'visible',
      verdict: 'pass' as const,
      confidence: 'high' as const,
    };

    expect(validateVisualEvidence({
      caseId: 'default-alpha',
      width: 32,
      height: 32,
      background: [0, 0, 0, 0],
      framing: 'orthographic-center',
      artifacts: [artifact, { ...artifact, url: 'artifact://forgeax-2' }, { ...artifact, url: 'artifact://diff' }],
    }).ok).toBe(false);
  });

  it('retains missing cases, pipelines, and backends instead of projecting pass', () => {
    const index = buildPublicParityStatusIndex({
      caseStatuses: { 'positive-minimal': 'pass' },
      caseBackendStatuses: {
        'positive-minimal': { 'browser-webgpu': 'pass' },
      },
      backends: {
        'browser-webgpu': 'pass',
        dawn: 'not-executed',
        'chromium-webgl2': 'not-executed',
      },
      missingPipelineIds: ['hdrp'],
    });

    expect(index.status).toBe('partial');
    expect(index.missingCaseIds).toContain('ibl-constant-environment');
    expect(index.missingCaseIds).toContain('transparent-hdr-hdrp');
    expect(index.missingMatrixCaseIds).toContain('ibl-constant-environment');
    expect(index.missingMatrixCaseIds).not.toContain('positive-minimal');
    expect(index.missingBackendIds).toEqual(['dawn', 'chromium-webgl2']);
    expect(index.missingPipelineIds).toEqual(['hdrp']);
    expect(isPublicParityComplete(index)).toBe(false);
  });

  it('returns a nonzero command result when the browser result is not ok', () => {
    const completeBackendStatus = {
      'browser-webgpu': 'pass',
      dawn: 'pass',
      'chromium-webgl2': 'pass',
    } as const;
    const completeCaseBackendStatuses = Object.fromEntries(
      PARITY_CASE_AUTHORITY.map((entry) => [entry.caseId, completeBackendStatus]),
    );
    const completeIndex = buildPublicParityStatusIndex({
      caseStatuses: Object.fromEntries(PARITY_CASE_AUTHORITY.map((entry) => [entry.caseId, 'pass'])),
      caseBackendStatuses: completeCaseBackendStatuses,
      backends: completeBackendStatus,
      missingPipelineIds: [],
    });

    expect(parityCommandExitCode({ browserOk: false, statusIndex: completeIndex })).toBe(1);
    expect(parityCommandExitCode({ browserOk: true, statusIndex: completeIndex })).toBe(0);
  });

  it('does not let a global Dawn success cover an unobserved IBL case', () => {
    const index = buildPublicParityStatusIndex({
      caseStatuses: { 'ibl-constant-environment': 'not-executed' },
      caseBackendStatuses: {},
      backends: {
        'browser-webgpu': 'pass',
        dawn: 'pass',
      'chromium-webgl2': 'pass',
      },
      missingPipelineIds: [],
    });

    expect(index.cases.find((entry) => entry.caseId === 'ibl-constant-environment')).toMatchObject({
      requiredStatus: 'not-executed',
      primaryStatus: 'not-executed',
      matrixStatus: 'not-executed',
      matrixRequiredBackends: ['browser-webgpu', 'dawn'],
    });
    expect(index.missingCaseIds).toContain('ibl-constant-environment');
    expect(index.missingMatrixCaseIds).toContain('ibl-constant-environment');
  });

  it('projects injected vertex visual reports into required browser case status', () => {
    const merged = mergeInjectedVisualEvidenceStatuses(
      { 'positive-minimal': 'pass' },
      { 'positive-minimal': { 'browser-webgpu': 'pass' } },
      [{ caseId: 'vertex-color-vec3', status: 'complete', verdict: 'passed' }],
    );

    expect(merged.caseStatuses['vertex-color-vec3']).toBe('pass');
    expect(merged.caseBackendStatuses['vertex-color-vec3']).toEqual({ 'browser-webgpu': 'pass' });
  });
});
