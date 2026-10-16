// Reproduce Bevy's `audio` example.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AudioSource, type AudioBackend, audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import { Update } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AudioClipAsset, Handle } from '@forgeax/engine-types';

import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildAudioWorld, HANDLE_NONE } from './audio';

const AUDIO_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
const audioStatus = document.querySelector<HTMLSpanElement>('#audio-status');
if (!canvas || !audioStatus) throw new Error('bevy-audio: missing canvas or overlay');

const appResult = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()], pointerLockAllowed: () => false }, { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) });
if (!appResult.ok) {
  if (appResult.error instanceof EngineEnvironmentError) console.error('[bevy-audio] EngineEnvironmentError creating renderer');
  else console.error(`[bevy-audio] ${appResult.error.code}: ${appResult.error.hint}`);
  throw new Error('bevy-audio: createApp failed');
}
const app = appResult.value;
app.onError((error) => console.error(`[bevy-audio] app-error ${error.code}`));

const world = app.world;
const scene = buildAudioWorld(world, canvas.width / Math.max(canvas.height, 1));
const assets = app.assets;
if (assets === undefined) throw new Error('bevy-audio: assets unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);
const audio = world.getResource<AudioBackend>('AudioEngine');
if (!audio) throw new Error('bevy-audio: AudioEngine resource missing');

let clipHandle: Handle<'AudioClipAsset', 'shared'> = HANDLE_NONE;
let loaded = false;
const guid = AssetGuid.parse(AUDIO_GUID);
if (!guid.ok) throw new Error(`bevy-audio: invalid audio GUID ${AUDIO_GUID}`);
const clipResult = await assets.loadByGuid<AudioClipAsset>(guid.value);
if (clipResult.ok) {
  clipHandle = world.allocSharedRef('AudioClipAsset', clipResult.value);
  loaded = true;
  world.set(scene.source, AudioSource, { clip: clipHandle, playing: true, loop: true, volume: 1, spatialBlend: 0, bus: 'music' });
} else {
  console.error('[bevy-audio] loadByGuid failed:', clipResult.error.code, clipResult.error.hint);
}

world.addSystem(Update, {
  name: 'audio-status-overlay',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: () => {
    const state = audio.getState();
    audioStatus.textContent = `audio=${state.contextState} | active=${state.activeSourceCount} | loaded=${loaded ? 1 : 0} | playing=${loaded ? 1 : 0}`;
  },
});

const started = app.start();
if (!started.ok) throw new Error(`bevy-audio: app.start failed: ${started.error.code}`);
(window as typeof window & { __audioStop?: () => { contextState: string; activeSourceCount: number } }).__audioStop = () => {
  const stopped = app.stop();
  if (!stopped.ok) throw new Error(`app.stop failed: ${stopped.error.code}`);
  return audio.getState();
};
console.warn('[bevy-audio] running. The imported clip starts automatically, subject to browser autoplay policy.');
