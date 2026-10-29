import type { AssetHandle } from '@forgeax/engine-types';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AUDIO_ENGINE_RESOURCE_KEY, AUDIO_TICK_SYSTEM_NAME, AudioSource, type AudioBackend, audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import {
  FRAME_START_SCAN_SYSTEM_NAME,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { FixedTime, Update, FixedUpdate } from '@forgeax/engine-ecs';
import { physicsPlugin, CollidingEntities } from '@forgeax/engine-physics';
import { pick } from '@forgeax/engine-picking';
import { MeshRenderer } from '@forgeax/engine-render';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { addOnEnter, defineState, getState, setNextState } from '@forgeax/engine-state';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { CapstoneVelocity, buildCapstoneScene } from './scene';
import './pulse-material.wgsl';
import { CAPSTONE_CONTENT_GUID, capstoneContentKind, capstoneContentDecoder } from './reimport';

const SFX_GUID = '019e7535-5e5e-75fe-a328-0b08e3a72744';
const Phase = defineState('M8CapstonePhase', ['boot', 'playing', 'mutated', 'recovered'] as const);
const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLSpanElement>('#status');
const audioStatus = document.querySelector<HTMLSpanElement>('#audio-status');
if (!canvas || !status || !audioStatus) throw new Error('m8-capstone: missing browser host elements');

const appResult = await createApp(
  canvas,
  {
    time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
    plugins: [webAudioPlugin(), audioPlugin(), physicsPlugin('rapier-3d')],
  },
  { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
);
if (!appResult.ok) throw new Error(`m8-capstone createApp failed: ${appResult.error instanceof Error ? appResult.error.message : String(appResult.error)}`);

const app = appResult.value;
const world = app.world;
const assets = app.assets;
if (assets === undefined) throw new Error('m8-capstone: app asset owner unavailable');
configureRuntimeAssetCatalog(assets, runtimeBinding);
assets.installDecoder(capstoneContentKind, capstoneContentDecoder);

const scene = buildCapstoneScene(world);
const pulseShaderId = 'my_game::pulse_material';
const pulseTexture = assets.create({
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
  format: 'rgba8unorm',
  data: new Uint8Array([
    255, 128, 64, 255,
    255, 128, 64, 255,
    255, 128, 64, 255,
    255, 128, 64, 255,
  ]),
  colorSpace: 'linear',
  mips: { kind: 'none' },
}).unwrap();
const pulseParams: Record<string, number | number[]> = {
  baseColor: [0.2, 0.75, 1],
  metallic: 0,
  roughness: 2,
  baseColorTexture: pulseTexture,
};
const customMaterial = assets.create({
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: pulseShaderId }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
  values: pulseParams,
}).unwrap();
const phase = { value: 'boot' };
const fixedTicks = { value: 0 };
const pickCount = { value: 0 };
const content = { ready: false, revision: 0, bytes: 0, title: '', markers: 0 };
const renderMode = { value: 'standard' };
const fault = { code: 'none' };
const recovery = { value: 0 };
const audioCounters: { starts: number; previousActive: number | null } = { starts: 0, previousActive: 0 };
let clipHandle = 0 as unknown as AssetHandle<'audio'>;
let rearmAudio = false;
let collisionSeen = false;

const phaseOnEnter = (next: 'playing' | 'mutated' | 'recovered') => {
  addOnEnter(Phase, next, () => { phase.value = next; });
};
phaseOnEnter('playing');
phaseOnEnter('mutated');
phaseOnEnter('recovered');

const guid = AssetGuid.parse(SFX_GUID);
if (!guid.ok) throw new Error(`m8-capstone: invalid SFX GUID ${SFX_GUID}`);
const clipResult = await assets.load(guid.value, 'audio');
if (clipResult.ok) {
  const clip = assets.read(clipResult.value).unwrap();
  clipHandle = clipResult.value;
  world.set(scene.emitter, AudioSource, {
    clip: clipHandle,
    playing: false,
    spatialBlend: 1,
    bus: 'sfx',
  });
  content.ready = true;
  content.revision = 1;
  if (clip.stream)
    throw new Error('[m8-capstone] loaded-byte fixture requires a buffered short SFX');
  content.bytes = clip.bytes.length;
} else {
  throw new Error(`m8-capstone content load failed: ${clipResult.error.code}`);
}

const contentGuid = AssetGuid.parse(CAPSTONE_CONTENT_GUID);
if (!contentGuid.ok) throw new Error(`m8-capstone: invalid content GUID ${CAPSTONE_CONTENT_GUID}`);
const contentResult = await assets.load(contentGuid.value, capstoneContentKind);
if (!contentResult.ok) throw new Error(`m8-capstone content reimport seed failed: ${contentResult.error.code}`);
content.ready = true;
content.revision = 1;
const contentPayload = assets.read(contentResult.value).unwrap();
content.title = contentPayload.title;
content.markers = contentPayload.markers.length;

const audio = world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);
world.insertResource('m8CapstoneContent', content);
world.insertResource('m8CapstoneFixedTicks', fixedTicks);
world.insertResource('m8CapstonePickCount', pickCount);
world.insertResource('m8CapstoneFault', fault);

