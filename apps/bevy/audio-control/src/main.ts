// Reproduce Bevy's `audio_control` example.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AudioSource, type AudioBackend, audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import { Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AudioClipAsset, Handle } from '@forgeax/engine-types';

import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildAudioControlWorld, HANDLE_NONE } from './audio-control';

const MUSIC_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
const audioStatus = document.querySelector<HTMLSpanElement>('#audio-status');
const controlStatus = document.querySelector<HTMLSpanElement>('#control-status');
if (!canvas || !audioStatus || !controlStatus) throw new Error('bevy-audio-control: missing canvas or overlay elements');

const appResult = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] }, { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) });
if (!appResult.ok) {
  if (appResult.error instanceof EngineEnvironmentError) console.error('[bevy-audio-control] EngineEnvironmentError creating renderer');
  else console.error(`[bevy-audio-control] ${appResult.error.code}: ${appResult.error.hint}`);
  throw new Error('bevy-audio-control: createApp failed');
}
const app = appResult.value;
app.onError((error) => console.error(`[bevy-audio-control] app-error ${error.code}`));

const world = app.world;
const scene = buildAudioControlWorld(world, canvas.width / Math.max(canvas.height, 1));
const assets = app.assets;
if (assets === undefined) throw new Error('bevy-audio-control: assets unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);
const audio = world.getResource<AudioBackend>('AudioEngine');
if (!audio) throw new Error('bevy-audio-control: AudioEngine resource missing');

let clipHandle: Handle<'AudioClipAsset', 'shared'> = HANDLE_NONE;
let loaded = false;
const guid = AssetGuid.parse(MUSIC_GUID);
if (!guid.ok) throw new Error(`bevy-audio-control: invalid music GUID ${MUSIC_GUID}`);
const clipResult = await assets.loadByGuid<AudioClipAsset>(guid.value);
if (clipResult.ok) {
  clipHandle = world.allocSharedRef('AudioClipAsset', clipResult.value);
  loaded = true;
  world.set(scene.music, AudioSource, { clip: clipHandle, playing: false, loop: true, volume: 1, spatialBlend: 0, bus: 'music' });
} else {
  console.error('[bevy-audio-control] loadByGuid failed:', clipResult.error.code, clipResult.error.hint);
}

let playing = false;
let muted = false;
let volume = 0.8;
let previousSpace = false;
let previousMute = false;
let previousDown = false;
let previousUp = false;
const writeControls = () => {
  if (!loaded) return;
  world.set(scene.music, AudioSource, { playing, volume: 1, loop: true, bus: 'music' });
  audio.setBusVolume('music', volume);
  audio.setBusMute('music', muted);
};

world.addSystem(Update, {
  name: 'audio-control-input',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: () => {
    const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const space = input?.keyboard.down(' ') ?? false;
    const mute = input?.keyboard.down('m') || input?.keyboard.down('M') || false;
    const down = input?.keyboard.down('-') ?? false;
    const up = input?.keyboard.down('=') || input?.keyboard.down('+') || false;
    if (space && !previousSpace && loaded) playing = !playing;
    if (mute && !previousMute && loaded) muted = !muted;
    if (down && !previousDown) volume = Math.max(0, Number((volume - 0.1).toFixed(2)));
    if (up && !previousUp) volume = Math.min(1, Number((volume + 0.1).toFixed(2)));
    previousSpace = space;
    previousMute = mute;
    previousDown = down;
    previousUp = up;
    writeControls();
    const state = audio.getState();
    audioStatus.textContent = `audio=${state.contextState} | active=${state.activeSourceCount} | loaded=${loaded ? 1 : 0}`;
    controlStatus.textContent = `playing=${playing ? 1 : 0} | muted=${muted ? 1 : 0} | volume=${volume.toFixed(2)}`;
  },
});

const started = app.start();
if (!started.ok) throw new Error(`bevy-audio-control: app.start failed: ${started.error.code}`);
(window as typeof window & { __audioControlStop?: () => { contextState: string; activeSourceCount: number } }).__audioControlStop = () => {
  const stopped = app.stop();
  if (!stopped.ok) throw new Error(`app.stop failed: ${stopped.error.code}`);
  return audio.getState();
};
console.warn('[bevy-audio-control] running. Space toggles playback; M mutes; -/= changes music-bus volume.');
