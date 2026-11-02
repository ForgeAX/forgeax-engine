// Engine Worker half of the page video bridge. The Worker has no DOM, so it
// cannot own a <video>; it announces each (renderable, clip) consumer to the
// page, which plays the element and transfers decoded frames back. This
// provider keeps the newest frame per consumer and hands it to the Renderer
// through the ordinary VideoSourceProvider seam, where a `texture_external`
// slot imports it zero-copy and every other slot copies it.

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { type AssetHandle, err, ok, type Result, type VideoAsset } from '@forgeax/engine-types';
import {
  closeFrameSource,
  isVideoFrameNotice,
  type VideoFrameBridgeError,
  type VideoFrameNotice,
  type VideoFramePort,
  type VideoFrameRequest,
  videoFrameBridgeError,
} from './video-frame-protocol';
import { VideoPlayer } from './video-player';
import { VIDEO_SOURCE_PROVIDER_KEY, type VideoSourceProvider } from './video-source-provider';

/** Worker end of one page port: id allocation and notice routing for every provider on it. */
export interface VideoFrameEndpoint {
  send(request: VideoFrameRequest): void;
  claim(id: number, sink: (notice: VideoFrameNotice) => void): void;
  drop(id: number): void;
  nextId(): number;
  /** Detach and close the port. Frames that arrive for no consumer are closed on receipt. */
  close(): void;
}

/**
 * Wrap the Worker end of a page `MessagePort`. One endpoint outlives World
 * rebuilds: an old and a new World may share it while the old one retires,
 * because consumer ids never repeat on one endpoint.
 */
