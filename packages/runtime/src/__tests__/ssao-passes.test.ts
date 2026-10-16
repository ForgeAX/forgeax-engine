// @forgeax/engine-runtime/__tests__/ssao-passes.test.ts -
// SSAO record-owner tests (M8 / w35-w46).
// feat-20260612-hdrp-ssao.
//
// The tests invoke recordSsaoCalcPass/recordSsaoBlurPass through a minimal
// typed graph fixture and keep the GPU dispatch/binding predicates intact.

import { RenderGraph } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../../render/src/device/device-scope';
import type { BloomPersistentBundle } from '../../../render/src/record/render-context';
import {
  recordBloomCompositePass,
  recordBloomDownsamplePass,
  recordBloomUpsamplePass,
  recordFxaaPass,
  recordSkyboxPass,
} from '../../../render/src/record/skybox-post-pass';
import { VIEW_UNIFORM_BYTES } from '../../../render/src/record/view-ubo';
import type { RenderPipelineContext } from '../../../render/src/render-contract';
import {
  recordSsaoBlurPass,
  recordSsaoCalcPass,
} from '../../../render/src/render-graph-primitives';
import type {
  _InternalRenderPipelineContext,
  RenderSystemRuntime,
} from '../../../render/src/render-system';

// ── M8 / w35-w36-w46 GPU dispatch + intensity write RED tests ───────────────
//
// plan-strategy §D-A: record closures must call setPipeline + setBindGroup + draw(3,1,0,0).
// plan-strategy §D-D: ssao-blur encoder setBindGroup must contain ssaoRaw view, not gbuf0.
// plan-strategy §D-C: per-frame writeBuffer must include intensity at offset 192 in 256B uniform.
//
// These tests grab the pass.descriptor.execute closure from RenderGraph
// (mirrors dispatch-fullscreen-pass-custom-reads.dawn.test.ts pattern), invoke
// it with a spy ctx, and assert setPipeline / setBindGroup / draw / writeBuffer
// are really fired by the record closure. RED phase: closures are stubs, so
// expectations on .toBe(1) for setPipeline / draw / writeBuffer fail until
// w37+w38+w47 GREEN.

interface DispatchSpy {
  beginRenderPassCalls: { view: unknown }[];
  setPipelineCalls: unknown[];
  setBindGroupCalls: { slot: number; bindGroup: unknown; entries?: readonly unknown[] }[];
  drawCalls: {
    vertexCount: number;
    instanceCount: number;
    firstVertex: number;
    firstInstance: number;
  }[];
  bindGroupCreates: {
    entries: readonly { binding: number; resource: { kind: string; value: unknown } }[];
  }[];
  writeBufferCalls: { buffer: unknown; offset: number; data: ArrayBufferLike | ArrayBufferView }[];
}

interface SpyCtx {
  ctx: RenderPipelineContext;
  spy: DispatchSpy;
}

