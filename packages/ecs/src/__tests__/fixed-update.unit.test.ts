import { describe, expect, it } from 'vitest';
import { FixedUpdate, Update } from '../schedule-token';
import { FixedTime, Time } from '../time';
import { World } from '../world';

describe('fixed update loop', () => {
  it('runs zero, one, and multiple fixed iterations while preserving remainder', () => {
    const world = new World();
    const ticks: number[] = [];
    world.addSystem(FixedUpdate, {
      name: 'fixed',
      queries: [],
      fn: (_world) => ticks.push(_world.getResource<typeof FixedTime>(FixedTime).tick),
    });

    expect(world.update(0.01).ok).toBe(true);
    expect(world.update(0.01).ok).toBe(true);
    expect(world.update(2 / 60).ok).toBe(true);
    expect(ticks).toEqual([1, 2, 3]);
    expect(world.getResource<typeof FixedTime>(FixedTime).tick).toBe(3);
    expect(world.getResource<typeof FixedTime>(FixedTime).overstep).toBeCloseTo(1 / 300, 12);
  });

  it('clamps before accumulating fixed time and records exact dropped metrics', () => {
    const world = new World();
    let fixedRuns = 0;
    world.addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => fixedRuns++ });

    expect(world.update(5).ok).toBe(true);
    const time = world.getResource<typeof Time>(Time);
    const fixed = world.getResource<typeof FixedTime>(FixedTime);
    expect(time.delta).toBe(0.1);
    expect(fixedRuns).toBe(4);
    expect(fixed.droppedUpdates).toBe(1);
    expect(fixed.droppedSeconds).toBeCloseTo(1 / 60, 12);
    expect(fixed.overstep).toBeCloseTo(1 / 60, 10);
  });

  it('does not replay discarded catch-up time on the next healthy frame', () => {
    const world = new World();
    let fixedRuns = 0;
    world.addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => fixedRuns++ });

    expect(world.update(5).ok).toBe(true);
    const afterLargeFrame = world.getResource<typeof FixedTime>(FixedTime);
    const largeFrameTick = afterLargeFrame.tick;
    const largeFrameDroppedSeconds = afterLargeFrame.droppedSeconds;
    const largeFrameDroppedUpdates = afterLargeFrame.droppedUpdates;

    expect(world.update(1 / 60).ok).toBe(true);
    const afterHealthyFrame = world.getResource<typeof FixedTime>(FixedTime);
    expect(fixedRuns).toBe(5);
    expect(afterHealthyFrame.tick).toBe(largeFrameTick + 1);
    expect(afterHealthyFrame.droppedSeconds).toBe(largeFrameDroppedSeconds);
    expect(afterHealthyFrame.droppedUpdates).toBe(largeFrameDroppedUpdates);
  });

  it('runs Update before and after the intrinsic fixed node', () => {
    const world = new World();
    const trace: string[] = [];
    world.addSystem(Update, {
      name: 'before-fixed',
      queries: [],
      before: [FixedUpdate],
      fn: () => trace.push('before'),
    });
    world.addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => trace.push('fixed') });
    world.addSystem(Update, {
      name: 'after-fixed',
      queries: [],
      after: [FixedUpdate],
      fn: () => trace.push('after'),
    });

    expect(world.update(1 / 60).ok).toBe(true);
    expect(trace).toEqual(['before', 'fixed', 'after']);
  });
});
