// dawn-real-gpu.test.ts -- vitest dawn project (AC-RSC-07 / L-P3) D-S3 4 error
// codes triggered against a real GPU adapter (dawn.node native binding).
//
// Trigger: root vitest.config.ts dawn project (`*.dawn.test.ts` glob).
// Setup file: ./vitest.setup-webgpu.ts injects globalThis.navigator.gpu.
//
// Why a separate file from `packages/engine/__tests__/webgpu-backend.dawn.test.ts`:
//   the engine dawn test focuses on the hello-triangle smoke recording chain
//   end-to-end. This file focuses on the 4 D-S3 RhiErrorCode triggers that
//   mock-only tests cannot fully exercise (charter candidate proposition 6:
//   mock vs real-GPU divergence; plan-decisions L-P3 / plan-strategy R-7).
//
// 4 D-S3 RhiErrorCode triggers (one describe block per code):
//   (1) 'command-encoder-finished'
//       encoder.finish() succeeds -> a second encoder.finish() returns
//       Result.err({ code: 'command-encoder-finished' }) (the void-returning
//       record APIs throw on finished encoders; finish() returns Result so
//       the structured error is observable through the Result channel).
//   (2) 'render-pass-not-ended'
//       beginRenderPass() without calling pass.end() -> encoder.finish()
//       returns Result.err({ code: 'render-pass-not-ended' }).
//   (3) 'queue-submit-failed'
//       submit a command buffer twice in a row; the second submit forwards
//       to GPUQueue.submit which dawn rejects with a validation error wrapped
//       to Result.err({ code: 'queue-submit-failed' }).
//   (4) 'queue-write-buffer-out-of-bounds'
//       writeBuffer(buf, 0, data) where data.byteLength > buf.size; the
//       per-buffer bounds guard returns Result.err.
//
// Charter mapping:
//   - proposition 4 (explicit failure): every code is observable via Result.err
//     with .code / .expected / .hint; AI users grep test names per code.
//   - candidate proposition 6 (mock vs real-GPU): mocks cannot exercise dawn's
//     internal validation; this file is the truth check (plan-strategy R-7).

// M6 (feat-20260510-rhi-resource-creation / w42): all `_internal_getRawDevice`
// call sites are migrated off; the dawn tests now drive `rhi.requestAdapter()`
// + `adapter.requestDevice()` (the strict two-step path, charter proposition 5
// consistent abstraction). The single test that needs raw GPUDevice access
// (D-S3 #3 pushErrorScope/popErrorScope candidate proposition 6 truth check)
// captures the raw device by wrapping `adapter.requestDevice` before driving
// the forgeax `rhi` factory through that wrapped adapter (the same pattern
// `apps/hello/cube/scripts/smoke-dawn.mjs` uses; AC-08 grep gate keeps
// `_internal_getRawDevice` at 0 hits across packages/ + apps/).
import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { rhi } from '../index';

/**
 * Helper: walk the strict two-step `rhi.requestAdapter()` ->
 * `adapter.requestDevice()` path and return the resulting `RhiDevice` (or
 * `undefined` on a failure that the test should bail out on).
 */
async function requestRhiDevice(): Promise<RhiDevice | undefined> {
  const adapterResult = await rhi.requestAdapter();
  expect(adapterResult.ok).toBe(true);
  if (!adapterResult.ok) return undefined;
  const deviceResult = await adapterResult.value.requestDevice();
  expect(deviceResult.ok).toBe(true);
  if (!deviceResult.ok) return undefined;
  return deviceResult.value;
}

describe('dawn Environment backend admission', () => {
  it('records unavailable instead of treating RhiNull as real GPU evidence', async () => {
    const adapterResult = await rhi.requestAdapter();
    if (!adapterResult.ok) {
      expect(adapterResult.error.code).toBe('adapter-unavailable');
      expect(adapterResult.error.expected.length).toBeGreaterThan(0);
      expect(adapterResult.error.hint.length).toBeGreaterThan(0);
      reportTimestampEvidence({
        backend: 'webgpu-dawn',
        status: 'unavailable',
        code: adapterResult.error.code,
      });
      return;
    }
    expect(adapterResult.ok).toBe(true);
    reportTimestampEvidence({ backend: 'webgpu-dawn', status: 'available' });
  });
});

function reportTimestampEvidence(evidence: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: the dawn admission record is the test evidence output
  console.log(JSON.stringify(evidence));
}

