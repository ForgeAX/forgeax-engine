import { defineComponent, World } from '@forgeax/engine-ecs';
import { addOnEnter, defineState, despawnOnExit, getState, registerStatesPlugin, setNextState } from '@forgeax/engine-state';
import { expect, test } from 'vitest';

test('control: state plugin without live scoped entities releases its component', () => {
  const token = defineState('Round2Empty', ['off', 'on']);
  const world = new World();
  const dispose = registerStatesPlugin(world);
  dispose();
  expect(world.components.resolve(`__scopedTo__${token.name}`)).toBeUndefined();
  const reinstalled = registerStatesPlugin(world);
  expect(getState(world, token).unwrap()).toBe('off');
  reinstalled();
});

test('a disposed owner cannot release a later plugin installation', () => {
  const token = defineState('Round2Reinstalled', ['off', 'on']);
  const world = new World();
  const firstDispose = registerStatesPlugin(world);
  firstDispose();
  const secondDispose = registerStatesPlugin(world);

  firstDispose();
  const duplicateDispose = registerStatesPlugin(world);
  duplicateDispose();

  expect(world.inspect().systems.filter((system) => system.name === 'transitionStates')).toHaveLength(
    1,
  );
  expect(getState(world, token).unwrap()).toBe('off');
  secondDispose();
});

test('R2-S1: disposal must not lose a rejected component lease permanently', () => {
  const token = defineState('Round2Occupied', ['off', 'on']);
  const world = new World();
  const dispose = registerStatesPlugin(world);
  const entity = world.spawn().unwrap();
  despawnOnExit(world, entity, token, 'off');
  expect(dispose).toThrowError(expect.objectContaining({ code: 'component-in-use' }));
  expect(world.inspect().systems.some((system) => system.name === 'transitionStates')).toBe(false);
  world.despawn(entity).unwrap();
  dispose();
  expect(world.components.resolve(`__scopedTo__${token.name}`)).toBeUndefined();
  const reinstalled = registerStatesPlugin(world);
  expect(getState(world, token).unwrap()).toBe('off');
  reinstalled();
});

test('R2-S2: distinct token and variant pairs must dispatch only their own callbacks', () => {
  const left = defineState('Round2Label__OnEnter__X', ['idle', 'Y']);
  const right = defineState('Round2Label', ['idle', 'X__OnEnter__Y']);
  const world = new World();
  const dispose = registerStatesPlugin(world);
  const events: string[] = [];
  const removeLeft = addOnEnter(left, 'Y', () => events.push('left'));
  const removeRight = addOnEnter(right, 'X__OnEnter__Y', () => events.push('right'));
  try {
    setNextState(world, left, 'Y').unwrap();
    world.update(1 / 60);
    expect(getState(world, right).unwrap()).toBe('idle');
    expect(events).toEqual(['left']);
  } finally {
    removeLeft();
    removeRight();
    dispose();
  }
});


test('callback labels keep Unicode, separators, quotes and transition kinds distinct', () => {
  const token = defineState('identity-\u03b1-__OnExit__', ['a__OnEnter__b', 'a', '\u03b2', '"'] as const);
  const world = new World();
  const dispose = registerStatesPlugin(world);
  const events: string[] = [];
  const remove = token.variants.map(variant => addOnEnter(token, variant, () => events.push(variant)));
  try {
    for (const variant of token.variants.slice(1)) {
      setNextState(world, token, variant).unwrap();
      world.update(1 / 60).unwrap();
    }
    expect(events).toEqual(token.variants.slice(1));
  } finally { for (const unsubscribe of remove) unsubscribe(); dispose(); }
});


test('failed activation releases earlier token leases and resources without retiring another owner', () => {
  const first = defineState('CompressionActivationFirst', ['off', 'on']);
  const conflict = defineState('CompressionActivationConflict', ['off', 'on']);
  const world = new World();
  const foreign = defineComponent(`__scopedTo__${conflict.name}`, { foreign: 'f32' });
  const foreignLease = world.components.register(foreign).unwrap();

  expect(() => registerStatesPlugin(world)).toThrowError(
    expect.objectContaining({ code: 'component-name-conflict' }),
  );
  expect(world.components.resolve(`__scopedTo__${first.name}`)).toBeUndefined();
  expect(world.hasResource(`__state__${first.name}`)).toBe(false);
  expect(world.components.resolve(foreign.name)).toBe(foreign);
  expect(world.inspect().systems.some((system) => system.name === 'transitionStates')).toBe(false);

  foreignLease.dispose().unwrap();
  const dispose = registerStatesPlugin(world);
  expect(getState(world, first).unwrap()).toBe('off');
  dispose();
});


test('failed activation retains an in-use rollback lease until activation can retry', () => {
  const first = defineState('CompressionActivationOccupied', ['off', 'on']);
  const conflict = defineState('CompressionActivationOccupiedConflict', ['off', 'on']);
  const world = new World();
  const entity = world.spawn().unwrap();
  despawnOnExit(world, entity, first, 'off');
  const foreign = defineComponent(`__scopedTo__${conflict.name}`, { foreign: 'f32' });
  const foreignLease = world.components.register(foreign).unwrap();

  expect(() => registerStatesPlugin(world)).toThrowError(
    expect.objectContaining({code: 'component-in-use'}),
  );
  expect(world.hasResource(`__state__${first.name}`)).toBe(false);
  expect(world.components.resolve(foreign.name)).toBe(foreign);

  const releasedKey = `__state__${first.name}`;
  const laterResource = { owner: 'another contributor' };
  world.insertResource(releasedKey, laterResource);
  expect(() => registerStatesPlugin(world)).toThrowError(
    expect.objectContaining({ code: 'component-in-use' }),
  );
  expect(world.getResource(releasedKey)).toBe(laterResource);
  world.removeResource(releasedKey);
  world.despawn(entity).unwrap();
  foreignLease.dispose().unwrap();
  const dispose = registerStatesPlugin(world);
  expect(getState(world, first).unwrap()).toBe('off');
  dispose();
  expect(world.components.resolve(`__scopedTo__${first.name}`)).toBeUndefined();
  expect(world.components.resolve(`__scopedTo__${conflict.name}`)).toBeUndefined();
});
