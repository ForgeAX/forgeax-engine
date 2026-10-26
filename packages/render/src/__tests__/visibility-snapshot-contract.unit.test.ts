import { World } from '@forgeax/engine-ecs';
import { ChildOf } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
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

it('captures lazy reads before later visibility edits and generation replacement', () => {
  const world = new World();
  const parent = world
    .spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } })
    .unwrap();
  const child = world.spawn({ component: ChildOf, data: { parent } }).unwrap();
  const before = resolveVisibility(world);
  world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
  const after = resolveVisibility(world);
  expect(before.effective(child)).toBe('hidden');
  expect(after.effective(child)).toBe('visible');
  expect(after.hasAnyHiddenIntent).toBe(false);
  world.despawn(parent).unwrap();
  const replacement = world
    .spawn({ component: Visibility, data: { state: VisibilityStateValue.inherited } })
    .unwrap();
  const next = resolveVisibility(world);
  expect(next.get(parent)).toBeUndefined();
  expect(next.get(replacement)?.intent).toBe('inherited');
  expect(next.hasAnyIntent).toBe(true);
  expect(next.hasAnyHiddenIntent).toBe(false);
  expect(after.get(parent)?.effective).toBe('visible');
});

it('observes removal, inheritance changes and equal-count membership after unrelated migrations', () => {
  const world = new World();
  const hidden = world
    .spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } })
    .unwrap();
  const visible = world
    .spawn({ component: Visibility, data: { state: VisibilityStateValue.visible } })
    .unwrap();
  const child = world.spawn({ component: ChildOf, data: { parent: hidden } }).unwrap();
  expect(resolveVisibility(world).effective(child)).toBe('hidden');
  const unrelated = world.spawn().unwrap();
  expect(resolveVisibility(world).effective(child)).toBe('hidden');
  world.despawn(unrelated).unwrap();
  world.set(child, ChildOf, { parent: visible }).unwrap();
  expect(resolveVisibility(world).effective(child)).toBe('visible');
  world.removeComponent(visible, Visibility).unwrap();
  world
    .addComponent(child, { component: Visibility, data: { state: VisibilityStateValue.hidden } })
    .unwrap();
  const changed = resolveVisibility(world);
  expect(changed.get(visible)).toBeUndefined();
  expect(changed.get(child)?.effective).toBe('hidden');
});

it.each([1000, 100000])('keeps visibility capture proportional to 8 flips at N=%i', (count) => {
  const world = new World();
  const entities = Array.from({ length: count }, () =>
    world.spawn({ component: Visibility, data: {} }).unwrap(),
  );
  let visitedRows = 0;
  const query = world.query.bind(world);
  const queries = vi.spyOn(world, 'query').mockImplementation((options) => {
    const result = query(options);
    if (result.ok && options.read?.includes(Visibility)) {
      const spans = result.value.spans.bind(result.value);
      vi.spyOn(result.value, 'spans').mockImplementation(() => {
        const result = spans();
        if (result.ok) for (const span of result.value) visitedRows += span.length;
        return result;
      });
    }
    return result;
  });
  const baseline = resolveVisibility(world);
  expect(baseline.hasAnyHiddenIntent).toBe(false);
  visitedRows = 0;
  const flipped = entities.slice(100, 108);
  for (const entity of flipped)
    world.set(entity, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
  const hidden = resolveVisibility(world);
  // No full read-query scan is allowed before a cache return. The changed
  // entities' values and snapshot isolation are checked below.
  expect(visitedRows).toBeLessThanOrEqual(flipped.length);
  queries.mockRestore();
  expect(hidden.hasAnyHiddenIntent).toBe(true);
  for (const entity of flipped) expect(hidden.effective(entity)).toBe('hidden');
  expect(hidden.effective(entities[0] as (typeof entities)[number])).toBe('visible');
  expect(baseline.get(flipped[0] as (typeof flipped)[number])?.intent).toBe('inherited');
  for (const entity of flipped) world.despawn(entity).unwrap();
  const despawned = resolveVisibility(world);
  expect(despawned.hasAnyHiddenIntent).toBe(false);
  expect(despawned.get(flipped[0] as (typeof flipped)[number])).toBeUndefined();
  expect(hidden.effective(flipped[0] as (typeof flipped)[number])).toBe('hidden');
});
