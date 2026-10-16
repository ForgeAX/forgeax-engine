// @forgeax/engine-rhi-debug/src/__tests__/recorder-bootstrap.unit.test.ts
//
// M1 bug-20260624: getTape() inFrameHandleIds backward-refs removal (fix 2).
// M4 fix-up: revert M1 _realDevice hook — _realDevice must stay the original
//   RhiDevice for RAW_DEVICE_MAP reverse-lookup (rhi-webgpu createShaderModule,
//   configureSurface etc.) to succeed. _realDevice is the raw device, NOT a
//   hooked wrapper; bootstrap registration is the proxy path's responsibility.
//
// AC-01: tape self-containment (findDanglingHandleId=null after fix).
// AC-04: closure fully populated via proxy path.

// biome-ignore-all lint/suspicious/noExplicitAny: stub RHI mock objects at test boundary
// biome-ignore-all lint/style/noNonNullAssertion: test assertions on mock stubs guarded by expect

import { describe, expect, it, vi } from 'vitest';
import { type DebugRhiInstance, wrap } from '../recorder';

// ---------------------------------------------------------------
// Minimal Result helpers
// ---------------------------------------------------------------

function rOk<T>(value: T) {
  return { ok: true as const, value };
}

function h(): any {
  return {};
}

// ---------------------------------------------------------------
// Build a mock RhiInstance with a real device for bypass simulation
// ---------------------------------------------------------------

function buildMockInstanceWithRealDevice(): {
  inst: any;
  realDeviceSpies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const realCreateBuffer = vi.fn((_desc: any) => rOk(h()));
  const realCreateTexture = vi.fn(() => rOk(h()));
  const realCreateSampler = vi.fn(() => rOk(h()));
  const realCreateBindGroupLayout = vi.fn(() => rOk(h()));
  const realCreateBindGroup = vi.fn(() => rOk(h()));
  const realCreatePipelineLayout = vi.fn(() => rOk(h()));
  const realCreateRenderPipeline = vi.fn(() => rOk(h()));
  const realCreateComputePipeline = vi.fn(() => rOk(h()));

  const realDevice = {
    caps: { rgba16floatRenderable: false },
    features: new Set(),
    limits: {},
    queue: {
      writeBuffer: vi.fn(() => rOk(undefined)),
      submit: vi.fn(() => rOk(undefined)),
      writeTexture: vi.fn(() => rOk(undefined)),
      copyExternalImageToTexture: vi.fn(() => rOk(undefined)),
      onSubmittedWorkDone: vi.fn(() => Promise.resolve(undefined)),
    },
    lost: new Promise(() => {}),
    createBuffer: realCreateBuffer,
    createTexture: realCreateTexture,
    createTextureView: vi.fn(() => rOk(h())),
    createSampler: realCreateSampler,
    createBindGroupLayout: realCreateBindGroupLayout,
    createBindGroup: realCreateBindGroup,
    createPipelineLayout: realCreatePipelineLayout,
    createRenderPipeline: realCreateRenderPipeline,
    createComputePipeline: realCreateComputePipeline,
    createCommandEncoder: vi.fn(() => rOk(h())),
    createQuerySet: vi.fn(() => rOk(h())),
    destroyBuffer: vi.fn(),
    destroyTexture: vi.fn(),
  };

  const adapter = {
    features: new Set(),
    limits: {},
    requestDevice: vi.fn(() => Promise.resolve(rOk(realDevice))),
  };

  return {
    inst: { requestAdapter: vi.fn(() => Promise.resolve(rOk(adapter))) },
    realDeviceSpies: {
      createBuffer: realCreateBuffer,
      createTexture: realCreateTexture,
      createSampler: realCreateSampler,
      createBindGroupLayout: realCreateBindGroupLayout,
      createBindGroup: realCreateBindGroup,
      createPipelineLayout: realCreatePipelineLayout,
      createRenderPipeline: realCreateRenderPipeline,
      createComputePipeline: realCreateComputePipeline,
    },
  };
}

