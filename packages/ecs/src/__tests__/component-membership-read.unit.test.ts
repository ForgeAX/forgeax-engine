import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { componentDefinition } from '../component-schema';
import { World } from '../world';

describe('component membership and admitted read metadata', () => {
  it('keeps data and sparse tag presence correct through migration and entity recycling', () => {
    const world = new World();
    const components = Array.from({ length: 24 }, (_, i) =>
      defineComponent(`MembershipRead${i}`, { x: 'f32' }),
    );
    const tag = defineComponent('MembershipReadSparseTag', {}, { storage: 'sparse' });
    const entity = world
      .spawn(...components.map((component, i) => ({ component, data: { x: i } })).reverse(), {
        component: tag,
        data: {},
      })
      .unwrap();
    for (const [i, component] of components.entries()) {
      expect(world.hasComponent(entity, component)).toBe(true);
      expect(world.get(entity, component).unwrap().x).toBe(i);
      expect(
        world
          .query({ read: [component] })
          .unwrap()
          .at(entity)
          ?.get(component).x,
      ).toBe(i);
    }
    expect(world.hasComponent(entity, tag)).toBe(true);
    const removed = components[11];
    if (removed === undefined) throw new Error('missing component');
    world.removeComponent(entity, removed).unwrap();
    expect(world.hasComponent(entity, removed)).toBe(false);
    expect(world.get(entity, removed)).toMatchObject({
      ok: false,
      error: { code: 'component-not-present' },
    });
    world.despawn(entity).unwrap();
    const next = world.spawn({ component: removed, data: { x: 999 } }).unwrap();
    expect(world.hasComponent(entity, removed)).toBe(false);
    expect(world.get(entity, removed)).toMatchObject({
      ok: false,
      error: { code: 'stale-entity' },
    });
    expect(world.get(next, removed).unwrap().x).toBe(999);
  });

  it('retains definition-time field order without caching changing row values', () => {
    const component = defineComponent('MembershipFieldOrder', {
      z: 'f32',
      '2': 'i32',
      a: 'bool',
      '1': 'i32',
    });
    const definition = componentDefinition(component);
    expect(definition.fieldNames).toEqual(Object.keys(component.fields));
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.fieldNames)).toBe(true);
    const world = new World();
    const entity = world.spawn({ component, data: { z: 1, '2': 2, a: true, '1': 3 } }).unwrap();
    const first = world.get(entity, component).unwrap();
    expect(Object.keys(first)).toEqual(definition.fieldNames);
    world.set(entity, component, { z: 9 }).unwrap();
    expect(world.get(entity, component).unwrap().z).toBe(9);
    expect(first.z).toBe(1);
  });
});