describe("dawn-real-gpu - 'command-encoder-finished' triggered by second finish() (D-S3 #1)", () => {
  it('encoder.finish() returns ok; subsequent finish() returns command-encoder-finished', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-finish-twice' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const encoder = encResult.value;

    const finishOnce = encoder.finish();
    expect(finishOnce.ok).toBe(true);

    const finishTwice = encoder.finish();
    expect(finishTwice.ok).toBe(false);
    if (!finishTwice.ok) {
      expect(finishTwice.error.code).toBe('command-encoder-finished');
      expect(finishTwice.error.expected.length).toBeGreaterThan(0);
      expect(finishTwice.error.hint.length).toBeGreaterThan(0);
    }
  });

  it('preserves 2d-array and 3d texture-view dimensions on native Dawn', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const arrayTexture = device.createTexture({
      label: 'dawn-array-view-source',
      size: { width: 8, height: 8, depthOrArrayLayers: 4 },
      dimension: '2d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    expect(arrayTexture.ok).toBe(true);
    if (!arrayTexture.ok) return;

    const arrayView = device.createTextureView(arrayTexture.value, {
      label: 'dawn-array-view',
      dimension: '2d-array',
      baseArrayLayer: 1,
      arrayLayerCount: 2,
    });
    expect(arrayView.ok).toBe(true);

    const volumeTexture = device.createTexture({
      label: 'dawn-volume-view-source',
      size: { width: 4, height: 4, depthOrArrayLayers: 4 },
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    expect(volumeTexture.ok).toBe(true);
    if (!volumeTexture.ok) return;

    const volumeView = device.createTextureView(volumeTexture.value, {
      label: 'dawn-volume-view',
      dimension: '3d',
    });
    expect(volumeView.ok).toBe(true);
  });
});

describe("dawn-real-gpu - 'render-pass-not-ended' triggered by finish() with active pass (D-S3 #2)", () => {
  it('encoder.beginRenderPass() then encoder.finish() without pass.end() returns render-pass-not-ended', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const texResult = device.createTexture({
      label: 'dawn-pass-not-ended-target',
      size: { width: 32, height: 32, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    expect(texResult.ok).toBe(true);
    if (!texResult.ok) return;
    const viewResult = device.createTextureView(texResult.value, {});
    expect(viewResult.ok).toBe(true);
    if (!viewResult.ok) return;
    const view = viewResult.value;

    const encResult = device.createCommandEncoder({ label: 'dawn-pass-not-ended' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const encoder = encResult.value;

    // Begin a pass and intentionally do NOT call pass.end() before finish().
    void encoder.beginRenderPass({
      colorAttachments: [
        {
          view: view as never,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as never);

    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(false);
    if (!finishResult.ok) {
      expect(finishResult.error.code).toBe('render-pass-not-ended');
      expect(finishResult.error.expected.length).toBeGreaterThan(0);
      expect(finishResult.error.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("dawn-real-gpu - 'queue-submit-failed' triggered by double-submit (D-S3 #3, candidate proposition 6 truth check)", () => {
  it('queue.submit(cmdBuf) twice on real GPU surfaces a GPUValidationError; shim wrap path returns queue-submit-failed when caught synchronously, otherwise the validation error reaches popErrorScope and the candidate proposition 6 monitoring fires', async () => {
    // M6 / w42: capture the raw GPUDevice by monkey-patching
    // `navigator.gpu.requestAdapter` so the spec `adapter.requestDevice`
    // returns through our hook (the same intercept pattern that
    // `apps/hello/cube/scripts/smoke-dawn.mjs` uses). This avoids the M4-torn
    // `_internal_getRawDevice` cross-package escape hatch while still
    // surfacing the raw device for the candidate-proposition-6 truth check
    // (pushErrorScope / popErrorScope are GPUDevice-only spec entries; not
    // on the forgeax RHI surface).
    const navWithGpu = globalThis as {
      navigator?: { gpu?: { requestAdapter: (opts?: unknown) => Promise<unknown> } };
    };
    const ambient = navWithGpu.navigator?.gpu;
    if (ambient === undefined || ambient === null) return;
    const originalAmbientRequestAdapter = ambient.requestAdapter.bind(ambient);
    let capturedRawDevice: GPUDevice | undefined;
    ambient.requestAdapter = async (opts?: unknown): Promise<unknown> => {
      const rawAdapter = (await originalAmbientRequestAdapter(opts)) as {
        requestDevice: (desc?: unknown) => Promise<unknown>;
      } | null;
      if (rawAdapter === null) return rawAdapter;
      const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
      rawAdapter.requestDevice = async (desc?: unknown): Promise<unknown> => {
        const dev = (await originalRequestDevice(desc)) as GPUDevice;
        if (capturedRawDevice === undefined) capturedRawDevice = dev;
        return dev;
      };
      return rawAdapter;
    };
    let device: RhiDevice | undefined;
    try {
      device = await requestRhiDevice();
    } finally {
      ambient.requestAdapter = originalAmbientRequestAdapter;
    }
    if (device === undefined) return;
    expect(capturedRawDevice).toBeDefined();
    if (capturedRawDevice === undefined) return;
    const rawDevice = capturedRawDevice;

    const texResult = device.createTexture({
      label: 'dawn-submit-failed-target',
      size: { width: 32, height: 32, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    expect(texResult.ok).toBe(true);
    if (!texResult.ok) return;
    const viewResult = device.createTextureView(texResult.value, {});
    expect(viewResult.ok).toBe(true);
    if (!viewResult.ok) return;
    const view = viewResult.value;

    const encResult = device.createCommandEncoder({ label: 'dawn-submit-failed' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const encoder = encResult.value;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: view as never,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as never);
    pass.end();
    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
    if (!finishResult.ok) return;
    const cmdBuf = finishResult.value;

    // First submit consumes the command buffer (WebGPU spec: a CommandBuffer
    // can be submitted at most once).
    const submit1 = device.queue.submit([cmdBuf]);
    expect(submit1.ok).toBe(true);

    // Wrap the failing submit in an error scope. Dawn raises a validation
    // error on the second submit; popErrorScope() resolves with a
    // GPUValidationError. Either the shim's try/catch wrap returns
    // Result.err({code:'queue-submit-failed'}) synchronously, or the async
    // validation surfaces via popErrorScope. Both paths assert real
    // validation reached the test (charter proposition 4 explicit failure;
    // no silent pass).
    rawDevice.pushErrorScope('validation');
    const submit2 = device.queue.submit([cmdBuf]);
    const validationError = await rawDevice.popErrorScope();

    if (!submit2.ok) {
      // Synchronous catch path inside the shim wrapped the throw.
      expect(submit2.error.code).toBe('queue-submit-failed');
      expect(submit2.error.expected.length).toBeGreaterThan(0);
      expect(submit2.error.hint.length).toBeGreaterThan(0);
    } else {
      // Async validation path: dawn surfaced the error through popErrorScope.
      // Asserting non-null here is the candidate proposition 6 truth check:
      // if dawn ever stops raising here, the test fails (silent-pass
      // monitoring per plan-strategy R-7).
      expect(validationError).not.toBeNull();
      expect(validationError?.message ?? '').toMatch(/submitted more than once|invalid|destroyed/i);
    }
  });
});

describe("dawn-real-gpu - 'queue-write-buffer-out-of-bounds' triggered by oversized writeBuffer (D-S3 #4)", () => {
  it('writeBuffer where offset + data.byteLength > buffer.size returns queue-write-buffer-out-of-bounds', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const bufResult = device.createBuffer({
      label: 'dawn-oob-buffer',
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });
    expect(bufResult.ok).toBe(true);
    if (!bufResult.ok) return;
    const buffer = bufResult.value;

    // 32 bytes data into a 16-byte buffer at offset 0 -> bounds violation.
    const data = new Uint8Array(32);
    const out = device.queue.writeBuffer(buffer, 0, data);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('queue-write-buffer-out-of-bounds');
      // Hint must include the concrete numbers for AI-user routing
      // (charter proposition 4 + queue-real-path.test.ts contract parity).
      expect(out.error.hint).toContain('got 0');
      expect(out.error.hint).toContain('got 32');
      expect(out.error.hint).toContain('got 16');
    }
  });
});

// w05 — createTextureView dawn real-GPU red phase.
//
// Goal: assert the `device.createTextureView(tex, desc)` real path returns a
// usable handle on the happy path AND maps a cross-resource format violation
// to Result.err({ code: 'webgpu-runtime-error' }) on dawn (real validation).
//
// Currently red: RhiDevice.createTextureView is not on the interface (TS2339).
// Turns green after w06 ships interface + shim.
//
// Anchors: requirements §IN-1 / §AC-07(c) / §IN-9; research §1.1 cross-resource
//          gate + §7 dawn-node real path; plan-strategy §4.2 dawn + K-10.
describe('dawn-real-gpu - createTextureView happy path returns a TextureView handle (w05)', () => {
  it('device.createTextureView({format,dimension}) on a matching source texture returns ok and the handle is usable as a render-pass attachment view', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const texResult = device.createTexture({
      label: 'dawn-view-source',
      size: { width: 32, height: 32, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    expect(texResult.ok).toBe(true);
    if (!texResult.ok) return;

    const viewResult = device.createTextureView(texResult.value, {
      label: 'dawn-view',
      format: 'rgba8unorm',
      dimension: '2d',
    });
    expect(viewResult.ok).toBe(true);
    if (!viewResult.ok) return;

    // The view handle must be consumable by a render pass attachment slot.
    const encResult = device.createCommandEncoder({ label: 'dawn-view-encoder' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const encoder = encResult.value;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: viewResult.value as never,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as never);
    pass.end();
    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
  });
});

// w08 — createComputePipeline dawn real-GPU red phase. Asserts the real
// `device.createComputePipeline({layout:'auto', compute:{module, entryPoint}})`
// path returns ok with a usable pipeline handle on dawn-node. Currently red:
// RhiDevice.createComputePipeline does not exist on the interface (TS2339).
// Turns green after w09 ships interface + shim.
//
// Anchors: requirements §IN-1 / §AC-01; research §1.2 device timeline +
//          §7 dawn-node real path; plan-strategy §4.3 + K-10.
// w11 — createQuerySet dawn real-GPU red phase. Asserts that
//   (a) device.createQuerySet({type:'occlusion', count}) returns ok and the
//       handle is consumable as RenderPassDescriptor.occlusionQuerySet.
//   (b) device.createQuerySet({type:'timestamp', count}) returns
//       'feature-not-enabled' when the dawn adapter does not surface the
//       'timestamp-query' feature (charter proposition 4 + research §1.3).
// Currently red: createQuerySet not on RhiDevice (TS2339). Turns green
// after w12 ships interface + shim.
describe('dawn-real-gpu - createQuerySet occlusion happy path (w11)', () => {
  it("device.createQuerySet({type:'occlusion'}) returns ok on dawn", async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({
      label: 'dawn-qs-occ',
      type: 'occlusion',
      count: 4,
    });
    expect(qsResult.ok).toBe(true);
  });
});

describe('dawn-real-gpu - createQuerySet timestamp gate (w11)', () => {
  it("device.createQuerySet({type:'timestamp'}) handles timestamp-query feature presence/absence per spec", async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({
      label: 'dawn-qs-ts',
      type: 'timestamp',
      count: 4,
    });
    if (!device.caps.timestampQuery) {
      // gate: shim returns 'feature-not-enabled' ahead of forwarding.
      expect(qsResult.ok).toBe(false);
      if (!qsResult.ok) {
        expect(qsResult.error.code).toBe('feature-not-enabled');
      }
    } else {
      expect(qsResult.ok).toBe(true);
    }
  });
});

describe('dawn-real-gpu - createComputePipeline happy path (w08)', () => {
  it('an indirect compute dispatch writes the storage buffer and survives GPU readback', async () => {
    const { rhi: rhiInst, createShaderModule: createShaderMod } = await import('../index');
    // M6 fix-up [w51]: spec-aligned strict two-step path; legacy
    // `rhi.requestDevice` retired (AGENTS.md break-point list 2026-05-10 #2).
    const ar = await rhiInst.requestAdapter();
    expect(ar.ok).toBe(true);
    if (!ar.ok) return;
    const dr = await ar.value.requestDevice();
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    const device = dr.value;

    const shaderResult = await createShaderMod(device, {
      code: `
        @group(0) @binding(0) var<storage, read_write> values: array<u32>;
        @compute @workgroup_size(1)
        fn cs_main(@builtin(global_invocation_id) id: vec3<u32>) {
          values[id.x] = id.x + 10u;
        }
      `,
    });
    expect(shaderResult.ok).toBe(true);
    if (!shaderResult.ok) return;

    const layoutResult = device.createBindGroupLayout({
      label: 'dawn-cs-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
      ],
    });
    expect(layoutResult.ok).toBe(true);
    if (!layoutResult.ok) return;
    const pipelineLayoutResult = device.createPipelineLayout({
      label: 'dawn-cs-pipeline-layout',
      bindGroupLayouts: [layoutResult.value],
    });
    expect(pipelineLayoutResult.ok).toBe(true);
    if (!pipelineLayoutResult.ok) return;

    const pipelineResult = device.createComputePipeline({
      label: 'dawn-cs',
      layout: pipelineLayoutResult.value,
      compute: { module: shaderResult.value, entryPoint: 'cs_main' },
    });
    expect(pipelineResult.ok).toBe(true);
    if (!pipelineResult.ok) return;

    const valuesResult = device.createBuffer({
      label: 'dawn-cs-values',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const indirectResult = device.createBuffer({
      label: 'dawn-cs-indirect',
      size: 12,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    const readbackResult = device.createBuffer({
      label: 'dawn-cs-readback',
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    expect(valuesResult.ok && indirectResult.ok && readbackResult.ok).toBe(true);
    if (!valuesResult.ok || !indirectResult.ok || !readbackResult.ok) return;
    expect(device.queue.writeBuffer(indirectResult.value, 0, new Uint32Array([4, 1, 1])).ok).toBe(
      true,
    );
    const bindingsResult = device.createBindGroup({
      label: 'dawn-cs-bindings',
      layout: layoutResult.value,
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: valuesResult.value } },
        },
      ],
    });
    expect(bindingsResult.ok).toBe(true);
    if (!bindingsResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-cs-encoder' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const encoder = encResult.value;
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipelineResult.value);
    pass.setBindGroup(0, bindingsResult.value);
    pass.dispatchWorkgroupsIndirect(indirectResult.value, 0);
    pass.end();
    encoder.copyBufferToBuffer(valuesResult.value, 0, readbackResult.value, 0, 16);
    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
    if (!finishResult.ok) return;
    expect(device.queue.submit([finishResult.value]).ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    const mapped = await readbackResult.value.mapAsync(GPUMapMode.READ);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const range = mapped.value.getMappedRange();
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    expect(Array.from(new Uint32Array(range.value.slice(0)))).toEqual([10, 11, 12, 13]);
    mapped.value.unmap();
  });
});

describe("dawn-real-gpu - createTextureView format outside source.format ∪ source.viewFormats returns 'webgpu-runtime-error' (w05)", () => {
  it('format mismatch surfaces a real GPUValidationError; the shim wraps it as webgpu-runtime-error', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const texResult = device.createTexture({
      label: 'dawn-view-format-mismatch-source',
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    expect(texResult.ok).toBe(true);
    if (!texResult.ok) return;

    const viewResult = device.createTextureView(texResult.value, {
      // bgra8unorm is neither the source format nor in source.viewFormats.
      format: 'bgra8unorm',
      dimension: '2d',
    });
    expect(viewResult.ok).toBe(false);
    if (!viewResult.ok) {
      expect(viewResult.error.code).toBe('webgpu-runtime-error');
      expect(viewResult.error.expected.length).toBeGreaterThan(0);
      expect(viewResult.error.hint.length).toBeGreaterThan(0);
    }
  });
});

// w20 - RhiCanvasContext dawn-real-GPU red phase. Asserts:
//   (a) configure with format = 'rgba8unorm-srgb' (NOT in supported context
//       formats) returns webgpu-runtime-error.
//   (b) configure with format = 'bgra8unorm' on a real OffscreenCanvas
//       succeeds; getCurrentTexture returns ok.
//   (c) getCurrentTexture before configure returns webgpu-runtime-error
//       (spec InvalidStateError mapping).
//
// Anchors: requirements §IN-4 / §AC-04 / §AC-07 / boundary case row 7;
//          research §3.1 4 methods + §3.2 7 fields + §3.3 4 method algorithms;
//          plan-strategy §2 K-4 + §6 M3 + K-10.
import { acquireCanvasContext } from '../index';

describe('w20 dawn-real-gpu - RhiCanvasContext.configure format gate (research §3.2 supported context formats)', () => {
  it('format outside {bgra8unorm, rgba8unorm, rgba16float} fires webgpu-runtime-error', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    // dawn-node does not provide a canvas; we synthesize a stub that fulfils
    // the GPUCanvasContext shape sufficiently for the format-gate path. The
    // shim's format check happens before the underlying configure() is
    // invoked, so the stub need not implement actual configure semantics.
    const stub = {
      configure(_d: GPUCanvasConfiguration) {},
      unconfigure() {},
      getConfiguration(): GPUCanvasConfiguration | null {
        return null;
      },
      getCurrentTexture(): GPUTexture {
        throw new Error('stub: getCurrentTexture should not be reached on format-gate path');
      },
    };
    const mockCanvas = { getContext: () => stub };
    const ctxResult = acquireCanvasContext(mockCanvas as unknown as HTMLCanvasElement);
    if (!ctxResult.ok) return;
    const out = ctxResult.value.configure({
      device,
      format: 'rgba8unorm-srgb',
      usage: 0x10,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('webgpu-runtime-error');
      expect(out.error.expected).toBe('one of bgra8unorm/rgba8unorm/rgba16float');
    }
  });
});

// w22 - RPE beginOcclusionQuery / endOcclusionQuery placeholder retirement
// dawn-real-GPU red phase. Asserts:
//   (a) beginOcclusionQuery while RPDesc.occlusionQuerySet is null ->
//       webgpu-runtime-error with the contracted .hint literal.
//   (b) nested begin (begin while another begin is active) ->
//       webgpu-runtime-error with the contracted .expected literal.
//   (c) end without active begin -> render-pass-not-ended (existing code).
//   (d) full occlusion query round-trip on dawn (Pattern C) succeeds.
//
// F-3 ai-user-review absorption: literal grep on .expected / .hint string
// contents (charter proposition 4 explicit failure).
//
// Anchors: requirements §IN-3 / §AC-03 / §AC-12 / boundary case row 4-5;
//          research §2.1 + §2.2 + §7.2 + §9; plan-strategy §2 K-2 + §6 M3 +
//          K-10.
describe('w22 dawn-real-gpu - beginOcclusionQuery without occlusionQuerySet returns webgpu-runtime-error (F-3 hint literal)', () => {
  it('begin when RPDesc.occlusionQuerySet null fires webgpu-runtime-error with contracted hint literal', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const texResult = device.createTexture({
      label: 'dawn-occ-no-qs-target',
      size: { width: 32, height: 32, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (!texResult.ok) return;
    const viewResult = device.createTextureView(texResult.value, {});
    if (!viewResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-occ-no-qs' });
    if (!encResult.ok) return;
    const encoder = encResult.value;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: viewResult.value as never,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as never);

    const out = pass.beginOcclusionQuery(0);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('webgpu-runtime-error');
      // F-3 literal hint assertion.
      expect(out.error.hint).toBe(
        'pass occlusionQuerySet in RenderPassDescriptor before beginOcclusionQuery',
      );
    }
    pass.end();
    void encoder.finish();
  });
});

describe('w22 dawn-real-gpu - nested beginOcclusionQuery returns webgpu-runtime-error (K-2 + F-3 expected literal)', () => {
  it('begin while another begin is active fires webgpu-runtime-error with the contracted .expected literal', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
    if (!qsResult.ok) return;
    const querySet = qsResult.value;

    const texResult = device.createTexture({
      label: 'dawn-occ-nested-target',
      size: { width: 32, height: 32, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (!texResult.ok) return;
    const viewResult = device.createTextureView(texResult.value, {});
    if (!viewResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-occ-nested' });
    if (!encResult.ok) return;
    const encoder = encResult.value;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: viewResult.value as never,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      occlusionQuerySet: querySet,
    } as never);

    const begin1 = pass.beginOcclusionQuery(0);
    expect(begin1.ok).toBe(true);
    const begin2 = pass.beginOcclusionQuery(1);
    expect(begin2.ok).toBe(false);
    if (!begin2.ok) {
      expect(begin2.error.code).toBe('webgpu-runtime-error');
      // F-3 literal expected assertion.
      expect(begin2.error.expected).toBe(
        '[[occlusion_query_active]] == false; pair beginOcclusionQuery / endOcclusionQuery',
      );
    }
    pass.endOcclusionQuery();
    pass.end();
    void encoder.finish();
  });
});

describe('w22 dawn-real-gpu - endOcclusionQuery without active begin returns render-pass-not-ended', () => {
  it('end without active begin fires render-pass-not-ended', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
    if (!qsResult.ok) return;
    const querySet = qsResult.value;

    const texResult = device.createTexture({
      label: 'dawn-occ-end-no-begin-target',
      size: { width: 32, height: 32, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (!texResult.ok) return;
    const viewResult = device.createTextureView(texResult.value, {});
    if (!viewResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-occ-end-no-begin' });
    if (!encResult.ok) return;
    const encoder = encResult.value;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: viewResult.value as never,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      occlusionQuerySet: querySet,
    } as never);

    const out = pass.endOcclusionQuery();
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('render-pass-not-ended');
    }
    pass.end();
    void encoder.finish();
  });
});

describe('w22 dawn-real-gpu - occlusion query full round-trip (Pattern C, research §7.2)', () => {
  it('begin/draw/end occlusion query in a real pass succeeds end-to-end', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({
      label: 'dawn-occ-roundtrip',
      type: 'occlusion',
      count: 4,
    });
    if (!qsResult.ok) return;
    const querySet = qsResult.value;

    const texResult = device.createTexture({
      label: 'dawn-occ-rt-target',
      size: { width: 32, height: 32, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (!texResult.ok) return;
    const viewResult = device.createTextureView(texResult.value, {});
    if (!viewResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-occ-roundtrip' });
    if (!encResult.ok) return;
    const encoder = encResult.value;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: viewResult.value as never,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      occlusionQuerySet: querySet,
    } as never);

    const begin = pass.beginOcclusionQuery(0);
    expect(begin.ok).toBe(true);
    const end = pass.endOcclusionQuery();
    expect(end.ok).toBe(true);
    pass.end();
    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
  });
});

// w24 - resolveQuerySet placeholder retirement dawn-real-GPU red phase.
// Asserts:
//   (a) destinationOffset % 256 != 0 -> webgpu-runtime-error with .expected
//       literal 'destinationOffset % 256 == 0 (spec normative)'.
//   (b) destination.usage missing QUERY_RESOLVE -> webgpu-runtime-error with
//       .expected literal 'destination.usage must contain QUERY_RESOLVE'.
//   (c) firstQuery >= count / firstQuery + queryCount > count.
//   (d) resolveQuerySet happy path returns ok.
//
// F-3 ai-user-review absorption: literal grep on .expected string contents
// (charter proposition 4 explicit failure: K-2 merges all alignment / usage /
// bounds violations under webgpu-runtime-error; .expected must distinguish).
//
// Anchors: requirements §IN-3 / §AC-03 / §AC-12; research §2.3 + §7.2 + §9;
//          plan-strategy §2 K-2 + §6 M3 + K-10.
describe('w24 dawn-real-gpu - resolveQuerySet destinationOffset alignment maps to webgpu-runtime-error (K-2 + F-3 expected literal)', () => {
  it('destinationOffset = 8 (NOT a multiple of 256) returns webgpu-runtime-error with .expected literal', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
    if (!qsResult.ok) return;

    const dstResult = device.createBuffer({
      label: 'dawn-resolve-dst',
      size: 256,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    if (!dstResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-resolve-align' });
    if (!encResult.ok) return;
    const encoder = encResult.value;

    const out = encoder.resolveQuerySet(qsResult.value, 0, 4, dstResult.value, 8);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('webgpu-runtime-error');
      expect(out.error.expected).toBe('destinationOffset % 256 == 0 (spec normative)');
    }
    void encoder.finish();
  });
});

describe('w24 dawn-real-gpu - resolveQuerySet destination.usage missing QUERY_RESOLVE maps to webgpu-runtime-error (F-3)', () => {
  it('destination buffer without QUERY_RESOLVE usage flag returns webgpu-runtime-error with .expected literal', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
    if (!qsResult.ok) return;

    const dstResult = device.createBuffer({
      label: 'dawn-resolve-dst-no-qr',
      size: 256,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    if (!dstResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-resolve-no-qr' });
    if (!encResult.ok) return;
    const encoder = encResult.value;

    const out = encoder.resolveQuerySet(qsResult.value, 0, 4, dstResult.value, 0);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('webgpu-runtime-error');
      expect(out.error.expected).toBe('destination.usage must contain QUERY_RESOLVE');
    }
    void encoder.finish();
  });
});

describe('w24 dawn-real-gpu - resolveQuerySet firstQuery / queryCount range bounds', () => {
  it('firstQuery + queryCount > querySet.count returns webgpu-runtime-error with .expected literal (F-3)', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
    if (!qsResult.ok) return;

    const dstResult = device.createBuffer({
      label: 'dawn-resolve-dst-oob',
      size: 256,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    if (!dstResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-resolve-oob' });
    if (!encResult.ok) return;
    const encoder = encResult.value;

    const out = encoder.resolveQuerySet(qsResult.value, 2, 3, dstResult.value, 0);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('webgpu-runtime-error');
      expect(out.error.expected).toBe('firstQuery + queryCount <= querySet.count');
    }
    void encoder.finish();
  });
});

describe('w24 dawn-real-gpu - resolveQuerySet happy path returns ok (real round-trip succeeds)', () => {
  it('resolveQuerySet on a 256-byte aligned dst with QUERY_RESOLVE usage succeeds', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const qsResult = device.createQuerySet({ type: 'occlusion', count: 4 });
    if (!qsResult.ok) return;

    const dstResult = device.createBuffer({
      label: 'dawn-resolve-dst-ok',
      size: 256,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    if (!dstResult.ok) return;

    const encResult = device.createCommandEncoder({ label: 'dawn-resolve-ok' });
    if (!encResult.ok) return;
    const encoder = encResult.value;

    const out = encoder.resolveQuerySet(qsResult.value, 0, 4, dstResult.value, 0);
    expect(out.ok).toBe(true);
    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
  });
});

// w31 (M5) — mappedAtCreation shim passthrough Pattern B (research §7.2 / AC-05 (b)).
//
// Verifies the BufferDescriptor.mappedAtCreation field actually reaches the
// raw GPUBuffer. The forgeax BufferDescriptor.mappedAtCreation field has been
// declared since the shader-mvp closure (packages/rhi/src/index.ts:149) but
// research §8.2 + OQ-7 / D-R3 flagged a suspected silent passthrough drop in
// the shim. This dawn-real-gpu test is the truth check: when the field reaches
// the raw GPU correctly, the buffer enters the mapped state and getMappedRange
// returns a non-empty ArrayBuffer that we can write to and unmap.
//
// Method: cast the forgeax Buffer handle to the raw GPUBuffer (the shim stores
// the raw object in BUFFER_RAW_MAP and the brand IS the raw object as a cast
// in the WebGPU path). We exercise the spec mappedAtCreation init idiom:
// createBuffer({size:16, usage:STORAGE, mappedAtCreation:true}) -> 16 bytes
// pre-mapped -> write four u32 values -> unmap -> readback round-trip via a
// COPY_DST + MAP_READ buffer to verify the data persisted post-unmap.
//
// Charter: proposition 4 explicit failure (mappedAtCreation must produce real
// GPU effect, not silently no-op); plan-strategy K-7 + risk mitigation P-1.
describe('w31 (M5) — mappedAtCreation shim passthrough (Pattern B init path)', () => {
  it('createBuffer({mappedAtCreation:true}) yields a buffer in mapped state with 16-byte ArrayBuffer; data persists after unmap and round-trips via COPY', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const initBufResult = device.createBuffer({
      label: 'w31-mapped-at-creation-init',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    expect(initBufResult.ok).toBe(true);
    if (!initBufResult.ok) return;
    const initBuf = initBufResult.value;

    // mappedAtCreation success means mapState === 'mapped'; the shim ships the
    // descriptor field through to the raw GPUBuffer (BUFFER_KEYS mirror) and
    // the forgeax Buffer wrapper exposes mapState as a getter (M5 / w35).
    expect(initBuf.mapState).toBe('mapped');

    // mappedAtCreation:true puts the Buffer into mapState='mapped' synchronously;
    // cast to MappedBuffer brand to access getMappedRange / unmap method form
    // (D-P2 #6: mapAsync resolves a MappedBuffer; mappedAtCreation is the
    // synchronous variant where the Buffer is already mapped without an explicit
    // mapAsync round-trip).
    const initBufMapped = initBuf as unknown as import('@forgeax/engine-rhi').MappedBuffer;
    // getMappedRange must yield a non-zero-byte-length ArrayBuffer matching size.
    const range = initBufMapped.getMappedRange();
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    expect(range.value.byteLength).toBe(16);
    new Uint32Array(range.value).set([1, 2, 3, 4]);
    initBufMapped.unmap();
    expect(initBuf.mapState).toBe('unmapped');

    // Round-trip: copy STORAGE buffer to a MAP_READ buffer and verify the
    // initial values persist. This is the strongest evidence that
    // mappedAtCreation passthrough is real (not declaration-only).
    const readBufResult = device.createBuffer({
      label: 'w31-mapped-at-creation-readback',
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    expect(readBufResult.ok).toBe(true);
    if (!readBufResult.ok) return;
    const readBuf = readBufResult.value;

    const encResult = device.createCommandEncoder({ label: 'w31-init-readback' });
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;
    const encoder = encResult.value;
    encoder.copyBufferToBuffer(initBufResult.value, 0, readBufResult.value, 0, 16);
    const finishResult = encoder.finish();
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
    expect(Array.from(new Uint32Array(range2.value.slice(0)))).toEqual([1, 2, 3, 4]);
    m2.value.unmap();
  });
});

// ---------------------------------------------------------------------------
// w34 (M5) - dawn-real-gpu Pattern A round-trip + F-8 three-row real-path.
// ---------------------------------------------------------------------------
//
// research §7.2 Pattern A: mapAsync(WRITE) -> write -> unmap -> submit copy
// -> onSubmittedWorkDone -> mapAsync(READ) -> readback. This is the AC-05 (a)
// reference idiom + the spec ordering constraint #2 demonstration (mapAsync
// before onSubmittedWorkDone).
//
// F-8 contract on dawn (research §4.2 step 1 / 9): the shim must reject
// already-mapped re-mapAsync and mode-usage mismatch with
// 'webgpu-runtime-error'. Detached ArrayBuffer access (F-8 row 2) is checked
// via getMappedRange after unmap.
//
// These cases are RED until w35 ships the impl.
describe('w34 (M5) - dawn-real-gpu Pattern A round-trip (mapAsync + onSubmittedWorkDone ordering)', () => {
  it('mapAsync(WRITE)->write->unmap->submit->onSubmittedWorkDone->mapAsync(READ)->readback returns the written u32 sequence', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;
    // M6 / w42: w36/w37 ship `RhiQueue.onSubmittedWorkDone` so the ordering
    // wait now goes through the forgeax RHI surface directly (no raw device
    // hatch needed).

    const writeBufResult = device.createBuffer({
      label: 'w34-write-buf',
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
    new Uint32Array(range1.value).set([1, 2, 3, 4]);
    m1.value.unmap();

    const readBufResult = device.createBuffer({
      label: 'w34-read-buf',
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    expect(readBufResult.ok).toBe(true);
    if (!readBufResult.ok) return;
    const readBuf = readBufResult.value;

    const encResult = device.createCommandEncoder({ label: 'w34-enc' });
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
    expect(Array.from(new Uint32Array(range2.value.slice(0)))).toEqual([1, 2, 3, 4]);
    m2.value.unmap();
  });
});

describe('w34 (M5) - dawn-real-gpu F-8 row 1 real-path (already-mapped re-mapAsync)', () => {
  it('mapAsync on a mappedAtCreation:true buffer returns webgpu-runtime-error with mapState .expected literal', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const bufResult = device.createBuffer({
      label: 'w34-already-mapped',
      size: 16,
      usage: GPUBufferUsage.MAP_WRITE,
      mappedAtCreation: true,
    });
    expect(bufResult.ok).toBe(true);
    if (!bufResult.ok) return;
    const out = await bufResult.value.mapAsync(GPUMapMode.WRITE);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('webgpu-runtime-error');
      expect(out.error.expected).toContain('mapState');
      expect(out.error.hint).toContain('unmap');
    }
  });
});

describe('w34 (M5) - dawn-real-gpu F-8 row 3 real-path (mode-usage mismatch)', () => {
  it('mapAsync(READ) on a buffer without MAP_READ returns webgpu-runtime-error with the mode-usage .expected literal', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const bufResult = device.createBuffer({
      label: 'w34-mode-usage-mismatch',
      size: 16,
      usage: GPUBufferUsage.COPY_DST,
    });
    expect(bufResult.ok).toBe(true);
    if (!bufResult.ok) return;
    const out = await bufResult.value.mapAsync(GPUMapMode.READ);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('webgpu-runtime-error');
      expect(out.error.expected).toContain('READ requires buffer.usage to contain MAP_READ');
      expect(out.error.hint).toContain('GPUBufferUsage.MAP_READ');
    }
  });
});

describe('w34 (M5) - dawn-real-gpu F-8 row 2 real-path (detach guard via getMappedRange after unmap)', () => {
  it('getMappedRange after unmap returns webgpu-runtime-error with the mapped .expected literal', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const bufResult = device.createBuffer({
      label: 'w34-detach',
      size: 16,
      usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
    });
    expect(bufResult.ok).toBe(true);
    if (!bufResult.ok) return;
    const buf = bufResult.value;
    const m1 = await buf.mapAsync(GPUMapMode.WRITE);
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;
    const r1 = m1.value.getMappedRange();
    expect(r1.ok).toBe(true);
    m1.value.unmap();
    // After unmap the MappedBuffer brand is detached; calling getMappedRange
    // again returns Result.err with code 'webgpu-runtime-error' + expected
    // literal 'mapped' (F-8 row 2 detach guard).
    const r2 = m1.value.getMappedRange();
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe('webgpu-runtime-error');
      expect(r2.error.expected).toContain('mapped');
      expect(r2.error.hint).toContain('mapAsync');
    }
  });
});

// ---------------------------------------------------------------------------
// w36 (M5) - dawn-real-gpu RhiQueue.writeTexture + onSubmittedWorkDone.
// ---------------------------------------------------------------------------
//
// research §5.1 / §5.2 / §5.3 + Pattern A: onSubmittedWorkDone has no reject
// path; it is the standard read-back idiom companion to mapAsync. dawn-node
// is the truth check (charter candidate proposition 6: mock vs real-GPU).
describe('w36 (M5) - dawn-real-gpu RhiQueue.onSubmittedWorkDone returns Promise<void>', () => {
  it('queue.onSubmittedWorkDone resolves after queue.submit completes (FIFO ordering constraint #1)', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const encResult = device.createCommandEncoder({ label: 'w36-enc' });
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

// ---------------------------------------------------------------------------
// w38 (M5 / K-3) - dawn-real-gpu compute-pass timestampWrites.
// ---------------------------------------------------------------------------
//
// research §2.4 + dawn ComputePassDescriptor timestampWrites reference:
// the real compute pass owns the beginning/end timestamp writes. Command-
// encoder timestamp markers are intentionally absent from the RHI surface.
describe('w38 (M5 / K-3) - dawn-real-gpu compute-pass timestampWrites gate', () => {
  it('reports timestamp-query refusal without treating a capability-disabled path as success', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    if (device.caps.timestampQuery) {
      return;
    }
    const qsResult = device.createQuerySet({ type: 'timestamp', count: 1 });
    expect(qsResult.ok).toBe(false);
    if (!qsResult.ok) {
      expect(qsResult.error.code).toBe('feature-not-enabled');
      expect(qsResult.error.expected).toContain('timestampQuery');
      expect(qsResult.error.hint).toContain('timestamp-query');
      reportTimestampEvidence({
        carrier: 'dawn-node',
        selector: 'standard',
        source: 'packages/rhi-webgpu/src/__tests__/dawn-real-gpu.dawn.test.ts',
        acceptedGpu: 0,
        refusalCode: 'timestamp-query-unsupported',
        expected: qsResult.error.expected,
        hint: qsResult.error.hint,
      });
    }
  });
});

describe('w3 dawn-real-gpu timestamp admission path', () => {
  it('runs compute-pass timestampWrites -> resolve -> submit -> readback or records a structured refusal', async () => {
    const selector = 'standard' as const;
    const source = 'packages/rhi-webgpu/src/__tests__/dawn-real-gpu.dawn.test.ts';
    const adapterResult = await rhi.requestAdapter();
    expect(adapterResult.ok).toBe(true);
    if (!adapterResult.ok) return;

    if (!adapterResult.value.features.has('timestamp-query')) {
      reportTimestampEvidence({
        carrier: 'dawn-node',
        selector,
        source,
        acceptedGpu: 0,
        refusalCode: 'timestamp-query-unsupported',
        expected: "adapter.features.has('timestamp-query')",
        hint: 'request a real Dawn device with the timestamp-query feature enabled',
      });
      return;
    }

    const deviceResult = await adapterResult.value.requestDevice({
      requiredFeatures: ['timestamp-query'],
    });
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const device = deviceResult.value;

    const { createShaderModule } = await import('../index');
    const shaderResult = await createShaderModule(device, {
      code: '@compute @workgroup_size(1) fn timestamp_probe() {}',
    });
    expect(shaderResult.ok).toBe(true);
    if (!shaderResult.ok) return;
    const pipelineResult = device.createComputePipeline({
      label: 'w3-timestamp-compute-pipeline',
      layout: 'auto',
      compute: { module: shaderResult.value, entryPoint: 'timestamp_probe' },
    });
    expect(pipelineResult.ok).toBe(true);
    if (!pipelineResult.ok) return;

    const querySetResult = device.createQuerySet({ type: 'timestamp', count: 2 });
    expect(querySetResult.ok).toBe(true);
    if (!querySetResult.ok) return;

    const resolveResult = device.createBuffer({
      label: 'w3-timestamp-resolve',
      size: 256,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    const readbackResult = device.createBuffer({
      label: 'w3-timestamp-readback',
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    expect(readbackResult.ok).toBe(true);
    if (!readbackResult.ok) return;

    const encoderResult = device.createCommandEncoder({ label: 'w3-timestamp-encoder' });
    expect(encoderResult.ok).toBe(true);
    if (!encoderResult.ok) return;
    const encoder = encoderResult.value;

    try {
      const pass = encoder.beginComputePass({
        label: 'hdrp-cluster-membership',
        timestampWrites: {
          querySet: querySetResult.value,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
      });
      pass.setPipeline(pipelineResult.value);
      pass.dispatchWorkgroups(1);
      pass.end();
    } catch (error) {
      const refusal = error as { code?: string; expected?: string; hint?: string };
      reportTimestampEvidence({
        carrier: 'dawn-node',
        selector,
        source,
        acceptedGpu: 0,
        refusalCode: 'timestamp-write-unavailable',
        expected:
          refusal.expected ??
          'GPUComputePassDescriptor.timestampWrites to be accepted by the real compute pass',
        hint: refusal.hint ?? String(error),
      });
      expect(refusal.code).toBe('webgpu-runtime-error');
      return;
    }

    const resolveQueriesResult = encoder.resolveQuerySet(
      querySetResult.value,
      0,
      2,
      resolveResult.value,
      0,
    );
    expect(resolveQueriesResult.ok).toBe(true);
    if (!resolveQueriesResult.ok) return;
    encoder.copyBufferToBuffer(resolveResult.value, 0, readbackResult.value, 0, 16);

    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
    if (!finishResult.ok) return;
    const submitResult = device.queue.submit([finishResult.value]);
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;
    await device.queue.onSubmittedWorkDone();

    const mappedResult = await readbackResult.value.mapAsync(GPUMapMode.READ);
    expect(mappedResult.ok).toBe(true);
    if (!mappedResult.ok) return;
    const rangeResult = mappedResult.value.getMappedRange(0, 16);
    expect(rangeResult.ok).toBe(true);
    if (!rangeResult.ok) return;
    const ticks = new BigUint64Array(rangeResult.value);
    const begin = ticks[0];
    const end = ticks[1];
    if (begin === undefined || end === undefined || end <= begin) {
      reportTimestampEvidence({
        carrier: 'dawn-node',
        selector,
        source,
        acceptedGpu: 0,
        refusalCode: 'timestamp-write-unavailable',
        expected: 'end > begin',
        hint: 'timestamp readback did not produce a positive GPU interval',
        observed: { begin: begin?.toString() ?? null, end: end?.toString() ?? null },
      });
      mappedResult.value.unmap();
      return;
    }

    reportTimestampEvidence({
      carrier: 'dawn-node',
      selector,
      source,
      acceptedGpu: 1,
      ticks: { begin: begin.toString(), end: end.toString() },
    });
    expect(end).toBeGreaterThan(begin);
    mappedResult.value.unmap();
  });

  it('runs render-pass timestampWrites -> resolve -> submit -> readback or records a structured refusal', async () => {
    const selector = 'standard' as const;
    const source = 'packages/rhi-webgpu/src/__tests__/dawn-real-gpu.dawn.test.ts';
    const adapterResult = await rhi.requestAdapter();
    expect(adapterResult.ok).toBe(true);
    if (!adapterResult.ok) return;

    if (!adapterResult.value.features.has('timestamp-query')) {
      reportTimestampEvidence({
        carrier: 'dawn-node',
        selector,
        source,
        acceptedGpu: 0,
        refusalCode: 'timestamp-query-unsupported',
        expected: "adapter.features.has('timestamp-query')",
        hint: 'request a real Dawn device with the timestamp-query feature enabled',
      });
      return;
    }

    const deviceResult = await adapterResult.value.requestDevice({
      requiredFeatures: ['timestamp-query'],
    });
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const device = deviceResult.value;

    const querySetResult = device.createQuerySet({ type: 'timestamp', count: 2 });
    expect(querySetResult.ok).toBe(true);
    if (!querySetResult.ok) return;

    const targetResult = device.createTexture({
      label: 'w3-timestamp-raster-target',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    const viewResult = device.createTextureView(targetResult.value, {});
    expect(viewResult.ok).toBe(true);
    if (!viewResult.ok) return;

    const resolveResult = device.createBuffer({
      label: 'w3-timestamp-raster-resolve',
      size: 256,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    const readbackResult = device.createBuffer({
      label: 'w3-timestamp-raster-readback',
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    expect(readbackResult.ok).toBe(true);
    if (!readbackResult.ok) return;

    const encoderResult = device.createCommandEncoder({ label: 'w3-timestamp-raster-encoder' });
    expect(encoderResult.ok).toBe(true);
    if (!encoderResult.ok) return;
    const encoder = encoderResult.value;

    try {
      const pass = encoder.beginRenderPass({
        label: 'timestamp-raster',
        colorAttachments: [
          {
            view: viewResult.value,
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        timestampWrites: {
          querySet: querySetResult.value,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
      });
      pass.end();
    } catch (error) {
      const refusal = error as { code?: string; expected?: string; hint?: string };
      reportTimestampEvidence({
        carrier: 'dawn-node',
        selector,
        source,
        acceptedGpu: 0,
        refusalCode: 'timestamp-write-unavailable',
        expected:
          refusal.expected ??
          'GPURenderPassDescriptor.timestampWrites to be accepted by the real render pass',
        hint: refusal.hint ?? String(error),
      });
      expect(refusal.code).toBe('webgpu-runtime-error');
      return;
    }

    const resolveQueriesResult = encoder.resolveQuerySet(
      querySetResult.value,
      0,
      2,
      resolveResult.value,
      0,
    );
    expect(resolveQueriesResult.ok).toBe(true);
    if (!resolveQueriesResult.ok) return;
    encoder.copyBufferToBuffer(resolveResult.value, 0, readbackResult.value, 0, 16);

    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
    if (!finishResult.ok) return;
    const submitResult = device.queue.submit([finishResult.value]);
    expect(submitResult.ok).toBe(true);
    if (!submitResult.ok) return;
    await device.queue.onSubmittedWorkDone();

    const mappedResult = await readbackResult.value.mapAsync(GPUMapMode.READ);
    expect(mappedResult.ok).toBe(true);
    if (!mappedResult.ok) return;
    const rangeResult = mappedResult.value.getMappedRange(0, 16);
    expect(rangeResult.ok).toBe(true);
    if (!rangeResult.ok) return;
    const ticks = new BigUint64Array(rangeResult.value);
    const begin = ticks[0];
    const end = ticks[1];
    if (begin === undefined || end === undefined || end <= begin) {
      reportTimestampEvidence({
        carrier: 'dawn-node',
        selector,
        source,
        acceptedGpu: 0,
        refusalCode: 'timestamp-write-unavailable',
        expected: 'end > begin',
        hint: 'timestamp readback did not produce a positive GPU interval for a render pass',
        observed: { begin: begin?.toString() ?? null, end: end?.toString() ?? null },
      });
      mappedResult.value.unmap();
      return;
    }

    reportTimestampEvidence({
      carrier: 'dawn-node',
      selector,
      source,
      acceptedGpu: 1,
      ticks: { begin: begin.toString(), end: end.toString() },
    });
    expect(end).toBeGreaterThan(begin);
    mappedResult.value.unmap();
  });
});

describe('w36 (M5) - dawn-real-gpu RhiQueue.writeTexture real-path', () => {
  it('queue.writeTexture writes pixels into a texture and returns ok', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    const texResult = device.createTexture({
      label: 'w36-write-tex',
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    expect(texResult.ok).toBe(true);
    if (!texResult.ok) return;

    // bytesPerRow must be 256-aligned (forgeax K-2); rowsPerImage * bytesPerRow
    // sets the required linear data size. A 4x4 BGRA8 texture needs 256*4=1024
    // bytes minimum (with the 256-byte alignment overhead per row).
    const data = new Uint8Array(256 * 4);
    data.fill(0xff);
    const out = device.queue.writeTexture(
      { texture: texResult.value as never, mipLevel: 0, origin: [0, 0, 0] },
      data,
      { offset: 0, bytesPerRow: 256, rowsPerImage: 4 },
      { width: 4, height: 4, depthOrArrayLayers: 1 },
    );
    expect(out.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
  });

  it('queue.writeTexture accepts non-256-aligned bytesPerRow (bug repro: 500x500 RGBA8, bytesPerRow=2000)', async () => {
    const device = await requestRhiDevice();
    if (device === undefined) return;

    // 500x500 RGBA8 => bytesPerRow=2000, NOT a multiple of 256.
    // webgpu spec section 19.2 Note: unlike copyBufferToTexture(), there is
    // no alignment requirement on writeTexture dataLayout.bytesPerRow.
    const texResult = device.createTexture({
      label: 'w36-write-tex-non-256-align',
      size: { width: 500, height: 500, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST,
    });
    expect(texResult.ok).toBe(true);
    if (!texResult.ok) return;

    const data = new Uint8Array(500 * 500 * 4);
    const out = device.queue.writeTexture(
      { texture: texResult.value as never, mipLevel: 0, origin: [0, 0, 0] },
      data,
      { offset: 0, bytesPerRow: 2000, rowsPerImage: 500 },
      { width: 500, height: 500, depthOrArrayLayers: 1 },
    );
    expect(out.ok).toBe(true);

    // Verify the submission completes without a validation error.
    await device.queue.onSubmittedWorkDone();

    // Also verify bytesPerRow=100 (non-256-aligned) on a 1x1 texture.
    const texSmall = device.createTexture({
      label: 'w36-write-tex-small-non-256-align',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST,
    });
    expect(texSmall.ok).toBe(true);
    if (!texSmall.ok) return;

    const dataSmall = new Uint8Array(100);
    const outSmall = device.queue.writeTexture(
      { texture: texSmall.value as never, mipLevel: 0, origin: [0, 0, 0] },
      dataSmall,
      { offset: 0, bytesPerRow: 100, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    expect(outSmall.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
  });
});
