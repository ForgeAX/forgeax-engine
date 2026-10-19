import { FixedTime, FixedUpdate, type ScheduleToken, Time, Update } from '@forgeax/engine-ecs';
import { sampleChannel } from '../sample-channel';
// @forgeax/engine-animation — advanceAnimationPlayer system (variable N-way blend).
//
// Per-tick: scans the variable-length SoA columns on each AnimationPlayer; for
// each active slot (clips[i] != 0), advances times[i] += dt * speeds[i] (paused
// gates the whole entity), samples the AnimationClip channels, and accumulates a
// weighted pose into per-joint TRS accumulators. Once all slots are
// folded in, each changed joint receives at most one `world.set(joint, Transform,
// fullPose)` (research F-2 / F-7 / F-8 — single write per joint per tick).
//
// Variable N-slot (feat-20260713 M1 / w5): the fixed 4-slot cap is retired. The
// four parallel columns (clips / times / weights / speeds) are variable
// `array<T>` columns, so row queries expose them through each entity's resolved
// component value; the flat-SoA row window used by the retired fixed schema no
// longer applies. Each entity's columns are read back as
// resolved TypedArrays via `world.get(entity, AnimationPlayer)` and the advanced
// `times` column is written back via `world.set` (D-7: weights are never written
// back; clamping is read-time only). The blend math (translation linear / scale
// linear / rotation nlerp, per-channel sumW) is byte-for-byte unchanged from the
// fixed schema — only the loop bound moved from a hard 4 to the column length.
//
// Blend math (plan-strategy D-1):
//   - translation / scale: linear average — accumulator += w_i * v_i, then
//     accumulator /= Σw_i (per-channel sumW).
//   - rotation: nlerp — first valid quat fixes the sign reference; later
//     quats negated when dot < 0 to take the short arc; accumulator += w * q;
//     finalize = normalize(accumulator). nlerp (not slerp) per D-1 (research
//     F-7: Three.js Normal-mode mathematical form).
//   - per-channel sumW: a joint receiving translation from 2 slots and rotation
//     from 1 slot normalizes each channel by its own sum. Slot weights need not
//     be partitioned-by-1 (research F-2).
//
// Best-effort failure modes (AC-05, plan-strategy D-7 / D-9):
//   - clips[i] == 0          : skip slot, no resolver call (AC-04)
//   - resolver miss          : skip slot
//   - weights[i] < 0         : clamped via max(0, w); not written back (D-7)
//   - duration mismatch      : per-slot modulo on its own duration
//   - channel target missing : skip channel
//   - channel missing on slot: per-channel normalize covers it
//
// w5 layers a dev-mode warn pass on top of these silent skips
// (channel-target-missing / channel-missing-on-some-slot, once per
// (entity, channelKey, reason)).
//
// Decision anchors:
//   - requirements IS-2 / AC-03 / AC-04 / AC-05 (best-effort N-way blend)
//   - plan-strategy D-1 (TRS accumulators + nlerp), D-3 (public Query, no
//     query-backed lookup), D-7 (clamp without write-back), D-9 (negative speed
//     natural reverse)
//   - charter P4 (single Transform write per joint per tick)

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem, defineSystemSet, ENTITY_NULL_RAW } from '@forgeax/engine-ecs';
import {
  createStateProjection,
  readRenderArrayView,
  type StateProjection,
} from '@forgeax/engine-ecs/projection';
import { MorphWeights, Transform } from '@forgeax/engine-scene';
import type { AnimationChannel, AnimationClip } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import {
  emitAnimationDiagnostic,
  isAnimationDevMode,
  _resetAnimationWarnsForTests as resetAnimationDiagnosticsForTests,
} from '../animation-diagnostic';
import {
  animationMaskWeight,
  type CompiledAnimationMask,
  resolveAnimationMask,
} from '../animation-mask';
import { AnimationPlayer } from '../animation-player';
import { AnimatedBy, AnimationTargetId, AnimationTargets } from '../animation-target';
import { AnimationBlendError } from '../blend-errors';
import {
  type PlaybackInterval,
  playbackInterval,
  sampleTime,
  takeGraphIntervals,
} from '../playback-interval';
import { AnimationPlayerSlotLengthMismatchError } from '../player-errors';
import {
  accumulateProperty,
  type PropertyAccumulator,
  reportPropertyFailure,
  writeProperties,
} from '../property-binding';
import { AnimationRootMotion, prepareRootMotion, rootMotionPose } from '../root-motion';
import { clearAnimationEvents, collectTimelineEvents, publishTimelineEvents } from '../timeline';

/**
 * System name used when `registerAdvanceAnimationPlayer` installs the system
 * into the ECS schedule. External consumers can reference this constant to
 * declare `after: [ADVANCE_ANIMATION_PLAYER_SYSTEM]` on dependent systems.
 */
