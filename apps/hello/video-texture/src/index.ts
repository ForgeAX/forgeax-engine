// apps/hello/video-texture — world-space video texture demo
// (feat-20260623-world-space-video-asset M5 / w20).
//
// Host side: implements a VideoSourceProvider that owns <video> DOM
// lifecycle (create / set src / autoplay / mute / dispose), registers it
// as a World Resource so the engine's per-frame record stage can sample
// frames each draw (plan-strategy D-1).
//
// AI-user side: declares a VideoAsset { url } -> loadByGuid -> spawn a
// quad entity with MeshFilter + MeshRenderer + MaterialAsset.values
// referencing the video GUID + VideoPlayer { clip, playing:true, loop:true }.
// The material reuses the same texture2d slot a static texture would (D-5),
// so the AI-user code is line-by-line isomorphic to a static-textured quad
// (charter P4 consistent abstraction).
//
// Test clip: apps/hello/video-cutscene/dist/cutscene.webm (already in repo,
// plan-strategy D-8). Referenced as a relative URL from this app's dev server
// (vite serves the monorepo root). The video-cutscene app is NOT modified
// (AC-11).
//
// Decision anchors:
//   - requirements AC-07 (browser end-to-end visible)
//   - plan-strategy D-1 (host VideoSourceProvider), D-8 (test clip reuse)
//   - charter P4 (AI-user code isomorphic to static textures)

import { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { VideoAsset } from '@forgeax/engine-types';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { VideoPlayer, VIDEO_SOURCE_PROVIDER_KEY } from '@forgeax/engine-graphics-extras';
import type { VideoSourceProvider } from '@forgeax/engine-graphics-extras';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// GUIDs: stable per-run (not persisted across builds).
const VIDEO_GUID_STRING = 'f1b3d000-1111-4aaa-9eee-aa1111112222';
const MATERIAL_GUID_STRING = 'b2b3d000-2222-4bbb-9eee-bb2222223333';
const STATIC_MATERIAL_GUID_STRING = 'c3b3d000-3333-4ccc-9eee-cc3333334444';

type VideoTextureRecoveryControls = {
  pauseFrames(): Promise<void>;
  resumeFrames(): void;
  removeProvider(): void;
  restoreProvider(): void;
  cleanup(): void;
  inspect(): {
    readonly providerPresent: boolean;
    readonly sameWorld: boolean;
    readonly sameRenderer: boolean;
    readonly sameHost: boolean;
    readonly sameVideoEntity: boolean;
    readonly sameStaticEntity: boolean;
    readonly sameVideoClip: boolean;
    readonly sameVideoMaterial: boolean;
    readonly sameStaticMaterial: boolean;
    readonly packFirstErrorCode: string | undefined;
    readonly packCurrentErrorCode: string | undefined;
    readonly packRetrySucceeded: boolean;
    readonly videoUrl: string;
    readonly videoElementCount: number;
    readonly videoElementSrc: string | undefined;
    readonly errorCodes: readonly string[];
  };
};

// --- host: VideoSourceProvider implementation ------------------------------

/**
 * Simple host-side VideoSourceProvider: creates one <video> element per
 * entity, caches it, and returns the element on each tick.
 *
 * The engine calls getSource every frame for each VideoPlayer entity; the
 * host owns the <video> DOM lifecycle (creating, setting src, autoplay,
 * mute, dispose) single-sidedly. The engine NEVER constructs a video
 * element or sets `.src` (requirements constraint).
 */
type DemoVideoProvider = VideoSourceProvider & {
  elementCount(): number;
  firstElementAttributeUrl(): string | undefined;
};

function createDemoVideoProvider(url: string): DemoVideoProvider {
  const cache = new Map<number, HTMLVideoElement>();

  function ensureElement(entity: EntityHandle, url: string): HTMLVideoElement {
    const key = entity as unknown as number;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;

    const videoEl = document.createElement('video');
    videoEl.setAttribute('src', url);
    videoEl.src = url;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.loop = true;
    videoEl.crossOrigin = 'anonymous';
    // Start loading; autoplay may be blocked until user gesture, but the
    // engine's copyExternalImageToTexture only needs a decoded frame.
    videoEl.load();
    videoEl.play().catch(() => {
      // Autoplay blocked: the element will play once a frame is decoded.
      // The engine tolerates videoWidth===0 (returns default view).
    });
    cache.set(key, videoEl);
    return videoEl;
  }

  return {
    getSource(entity, _clipHandle): HTMLVideoElement | undefined {
      return ensureElement(entity, url);
    },
    elementCount() {
      return cache.size;
    },
    firstElementAttributeUrl() {
      for (const element of cache.values()) return element.getAttribute('src') ?? undefined;
      return undefined;
    },
  };
}

// --- AI-user: scene recipe --------------------------------------------------

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('video-texture: missing <canvas id="app"> in index.html');

void bootstrap(canvas);

export async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const constructed = await constructRuntimeRendererHost(target, {}, forgeaxBundlerAdapter());
    if (!constructed.ok) throw constructed.error;
    const { renderer, assets } = constructed.value;
    const rendererErrorCodes: string[] = [];
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const e = event.error;
      const code = e.code === 'device-operation-failed' ? e.detail.cause.code : e.code;
      rendererErrorCodes.push(code);
      console.error('[video-texture] renderer error:', e.code, code, e.hint);
    });
    console.warn('[video-texture] Standard pipeline active');

    const search = new URLSearchParams(globalThis.location?.search ?? '');
    const recoveryMode = search.get('recovery') === '1';
    const packRetryMode = search.get('pack-retry') === '1';
    let packFirstErrorCode: string | undefined;
    let packCurrentErrorCode: string | undefined;
    let packRetrySucceeded = false;
    if (packRetryMode) {
      const reset = await fetch('/__forgeax-video-pack-reset', { method: 'POST' });
      if (!reset.ok) throw new Error('video-texture: Pack retry fixture reset failed');
      assets.configurePackIndex('/video-pack-index.json');
    }

    // Step 1: register VideoAsset { kind: 'video', url }
    const videoGuidResult = AssetGuid.parse(VIDEO_GUID_STRING);
    if (!videoGuidResult.ok) {
      console.error('[video-texture] video GUID parse failed:', videoGuidResult.error);
      return;
    }
    const videoGuid = videoGuidResult.value;
    if (!packRetryMode) {
      assets.catalog<VideoAsset>(videoGuid, {
        kind: 'video',
        url: '/cutscene.webm',
      });
    }
    let videoHandleRes = await assets.loadByGuid<VideoAsset>(videoGuid);
    if (!videoHandleRes.ok) {
      if (packRetryMode && videoHandleRes.error.code === 'asset-parse-failed') {
        packFirstErrorCode = videoHandleRes.error.code;
        packCurrentErrorCode = packFirstErrorCode;
        console.warn('[video-texture] Pack retry first descriptor rejected:', packFirstErrorCode);
        const repair = await fetch('/__forgeax-video-pack-repair', { method: 'POST' });
        if (!repair.ok) throw new Error('video-texture: Pack retry fixture repair failed');
        assets.invalidate(VIDEO_GUID_STRING);
        videoHandleRes = await assets.loadByGuid<VideoAsset>(videoGuid);
        if (videoHandleRes.ok) {
          packRetrySucceeded = true;
          packCurrentErrorCode = undefined;
        }
      }
    }
    if (!videoHandleRes.ok) {
      console.error('[video-texture] loadByGuid video failed:', videoHandleRes.error);
      return;
    }
    if (packRetryMode && !packRetrySucceeded) {
      console.error('[video-texture] Pack retry unexpectedly bypassed the first failure');
      return;
    }
    const videoAsset = videoHandleRes.value;
    console.log('[video-texture] VideoAsset registered');

    // Step 2: register unlit MaterialAsset with values.baseColorTexture=videoGuid.
    // The video GUID occupies the same texture2d slot a static texture would (D-5).
    const matGuidResult = AssetGuid.parse(MATERIAL_GUID_STRING);
    if (!matGuidResult.ok) {
      console.error('[video-texture] material GUID parse failed:', matGuidResult.error);
      return;
    }
    assets.catalog(matGuidResult.value, {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
      ],
      values: {
        baseColor: [0.9, 0.9, 0.9],
        // values texture fields are dash-form GUID strings (D-19): the
        // extract stage resolves the string against the catalogue and routes a
        // video-kind payload to the transient DynamicTextureStore. Passing the
        // raw AssetGuid (Uint8Array) here would match neither the string nor the
        // minted-handle (number) arm, silently dropping the slot to default white.
        baseColorTexture: VIDEO_GUID_STRING,
      },
    });
    const matHandleRes = await assets.loadByGuid(matGuidResult.value);
    if (!matHandleRes.ok) {
      console.error('[video-texture] loadByGuid material failed:', matHandleRes.error);
      return;
    }
    console.log('[video-texture] video-textured material registered');

    const staticMatGuidResult = AssetGuid.parse(STATIC_MATERIAL_GUID_STRING);
    if (!staticMatGuidResult.ok) {
      console.error('[video-texture] static material GUID parse failed:', staticMatGuidResult.error);
      return;
    }
    assets.catalog(staticMatGuidResult.value, {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [0.12, 0.78, 0.24] },
    });
    const staticMatHandleRes = await assets.loadByGuid(staticMatGuidResult.value);
    if (!staticMatHandleRes.ok) {
      console.error('[video-texture] static material load failed:', staticMatHandleRes.error);
      return;
    }
    console.log('[video-texture] static sibling material registered');

    // Step 3: build world
    const world = new World();
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;

    // Register the host VideoSourceProvider as a World Resource. The single
    // per-frame video upload path (the record stage's videoTextureView) reads
    // this resource directly during renderer.draw — there is no separate ECS
    // "video player system" to register (the upload + AC-10 failure signal both
    // live on the real draw path).
    //
    // Falsification hook (`?falsify=1`): SKIP the provider registration. Without
    // a host element the production path hits the AC-10 double-miss, binds the
    // default view, and the quad never shows live video — the smoke's pixel
    // probes MUST then go RED. The browser smoke runs this mode to prove its
    // probes actually detect video content (not e.g. a false-green from the HUD).
    const falsify = search.get('falsify') === '1';
    let demoProvider: DemoVideoProvider | undefined;
    if (!falsify) {
      demoProvider = createDemoVideoProvider(videoAsset.url);
      world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, demoProvider);
    } else {
      console.warn('[video-texture] FALSIFY mode: VideoSourceProvider NOT registered');
    }

    // Spawn camera at (0, 0, 5) looking down -Z. Use the `perspective` factory:
    // it requires fov (RADIANS) + aspect (no schema default for either), so a
    // raw `{ fov: 60, near, far }` would leave aspect=0 (degenerate projection
    // -> nothing on screen) and treat 60 as radians. perspective() fills the
    // 22-column CameraPod correctly.
    world.spawn(
      {
        component: Camera,
        data: perspective({
          fov: Math.PI / 3,
          aspect: target.width / target.height,
          near: 0.1,
          far: 100,
        }),
      },
      { component: Transform, data: { pos: [0, 0, 5]} },
    );

    // Spawn directional light.
    world.spawn(
      {
        component: DirectionalLight,
        data: {
          direction: [-0.3, -1.0, -0.5],
          color: [1, 1, 1],
          intensity: 1.5,
        },
      },
      { component: Transform, data: { pos: [1, 2, 1]} },
    );

    // Mint handles from the payloads returned by loadByGuid (D-17:
    // loadByGuid returns the payload — allocSharedRef maps it to a
    // per-world column handle for spawn).
    const videoClipHandle = world.allocSharedRef('VideoAsset', videoHandleRes.value);
    const matHandle = world.allocSharedRef('MaterialAsset', matHandleRes.value);
    const staticMatHandle = world.allocSharedRef('MaterialAsset', staticMatHandleRes.value);

    const staticEnt = world.spawn(
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [staticMatHandle] } },
      { component: Transform, data: { pos: [-2.1, 0, -1], scale: [1.2, 1.2, 1] } },
    );
    console.log(`[video-texture] static sibling quad spawned: entity=${String(staticEnt)}`);

    // Spawn the video-textured quad entity beside the static sibling, scaled 2x on X/Y,
    // positioned slightly behind the camera at Z=-1.
    const videoEnt = world.spawn(
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      {
        component: VideoPlayer,
        data: { clip: videoClipHandle, playing: true, loop: true, currentTime: 0 },
      },
      {
        component: Transform,
        data: { pos: [0.5, 0, -1], scale: [2, 2, 1] },
      },
    );
    console.log(`[video-texture] video-textured quad spawned: entity=${String(videoEnt)}`);

    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;

    let running = true;
    let framesPaused = false;
    let lastCompletion = Promise.resolve();
    let completedFrames = 0;
    if (recoveryMode && !falsify && demoProvider !== undefined) {
      const stable = {
        world,
        renderer,
        deviceGeneration: renderer.inspect().frame.deviceGeneration,
        videoEnt,
        staticEnt,
        videoClipHandle,
        matHandle,
        staticMatHandle,
        provider: demoProvider,
      };
      const recoveryGlobal = globalThis as typeof globalThis & {
        __forgeaxVideoTextureRecovery?: VideoTextureRecoveryControls;
      };
      recoveryGlobal.__forgeaxVideoTextureRecovery = {
        async pauseFrames() {
          framesPaused = true;
          await lastCompletion;
        },
        resumeFrames() {
          framesPaused = false;
        },
        removeProvider() {
          world.removeResource(VIDEO_SOURCE_PROVIDER_KEY);
        },
        restoreProvider() {
          world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, demoProvider);
        },
        cleanup() {
          running = false;
          void renderer.dispose();
        },
        inspect() {
          return {
            providerPresent:
              world.hasResource(VIDEO_SOURCE_PROVIDER_KEY) &&
              world.getResource<VideoSourceProvider>(VIDEO_SOURCE_PROVIDER_KEY) === stable.provider,
            sameWorld: world === stable.world,
            sameRenderer: renderer === stable.renderer,
            sameHost: renderer === stable.renderer,
            sameDevice: renderer.inspect().frame.deviceGeneration === stable.deviceGeneration,
            sameVideoEntity: videoEnt === stable.videoEnt,
            sameStaticEntity: staticEnt === stable.staticEnt,
            sameVideoClip: videoClipHandle === stable.videoClipHandle,
            sameVideoMaterial: matHandle === stable.matHandle,
            sameStaticMaterial: staticMatHandle === stable.staticMatHandle,
            packFirstErrorCode,
            packCurrentErrorCode,
            packRetrySucceeded,
            videoUrl: videoAsset.url,
            videoElementCount: stable.provider.elementCount(),
            videoElementSrc: stable.provider.firstElementAttributeUrl(),
            errorCodes: rendererErrorCodes.slice(),
          };
        },
      };
    }

    // HUD update.
    const hudEl = document.querySelector<HTMLElement>('#hud');
    if (hudEl) {
      hudEl.textContent = 'World-space video texture demo — quad sampling cutscene.webm';
    }

    // Render loop.
    const frame = (): void => {
      if (!running) return;
      if (framesPaused) {
        requestAnimationFrame(frame);
        return;
      }
      world.update().unwrap();
      const r = renderer.draw({
        leases: [attachment.value],
        camera: { lease: attachment.value },
        environment: { lease: attachment.value },
      });
      if (!r.ok) {
        console.error('[video-texture] draw error:', r.error.code, r.error.hint);
      } else {
        lastCompletion = r.value.completed.then((completed) => {
          if (!running) return;
          if (!completed.ok) {
            console.error('[video-texture] completion error:', completed.error.code);
            return;
          }
          target.dataset.forgeaxCompletedFrames = String(++completedFrames);
        });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (err: unknown) {
    console.error('[video-texture] bootstrap error:', err);
  }
}
