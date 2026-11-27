import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
} from '../../../packages/animation/dist/index.mjs';
import {
  Name,
  Transform,
  worldDespawnScene,
  worldGetSceneInstanceState,
} from '../../../packages/scene/dist/index.mjs';
import { Skin } from '../../../packages/skinning/dist/index.mjs';
import { groundHeight, roadX } from './level-streaming-landscape.mjs';

const herdSites = [
  [1745, 27],
  [790, -39],
  [-790, 50],
];

function placeDeer(world, root, z, offset, heading) {
  const x = roadX(z) + offset;
  const y = groundHeight(x, z);
  world
    .set(root, Transform, {
      pos: [x, y, z],
      quat: [0, Math.sin(heading / 2), 0, Math.cos(heading / 2)],
    })
    .unwrap();
  return { x, y, z };
}

function spawnDeer(world, assets, scene, ordinal) {
  const group = Math.floor(ordinal / 3);
  const index = ordinal % 3;
  const [z, offset] = herdSites[group];
  const spec = { z: z + index * 4, offset: offset + 3 * index, walking: index !== 2 };
  const root = assets.instantiate(scene, world).unwrap();
  try {
    const members = [...worldGetSceneInstanceState(world, root).unwrap().bindings.values()];
    const player = members.find((entity) => world.hasComponent(entity, AnimationPlayer));
    const skin = members.find((entity) => world.hasComponent(entity, Skin));
    const joints = members.filter((entity) => world.hasComponent(entity, AnimationTargetId));
    const leg = joints.find(
      (entity) => world.get(entity, Name).unwrap().value === 'front-left-upper',
    );
    if (player === undefined || skin === undefined || leg === undefined)
      throw Error('Pine Basin deer requires an authored player, skin and foreleg');
    bindAnimationTargets(world, player, joints).unwrap();
    const jointCount = world.get(skin, Skin).unwrap().joints.length;
    if (jointCount === 0 || jointCount !== joints.length)
      throw Error('Pine Basin deer joint paths did not bind to its skeleton');
    world
      .set(player, AnimationPlayer, {
        times: [0.17 * index, 0.27 * group],
        weights: [Number(spec.walking), Number(!spec.walking)],
      })
      .unwrap();
    const position = placeDeer(world, root, spec.z, spec.offset, 0.7);
    return { ...spec, root, player, leg, jointCount, position };
  } catch (error) {
    worldDespawnScene(world, root).unwrap();
    throw error;
  }
}

export function createWildlife(world, assets, guid, onFailure) {
  const actors = [];
  const population = herdSites.length * 3;
  let started = false;
  let scene;
  let closed = false;
  let focused = false;
  let elapsed = 0;

  const releaseScene = () => {
    if (scene === undefined) return;
    assets.release(scene).unwrap();
    scene = undefined;
  };

  return {
    start() {
      if (started || closed) return;
      started = true;
      void assets
        .load(assets.parseGuid(guid), 'scene')
        .then((result) => {
          scene = result.unwrap();
          if (closed) releaseScene();
        })
        .catch((cause) => {
          if (!closed) onFailure(cause);
        });
    },
    update(dt) {
      if (scene !== undefined) {
        actors.push(spawnDeer(world, assets, scene, actors.length));
        if (actors.length === population) releaseScene();
      }
      elapsed += dt;
      for (const actor of actors) {
        if (!actor.walking || (actor === actors[0] && focused)) continue;
        const t = elapsed * 0.115 + actor.offset * 0.32;
        const z = actor.z + 11 * Math.sin(t);
        const offset = actor.offset + 5 * Math.cos(t);
        actor.position = placeDeer(
          world,
          actor.root,
          z,
          offset,
          Math.atan2(-5 * Math.sin(t), 11 * Math.cos(t)),
        );
      }
    },
    focus(enabled) {
      focused = enabled;
      return actors[0]?.position;
    },
    inspect() {
      const actor = actors[0];
      if (actor === undefined) return { count: 0 };
      return {
        count: actors.length,
        clips: [...world.get(actor.player, AnimationPlayer).unwrap().clips],
        times: [...world.get(actor.player, AnimationPlayer).unwrap().times],
        jointCount: actor.jointCount,
        foreleg: [...world.get(actor.leg, Transform).unwrap().quat],
      };
    },
    dispose() {
      closed = true;
      for (const actor of actors) worldDespawnScene(world, actor.root).unwrap();
      releaseScene();
    },
  };
}
