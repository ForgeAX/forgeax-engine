import { GameState, wireStates } from './state-lifecycle';

export { GameState } from './state-lifecycle';

import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';

import type { AssetHandle } from '@forgeax/engine-types';
// apps/collectathon — 3D third-person collectathon showcase game.
//
// Bootstrap: createApp(canvas, {plugins}, { ...bundler, importTransport })
// three-arg form (bundler adapter required — AGENTS.md known pit P-04; the
// dev import transport lets pluginPack dispatch humanoid.fbx through fbxImporter
// at dev time, mirroring apps/hello/fbx-skin).
//
// GameState four-state machine (Title / Play / Win / Lose) runs through the
// App-owned state plugin. M2 fills the Play state: ground + light + camera +
// the player parent/child pair, with player-move / player-anim systems gated to
// run only in Play (inState runIf).

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AudioListener, audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import physics3d from '@forgeax/engine-physics-rapier3d';
import {
  ANTIALIAS_FXAA,
  BLOOM_ENABLED,
  Camera,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { skinningPlugin } from '@forgeax/engine-skinning';
import { getState, setNextStateForce } from '@forgeax/engine-state';
import { createHUD } from './hud';

import { loadAudioCues } from './systems/audio-cue';

import { resolveDebugEnabled } from './systems/debug-overlay';

import { CAMERA_OFFSET_Y, CAMERA_OFFSET_Z, cameraLookAtQuat } from './systems/player-move';

// Four-state machine for game lifecycle: Title -> Play -> Win/Lose -> Title.

// Title -> Play is two deferred setNextState hops (F-08): force-Title applies +
// queues Play on update 1, Play applies + spawnCamera on update 2. bootstrap()
// pumps world.update(delta).unwrap() up to this bound before app.start() so a Camera exists
// before the first frame draw (R-12). The bound is well above 2 so it drives the
// transition to completion without risking an unbounded loop if a future state
// rewire changes the hop count. Declared at module scope (not inside bootstrap)
// because bootstrap is awaited at import time -- a const after its use would hit
// the temporal dead zone.
const BOOT_TRANSITION_PUMP_LIMIT = 8;

// humanoid.fbx GUIDs (reused from apps/hello/fbx-skin per D-3). Scene + the run
// clip used as both locomotion (speed 1) and idle (speed 0) slots.
const HUMANOID_SCENE_GUID = '019ecd87-179b-7eb3-a37d-391f05c61e52';
const RUN_CLIP_GUID = '019ecd87-179b-71f7-b9f8-4c8518326b65';

// sky.hdr IBL source (F-05): demo-assets/template-game-default/sky.hdr (Apache-2.0,
// commercial-compatible). pluginPack scans that directory (added to vite roots)
// and surfaces it through the binding's scoped Catalog, the same
// declarative equirect IBL path the learn-render PBR demos + templates/game-3d
// use (Skylight/SkyboxBackground hold the equirect handle; projection is internal).

// DejaVu Sans Mono MSDF font; its source publication includes the sampler closure.
const FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('collectathon: missing <canvas id="game"> in index.html');

// Size the canvas backing store to its CSS box * devicePixelRatio BEFORE
// createApp (D4): the engine reads canvas.width/height and never auto-resizes,
// so without this the buffer stays at the HTML default 300x150 and gets
// stretched to the viewport, rendering at ~1/4 resolution. Mirrors the
// apps/hello/skin resizeCanvasToDisplaySize idiom; createApp's frame loop
// re-reads canvas.width each frame + syncs camera aspect, so a runtime resize
// listener keeps it crisp on window resize too.
resizeCanvasToDisplaySize(canvas);
window.addEventListener('resize', () => resizeCanvasToDisplaySize(canvas));

await bootstrap(canvas);

function resizeCanvasToDisplaySize(c: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || window.innerWidth;
  const cssH = c.clientHeight || window.innerHeight;
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (c.width !== targetW) c.width = targetW;
  if (c.height !== targetH) c.height = targetH;
}

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    {
      plugins: [physics3d, webAudioPlugin(), audioPlugin(), skinningPlugin()],
      ...(runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding }),
    },
    {
      ...forgeaxBundlerAdapter(),
      importTransport: createRuntimeAssetImportTransport(runtimeBinding),
    },
  );
  if (!appResult.ok) {
    throw new Error(`collectathon: createApp failed: ${JSON.stringify(appResult.error)}`);
  }
  const app = appResult.value;
  const { world } = app;

  // Resolve the humanoid scene + run clip up front (Fail Fast, AC-21): the Play
  // state must not be entered until the player asset is loadable.
  const assets = app.assets;
  if (assets === undefined) {
    throw new Error('collectathon: asset owner unavailable (bundler adapter missing?)');
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const sceneHandle = await loadSceneHandle(world, assets);
  const runClip = await loadClipHandle(world, assets);
  if (sceneHandle === undefined || runClip === undefined) {
    throw new Error('collectathon: humanoid.fbx scene / run clip failed to load');
  }

  // Debug-draw overlay toggle (D-4): dev default + URL ?debug=0/1 override,
  // resolved once at boot and threaded into the per-run Play wiring.
  const debugEnabled = resolveDebugEnabled(
    import.meta.env.DEV,
    new URLSearchParams(window.location.search).get('debug'),
  );

  // HUD overlay (F-14 / AC-18): resolve the persistent #hud spans once. hud-sync
  // renders GameProgress into them each Play frame (one-way derive).
  const hud = createHUD();

  // 3D spatial audio cues (F-07 / AC-10): load the four cue families once + spawn
  // their emitter entities. The cue system drives playing edges each Play frame.
  // The emitters live for the app lifetime (not state-scoped) -- they carry no
  // gameplay state and re-arming on each replay is the cue system's job.
  const cues = await loadAudioCues(world, assets);

  const fontGuidParsed = AssetGuid.parse(FONT_GUID);
  let fontHandle: AssetHandle<'font'> | undefined;
  if (fontGuidParsed.ok) {
    const fontRes = await assets.load(fontGuidParsed.value, 'font');
    if (fontRes.ok) fontHandle = fontRes.value;
  }

  // Camera: spawned ONCE for the app lifetime (not state-scoped). Like the audio
  // emitters above, it carries no per-run gameplay state. Scoping it to Play
  // (despawnOnExit) used to recreate it on every replay, but a Win/Lose -> Title
  // -> Play hop is two deferred setNextState frames (F-08): the old camera is
  // despawned on Play exit, and the new one is not spawned until Play re-enters,
  // so the unconditional frame-loop draw hit `render-system-no-camera` for those
  // in-between frames (a black flash on replay). The boot pump fixes the FIRST
  // entry only -- it runs before app.start() and cannot re-pump mid-loop. A
  // lifetime camera survives every replay, so there is never a camera-less frame.
  const camera = spawnCamera(world);
  wireStates(app, assets, sceneHandle, runClip, debugEnabled, hud, cues, fontHandle, camera);

  // Structural smoke hook (AC-02): expose a live entity/camera count so the
  // Playwright browser e2e can assert the full level instantiated (entity count
  // in range + Camera present) without a pixel readback (OOS-7). Read-only --
  // it never mutates the World.
  installSmokeHook(world);

  // Boot into Title, then drive Title->Play to completion BEFORE app.start()
  // (R-12 fix). The default state is already 'Title', so the force variant is
  // needed to run the Title OnEnter (reset scoreboard + advance to Play). The
  // app frame loop (createApp) already calls renderer.draw(world) every frame,
  // so the demo must NOT register its own draw -- a second draw is redundant and
  // doubled the boot-window errors. But the built-in draw is unconditional, and
  // setNextState defers one frame each (F-08): Title OnEnter queues Play, Play
  // OnEnter spawns the Camera. So a plain start() would draw ~3 frames with no
  // Camera and fire `render-system-no-camera` each. Instead, pump world.update(delta)
  // here until Play is live (Camera + full scene spawned) so the very first
  // frame the loop draws already has a Camera.
  void setNextStateForce(world, GameState, 'Title');
  for (let i = 0; i < BOOT_TRANSITION_PUMP_LIMIT; i++) {
    const s = getState(world, GameState);
    if (s.ok && s.value === 'Play') break;
    world.update(1 / 60).unwrap();
  }
  app.start();
}

