import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { renderComponentsPlugin } from '@forgeax/engine-render';
import { rootsToSceneAsset } from '@forgeax/engine-runtime';
import { GlobalTransform, Transform, worldInstantiateSceneFlat } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { DesiredPathPose, PathFollower, PathMotion, pathPlugin } from '../index';

it('saves and reloads ordinary SceneAsset path declarations and instance-local follower references', async () => {
  const source: SceneAsset = {
    kind: 'scene',
    entities: {
      rail: {
        components: {
          Name: { value: 'rail' },
          Path: {
            points: [0, 0, 0, 0.2, 4, 0, 1, 4.2, 2, 7, 1, -1, 8, 0, 0],
            subdivisions: 2048,
            closed: true,
          },
        },
      },
      patrol: {
        components: {
          Name: { value: 'patrol' },
          PathFollower: { path: 'rail', speed: 3, loop: true },
        },
      },
    },
  };
  const world = new World(),
    context = await createWorldContext(world, [pathPlugin(), renderComponentsPlugin()]);
  const registry = new AssetRegistry({} as never);
  const handle = world.allocSharedRef(
    'SceneAsset',
    JSON.parse(JSON.stringify(source)) as SceneAsset,
  );
  const first = worldInstantiateSceneFlat(world, handle).unwrap();
  const second = worldInstantiateSceneFlat(world, handle).unwrap();
  const followers = Array.from(world.query({ read: [PathFollower] }).unwrap(), (row) => row.entity);
  const [one, two] = followers;
  if (one === undefined || two === undefined) throw new Error('Expected two follower instances');
  expect(world.get(one, PathFollower).unwrap().path).not.toBe(
    world.get(two, PathFollower).unwrap().path,
  );
  world.set(one, PathFollower, { distance: 5, speed: 0 }).unwrap();
  world.update(1 / 60).unwrap();
  expect(world.get(one, PathFollower).unwrap().distance).toBe(5);
  expect(world.get(two, PathFollower).unwrap().distance).toBeCloseTo(0.05);
  const pose = Array.from(world.get(one, GlobalTransform).unwrap().world);
  const saved = rootsToSceneAsset(registry, world, first.roots).unwrap();
  expect(
    Object.values(saved.entities).some((entity) => 'DesiredPathPose' in entity.components),
  ).toBe(false);
  const third = new World(),
    thirdContext = await createWorldContext(third, [pathPlugin(), renderComponentsPlugin()]);
  const reload = third.allocSharedRef(
    'SceneAsset',
    JSON.parse(JSON.stringify(saved)) as SceneAsset,
  );
  worldInstantiateSceneFlat(third, reload).unwrap();
  third.update(1 / 60).unwrap();
  const reloaded = Array.from(
    third.query({ read: [PathFollower] }).unwrap(),
    (row) => row.entity,
  )[0];
  if (reloaded === undefined) throw new Error('Reloaded follower absent');
  expect(third.get(reloaded, PathFollower).unwrap().distance).toBe(5);
  expect(Array.from(third.get(reloaded, GlobalTransform).unwrap().world)).toEqual(pose);
  for (const entity of [...first.roots, ...second.roots]) world.despawn(entity).unwrap();
  world.update(1 / 60).unwrap();
  expect(Array.from(world.query({ read: [PathFollower] }).unwrap())).toHaveLength(0);
  await context.fiber.dispose();
  await thirdContext.fiber.dispose();
});