export const ADVANCE_ANIMATION_PLAYER_SYSTEM = 'advanceAnimationPlayer' as const;
export const AnimationSet = defineSystemSet({ name: 'animation' });

export function _resetAnimationWarnsForTests(world: World): void {
  resetAnimationDiagnosticsForTests(world);
  targetMapCacheByWorld.delete(world);
}

/**
 * Advance all AnimationPlayer components by dt, blend the N active clips per
 * entity, and write one Transform per joint per tick. Returns void.
 *
 * Iteration walks every matching row through the injected Query (D-3). Variable
 * SoA columns are read through the row facade, so entity handles are collected first, then each
 * entity's columns are resolved to TypedArrays via `world.get` and the advanced
 * `times` written back via `world.set` (mutating the query bundle mid-walk would
 * be a compile error against the reader shape).
 */
export function advanceAnimationPlayer(world: World, dt: number): void {
  clearAnimationEvents(world);
  refreshTargetMaps(world);
  const query = world.query({ with: [AnimationPlayer] }).unwrap();
  let available = poseScratchByWorld.get(world);
  if (available === undefined) {
    available = [];
    poseScratchByWorld.set(world, available);
  }
  const scratch = available.pop() ?? createPoseScratch();
  try {
    // Structural author callbacks can change target membership while a player
    // advances. Collect handles before writes and keep nested evaluations isolated.
    for (const row of query) scratch.entities.push(row.entity);
    for (const entityRaw of scratch.entities) advanceOnePlayer(world, entityRaw, dt, scratch);
  } finally {
    scratch.entities.length = 0;
    scratch.targets.length = 0;
    available.push(scratch);
  }
}

/**
 * Resolved per-entity AnimationPlayer columns (a `world.get` snapshot). Variable
 * columns alias the BufferPool slot bytes; the advanced `times` is written back
 * via `world.set`, never in place, so the snapshot is treated read-only here.
 */
interface PlayerColumns {
  readonly clips: Uint32Array;
  readonly times: Float64Array;
  readonly weights: Float32Array;
  readonly speeds: Float32Array;
  readonly masks: Uint32Array;
  readonly paused: boolean;
  readonly looping: boolean;
  readonly graph: number;
}

/**
 * Advance one entity's AnimationPlayer: validate the four parallel column
 * lengths at the evaluation entry (the single length chokepoint, D-5), walk the
 * N slots to collect the active set + advanced times, write the advanced `times`
 * column back, and fold the active slots into the joint pose.
 *
 * Length guard (AC-11 / D-5): variable columns are set field-by-field, so a
 * consumer that desyncs their lengths is rejected here with the structured
 * `animation-player-slot-length-mismatch` error rather than silently padded or
 * truncated.
 */
function advanceOnePlayer(world: World, entityRaw: number, dt: number, scratch: PoseScratch): void {
  const entity = entityRaw as EntityHandle;
  const apRes = world.get(entity, AnimationPlayer);
  if (!apRes.ok) return;
  const ap = apRes.value as unknown as PlayerColumns;

  const count = ap.clips.length;
  if (ap.times.length !== count || ap.weights.length !== count || ap.speeds.length !== count) {
    throw new AnimationPlayerSlotLengthMismatchError({
      entity: entityRaw,
      clips: count,
      times: ap.times.length,
      weights: ap.weights.length,
      speeds: ap.speeds.length,
    });
  }
  if (ap.masks.length !== 0 && ap.masks.length !== count) {
    throw new AnimationBlendError('animation-player-mask-length-mismatch', {
      entity: entityRaw,
      field: 'masks',
      expectedLength: count,
      actualLength: ap.masks.length,
    });
  }

  const newTimes = new Float64Array(ap.times);
  const activeSlots = collectActiveSlotsAndAdvanceTimes(
    world,
    ap,
    newTimes,
    dt,
    takeGraphIntervals(world, entity),
  );

  const events = collectTimelineEvents(
    entity,
    activeSlots.map((slot) => slot.interval),
  );
  const root = world.hasComponent(entity, AnimationRootMotion)
    ? world.get(entity, AnimationRootMotion)
    : undefined;
  const commitRoot = root?.ok
    ? prepareRootMotion(
        world,
        entity,
        activeSlots
          .map((slot) => ({
            interval: slot.interval,
            weight:
              slot.weight *
              (root?.ok && slot.mask ? animationMaskWeight(slot.mask, root.value.targetId) : 1),
          }))
          .filter((slot) => slot.weight > 0),
      )
    : undefined;

  // Persist the advanced times column (D-7: weights are never written back —
  // negative-weight clamping is read-time only). Only `times` is set, so the
  // clips / weights / speeds slots are left untouched.
  world.set(entity, AnimationPlayer, { times: newTimes });

  if (activeSlots.length > 0) tickEntityTargets(world, entity, entityRaw, activeSlots, scratch);
  commitRoot?.();
  publishTimelineEvents(world, entity, events);
}

