#!/usr/bin/env node
import { decodeCatalogWire } from '@forgeax/engine-pack';
// apps/learn-render/6.pbr/_shared/ibl-smoke-shared.mjs
//
// Shared dawn-node IBL smoke driver consumed by:
//   - apps/learn-render/6.pbr/2.ibl-irradiance/scripts/smoke-dawn.mjs
//   - apps/learn-render/6.pbr/3.ibl-specular/scripts/smoke-dawn.mjs
//   - scripts/bake-ibl-reference.mjs (BAKE mode for reference PNG regen)
//
// charter P5 producer/consumer split + dispatch F-9 (eliminate the 130-line
// smoke-dawn.mjs cross-pair duplicate). The two demos previously shipped
// near-identical scripts; the only deltas are demo id, capture-hook name,
// equirect HDR tint, sphere baseColor. Those parameterise here.
//
// charter "Demo failures route to engine fixes, not workarounds": the HDR
// equirect input is the real LearnOpenGL newport_loft.hdr CC-BY-NC carve-out
// (forgeax-engine-assets/learn-opengl/textures/newport_loft.hdr, GUID
// 019e4a26-3c29-7420-af5d-20f2724a16b0). In feat-20260604-hdr-equirect-cube-
// importer-loader M5, the smoke walks the REAL production loadByGuid path
// (configurePackIndex -> loadByGuid<EquirectAsset> -> allocSharedRef -> Skylight
// equirect handle; projection is internal to the engine record arm)
// using a mock fetch that serves the pre-built pack-index + imported .bin from
// the vite build dist directory. No decodeHdr / registerWithGuid bypass
// (AC-07). In FALSIFY=hdr-bin-empty mode the imported .bin payload is zeroed to
// verify the smoke pixel readback detects missing IBL (w17 falsification).
//
// Verdict (verify mode):
//   - backend === 'webgpu'
//   - frames observed >= 60 (SMOKE_MIN_FRAMES)
//   - renderer.subscribe error count 0
//   - mean abs delta between final-frame readback and reference PNG <= 0.05
//
// Bake mode: skips the diff and writes the final-frame readback to the
// reference PNG (idempotent -- a second run produces a bytewise-identical
// PNG given identical adapter + scene). Caller is responsible for
// committing the resulting PNG into the engine repo.
//
// Falsification (w17): FALSIFY=hdr-bin-empty zeroes the imported .bin payload.
// This must cause the smoke pixel readback to FAIL (IBL contribution goes
// black -> readback delta > threshold). The variant is manual-only (not in
// CI), proving the smoke can detect missing IBL. If the smoke readback is
// insensitive to IBL (samples hit constant-sky regions), the visual SSOT
// (browser Read(image)) is the final arbiter -- smoke serves as a regression
// baseline only (dawn-smoke-loose-threshold lesson).

import { readCatalogRows } from '@forgeax/engine-types';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SMOKE_DELTA_THRESHOLD = Number.parseFloat(process.env.SMOKE_DELTA_THRESHOLD ?? '0.05');
const WIDTH = 512;
const HEIGHT = 512;
const IBL_READY_TIMEOUT_MS = 120_000;
// Publishes renderer.inspect().iblBinding, the readiness fact the IBL wait below reads.
process.env.FORGEAX_MATERIAL_DIAGNOSTICS = '1';

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const FALSIFY_HDR_BIN_EMPTY = process.env.FALSIFY === 'hdr-bin-empty';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
const engineDist = (packageName, entry = 'index.mjs') =>
  pathToFileURL(resolve(monorepoRoot, 'packages', packageName, 'dist', entry)).href;

