import { describe, expect, it, vi } from 'vitest';
import type { CommandBuffer } from '../commands';
import * as commandsModule from '../commands';
import { defineComponent } from '../component';
import { defineSchedule } from '../schedule-token';
import { World } from '../world';

const Domain = defineSchedule('command-policy-domain');
const Value = defineComponent('command-policy-value', { x: 'f32' });

describe('registered system command policy', () => {
  it('runs explicitly command-free systems without creating deferred transactions', () => {
    const world = new World();
    world.spawn({ component: Value, data: { x: 1 } }).unwrap();
    let calls = 0;
    world
      .addSystem(Domain, {
        name: 'numeric-only',
        commands: 'none',
        queries: [{ read: [Value] }],
        fn: (_world, [values]) => {
          values.forEach(() => {
            calls++;
          });
        },
      })
      .unwrap();
    const spy = vi.spyOn(commandsModule, 'createCommandBuffer');
    try {
      for (let frame = 0; frame < 5; frame++) world.run(Domain).unwrap();
      expect(calls).toBe(5);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps default transaction identities and predecessor flushes in a mixed schedule', () => {
    const world = new World();
    const captured: CommandBuffer[] = [];
    let visible = 0;
    world
      .addSystem(Domain, {
        name: 'producer',
        queries: [],
        fn: (_world, _queries, commands) => {
          captured.push(commands);
          commands.spawn({ component: Value, data: { x: captured.length } });
        },
      })
      .unwrap();
    world
      .addSystem(Domain, {
        name: 'consumer',
        commands: 'none',
        after: ['producer'],
        queries: [{ read: [Value] }],
        fn: (_world, [values]) => {
          visible = 0;
          values.forEach(() => {
            visible++;
          });
        },
      })
      .unwrap();
    world.run(Domain).unwrap();
    expect(visible).toBe(1);
    world.run(Domain).unwrap();
    expect(visible).toBe(2);
    expect(captured[0]).not.toBe(captured[1]);
    expect(captured.map((c) => c.status)).toEqual(['committed', 'committed']);
    expect(() => captured[0]?.spawn({ component: Value, data: { x: 3 } })).toThrow(/committed/);
  });

  it('denies deferred writes through the explicit closed capability', () => {
    const world = new World();
    world
      .addSystem(Domain, {
        name: 'invalid-writer',
        commands: 'none',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.spawn({ component: Value, data: { x: 1 } });
        },
      })
      .unwrap();
    const result = world.run(Domain);
    expect(result.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
  });

  it('recompiles command requirements after replacement and preserves gated/reentrant execution', () => {
    const world = new World();
    let inner = false;
    let calls = 0;
    world
      .addSystem(Domain, {
        name: 'reentrant',
        commands: 'none',
        queries: [],
        runIf: () => calls < 3,
        fn: () => {
          calls++;
          if (!inner) {
            inner = true;
            world.run(Domain).unwrap();
            inner = false;
          }
        },
      })
      .unwrap();
    world.run(Domain).unwrap();
    expect(calls).toBe(2);
    world
      .replaceSystem(Domain, 'reentrant', {
        name: 'reentrant',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.spawn({ component: Value, data: { x: 4 } });
        },
      })
      .unwrap();
    world.run(Domain).unwrap();
    expect([...world.query({ read: [Value] }).unwrap()]).toHaveLength(1);
  });
});
