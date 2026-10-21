import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AnimationPlayer,
  AnimationTargetId,
  animationClipContribution,
  animationPlugin,
  bindAnimationTargets,
} from '@forgeax/engine-animation';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { importedSource } from '../../../import/src/__tests__/fixtures/runtime-import';
import { initFbxWasm, parseFbxToObject } from '../index';
import { type FbxRawAnimDoc, parseAnimationClips } from '../parse-animation-clip';

interface SourceOracle {
  name: string;
  nodes: { path: string; samples: number[][] }[];
}

// Independent ufbx_evaluate_transform evaluations at non-key times, frozen before runtime interpolation.
describe('FBX source curves through JSON Cook and ordinary ECS playback', () => {
  it.each([
    'maya-interpolation',
    'maya-spin',
  ])('%s preserves evaluated source poses', async (name) => {
    await initFbxWasm();
    const path = fileURLToPath(new URL(`./fixtures/animation-fidelity/${name}`, import.meta.url));
    const raw = parseFbxToObject(new Uint8Array(readFileSync(`${path}.fbx`))) as FbxRawAnimDoc;
    const oracles = JSON.parse(readFileSync(`${path}.oracle.json`, 'utf8')) as SourceOracle[];
    // Published Float32 timelines from the pre-optimization native producer at 918fec534.
    // This gate protects all source knots and values while evaluation/encoding cost changes.
    const timeline = createHash('sha256');
    for (const clip of raw.clips ?? []) {
      timeline.update(JSON.stringify([clip.name, clip.duration]));
      for (const channel of clip.channels) {
        timeline.update(JSON.stringify([channel.targetNode, channel.property]));
        for (const values of [channel.keyTimes ?? [], channel.keyValues ?? []]) {
          const data = Float32Array.from(values);
          timeline.update(String(data.length));
          timeline.update(new Uint8Array(data.buffer));
        }
      }
    }
    expect(timeline.digest('hex')).toBe(
      name === 'maya-interpolation'
        ? 'b237710a00e3cc01f5bc9222754eb54167e8f9edfdf8c9288076c735f8b181b9'
        : 'f4fa82cdf0491d7b3833132f2fbcbea2cde0f83751daa1aedf51b6e9e0446ea0',
    );
    const pods = parseAnimationClips(raw);
    for (const pod of pods) {
      const cooked = JSON.parse(
        JSON.stringify(pod, (_key, value) =>
          ArrayBuffer.isView(value) ? Array.from(value as Float32Array) : value,
        ),
      );
      const guid = '019d0000-0000-7000-8000-000000000111';
      const { assets } = importedSource({
        assets: [
          {
            guid,
            kind: 'animation-clip',
            payload: { ...cooked, kind: 'animation-clip' },
            refs: [],
            artifacts: {},
          },
        ],
      });
      assets.installDecoder(animationClipContribution.kind, animationClipContribution.decoder);
      const clipHandle = (await assets.load(guid, 'animation-clip')).unwrap();
      const clip = assets.read(clipHandle).unwrap();
      const reference = oracles.find((row) => row.name === pod.name);
      if (reference === undefined) throw new Error('missing source oracle');
      const source = raw.clips?.find((row) => row.name === pod.name);
      if (source === undefined) throw new Error('missing native clip');
      const world = new World({ assets });
      await createWorldContext(world, [scenePlugin(), animationPlugin()]);
      const player = world.spawn({ component: Transform, data: {} }).unwrap();
      world
        .addComponent(player, {
          component: AnimationPlayer,
          data: {
            clips: [clipHandle],
            times: [0],
            weights: [1],
            speeds: [0],
            paused: true,
            looping: false,
          },
        })
        .unwrap();
      const paths = new Map<string, typeof player>();
      for (const [index, channel] of clip.channels.entries()) {
        const native = source.channels?.[index];
        if (native === undefined) throw new Error('missing source channel');
        if (paths.has(native.targetNode)) continue;
        const target = world
          .spawn(
            { component: Transform, data: {} },
            { component: ChildOf, data: { parent: player } },
            { component: AnimationTargetId, data: { value: channel.targetId } },
          )
          .unwrap();
        paths.set(native.targetNode, target);
      }
      bindAnimationTargets(world, player, [...paths.values()]).unwrap();
      for (const node of reference.nodes) {
        const target = paths.get(node.path);
        if (target === undefined) continue;
        const channels = source.channels.filter((channel) => channel.targetNode === node.path);
        for (const sample of node.samples) {
          const time = sample[0];
          if (time === undefined) throw new Error('missing oracle time');
          world.set(player, AnimationPlayer, { times: [time] }).unwrap();
          world.update(0).unwrap();
          const pose = world.get(target, Transform).unwrap();
          for (const channel of channels) {
            if (channel.property === 'rotation') {
              const dot = Math.abs(
                [...pose.quat].reduce((sum, value, c) => sum + value * (sample[4 + c] ?? NaN), 0),
              );
              expect((2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI).toBeLessThanOrEqual(0.1);
            } else if (channel.property !== 'weights') {
              const actual = channel.property === 'translation' ? pose.pos : pose.scale;
              const offset = channel.property === 'translation' ? 1 : 8;
              const error = Math.hypot(
                ...[...actual].map((value, c) => value - (sample[offset + c] ?? NaN)),
              );
              expect(error).toBeLessThanOrEqual(channel.property === 'translation' ? 1e-3 : 1e-4);
            }
          }
        }
      }
    }
  });
});
