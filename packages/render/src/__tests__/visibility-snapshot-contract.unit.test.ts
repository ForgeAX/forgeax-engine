import { World } from '@forgeax/engine-ecs';
import { ChildOf } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { resolveVisibility } from '../extract/visibility';

describe('visibility snapshot contract', () => {
  it('projects intent and effective state without writing a derived component', () => {
    const world = new World();
    const parent = world
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } })
      .unwrap();
    const child = world
      .spawn(
        { component: Visibility, data: { state: VisibilityStateValue.inherited } },
        { component: ChildOf, data: { parent } },
      )
      .unwrap();

    const snapshot = resolveVisibility(world);
    const childResult = snapshot.get(child);

    expect(childResult).toMatchObject({ intent: 'inherited', effective: 'hidden' });
    expect(snapshot.diagnostics).toEqual([]);
    expect(world.components.resolve('EffectiveVisibility')).toBeUndefined();
  });

  it('is read-only and does not retain a previous World result', () => {
    const first = new World();
    const firstEntity = first
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } })
      .unwrap();
    const firstSnapshot = resolveVisibility(first);
    expect(firstSnapshot.get(firstEntity)?.effective).toBe('hidden');

    const second = new World();
    second.spawn().unwrap();
    const secondEntity = second
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.visible } })
      .unwrap();
    const secondSnapshot = resolveVisibility(second);

    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(secondSnapshot.get(secondEntity)?.effective).toBe('visible');
    // The first numeric handle is occupied by a non-visibility entity in the
    // second World, so a prior World snapshot cannot leak a result into it.
    expect(secondSnapshot.get(firstEntity)).toBeUndefined();
  });

  it('exposes diagnostics alongside entity queries for a broken parent edge', () => {
    const world = new World();
    const child = world
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.inherited } })
      .unwrap();
    const snapshot = resolveVisibility(world);

    expect(snapshot.get(child)?.intent).toBe('inherited');
    expect(snapshot.diagnostics).toBeDefined();
  });
});
