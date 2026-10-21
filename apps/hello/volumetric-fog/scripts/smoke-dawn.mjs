#!/usr/bin/env node
import { useBuiltAssetSource } from '../../../shared/scripts/source-publication.mjs';
// hello-volumetric-fog Dawn smoke: exercise the Engine App/Renderer front door.
// The density texture is authored as a real 3D TextureAsset and consumed by
// the VolumetricFog component; no parallel raw compute path is used.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';
import { combineSmokeErrors, createSmokeCleanup } from './smoke-resource-cleanup.mjs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const WIDTH = 200;
const HEIGHT = 150;
const requestedMinFrames = Number(process.env.SMOKE_MIN_FRAMES ?? '60');
if (!Number.isSafeInteger(requestedMinFrames) || requestedMinFrames < 1) {
  throw new Error('SMOKE_MIN_FRAMES must be a positive integer');
}
const SMOKE_MIN_FRAMES = Math.max(60, requestedMinFrames);
const CAMERA_INSIDE = [0, 0, 1.5];
const CAMERA_OUTSIDE = [0, 0, 4];
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const FOX_GLB_PATH = resolve(repoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Fox/Fox.glb');
const FOX_META_PATH = resolve(
  repoRoot,
  'forgeax-engine-assets/khronos-gltf-samples/Fox/Fox.glb.meta.json',
);
const jsonMode = process.argv.includes('--json');
const startedAt = Date.now();
const log = (...args) => {
  if (jsonMode) {
    console.error(...args);
    return;
  }
  process.stdout.write(`${args.join(' ')}\n`);
};
const artifact = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  backend: 'dawn',
  limits: {},
  errors: [],
  readback: { supported: false, reason: 'GPU probe not attempted' },
  oracle: { name: 'same-renderer-density-update', status: 'unavailable' },
  densityComparison: { status: 'not-captured' },
  fixture: {
    rendererInstances: 1,
    worldInstances: 1,
    attachmentLeases: 1,
    volumeOwners: 0,
    cameraPhases: ['inside', 'outside', 'inside'],
    densityUpdate: { sameOwner: true, sameRenderer: true, sameWorld: true },
    compositionGaps: [
      'Fox and transparent subject pixel composition ordering is not directly compared',
    ],
  },
  completedFrameIds: [],
  pass: false,
  sample: { source: 'World shared TextureAsset', generation: 1 },
  memoryBytes: 0,
  recovery: { attempts: 0, status: 'not-needed' },
  timingMs: 0,
};

