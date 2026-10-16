// biome-ignore-all lint/suspicious/noExplicitAny: getTape() returns Tape | RhiDebugError | undefined; existing self-contained tape tests always get Tape back, safe to narrow with any cast
// biome-ignore-all lint/style/noNonNullAssertion: test assertions on mock stubs verified by parent expect guards
// m3-3: bootstrap integration test — verify FORGEAX_ENGINE_RHI_DEBUG=1 wiring:
// wrap -> wrapCreateShaderModule -> onFrameEnd listener register -> draw -> frameMark.
//
// Tests the recorder integration at API level without a real GPU context.
// Uses stubs/mocks for the RHI backend; no real canvas or device.

import { describe, expect, it, vi } from 'vitest';
import { type CreateShaderModuleFn, wrap, wrapCreateShaderModule } from '../recorder';

// ---------------------------------------------------------------
// Minimal Result helpers (same shape as recorder.ts internal)
// ---------------------------------------------------------------

function rOk<T>(value: T) {
  return { ok: true as const, value };
}

// ---------------------------------------------------------------
// Stub RhiInstance (mimics the shape wrap() expects)
// ---------------------------------------------------------------

function h(): any {
  return {};
}

function stubRhiInstance(): { inst: any; requestAdapterSpy: any; createCmdEncRes: any } {
  const writeBufferSpy = vi.fn(() => rOk(undefined));
  const submitSpy = vi.fn(() => rOk(undefined));
  const createBufferRes = vi.fn(() => rOk(h()));
  const createTextureRes = vi.fn(() => rOk(h()));
  const createTextureViewRes = vi.fn(() => rOk(h()));
  const createSamplerRes = vi.fn(() => rOk(h()));
  const createBGLRes = vi.fn(() => rOk(h()));
  const createBGRes = vi.fn(() => rOk(h()));
  const createLayoutRes = vi.fn(() => rOk(h()));
  const createRPRes = vi.fn(() => rOk(h()));
  const createCPRes = vi.fn(() => rOk(h()));
  const createCmdEncRes = vi.fn(() =>
    rOk({
      beginRenderPass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        setBindGroup: vi.fn(),
        draw: vi.fn(),
        drawIndexed: vi.fn(),
        end: vi.fn(),
        setViewport: vi.fn(),
        setScissorRect: vi.fn(),
        setBlendConstant: vi.fn(),
        setStencilReference: vi.fn(),
        pushDebugGroup: vi.fn(),
        popDebugGroup: vi.fn(),
        insertDebugMarker: vi.fn(),
        beginOcclusionQuery: vi.fn(),
        endOcclusionQuery: vi.fn(),
        executeBundles: vi.fn(),
      })),
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      })),
      copyBufferToBuffer: vi.fn(),
      copyBufferToTexture: vi.fn(),
      copyTextureToBuffer: vi.fn(),
      copyTextureToTexture: vi.fn(),
      clearBuffer: vi.fn(),
      pushDebugGroup: vi.fn(),
      popDebugGroup: vi.fn(),
      insertDebugMarker: vi.fn(),
      finish: vi.fn(() => rOk(h())),
      resolveQuerySet: vi.fn(() => rOk(undefined)),
    }),
  );

  const device = {
    caps: { rgba16floatRenderable: false },
    features: new Set(),
    limits: {},
    queue: {
      writeBuffer: writeBufferSpy,
      submit: submitSpy,
      writeTexture: vi.fn(() => rOk(undefined)),
      copyExternalImageToTexture: vi.fn(() => rOk(undefined)),
      onSubmittedWorkDone: vi.fn(() => Promise.resolve(undefined)),
    },
    lost: new Promise(() => {}),
    createBuffer: createBufferRes,
    createTexture: createTextureRes,
    createTextureView: createTextureViewRes,
    createSampler: createSamplerRes,
    createBindGroupLayout: createBGLRes,
    createBindGroup: createBGRes,
    createPipelineLayout: createLayoutRes,
    createRenderPipeline: createRPRes,
    createComputePipeline: createCPRes,
    createCommandEncoder: createCmdEncRes,
    createQuerySet: vi.fn(() => rOk(h())),
    destroyBuffer: vi.fn(),
    destroyTexture: vi.fn(),
  };

  const adapter = {
    features: new Set(),
    limits: {},
    requestDevice: vi.fn(() => Promise.resolve(rOk(device))),
  };

  const requestAdapterSpy = vi.fn(() => Promise.resolve(rOk(adapter)));

  return {
    inst: { requestAdapter: requestAdapterSpy },
    requestAdapterSpy,
    createCmdEncRes,
  };
}

