import { describe, expect, it } from 'vitest';
import { TimeScaleInvalidError, TimeScaleLeaseReleasedError } from '../index';
import { defineSystem } from '../schedule';
import { FixedUpdate, Update } from '../schedule-token';
import { FixedTime, Time } from '../time';
import { World } from '../world';

describe('World time resources', () => {
  it('runs all three 60 Hz catch-up ticks without rounding away the last tick', () => {
    const world = new World();
    let runs = 0;
    const systemToken1 = defineSystem({ name: 'fixed', queries: [], fn: () => runs++ });
    world.addSystem(FixedUpdate, systemToken1);
    expect(world.update(3 / 60).ok).toBe(true);
    expect(runs).toBe(3);
    expect(world.getResource(FixedTime)).toMatchObject({ tick: 3, overstep: 0 });
    for (let frame = 0; frame < 60; frame++) expect(world.update(1 / 60).ok).toBe(true);
    expect(runs).toBe(63);
    expect(world.getResource(FixedTime)).toMatchObject({ tick: 63, overstep: 0 });
  });

  it('rejects negative, NaN, and infinite deltas without mutating time', () => {
    const world = new World();
    const before = { ...world.getResource(Time) };

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
    const systemToken2 = defineSystem({ name: 'update', queries: [], fn: () => updates++ });
    world.addSystem(Update, systemToken2);

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
    const beforeTime = { ...world.getResource(Time) };
    const beforeFixed = { ...world.getResource(FixedTime) };

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
    const systemToken3 = defineSystem({ name: 'observe-time', queries: [], fn: () => {} });
    world.addSystem(Update, systemToken3);
    const systemToken4 = defineSystem({ name: 'fixed', queries: [], fn: () => fixedRuns++ });
    world.addSystem(FixedUpdate, systemToken4);

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
    const systemToken5 = defineSystem({ name: 'fixed', queries: [], fn: () => {} });
    if (!empty) world.addSystem(FixedUpdate, systemToken5).unwrap();
    const systemToken6 = defineSystem({
      name: 'after-fixed',
      after: [FixedUpdate],
      queries: [],
      fn: () => {
        observed = { ...world.getResource(FixedTime) };
      },
    });
    world.addSystem(Update, systemToken6).unwrap();

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

describe('merged fixed catch-up', () => {
  const policy = {
    fixedDeltaSeconds: 0.05,
    maxStepsPerUpdate: 2,
    maxDeltaSeconds: 3 * 0.05,
    fixedCatchUp: 'merged' as const,
  };

  it('runs one FixedUpdate pass with the owed steps as its delta and restores the base step', () => {
    const world = new World({ time: policy });
    const seen: number[] = [];
    const systemToken7 = defineSystem({
      name: 'fixed',
      queries: [],
      fn: (world) => void seen.push(world.getResource(FixedTime).delta),
    });
    world.addSystem(FixedUpdate, systemToken7);
    expect(world.update(0.05).ok).toBe(true);
    expect(world.update(0.11).ok).toBe(true);
    expect(seen.map((value) => Math.round(value * 1000))).toEqual([50, 100]);
    expect(world.getResource(FixedTime)).toMatchObject({ tick: 2, delta: 0.05, stepDelta: 0.1 });
    expect(world.getResource(FixedTime).overstep).toBeCloseTo(0.01, 9);
    // A frame owing one step runs an ordinary step.
    expect(world.update(0.04).ok).toBe(true);
    expect(seen.map((value) => Math.round(value * 1000))).toEqual([50, 100, 50]);
    expect(world.getResource(FixedTime)).toMatchObject({ tick: 3, stepDelta: 0.05 });
  });

  it('keeps the step cap and drops whole overflow steps exactly like substeps', () => {
    const world = new World({ time: policy });
    let simulated = 0;
    const systemToken8 = defineSystem({
      name: 'fixed',
      queries: [],
      fn: (world) => {
        simulated += world.getResource(FixedTime).delta;
      },
    });
    world.addSystem(FixedUpdate, systemToken8);
    // 0.15 s owes three steps; two are simulated in one pass and one is dropped.
    expect(world.update(0.15).ok).toBe(true);
    expect(simulated).toBeCloseTo(0.1, 9);
    expect(world.getResource(FixedTime)).toMatchObject({ tick: 1, droppedUpdates: 1 });
    expect(world.getResource(FixedTime).droppedSeconds).toBeCloseTo(0.05, 9);
  });

  it('keeps substeps as the default policy', () => {
    const { fixedCatchUp: _merged, ...substeps } = policy;
    const world = new World({ time: substeps });
    const seen: number[] = [];
    const systemToken9 = defineSystem({
      name: 'fixed',
      queries: [],
      fn: (world) => void seen.push(world.getResource(FixedTime).delta),
    });
    world.addSystem(FixedUpdate, systemToken9);
    expect(world.update(0.1).ok).toBe(true);
    expect(seen).toEqual([0.05, 0.05]);
    expect(world.getResource(FixedTime)).toMatchObject({ catchUp: 'substeps', tick: 2 });
  });
});

describe('World clock view ownership', () => {
  it('keeps live, enumerable, frozen views independent across Worlds', () => {
    const a = new World();
    const b = new World();
    const first = a.getResource(Time);
    const second = b.getResource(Time);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first)).toEqual([
      'delta',
      'elapsed',
      'unscaledDelta',
      'unscaledElapsed',
      'scale',
      'maxDeltaSeconds',
    ]);
    expect(() => Object.assign(first, { elapsed: 100 })).toThrow(TypeError);
    a.update(0.025).unwrap();
    expect(first.elapsed).toBe(0.025);
    expect(second.elapsed).toBe(0);
    expect(JSON.parse(JSON.stringify(first))).toEqual({
      delta: 0.025,
      elapsed: 0.025,
      unscaledDelta: 0.025,
      unscaledElapsed: 0.025,
      scale: 1,
      maxDeltaSeconds: 0.1,
    });
    expect(Object.getOwnPropertySymbols(first)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(first, 'elapsed')?.set).toBeUndefined();
  });
});

describe('World time scale ownership', () => {
  it('samples the smallest active contribution at update boundaries and caps only simulation time', () => {
    const world = new World();
    const half = world.acquireTimeScale(0.5).unwrap();
    const quarter = world.acquireTimeScale(0.25).unwrap();
    const time = world.getResource(Time);
    expect(time.scale).toBe(1);
    world.update(0.04).unwrap();
    expect(time).toMatchObject({ delta: 0.01, elapsed: 0.01, scale: 0.25, unscaledElapsed: 0.04 });
    quarter.release();
    quarter.release();
    world.update(0.04).unwrap();
    expect(time).toMatchObject({ delta: 0.02, elapsed: 0.03, scale: 0.5, unscaledElapsed: 0.08 });
    half.set(2).unwrap();
    expect(time.scale).toBe(0.5);
    world.update(0.08).unwrap();
    expect(time).toMatchObject({
      delta: 0.1,
      scale: 2,
      unscaledDelta: 0.08,
      unscaledElapsed: 0.16,
    });
    expect(time.elapsed).toBeCloseTo(0.13, 12);
    half.release();
    world.update(0.02).unwrap();
    expect(time.scale).toBe(1);
    expect(time.elapsed).toBeCloseTo(0.15, 12);
    expect(time.unscaledElapsed).toBeCloseTo(0.18, 12);
    expect(new World().getResource(Time).scale).toBe(1);
  });

  it('keeps Update and host time running while a zero contribution pauses fixed simulation', () => {
    const world = new World();
    let updates = 0;
    let ticks = 0;
    world
      .addSystem(Update, defineSystem({ name: 'scaled-update', queries: [], fn: () => updates++ }))
      .unwrap();
    world
      .addSystem(
        FixedUpdate,
        defineSystem({ name: 'scaled-fixed', queries: [], fn: () => ticks++ }),
      )
      .unwrap();
    const pause = world.acquireTimeScale(0).unwrap();
    world.update(0.05).unwrap();
    expect(world.getResource(Time)).toMatchObject({
      delta: 0,
      elapsed: 0,
      unscaledDelta: 0.05,
      unscaledElapsed: 0.05,
    });
    expect(updates).toBe(1);
    expect(ticks).toBe(0);
    pause.release();
    world.update(1 / 60).unwrap();
    expect(updates).toBe(2);
    expect(ticks).toBe(1);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
  ])('rejects invalid scale %s without changing a lease, and refuses a released lease', (invalid) => {
    const world = new World();
    const acquired = world.acquireTimeScale(invalid);
    expect(acquired.ok).toBe(false);
    if (acquired.ok) throw new Error('invalid scale was accepted');
    expect(acquired.error).toBeInstanceOf(TimeScaleInvalidError);
    expect(acquired.error.detail.received).toBe(invalid);
    const lease = world.acquireTimeScale(0.5).unwrap();
    const changed = lease.set(invalid);
    expect(changed.ok).toBe(false);
    if (changed.ok) throw new Error('invalid scale replaced an active contribution');
    expect(changed.error.code).toBe('time-scale-invalid');
    expect(lease).toMatchObject({ active: true, scale: 0.5 });
    world.update(0.04).unwrap();
    expect(world.getResource(Time).delta).toBe(0.02);
    lease.release();
    lease.release();
    const released = lease.set(0.25);
    expect(released.ok).toBe(false);
    if (released.ok) throw new Error('released lease was reactivated');
    expect(released.error).toBeInstanceOf(TimeScaleLeaseReleasedError);
    expect(released.error.code).toBe('time-scale-lease-released');
    expect(lease).toMatchObject({ active: false, scale: 0.5 });
    world.update(0.04).unwrap();
    expect(world.getResource(Time)).toMatchObject({ delta: 0.04, scale: 1 });
  });
});
