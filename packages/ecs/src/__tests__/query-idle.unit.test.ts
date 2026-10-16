import { expect, it, vi } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

it('uses component epochs to skip idle changed-query row scans', () => {
  const Value = defineComponent('IdleValue', { value: 'f32' });
  const world = new World();
  const entity = world.spawn({ component: Value, data: { value: 1 } }).unwrap();
  const query = world.query({ read: [Value], changed: [Value] }).unwrap();
  expect([...query]).toHaveLength(1);
  const probe = vi.spyOn(
    query as unknown as { changeMatches: (...args: unknown[]) => boolean },
    'changeMatches',
  );
  expect([...query]).toHaveLength(0);
  expect(probe).not.toHaveBeenCalled();
  world.set(entity, Value, { value: 2 }).unwrap();
  expect([...query]).toHaveLength(1);
});
