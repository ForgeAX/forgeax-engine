import { Disabled, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { createStateProjection } from '@forgeax/engine-ecs/projection';
import { GlobalTransform } from '@forgeax/engine-scene';
import { AudioError } from '@forgeax/engine-types';
import type { AudioBackend, AudioPlayOptions, AudioSourcePose, BusName } from './audio-backend';
import { AudioSource } from './components';

/** Scene and listener forward both use local -Z. Scale does not affect direction. */
export function sourcePoseFromWorldMatrix(world: Float32Array): AudioSourcePose {
  const length = Math.hypot(world[8] ?? 0, world[9] ?? 0, world[10] ?? 0);
  return {
    positionX: world[12] ?? 0,
    positionY: world[13] ?? 0,
    positionZ: world[14] ?? 0,
    forwardX: length > 0 ? -(world[8] ?? 0) / length : 0,
    forwardY: length > 0 ? -(world[9] ?? 0) / length : 0,
    forwardZ: length > 0 ? -(world[10] ?? 0) / length : -1,
  };
}

export function listenerPoseFromWorldMatrix(world: Float32Array) {
  const upLength = Math.hypot(world[4] ?? 0, world[5] ?? 0, world[6] ?? 0) || 1;
  return {
    ...sourcePoseFromWorldMatrix(world),
    upX: (world[4] ?? 0) / upLength,
    upY: (world[5] ?? 0) / upLength,
    upZ: (world[6] ?? 0) / upLength,
  };
}

const ORIGIN_SOURCE_POSE: AudioSourcePose = {
  positionX: 0,
  positionY: 0,
  positionZ: 0,
  forwardX: 0,
  forwardY: 0,
  forwardZ: -1,
};

function samePose(left: AudioSourcePose | undefined, right: AudioSourcePose): boolean {
  return (
    left !== undefined &&
    left.positionX === right.positionX &&
    left.positionY === right.positionY &&
    left.positionZ === right.positionZ &&
    left.forwardX === right.forwardX &&
    left.forwardY === right.forwardY &&
    left.forwardZ === right.forwardZ
  );
}

interface SourceState {
  entity: EntityHandle;
  bus: string;
  fromPosition: number;
  pose: AudioSourcePose | undefined;
  spatial: boolean;
  volume: number;
  playbackRate: number;
  paused: boolean;
}

type TickBackend = Omit<AudioBackend, 'music'>;

function createTickState(world: World) {
  const query = world.query({ read: [AudioSource], optional: [GlobalTransform] });
  if (!query.ok) return;
  return {
    query: query.value,
    projection: createStateProjection(
      world,
      [AudioSource, GlobalTransform, Disabled],
      [AudioSource],
    ),
    // Only accepted playing controls belong here. Clip content stays with assets
    // and each publication; idle sources have no parallel Audio metadata.
    sources: new Map<number, SourceState>(),
    retry: new Set<number>(),
  };
}

const states = new WeakMap<
  World,
  WeakMap<TickBackend, NonNullable<ReturnType<typeof createTickState>>>
>();

function stateFor(world: World, backend: TickBackend) {
  let backends = states.get(world);
  if (backends === undefined) {
    backends = new WeakMap();
    states.set(world, backends);
  }
  let state = backends.get(backend);
  if (state === undefined) {
    state = createTickState(world);
    if (state !== undefined) backends.set(backend, state);
  }
  return state;
}

export function audioTickSystem(world: World, backend: TickBackend): void {
  const state = stateFor(world, backend);
  if (state === undefined) return;
  const batch = state.projection.read();
  for (const index of batch.indices) state.retry.add(index);
  for (const index of state.retry) {
    try {
      const entity = state.projection.entity(index);
      const row = entity === undefined ? undefined : state.query.at(entity);
      let previous = state.sources.get(index);
      // Generations and query membership are authoritative even if no stop edge
      // was sampled between removal and a replacement at the same source index.
      if (previous !== undefined && (previous.entity !== entity || row === undefined)) {
        backend.stop(previous.entity);
        state.sources.delete(index);
        previous = undefined;
      }
      const source = row?.get(AudioSource);
      if (source === undefined || source.playing !== true) {
        if (previous !== undefined) {
          backend.stop(previous.entity);
          state.sources.delete(index);
        }
        state.retry.delete(index);
        continue;
      }
      if (entity === undefined) continue;
      const spatial = previous?.spatial ?? source.spatialBlend > 0;
      const matrix = spatial ? row?.get(GlobalTransform)?.world : undefined;
      const pose = spatial
        ? matrix === undefined
          ? ORIGIN_SOURCE_POSE
          : sourcePoseFromWorldMatrix(matrix)
        : undefined;
      if (previous === undefined) {
        if (world.assets === undefined) continue;
        const options: AudioPlayOptions = {
          fromPosition: source.fromPosition,
          loop: source.loop === true,
          volume: source.volume,
          paused: source.paused,
          playbackRate: source.playbackRate,
          spatialBlend: source.spatialBlend,
          bus: source.bus as BusName,
          ...(pose === undefined ? {} : { sourcePose: pose }),
          coneInnerAngle: source.coneInnerAngle,
          coneOuterAngle: source.coneOuterAngle,
          coneOuterGain: source.coneOuterGain,
        };
        backend.play(entity, world.assets, source.clip, options);
        state.sources.set(index, {
          entity,
          bus: source.bus,
          fromPosition: source.fromPosition,
          spatial,
          pose,
          volume: source.volume,
          playbackRate: source.playbackRate,
          paused: source.paused,
        });
      } else {
        if (pose !== undefined && !samePose(previous.pose, pose)) {
          backend.setSourcePose(entity, pose);
          previous.pose = pose;
        }
        if (previous.bus !== source.bus) backend.setBus(entity, source.bus);
        previous.bus = source.bus;
        if (previous.volume !== source.volume) backend.setVolume(entity, source.volume);
        previous.volume = source.volume;
        if (previous.playbackRate !== source.playbackRate)
          backend.setPlaybackRate(entity, source.playbackRate);
        previous.playbackRate = source.playbackRate;
        if (previous.paused !== source.paused) backend.setPaused(entity, source.paused);
        previous.paused = source.paused;
        if (previous.fromPosition !== source.fromPosition)
          backend.seek(entity, source.fromPosition);
        previous.fromPosition = source.fromPosition;
      }
      state.retry.delete(index);
    } catch (cause) {
      // Keep only accepted controls and retry this exact source index after a
      // transport failure. Other source mutations can still be accepted now.
      if (!(cause instanceof AudioError)) throw cause;
    }
  }
  batch.accept();
}
