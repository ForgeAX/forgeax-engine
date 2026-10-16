// @forgeax/engine-rhi-debug/src/__tests__/recorder-push-event.unit.test.ts
//
// M3 w8: RED-phase unit tests for recorder proxy pushEvent completeness.
// Verifies that all 16 commands (7 silent pass-through + 3 encoder-level
// debug group + 6 new events) produce correct event kinds in the tape.
// Currently RED because proxy methods in recorder.ts do not pushEvent for
// these 16 commands (w10 adds them).
//
// AC-03: 7 silent pass-through commands each emit correct event kind.
// AC-04: 3 encoder-level debug group commands each emit correct event kind.
// AC-05: 6 new events each emit correct event kind; indirect events assert
//        indirectBufferHandleId is present in event payload.
//
// Related: requirements AC-03/AC-04/AC-05; plan-strategy 5.1 TDD;
// research Finding 1/2/3.

// biome-ignore-all lint/suspicious/noExplicitAny: test stubs for recorder proxy exercise need mock RHI types at the boundary; RhiCallEvent/RhiRenderPassEncoder/RhiCommandEncoder are structural shapes that vi.fn() stubs cannot type-narrow without any
// biome-ignore-all lint/style/noNonNullAssertion: test assertions on tape event arrays are guarded by expect.length checks before indexed access

import { describe, expect, it, vi } from 'vitest';
import { type DebugRhiInstance, wrap } from '../recorder';
import type {
  RhiCallEvent,
  RhiCallEventClearBuffer,
  RhiCallEventCopyBufferToBuffer,
  RhiCallEventDrawIndexedIndirect,
  RhiCallEventDrawIndirect,
  RhiCallEventInsertDebugMarker,
  RhiCallEventPassInsertDebugMarker,
  RhiCallEventPassPushDebugGroup,
  RhiCallEventPushDebugGroup,
  RhiCallEventSetBlendConstant,
  RhiCallEventSetScissorRect,
  RhiCallEventSetViewport,
} from '../types';

// ============================================================================
// Helpers
// ============================================================================

function rOk<T>(value: T) {
  return { ok: true as const, value };
}

/**
 * Build a mock RhiInstance with all RHI encoder/pass methods stubbed so the
 * recorder proxy can exercise the full encoder + render pass surface without
 * a real GPU device. Uses any casts at the RhiInstance boundary since mock
 * Result objects lack the prototype-level unwrap/unwrapOr methods.
 */
async function buildMockAndArm(): Promise<{
  debugInst: DebugRhiInstance;
  proxyDevice: any;
}> {
  function makeMockRenderPass(): any {
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
      end: vi.fn(),
      beginOcclusionQuery: vi.fn(),
      endOcclusionQuery: vi.fn(),
      executeBundles: vi.fn(),
    };
  }

  function makeMockComputePass(): any {
    return {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    };
  }

  const mockCmdEncoder: any = {
    beginRenderPass: vi.fn((_desc: any) => makeMockRenderPass()),
    beginComputePass: vi.fn((_desc?: any) => makeMockComputePass()),
    copyBufferToBuffer: vi.fn(),
    copyBufferToTexture: vi.fn(),
    copyTextureToBuffer: vi.fn(),
    copyTextureToTexture: vi.fn(),
    clearBuffer: vi.fn(),
    pushDebugGroup: vi.fn(),
    popDebugGroup: vi.fn(),
    insertDebugMarker: vi.fn(),
    finish: vi.fn(() => rOk({})),
  };

  const mockDevice: any = {
    caps: { rgba16floatRenderable: false },
    features: new Set(),
    limits: {},
    queue: {
      writeBuffer: vi.fn(() => rOk(undefined)),
      writeTexture: vi.fn(() => rOk(undefined)),
      submit: vi.fn(() => rOk(undefined)),
      copyExternalImageToTexture: vi.fn(() => rOk(undefined)),
      onSubmittedWorkDone: vi.fn(() => Promise.resolve(undefined)),
    },
    lost: new Promise(() => {}),
    createBuffer: vi.fn(() => rOk({})),
    createTexture: vi.fn(() => rOk({})),
    createTextureView: vi.fn(() => rOk({})),
    createSampler: vi.fn(() => rOk({})),
    createBindGroupLayout: vi.fn(() => rOk({})),
    createBindGroup: vi.fn(() => rOk({})),
    createPipelineLayout: vi.fn(() => rOk({})),
    createRenderPipeline: vi.fn(() => rOk({})),
    createComputePipeline: vi.fn(() => rOk({})),
    createShaderModule: vi.fn(() => rOk({})),
    createCommandEncoder: vi.fn(() => rOk(mockCmdEncoder)),
    createQuerySet: vi.fn(() => rOk({})),
    destroyBuffer: vi.fn(),
    destroyTexture: vi.fn(),
  };

  const mockAdapter: any = {
    features: new Set(),
    limits: {},
    requestDevice: vi.fn(() => Promise.resolve(rOk(mockDevice))),
  };

  const mockInst: any = {
    requestAdapter: vi.fn(() => Promise.resolve(rOk(mockAdapter))),
  };

  const debugInst = wrap(mockInst);
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('mock adapter failed');
  const adapter = (adapterRes as any).value;
  const devRes = await adapter.requestDevice();
  if (!devRes.ok) throw new Error('mock device failed');
  const proxyDevice = (devRes as any).value;

  // Arm for 1 frame so pushEvent gate passes
  debugInst.arm(1);

  return { debugInst, proxyDevice };
}

