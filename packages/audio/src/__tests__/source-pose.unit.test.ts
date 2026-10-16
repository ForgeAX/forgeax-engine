import { World } from '@forgeax/engine-ecs';
import { GlobalTransform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { type AudioIntent, AudioSource, audioTickSystem, createAudioIntentBackend } from '../index';

it('plays at the propagated source position, then publishes only changed poses', () => {
  const world = new World();
  const clip = world.allocSharedRef('AudioClipAsset', {
    kind: 'audio',
    sourceKey: 'spatial',
    bytes: Uint8Array.of(1),
  });
  const matrix = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
  const entity = world
    .spawn(
      { component: AudioSource, data: { clip, playing: true, spatialBlend: 1 } },
      { component: GlobalTransform, data: { world: matrix } },
    )
    .unwrap();
  const intents: AudioIntent[] = [];
  const backend = createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
  audioTickSystem(world, backend);
  expect(intents[0]).toMatchObject({
    kind: 'play',
    options: {
      sourcePose: {
        positionX: 5,
        positionY: 6,
        positionZ: 7,
        forwardX: -0,
        forwardY: -0,
        forwardZ: -1,
      },
    },
  });
  audioTickSystem(world, backend);
  expect(intents).toHaveLength(1);
  matrix[12] = -8;
  world.set(entity, GlobalTransform, { world: matrix }).unwrap();
  audioTickSystem(world, backend);
  expect(intents[1]).toMatchObject({
    kind: 'set-source-pose',
    entityId: entity,
    pose: { positionX: -8 },
  });
  world.despawn(entity).unwrap();
  audioTickSystem(world, backend);
  expect(intents.map((intent) => intent.kind)).toEqual(['play', 'set-source-pose', 'stop']);
});

import { createWorldContext } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import { audioBackendPlugin, audioPlugin, sourcePoseFromWorldMatrix } from '../index';

it('syncs the current parented pose after scene propagation in the same Update', async () => {
  const world = new World();
  const intents: AudioIntent[] = [];
  const backend = createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
  const ctx = await createWorldContext(world, [
    audioBackendPlugin(backend),
    audioPlugin(),
    scenePlugin(),
  ]);
  try {
    const clip = world.allocSharedRef('AudioClipAsset', {
      kind: 'audio',
      sourceKey: 'parented',
      bytes: Uint8Array.of(1),
    });
    const parent = world
      .spawn({ component: Transform, data: { pos: [10, 0, 0], scale: [2, 3, 4] } })
      .unwrap();
    const source = world
      .spawn(
        { component: Transform, data: { pos: [1, 0, 0] } },
        { component: ChildOf, data: { parent } },
        { component: AudioSource, data: { clip, playing: true, spatialBlend: 1 } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(intents[0]).toMatchObject({
      kind: 'play',
      options: { sourcePose: { positionX: 12, forwardZ: -1 } },
    });
    world.set(parent, Transform, { pos: [-10, 0, 0] }).unwrap();
    world.set(source, AudioSource, { paused: true }).unwrap();
    world.update(1 / 60).unwrap();
    expect(intents[1]).toMatchObject({ kind: 'set-source-pose', pose: { positionX: -8 } });
    expect(intents[2]).toMatchObject({ kind: 'set-paused', paused: true });
    world.update(1 / 60).unwrap();
    expect(intents).toHaveLength(3);
  } finally {
    await ctx.fiber.dispose();
  }
});

it('keeps 2D sources pose-free and resets a removed spatial transform to the origin', () => {
  const world = new World();
  const clip = world.allocSharedRef('AudioClipAsset', {
    kind: 'audio',
    sourceKey: 'optional',
    bytes: Uint8Array.of(1),
  });
  const twoD = world.spawn({ component: AudioSource, data: { clip, playing: true } }).unwrap();
  const spatial = world
    .spawn(
      { component: AudioSource, data: { clip, playing: true, spatialBlend: 1 } },
      {
        component: GlobalTransform,
        data: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1]) },
      },
    )
    .unwrap();
  const intents: AudioIntent[] = [];
  const backend = createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
  audioTickSystem(world, backend);
  expect(intents.find((i) => i.kind === 'play' && i.entityId === twoD)).not.toHaveProperty(
    'options.sourcePose',
  );
  world.removeComponent(spatial, GlobalTransform).unwrap();
  audioTickSystem(world, backend);
  expect(intents.at(-1)).toMatchObject({
    kind: 'set-source-pose',
    pose: { positionX: 0, forwardZ: -1 },
  });
  expect(sourcePoseFromWorldMatrix(new Float32Array(16))).toMatchObject({ forwardZ: -1 });
});

it('normalizes a rotated emitter direction independently of nonuniform scale', () => {
  const matrix = new Float32Array([0, 0, -2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 5, 6, 7, 1]);
  expect(sourcePoseFromWorldMatrix(matrix)).toEqual({
    positionX: 5,
    positionY: 6,
    positionZ: 7,
    forwardX: -1,
    forwardY: -0,
    forwardZ: -0,
  });
});
