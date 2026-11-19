import { err, ok, type Result } from '@forgeax/engine-types';
import { expect, test } from 'vitest';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { createStateProjection } from '../projection/state-projection';
import { defineResource } from '../resource';
import { defineSystem } from '../schedule';
import { defineSchedule, Update } from '../schedule-token';
import { FixedTime, Time } from '../time';
import { World } from '../world';

const Input = defineComponent('DomainScheduleInput', { x: 'f32' });
const Prepared = defineComponent('DomainSchedulePrepared', { x: 'f32' });
const Submitted = defineComponent('DomainScheduleSubmitted', { x: 'f32' });
const Domain = defineSchedule('DomainSchedule');

test('a domain schedule derives, attempts and conditionally commits without advancing World time', () => {
  const resource1 = defineResource<Result<number, string>>('operation-result');

  const world = new World();
  const entity = world
    .spawn(
      { component: Input, data: {} },
      { component: Prepared, data: {} },
      { component: Submitted, data: {} },
    )
    .unwrap();
  const time = { ...world.getResource(Time) };
  const fixed = { ...world.getResource(FixedTime) };
  const prepare = createStateProjection(world, [Input]);
  const commit = createStateProjection(world, [Prepared]);
  prepare.read().accept();
  commit.read().accept();
  const trace: string[] = [];
  let available = false;
  const systemToken1 = defineSystem({
    name: 'prepare',
    queries: [],
    fn: () => {
      trace.push('prepare');
      const batch = prepare.read();
      for (const index of batch.indices) {
        const current = prepare.entity(index) as EntityHandle;
        world.set(current, Prepared, { x: world.get(current, Input).unwrap().x * 2 }).unwrap();
      }
      batch.accept();
    },
  });
  world.addSystem(Domain, systemToken1);
  const systemToken2 = defineSystem({
    name: 'attempt',
    after: [systemToken1],
    queries: [],
    fn: () => {
      trace.push('attempt');
      const result: Result<number, string> = available ? ok(1) : err('temporarily-unavailable');
      world.insertResource(resource1, result);
    },
  });
  world.addSystem(Domain, systemToken2);
  const systemToken3 = defineSystem({
    name: 'commit',
    after: [systemToken2],
    queries: [],
    runIf: () => world.getResource(resource1).ok,
    fn: () => {
      trace.push('commit');
      const batch = commit.read();
      for (const index of batch.indices) {
        const current = commit.entity(index) as EntityHandle;
        world.set(current, Submitted, { x: world.get(current, Prepared).unwrap().x }).unwrap();
      }
      batch.accept();
    },
  });
  world.addSystem(Domain, systemToken3).unwrap();
  world.set(entity, Input, { x: 3 }).unwrap();
  world.run(Domain).unwrap();
  expect(trace).toEqual(['prepare', 'attempt']);
  expect(world.execution.health).toBe('healthy');
  expect(world.get(entity, Prepared).unwrap().x).toBe(6);
  expect(world.get(entity, Submitted).unwrap().x).toBe(0);
  expect(prepare.isCurrent()).toBe(true);
  expect(commit.isCurrent()).toBe(false);
  available = true;
  trace.length = 0;
  world.run(Domain).unwrap();
  expect(trace).toEqual(['prepare', 'attempt', 'commit']);
  expect(world.get(entity, Submitted).unwrap().x).toBe(6);
  expect(prepare.isCurrent()).toBe(true);
  expect(commit.isCurrent()).toBe(true);
  expect(world.getResource(Time)).toEqual(time);
  expect(world.getResource(FixedTime)).toEqual(fixed);
});

test('domain schedules are registered on first use and only run explicitly', () => {
  const world = new World();
  let runs = 0;
  const systemToken4 = defineSystem({ name: 'domain', queries: [], fn: () => void runs++ });
  world.addSystem(Domain, systemToken4).unwrap();
  world.update(1 / 60).unwrap();
  expect(runs).toBe(0);
  world.run(Domain).unwrap();
  expect(runs).toBe(1);
  expect(world.run(Update).ok).toBe(false);
  const sameName = defineSchedule('Update');
  expect(sameName).not.toBe(Update);
  expect(world.run(sameName).ok).toBe(true);
});

test('a domain system cannot order against another schedule', () => {
  const world = new World();
  const systemToken5 = defineSystem({ name: 'simulation', queries: [], fn: () => {} });
  world.addSystem(Update, systemToken5).unwrap();
  const systemToken6 = defineSystem({
    name: 'render',
    after: [systemToken5],
    queries: [],
    fn: () => {},
  });
  world.addSystem(Domain, systemToken6).unwrap();
  const result = world.run(Domain);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('schedule-scope-mismatch');
});

test('a returned system failure retains the poisoned-World policy', () => {
  const world = new World();
  const systemToken7 = defineSystem({
    name: 'failure',
    queries: [],
    fn: () => err('injected-operation-failure'),
  });
  world.addSystem(Domain, systemToken7).unwrap();
  expect(world.run(Domain).ok).toBe(false);
  expect(world.execution.health).toBe('poisoned');
  expect(world.run(Domain).ok).toBe(false);
});

test('multi-component changed predicates are conjunctive while a state projection discovers the union', () => {
  const world = new World();
  const entity = world
    .spawn({ component: Input, data: {} }, { component: Prepared, data: {} })
    .unwrap();
  const both = world.query({ read: [Input, Prepared], changed: [Input, Prepared] }).unwrap();
  Array.from(both);
  const either = createStateProjection(world, [Input, Prepared]);
  either.read().accept();
  world.set(entity, Input, { x: 1 }).unwrap();
  expect(Array.from(both)).toEqual([]);
  expect(either.read().indices).toHaveLength(1);
});