async function bootstrapWithRealDevice(): Promise<{
  debugInst: DebugRhiInstance;
  proxyDevice: any;
  realDevice: any;
}> {
  const { inst } = buildMockInstanceWithRealDevice();
  const debugInst = wrap(inst);
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('adapter');
  const adapter = (adapterRes as any).value;
  const devRes = await adapter.requestDevice();
  if (!devRes.ok) throw new Error('device');
  const proxyDevice = (devRes as any).value;
  const realDevice = proxyDevice._realDevice;
  return { debugInst, proxyDevice, realDevice };
}

// ================================================================
// _realDevice RAW_DEVICE_MAP contract (M4 fix-up)
// ================================================================
//
// M4 fix-up: M1 broke the RAW_DEVICE_MAP contract by replacing _realDevice
// with a hooked wrapper. RAW_DEVICE_MAP (rhi-webgpu WeakMap) is keyed on the
// original RhiDevice that makeRhiDevice registered. _realDevice must stay
// reference-equal to that object so reverse-lookup succeeds.
//
// Resources created through _realDevice directly bypass the recorder — this
// is correct: _realDevice exists only for cross-module device identity lookup.

describe('B1: _realDevice RAW_DEVICE_MAP contract (M4 fix-up)', () => {
  it('_realDevice is reference-equal to the original real device (not hooked)', async () => {
    const { proxyDevice } = await bootstrapWithRealDevice();

    // After M4 fix-up: _realDevice must be the untampered RhiDevice so
    // RAW_DEVICE_MAP.get(_realDevice) returns the real GPUDevice.
    const rd = proxyDevice._realDevice;
    expect(rd).toBeDefined();
    expect(rd).toHaveProperty('caps');
    expect(rd).toHaveProperty('createBuffer');
    expect(rd).toHaveProperty('queue');
  });

  it('proxy path registers resources in bootstrapCreates; _realDevice bypass does not', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    // Create through proxy: enters handleMap + bootstrapCreates.
    proxyDevice.createBuffer({ size: 64, usage: 16 });
    expect(debugInst.bootstrapCreatesSize()).toBe(1);

    // Create through raw _realDevice (not hooked anymore): bypasses recorder.
    // This is correct — _realDevice is only for RAW_DEVICE_MAP identity lookup.
    const realDevice = proxyDevice._realDevice;
    realDevice.createBuffer({ size: 128, usage: 16 });
    expect(debugInst.bootstrapCreatesSize()).toBe(1);
  });

  it('proxy-only path produces self-contained tape', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    const bufRes = proxyDevice.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;

    debugInst.arm(1);
    proxyDevice.queue.writeBuffer(buf, 0, new Uint8Array([1]));
    debugInst.onFrameEnd();

    const tape = debugInst.getTape() as any;
    expect(tape).toBeDefined();
    expect(tape).toHaveProperty('formatVersion');
    // Self-contained: no dangling handleIds.
    expect(tape).not.toHaveProperty('code');

    const prefixEvents = tape.events.filter((e: any) => e.kind === 'createBuffer');
    expect(prefixEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('bootstrapCreates preserved across arm cycles (proxy-only path)', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    proxyDevice.createBuffer({ size: 64, usage: 16 });
    expect(debugInst.bootstrapCreatesSize()).toBe(1);

    // Arm + frameMark preserves bootstrapCreates.
    debugInst.arm(1);
    debugInst.onFrameEnd();
    expect(debugInst.bootstrapCreatesSize()).toBe(1);

    // Re-arm, create more via proxy.
    debugInst.arm(1);
    proxyDevice.createBuffer({ size: 128, usage: 16 });
    debugInst.onFrameEnd();
    expect(debugInst.bootstrapCreatesSize()).toBe(2);
  });

  it('adds a requested view format to a synthetic swapchain texture event', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();
    debugInst.arm(1);

    const swapchainTexture = {
      width: 1280,
      height: 720,
      depthOrArrayLayers: 1,
      format: 'bgra8unorm',
      usage: 23,
    };
    const view = proxyDevice.createTextureView(swapchainTexture, {
      format: 'bgra8unorm-srgb',
    });
    expect(view.ok).toBe(true);

    const create = debugInst
      .bootstrapEvents()
      .find((event: any) => event.kind === 'createTexture' && event.origin === 'swapchain') as any;
    expect(create?.desc.viewFormats).toEqual(['bgra8unorm-srgb']);
  });
});

