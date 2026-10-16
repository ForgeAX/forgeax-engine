// Reproduce Bevy's `play_sound_effect` example.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AudioSource, audioPlugin } from '@forgeax/engine-audio';
import { WebAudioEngine, webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import { Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AudioClipAsset, Handle } from '@forgeax/engine-types';

import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildPlaySoundEffectWorld, HANDLE_NONE } from './play-sound-effect';

const SFX_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const audioStatus = document.querySelector<HTMLSpanElement>('#audio-status');
const triggerStatus = document.querySelector<HTMLSpanElement>('#trigger-status');
if (!canvas || !audioStatus || !triggerStatus) {
  throw new Error('bevy-play-sound-effect: missing canvas or overlay elements');
}

const appResult = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] }, {
  ...forgeaxBundlerAdapter(),
  importTransport: createRuntimeAssetImportTransport(runtimeBinding),
});
if (!appResult.ok) {
  if (appResult.error instanceof EngineEnvironmentError) {
    console.error('[bevy-play-sound-effect] EngineEnvironmentError creating renderer');
  } else {
    console.error(`[bevy-play-sound-effect] ${appResult.error.code}: ${appResult.error.hint}`);
  }
  throw new Error('bevy-play-sound-effect: createApp failed');
}

const app = appResult.value;
app.onError((error) => console.error(`[bevy-play-sound-effect] app-error ${error.code}`));

const world = app.world;
const scene = buildPlaySoundEffectWorld(world, canvas.width / Math.max(canvas.height, 1));
const assets = app.assets;
if (assets === undefined) throw new Error('bevy-play-sound-effect: assets unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);
const audioEngine = world.getResource<WebAudioEngine>('AudioEngine');
let clipHandle: Handle<'AudioClipAsset', 'shared'> = HANDLE_NONE;
let loaded = false;
const guid = AssetGuid.parse(SFX_GUID);
if (!guid.ok) {
  console.error('[bevy-play-sound-effect] invalid SFX GUID:', SFX_GUID);
} else {
  const clipResult = await assets.loadByGuid<AudioClipAsset>(guid.value);
  if (clipResult.ok) {
    clipHandle = world.allocSharedRef('AudioClipAsset', clipResult.value);
    loaded = true;
    world.set(scene.audioAnchor, AudioSource, {
      clip: clipHandle,
      playing: false,
      loop: false,
      volume: 0.9,
      spatialBlend: 0,
      bus: 'sfx',
    });
  } else {
    console.error('[bevy-play-sound-effect] loadByGuid failed:', clipResult.error.code, clipResult.error.hint);
  }
}

let previousSpace = false;
let triggerCount = 0;
let lastTriggered = false;
world.addSystem(Update, {
  name: 'play-sound-effect-controls',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: () => {
    const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const space = snapshot?.keyboard.down(' ') ?? false;
    lastTriggered = false;
    if (space && !previousSpace && loaded) {
      const spawned = world.spawn({
        component: AudioSource,
        data: {
          clip: clipHandle,
          playing: true,
          loop: false,
          volume: 0.9,
          spatialBlend: 0,
          bus: 'sfx',
        },
      });
      if (spawned.ok) {
        triggerCount += 1;
        lastTriggered = true;
      }
    }
    previousSpace = space;
    const state = audioEngine.getState();
    audioStatus.textContent = `audio=${state.contextState} | active=${state.activeSourceCount} | loaded=${loaded ? 1 : 0}`;
    triggerStatus.textContent = `triggers=${triggerCount} | last=${lastTriggered ? 1 : 0}`;
  },
});

const started = app.start();
if (!started.ok) {
  console.error('[bevy-play-sound-effect] app.start() failed:', started.error);
  throw new Error('bevy-play-sound-effect: app.start failed');
}
(window as typeof window & {
  __playSoundEffectStop?: () => { contextState: string; activeSourceCount: number };
}).__playSoundEffectStop = () => {
  const stopped = app.stop();
  if (!stopped.ok) throw new Error(`app.stop failed: ${stopped.error.code}`);
  return audioEngine.getState();
};
console.warn('[bevy-play-sound-effect] running. Press Space to play the imported one-shot SFX.');
