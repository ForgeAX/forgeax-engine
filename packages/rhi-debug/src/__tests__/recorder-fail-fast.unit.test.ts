// @forgeax/engine-rhi-debug/src/__tests__/recorder-fail-fast.unit.test.ts
//
// M2 bug-20260624: B2 fail-fast convergence —
// getTape() dangling detection mirrors deserializeTape's findDanglingHandleId.
//
// AC-04: producer-side fail-fast — getTape() returns tape-invalid
//        for any handle that findDanglingHandleId would reject.
// AC-23: reuses the closed v7 tape error, no new member.
// R-3:   in-frame transient handles (passHandleId, cmdHandleId) not
//        falsely flagged when legitimately declared.

// biome-ignore-all lint/suspicious/noExplicitAny: stub RHI mock objects at test boundary
// biome-ignore-all lint/style/noNonNullAssertion: test assertions on mock stubs guarded by expect

import { describe, expect, it, vi } from 'vitest';
import type { RhiDebugError } from '../errors';
import { type DebugRhiInstance, wrap } from '../recorder';
import type { HandleId } from '../types';

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
// Build a mock RhiInstance with a proxied device
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

  function makeCmdEncoder(): any {
    const e: any = {};
    const realPass = makeRenderPass();
    const realCPass = makeComputePass();
    e.beginRenderPass = vi.fn(() => realPass);
    e.beginComputePass = vi.fn(() => realCPass);
    e.copyBufferToBuffer = vi.fn();
    e.copyBufferToTexture = vi.fn();
    e.copyTextureToBuffer = vi.fn();
    e.copyTextureToTexture = vi.fn();
    e.clearBuffer = vi.fn();
    e.resolveQuerySet = vi.fn(() => rOk(undefined));
    e.pushDebugGroup = vi.fn();
    e.popDebugGroup = vi.fn();
    e.insertDebugMarker = vi.fn();
    e.finish = vi.fn(() => rOk(h()));
    return e;
  }

  function makeRenderPass(): any {
    return {
      setPipeline: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      setViewport: vi.fn(),
      setScissorRect: vi.fn(),
      setBlendConstant: vi.fn(),
      setStencilReference: vi.fn(),
      drawIndirect: vi.fn(),
      drawIndexedIndirect: vi.fn(),
      pushDebugGroup: vi.fn(),
      popDebugGroup: vi.fn(),
      insertDebugMarker: vi.fn(),
      executeBundles: vi.fn(),
      beginOcclusionQuery: vi.fn(),
      endOcclusionQuery: vi.fn(),
      end: vi.fn(),
    };
  }

  function makeComputePass(): any {
    return {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    };
  }

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
    createCommandEncoder: vi.fn(() => rOk(makeCmdEncoder())),
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
// B2: dangling handle detection — getTape fail-fast
// ================================================================

describe('B2: getTape dangling handle fail-fast (AC-04)', () => {
  it('returns tape-invalid for orphan passHandleId in endRenderPass', async () => {
    const { debugInst } = await bootstrapWithRealDevice();

    // Inject an endRenderPass event with a passHandleId that was
    // never declared by any beginRenderPass in the frame, and is not
    // in bootstrapCreates. This simulates a tape where a pass handle
    // is referenced but undeclared — findDanglingHandleId would reject
    // it. Before B2 convergence, _collectFrameReferencedHandleIds
    // ignores passHandleId from endRenderPass (it's not in the switch),
    // so getTape() would silently produce a tape that deserializeTape
    // later rejects.
    debugInst.arm(1);

    // Inject endRenderPass with an undeclared passHandleId directly
    // into the event stream via pushExternalEvent.
    const orphanPassId = 'renderPass:orphan' as HandleId;
    debugInst.pushExternalEvent({
      kind: 'endRenderPass',
      passHandleId: orphanPassId,
    } as any);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).toHaveProperty('code', 'tape-invalid');

    const error = tape as RhiDebugError;
    expect(error.code).toBe('tape-invalid');
    expect(error.detail).toMatchObject({ handleId: orphanPassId });
  });

  it('returns tape-invalid for orphan passHandleId in draw', async () => {
    const { debugInst } = await bootstrapWithRealDevice();

    debugInst.arm(1);

    const orphanPassId = 'renderPass:orphan' as HandleId;
    debugInst.pushExternalEvent({
      kind: 'draw',
      passHandleId: orphanPassId,
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    } as any);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).toHaveProperty('code', 'tape-invalid');
    const error = tape as RhiDebugError;
    expect(error.code).toBe('tape-invalid');
    expect(error.detail).toMatchObject({ handleId: orphanPassId });
  });

  it('returns tape-invalid for orphan cmdHandleId in finish', async () => {
    const { debugInst } = await bootstrapWithRealDevice();

    debugInst.arm(1);

    const orphanCmdId = 'commandEncoder:orphan' as HandleId;
    debugInst.pushExternalEvent({
      kind: 'finish',
      cmdHandleId: orphanCmdId,
    } as any);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).toHaveProperty('code', 'tape-invalid');
    const error = tape as RhiDebugError;
    expect(error.code).toBe('tape-invalid');
    expect(error.detail).toMatchObject({ handleId: orphanCmdId });
  });

  it('returns tape-invalid for orphan cmdHandleId in submit', async () => {
    const { debugInst } = await bootstrapWithRealDevice();

    debugInst.arm(1);

    const orphanCmdId = 'commandEncoder:orphan' as HandleId;
    debugInst.pushExternalEvent({
      kind: 'submit',
      cmdHandleIds: [orphanCmdId],
    } as any);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).toHaveProperty('code', 'tape-invalid');
    const error = tape as RhiDebugError;
    expect(error.code).toBe('tape-invalid');
    expect(error.detail).toMatchObject({ handleId: orphanCmdId });
  });

  it('returns tape-invalid for orphan cmdHandleId in beginRenderPass', async () => {
    const { debugInst } = await bootstrapWithRealDevice();

    debugInst.arm(1);

    const orphanCmdId = 'commandEncoder:orphan' as HandleId;
    debugInst.pushExternalEvent({
      kind: 'beginRenderPass',
      cmdHandleId: orphanCmdId,
      passHandleId: 'renderPass:valid' as HandleId,
      colorAttachmentViewHandleIds: [],
      desc: { colorAttachments: [] },
    } as any);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).toHaveProperty('code', 'tape-invalid');
    const error = tape as RhiDebugError;
    expect(error.code).toBe('tape-invalid');
    expect(error.detail).toMatchObject({ handleId: orphanCmdId });
  });

  it('returns tape-invalid for orphan handle in setPipeline', async () => {
    const { debugInst } = await bootstrapWithRealDevice();

    debugInst.arm(1);

    // passHandleId + pipelineHandleId both undeclared.
    const orphanPassId = 'renderPass:orphan' as HandleId;
    debugInst.pushExternalEvent({
      kind: 'setPipeline',
      passHandleId: orphanPassId,
      pipelineHandleId: 'renderPipeline:ghost' as HandleId,
    } as any);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).toHaveProperty('code', 'tape-invalid');
    const error = tape as RhiDebugError;
    expect(error.code).toBe('tape-invalid');
  });

  it('returns tape-invalid for orphan handle in pushDebugGroup', async () => {
    const { debugInst } = await bootstrapWithRealDevice();

    debugInst.arm(1);

    const orphanCmdId = 'commandEncoder:orphan' as HandleId;
    debugInst.pushExternalEvent({
      kind: 'pushDebugGroup',
      cmdHandleId: orphanCmdId,
      groupLabel: 'test',
    } as any);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).toHaveProperty('code', 'tape-invalid');
    const error = tape as RhiDebugError;
    expect(error.code).toBe('tape-invalid');
    expect(error.detail).toMatchObject({ handleId: orphanCmdId });
  });
});

