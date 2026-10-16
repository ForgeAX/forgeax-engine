import {
  AnimationPlayer,
  AnimationTargetId,
  animationPlugin,
  bindAnimationTargets,
  defineAnimationGraph,
  deriveAnimationTargetId,
  describeAnimationGraph,
} from '@forgeax/engine/animation';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine/ecs';
import { ChildOf, Name, scenePlugin, Transform } from '@forgeax/engine/scene';
import type { AnimationClip } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const TARGET = deriveAnimationTargetId(['Root', 'Box']);

function translationClip(to: readonly [number, number, number]): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 1,
    channels: [
      {
        targetId: TARGET,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([...to, ...to]),
          interpolation: 'STEP',
        },
      },
    ],
  };
}

const CLIPS: Record<string, AnimationClip> = {
  'lab/clip-x': translationClip([4, 0, 0]),
  'lab/clip-y': translationClip([0, 4, 0]),
};

export default defineFeature({
  title: 'AnimationGraph blend evaluation',
  catalog: 'AnimationGraph',
  kind: 'headless',
  summary:
    'defineAnimationGraph builds a validated clip/blend/add DAG; AnimationPlayer drives it through per-node nodeTimes/nodeWeights, and describeAnimationGraph exposes indices that match those arrays.',
  expect:
    'All checks pass: blend(clipX, clipY) poses the target at (2,2,0), reweighting nodes to [1,0,1] yields (4,0,0), the description reports clip/clip/blend with root 2, and a negative weight is a structured error.',
  async run(checks) {
    const graph = defineAnimationGraph((b) =>
      b.blend([b.clip('lab/clip-x'), b.clip('lab/clip-y')]),
    );
    checks.ok('graph builds', graph.ok);
    if (!graph.ok) return;
    const desc = describeAnimationGraph(graph.value);
    checks.equal(
      'description nodes',
      desc.nodes.map((n) => [n.index, n.type, n.children]),
      [
        [0, 'clip', []],
        [1, 'clip', []],
        [2, 'blend', [0, 1]],
      ],
    );
    checks.equal('description root', desc.root, 2);

    const invalid = defineAnimationGraph((b) => b.clip('lab/clip-x', -1));
    checks.equal(
      'negative weight rejected',
      invalid.ok ? 'ok' : invalid.error.code,
      'animation-graph-node-weight-invalid',
    );

    const world = new World();
    await createWorldContext(world, [scenePlugin()]);
    await createWorldContext(world, [animationPlugin((guid) => CLIPS[guid])]);
    const player = world
      .spawn({ component: Transform, data: {} }, { component: Name, data: { value: 'Root' } })
      .unwrap() as EntityHandle;
    world
      .addComponent(player, {
        component: AnimationPlayer,
        data: {
          graph: world.allocSharedRef('AnimationGraph', graph.value),
          nodeTimes: [0, 0, 0],
          nodeWeights: [1, 1, 1],
          nodeSpeeds: [0, 0, 0],
          paused: true,
          looping: false,
        },
      })
      .unwrap();
    const box = world
      .spawn(
        { component: Transform, data: {} },
        { component: Name, data: { value: 'Box' } },
        { component: ChildOf, data: { parent: player } },
        { component: AnimationTargetId, data: { value: TARGET } },
      )
      .unwrap() as EntityHandle;
    const bound = bindAnimationTargets(world, player, [box]);
    checks.ok('bind succeeds', bound.ok, bound.ok ? undefined : bound.error.code);

    const pos = (): number[] =>
      Array.from(world.get(box, Transform).unwrap().pos, (v) => Math.round(v * 1000) / 1000);
    world.update(0);
    checks.equal('equal blend averages the clips', pos(), [2, 2, 0]);
    world.set(player, AnimationPlayer, { nodeWeights: [1, 0, 1] }).unwrap();
    world.update(0);
    checks.equal('zero weight removes clipY', pos(), [4, 0, 0]);
  },
});
