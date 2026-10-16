// @forgeax/engine-animation -- evaluateAnimationGraph system (post-order DAG eval).
//
// feat-20260713-animation-state-machine-plugin M3 / w25 (plan D-2 independent
// before-advance system, D-7 eval owns time):
//
// This is the "graph -> N-slot" seam. It runs BEFORE advanceAnimationPlayer (the
// "N-slot -> pose" seam) and is the SOLE writer of the derived slot columns for
// entities carrying an AnimationGraph handle (AnimationPlayer.graph != 0):
//
//   1. Resolve the shared<AnimationGraph> handle to its POD.
//   2. Resolve every clip leaf's shared<AnimationClip> BEFORE writing anything --
//      a dangling handle throws the structured animation asset error so no
//      dirty pose is left (AC-04 / AC-11).
//   3. Post-order evaluate effective weights: effective = runtime weight
//      (nodeWeights, default 1) x graph static weight (AC-07 orthogonal product);
//      Blend normalizes its children (AC-04), Add stacks additive layers without
//      normalization (AC-05), nesting propagates a subtree's normalized weight
//      down before its parent combines it (AC-06).
//   4. Advance each clip node's seek-time by nodeSpeeds*dt (wrap/clamp reusing
//      advance's looping logic) and persist it back to nodeTimes (D-7: eval owns
//      the time SSOT).
//   5. Spread one derived slot per clip leaf into the variable clips[] / times[]
//      / weights[] columns and park speeds[]=0 so advance does not re-advance the
//      time (D-7). advance's blend math is left completely unchanged (D-2).
//
// Entities without a graph (graph == 0) are left untouched -- their slots stay
// the direct-write SSOT (single evaluation path, plan D-3). advance's mixing
// math never branches on graph mode; it just consumes whatever fills the slots.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import {
  defineSystem,
  FixedTime,
  FixedUpdate,
  type ScheduleToken,
  Time,
  Update,
} from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import type { AnimationClip, AnimationGraph, Handle } from '@forgeax/engine-types';
import { resolveAnimationMask } from '../animation-mask';
import { AnimationPlayer } from '../animation-player';
import { AnimationBlendError } from '../blend-errors';
import {
  clearPlaybackIntervals,
  type PlaybackInterval,
  playbackInterval,
  sampleTime,
  stageGraphIntervals,
} from '../playback-interval';
import { resolveAnimationAsset } from '../resolve-animation-asset';
import { collectTimelineEvents } from '../timeline';
import { ADVANCE_ANIMATION_PLAYER_SYSTEM } from './advance-animation-player';

/**
 * System name used when `registerEvaluateAnimationGraph` installs the system.
 * External consumers can reference this constant to declare ordering against the
 * graph-evaluation seam.
 */
export const EVALUATE_ANIMATION_GRAPH_SYSTEM = 'evaluateAnimationGraph' as const;

export type AnimationPayloadLookup = (
  guid: string,
) => AnimationClip | { readonly code: 'stale' } | undefined;

/**
 * Resolved per-entity graph-mode columns (a `world.get` snapshot). `graph` is the
 * raw shared handle (0 = no graph); the three node-* columns are per-node runtime
 * knobs indexed by graph node index.
 */
interface PlayerGraphColumns {
  readonly graph: number;
  readonly nodeWeights: Float32Array;
  readonly nodeTimes: Float64Array;
  readonly nodeSpeeds: Float32Array;
  readonly nodeMasks: Uint32Array;
  readonly paused: boolean;
  readonly looping: boolean;
}

/** Read `arr[i]` when in range, else the default (missing per-node knobs default). */
function readAt(arr: ArrayLike<number>, i: number, dflt: number): number {
  return i >= 0 && i < arr.length ? (arr[i] ?? dflt) : dflt;
}

/**
 * Evaluate every graph-carrying AnimationPlayer for one frame, filling the
 * derived N-slot columns. Iterates rows through the system Query (like advance),
 * collecting entity handles first, then resolving + writing each player outside
 * the transient row facade.
 */
