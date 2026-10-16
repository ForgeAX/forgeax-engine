import { describe, expect, it } from 'vitest';
import {
  aggregateTemporalDemand,
  standardTemporalLaneAdmission,
} from '../temporal/standard-scene-data';

describe('Standard temporal producer admission', () => {
  it.each([
    ['direct', { compute: true, storageBuffer: true }],
    ['clustered', { compute: true, storageBuffer: true }],
    ['cpu-webgl2', { compute: false, storageBuffer: false }],
    ['rhi-null', { compute: true, storageBuffer: true }],
  ] as const)('shares temporal-v1 semantics on the %s lane', (lane, caps) => {
    const admission = standardTemporalLaneAdmission({
      lane,
      demand: aggregateTemporalDemand({ taa: true, motionBlur: true }),
      capabilities: { ...caps, rgba16floatRenderable: true },
    });
    expect(admission.status).toBe('available');
    if (admission.status !== 'available') return;
    expect(admission.schema).toBe('forgeax::scene-data::temporal-v1');
    expect(admission.producerId).toBe('forgeax::standard::scene-data');
    expect(admission.structuralOnly).toBe(lane === 'rhi-null');
  });

  it('returns closed unavailable data without an 8-bit fallback', () => {
    const admission = standardTemporalLaneAdmission({
      lane: 'direct',
      demand: aggregateTemporalDemand({ taa: true, motionBlur: false }),
      capabilities: { compute: true, storageBuffer: true, rgba16floatRenderable: false },
    });
    expect(admission).toMatchObject({ status: 'unavailable', reason: 'capability-missing' });
    expect(admission).not.toHaveProperty('format', 'rgba8unorm');
  });
});
