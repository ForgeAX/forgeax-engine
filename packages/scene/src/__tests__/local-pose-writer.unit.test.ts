import { ENTITY_MAX_INDEX, type EntityHandle, World } from '@forgeax/engine-ecs';
import { readMutationEpoch } from '@forgeax/engine-ecs/projection';
import { expect, it } from 'vitest';
import { Transform } from '../components/transform';
import { createLocalPoseWriter } from '../local-pose-writer';

function packed(position: readonly number[], scale = [2, 3, 4]): number[] {
  return [...position, 0, 1, 0, 0, ...scale];
}

function readPose(world: World, entity: EntityHandle): number[] {
  const { pos, quat, scale } = world.get(entity, Transform).unwrap();
  return [...pos, ...quat, ...scale];
}

it('publishes the full packed row once and compares against current Float32 storage', () => {
  const world = new World();
  const entity = world.spawn({ component: Transform, data: {} }).unwrap();
  const changed = world.query({ changed: [Transform] }).unwrap();
  expect([...changed].map((row) => row.entity)).toEqual([entity]);
  const write = createLocalPoseWriter(world);

  const values = packed([1, 2, 3]);
  const epoch = readMutationEpoch(world);
  write(entity, [-99, ...values, 99], 1);
  expect(readPose(world, entity)).toEqual(values);
  expect(readMutationEpoch(world)).toBe(epoch + 1);
  expect([...changed].map((row) => row.entity)).toEqual([entity]);

  write(entity, packed([1 + 2 ** -30, 2, 3]), 0);
  expect(readMutationEpoch(world)).toBe(epoch + 1);
  expect([...changed]).toEqual([]);

  world.set(entity, Transform, { pos: [7, 8, 9], scale: [5, 6, 7] }).unwrap();
  expect([...changed].map((row) => row.entity)).toEqual([entity]);
  const external = readMutationEpoch(world);
  write(entity, values, 0);
  expect(readPose(world, entity)).toEqual(values);
  expect(readMutationEpoch(world)).toBe(external + 1);
  expect([...changed].map((row) => row.entity)).toEqual([entity]);
});

it('keeps outer input through nested writes and resolves a live entity generation after reading', () => {
  const world = new World();
  // Use one ordinary archetype so the callback can grow the writer's already-resolved columns.
  const spawn = () => world.spawn({ component: Transform, data: {} }).unwrap();
  const outer = spawn();
  const inner = spawn();
  const write = createLocalPoseWriter(world);
  write(outer, packed([1, 2, 3]), 0);
  const outerPose = packed([4, 5, 6], [5, 7, 9]);
  const innerPose = packed([7, 8, 9], [6, 8, 10]);
  const input = new Proxy(outerPose, {
    get(target, key) {
      if (key === '5') {
        write(inner, innerPose, 0);
        for (let count = 0; count < 80; count++) spawn();
      }
      return Reflect.get(target, key);
    },
  });
  write(outer, input, 0);
  expect(readPose(world, outer)).toEqual(outerPose);
  expect(readPose(world, inner)).toEqual(innerPose);

  let replacement: EntityHandle | undefined;
  const retired = new Proxy(outerPose, {
    get(target, key) {
      if (key === '5') {
        world.despawn(outer).unwrap();
        replacement = spawn();
        write(replacement, innerPose, 0);
      }
      return Reflect.get(target, key);
    },
  });
  expect(() => write(outer, retired, 0)).toThrow(expect.objectContaining({ code: 'stale-entity' }));
  if (replacement === undefined) throw new Error('Expected a replacement Transform row');
  expect(replacement).not.toBe(outer);
  expect(replacement & ENTITY_MAX_INDEX).toBe(outer & ENTITY_MAX_INDEX);
  expect(readPose(world, replacement)).toEqual(innerPose);
});

it('keeps the accepted pose when its change epoch cannot be issued', () => {
  const world = new World();
  const entity = world.spawn({ component: Transform, data: {} }).unwrap();
  const write = createLocalPoseWriter(world);
  const before = readPose(world, entity);
  Object.defineProperty(world, 'mutationEpoch', { value: Number.MAX_SAFE_INTEGER, writable: true });
  write(entity, before, 0);
  expect(() => write(entity, packed([4, 5, 6]), 0)).toThrow();
  expect(readPose(world, entity)).toEqual(before);
});
