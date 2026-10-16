import type { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { AnimationPlaybackError } from './playback-errors';

export interface PlaybackInterval {
  readonly clip: AnimationClip;
  readonly clipHandle: number;
  readonly slot: number;
  readonly from: number;
  readonly to: number;
  readonly looping: boolean;
  readonly advance: number;
}

export function playbackInterval(
  clip: AnimationClip,
  clipHandle: number,
  slot: number,
  time: number,
  delta: number,
  looping: boolean,
): PlaybackInterval {
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(delta) ||
    !Number.isFinite(time + delta) ||
    !Number.isFinite(clip.duration) ||
    clip.duration < 0
  ) {
    throw new AnimationPlaybackError('animation-playback-invalid', {
      reason: 'finite clocks and non-negative duration required',
      slot,
    });
  }
  const from = sampleTime(time, clip.duration, looping);
  const to =
    clip.duration === 0
      ? from
      : looping
        ? snapDurationBoundary(from + delta, clip.duration)
        : sampleTime(from + delta, clip.duration, false);
  if (!Number.isSafeInteger(Math.floor(to / (clip.duration || 1)))) {
    throw new AnimationPlaybackError('animation-playback-invalid', {
      reason: 'cycle count exceeds integer precision',
      slot,
    });
  }
  return { clip, clipHandle, slot, from, to, looping, advance: delta };
}

export function sampleTime(time: number, duration: number, looping: boolean): number {
  if (duration <= 0) return 0;
  const clock = snapDurationBoundary(time, duration);
  if (!looping) return Math.max(0, Math.min(duration, clock));
  const phase = clock % duration;
  return phase < 0 ? phase + duration : phase;
}

// Canonicalize a duration boundary within one clock ulp, including accumulated
// decimal steps such as ten 0.1-second updates. Mid-clip keys are never snapped.
function snapDurationBoundary(time: number, duration: number): number {
  const boundary = Math.round(time / duration) * duration;
  return Math.abs(time - boundary) <= Number.EPSILON * Math.abs(time) ? boundary : time;
}

// Graph clocks own these intervals until the pose consumer takes them once.
// No public clock column or persistent replay ledger is needed.
const graphIntervals = new WeakMap<World, Map<number, readonly PlaybackInterval[]>>();
export function stageGraphIntervals(
  world: World,
  player: number,
  intervals: readonly PlaybackInterval[],
): void {
  let players = graphIntervals.get(world);
  if (players === undefined) {
    players = new Map();
    graphIntervals.set(world, players);
  }
  players.set(player, intervals);
}
export function takeGraphIntervals(world: World, player: number): readonly PlaybackInterval[] {
  const players = graphIntervals.get(world);
  const intervals = players?.get(player) ?? [];
  players?.delete(player);
  return intervals;
}
export function clearPlaybackIntervals(world: World): void {
  graphIntervals.delete(world);
}
