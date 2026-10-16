#!/usr/bin/env node

// scripts/byte-equiv/record-pre-feat.mjs — M2-T1 pre-feat PSO descriptor baseline.
//
// Records frame-30 createRenderPipeline descriptor snapshots for 5 high-risk
// demos (hello-cube / hello-shadow-csm / hello-tonemap / hello-fxaa / hello-skin)
// before the PipelineSpec SSOT refactoring lands.
//
// Output: artifacts/byte-equiv-baselines/<demo>/frame-30.json
//   Each baseline file contains: { demoName, frame, pipelines: CreatePipelineDescriptor[] }
//   where CreatePipelineDescriptor includes the subset of GPURenderPipelineDescriptor
//   fields that cacheKeyOf / buildPipelineDescriptor encode:
//     vertex.entryPoint, vertex.buffers (shape only)
//     fragment.entryPoint, fragment.targets (format + blend)
//     primitive.topology, primitive.cullMode, primitive.frontFace
//     depthStencil.format, depthStencil.depthWriteEnabled, depthStencil.depthCompare
//     multisample (count or undefined)
//
// Strategy: monkey-patch device.createRenderPipeline on the dawn-node GPUDevice
// to snapshot descriptors. Runs deterministic 30 frames then exits.
//
// Usage: node scripts/byte-equiv/record-pre-feat.mjs [--demo <name>]
//   Without --demo: runs all 5 demos sequentially.
//   With --demo: runs a single demo (for faster iteration).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENGINE_ROOT = resolve(__dirname, '..', '..');

// --- CLI args ----------------------------------------------------------------

const args = process.argv.slice(2);
const demoArgIdx = args.indexOf('--demo');
const targetDemo = demoArgIdx !== -1 ? args[demoArgIdx + 1] : undefined;

// --- Baseline output dir -----------------------------------------------------

const BASELINE_DIR = resolve(ENGINE_ROOT, 'artifacts', 'byte-equiv-baselines');
mkdirSync(BASELINE_DIR, { recursive: true });

// --- Demo registry -----------------------------------------------------------

