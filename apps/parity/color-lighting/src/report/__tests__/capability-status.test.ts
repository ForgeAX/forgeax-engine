import { describe, expect, it } from 'vitest';
import { projectIblCapabilityStatus } from '../capability-status';

describe('IBL capability report projection', () => {
  it('keeps a supported HDR capability executable and passable', () => {
    const report = projectIblCapabilityStatus({ rgba16floatRenderable: true });

    expect(report).toMatchObject({
      capabilityStatus: 'supported',
      executionStatus: 'complete',
      verdict: 'passed',
      fallbackArtifact: null,
    });
  });

  it('reports capability loss as failed or degraded, never pass', () => {
    const report = projectIblCapabilityStatus({ rgba16floatRenderable: false });

    expect(['failed', 'degraded']).toContain(report.capabilityStatus);
    expect(report.executionStatus).toBe('notExecuted');
    expect(report.verdict).not.toBe('passed');
    expect(report.fallbackArtifact).toBe('white-cube');
    expect(report.lastKnownGood).toBeDefined();
  });
});