/**
 * Expose `globalThis.__collectathon` for the structural browser smoke: a
 * read-only view of the live entity count (entities carrying Transform) + camera
 * count (entities carrying Camera). The smoke polls these after the Play scene
 * settles to assert the level fully instantiated. Query row counting is the same
 * count path apps/preview's browser test uses.
 */
function installSmokeHook(world: World): void {
  const view = {
    entityCount(): number {
      let n = 0;
      const query = world.query({ with: [Transform] }).unwrap();
      for (const _row of query) n += 1;
      return n;
    },
    cameraCount(): number {
      let n = 0;
      const query = world.query({ with: [Camera] }).unwrap();
      for (const _row of query) n += 1;
      return n;
    },
  };
  (globalThis as unknown as { __collectathon?: typeof view }).__collectathon = view;
}

/**
 * Dev-only verification hook deleted (feat-20260629-inspector-two-layer-model M5 w24).
 * createApp now auto-wires app.remote in dev mode — host can read player pose
 * frame-over-frame and fix the camera via client.eval(script) against the
 * remote eval channel. The old window.__cg manual hook (installDevHook) is
 * no longer needed — the eval server makes World access zero-cost present.
 */

// ── Play-state spawn helpers ──────────────────────────────────────────────

function spawnCamera(world: World): EntityHandle {
  // Third-person camera; player-move repositions it to follow the player each
  // frame. Initial pose looks at the spawn origin from behind + above using the
  // same orbit offset (CAMERA_OFFSET_Y, CAMERA_OFFSET_Z) as the follow system.
  //
  // The look target (0, 1.8, 0) is the expected player torso position
  // (PLAYER_SPAWN_Y approx 0.8 + 1 unit look-up offset). cameraLookAtQuat ensures the
  // orientation matches followCamera so there is no visual snap on the first
  // player-move frame.
  //
  // Post-processing all-on (D-6 / F-06, AC-09): bloom + tonemap + fxaa. bloom
  // MUST ship with tonemap active -- bloom allocates an HDR target and gates on
  // tonemapActive=true; a lone bloom (no tonemap) renders a white burn-out
  // (memory hdrp-graph-missing-tonemap / P-06). The emissive Cores
  // (emissiveIntensity:2.0) push pixels >1.0 that the bloom bright-pass extracts
  // into a glow. FXAA (not MSAA -- MSAA is incompatible with the HDR target).
  // The fields live on the Camera component data (read every frame by the engine
  // extract stage); no per-frame system mutates them.
  //
  // AudioListener (F-07): the camera carries the listener so 3D AudioSource
  // emitters attenuate by distance. createApp auto-registers the listener-sync
  // system that drives the Web Audio listener pose from this entity's
  // GlobalTransform.world.
  const look = cameraLookAtQuat(
    0,
    CAMERA_OFFSET_Y,
    CAMERA_OFFSET_Z, // eye
    0,
    1.8,
    0, // target (player torso at spawn)
    0,
    1,
    0, // up = +Y
  );
  return world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, CAMERA_OFFSET_Y, CAMERA_OFFSET_Z],
          quat: look,
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 200 }),
          tonemap: TONEMAP_REINHARD_EXTENDED,
          bloom: BLOOM_ENABLED,
          bloomThreshold: 1.0,
          bloomIntensity: 1.0,
          antialias: ANTIALIAS_FXAA,
        },
      },
      { component: AudioListener, data: {} },
    )
    .unwrap();
}

