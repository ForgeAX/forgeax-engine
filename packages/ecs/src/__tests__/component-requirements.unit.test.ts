import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { Update } from '../schedule-token';
import { World } from '../world';

describe('component requirements', () => {
  it('materializes transitive requirements for synchronous spawn', () => {
    const Base = defineComponent('RequirementsBase', { value: { type: 'f32', default: 3 } });
    const Middle = defineComponent('RequirementsMiddle', {}, { requires: [Base] });
    const Carrier = defineComponent('RequirementsCarrier', {}, { requires: [Middle] });
    const world = new World();

    const entity = world.spawn({ component: Carrier, data: {} }).unwrap();

    expect(world.get(entity, Carrier).ok).toBe(true);
    expect(world.get(entity, Middle).ok).toBe(true);
    expect(world.get(entity, Base).unwrap().value).toBe(3);
  });

  it('keeps explicit required data and adds missing requirements on addComponent', () => {
    const Base = defineComponent('RequirementsExplicitBase', { value: 'f32' });
    const Carrier = defineComponent('RequirementsExplicitCarrier', {}, { requires: [Base] });
    const world = new World();
    const entity = world.spawn({ component: Base, data: { value: 9 } }).unwrap();

    expect(world.addComponent(entity, { component: Carrier, data: {} }).ok).toBe(true);
    expect(world.get(entity, Base).unwrap().value).toBe(9);

    const explicit = world
      .spawn({ component: Carrier, data: {} }, { component: Base, data: { value: 17 } })
      .unwrap();
    expect(world.get(explicit, Base).unwrap().value).toBe(17);
  });

  it('applies requirements to deferred Commands.spawn', () => {
    const Base = defineComponent('RequirementsDeferredBase', { value: 'f32' });
    const Carrier = defineComponent('RequirementsDeferredCarrier', {}, { requires: [Base] });
    const world = new World();
    let entity: EntityHandle | undefined;

    world
      .addSystem(Update, {
        name: 'requirements-deferred-spawn',
        queries: [],
        fn: (_world, _queries, commands) => {
          entity = commands.spawn({ component: Carrier, data: {} });
        },
      })
      .unwrap();

    expect(world.update(0).ok).toBe(true);
    expect(entity).toBeDefined();
    expect(world.get(entity as EntityHandle, Base).ok).toBe(true);
  });

  it('applies requirements to deferred Commands.addComponent', () => {
    const Base = defineComponent('RequirementsDeferredAddBase', { value: 'f32' });
    const Carrier = defineComponent('RequirementsDeferredAddCarrier', {}, { requires: [Base] });
    const world = new World();
    const entity = world.spawn().unwrap();

    world
      .addSystem(Update, {
        name: 'requirements-deferred-add',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.addComponent(entity, { component: Carrier, data: {} });
        },
      })
      .unwrap();

    expect(world.update(0).ok).toBe(true);
    expect(world.get(entity, Base).ok).toBe(true);
  });
});
