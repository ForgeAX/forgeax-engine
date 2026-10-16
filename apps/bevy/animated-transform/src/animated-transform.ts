import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
  defineAnimationGraph,
  deriveAnimationTargetId,
} from '@forgeax/engine-animation';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue, Handle } from '@forgeax/engine-types';

export type AnimatedTransformInstanceKey = 'direct' | 'graph';

export const TRANSFORM_CLIP_GUID = 'demo/animated-transform/clip';

export interface AnimatedTransformInstance {
  readonly key: AnimatedTransformInstanceKey;
  readonly player: EntityHandle;
  readonly planet: EntityHandle;
  readonly orbitController: EntityHandle;
  readonly satellite: EntityHandle;
  readonly targets: readonly EntityHandle[];
}

export interface AnimatedTransformDemo {
  readonly instances: readonly [AnimatedTransformInstance, AnimatedTransformInstance];
}

const PLANET_ID = deriveAnimationTargetId(['Planet']);
const ORBIT_ID = deriveAnimationTargetId(['Planet', 'OrbitController']);
const SATELLITE_ID = deriveAnimationTargetId(['Planet', 'OrbitController', 'Satellite']);

export function transformClip(): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 1,
    channels: [
      {
        targetId: PLANET_ID,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 0, 4, 0]),
          interpolation: 'LINEAR',
        },
      },
      {
        targetId: ORBIT_ID,
        property: 'rotation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0]),
          interpolation: 'LINEAR',
        },
      },
      {
        targetId: SATELLITE_ID,
        property: 'scale',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([1, 1, 1, 2, 2, 2]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
}

function spawnNamed(
  world: World,
  name: string,
  parent: EntityHandle | undefined,
  pos: readonly [number, number, number] = [0, 0, 0],
): EntityHandle {
  const entity = world.spawn({ component: Transform, data: { pos } }).unwrap() as EntityHandle;
  world.addComponent(entity, { component: Name, data: { value: name } }).unwrap();
  if (parent !== undefined) {
    world.addComponent(entity, { component: ChildOf, data: { parent } }).unwrap();
  }
  return entity;
}

function addTargetId(world: World, entity: EntityHandle, value: AnimationTargetIdValue): void {
  world.addComponent(entity, { component: AnimationTargetId, data: { value } }).unwrap();
}

function spawnInstance(
  world: World,
  key: AnimatedTransformInstanceKey,
  x: number,
  clipHandle: Handle<'AnimationClip', 'shared'>,
): AnimatedTransformInstance {
  const player = spawnNamed(world, `${key}-player`, undefined, [x, 0, 0]);
  if (key === 'direct') {
    world
      .addComponent(player, {
        component: AnimationPlayer,
        data: {
          clips: [clipHandle],
          times: [0],
          weights: [1],
          speeds: [1],
          paused: false,
          looping: true,
        },
      })
      .unwrap();
  } else {
    const graph = defineAnimationGraph((builder) => builder.clip(TRANSFORM_CLIP_GUID));
    if (!graph.ok) throw graph.error;
    const graphHandle = world.allocSharedRef('AnimationGraph', graph.value);
    world
      .addComponent(player, {
        component: AnimationPlayer,
        data: {
          graph: graphHandle,
          nodeTimes: [0],
          nodeWeights: [1],
          nodeSpeeds: [1],
          paused: false,
          looping: true,
        },
      })
      .unwrap();
  }

  const planet = spawnNamed(world, 'Planet', player);
  const orbitController = spawnNamed(world, 'OrbitController', planet);
  const satellite = spawnNamed(world, 'Satellite', orbitController, [2, 0, 0]);
  addTargetId(world, planet, PLANET_ID);
  addTargetId(world, orbitController, ORBIT_ID);
  addTargetId(world, satellite, SATELLITE_ID);
  const targets = [planet, orbitController, satellite] as const;
  const bound = bindAnimationTargets(world, player, targets);
  if (!bound.ok) throw bound.error;
  return { key, player, planet, orbitController, satellite, targets };
}

export function buildAnimatedTransformWorld(
  world: World,
  clip: AnimationClip = transformClip(),
): AnimatedTransformDemo {
  const clipHandle = world.allocSharedRef('AnimationClip', clip);
  return {
    instances: [
      spawnInstance(world, 'direct', -4, clipHandle),
      spawnInstance(world, 'graph', 4, clipHandle),
    ],
  };
}

function instanceFor(
  demo: AnimatedTransformDemo,
  key: AnimatedTransformInstanceKey,
): AnimatedTransformInstance {
  return key === 'direct' ? demo.instances[0] : demo.instances[1];
}

export function setAnimatedTransformPaused(
  world: World,
  demo: AnimatedTransformDemo,
  key: AnimatedTransformInstanceKey,
  paused: boolean,
): void {
  world.set(instanceFor(demo, key).player, AnimationPlayer, { paused }).unwrap();
}

export function setAnimatedTransformSpeed(
  world: World,
  demo: AnimatedTransformDemo,
  key: AnimatedTransformInstanceKey,
  speed: number,
): void {
  const player = instanceFor(demo, key).player;
  world
    .set(
      player,
      AnimationPlayer,
      key === 'direct' ? { speeds: [speed] } : { nodeSpeeds: [speed] },
    )
    .unwrap();
}

export function replayAnimatedTransform(
  world: World,
  demo: AnimatedTransformDemo,
  key: AnimatedTransformInstanceKey,
): void {
  const player = instanceFor(demo, key).player;
  world
    .set(player, AnimationPlayer, key === 'direct' ? { times: [0] } : { nodeTimes: [0] })
    .unwrap();
}
