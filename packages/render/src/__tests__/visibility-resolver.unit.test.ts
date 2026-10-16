import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { resolveVisibility } from '../extract/visibility';
import { Visibility, VisibilityStateValue } from '../index';

function spawn(
  world: World,
  state: keyof typeof VisibilityStateValue,
  parent?: EntityHandle,
): EntityHandle {
  const parentData = parent === undefined ? [] : [{ component: ChildOf, data: { parent } }];
  return world
    .spawn({ component: Visibility, data: { state: VisibilityStateValue[state] } }, ...parentData)
    .unwrap();
}

describe('visibility resolver truth table', () => {
  it('defaults root inherited to visible and preserves explicit states', () => {
    const world = new World();
    const inherited = spawn(world, 'inherited');
    const hidden = spawn(world, 'hidden');
    const visible = spawn(world, 'visible');

    const snapshot = resolveVisibility(world);

    expect(snapshot.get(inherited)).toMatchObject({
      intent: 'inherited',
      effective: 'visible',
      source: 'default',
    });
    expect(snapshot.get(hidden)).toMatchObject({
      intent: 'hidden',
      effective: 'hidden',
      source: 'self',
    });
    expect(snapshot.get(visible)).toMatchObject({
      intent: 'visible',
      effective: 'visible',
      source: 'self',
    });
  });

  it.each([
    ['visible', 'inherited', 'visible'],
    ['visible', 'hidden', 'hidden'],
    ['visible', 'visible', 'visible'],
    ['hidden', 'inherited', 'hidden'],
    ['hidden', 'hidden', 'hidden'],
    ['hidden', 'visible', 'visible'],
  ] as const)('resolves parent %s and child %s as %s', (parentState, childState, expected) => {
    const world = new World();
    const parent = spawn(world, parentState);
    const child = spawn(world, childState, parent);

    const result = resolveVisibility(world);

    expect(result.get(child)?.effective).toBe(expected);
  });

  it('lets explicit visible establish a new inherited baseline below a hidden ancestor', () => {
    const world = new World();
    const hiddenParent = spawn(world, 'hidden');
    const visibleChild = spawn(world, 'visible', hiddenParent);
    const inheritedGrandchild = spawn(world, 'inherited', visibleChild);

    const snapshot = resolveVisibility(world);

    expect(snapshot.get(hiddenParent)?.effective).toBe('hidden');
    expect(snapshot.get(visibleChild)?.effective).toBe('visible');
    expect(snapshot.get(inheritedGrandchild)?.effective).toBe('visible');
    expect(snapshot.get(inheritedGrandchild)?.source).toBe('parent');
  });

  it('keeps the author intent queryable for a non-render hierarchy node', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const child = spawn(world, 'inherited', parent);

    const result = resolveVisibility(world);

    expect(result.get(parent)?.intent).toBeUndefined();
    expect(result.get(child)?.effective).toBe('visible');
  });

  it('invalidates the cached snapshot when visibility intent changes', () => {
    const world = new World();
    const parent = spawn(world, 'visible');
    const child = spawn(world, 'inherited', parent);

    const visible = resolveVisibility(world);
    expect(visible.effective(child)).toBe('visible');

    world.set(parent, Visibility, { state: VisibilityStateValue.hidden }).unwrap();

    const hidden = resolveVisibility(world);
    expect(hidden).not.toBe(visible);
    expect(hidden.effective(child)).toBe('hidden');
  });
});
