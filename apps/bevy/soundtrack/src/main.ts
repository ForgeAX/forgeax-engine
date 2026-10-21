import type { AssetHandle } from '@forgeax/engine-types';
// Reproduce Bevy's `soundtrack` example.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AudioSource, type AudioBackend, audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import { Time, Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSoundtrackWorld, HANDLE_NONE } from './soundtrack';

const PEACEFUL_GUID = '3b298083-a2bc-496f-91fb-80e5bb8cfe48';
const BATTLE_GUID = '019ee3df-a914-7eca-9468-489ba99addf7';
const FADE_SECONDS = 1.2;
type Track = 'peaceful' | 'battle';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const audioStatus = document.querySelector<HTMLSpanElement>('#audio-status');
const controlStatus = document.querySelector<HTMLSpanElement>('#control-status');
if (!canvas || !audioStatus || !controlStatus) throw new Error('bevy-soundtrack: missing canvas or overlay elements');

const appResult = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] }, { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) });
if (!appResult.ok) {
  if (appResult.error instanceof EngineEnvironmentError) console.error('[bevy-soundtrack] EngineEnvironmentError creating renderer');
  else console.error(`[bevy-soundtrack] ${appResult.error.code}: ${appResult.error.hint}`);
  throw new Error('bevy-soundtrack: createApp failed');
}
const app = appResult.value;
app.onError((error) => console.error(`[bevy-soundtrack] app-error ${error.code}`));

const world = app.world;
const scene = buildSoundtrackWorld(world, canvas.width / Math.max(canvas.height, 1));
const assets = app.assets;
if (assets === undefined) throw new Error('bevy-soundtrack: assets unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);
const audio = world.getResource<AudioBackend>('AudioEngine');
if (!audio) throw new Error('bevy-soundtrack: AudioEngine resource missing');

let peacefulHandle: AssetHandle<'audio'> = HANDLE_NONE;
let battleHandle: AssetHandle<'audio'> = HANDLE_NONE;
let loaded = 0;
for (const [guidText, assign] of [[PEACEFUL_GUID, (handle: AssetHandle<'audio'>) => { peacefulHandle = handle; }], [BATTLE_GUID, (handle: AssetHandle<'audio'>) => { battleHandle = handle; }]] as const) {
  const guid = AssetGuid.parse(guidText);
  if (!guid.ok) throw new Error(`bevy-soundtrack: invalid audio GUID ${guidText}`);
  const clipResult = await assets.load(guid.value, 'audio');
  if (clipResult.ok) {
    assign(clipResult.value);
    loaded += 1;
  } else console.error('[bevy-soundtrack] loadByGuid failed:', clipResult.error.code, clipResult.error.hint);
}
if (loaded > 0) world.set(scene.peaceful, AudioSource, { clip: peacefulHandle, playing: false, loop: true, volume: 0, spatialBlend: 0, bus: 'music' });
if (loaded > 1) world.set(scene.battle, AudioSource, { clip: battleHandle, playing: false, loop: true, volume: 0, spatialBlend: 0, bus: 'music' });

let current: Track = 'peaceful';
let target: Track = 'peaceful';
let transitionElapsed = 0;
let started = false;
let previousSpace = false;

function volumeFor(track: Track): number {
  if (!started) return 0;
  if (current === target) return track === current ? 1 : 0;
  const t = Math.min(1, transitionElapsed / FADE_SECONDS);
  return track === current ? 1 - t : t;
}

function writeTracks(): void {
  const peacefulVolume = volumeFor('peaceful');
  const battleVolume = volumeFor('battle');
  world.set(scene.peaceful, AudioSource, { playing: started && (current === 'peaceful' || target === 'peaceful'), volume: peacefulVolume, loop: true, bus: 'music' });
  world.set(scene.battle, AudioSource, { playing: started && (current === 'battle' || target === 'battle'), volume: battleVolume, loop: true, bus: 'music' });
  return;
}

world.addSystem(Update, {
  name: 'soundtrack-transition',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: () => {
    const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const space = input?.keyboard.down(' ') ?? false;
    if (space && !previousSpace && loaded === 2) {
      if (!started) started = true;
      else if (current === target) target = current === 'peaceful' ? 'battle' : 'peaceful';
      if (current !== target) transitionElapsed = 0;
    }
    previousSpace = space;
    const dt = world.hasResource(Time) ? world.getResource(Time).delta : 0;
    if (started && current !== target) {
      transitionElapsed += dt;
      if (transitionElapsed >= FADE_SECONDS) {
        current = target;
        transitionElapsed = 0;
      }
    }
    writeTracks();
    const state = audio.getState();
    const peacefulVolume = volumeFor('peaceful');
    const battleVolume = volumeFor('battle');
    audioStatus.textContent = `audio=${state.contextState} | active=${state.activeSourceCount} | loaded=${loaded}/2`;
    controlStatus.textContent = `state=${current} | target=${target} | transition=${Math.min(1, transitionElapsed / FADE_SECONDS).toFixed(2)} | peaceful=${peacefulVolume.toFixed(2)} | battle=${battleVolume.toFixed(2)}`;
  },
});

const startedResult = app.start();
if (!startedResult.ok) throw new Error(`bevy-soundtrack: app.start failed: ${startedResult.error.code}`);
(window as typeof window & { __soundtrackStop?: () => { contextState: string; activeSourceCount: number } }).__soundtrackStop = () => {
  const stopped = app.stop();
  if (!stopped.ok) throw new Error(`app.stop failed: ${stopped.error.code}`);
  return audio.getState();
};
console.warn('[bevy-soundtrack] running. Space starts playback and toggles the soundtrack state.');
