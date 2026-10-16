#!/usr/bin/env node
// hello-triangle headless smoke (feat-20260510-smoke-architecture-redesign
// cash-out: ECS-driven harness, mirrors hello-cube smoke; charter proposition
// 5 consistent abstraction). Inline parallel-shader path removed (D-P5 /
// OQ-R6 candidate (i) integral delete - cash-out feat-future-hello-triangle-
// ecs-smoke deferred from feat-20260509-ecs-render-bridge-mvp implement review
// round 1 issue #1; the previously-inline WGSL + vertex constants are gone).
// Strategy: world.spawn -> runtime Renderer host -> lease-bound renderer.draw(...);
// copyTextureToBuffer + mapAsync NDC-center sample; verdict via
// ./smoke-criteria.mjs evaluateSmokeCriteria SSOT (same pure function the
// unit tests consume). Preserved output literals (ac-08 grep gate (e)/(f)):
// `[hello-triangle] backend=webgpu`, `frames observed=<N>`, `pixelSamples=<json>`.
//
// Boilerplate factored out into ./smoke-helpers.mjs (originally shared with the
// since-deleted smoke-wgpu-wasm.mjs; bug-20260610 made the rhi-wgpu dawn-node
// variant invalid by contract -- rhi-wgpu is browser-only WebGL2 fallback now).
// (feat-20260514-ci-jscpd-duplication-gate M3 T-012 / clone #1+#3 cash-out). Token
// preservation contract: this file still hosts the canonical ECS/runtime imports,
// `HANDLE_TRIANGLE`, and a lease-bound Renderer draw request that the smoke gate checks.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluateSmokeCriteria, DEFAULTS } from './smoke-criteria.mjs';
import {
  bootRenderer,
  evaluateAndExit,
  populateSmokeWorld,
  runFrameLoopAndReadback,
  setupGpuShim,
  SMOKE_HELPERS_DEFAULTS,
} from './smoke-helpers.mjs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? String(DEFAULTS.SMOKE_DURATION_MS), 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? String(DEFAULTS.SMOKE_MIN_FRAMES), 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? String(DEFAULTS.SMOKE_PIXEL_THRESHOLD));
const { WIDTH, HEIGHT } = SMOKE_HELPERS_DEFAULTS;
const RERUN_CMD = 'pnpm --filter @forgeax/hello-triangle smoke';
const here = dirname(fileURLToPath(import.meta.url));

// dawn.node binding setup (mirror vitest.setup-webgpu.ts F-1 / D-P2). Boilerplate
// (gpu shim + adapter wrap + offscreen mock canvas) shared via setupGpuShim.
const shim = await setupGpuShim({ width: WIDTH, height: HEIGHT, rerunCmd: RERUN_CMD });
const { mockCanvas } = shim;

// Drive engine ECS path. Imports happen AFTER the GPU shim is installed.
const { World } = await import('@forgeax/engine-ecs');
await import('@forgeax/engine-runtime');
const { constructRuntimeRendererHost: createRenderer } = await import('@forgeax/engine-runtime/internal/renderer-host');
const assets = await import('@forgeax/engine-assets-runtime');
const render = await import('@forgeax/engine-render');
const scene = await import('@forgeax/engine-scene');
const { _internal_getRawDevice: captureRawDevice, rhi } = await import('@forgeax/engine-rhi-webgpu');

// World spawn: data-equivalent mirror of apps/hello/triangle/src/main.ts M0
// SSOT lock values (charter proposition 5 co-source binding exemplar).
const world = new World();
populateSmokeWorld(world, { ...render, ...scene }, assets);

// rhi.requestDevice was deprecated by feat-20260510-rhi-resource-creation
// breaking point #2 (top-level single-step factory removed; spec-aligned
// rhi.requestAdapter() -> adapter.requestDevice() two-step path is canonical).
// Capture the raw GPUDevice via the wrapped gpu.requestAdapter chain inside
// setupGpuShim: when the engine calls rhi.requestAdapter() -> adapter.requestDevice()
// the wrapped adapter records the resolved device into shim.sharedDevice. The raw
// device is identical to the rhi-shimmed device for native backends (D-S1
// single-point exemption); _internal_getRawDevice and captureRawDevice imports
// remain for symbol-stability with smoke-criteria.mjs but are no longer used.
void captureRawDevice;
void rhi;

// feat-20260518-pbr-direct-lighting-mvp M5 / w22.9: the runtime no longer
// embeds an inline fallback shader; build a real manifest from the engine's
// shipped pbr/unlit WGSL via @forgeax/engine-vite-plugin-shader's
// buildEngineShaderManifest helper (same composition path the plugin
// emits at vite build time, charter P5).
const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

const { renderer, errors } = await bootRenderer({
  createRenderer,
  mockCanvas,
  shaderManifestUrl: MANIFEST_URL,
});
const attachment = renderer.attach(world);
if (!attachment.ok) throw attachment.error;

// Frame loop + readback: the requested frame count owns rendering work.
// Use the lease-bound frame request; the public Renderer returns a FrameReceipt.
const { framesObserved, pixelSamples, device } = await runFrameLoopAndReadback({
  draw: () => {
    world.update().unwrap();
    return renderer.draw({
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
  },
  shim,
  width: WIDTH,
  height: HEIGHT,
  smokeMinFrames: SMOKE_MIN_FRAMES,
  smokeDurationMs: SMOKE_DURATION_MS,
  rerunCmd: RERUN_CMD,
});

// Verdict via evaluateSmokeCriteria SSOT (charter proposition 5).
const verdict = evaluateSmokeCriteria(
  { backendLine: 'webgpu', framesObserved, pixelSamples },
  { minFrames: SMOKE_MIN_FRAMES, pixelThreshold: SMOKE_PIXEL_THRESHOLD },
);

if (verdict.pass && errors.length === 0) emitSmokeReceipt('hello-triangle/smoke', framesObserved);

await evaluateAndExit({
  delay,
  device,
  errors,
  failHint:
    'inspect Renderer.onError fan-out + verify @forgeax/engine-runtime ECS path GPU wiring on dawn-node (plan-strategy K-1 amend C-ii)',
  framesObserved,
  rerunCmd: RERUN_CMD,
  smokeDurationMs: SMOKE_DURATION_MS,
  verdict,
  verdictBackendLabel: 'webgpu',
});
