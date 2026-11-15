import { describe, expect, it } from 'vitest';
import { FixedUpdate, Update, World } from '../index';
import { defineSystem } from '../schedule';

describe('schedule token boundaries', () => {
  it('brackets every fixed tick independently of registration order and catch-up', () => {
    const world = new World();
    const trace: string[] = [];
    const systemToken1 = defineSystem({
      name: 'end',
      after: [FixedUpdate],
      queries: [],
      fn: () => trace.push('end'),
    });
    world.addSystem(FixedUpdate, systemToken1).unwrap();
    const systemToken2 = defineSystem({ name: 'move', queries: [], fn: () => trace.push('move') });
    world.addSystem(FixedUpdate, systemToken2).unwrap();
    const systemToken3 = defineSystem({
      name: 'begin',
      before: [FixedUpdate],
      queries: [],
      fn: () => trace.push('begin'),
    });
    world.addSystem(FixedUpdate, systemToken3).unwrap();
    world.update(3 / 60).unwrap();
    expect(trace).toEqual(['begin', 'move', 'end', 'begin', 'move', 'end', 'begin', 'move', 'end']);
  });
});

it('keeps Update boundaries outside the intrinsic fixed block', () => {
  const world = new World();
  const trace: string[] = [];
  const systemToken4 = defineSystem({
    name: 'end',
    after: [Update],
    queries: [],
    fn: () => trace.push('end'),
  });
  world.addSystem(Update, systemToken4).unwrap();
  const systemToken5 = defineSystem({ name: 'fixed', queries: [], fn: () => trace.push('fixed') });
  world.addSystem(FixedUpdate, systemToken5).unwrap();
  const systemToken6 = defineSystem({
    name: 'after-fixed',
    after: [FixedUpdate],
    queries: [],
    fn: () => trace.push('after-fixed'),
  });
  world.addSystem(Update, systemToken6).unwrap();
  const systemToken7 = defineSystem({
    name: 'begin',
    before: [Update],
    queries: [],
    fn: () => trace.push('begin'),
  });
  world.addSystem(Update, systemToken7).unwrap();
  world.update(2 / 60).unwrap();
  expect(trace).toEqual(['begin', 'fixed', 'fixed', 'after-fixed', 'end']);
});

it('rejects an impossible boundary ordering through ordinary cycle detection', () => {
  const world = new World();
  const systemToken8 = defineSystem({
    name: 'impossible',
    before: [FixedUpdate],
    after: [FixedUpdate],
    queries: [],
    fn: () => {},
  });
  world.addSystem(FixedUpdate, systemToken8).unwrap();
  expect(world.update(1 / 60).ok).toBe(false);
});

it('keeps the captured Update membership in rebuilt order after fixed-time registration', () => {
  const world = new World();
  const trace: string[] = [];
  let changed = false;
  const systemToken9 = defineSystem({
    name: 'before',
    commands: 'none',
    before: [FixedUpdate],
    queries: [],
    fn: () => {
      trace.push('before');
    },
  });
  world.addSystem(Update, systemToken9).unwrap();
  const systemToken10 = defineSystem({
    name: 'a',
    commands: 'none',
    after: [FixedUpdate],
    queries: [],
    fn: () => {
      trace.push('a');
    },
  });
  world.addSystem(Update, systemToken10).unwrap();
  const systemToken11 = defineSystem({
    name: 'b',
    commands: 'none',
    after: [systemToken10],
    queries: [],
    fn: () => {
      trace.push('b');
    },
  });
  world.addSystem(Update, systemToken11).unwrap();
  const systemToken12 = defineSystem({
    name: 'register',
    commands: 'none',
    queries: [],
    fn: () => {
      trace.push('fixed');
      if (changed) return;
      changed = true;
      world
        .replaceSystem(
          Update,
          systemToken10,
          defineSystem({
            name: 'a',
            commands: 'none',
            after: [systemToken11],
            queries: [],
            fn: () => {
              trace.push('a');
            },
          }),
        )
        .unwrap();
      world
        .replaceSystem(
          Update,
          systemToken11,
          defineSystem({
            name: 'b',
            commands: 'none',
            after: [FixedUpdate],
            queries: [],
            fn: () => {
              trace.push('b');
            },
          }),
        )
        .unwrap();
      const systemToken13 = defineSystem({
        name: 'new',
        commands: 'none',
        after: [systemToken10],
        queries: [],
        fn: () => {
          trace.push('new');
        },
      });
      world.addSystem(Update, systemToken13).unwrap();
    },
  });
  world.addSystem(FixedUpdate, systemToken12).unwrap();
  world.update(1 / 60).unwrap();
  expect(trace).toEqual(['before', 'fixed', 'b', 'a']);
  trace.length = 0;
  world.update(1 / 60).unwrap();
  expect(trace).toEqual(['before', 'fixed', 'b', 'a', 'new']);
});
