import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { AnimationPlaybackError } from './playback-errors';
import type { PlaybackInterval } from './playback-interval';
import { sampleChannel } from './sample-channel';
import { isAnimationTargetId } from './target-id';

/** Opt-in extraction; ordinary movement/physics owns applying the local delta. */
export const AnimationRootMotion = defineComponent('AnimationRootMotion', {
  targetId: { type: 'string' },
  position: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
  rotation: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
  accumulatedPosition: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
  accumulatedRotation: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
});

interface RigidPose {
  readonly p: number[];
  readonly q: number[];
}
const identity = (): RigidPose => ({ p: [0, 0, 0], q: [0, 0, 0, 1] });
function multiply(a: number[], b: number[]): number[] {
  const [x = 0, y = 0, z = 0, w = 1] = a,
    [X = 0, Y = 0, Z = 0, W = 1] = b;
  const q = [
    w * X + x * W + y * Z - z * Y,
    w * Y - x * Z + y * W + z * X,
    w * Z + x * Y - y * X + z * W,
    w * W - x * X - y * Y - z * Z,
  ];
  const length = Math.hypot(...q);
  return q.map((value) => value / length);
}
function rotate(q: number[], p: number[]): number[] {
  const [x = 0, y = 0, z = 0, w = 1] = q,
    [X = 0, Y = 0, Z = 0] = p;
  const tx = 2 * (y * Z - z * Y),
    ty = 2 * (z * X - x * Z),
    tz = 2 * (x * Y - y * X);
  return [X + w * tx + y * tz - z * ty, Y + w * ty + z * tx - x * tz, Z + w * tz + x * ty - y * tx];
}
function compose(a: RigidPose, b: RigidPose): RigidPose {
  return { p: rotate(a.q, b.p).map((v, i) => v + (a.p[i] ?? 0)), q: multiply(a.q, b.q) };
}
function inverse(a: RigidPose): RigidPose {
  const q = [-(a.q[0] ?? 0), -(a.q[1] ?? 0), -(a.q[2] ?? 0), a.q[3] ?? 1];
  return {
    p: rotate(
      q,
      a.p.map((v) => -v),
    ),
    q,
  };
}
function power(value: RigidPose, exponent: number): RigidPose {
  let base = exponent < 0 ? inverse(value) : value;
  let result = identity(),
    remaining = Math.abs(exponent);
  while (remaining > 0) {
    if (remaining % 2 === 1) result = compose(result, base);
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) base = compose(base, base);
  }
  return result;
}

interface RootCurve {
  readonly sample: (time: number) => RigidPose;
  readonly reference: RigidPose;
  readonly inverseReference: RigidPose;
  readonly cycle: RigidPose;
}
const rootCurves = new WeakMap<AnimationClip, Map<string, RootCurve>>();
function rootCurve(clip: AnimationClip, targetId: string): RootCurve {
  let targets = rootCurves.get(clip);
  const cached = targets?.get(targetId);
  if (cached !== undefined) return cached;
  const channels = clip.channels.filter(
    (channel) =>
      channel.targetId === targetId &&
      (channel.property === 'translation' || channel.property === 'rotation'),
  );
  if (
    channels.filter((c) => c.property === 'translation').length > 1 ||
    channels.filter((c) => c.property === 'rotation').length > 1
  ) {
    throw new AnimationPlaybackError('animation-root-motion-invalid', {
      reason: 'one root curve per rigid property required',
      targetId,
    });
  }
  const sample = (time: number): RigidPose => {
    let p = [0, 0, 0],
      q = [0, 0, 0, 1];
    for (const channel of channels) {
      if (channel.property === 'property') continue;
      const values = sampleChannel(channel.sampler, time, channel.property);
      if (
        values === undefined ||
        values.some((v) => !Number.isFinite(v)) ||
        values.length !== (channel.property === 'translation' ? 3 : 4) ||
        (channel.property === 'rotation' && Math.abs(Math.hypot(...values) - 1) > 1e-4)
      ) {
        throw new AnimationPlaybackError('animation-root-motion-invalid', {
          reason: 'finite vec3/unit-quaternion root curves required',
          targetId,
        });
      }
      if (channel.property === 'translation') p = values;
      else q = values;
    }
    return { p, q };
  };
  const reference = sample(0),
    inverseReference = inverse(reference);
  const compiled = {
    sample,
    reference,
    inverseReference,
    cycle: compose(sample(clip.duration), inverseReference),
  };
  if (targets === undefined) {
    targets = new Map();
    rootCurves.set(clip, targets);
  }
  targets.set(targetId, compiled);
  return compiled;
}

