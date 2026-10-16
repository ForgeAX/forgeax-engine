import { describe, expect, it } from 'vitest';
import { aggregateTemporalDemand, describeTemporalDemand } from '../temporal/standard-scene-data';

describe('Standard temporal demand', () => {
  it('provides motion for visible surfaces independently of color history', () => {
    const demand = aggregateTemporalDemand({ taa: false, motionBlur: false, visibleSurface: true });
    expect(demand).toEqual({
      consumerIds: ['visible-surface'],
      targetCount: 1,
      producerPassCount: 1,
      historyCount: 0,
    });
    expect(
      aggregateTemporalDemand({ taa: true, motionBlur: true, visibleSurface: true }),
    ).toMatchObject({
      targetCount: 1,
      producerPassCount: 1,
      historyCount: 1,
    });
  });
  it('keeps the disabled path at zero work before topology allocation', () => {
    const demand = aggregateTemporalDemand({ taa: false, motionBlur: false });
    expect(describeTemporalDemand(demand)).toEqual({
      consumerCount: 0,
      targetCount: 0,
      producerPassCount: 0,
      historyCount: 0,
      byteLength: 0,
    });
  });

  it.each([
    ['taa', { taa: true, motionBlur: false }],
    ['motion-blur', { taa: false, motionBlur: true }],
    ['taa-and-motion-blur', { taa: true, motionBlur: true }],
  ] as const)('deduplicates %s into one producer and target', (_name, input) => {
    const demand = aggregateTemporalDemand(input);
    expect(describeTemporalDemand(demand)).toMatchObject({
      consumerCount: input.taa && input.motionBlur ? 2 : 1,
      targetCount: 1,
      producerPassCount: 1,
      byteLength: 1,
    });
    expect(demand.historyCount).toBe(input.taa ? 1 : 0);
  });

  it('does not create a second producer when a consumer is repeated', () => {
    const demand = aggregateTemporalDemand({ taa: true, motionBlur: true });
    expect(demand.consumerIds).toEqual(['taa', 'motion-blur']);
    expect(aggregateTemporalDemand({ taa: true, motionBlur: true })).toEqual(demand);
  });

  it('keeps zero work for a missing or identity Motion Blur component', () => {
    expect(aggregateTemporalDemand({ taa: false, motionBlur: false })).toMatchObject({
      targetCount: 0,
      producerPassCount: 0,
      historyCount: 0,
    });
  });
});