/**
 * Walk the N SoA slots for one entity: skip `clips[i]==0` (AC-04, no resolver
 * call), skip resolver miss, advance `times[i] += speeds[i]*dt` (paused gates
 * the entity per AC-05) into `newTimes`, wrap / clamp by clip duration based on
 * `looping`, and keep the slot if `max(0, weights[i]) > 0` (D-7 clamp without
 * write-back).
 *
 * The negative-speed reverse case (D-9) falls out naturally — `newTime`
 * goes negative, the looping branch's `+= duration` re-anchors it; the
 * looping=false branch clamps to 0.
 */
function collectActiveSlotsAndAdvanceTimes(
  world: World,
  ap: PlayerColumns,
  newTimes: Float64Array,
  dt: number,
  graphIntervals: readonly PlaybackInterval[],
): ActiveSlot[] {
  const paused = ap.paused;
  const looping = ap.looping;
  const count = ap.clips.length;
  const activeSlots: ActiveSlot[] = [];

  for (let i = 0; i < count; i++) {
    const clipHandleRaw = ap.clips[i] ?? 0;
    if (clipHandleRaw === 0) continue;
    const clipLookup = world.sharedRefs.resolve<'AnimationClip', AnimationClip>(
      toShared<'AnimationClip'>(clipHandleRaw),
    );
    if (!clipLookup.ok) throw clipLookup.error;
    const clip = clipLookup.value;
    const mask = resolveAnimationMask(world, ap.masks[i] ?? 0);

    const speed = ap.speeds[i] ?? 0;
    const interval =
      ap.graph !== 0
        ? ((graphIntervals[i]?.clipHandle === clipHandleRaw ? graphIntervals[i] : undefined) ??
          playbackInterval(clip, clipHandleRaw, i, ap.times[i] ?? 0, 0, looping))
        : playbackInterval(
            clip,
            clipHandleRaw,
            i,
            ap.times[i] ?? 0,
            paused ? 0 : speed * dt,
            looping,
          );
    const newTime = sampleTime(interval.to, clip.duration, looping);
    newTimes[i] = newTime;

    const wRaw = ap.weights[i] ?? 0;
    const w = wRaw > 0 ? wRaw : 0;
    if (w === 0) continue;

    activeSlots.push({ clip, clipHandleRaw, weight: w, time: newTime, slotIdx: i, mask, interval });
  }

  return activeSlots;
}

/**
 * Target-write pass for one player: resolves its explicit target mirror and
 * folds every active-slot channel into a per-target TRS accumulator (linear
 * for translation/scale, nlerp with sign-fixed reference for rotation),
 * then writes one `world.set(joint, Transform, ...)` per touched joint.
 *
 * Dev-mode warns (D-2):
 *   - channel-target-missing: a clip channel ID does not resolve in this
 *     player's explicit target set. Once per (entityId, clip, chIdx).
 *   - channel-missing-on-some-slot: a (joint, kind) tuple is covered by
 *     some slot but missing on another. The warn is emitted once per
 *     (entityId, the-covering-slot's-clip, that-slot's-chIdx) so users
 *     find the authoring point that has the channel; per-channel sumW
 *     normalize covers the runtime gap regardless.
 */
interface ResolvedTarget {
  readonly entity: EntityHandle;
  readonly transform: boolean;
  readonly index: number;
}

interface TargetMap {
  /** Null marks an ambiguous ID; each unique ID retains its binding snapshot. */
  readonly bindings: ReadonlyMap<string, ResolvedTarget | null>;
  readonly hasStaleTarget: boolean;
  readonly resolvedClips: WeakMap<AnimationClip, readonly (ResolvedTarget | undefined)[]>;
}

interface TargetBinding {
  readonly entity: EntityHandle;
  readonly player: EntityHandle | undefined;
  readonly id: string | undefined;
  readonly transform: boolean;
}

interface WorldTargetMapCache {
  readonly projection: StateProjection;
  readonly bindings: Map<number, TargetBinding>;
  readonly players: Map<number, TargetMap>;
}

const targetMapCacheByWorld = new WeakMap<World, WorldTargetMapCache>();

