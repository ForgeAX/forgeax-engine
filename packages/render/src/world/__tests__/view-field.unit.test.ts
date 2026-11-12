import { defineComponent, World } from '@forgeax/engine-ecs';
import { setDerivedComponent } from '@forgeax/engine-ecs/projection';
import { expect, it, vi } from 'vitest';
import { EMPTY_VIEW_STATE_UPDATE, readViewField, requireViewField } from '../view-field';
import { ViewFrame, type ViewFrameState, viewFrameOf } from '../view-frame-systems';

const Values = defineComponent('ViewFieldValues', { enabled: 'bool', count: 'u32' });
const State = defineComponent('ViewFieldState', { state: 'unique<ViewFieldState>' });

it('reads a staged view through its live scalar handle without a component snapshot', () => {
  const world = new World();
  const state: ViewFrameState = {
    frame: 0,
    opts: { cameraOwner: 0, resourceOwner: 0 },
    mode: true,
    publication: undefined,
    result: undefined,
  };
  const handle = world.allocUniqueRef('ViewFrame', state);
  const entity = world.spawn({ component: ViewFrame, data: { state: handle } }).unwrap();
  const snapshot = vi.spyOn(world, 'get').mockImplementation(() => {
    throw new Error('a staged view must not materialize a component snapshot');
  });
  try {
    expect(viewFrameOf(world, entity)).toBe(state);
    state.mode = 'capture';
    expect(viewFrameOf(world, entity)?.mode).toBe('capture');
    state.frame = 1;
    expect(viewFrameOf(world, entity)).toBeUndefined();
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    snapshot.mockRestore();
  }
});

it('reads zero, false and optional reference identities without component snapshots', () => {
  const world = new World();
  const payload = { value: 7 };
  const handle = world.allocUniqueRef('ViewFieldState', payload);
  const first = world
    .spawn(
      { component: Values, data: { enabled: false, count: 0 } },
      { component: State, data: { state: handle } },
    )
    .unwrap();
  const second = world.spawn({ component: Values, data: { enabled: true, count: 12 } }).unwrap();
  const query = world.query({ read: [Values], optional: [State] }).unwrap();
  const snapshot = vi.spyOn(world, 'get').mockImplementation(() => {
    throw Error('numeric view reads must not materialize component snapshots');
  });
  try {
    const observed = [];
    for (const row of query) {
      const entity = row.entity;
      observed.push([
        entity,
        readViewField(world, entity, Values, 'enabled'),
        readViewField(world, entity, Values, 'count'),
        readViewField(world, entity, State, 'state'),
      ]);
    }
    expect(observed).toEqual([
      [first, false, 0, handle],
      [second, true, 12, undefined],
    ]);
    expect(world.resolveUniqueRef(requireViewField(world, first, State, 'state')).unwrap()).toBe(
      payload,
    );
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    snapshot.mockRestore();
  }
  expect(() => requireViewField(world, second, State, 'state')).toThrow(
    'does not have component "ViewFieldState"',
  );
});

it('rejects retired identities and observes field edits and reference replacement', () => {
  const world = new World();
  const first = world.spawn({ component: Values, data: { count: 3 } }).unwrap();
  world.set(first, Values, { enabled: true, count: 9 }).unwrap();
  expect(readViewField(world, first, Values, 'enabled')).toBe(true);
  expect(readViewField(world, first, Values, 'count')).toBe(9);
  world.despawn(first).unwrap();
  const replacement = world.spawn({ component: Values, data: { count: 22 } }).unwrap();
  expect(replacement).not.toBe(first);
  expect(readViewField(world, first, Values, 'count')).toBeUndefined();
  expect(readViewField(world, replacement, Values, 'count')).toBe(22);
  const handle = world.allocUniqueRef('ViewFieldState', { value: 1 });
  world.addComponent(replacement, { component: State, data: { state: handle } }).unwrap();
  expect(readViewField(world, replacement, State, 'state')).toBe(handle);
  world.removeComponent(replacement, State).unwrap();
  expect(readViewField(world, replacement, State, 'state')).toBeUndefined();
});

it('retains eager write evidence without replacing or releasing the managed reference', () => {
  const world = new World();
  const released = vi.fn();
  const payload = { value: 1 };
  const handle = world.allocUniqueRef('ViewFieldState', payload, released);
  const entity = world.spawn({ component: State, data: { state: handle } }).unwrap();
  const changed = world.query({ read: [State], changed: [State] }).unwrap();
  for (const row of changed) expect(row.entity).toBe(entity);
  payload.value = 2;
  setDerivedComponent(world, entity, State, EMPTY_VIEW_STATE_UPDATE).unwrap();
  const selected = [];
  for (const row of changed) selected.push(row.entity);
  expect(selected).toEqual([entity]);
  expect(readViewField(world, entity, State, 'state')).toBe(handle);
  expect(world.resolveUniqueRef(handle).unwrap()).toBe(payload);
  expect(released).not.toHaveBeenCalled();
});
