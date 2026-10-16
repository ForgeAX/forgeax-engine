#!/usr/bin/env node
// scripts/bench/bench-nineslice-100panel.mjs -- feat-20260527-sprite-nineslice
// M5 / w20 (AC-09 + AC-10). 100 panel @ 10x10 stretch grid bench fixture
// monitoring two sub-keys on the same run:
//
//   - fps: target 60 fps +/- 3% on Mac M1 Chrome Beta 1080p (research F-5
//     baseline).
//   - ubo-bytes-per-entity: AC-10 ceiling 16 B/entity increment over the
//     pre-feat sprite UBO. Sprite UBO grew 48 B -> 64 B (one vec4 column
//     for slicesAndMode, plan-strategy D-3); 16 / entity is the mechanical
//     ceiling.
//
// D-8 (plan-strategy): pure stretch grid (no tile mix). One MaterialAsset
// handle shared by all 100 entities; only Transform.posX/posY differ
// (variable single = layout density). Tiling perf is the same vertex
// shader path -- D-4 uses sampler.addressMode='repeat' (zero-ALU vs the
// alternative wgsl fract()), so a separate tile bench would not surface
// new throughput info.
//
// Seed (for any RNG use that may be added later): 'forgeax-nineslice-2026'.
// iteration count (frames): 60. Canvas: 1920x1080 (1080p).
//
// Output (charter P3 explicit failure as machine-readable signal):
//   report/bench-nineslice-100panel.json
//   {
//     "fixture": "nineslice-100panel",
//     "seed": "forgeax-nineslice-2026",
//     "frames": <int>,
//     "panels": 100,
//     "fps": <float>,
//     "uboBytesPerEntity": <int>,
//     "verdict": "pass" | "fail",
//     "code"?: <MetricErrorCode>,
//     "expected"?: <string>,
//     "hint"?: <string>,
//     "detail"?: <object>
//   }
//
// CLI exit codes (mirror scripts/bench/pixel-parity.mjs):
//   - 0  -- both sub-keys within their thresholds.
//   - 65 -- one or both sub-keys exceeded threshold (analog of pixel-parity
//           -threshold-exceeded; reuses MetricErrorCode 'pixel-parity-
//           threshold-exceeded' to keep the closed union closed; the
//           detail.fixture field disambiguates).
//   - 74 -- capture / device init failed (pixel-parity-capture-failed).
//
// Sandbox / CI gating (plan-strategy 5.1 + 5.5):
//   - Sandbox path: dawn-node `webgpu` package; if dawn import / device
//     init fails the script exits 74 with a structured payload (charter
//     P3) instead of a raw stack trace.
//   - CI path (Mac M1 chrome-beta primary-pnpm): same script invoked via
//     `pnpm bench:nineslice` (root scripts entry; w20 wires) reads the
//     identical fixture; the chrome-beta vs dawn-node delta is just the
//     navigator.gpu source, the rendering path and JSON schema are the
//     same.
//
// Per requirements F-5 + plan §D-8 the threshold tuple is:
//   - fps         >= 60 * (1 - 0.03) = 58.2 (steady-state floor).
//   - uboPerEntity <= 16 (B/entity hard ceiling).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const REPORT_DIR = resolve(REPO_ROOT, 'report');
const REPORT_PATH = resolve(REPORT_DIR, 'bench-nineslice-100panel.json');

const SEED = 'forgeax-nineslice-2026';
const PANELS = 100;
const GRID_SIDE = 10;
const FRAMES = 60;
const CANVAS_W = 1920;
const CANVAS_H = 1080;

const FPS_FLOOR = 60 * (1 - 0.03); // AC-09
const UBO_BYTES_PER_ENTITY_CAP = 16; // AC-10

