import { describe, expect, it } from 'vitest';
import { createTemporalGraphRoster } from '../record/typed-frame-graph';

describe('TAA graph topology', () => {
  it('uses one shared temporal target and one resolve in both lighting lanes', () => {
    const direct = createTemporalGraphRoster({ antialias: 'taa', lane: 'direct' });
    const clustered = createTemporalGraphRoster({ antialias: 'taa', lane: 'clustered' });
    expect(direct).toEqual(clustered);
    expect(direct.targets).toEqual([
      'standard-scene-temporal',
      'taa-history-current-color',
      'taa-history-previous-color',
      'taa-history-current-temporal',
      'taa-history-previous-temporal',
    ]);
    expect(direct.passes.filter((name) => name === 'taa-resolve')).toHaveLength(1);
    expect(direct.passes.indexOf('taa-resolve')).toBeLessThan(
      direct.passes.indexOf('output-transform'),
    );
  });

  it('keeps the disabled roster exactly empty', () => {
    expect(createTemporalGraphRoster({ antialias: 'none', lane: 'direct' })).toEqual({
      targets: [],
      passes: [],
      uploads: 0,
    });
    expect(createTemporalGraphRoster({ antialias: 'fxaa', lane: 'clustered' })).toEqual({
      targets: [],
      passes: [],
      uploads: 0,
    });
  });

  it('admits TAA only when MRT and rgba16float render/sample capabilities agree', () => {
    expect(
      createTemporalGraphRoster({
        antialias: 'taa',
        lane: 'direct',
        capabilities: { rgba16floatRender: true, rgba16floatSample: true, mrt: true },
      }).enabled,
    ).toBe(true);
    expect(
      createTemporalGraphRoster({
        antialias: 'taa',
        lane: 'direct',
        capabilities: { rgba16floatRender: true, rgba16floatSample: false, mrt: true },
      }).enabled,
    ).toBe(false);
  });
});
