// apps/hello/audio -- spacebar one-shot SFX + movable 3D listener + collision
// cleanup demo
// (feat-20260529-hello-audio-demo-with-spacebar-one-shot-sfx-playba / M3 / w15,
//  updated feat-20260619 M3 w15: audioTickSystem is now auto-registered).
//
// What this demo exercises end-to-end:
//   - createApp(canvas, { plugins: [audioPlugin()] }) registers audioTickSystem
//     (input is in the canvas-form default plugin set, no longer an explicit opt).
//   - Declarative ECS audio path: AudioSource.playing edge is now genuinely
//     consumed by the auto-registered audioTickSystem (not imperative
//     backend.play() bypass).
//   - Spacebar re-arm one-shot state machine (D-3 / D-4):
//     consumer-side edge write — cross-frame false->true edge per keypress
//     via write-true-then-write-false. Not replaced by tick system (D-4).
//   - Listener sync via createAppFromCanvas auto-registered ECS addSystem
//     (M7 w25 — after propagateTransforms, reads current-frame GlobalTransform.world).
//     Independent of tick system; no manual registration needed (D-7/D-8).
//   - Overlay text readout (distance + L/R pan) as spatial audio
//     verification anchor (charter F2 -- AC-11)
//   - Pack-index asset resolution: sfx GUID -> packageUrl -> Pack v2 body ->
//     audio loader -> AudioSource.clip (AC-06 round-trip)
//
// D-3 one-shot edge mapping (unchanged from original):
//   audioTickSystem reads AudioSource.playing once per frame. A one-shot
//   trigger needs a real false->true transition across TWO frames. The
//   re-arm pattern: on spacebar up-edge, write playing=true; next frame
//   unconditionally write playing=false. This produces:
//     frame N:   false->true (tick sees edge N+1 -> backend.play)
//     frame N+1: true->false (tick sees edge N+2 -> backend.stop)
//     frame N+2+: false (ready for next keypress)
//   README records this ergonomics honestly (AC-08).
//
// SFX GUID SSOT:
//   forgeax-engine-assets/sfx/dragon-studio-correct-472358.mp3.meta.json
//   subAssets[0].guid = 019e7535-5e5e-75fe-a328-0b08e3a72744
const SFX_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import type { App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import {
  AudioListener,
  AudioSource,
  audioPlugin,
  type AudioBackend,
} from '@forgeax/engine-audio';
import { WebAudioEngine, webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import { installAudioControls } from './audio-controls';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { type AudioClipAsset, type Handle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';


const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-audio: missing <canvas id="app"> in index.html');

// M3 (w16): input is now in the canvas-form default set (D-2); audioPlugin()
// provides the Host-owned backend before the ECS audio consumer activates.
const hostAudio = new WebAudioEngine();
const appRes = await createApp(canvas, {
  ...(runtimeBinding !== undefined && import.meta.env.DEV ? { assetRuntimeBinding: runtimeBinding } : {}),
  plugins: [webAudioPlugin(hostAudio), audioPlugin(), physicsPlugin('rapier-3d')],
}, {
  ...forgeaxBundlerAdapter(),
  importTransport: createRuntimeAssetImportTransport(runtimeBinding),
});
if (!appRes.ok) {
  if (appRes.error instanceof EngineEnvironmentError) {
    console.error('[hello-audio] EngineEnvironmentError creating renderer');
  } else {
    console.error(`[hello-audio] ${appRes.error.code}: ${appRes.error.hint}`);
  }
  throw new Error('hello-audio: createApp failed');
}
const app: App = appRes.value;
console.warn(`[hello-audio] backend=${app.renderer.inspect().capabilities.backendKind}`);


// Step 2: point AssetRegistry at the Vite-emitted catalog. `loadByGuid` owns
// both dev and build lookup plus Web Audio decoding; demos never inspect the
// pack-index row or fetch the source URL themselves.
const assets = app.assets;
if (assets === undefined) throw new Error('hello-audio: assets unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);

const world = app.world;

// Step 3: spawn the 3D scene.
//   - Emitter: a marker cube at origin with AudioSource.
//   - Listener: Camera entity with AudioListener marker.
//   - DirectionalLight for visibility.

// Camera as listener (movable via WASD).
const cameraEntity = world
  .spawn(
    { component: Transform, data: { pos: [0, 1, 5]} },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 },
    },
    { component: AudioListener, data: {} },
  )
  .unwrap();

// DirectionalLight.
world
  .spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.5, -1, -0.3],
      color: [1, 1, 1],
      intensity: 1,
    },
  })
  .unwrap();

// Sentry value: a Handle strong enough to compile when AudioSource.clip
// is `handle<AudioClipAsset>` (branded number), yet semantically "none".
const HANDLE_NONE = 0 as unknown as Handle<'AudioClipAsset', 'shared'>;

