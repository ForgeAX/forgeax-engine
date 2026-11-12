import { describe, expect, it } from 'vitest';
import { FixedUpdate, Update, World } from '../index';

describe('schedule token boundaries', () => {
  it('brackets every fixed tick independently of registration order and catch-up', () => {
    const world = new World();
    const trace: string[] = [];
    world
      .addSystem(FixedUpdate, {
        name: 'end',
        after: [FixedUpdate],
        queries: [],
        fn: () => trace.push('end'),
      })
      .unwrap();
    world
      .addSystem(FixedUpdate, { name: 'move', queries: [], fn: () => trace.push('move') })
      .unwrap();
    world
      .addSystem(FixedUpdate, {
        name: 'begin',
        before: [FixedUpdate],
        queries: [],
        fn: () => trace.push('begin'),
      })
      .unwrap();
    world.update(3 / 60).unwrap();
    expect(trace).toEqual(['begin', 'move', 'end', 'begin', 'move', 'end', 'begin', 'move', 'end']);
  });
});

it('keeps Update boundaries outside the intrinsic fixed block', () => {
  const world = new World();
  const trace: string[] = [];
  world
    .addSystem(Update, { name: 'end', after: [Update], queries: [], fn: () => trace.push('end') })
    .unwrap();
  world
    .addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => trace.push('fixed') })
    .unwrap();
  world
    .addSystem(Update, {
      name: 'after-fixed',
      after: [FixedUpdate],
      queries: [],
      fn: () => trace.push('after-fixed'),
    })
    .unwrap();
  world
    .addSystem(Update, {
      name: 'begin',
      before: [Update],
      queries: [],
      fn: () => trace.push('begin'),
    })
    .unwrap();
  world.update(2 / 60).unwrap();
  expect(trace).toEqual(['begin', 'fixed', 'fixed', 'after-fixed', 'end']);
});

it('rejects an impossible boundary ordering through ordinary cycle detection', () => {
  const world = new World();
  world
    .addSystem(FixedUpdate, {
      name: 'impossible',
      before: [FixedUpdate],
      after: [FixedUpdate],
      queries: [],
      fn: () => {},
    })
    .unwrap();
  expect(world.update(1 / 60).ok).toBe(false);
});

it('keeps the captured Update membership in rebuilt order after fixed-time registration', () => {
  const world = new World();
  const trace: string[] = [];
  let changed = false;
  world
    .addSystem(Update, {
      name: 'before',
      commands: 'none',
      before: [FixedUpdate],
      queries: [],
      fn: () => {
        trace.push('before');
      },
    })
    .unwrap();
  world
    .addSystem(Update, {
      name: 'a',
      commands: 'none',
      after: [FixedUpdate],
      queries: [],
      fn: () => {
        trace.push('a');
      },
    })
    .unwrap();
  world
    .addSystem(Update, {
      name: 'b',
      commands: 'none',
      after: ['a'],
      queries: [],
      fn: () => {
        trace.push('b');
      },
    })
    .unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'register',
      commands: 'none',
      queries: [],
      fn: () => {
        trace.push('fixed');
        if (changed) return;
        changed = true;
        world
          .replaceSystem(Update, 'a', {
            name: 'a',
            commands: 'none',
            after: ['b'],
            queries: [],
            fn: () => {
              trace.push('a');
            },
          })
          .unwrap();
        world
          .replaceSystem(Update, 'b', {
            name: 'b',
            commands: 'none',
            after: [FixedUpdate],
            queries: [],
            fn: () => {
              trace.push('b');
            },
          })
          .unwrap();
        world
          .addSystem(Update, {
            name: 'new',
            commands: 'none',
            after: ['a'],
            queries: [],
            fn: () => {
              trace.push('new');
            },
          })
          .unwrap();
      },
    })
    .unwrap();
  world.update(1 / 60).unwrap();
  expect(trace).toEqual(['before', 'fixed', 'b', 'a']);
  trace.length = 0;
  world.update(1 / 60).unwrap();
  expect(trace).toEqual(['before', 'fixed', 'b', 'a', 'new']);
});
