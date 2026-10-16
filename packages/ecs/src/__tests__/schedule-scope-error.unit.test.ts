import { describe, expect, it } from 'vitest';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';

describe('schedule scope errors', () => {
  it('rejects a string system-name ordering edge that crosses schedules', () => {
    const world = new World();
    world.addSystem(FixedUpdate, { name: 'fixed-system', queries: [], fn: () => {} });
    world.addSystem(Update, {
      name: 'update-system',
      queries: [],
      after: ['fixed-system'],
      fn: () => {},
    });

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
    world.addSystem(FixedUpdate, {
      name: 'fixed-system',
      queries: [],
      [edge]: [Update],
      fn: () => {},
    });

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

    const result = world.addSystem(unknown, { name: 'unknown', queries: [], fn: () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('schedule-scope-mismatch');
      expect(result.error.hint).toContain('Update');
    }
  });
});