function makeDispatchSpyCtx(
  opts: {
    ssaoCalcPipeline?: unknown;
    ssaoBlurPipeline?: unknown;
    ssaoBgl?: unknown;
    fxaaPipeline?: unknown;
    fxaaBindGroupLayout?: unknown;
    fxaaSampler?: unknown;
  } = {},
): SpyCtx {
  const spy: DispatchSpy = {
    beginRenderPassCalls: [],
    setPipelineCalls: [],
    setBindGroupCalls: [],
    drawCalls: [],
    bindGroupCreates: [],
    writeBufferCalls: [],
  };

  const passEncoder = {
    setPipeline(p: unknown): void {
      spy.setPipelineCalls.push(p);
    },
    setBindGroup(slot: number, bg: unknown): void {
      spy.setBindGroupCalls.push({ slot, bindGroup: bg });
    },
    draw(
      vertexCount: number,
      instanceCount: number,
      firstVertex: number,
      firstInstance: number,
    ): void {
      spy.drawCalls.push({ vertexCount, instanceCount, firstVertex, firstInstance });
    },
    end(): void {},
  };

  const ssaoUniformBuffer = { __label: 'ssao-uniform' };
  const ssaoKernelBuffer = { __label: 'ssao-kernel' };
  const ssaoNoiseTexture = { __label: 'ssao-noise' };

  const device = {
    caps: {
      backendKind: 'webgpu' as const,
      storageBuffer: true,
      float32Filterable: true,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      maxStorageBuffersPerShaderStage: 4,
    },
    createBuffer: vi.fn((desc: { label?: string }) => ({
      ok: true,
      value: { __label: desc.label ?? 'buf' },
    })),
    createTexture: vi.fn(() => ({ ok: true, value: ssaoNoiseTexture })),
    createTextureView: vi.fn(() => ({ ok: true, value: { __label: 'view' } })),
    createSampler: vi.fn(() => ({ ok: true, value: { __label: 'sampler' } })),
    createBindGroupLayout: vi.fn(() => ({ ok: true, value: { __label: 'bgl' } })),
    createBindGroup: vi.fn(
      (desc: {
        entries: readonly { binding: number; resource: { kind: string; value: unknown } }[];
      }) => {
        spy.bindGroupCreates.push({ entries: desc.entries });
        return { ok: true, value: { __label: 'bg' } };
      },
    ),
    queue: {
      writeBuffer: vi.fn(
        (buffer: unknown, offset: number, data: ArrayBufferLike | ArrayBufferView) => {
          spy.writeBufferCalls.push({ buffer, offset, data });
          return { ok: true, value: undefined };
        },
      ),
      writeTexture: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    },
  } as unknown as RhiDevice;

  const errorRegistry = {
    fire: vi.fn(),
    listeners: new Set(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const fxaaParamsBuffer = { __label: 'fxaa-params' };
  const runtime = {
    device,
    errorRegistry,
    shaderCache: { get: vi.fn() },
    getPostProcessParamsBuffer: vi.fn(() => fxaaParamsBuffer),
  } as unknown as RenderSystemRuntime;

  // Pre-seed ssao-buffers cache so the record closure resolves a stable
  // SsaoBuffers identity (kernelBuffer / uniformBuffer / noiseTexture) — the
  // dispatch closure will writeBuffer to uniformBuffer and bind kernelBuffer
  // / noiseTexture in the bind-group entries. We avoid reaching inside the
  // ssao-buffers WeakMap by pre-allocating the same shape via a first
  // getOrCreateSsaoBuffers call (it succeeds since storageBuffer=true and
  // createBuffer / createTexture are mocked).

  const pipelineState = {
    perPassResources: {
      ssaoCalcPipeline:
        'ssaoCalcPipeline' in opts ? opts.ssaoCalcPipeline : { __label: 'ssao-calc-pipeline' },
      ssaoBlurPipeline:
        'ssaoBlurPipeline' in opts ? opts.ssaoBlurPipeline : { __label: 'ssao-blur-pipeline' },
      ssaoBgl: 'ssaoBgl' in opts ? opts.ssaoBgl : { __label: 'ssao-bgl' },
      ssaoFilteringSampler: null,
      ssaoDepthSampler: null,
      ssaoFallbackRawView: null,
      // FXAA is part of the same Standard post chain. Keep the fixture's
      // fullscreen resources complete so recordAll exercises the real FXAA
      // bind-group path instead of returning early at its capability gate.
      fxaaPipeline: 'fxaaPipeline' in opts ? opts.fxaaPipeline : { __label: 'fxaa-pipeline' },
      fxaaBindGroupLayout:
        'fxaaBindGroupLayout' in opts ? opts.fxaaBindGroupLayout : { __label: 'fxaa-bgl' },
      fxaaSampler: 'fxaaSampler' in opts ? opts.fxaaSampler : { __label: 'fxaa-sampler' },
    },
  };

  // Pre-prime ssao-buffers cache: device.createBuffer is invoked the first
  // time getOrCreateSsaoBuffers fires; subsequent record closure invocations
  // hit the cache. We expose the seeded buffers so test assertions can
  // identify them in writeBuffer / bindGroup entries.
  void ssaoUniformBuffer;
  void ssaoKernelBuffer;

  // Mock graph targets for resolveHdrDepthDepthOnlyView:
  // resolveHdrDepthDepthOnlyView needs graph.getColorTargetTexture(hdrDepthKey)
  // to return a dummy texture, then calls device.createTextureView on it.
  // We provide a mock texture object that createTextureView will accept.
  const mockHdrDepthTexture = { __label: 'mock-hdr-depth-tex' };
  const mockGraphTargets = {
    getColorTargetTexture: vi.fn((_name: string) => mockHdrDepthTexture),
  };

  const ctx = {
    runtime,
    assets: { get: vi.fn(), register: vi.fn() },
    store: { ensureResident: vi.fn(), getTextureView: vi.fn() },
    pipelineState,
    encoder: {
      beginRenderPass: vi.fn((desc: { colorAttachments: readonly { view: unknown }[] }) => {
        spy.beginRenderPassCalls.push({ view: desc.colorAttachments[0]?.view });
        return passEncoder;
      }),
    },
    view: { __swap: true },
    clear: [0, 0, 0, 1],
    targetW: 800,
    targetH: 600,
    currentTexture: {},
    // Identity world + perspective projection so computeViewMatrix /
    // computeProjectionMatrix return a sane mat4 (the test only cares that
    // writeBuffer fires once with the right intensity slot, not the matrix
    // contents).
    camera: {
      world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      projection: 'perspective',
      fov: Math.PI / 2,
      aspect: 4 / 3,
      near: 0.1,
      far: 100,
    },
    validated: [],
    validatedOrdered: [],
    viewBindGroup: null,
    meshBindGroup: null,
    frameState: {
      compiledFrameGraph: { targets: mockGraphTargets },
      installedPipelineConfig: { ssao: { enabled: true, intensity: 1.0 } },
      // Post-process bind group identity cache (bloom / fxaa / ssao). Keyed on
      // the graph-resolved views so resize rebuilds automatically.
      postProcessBgCache: new WeakMap(),
    },
    dispatchCounts: {},
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    skylight: undefined,
    skylightCount: 0,
    skybox: undefined,
    msaaActive: false,
    geometryColorResolveView: null,
    ldrSpriteColorView: null,
    tonemapActive: true,
  } as unknown as RenderPipelineContext;

  return { ctx, spy };
}

interface PassDescriptor {
  reads: readonly string[];
  writes: readonly string[];
  execute?: (c: RenderPipelineContext, r?: { resolve(name: string): unknown }) => void;
}

function findPassExecute(
  graph: RenderGraph<RenderPipelineContext>,
  passName: string,
): PassDescriptor['execute'] | undefined {
  // Mirrors dispatch-fullscreen-pass-custom-reads.dawn.test.ts — reach into
  // the package-private pass registry. listPasses surfaces only name/reads/
  // writes; execute lives on the descriptor.
  const inner = graph as unknown as {
    passes: { list(): readonly { name: string; descriptor: PassDescriptor }[] };
  };
  const passes = inner.passes.list();
  return passes.find((p) => p.name === passName)?.descriptor.execute;
}

function setupGraphForDispatch(graph: RenderGraph<RenderPipelineContext>): void {
  graph.addColorTarget('gbuf0', {
    format: 'rgba16float',
    size: 'swapchain',
    sample: 1,
  });
  graph.addColorTarget('hdrDepth', {
    format: 'depth24plus-stencil8',
    size: 'swapchain',
    sample: 1,
  });
  graph.addColorTarget('ssaoRaw', {
    format: 'r8unorm',
    size: 'half-swapchain',
    sample: 1,
  });
  graph.addColorTarget('ssaoBlurred', {
    format: 'r8unorm',
    size: 'half-swapchain',
    sample: 1,
  });
}

function addSsaoRecordPasses(
  graph: RenderGraph<RenderPipelineContext>,
  _ctx: RenderPipelineContext,
): void {
  graph.addPass('ssao-calc', {
    reads: ['gbuf0', 'hdrDepth'],
    writes: ['ssaoRaw'],
    execute: (c, resolveCtx) =>
      recordSsaoCalcPass(
        c as _InternalRenderPipelineContext,
        resolveCtx,
        'ssaoRaw',
        'gbuf0',
        'hdrDepth',
      ),
  });
  graph.addPass('ssao-blur', {
    reads: ['ssaoRaw', 'gbuf0', 'hdrDepth'],
    writes: ['ssaoBlurred'],
    execute: (c, resolveCtx) =>
      recordSsaoBlurPass(
        c as _InternalRenderPipelineContext,
        resolveCtx,
        'ssaoBlurred',
        'ssaoRaw',
        'gbuf0',
        'hdrDepth',
      ),
  });
}

describe('recordSsaoCalcPass GPU dispatch (M8 / w35 — RED)', () => {
  it('(g) recordSsaoCalcPass calls setPipeline(ssaoCalcPipeline) once per frame', () => {
    const calcPipeline = { __label: 'ssao-calc-pipeline' };
    const { ctx, spy } = makeDispatchSpyCtx({ ssaoCalcPipeline: calcPipeline });

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-calc');
    expect(execute).toBeDefined();
    if (!execute) return;

    const ssaoRawView = { __label: 'ssaoRawView' };
    const gbuf0View = { __label: 'gbuf0View' };
    const hdrDepthView = { __label: 'hdrDepthView' };
    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? ssaoRawView
          : n === 'gbuf0'
            ? gbuf0View
            : n === 'hdrDepth'
              ? hdrDepthView
              : undefined,
    });

    expect(spy.setPipelineCalls.length).toBe(1);
    expect(spy.setPipelineCalls[0]).toBe(calcPipeline);
  });

  it('(h) recordSsaoCalcPass calls setBindGroup once + draw(3, 1, 0, 0) once', () => {
    const { ctx, spy } = makeDispatchSpyCtx();

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-calc');
    if (!execute) return;

    const ssaoRawView = { __label: 'ssaoRawView' };
    const gbuf0View = { __label: 'gbuf0View' };
    const hdrDepthView = { __label: 'hdrDepthView' };
    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? ssaoRawView
          : n === 'gbuf0'
            ? gbuf0View
            : n === 'hdrDepth'
              ? hdrDepthView
              : undefined,
    });

    expect(spy.setBindGroupCalls.length).toBe(1);
    expect(spy.setBindGroupCalls[0]?.slot).toBe(0);
    expect(spy.drawCalls.length).toBe(1);
    expect(spy.drawCalls[0]).toEqual({
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    });
  });

  it('(i) recordSsaoCalcPass beginRenderPass color view is the ssaoRaw resolve target', () => {
    const { ctx, spy } = makeDispatchSpyCtx();

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-calc');
    if (!execute) return;

    const ssaoRawView = { __label: 'ssaoRawView' };
    const gbuf0View = { __label: 'gbuf0View' };
    const hdrDepthView = { __label: 'hdrDepthView' };
    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? ssaoRawView
          : n === 'gbuf0'
            ? gbuf0View
            : n === 'hdrDepth'
              ? hdrDepthView
              : undefined,
    });

    expect(spy.beginRenderPassCalls.length).toBe(1);
    expect(spy.beginRenderPassCalls[0]?.view).toBe(ssaoRawView);
  });

  it('refuses SSAO on the GLES depth-sampling path with an actionable capability error', () => {
    const { ctx, spy } = makeDispatchSpyCtx({ ssaoCalcPipeline: null, ssaoBgl: null });
    Object.assign(ctx.runtime.device.caps, { backendKind: 'wgpu-webgl2' });
    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);
    const execute = findPassExecute(graph, 'ssao-calc');
    if (!execute) throw new Error('SSAO calc pass missing');
    expect(() => execute(ctx, { resolve: () => undefined })).toThrow(
      expect.objectContaining({
        code: 'feature-not-enabled',
        hint: expect.stringContaining('WebGPU'),
      }),
    );
    expect(spy.drawCalls).toHaveLength(0);
  });

  it('(j) missing SSAO producer fails explicitly instead of white AO', () => {
    // Enabling AO against a stripped manifest must explain the missing producer.
    const { ctx, spy } = makeDispatchSpyCtx({
      ssaoCalcPipeline: null,
      ssaoBlurPipeline: null,
      ssaoBgl: null,
    });

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-calc');
    if (!execute) return;

    expect(() =>
      execute(ctx, {
        resolve: (n: string) =>
          n === 'ssaoRaw'
            ? { __label: 'ssaoRawView' }
            : n === 'gbuf0'
              ? { __label: 'gbuf0View' }
              : n === 'hdrDepth'
                ? { __label: 'hdrDepthView' }
                : undefined,
      }),
    ).toThrow(expect.objectContaining({ code: 'post-process-not-found' }));
    expect(spy.setPipelineCalls.length).toBe(0);
    expect(spy.drawCalls.length).toBe(0);
  });
});
describe('recordSsaoBlurPass GPU dispatch + ssaoRaw input (M8 / w36 — RED)', () => {
  it('(k) recordSsaoBlurPass calls setPipeline(ssaoBlurPipeline) once per frame', () => {
    const blurPipeline = { __label: 'ssao-blur-pipeline' };
    const { ctx, spy } = makeDispatchSpyCtx({ ssaoBlurPipeline: blurPipeline });

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-blur');
    if (!execute) return;

    const ssaoRawView = { __label: 'ssaoRawView' };
    const ssaoBlurredView = { __label: 'ssaoBlurredView' };
    const gbuf0View = { __label: 'gbuf0View' };
    const hdrDepthView = { __label: 'hdrDepthView' };
    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? ssaoRawView
          : n === 'ssaoBlurred'
            ? ssaoBlurredView
            : n === 'gbuf0'
              ? gbuf0View
              : n === 'hdrDepth'
                ? hdrDepthView
                : undefined,
    });

    expect(spy.setPipelineCalls.length).toBe(1);
    expect(spy.setPipelineCalls[0]).toBe(blurPipeline);
  });

  it('(l) recordSsaoBlurPass beginRenderPass color view is ssaoBlurred (not ssaoRaw)', () => {
    const { ctx, spy } = makeDispatchSpyCtx();

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-blur');
    if (!execute) return;

    const ssaoRawView = { __label: 'ssaoRawView' };
    const ssaoBlurredView = { __label: 'ssaoBlurredView' };
    const gbuf0View = { __label: 'gbuf0View' };
    const hdrDepthView = { __label: 'hdrDepthView' };
    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? ssaoRawView
          : n === 'ssaoBlurred'
            ? ssaoBlurredView
            : n === 'gbuf0'
              ? gbuf0View
              : n === 'hdrDepth'
                ? hdrDepthView
                : undefined,
    });

    expect(spy.beginRenderPassCalls.length).toBe(1);
    expect(spy.beginRenderPassCalls[0]?.view).toBe(ssaoBlurredView);
  });

  it('(m) recordSsaoBlurPass createBindGroup binds ssaoRaw view (not gbuffer_normal)', () => {
    const { ctx, spy } = makeDispatchSpyCtx();

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-blur');
    if (!execute) return;

    const ssaoRawView = { __label: 'ssaoRawView' };
    const gbuf0View = { __label: 'gbuf0View' };
    const hdrDepthView = { __label: 'hdrDepthView' };
    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? ssaoRawView
          : n === 'ssaoBlurred'
            ? { __label: 'ssaoBlurredView' }
            : n === 'gbuf0'
              ? gbuf0View
              : n === 'hdrDepth'
                ? hdrDepthView
                : undefined,
    });

    expect(spy.bindGroupCreates.length).toBe(1);
    const entries = spy.bindGroupCreates[0]?.entries ?? [];
    // D-D fix: ssaoRaw slot (binding 7) must carry the half-res calc output.
    const ssaoRawEntry = entries.find((e) => e.binding === 7);
    expect(ssaoRawEntry).toBeDefined();
    expect(ssaoRawEntry?.resource.kind).toBe('textureView');
    expect(ssaoRawEntry?.resource.value).toBe(ssaoRawView);
    // The blur shader does not sample gbuffer_normal at binding 7 (typo
    // pre-w37 had the blur reading binding 4); confirm binding 7 is NOT the
    // gbuf0 view.
    expect(ssaoRawEntry?.resource.value).not.toBe(gbuf0View);
  });

  it('(n) recordSsaoBlurPass calls draw(3, 1, 0, 0) once', () => {
    const { ctx, spy } = makeDispatchSpyCtx();

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-blur');
    if (!execute) return;

    const ssaoRawView = { __label: 'ssaoRawView' };
    const ssaoBlurredView = { __label: 'ssaoBlurredView' };
    const gbuf0View = { __label: 'gbuf0View' };
    const hdrDepthView = { __label: 'hdrDepthView' };
    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? ssaoRawView
          : n === 'ssaoBlurred'
            ? ssaoBlurredView
            : n === 'gbuf0'
              ? gbuf0View
              : n === 'hdrDepth'
                ? hdrDepthView
                : undefined,
    });

    expect(spy.drawCalls.length).toBe(1);
    expect(spy.drawCalls[0]).toEqual({
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    });
  });
});

