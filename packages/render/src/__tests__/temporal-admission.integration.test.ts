import { describe, expect, it } from 'vitest';
import {
  aggregateTemporalDemand,
  standardTemporalLaneAdmission,
} from '../temporal/standard-scene-data';

describe('temporal admission matrix', () => {
  it.each([
    'direct',
    'clustered',
    'cpu-webgl2',
    'rhi-null',
  ] as const)('admits one producer for TAA and Motion Blur on %s', (lane) => {
    const admission = standardTemporalLaneAdmission({
      lane,
      demand: aggregateTemporalDemand({ taa: true, motionBlur: true }),
      capabilities: {
        compute: lane !== 'cpu-webgl2',
        storageBuffer: lane !== 'cpu-webgl2',
        rgba16floatRenderable: true,
      },
    });
    expect(admission).toMatchObject({
      status: 'available',
      producerId: 'forgeax::standard::scene-data',
      format: 'rgba16float',
    });
  });

  it.each([
    { taa: false, motionBlur: false },
    { taa: true, motionBlur: false },
    { taa: false, motionBlur: true },
    { taa: true, motionBlur: true },
  ])('keeps admission demand cardinality deterministic for %j', (input) => {
    const demand = aggregateTemporalDemand(input);
    expect(demand.producerPassCount).toBe(input.taa || input.motionBlur ? 1 : 0);
    expect(demand.targetCount).toBe(input.taa || input.motionBlur ? 1 : 0);
  });
});
