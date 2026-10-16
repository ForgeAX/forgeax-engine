import {
  AnimationPlayer,
  AnimationSet,
  AnimationTargetId,
  bindAnimationTargets,
  createSkeletonRetargeter,
  deriveAnimationTargetId,
  retargetAnimationClip,
} from '@forgeax/engine/animation';
import { defineSystem, type EntityHandle, Update } from '@forgeax/engine/ecs';
import { Name, Transform } from '@forgeax/engine/scene';
import type { AnimationClip } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { effector, spawnAnimatedRig } from './support/animated-rig';
import { animationEvidence } from './support/animation-evidence';

export default defineFeature({
  title: 'Skeleton retargeting',
  catalog: 'Skeleton retargeting',
  kind: 'visual',
  appOptions: { gpuPassTiming: {} },
  summary:
    'The source AnimationPlayer pose is retargeted to a taller Skin through an explicit joint map and captured reference poses. Target bone lengths and placement stay intact. The green strip plays the baked ordinary clip through AnimationPlayer.',
  expect:
    'ON: the orange tall strip copies the cyan source bend, keeping 1.4 m bones against the source 0.9 m bones. The green strip matches the orange runtime target through baked playback. OFF: both targets stand straight while the source stays bent.',
  setup({ world, app }) {
    spawnStage(world, { eye: [0.4, 2, 12], target: [0.4, 1.3, 0] });
    const source = spawnAnimatedRig(world, -2.7, 0.9, [0.1, 0.8, 1, 1]);
    const target = spawnAnimatedRig(world, 0, 1.4, [1, 0.45, 0.08, 1]);
    const retargeter = createSkeletonRetargeter(world, {
      pairs: source.map((joint, i) => ({ source: joint, target: target[i] as EntityHandle })),
    }).unwrap();
    const targetId = deriveAnimationTargetId(['Source', 'Elbow']);
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId,
          property: 'rotation',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 0, 1, 0, 0, -Math.sin(0.55), Math.cos(0.55)]),
            interpolation: 'LINEAR',
          },
        },
      ],
    };
    world.addComponent(source[0], { component: Name, data: { value: 'Source' } }).unwrap();
    world.addComponent(source[1], { component: Name, data: { value: 'Elbow' } }).unwrap();
    world
      .addComponent(source[1], { component: AnimationTargetId, data: { value: targetId } })
      .unwrap();
    world
      .addComponent(source[0], {
        component: AnimationPlayer,
        data: {
          clips: [world.allocSharedRef('AnimationClip', clip)],
          times: [1],
          weights: [1],
          speeds: [0],
          paused: true,
          looping: false,
        },
      })
      .unwrap();
    bindAnimationTargets(world, source[0], [source[1]]).unwrap();
    const bakedJoints = spawnAnimatedRig(world, 2.7, 1.4, [0.55, 1, 0.25, 1]);
    for (let i = 0; i < 3; i++)
      world
        .addComponent(bakedJoints[i] as EntityHandle, {
          component: AnimationTargetId,
          data: { value: deriveAnimationTargetId(['Baked', String(i)]) },
        })
        .unwrap();
    const baked = retargetAnimationClip(world, {
      pairs: source.map((joint, i) => ({ source: joint, target: bakedJoints[i] as EntityHandle })),
      clip,
      fps: 60,
    }).unwrap();
    world
      .addComponent(bakedJoints[0], {
        component: AnimationPlayer,
        data: {
          clips: [world.allocSharedRef('AnimationClip', baked)],
          times: [1],
          weights: [1],
          speeds: [0],
          paused: true,
          looping: false,
        },
      })
      .unwrap();
    bindAnimationTargets(world, bakedJoints[0], bakedJoints).unwrap();
    let enabled = true;
    let cpuMs = 0;
    animationEvidence(
      app,
      () => cpuMs,
      () => enabled,
    );
    const system = defineSystem({
      name: 'featureLabRetarget',
      queries: [],
      after: ['advanceAnimationPlayer'],
      before: ['propagateTransforms'],
      fn() {
        for (const joint of target) world.set(joint, Transform, { quat: [0, 0, 0, 1] }).unwrap();
        const start = performance.now();
        if (enabled) retargeter.retarget().unwrap();
        else
          for (const joint of bakedJoints)
            world.set(joint, Transform, { quat: [0, 0, 0, 1] }).unwrap();
        cpuMs = performance.now() - start;
      },
    });
    world.addSystems(Update, AnimationSet, [system]).unwrap();
    return {
      toggle(on) {
        enabled = on;
      },
      checks() {
        const checks = new CheckList();
        checks.near(
          'target retains its longer bones',
          world.get(target[1], Transform).unwrap().pos[1] as number,
          1.4,
        );
        checks.near(
          'target mapped local rotation',
          world.get(target[1], Transform).unwrap().quat[2] as number,
          enabled ? -Math.sin(0.55) : 0,
        );
        const sourceTip = effector(world, source[2]);
        const targetTip = effector(world, target[2]);
        checks.near(
          'different proportions produce scaled displacement',
          targetTip[0],
          enabled ? (sourceTip[0] + 2.7) * (1.4 / 0.9) : 0,
          1e-4,
        );
        for (let i = 0; i < 3; i++) {
          const a = world.get(target[i] as EntityHandle, Transform).unwrap().quat;
          const b = world.get(bakedJoints[i] as EntityHandle, Transform).unwrap().quat;
          checks.ok(
            'runtime and baked pose agree',
            [...a].every((value, j) => Math.abs(value - (b[j] as number)) < 1e-5),
          );
        }
        const bakedTip = effector(world, bakedJoints[2]);
        checks.near(
          'baked playback uses the same propagated pose',
          bakedTip[0] - 2.7,
          targetTip[0],
          1e-4,
        );
        return checks.items;
      },
    };
  },
});
