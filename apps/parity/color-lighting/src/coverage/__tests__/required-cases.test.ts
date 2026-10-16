import { describe, expect, it } from 'vitest';
import { deriveCoverageStatus } from '../build-status-index';
import {
  PARITY_CASE_AUTHORITY,
  PARITY_REQUIRED_BACKEND_IDS,
  PARITY_REQUIRED_CASE_IDS,
  PARITY_REQUIRED_PIPELINE_IDS,
} from '../required-cases';

describe('required coverage accounting', () => {
  it('counts only required cases toward the completion gate', () => {
    const result = deriveCoverageStatus({
      cases: [
        {
          caseId: 'required-tone',
          required: true,
          requiredStatus: 'pass',
          primaryStatus: 'pass',
          matrixStatus: 'pass',
        },
        {
          caseId: 'diagnostic-only',
          required: false,
          requiredStatus: 'not-executed',
          primaryStatus: 'not-executed',
          matrixStatus: 'not-executed',
        },
      ],
    });

    expect(result.required.total).toBe(1);
    expect(result.status).toBe('complete');
  });

  it('keeps a missing required case visible as not executed', () => {
    const result = deriveCoverageStatus({
      cases: [
        {
          caseId: 'required-tone',
          required: true,
          requiredStatus: 'not-executed',
          primaryStatus: 'not-executed',
          matrixStatus: 'not-executed',
        },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.required.notExecuted).toBe(1);
    expect(result.primary.notExecuted).toBe(1);
    expect(result.matrix.notExecuted).toBe(1);
  });

  it('exposes the existing M0-M6 fixtures through one public authority', () => {
    expect(PARITY_REQUIRED_CASE_IDS).toEqual(expect.arrayContaining([
      'positive-minimal',
      'ibl-constant-environment',
      'transparent-ldr-urp',
      'transparent-hdr-hdrp',
    ]));
    expect(PARITY_CASE_AUTHORITY.find((entry) => entry.caseId === 'ibl-capability-loss')).toMatchObject({
      required: false,
      owner: 'm5',
    });
    expect(PARITY_REQUIRED_BACKEND_IDS).toEqual(['browser-webgpu', 'dawn', 'chromium-webgl2']);
    expect(PARITY_REQUIRED_PIPELINE_IDS).toEqual(['urp', 'hdrp']);
    expect(new Set(PARITY_CASE_AUTHORITY.map((entry) => entry.caseId)).size).toBe(PARITY_CASE_AUTHORITY.length);
  });

  it('declares backend applicability per case instead of projecting one global pass', () => {
    expect(PARITY_CASE_AUTHORITY.find((entry) => entry.caseId === 'positive-minimal')).toMatchObject({
      matrixRequiredBackends: [],
    });
    expect(PARITY_CASE_AUTHORITY.find((entry) => entry.caseId === 'default-scalar-srgb')).toMatchObject({
      matrixRequiredBackends: ['browser-webgpu'],
    });
    expect(PARITY_CASE_AUTHORITY.find((entry) => entry.caseId === 'ibl-constant-environment')).toMatchObject({
      matrixRequiredBackends: ['browser-webgpu', 'dawn'],
    });
    expect(PARITY_CASE_AUTHORITY.find((entry) => entry.caseId === 'direct-directional-urp')).toMatchObject({
      matrixRequiredBackends: ['browser-webgpu', 'dawn', 'chromium-webgl2'],
    });
  });
});
