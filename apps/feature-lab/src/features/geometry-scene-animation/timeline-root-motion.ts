import {
  AnimationPlayer,
  AnimationRootMotion,
  AnimationSet,
  AnimationTargetId,
  bindAnimationTargets,
  deriveAnimationTargetId,
  drainAnimationEvents,
} from '@forgeax/engine/animation';
import {
  AUDIO_ENGINE_RESOURCE_KEY,
  type AudioBackend,
  AudioSource,
  audioPlugin,
} from '@forgeax/engine/audio';
import { webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import { ChildOf, Transform } from '@forgeax/engine/scene';
import type { AnimationClip } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { makeWav } from '../audio/support/webaudio';
import { spawnAnimatedRig } from './support/animated-rig';
import { animationEvidence } from './support/animation-evidence';

const rootId = deriveAnimationTargetId(['Rig', 'Root']),
  upperId = deriveAnimationTargetId(['Rig', 'Upper']);
const audioGuid = '019e2cc6-0c86-79da-aa76-b0984c86d45c',
  childGuid = '019e2cc6-0c86-79da-aa76-b0984c86d45d';

export default defineFeature({
  title: 'Timeline events and loop-safe root motion',
  catalog: 'Animation timeline and root motion',
  kind: 'visual',
  appOptions: { gpuPassTiming: {}, plugins: [webAudioPlugin(), audioPlugin()] },
  summary:
    'Cyan travels one world unit across a clip seam. A method key bends its upper joint, an audio key publishes a Host play intent, and a sub-animation key bends the orange rig.',
  expect:
    'ON: cyan moves right without its root jumping, both upper joints bend, and all three keys arrive once. OFF: both rigs remain straight and no effects are dispatched.',
  setup({ world, app, hud }) {
    spawnStage(world, { eye: [0, 2, 12], target: [0, 1.3, 0] });
    const actor = world.spawn({ component: Transform, data: { pos: [-2.5, 0, 0] } }).unwrap();
    const rig = spawnAnimatedRig(world, 0, 1.4, [0.1, 0.8, 1, 1]),
      child = spawnAnimatedRig(world, 2.5, 1.4, [1, 0.45, 0.08, 1]);
    world.addComponent(rig[0], { component: ChildOf, data: { parent: actor } }).unwrap();
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId: rootId,
          property: 'translation',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0.15, 0, 2, 0.15, 0]),
            interpolation: 'LINEAR',
          },
        },
      ],
      events: [
        { time: 0, targetId: upperId, action: { kind: 'method', name: 'bend', args: [-0.9] } },
        {
          time: 0.05,
          targetId: upperId,
          action: { kind: 'audio', clip: audioGuid, fromPosition: 0.1 },
        },
        {
          time: 0.1,
          targetId: upperId,
          action: { kind: 'animation', clip: childGuid, fromPosition: 0.2 },
        },
      ],
    };
    const mainClip = world.allocSharedRef('AnimationClip', clip);
    const childClip = world.allocSharedRef('AnimationClip', {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId: upperId,
          property: 'rotation',
          sampler: {
            input: new Float32Array([0]),
            output: new Float32Array([0, 0, Math.sin(0.9 / 2), Math.cos(0.9 / 2)]),
            interpolation: 'STEP',
          },
        },
      ],
    });
    for (const joints of [rig, child]) {
      world
        .addComponent(joints[0], { component: AnimationTargetId, data: { value: rootId } })
        .unwrap();
      world
        .addComponent(joints[1], { component: AnimationTargetId, data: { value: upperId } })
        .unwrap();
      world
        .addComponent(joints[0], {
          component: AnimationPlayer,
          data:
            joints === rig ? { clips: [mainClip], times: [0.75], speeds: [1], weights: [1] } : {},
        })
        .unwrap();
      bindAnimationTargets(world, joints[0], [joints[0], joints[1]]).unwrap();
    }
    world
      .addComponent(rig[0], { component: AnimationRootMotion, data: { targetId: rootId } })
      .unwrap();
    const audio = world.allocSharedRef('AudioClipAsset', {
      kind: 'audio',
      sourceKey: 'timeline-click',
      bytes: makeWav(440, 1),
    });
    const sound = world
      .spawn({
        component: AudioSource,
        data: { clip: audio, playing: false, loop: true, volume: 0 },
      })
      .unwrap();
    const backend = world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);
    let enabled = true,
      remaining = 0.5,
      cpuMs = 0;
    const actions: string[] = [];
    const reset = (on: boolean) => {
      enabled = on;
      remaining = on ? 0.5 : 0;
      actions.length = 0;
      world.set(actor, Transform, { pos: [-2.5, 0, 0] }).unwrap();
      world.set(rig[0], AnimationPlayer, { times: [0.75], speeds: [0] }).unwrap();
      world
        .set(rig[0], AnimationRootMotion, {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          accumulatedPosition: [0, 0, 0],
          accumulatedRotation: [0, 0, 0, 1],
        })
        .unwrap();
      for (const joints of [rig, child])
        world.set(joints[1], Transform, { quat: [0, 0, 0, 1] }).unwrap();
      world
        .set(child[0], AnimationPlayer, { clips: [], times: [], speeds: [], weights: [] })
        .unwrap();
      world.set(sound, AudioSource, { playing: false }).unwrap();
    };
    reset(true);
    animationEvidence(
      app,
      () => cpuMs,
      () => enabled,
    );
    world
      .addSystems(Update, AnimationSet, [
        defineSystem({
          name: 'timelineDemoControl',
          queries: [],
          before: ['advanceAnimationPlayer'],
          fn() {
            const dt = world.getResource(Time).delta;
            const step = Math.min(dt, remaining);
            remaining -= step;
            world.set(rig[0], AnimationPlayer, { speeds: [dt > 0 ? step / dt : 0] }).unwrap();
          },
        }),
        defineSystem({
          name: 'timelineDemoConsume',
          queries: [],
          after: ['advanceAnimationPlayer'],
          before: ['propagateTransforms'],
          fn() {
            const start = performance.now();
            const motion = world.get(rig[0], AnimationRootMotion).unwrap();
            const pos = world.get(actor, Transform).unwrap().pos;
            world
              .set(actor, Transform, { pos: [(pos[0] ?? 0) + (motion.position[0] ?? 0), 0, 0] })
              .unwrap();
            for (const event of drainAnimationEvents(world, rig[0])) {
              actions.push(event.action.kind);
              switch (event.action.kind) {
                case 'method':
                  world
                    .set(rig[1], Transform, {
                      quat: [0, 0, Math.sin(-0.9 / 2), Math.cos(-0.9 / 2)],
                    })
                    .unwrap();
                  break;
                case 'audio':
                  world
                    .set(sound, AudioSource, {
                      playing: event.action.clip !== null,
                      fromPosition: event.action.fromPosition,
                    })
                    .unwrap();
                  break;
                case 'animation':
                  world
                    .set(child[0], AnimationPlayer, {
                      clips: [childClip],
                      times: [event.action.fromPosition],
                      speeds: [0],
                      weights: [1],
                    })
                    .unwrap();
                  break;
              }
            }
            cpuMs = performance.now() - start;
            hud.status(
              `Travel ${Number(motion.accumulatedPosition[0]).toFixed(3)} m · keys ${actions.join(', ') || 'none'} · Host audio sources ${backend.getActiveSourceCount()}`,
            );
          },
        }),
      ])
      .unwrap();
    return {
      toggle: reset,
      checks() {
        const checks = new CheckList();
        checks.near(
          'loop-safe travel',
          Number(world.get(actor, Transform).unwrap().pos[0]),
          enabled ? -1.5 : -2.5,
          1e-4,
        );
        checks.near(
          'root remains in place',
          Number(world.get(rig[0], Transform).unwrap().pos[0]),
          0,
        );
        checks.equal(
          'ordered typed effects',
          actions,
          enabled ? ['method', 'audio', 'animation'] : [],
        );
        checks.near(
          'method bent upper joint',
          Number(world.get(rig[1], Transform).unwrap().quat[2]),
          enabled ? Math.sin(-0.9 / 2) : 0,
        );
        checks.near(
          'child clip bent orange upper joint',
          Number(world.get(child[1], Transform).unwrap().quat[2]),
          enabled ? Math.sin(0.9 / 2) : 0,
        );
        checks.equal(
          'decoded Host AudioBufferSource',
          backend.getActiveSourceCount(),
          enabled ? 1 : 0,
        );
        checks.equal('Host audio decode succeeded', backend.getState().lastError, null);
        return checks.items;
      },
    };
  },
});