// ================================================================
// B2: known-good paths — not falsely flagging
// ================================================================

describe('B2: legitimate tape production (known-good paths)', () => {
  it('returns a valid Tape when all references resolve through bootstrapCreates', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    // Pre-arm resource creation.
    const bufRes = proxyDevice.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;

    debugInst.arm(1);
    proxyDevice.queue.writeBuffer(buf, 0, new Uint8Array([1]));
    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).not.toHaveProperty('code');
    expect(tape).toHaveProperty('events');
  });

  it('does not flag handles declared in-frame by create* events', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    // All resources created in-frame (after arm) — their create* events
    // are part of the frame's event stream and should be self-sufficient.
    debugInst.arm(1);
    const bufRes = proxyDevice.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    proxyDevice.queue.writeBuffer((bufRes as any).value, 0, new Uint8Array([1]));
    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).not.toHaveProperty('code');
    expect(tape).toHaveProperty('events');
  });
});

// ================================================================
// R-3: in-frame transient handle exemption (anti-regression)
// ================================================================

describe('B2: R-3 in-frame transient handle exemption (anti-regression)', () => {
  it('does not falsely flag pass+capture chain from real proxy', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    // Full proxy chain: createCommandEncoder → beginRenderPass → ... → end → finish → submit.
    // All passHandleId and cmdHandleId are properly declared in-frame.
    debugInst.arm(1);

    const cmdEncRes = proxyDevice.createCommandEncoder();
    expect(cmdEncRes.ok).toBe(true);
    const cmdEnc = (cmdEncRes as any).value;

    const pass = cmdEnc.beginRenderPass({
      colorAttachments: [],
    });

    pass.setViewport(0, 0, 800, 600, 0, 1);
    pass.setScissorRect(0, 0, 800, 600);
    pass.end();

    const cmdBufRes = cmdEnc.finish();
    expect(cmdBufRes.ok).toBe(true);
    const cmdBuf = (cmdBufRes as any).value;

    proxyDevice.queue.submit([cmdBuf]);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).not.toHaveProperty('code');
    expect(tape).toHaveProperty('events');
  });

  it('does not falsely flag popDebugGroup/insertDebugMarker/finish referencing in-frame cmdHandleId', async () => {
    const { debugInst, proxyDevice } = await bootstrapWithRealDevice();

    debugInst.arm(1);

    const cmdEncRes = proxyDevice.createCommandEncoder();
    expect(cmdEncRes.ok).toBe(true);
    const cmdEnc = (cmdEncRes as any).value;

    cmdEnc.pushDebugGroup('test');
    cmdEnc.popDebugGroup();
    cmdEnc.insertDebugMarker('marker');

    const cmdBufRes = cmdEnc.finish();
    expect(cmdBufRes.ok).toBe(true);
    const cmdBuf = (cmdBufRes as any).value;

    proxyDevice.queue.submit([cmdBuf]);

    debugInst.onFrameEnd();

    const tape = debugInst.getTape();
    expect(tape).not.toHaveProperty('code');
    expect(tape).toHaveProperty('events');
  });
});
