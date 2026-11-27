import { ChangeEpochExhaustedError, Disabled, World } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { describe, expect, it, vi } from 'vitest';
import { ChildOf, Children, GlobalTransform, propagateTransforms, Transform } from '../index';

const worldInternal: unique symbol = Symbol.for(
  'forgeax.ecs.worldInternal',
) as unknown as typeof worldInternal;
interface EpochInjection {
  readonly [worldInternal]: { nextMutationEpoch(): number };
}

function fixture() {
  const world = new World();
  for (const component of [Transform, ChildOf, Children, Disabled])
    world.components.register(component).unwrap();
  const root = world.spawn({ component: Transform, data: { pos: [3, 0, 0] } }).unwrap();
  const child = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
      { component: Disabled, data: {} },
    )
    .unwrap();
  return { world, root, child };
}

describe('Disabled hierarchy propagation', () => {
  it('keeps a disabled child unchanged while its participating parent moves, then admits the child after enable', () => {
    const { world, root, child } = fixture();
    const initial = Array.from(world.get(child, GlobalTransform).unwrap().world);
    for (const x of [3, 4, 5]) {
      world.set(root, Transform, { pos: [x, 0, 0] }).unwrap();
      propagateTransforms(world).unwrap();
      expect(Array.from(world.get(child, GlobalTransform).unwrap().world)).toEqual(initial);
    }
    world.removeComponent(child, Disabled).unwrap();
    propagateTransforms(world).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(7);
    world.addComponent(child, { component: Disabled, data: {} }).unwrap();
    world.set(root, Transform, { pos: [8, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(7);
    world.removeComponent(child, Disabled).unwrap();
    propagateTransforms(world).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(10);
  });

  it('preserves authored change evidence when a reenabled child receives the same pose', () => {
    const { world, child } = fixture();
    world.removeComponent(child, Disabled).unwrap();
    propagateTransforms(world).unwrap();
    world.addComponent(child, { component: Disabled, data: {} }).unwrap();
    propagateTransforms(world).unwrap();
    const previous = world[worldRead].getChangedEpoch(child, GlobalTransform);

    world.removeComponent(child, Disabled).unwrap();
    world.set(child, Transform, { pos: [2, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();

    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(5);
    expect(world[worldRead].getChangedEpoch(child, GlobalTransform)).toBeGreaterThan(previous);
  });

  it('still reports a participating descendant whose Transform parent is disabled', () => {
    const { world, child } = fixture();
    world.spawn({ component: ChildOf, data: { parent: child } }).unwrap();
    expect(propagateTransforms(world)).toMatchObject({
      ok: false,
      error: { code: 'hierarchy-broken' },
    });
  });

  it('does not let Disabled hide a genuinely incomplete child Transform pair', () => {
    const { world, root, child } = fixture();
    world.spawn({ component: ChildOf, data: { parent: root } }).unwrap();
    world.removeComponent(child, GlobalTransform).unwrap();
    expect(world.hasComponent(child, GlobalTransform)).toBe(false);
    expect(propagateTransforms(world)).toMatchObject({
      ok: false,
      error: { code: 'hierarchy-broken' },
    });
  });
});

it('replays flat re-entry after a failed derived epoch reservation', () => {
  const world = new World();
  const entity = world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
  propagateTransforms(world).unwrap();
  world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
  world.set(entity, Transform, { pos: [9, 0, 0] }).unwrap();
  propagateTransforms(world).unwrap();
  world.removeComponent(entity, Disabled).unwrap();
  const failure = vi
    .spyOn((world as unknown as EpochInjection)[worldInternal], 'nextMutationEpoch')
    .mockImplementationOnce(() => {
      throw new ChangeEpochExhaustedError(Number.MAX_SAFE_INTEGER);
    });
  try {
    expect(propagateTransforms(world).ok).toBe(false);
  } finally {
    failure.mockRestore();
  }
  propagateTransforms(world).unwrap();
  expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBe(9);
});
