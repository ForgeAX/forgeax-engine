#!/usr/bin/env node
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { decodeCatalogWire } from '@forgeax/engine-pack';

// Cinder Fall Dawn smoke intentionally drives the public Engine assembly. It
// is a bounded consumer oracle: the renderer owns all WebGPU command encoding,
// bind groups, compute dispatch and raster draws; this script only supplies a
// Dawn canvas shim and observes the resulting target.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupGpuShim } from '../../triangle/scripts/smoke-helpers.mjs';

const here = resolve(import.meta.dirname);
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const distRoot = resolve(appRoot, 'dist');
// Dawn CI runs this consumer through the lavapipe software path. Keep the
// long-lived 60-frame receipt contract, but use a small target so the test
// spends its budget on Engine/VFX lifecycle and submission work instead of
// rasterizing an unnecessarily large software framebuffer.
const WIDTH = 128;
const HEIGHT = 96;
const FRAMES = Math.max(60, Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10));
const SMOKE_TIMEOUT_MS = Number(process.env.DAWN_SMOKE_ENTRY_TIMEOUT_MS ?? 120_000);
if (!Number.isFinite(SMOKE_TIMEOUT_MS) || SMOKE_TIMEOUT_MS <= 0) {
  throw new Error(`cinder-fall: DAWN_SMOKE_ENTRY_TIMEOUT_MS must be a positive finite number, got ${process.env.DAWN_SMOKE_ENTRY_TIMEOUT_MS}`);
}
const EFFECT_GUID = 'c1de0000-0000-7000-8000-000000000000';
const STANDARD_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000001';
const ADDITIVE_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000002';
const ALPHA_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000003';
const PLATFORM_MATERIAL_GUID = 'c1de0000-0000-7000-8000-000000000004';

let smokePhase = 'bootstrap';
let timeout;
const armSmokeTimeout = () => {
  timeout = setTimeout(() => {
    console.error(`[cinder-fall-dawn] TIMEOUT after ${SMOKE_TIMEOUT_MS}ms phase=${smokePhase}`);
    process.exit(124);
  }, SMOKE_TIMEOUT_MS);
};
const phase = (value) => {
  smokePhase = value;
  if (value !== 'frame-loop') console.log(`[cinder-fall-dawn] phase=${value}`);
};