export function createVideoFrameEndpoint(port: VideoFramePort): VideoFrameEndpoint {
  const sinks = new Map<number, (notice: VideoFrameNotice) => void>();
  let lastId = 0;
  let closed = false;
  const onMessage = (event: MessageEvent): void => {
    const notice: unknown = event.data;
    if (!isVideoFrameNotice(notice)) return;
    const sink = sinks.get(notice.id);
    if (sink !== undefined) sink(notice);
    else if (notice.kind === 'video-frame') closeFrameSource(notice.frame);
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return {
    send(request) {
      if (!closed) port.postMessage(request);
    },
    claim: (id, sink) => void sinks.set(id, sink),
    drop: (id) => void sinks.delete(id),
    nextId: () => ++lastId,
    close() {
      if (closed) return;
      closed = true;
      sinks.clear();
      port.removeEventListener('message', onMessage);
      port.close();
    },
  };
}

/** Observable bridge state for one consumer. */
export interface VideoFrameConsumerStatus {
  readonly id: number;
  /** A frame is bound for sampling. */
  readonly hasFrame: boolean;
  /** Frames received from the page. */
  readonly received: number;
  /** Received frames replaced before the Renderer saw them (closed on drop). */
  readonly dropped: number;
}

export interface WorkerVideoSourceProvider extends VideoSourceProvider {
  /**
   * `undefined` until the Renderer first asks for this consumer. A page-side
   * failure (autoplay refused, load or capture failed) is the error.
   */
  status(
    entity: EntityHandle,
    clip: AssetHandle<'video'>,
  ): Result<VideoFrameConsumerStatus | undefined, VideoFrameBridgeError>;
  /** Ask the page to retry refused play() calls. Most effective inside a user gesture. */
  resume(): void;
  /** One frame step: publish play state, release despawned consumers, promote frames. */
  sync(): void;
  /** Stop the page elements and close the frames owned by `entity`. */
  release(entity: EntityHandle): void;
  /** Release every consumer, remove the sync system and the World resource. */
  dispose(): void;
}

export interface WorkerVideoSourceOptions {
  /** Defaults to the realm `VideoFrame`. Injected by tests. */
  readonly videoFrame?: typeof VideoFrame;
}

/** Name of the Update system that runs `provider.sync()` once per frame. */
export const VIDEO_FRAME_SYNC_SYSTEM = 'forgeax:video-frame-sync';

interface PlayState {
  readonly playing: boolean;
  readonly loop: boolean;
}

/** Same default as the DOM provider: a renderable without VideoPlayer plays looped. */
function playState(world: World, entity: EntityHandle): PlayState {
  if (!world.hasComponent(entity, VideoPlayer)) return { playing: true, loop: true };
  const player = world.get(entity, VideoPlayer).unwrap();
  return { playing: player.playing, loop: player.loop };
}

/** One (entity, clip) consumer. It owns at most two frames: the bound one and the newest. */
class FrameConsumer {
  current: VideoFrame | undefined;
  pending: VideoFrame | undefined;
  received = 0;
  dropped = 0;
  error: VideoFrameBridgeError | null = null;

  constructor(
    readonly id: number,
    readonly entity: EntityHandle,
    readonly clip: AssetHandle<'video'>,
    public state: PlayState,
  ) {}

  /** Latest wins: a newer frame closes the unseen one. */
  adopt(frame: VideoFrame): void {
    this.received++;
    if (this.pending !== undefined) {
      this.pending.close();
      this.dropped++;
    }
    this.pending = frame;
  }

  /** Bind the newest frame. The previous one was submitted last frame, so it can close. */
  promote(): void {
    if (this.pending === undefined) return;
    this.current?.close();
    this.current = this.pending;
    this.pending = undefined;
  }

  close(): void {
    this.current?.close();
    this.pending?.close();
    this.current = undefined;
    this.pending = undefined;
  }

  status(): VideoFrameConsumerStatus {
    return {
      id: this.id,
      hasFrame: this.current !== undefined,
      received: this.received,
      dropped: this.dropped,
    };
  }
}

/** Wrap a transferred ImageBitmap so every sampler sees a VideoFrame; the bitmap closes here. */
function toVideoFrame(
  source: VideoFrame | ImageBitmap,
  timestamp: number,
  Frame: typeof VideoFrame,
): VideoFrame {
  if (source instanceof Frame) return source;
  try {
    return new Frame(source as ImageBitmap, { timestamp });
  } finally {
    closeFrameSource(source);
  }
}

const installed = new WeakMap<World, WorkerVideoSourceProvider>();

/**
 * Install the Engine Worker `VideoSourceProvider`. The Three equivalent is a
 * `VideoTexture` whose element lives on the page: the page plays one muted
 * inline `<video>` per (renderable, clip), follows that entity's
 * `VideoPlayer.playing` / `loop`, and transfers each new frame
 * (`requestVideoFrameCallback`) with one frame in flight per consumer.
 * Refuses a realm without WebCodecs `VideoFrame` with `video-frame-unsupported`.
 * Installing again on the same World replaces the previous provider.
 */
export function installWorkerVideoSourceProvider(
  world: World,
  endpoint: VideoFrameEndpoint,
  options: WorkerVideoSourceOptions = {},
): Result<WorkerVideoSourceProvider, VideoFrameBridgeError> {
  const Frame = options.videoFrame ?? (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
  if (typeof Frame !== 'function')
    return err(
      videoFrameBridgeError('video-frame-unsupported', {
        reason: 'VideoFrame is not defined in the Engine realm',
      }),
    );
  installed.get(world)?.dispose();
  const provider = createProvider(world, endpoint, Frame);
  const update = world.scheduleToken('Update');
  world
    .addSystem(update, {
      name: VIDEO_FRAME_SYNC_SYSTEM,
      queries: [],
      commands: 'none',
      fn: () => provider.sync(),
    })
    .unwrap();
  world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, provider);
  installed.set(world, provider);
  return ok(provider);
}

function createProvider(
  world: World,
  endpoint: VideoFrameEndpoint,
  Frame: typeof VideoFrame,
): WorkerVideoSourceProvider {
  const consumers = new Map<EntityHandle, Map<AssetHandle<'video'>, FrameConsumer>>();
  const receive = (consumer: FrameConsumer, notice: VideoFrameNotice): void => {
    if (notice.kind === 'video-status') {
      consumer.error = notice.error;
      return;
    }
    try {
      consumer.adopt(toVideoFrame(notice.frame, notice.timestamp, Frame));
    } catch (cause) {
      consumer.error = videoFrameBridgeError('video-frame-capture-failed', {
        reason: String(cause),
      });
    }
    endpoint.send({ kind: 'video-ack', id: consumer.id });
  };
  const open = (entity: EntityHandle, clip: AssetHandle<'video'>): FrameConsumer | undefined => {
    const asset = world.assets?.read<'video', VideoAsset>(clip);
    if (asset === undefined || !asset.ok) return undefined;
    const consumer = new FrameConsumer(endpoint.nextId(), entity, clip, playState(world, entity));
    endpoint.claim(consumer.id, (notice) => receive(consumer, notice));
    let rows = consumers.get(entity);
    if (rows === undefined) {
      rows = new Map();
      consumers.set(entity, rows);
    }
    rows.set(clip, consumer);
    endpoint.send({ kind: 'video-open', id: consumer.id, url: asset.value.url, ...consumer.state });
    return consumer;
  };
  const retire = (consumer: FrameConsumer): void => {
    endpoint.drop(consumer.id);
    endpoint.send({ kind: 'video-release', id: consumer.id });
    consumer.close();
  };
  const publishState = (consumer: FrameConsumer): void => {
    const next = playState(world, consumer.entity);
    if (next.playing === consumer.state.playing && next.loop === consumer.state.loop) return;
    consumer.state = next;
    endpoint.send({ kind: 'video-state', id: consumer.id, ...next });
  };
  const provider: WorkerVideoSourceProvider = {
    getSource(entity, clip) {
      const consumer = consumers.get(entity)?.get(clip) ?? open(entity, clip);
      return consumer?.current;
    },
    status(entity, clip) {
      const consumer = consumers.get(entity)?.get(clip);
      if (consumer?.error) return err(consumer.error);
      return ok(consumer?.status());
    },
    resume: () => endpoint.send({ kind: 'video-resume' }),
    sync() {
      for (const [entity, rows] of consumers) {
        if (!world.componentsOf(entity).ok) {
          provider.release(entity);
          continue;
        }
        for (const consumer of rows.values()) {
          publishState(consumer);
          consumer.promote();
        }
      }
    },
    release(entity) {
      for (const consumer of consumers.get(entity)?.values() ?? []) retire(consumer);
      consumers.delete(entity);
    },
    dispose() {
      for (const entity of [...consumers.keys()]) provider.release(entity);
      if (installed.get(world) !== provider) return;
      installed.delete(world);
      world.removeSystem(world.scheduleToken('Update'), VIDEO_FRAME_SYNC_SYSTEM);
      if (
        world.hasResource(VIDEO_SOURCE_PROVIDER_KEY) &&
        world.getResource(VIDEO_SOURCE_PROVIDER_KEY) === provider
      )
        world.removeResource(VIDEO_SOURCE_PROVIDER_KEY);
    },
  };
  return provider;
}