/** Unwrapped rigid transform; complete cycles use O(log cycles) composition. */
export function extractRootMotion(interval: PlaybackInterval, targetId: string): RigidPose {
  const { clip, from, to, looping } = interval;
  if (from === to) return identity();
  const curve = rootCurve(clip, targetId);
  const cycles = looping && clip.duration > 0 ? Math.floor(to / clip.duration) : 0;
  const phase = to - cycles * clip.duration;
  const a = curve.sample(from),
    b = curve.sample(phase);
  // Constant root orientation cancels: translation-only clips need no rigid compositions.
  if (
    a.q.every((v, i) => v === curve.reference.q[i]) &&
    b.q.every((v, i) => v === curve.reference.q[i]) &&
    curve.cycle.q[0] === 0 &&
    curve.cycle.q[1] === 0 &&
    curve.cycle.q[2] === 0 &&
    Math.abs(curve.cycle.q[3] ?? 0) === 1
  ) {
    return {
      p: b.p.map((v, i) => v - (a.p[i] ?? 0) + cycles * (curve.cycle.p[i] ?? 0)),
      q: [0, 0, 0, 1],
    };
  }
  const previous = compose(a, curve.inverseReference);
  const next = compose(b, curve.inverseReference);
  return compose(
    inverse(previous),
    cycles === 0 ? next : compose(power(curve.cycle, cycles), next),
  );
}

export function rootMotionPose(
  clip: AnimationClip,
  targetId: string,
  property: 'translation' | 'rotation',
): number[] | undefined {
  const curve = rootCurve(clip, targetId);
  return property === 'translation' ? curve.reference.p : curve.reference.q;
}

export function prepareRootMotion(
  world: World,
  player: EntityHandle,
  slots: readonly { readonly interval: PlaybackInterval; readonly weight: number }[],
): (() => void) | undefined {
  if (!world.hasComponent(player, AnimationRootMotion)) return;
  const root = world.get(player, AnimationRootMotion);
  if (!root.ok) return;
  const { targetId } = root.value;
  if (!isAnimationTargetId(targetId))
    throw new AnimationPlaybackError('animation-root-motion-invalid', {
      reason: 'canonical target ID required',
      targetId,
    });
  if (
    Array.from(root.value.accumulatedPosition).some((v) => !Number.isFinite(v)) ||
    Array.from(root.value.accumulatedRotation).some((v) => !Number.isFinite(v)) ||
    Math.abs(Math.hypot(...root.value.accumulatedRotation) - 1) > 1e-4 ||
    slots.some((slot) => !Number.isFinite(slot.weight))
  ) {
    throw new AnimationPlaybackError('animation-root-motion-invalid', {
      reason: 'finite weights and accumulated rigid pose required',
      targetId,
    });
  }
  let p = [0, 0, 0],
    q = [0, 0, 0, 0],
    sum = 0;
  for (const slot of slots) {
    const delta = extractRootMotion(slot.interval, targetId);
    const sign = sum === 0 || delta.q.reduce((dot, v, i) => dot + v * (q[i] ?? 0), 0) >= 0 ? 1 : -1;
    p = p.map((v, i) => v + slot.weight * (delta.p[i] ?? 0));
    q = q.map((v, i) => v + sign * slot.weight * (delta.q[i] ?? 0));
    sum += slot.weight;
  }
  const delta =
    sum > 0 ? { p: p.map((v) => v / sum), q: q.map((v) => v / Math.hypot(...q)) } : identity();
  const accumulated = compose(
    {
      p: Array.from(root.value.accumulatedPosition),
      q: Array.from(root.value.accumulatedRotation),
    },
    delta,
  );
  for (const values of [delta.p, delta.q, accumulated.p, accumulated.q]) {
    if (values.some((value) => !Number.isFinite(Math.fround(value)))) {
      throw new AnimationPlaybackError('animation-root-motion-invalid', {
        reason: 'derived rigid motion must fit finite f32 component values',
        targetId,
      });
    }
  }
  return () => {
    world
      .set(player, AnimationRootMotion, {
        position: delta.p,
        rotation: delta.q,
        accumulatedPosition: accumulated.p,
        accumulatedRotation: accumulated.q,
      })
      .unwrap();
  };
}