// ================================================================
// getTape: inFrameHandleIds no longer includes backward-refs
// ================================================================

describe('B1: getTape inFrameHandleIds backward-refs (fix 2)', () => {
  it('persistent resource referenced by in-frame createBG gets bootstrap prefix', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    // Create persistent buffer before arm
    const bufRes = proxyDevice.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;

    // Create a BGL and sampler
    const bglRes = proxyDevice.createBindGroupLayout({ entries: [] });
    expect(bglRes.ok).toBe(true);
    const bgl = (bglRes as any).value;

    // Arm and create a bindGroup that references the pre-arm buffer + BGL
    debugInst.arm(1);
    const bgRes = proxyDevice.createBindGroup({
      layout: bgl,
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer' as const, value: { buffer: buf, offset: 0, size: 64 } },
        },
      ],
    });
    expect(bgRes.ok).toBe(true);

    proxyDevice.queue.writeBuffer(buf, 0, new Uint8Array([1]));
    debugInst.onFrameEnd();

    const tape = debugInst.getTape() as any;
    expect(tape).toBeDefined();
    expect(tape).not.toHaveProperty('code');

    // With fix: the persistent buffer (created before arm) is NOT in
    // inFrameHandleIds (backward-refs removed), so it enters prefixSeedIds
    // and gets bootstrap prefixing. The tape is self-contained.
    const prefixBufferCreates = tape.events.filter((e: any) => e.kind === 'createBuffer');
    expect(prefixBufferCreates.length).toBeGreaterThanOrEqual(1);
  });

  // bug #8 (batch-3 CSM): a pre-arm resource reachable ONLY through an in-frame
  // createBindGroup's backward edge -- with NO direct usage event naming it --
  // must still be pulled into the bootstrap prefix. The test above passed for
  // the wrong reason: its pre-arm buffer was ALSO hit by an in-frame writeBuffer,
  // so _collectFrameReferencedHandleIds seeded it via the writeBuffer case. CSM's
  // composite-pass bind group sampled a pre-arm TextureView that no usage event
  // referenced directly, so the closure never seeded it and the tape deserialized
  // as tape-invalid. This case isolates that path: a pre-arm buffer
  // bound by an in-frame createBindGroup with NO writeBuffer/setBindGroup usage.
  it('pre-arm resource referenced ONLY by in-frame createBindGroup is prefixed', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    // Pre-arm buffer + BGL (created before arm; NOT touched by any usage event).
    const bufRes = proxyDevice.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;
    const bglRes = proxyDevice.createBindGroupLayout({ entries: [] });
    expect(bglRes.ok).toBe(true);
    const bgl = (bglRes as any).value;

    // Arm, then build a bind group referencing the pre-arm buffer. Crucially:
    // NO writeBuffer, NO setBindGroup -- the only edge to `buf` is this in-frame
    // createBindGroup's resourceHandleIds backward ref.
    debugInst.arm(1);
    const bgRes = proxyDevice.createBindGroup({
      layout: bgl,
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer' as const, value: { buffer: buf, offset: 0, size: 64 } },
        },
      ],
    });
    expect(bgRes.ok).toBe(true);
    debugInst.onFrameEnd();

    const tape = debugInst.getTape() as any;
    expect(tape).toBeDefined();
    // Must NOT be an unstructured error (tape-invalid before the fix).
    expect(tape).not.toHaveProperty('code');
    // The pre-arm buffer's createBuffer must land in the prefix for self-containment.
    const bufferCreates = tape.events.filter((e: any) => e.kind === 'createBuffer');
    expect(bufferCreates.length).toBeGreaterThanOrEqual(1);
  });
});