describe('recordSsaoCalcPass per-frame intensity write (M8 / w46 — RED)', () => {
  it('(o) calc pass writeBuffer carries intensity at offset 192 (256B SSAO uniform)', () => {
    const { ctx, spy } = makeDispatchSpyCtx();

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-calc');
    if (!execute) return;

    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? { __label: 'ssaoRawView' }
          : n === 'gbuf0'
            ? { __label: 'gbuf0View' }
            : n === 'hdrDepth'
              ? { __label: 'hdrDepthView' }
              : undefined,
    });

    // Filter writeBuffer calls whose payload is 256 bytes (SSAO uniform).
    const ssaoUniformWrites = spy.writeBufferCalls.filter((c) => {
      const view = c.data as ArrayBufferView;
      return view.byteLength === 256;
    });
    expect(ssaoUniformWrites.length).toBe(1);
    const data = new Float32Array(
      (ssaoUniformWrites[0]?.data as Float32Array).buffer,
      (ssaoUniformWrites[0]?.data as Float32Array).byteOffset,
      64,
    );
    // intensityPad starts at float index 48 (offset 192). The spy supplies
    // only enabled+intensity, so the parameter authority contributes the
    // documented radius/bias defaults.
    expect(data[48]).toBe(1.0);
    expect(data[49]).toBe(0.5);
    expect(data[50]).toBeCloseTo(0.025, 6);
    expect(data[51]).toBe(64); // Default high-quality sample count.
  });

  it('(p) calc pass writeBuffer count is 1 per frame (single 256B transaction)', () => {
    const { ctx, spy } = makeDispatchSpyCtx();

    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);

    const execute = findPassExecute(graph, 'ssao-calc');
    if (!execute) return;

    execute(ctx, {
      resolve: (n: string) =>
        n === 'ssaoRaw'
          ? { __label: 'ssaoRawView' }
          : n === 'gbuf0'
            ? { __label: 'gbuf0View' }
            : n === 'hdrDepth'
              ? { __label: 'hdrDepthView' }
              : undefined,
    });

    const ssaoUniformWrites = spy.writeBufferCalls.filter((c) => {
      const view = c.data as ArrayBufferView;
      return view.byteLength === 256;
    });
    expect(ssaoUniformWrites.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// R-BGCACHE: bind group resize invalidation (feedback 2026-07-10). The SSAO
// calc/blur bind groups sample graph-owned transient targets (gbuf0 / hdrDepth
// / ssaoRaw). On resize the render-graph retires those physical textures and
// allocates new ones, so the resolved TextureView objects change identity. The
// bind group MUST be rebuilt against the new views — the pre-fix `=== null`
// slot cache reused a bind group referencing the destroyed texture and hit
// `queue-submit-failed: Destroyed texture used in a submit`. These drive the
// real pass closures through simulated resize and assert the cache is keyed on
// physical view identity (bloom / fxaa share the identical getOrCreateFromChain
// mechanism via frameState.postProcessBgCache).
// ─────────────────────────────────────────────────────────────────────────
interface PostProcessBindGroupCreate {
  label?: string;
  entries: readonly { binding: number; resource: { kind: string; value: unknown } }[];
}

function makePostProcessRecordCtx(): {
  ctx: _InternalRenderPipelineContext;
  bindGroupCreates: PostProcessBindGroupCreate[];
} {
  const bindGroupCreates: PostProcessBindGroupCreate[] = [];
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const fxaaParamsBuffer = { label: 'fxaa-params' };
  const device = {
    createBindGroup: vi.fn((desc: PostProcessBindGroupCreate) => {
      bindGroupCreates.push(desc);
      return { ok: true, value: { label: `bg-${bindGroupCreates.length}` } };
    }),
    createTextureView: vi.fn(() => ({ ok: true, value: { label: 'fxaa-output-view' } })),
    queue: { writeBuffer: vi.fn(() => ({ ok: true, value: undefined })) },
  };
  const sampler = { label: 'postprocess-sampler' };
  const bloomScope = DeviceScope.create(1, 'runtime-ssao-bloom-fixture');
  const ownBloomHandle = (
    kind: 'pipeline' | 'binding' | 'post-effect' | 'buffer',
    label: string,
  ) => {
    const handle = { label };
    bloomScope._adopt(kind, handle, () => undefined);
    return handle;
  };
  const bloomResources = {
    scope: bloomScope,
    generation: bloomScope.generation,
    bloomDownsamplePipeline: ownBloomHandle('pipeline', 'bloom-downsample-pipeline'),
    bloomUpsamplePipeline: ownBloomHandle('pipeline', 'bloom-upsample-pipeline'),
    bloomCompositePipeline: ownBloomHandle('pipeline', 'bloom-composite-pipeline'),
    bloomDownsampleBindGroupLayout: ownBloomHandle('binding', 'bloom-downsample-bgl'),
    bloomUpsampleBindGroupLayout: ownBloomHandle('binding', 'bloom-upsample-bgl'),
    bloomCompositeBindGroupLayout: ownBloomHandle('binding', 'bloom-composite-bgl'),
    bloomSampler: ownBloomHandle('post-effect', 'bloom-sampler'),
    bloomDownsampleParamsBuffer: ownBloomHandle('buffer', 'bloom-downsample-params'),
    bloomUpsampleParamsBuffer: ownBloomHandle('buffer', 'bloom-upsample-params'),
    bloomCompositeParamsBuffer: ownBloomHandle('buffer', 'bloom-composite-params'),
  } as unknown as BloomPersistentBundle;
  const ctx = {
    runtime: {
      device: { ...device, caps: { storageBuffer: true } },
      errorRegistry: { fire: vi.fn() },
      getPostProcessParamsBuffer: vi.fn(() => fxaaParamsBuffer),
    },
    store: { getCubemapGpuView: vi.fn() },
    encoder: {
      beginRenderPass: vi.fn(() => pass),
      copyTextureToTexture: vi.fn(),
    },
    pipelineState: {
      format: 'bgra8unorm',
      colorAttachmentFormat: 'bgra8unorm-srgb',
      viewUniformBuffer: { label: 'view-uniform' },
      perPassResources: {
        hdrColorView: { label: 'hdr-color' },
        hdrColorMsaaView: null,
        skyboxPipeline: { label: 'skybox-pipeline' },
        skyboxPipelineMsaa: null,
        skyboxBindGroupLayout: { label: 'skybox-bgl' },
        skyboxSampler: sampler,
        skyboxRotationBuffer: { label: 'skybox-rotation' },
        fxaaPipeline: { label: 'fxaa-pipeline' },
        fxaaBindGroupLayout: { label: 'fxaa-bgl' },
        fxaaSampler: sampler,
      },
    },
    bloomResources,
    frameState: { postProcessBgCache: new WeakMap() },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    camera: {
      bloom: 'on',
      bloomThreshold: 1,
      bloomSoftKnee: 0.5,
      bloomScatter: 0.7,
      bloomIntensity: 0.5,
      antialias: 'fxaa',
    },
    tonemapActive: true,
    skyboxActive: true,
    skybox: { equirectHandle: 1, rotation: [0, 0, 0, 1] },
    msaaActive: false,
    targetW: 800,
    targetH: 600,
    currentTexture: { label: 'swapchain' },
  } as unknown as _InternalRenderPipelineContext;
  return { ctx, bindGroupCreates };
}

describe('post-process bindgroup identity cache (issue #670)', () => {
  it('reuses live-view bindgroups and rebuilds changed-view bindings across postprocess paths', () => {
    const { ctx, bindGroupCreates } = makePostProcessRecordCtx();
    const views = {
      hdrColor: { label: 'hdr-color' },
      ldrColor: { label: 'ldr-color' },
      bloomDownsample0: { label: 'bloom-downsample-0' },
      bloomDownsample1: { label: 'bloom-downsample-1' },
      bloomDownsample2: { label: 'bloom-downsample-2' },
      bloomDownsample3: { label: 'bloom-downsample-3' },
      bloomDownsample4: { label: 'bloom-downsample-4' },
      bloomUpsample3: { label: 'bloom-upsample-3' },
      bloomUpsample2: { label: 'bloom-upsample-2' },
      bloomUpsample1: { label: 'bloom-upsample-1' },
      bloomUpsample0: { label: 'bloom-upsample-0' },
      hdrComposited: { label: 'hdr-composited' },
      cubemap: { label: 'cubemap' },
    };
    const resolve = { resolve: (name: string) => views[name as keyof typeof views] };
    const store = ctx.store as unknown as { getCubemapGpuView: ReturnType<typeof vi.fn> };
    store.getCubemapGpuView.mockImplementation(() => views.cubemap);

    const recordAll = () => {
      for (let level = 0; level < 5; level += 1) {
        recordBloomDownsamplePass(ctx, resolve, undefined, level);
      }
      for (let level = 3; level >= 0; level -= 1) {
        recordBloomUpsamplePass(ctx, resolve, undefined, level);
      }
      recordBloomCompositePass(ctx, resolve);
      recordFxaaPass(ctx, resolve);
      recordSkyboxPass(ctx);
    };
    recordAll();
    expect(ctx.encoder.copyTextureToTexture).not.toHaveBeenCalled();
    expect(bindGroupCreates).toHaveLength(12);
    expect(bindGroupCreates.map((create) => create.label)).toEqual([
      'bloom-downsample-0-bg',
      'bloom-downsample-1-bg',
      'bloom-downsample-2-bg',
      'bloom-downsample-3-bg',
      'bloom-downsample-4-bg',
      'bloom-upsample-3-bg',
      'bloom-upsample-2-bg',
      'bloom-upsample-1-bg',
      'bloom-upsample-0-bg',
      'bloom-composite-bg',
      'fxaa-bg',
      'skybox-bg',
    ]);
    expect(bindGroupCreates[9]?.entries.map((entry) => entry.resource.value)).toContain(
      views.bloomUpsample0,
    );
    expect(bindGroupCreates[11]?.entries[0]?.resource.value).toBe(views.cubemap);
    expect(bindGroupCreates[11]?.entries[2]?.resource.value).toEqual({
      buffer: ctx.pipelineState.viewUniformBuffer,
      size: VIEW_UNIFORM_BYTES,
    });

    recordAll();
    expect(bindGroupCreates).toHaveLength(12);

    views.bloomDownsample0 = { label: 'bloom-downsample-0-resized' };
    views.bloomDownsample1 = { label: 'bloom-downsample-1-resized' };
    views.bloomDownsample2 = { label: 'bloom-downsample-2-resized' };
    views.bloomDownsample3 = { label: 'bloom-downsample-3-resized' };
    views.bloomDownsample4 = { label: 'bloom-downsample-4-resized' };
    views.bloomUpsample3 = { label: 'bloom-upsample-3-resized' };
    views.bloomUpsample2 = { label: 'bloom-upsample-2-resized' };
    views.bloomUpsample1 = { label: 'bloom-upsample-1-resized' };
    views.bloomUpsample0 = { label: 'bloom-upsample-0-resized' };
    views.hdrColor = { label: 'hdr-color-resized' };
    views.ldrColor = { label: 'ldr-color-resized' };
    views.cubemap = { label: 'cubemap-reprojected' };
    recordAll();

    expect(bindGroupCreates).toHaveLength(24);
    expect(bindGroupCreates[12]?.entries[0]?.resource.value).toBe(views.hdrColor);
    expect(bindGroupCreates[14]?.entries[0]?.resource.value).toBe(views.bloomDownsample1);
    expect(bindGroupCreates[20]?.entries[0]?.resource.value).toBe(views.bloomDownsample0);
    expect(bindGroupCreates[21]?.entries.map((entry) => entry.resource.value)).toContain(
      views.bloomUpsample0,
    );
    expect(bindGroupCreates[22]?.entries[0]?.resource.value).toBe(views.ldrColor);
    expect(bindGroupCreates[23]?.entries[0]?.resource.value).toBe(views.cubemap);
  });
});

describe('bindgroup resize invalidation (R-BGCACHE)', () => {
  // A resolve function whose returned view objects can be swapped to simulate
  // a resize (new physical texture identity for the same logical key).
  function makeResolver(views: Record<string, { __label: string }>) {
    return { resolve: (n: string) => views[n] };
  }

  it('after resize frame, bindgroup that sampled old transient RT is rebuilt with new physical texture', () => {
    const { ctx, spy } = makeDispatchSpyCtx();
    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);
    const execute = findPassExecute(graph, 'ssao-calc');
    if (!execute) throw new Error('ssao-calc pass missing');

    // Frame 1 (pre-resize): stable view identities.
    const preViews = {
      ssaoRaw: { __label: 'ssaoRawView-A' },
      gbuf0: { __label: 'gbuf0View-A' },
      hdrDepth: { __label: 'hdrDepthView-A' },
    };
    execute(ctx, makeResolver(preViews));
    const createsAfterFrame1 = spy.bindGroupCreates.length;

    // Frame 2 (resize): the graph reallocates gbuf0 + hdrDepth -> new view
    // objects. The bind group must be rebuilt against the new identities.
    const postViews = {
      ssaoRaw: { __label: 'ssaoRawView-B' },
      gbuf0: { __label: 'gbuf0View-B' },
      hdrDepth: { __label: 'hdrDepthView-B' },
    };
    execute(ctx, makeResolver(postViews));
    const createsAfterFrame2 = spy.bindGroupCreates.length;

    // A new bind group was created on the resize frame (invalidation fired).
    expect(createsAfterFrame2).toBe(createsAfterFrame1 + 1);
    // The rebuilt bind group references the NEW gbuf0 view (binding 4), never
    // the retired one.
    const rebuilt = spy.bindGroupCreates[createsAfterFrame2 - 1];
    const gbuf0Entry = rebuilt?.entries.find((e) => e.binding === 4);
    expect(gbuf0Entry?.resource.value).toBe(postViews.gbuf0);
  });

  it('non-resize frame reuses cached bindgroup (no unnecessary rebuild)', () => {
    const { ctx, spy } = makeDispatchSpyCtx();
    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);
    const execute = findPassExecute(graph, 'ssao-calc');
    if (!execute) throw new Error('ssao-calc pass missing');

    // Same view identities across three frames (steady state, no resize).
    const views = {
      ssaoRaw: { __label: 'ssaoRawView' },
      gbuf0: { __label: 'gbuf0View' },
      hdrDepth: { __label: 'hdrDepthView' },
    };
    execute(ctx, makeResolver(views));
    const createsAfterFrame1 = spy.bindGroupCreates.length;
    execute(ctx, makeResolver(views));
    execute(ctx, makeResolver(views));

    // No additional createBindGroup after frame 1 — the cache hit on identity.
    expect(spy.bindGroupCreates.length).toBe(createsAfterFrame1);
  });

  it('bindgroup rebuild after resize uses the new physical texture identity, not the old one', () => {
    const { ctx, spy } = makeDispatchSpyCtx();
    const graph = new RenderGraph<RenderPipelineContext>();
    setupGraphForDispatch(graph);
    addSsaoRecordPasses(graph, ctx);
    const execute = findPassExecute(graph, 'ssao-blur');
    if (!execute) throw new Error('ssao-blur pass missing');

    const preViews = {
      ssaoRaw: { __label: 'ssaoRawView-A' },
      ssaoBlurred: { __label: 'ssaoBlurredView-A' },
      gbuf0: { __label: 'gbuf0View-A' },
      hdrDepth: { __label: 'hdrDepthView-A' },
    };
    execute(ctx, makeResolver(preViews));

    const postViews = {
      ssaoRaw: { __label: 'ssaoRawView-B' },
      ssaoBlurred: { __label: 'ssaoBlurredView-B' },
      gbuf0: { __label: 'gbuf0View-B' },
      hdrDepth: { __label: 'hdrDepthView-B' },
    };
    execute(ctx, makeResolver(postViews));

    // The blur pass binds ssaoRaw at binding 7 (the read it actually samples).
    // After resize it must reference the new ssaoRaw view, never the retired A.
    const last = spy.bindGroupCreates[spy.bindGroupCreates.length - 1];
    const ssaoRawEntry = last?.entries.find((e) => e.binding === 7);
    expect(ssaoRawEntry?.resource.value).toBe(postViews.ssaoRaw);
    expect(ssaoRawEntry?.resource.value).not.toBe(preViews.ssaoRaw);
  });
});