if (!existsSync(resolve(distRoot, 'pack-index.json'))) {
  phase('build');
  const build = spawnSync('pnpm', ['--filter', '@forgeax/hello-cinder-fall', 'build'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

// The roster gives the entry a runtime budget; a cold build is setup work and
// must not consume the Cinder frame-loop watchdog before the first frame.
armSmokeTimeout();

const packIndexText = readFileSync(resolve(distRoot, 'pack-index.json'), 'utf8');
const packIndex = decodeCatalogWire(JSON.parse(packIndexText)).unwrap();
const packageFiles = new Map(
  packIndex.map((entry) => [entry.packageUrl, resolve(distRoot, entry.packageUrl.slice(1))]),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (request) => {
  const url = new URL(typeof request === 'string' ? request : request.url, 'http://127.0.0.1');
  if (url.pathname === '/pack-index.json') return new Response(packIndexText);
  const packageFile = packageFiles.get(url.pathname);
  if (packageFile !== undefined) return new Response(readFileSync(packageFile));
  const assetFile = resolve(distRoot, url.pathname.slice(1));
  if (existsSync(assetFile)) return new Response(readFileSync(assetFile));
  return originalFetch(request);
};

phase('gpu-shim');
const shim = await setupGpuShim({ width: WIDTH, height: HEIGHT, rerunCmd: 'pnpm --filter @forgeax/hello-cinder-fall smoke' });
phase('engine-imports');
const manifest = JSON.parse(readFileSync(resolve(distRoot, 'shaders/manifest.json'), 'utf8'));
const { World } = await import('@forgeax/engine-ecs');
const { mat4, quat, vec3 } = await import('@forgeax/engine-math');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { HANDLE_CUBE, HANDLE_SPHERE } = await import('@forgeax/engine-assets-runtime');
const { createApp } = await import('@forgeax/engine-app');
const { GlobalTransform, Transform, scenePlugin } = await import('@forgeax/engine-scene');
const { loadVfxGpuEffect, ParticleEffectPlayer, VFX_GPU_RUNTIME_RESOURCE_KEY } = await import('@forgeax/engine-vfx');
const { createCameraProvider, createVfxRuntimeHost } = await import('@forgeax/engine-vfx-render');

const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 } });
const cameraPosition = [0, 4.9, 10.0];
const cameraTarget = [0, 3.8, 0];
const cameraQuat = quat.fromLookAt(quat.create(), cameraPosition, cameraTarget, [0, 1, 0]);
let cameraEntity;
const camera = {
  read(currentWorld) {
    if (cameraEntity === undefined) return undefined;
    const transform = currentWorld.get(cameraEntity, Transform);
    const globalTransform = currentWorld.get(cameraEntity, GlobalTransform);
    const cameraValue = currentWorld.get(cameraEntity, Camera);
    if (!transform.ok || !globalTransform.ok || !cameraValue.ok) return undefined;
    // Mirror the app camera provider and the renderer's camera authority:
    // VFX uses inverse(GlobalTransform.world) rather than a second lookAt target.
    const cameraWorld = globalTransform.value.world;
    const view = mat4.invert(mat4.create(), cameraWorld);
    const projection = mat4.perspectiveReverseZ(
      mat4.create(),
      cameraValue.value.fov,
      cameraValue.value.aspect,
      cameraValue.value.near,
      cameraValue.value.far,
    );
    return {
      position: new Float32Array(transform.value.pos),
      right: new Float32Array(mat4.getRight(vec3.create(), cameraWorld)),
      up: new Float32Array(mat4.getUp(vec3.create(), cameraWorld)),
      viewProjection: mat4.multiply(mat4.create(), projection, view),
    };
  },
};
const host = createVfxRuntimeHost({
  camera,
  providers: [createCameraProvider({ available: () => true })],
});
phase('renderer-construct');
const constructed = await constructRuntimeRendererHost(
  shim.mockCanvas,
  { features: [host.feature] },
  { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` },
);
if (!constructed.ok) throw constructed.error;
const { renderer, assets } = constructed.value;
phase('world-attach');
const attachment = renderer.attach(world);
if (!attachment.ok) throw attachment.error;
const lease = attachment.value;
assets.configurePackIndex('/pack-index.json');
const attached = await host.attachWorld({ world, assets });
if (!attached.ok) throw new Error(`cinder-fall: VFX host attach failed: ${attached.error.hint}`);

phase('assets');
const materialResult = await assets.loadByGuid(assets.parseGuid(STANDARD_MATERIAL_GUID));
if (!materialResult.ok) throw new Error(`cinder-fall: material load failed: ${String(materialResult.error)}`);
const material = world.allocSharedRef('MaterialAsset', materialResult.value);
let platformMaterial = material;
for (const guid of [ADDITIVE_MATERIAL_GUID, ALPHA_MATERIAL_GUID, PLATFORM_MATERIAL_GUID]) {
  const loadedMaterial = await assets.loadByGuid(assets.parseGuid(guid));
  if (!loadedMaterial.ok) throw new Error(`cinder-fall: material load failed: ${String(loadedMaterial.error)}`);
  // Keep every material referenced by the V3 renderer projections resident in
  // the same World registry. The VFX feature resolves these typed assets by
  // GUID during its owning prepare stage; it must not silently defer a
  // missing material to a zero-pass plan.
  const loadedRef = world.allocSharedRef('MaterialAsset', loadedMaterial.value);
  if (guid === PLATFORM_MATERIAL_GUID) platformMaterial = loadedRef;
}
cameraEntity = world.spawn(
  { component: Transform, data: { pos: cameraPosition, quat: cameraQuat } },
  { component: Camera, data: { fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
).unwrap();
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -0.8, -0.5], color: [1, 0.32, 0.1], intensity: 2, castShadow: true },
}).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, -0.12, 0], scale: [4.5, 0.1, 4.5] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [platformMaterial] } },
).unwrap();
const meteor = world.spawn(
  { component: Transform, data: { pos: [0, 8, 0], scale: [0.52, 0.7, 0.52] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
  { component: MeshRenderer, data: { materials: [material] } },
).unwrap();
phase('effect-load');
const loaded = await loadVfxGpuEffect(assets, EFFECT_GUID);
if (!loaded.ok) throw new Error(`cinder-fall: effect load failed: ${JSON.stringify(loaded.error)}`);
const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
const player = world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: ParticleEffectPlayer, data: { effect, playing: true, seed: 0xc1de3, timeScale: 1 } },
).unwrap();
phase('app-assemble');
const appResult = await createApp({ platform: createSmokePlatform({ width: 1, height: 1 }),  renderer, assets, world, plugins: [scenePlugin()] });
if (!appResult.ok) throw appResult.error;
const app = appResult.value;
const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

const runtime = world.getResource(VFX_GPU_RUNTIME_RESOURCE_KEY);
let drawCount = 0;
let lastReceipt;
phase('frame-loop');
for (let frame = 0; frame < FRAMES; frame += 1) {
  world.update(1 / 60).unwrap();
  const receipt = await drawReadyFrame(renderer, { leases: [lease], camera: { lease }, environment: { lease } });
  drawCount += 1;
  lastReceipt = receipt;
  if (frame % 10 === 0) console.log(`[cinder-fall-dawn] frame=${frame + 1}/${FRAMES}`);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}
phase('queue-complete');
await shim.sharedDevice.queue.onSubmittedWorkDone();
if (drawCount !== FRAMES || lastReceipt === undefined) throw new Error('cinder-fall: no Engine frame receipt');
phase('receipt-complete');
const completed = await lastReceipt.completed;
if (!completed.ok) throw new Error(`cinder-fall: submitted Engine frame failed: ${completed.error.hint}`);
phase('observe');
const observed = await renderer.observe(lastReceipt, { include: ['draws', 'bindings'] });
if (!observed.ok) throw new Error(`cinder-fall: Engine frame observation failed: ${observed.error.hint}`);
const passNames = renderer.inspect().perFramePassNames;
const computePasses = passNames.filter((name) => name.includes('compute') || name.includes('simulate') || name.includes('project')).length;
const rasterPasses = passNames.filter((name) => name.includes('raster') || name.includes('forward')).length;
if (computePasses === 0 || rasterPasses === 0) {
  console.error(
    `[cinder-fall-dawn] featureDiagnostics=${JSON.stringify(renderer.inspect().featureDiagnostics)} ` +
      `featurePasses=${JSON.stringify(renderer.inspect().features)}`,
  );
  throw new Error(`cinder-fall: expected compute+raster graph work, got ${JSON.stringify({ passNames, computePasses, rasterPasses })}`);
}
phase('readback');
const pixels = await readTargetPixels(shim.sharedDevice, shim.renderTarget, WIDTH, HEIGHT);
let energy = 0;
for (let index = 0; index < pixels.length; index += 4) energy += pixels[index] + pixels[index + 1] + pixels[index + 2];
if (energy === 0) throw new Error('cinder-fall: render target was empty after Engine draw');
const inspect = host.inspect(world);
if (inspect === undefined || inspect.players.every((candidate) => candidate.player !== player)) {
  throw new Error('cinder-fall: VFX player was not observable through the public host');
}
await app.dispose();
await host.detachWorld({ world });
lease.dispose();
await renderer.dispose();
clearTimeout(timeout);
console.log(`[cinder-fall-dawn] PASS - ${FRAMES} Engine frames, compute=${computePasses}, raster=${rasterPasses}, nonzero=${energy > 0}, diagnostics=${errors.length}`);
console.log(
  `[forgeax-smoke-receipt] ${JSON.stringify({
    schemaVersion: 1,
    gateId: 'hello-cinder-fall/smoke',
    commandId: 'smoke',
    framesObserved: drawCount,
    completed: true,
  })}`,
);
process.exit(0);

async function readTargetPixels(device, target, width, height) {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readback = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const result = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  return result;
}
