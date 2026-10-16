#!/usr/bin/env node

// scripts/byte-equiv/compare-post-feat.mjs — M2-T4-TEST post-feat PSO byte-equiv.
//
// Records frame-30 createRenderPipeline descriptor snapshots for 5 high-risk
// demos (hello-cube / hello-shadow-csm / hello-tonemap / hello-fxaa / hello-skin)
// and deep-compares them against the M2-T1 pre-feat baseline.
//
// Usage: node scripts/byte-equiv/compare-post-feat.mjs [--demo <name>]
//   Without --demo: compares all 5 demos.
//   With --demo: compares a single demo (for faster iteration).
//
// Exit 0 when ALL demos produce 0-field diffs against the baseline.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

// --- Baseline dir ------------------------------------------------------------

const BASELINE_DIR = resolve(ENGINE_ROOT, 'artifacts', 'byte-equiv-baselines');

// --- Demo registry (mirrors record-pre-feat.mjs) ----------------------------

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
      const { Transform, MeshFilter, MeshRenderer, HANDLE_SPHERE, DirectionalLight, Camera } =
        modules;
      world.spawn(
        { component: Transform, data: posIdent() },
        { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
        { component: MeshRenderer, data: {} },
      );
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
  const v = rawDesc.vertex;
  const f = rawDesc.fragment;
  const p = rawDesc.primitive;
  const ds = rawDesc.depthStencil;
  const ms = rawDesc.multisample;

  return {
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
    layoutHash: hashDescriptor(rawDesc),
  };
}

function hashDescriptor(desc) {
  const h = createHash('sha256');
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

// --- Diff engine: deep-equal on two stable PSO descriptor arrays ------------

/**
 * Deep-compare two arrays of PSO descriptors.
 * Returns an array of diff entries, or empty [] when identical.
 */
function diffDescriptors(baseline, actual, label) {
  const diffs = [];

  if (baseline.length !== actual.length) {
    diffs.push({
      field: `<pipelineCount>`,
      baseline: baseline.length,
      actual: actual.length,
    });
    // Still compare what we can by index.
  }

  const minLen = Math.min(baseline.length, actual.length);
  for (let i = 0; i < minLen; i++) {
    const b = baseline[i];
    const a = actual[i];
    const keys = new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})]);
    for (const key of keys) {
      const bv = JSON.stringify(b?.[key]);
      const av = JSON.stringify(a?.[key]);
      if (bv !== av) {
        diffs.push({
          field: `${label}[${i}].${key}`,
          baseline: bv,
          actual: av,
        });
      }
    }
  }

  return diffs;
}

// --- Smoke harness (per demo) ------------------------------------------------

const WIDTH = 200;
const HEIGHT = 150;
const TARGET_FRAME = 30;