/** Collect binding changes once before advancing any player. */
function refreshTargetMaps(world: World): void {
  let cache = targetMapCacheByWorld.get(world);
  if (cache === undefined) {
    cache = {
      projection: createStateProjection(world, [AnimationTargets, AnimationTargetId, AnimatedBy]),
      bindings: new Map(),
      players: new Map(),
    };
    targetMapCacheByWorld.set(world, cache);
  }
  const batch = cache.projection.read();
  for (const index of batch.indices) {
    const old = cache.bindings.get(index);
    const entity = cache.projection.entity(index);
    if (entity === undefined) {
      if (old?.player !== undefined) cache.players.delete(old.player);
      if (old !== undefined) cache.players.delete(old.entity);
      cache.bindings.delete(index);
      continue;
    }
    const bindingChanged =
      batch.membershipChanged ||
      old?.entity !== entity ||
      cache.projection.changed(entity, AnimatedBy) ||
      cache.projection.changed(entity, AnimationTargetId);
    const by = bindingChanged ? world.get(entity, AnimatedBy) : undefined;
    const id = bindingChanged ? world.get(entity, AnimationTargetId) : undefined;
    const next: TargetBinding = {
      entity,
      player: bindingChanged ? (by?.ok ? (by.value.player ?? undefined) : undefined) : old?.player,
      id: bindingChanged ? (id?.ok ? id.value.value : undefined) : old?.id,
      transform: world.hasComponent(entity, Transform),
    };
    if (
      old?.entity !== entity ||
      old.player !== next.player ||
      old.id !== next.id ||
      old.transform !== next.transform
    ) {
      if (old?.player !== undefined) cache.players.delete(old.player);
      if (next.player !== undefined) cache.players.delete(next.player);
    }
    if (batch.membershipChanged || cache.projection.changed(entity, AnimationTargets))
      cache.players.delete(entity);
    cache.bindings.set(index, next);
  }
  batch.accept();
}

function targetMapForPlayer(world: World, player: EntityHandle): TargetMap {
  const cache = targetMapCacheByWorld.get(world);
  const cached = cache?.players.get(player);
  if (cached !== undefined) return cached;
  const built = buildTargetMap(world, player);
  cache?.players.set(player, built);
  return built;
}

function buildTargetMap(world: World, player: EntityHandle): TargetMap {
  const targets = world.get(player, AnimationTargets);
  if (!targets.ok) {
    return {
      bindings: new Map(),
      hasStaleTarget: false,
      resolvedClips: new WeakMap(),
    };
  }
  const bindings = new Map<string, ResolvedTarget | null>();
  let hasStaleTarget = false;
  for (const raw of targets.value.targets) {
    if (raw === ENTITY_NULL_RAW) continue;
    const target = raw as EntityHandle;
    const id = world.get(target, AnimationTargetId);
    if (!id.ok) {
      hasStaleTarget = true;
      continue;
    }
    const targetId = id.value.value;
    if (bindings.has(targetId)) bindings.set(targetId, null);
    else
      bindings.set(targetId, {
        entity: target,
        transform: world.get(target, Transform).ok,
        index: bindings.size,
      });
  }
  return {
    bindings,
    hasStaleTarget,
    resolvedClips: new WeakMap(),
  };
}

