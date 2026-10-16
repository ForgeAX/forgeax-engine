import { describe, expect, it } from 'vitest';
import { FixedUpdate, Update } from '../schedule-token';
import { FixedTime, Time } from '../time';
import { World } from '../world';

describe('World time resources', () => {
  it('runs all three 60 Hz catch-up ticks without rounding away the last tick', () => {
    const world = new World();
    let runs = 0;
    world.addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => runs++ });
    expect(world.update(3 / 60).ok).toBe(true);
    expect(runs).toBe(3);
    expect(world.getResource(FixedTime)).toMatchObject({ tick: 3, overstep: 0 });
    for (let frame = 0; frame < 60; frame++) expect(world.update(1 / 60).ok).toBe(true);
    expect(runs).toBe(63);
    expect(world.getResource(FixedTime)).toMatchObject({ tick: 63, overstep: 0 });
  });

  it('rejects negative, NaN, and infinite deltas without mutating time', () => {
    const world = new World();
    const before = world.getResource(Time);

    for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = world.update(delta);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('time-delta-invalid');
        expect(result.error.expected).toBe('a finite delta greater than or equal to 0');
        expect(result.error.hint).toContain('world.update');
      }
    }

    expect(world.getResource(Time)).toEqual(before);
  });

  it('treats an omitted delta as zero while still running Update', () => {
    const world = new World();
    let updates = 0;
    world.addSystem(Update, { name: 'update', queries: [], fn: () => updates++ });

    expect(world.update().ok).toBe(true);
    expect(world.getResource(Time)).toMatchObject({ delta: 0, elapsed: 0 });
    expect(world.getResource(FixedTime).tick).toBe(0);
    expect(updates).toBe(1);
  });

  it('advances Time by an explicit positive delta', () => {
    const world = new World();

    expect(world.update(0.025).ok).toBe(true);
    expect(world.getResource(Time)).toMatchObject({ delta: 0.025, elapsed: 0.025 });
  });

  it('rejects an incoherent policy before writing protected resources', () => {
    const world = new World({
      time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.05 },
    });
    const beforeTime = world.getResource(Time);
    const beforeFixed = world.getResource(FixedTime);

    const result = world.update(0.01);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('time-config-invalid');
      expect(result.error.expected).toContain('maxDeltaSeconds >=');
      expect(result.error.hint).toContain('maxDeltaSeconds');
    }
    expect(world.getResource(Time)).toEqual(beforeTime);
    expect(world.getResource(FixedTime)).toEqual(beforeFixed);
  });

  it('uses the clamped Time delta as the fixed accumulator input', () => {
    const world = new World();
    let fixedRuns = 0;
    world.addSystem(Update, { name: 'observe-time', queries: [], fn: () => {} });
    world.addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => fixedRuns++ });

    expect(world.update(5).ok).toBe(true);
    const time = world.getResource(Time);
    const fixed = world.getResource(FixedTime);
    expect(time.delta).toBe(0.1);
    expect(fixed).toMatchObject({
      delta: 1 / 60,
      maxStepsPerUpdate: 4,
      droppedUpdates: 1,
    });
    expect(fixedRuns).toBe(4);
    expect(fixed.droppedSeconds).toBeCloseTo(1 / 60, 12);
  });

  it.each([
    { name: 'zero fixed ticks', delta: 1 / 240, ticks: 0, overstep: 1 / 120, dropped: 0 },
    {
      name: 'multiple fixed ticks',
      delta: 3 / 60 + 1 / 240,
      ticks: 3,
      overstep: 1 / 120,
      dropped: 0,
    },
    { name: 'capped catch-up', delta: 0.1, ticks: 4, overstep: 1 / 240, dropped: 2 / 60 },
    {
      name: 'empty fixed schedule',
      delta: 3 / 60 + 1 / 240,
      ticks: 0,
      overstep: 1 / 120,
      dropped: 3 / 60,
      empty: true,
    },
  ])('publishes the final fixed remainder before downstream Update after $name', ({
    delta,
    ticks,
    overstep,
    dropped,
    empty,
  }) => {
    const world = new World();
    let observed = { ...world.getResource(FixedTime) };
    if (!empty) world.addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => {} }).unwrap();
    world
      .addSystem(Update, {
        name: 'after-fixed',
        after: [FixedUpdate],
        queries: [],
        fn: () => {
          observed = { ...world.getResource(FixedTime) };
        },
      })
      .unwrap();

    world.update(1 / 240).unwrap();
    world.update(delta).unwrap();

    const fixed = world.getResource(FixedTime);
    expect(observed).toEqual({ ...fixed });
    expect(observed.tick).toBe(ticks);
    expect(observed.overstep).toBeCloseTo(overstep, 11);
    expect(observed.overstep).toBeLessThan(fixed.delta);
    expect(observed.droppedSeconds).toBeCloseTo(dropped, 11);
    expect(observed.droppedUpdates).toBe(dropped > 0 ? 1 : 0);
  });
});