async function compareDemo(demo) {
  console.log(`[byte-equiv] Comparing ${demo.name} ...`);

  // 1. Load baseline
  const baselinePath = resolve(BASELINE_DIR, demo.name, 'frame-30.json');
  if (!existsSync(baselinePath)) {
    console.error(`  SKIP - baseline not found at ${baselinePath}`);
    return { diffs: [`baseline file missing: ${baselinePath}`], pipelineCount: 0 };
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (err) {
    console.error(`  SKIP - could not parse baseline: ${err.message}`);
    return { diffs: [`baseline parse error: ${err.message}`], pipelineCount: 0 };
  }

  // 2. dawn-node GPU setup
  let create, globals;
  try {
    ({ create, globals } = await import('@forgeax/engine-dawn-node'));
  } catch (err) {
    console.error(`  SKIP - dawn.node import failed: ${err.message}`);
    return { diffs: [`dawn.node import failed: ${err.message}`], pipelineCount: 0 };
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
    return { diffs: [`dawn-node create failed: ${err.message}`], pipelineCount: 0 };
  }
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  // 3. Capture shared device + monkey-patch createRenderPipeline
  let sharedDevice;
  const pipelineRecords = [];
  let callIndex = 0;
  let currentFrame = 0;

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

  // 4. Mock canvas
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

  // 5. Import engine modules
  const { World } = await import('@forgeax/engine-ecs');
  const enginePkg = await import('@forgeax/engine-runtime');
  const { createRenderer } = enginePkg;

  const manifestPath = resolve(ENGINE_ROOT, demo.manifestPath);
  let MANIFEST_URL;
  try {
    MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
  } catch (err) {
    globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
    console.error(`  SKIP - manifest not found at ${manifestPath}: ${err.message}`);
    return { diffs: [`manifest not found: ${err.message}`], pipelineCount: 0 };
  }

  const world = new World();
  demo.worldSetup(world, enginePkg);

  let renderer;
  try {
    renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  } catch (err) {
    globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
    console.error(`  SKIP - createRenderer failed: ${err.message}`);
    return { diffs: [`createRenderer failed: ${err.message}`], pipelineCount: 0 };
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
  }

  const attached = renderer.attach(world);
  if (!attached.ok) {
    console.error(`  SKIP - renderer attach failed: ${attached.error.code}`);
    return { diffs: [`renderer attach failed: ${attached.error.code}`], pipelineCount: 0 };
  }
  const lease = attached.value;
  const drawFrame = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
  console.log(`  backend=${renderer.inspect().capabilities.backendKind}`);

  // 6. Run frames 0..29
  for (let frame = 0; frame < TARGET_FRAME; frame++) {
    currentFrame = frame;
    world.update().unwrap();
    const drawn = drawFrame();
    if (!drawn.ok) return { diffs: [`draw failed: ${drawn.error.code}`], pipelineCount: 0 };
    await delay(0);
  }

  // 7. Extract frame-30 PSO records
  const frame30Records = pipelineRecords.filter((r) => r.frame === TARGET_FRAME - 1);
  const actualDescriptors = frame30Records.map((r) => ({ callIndex: r.callIndex, ...r.desc }));

  // 8. Diff against baseline
  const baselineDescriptors = baseline.pipelines ?? [];
  const diffs = diffDescriptors(baselineDescriptors, actualDescriptors, demo.name);

  if (diffs.length === 0) {
    console.log(
      `  OK - 0 diffs (${actualDescriptors.length} pipelines, ${baseline.pipelineCount} baseline)`,
    );
  } else {
    console.error(`  FAIL - ${diffs.length} field diffs:`);
    for (const d of diffs.slice(0, 20)) {
      console.error(`    ${d.field}: baseline=${d.baseline} actual=${d.actual}`);
    }
    if (diffs.length > 20) {
      console.error(`    ... and ${diffs.length - 20} more diffs`);
    }
  }

  return { diffs, pipelineCount: actualDescriptors.length };
}

// --- Main --------------------------------------------------------------------

const demosToRun = targetDemo ? DEMOS.filter((d) => d.name === targetDemo) : DEMOS;

if (demosToRun.length === 0) {
  console.error(`Unknown demo: ${targetDemo}`);
  console.error(`Known demos: ${DEMOS.map((d) => d.name).join(', ')}`);
  process.exit(1);
}

let totalDiffs = 0;
let exitCode = 0;
for (const demo of demosToRun) {
  try {
    const result = await compareDemo(demo);
    totalDiffs += result.diffs.length;
    if (result.diffs.length > 0) {
      exitCode = 1;
    }
  } catch (err) {
    console.error(`[byte-equiv] FAIL - ${demo.name} threw: ${err.message}\n${err.stack}`);
    exitCode = 1;
  }
}

if (exitCode === 0) {
  console.log(
    `\n[byte-equiv] PASS - all ${demosToRun.length} demos have 0-field PSO descriptor diffs.`,
  );
} else {
  console.error(
    `\n[byte-equiv] FAIL - ${totalDiffs} total field diffs across ${demosToRun.length} demos.`,
  );
}

process.exit(exitCode);