// Emitter: marker cube at origin.
const emitterEntity = world
  .spawn(
    { component: Transform, data: { pos: [0, 0, 0]} },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
    {
      component: AudioSource,
      data: { clip: HANDLE_NONE, playing: false, spatialBlend: 1.0, bus: 'sfx' },
    },
  )
  .unwrap();

// Static floor for the post-gesture collision/audio journey. It is deliberately
// authored as normal ECS physics data so the demo exercises the same collision
// boundary as a consumer game, rather than calling the backend directly.
world
  .spawn(
    { component: Transform, data: { pos: [0, -1, 0], scale: [8, 0.5, 8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    {
      component: Collider,
      data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5] },
    },
  )
  .unwrap();

// Step 2b: the same GUID -> payload path used by generic editor bindings.
let sfxClipHandle: Handle<'AudioClipAsset', 'shared'> = HANDLE_NONE;
let m20StaleClipHandle: Handle<'AudioClipAsset', 'shared'> = HANDLE_NONE;
let m20CurrentClipHandle: Handle<'AudioClipAsset', 'shared'> = HANDLE_NONE;
let m20StaleSourceKey = '';
let m20CurrentSourceKey = '';
const sfxGuid = AssetGuid.parse(SFX_GUID);
if (!sfxGuid.ok) {
  console.error('[hello-audio] invalid SFX GUID:', SFX_GUID);
} else {
  const loadRes = await assets.loadByGuid<AudioClipAsset>(sfxGuid.value);
  if (loadRes.ok) {
    if (loadRes.value.stream)
      throw new Error('[hello-audio] stale-decode fixture requires a buffered short SFX');
    sfxClipHandle = world.allocSharedRef('AudioClipAsset', loadRes.value);
    world.set(emitterEntity, AudioSource, {
      clip: sfxClipHandle,
      playing: false,
      spatialBlend: 1.0,
      bus: 'sfx',
    });
    m20StaleSourceKey = `${loadRes.value.sourceKey}:m20-stale-decode`;
    m20StaleClipHandle = world.allocSharedRef('AudioClipAsset', {
      ...loadRes.value,
      sourceKey: m20StaleSourceKey,
      bytes: loadRes.value.bytes.slice(),
    });
    m20CurrentSourceKey = `${loadRes.value.sourceKey}:m20-current-epoch`;
    m20CurrentClipHandle = world.allocSharedRef('AudioClipAsset', {
      ...loadRes.value,
      sourceKey: m20CurrentSourceKey,
      bytes: loadRes.value.bytes.slice(),
    });
    console.warn('[hello-audio] SFX loaded and registered');
  } else {
    console.error('[hello-audio] loadByGuid failed:', loadRes.error.code, loadRes.error.hint);
  }
}

// Step 4: spacebar re-arm one-shot state machine (D-3).
// Per-frame update callback registered via world.addSystem(Update, ...).
// The re-arm produces:
//   - On spacebar up-edge: write AudioSource.playing=true
//   - Next frame: write AudioSource.playing=false (re-arm for next press)
let spacebarReArm = false;
const sfxClipHandleLoaded = () => sfxClipHandle;

// Step 5-6: listener sync loop + overlay readout.
// Runs inside the same Update system.
const overlayEl = document.querySelector<HTMLDivElement>('#overlay');
const listenerEntity = cameraEntity;
const emitterEntityId = emitterEntity;
const audioEngine = world.getResource<AudioBackend>('AudioEngine');
let audioStarts = 0;
let collisionDetected = false;
let collisionAudioStarted = false;
let collisionCleanup = false;
let collisionActor: import('@forgeax/engine-ecs').EntityHandle | undefined;
let collisionAudioAge = 0;

type M20AudioSnapshot = {
  readonly phase: string;
  readonly staleSourceKey: string;
  readonly currentSourceKey: string;
  readonly entityId: number | null;
  readonly entityAlive: boolean;
  readonly cleanupCalls: number;
  readonly audio: ReturnType<AudioBackend['getState']>;
};

let m20ProbeEntity: EntityHandle | undefined;
let m20Phase = 'idle';
let m20CleanupCalls = 0;

function m20Snapshot(): M20AudioSnapshot {
  const entityId = m20ProbeEntity === undefined ? null : Number(m20ProbeEntity);
  const entityAlive = m20ProbeEntity !== undefined && world.get(m20ProbeEntity, AudioSource).ok;
  return {
    phase: m20Phase,
    staleSourceKey: m20StaleSourceKey,
    currentSourceKey: m20CurrentSourceKey,
    entityId,
    entityAlive,
    cleanupCalls: m20CleanupCalls,
    audio: audioEngine.getState(),
  };
}

function m20EnsureProbe(): EntityHandle | undefined {
  if (m20StaleClipHandle === HANDLE_NONE) return undefined;
  if (m20ProbeEntity !== undefined && world.get(m20ProbeEntity, AudioSource).ok) {
    return m20ProbeEntity;
  }
  const spawned = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    {
      component: AudioSource,
      data: {
        clip: m20StaleClipHandle,
        playing: false,
        loop: true,
        volume: 0.2,
        spatialBlend: 1.0,
        bus: 'sfx',
      },
    },
  );
  if (!spawned.ok) return undefined;
  m20ProbeEntity = spawned.value;
  return m20ProbeEntity;
}