function tickEntityTargets(
  world: World,
  entity: EntityHandle,
  entityRaw: number,
  activeSlots: ActiveSlot[],
  scratch: PoseScratch,
): void {
  const targetMap = targetMapForPlayer(world, entity);
  const root = world.hasComponent(entity, AnimationRootMotion)
    ? world.get(entity, AnimationRootMotion)
    : undefined;

  const { channelSample } = scratch;
  const morphAccumulators = new Map<number, MorphWeightAccumulator>();
  const propertyAccumulators = new Map<string, PropertyAccumulator>();
  scratch.generation += 1;
  scratch.targets.length = 0;
  // Per-slot signature of (joint, channel-kind) coverage — used to detect
  // channel-missing-on-some-slot once at the end of the channel walk. Lazy
  // build only when there are 2+ active slots and dev-mode is on (warn pass
  // is skipped in production by the shared diagnostics mode gate).
  const slotCoverage: SlotCoverage | undefined =
    activeSlots.length >= 2 && isAnimationDevMode() ? new Map() : undefined;

  for (let slotIdx = 0; slotIdx < activeSlots.length; slotIdx++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by activeSlots.length
    const slot = activeSlots[slotIdx]!;
    const mask = slot.mask;
    const resolvedTargets =
      mask === undefined ? resolveClipTargets(world, entityRaw, slot, targetMap) : undefined;
    for (let chIdx = 0; chIdx < slot.clip.channels.length; chIdx++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by channels.length
      const channel = slot.clip.channels[chIdx]!;
      const weight =
        mask === undefined
          ? slot.weight
          : slot.weight * animationMaskWeight(mask, channel.targetId);
      if (weight <= 0) continue;
      if (channel.property === 'property') {
        try {
          accumulateProperty(
            world,
            entity,
            channel,
            slot.time,
            weight,
            propertyAccumulators,
            slot.clipHandleRaw,
            chIdx,
            sampleChannel,
          );
        } catch (failure) {
          reportPropertyFailure(world, entity, channel, slot.clipHandleRaw, chIdx, failure);
        }
        continue;
      }
      const sampled =
        root?.ok &&
        channel.targetId === root.value.targetId &&
        (channel.property === 'translation' || channel.property === 'rotation')
          ? rootMotionPose(slot.clip, channel.targetId, channel.property)
          : sampleChannel(channel.sampler, slot.time, channel.property, channelSample);
      if (sampled === undefined) continue;
      const target =
        channel.property === 'weights'
          ? resolveChannelTarget(
              world,
              entityRaw,
              slot.clipHandleRaw,
              chIdx,
              channel.targetId,
              channel.property,
              sampled.length,
              targetMap,
            )
          : resolvedTargets === undefined
            ? resolveChannelTarget(
                world,
                entityRaw,
                slot.clipHandleRaw,
                chIdx,
                channel.targetId,
                channel.property,
                undefined,
                targetMap,
              )
            : resolvedTargets[chIdx];
      if (target === undefined) continue;
      const targetRaw = target.entity as number;

      if (channel.property === 'weights') {
        let weights = morphAccumulators.get(targetRaw);
        if (weights === undefined) {
          weights = { values: new Float32Array(sampled.length), sumW: 0 };
          morphAccumulators.set(targetRaw, weights);
        }
        if (weights.values.length !== sampled.length) continue;
        for (let i = 0; i < sampled.length; i++) {
          weights.values[i] = (weights.values[i] ?? 0) + weight * (sampled[i] ?? 0);
        }
        weights.sumW += weight;
        if (slotCoverage !== undefined)
          recordSlotCoverage(slotCoverage, slotIdx, channel.targetId, channel.property, chIdx);
        continue;
      }

      let acc = scratch.joints[target.index];
      if (acc === undefined) {
        acc = createAccumulator();
        scratch.joints[target.index] = acc;
      }
      if (acc.generation !== scratch.generation) {
        resetAccumulator(acc);
        acc.generation = scratch.generation;
        acc.target = target.entity;
        scratch.targets.push(target.index);
      }

      foldChannelIntoAccumulator(acc, channel.property, sampled, weight);

      if (slotCoverage !== undefined) {
        recordSlotCoverage(slotCoverage, slotIdx, channel.targetId, channel.property, chIdx);
      }
    }
  }

  if (slotCoverage !== undefined) {
    emitMissingOnSomeSlotWarns(world, entityRaw, activeSlots, slotCoverage);
  }

  writeProperties(world, entity, propertyAccumulators);
  for (let index = 0; index < scratch.targets.length; index++) {
    const targetIndex = scratch.targets[index];
    const acc = targetIndex === undefined ? undefined : scratch.joints[targetIndex];
    if (acc !== undefined) writeAccumulator(world, acc.target, acc, scratch);
  }
  for (const [targetRaw, acc] of morphAccumulators) {
    if (acc.sumW <= 0) continue;
    const target = targetRaw as EntityHandle;
    const weights = world.get(target, MorphWeights);
    if (weights.ok && weights.value.weights.length === acc.values.length) {
      const next = new Float32Array(acc.values.length);
      for (let i = 0; i < next.length; i++) next[i] = (acc.values[i] ?? 0) / acc.sumW;
      world.set(target, MorphWeights, { weights: next });
    }
  }
}

function resolveClipTargets(
  world: World,
  player: number,
  slot: ActiveSlot,
  targetMap: TargetMap,
): readonly (ResolvedTarget | undefined)[] {
  const cached = targetMap.resolvedClips.get(slot.clip);
  if (cached !== undefined) return cached;

  const targets = slot.clip.channels.map((channel, channelIndex) =>
    channel.property === 'weights' || channel.property === 'property'
      ? undefined
      : resolveChannelTarget(
          world,
          player,
          slot.clipHandleRaw,
          channelIndex,
          channel.targetId,
          channel.property,
          undefined,
          targetMap,
        ),
  );
  targetMap.resolvedClips.set(slot.clip, targets);
  return targets;
}

