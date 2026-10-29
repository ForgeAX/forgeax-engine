import { describe, expect, it } from 'vitest';
import { RenderDrawTiming, renderStallReason } from '../execution/render-draw-timing';

describe('renderStallReason', () => {
  it('attributes the largest interval part', () => {
    expect(renderStallReason(20, 1, 0, 0, 0)).toBe('render-cpu');
    expect(renderStallReason(2, 10, 1, 0, 0)).toBe('publication');
    expect(renderStallReason(2, 1, 9, 0, 0)).toBe('queue');
  });

  it('splits the await into credit, simulation and publication in order', () => {
    // await 12 = credit 8 + simulation 3 + publication 1
    expect(renderStallReason(2, 12, 0, 8, 3)).toBe('credit');
    // await 12 = credit 2 + simulation 9 + publication 1
    expect(renderStallReason(2, 12, 0, 2, 9)).toBe('simulation');
    // Engine shares larger than the await are clamped to it.
    expect(renderStallReason(2, 4, 0, 0, 50)).toBe('simulation');
    expect(renderStallReason(2, 4, 0, 50, 50)).toBe('credit');
  });

  it('keeps the earlier reason on ties', () => {
    expect(renderStallReason(5, 5, 5, 0, 0)).toBe('render-cpu');
    expect(renderStallReason(0, 10, 0, 5, 5)).toBe('credit');
  });
});

describe('RenderDrawTiming', () => {
  function fixture() {
    const state = { now: 0, compiles: 0, pipelines: 0 };
    const timing = new RenderDrawTiming({
      now: () => state.now,
      graphCompiles: () => state.compiles,
      pipelineCreations: () => state.pipelines,
    });
    return { state, timing };
  }

  it('reports cpu, counter deltas and no stall reason on the first draw', () => {
    const { state, timing } = fixture();
    const first = {};
    state.now = 100;
    timing.arrive(first);
    timing.begin(first);
    state.now = 104.123;
    state.compiles = 2;
    state.pipelines = 3;
    timing.submit();
    expect(timing.intervalMs).toBeUndefined();
    expect(timing.stallReason).toBeUndefined();
    expect(timing.cpuMs).toBe(4.12);
    expect(timing.awaitMs).toBe(0);
    expect(timing.queuedMs).toBe(0);
    expect(timing.graphCompiles).toBe(2);
    expect(timing.pipelineCreations).toBe(3);
  });

  it('decomposes the interval into previous turn, await and queue', () => {
    const { state, timing } = fixture();
    const first = {};
    const second = { engineUpdateMs: 6, engineCreditWaitMs: 1 };
    timing.arrive(first);
    timing.begin(first);
    state.now = 4;
    timing.submit();
    state.now = 5;
    timing.end();
    // Arrives 10 ms after the previous turn ended, starts 2 ms later.
    state.now = 15;
    timing.arrive(second);
    state.now = 17;
    timing.begin(second);
    expect(timing.intervalMs).toBe(17);
    expect(timing.awaitMs).toBe(10);
    expect(timing.queuedMs).toBe(2);
    // await 10 = credit 1 + simulation 6 + publication 3; previous turn 5.
    expect(timing.stallReason).toBe('simulation');
    state.now = 20;
    timing.submit();
    timing.end();
    expect(timing.graphCompiles).toBe(0);
    expect(timing.pipelineCreations).toBe(0);
  });

  it('reports a queued wait when the draw arrived during the previous turn', () => {
    const { state, timing } = fixture();
    const first = {};
    const second = {};
    timing.arrive(first);
    timing.begin(first);
    state.now = 3;
    timing.arrive(second);
    state.now = 20;
    timing.submit();
    timing.end();
    state.now = 21;
    timing.begin(second);
    expect(timing.awaitMs).toBe(0);
    expect(timing.queuedMs).toBe(1);
    expect(timing.stallReason).toBe('render-cpu');
  });
});
