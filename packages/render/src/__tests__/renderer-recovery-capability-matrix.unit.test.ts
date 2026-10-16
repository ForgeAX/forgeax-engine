import { describe, expect, it } from 'vitest';
import {
  classifyRecoveryCapability,
  type RecoveryCapabilityFacts,
} from '../gpu-driven/production-raster';

const allCapabilities: RecoveryCapabilityFacts = {
  generation: 7,
  compute: true,
  storageBuffer: true,
  indirectDrawing: true,
  multisample: true,
  shaderCompilation: true,
};

describe('renderer recovery capability matrix', () => {
  it('publishes the standard fallback when optional capability is absent', () => {
    const result = classifyRecoveryCapability({
      ...allCapabilities,
      multisample: false,
    });

    expect(result).toEqual({
      status: 'fallback',
      generation: 7,
      disabled: [],
    });
  });

  it('reports optional GPU-driven work as disabled without allocation', () => {
    const result = classifyRecoveryCapability({
      ...allCapabilities,
      compute: false,
      storageBuffer: false,
      indirectDrawing: false,
    });

    expect(result).toEqual({
      status: 'disabled',
      generation: 7,
      disabled: ['gpu-driven'],
      allocations: 0,
    });
  });

  it('refuses a generation that lacks a core shader capability', () => {
    const result = classifyRecoveryCapability({
      ...allCapabilities,
      shaderCompilation: false,
    });

    expect(result).toEqual({
      status: 'refused',
      generation: 7,
      failedOwner: 'shader-material-pipeline',
      resourceKind: 'pipeline',
    });
  });
});
