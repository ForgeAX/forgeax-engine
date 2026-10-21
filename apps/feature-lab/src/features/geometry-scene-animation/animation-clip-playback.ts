import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
  defineAnimationGraph,
  deriveAnimationTargetId,
} from '@forgeax/engine/animation';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { quat } from '@forgeax/engine/math';
import { Name } from '@forgeax/engine/scene';
import type { AnimationClip } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

const TARGET = deriveAnimationTargetId(['Mover']);

function clip(): AnimationClip {
  const turned = Array.from(quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 4));
  return {
    kind: 'animation-clip',
    duration: 2,
    channels: [
      {
        targetId: TARGET,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 2]),
          output: new Float32Array([-2, 0.6, 0, 2, 0.6, 0]),
          interpolation: 'LINEAR',
        },
      },
      {
        targetId: TARGET,
        property: 'rotation',
        sampler: {
          input: new Float32Array([0, 2]),
          output: new Float32Array([0, 0, 0, 1, ...turned]),
          interpolation: 'LINEAR',
        },
      },
      {
        targetId: TARGET,
        property: 'scale',
        sampler: {
          input: new Float32Array([0, 2]),
          output: new Float32Array([0.6, 0.6, 0.6, 1.2, 1.2, 1.2]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
}

export default defineFeature({
  title: 'AnimationClip playback',
  catalog: 'AnimationClip playback',
  kind: 'visual',
  summary:
    'A catalogued AnimationClip drives translation/rotation/scale of a bound target through an AnimationPlayer graph; Transform propagation resolves the rendered pose.',
  expect:
    'ON: the player is paused at t=2 - the orange cube sits large and turned 45 degrees on the right. OFF: paused at t=0 - a small unrotated cube on the left.',
  setup({ world, hud }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    const sceneAssets = world.assets;
    if (!(sceneAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    spawnStage(world, { eye: [0, 1.8, 6.5], target: [0, 0.6, 0] });
    const clipHandle = sceneAssets.create(clip()).unwrap();
    const graph = defineAnimationGraph((b) => b.clip(clipHandle));
    if (!graph.ok) {
      hud.status(`graph failed: ${graph.error.code}`);
      return {};
    }
    const mover: EntityHandle = spawnMesh(
      world,
      stageCube,
      standard(world, { baseColor: [1, 0.45, 0.1, 1] }),
      {},
      { component: Name, data: { value: 'Mover' } },
      { component: AnimationTargetId, data: { value: TARGET } },
      {
        component: AnimationPlayer,
        data: {
          graph: sceneAssets.create(graph.value).unwrap(),
          nodeTimes: [2],
          nodeWeights: [1],
          nodeSpeeds: [1],
          paused: true,
          looping: false,
        },
      },
    );
    const bound = bindAnimationTargets(world, mover, [mover]);
    if (!bound.ok) hud.status(`bind failed: ${bound.error.code}`);
    return {
      toggle(on) {
        world.set(mover, AnimationPlayer, { nodeTimes: [on ? 2 : 0] } as never);
      },
    };
  },
});
