#!/usr/bin/env node
// Point-shadow recipe smoke.
//
// This is intentionally a consumer-shaped check, not only a cube-array
// primitive test: it creates the same renderer host used by the focused app,
// publishes one PointLight + PointLightShadow scene, submits 60 frames, and
// checks the renderer-owned detached inspection. The existing browser test is
// run first so both WebGPU delivery lanes remain visible in one evidence row.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const appRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(appRoot, '../../..');
const vitest = resolve(repoRoot, 'node_modules/.bin/vitest');
const frameTarget = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const width = Number.parseInt(process.env.SMOKE_WIDTH ?? '96', 10);
const height = Number.parseInt(process.env.SMOKE_HEIGHT ?? '96', 10);
const skipBrowser = process.env.POINT_SHADOW_SKIP_BROWSER === '1';

if (!Number.isInteger(frameTarget) || frameTarget < 60) {
  throw new Error(`point-shadow smoke requires SMOKE_MIN_FRAMES >= 60, got ${frameTarget}`);
}
if (!Number.isInteger(width) || width < 16 || !Number.isInteger(height) || height < 16) {
  throw new Error(`point-shadow smoke requires positive surface dimensions, got ${width}x${height}`);
}

const source = readFileSync(resolve(appRoot, 'src/main.ts'), 'utf8');
const bootstrap = readFileSync(resolve(appRoot, 'src/bootstrap.ts'), 'utf8');
assert.match(source, /fixture === 'point-shadow-recipe'/, 'main must activate point-shadow recipe');
assert.match(bootstrap, /PointLightShadow/, 'recipe must publish PointLightShadow');
assert.match(bootstrap, /PointLight/, 'recipe must publish PointLight');

const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;

function runVitest(args) {
  const result = spawnSync(vitest, args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function serializeResult(result) {
  if (result === undefined) return { status: 'not-run' };
  if (result.ok) return { ok: true, value: result.value };
  return {
    ok: false,
    error: {
      code: result.error.code,
      expected: result.error.expected,
      hint: result.error.hint,
      detail: result.error.detail,
    },
  };
}

async function readSurface(device, texture) {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readback = device.createBuffer({
    size: bytesPerRow * height,
    usage: 0x01 | 0x08,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(0x01);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  let nonZeroPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      if ((bytes[offset] ?? 0) !== 0 || (bytes[offset + 1] ?? 0) !== 0 || (bytes[offset + 2] ?? 0) !== 0) {
        nonZeroPixels += 1;
      }
    }
  }
  return { bytes, bytesPerRow, nonZeroPixels };
}

function pixelDifference(a, b, bytesPerRow) {
  let difference = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      difference += Math.abs((a[offset] ?? 0) - (b[offset] ?? 0));
      difference += Math.abs((a[offset + 1] ?? 0) - (b[offset + 1] ?? 0));
      difference += Math.abs((a[offset + 2] ?? 0) - (b[offset + 2] ?? 0));
    }
  }
  return difference;
}

const browserStatus = skipBrowser
  ? null
  : runVitest([
      'run',
      '--config',
      'config/vitest.browser.config.ts',
      '--project=browser',
      'packages/runtime/src/__tests__/point-light-shadow.browser.test.ts',
      '--maxWorkers=1',
      '--retry=0',
    ]);

let dawnEvidence;
let dawnStatus = 0;
let atlasCapacity = null;
let shadowInspection;
let inactiveInspection;
let inactiveProjection;
let validAdmission;
let overBudgetAdmission;
let missingCapabilityAdmission;
let directionalPassNames = [];
let shadowSurface;
let noShadowSurface;
let sharedDevice;
let renderTarget;
let renderer;
let recipeContext;
let attachment;
let noShadowAttachment;

