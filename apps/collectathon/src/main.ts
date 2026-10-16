import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { Update } from '@forgeax/engine-ecs';
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
import { AudioListener, audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { physicsPlugin } from '@forgeax/engine-physics';
import {
  ANTIALIAS_FXAA,
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  perspective,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';

import { Transform } from '@forgeax/engine-scene';
import { skinningPlugin } from '@forgeax/engine-skinning';
import {
  addOnEnter,
  addOnExit,
  defineState,
  despawnOnExit,
  getState,
  inState,
  setNextState,
  setNextStateForce,
} from '@forgeax/engine-state';
import type {
  AnimationClip,
  EquirectAsset,
  FontAsset,
  Handle,
  SceneAsset,
} from '@forgeax/engine-types';

import { createHUD, hideHUD, showHUD } from './hud';
import { createGameProgress, GAME_PROGRESS_KEY, resetProgress } from './resources';
import { CORE_POSITIONS, spawnCore } from './spawn/spawn-core';
import { GUARDIAN_SPAWNS, spawnGuardian } from './spawn/spawn-guardian';
import { LEVEL_HALF, spawnLevel } from './spawn/spawn-level';
import { spawnPlayer } from './spawn/spawn-player';
import { spawnPortal } from './spawn/spawn-portal';
import { type AudioCueEntities, createAudioCueSystem, loadAudioCues } from './systems/audio-cue';
import { createCollectSystem } from './systems/core-collect';
import { createSpinSystem } from './systems/core-spin';
import { createDebugOverlaySystem, resolveDebugEnabled } from './systems/debug-overlay';
import { createGuardianAISystem, guardianWaypoints } from './systems/guardian-ai';
import { createGuardianHitSystem } from './systems/guardian-hit';
import { createHudSyncSystem, createTimerSystem } from './systems/hud-sync';
import { createPickupTextSystem } from './systems/pickup-text';
import { createAnimSystem } from './systems/player-anim';
import {
  CAMERA_OFFSET_Y,
  CAMERA_OFFSET_Z,
  cameraLookAtQuat,
  createMoveSystem,
  createPlayerMoveSignal,
} from './systems/player-move';
import { createPortalSystem } from './systems/portal-activate';
import { createArbiterSystem } from './systems/win-lose-arbiter';

// Four-state machine for game lifecycle: Title -> Play -> Win/Lose -> Title.
export const GameState = defineState('GameState', ['Title', 'Play', 'Win', 'Lose'] as const);

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
// and surfaces it via the binding's scoped catalog -> loadByGuid<EquirectAsset>, the same
// declarative equirect IBL path the learn-render PBR demos + templates/game-3d
// use (Skylight/SkyboxBackground hold the equirect handle; projection is internal).
const SKY_HDR_GUID = '81eec382-392f-5a93-8998-0ecf11ef7990';

// DejaVu Sans Mono MSDF font (AC-12): pre-baked atlas + font.pack.json in
// forgeax-engine-assets/dejavu-fonts/. The font GUID + sampler GUID are SSOT
// from DejaVuSansMono.font.pack.json + DejaVuSansMono.atlas.png.meta.json
// (reused from apps/hello/text). The sampler must be catalogued before
// loadByGuid<FontAsset> so fontLoader can resolve the `samplerGuid` ref.
const FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';
const FONT_SAMPLER_GUID = '019eb276-4d96-7313-b4f0-f5d55536acd2';

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
      plugins: [physicsPlugin('rapier-3d'), webAudioPlugin(), audioPlugin(), skinningPlugin()],
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

  // AC-12 MSDF font: register the shared sampler + load the pre-baked DejaVu
  // Sans Mono FontAsset. The sampler GUID must be catalogued before loadByGuid
  // so fontLoader can resolve the FontAsset's `samplerGuid` ref. Mirrors
  // apps/hello/text/src/main.ts registerSharedSampler pattern.
  const fontGuidParsed = AssetGuid.parse(FONT_GUID);
  const samplerGuidParsed = AssetGuid.parse(FONT_SAMPLER_GUID);
  let fontHandle: Handle<'FontAsset', 'shared'> | undefined;
  if (fontGuidParsed.ok && samplerGuidParsed.ok) {
    assets.catalog<import('@forgeax/engine-types').SamplerAsset>(samplerGuidParsed.value, {
      kind: 'sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
    });
    const fontRes = await assets.loadByGuid<FontAsset>(fontGuidParsed.value);
    if (fontRes.ok) {
      fontHandle = world.allocSharedRef('FontAsset', fontRes.value);
    }
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

function wireStates(
  app: import('@forgeax/engine-app').App,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
  sceneHandle: Handle<'SceneAsset', 'shared'>,
  runClip: Handle<'AnimationClip', 'shared'>,
  debugEnabled: boolean,
  hud: import('./hud').HudHandles,
  cues: AudioCueEntities,
  fontHandle: Handle<'FontAsset', 'shared'> | undefined,
  camera: EntityHandle,
): void {
  // Title -> Play. On every Title entry (initial + each Win/Lose replay) reset
  // the scoreboard SSOT so a replay starts clean (AC-11). The Play-scoped
  // entities are despawned by transitionStatesSystem on the Play->Title exit, so
  // the only carry-over to clear is the GameProgress resource.
  addOnEnter(GameState, 'Title', (w: World) => {
    resetProgress(w, CORE_POSITIONS.length);
    void setNextState(w, GameState, 'Play');
  });

  // Play: spawn light (D-7, before any standard material) -> camera -> level
  // (ground + boundary walls) -> Cores -> Portal -> player. All spawned entities
  // are state-scoped (despawnOnExit) so a Win/Lose -> Title -> Play replay starts
  // clean (AC-11). Movement / animation / collect / spin / portal systems are
  // gated to Play via inState runIf.
  addOnEnter(GameState, 'Play', (w: World) => {
    showHUD(hud);
    const light = spawnLight(w);
    // Environment lighting (F-05 / AC-08): spawn a Skylight now (frame-1 white
    // ambient via the engine fallback cube), then load the sky.hdr equirect and
    // attach its handle + the visible SkyboxBackground once available. The engine
    // record arm projects the equirect->cubemap + IBL lazily (caps-gated, white
    // fallback while pending) -- no manual upload call, no WebKit UA guard.
    const skylight = spawnSkylight(w);
    // The camera is app-lifetime (spawned once in bootstrap, passed in) so it
    // survives Title<->Play replays without a camera-less draw frame. player-move
    // re-aims it at the fresh player each run via followCamera.
    void attachSkyEquirect(w, assets, skylight).then((skybox) => {
      // The skybox spawns after the async equirect load; scope it for replay
      // cleanup (best-effort -- the load may resolve after a fast Play->Title).
      if (skybox !== undefined) despawnOnExit(w, skybox, GameState, 'Play');
    });
    const levelEntities = spawnLevel(w);

    // Cores: one per CORE_POSITIONS entry. CORE_POSITIONS.length is the SSOT for
    // the level Core count, so GameProgress.total derives from it (no second
    // hand-kept count). The collect system reads/writes the score on this SSOT.
    const cores = CORE_POSITIONS.map((p) => spawnCore(w, p));
    w.insertResource(GAME_PROGRESS_KEY, createGameProgress(cores.length));

    // Portal at the far end of the level (-Z edge, inside the boundary wall).
    const portal = spawnPortal(w, { x: 0, z: -13 });

    const playerRes = spawnPlayer(w, assets, sceneHandle, runClip);
    if (!playerRes.ok) {
      throw new Error(
        `collectathon: spawnPlayer failed: ${playerRes.error.code} - ${playerRes.error.hint}`,
      );
    }
    const player = playerRes.value;
    // Collision-group membership + the CollidingEntities receiver component are
    // set in spawnPlayer (SSOT); the Core/Portal/Guardian sensors filter to
    // PLAYER only and register the player there (R-D1).

    // Guardians (1-3): a KCC body + an armed-on-attack sensor child each. Spawned
    // clear of the Core cluster and off the player->Portal corridor (M4 fail path).
    const guardians = GUARDIAN_SPAWNS.map((p) => spawnGuardian(w, p));

    // State-scoped despawn for every Play entity (AC-11). The Core list, level
    // pieces, and Guardian body + sensor pairs flatten into the scoped set.
    const guardianEntities = guardians.flatMap((g) => [g.body, g.attackSensor]);
    for (const e of [
      light,
      skylight,
      portal,
      player.parent,
      player.sceneRoot,
      ...levelEntities,
      ...cores,
      ...guardianEntities,
    ]) {
      despawnOnExit(w, e, GameState, 'Play');
    }

    // Register the per-frame gameplay systems once, gated to Play. The move
    // signal flows player-move -> player-anim (one-way producer).
    const signal = createPlayerMoveSignal();
    const playOnly = inState(GameState, 'Play');
    w.addSystem(Update, {
      ...createMoveSystem(player.parent, camera, signal),
      runIf: playOnly,
    });
    w.addSystem(Update, {
      ...createAnimSystem(app, player.animationPlayer, signal),
      runIf: playOnly,
    });
    w.addSystem(Update, { ...createSpinSystem(cores), runIf: playOnly });
    w.addSystem(Update, { ...createCollectSystem(player.parent), runIf: playOnly });
    w.addSystem(Update, {
      ...createPortalSystem(player.parent, portal, GameState),
      runIf: playOnly,
    });

    // M4 fail-path systems: guardian-ai (per-entity sub-machine) -> guardian-hit
    // (Health--) -> win-lose-arbiter (single Win/Lose verdict), plus the debug
    // overlay. The arbiter runs after portal-activate + guardian-hit so its
    // verdict reads the freshest score/health (same-frame mutual exclusion).
    const guardianRuntime = guardians.map((g, i) => ({
      ...g,
      waypoints: guardianWaypoints(GUARDIAN_SPAWNS[i] ?? { x: 0, z: 0 }),
    }));
    w.addSystem(Update, {
      ...createGuardianAISystem(app, guardianRuntime, player.parent),
      runIf: playOnly,
    });
    w.addSystem(Update, { ...createGuardianHitSystem(player.parent), runIf: playOnly });
    w.addSystem(Update, {
      ...createArbiterSystem(player.parent, portal, GameState),
      runIf: playOnly,
    });
    w.addSystem(Update, {
      ...createDebugOverlaySystem(
        app,
        {
          player: player.parent,
          cores,
          guardianBodies: guardians.map((g) => g.body),
          levelHalf: LEVEL_HALF,
        },
        debugEnabled,
      ),
      runIf: playOnly,
    });

    // M5 presentation systems: hud-timer accumulates elapsed into GameProgress
    // (sole elapsed writer); hud-sync renders the SSOT into the DOM (one-way,
    // AC-18); pickup-text spawns floating "+1" MSDF GlyphText on Core pickup
    // (AC-12, after core-collect); audio-cue drives the 3D spatial cue playing
    // edges off the move signal + score/health deltas (F-07 / AC-10).
    w.addSystem(Update, { ...createTimerSystem(), runIf: playOnly });
    w.addSystem(Update, { ...createHudSyncSystem(hud), runIf: playOnly });
    if (fontHandle !== undefined) {
      w.addSystem(Update, { ...createPickupTextSystem(fontHandle, GameState), runIf: playOnly });
    }
    w.addSystem(Update, { ...createAudioCueSystem(cues, signal), runIf: playOnly });

    // Dev-only verification hook deleted (M5 w24): createApp auto-wires
    // app.remote in dev mode — host reads player pose / fixes camera via
    // client.eval(script) against the eval channel. The old __cg hook is
    // replaced by the zero-cost present remote eval server.
  });

  // Hide the HUD when leaving Play (Win/Lose result screens land later); the
  // Title OnEnter resets GameProgress for the replay.
  addOnExit(GameState, 'Play', () => {
    hideHUD(hud);
  });

  // Win / Lose return to Title (the Title OnEnter resets the scoreboard for the
  // replay). Real result screens land in M5 HUD.
  addOnEnter(GameState, 'Win', (w: World) => {
    void setNextState(w, GameState, 'Title');
  });
  addOnEnter(GameState, 'Lose', (w: World) => {
    void setNextState(w, GameState, 'Title');
  });
}

// ── Play-state spawn helpers ──────────────────────────────────────────────

function spawnLight(world: World): EntityHandle {
  // D-7 / F-04: a DirectionalLight (default castShadow:true, real CSM) must
  // exist before any standard-material entity or the scene renders black.
  return world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.4, -1, -0.3],
        color: [1, 1, 1],
        intensity: 1,
      },
    })
    .unwrap();
}

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
function spawnSkylight(world: World): EntityHandle {
  return world
    .spawn({
      component: Skylight,
      data: { color: [0.9, 0.95, 1.0], intensity: 0.35 },
    })
    .unwrap();
}

