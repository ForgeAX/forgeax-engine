import { describe, expect, it, vi } from 'vitest';
import { defineSystem } from '../schedule';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';
import { worldInternal } from '../world-internal';

describe('schedule scope errors', () => {
  it('keeps a World schedule validation warm when another World changes registration', () => {
    const world = new World();
    const systemToken1 = defineSystem({ name: 'stable', queries: [], fn: () => {} });
    world.addSystem(Update, systemToken1).unwrap();
    world.update(0).unwrap();
    const schedule = world[worldInternal].getSchedule(Update);
    if (schedule === undefined) throw new Error('Update schedule is missing');
    const scan = vi.spyOn(schedule.systems, 'values');
    const other = new World();
    const systemToken2 = defineSystem({ name: 'unrelated', queries: [], fn: () => {} });
    other.addSystem(Update, systemToken2).unwrap();
    world.update(0).unwrap();
    expect(scan).not.toHaveBeenCalled();
  });

  it('revalidates warmed schedules when a named target moves within the same World', () => {
    const world = new World();
    const target = defineSystem({ name: 'target', queries: [], fn: () => {} });
    world.addSystem(Update, target).unwrap();
    const systemToken3 = defineSystem({
      name: 'dependent',
      queries: [],
      after: [target],
      fn: () => {},
    });
    world.addSystem(Update, systemToken3).unwrap();
    world.update(0).unwrap();
    world.removeSystem(Update, target).unwrap();
    world.addSystem(FixedUpdate, target).unwrap();
    const result = world.update(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('schedule-scope-mismatch');
  });

  it('rejects a system identity ordering edge that crosses schedules', () => {
    const world = new World();
    const systemToken4 = defineSystem({ name: 'fixed-system', queries: [], fn: () => {} });
    world.addSystem(FixedUpdate, systemToken4);
    const systemToken5 = defineSystem({
      name: 'update-system',
      queries: [],
      after: [systemToken4],
      fn: () => {},
    });
    world.addSystem(Update, systemToken5);

    const result = world.update(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('schedule-scope-mismatch');
      expect(result.error.detail).toMatchObject({
        sourceSchedule: 'Update',
        targetSchedule: 'FixedUpdate',
        reference: 'fixed-system',
      });
    }
  });

  it.each([
    'before',
    'after',
  ] as const)('rejects a FixedUpdate %s edge that references the Update token', (edge) => {
    const world = new World();
    const systemToken6 = defineSystem({
      name: 'fixed-system',
      queries: [],
      [edge]: [Update],
      fn: () => {},
    });
    world.addSystem(FixedUpdate, systemToken6);

    const result = world.update(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('schedule-scope-mismatch');
      expect(result.error.detail).toMatchObject({
        sourceSchedule: 'FixedUpdate',
        targetSchedule: 'Update',
        reference: 'Update',
      });
    }
  });

  it('does not silently skip an unknown schedule token', () => {
    const world = new World();
    const unknown = Object.freeze({ name: 'Unknown' }) as typeof Update;

    const systemToken7 = defineSystem({ name: 'unknown', queries: [], fn: () => {} });
    const result = world.addSystem(unknown, systemToken7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('schedule-scope-mismatch');
      expect(result.error.hint).toContain('Update');
    }
  });
});
