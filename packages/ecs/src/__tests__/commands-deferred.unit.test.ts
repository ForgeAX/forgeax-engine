import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';

describe('schedule-owned deferred commands', () => {
  it('makes producer commands visible to an explicit successor', () => {
    const Marker = defineComponent('DeferredMarker', {});
    const world = new World();
    let observed = 0;

    world.addSystem(Update, {
      name: 'producer',
      queries: [],
      before: ['consumer'],
      fn: (_world, _queries, commands) => commands.spawn({ component: Marker, data: {} }),
    });
    world.addSystem(Update, {
      name: 'consumer',
      queries: [{ with: [Marker] }],
      fn: (_world, results) => (observed += [...results[0]].length),
    });

    expect(world.update(0).ok).toBe(true);
    expect(observed).toBe(1);
  });

  it('drains commands recursively at a schedule final boundary', () => {
    const Marker = defineComponent('CascadeMarker', {});
    const world = new World();
    let drained = false;

    world.addSystem(Update, {
      name: 'producer',
      queries: [],
      fn: (_world, _queries, commands) => commands.spawn({ component: Marker, data: {} }),
    });
    world.addSystem(Update, {
      name: 'observer',
      queries: [{ with: [Marker] }],
      fn: () => (drained = true),
    });

    expect(world.update(0).ok).toBe(true);
    expect(world.update(0).ok).toBe(true);
    expect(drained).toBe(true);
  });

  it('isolates Update and FixedUpdate command buffers', () => {
    const Marker = defineComponent('ScheduleIsolationMarker', {});
    const world = new World();
    let fixedObserved = 0;

    world.addSystem(Update, {
      name: 'update-producer',
      queries: [],
      fn: (_world, _queries, commands) => commands.spawn({ component: Marker, data: {} }),
    });
    world.addSystem(FixedUpdate, {
      name: 'fixed-observer',
      queries: [{ with: [Marker] }],
      fn: (_world, results) => (fixedObserved += [...results[0]].length),
    });

    expect(world.update(1 / 60).ok).toBe(true);
    expect(fixedObserved).toBe(0);
  });
});