/**
 * Attach the sky.hdr equirect to an existing Skylight + spawn the visible
 * SkyboxBackground (F-05 / AC-08). Async: returns the SkyboxBackground entity
 * (or undefined) so the caller state-scopes it.
 *
 * Declarative path (no manual cubemap upload, no WebKit UA guard): loadByGuid
 * yields the EquirectAsset payload, allocSharedRef mints a user-tier handle, and
 * the Skylight/SkyboxBackground hold that handle. The engine record arm projects
 * the equirect->cubemap + IBL lazily, gated solely by caps.rgba16floatRenderable
 * -- WebKit/WKWebView lacking that feature keeps the white fallback cube (solid
 * ambient, no skybox) automatically, without poisoning the device.
 */
async function attachSkyEquirect(
  world: World,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
  skylight: EntityHandle,
): Promise<EntityHandle | undefined> {
  const guidRes = AssetGuid.parse(SKY_HDR_GUID);
  if (!guidRes.ok) return undefined;
  const podRes = await assets.loadByGuid<EquirectAsset>(guidRes.value);
  if (!podRes.ok) return undefined;
  const equirect = world.allocSharedRef('EquirectAsset', podRes.value);

  // Attach the equirect to the Skylight for image-based lighting (neutral tint
  // lets the HDR drive the color); the same handle feeds the visible
  // SkyboxBackground (F-05). Projection happens lazily inside the renderer.
  world.set(skylight, Skylight, {
    equirect,
    color: [1, 1, 1],
    intensity: 0.25,
  });
  return world
    .spawn({
      component: SkyboxBackground,
      data: { equirect, mode: SKYBOX_MODE_CUBEMAP },
    })
    .unwrap();
}

// ── Asset load helpers (Fail Fast) ────────────────────────────────────────

async function loadSceneHandle(
  world: World,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
): Promise<Handle<'SceneAsset', 'shared'> | undefined> {
  const guidRes = AssetGuid.parse(HUMANOID_SCENE_GUID);
  if (!guidRes.ok) return undefined;
  const res = await assets.loadByGuid<SceneAsset>(guidRes.value);
  if (!res.ok) return undefined;
  return world.allocSharedRef('SceneAsset', res.value);
}

async function loadClipHandle(
  world: World,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
): Promise<Handle<'AnimationClip', 'shared'> | undefined> {
  const guidRes = AssetGuid.parse(RUN_CLIP_GUID);
  if (!guidRes.ok) return undefined;
  const res = await assets.loadByGuid<AnimationClip>(guidRes.value);
  if (!res.ok) return undefined;
  // Strip the humanoid.fbx Camera/Light authoring channels (symptom2 fix, m6-3):
  // they animate nodes absent from the player Skin and otherwise trip the D-10
  // gate with channel-leaf-mismatch warnings. The handle is minted from the
  // stripped clip so the AnimationPlayer never sees the non-skeleton channels.
  return world.allocSharedRef('AnimationClip', res.value);
}