const DEMOS = /** @type {const} */ ([
  {
    name: 'hello-cube',
    packageName: '@forgeax/hello-cube',
    manifestPath: 'apps/hello/cube/dist/shaders/manifest.json',
    worldSetup: (world, modules) => {
      const { Transform, MeshFilter, MeshRenderer, HANDLE_CUBE, Camera, DirectionalLight } =
        modules;
      world.spawn(
        { component: Transform, data: posIdent() },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      );
      world.spawn(
        { component: Transform, data: { ...posIdent(), posZ: 3 } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
      );
      world.spawn({
        component: DirectionalLight,
        data: {
          directionX: -0.5,
          directionY: -1,
          directionZ: -0.3,
          colorR: 1,
          colorG: 1,
          colorB: 1,
          intensity: 1,
        },
      });
    },
  },
  {
    name: 'hello-shadow-csm',
    packageName: '@forgeax/hello-shadows',
    manifestPath: 'apps/hello/shadow-csm/dist/shaders/manifest.json',
    worldSetup: (world, modules) => {
      const { Transform, MeshFilter, MeshRenderer, HANDLE_SPHERE, DirectionalLight } = modules;
      // Simple scene: sphere on a plane-like setup with directional light for shadow
      world.spawn(
        { component: Transform, data: posIdent() },
        { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
        { component: MeshRenderer, data: {} },
      );
      // Camera looking at the sphere
      const { Camera } = modules;
      world.spawn(
        { component: Transform, data: { ...posIdent(), posZ: 5 } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
      );
      world.spawn({
        component: DirectionalLight,
        data: {
          directionX: -0.5,
          directionY: -1,
          directionZ: -0.3,
          colorR: 1,
          colorG: 1,
          colorB: 1,
          intensity: 1,
        },
      });
    },
  },
  {
    name: 'hello-tonemap',
    packageName: '@forgeax/hello-tonemap',
    manifestPath: 'apps/hello/tonemap/dist/shaders/manifest.json',
    worldSetup: (world, modules) => {
      const { Transform, MeshFilter, MeshRenderer, HANDLE_CUBE, Camera } = modules;
      world.spawn(
        { component: Transform, data: posIdent() },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      );
      world.spawn(
        { component: Transform, data: { ...posIdent(), posZ: 3 } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
      );
    },
  },
  {
    name: 'hello-fxaa',
    packageName: '@forgeax/hello-fxaa',
    manifestPath: 'apps/hello/fxaa/dist/shaders/manifest.json',
    worldSetup: (world, modules) => {
      const { Transform, MeshFilter, MeshRenderer, HANDLE_CUBE, Camera } = modules;
      world.spawn(
        { component: Transform, data: posIdent() },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      );
      world.spawn(
        { component: Transform, data: { ...posIdent(), posZ: 3 } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
      );
    },
  },
  {
    name: 'hello-skin',
    packageName: '@forgeax/hello-skin',
    manifestPath: 'apps/hello/skin/dist/shaders/manifest.json',
    worldSetup: (world, modules) => {
      const { Transform, Camera } = modules;
      world.spawn(
        { component: Transform, data: { ...posIdent(), posY: -35, posZ: 110 } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 500 } },
      );
      // Note: hello-skin uses GLTF assets loaded via asset registry.
      // The full scene setup requires asset loading which is demo-specific.
      // We use a minimal setup; the baseline just needs deterministic PSOs.
    },
  },
]);

function posIdent() {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  };
}

// --- Helper: strip complex objects from PSO descriptor for stable comparison --

function stablePSODescriptor(rawDesc) {
  // Extract fields that cacheKeyOf / buildPipelineDescriptor encode.
  // Strip non-deterministic fields (labels, GPU object references).
  const v = rawDesc.vertex;
  const f = rawDesc.fragment;
  const p = rawDesc.primitive;
  const ds = rawDesc.depthStencil;
  const ms = rawDesc.multisample;

  return {
    // We don't hash shader module identity — we record the entry point names
    vertexEntryPoint: v?.entryPoint ?? 'vs_main',
    fragmentEntryPoint: f?.entryPoint ?? 'fs_main',
    vertexBuffersShape: (v?.buffers ?? []).map((b) => ({
      arrayStride: b.arrayStride,
      stepMode: b.stepMode,
      attributeCount: b.attributes?.length ?? 0,
    })),
    fragmentTargets: (f?.targets ?? []).map((t) => ({
      format: t.format,
      hasBlend: t.blend !== undefined,
    })),
    primitiveTopology: p?.topology ?? 'triangle-list',
    cullMode: p?.cullMode ?? 'back',
    frontFace: p?.frontFace ?? 'ccw',
    stripIndexFormat: p?.stripIndexFormat,
    depthFormat: ds?.format,
    depthWriteEnabled: ds?.depthWriteEnabled ?? false,
    depthCompare: ds?.depthCompare,
    stencilReadMask: ds?.stencilReadMask,
    stencilWriteMask: ds?.stencilWriteMask,
    hasStencil: ds?.stencilFront !== undefined,
    multisampleCount: ms?.count,
    // Hash of the vertex buffer layouts for stable comparison
    layoutHash: hashDescriptor(rawDesc),
  };
}

function hashDescriptor(desc) {
  const h = createHash('sha256');
  // Hash the structural shape, not raw GPU objects
  const structural = {
    ve: desc.vertex?.entryPoint,
    vb: (desc.vertex?.buffers ?? []).map((b) => ({
      s: b.arrayStride,
      m: b.stepMode,
      ac: b.attributes?.length ?? 0,
      af: b.attributes?.map((a) => ({ f: a.format, o: a.offset, sl: a.shaderLocation })),
    })),
    fe: desc.fragment?.entryPoint,
    ft: (desc.fragment?.targets ?? []).map((t) => ({ f: t.format, b: t.blend !== undefined })),
    pt: desc.primitive?.topology,
    pc: desc.primitive?.cullMode,
    pf: desc.primitive?.frontFace,
    ps: desc.primitive?.stripIndexFormat,
    df: desc.depthStencil?.format,
    dw: desc.depthStencil?.depthWriteEnabled,
    dc: desc.depthStencil?.depthCompare,
    sr: desc.depthStencil?.stencilReadMask,
    sw: desc.depthStencil?.stencilWriteMask,
    sf: desc.depthStencil?.stencilFront?.compare,
    mc: desc.multisample?.count,
  };
  h.update(JSON.stringify(structural, null, 0));
  return h.digest('hex').slice(0, 16);
}

// --- Smoke harness (per demo) ------------------------------------------------

const WIDTH = 200;
const HEIGHT = 150;
const TARGET_FRAME = 30;

async function recordDemo(demo) {
  console.log(`[byte-equiv] Recording ${demo.name} ...`);

  // 1. dawn-node GPU setup
  let create, globals;
  try {
    ({ create, globals } = await import('@forgeax/engine-dawn-node'));
  } catch (err) {
    console.error(`  SKIP - dawn.node import failed: ${err.message}`);
    return null;
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
    console.error(`  SKIP - dawn-node create failed: ${err.message}`);
    return null;
  }
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  // 2. Capture shared device + monkey-patch createRenderPipeline
  /** @type {GPUDevice | undefined} */
  let sharedDevice;
  /** @type {Array<{ frame: number, callIndex: number, desc: Record<string, unknown> }>} */
  const pipelineRecords = [];
  let callIndex = 0;
  let currentFrame = 0;

  // Track frame boundaries: increment currentFrame when the recorder sees
  // a frame boundary. For dawn-node, the engine drives frames synchronously
  // via renderer.draw(world), so we count frames by tracking draw cycles.
  // We increment currentFrame after each renderer.draw() call.

  const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const rawAdapter = await originalAmbientRequestAdapter(opts);
    if (rawAdapter === null) return rawAdapter;
    const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
    rawAdapter.requestDevice = async (desc) => {
      const dev = await originalRequestDevice(desc);
      if (!sharedDevice) {
        sharedDevice = dev;
        // Monkey-patch createRenderPipeline to capture descriptors
        const originalCreateRenderPipeline = dev.createRenderPipeline.bind(dev);
        dev.createRenderPipeline = (pipelineDesc) => {
          const record = {
            frame: currentFrame,
            callIndex: callIndex++,
            desc: stablePSODescriptor(pipelineDesc),
          };
          pipelineRecords.push(record);
          return originalCreateRenderPipeline(pipelineDesc);
        };
      }
      return dev;
    };
    return rawAdapter;
  };

  // 3. Mock canvas
  let renderTarget;
  function ensureRenderTarget(device, format) {
    if (renderTarget) return renderTarget;
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

  // 4. Import engine modules
  const { World } = await import('@forgeax/engine-ecs');
  const enginePkg = await import('@forgeax/engine-runtime');
  const { createRenderer } = enginePkg;

  // Load shader manifest
  const manifestPath = resolve(ENGINE_ROOT, demo.manifestPath);
  let MANIFEST_URL;
  try {
    MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
  } catch (err) {
    console.error(`  SKIP - manifest not found at ${manifestPath}: ${err.message}`);
    return null;
  }

  const world = new World();
  demo.worldSetup(world, enginePkg);

  let renderer;
  try {
    renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  } catch (err) {
    globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
    console.error(`  SKIP - createRenderer failed: ${err.message}`);
    return null;
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
  }

  const attached = renderer.attach(world);
  if (!attached.ok) {
    console.error(`  SKIP - renderer attach failed: ${attached.error.code}`);
    return null;
  }
  const lease = attached.value;
  const drawFrame = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
  console.log(`  backend=${renderer.inspect().capabilities.backendKind}`);

  // 5. Run frames 0..29 (warm-up), capture at frame 29 (0-indexed = frame 30 1-indexed)
  // We track the frame number from draw() calls.
  for (let frame = 0; frame < TARGET_FRAME; frame++) {
    currentFrame = frame;
    world.update().unwrap();
    const drawn = drawFrame();
    if (!drawn.ok) return null;
    await delay(0); // yield event loop
  }

  // 6. Extract frame-30 (0-indexed frame 29) PSO records
  const frame30Records = pipelineRecords.filter((r) => r.frame === TARGET_FRAME - 1);

  // 7. Write baseline
  const demoDir = resolve(BASELINE_DIR, demo.name);
  mkdirSync(demoDir, { recursive: true });

  const baseline = {
    demo: demo.name,
    frame: TARGET_FRAME,
    pipelineCount: frame30Records.length,
    pipelines: frame30Records.map((r) => ({
      callIndex: r.callIndex,
      ...r.desc,
    })),
    recordTimestamp: new Date().toISOString(),
  };

  const outputPath = resolve(demoDir, 'frame-30.json');
  writeFileSync(outputPath, JSON.stringify(baseline, null, 2), 'utf8');
  console.log(`  wrote ${frame30Records.length} PSO descriptors to ${outputPath}`);

  return baseline;
}

// --- Main --------------------------------------------------------------------

const demosToRun = targetDemo ? DEMOS.filter((d) => d.name === targetDemo) : DEMOS;

if (demosToRun.length === 0) {
  console.error(`Unknown demo: ${targetDemo}`);
  console.error(`Known demos: ${DEMOS.map((d) => d.name).join(', ')}`);
  process.exit(1);
}

let exitCode = 0;
for (const demo of demosToRun) {
  try {
    const result = await recordDemo(demo);
    if (result === null) {
      console.error(`[byte-equiv] FAIL - ${demo.name} could not be recorded`);
      exitCode = 1;
    } else {
      console.log(
        `[byte-equiv] OK - ${demo.name} (${result.pipelineCount} pipelines at frame ${TARGET_FRAME})`,
      );
    }
  } catch (err) {
    console.error(`[byte-equiv] FAIL - ${demo.name} threw: ${err.message}`);
    exitCode = 1;
  }
}

process.exit(exitCode);