try {
  const { create, globals } = await import('@forgeax/engine-dawn-node');
  Object.assign(globalThis, globals);
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {},
    });
  }
  const gpu = create([]);
  Object.defineProperty(globalThis.navigator, 'gpu', {
    configurable: true,
    writable: true,
    value: gpu,
  });
  // Dawn's preferred format can be BGRA on some machines. Pin the same
  // rgba8unorm surface route used by the other Dawn hello smokes so the
  // readback texture has one deterministic format.
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await originalRequestDevice(descriptor);
      sharedDevice ??= device;
      return device;
    };
    return adapter;
  };

  function ensureRenderTarget(device, format = 'rgba8unorm') {
    if (renderTarget !== undefined) return renderTarget;
    const viewFormat = format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb';
    renderTarget = device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: 0x10 | 0x01,
      viewFormats: [viewFormat],
    });
    return renderTarget;
  }

  const mockCanvas = {
    tagName: 'CANVAS',
    isConnected: true,
    width,
    height,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor) {
          ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture() {
          if (renderTarget === undefined) {
            if (sharedDevice === undefined) throw new Error('point-shadow smoke: device not captured');
            ensureRenderTarget(sharedDevice);
          }
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const [app, ecs, render, scene, runtime, shader, assetsRuntime] = await Promise.all([
    import('@forgeax/engine-app'),
    import('@forgeax/engine-ecs'),
    import('@forgeax/engine-render'),
    import('@forgeax/engine-scene'),
    import('@forgeax/engine-runtime/internal/renderer-host'),
    import('@forgeax/engine-vite-plugin-shader'),
    import('@forgeax/engine-assets-runtime'),
  ]);
  atlasCapacity = render.SHADOW_ATLAS_DEFAULT_LAYERS;
  const manifest = await shader.buildEngineShaderManifest({ pointShadows: true });
  const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
  process.once('exit', () => URL.revokeObjectURL(manifestUrl));
  const constructed = await runtime.constructRuntimeRendererHost(
    mockCanvas,
    {},
    { shaderManifestUrl: manifestUrl },
  );
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  recipeContext = new app.Context();
  await recipeContext.plugin(app.rendererPlugin(renderer));
  await recipeContext.plugin(app.pointShadowPlugin());
  validAdmission = recipeContext.pointShadow?.admit(1);
  assert.equal(validAdmission?.ok, true, 'focused recipe must admit one caster before spawn');
  overBudgetAdmission = app.admitPointShadowBudget(atlasCapacity + 1);
  assert.equal(overBudgetAdmission?.ok, false, 'over-budget admission must be structured');
  missingCapabilityAdmission = app.admitPointShadowBudget(1, 'storageBuffer');
  assert.equal(missingCapabilityAdmission.ok, false, 'missing capability must be structured');
  const world = new ecs.World();
  const material = world.allocSharedRef(
    'MaterialAsset',
    render.Materials.standard({
      baseColor: [0.82, 0.36, 0.08, 1],
      metallic: 0,
      roughness: 0.45,
    }),
  );

  // The cube is the caster and the flattened cube is the receiver. Their
  // material's built-in shadow-caster pass is part of the production recipe.
  world.spawn(
    { component: scene.Transform, data: { pos: [0, 0, 0], scale: [1.25, 1.25, 1.25] } },
    { component: render.MeshFilter, data: { assetHandle: assetsRuntime.HANDLE_CUBE } },
    { component: render.MeshRenderer, data: { materials: [material] } },
  );
  world.spawn({
    component: render.DirectionalLight,
    data: {
      direction: [-0.4, -0.8, -1],
      intensity: 0.35,
      castShadow: true,
      cascadeCount: 1,
      mapSize: 64,
      shadowDistance: 30,
    },
  });
  world.spawn(
    { component: scene.Transform, data: { pos: [0, -1.7, 0], scale: [3.5, 0.15, 3.5] } },
    { component: render.MeshFilter, data: { assetHandle: assetsRuntime.HANDLE_CUBE } },
    { component: render.MeshRenderer, data: { materials: [material] } },
  );
  world.spawn(
    { component: scene.Transform, data: { pos: [0, 0, 6] } },
    {
      component: render.Camera,
      data: {
        fov: Math.PI / 4,
        aspect: width / height,
        near: 0.1,
        far: 50,
        clearColor: [0.02, 0.02, 0.04, 1],
      },
    },
  );
  world.spawn(
    { component: scene.Transform, data: { pos: [1.8, 2.6, 2.2] } },
    { component: render.PointLight, data: { color: [1, 0.72, 0.4], intensity: 18, range: 12 } },
    { component: render.PointLightShadow, data: { mapSize: 256, nearPlane: 0.1, farPlane: 25 } },
  );

  // This is a standalone renderer host, so no scenePlugin is installed to
  // run the transform system during World.update. Propagate once explicitly
  // before extraction so the Dawn pixel comparison sees the real scene.
  scene.propagateTransforms(world).unwrap();

  attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const rendererErrors = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrors.push(event.error);
  });
  let frames = 0;
  let receipt;
  for (let frame = 0; frame < frameTarget; frame += 1) {
    world.update(1 / 60).unwrap();
    const drawn = renderer.draw({
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
    if (!drawn.ok) throw drawn.error;
    receipt = drawn.value;
    frames += 1;
  }
  if (receipt === undefined) throw new Error('point-shadow smoke: no FrameReceipt');
  await sharedDevice?.queue.onSubmittedWorkDone();
  const inspection = renderer.inspect();
  const pointShadow = inspection.pointShadow;
  shadowInspection = pointShadow;
  assert.ok(pointShadow, 'renderer inspection must expose point-shadow facts');
  assert.equal(pointShadow.status, 'ready');
  assert.equal(pointShadow.requested, 1);
  assert.equal(pointShadow.admitted, 1);
  assert.equal(pointShadow.shadowed, 1);
  assert.equal(pointShadow.shadowAtlasOccupancy, 1);
  assert.equal(pointShadow.shadowAtlasCapacity, atlasCapacity);
  // Each face may also record retained static-layer passes (`.static`, `.static-copy`).
  const pointPasses = inspection.perFramePassNames.filter((name) => /^point-shadow-\d+-\d+$/.test(name));
  assert.equal(pointPasses.length, 6, `expected one point light x six faces, got ${pointPasses.length}`);
  directionalPassNames = inspection.perFramePassNames.filter(
    (name) => name === 'shadowCascade0' || name === 'directional-shadow-observation',
  );
  assert.ok(directionalPassNames.includes('shadowCascade0'), 'directional CSM pass must be real');
  assert.ok(
    directionalPassNames.includes('directional-shadow-observation'),
    'directional CSM observation pass must be real',
  );
  assert.equal(rendererErrors.length, 0, `renderer errors: ${JSON.stringify(rendererErrors)}`);

  // Capture the shadowed output before driving the same renderer through a
  // no-shadow World; the byte comparison is the pixel-level shadow/no-shadow
  // witness while inspection remains the renderer-owned state proof.
  if (sharedDevice === undefined || renderTarget === undefined) {
    throw new Error('point-shadow smoke: no Dawn surface to read back');
  }
  shadowSurface = await readSurface(sharedDevice, renderTarget);
  assert.ok(shadowSurface.nonZeroPixels > 0, 'point-shadow recipe must produce non-black output');

  const noShadowWorld = new ecs.World();
  const noShadowMaterial = noShadowWorld.allocSharedRef(
    'MaterialAsset',
    render.Materials.standard({
      baseColor: [0.82, 0.36, 0.08, 1],
      metallic: 0,
      roughness: 0.45,
    }),
  );
  noShadowWorld.spawn(
    { component: scene.Transform, data: { pos: [0, 0, 0], scale: [1.25, 1.25, 1.25] } },
    { component: render.MeshFilter, data: { assetHandle: assetsRuntime.HANDLE_CUBE } },
    { component: render.MeshRenderer, data: { materials: [noShadowMaterial] } },
  );
  noShadowWorld.spawn(
    { component: scene.Transform, data: { pos: [0, -1.7, 0], scale: [3.5, 0.15, 3.5] } },
    { component: render.MeshFilter, data: { assetHandle: assetsRuntime.HANDLE_CUBE } },
    { component: render.MeshRenderer, data: { materials: [noShadowMaterial] } },
  );
  noShadowWorld.spawn(
    { component: scene.Transform, data: { pos: [0, 0, 6] } },
    {
      component: render.Camera,
      data: { fov: Math.PI / 4, aspect: width / height, near: 0.1, far: 50, clearColor: [0.02, 0.02, 0.04, 1] },
    },
  );
  noShadowWorld.spawn({
    component: render.DirectionalLight,
    data: {
      direction: [-0.4, -0.8, -1],
      intensity: 0.35,
      castShadow: true,
      cascadeCount: 1,
      mapSize: 64,
      shadowDistance: 30,
    },
  });
  noShadowWorld.spawn(
    { component: scene.Transform, data: { pos: [1.8, 2.6, 2.2] } },
    { component: render.PointLight, data: { color: [1, 0.72, 0.4], intensity: 18, range: 12 } },
  );
  scene.propagateTransforms(noShadowWorld).unwrap();
  noShadowAttachment = renderer.attach(noShadowWorld);
  if (!noShadowAttachment.ok) throw noShadowAttachment.error;
  for (let frame = 0; frame < 6; frame += 1) {
    noShadowWorld.update(1 / 60).unwrap();
    const drawn = renderer.draw({
      leases: [noShadowAttachment.value],
      camera: { lease: noShadowAttachment.value },
      environment: { lease: noShadowAttachment.value },
    });
    if (!drawn.ok) throw drawn.error;
  }
  inactiveInspection = renderer.inspect().pointShadow;
  inactiveProjection = render.inspectPointShadow([], atlasCapacity);
  assert.equal(inactiveInspection?.status, 'inactive');
  assert.deepEqual(inactiveInspection, inactiveProjection);
  assert.equal(renderer.inspect().perFramePassNames.filter((name) => name.startsWith('point-shadow-')).length, 0);
  await sharedDevice.queue.onSubmittedWorkDone();
  noShadowSurface = await readSurface(sharedDevice, renderTarget);
  assert.ok(noShadowSurface.nonZeroPixels > 0, 'no-shadow baseline must produce non-black output');
  const shadowVsNoShadowPixelDifference = pixelDifference(
    shadowSurface.bytes,
    noShadowSurface.bytes,
    shadowSurface.bytesPerRow,
  );
  assert.ok(
    shadowVsNoShadowPixelDifference > 0,
    `shadow and no-shadow outputs must differ (difference=${shadowVsNoShadowPixelDifference})`,
  );
  await recipeContext.fiber.dispose();
  dawnEvidence = {
    status: 'pass',
    frames,
    nonZeroPixels: shadowSurface.nonZeroPixels,
    noShadowNonZeroPixels: noShadowSurface.nonZeroPixels,
    shadowVsNoShadowPixelDifference,
    inspection: pointShadow,
    inactiveInspection,
    validAdmission: serializeResult(validAdmission),
    directionalPassNames,
    passCount: pointPasses.length,
  };
  attachment.value.dispose();
  noShadowAttachment.value.dispose();
  await renderer.dispose();
  sharedDevice?.destroy?.();
} catch (error) {
  dawnStatus = 1;
  dawnEvidence = {
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
  };
  // Keep a failed Dawn assertion from leaving the native device/event loop
  // alive, which would hide the actual failure behind a hung smoke process.
  try {
    attachment?.value?.dispose();
  } catch {}
  try {
    noShadowAttachment?.value?.dispose();
  } catch {}
  try {
    await recipeContext?.fiber.dispose();
  } catch {}
  try {
    await renderer?.dispose();
  } catch {}
  sharedDevice?.destroy?.();
}

const evidence = {
  fixture: 'point-shadow-recipe',
  browser: skipBrowser ? 'not-run' : browserStatus === 0 ? 'pass' : 'failed',
  dawn: dawnEvidence,
  falsification: {
    noPointLightShadow: {
      rendererInspection: inactiveInspection ?? { status: 'not-run' },
      projection: inactiveProjection ?? { status: 'not-run' },
    },
    overBudget: {
      requested: (atlasCapacity ?? 0) + 1,
      capacity: atlasCapacity,
      result: serializeResult(overBudgetAdmission),
    },
    missingStorageBuffer: {
      capability: 'storageBuffer',
      result: serializeResult(missingCapabilityAdmission),
    },
  },
  directionalCsm: {
    owner: 'renderer',
    passNames: directionalPassNames,
    gate:
      directionalPassNames.includes('shadowCascade0') &&
      directionalPassNames.includes('directional-shadow-observation')
        ? 'pass'
        : 'failed',
  },
  hardwareFps: 'not-claimed',
};
const overallStatus =
  browserStatus === null
    ? dawnStatus === 0
      ? 'PARTIAL (browser not-run)'
      : 'FAIL'
    : browserStatus === 0 && dawnStatus === 0
      ? 'PASS'
      : 'FAIL';
console.log(`[deep-agent-feedback] point-shadow recipe smoke: ${overallStatus}`);
console.log(JSON.stringify(evidence));
if (browserStatus !== null && browserStatus !== 0) process.exitCode = browserStatus;
if (dawnStatus !== 0) process.exitCode = dawnStatus;