function resolveChannelTarget(
  world: World,
  player: number,
  clip: number,
  channel: number,
  targetId: string,
  property: ChannelKind,
  expectedWeightCount: number | undefined,
  targetMap: TargetMap,
): ResolvedTarget | undefined {
  const binding = targetMap.bindings.get(targetId);
  if (binding === null) {
    emitTargetDiagnostic(
      world,
      player,
      clip,
      channel,
      targetId,
      'target-id-duplicate',
      'assign a unique AnimationTargetId to each target owned by this player',
    );
    return undefined;
  }
  if (binding !== undefined && !binding.transform) {
    emitTargetDiagnostic(
      world,
      player,
      clip,
      channel,
      targetId,
      'transform-missing',
      'attach Transform to the bound animation target',
      binding.entity as number,
    );
    return undefined;
  }
  if (binding === undefined) {
    emitTargetDiagnostic(
      world,
      player,
      clip,
      channel,
      targetId,
      targetMap.hasStaleTarget ? 'target-stale' : 'target-missing',
      targetMap.hasStaleTarget
        ? 'remove the stale target relation or bind a live replacement'
        : 'bind the matching AnimationTargetId to this player',
    );
    return undefined;
  }
  const target = binding.entity;
  if (property === 'weights') {
    const weights = world.get(target, MorphWeights);
    if (!weights.ok) {
      emitAnimationDiagnostic(
        world,
        {
          player,
          clip,
          channel,
          targetId,
          reason: 'morph-weights-missing',
          target: target as number,
          property,
          ...(expectedWeightCount === undefined ? {} : { expectedWeightCount }),
        },
        'attach MorphWeights to the morph target entity before playing a weights channel',
      );
      return undefined;
    }
    if (expectedWeightCount !== undefined && weights.value.weights.length !== expectedWeightCount) {
      emitAnimationDiagnostic(
        world,
        {
          player,
          clip,
          channel,
          targetId,
          reason: 'morph-weight-count-mismatch',
          target: target as number,
          property,
          expectedWeightCount,
          actualWeightCount: weights.value.weights.length,
        },
        'make MorphWeights.length equal the animation channel output width',
      );
      return undefined;
    }
    return binding;
  }
  if (!world.get(target, Transform).ok) {
    emitTargetDiagnostic(
      world,
      player,
      clip,
      channel,
      targetId,
      'transform-missing',
      'attach Transform to the bound animation target',
      target as number,
    );
    return undefined;
  }
  return binding;
}

/** Target/kind coverage retains each slot's first channel as a diagnostic anchor. */
type ChannelKind = Exclude<AnimationChannel['property'], 'property'>;
type SlotCoverage = Map<string, Map<ChannelKind, Map<number, number>>>;

function recordSlotCoverage(
  cov: SlotCoverage,
  slot: number,
  targetId: string,
  kind: ChannelKind,
  channel: number,
): void {
  let perTarget = cov.get(targetId);
  if (perTarget === undefined) {
    perTarget = new Map();
    cov.set(targetId, perTarget);
  }
  let coveringSlots = perTarget.get(kind);
  if (coveringSlots === undefined) {
    coveringSlots = new Map();
    perTarget.set(kind, coveringSlots);
  }
  if (!coveringSlots.has(slot)) coveringSlots.set(slot, channel);
}

function emitTargetDiagnostic(
  world: World,
  entityRaw: number,
  clipHandleRaw: number,
  chIdx: number,
  targetId: string,
  reason: 'target-missing' | 'transform-missing' | 'target-id-duplicate' | 'target-stale',
  hint: string,
  target?: number,
): void {
  emitAnimationDiagnostic(
    world,
    {
      player: entityRaw,
      clip: clipHandleRaw,
      channel: chIdx,
      targetId,
      reason,
      ...(target === undefined ? {} : { target }),
    },
    hint,
  );
}

/** Emit once at the first covering channel when any active slot lacks that kind. */
function emitMissingOnSomeSlotWarns(
  world: World,
  entityRaw: number,
  activeSlots: ActiveSlot[],
  coverage: SlotCoverage,
): void {
  for (const [targetId, kinds] of coverage) {
    // Keep diagnostic observation in missing-slot order. The diagnostic owner
    // deduplicates repeated facts when more than one slot lacks the channel.
    for (let missingSlot = 0; missingSlot < activeSlots.length; missingSlot++) {
      const mask = activeSlots[missingSlot]?.mask;
      if (mask !== undefined && animationMaskWeight(mask, targetId) === 0) continue;
      for (const [kind, coveringSlots] of kinds) {
        if (coveringSlots.has(missingSlot)) continue;
        const anchor = coveringSlots.entries().next().value;
        if (anchor === undefined) continue;
        const [slotIndex, channel] = anchor;
        const slot = activeSlots[slotIndex];
        if (slot === undefined) continue;
        emitAnimationDiagnostic(
          world,
          {
            player: entityRaw,
            clip: slot.clipHandleRaw,
            channel,
            targetId,
            reason: 'channel-missing',
            property: kind,
          },
          `author the missing ${kind} channel on the slot whose clip lacks it`,
        );
      }
    }
  }
}

