import { describe, expect, it } from 'vitest';
import { deriveCaseStatus } from '../../report/status';
import { projectIblCapabilityStatus } from '../../report/capability-status';

describe('IBL capability integration status', () => {
  it('keeps the HDR path complete when the producer capability is available', () => {
    const report = projectIblCapabilityStatus({
      rgba16floatRenderable: true,
      lastKnownGood: 'ibl-constant-environment',
    });

    expect(report).toMatchObject({
      capabilityStatus: 'supported',
      executionStatus: 'complete',
      verdict: 'passed',
      fallbackArtifact: null,
      outputFormat: 'rgba16float',
      lastKnownGood: 'ibl-constant-environment',
    });
    expect(deriveCaseStatus(report)).toBe('complete');
  });

  it('keeps capability loss observable instead of promoting white-cube fallback', () => {
    const report = projectIblCapabilityStatus({
      rgba16floatRenderable: false,
      lastKnownGood: 'ibl-constant-environment',
    });

    expect(report).toMatchObject({
      capabilityStatus: 'degraded',
      executionStatus: 'notExecuted',
      verdict: 'failed',
      fallbackArtifact: 'white-cube',
      outputFormat: null,
      lastKnownGood: 'ibl-constant-environment',
    });
    expect(report.outputFormat).not.toBe('rgba8unorm');
    expect(deriveCaseStatus(report)).toBe('partial');
  });
});
