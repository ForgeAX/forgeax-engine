import { describe, expect, it } from 'vitest';
import { deriveCaseStatus } from '../../../src/report/status';
import { projectIblCapabilityStatus } from '../../../src/report/capability-status';

describe('IBL capability-loss case', () => {
  it('records failed execution and the recoverable artifact', () => {
    const report = projectIblCapabilityStatus({ rgba16floatRenderable: false });

    expect(report.capabilityStatus).toBe('degraded');
    expect(report.executionStatus).toBe('notExecuted');
    expect(report.verdict).toBe('failed');
    expect(report.fallbackArtifact).toBe('white-cube');
    expect(report.hint).toContain('rgba16floatRenderable');
    expect(deriveCaseStatus(report)).not.toBe('complete');
  });
});
