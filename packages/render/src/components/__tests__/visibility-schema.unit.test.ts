import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Visibility, VisibilityStateValue, visibilityStateFromU32 } from '../visibility';

describe('M1 Visibility schema', () => {
  it('uses inherited as the default and decodes the closed three-state set', () => {
    const world = new World();
    const entity = world.spawn({ component: Visibility, data: {} }).unwrap();

    expect(world.get(entity, Visibility).unwrap().state).toBe(VisibilityStateValue.inherited);
    expect(Visibility.fields.state.labels).toEqual(VisibilityStateValue);
    expect(Object.isFrozen(Visibility.fields.state.labels)).toBe(true);
    expect(JSON.parse(JSON.stringify(Visibility.fields.state.labels))).toEqual(
      VisibilityStateValue,
    );
    expect(Visibility.fields.state.default).toBe(VisibilityStateValue.inherited);
    expect(visibilityStateFromU32(VisibilityStateValue.inherited)).toBe('inherited');
    expect(visibilityStateFromU32(VisibilityStateValue.hidden)).toBe('hidden');
    expect(visibilityStateFromU32(VisibilityStateValue.visible)).toBe('visible');
    expect(visibilityStateFromU32(3)).toBeUndefined();
  });

  it('supports real World.set and Query consumption without a cast', () => {
    const world = new World();
    const entity = world.spawn({ component: Visibility, data: {} }).unwrap();

    expect(world.set(entity, Visibility, { state: VisibilityStateValue.hidden }).ok).toBe(true);

    const query = world.query({ read: [Visibility] }).unwrap();
    let stateFromQuery: number | undefined;
    for (const row of query) stateFromQuery = row.get(Visibility).state;

    expect(stateFromQuery).toBe(VisibilityStateValue.hidden);
  });
});
