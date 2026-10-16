// Reproduce Bevy's `spatial_audio_3d` example.
//
// The emitter uses the declarative AudioSource path. The browser gesture starts
// the loop, while the listener's ECS Transform drives Web Audio panning.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AudioSource, audioPlugin } from '@forgeax/engine-audio';
import { WebAudioEngine, webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import { Update, Time } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type AudioClipAsset, type Handle } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpatialAudioWorld, HANDLE_NONE } from './spatial-audio-3d';

const SFX_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';
const MOVE_SPEED = 3.5;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const audioStatus = document.querySelector<HTMLSpanElement>('#audio-status');
const spatialStatus = document.querySelector<HTMLSpanElement>('#spatial-status');
if (!canvas || !audioStatus || !spatialStatus) {
  throw new Error('bevy-spatial-audio-3d: missing canvas or overlay elements');
}

const appResult = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] }, {
  ...forgeaxBundlerAdapter(),
  importTransport: createRuntimeAssetImportTransport(runtimeBinding),
});
if (!appResult.ok) {
  if (appResult.error instanceof EngineEnvironmentError) {
    console.error('[bevy-spatial-audio-3d] EngineEnvironmentError creating renderer');
  } else {
    console.error(`[bevy-spatial-audio-3d] ${appResult.error.code}: ${appResult.error.hint}`);
  }
  throw new Error('bevy-spatial-audio-3d: createApp failed');
}

const app = appResult.value;

const world = app.world;
const scene = buildSpatialAudioWorld(world, canvas.width / Math.max(canvas.height, 1));
const assets = app.assets;
if (assets === undefined) throw new Error('bevy-spatial-audio-3d: assets unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);
const audioEngine = world.getResource<WebAudioEngine>('AudioEngine');

let clipHandle: Handle<'AudioClipAsset', 'shared'> = HANDLE_NONE;
let loaded = false;
const guid = AssetGuid.parse(SFX_GUID);
if (!guid.ok) {
  console.error('[bevy-spatial-audio-3d] invalid SFX GUID:', SFX_GUID);
} else {
  const clipResult = await assets.loadByGuid<AudioClipAsset>(guid.value);
  if (clipResult.ok) {
    clipHandle = world.allocSharedRef('AudioClipAsset', clipResult.value);
    loaded = true;
    world.set(scene.emitter, AudioSource, {
      clip: clipHandle,
      playing: false,
      loop: true,
      volume: 0.8,
      spatialBlend: 1,
      bus: 'sfx',
    });
    console.warn('[bevy-spatial-audio-3d] SFX loaded and registered');
  } else {
    console.error('[bevy-spatial-audio-3d] loadByGuid failed:', clipResult.error.code, clipResult.error.hint);
  }
}

let previousSpace = false;
let previousMute = false;
let previousMove = false;
let emitterMoving = false;
let muted = false;
let emitterPhase = 0;

world.addSystem(Update, {
  name: 'spatial-audio-3d-controls',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: () => {
    const dt = world.getResource(Time).delta;
    const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const listenerTransform = world.get(scene.listener, Transform);
    const emitterTransform = world.get(scene.emitter, Transform);
    if (!listenerTransform.ok || !emitterTransform.ok) return;

    let listenerX = listenerTransform.value.pos[0] ?? 0;
    let listenerZ = listenerTransform.value.pos[2] ?? 5;
    if (snapshot) {
      if (snapshot.keyboard.down('a') || snapshot.keyboard.down('A')) listenerX -= MOVE_SPEED * dt;
      if (snapshot.keyboard.down('d') || snapshot.keyboard.down('D')) listenerX += MOVE_SPEED * dt;
      if (snapshot.keyboard.down('w') || snapshot.keyboard.down('W')) listenerZ -= MOVE_SPEED * dt;
      if (snapshot.keyboard.down('s') || snapshot.keyboard.down('S')) listenerZ += MOVE_SPEED * dt;
      const space = snapshot.keyboard.down(' ');
      const mute = snapshot.keyboard.down('m') || snapshot.keyboard.down('M');
      const move = snapshot.keyboard.down('e') || snapshot.keyboard.down('E');
      if (space && !previousSpace && loaded) {
        const current = world.get(scene.emitter, AudioSource);
        if (current.ok) {
          world.set(scene.emitter, AudioSource, {
            clip: clipHandle,
            playing: !current.value.playing,
            loop: true,
            volume: 0.8,
            spatialBlend: 1,
            bus: 'sfx',
          });
        }
      }
      if (mute && !previousMute) {
        muted = !muted;
        audioEngine.setBusMute('sfx', muted);
      }
      if (move && !previousMove) emitterMoving = !emitterMoving;
      previousSpace = space;
      previousMute = mute;
      previousMove = move;
    }

    if (listenerX !== (listenerTransform.value.pos[0] ?? 0) || listenerZ !== (listenerTransform.value.pos[2] ?? 5)) {
      world.set(scene.listener, Transform, { pos: [listenerX, listenerTransform.value.pos[1] ?? 1.4, listenerZ] });
      world.set(scene.leftEar, Transform, { pos: [listenerX - 0.35, listenerTransform.value.pos[1] ?? 1.4, listenerZ - 1.5] });
      world.set(scene.rightEar, Transform, { pos: [listenerX + 0.35, listenerTransform.value.pos[1] ?? 1.4, listenerZ - 1.5] });
    }

    if (emitterMoving) {
      emitterPhase += dt * 1.8;
      world.set(scene.emitter, Transform, {
        pos: [Math.sin(emitterPhase) * 2.2, 0.9, Math.cos(emitterPhase * 0.7) * 0.8],
      });
    }

    const source = world.get(scene.emitter, AudioSource);
    const state = audioEngine.getState();
    audioStatus.textContent = `audio=${state.contextState} | active=${state.activeSourceCount} | loaded=${loaded ? 1 : 0} | playing=${source.ok && source.value.playing ? 1 : 0} | mute=${muted ? 1 : 0}`;
    const emitterX = emitterTransform.value.pos[0] ?? 0;
    const pan = emitterX - listenerX > 0.15 ? 'R' : emitterX - listenerX < -0.15 ? 'L' : 'C';
    spatialStatus.textContent = `listener=(${listenerX.toFixed(1)}, ${listenerZ.toFixed(1)}) | emitter=(${emitterX.toFixed(1)}, ${(emitterTransform.value.pos[2] ?? 0).toFixed(1)}) | pan=${pan}`;
  },
});

const started = app.start();
if (!started.ok) {
  console.error('[bevy-spatial-audio-3d] app.start() failed:', started.error);
  throw new Error('bevy-spatial-audio-3d: app.start failed');
}
(window as typeof window & {
  __spatialAudioStop?: () => { contextState: string; activeSourceCount: number };
}).__spatialAudioStop = () => {
  const stopped = app.stop();
  if (!stopped.ok) throw new Error(`app.stop failed: ${stopped.error.code}`);
  return audioEngine.getState();
};
console.warn('[bevy-spatial-audio-3d] running. Press Space to start spatial SFX.');
