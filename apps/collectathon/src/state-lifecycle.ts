import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { defineSystem, type System, type SystemToken, Update } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  DirectionalLight,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
} from '@forgeax/engine-render';
import {
  addOnEnter,
  addOnExit,
  defineState,
  despawnOnExit,
  inState,
  setNextState,
} from '@forgeax/engine-state';
import type { AssetHandle } from '@forgeax/engine-types';
import { hideHUD, showHUD } from './hud';
import { createGameProgress, GAME_PROGRESS_KEY, resetProgress } from './resources';
import { CORE_POSITIONS, spawnCore } from './spawn/spawn-core';
import { GUARDIAN_SPAWNS, spawnGuardian } from './spawn/spawn-guardian';
import { LEVEL_HALF, spawnLevel } from './spawn/spawn-level';
import { spawnPlayer } from './spawn/spawn-player';
import { spawnPortal } from './spawn/spawn-portal';
import { type AudioCueEntities, createAudioCueSystem } from './systems/audio-cue';
import { createCollectSystem } from './systems/core-collect';
import { createSpinSystem } from './systems/core-spin';
import { createDebugOverlaySystem } from './systems/debug-overlay';
import { createGuardianAISystem, guardianWaypoints } from './systems/guardian-ai';
import { createGuardianHitSystem } from './systems/guardian-hit';
import { createHudSyncSystem, createTimerSystem } from './systems/hud-sync';
import { createPickupTextSystem } from './systems/pickup-text';
import { createAnimSystem } from './systems/player-anim';
import { createMoveSystem, createPlayerMoveSignal } from './systems/player-move';
import { createPortalSystem } from './systems/portal-activate';
import { createArbiterSystem } from './systems/win-lose-arbiter';

export const GameState = defineState('GameState', ['Title', 'Play', 'Win', 'Lose'] as const);

const SKY_HDR_GUID = '81eec382-392f-5a93-8998-0ecf11ef7990';

export function wireStates(
  app: import('@forgeax/engine-app').App,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
  sceneHandle: AssetHandle<'scene'>,
  runClip: AssetHandle<'animation-clip'>,
  debugEnabled: boolean,
  hud: import('./hud').HudHandles,
  cues: AudioCueEntities,
  fontHandle: AssetHandle<'font'> | undefined,
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
  const playSystems: SystemToken[] = [];
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
    const install = (descriptor: System<readonly []>) => {
      const system = defineSystem({ ...descriptor, runIf: playOnly });
      w.addSystem(Update, system).unwrap();
      playSystems.push(system);
    };
    install({
      ...createMoveSystem(player.parent, camera, signal),
      runIf: playOnly,
    });
    install({
      ...createAnimSystem(app, player.animationPlayer, signal),
      runIf: playOnly,
    });
    install({ ...createSpinSystem(cores), runIf: playOnly });
    install({ ...createCollectSystem(player.parent), runIf: playOnly });
    install({
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
    install({
      ...createGuardianAISystem(app, guardianRuntime, player.parent),
      runIf: playOnly,
    });
    install({ ...createGuardianHitSystem(player.parent), runIf: playOnly });
    install({
      ...createArbiterSystem(player.parent, portal, GameState),
      runIf: playOnly,
    });
    install({
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
    install({ ...createTimerSystem(), runIf: playOnly });
    install({ ...createHudSyncSystem(hud), runIf: playOnly });
    if (fontHandle !== undefined) {
      install({ ...createPickupTextSystem(fontHandle, GameState), runIf: playOnly });
    }
    install({ ...createAudioCueSystem(cues, signal), runIf: playOnly });

    // Dev-only verification hook deleted (M5 w24): createApp auto-wires
    // app.remote in dev mode — host reads player pose / fixes camera via
    // client.eval(script) against the eval channel. The old __cg hook is
    // replaced by the zero-cost present remote eval server.
  });

  // Hide the HUD when leaving Play (Win/Lose result screens land later); the
  // Title OnEnter resets GameProgress for the replay.
  addOnExit(GameState, 'Play', (w: World) => {
    for (const system of playSystems) w.removeSystem(Update, system).unwrap();
    playSystems.length = 0;
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

function spawnLight(world: World): EntityHandle {
  // D-7 / F-04: a DirectionalLight (default castShadow:true, real CSM) must
  // exist before any standard-material entity or the scene renders black.
  return world
    .spawn({
      component: DirectionalLight,
      data: { castShadow: true, direction: [-0.4, -1, -0.3], color: [1, 1, 1], intensity: 1 },
    })
    .unwrap();
}

function spawnSkylight(world: World): EntityHandle {
  return world
    .spawn({
      component: Skylight,
      data: { color: [0.9, 0.95, 1.0], intensity: 0.35 },
    })
    .unwrap();
}

async function attachSkyEquirect(
  world: World,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
  skylight: EntityHandle,
): Promise<EntityHandle | undefined> {
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry) || sceneAssets !== assets)
    throw new Error('Scene requires its runtime asset owner');

  const guidRes = AssetGuid.parse(SKY_HDR_GUID);
  if (!guidRes.ok) return undefined;
  const podRes = await assets.load(guidRes.value, 'equirect');
  if (!podRes.ok) return undefined;
  const equirect = podRes.value;

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