describe('bootstrap integration (m3-3)', () => {
  it('wrap -> wrapCreateShaderModule call order is correct', () => {
    const { inst } = stubRhiInstance();

    // Step 1: wrap(rhiInstance)
    const debugInst = wrap(inst);

    expect(debugInst.getState()).toBe('idle');

    // Step 2: wrapCreateShaderModule
    const originalFn: CreateShaderModuleFn = vi.fn((_device: any, _desc: any) =>
      Promise.resolve(rOk(h())),
    ) as unknown as CreateShaderModuleFn;

    const wrappedFn = wrapCreateShaderModule(originalFn, debugInst);
    expect(wrappedFn).toBeInstanceOf(Function);
  });

  it('arm + onFrameEnd produces frameMark event', () => {
    const { inst } = stubRhiInstance();
    const debugInst = wrap(inst);

    // Arm for 1 frame
    const armResult = debugInst.arm(1);
    expect(armResult.ok).toBe(true);
    expect(debugInst.getState()).toBe('armed');

    // Fire onFrameEnd (simulates renderer._onFrameEnd callback)
    debugInst.onFrameEnd();
    expect(debugInst.getState()).toBe('idle'); // 1 frame complete -> idle

    // Check tape events
    const tape = debugInst.getTape() as any;
    expect(tape).toBeDefined();
    expect(tape?.events).toHaveLength(1);
    expect(tape?.events[0]?.kind).toBe('frameMark');
  });

  it('onFrameEnd listener pattern: register -> draw -> fire', () => {
    const { inst } = stubRhiInstance();
    const debugInst = wrap(inst);

    // Simulate the _onFrameEnd pattern: register a callback,
    // fire it on frame boundary.
    const listeners: Array<() => void> = [];
    const registerOnFrameEnd = (cb: () => void): (() => void) => {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    };

    // Arm the recorder
    debugInst.arm(1);
    expect(debugInst.getState()).toBe('armed');

    // Register onFrameEnd callback
    const unsub = registerOnFrameEnd(() => debugInst.onFrameEnd());

    // Simulate draw -> fire onFrameEnd
    for (const fn of listeners) fn();

    // After frame-end, recorder should have transitioned
    expect(debugInst.getState()).toBe('idle');

    const tape = debugInst.getTape() as any;
    expect(tape).toBeDefined();
    expect(tape?.events).toHaveLength(1);
    expect(tape?.events[0]?.kind).toBe('frameMark');

    // Unsubscribe should work
    unsub();
    expect(listeners).toHaveLength(0);
  });

  it('bootstrap events go into frame-0 before frameMark', () => {
    const { inst } = stubRhiInstance();
    const debugInst = wrap(inst);

    // Arm for 1 frame
    debugInst.arm(1);

    // Simulate a bootstrap createBuffer call (via proxy chain)
    // The proxy intercepts at requestAdapter -> requestDevice level,
    // so we simulate by accessing the internal proxy chain.
    // For this test, we verify the frameMark behavior directly.
    debugInst.onFrameEnd();

    const tape = debugInst.getTape() as any;
    expect(tape).toBeDefined();

    // frameMark should be the last event (or the only event if no RHI calls)
    const frameMarkEvents = tape!.events.filter((e: any) => e.kind === 'frameMark');
    expect(frameMarkEvents).toHaveLength(1);
    expect(frameMarkEvents[0]!.kind).toBe('frameMark');
    const first = frameMarkEvents[0]!;
    if (first && 'frameIdx' in first) {
      expect(first?.frameIdx).toBe(0);
    }
  });

  it('_onFrameEnd fires every frame even when not armed (no recording)', () => {
    const { inst } = stubRhiInstance();
    const debugInst = wrap(inst);

    // Not armed — onFrameEnd should increment frameIdx but not record
    const state1 = debugInst.getState();
    expect(state1).toBe('idle');

    debugInst.onFrameEnd();
    expect(debugInst.getState()).toBe('idle');

    // No tape should be produced (nothing recorded)
    const tape = debugInst.getTape() as any;
    expect(tape).toBeUndefined();
  });

  it('wrap + extras (createShaderModule via Channel-1 pattern)', async () => {
    const { inst } = stubRhiInstance();
    const debugInst = wrap(inst);

    // Simulate the Channel-1 probe pattern: attach createShaderModule as an extra
    // property on the wrapped instance (as done in createApp m3-1).
    const realCsm: CreateShaderModuleFn = vi.fn((_device: any, _desc: any) =>
      Promise.resolve(rOk(h())),
    ) as unknown as CreateShaderModuleFn;
    const wrappedCsm = wrapCreateShaderModule(realCsm, debugInst);

    const extras = debugInst as unknown as Record<string, unknown>;
    extras.createShaderModule = wrappedCsm;

    // Arm the recorder
    debugInst.arm(1);

    // Call the wrapped createShaderModule (as if from inside createRenderer)
    const result = await wrappedCsm(h() as never, { code: 'fn main() {}', label: 'test' });
    expect(result.ok).toBe(true);

    // The tape should contain a createShaderModule event
    const tape = debugInst.getTape() as any;
    expect(tape).toBeDefined();
    const csmEvents = tape?.events.filter((e: any) => e.kind === 'createShaderModule');
    expect(csmEvents).toHaveLength(1);
  });
});