/**
 * Add a sampled (translation / rotation / scale) channel to the per-joint
 * accumulator, weighted by the slot's weight. Quat handling sign-fixes
 * against the first quat seen so the nlerp picks the short arc (research
 * F-7); per-channel sumW lets translation / rotation / scale normalize
 * independently when slot coverage differs (research F-2 / AC-05(b)).
 */
function foldChannelIntoAccumulator(
  acc: JointAccumulator,
  property: ChannelKind,
  sampled: number[],
  weight: number,
): void {
  if (property === 'weights') return;
  if (property === 'translation' && sampled.length >= 3) {
    acc.posX += weight * (sampled[0] ?? 0);
    acc.posY += weight * (sampled[1] ?? 0);
    acc.posZ += weight * (sampled[2] ?? 0);
    acc.sumWPos += weight;
    return;
  }
  if (property === 'rotation' && sampled.length >= 4) {
    const qx = sampled[0] ?? 0;
    const qy = sampled[1] ?? 0;
    const qz = sampled[2] ?? 0;
    const qw = sampled[3] ?? 1;
    if (acc.sumWQuat === 0) {
      acc.refQX = qx;
      acc.refQY = qy;
      acc.refQZ = qz;
      acc.refQW = qw;
      acc.quatX = weight * qx;
      acc.quatY = weight * qy;
      acc.quatZ = weight * qz;
      acc.quatW = weight * qw;
    } else {
      const dot = acc.refQX * qx + acc.refQY * qy + acc.refQZ * qz + acc.refQW * qw;
      const sign = dot < 0 ? -1 : 1;
      acc.quatX += weight * sign * qx;
      acc.quatY += weight * sign * qy;
      acc.quatZ += weight * sign * qz;
      acc.quatW += weight * sign * qw;
    }
    acc.sumWQuat += weight;
    return;
  }
  if (property === 'scale' && sampled.length >= 3) {
    acc.scaleX += weight * (sampled[0] ?? 1);
    acc.scaleY += weight * (sampled[1] ?? 1);
    acc.scaleZ += weight * (sampled[2] ?? 1);
    acc.sumWScale += weight;
  }
}

/**
 * Per-channel normalize: divide by per-channel sumW. Quat finalize
 * normalizes the resulting vec4 (nlerp). A channel with sumW=0 is silently
 * absent from the partial — `world.set` with a partial leaves untouched
 * fields at their existing values (AC-05(b) per-channel fallback). Channel
 * granularity maps 1:1 onto the Transform array columns (feat-20260709 M2):
 * an animated channel always covers its whole pos/quat/scale vector, so the
 * per-field partial write semantics are unchanged by the column migration.
 */
function writeAccumulator(
  world: World,
  target: EntityHandle,
  acc: JointAccumulator,
  scratch: PoseScratch,
): void {
  const { pos, quat, scale } = scratch;
  let fields = 0;
  if (acc.sumWPos > 0) {
    pos[0] = acc.posX / acc.sumWPos;
    pos[1] = acc.posY / acc.sumWPos;
    pos[2] = acc.posZ / acc.sumWPos;
    if (transformValuesChanged(world, target, 'pos', pos)) {
      fields |= 1;
    }
  }
  if (acc.sumWQuat > 0) {
    const qx = acc.quatX / acc.sumWQuat;
    const qy = acc.quatY / acc.sumWQuat;
    const qz = acc.quatZ / acc.sumWQuat;
    const qw = acc.quatW / acc.sumWQuat;
    const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (len > 0) {
      quat[0] = qx / len;
      quat[1] = qy / len;
      quat[2] = qz / len;
      quat[3] = qw / len;
      if (transformValuesChanged(world, target, 'quat', quat)) {
        fields |= 2;
      }
    }
  }
  if (acc.sumWScale > 0) {
    scale[0] = acc.scaleX / acc.sumWScale;
    scale[1] = acc.scaleY / acc.sumWScale;
    scale[2] = acc.scaleZ / acc.sumWScale;
    if (transformValuesChanged(world, target, 'scale', scale)) {
      fields |= 4;
    }
  }
  // World consumes these numeric arrays synchronously; it owns the stored pose.
  if (fields !== 0) world.set(target, Transform as never, scratch.partials[fields] as never);
}

function transformValuesChanged(
  world: World,
  target: EntityHandle,
  field: 'pos' | 'quat' | 'scale',
  values: number[],
): boolean {
  const current = readRenderArrayView(world, target, Transform, field);
  if (current === undefined || current.length !== values.length) return true;
  // Compare the f32 destination, including negative zero, so external author
  // writes are restored even when clip time has not moved.
  for (let index = 0; index < values.length; index++) {
    const value = values[index] as number;
    if (Number.isNaN(value) || !Object.is(current[index], Math.fround(value))) return true;
  }
  return false;
}

