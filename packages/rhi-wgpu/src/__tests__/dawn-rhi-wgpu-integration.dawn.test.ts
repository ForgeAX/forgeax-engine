// dawn-rhi-wgpu-integration.dawn.test.ts — feat-20260511-rhi-wgpu-impl M4(c)
// integration test (w24). dawn-node native binding + @forgeax/engine-rhi-wgpu TS shim
// (the M2-built navigator.gpu pass-through path; the wgpu wasm wasm-bindgen
// path arrives in a later loop — current shim accepts navigator.gpu raw
// handles so the dawn-node injection makes this an end-to-end RhiInstance
// → RhiAdapter → RhiDevice → RhiQueue / RhiCommandEncoder / Buffer mapping
// exercise on real GPU command recording, charter candidate proposition 6:
// mock vs real-GPU divergence; plan-strategy §4.2 + §4.5 dawn project).
//
// Trigger: root vitest.config.ts dawn project (`**/*.dawn.test.ts` glob);
// setup file `vitest.setup-webgpu.ts` injects globalThis.navigator.gpu via
// dawn.node binding. M2 baseline `rhi.requestAdapter()` routes through
// `globalThis.navigator.gpu.requestAdapter()` (packages/rhi-wgpu/src/index.ts
// line 81), so the dawn-node setup is sufficient to exercise the real
// command-recording surface end-to-end on this path.
//
// 3 integration scenarios (plan-tasks.json w24 acceptanceCheck):
//   (1) createBuffer + createTexture + mapAsync complete round-trip
//       — MAP_WRITE buffer pattern A from research §7.2: mapAsync(WRITE)
//       → write u32 sequence → unmap → copyBufferToBuffer to MAP_READ
//       buffer → onSubmittedWorkDone → mapAsync(READ) → assert byte-equal
//       (charter proposition 4 explicit failure: ok-path round-trip).
//   (2) queue.submit + command recording — full render-pass round trip:
//       createTexture(RENDER_ATTACHMENT) → createTextureView → encoder
//       → beginRenderPass(loadOp='clear') → pass.end() → finish →
//       queue.submit (Result<void, RhiError>; assert ok=true).
//   (3) onSubmittedWorkDone — sync barrier after submit; resolved Promise
//       must be undefined (FIFO ordering constraint #1; research §5).
//
// All three flow through the forgeax RhiInstance surface — no raw
// navigator.gpu access in the test body (charter proposition 5 consistent
// abstraction across the dual-impl boundary; the @forgeax/engine-rhi-wgpu shim is
// equivalent to @forgeax/engine-rhi-webgpu from the AI-user perspective).

/// <reference types="@webgpu/types" />

// bug-20260610: rhi-wgpu became contractually browser-only WebGL2 fallback
// (wgpu-wasm Cargo.toml drops BROWSER_WEBGPU; adapter.ts removes the
// navigator.gpu fast path). Under dawn-node there is no GL adapter, so
// rhi.requestAdapter() returns adapter-unavailable by design — the
// "dawn-node + rhi-wgpu" pattern these tests exercise is no longer valid.
// Browser coverage of rhi-wgpu lives in
// packages/runtime/__tests__/renderer-wgpu-wasm.browser.test.ts (real
// chromium WebGPU); GL parity for rhi-wgpu would belong in a separate
// linux-lavapipe job (out of scope for this bug).

import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { rhi } from '../index';

async function requestRhiDevice(): Promise<RhiDevice | undefined> {
  const adapterResult = await rhi.requestAdapter();
  expect(adapterResult.ok).toBe(true);
  if (!adapterResult.ok) return undefined;
  const deviceResult = await adapterResult.value.requestDevice();
  expect(deviceResult.ok).toBe(true);
  if (!deviceResult.ok) return undefined;
  return deviceResult.value;
}

describe.skip('rhi-wgpu dawn integration (1) — createBuffer + createTexture + mapAsync round-trip', () => {
  it('Pattern A: mapAsync(WRITE)→unmap→copy→onSubmittedWorkDone→mapAsync(READ) preserves u32 sequence end-to-end', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    // createTexture happy path — RGBA8 4x4 with COPY_DST | COPY_SRC so the
    // round-trip exercises the descriptor passthrough + raw handle wrap on
    // a non-trivial resource (the buffer round-trip is the assert anchor;
    // the texture create is a parallel real-GPU validation that the M2
    // shim's createTexture wrap path produces a usable handle).
    const texResult = device.createTexture({
      label: 'w24-texture-roundtrip',
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    expect(texResult.ok).toBe(true);
    if (!texResult.ok) return;

    const writeBufResult = device.createBuffer({
      label: 'w24-mapasync-write',
      size: 16,
      usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
    });
    expect(writeBufResult.ok).toBe(true);
    if (!writeBufResult.ok) return;
    const writeBuf = writeBufResult.value;

    const m1 = await writeBuf.mapAsync(GPUMapMode.WRITE);
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;
    const range1 = m1.value.getMappedRange();
    expect(range1.ok).toBe(true);
    if (!range1.ok) return;
    new Uint32Array(range1.value).set([10, 20, 30, 40]);
    m1.value.unmap();

    const readBufResult = device.createBuffer({
      label: 'w24-mapasync-read',
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    expect(readBufResult.ok).toBe(true);
    if (!readBufResult.ok) return;
    const readBuf = readBufResult.value;

    const encResult = device.createCommandEncoder({ label: 'w24-roundtrip-enc' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const enc = encResult.value;
    enc.copyBufferToBuffer(writeBuf, 0, readBuf, 0, 16);
    const finishResult = enc.finish();
    expect(finishResult.ok).toBe(true);
    if (!finishResult.ok) return;

    const submitResult = device.queue.submit([finishResult.value]);
    expect(submitResult.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    const m2 = await readBuf.mapAsync(GPUMapMode.READ);
    expect(m2.ok).toBe(true);
    if (!m2.ok) return;
    const range2 = m2.value.getMappedRange();
    expect(range2.ok).toBe(true);
    if (!range2.ok) return;
    expect(Array.from(new Uint32Array(range2.value.slice(0)))).toEqual([10, 20, 30, 40]);
    m2.value.unmap();
  });
});

describe.skip('rhi-wgpu dawn integration (2) — queue.submit + command recording (render pass)', () => {
  it('full render-pass recording → finish → queue.submit returns ok end-to-end', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const texResult = device.createTexture({
      label: 'w24-submit-target',
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    expect(texResult.ok).toBe(true);
    if (!texResult.ok) return;
    const viewResult = device.createTextureView(texResult.value, {});
    expect(viewResult.ok).toBe(true);
    if (!viewResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'w24-submit-enc' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const encoder = encResult.value;

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: viewResult.value as never,
          clearValue: { r: 0.06, g: 0.06, b: 0.08, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as never);
    pass.end();
    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
    if (!finishResult.ok) return;

    const submitResult = device.queue.submit([finishResult.value]);
    expect(submitResult.ok).toBe(true);
  });
});

describe.skip('rhi-wgpu dawn integration (3) — onSubmittedWorkDone barrier', () => {
  it('queue.onSubmittedWorkDone resolves to undefined after a real submit completes (FIFO ordering #1)', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const encResult = device.createCommandEncoder({ label: 'w24-osd-enc' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const finishResult = encResult.value.finish();
    expect(finishResult.ok).toBe(true);
    if (!finishResult.ok) return;
    const submitResult = device.queue.submit([finishResult.value]);
    expect(submitResult.ok).toBe(true);

    const v = await device.queue.onSubmittedWorkDone();
    expect(v).toBeUndefined();
  });
});