world.addSystem(FixedUpdate, {
  name: 'm8-capstone-fixed-motion',
  queries: [],
  fn: () => {
    fixedTicks.value += 1;
    const velocity = world.get(scene.cursor, CapstoneVelocity);
    const transform = world.get(scene.cursor, Transform);
    if (!velocity.ok || !transform.ok) return;
    const position = transform.value.pos as Float32Array;
    const speed = velocity.value.x as number;
    const next = (position[0] ?? 0) + speed * world.getResource(FixedTime).delta;
    if (next > 1.7 || next < -1.7) world.set(scene.cursor, CapstoneVelocity, { x: -speed });
    world.set(scene.cursor, Transform, { pos: [next, position[1] ?? 0, position[2] ?? 0] });
  },
}).unwrap();

world.addSystem(Update, {
  name: 'm8-capstone-observe-input',
  after: [FRAME_START_SCAN_SYSTEM_NAME],
  before: [AUDIO_TICK_SYSTEM_NAME],
  queries: [],
  fn: () => {
    const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const spaceUp = input.keyboard.up(' ');
    if (!rearmAudio && spaceUp && clipHandle !== (0 as unknown as AssetHandle<'audio'>)) {
      world.set(scene.emitter, AudioSource, { clip: clipHandle, playing: true, spatialBlend: 1, bus: 'sfx' });
      rearmAudio = true;
    } else if (rearmAudio) {
      world.set(scene.emitter, AudioSource, { clip: clipHandle, playing: false, spatialBlend: 1, bus: 'sfx' });
      rearmAudio = false;
    }

    const audioState = audio.getState();
    const active = audioState.activeSourceCount;
    const previous = audioCounters.previousActive;
    if (active !== null && previous !== null && active > previous) {
      audioCounters.starts += active - previous;
    }
    audioCounters.previousActive = active;
    const contacts = world.get(scene.actor, CollidingEntities);
    collisionSeen ||= contacts.ok && contacts.value.entities.length > 0;
    if (phase.value === 'boot' && content.ready) setNextState(world, Phase, 'playing');
    const current = getState(world, Phase);
    if (current.ok) phase.value = current.value;
    status.textContent = [
      `phase=${phase.value}`,
      `content=${content.ready ? 'ready' : 'loading'}`,
      `contentTitle=${content.title}`,
      `fixed=${fixedTicks.value}`,
      `pick=${pickCount.value}`,
      `render=${renderMode.value}`,
      `fault=${fault.code}`,
      `recovery=${recovery.value}`,
      `collision=${collisionSeen ? 1 : 0}`,
    ].join(' ');
    audioStatus.textContent = `audio=${audioState.contextState} active=${audioState.activeSourceCount} starts=${audioCounters.starts}`;
  },
}).unwrap();

const markMutated = () => {
  if (phase.value === 'playing') setNextState(world, Phase, 'mutated');
};
const pickCenter = () => {
  propagateTransforms(world);
  const hit = pick(world, scene.camera, canvas.width / 2, canvas.height / 2, canvas.width, canvas.height);
  if (hit !== undefined) {
    pickCount.value += 1;
    world.set(hit.entity, MeshRenderer, { materials: [scene.highlightMaterial] });
    markMutated();
  }
  return hit === undefined ? { hit: false } : { hit: true, entity: hit.entity, distance: hit.distance };
};
const switchRender = () => {
  renderMode.value = renderMode.value === 'standard' ? 'custom' : 'standard';
  world.set(scene.root, MeshRenderer, { materials: [renderMode.value === 'standard' ? scene.material : customMaterial] });
  markMutated();
  return { renderMode: renderMode.value };
};
const injectFault = () => {
  const result = world.update(-1);
  if (result.ok) throw new Error('m8-capstone invalid delta unexpectedly succeeded');
  fault.code = result.error.code;
  world.insertResource('m8CapstoneFault', fault);
  return { ok: false, code: result.error.code };
};
const recover = () => {
  setNextState(world, Phase, 'recovered');
  recovery.value += 1;
  return { ok: true, entityCount: world.inspect().entityCount };
};
const snapshot = () => ({
  phase: phase.value,
  content: { ...content },
  fixedTicks: fixedTicks.value,
  pickCount: pickCount.value,
  renderMode: renderMode.value,
  fault: fault.code,
  recovery: recovery.value,
  collision: collisionSeen,
  entityCount: world.inspect().entityCount,
});

if (new URLSearchParams(location.search).has('m8-probe')) {
  Object.assign(globalThis, {
    __forgeaxM8: {
      snapshot,
      pickCenter,
      switchRender,
      injectFault,
      recover,
      health: () => app.renderer.inspect().state,
      rhiCaptureAvailable: () => app.rhiCapture !== undefined,
    },
  });
}

const started = app.start();
if (!started.ok) throw new Error(`m8-capstone start failed: ${started.error.code}`);