// MetricErrorCode-aligned helper. Reuses the existing closed union members
// (no new Code) so AGENTS.md error-model evolution contract stays
// minor-add-only.
function errPayload(code, detail) {
  return {
    fixture: 'nineslice-100panel',
    seed: SEED,
    panels: PANELS,
    frames: 0,
    fps: 0,
    uboBytesPerEntity: 0,
    verdict: 'fail',
    code,
    expected: expectedFor(code),
    hint: hintFor(code),
    detail: detail ?? null,
  };
}

function expectedFor(code) {
  switch (code) {
    case 'pixel-parity-threshold-exceeded':
      return `fps >= ${FPS_FLOOR.toFixed(1)} AND uboBytesPerEntity <= ${UBO_BYTES_PER_ENTITY_CAP}`;
    case 'pixel-parity-capture-failed':
      return 'both sub-keys (fps + uboBytesPerEntity) measured from a 60-frame draw loop on a webgpu device';
    case 'metric-status-not-ok':
      return 'metric runner reports status=ok for the bench-nineslice-100panel fixture';
  }
  throw new Error(`bench-nineslice-100panel: unhandled MetricErrorCode '${code}'`);
}

function hintFor(code) {
  switch (code) {
    case 'pixel-parity-threshold-exceeded':
      return 'inspect git diff for sprite shader / runtime record-stage regressions; if driver noise, bump packages/runtime/package.json#forgeax.metrics.bench thresholds in a PR commit (append-only audit)';
    case 'pixel-parity-capture-failed':
      return 'inspect detail.stage to localize the capture pipeline step; ensure dawn-node `webgpu` package is installed (sandbox) or chrome-beta is available (CI primary-pnpm)';
    case 'metric-status-not-ok':
      return 'rerun pnpm bench:nineslice locally; if persistent, inspect report/bench-nineslice-100panel.json for the failing sub-key';
  }
  throw new Error(`bench-nineslice-100panel: unhandled MetricErrorCode '${code}'`);
}

function passPayload(framesObserved, fps, uboBytesPerEntity) {
  return {
    fixture: 'nineslice-100panel',
    seed: SEED,
    panels: PANELS,
    frames: framesObserved,
    fps,
    uboBytesPerEntity,
    verdict: 'pass',
  };
}

function writeReport(payload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.warn(`[bench-nineslice-100panel] report -> ${REPORT_PATH}`);
}