export function evaluateAnimationGraph(
  world: World,
  dt: number,
  lookup: AnimationPayloadLookup = () => undefined,
): void {
  clearPlaybackIntervals(world);
  const query = world.query({ with: [AnimationPlayer] }).unwrap();

  const entities: EntityHandle[] = [];
  for (const row of query) entities.push(row.entity);

  for (const entityRaw of entities) {
    evaluateOneEntity(world, entityRaw, dt, lookup);
  }
}

/**
 * Evaluate one entity's AnimationGraph into its derived slots. No-op when the
 * entity has no graph (graph == 0). Every non-zero graph or clip handle is
 * resolved through the World-local animation lookup and invalid handles throw
 * a structured animation error before any derived write (AC-04 / AC-11).
 */
function evaluateOneEntity(
  world: World,
  entityRaw: number,
  dt: number,
  lookup: AnimationPayloadLookup,
): void {
  const entity = entityRaw as EntityHandle;
  // Direct playback needs only this scalar probe, not every variable graph column.
  const graphRaw = world[worldRead].getFieldValue(entity, AnimationPlayer, 'graph');
  if (graphRaw === undefined || graphRaw === 0) return;
  const apRes = world.get(entity, AnimationPlayer);
  if (!apRes.ok) return;
  const ap = apRes.value as unknown as PlayerGraphColumns;

  const graphLookup = resolveAssetHandle<AnimationGraph>(
    world,
    graphRaw as Handle<string, 'shared'>,
  );
  if (!graphLookup.ok) throw graphLookup.error;
  const graph = graphLookup.value;

  const nodes = graph.nodes;
  if (nodes.length === 0) return; // construction rejects empty graphs; guard anyway.
  if (ap.nodeMasks.length > nodes.length) {
    throw new AnimationBlendError('animation-player-mask-length-mismatch', {
      entity: entityRaw,
      field: 'nodeMasks',
      expectedLength: nodes.length,
      actualLength: ap.nodeMasks.length,
    });
  }
  for (let i = 0; i < ap.nodeMasks.length; i++) {
    const handle = ap.nodeMasks[i] ?? 0;
    if (handle === 0) continue;
    if (nodes[i]?.type !== 'clip') {
      throw new AnimationBlendError('animation-mask-invalid', {
        reason: 'nodeMasks may only name clip nodes',
        index: i,
      });
    }
    resolveAnimationMask(world, handle);
  }

  // Collect clip leaves (ascending node index) and resolve every clip BEFORE any
  // write (AC-11: a dangling handle must not leave a dirty pose).
  const clipNodeIndices: number[] = [];
  const clipHandles: Handle<'AnimationClip', 'shared'>[] = [];
  const clips: AnimationClip[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === undefined || node.type !== 'clip') continue;
    const clipLookup = resolveAnimationAsset<AnimationClip>(
      world,
      node.clip,
      'animation-clip',
      (guid) => {
        return lookup(guid);
      },
    );
    if (!clipLookup.ok) throw clipLookup.error;
    const handle = clipLookup.value.handle;
    clipNodeIndices.push(i);
    clipHandles.push(handle);
    clips.push(clipLookup.value.asset);
  }

  // Post-order effective-weight evaluation from the root (incoming influence 1).
  const effByNode = new Map<number, number>();
  const runtimeWeight = (n: number): number => readAt(ap.nodeWeights, n, 1);
  const evalNode = (nodeIndex: number, incoming: number): void => {
    const node = nodes[nodeIndex];
    if (node === undefined) return;
    const eff = incoming * runtimeWeight(nodeIndex) * node.weight;
    switch (node.type) {
      case 'clip':
        effByNode.set(nodeIndex, (effByNode.get(nodeIndex) ?? 0) + eff);
        return;
      case 'blend': {
        let total = 0;
        for (const child of node.children)
          total += runtimeWeight(child) * (nodes[child]?.weight ?? 0);
        if (total > 0) {
          for (const child of node.children) evalNode(child, eff / total);
        }
        return;
      }
      case 'add':
        evalNode(node.base, eff);
        for (const layer of node.additive) evalNode(layer, eff);
        return;
    }
  };
  evalNode(graph.root, 1);

  // Advance each clip node's seek-time (D-7: eval owns the time). Persist the full
  // per-node time column so it stays bounded frame-to-frame.
  const newNodeTimes = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) newNodeTimes[i] = readAt(ap.nodeTimes, i, 0);
  const intervals: PlaybackInterval[] = [];
  for (let k = 0; k < clipNodeIndices.length; k++) {
    // biome-ignore lint/style/noNonNullAssertion: parallel to clipNodeIndices
    const nodeIndex = clipNodeIndices[k]!;
    // biome-ignore lint/style/noNonNullAssertion: parallel to clipNodeIndices
    const clip = clips[k]!;
    const current = readAt(ap.nodeTimes, nodeIndex, 0);
    const speed = readAt(ap.nodeSpeeds, nodeIndex, 0);
    const interval = playbackInterval(
      clip,
      clipHandles[k] ?? 0,
      k,
      current,
      ap.paused ? 0 : speed * dt,
      ap.looping,
    );
    intervals.push(interval);
    newNodeTimes[nodeIndex] = sampleTime(interval.to, clip.duration, ap.looping);
  }

  // Spread one derived slot per clip leaf into the variable columns; speeds[]=0
  // parks the time so advance does not re-advance it (D-7).
  const slotCount = clipNodeIndices.length;
  const times = new Float64Array(slotCount);
  const weights = new Float32Array(slotCount);
  const speeds = new Float32Array(slotCount);
  const masks =
    ap.nodeMasks.length === 0
      ? []
      : clipNodeIndices.map((nodeIndex) => ap.nodeMasks[nodeIndex] ?? 0);
  for (let k = 0; k < slotCount; k++) {
    // biome-ignore lint/style/noNonNullAssertion: parallel to clipNodeIndices
    const nodeIndex = clipNodeIndices[k]!;
    weights[k] = effByNode.get(nodeIndex) ?? 0;
    times[k] = newNodeTimes[nodeIndex] ?? 0;
    speeds[k] = 0;
  }

  // Validate bounded effects before committing graph clocks. Pose publication remains deferred.
  collectTimelineEvents(
    entity,
    intervals.filter((_, slot) => (weights[slot] ?? 0) > 0),
  );
  stageGraphIntervals(world, entity, intervals);
  world.set(entity, AnimationPlayer, {
    clips: clipHandles,
    times,
    weights,
    speeds,
    masks,
    nodeTimes: newNodeTimes,
  });
}