const m20AudioController = {
  begin(): M20AudioSnapshot {
    const entity = m20EnsureProbe();
    if (entity === undefined) {
      m20Phase = 'clip-not-ready';
      return m20Snapshot();
    }
    world.set(entity, AudioSource, {
      clip: m20StaleClipHandle,
      playing: true,
      loop: true,
      volume: 0.2,
      spatialBlend: 1.0,
      bus: 'sfx',
    });
    m20Phase = 'pending-decode';
    return m20Snapshot();
  },
  stopStale(): M20AudioSnapshot {
    if (m20ProbeEntity !== undefined && world.get(m20ProbeEntity, AudioSource).ok) {
      world.set(m20ProbeEntity, AudioSource, {
        clip: m20StaleClipHandle,
        playing: false,
        loop: true,
        volume: 0.2,
        spatialBlend: 1.0,
        bus: 'sfx',
      });
    }
    m20Phase = 'stale-stopped';
    return m20Snapshot();
  },
  replaceCurrentEpoch(): M20AudioSnapshot {
    const entity = m20EnsureProbe();
    if (entity !== undefined) {
      world.set(entity, AudioSource, {
        clip: m20CurrentClipHandle,
        playing: true,
        loop: true,
        volume: 0.2,
        spatialBlend: 1.0,
        bus: 'sfx',
      });
    }
    m20Phase = 'replacement-requested';
    return m20Snapshot();
  },
  markRecovered(): M20AudioSnapshot {
    m20Phase = 'current-epoch-playing';
    return m20Snapshot();
  },
  cleanup(): M20AudioSnapshot {
    m20CleanupCalls += 1;
    if (m20ProbeEntity !== undefined && world.get(m20ProbeEntity, AudioSource).ok) {
      world.set(m20ProbeEntity, AudioSource, {
        clip: m20CurrentClipHandle,
        playing: false,
        loop: true,
        volume: 0.2,
        spatialBlend: 1.0,
        bus: 'sfx',
      });
      world.despawn(m20ProbeEntity);
      m20Phase = 'cleanup-requested';
    } else {
      m20Phase = 'cleanup-idempotent';
    }
    return m20Snapshot();
  },
  snapshot(): M20AudioSnapshot {
    return m20Snapshot();
  },
};

const browserGlobals = globalThis as typeof globalThis & {
  __forgeaxAudioM20?: typeof m20AudioController;
};
browserGlobals.__forgeaxAudioM20 = m20AudioController;

// Camera movement speed (units/second).
const MOVE_SPEED = 5;

