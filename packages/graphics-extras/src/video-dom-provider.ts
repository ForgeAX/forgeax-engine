// A browser-realm VideoSourceProvider: one muted inline <video> element per
// (entity, clip), driven by the entity's VideoPlayer play state. This is the
// provider every DOM host used to hand-write; the engine itself still never
// decodes video bytes. A Worker realm has no HTMLVideoElement, so this helper
// refuses to install there (see `installDomVideoSourceProvider`).

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { type AssetHandle, err, ok, type Result, type VideoAsset } from '@forgeax/engine-types';
import { VideoPlayer } from './video-player';
import { VIDEO_SOURCE_PROVIDER_KEY, type VideoSourceProvider } from './video-source-provider';

/** Structured refusal when the current realm cannot create `<video>` elements. */
export interface VideoDomUnavailableError {
  readonly code: 'video-dom-unavailable';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly realm: 'worker' | 'non-browser' };
}

/** The installed provider plus explicit element lifetime control. */
export interface DomVideoSourceProvider extends VideoSourceProvider {
  /** The live element for one consumer, if one was created. */
  element(entity: EntityHandle, clip: AssetHandle<'video'>): HTMLVideoElement | undefined;
  /** Stop and drop every element owned by `entity`. */
  release(entity: EntityHandle): void;
  /** Stop and drop every element and remove the World resource. */
  dispose(): void;
}

export interface DomVideoSourceOptions {
  /** Defaults to `document`. Injected by tests and embedded hosts. */
  readonly document?: Pick<Document, 'createElement'>;
  /** Defaults to true; browsers only autoplay muted media without a gesture. */
  readonly muted?: boolean;
  /** Defaults to `'anonymous'` so cross-origin clips stay sampleable by WebGPU. */
  readonly crossOrigin?: '' | 'anonymous' | 'use-credentials';
}

function realmError(): VideoDomUnavailableError {
  const worker =
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
  return {
    code: 'video-dom-unavailable',
    expected: 'a browser window realm that can create HTMLVideoElement',
    hint: worker
      ? "the Engine Worker has no DOM: run the Engine realm locally (FORGEAX_EXECUTION_WORKERS='{\"engine\":false}') or let App's startEngineWorker bridge page video frames (installWorkerVideoSourceProvider)"
      : 'pass options.document, or install the provider from browser code',
    detail: { realm: worker ? 'worker' : 'non-browser' },
  };
}

/**
 * Install a DOM `VideoSourceProvider` on `world` under
 * `VIDEO_SOURCE_PROVIDER_KEY`. For each renderable whose material samples a
 * VideoAsset, the provider creates one `<video>` from the asset's URL and
 * applies the entity's `VideoPlayer.playing` / `loop` every frame (the Three
 * equivalent is `new VideoTexture(video)` plus `video.play()`). An entity
 * without a VideoPlayer plays its clip looped, like a Three `VideoTexture`
 * whose element the page started. Render publication calls `getSource`, so
 * the provider only reads the World; read the playhead from `element()`.
 */
export function installDomVideoSourceProvider(
  world: World,
  options: DomVideoSourceOptions = {},
): Result<DomVideoSourceProvider, VideoDomUnavailableError> {
  const doc =
    options.document ??
    (typeof document === 'undefined' ? undefined : (document as Pick<Document, 'createElement'>));
  if (doc === undefined) return err(realmError());
  const elements = new Map<EntityHandle, Map<AssetHandle<'video'>, HTMLVideoElement>>();
  const stop = (video: HTMLVideoElement) => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
  const create = (url: string): HTMLVideoElement => {
    const video = doc.createElement('video');
    video.muted = options.muted ?? true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = options.crossOrigin ?? 'anonymous';
    video.src = url;
    video.load();
    return video;
  };
  const provider: DomVideoSourceProvider = {
    getSource(entity, clip) {
      let rows = elements.get(entity);
      let video = rows?.get(clip);
      if (video === undefined) {
        const asset = world.assets?.read<'video', VideoAsset>(clip);
        if (asset === undefined || !asset.ok) return undefined;
        video = create(asset.value.url);
        if (rows === undefined) {
          rows = new Map();
          elements.set(entity, rows);
        }
        rows.set(clip, video);
      }
      const player = world.hasComponent(entity, VideoPlayer)
        ? world.get(entity, VideoPlayer).unwrap()
        : undefined;
      const playing = player?.playing ?? true;
      video.loop = player?.loop ?? true;
      if (playing && video.paused) void video.play().catch(() => undefined);
      else if (!playing && !video.paused) video.pause();
      return video;
    },
    element(entity, clip) {
      return elements.get(entity)?.get(clip);
    },
    release(entity) {
      for (const video of elements.get(entity)?.values() ?? []) stop(video);
      elements.delete(entity);
    },
    dispose() {
      for (const rows of elements.values()) for (const video of rows.values()) stop(video);
      elements.clear();
      if (world.hasResource(VIDEO_SOURCE_PROVIDER_KEY))
        world.removeResource(VIDEO_SOURCE_PROVIDER_KEY);
    },
  };
  world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, provider);
  return ok(provider);
}
