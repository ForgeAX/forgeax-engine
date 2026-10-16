import type { World } from '@forgeax/engine-ecs';
import { GlobalTransform } from '@forgeax/engine-scene';
import type { AudioClipAsset } from '@forgeax/engine-types';
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

export type EdgeAction = 'none' | 'play-start' | 'play-stop';

export function detectEdge(previous: boolean, current: boolean): EdgeAction {
  if (!previous && current) return 'play-start';
  if (previous && !current) return 'play-stop';
  return 'none';
}

export function detectRemovedEntities(
  previous: readonly number[],
  current: readonly number[],
): number[] {
  const currentSet = new Set(current);
  return previous.filter((entity) => !currentSet.has(entity));
}

interface SourceState {
  bus: string;
  fromPosition: number;
  pose: AudioSourcePose | undefined;
  spatial: boolean;
  playing: boolean;
  volume: number;
  playbackRate: number;
  paused: boolean;
}

const states = new WeakMap<Omit<AudioBackend, 'music'>, Map<number, SourceState>>();

function stateFor(backend: Omit<AudioBackend, 'music'>): Map<number, SourceState> {
  const existing = states.get(backend);
  if (existing !== undefined) return existing;
  const created = new Map<number, SourceState>();
  states.set(backend, created);
  return created;
}

export function createClipResolver(
  world: World,
): (clipHandle: number) => AudioClipAsset | undefined {
  return (clipHandle) => {
    const resolved = world.sharedRefs.resolve<string, AudioClipAsset>(
      clipHandle as unknown as Parameters<typeof world.sharedRefs.resolve>[0],
    );
    return resolved.ok && resolved.value.kind === 'audio' ? resolved.value : undefined;
  };
}

export function audioTickSystem(world: World, backend: Omit<AudioBackend, 'music'>): void {
  const states = stateFor(backend);
  const resolveClip = createClipResolver(world);
  const currentEntities = new Set<number>();
  const query = world.query({ read: [AudioSource], optional: [GlobalTransform] });
  if (!query.ok) return;
  for (const queryRow of query.value) {
    const entity = queryRow.entity as number;
    const source = queryRow.get(AudioSource);
    const playing = source.playing === true;
    let previous = states.get(entity);
    if (previous === undefined) {
      previous = {
        pose: undefined,
        spatial: false,
        bus: source.bus,
        playing: false,
        fromPosition: source.fromPosition,
        volume: source.volume,
        playbackRate: source.playbackRate,
        paused: source.paused,
      };
      states.set(entity, previous);
    }
    const spatial = previous.playing ? previous.spatial : source.spatialBlend > 0;
    const matrix = spatial && playing ? queryRow.get(GlobalTransform)?.world : undefined;
    const pose =
      spatial && playing
        ? matrix === undefined
          ? ORIGIN_SOURCE_POSE
          : sourcePoseFromWorldMatrix(matrix)
        : undefined;
    const edge = detectEdge(previous.playing, playing);
    if (edge === 'play-start') {
      const clip = resolveClip(source.clip as number);
      if (clip !== undefined) {
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
        backend.play(entity, clip, options);
        previous.bus = source.bus;
        previous.playing = true;
        previous.fromPosition = source.fromPosition;
        previous.spatial = spatial;
        previous.pose = pose;
        previous.volume = source.volume;
        previous.playbackRate = source.playbackRate;
        previous.paused = source.paused;
      }
    } else {
      previous.playing = playing;
      if (edge === 'play-stop') {
        backend.stop(entity);
      } else if (playing) {
        if (pose !== undefined && !samePose(previous.pose, pose)) {
          backend.setSourcePose(entity, pose);
          previous.pose = pose;
        }
        if (previous.bus !== source.bus) backend.setBus(entity, source.bus);
        previous.bus = source.bus;
        if (previous.volume !== source.volume) backend.setVolume(entity, source.volume);
        if (previous.playbackRate !== source.playbackRate)
          backend.setPlaybackRate(entity, source.playbackRate);
        if (previous.paused !== source.paused) backend.setPaused(entity, source.paused);
        if (previous.fromPosition !== source.fromPosition)
          backend.seek(entity, source.fromPosition);
        previous.fromPosition = source.fromPosition;
        previous.volume = source.volume;
        previous.playbackRate = source.playbackRate;
        previous.paused = source.paused;
      }
    }
    currentEntities.add(entity);
  }
  for (const [entity, source] of states) {
    if (currentEntities.has(entity)) continue;
    if (source.playing) backend.stop(entity);
    states.delete(entity);
  }
}
