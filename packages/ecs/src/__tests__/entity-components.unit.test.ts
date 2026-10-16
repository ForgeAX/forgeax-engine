import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

describe('World.componentsOf', () => {
  it('reflects actual entity components without a catalog lease, including sparse tags', () => {
    const world = new World();
    const Health = defineComponent('ReflectedHealth', { value: 'f32' });
    const Selected = defineComponent('ReflectedSelected', {}, { storage: 'sparse' });
    const entity = world.spawn({ component: Health, data: { value: 9 } }).unwrap();
    expect(world.componentsOf(entity).unwrap()).toContain(Health);
    world.addComponent(entity, { component: Selected, data: {} }).unwrap();
    const snapshot = world.componentsOf(entity).unwrap();
    expect(snapshot).toContain(Selected);
    world.removeComponent(entity, Selected).unwrap();
    expect(world.componentsOf(entity).unwrap()).not.toContain(Selected);
    expect(snapshot).toContain(Selected);
  });

  it('rejects a recycled handle and exposes no mutable archetype array', () => {
    const world = new World();
    const Value = defineComponent('ReflectedValue', { value: 'f32' });
    const entity = world.spawn({ component: Value, data: { value: 2 } }).unwrap();
    const copy = world.componentsOf(entity).unwrap() as unknown[];
    copy.length = 0;
    expect(world.get(entity, Value).unwrap().value).toBe(2);
    expect(world.componentsOf(entity).unwrap()).toContain(Value);
    world.despawn(entity).unwrap();
    const replacement = world.spawn({ component: Value, data: { value: 3 } }).unwrap();
    expect(world.componentsOf(entity).ok).toBe(false);
    expect(world.componentsOf(replacement).unwrap()).toContain(Value);
  });
});
