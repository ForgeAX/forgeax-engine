import type { World } from '@forgeax/engine-ecs';
import type { AnimationClip, AnimationTimelineKey } from '@forgeax/engine-types';
import { AnimationPlaybackError } from './playback-errors';
import type { PlaybackInterval } from './playback-interval';
import { isAnimationTargetId } from './target-id';

export interface AnimationTimelineEvent extends AnimationTimelineKey {
  readonly player: number;
  readonly clip: number;
  readonly slot: number;
  readonly key: number;
  readonly cycle: number;
  readonly direction: 1 | -1;
  /** Fraction of this tick at which the key was crossed. */
  readonly fraction: number;
}
export const ANIMATION_TIMELINE_EVENT_LIMIT = 2048;
const validated = new WeakSet<AnimationClip>();
const frames = new WeakMap<World, Map<number, readonly AnimationTimelineEvent[]>>();

/** Validate immutable clip keys at their producer/first runtime use. */
export function validateAnimationTimeline(clip: AnimationClip): void {
  if (validated.has(clip)) return;
  if (clip.events !== undefined && !Array.isArray(clip.events)) {
    throw new AnimationPlaybackError('animation-timeline-invalid', {
      reason: 'events must be an array',
    });
  }
  const keys = clip.events ?? [];
  if (keys.length > 1024)
    throw new AnimationPlaybackError('animation-timeline-invalid', {
      reason: 'at most 1024 keys per clip',
    });
  let previous = -Infinity;
  for (let key = 0; key < keys.length; key++) {
    const entry = keys[key];
    const action = entry?.action;
    const validAction =
      action &&
      (action.kind === 'method'
        ? typeof action.name === 'string' &&
          action.name.length > 0 &&
          Array.isArray(action.args) &&
          action.args.length <= 32 &&
          action.args.every(
            (value: unknown) =>
              value === null ||
              typeof value === 'string' ||
              typeof value === 'boolean' ||
              (typeof value === 'number' && Number.isFinite(value)),
          )
        : (action.kind === 'audio' || action.kind === 'animation') &&
          (action.clip === null || (typeof action.clip === 'string' && action.clip.length > 0)) &&
          Number.isFinite(action.fromPosition) &&
          action.fromPosition >= 0);
    if (
      !entry ||
      !Number.isFinite(entry.time) ||
      entry.time < previous ||
      entry.time < 0 ||
      entry.time > clip.duration ||
      !isAnimationTargetId(entry.targetId) ||
      !validAction
    ) {
      throw new AnimationPlaybackError('animation-timeline-invalid', {
        reason: 'sorted in-range keys, canonical target IDs and typed POD actions required',
        key,
      });
    }
    previous = entry.time;
  }
  validated.add(clip);
}

/** Half-open traversal: forward (from,to], reverse [to,from). */
export function collectTimelineEvents(
  player: number,
  intervals: readonly PlaybackInterval[],
): AnimationTimelineEvent[] {
  const events: AnimationTimelineEvent[] = [];
  for (const interval of intervals) {
    validateAnimationTimeline(interval.clip);
    const { from, to, looping, clip } = interval;
    if (from === to) continue;
    const direction = to > from ? 1 : -1;
    for (const [key, entry] of (clip.events ?? []).entries()) {
      let first = 0,
        last = 0;
      if (looping && clip.duration > 0) {
        first =
          direction === 1
            ? Math.floor((from - entry.time) / clip.duration) + 1
            : Math.ceil((to - entry.time) / clip.duration);
        last =
          direction === 1
            ? Math.floor((to - entry.time) / clip.duration)
            : Math.ceil((from - entry.time) / clip.duration) - 1;
      } else if (
        !(direction === 1
          ? entry.time > from && entry.time <= to
          : entry.time >= to && entry.time < from)
      )
        continue;
      if (last - first + 1 > ANIMATION_TIMELINE_EVENT_LIMIT - events.length) {
        throw new AnimationPlaybackError('animation-timeline-overflow', {
          player,
          limit: ANIMATION_TIMELINE_EVENT_LIMIT,
        });
      }
      for (let cycle = first; cycle <= last; cycle++) {
        const crossing = entry.time + cycle * clip.duration;
        events.push({
          ...entry,
          player,
          clip: interval.clipHandle,
          slot: interval.slot,
          key,
          cycle,
          direction,
          fraction: (crossing - from) / interval.advance,
        });
      }
    }
  }
  events.sort(
    (a, b) =>
      a.fraction - b.fraction ||
      a.slot - b.slot ||
      a.direction * (a.cycle - b.cycle) ||
      a.direction * (a.time - b.time) ||
      a.key - b.key,
  );
  return events;
}

export function publishTimelineEvents(
  world: World,
  player: number,
  events: readonly AnimationTimelineEvent[],
): void {
  let players = frames.get(world);
  if (players === undefined) {
    players = new Map();
    frames.set(world, players);
  }
  if (events.length === 0) players.delete(player);
  else players.set(player, events);
}

/** Consume after advanceAnimationPlayer. Unread results are replaced next tick. */
export function drainAnimationEvents(
  world: World,
  player: number,
): readonly AnimationTimelineEvent[] {
  const players = frames.get(world);
  const events = players?.get(player) ?? [];
  players?.delete(player);
  return events;
}
export function clearAnimationEvents(world: World): void {
  frames.delete(world);
}
