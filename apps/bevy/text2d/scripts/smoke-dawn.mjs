#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// Dawn-node smoke for Bevy's text2d mapping.
//
// The browser app and this smoke both call src/text2d.ts. Dawn cannot fetch a
// Vite pack-index, so this script registers the same baked DejaVu MSDF payload
// inline and then drives the public World + renderer path for deterministic
// readback.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';


const framesTarget = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const width = 320;
const height = 180;
const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(process.env.SMOKE_ARTIFACT_DIR ?? resolve(here, '..', 'artifacts'));
mkdirSync(artifactDir, { recursive: true });

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - dawn.node import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        renderTarget ??= descriptor.device.createTexture({
          size: { width, height, depthOrArrayLayers: 1 },
          format: descriptor.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() { return renderTarget; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { createApp } = await import('@forgeax/engine-app/browser');
const { Update } = await import('@forgeax/engine-ecs');
const { MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const {
  Text2dMotion,
  registerSharedSampler,
  buildText2dFontRecoveryWorld,
  buildText2dWorld,
  createText2dFontRecoveryController,
  stepText2d,
} = await import(resolve(here, '..', 'src', 'text2d.ts'));
const m34RecoveryMode = process.argv.includes('--m34-recovery');
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;

const result = await createApp(mockCanvas, { platform: createSmokePlatform(mockCanvas) }, { shaderManifestUrl: manifestUrl }).catch((error) => {
  console.error(`[smoke] FAIL - createApp threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
gpu.requestAdapter = originalRequestAdapter;
if (!result.ok) {
  console.error(`[smoke] FAIL - createApp: ${result.error.code}`);
  process.exit(1);
}
const app = result.value;
console.log(`[bevy-text2d] backend=${rendererBackend(app.renderer)}`);
const errors = [];
const recordError = (error) =>
  errors.push({
    code: error.code,
    hint: error.hint,
    ...(error.expected === undefined ? {} : { expected: error.expected }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });
app.onError(recordError);
subscribeSmokeErrors(app.renderer, recordError);
const attachment = app.renderer.attach(app.world);
if (!attachment.ok) throw attachment.error;

const assets = app.assets;
if (assets === null) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}
registerSharedSampler(assets);
const fontHandle = await registerBakedFont(app.world, assets);
if (m34RecoveryMode) {
  const fontPayload = app.world.sharedRefs.resolve(fontHandle).unwrap();
  app.world.sharedRefs.release(fontHandle);
  const recoveryScene = buildText2dFontRecoveryWorld(app.world, fontPayload);
  let m34Phase = 0;
  app.world.addSystem(Update, {
    name: 'text2d-m34-frame-keepalive',
    queries: [],
    fn: (world) => {
      world.set(recoveryScene.unrelated, Transform, { pos: [m34Phase, 0, 0] });
      m34Phase += 0.001;
    },
  });
  await runM34Recovery(app, fontPayload, errors, artifactDir, recoveryScene);
  delete globalThis.navigator.gpu;
  process.exit(0);
}
const fontPayload = fontHandle;
const scene = buildText2dWorld(app.world, fontPayload);
app.world.addSystem(Update, {
  name: 'text2d-motion',
  queries: [],
  fn: (world) => stepText2d(world, scene, 1 / 60),
});

const attached = () => [scene.translation, scene.rotation, scene.scale, scene.multiline]
  .filter((entity) => worldGet(entity, MeshFilter) && worldGet(entity, MeshRenderer)).length;
const worldGet = (entity, component) => app.world.get(entity, component).ok;
let frames = 0;
for (let i = 0; i < framesTarget; i++) {
  const updated = app.world.update(1 / 60);
  if (!updated.ok) {
    console.error(`[smoke] FAIL - world.update frame=${i}: ${updated.error.code}`);
    process.exit(1);
  }
  const drawn = await drawSmokeFrame(app.renderer, app.world);
  if (!drawn.ok) console.error(`[smoke] draw frame=${i}: ${drawn.error.code}`);
  frames++;
  await delay(0);
}
await delay(100);

const pixels = await readback(sharedDevice);
writeFileSync(resolve(artifactDir, 'text2d.png'), encodePng(width, height, pixels));
const visiblePixels = countVisiblePixels(pixels);
const motion = app.world.get(scene.translation, Text2dMotion);
const motionPhase = motion.ok ? motion.value.phase : 0;
const metrics = { backend: rendererBackend(app.renderer), frames, attachedGlyphMeshes: attached(), motionPhase, visiblePixels, rhiErrors: errors.length };
writeFileSync(resolve(artifactDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`[smoke] frames observed=${frames}`);
console.log(`[smoke] GlyphText meshes attached=${metrics.attachedGlyphMeshes}/4`);
console.log(`[smoke] translation motion phase=${motionPhase.toFixed(3)}`);
console.log(`[smoke] visible pixels=${visiblePixels}`);
console.log(`[smoke] wrote PNG=${resolve(artifactDir, 'text2d.png')}`);

const failures = [];
if (rendererBackend(app.renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(app.renderer)}`);
if (frames < framesTarget) failures.push(`frames=${frames}<${framesTarget}`);
if (metrics.attachedGlyphMeshes !== 4) failures.push(`GlyphText mesh attachment=${metrics.attachedGlyphMeshes}/4`);
if (motionPhase <= 0) failures.push(`motionPhase=${motionPhase} did not advance`);
if (visiblePixels < 150) failures.push(`visiblePixels=${visiblePixels}<150`);
if (errors.length > 0) failures.push(`renderer errors=${JSON.stringify(errors.slice(0, 3))}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - ${frames} frames, 4 GlyphText meshes, ${visiblePixels} visible pixels, rhiErrors=0`);
delete globalThis.navigator.gpu;

async function registerBakedFont(world, assets) {
  const repoRoot = resolve(here, '..', '..', '..', '..');
  const fontDir = resolve(repoRoot, 'forgeax-engine-assets', 'dejavu-fonts');
  const atlasBytes = readFileSync(resolve(fontDir, 'DejaVuSansMono.atlas.png'));
  const pack = JSON.parse(readFileSync(resolve(fontDir, 'DejaVuSansMono.font.pack.json'), 'utf8'));
  const { loadUpng } = await import('@forgeax/engine-image');
  const decoded = (await loadUpng()).decode(atlasBytes, { useTArray: true, formatAsRGBA: true });
  const payload = pack.assets[0].payload;
  const atlas = AssetGuid.parse(payload.atlasGuid);
  const sampler = AssetGuid.parse(payload.samplerGuid);
  if (!atlas.ok || !sampler.ok) throw new Error('font asset GUID parse failed');
  assets.catalog(atlas.value, {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: decoded.width, height: decoded.height } },
    format: 'rgba8unorm',
    data: decoded.data,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  });
  return world.allocSharedRef('FontAsset', {
    kind: 'font',
    atlas: atlas.value,
    sampler: sampler.value,
    glyphs: payload.glyphs,
    common: payload.common,
  });
}

async function readback(device) {
  if (!device || !renderTarget) throw new Error('render target unavailable for readback');
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return tight;
}

function countVisiblePixels(pixels) {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const max = Math.max(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    const min = Math.min(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    if (max > 40 || max - min > 18) count++;
  }
  return count;
}

async function runM34Recovery(app, font, errors, outputDir, providedScene) {
  const scene = providedScene ?? buildText2dFontRecoveryWorld(app.world, font);
  const controller = createText2dFontRecoveryController(
    app.world,
    scene,
    async () => {
      const updated = app.world.update(1 / 60);
      if (!updated.ok) throw new Error(`M34 world.update failed: ${updated.error.code}`);
      const drawn = await drawSmokeFrame(app.renderer, app.world);
      if (!drawn.ok) throw new Error(`M34 renderer.draw failed: ${drawn.error.code}`);
      const repeated = await drawSmokeFrame(app.renderer, app.world);
      if (!repeated.ok) throw new Error(`M34 repeated renderer.draw failed: ${repeated.error.code}`);
      await delay(0);
    },
    () => errors,
  );

  const capture = async (name, statePromise) => {
    const state = await statePromise;
    await delay(100);
    const pixels = await readback(sharedDevice);
    const visiblePixels = countVisiblePixels(pixels);
    const path = resolve(outputDir, `m34-${name}.png`);
    writeFileSync(path, encodePng(width, height, pixels));
    return { state, visiblePixels, path };
  };

  const baseline = await capture('baseline', controller.baseline());
  const overflow = await capture('overflow', controller.overflow());
  const recovered = await capture('recovered', controller.recover());
  const cleanup = await capture('cleanup', controller.cleanup());
  const cleanupAgain = await controller.cleanup();
  const evidence = { baseline, overflow, recovered, cleanup, cleanupAgain, errors };
  writeFileSync(resolve(outputDir, 'm34-recovery-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  const failures = [];
  if (rendererBackend(app.renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(app.renderer)}`);
  if (baseline.state.prefixAttached !== 8 || !baseline.state.targetAttached || baseline.state.errorCount !== 0) {
    failures.push(`baseline=${JSON.stringify(baseline.state)}`);
  }
  const overflowError = overflow.state.lastError;
  if (
    overflow.state.prefixAttached !== 8 ||
    overflow.state.targetAttached ||
    overflow.state.errorCount !== 1 ||
    overflow.state.liveRefs !== overflow.state.baselineLiveRefs - 2 ||
    overflowError?.code !== 'font-concurrency-exceeded' ||
    overflowError.expected !== '8' ||
    JSON.stringify(overflowError.detail) !==
      JSON.stringify({ active: 8, limit: 8, rejected: scene.fonts[8] })
  ) {
    failures.push(`overflow=${JSON.stringify(overflow.state)}`);
  }
  if (
    recovered.state.prefixAttached !== 8 ||
    !recovered.state.targetAttached ||
    recovered.state.errorCount !== 1 ||
    recovered.state.liveRefs !== recovered.state.baselineLiveRefs ||
    recovered.state.targetMeshHandle === baseline.state.targetMeshHandle ||
    recovered.state.targetMaterialHandle === baseline.state.targetMaterialHandle
  ) {
    failures.push(`recovered=${JSON.stringify(recovered.state)}`);
  }
  if (
    cleanup.state.prefixAttached !== 0 ||
    cleanup.state.targetAttached ||
    !cleanup.state.unrelatedPresent ||
    cleanup.state.liveRefs !== cleanup.state.baselineLiveRefs - 27 ||
    JSON.stringify(cleanupAgain) !== JSON.stringify(cleanup.state) ||
    cleanup.state.errorCount !== 1
  ) {
    failures.push(`cleanup=${JSON.stringify({ cleanup: cleanup.state, cleanupAgain })}`);
  }
  if (overflow.visiblePixels >= baseline.visiblePixels) {
    failures.push(`overflow pixels did not remove target: ${baseline.visiblePixels}->${overflow.visiblePixels}`);
  }
  if (recovered.visiblePixels < baseline.visiblePixels * 0.8) {
    failures.push(`recovered pixels did not return: ${baseline.visiblePixels}->${recovered.visiblePixels}`);
  }
  if (cleanup.visiblePixels >= recovered.visiblePixels * 0.2) {
    failures.push(`cleanup pixels remained: ${cleanup.visiblePixels}`);
  }
  if (errors.length !== 1) failures.push(`errors=${JSON.stringify(errors)}`);
  if (failures.length > 0) {
    console.error(`[m34] FAIL - ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log(
    `[m34] PASS baseline=${baseline.visiblePixels} overflow=${overflow.visiblePixels} ` +
      `recovered=${recovered.visiblePixels} cleanup=${cleanup.visiblePixels} ` +
      `active=8 limit=8 rejected=${scene.fonts[8]}`,
  );
}