/**
 * Run the IBL smoke driver.
 *
 * @param {Object} opts
 * @param {'irradiance' | 'specular'} opts.demoKind  -- which sphere matrix tint to render.
 * @param {string} opts.demoId                       -- 'learn-render-ibl-irradiance' or 'learn-render-ibl-specular' (log prefix).
 * @param {string} opts.referencePath                -- absolute path to reference PNG (verify=read+diff, bake=write).
 * @param {'verify' | 'bake'} opts.mode              -- run mode.
 * @param {string} opts.distDir                      -- absolute path to the demo's vite build dist/ directory (for pre-built pack-index.json + imported .bin).
 */
export async function runIblSmoke(opts) {
  const { demoKind, demoId, referencePath, mode, distDir } = opts;

  // --- 1. dawn.node binding setup ---
  let create;
  let globals;
  try {
    ({ create, globals } = await import('@forgeax/engine-dawn-node'));
  } catch (err) {
    fail(`dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  Object.assign(globalThis, globals);
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  let gpu;
  try {
    gpu = create([]);
  } catch (err) {
    fail(`dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  // bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
  // smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
  // dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
  // path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
  // BGRA path is exercised through the helper unmodified there.
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  let sharedDevice;
  const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (req) => {
    const rawAdapter = await originalAmbientRequestAdapter(req);
    if (rawAdapter === null) return rawAdapter;
    const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
    rawAdapter.requestDevice = async (desc) => {
      const dev = await originalRequestDevice(desc);
      if (!sharedDevice) sharedDevice = dev;
      return dev;
    };
    return rawAdapter;
  };

  // --- 2. Mock canvas with offscreen render target ---
  let renderTarget;
  let renderTargetFormat = 'rgba8unorm';
  function ensureRenderTarget(device, format) {
    if (renderTarget) return renderTarget;
    renderTargetFormat = format;
    renderTarget = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format,
      usage: 0x10 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  }
  const mockCanvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc) {
          renderTargetFormat = desc.format ?? 'rgba8unorm';
          ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture() {
          if (!renderTarget) {
            if (!sharedDevice) throw new Error('no shared device captured');
            ensureRenderTarget(sharedDevice, 'rgba8unorm');
          }
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  // --- 3. Engine + manifest ---
  // This helper lives outside a workspace package, so Node cannot resolve a
  // child's pnpm dependency symlinks while loading it from `_shared/`.
  // Resolve the built package entries from the monorepo root instead.
  const { World } = await import(engineDist('ecs'));
  const { createSphereGeometry } = await import(engineDist('geometry'));
  const { Camera, MeshFilter, MeshRenderer } = await import(engineDist('render'));
  const { constructRuntimeRendererHost } = await import(
    engineDist('runtime', 'renderer-host.mjs'),
  );
  const { SKYBOX_MODE_CUBEMAP, SkyboxBackground, Skylight } = await import(
    engineDist('render'),
  );
  const { TONEMAP_REINHARD_EXTENDED } = await import(engineDist('render'));
  const { Transform } = await import(engineDist('scene'));
  const { buildEngineShaderManifest } = await import(engineDist('vite-plugin-shader'));

  const ENGINE_MANIFEST = await buildEngineShaderManifest();
  const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
  process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

  let renderer;
  let assets;
  try {
    const host = await constructRuntimeRendererHost(
      mockCanvas,
      {},
      { shaderManifestUrl: MANIFEST_URL },
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    assets = host.value.assets;
  } catch (err) {
    fail(`renderer host construction failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
  }

  console.log(`[${demoId}] backend=${renderer.inspect().capabilities.backendKind}`);

  const errors = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
  });


  // --- 4. Load newport_loft.hdr through REAL production loadByGuid path ---
  // AC-07: No decodeHdr / registerWithGuid HDR bypass. The smoke serves the
  // pre-built pack-index.json + Pack v2 package + asset-local body.bin from
  // distDir via mock fetch.
  const packIndexPath = resolve(distDir, 'pack-index.json');

  let packIndexWire;
  let packIndexJson;
  try {
    packIndexWire = JSON.parse(await readFile(packIndexPath, 'utf8'));
    packIndexJson = decodeCatalogWire(packIndexWire).unwrap();
  } catch (err) {
    fail(`pack-index.json unreadable at ${packIndexPath}: ${err instanceof Error ? err.message : String(err)}; run 'pnpm build' for this demo first.`);
  }

  const packIndexRows = readCatalogRows(packIndexJson);
  if (packIndexRows === undefined) throw new Error('Invalid published Catalog');
  const hdrEntry = packIndexRows.find((e) => e.guid === NEWPORT_LOFT_GUID);
  if (!hdrEntry) fail(`newport_loft.hdr GUID ${NEWPORT_LOFT_GUID} not found in pack-index at ${packIndexPath}`);
  const packagePath = resolve(distDir, hdrEntry.packageUrl.replace(/^\//, ''));
  let packFileJson;
  try {
    packFileJson = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch (err) {
    fail(`pack file unreadable at ${packagePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const packAsset = packFileJson.assets?.find((asset) => asset.guid === NEWPORT_LOFT_GUID);
  const bodyDescriptor = packAsset?.artifacts?.body;
  if (packAsset === undefined || bodyDescriptor?.path === undefined) {
    fail(`Pack v2 body artifact missing for ${NEWPORT_LOFT_GUID} in ${packagePath}`);
  }
  const artifactUrl = `${hdrEntry.packageUrl.slice(0, hdrEntry.packageUrl.lastIndexOf('/') + 1)}${bodyDescriptor.path}`;
  console.log(
    `[${demoId}] pack-index HDR entry: kind=${hdrEntry.kind} payload=${packAsset.payload?.format} ${packAsset.payload?.width}x${packAsset.payload?.height}`,
  );

  const importedBinPath = resolve(dirname(packagePath), bodyDescriptor.path);
  let importedBinBytes;
  try {
    const buf = await readFile(importedBinPath);
    importedBinBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    fail(`imported .bin unreadable at ${importedBinPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // FALSIFY=hdr-bin-empty: zero out the imported .bin to verify smoke detects missing IBL.
  if (FALSIFY_HDR_BIN_EMPTY) {
    console.log(`[${demoId}] FALSIFY=hdr-bin-empty: zeroing imported .bin payload (${importedBinBytes.length} bytes -> all-zero)`);
    importedBinBytes.fill(0);
  }

  // Mock fetch: serve pack-index.json, the Pack v2 JSON, and its body.bin.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url === '/pack-index.json') {
      return {
        ok: true,
        json: () => Promise.resolve(packIndexWire),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      };
    }
    if (typeof url === 'string' && url === hdrEntry.packageUrl) {
      return {
        ok: true,
        json: () => Promise.resolve(packFileJson),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(packFileJson)).buffer),
      };
    }
    if (typeof url === 'string' && url === artifactUrl) {
      const ab = new ArrayBuffer(importedBinBytes.byteLength);
      new Uint8Array(ab).set(importedBinBytes);
      return {
        ok: true,
        json: () => Promise.resolve({}),
        arrayBuffer: () => Promise.resolve(ab),
      };
    }
    return { ok: false, status: 404, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  };

  assets.configurePackIndex('/pack-index.json');

  const { AssetGuid } = await import(engineDist('pack', 'guid.mjs'));
  const guidRes = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guidRes.ok)
    fail(`AssetGuid.parse failed for NEWPORT_LOFT_GUID: ${guidRes.error.code}`);

  // loadByGuid returns the EquirectAsset PAYLOAD (D-17), not a handle.
  const hdrPodRes = await assets.loadByGuid(guidRes.value);
  if (!hdrPodRes.ok)
    fail(`loadByGuid(newport_loft.hdr) failed: ${hdrPodRes.error.code} - ${hdrPodRes.error.hint}`);

  const equirectPod = hdrPodRes.value;

  // --- 5. Build scene (3x3 sphere matrix) ---
  const world = new World();
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const frameRequest = {
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  };

  // Mint a user-tier handle for the equirect pod. The equirect->cubemap + IBL
  // projection is now INTERNAL to the engine (lazy, in the render record arm) --
  // the Skylight holds the equirect handle directly, no manual upload call.
  const equirect = world.allocSharedRef('EquirectAsset', equirectPod);

  console.log(`[${demoId}] loadByGuid<EquirectAsset> OK (format=${equirectPod.format} ${equirectPod.width}x${equirectPod.height})`);

  world.spawn({
    component: Skylight,
    data: { equirect, intensity: 1.0 },
  });

  const sphereRes = createSphereGeometry(1.0, 32, 16);
  if (!sphereRes.ok) fail(`createSphereGeometry failed: ${sphereRes.error.code}`);
  const sphereAssetHandle = world.allocSharedRef('MeshAsset', sphereRes.value);

  const baseColor = demoKind === 'specular' ? [0.5, 0.5, 0.5, 1.0] : [0.8, 0.8, 0.8, 1.0];
  const GRID = 3;
  const SPACING = 2.5;
  const SCALE = 0.9;
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const roughness = 0.1 + row * 0.4;
      const metallic = col * 0.5;
      // feat-20260527 M3 / w12: pass-based MaterialAsset minted as a
      // user-tier shared ref (M8 unified path).
      const matHandle = world.allocSharedRef('MaterialAsset', {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {
          baseColor,
          metallic,
          roughness,
        },
      });
      const cx = (col - (GRID - 1) / 2) * SPACING;
      const cy = ((GRID - 1) / 2 - row) * SPACING;
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [cx, cy, 0], quat: [0, 0, 0, 1], scale: [SCALE, SCALE, SCALE],},
        },
        { component: MeshFilter, data: { assetHandle: sphereAssetHandle } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      );
    }
  }

  const cameraData = demoKind === 'specular'
    ? { fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100, tonemap: TONEMAP_REINHARD_EXTENDED, clearColor: [0.1, 0.1, 0.1, 1] }
    : { fov: Math.PI / 3, aspect: WIDTH / HEIGHT, near: 0.1, far: 100, clearColor: [0.1, 0.1, 0.1, 1] };

  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 2, 8], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: Camera, data: cameraData },
  );

  if (demoKind === 'specular') {
    world.spawn({
      component: SkyboxBackground,
      data: { equirect, mode: SKYBOX_MODE_CUBEMAP },
    });
    console.log(`[${demoId}] SkyboxBackground spawned (same equirect handle as Skylight)`);
  }

  // --- 6. Draw frames ---
  // The equirect->cubemap + IBL precompute (cubemap projection -> irradiance
  // convolution -> prefilter mip chain -> BRDF LUT) is fire-and-forget async
  // inside the engine record arm (feat-20260630): the Skylight binds the white
  // fallback cube until that multi-stage projection settles, then upgrades to
  // full IBL. In a real browser the rAF loop yields between frames so the chain
  // completes within a window; this dawn-node loop must do the same. A tight sync
  // for-loop would never let the microtask/timer queue drain, so the projection
  // would never complete and the final frame would stay white -> large baseline
  // delta. Yield each frame, wait for the renderer to report the IBL binding
  // active, then run a final draw batch before readback.
  // This is the harness matching production frame pacing, not an engine workaround.
  const device = sharedDevice;
  if (!device) fail('no shared device captured for readback');

  const frameStart = Date.now();
  let framesObserved = 0;
  for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
    world.update(1 / 60).unwrap();
    const r = renderer.draw(frameRequest);
    if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
    framesObserved++;
    // Drain the device queue + yield every few frames so the fire-and-forget IBL
    // projection's GPU passes (cubemap render -> irradiance/prefilter -> BRDF LUT)
    // complete and the projection promise resolves. dawn-node needs the explicit
    // onSubmittedWorkDone to advance GPU work; a tight sync loop would leave the
    // projection pending and the Skylight stuck on the white fallback cube.
    if (i % 16 === 15) {
      await device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  // Wait for the renderer to report the projected IBL as bound. A fixed wall
  // timer is not enough on software adapters (lavapipe runs the projection on
  // the CPU and needs several seconds), which left the final frame on the white
  // fallback cube; the renderer's iblBinding fact is the readiness authority.
  const iblDeadline = Date.now() + IBL_READY_TIMEOUT_MS;
  while (renderer.inspect().iblBinding?.active !== 'active') {
    if (Date.now() > iblDeadline) {
      fail(`IBL binding stayed on the fallback cube for ${IBL_READY_TIMEOUT_MS}ms (iblBinding=${JSON.stringify(renderer.inspect().iblBinding?.active)})`);
    }
    world.update(1 / 60).unwrap();
    const r = renderer.draw(frameRequest);
    if (!r.ok) console.error(`[smoke] IBL wait draw error: ${r.error.code}`);
    framesObserved++;
    await device.queue.onSubmittedWorkDone();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(`[${demoId}] IBL binding active after ${Date.now() - frameStart}ms`);
  for (let i = 0; i < 32; i++) {
    world.update(1 / 60).unwrap();
    const r = renderer.draw(frameRequest);
    if (!r.ok) console.error(`[smoke] post-settle draw frame ${i} error: ${r.error.code}`);
    framesObserved++;
    if (i % 8 === 7) {
      await device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await device.queue.onSubmittedWorkDone();
  const frameWall = Date.now() - frameStart;
  console.log(
    `[${demoId}] frames observed=${framesObserved} (wall=${frameWall}ms, target=${SMOKE_MIN_FRAMES})`,
  );

  // --- 7. Pixel readback ---
  if (!renderTarget) fail('renderTarget never allocated');
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const readbackBuffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08,
  });
  {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
  }
  try {
    await readbackBuffer.mapAsync(0x01);
  } catch (err) {
    fail(`mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  const mapped = readbackBuffer.getMappedRange();
  const padded = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();

  // Convert padded readback to tightly packed RGBA for PNG storage. Dawn's
  // smoke canvas pins the preferred format to rgba8unorm, but keep this
  // format-aware for hosts that expose a BGRA swapchain.
  const readbackIsBgra = renderTargetFormat.startsWith('bgra');
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const srcOff = y * bytesPerRow + x * bytesPerPixel;
      const dstOff = (y * WIDTH + x) * 4;
      rgba[dstOff + 0] = padded[srcOff + (readbackIsBgra ? 2 : 0)] ?? 0;
      rgba[dstOff + 1] = padded[srcOff + 1] ?? 0;
      rgba[dstOff + 2] = padded[srcOff + (readbackIsBgra ? 0 : 2)] ?? 0;
      rgba[dstOff + 3] = padded[srcOff + 3] ?? 255;
    }
  }

  // --- 8. Verdict / bake ---
  const failures = [];
  if (rgba.some((value, index) => index % 4 === 3 && value !== 255)) {
    failures.push('(a) opaque sphere fixture must preserve alpha=1 throughout the final frame');
  }
  if (renderer.inspect().capabilities.backendKind !== 'webgpu')
    failures.push(`(a) backend=${renderer.inspect().capabilities.backendKind} (expected webgpu)`);
  if (framesObserved < SMOKE_MIN_FRAMES)
    failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
  if (errors.length > 0) {
    const codes = errors.map((e) => e.code).join(', ');
    failures.push(`(c) Renderer.onError fired ${errors.length} times: [${codes}]`);
  }

  if (mode === 'bake') {
    await mkdir(dirname(referencePath), { recursive: true });
    const pngBytes = encodePngRgba(rgba, WIDTH, HEIGHT);
    await writeFile(referencePath, pngBytes);
    console.log(`[${demoId}] BAKE -- wrote reference PNG (${pngBytes.length} bytes) to ${referencePath}`);
  } else {
    let refBytes;
    try {
      refBytes = await readFile(referencePath);
    } catch (err) {
      failures.push(
        `(d) reference PNG unreadable at ${referencePath}: ${err instanceof Error ? err.message : String(err)}; ` +
          `run pnpm bake:ibl-reference to regenerate.`,
      );
    }
    if (refBytes !== undefined) {
      const refRgba = decodePngRgba(refBytes);
      if (refRgba === null) {
        failures.push(`(d) reference PNG decode failed`);
      } else if (refRgba.length !== rgba.length) {
        failures.push(
          `(d) reference PNG size mismatch: got ${refRgba.length} expected ${rgba.length}`,
        );
      } else {
        let sumAbs = 0;
        for (let i = 0; i < rgba.length; i++) {
          sumAbs += Math.abs((rgba[i] ?? 0) - (refRgba[i] ?? 0));
        }
        const meanAbsDelta = sumAbs / rgba.length / 255;
        console.log(
          `[${demoId}] meanAbsDelta=${meanAbsDelta.toFixed(5)} (threshold=${SMOKE_DELTA_THRESHOLD})`,
        );
        if (meanAbsDelta > SMOKE_DELTA_THRESHOLD) {
          failures.push(
            `(d) meanAbsDelta=${meanAbsDelta.toFixed(5)} > threshold=${SMOKE_DELTA_THRESHOLD}`,
          );
        }
      }
    }
  }

  const wallTotalMs = Date.now() - frameStart;
  if (failures.length > 0) {
    console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
    for (const f of failures) console.error(`  ${f}`);
    device.destroy?.();
    process.exit(1);
  }

  console.log(
    `[${demoId}] PASS -- mode=${mode} backend=webgpu frames=${framesObserved} errors=0 wallTotalMs=${wallTotalMs}`,
  );
  device.destroy?.();
  delete globalThis.navigator.gpu;
  return framesObserved;
}

function fail(msg) {
  console.error(`[smoke] FAIL - ${msg}`);
  process.exit(1);
}

// --- PNG codec wrappers (UPNG.js -- already a runtime dep of @forgeax/engine-image) ---

async function loadUPNG() {
  const mod = await import('upng-js');
  // upng-js ships CommonJS; under ESM both `mod.default` (with encode/decode)
  // and named-export shape can appear depending on Node version + bundler.
  // Prefer the shape that actually carries `encode` as a function.
  if (typeof mod?.encode === 'function') return mod;
  if (typeof mod?.default?.encode === 'function') return mod.default;
  throw new Error('upng-js encode shape unrecognised');
}

function encodePngRgba(rgba, width, height) {
  // UPNG.encode is sync once the module is loaded; this function is itself
  // sync after the caller awaits the dynamic import. Lossless encode (cnum=0).
  // Using `require`-style sync interface is impossible in pure ESM; the
  // caller awaits loadUPNG separately. We bundle the call here as a sync
  // helper assuming UPNG is already cached.
  const UPNG = globalThis.__upngCache;
  if (!UPNG) throw new Error('encodePngRgba called before UPNG warmup');
  const buf = UPNG.encode([rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)], width, height, 0);
  return new Uint8Array(buf);
}

function decodePngRgba(pngBytes) {
  const UPNG = globalThis.__upngCache;
  if (!UPNG) return null;
  try {
    const img = UPNG.decode(pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength));
    const rgba8 = UPNG.toRGBA8(img);
    if (!Array.isArray(rgba8) || rgba8.length === 0) return null;
    return new Uint8Array(rgba8[0]);
  } catch {
    return null;
  }
}

// Warm UPNG cache once before runIblSmoke is invoked.
export async function warmUpng() {
  globalThis.__upngCache = await loadUPNG();
}