/**
 * The `evaluateAnimationGraph` system token. Runs `before` advanceAnimationPlayer
 * (plan D-2 / R-5) so the derived slots are ready when advance blends them, and
 * is labelled `'animation'`. Registered by the default `animationPlugin` (w26),
 * so it is on the default path (AC-09), not opt-in.
 */
export const EvaluateAnimationGraph: SystemHandle<readonly []> = defineSystem({
  name: EVALUATE_ANIMATION_GRAPH_SYSTEM,
  queries: [],
  before: [ADVANCE_ANIMATION_PLAYER_SYSTEM],
  fn: (world) => {
    evaluateAnimationGraph(world, world.getResource(Time).delta);
  },
});

/**
 * Register `evaluateAnimationGraph` into the ECS schedule (before
 * advanceAnimationPlayer). Called by `animationPlugin` so both createApp forms
 * get graph evaluation on the default path for free.
 */
export function registerEvaluateAnimationGraph(
  world: World,
  lookup: AnimationPayloadLookup = () => undefined,
  schedule: ScheduleToken = Update,
): () => void {
  world
    .addSystem(schedule, {
      name: EVALUATE_ANIMATION_GRAPH_SYSTEM,
      queries: [],
      before: [ADVANCE_ANIMATION_PLAYER_SYSTEM],
      fn: (world) => {
        evaluateAnimationGraph(
          world,
          schedule === FixedUpdate
            ? world.getResource(FixedTime).delta
            : world.getResource(Time).delta,
          lookup,
        );
      },
    })
    .unwrap();
  return () => {
    world.removeSystem(schedule, EVALUATE_ANIMATION_GRAPH_SYSTEM);
  };
}