/**
 * Per-active-slot snapshot folded into the per-entity accumulator pass:
 * the resolved clip + the (advanced) sample time + the clamped weight, so
 * the channel loop never has to re-read the SoA columns.
 */
interface ActiveSlot {
  readonly clip: AnimationClip;
  readonly clipHandleRaw: number;
  readonly weight: number;
  readonly time: number;
  readonly slotIdx: number;
  readonly mask: CompiledAnimationMask | undefined;
  readonly interval: PlaybackInterval;
}

interface JointAccumulator {
  generation: number;
  target: EntityHandle;
  posX: number;
  posY: number;
  posZ: number;
  sumWPos: number;
  // Quat reference + accumulator. refQ* is the first sampled quat (sign-fixed)
  // so subsequent quats with dot<0 are negated for short-arc nlerp.
  refQX: number;
  refQY: number;
  refQZ: number;
  refQW: number;
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  sumWQuat: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  sumWScale: number;
}

interface MorphWeightAccumulator {
  readonly values: Float32Array;
  sumW: number;
}

interface PoseScratch {
  readonly entities: EntityHandle[];
  readonly targets: number[];
  generation: number;
  readonly joints: JointAccumulator[];
  readonly channelSample: number[];
  readonly pos: number[];
  readonly quat: number[];
  readonly scale: number[];
  readonly partials: readonly { pos?: number[]; quat?: number[]; scale?: number[] }[];
}

// Only numeric work survives calls; no component or asset object is retained.
// Nested evaluations borrow separate scratch instances.
const poseScratchByWorld = new WeakMap<World, PoseScratch[]>();

function createPoseScratch(): PoseScratch {
  const pos = [0, 0, 0];
  const quat = [0, 0, 0, 1];
  const scale = [1, 1, 1];
  return {
    entities: [],
    targets: [],
    joints: [],
    generation: 0,
    channelSample: [],
    pos,
    quat,
    scale,
    partials: [
      {},
      { pos },
      { quat },
      { pos, quat },
      { scale },
      { pos, scale },
      { quat, scale },
      { pos, quat, scale },
    ],
  };
}

function resetAccumulator(acc: JointAccumulator): void {
  acc.posX = 0;
  acc.posY = 0;
  acc.posZ = 0;
  acc.sumWPos = 0;
  acc.quatX = 0;
  acc.quatY = 0;
  acc.quatZ = 0;
  acc.quatW = 0;
  acc.sumWQuat = 0;
  acc.scaleX = 0;
  acc.scaleY = 0;
  acc.scaleZ = 0;
  acc.sumWScale = 0;
}

function createAccumulator(): JointAccumulator {
  return {
    generation: -1,
    target: 0 as EntityHandle,
    posX: 0,
    posY: 0,
    posZ: 0,
    sumWPos: 0,
    refQX: 0,
    refQY: 0,
    refQZ: 0,
    refQW: 1,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 0,
    sumWQuat: 0,
    scaleX: 0,
    scaleY: 0,
    scaleZ: 0,
    sumWScale: 0,
  };
}

/**
 * The `advanceAnimationPlayer` system token.
 *
 * Module-level `defineSystem` with the real fn body — no closure and no
 * feature-specific resolver resource. Handles resolve from the World passed
 * to the system, so invalid clips become structured animation failures.
 */
export const AdvanceAnimationPlayer: SystemHandle<readonly []> = defineSystem({
  name: ADVANCE_ANIMATION_PLAYER_SYSTEM,
  queries: [],
  before: ['propagateTransforms'],
  fn: (world) => {
    advanceAnimationPlayer(world, world.getResource(Time).delta);
  },
});

/**
 * Register `advanceAnimationPlayer` into the ECS schedule before
 * `propagateTransforms`. Animation clip handles are resolved from the running
 * World; callers only need to register the system once per World.
 *
 * @example Driver registers once per World:
 *   const world = new World();
 *   registerAdvanceAnimationPlayer(world);
 *   // ...system will run each world.update() before propagateTransforms...
 */
export function registerAdvanceAnimationPlayer(
  world: World,
  schedule: ScheduleToken = Update,
): () => void {
  world
    .addSystems(schedule, AnimationSet, [
      {
        ...AdvanceAnimationPlayer,
        before: [schedule === FixedUpdate ? 'propagateTransformsFixed' : 'propagateTransforms'],
        fn: (current) =>
          advanceAnimationPlayer(
            current,
            schedule === FixedUpdate
              ? current.getResource(FixedTime).delta
              : current.getResource(Time).delta,
          ),
      },
    ])
    .unwrap();
  return () => {
    world.removeSystem(schedule, ADVANCE_ANIMATION_PLAYER_SYSTEM);
  };
}