const smokeCleanup = createSmokeCleanup();
let primaryFailure;
let cleanupErrors = [];
try {
  const { create, globals } = await import('@forgeax/engine-dawn-node');
  const originalGlobalDescriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  smokeCleanup.own(() => {
    for (const [key, descriptor] of originalGlobalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  Object.assign(globalThis, globals);
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  const smokeNavigator = globalThis.navigator;
  const originalGpuDescriptor = Object.getOwnPropertyDescriptor(smokeNavigator, 'gpu');
  smokeCleanup.own(() => {
    if (originalGpuDescriptor) Object.defineProperty(smokeNavigator, 'gpu', originalGpuDescriptor);
    else Reflect.deleteProperty(smokeNavigator, 'gpu');
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
  const gpu = create([]);
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  const originalGetPreferredCanvasFormat = gpu.getPreferredCanvasFormat;
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  // Keep final destroy responsibility for the exact device intercepted below.
  let sharedDevice;
  const originalGpuRequestAdapter = gpu.requestAdapter;
  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (...args) => {
    const adapter = await originalRequestAdapter(...args);
    if (!adapter) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...deviceArgs) => {
      const device = await originalRequestDevice(...deviceArgs);
      sharedDevice ??= device;
      return device;
    };
    return adapter;
  };
  smokeCleanup.own(() => {
    gpu.getPreferredCanvasFormat = originalGetPreferredCanvasFormat;
    gpu.requestAdapter = originalGpuRequestAdapter;
  });
  smokeCleanup.own(() => {
    sharedDevice?.destroy?.();
    sharedDevice = undefined;
  });

  let renderTarget;
  smokeCleanup.own(() => {
    const target = renderTarget;
    renderTarget = undefined;
    target?.destroy?.();
  });
  const mockCanvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc) {
          renderTarget?.destroy?.();
          renderTarget = desc.device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (!renderTarget) throw new Error('renderer did not configure the fog smoke target');
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const { createWorldContext, World } = await import('@forgeax/engine-ecs');
  const { constructRuntimeRendererHost } = await import(
    '@forgeax/engine-runtime/internal/renderer-host'
  );
  const {
    Camera,
    DirectionalLight,
    Materials,
    MeshFilter,
    MeshRenderer,
    renderComponentsPlugin,
    Skylight,
    TONEMAP_NEUTRAL,
    VolumetricFog,
    VolumetricFogSamplingValue,
    perspective,
  } = await import('@forgeax/engine-render');

  const { ChildOf, scenePlugin, Transform } = await import('@forgeax/engine-scene');
  const { Skin, skinningPlugin } = await import('@forgeax/engine-skinning');
  const { animationPlugin } = await import('@forgeax/engine-animation');
  const { gltfDocToSceneAsset, meshIrToMeshAsset, parseGlb, toMaterialAsset } = await import(
    '@forgeax/engine-gltf'
  );
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');

  const manifestUrl = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }),
  );
  smokeCleanup.own(() => URL.revokeObjectURL(manifestUrl));

  const constructed = await constructRuntimeRendererHost(
    mockCanvas,
    {},
    { shaderManifestUrl: manifestUrl },
  );
  if (!constructed.ok)
    throw new Error(`volumetric-fog renderer bootstrap failed: ${constructed.error.code}`);
  const { assets, renderer } = constructed.value;
  const world = new World({ assets });
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  const worldContext = await createWorldContext(world, [
    renderComponentsPlugin(),
    scenePlugin(),
    skinningPlugin(),
    animationPlugin(),
  ]);
  smokeCleanup.own(() => worldContext.fiber.dispose());

  smokeCleanup.own(async () => {
    const disposed = await renderer.dispose();
    if (!disposed.ok) {
      throw new Error(`volumetric-fog renderer disposal failed: ${disposed.error.code}`, {
        cause: disposed.error,
      });
    }
  });
  artifact.limits = renderer.inspect().capabilities;
  const densityAsset = (value) => ({
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
    format: 'r8unorm',
    data: new Uint8Array(2 * 2 * 2).fill(value),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  });
  const baselineDensity = world.assets.create(densityAsset(0)).unwrap();
  const secondDensity = world.assets.create(densityAsset(96)).unwrap();
  const updatedDensity = world.assets.create(densityAsset(255)).unwrap();
  const material = world.assets.create(Materials.unlit([0.25, 0.42, 0.8, 1])).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
  const straightAlphaBlend = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const transparentMaterial = world.assets.create(Materials.standard({
      baseColor: [0.9, 0.3, 0.12, 0.35],
      metallic: 0,
      roughness: 0.6,
      renderState: { blend: straightAlphaBlend, depthWriteEnabled: false },
    })).unwrap();
  const transparentSubject = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0.6, 0, 0.2], quat: [0, 0, 0, 1], scale: [0.7, 0.7, 0.7] },
      },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [transparentMaterial] } },
    )
    .unwrap();
  const light = world
    .spawn({
      component: DirectionalLight,
      data: { castShadow: true, direction: [-0.4, -0.7, -0.5], color: [1, 1, 1], intensity: 1 },
    })
    .unwrap();
  world.spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 0 } }).unwrap();
  const cameraEntity = world
    .spawn(
      { component: Transform, data: { pos: CAMERA_INSIDE, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: WIDTH / HEIGHT }),
          tonemap: TONEMAP_NEUTRAL,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const spawnVolume = (density, boundsMin, boundsMax) =>
    world
      .spawn({
        component: VolumetricFog,
        data: {
          light,
          density,
          boundsMin,
          boundsMax,
          extinction: [0.2, 0.2, 0.2],
          albedo: [1, 1, 1],
          emission: [0, 0, 0],
          anisotropy: 0,
          maxDistance: 20,
          sampling: VolumetricFogSamplingValue.density,
        },
      })
      .unwrap();
  const volumeEntities = [
    spawnVolume(baselineDensity, [-2, -2, -2], [2, 2, 2]),
    spawnVolume(secondDensity, [-1.75, -1.75, -1.75], [1.75, 1.75, 1.75]),
  ];
  const volumeOwnerCount = Array.from(world.query({ read: [VolumetricFog] }).unwrap()).length;
  if (volumeOwnerCount !== 2)
    throw new Error(`expected two live fog owners, got ${volumeOwnerCount}`);
  artifact.fixture.volumeOwners = volumeOwnerCount;

  const foxMeta = JSON.parse(readFileSync(FOX_META_PATH, 'utf8'));
  const foxSubAssets = foxMeta.subAssets;
  const foxSubAsset = (kind, sourceIndex) => {
    const row = foxSubAssets.find((item) => item.kind === kind && item.sourceIndex === sourceIndex);
    if (!row) throw new Error(`Fox.glb.meta.json missing ${kind}/${sourceIndex}`);
    return { guid: assets.parseGuid(row.guid), guidText: row.guid };
  };
  const foxMeshGuid = foxSubAsset('mesh', 0);
  const foxMaterialGuid = foxSubAsset('material', 0);
  const foxSceneGuid = foxSubAsset('scene', 0);
  const foxSkeletonGuid = foxSubAsset('skeleton', 0);
  const foxSkinGuid = foxSubAsset('skin', 0);
  useBuiltAssetSource(assets, new URL('../dist', import.meta.url).pathname);
  const foxSceneResult = await assets.load(foxSceneGuid.guid, 'scene');
  if (!foxSceneResult.ok) throw foxSceneResult.error;
  const foxSceneHandle = foxSceneResult.value;
  const foxInstance = assets.instantiate(foxSceneHandle, world);
  if (!foxInstance.ok) throw foxInstance.error;
  const foxRig = world
    .spawn({
      component: Transform,
      data: { pos: [-1.6, -1.35, 0], quat: [0, 0, 0, 1], scale: [0.02, 0.02, 0.02] },
    })
    .unwrap();
  world.addComponent(foxInstance.value, { component: ChildOf, data: { parent: foxRig } }).unwrap();
  const foxSkinEntities = Array.from(world.query({ read: [Skin] }).unwrap()).length;
  if (foxSkinEntities === 0) throw new Error('Fox scene did not instantiate any Skin entities');
  artifact.fixture.character = {
    asset: 'Fox.glb',
    sceneGuid: foxSceneGuid.guidText,
    skinEntityCount: foxSkinEntities,
    sameWorld: true,
    sameRenderer: true,
    path: 'built glTF publication + assets.load/instantiate + Skin',
  };
  artifact.fixture.transparentSubject = {
    entity: Number(transparentSubject),
    material: 'Standard with source-alpha blend and depth writes disabled',
    sameWorld: true,
    sameRenderer: true,
  };
  const baselineAsset = assets.read(baselineDensity);
  const updatedAsset = assets.read(updatedDensity);
  if (!baselineAsset.ok || !updatedAsset.ok)
    throw new Error('volumetric-fog density asset handle is not live');
  artifact.fixture.densityUpdate = {
    sameOwner: true,
    sameRenderer: true,
    sameWorld: true,
    fromHandle: Number(baselineDensity),
    toHandle: Number(updatedDensity),
    dataBytesChanged: baselineAsset.value.data.some(
      (value, index) => value !== updatedAsset.value.data[index],
    ),
  };
  if (!artifact.fixture.densityUpdate.dataBytesChanged)
    throw new Error('volumetric-fog density falsifier requires different source bytes');

  const attachment = renderer.attach(world);
  if (!attachment.ok)
    throw new Error(`volumetric-fog renderer attach failed: ${attachment.error.code}`);
  smokeCleanup.own(() => attachment.value.dispose());
  const errors = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push({ code: event.error.code, detail: event.error.detail });
  });
  log(`[hello-volumetric-fog] backend=${renderer.inspect().capabilities.backendKind}`);
  let framesObserved = 0;
  let latestReceipt;
  const completedFrameIds = new Set();

  async function drawCompletedFrame(label) {
    world.update().unwrap();
    const drawn = renderer.draw({
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
    if (!drawn.ok) {
      throw new Error(
        `volumetric-fog ${label} draw failed at frame ${framesObserved + 1}: ${drawn.error.code}`,
      );
    }
    const receipt = drawn.value;
    const completed = await receipt.completed;
    if (!completed.ok) {
      throw new Error(`volumetric-fog ${label} frame completion failed: ${completed.error.code}`);
    }
    if (completedFrameIds.has(receipt.frameId)) {
      throw new Error(`volumetric-fog duplicated completed frame receipt ${receipt.frameId}`);
    }
    completedFrameIds.add(receipt.frameId);
    framesObserved = completedFrameIds.size;
    artifact.framesObserved = framesObserved;
    artifact.completedFrameIds = [...completedFrameIds];
    latestReceipt = receipt;
    return receipt;
  }

  async function readCompletedCanvasPixels(receipt) {
    if (!completedFrameIds.has(receipt.frameId) || receipt.presentation !== 'ready') {
      throw new Error(
        `volumetric-fog readback requires a ready completed receipt: ${receipt.frameId}`,
      );
    }
    if (!sharedDevice || !renderTarget) {
      throw new Error('volumetric-fog renderer did not produce a readback target');
    }
    const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
    const readback = sharedDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
    smokeCleanup.own(() => readback.destroy());
    const encoder = sharedDevice.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    sharedDevice.queue.submit([encoder.finish()]);
    await readback.mapAsync(0x01);
    const paddedPixels = new Uint8Array(readback.getMappedRange().slice());
    readback.unmap();

    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let row = 0; row < HEIGHT; row += 1) {
      const sourceOffset = row * bytesPerRow;
      pixels.set(paddedPixels.subarray(sourceOffset, sourceOffset + WIDTH * 4), row * WIDTH * 4);
    }
    return { pixels, memoryBytes: bytesPerRow * HEIGHT };
  }

  function comparePixels(before, after) {
    if (before.length !== after.length || before.length !== WIDTH * HEIGHT * 4) {
      throw new Error('volumetric-fog pixel captures have incompatible extents');
    }
    let changedPixels = 0;
    let totalRgbDelta = 0;
    for (let offset = 0; offset < before.length; offset += 4) {
      const redDelta = Math.abs((before[offset] ?? 0) - (after[offset] ?? 0));
      const greenDelta = Math.abs((before[offset + 1] ?? 0) - (after[offset + 1] ?? 0));
      const blueDelta = Math.abs((before[offset + 2] ?? 0) - (after[offset + 2] ?? 0));
      if (redDelta + greenDelta + blueDelta > 0) changedPixels += 1;
      totalRgbDelta += (redDelta + greenDelta + blueDelta) / (3 * 255);
    }
    return {
      changedPixels: changedPixels / (WIDTH * HEIGHT),
      meanRgbDelta: totalRgbDelta / (WIDTH * HEIGHT),
    };
  }

  for (; framesObserved < SMOKE_MIN_FRAMES; ) await drawCompletedFrame('warmup');
  if (latestReceipt === undefined)
    throw new Error('volumetric-fog has no completed warmup receipt');
  const baselineReceipt = latestReceipt;
  const baselineInspection = await renderer.observe(baselineReceipt, {
    include: ['draws', 'bindings'],
  });
  if (!baselineInspection.ok) {
    throw new Error(`volumetric-fog baseline inspection failed: ${baselineInspection.error.code}`);
  }
  const { transparency: baselineTransparency, observation: graphObservation } = renderer.inspect();
  if (graphObservation.frameId !== baselineReceipt.frameId)
    throw new Error('volumetric-fog graph inspection does not belong to the completed baseline');
  const baselinePassNames = graphObservation.passNames;
  for (const pass of ['volume-inject', 'volume-integrate', 'volume-temporal', 'volume-composite'])
    if (!baselinePassNames.includes(pass))
      throw new Error(`volumetric-fog committed graph omitted ${pass}`);
  if ((baselineTransparency?.sortedDrawCount ?? 0) < 1) {
    throw new Error(
      'volumetric-fog transparent subject did not enter the sorted transparent draw lane',
    );
  }
  if (!baselinePassNames.includes('transparent')) {
    throw new Error('volumetric-fog committed graph omitted its transparent composition pass');
  }
  artifact.fixture.transparentSubject = {
    ...artifact.fixture.transparentSubject,
    sortedDrawCount: baselineTransparency.sortedDrawCount,
    passNames: baselinePassNames,
  };
  const baselineCapture = await readCompletedCanvasPixels(baselineReceipt);

  world.set(cameraEntity, Transform, { pos: CAMERA_OUTSIDE }).unwrap();
  const outsideReceipt = await drawCompletedFrame('camera outside both volumes');
  if (outsideReceipt.presentation !== 'ready') {
    throw new Error(`volumetric-fog outside camera frame is not ready: ${outsideReceipt.frameId}`);
  }
  const outsideInspection = await renderer.observe(outsideReceipt, {
    include: ['draws', 'bindings'],
  });
  if (!outsideInspection.ok) {
    throw new Error(
      `volumetric-fog outside camera inspection failed: ${outsideInspection.error.code}`,
    );
  }

  world.set(cameraEntity, Transform, { pos: CAMERA_INSIDE }).unwrap();
  world.set(volumeEntities[0], VolumetricFog, { density: updatedDensity }).unwrap();
  const activeOwners = Array.from(world.query({ read: [VolumetricFog] }).unwrap(), (row) =>
    row.get(VolumetricFog),
  );
  if (Number(activeOwners[0]?.density) !== Number(updatedDensity)) {
    throw new Error('volumetric-fog density handle update did not reach the live owner');
  }
  const updatedReceipt = await drawCompletedFrame('updated density inside volume');
  if (updatedReceipt.presentation !== 'ready') {
    throw new Error(`volumetric-fog updated density frame is not ready: ${updatedReceipt.frameId}`);
  }
  const inspection = await renderer.observe(updatedReceipt, { include: ['draws', 'bindings'] });
  if (!inspection.ok)
    throw new Error(`volumetric-fog updated inspection failed: ${inspection.error.code}`);
  const updatedCapture = await readCompletedCanvasPixels(updatedReceipt);
  const densityComparison = comparePixels(baselineCapture.pixels, updatedCapture.pixels);
  const nonBlackPixels = updatedCapture.pixels.reduce((count, value, index) => {
    if (index % 4 !== 0) return count;
    return (
      count +
      ((value ?? 0) |
      (updatedCapture.pixels[index + 1] ?? 0) |
      (updatedCapture.pixels[index + 2] ?? 0)
        ? 1
        : 0)
    );
  }, 0);
  const densityPixelPass =
    densityComparison.changedPixels > 0.01 && densityComparison.meanRgbDelta > 0.01;
  artifact.fixture.cameraPositions = { inside: CAMERA_INSIDE, outside: CAMERA_OUTSIDE };
  artifact.fixture.densityUpdate.completedFrameId = updatedReceipt.frameId;
  artifact.densityComparison = {
    status: densityPixelPass ? 'pass' : 'mismatch',
    baselineFrameId: baselineReceipt.frameId,
    outsideFrameId: outsideReceipt.frameId,
    updatedFrameId: updatedReceipt.frameId,
    ...densityComparison,
    threshold: { changedPixelsGreaterThan: 0.01, meanRgbDeltaGreaterThan: 0.01 },
  };
  artifact.readback = { supported: true, nonBlackPixels, width: WIDTH, height: HEIGHT };
  artifact.framesObserved = framesObserved;
  artifact.completedFrameIds = [...completedFrameIds];
  artifact.memoryBytes = Math.max(baselineCapture.memoryBytes, updatedCapture.memoryBytes);
  artifact.oracle = {
    name: 'same-renderer-density-update',
    status: densityPixelPass ? 'pass' : 'mismatch',
  };
  artifact.pass =
    densityPixelPass &&
    nonBlackPixels > 0 &&
    (baselineTransparency?.sortedDrawCount ?? 0) > 0 &&
    baselinePassNames.includes('transparent') &&
    errors.length === 0 &&
    framesObserved >= SMOKE_MIN_FRAMES;
  artifact.timingMs = Date.now() - startedAt;
  log(`[smoke] frames observed=${framesObserved}`);
  log(`[smoke] density comparison=${JSON.stringify(artifact.densityComparison)}`);
  log(`[smoke] readback=${JSON.stringify({ nonBlackPixels, inspection: inspection.value })}`);
  if (framesObserved < SMOKE_MIN_FRAMES)
    throw new Error(`frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
  if (nonBlackPixels === 0) throw new Error('volumetric-fog readback was entirely black');
  if (!densityPixelPass) {
    throw new Error(
      `density visual falsifier failed: changedPixels=${densityComparison.changedPixels.toFixed(4)} meanRgbDelta=${densityComparison.meanRgbDelta.toFixed(4)}`,
    );
  }
  if (errors.length > 0)
    throw new Error(`volumetric-fog renderer errors: ${JSON.stringify(errors)}`);
} catch (error) {
  primaryFailure = { error };
} finally {
  cleanupErrors = await smokeCleanup.dispose();
}

const smokeFailure = combineSmokeErrors(primaryFailure, cleanupErrors);
if (primaryFailure !== undefined && cleanupErrors.length === 0) throw primaryFailure.error;
if (smokeFailure !== undefined) throw smokeFailure;
if (!jsonMode) emitSmokeReceipt('hello-volumetric-fog/smoke', artifact.framesObserved);
log(
  `[smoke] PASS - same Renderer density update, ${artifact.framesObserved} completed receipt frames and real pixel readback GREEN`,
);
if (jsonMode) {
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(artifact)}\n`, resolve));
}