/**
 * Record one frame and return the tape events array.
 */
function finalizeAndGetEvents(debugInst: DebugRhiInstance): readonly RhiCallEvent[] {
  debugInst.onFrameEnd();
  const tape = debugInst.getTape() as any;
  if (tape?.events) return tape.events as readonly RhiCallEvent[];
  throw new Error('getTape() returned no events');
}

function findEventsOfKind(events: readonly RhiCallEvent[], kind: string): RhiCallEvent[] {
  return events.filter((e) => e.kind === kind);
}

// ============================================================================
// AC-03: 7 silent pass-through commands
// ============================================================================

describe('w8: AC-03 silent pass-through commands (7 total)', () => {
  it('copyBufferToBuffer pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const bufResA = proxyDevice.createBuffer({ size: 16, usage: 1 });
    const bufResB = proxyDevice.createBuffer({ size: 16, usage: 2 });
    expect(bufResA.ok).toBe(true);
    expect(bufResB.ok).toBe(true);
    const bufA = (bufResA as any).value;
    const bufB = (bufResB as any).value;

    enc.copyBufferToBuffer(bufA, 0, bufB, 0, 16);
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const copyEvents = findEventsOfKind(events, 'copyBufferToBuffer');
    expect(copyEvents.length).toBe(1);
    const ev = copyEvents[0] as RhiCallEventCopyBufferToBuffer;
    expect(ev.sourceHandleId).toBeDefined();
    expect(ev.destinationHandleId).toBeDefined();
    expect(ev.size).toBe(16);
  });

  it('copyBufferToTexture pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const bufRes = proxyDevice.createBuffer({ size: 64, usage: 1 });
    const texRes = proxyDevice.createTexture({
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: 8,
    });
    expect(bufRes.ok).toBe(true);
    expect(texRes.ok).toBe(true);
    const buf = (bufRes as any).value;
    const tex = (texRes as any).value;

    enc.copyBufferToTexture(
      { buffer: buf, bytesPerRow: 16, rowsPerImage: 4 },
      { texture: tex, mipLevel: 0 },
      { width: 4, height: 4 },
    );
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const copyEvents = findEventsOfKind(events, 'copyBufferToTexture');
    expect(copyEvents.length).toBe(1);
  });

  it('copyTextureToBuffer pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const texRes = proxyDevice.createTexture({
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: 9,
    });
    const bufRes = proxyDevice.createBuffer({ size: 64, usage: 2 });
    expect(texRes.ok).toBe(true);
    expect(bufRes.ok).toBe(true);
    const tex = (texRes as any).value;
    const buf = (bufRes as any).value;

    enc.copyTextureToBuffer(
      { texture: tex, mipLevel: 0 },
      { buffer: buf, bytesPerRow: 16, rowsPerImage: 4 },
      { width: 4, height: 4 },
    );
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const copyEvents = findEventsOfKind(events, 'copyTextureToBuffer');
    expect(copyEvents.length).toBe(1);
  });

  it('copyTextureToTexture pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const texResA = proxyDevice.createTexture({
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: 9,
    });
    const texResB = proxyDevice.createTexture({
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: 8,
    });
    expect(texResA.ok).toBe(true);
    expect(texResB.ok).toBe(true);
    const texA = (texResA as any).value;
    const texB = (texResB as any).value;

    enc.copyTextureToTexture(
      { texture: texA, mipLevel: 0 },
      { texture: texB, mipLevel: 0 },
      { width: 4, height: 4 },
    );
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const copyEvents = findEventsOfKind(events, 'copyTextureToTexture');
    expect(copyEvents.length).toBe(1);
  });

  it('clearBuffer pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const bufRes = proxyDevice.createBuffer({ size: 64, usage: 1 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;

    enc.clearBuffer(buf, 0, 64);
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const clearEvents = findEventsOfKind(events, 'clearBuffer');
    expect(clearEvents.length).toBe(1);
    const ev = clearEvents[0] as RhiCallEventClearBuffer;
    expect(ev.handleId).toBeDefined();
  });

  it('setViewport pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const pass = enc.beginRenderPass({
      colorAttachments: [],
    });
    pass.setViewport(0, 0, 800, 600, 0, 1);
    pass.end();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const vpEvents = findEventsOfKind(events, 'setViewport');
    expect(vpEvents.length).toBe(1);
    const ev = vpEvents[0] as RhiCallEventSetViewport;
    expect(ev.w).toBe(800);
    expect(ev.h).toBe(600);
  });

  it('setScissorRect pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const pass = enc.beginRenderPass({
      colorAttachments: [],
    });
    pass.setScissorRect(0, 0, 800, 600);
    pass.end();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const scEvents = findEventsOfKind(events, 'setScissorRect');
    expect(scEvents.length).toBe(1);
    const ev = scEvents[0] as RhiCallEventSetScissorRect;
    expect(ev.w).toBe(800);
    expect(ev.h).toBe(600);
  });
});

