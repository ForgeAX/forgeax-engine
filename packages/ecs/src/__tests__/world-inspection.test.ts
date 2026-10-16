import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { FixedTime, Time } from '../time';
import { World } from '../world';

describe('detached inspection and readonly clock', () => {
  it('freezes detached inspection data without changing World', () => {
    const Position = defineComponent('InspectionPosition', { x: 'f32' });
    const world = new World();
    world.spawn({ component: Position, data: { x: 1 } }).unwrap();
    const snapshot = world.inspect();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.archetypes)).toBe(true);
    expect(() =>
      snapshot.archetypes.push({
        key: 'fake',
        componentNames: [],
        entityCount: 0,
        tableId: -1,
      }),
    ).toThrow();
    expect(world.inspect().entityCount).toBe(1);
  });

  it('keeps stable clock views while rejecting direct writes', () => {
    const world = new World();
    const time = world.getResource(Time);
    const fixed = world.getResource(FixedTime);
    expect(world.getResource(Time)).toBe(time);
    expect(world.getResource(FixedTime)).toBe(fixed);
    expect(Object.isFrozen(time)).toBe(true);
    expect(Object.isFrozen(fixed)).toBe(true);
    expect(() => ((time as { delta: number }).delta = 1)).toThrow();
    expect(() => ((fixed as { tick: number }).tick = 1)).toThrow();
  });
});
