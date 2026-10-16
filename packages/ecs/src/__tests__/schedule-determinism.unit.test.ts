import { describe, expect, it } from 'vitest';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';

function runTrace(deltas: readonly number[]): string[] {
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

  for (const delta of deltas) expect(world.update(delta).ok).toBe(true);
  return trace;
}

describe('schedule ordering determinism', () => {
  it('produces the same trace for the same explicit delta sequence', () => {
    const deltas = [0, 1 / 120, 1 / 120, 1 / 60, 0.01];

    expect(runTrace(deltas)).toEqual(runTrace(deltas));
  });

  it('preserves before and after ordering around fixed runs', () => {
    expect(runTrace([1 / 60])).toEqual(['before', 'fixed', 'after']);
  });
});
