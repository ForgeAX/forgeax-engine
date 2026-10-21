// apps/hello/level-switch/src/index.ts -- state-machine demo (feat-20260616 M7 / m7w1).
//
// Demonstrates the engine-state API end-to-end:
//   1. defineState('LevelId', ...) at module level
//   2. createApp(canvas) auto-wires registerStatesPlugin
//   3. assets.create creates managed tutorial + street-a scene handles
//   4. OnEnter(LevelId,'tutorial') assets.instantiate + despawnOnExit on scene root
//   5. Spawn a cross-state player entity (red cube, MeshFilter + MeshRenderer, no scope)
//   6. Keyboard handler (1 -> tutorial, 2 -> street-a, 3 -> main-menu)
//   7. HUD div shows the current state variant name

import { createApp } from '@forgeax/engine-app/browser';
import { Entity, Update, type EntityHandle } from '@forgeax/engine-ecs';

import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset, SceneAsset } from '@forgeax/engine-types';
import {
  addOnEnter,
  defineState,
  despawnOnEnter,
  despawnOnExit,
  getPreviousState,
  getState,
  setNextState,
  setNextStateForce,
} from '@forgeax/engine-state';
import type { StateTokenVariant } from '@forgeax/engine-state';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


export const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);
export const SessionPhase = defineState('SessionPhase', ['boot', 'ready'] as const);

// Scene labels shared with scripts/smoke-dawn.mjs; scene values are created inline.
const TUTORIAL_GUID = '6a000001-0001-4000-a000-000000000001';
const STREET_A_GUID = '6a000002-0001-4000-a000-000000000002';