// ============================================================================
// AC-04: 3 encoder-level debug group commands
// ============================================================================

describe('w8: AC-04 encoder-level debug group (3 total)', () => {
  it('pushDebugGroup on encoder produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    enc.pushDebugGroup('test-group');
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const pdgEvents = findEventsOfKind(events, 'pushDebugGroup');
    expect(pdgEvents.length).toBe(1);
    const ev = pdgEvents[0] as RhiCallEventPushDebugGroup;
    expect(ev.groupLabel).toBe('test-group');
  });

  it('popDebugGroup on encoder produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    enc.popDebugGroup();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const pdgEvents = findEventsOfKind(events, 'popDebugGroup');
    expect(pdgEvents.length).toBe(1);
  });

  it('insertDebugMarker on encoder produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    enc.insertDebugMarker('marker-1');
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const idmEvents = findEventsOfKind(events, 'insertDebugMarker');
    expect(idmEvents.length).toBe(1);
    const ev = idmEvents[0] as RhiCallEventInsertDebugMarker;
    expect(ev.markerLabel).toBe('marker-1');
  });
});

// ============================================================================
// AC-05: 6 new events
// ============================================================================

describe('w8: AC-05 new events (6 total)', () => {
  it('setBlendConstant pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const pass = enc.beginRenderPass({
      colorAttachments: [],
    });
    pass.setBlendConstant([0.1, 0.2, 0.3, 0.4]);
    pass.end();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const bcEvents = findEventsOfKind(events, 'setBlendConstant');
    expect(bcEvents.length).toBe(1);
    const ev = bcEvents[0] as RhiCallEventSetBlendConstant;
    expect(ev.color).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('drawIndirect pushEvent produces event kind + indirectBufferHandleId in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    // Create an indirect buffer
    const bufRes = proxyDevice.createBuffer({ size: 20, usage: 256 }); // INDIRECT
    expect(bufRes.ok).toBe(true);
    const indirectBuf = (bufRes as any).value;

    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const pass = enc.beginRenderPass({
      colorAttachments: [],
    });
    pass.drawIndirect(indirectBuf, 0);
    pass.end();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const diEvents = findEventsOfKind(events, 'drawIndirect');
    expect(diEvents.length).toBe(1);
    const ev = diEvents[0] as RhiCallEventDrawIndirect;
    expect(ev.indirectBufferHandleId).toBeDefined();
    expect(ev.indirectBufferHandleId.length).toBeGreaterThan(0);
    expect(ev.indirectOffset).toBe(0);
  });

  it('drawIndexedIndirect pushEvent produces event kind + indirectBufferHandleId in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const bufRes = proxyDevice.createBuffer({ size: 20, usage: 256 }); // INDIRECT
    expect(bufRes.ok).toBe(true);
    const indirectBuf = (bufRes as any).value;

    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const pass = enc.beginRenderPass({
      colorAttachments: [],
    });
    pass.drawIndexedIndirect(indirectBuf, 0);
    pass.end();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const diiEvents = findEventsOfKind(events, 'drawIndexedIndirect');
    expect(diiEvents.length).toBe(1);
    const ev = diiEvents[0] as RhiCallEventDrawIndexedIndirect;
    expect(ev.indirectBufferHandleId).toBeDefined();
    expect(ev.indirectBufferHandleId.length).toBeGreaterThan(0);
    expect(ev.indirectOffset).toBe(0);
  });

  it('passPushDebugGroup pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const pass = enc.beginRenderPass({
      colorAttachments: [],
    });
    pass.pushDebugGroup('pass-group');
    pass.end();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const ppdgEvents = findEventsOfKind(events, 'passPushDebugGroup');
    expect(ppdgEvents.length).toBe(1);
    const ev = ppdgEvents[0] as RhiCallEventPassPushDebugGroup;
    expect(ev.groupLabel).toBe('pass-group');
    expect(ev.passHandleId).toBeDefined();
  });

  it('passPopDebugGroup pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const pass = enc.beginRenderPass({
      colorAttachments: [],
    });
    pass.popDebugGroup();
    pass.end();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const ppdgEvents = findEventsOfKind(events, 'passPopDebugGroup');
    expect(ppdgEvents.length).toBe(1);
  });

  it('passInsertDebugMarker pushEvent produces event kind in tape', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const encRes = proxyDevice.createCommandEncoder();
    expect(encRes.ok).toBe(true);
    const enc = (encRes as any).value;

    const pass = enc.beginRenderPass({
      colorAttachments: [],
    });
    pass.insertDebugMarker('pass-marker');
    pass.end();
    const finishRes = enc.finish();
    expect(finishRes.ok).toBe(true);
    proxyDevice.queue.submit([finishRes.value]);

    const events = finalizeAndGetEvents(debugInst);
    const pidmEvents = findEventsOfKind(events, 'passInsertDebugMarker');
    expect(pidmEvents.length).toBe(1);
    const ev = pidmEvents[0] as RhiCallEventPassInsertDebugMarker;
    expect(ev.markerLabel).toBe('pass-marker');
    expect(ev.passHandleId).toBeDefined();
  });
});

