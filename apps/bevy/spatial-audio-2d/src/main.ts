import type { AssetHandle } from '@forgeax/engine-types';
// Reproduce Bevy's `spatial_audio_2d` example.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AudioSource, audioPlugin } from '@forgeax/engine-audio';
import { WebAudioEngine, webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import { Time, Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { Transform } from '@forgeax/engine-scene';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpatialAudio2dWorld, HANDLE_NONE } from './spatial-audio-2d';

const SFX_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';
const MOVE_SPEED = 3.2;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const audioStatus = document.querySelector<HTMLSpanElement>('#audio-status');
const spatialStatus = document.querySelector<HTMLSpanElement>('#spatial-status');
if (!canvas || !audioStatus || !spatialStatus) throw new Error('bevy-spatial-audio-2d: missing canvas or overlay elements');

const appResult = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] }, {
  ...forgeaxBundlerAdapter(),
  importTransport: createRuntimeAssetImportTransport(runtimeBinding),
});
if (!appResult.ok) {
  if (appResult.error instanceof EngineEnvironmentError) console.error('[bevy-spatial-audio-2d] EngineEnvironmentError creating renderer');
  else console.error(`[bevy-spatial-audio-2d] ${appResult.error.code}: ${appResult.error.hint}`);
  throw new Error('bevy-spatial-audio-2d: createApp failed');
}

const app = appResult.value;

const world = app.world;
const scene = buildSpatialAudio2dWorld(world, canvas.width / Math.max(canvas.height, 1));
const assets = app.assets;
if (assets === undefined) throw new Error('bevy-spatial-audio-2d: assets unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);
const audioEngine = world.getResource<WebAudioEngine>('AudioEngine');

let clipHandle: AssetHandle<'audio'> = HANDLE_NONE;
let loaded = false;
const guid = AssetGuid.parse(SFX_GUID);
if (guid.ok) {
  const clipResult = await assets.load(guid.value, 'audio');
  if (clipResult.ok) {
    clipHandle = clipResult.value;
    loaded = true;
    world.set(scene.emitter, AudioSource, { clip: clipHandle, playing: false, loop: true, volume: 0.8, spatialBlend: 1, bus: 'sfx' });
  } else console.error('[bevy-spatial-audio-2d] loadByGuid failed:', clipResult.error.code, clipResult.error.hint);
} else console.error('[bevy-spatial-audio-2d] invalid SFX GUID:', SFX_GUID);

let previousSpace = false;
let previousMute = false;
let previousMove = false;
let emitterMoving = false;
let muted = false;
let emitterPhase = 0;

world.addSystem(Update, {
  name: 'spatial-audio-2d-controls',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: () => {
    const dt = world.getResource(Time).delta;
    const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const listenerTransform = world.get(scene.listener, Transform);
    const emitterTransform = world.get(scene.emitter, Transform);
    if (!listenerTransform.ok || !emitterTransform.ok) return;

    let listenerX = listenerTransform.value.pos[0] ?? 0;
    let listenerY = listenerTransform.value.pos[1] ?? 0;
    if (snapshot) {
      if (snapshot.keyboard.down('a') || snapshot.keyboard.down('ArrowLeft')) listenerX -= MOVE_SPEED * dt;
      if (snapshot.keyboard.down('d') || snapshot.keyboard.down('ArrowRight')) listenerX += MOVE_SPEED * dt;
      if (snapshot.keyboard.down('w') || snapshot.keyboard.down('ArrowUp')) listenerY += MOVE_SPEED * dt;
      if (snapshot.keyboard.down('s') || snapshot.keyboard.down('ArrowDown')) listenerY -= MOVE_SPEED * dt;
      const space = snapshot.keyboard.down(' ');
      const mute = snapshot.keyboard.down('m') || snapshot.keyboard.down('M');
      const move = snapshot.keyboard.down('e') || snapshot.keyboard.down('E');
      if (space && !previousSpace && loaded) {
        const current = world.get(scene.emitter, AudioSource);
        if (current.ok) world.set(scene.emitter, AudioSource, { clip: clipHandle, playing: !current.value.playing, loop: true, volume: 0.8, spatialBlend: 1, bus: 'sfx' });
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

    world.set(scene.listener, Transform, { pos: [listenerX, listenerY, 0] });
    world.set(scene.leftEar, Transform, { pos: [listenerX - 0.45, listenerY, 0] });
    world.set(scene.rightEar, Transform, { pos: [listenerX + 0.45, listenerY, 0] });

    if (emitterMoving) {
      emitterPhase += dt * 1.8;
      world.set(scene.emitter, Transform, { pos: [Math.sin(emitterPhase) * 2.8, 1.2, 0] });
    }

    const source = world.get(scene.emitter, AudioSource);
    const state = audioEngine.getState();
    audioStatus.textContent = `audio=${state.contextState} | active=${state.activeSourceCount} | loaded=${loaded ? 1 : 0} | playing=${source.ok && source.value.playing ? 1 : 0} | mute=${muted ? 1 : 0}`;
    const currentEmitterTransform = world.get(scene.emitter, Transform);
    const emitterX = currentEmitterTransform.ok ? currentEmitterTransform.value.pos[0] ?? 0 : 0;
    const emitterY = currentEmitterTransform.ok ? currentEmitterTransform.value.pos[1] ?? 0 : 0;
    const dx = emitterX - listenerX;
    const pan = dx > 0.15 ? 'R' : dx < -0.15 ? 'L' : 'C';
    spatialStatus.textContent = `listener=(${listenerX.toFixed(1)}, ${listenerY.toFixed(1)}) | emitter=(${emitterX.toFixed(1)}, ${emitterY.toFixed(1)}) | pan=${pan}`;
  },
});

const started = app.start();
if (!started.ok) throw new Error(`bevy-spatial-audio-2d: app.start failed: ${started.error.code}`);
(window as typeof window & { __spatialAudio2dStop?: () => { contextState: string; activeSourceCount: number } }).__spatialAudio2dStop = () => {
  const stopped = app.stop();
  if (!stopped.ok) throw new Error(`app.stop failed: ${stopped.error.code}`);
  return audioEngine.getState();
};
console.warn('[bevy-spatial-audio-2d] running. Press Space to start spatial SFX.');
