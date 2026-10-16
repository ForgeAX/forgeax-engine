import { describe, expect, it } from 'vitest';
import constantEnvironment from '../constant-environment.json' with { type: 'json' };
import { captureIblGpuCase } from '../../../src/adapters/ibl-adapter';

describe('IBL browser GPU case', () => {
  it('records E/pi analytics and real capability/readback evidence', async () => {
    const result = await captureIblGpuCase(navigator.gpu);

    expect(result.analytic.maxError).toBeLessThan(constantEnvironment.analyticMax);
    expect(result.analytic.reconstructed).toBeCloseTo(constantEnvironment.environment, 12);
    if (result.capability.capabilityStatus !== 'supported') {
      expect(result.capability.verdict).toBe('failed');
      expect(result.capability.executionStatus).toBe('notExecuted');
      expect(result.evidence.status).toBe('failed');
      return;
    }
    expect(result.evidence).toMatchObject({
      status: 'ready',
      format: constantEnvironment.outputFormat,
      attachmentName: 'ibl.constant-environment',
      layer: 0,
      frameId: 0,
      capabilitySnapshot: { rgba16floatRenderable: true },
      fallbackArtifact: null,
    });
    expect(result.evidence.bytes?.byteLength).toBe(8);
    expect(result.evidence.rawHash).toMatch(/^[0-9a-f]{8}$/);
    expect(result.finalDisplay.status).toBe('ready');
    expect(result.finalDisplay.format).toBe('rgba8unorm');
    expect(result.finalDisplay.bytes?.byteLength).toBe(4);
  });
});