export async function bootstrap(canvas: HTMLCanvasElement): Promise<void> {
  // M3 (w16): input:false opt-out deleted (D-6). Canvas form always attaches
  // input (D-2). This demo accepts input always-on — the state-switch keys
  // (1/2/3) continue to work via the InputSnapshot that inputPlugin provides.
  // Option (a) assemble-form migration was assessed but costs outweigh benefits
  // for a demo where input-always-on has zero correctness impact.
  const appResult = await createApp(canvas, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error(`[hello-level-switch] createApp failed:`, appResult.error);
    throw new Error('createApp failed');
  }
  const app = appResult.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  const { world } = app;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();


  console.log(`[hello-level-switch] backend=${app.renderer.inspect().capabilities.backendKind}`);

  const assets = app.assets;
  if (!assets) throw new Error('AssetRegistry is null');

  // Register scene materials. tutorial floor = orange unlit, street-a floor =
  // blue standard-PBR. Handles feed the inline scene PODs below.
  // assets.create returns the managed handles consumed by scene components.
  const unlitMatPayload = Materials.unlit([0.8, 0.4, 0.2, 1]);
  const unlitMatGuid = AssetGuid.parse('008e4f75-e7a3-4715-b05b-b93a9ec12074');
  if (!unlitMatGuid.ok) throw new Error('unlit material GUID parse failed');
  const unlitMatHandle = assets.create(unlitMatPayload).unwrap();

  const stdMatPayload: MaterialAsset = {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: { baseColor: [0.2, 0.3, 0.9], metallic: 0, roughness: 0.5 },
  };
  const stdMatGuid = AssetGuid.parse('f6af7007-158f-4d92-9e47-93bf2f213e1f');
  if (!stdMatGuid.ok) throw new Error('standard material GUID parse failed');
  const stdMatHandle = assets.create(stdMatPayload).unwrap();

  // Player material: red unlit for cross-state visibility.
  const playerMatHandle = assets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: { baseColor: [0.9, 0.2, 0.2] },
  }).unwrap();

  // Create inline scene assets, mirrored by smoke-dawn.mjs: tutorial has an
  // orange unlit floor; street-a has a blue standard-PBR floor. Both reuse
  // the managed cube mesh, scaled flat.
  const FLOOR_TRANSFORM = {
    pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [10, 0.1, 10],};

  const tutorialGuid = AssetGuid.parse(TUTORIAL_GUID);
  if (!tutorialGuid.ok) throw new Error('tutorial GUID parse failed');

  const tutorialSceneRes = assets.create({
    kind: 'scene',
    entities: {
      floor: {
        components: {
          Transform: FLOOR_TRANSFORM,
          MeshFilter: { assetHandle: primitiveCube },
          MeshRenderer: { materials: [Number(unlitMatHandle)] },
        },
      },
    },
  } satisfies SceneAsset);
  if (!tutorialSceneRes.ok) throw new Error(`tutorial create scene failed: ${tutorialSceneRes.error.code}`);

  const streetGuid = AssetGuid.parse(STREET_A_GUID);
  if (!streetGuid.ok) throw new Error('street-a GUID parse failed');

  const streetSceneRes = assets.create({
    kind: 'scene',
    entities: {
      floor: {
        components: {
          Transform: FLOOR_TRANSFORM,
          MeshFilter: { assetHandle: primitiveCube },
          MeshRenderer: { materials: [Number(stdMatHandle)] },
        },
      },
    },
  } satisfies SceneAsset);
  if (!streetSceneRes.ok) throw new Error(`street-a create scene failed: ${streetSceneRes.error.code}`);

  // Camera + light.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 2, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: Camera, data: { fov: 60, aspect: 800 / 600, near: 0.1, far: 100 } },
  );

  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [-0.3, -1.0, -0.5],
      color: [1.0, 0.95, 0.9], intensity: 1.0,
    },
  });

  // Cross-state player entity: red cube (HANDLE_CUBE), no scope — persists
  // across all state transitions. Raised above the floor plane and enlarged
  // so it is clearly visible against the dark background in every level
  // screenshot (cross-state persistence is the headline visual). Its world
  // position never changes across transitions — only the floor material does.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 1.2, 1.5], quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [playerMatHandle] } },
  );

  let tutorialRoot: EntityHandle | undefined;

  // OnEnter tutorial: instantiate scene, scope root for exit-cleanup. The
  // liveness guard makes the consumer callback safe to re-fire after a
  // forced same-state retry: the failed transition has already materialised
  // this root before a later callback throws.
  // Keep the scene handle across state entries; each instance owns its entity
  // lifetime, so despawning an instance leaves the scene asset available.
  addOnEnter(LevelId, 'tutorial', (w) => {
const sceneAssetsW = w.assets;
if (!(sceneAssetsW instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

    if (tutorialRoot !== undefined && w.get(tutorialRoot, Entity).ok) {
      return;
    }
    const ir = assets.instantiate(tutorialSceneRes.value, w);
    if (!ir.ok) {
      console.error(`[hello-level-switch] instantiate tutorial failed: ${ir.error.code}`);
      return;
    }
    const root = ir.value;
    tutorialRoot = root;
    despawnOnExit(w, root, LevelId, 'tutorial');
    console.log(`[hello-level-switch] tutorial scene spawned, root=${root}`);
  });

  // OnEnter street-a: instantiate scene, scope root for exit-cleanup.
  addOnEnter(LevelId, 'street-a', (w) => {
const sceneAssetsW = w.assets;
if (!(sceneAssetsW instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

    const ir = assets.instantiate(streetSceneRes.value, w);
    if (!ir.ok) {
      console.error(`[hello-level-switch] instantiate street-a failed: ${ir.error.code}`);
      return;
    }
    const root = ir.value;
    despawnOnExit(w, root, LevelId, 'street-a');
    console.log(`[hello-level-switch] street-a scene spawned, root=${root}`);
  });

  // DOM HUD: display current state variant name.
  const hud = document.createElement('div');
  hud.id = 'level-switch-hud';
  hud.style.cssText = [
    'position: absolute',
    'top: 16px',
    'left: 16px',
    'color: #fff',
    'font: 20px/1.4 system-ui, sans-serif',
    'padding: 8px 16px',
    'background: rgba(0,0,0,0.6)',
    'border-radius: 4px',
    'pointer-events: none',
    'z-index: 10',
  ].join('; ');
  const parentEl = canvas.parentElement;
  if (parentEl) {
    parentEl.style.position = 'relative';
    parentEl.appendChild(hud);
  }

  function refreshHud(): void {
    const s = getState(world, LevelId);
    hud.textContent = `Level: ${s.ok ? s.value : '???'}`;
  }

  Object.assign(globalThis as Record<string, unknown>, {
    __forgeax_level_switch_hud__: () => hud.textContent ?? '',
  });

  world
    .addSystem(Update, {
      name: 'level-switch-refresh-hud',
      queries: [],
      fn: refreshHud,
    })
    .unwrap();

  // Keyboard handler: 1 -> tutorial, 2 -> street-a, 3 -> main-menu.
  // The map values are typed as the LevelId variant union, so a typo here is
  // a compile error (PF-1: setNextState narrows variant to the token union).
  function onKeyDown(e: KeyboardEvent): void {
    const map: Record<string, StateTokenVariant<typeof LevelId>> = {
      '1': 'tutorial',
      '2': 'street-a',
      '3': 'main-menu',
    };
    const variant = map[e.key];
    if (variant !== undefined) {
      const r = setNextState(world, LevelId, variant);
      if (!r.ok) {
        console.error(`[hello-level-switch] setNextState failed: ${r.error.code}`);
      }
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // M29 real-consumer probe. It stays behind a narrow app-local diagnostic
  // surface so the browser smoke can drive the public App/World error path.
  // A thrown state callback poisons this World; recovery requires the owning
  // execution layer to rebuild a fresh World before any later frame.
  const m29Errors: Array<{ code: string; causeMatches: boolean }> = [];
  let m29Fault: Error | undefined;
  let m29LastCause: unknown;
  let m29FaultUnsubscribe: (() => void) | undefined;
  let m29MainMenuExit: EntityHandle | undefined;
  let m29TutorialEnter: EntityHandle | undefined;
  const m41StateKey = `__state__${LevelId.name}`;
  const m41InvalidVariant = String('m41-runtime-invalid');
  let m41MainMenuExit: EntityHandle | undefined;
  let m41TutorialEnter: EntityHandle | undefined;
  let m41RepairScope: EntityHandle | undefined;
  let m41CallbackRuns = 0;
  let m41Unsubscribe: (() => void) | undefined;
  let m41Cleaned = false;

  function m29CauseMatches(cause: unknown, depth = 0): boolean {
    if (cause === m29Fault) return true;
    if (depth > 4 || m29Fault === undefined || cause === null || typeof cause !== 'object') {
      return false;
    }
    const candidate = cause as {
      readonly name?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
      readonly detail?: { readonly cause?: unknown };
    };
    if (candidate.name === m29Fault.name && candidate.message === m29Fault.message) return true;
    return (
      m29CauseMatches(candidate.cause, depth + 1) ||
      m29CauseMatches(candidate.detail?.cause, depth + 1)
    );
  }

  app.onError((error) => {
    if (error.code === 'app-system-update-failed') {
      m29LastCause = error.detail.cause;
    }
    m29Errors.push({
      code: error.code,
      causeMatches: error.code === 'app-system-update-failed' && m29CauseMatches(error.detail.cause),
    });
  });

  function m29Alive(entity: EntityHandle | undefined): boolean {
    return entity !== undefined && world.get(entity, Entity).ok;
  }

  function m29Variant(token: typeof LevelId | typeof SessionPhase): string {
    const state = getState(world, token);
    return state.ok ? state.value : `error:${state.error.code}`;
  }

  function m29Previous(token: typeof LevelId | typeof SessionPhase): string {
    const state = getPreviousState(world, token);
    return state.ok ? state.value : `error:${state.error.code}`;
  }

  function m29MeshCount(): number {
    const query = world.query({ with: [MeshFilter] });
    if (!query.ok) return -1;
    let count = 0;
    for (const _row of query.value) count += 1;
    return count;
  }

  function m29Snapshot(): Record<string, unknown> {
    return {
      worldIdentity: world.identity,
      level: m29Variant(LevelId),
      previousLevel: m29Previous(LevelId),
      session: m29Variant(SessionPhase),
      previousSession: m29Previous(SessionPhase),
      mainMenuExitAlive: m29Alive(m29MainMenuExit),
      tutorialEnterAlive: m29Alive(m29TutorialEnter),
      meshEntityCount: m29MeshCount(),
      worldHealth: world.execution.health,
      appErrorCount: m29Errors.length,
      lastAppErrorCode: m29Errors.at(-1)?.code ?? null,
      lastCauseMatches: m29CauseMatches(m29LastCause),
    };
  }

  function m41RequestResult(result: ReturnType<typeof setNextState>): Record<string, unknown> {
    if (result.ok) return { ok: true };
    if (result.error.code === 'invalid-variant') {
      return {
        ok: false,
        code: result.error.code,
        detail: {
          code: result.error.code,
          name: result.error.detail.name,
          got: result.error.detail.got,
          valid: [...result.error.detail.valid],
        },
      };
    }
    return { ok: false, code: result.error.code, detail: result.error.detail };
  }

  function m41ExecutionSignature(): Record<string, unknown> {
    const inspection = world.inspect();
    return {
      systems: inspection.systems.map((system) => ({ name: system.name, sets: [...system.sets] })),
      schedules: inspection.schedules.map((schedule) => ({
        name: schedule.schedule.name,
        systems: schedule.systems.map((system) => ({ name: system.name, sets: [...system.sets] })),
      })),
      resourceKeys: [...inspection.resourceKeys].sort(),
    };
  }

  function m41PendingNextState(): Record<string, unknown> | null {
    const pending = world.getResource<{ next: { value: number; force: boolean } | undefined }>(m41StateKey).next;
    return pending === undefined ? null : { value: pending.value, force: pending.force };
  }

  function m41Snapshot(): Record<string, unknown> {
    const inspection = world.inspect();
    return {
      worldIdentity: world.identity,
      level: m29Variant(LevelId),
      previousLevel: m29Previous(LevelId),
      session: m29Variant(SessionPhase),
      previousSession: m29Previous(SessionPhase),
      pendingNextState: m41PendingNextState(),
      mainMenuExitAlive: m29Alive(m41MainMenuExit),
      tutorialEnterAlive: m29Alive(m41TutorialEnter),
      repairedScopeAlive: m29Alive(m41RepairScope),
      callbackRuns: m41CallbackRuns,
      entityCount: inspection.entityCount,
      meshEntityCount: m29MeshCount(),
      activeComponents: [...inspection.activeComponents].sort(),
      execution: m41ExecutionSignature(),
      appErrorCount: m29Errors.length,
    };
  }

  function m41RunInvalid(): Record<string, unknown> {
    if (m41Unsubscribe !== undefined || m41Cleaned) {
      return { ok: false, reason: 'probe-already-used', snapshot: m41Snapshot() };
    }
    const paused = app.pause();
    if (!paused.ok) {
      return { ok: false, reason: `pause:${paused.error.code}`, snapshot: m41Snapshot() };
    }

    m41MainMenuExit = world.spawn().unwrap();
    despawnOnExit(world, m41MainMenuExit, LevelId, 'main-menu');
    m41TutorialEnter = world.spawn().unwrap();
    despawnOnEnter(world, m41TutorialEnter, LevelId, 'tutorial');
    m41CallbackRuns = 0;
    m41RepairScope = undefined;
    m41Unsubscribe = addOnEnter(LevelId, 'tutorial', (w) => {
      m41CallbackRuns += 1;
      m41RepairScope = w.spawn().unwrap();
      despawnOnExit(w, m41RepairScope, LevelId, 'tutorial');
    });

    const before = m41Snapshot();
    const request = setNextState(world, LevelId, m41InvalidVariant as never);
    const forceRequest = setNextStateForce(world, LevelId, m41InvalidVariant as never);
    const afterRequest = m41Snapshot();
    const frame = app.stepFrame(1 / 60);
    const afterFrame = m41Snapshot();
    return {
      ok: !request.ok && !forceRequest.ok && frame.ok,
      request: m41RequestResult(request),
      forceRequest: m41RequestResult(forceRequest),
      frameCode: frame.ok ? null : frame.error.code,
      before,
      afterRequest,
      afterFrame,
    };
  }

  function m41Repair(): Record<string, unknown> {
    if (m41Unsubscribe === undefined || m41Cleaned) {
      return { ok: false, reason: 'probe-not-active', snapshot: m41Snapshot() };
    }
    const request = setNextState(world, LevelId, 'tutorial');
    const frame = app.stepFrame(1 / 60);
    return {
      ok: request.ok && frame.ok,
      request: m41RequestResult(request),
      frameCode: frame.ok ? null : frame.error.code,
      snapshot: m41Snapshot(),
    };
  }

  function m41Cleanup(): Record<string, unknown> {
    if (m41Cleaned) {
      return { ok: true, reason: 'already-clean', snapshot: m41Snapshot() };
    }
    if (m41Unsubscribe === undefined) {
      return { ok: false, reason: 'probe-not-active', snapshot: m41Snapshot() };
    }

    const cleanupRequest = setNextState(world, LevelId, 'main-menu');
    const cleanupFrame = app.stepFrame(1 / 60);
    const forceCleanupRequest = setNextStateForce(world, LevelId, 'main-menu');
    const forceCleanupFrame = app.stepFrame(1 / 60);
    const snapshot = m41Snapshot();
    m41Unsubscribe();
    m41Unsubscribe = undefined;
    m41Cleaned = true;
    const resumed = app.resume();
    return {
      ok: cleanupRequest.ok && cleanupFrame.ok && forceCleanupRequest.ok && forceCleanupFrame.ok && resumed.ok,
      cleanupRequest: m41RequestResult(cleanupRequest),
      cleanupFrameCode: cleanupFrame.ok ? null : cleanupFrame.error.code,
      forceCleanupRequest: m41RequestResult(forceCleanupRequest),
      forceCleanupFrameCode: forceCleanupFrame.ok ? null : forceCleanupFrame.error.code,
      resumeCode: resumed.ok ? null : resumed.error.code,
      snapshot,
    };
  }

  function m29RunFault(): Record<string, unknown> {
    if (m29FaultUnsubscribe !== undefined) {
      return { ok: false, reason: 'fault-already-installed', snapshot: m29Snapshot() };
    }
    const paused = app.pause();
    if (!paused.ok) {
      return { ok: false, reason: `pause:${paused.error.code}`, snapshot: m29Snapshot() };
    }

    const mainMenuExit = world.spawn().unwrap();
    m29MainMenuExit = mainMenuExit;
    despawnOnExit(world, mainMenuExit, LevelId, 'main-menu');
    const tutorialEnter = world.spawn().unwrap();
    m29TutorialEnter = tutorialEnter;
    despawnOnEnter(world, tutorialEnter, LevelId, 'tutorial');
    const fault = new Error('m29-state-callback-fault');
    m29Fault = fault;
    m29FaultUnsubscribe = addOnEnter(LevelId, 'tutorial', () => {
      throw fault;
    });

    const levelRequest = setNextState(world, LevelId, 'tutorial');
    const sessionRequest = setNextState(world, SessionPhase, 'ready');
    const frame = app.stepFrame(1 / 60);
    return {
      ok: levelRequest.ok && sessionRequest.ok && !frame.ok,
      frameCode: frame.ok ? null : frame.error.code,
      snapshot: m29Snapshot(),
    };
  }

  function m29RecoveryRequired(): Record<string, unknown> {
    if (m29FaultUnsubscribe !== undefined) {
      m29FaultUnsubscribe();
      m29FaultUnsubscribe = undefined;
    }
    const snapshot = m29Snapshot();
    return {
      ok: snapshot.worldHealth === 'poisoned',
      recovery: 'fresh-world-required',
      snapshot,
    };
  }

  Object.assign(globalThis as Record<string, unknown>, {
    __forgeax_level_switch__: {
      m29: {
        runFault: m29RunFault,
        recoveryRequired: m29RecoveryRequired,
        snapshot: m29Snapshot,
      },
      m41: {
        runInvalid: m41RunInvalid,
        repair: m41Repair,
        cleanup: m41Cleanup,
        snapshot: m41Snapshot,
      },
    },
  });

  // Start the app.
  const startResult = app.start();
  if (!startResult.ok) {
    console.error(`[hello-level-switch] app.start failed: ${startResult.error.code}`);
  }
}
