import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
  deriveAnimationTargetId,
} from '@forgeax/engine/animation';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { World } from '@forgeax/engine/ecs';
import type { AnimationClip } from '@forgeax/engine/types';
import { spawnAnimatedRig } from './animated-rig';

/** One actual Skin and one existing player; the default App profile owns playback. */
export function skeletalMotionRig(
  world: World,
  x: number,
  color: readonly [number, number, number, number],
) {
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');

  const joints = spawnAnimatedRig(world, x, 1, color);
  const targets = ['Root', 'Middle', 'End'].map((name) =>
    deriveAnimationTargetId(['MotionRig', name]),
  );
  for (const [i, joint] of joints.entries()) {
    const target = targets[i];
    if (target === undefined) throw new Error('authored joint target missing');
    world.addComponent(joint, { component: AnimationTargetId, data: { value: target } }).unwrap();
  }
  const rootTarget = targets[0];
  if (rootTarget === undefined) throw new Error('authored root target missing');
  const clip: AnimationClip = {
    kind: 'animation-clip',
    duration: 2,
    channels: [
      {
        targetId: rootTarget,
        property: 'rotation',
        sampler: {
          input: new Float32Array([0, 0.5, 1, 1.5, 2]),
          output: new Float32Array([
            0,
            0,
            0,
            1,
            0,
            0,
            Math.sin(0.3),
            Math.cos(0.3),
            0,
            0,
            0,
            1,
            0,
            0,
            -Math.sin(0.3),
            Math.cos(0.3),
            0,
            0,
            0,
            1,
          ]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
  world
    .addComponent(joints[0], {
      component: AnimationPlayer,
      data: {
        clips: [sceneAssets.create(clip).unwrap()],
        times: [0],
        weights: [1],
        speeds: [1],
      },
    })
    .unwrap();
  bindAnimationTargets(world, joints[0], joints).unwrap();
  return { player: joints[0], joints, targets };
}
