import { describe, expect, it } from 'vitest';
import { CardRadiositySchedule, planCardRadiosity } from '../../raytracing/card-radiosity';

describe('Card-space radiosity publication', () => {
  it('retains full Card resolution and derives a separate surface probe/ray/SH atlas', () => {
    const plan = planCardRadiosity(32, 256, 128);
    expect(plan.probesPerCardAxis).toBe(8);
    expect(plan.probeCount).toBe(2048);
    expect(plan.raysPerProbe).toBe(16);
    expect(plan.traceBytes).toBe(2048 * 16 * 32);
    expect(plan.shBytes).toBe(2048 * 3 * 16);
    expect(plan.metaBytes).toBe(2048 * 16);
    expect(plan.visibilityBytes).toBe((256 * 128 + 2048 + plan.tileCapacity) * 16);
    expect(() => planCardRadiosity(32, 255, 128)).toThrow();
    const high = planCardRadiosity(32, 256, 128, {
      probeSpacing: 8,
      hemisphereResolution: 3,
      updateFactor: 128,
    });
    expect(high.cardResolution).toBe(plan.cardResolution);
    expect(high.probeCount).toBe(32 * 16);
    expect(high.raysPerProbe).toBe(9);
    expect(high.traceBytes).toBe(32 * 16 * 9 * 32);
  });

  it('does not publish unsubmitted work and rejects an old source epoch after mutation', () => {
    const schedule = new CardRadiositySchedule(4, 2);
    const first = schedule.select(1);
    expect(first.tiles).toEqual([0, 1]);
    expect(schedule.valid(0, 1)).toBe(false);
    expect(schedule.select(1)).toBe(first);
    const changed = schedule.select(2);
    expect(schedule.commit(first)).toBe(false);
    expect(schedule.valid(0, 2)).toBe(false);
    expect(schedule.commit(changed)).toBe(true);
    expect(schedule.valid(0, 1)).toBe(false);
    expect(schedule.valid(0, 2)).toBe(true);
  });

  it('prioritizes invalid pages, preserves unchanged history and advances age only on commit', () => {
    const schedule = new CardRadiositySchedule(4, 2);
    schedule.commit(schedule.select(7));
    const second = schedule.select(7);
    expect(second.tiles).toEqual([2, 3]);
    schedule.commit(second);
    expect([0, 1, 2, 3].every((tile) => schedule.valid(tile, 7))).toBe(true);
    schedule.invalidate([{ first: 3, end: 4 }]);
    expect(schedule.valid(3, 7)).toBe(false);
    expect(schedule.valid(0, 7)).toBe(true);
    const dirty = schedule.select(7);
    expect(dirty.tiles[0]).toBe(3);
    expect(schedule.commit(second)).toBe(false);
    schedule.commit(dirty);
    expect(schedule.valid(3, 7)).toBe(true);
  });

  it('invalidates in-flight page work, rather than admitting stale lighting as black', () => {
    const schedule = new CardRadiositySchedule(3, 3);
    const stale = schedule.select(1);
    const revision = schedule.invalidation;
    schedule.invalidate([{ first: 1, end: 2 }]);
    expect(schedule.invalidation).toBeGreaterThan(revision);
    expect(schedule.commit(stale)).toBe(false);
    expect(schedule.valid(1, 1)).toBe(false);
    expect(schedule.select(1)).not.toBe(stale);
  });
});