async function loadDawn() {
  try {
    const mod = await import('@forgeax/engine-dawn-node');
    return mod;
  } catch (err) {
    return {
      __failed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function dispatchExit(payload) {
  if (payload.verdict === 'pass') {
    console.warn(
      `[bench-nineslice-100panel] PASS frames=${payload.frames} fps=${payload.fps.toFixed(2)} uboBytesPerEntity=${payload.uboBytesPerEntity}`,
    );
    return 0;
  }
  console.error(`[ERROR ${payload.code}]`);
  console.error(`expected: ${payload.expected}`);
  console.error(`hint:     ${payload.hint}`);
  if (payload.detail !== null) console.error(`detail:   ${JSON.stringify(payload.detail)}`);
  switch (payload.code) {
    case 'pixel-parity-threshold-exceeded':
      return 65;
    case 'pixel-parity-capture-failed':
      return 74;
    case 'metric-status-not-ok':
      return 70;
  }
  // Unreachable (closed-union exhaustive switch).
  throw new Error(`bench-nineslice-100panel: unhandled code '${payload.code}'`);
}

async function main() {
  // 1. dawn-node bootstrap. If unavailable in this environment, exit 74
  //    with structured detail; CI primary-pnpm has the binding.
  const dawn = await loadDawn();
  if (dawn.__failed) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'dawn-import',
      cause: dawn.error,
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }
  Object.assign(globalThis, dawn.globals);
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  let gpu;
  try {
    gpu = dawn.create([]);
  } catch (err) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'dawn-create',
      cause: err instanceof Error ? err.message : String(err),
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });

  // 2. Mock canvas mirroring apps/hello/sprite/scripts/smoke-dawn.mjs --
  //    1080p, single shared render-target rebuilt on configure().
  let activeRenderTarget = null;
  let sharedDevice = null;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (opts) => {
    const adapter = await originalRequestAdapter(opts);
    if (adapter === null) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (desc) => {
      const dev = await originalRequestDevice(desc);
      if (!sharedDevice) sharedDevice = dev;
      return dev;
    };
    return adapter;
  };

  const mockCanvas = {
    width: CANVAS_W,
    height: CANVAS_H,
    getContext(kind) {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc) {
          if (activeRenderTarget) activeRenderTarget.destroy?.();
          activeRenderTarget = desc.device.createTexture({
            size: { width: CANVAS_W, height: CANVAS_H, depthOrArrayLayers: 1 },
            format: desc.format ?? 'bgra8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['bgra8unorm-srgb'],
          });
        },
        unconfigure() {
          activeRenderTarget?.destroy?.();
          activeRenderTarget = null;
        },
        getCurrentTexture() {
          if (!activeRenderTarget) {
            if (!sharedDevice) throw new Error('no shared device captured');
            activeRenderTarget = sharedDevice.createTexture({
              size: { width: CANVAS_W, height: CANVAS_H, depthOrArrayLayers: 1 },
              format: 'bgra8unorm',
              usage: 0x10 | 0x01,
              viewFormats: ['bgra8unorm-srgb'],
            });
          }
          return activeRenderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  // 3. Drive engine ECS + 100 panel grid path.
  let engineMod;
  let renderMod;
  let ecsMod;
  let manifestMod;
  try {
    ecsMod = await import('@forgeax/engine-ecs');
    engineMod = await import('@forgeax/engine-runtime');
    renderMod = await import('@forgeax/engine-render/internal/construct-renderer');
    manifestMod = await import('@forgeax/engine-vite-plugin-shader');
  } catch (err) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'engine-import',
      cause: err instanceof Error ? err.message : String(err),
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }
  const { World } = ecsMod;
  const { Camera, HANDLE_NINESLICE_QUAD, Layer, MeshFilter, MeshRenderer, Transform } = engineMod;
  let ENGINE_MANIFEST;
  try {
    ENGINE_MANIFEST = await manifestMod.buildEngineShaderManifest();
  } catch (err) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'shader-manifest-build',
      cause: err instanceof Error ? err.message : String(err),
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }
  const ENGINE_MANIFEST_URL = URL.createObjectURL(
    new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }),
  );
  process.once('exit', () => URL.revokeObjectURL(ENGINE_MANIFEST_URL));

  let renderer;
  let assets;
  try {
    const host = await renderMod.constructRendererHost(
      mockCanvas,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    assets = host.value.assets;
  } catch (err) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'createRenderer',
      cause: err instanceof Error ? err.message : String(err),
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
  }

  // Synthetic 8x8 RGBA texture (mirrors smoke-dawn.mjs to avoid PNG load).
  const synthBytes = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < synthBytes.length; i += 4) {
    synthBytes[i] = 200;
    synthBytes[i + 1] = 200;
    synthBytes[i + 2] = 200;
    synthBytes[i + 3] = 255;
  }
  const synthPod = {
    kind: 'texture',
    width: 8,
    height: 8,
    format: 'rgba8unorm-srgb',
    data: synthBytes,
    colorSpace: 'srgb',
    mipmap: false,
  };
  const texHandleRes = assets.register(synthPod);
  if (!texHandleRes.ok) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'texture-register',
      cause: texHandleRes.error.code,
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }
  const samplerHandleRes = assets.register({
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  if (!samplerHandleRes.ok) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'sampler-register',
      cause: samplerHandleRes.error.code,
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }

  // Single shared MaterialAsset across 100 panels (D-8: nominal stretch
  // panel; sliceMode=0).
  const matRes = assets.register({
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::sprite' },
        tags: { LightMode: 'Forward' },
        queue: 3000,
      },
    ],
    values: {
      baseColor: [1, 1, 1, 1],
      texture: texHandleRes.value,
      sampler: samplerHandleRes.value,
      region: [0, 0, 1, 1],
      pivot: [0.5, 0.5],
      slices: [0.25, 0.25, 0.25, 0.25],
      sliceMode: 0,
    },
  });
  if (!matRes.ok) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'material-register',
      cause: matRes.error.code,
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }

  // Build the 10x10 grid + ortho camera in a single World.
  const world = new World();
  const cellSpan = 1.6 / GRID_SIDE; // canvas-relative cell width.
  const cellScale = cellSpan * 0.42; // panel scale leaves a small gap.
  for (let row = 0; row < GRID_SIDE; row++) {
    for (let col = 0; col < GRID_SIDE; col++) {
      const x = -0.8 + col * cellSpan + cellSpan * 0.5;
      const y = -0.8 + row * cellSpan + cellSpan * 0.5;
      world
        .spawn(
          {
            component: Transform,
            data: { posX: x, posY: y, posZ: 0, scaleX: cellScale, scaleY: cellScale, scaleZ: 1 },
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_NINESLICE_QUAD } },
          { component: MeshRenderer, data: { material: matRes.value } },
          { component: Layer, data: { value: 0 } },
        )
        .unwrap();
    }
  }
  world
    .spawn(
      {
        component: Transform,
        data: { posX: 0, posY: 0, posZ: 5 },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: CANVAS_W / CANVAS_H,
          near: 0.1,
          far: 100,
          projection: 1, // CAMERA_PROJECTION_ORTHOGRAPHIC
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          tonemap: 0,
          exposure: 1,
          whitePoint: 8,
        },
      },
    )
    .unwrap();

  // Steady-state warm-up + measurement loop. We measure over `FRAMES`
  // total frames; the first 30 frames seed pipelines/caches and are
  // dropped from the fps average.
  const WARM_UP = 30;
  const measureFrames = FRAMES - WARM_UP;
  let drawErrors = 0;
  const lease = renderer.attach(world).unwrap();
  for (let i = 0; i < WARM_UP; i++) {
    world.update().unwrap();
    const r = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!r.ok) drawErrors++;
  }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < measureFrames; i++) {
    world.update().unwrap();
    const r = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!r.ok) drawErrors++;
  }
  await sharedDevice?.queue.onSubmittedWorkDone();
  const t1 = process.hrtime.bigint();
  const elapsedSec = Number(t1 - t0) / 1e9;
  const fps = elapsedSec > 0 ? measureFrames / elapsedSec : 0;

  // UBO bytes per entity: sprite UBO is 64 B (PBR slot stays 80 B). The
  // increment over pre-feat sprite (48 B) is exactly 16 B = one vec4
  // (slicesAndMode), pinned by D-3 sentinel layout. The bench reports
  // the runtime increment as a falsifiable signal so a regression that
  // re-pads the sprite UBO into a full 80 B slot would surface here.
  const SPRITE_UBO_BYTES = 64;
  const SPRITE_UBO_PRE_FEAT_BYTES = 48;
  const uboBytesPerEntity = SPRITE_UBO_BYTES - SPRITE_UBO_PRE_FEAT_BYTES;

  if (drawErrors > 0) {
    const payload = errPayload('pixel-parity-capture-failed', {
      stage: 'renderer-draw',
      drawErrors,
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }

  if (fps < FPS_FLOOR || uboBytesPerEntity > UBO_BYTES_PER_ENTITY_CAP) {
    const payload = errPayload('pixel-parity-threshold-exceeded', {
      fps,
      fpsFloor: FPS_FLOOR,
      uboBytesPerEntity,
      uboBytesPerEntityCap: UBO_BYTES_PER_ENTITY_CAP,
    });
    writeReport(payload);
    process.exitCode = dispatchExit(payload);
    return;
  }

  const payload = passPayload(measureFrames, fps, uboBytesPerEntity);
  writeReport(payload);
  process.exitCode = dispatchExit(payload);
  sharedDevice?.destroy?.();
}

await main();
