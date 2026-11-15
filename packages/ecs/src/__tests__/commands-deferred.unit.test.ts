import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import type { SystemOrderReference } from '../schedule';
import { defineSystem } from '../schedule';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';

describe('schedule-owned deferred commands', () => {
  it('makes producer commands visible to an explicit successor', () => {
    const Marker = defineComponent('DeferredMarker', {});
    const world = new World();
    let observed = 0;

    const forwardOrder1: SystemOrderReference[] = [];
    const systemToken1 = defineSystem({
      name: 'producer',
      queries: [],
      before: forwardOrder1,
      fn: (_world, _queries, commands) => commands.spawn({ component: Marker, data: {} }),
    });
    world.addSystem(Update, systemToken1);
    const systemToken2 = defineSystem({
      name: 'consumer',
      queries: [{ with: [Marker] }],
      fn: (_world, results) => (observed += [...results[0]].length),
    });
    forwardOrder1.push(systemToken2);
    world.addSystem(Update, systemToken2);

    expect(world.update(0).ok).toBe(true);
    expect(observed).toBe(1);
  });

  it('drains commands recursively at a schedule final boundary', () => {
    const Marker = defineComponent('CascadeMarker', {});
    const world = new World();
    let drained = false;

    const systemToken3 = defineSystem({
      name: 'producer',
      queries: [],
      fn: (_world, _queries, commands) => commands.spawn({ component: Marker, data: {} }),
    });
    world.addSystem(Update, systemToken3);
    const systemToken4 = defineSystem({
      name: 'observer',
      queries: [{ with: [Marker] }],
      fn: () => (drained = true),
    });
    world.addSystem(Update, systemToken4);

    expect(world.update(0).ok).toBe(true);
    expect(world.update(0).ok).toBe(true);
    expect(drained).toBe(true);
  });

  it('isolates Update and FixedUpdate command buffers', () => {
    const Marker = defineComponent('ScheduleIsolationMarker', {});
    const world = new World();
    let fixedObserved = 0;

    const systemToken5 = defineSystem({
      name: 'update-producer',
      queries: [],
      fn: (_world, _queries, commands) => commands.spawn({ component: Marker, data: {} }),
    });
    world.addSystem(Update, systemToken5);
    const systemToken6 = defineSystem({
      name: 'fixed-observer',
      queries: [{ with: [Marker] }],
      fn: (_world, results) => (fixedObserved += [...results[0]].length),
    });
    world.addSystem(FixedUpdate, systemToken6);

    expect(world.update(1 / 60).ok).toBe(true);
    expect(fixedObserved).toBe(0);
  });
});
