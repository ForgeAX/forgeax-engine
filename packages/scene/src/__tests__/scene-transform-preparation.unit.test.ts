import { Disabled, type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Children, GlobalTransform, propagateTransforms, Transform } from '../index';
import {
  prepareSceneTransformsSteps,
  type SceneTransformPreparation,
} from '../instances/preparation';

function fixture() {
  const world = new World();
  for (const component of [Transform, ChildOf, Children, Disabled])
    world.components.register(component).unwrap();
  const root = world
    .spawn(
      { component: Transform, data: { pos: [3, 4, 5], scale: [2, 1, 3] } },
      { component: Disabled, data: {} },
    )
    .unwrap();
  const child = world
    .spawn(
      { component: Transform, data: { pos: [1, 2, 3], quat: [0, 0, 0.6, 0.8] } },
      { component: ChildOf, data: { parent: root } },
      { component: Disabled, data: {} },
    )
    .unwrap();
  const leaf = world
    .spawn(
      { component: Transform, data: { pos: [-2, 1, 0] } },
      { component: ChildOf, data: { parent: child } },
      { component: Disabled, data: {} },
    )
    .unwrap();
  const input: SceneTransformPreparation = {
    members: [leaf, child, root],
    authorDisabled: new Set(),
    isCurrent: () => true,
  };
  return { world, root, child, leaf, input };
}

function matrix(world: World, entity: EntityHandle) {
  return Array.from(world.get(entity, GlobalTransform).unwrap().world);
}

function finish(world: World, input: SceneTransformPreparation) {
  const task = prepareSceneTransformsSteps(world, input);
  let next = task.next();
  while (!next.done) next = task.next();
  return next.value;
}

describe('owned inactive Transform preparation', () => {
  it('matches ordinary propagation for an unsorted affine hierarchy without touching another disabled candidate', () => {
    const { world, root, child, leaf, input } = fixture();
    const other = world
      .spawn({ component: Transform, data: { pos: [99, 0, 0] } }, { component: Disabled, data: {} })
      .unwrap();
    const untouched = matrix(world, other);
    const task = prepareSceneTransformsSteps(world, input);
    let next = task.next();
    let observations = 0;
    while (!next.done) {
      observations++;
      world.update(1 / 60).unwrap();
      expect(matrix(world, other)).toEqual(untouched);
      next = task.next();
    }
    expect(next.value.unwrap()).toBe(3);
    expect(observations).toBeGreaterThan(9);
    const prepared = [root, child, leaf].map((entity) => matrix(world, entity));
    for (const entity of [root, child, leaf]) world.removeComponent(entity, Disabled).unwrap();
    propagateTransforms(world).unwrap();
    expect([root, child, leaf].map((entity) => matrix(world, entity))).toEqual(prepared);
    expect(matrix(world, other)).toEqual(untouched);
  });

  it('rejects an enabled descendant of an author-disabled ancestor before any derived write', () => {
    const { world, root, child, leaf, input } = fixture();
    const before = [root, child, leaf].map((entity) => matrix(world, entity));
    expect(finish(world, { ...input, authorDisabled: new Set([root]) })).toMatchObject({
      ok: false,
      error: { code: 'scene-preparation-invalid', detail: { reason: 'disabled-ancestor' } },
    });
    expect([root, child, leaf].map((entity) => matrix(world, entity))).toEqual(before);
    expect(finish(world, { ...input, authorDisabled: new Set([root, child, leaf]) }).unwrap()).toBe(
      3,
    );
  });

  it('rejects incomplete ownership, duplicate rosters and an already participating member before publication', () => {
    const { world, root, child, leaf, input } = fixture();
    const before = [root, child, leaf].map((entity) => matrix(world, entity));
    expect(finish(world, { ...input, members: [child, leaf] })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'parent-outside-instance' } },
    });
    expect(finish(world, { ...input, members: [root, root, child, leaf] })).toMatchObject({
      ok: false,
      error: { detail: { reason: 'duplicate-member' } },
    });
    world.removeComponent(leaf, Disabled).unwrap();
    expect(finish(world, input)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'enabled-member' } },
    });
    expect([root, child, leaf].map((entity) => matrix(world, entity))).toEqual(before);
  });

  it('stops at a failed content guard instead of finishing a partially prepared generation', () => {
    const { world, root, leaf, input } = fixture();
    let current = true;
    const task = prepareSceneTransformsSteps(world, { ...input, isCurrent: () => current });
    let next = task.next();
    while (!next.done && matrix(world, root)[12] === 0) next = task.next();
    expect(next.done).toBe(false);
    const untouchedLeaf = matrix(world, leaf);
    current = false;
    const stopped = task.next();
    expect(stopped.done).toBe(true);
    expect(stopped.value).toMatchObject({
      ok: false,
      error: { detail: { reason: 'stale-input' } },
    });
    expect(matrix(world, leaf)).toEqual(untouchedLeaf);
    expect(world.hasComponent(root, Disabled)).toBe(true);
  });

  it('reacquires live derived rows after unrelated table growth between continuations', () => {
    const { world, root, child, leaf, input } = fixture();
    const task = prepareSceneTransformsSteps(world, input);
    let next = task.next();
    while (!next.done) {
      for (let index = 0; index < 8; index++)
        world
          .spawn(
            { component: Transform, data: { pos: [index, 0, 0] } },
            { component: Disabled, data: {} },
          )
          .unwrap();
      next = task.next();
    }
    expect(next.value.unwrap()).toBe(3);
    const prepared = [root, child, leaf].map((entity) => matrix(world, entity));
    for (const entity of [root, child, leaf]) world.removeComponent(entity, Disabled).unwrap();
    propagateTransforms(world).unwrap();
    expect([root, child, leaf].map((entity) => matrix(world, entity))).toEqual(prepared);
  });
});
