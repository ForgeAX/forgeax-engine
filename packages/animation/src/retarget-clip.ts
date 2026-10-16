import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat, vec3 } from '@forgeax/engine-math';
import {
  type AnimationChannel,
  type AnimationClip,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { AnimationTargetId } from './animation-target';
import { compileRetarget, type SkeletonRetargetOptions } from './retarget-core';
import { sampleChannel } from './sample-channel';
import { type SkeletonPose, solverFailure } from './skeleton-pose';
import { AnimationBindingError, type AnimationError } from './solver-errors';
import { isAnimationTargetId } from './target-id';

/** Bake an ordinary clip without changing any World pose, player clock or asset. */
export function retargetAnimationClip(
  world: World,
  options: SkeletonRetargetOptions & { readonly clip: AnimationClip; readonly fps: number },
): Result<AnimationClip, AnimationError> {
  try {
    const { clip, fps } = options;
    const fail = (reason: string): never => {
      throw new AnimationBindingError('animation-retarget-clip-invalid', { reason });
    };
    if (
      clip.kind !== 'animation-clip' ||
      !Number.isFinite(clip.duration) ||
      clip.duration < 0 ||
      !Number.isFinite(fps) ||
      fps <= 0 ||
      fps > 1000 ||
      !Array.isArray(clip.channels)
    )
      fail('requires a finite nonnegative clip duration and fps in (0,1000]');
    const compiled = compileRetarget(world, options);
    const sourceIds = new Map<string, number>();
    for (let i = 0; i < compiled.source.entities.length; i++) {
      const id = world.get(compiled.source.entities[i] as EntityHandle, AnimationTargetId);
      if (!id.ok) continue;
      if (!isAnimationTargetId(id.value.value) || sourceIds.has(id.value.value))
        fail('source pose requires unique valid AnimationTargetId values');
      sourceIds.set(id.value.value, i);
    }
    const targetIds = compiled.targetIndices.map((index) => {
      const id = world.get(compiled.target.entities[index] as EntityHandle, AnimationTargetId);
      if (!id.ok || !isAnimationTargetId(id.value.value))
        return fail('every mapped target requires a valid AnimationTargetId');
      return id.value.value;
    });
    if (new Set(targetIds).size !== targetIds.length) fail('mapped target IDs must be unique');
    const frameCount = Math.ceil(clip.duration * fps) + 1;
    if (!Number.isSafeInteger(frameCount) || frameCount > 65536) fail('bake exceeds 65536 samples');
    const times = new Set<number>();
    for (let i = 0; i < frameCount; i++) times.add(Math.fround(Math.min(i / fps, clip.duration)));
    const seen = new Set<string>();
    let interpolation: 'LINEAR' | 'STEP' | undefined;
    const channels = clip.channels.map((channel) => {
      if (
        channel.property !== 'translation' &&
        channel.property !== 'rotation' &&
        channel.property !== 'scale'
      )
        return fail('skeletal bake accepts only TRS channels');
      const index = sourceIds.get(channel.targetId);
      const key = `${channel.targetId}:${channel.property}`;
      if (index === undefined || seen.has(key))
        fail('source channels require explicit unique pose targets');
      seen.add(key);
      const sampler = channel.sampler;
      const size = channel.property === 'rotation' ? 4 : 3;
      const cubic = sampler.interpolation === 'CUBICSPLINE';
      const keyWidth = size * (cubic ? 3 : 1);
      if (
        !(sampler.input instanceof Float32Array) ||
        !(sampler.output instanceof Float32Array) ||
        sampler.input.length === 0 ||
        sampler.output.length !== sampler.input.length * keyWidth ||
        (sampler.interpolation !== 'LINEAR' && sampler.interpolation !== 'STEP' && !cubic)
      )
        fail('invalid skeletal sampler');
      const outputInterpolation = sampler.interpolation === 'STEP' ? 'STEP' : 'LINEAR';
      if (interpolation !== undefined && interpolation !== outputInterpolation)
        fail(
          'mixed STEP/smooth bake cannot represent discontinuities with one output interpolation',
        );
      interpolation = outputInterpolation;
      for (let i = 0; i < sampler.input.length; i++) {
        const time = sampler.input[i] as number;
        if (
          !Number.isFinite(time) ||
          time < 0 ||
          time > Math.fround(clip.duration) ||
          (i > 0 && time <= (sampler.input[i - 1] as number))
        )
          fail('invalid sample times');
        times.add(time);
        for (let j = 0; j < keyWidth; j++)
          if (!Number.isFinite(sampler.output[i * keyWidth + j])) fail('nonfinite sample value');
        const offset = i * keyWidth + (cubic ? size : 0);
        if (channel.property === 'rotation') {
          const norm = Math.hypot(...sampler.output.subarray(offset, offset + size));
          if (Math.abs(norm - 1) > 1e-3) fail('rotation keys must be unit quaternions');
        }
        if (channel.property === 'scale') {
          const x = sampler.output[offset] as number;
          if (
            x <= 0 ||
            Math.abs(x - (sampler.output[offset + 1] as number)) > 1e-4 ||
            Math.abs(x - (sampler.output[offset + 2] as number)) > 1e-4
          )
            fail('scale keys require positive uniform scales');
        }
      }
      return { channel, index: index as number };
    });
    const input = Float32Array.from([...times].sort((a, b) => a - b));
    if (input.length > 65536 || input.length * targetIds.length * 10 > 16777216)
      fail('bake exceeds 65536 samples or 16777216 output scalars');
    for (let i = 1; i < input.length; i++)
      if ((input[i] as number) <= (input[i - 1] as number))
        fail('times collapse at Float32 precision');
    const snapshot = (pose: SkeletonPose) => ({
      positions: pose.positions.map((p) => vec3.clone(p)),
      rotations: pose.rotations.map((q) => quat.clone(q)),
      scales: pose.scales.map((s) => vec3.clone(s)),
    });
    const sourceRest = snapshot(compiled.source);
    const targetRest = snapshot(compiled.target);
    const restore = (pose: SkeletonPose, rest: ReturnType<typeof snapshot>) => {
      for (let i = 0; i < pose.entities.length; i++) {
        pose.positions[i]?.set(rest.positions[i] as Float32Array);
        pose.rotations[i]?.set(rest.rotations[i] as Float32Array);
        pose.scales[i]?.set(rest.scales[i] as Float32Array);
      }
    };
    const output: AnimationChannel[] = [];
    for (const targetId of targetIds)
      for (const property of ['translation', 'rotation', 'scale'] as const)
        output.push({
          targetId,
          property,
          sampler: {
            input,
            output: new Float32Array(input.length * (property === 'rotation' ? 4 : 3)),
            interpolation: interpolation ?? 'LINEAR',
          },
        });
    for (let sample = 0; sample < input.length; sample++) {
      restore(compiled.source, sourceRest);
      restore(compiled.target, targetRest);
      for (const { channel, index } of channels) {
        const value = sampleChannel(channel.sampler, input[sample] as number, channel.property);
        const arrays =
          channel.property === 'rotation'
            ? compiled.source.rotations
            : channel.property === 'translation'
              ? compiled.source.positions
              : compiled.source.scales;
        arrays[index]?.set(value as number[]);
      }
      compiled.source.update(0);
      compiled.source.validate();
      compiled.target.update(0);
      compiled.transfer(1);
      compiled.target.validate();
      for (let i = 0; i < compiled.targetIndices.length; i++) {
        const index = compiled.targetIndices[i] as number;
        const values = [
          compiled.target.positions[index],
          compiled.target.rotations[index],
          compiled.target.scales[index],
        ];
        for (let property = 0; property < 3; property++) {
          const value = values[property] as Float32Array;
          const channel = output[i * 3 + property] as AnimationChannel;
          (channel.sampler.output as Float32Array).set(value, sample * value.length);
        }
      }
    }
    return ok({ kind: 'animation-clip', duration: clip.duration, channels: output });
  } catch (failure) {
    return err(solverFailure(failure));
  }
}