it('reloads saved desired-motion configuration while its motor reinstalls transient pose output', async () => {
  const source: SceneAsset = {
    kind: 'scene',
    entities: {
      rail: { components: { Path: { points: [0, 0, 0, 0, 0, 10] } } },
      platform: {
        components: {
          PathFollower: { path: 'rail', distance: 3, speed: 0, motion: PathMotion.desired },
          Transform: { pos: [5, 6, 7] },
        },
      },
    },
  };
  const registry = new AssetRegistry({} as never);
  let saved = source;
  for (let round = 0; round < 2; round++) {
    const world = new World();
    const context = await createWorldContext(world, [pathPlugin(), renderComponentsPlugin()]);
    const handle = world.allocSharedRef(
      'SceneAsset',
      JSON.parse(JSON.stringify(saved)) as SceneAsset,
    );
    const instance = worldInstantiateSceneFlat(world, handle).unwrap();
    world.sharedRefs.release(handle).unwrap();
    const follower = Array.from(
      world.query({ read: [PathFollower] }).unwrap(),
      (row) => row.entity,
    )[0];
    if (follower === undefined) throw new Error('Desired follower absent');
    expect(world.hasComponent(follower, DesiredPathPose)).toBe(false);
    // The existing motor owns this runtime output slot; it is not an author fact.
    world.addComponent(follower, { component: DesiredPathPose, data: {} }).unwrap();
    world.update(1 / 60).unwrap();
    expect(Array.from(world.get(follower, Transform).unwrap().pos)).toEqual([5, 6, 7]);
    expect(world.get(follower, DesiredPathPose).unwrap().valid).toBe(true);
    expect(Array.from(world.get(follower, DesiredPathPose).unwrap().position)).toEqual([0, 0, 3]);
    saved = rootsToSceneAsset(registry, world, instance.roots).unwrap();
    const authored = Object.values(saved.entities).find((entity) => entity.components.PathFollower);
    expect(authored?.components.PathFollower).toMatchObject({
      distance: 3,
      motion: PathMotion.desired,
    });
    expect(authored?.components.DesiredPathPose).toBeUndefined();
    for (const entity of instance.roots) world.despawn(entity).unwrap();
    await context.fiber.dispose();
  }
});

it.each([
  ['null control', 'Path', { points: [null, 0, 0, 0, 0, 10] }],
  ['string control', 'Path', { points: ['0', 0, 0, 0, 0, 10] }],
  ['boolean control', 'Path', { points: [false, 0, 0, 0, 0, 10] }],
  ['Float32 overflow', 'Path', { points: [1e100, 0, 0, 0, 0, 10] }],
  ['short fixed up', 'Path', { up: [0, 1] }],
  ['long fixed up', 'Path', { up: [0, 1, 0, 0] }],
  ['fractional subdivisions', 'Path', { subdivisions: 2048.5 }],
  ['wrapped subdivisions', 'Path', { subdivisions: 4294969344 }],
  ['string speed', 'PathFollower', { speed: '2' }],
  ['null distance', 'PathFollower', { distance: null }],
  ['string pause', 'PathFollower', { paused: 'false' }],
] as const)('rejects %s in ordinary authored Scene JSON before storage coercion', async (_label, component, patch) => {
  const world = new World();
  const context = await createWorldContext(world, [pathPlugin(), renderComponentsPlugin()]);
  const source: SceneAsset = {
    kind: 'scene',
    entities: {
      rail: {
        components: {
          Path: { points: [0, 0, 0, 0, 0, 10], ...(component === 'Path' ? patch : {}) },
        },
      },
      follower: {
        components: {
          PathFollower: { path: 'rail', speed: 0, ...(component === 'PathFollower' ? patch : {}) },
        },
      },
    },
  };
  const handle = world.allocSharedRef(
    'SceneAsset',
    JSON.parse(JSON.stringify(source)) as SceneAsset,
  );
  const result = worldInstantiateSceneFlat(world, handle);
  try {
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Invalid authored values became valid component data');
    expect(result.error).toMatchObject({ code: 'asset-package-invalid', detail: { component } });
    expect(Array.from(world.query({ read: [PathFollower] }).unwrap())).toHaveLength(0);
  } finally {
    if (result.ok) for (const entity of result.value.roots) world.despawn(entity).unwrap();
    world.sharedRefs.release(handle).unwrap();
    await context.fiber.dispose();
  }
});

it('projects typed author controls by numeric value rather than reinterpreting their bytes', async () => {
  const world = new World();
  const context = await createWorldContext(world, [pathPlugin(), renderComponentsPlugin()]);
  const source: SceneAsset = {
    kind: 'scene',
    entities: {
      rail: {
        components: {
          Path: { points: new Float64Array([0, 0, 0, 0, 0, 10]), up: new Float64Array([0, 1, 0]) },
        },
      },
      follower: { components: { PathFollower: { path: 'rail', distance: 3, speed: 0 } } },
    },
  };
  const handle = world.allocSharedRef('SceneAsset', source);
  const instance = worldInstantiateSceneFlat(world, handle).unwrap();
  world.update(1 / 60).unwrap();
  const follower = Array.from(
    world.query({ read: [PathFollower] }).unwrap(),
    (row) => row.entity,
  )[0];
  if (follower === undefined) throw new Error('Typed-source follower absent');
  expect(Array.from(world.get(follower, GlobalTransform).unwrap().world).slice(12, 15)).toEqual([
    0, 0, 3,
  ]);
  for (const entity of instance.roots) world.despawn(entity).unwrap();
  world.sharedRefs.release(handle).unwrap();
  await context.fiber.dispose();
});