world
  .addSystem(Update, {
    name: 'hello-audio-frame',
    queries: [],
    fn: () => {
      const _dt = world.getResource(Time).delta;
      const audioState = audioEngine.getState();
      // Re-read clip handle in case asset loaded after boot.
  const currentClip = sfxClipHandleLoaded();

  // --- Input ---
  const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);

  // Camera movement (WASD).
  if (snap) {
    const transformRes = world.get(listenerEntity, Transform);
    if (transformRes.ok) {
      const tg = transformRes.value;
      let dx = 0;
      let dz = 0;
      if (snap.keyboard.down('w') || snap.keyboard.down('W')) dz -= MOVE_SPEED * _dt;
      if (snap.keyboard.down('s') || snap.keyboard.down('S')) dz += MOVE_SPEED * _dt;
      if (snap.keyboard.down('a') || snap.keyboard.down('A')) dx -= MOVE_SPEED * _dt;
      if (snap.keyboard.down('d') || snap.keyboard.down('D')) dx += MOVE_SPEED * _dt;
      if (dx !== 0 || dz !== 0) {
        world.set(listenerEntity, Transform, {
          pos: [(tg.pos[0] ?? 0) + dx, tg.pos[1] ?? 0, (tg.pos[2] ?? 0) + dz],
        });
      }
    }
  }

  // --- Spacebar re-arm state machine (D-3) ---
  if (snap && currentClip !== HANDLE_NONE) {
    const spaceUp = snap.keyboard.up(' ');

    if (spacebarReArm) {
      // Frame after keypress: write false to re-arm.
      world.set(emitterEntityId, AudioSource, {
        clip: currentClip,
        playing: false,
        spatialBlend: 1.0,
        bus: 'sfx',
      });
      spacebarReArm = false;
    } else if (spaceUp) {
      // Spacebar up-edge: write true (produces false->true edge
      // seen by audioTickSystem next frame).
      world.set(emitterEntityId, AudioSource, {
        clip: currentClip,
        playing: true,
        spatialBlend: 1.0,
        bus: 'sfx',
      });
      audioStarts += 1;
      spacebarReArm = true;

      // The same user gesture also starts the physics leg. The actor owns its
      // AudioSource so despawning it proves both Collider and audio cleanup.
      if (collisionActor === undefined) {
        collisionActor = world
          .spawn(
            { component: Transform, data: { pos: [0, 3, 0] } },
            { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
            { component: MeshRenderer, data: {} },
            {
              component: RigidBody,
              data: { type: RigidBodyTypeValue.dynamic, mass: 1, linearDamping: 0.01 },
            },
            {
              component: Collider,
              data: {
                shape: ColliderShapeValue.sphere,
                radius: 0.5,
                restitution: 0,
                friction: 0.5,
              },
            },
            { component: CollidingEntities, data: { entities: [] } },
            {
              component: AudioSource,
              data: {
                clip: currentClip,
                playing: false,
                spatialBlend: 1.0,
                bus: 'sfx',
              },
            },
          )
          .unwrap();
        collisionAudioAge = 0;
      }
    }
  }

  // --- Collision -> spatial audio -> entity cleanup journey ---
  if (collisionActor !== undefined) {
    const contacts = world.get(collisionActor, CollidingEntities);
    const overlaps = contacts.ok ? Array.from(contacts.value.entities as ArrayLike<number>) : [];
    if (overlaps.length > 0) {
      collisionDetected = true;
      if (!collisionAudioStarted) {
        world.set(collisionActor, AudioSource, {
          clip: currentClip,
          playing: true,
          spatialBlend: 1.0,
          bus: 'sfx',
        });
        audioStarts += 1;
        collisionAudioStarted = true;
        collisionAudioAge = 0;
      }
    }
    // Give audioTickSystem a few frames to observe the true edge, then use the
    // normal ECS despawn path. Audio cleanup is intentionally inferred from the
    // backend active-source count below, not from a backend-specific call.
    if (collisionAudioStarted) collisionAudioAge += 1;
    if (collisionAudioStarted && collisionAudioAge > 8) {
      world.despawn(collisionActor);
      collisionActor = undefined;
      collisionCleanup = true;
    }
  }

  const listenerTf = world.get(listenerEntity, GlobalTransform);
  const listenerWorld = listenerTf.ok ? listenerTf.value.world : undefined;

  // --- Overlay readout (AC-11) ---
  if (overlayEl) {
    const emitterTf = world.get(emitterEntityId, GlobalTransform);
    const emitterWorld = emitterTf.ok ? emitterTf.value.world : undefined;
    if (listenerWorld !== undefined && emitterWorld !== undefined) {
      // World-space position = translation column (m[12], m[14] for x, z).
      const lx = listenerWorld[12] ?? 0;
      const lz = listenerWorld[14] ?? 0;
      const ex = emitterWorld[12] ?? 0;
      const ez = emitterWorld[14] ?? 0;
      const dx = ex - lx;
      const dz = ez - lz;
      const distance = Math.hypot(dx, 0, dz).toFixed(1);
      const pan = ex < lx ? 'L' : ex > lx ? 'R' : 'C';
      overlayEl.innerHTML = [
        '<b>spacebar</b> = one-shot SFX &amp; resume AudioContext<br />',
        '<b>WASD</b> = move listener<br />',
        `distance = ${distance} | pan = ${pan}<br />`,
        `<span id="physics-status">collision=${collisionDetected ? 1 : 0} | cleanup=${collisionCleanup ? 1 : 0}</span><br />`,
        `<span id="audio-status">audio=${audioState.contextState} | active=${audioState.activeSourceCount} | starts=${audioStarts}</span>`,
        `<span id="m20-status">m20=${m20Phase} | probe=${m20ProbeEntity === undefined ? 'none' : m20Snapshot().entityAlive ? 'alive' : 'gone'}</span>`,
      ].join('');
    }
  }
    },
  })
  .unwrap();

if (sfxClipHandle !== HANDLE_NONE) installAudioControls(app, hostAudio, sfxClipHandle);

const startRes = app.start();
if (!startRes.ok) {
  console.error(`[hello-audio] app.start failed: ${startRes.error.code}`);
  throw new Error('hello-audio: app.start failed');
}
console.warn('[hello-audio] running. Press spacebar for SFX, WASD to move listener.');
