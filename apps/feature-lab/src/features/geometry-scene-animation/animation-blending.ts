import {
  AnimationPlayer,
  AnimationSet,
  AnimationTargetId,
  bindAnimationTargets,
  createBlendSpace1D,
  createBlendSpace2D,
  defineAnimationMask,
  deriveAnimationTargetId,
} from '@forgeax/engine/animation';
import { defineSystem, Update } from '@forgeax/engine/ecs';
import { Transform } from '@forgeax/engine/scene';
import type { AnimationClip } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { spawnAnimatedRig } from './support/animated-rig';
import { animationEvidence } from './support/animation-evidence';

const rootId = deriveAnimationTargetId(['Rig', 'Root']);
const upperId = deriveAnimationTargetId(['Rig', 'Upper']);
const angles = [-0.9, 0.9, -1.2];
function pose(root: number, upper: number): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 1,
    channels: (
      [
        [rootId, root],
        [upperId, upper],
      ] as const
    ).map(([targetId, angle]) => ({
      targetId,
      property: 'rotation' as const,
      sampler: {
        input: new Float32Array([0]),
        output: new Float32Array([0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]),
        interpolation: 'STEP' as const,
      },
    })),
  };
}
function blendedAngle(values: readonly number[], weights: ArrayLike<number>): number {
  let z = 0,
    w = 0;
  for (let i = 0; i < values.length; i++) {
    z += Math.sin(Number(values[i]) / 2) * Number(weights[i]);
    w += Math.cos(Number(values[i]) / 2) * Number(weights[i]);
  }
  return 2 * Math.atan2(z, w);
}

export default defineFeature({
  title: 'Code-driven BlendSpace and target masks',
  catalog: 'Code-driven animation blending',
  kind: 'visual',
  appOptions: { gpuPassTiming: {} },
  summary:
    'An ordinary TypeScript Update system drives cyan 1D and orange 2D blend weights. The green rig combines two full-body clips with a reusable upper-joint mask.',
  expect:
    'ON: cyan blends at speed 0.75, orange blends at (0.25, 0.5), and the green overlay bends only the upper joint. OFF: cyan/orange use their first sample, and the green overlay affects the lower joint too.',
  setup({ world, app, hud }) {
    spawnStage(world, { eye: [0.4, 2, 12], target: [0.4, 1.3, 0] });
    const rigs = [
      spawnAnimatedRig(world, -2.7, 1.4, [0.1, 0.8, 1, 1]),
      spawnAnimatedRig(world, 0, 1.4, [1, 0.45, 0.08, 1]),
      spawnAnimatedRig(world, 2.7, 1.4, [0.55, 1, 0.25, 1]),
    ] as const;
    const baseClips = angles.map((angle) => world.allocSharedRef('AnimationClip', pose(0, angle)));
    const layeredClips = [pose(-0.2, -0.2), pose(0.9, -1.2)].map((clip) =>
      world.allocSharedRef('AnimationClip', clip),
    );
    for (let i = 0; i < rigs.length; i++) {
      const rig = rigs[i];
      if (rig === undefined) continue;
      world
        .addComponent(rig[0], { component: AnimationTargetId, data: { value: rootId } })
        .unwrap();
      world
        .addComponent(rig[1], { component: AnimationTargetId, data: { value: upperId } })
        .unwrap();
      const clips = i === 2 ? layeredClips : i === 0 ? baseClips.slice(0, 2) : baseClips;
      world
        .addComponent(rig[0], {
          component: AnimationPlayer,
          data: {
            clips,
            times: clips.map(() => 0),
            speeds: clips.map(() => 0),
            weights: clips.map(() => 1),
            paused: true,
          },
        })
        .unwrap();
      bindAnimationTargets(world, rig[0], [rig[0], rig[1]]).unwrap();
    }
    const space1D = createBlendSpace1D([0, 1]).unwrap();
    const space2D = createBlendSpace2D({
      points: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      triangles: [[0, 1, 2]],
    }).unwrap();
    const weights1D = new Float32Array(2),
      weights2D = new Float32Array(3);
    const mask = world.allocSharedRef(
      'AnimationMask',
      defineAnimationMask([{ targetId: upperId, weight: 1 }]).unwrap(),
    );
    let enabled = true,
      cpuMs = 0;
    animationEvidence(
      app,
      () => cpuMs,
      () => enabled,
    );
    world
      .addSystems(Update, AnimationSet, [
        defineSystem({
          name: 'featureLabAnimationBlending',
          queries: [],
          before: ['advanceAnimationPlayer'],
          fn() {
            const start = performance.now();
            space1D.sample(weights1D, enabled ? 0.75 : 0).unwrap();
            space2D.sample(weights2D, enabled ? 0.25 : 0, enabled ? 0.5 : 0).unwrap();
            world.set(rigs[0][0], AnimationPlayer, { weights: weights1D }).unwrap();
            world.set(rigs[1][0], AnimationPlayer, { weights: weights2D }).unwrap();
            world
              .set(rigs[2][0], AnimationPlayer, {
                weights: [0.35, 0.65],
                masks: enabled ? [0, mask] : [],
              })
              .unwrap();
            cpuMs = performance.now() - start;
          },
        }),
      ])
      .unwrap();
    hud.status('Cyan: 1D speed · Orange: 2D direction · Green: upper-joint mask');
    return {
      toggle(on) {
        enabled = on;
      },
      checks() {
        const checks = new CheckList();
        const expected = [
          blendedAngle(angles.slice(0, 2), weights1D),
          blendedAngle(angles, weights2D),
          blendedAngle([-0.2, -1.2], [0.35, 0.65]),
        ];
        for (let i = 0; i < 3; i++) {
          const rig = rigs[i];
          if (rig === undefined) continue;
          checks.near(
            `rig ${i} upper-joint quaternion`,
            Number(world.get(rig[1], Transform).unwrap().quat[2]),
            Math.sin(Number(expected[i]) / 2),
          );
        }
        const layeredRoot = rigs[2][0];
        checks.near(
          'mask keeps the lower joint on the base clip',
          Number(world.get(layeredRoot, Transform).unwrap().quat[2]),
          Math.sin((enabled ? -0.2 : blendedAngle([-0.2, 0.9], [0.35, 0.65])) / 2),
        );
        checks.equal(
          '1D parameter weights',
          Array.from(weights1D),
          enabled ? [0.25, 0.75] : [1, 0],
        );
        checks.equal(
          '2D barycentric weights',
          Array.from(weights2D),
          enabled ? [0.25, 0.25, 0.5] : [1, 0, 0],
        );
        return checks.items;
      },
    };
  },
});
