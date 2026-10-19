import { encodePng } from '@forgeax/engine-image/png';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';
import { classifyDawnErrors, normalizeReadbackRgba, READINESS_FRAME_LIMIT } from './smoke-diagnostics.mjs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const distRoot = resolve(appRoot, 'dist');
const WIDTH = 200;
const HEIGHT = 150;
const benchmarkCapacity = Number.parseInt(process.env.VFX_BENCH_CAPACITY ?? '', 10);
const benchmarkMode = Number.isFinite(benchmarkCapacity) && benchmarkCapacity > 0;
const benchmarkAdapterClass = /(?:^|\/)lvp(?:_|\.)/.test(
  process.env.VK_ICD_FILENAMES ?? process.env.VK_DRIVER_FILES ?? '',
)
  ? 'software-reference'
  : 'hardware';
const TARGET_FRAMES = Math.max(60, Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10));
const frameLimit = benchmarkMode ? 90 : TARGET_FRAMES;
const SEED = 42;
const CAMERA = { position: [0, 1.2, 7.5], target: [0, 0.8, 0] };
const rerunCmd = 'pnpm --filter @forgeax/hello-boss-lightning smoke';
const falsifier = process.env.BOSS_LIGHTNING_FALSIFY ?? '';
const m11Mode = process.env.BOSS_LIGHTNING_M11 === '1';
const m35Mode = process.env.BOSS_LIGHTNING_M35 === '1';
const eventScenario = 'event-sub-emitter';
const eventOverflow = 'overflow';
const missingDepth = 'missing-depth';
const requiredStageId = 'turbulence';
const advancedRendererFields = ['textureSheet', 'pivot', 'softParticle', 'sorting', 'ribbon', 'trail', 'beam'];