describe('writeTexture blob capture', () => {
  it('records exactly the uploaded subarray of a packed mip chain', async () => {
    const { debugInst, proxyDevice } = await buildMockAndArm();
    const tex = proxyDevice.createTexture({
      size: { width: 2, height: 2 },
      format: 'rgba8unorm',
      usage: 2,
      mipLevelCount: 2,
    }).value;
    const packed = new Uint8Array(20);
    packed.fill(1, 0, 16);
    packed.fill(9, 16, 20);
    proxyDevice.queue.writeTexture(
      { texture: tex, mipLevel: 0 },
      packed.subarray(0, 16),
      { offset: 0, bytesPerRow: 8, rowsPerImage: 2 },
      { width: 2, height: 2 },
    );
    proxyDevice.queue.writeTexture(
      { texture: tex, mipLevel: 1 },
      packed.subarray(16, 20),
      { offset: 0, bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1 },
    );
    debugInst.onFrameEnd();
    const tape = debugInst.getTape() as any;
    const writes = findEventsOfKind(tape.events, 'writeTexture') as any[];
    expect(writes).toHaveLength(2);
    const pool = debugInst.getBlobPool();
    const bytesOf = (hash: string) => [...new Uint8Array(pool.get(hash)!)];
    expect(bytesOf(writes[0].dataHash)).toEqual(new Array(16).fill(1));
    expect(bytesOf(writes[1].dataHash)).toEqual([9, 9, 9, 9]);
  });
});