// ── IBL skylight + skybox (F-05 / AC-08) ──────────────────────────────────

/**
 * Spawn the Skylight for the Play scene (sync, frame-1 ambient). The forgeax PBR
 * shader computes ambient=0 without a Skylight, so a lone DirectionalLight leaves
 * shaded faces dark; an equirect-less Skylight binds the engine's 1x1 white
 * irradiance cube -- ambient is live on the FIRST frame with zero async GPU work.
 * attachSkyEquirect attaches the sky.hdr equirect handle once it loads. Returned so
 * the caller state-scopes it.
 */

/**
 * Attach the sky.hdr equirect to an existing Skylight + spawn the visible
 * SkyboxBackground (F-05 / AC-08). Async: returns the SkyboxBackground entity
 * (or undefined) so the caller state-scopes it.
 *
 * The loaded source handle drives both lighting and the background. The renderer
 * projects the equirect source according to the device capabilities.
 */

// ── Asset load helpers (Fail Fast) ────────────────────────────────────────

async function loadSceneHandle(
  world: World,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
): Promise<AssetHandle<'scene'> | undefined> {
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry) || sceneAssets !== assets)
    throw new Error('Scene requires its runtime asset owner');

  const guidRes = AssetGuid.parse(HUMANOID_SCENE_GUID);
  if (!guidRes.ok) return undefined;
  const res = await assets.load(guidRes.value, 'scene');
  if (!res.ok) return undefined;
  return res.value;
}

async function loadClipHandle(
  world: World,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
): Promise<AssetHandle<'animation-clip'> | undefined> {
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry) || sceneAssets !== assets)
    throw new Error('Scene requires its runtime asset owner');

  const guidRes = AssetGuid.parse(RUN_CLIP_GUID);
  if (!guidRes.ok) return undefined;
  const res = await assets.load(guidRes.value, 'animation-clip');
  if (!res.ok) return undefined;
  return res.value;
}