if (!existsSync(resolve(distRoot, 'pack-index.json'))) {
  const build = spawnSync('pnpm', ['--filter', '@forgeax/hello-boss-lightning', 'build'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const packIndexText = readFileSync(resolve(distRoot, 'pack-index.json'), 'utf8');
const packIndex = decodeCatalogWire(JSON.parse(packIndexText)).unwrap();
const packageFiles = new Map(
  packIndex.map(entry => [entry.packageUrl, resolve(distRoot, entry.packageUrl.slice(1))]),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = async request => {
  const url = new URL(typeof request === 'string' ? request : request.url, 'http://127.0.0.1');
  if (url.pathname === '/pack-index.json') return new Response(packIndexText);
  const file = packageFiles.get(url.pathname);
  if (file !== undefined) return new Response(readFileSync(file));
  const assetFile = resolve(distRoot, url.pathname.slice(1));
  if (existsSync(assetFile)) return new Response(readFileSync(assetFile));
  return originalFetch(request);
};

const shim = await setupGpuShim({ width: WIDTH, height: HEIGHT, rerunCmd });
let sceneDepthTexture;
let sceneDepthView;
const sceneDepthResource = () => {
  const device = shim.sharedDevice;
  if (device === undefined) return undefined;
  if (sceneDepthView === undefined) {
    sceneDepthTexture = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format: 'depth24plus',
      usage: 0x04 | 0x10,
    });
    sceneDepthView = sceneDepthTexture.createView();
  }
  return { kind: 'texture-view', value: sceneDepthView };
};
const manifest = JSON.parse(readFileSync(resolve(distRoot, 'shaders/manifest.json'), 'utf8'));
const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { mat4 } = await import('@forgeax/engine-math');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { HANDLE_CUBE } = await import('@forgeax/engine-assets-runtime');
const { Transform, scenePlugin } = await import('@forgeax/engine-scene');
const {
  loadVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
} = await import('@forgeax/engine-vfx');
const {
  createCameraProvider,
  createSceneDepthProvider,
  createVfxRuntimeHost,
  observeStagePlan,
  validatedStagePlan,
} = await import('@forgeax/engine-vfx-render');

const world = new World();
let playerEntity = 0;
let cameraEntity = 0;
const cameraEntities = new WeakMap();
const camera = {
  read(currentWorld) {
    const owner = cameraEntities.get(currentWorld) ?? cameraEntity;
    const transform = currentWorld.get(owner, Transform);
    const cameraValue = currentWorld.get(owner, Camera);
    if (!transform.ok || !cameraValue.ok) return undefined;
    return {
      position: new Float32Array(transform.value.pos),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(), cameraValue.value.fov, cameraValue.value.aspect, cameraValue.value.near, cameraValue.value.far), mat4.lookAt(mat4.create(), transform.value.pos, [0, 0.8, 0], [0, 1, 0])),
    };
  },
};
const host = createVfxRuntimeHost({
  camera,
  ...(m35Mode ? { maxQueuedTicks: 1 } : {}),
  providers: [
    createCameraProvider({ available: () => true }),
    createSceneDepthProvider({
      available: () => falsifier !== missingDepth,
      sampleCount: 1,
      resource: sceneDepthResource,
    }),
  ],
});
const constructed = await constructRuntimeRendererHost(
  shim.mockCanvas,
  { features: falsifier === 'strike-only' ? [] : [host.feature] },
  { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` },
);
if (!constructed.ok) throw constructed.error;
const renderer = constructed.value.renderer;
// Observe the real prepared-resource path, not a CPU particle approximation.
const persistentBuffers = new Map();
const observedDevice = shim.sharedDevice;
const nativeCreateBuffer = observedDevice.createBuffer.bind(observedDevice);
if (!benchmarkMode && !m11Mode && !m35Mode) {
  observedDevice.createBuffer = descriptor => {
    const tracked = /^vfx\.state-/.test(descriptor.label ?? '') &&
      /\.(particles|history|custom|counters|indirect)$/.test(descriptor.label);
    const buffer = nativeCreateBuffer(tracked ? { ...descriptor, usage: descriptor.usage | 0x04 } : descriptor);
    if (tracked) {
      const prior = persistentBuffers.get(descriptor.label);
      persistentBuffers.set(descriptor.label, { buffer, size: descriptor.size, creations: (prior?.creations ?? 0) + 1 });
    }
    return buffer;
  };
}
const assets = constructed.value.assets;
const errors = [];
let currentFrame = -1;
renderer.subscribe((event) => {
  if (event.kind !== 'error') return;
  errors.push({
    code: event.error.code,
    hint: event.error.hint,
    detail: event.error.detail,
    frame: currentFrame,
  });
});
const attachment = renderer.attach(world);
if (!attachment.ok) throw attachment.error;
const mainLease = attachment.value;
assets.configurePackIndex('/pack-index.json');
const attached = await host.attachWorld({ world, assets });
if (!attached.ok) throw new Error(`VFX host attach failed: ${attached.error.hint}`);

const materialGuid = assets.parseGuid('019e9c00-0000-7000-8000-000000000002');
const material = await assets.loadByGuid(materialGuid);
if (!material.ok) throw new Error(`strike material load failed: ${material.error.hint}`);
const strikeMaterial = world.allocSharedRef('MaterialAsset', material.value);
cameraEntity = world.spawn(
  { component: Transform, data: { pos: [0, 1.2, 7.5] } },
  { component: Camera, data: { fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
).unwrap();
cameraEntities.set(world, cameraEntity);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.8, -0.5], color: [0.6, 0.72, 1], intensity: 1.4, castShadow: false },
}).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 1.4, 0], scale: [0.16, 2.8, 0.16] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [strikeMaterial] } },
).unwrap();

const loaded = await loadVfxGpuEffect(assets, '019e9c00-0000-7000-8000-000000000000');
if (!loaded.ok) throw new Error(`particle effect load failed: ${loaded.error.code}: ${loaded.error.hint}`);
let effectAsset = loaded.value;
let benchmarkAllocatedCapacity = 0;
if (benchmarkMode) {
  const emitterCount = effectAsset.program.emitters.length;
  const baseCapacity = Math.floor(benchmarkCapacity / emitterCount);
  const remainder = benchmarkCapacity % emitterCount;
  // Loaded programs are immutable. The benchmark owns this derived capacity configuration.
  const emitters = effectAsset.program.emitters.map((emitter, index) => ({
    ...emitter,
    capacity: baseCapacity + (index < remainder ? 1 : 0),
  }));
  effectAsset = {
    ...effectAsset,
    emitters: emitters.map(({ id, capacity }) => ({ id, capacity })),
    program: { ...effectAsset.program, emitters },
  };
  benchmarkAllocatedCapacity = emitters.reduce((total, emitter) => total + emitter.capacity, 0);
}
const stageReflection = effectAsset.program.emitters.flatMap(item => item.reflection.stages ?? []);
const lastKnownGoodPlan = validatedStagePlan(stageReflection, 1);
let stageCandidate = lastKnownGoodPlan;
if (lastKnownGoodPlan.ok && falsifier.startsWith('stage-')) {
  const source = lastKnownGoodPlan.value.stages.map(stage => ({
    ...stage,
    ...(falsifier === 'stage-cycle' ? { dependsOn: [stage.id] } : {}),
    ...(falsifier === 'stage-hazard'
      ? { resources: [...stage.resources, ...(stage.resources[0] === undefined ? [] : [stage.resources[0]])] }
      : {}),
    ...(falsifier === 'stage-budget' ? { iterationBudget: 65 } : {}),
  }));
  stageCandidate = validatedStagePlan(source, 2);
}
const stageObservation = observeStagePlan(
  stageCandidate,
  falsifier.startsWith('stage-') ? 2 : 1,
  lastKnownGoodPlan.ok ? lastKnownGoodPlan.value : undefined,
);
const softParticle = effectAsset.program.emitters.some(item =>
  item.reflection.dataInterfaces?.some(interfaceValue => interfaceValue.kind === 'scene-depth'),
);
const depthProviderReady = host.resolveDataInterfaces({
  requirements: [
    {
      token: 'vfx:scene-depth',
      kind: 'scene-depth',
      binding: 9,
      bindingType: 'sampled-depth',
      lifetime: 'generation',
    },
  ],
  generation: 1,
});
if (!depthProviderReady.ok) {
  if (falsifier === missingDepth) {
    console.error(`[smoke-dawn] RED ${missingDepth} exposed ${depthProviderReady.error.code}`);
    process.exit(1);
  }
  throw new Error(`scene-depth provider failed: ${depthProviderReady.error.hint}`);
}
const effect = world.allocSharedRef('ParticleEffectAsset', effectAsset);
playerEntity = world.spawn(
  { component: Transform, data: { pos: [0, -0.2, 0] } },
  { component: ParticleEffectPlayer, data: { effect, playing: true, seed: SEED, timeScale: 1 } },
).unwrap();
let healthyWorld;
let healthyPlayerEntity;
let healthyLease;
const topologyShowcases = [
  { kind: 'ribbon', x: -2.2 },
  { kind: 'trail', x: 0 },
  { kind: 'beam', x: 2.2 },
];
for (const showcase of benchmarkMode || m35Mode ? [] : topologyShowcases) {
  const sourceEmitter = effectAsset.program.emitters.find(emitter =>
    emitter.renderers.some(renderer => renderer.kind === showcase.kind));
  if (sourceEmitter === undefined) throw new Error(`Missing authored ${showcase.kind} emitter`);
  const showcaseEmitter = {
    ...sourceEmitter,
    id: `showcase-${showcase.kind}`,
    space: 'local',
    channels: [],
    events: [],
    renderers: sourceEmitter.renderers.filter(rendererValue => rendererValue.kind === showcase.kind),
  };
  const showcaseEffect = {
    ...effectAsset,
    program: {
      ...effectAsset.program,
      fingerprint: `${effectAsset.program.fingerprint}:${showcase.kind}`,
      emitters: [showcaseEmitter],
    },
  };
  const showcaseHandle = world.allocSharedRef('ParticleEffectAsset', showcaseEffect);
  world.spawn(
    { component: Transform, data: { pos: [showcase.x, -0.8, 0] } },
    {
      component: ParticleEffectPlayer,
      data: { effect: showcaseHandle, playing: true, seed: SEED, timeScale: 1 },
    },
  ).unwrap();
}
await createWorldContext(world, [scenePlugin()]);

if (m35Mode) {
  healthyWorld = new World();
  const healthyCameraEntity = healthyWorld
    .spawn(
      { component: Transform, data: { pos: [0, 1.2, 7.5] } },
      {
        component: Camera,
        data: { fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
      },
    )
    .unwrap();
  cameraEntities.set(healthyWorld, healthyCameraEntity);
  const healthyEffect = healthyWorld.allocSharedRef('ParticleEffectAsset', effectAsset);
  healthyPlayerEntity = healthyWorld
    .spawn(
      { component: Transform, data: { pos: [0, -0.2, 0] } },
      {
        component: ParticleEffectPlayer,
        data: { effect: healthyEffect, playing: true, seed: SEED + 1, timeScale: 1 },
      },
    )
    .unwrap();
  await createWorldContext(healthyWorld, [scenePlugin()]);
  const rendererAttached = renderer.attach(healthyWorld);
  if (!rendererAttached.ok) throw rendererAttached.error;
  healthyLease = rendererAttached.value;
  const hostAttached = await host.attachWorld({ world: healthyWorld, assets });
  if (!hostAttached.ok) throw new Error(`healthy VFX host attach failed: ${hostAttached.error.hint}`);
}

const readiness = [];
let firstReadinessFrame;
let queuedIntents = 0;
let runtimeDiagnostics = [];
let eventDispatch = false;
let subEmitterVisible = false;
let queueCleared = false;
let mainEffectRunning = false;
let lastCommitted;
let eventSubmitted = false;
const runtime = world.getResource(VFX_GPU_RUNTIME_RESOURCE_KEY);
const frameDurations = [];
let device;
let target;
const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
const benchmarkBeamEvidenceFrame = 20;
let benchmarkBeamEvidencePixels;
async function readRenderTargetPixels() {
  if (device === undefined || target === undefined) throw new Error('Dawn render target unavailable');
  const readback = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const pixels = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  return normalizeReadbackRgba(pixels, WIDTH, HEIGHT, bytesPerRow, target.format);
}
function recordDraw(leases) {
  const cameraLease = leases[0];
  if (cameraLease === undefined) throw new Error('recordDraw requires a camera lease');
  const drawn = renderer.draw({
    leases,
    camera: { lease: cameraLease },
    environment: { lease: cameraLease },
  });
  if (!drawn.ok) {
    errors.push({
      code: drawn.error.code,
      hint: drawn.error.hint,
      detail: drawn.error.detail,
      frame: currentFrame,
    });
  }
  return drawn;
}

let m35Recovery;
let m11Recovery;
if (m35Mode) {
  if (healthyWorld === undefined || healthyPlayerEntity === undefined) {
    throw new Error('M35 healthy sibling World was not initialized');
  }
  const affectedControl = host.acquireControl(world);
  const healthyControl = host.acquireControl(healthyWorld);
  if (!affectedControl.ok || !healthyControl.ok) {
    throw new Error(`M35 public host control unavailable: ${JSON.stringify({ affectedControl, healthyControl })}`);
  }
  const inspectPlayer = (snapshot, player) =>
    snapshot?.players.find(candidate => candidate.player === player);
  const updateBoth = () => {
    world.update(1 / 60).unwrap();
    healthyWorld.update(1 / 60).unwrap();
  };
  if (healthyLease === undefined) throw new Error('M35 healthy render lease unavailable');
  const drawBoth = () => recordDraw([mainLease, healthyLease]);
  let initial;
  let initialSibling;
  for (let warmup = 0; warmup < READINESS_FRAME_LIMIT; warmup += 1) {
    currentFrame = warmup;
    updateBoth();
    if (!drawBoth().ok) throw new Error(`M35 initial composite draw failed at ${warmup}`);
    await new Promise(resolve => setImmediate(resolve));
    initial = host.inspect(world);
    initialSibling = host.inspect(healthyWorld);
    const warmPlayer = inspectPlayer(initial, playerEntity);
    const warmSiblingPlayer = inspectPlayer(initialSibling, healthyPlayerEntity);
    if (
      warmPlayer?.queuedIntents === 0 &&
      warmSiblingPlayer?.queuedIntents === 0 &&
      initial?.diagnostics.length === 0 &&
      initialSibling?.diagnostics.length === 0 &&
      warmPlayer?.lastCommitted !== null &&
      warmPlayer?.lastCommitted !== undefined &&
      warmSiblingPlayer?.lastCommitted !== null &&
      warmSiblingPlayer?.lastCommitted !== undefined
    ) {
      break;
    }
  }
  const initialPlayer = inspectPlayer(initial, playerEntity);
  const initialSiblingPlayer = inspectPlayer(initialSibling, healthyPlayerEntity);
  if (initialPlayer?.lastCommitted === null || initialSiblingPlayer?.lastCommitted === null) {
    throw new Error(`M35 players did not commit a visible baseline: ${JSON.stringify({ initial, initialSibling })}`);
  }
  const initialCommitted = initialPlayer?.lastCommitted;
  const initialSiblingCommitted = initialSiblingPlayer?.lastCommitted;
  const paused = affectedControl.value.setPlayerRenderConsumption({
    player: playerEntity,
    enabled: false,
  });
  if (!paused.ok) throw new Error(`M35 render pause failed: ${JSON.stringify(paused)}`);
  const pausedFrames = [];
  for (let index = 0; index < 3; index += 1) {
    currentFrame += 1;
    updateBoth();
    if (!drawBoth().ok) throw new Error(`M35 paused composite draw failed at ${index}`);
    await new Promise(resolve => setImmediate(resolve));
    const affected = host.inspect(world);
    const sibling = host.inspect(healthyWorld);
    const affectedPlayer = inspectPlayer(affected, playerEntity);
    const siblingPlayer = inspectPlayer(sibling, healthyPlayerEntity);
    pausedFrames.push({
      frame: currentFrame,
      queuedIntents: affectedPlayer?.queuedIntents ?? -1,
      queuedTicks: affectedPlayer?.queuedTicks ?? -1,
      diagnostics: affected?.diagnostics ?? [],
      lastCommitted: affectedPlayer?.lastCommitted,
      siblingLastCommitted: siblingPlayer?.lastCommitted,
      siblingDiagnostics: sibling?.diagnostics ?? [],
    });
  }
  const overflow = host.inspect(world);
  const overflowPlayer = inspectPlayer(overflow, playerEntity);
  const overflowDiagnostics =
    overflow?.diagnostics.filter(diagnostic => diagnostic.detail.player === playerEntity) ?? [];
  const pendingBeforeReplay = pausedFrames.at(-1)?.lastCommitted?.sequence ?? -1;
  if (
    overflowPlayer === undefined ||
    overflowPlayer.queuedIntents > effectAsset.program.emitters.length ||
    overflowPlayer.queuedTicks > 1 ||
    overflowDiagnostics.length !== 1 ||
    overflowDiagnostics[0]?.code !== 'vfx-intent-queue-overflow' ||
    overflowDiagnostics[0]?.detail.maxQueuedTicks !== 1 ||
    overflowPlayer.lastCommitted?.sequence !== initialCommitted?.sequence ||
    overflowPlayer.lastCommitted?.tick !== initialCommitted?.tick ||
    overflowPlayer.lastCommitted?.phaseTick !== initialCommitted?.phaseTick ||
    overflowPlayer.lastCommitted?.playCycle !== initialCommitted?.playCycle ||
    pausedFrames.some(frame => frame.siblingDiagnostics.length !== 0) ||
    (pausedFrames.at(-1)?.siblingLastCommitted?.tick ?? -1) <= (initialSiblingCommitted?.tick ?? -1)
  ) {
    throw new Error(`M35 overflow contract failed: ${JSON.stringify({ initial, overflow, pausedFrames })}`);
  }
  const resumed = affectedControl.value.setPlayerRenderConsumption({
    player: playerEntity,
    enabled: true,
  });
  if (!resumed.ok) throw new Error(`M35 render resume failed: ${JSON.stringify(resumed)}`);
  currentFrame += 1;
  updateBoth();
  if (!drawBoth().ok) throw new Error('M35 resumed composite draw failed');
  await new Promise(resolve => setImmediate(resolve));
  const afterResume = host.inspect(world);
  const afterResumePlayer = inspectPlayer(afterResume, playerEntity);
  if (
    afterResumePlayer?.queuedIntents !== 0 ||
    afterResume?.diagnostics.length !== 0 ||
    afterResumePlayer?.lastCommitted?.playCycle !== initialCommitted?.playCycle ||
    afterResumePlayer?.lastCommitted?.phaseTick !== (initialCommitted?.phaseTick ?? 0) + 1
  ) {
    throw new Error(`M35 resume contract failed: ${JSON.stringify({ afterResume, overflow })}`);
  }
  const replayed = affectedControl.value.replay({ player: playerEntity });
  if (!replayed.ok) throw new Error(`M35 public replay failed: ${JSON.stringify(replayed)}`);
  currentFrame += 1;
  updateBoth();
  if (!drawBoth().ok) throw new Error('M35 replay composite draw failed');
  await new Promise(resolve => setImmediate(resolve));
  const afterReplay = host.inspect(world);
  const afterReplaySibling = host.inspect(healthyWorld);
  const afterReplayPlayer = inspectPlayer(afterReplay, playerEntity);
  const afterReplaySiblingPlayer = inspectPlayer(afterReplaySibling, healthyPlayerEntity);
  const replayCommitted = afterReplayPlayer?.lastCommitted;
  if (
    afterReplayPlayer?.queuedIntents !== 0 ||
    afterReplay?.diagnostics.length !== 0 ||
    replayCommitted?.reset !== true ||
    replayCommitted?.phaseTick !== 0 ||
    replayCommitted?.playCycle !== (initialCommitted?.playCycle ?? -1) + 1 ||
    replayCommitted?.firstParticleId !== 0 ||
    replayCommitted?.sequence <= pendingBeforeReplay ||
    (afterReplaySiblingPlayer?.lastCommitted?.tick ?? -1) <= (initialSiblingCommitted?.tick ?? -1) ||
    afterReplaySibling?.diagnostics.length !== 0
  ) {
    throw new Error(`M35 replay contract failed: ${JSON.stringify({ afterReplay, afterReplaySibling, pendingBeforeReplay })}`);
  }
  queuedIntents = afterReplayPlayer.queuedIntents;
  runtimeDiagnostics = afterReplay?.diagnostics ?? [];
  lastCommitted = runtime.lastCommitted(playerEntity);
  readiness.push('ready');
  firstReadinessFrame = currentFrame;
  m35Recovery = {
    maxQueuedTicks: 1,
    maxQueuedIntents: effectAsset.program.emitters.length,
    initial: { player: initialPlayer, sibling: initialSiblingPlayer },
    pausedFrames,
    overflow: { player: overflowPlayer, diagnostics: overflowDiagnostics },
    resume: { player: afterResumePlayer },
    replay: { player: afterReplayPlayer, sibling: afterReplaySiblingPlayer },
  };
  console.log(
    `[m35-vfx] Dawn overflow/restart: PASS ${JSON.stringify({
      maxQueuedTicks: m35Recovery.maxQueuedTicks,
      maxQueuedIntents: m35Recovery.maxQueuedIntents,
      overflowDiagnostics: m35Recovery.overflow.diagnostics.length,
      pausedQueue: m35Recovery.overflow.player.queuedIntents,
      pausedTicks: m35Recovery.overflow.player.queuedTicks,
      lkg: m35Recovery.overflow.player.lastCommitted,
      replay: m35Recovery.replay.player.lastCommitted,
      sibling: m35Recovery.replay.sibling.lastCommitted,
    })}`,
  );
} else {
  for (let frame = 0; frame < frameLimit; frame += 1) {
    const frameStart = performance.now();
    currentFrame = frame;
    world.update(1 / 60).unwrap();
    if (!eventSubmitted) {
      const instance = runtime?.getInstance(playerEntity);
      instance?.submit({
        channel: 'impact',
        payload: { position: [0.25, -0.7, 0], strength: 1 },
        sequence: 1,
      });
      eventSubmitted = true;
    }
    const drawn = recordDraw([mainLease]);
    if (!drawn.ok) throw new Error(`Boss Lightning draw failed at frame ${frame}`);
    if (!benchmarkMode && !m11Mode) {
      const presentation = recordDraw([mainLease]);
      if (!presentation.ok) throw new Error(`Render-only Boss Lightning frame failed at ${frame}`);
    }
    await new Promise(resolve => setImmediate(resolve));
    if (benchmarkMode) {
      await shim.sharedDevice?.queue.onSubmittedWorkDone();
      if (frame === benchmarkBeamEvidenceFrame) {
        device = shim.sharedDevice;
        target = shim.renderTarget;
        benchmarkBeamEvidencePixels = await readRenderTargetPixels();
      }
      if (frame >= 30) frameDurations.push(performance.now() - frameStart);
    }
    queuedIntents = runtime.snapshot().length;
    runtimeDiagnostics = runtime.diagnostics();
    const eventCounters = runtime.eventCounters(playerEntity);
    eventDispatch = eventCounters.produced > 0;
    subEmitterVisible = eventCounters.consumed > 0;
    queueCleared = eventCounters.queued === 0;
    mainEffectRunning = runtime.hasPlayer(playerEntity);
    lastCommitted = runtime.lastCommitted(playerEntity);
    const readyNow = runtime.hasPlayer(playerEntity) && queuedIntents === 0 && runtimeDiagnostics.length === 0;
    readiness.push(readyNow ? 'ready' : 'warming');
    if (firstReadinessFrame === undefined && readyNow) firstReadinessFrame = frame;
    if (firstReadinessFrame === undefined && frame >= READINESS_FRAME_LIMIT) break;
  }

  if (m11Mode) {
    const stale = runtime.getInstance(playerEntity);
    const renderGenerationBefore = runtime.renderGeneration;
    const featureRecovery = host.feature.recover();
    const stalePatch = stale?.patch({});
    world.update(1 / 60).unwrap();
    const restarted = runtime.getInstance(playerEntity);
    const restartedInspect = runtime.inspectPlayer(playerEntity);
    const currentPatch = restarted?.patch({});
    world.update(1 / 60).unwrap();
    const currentInspect = runtime.inspectPlayer(playerEntity);
    for (let recoveryFrame = 0; recoveryFrame < 10; recoveryFrame += 1) {
      currentFrame += 1;
      world.update(1 / 60).unwrap();
      const recoveredDraw = recordDraw([mainLease]);
      if (!recoveredDraw.ok) throw new Error(`M11 recovery draw failed at frame ${recoveryFrame}`);
      await new Promise(resolve => setImmediate(resolve));
    }
    queuedIntents = runtime.snapshot().length;
    runtimeDiagnostics = runtime.diagnostics();
    lastCommitted = runtime.lastCommitted(playerEntity);
    m11Recovery = {
      featureRecovery,
      renderGenerationBefore,
      renderGenerationAfter: runtime.renderGeneration,
      stalePatch,
      staleInstanceDetached: stale !== undefined && restarted !== stale,
      restartedGeneration: restartedInspect?.values.generation ?? null,
      currentPatch,
      currentGeneration: currentInspect?.values.generation ?? null,
    };
    if (
      !featureRecovery.ok ||
      runtime.renderGeneration !== renderGenerationBefore + 1 ||
      !m11Recovery.staleInstanceDetached ||
      restartedInspect?.values.generation !== 0 ||
      currentInspect?.values.generation !== 1 ||
      queuedIntents !== 0 ||
      runtimeDiagnostics.length !== 0
    ) {
      console.error(`[smoke-dawn] FAIL M11 generation fence ${JSON.stringify(m11Recovery)}`);
      process.exit(1);
    }
    console.log(`[m11-vfx] Dawn generation fence: PASS ${JSON.stringify(m11Recovery)}`);
  }
}

if (falsifier === 'strike-only') {
  console.error('[smoke-dawn] RED strike-only correctly has no particle signal');
  process.exit(1);
}

if (persistentBuffers.size > 0) {
  const snapshot = async () => {
    const result = new Map();
    for (const [name, entry] of persistentBuffers) {
      if (entry.creations !== 1) throw new Error(`Persistent GPU allocation replaced: ${name} (${entry.creations})`);
      const readback = nativeCreateBuffer({ size: entry.size, usage: 0x01 | 0x08 });
      const encoder = observedDevice.createCommandEncoder();
      encoder.copyBufferToBuffer(entry.buffer, 0, readback, 0, entry.size);
      observedDevice.queue.submit([encoder.finish()]);
      await readback.mapAsync(0x01);
      result.set(name, Buffer.from(readback.getMappedRange().slice(0)));
      readback.unmap(); readback.destroy();
    }
    return result;
  };
  const before = await snapshot();
  for (let frame = 0; frame < 3; frame++) {
    if (!recordDraw([mainLease]).ok) throw new Error('Paused VFX presentation failed');
  }
  const after = await snapshot();
  let livingInstances = 0;
  for (const [name, bytes] of before) {
    if (!bytes.equals(after.get(name))) throw new Error(`Render-only frame mutated GPU state: ${name}`);
    if (name.endsWith('.indirect')) {
      for (let offset = 4; offset < bytes.length; offset += 20) livingInstances += bytes.readUInt32LE(offset);
    }
  }
  if (livingInstances === 0) throw new Error('Persistent GPU particle proof has no living indirect instances');
  observedDevice.createBuffer = nativeCreateBuffer;
  console.log(`[smoke-dawn] Fixed/render separation: PASS buffers=${before.size} livingInstances=${livingInstances}`);
}
device = device ?? shim.sharedDevice;
target = target ?? shim.renderTarget;
if (device === undefined || target === undefined) throw new Error('Dawn render target unavailable');
await device.queue.onSubmittedWorkDone();
const pixels = benchmarkBeamEvidencePixels ?? (await readRenderTargetPixels());
if (process.env.BOSS_LIGHTNING_DAWN_SCREENSHOT !== undefined) {
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    tight.set(pixels.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  writeFileSync(process.env.BOSS_LIGHTNING_DAWN_SCREENSHOT, encodePng(WIDTH, HEIGHT, tight));
}

function zoneEnergy(x0, x1, y0, y1) {
  let energy = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      energy += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / (255 * 3);
    }
  }
  return energy / ((x1 - x0) * (y1 - y0));
}

// This crop is the authored beam's projected spawn-to-endpoint envelope at the
// Dawn smoke resolution; keeping it tight prevents unrelated scene pixels from
// satisfying the topology oracle.
const beamZone = { x0: 75, x1: 125, y0: 30, y1: 130 };

function topologyPixelEvidence() {
  const counts = { ribbon: 0, trail: 0, beam: 0 };
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      const red = pixels[offset] / 255;
      const green = pixels[offset + 1] / 255;
      const blue = pixels[offset + 2] / 255;
      if (blue > 0.45 && green > red * 1.35) counts.ribbon += 1;
      if (
        (red > 0.45 && red > green * 1.1 && green > blue * 1.25) ||
        (green > 0.45 && blue > 0.35 && green > red * 1.5)
      ) counts.trail += 1;
      if (
        x >= beamZone.x0 &&
        x < beamZone.x1 &&
        y >= beamZone.y0 &&
        y < beamZone.y1 &&
        pixels[offset + 3] > 5 &&
        ((red > 0.75 && blue > 0.65 && green < 0.4 && red > green * 1.5) ||
          (blue > 0.45 && blue > green * 1.4 && red < blue * 0.5) ||
          (blue > 0.65 && green > 0.55 && blue >= red && green >= red))
      ) {
        counts.beam += 1;
      }
    }
  }
  return counts;
}

const billboardZone = { x0: 0, x1: WIDTH / 2, y0: 30, y1: HEIGHT - 20 };
const meshZone = { x0: WIDTH / 2, x1: WIDTH, y0: 30, y1: HEIGHT - 20 };
const billboardEnergy = zoneEnergy(billboardZone.x0, billboardZone.x1, billboardZone.y0, billboardZone.y1);
const meshEnergy = zoneEnergy(meshZone.x0, meshZone.x1, meshZone.y0, meshZone.y1);
const topologyPixels = topologyPixelEvidence();
const sortedFrameDurations = [...frameDurations].sort((left, right) => left - right);
const durationPercentile = percentile =>
  sortedFrameDurations[Math.max(0, Math.ceil(sortedFrameDurations.length * percentile) - 1)] ?? 0;
const topologyZones = {
  ribbon: zoneEnergy(25, 80, 75, 145),
  trail: zoneEnergy(75, 125, 75, 145),
  beam: zoneEnergy(beamZone.x0, beamZone.x1, beamZone.y0, beamZone.y1),
};
if (m35Mode) {
  if (healthyWorld === undefined || m35Recovery === undefined) {
    throw new Error('M35 recovery result is unavailable before cleanup');
  }
  const detachAffected = await host.detachWorld({ world });
  const detachAffectedAgain = await host.detachWorld({ world });
  const detachHealthy = await host.detachWorld({ world: healthyWorld });
  const detachHealthyAgain = await host.detachWorld({ world: healthyWorld });
  mainLease.dispose();
  healthyLease?.dispose();
  await renderer.dispose();
  await renderer.dispose();
  m35Recovery = {
    ...m35Recovery,
    cleanup: {
      detachAffected,
      detachAffectedAgain,
      detachHealthy,
      detachHealthyAgain,
      rendererDisposedTwice: true,
    },
  };
}
const strikeOnly = false;
const recovery = typeof renderer.recover === 'function';
const lastWarmupErrorFrame = errors
  .filter(error => error.code === 'render-feature-preparation-failed')
  .reduce((lastFrame, error) => Math.max(lastFrame, error.frame), -1);
const readinessFrame =
  firstReadinessFrame === undefined
    ? undefined
    : Math.max(firstReadinessFrame, lastWarmupErrorFrame + 1);
const { warmupErrors, persistentErrors } = classifyDawnErrors(errors, readinessFrame);
const result = {
  frames: frameLimit,
  seed: SEED,
  camera: CAMERA,
  frame: currentFrame,
  queuedIntents,
  runtimeDiagnostics,
  lastCommitted: lastCommitted === undefined ? undefined : {
    tick: lastCommitted.tick,
    generation: lastCommitted.instanceGeneration,
    patchCount: lastCommitted.instancePatchCount,
    canonicalPayload: [...lastCommitted.canonicalPayload],
    replay: {
      seed: lastCommitted.replayInput.seed,
      tick: lastCommitted.replayInput.tick,
      generation: lastCommitted.replayInput.generation,
      sequence: lastCommitted.replayInput.sequence,
      payload: [...lastCommitted.replayInput.payload],
    },
  },
  billboardEnergy,
  meshEnergy,
  topologyPixels,
  readbackFormat: target.format,
  ...(benchmarkMode
    ? {
        benchmark: {
          backend: 'dawn-wgpu',
          adapterClass: benchmarkAdapterClass,
          capacity: benchmarkCapacity,
          allocatedCapacity: benchmarkAllocatedCapacity,
          warmupFrames: 30,
          samples: frameDurations.length,
          p50Ms: durationPercentile(0.5),
          p95Ms: durationPercentile(0.95),
          p99Ms: durationPercentile(0.99),
        },
      }
    : {}),
  topologyZones,
  advancedRendererFields,
  topologyCounters: Object.fromEntries(
    effectAsset.program.emitters
      .flatMap(item => item.renderers)
      .map(rendererValue => [rendererValue.kind, { capacity: rendererValue.capacity ?? 0, produced: 0, dropped: 0 }]),
  ),
  indirectDraws: effectAsset.program.emitters
    .flatMap(item => item.renderers)
    .map(rendererValue => rendererValue.kind),
  billboardZone,
  meshZone,
  readiness: [...new Set(readiness)],
  readinessFrame,
  readinessFrameLimit: READINESS_FRAME_LIMIT,
  recovery,
  ...(m35Recovery === undefined ? {} : { m35Recovery }),
  ...(m11Recovery === undefined ? {} : { m11Recovery }),
  strikeOnly,
  errors,
  warmupErrors,
  persistentErrors,
  depthProviderReady: depthProviderReady.value.readiness === 'ready',
  softParticle,
  eventScenario,
  eventOverflow,
  eventDispatch,
  subEmitterVisible,
  queueCleared,
  mainEffectRunning,
  arcNovaLayerRunning: ['charge-arcane-dial', 'impact-violet-shock'].every(id => effectAsset.program.emitters.some(item => item.id === id)),
  stageReadiness: stageObservation.stageReadiness,
  stageOutput: stageObservation.stageOutput,
  stageDependencies: lastKnownGoodPlan.ok
    ? lastKnownGoodPlan.value.stages.map(stage => ({ id: stage.id, dependsOn: stage.dependsOn }))
    : [],
  stageDispatch: lastKnownGoodPlan.ok
    ? lastKnownGoodPlan.value.stages.map(stage => stage.entryPoint)
    : [],
  lastKnownGoodStage: stageObservation.lastKnownGoodStage,
};
globalThis.fetch = originalFetch;
if (
  readinessFrame === undefined ||
  readinessFrame > READINESS_FRAME_LIMIT ||
  persistentErrors.length > 0 ||
  queuedIntents !== 0 ||
  runtimeDiagnostics.length > 0 ||
  (m35Mode && (!m35Recovery?.cleanup || m35Recovery.overflow.diagnostics.length !== 1))
) {
  console.error(`[smoke-dawn] FAIL ${JSON.stringify(result)}`);
  process.exit(1);
}
if (billboardEnergy <= 0 || meshEnergy <= 0) {
  console.error(`[smoke-dawn] FAIL particle pixel zones are empty ${JSON.stringify(result)}`);
  process.exit(1);
}
if (!m35Mode && !benchmarkMode && falsifier.length === 0 && !result.arcNovaLayerRunning) {
  console.error(`[smoke-dawn] FAIL Arc Nova GPU layer is not running ${JSON.stringify(result)}`);
  process.exit(1);
}
if (!m35Mode && !['ribbon', 'trail', 'beam'].every(kind => result.indirectDraws.includes(kind))) {
  console.error(`[smoke-dawn] FAIL independent topology evidence is missing ${JSON.stringify(result)}`);
  process.exit(1);
}
if (!m35Mode && Object.values(topologyPixels).some(count => count < 20)) {
  console.error(`[smoke-dawn] FAIL advanced topology pixels are missing ${JSON.stringify(result)}`);
  process.exit(1);
}
if (!depthProviderReady.value || !softParticle) {
  console.error(`[smoke-dawn] FAIL soft-particle Data Interface was not consumed ${JSON.stringify(result)}`);
  process.exit(1);
}
if (
  result.stageOutput === 'empty' ||
  result.stageDispatch.length === 0 ||
  result.stageDependencies.length === 0 ||
  result.lastKnownGoodStage === undefined ||
  !result.stageReadiness.some(item => item.id === requiredStageId)
) {
  console.error(`[smoke-dawn] FAIL managed stage evidence missing ${JSON.stringify(result)}`);
  process.exit(1);
}
if (
  falsifier.startsWith('stage-') &&
  (result.stageOutput !== 'last-known-good' ||
    !result.stageReadiness.some(item => item.state === 'candidate-rejected' && item.retryable))
) {
  console.error(`[smoke-dawn] FAIL stage falsifier did not retain LKG ${JSON.stringify(result)}`);
  process.exit(1);
}
if (
  lastCommitted === undefined ||
  lastCommitted.instanceGeneration !== lastCommitted.replayInput.generation ||
  JSON.stringify([...lastCommitted.canonicalPayload]) !==
    JSON.stringify([...lastCommitted.replayInput.payload])
) {
  console.error(`[smoke-dawn] FAIL non-canonical replay record ${JSON.stringify(result)}`);
  process.exit(1);
}
console.log(`[smoke-dawn] PASS ${JSON.stringify(result)}`);
if (!benchmarkMode) emitSmokeReceipt('hello-boss-lightning/smoke', result.frames);
process.exit(0);
