// @forgeax/engine-runtime — surface retry unit tests
//
// Covers:
//   w5 — F2 surface retry: reconfigure + retry once, frame continues (AC-03)
//   w6 — F2 surface consecutive failure -> internal-fault (AC-04)
//
// Tests drive recordFrame() directly with mock internals. All mock objects
// are typed through `any` to avoid constructing full RhiDevice / PipelineState /
// AssetRegistry / GpuResidencyCache objects (each is ~50+ fields with branded
// opaque types). The test surface is the recordFrame function — verify that
// getCurrentTexture failure triggers reconfigure+retry and that consecutive
// failures escalate to health internal-fault.

import { RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { HealthListenerRegistry } from '../../../render/src/lifecycle';
import { acquireSwapChainTarget } from '../../../render/src/record/frame-targets';

// biome-ignore lint/suspicious/noExplicitAny: mock objects are intentionally opaque in test code
type MockObj = Record<string, any>;

function makePipelineState(): MockObj {
  return {
    meshes: new Map(),
    format: 'bgra8unorm',
    colorAttachmentFormat: 'bgra8unorm-srgb',
    standardPipeline: { __brand: 'RP' },
    unlitPipeline: { __brand: 'RP' },
    unlitPipelineHdr: { __brand: 'RP' },
    unlitPipelineMsaa: { __brand: 'RP' },
    unlitPipelineHdrMsaa: { __brand: 'RP' },
    spritePipeline: { __brand: 'RP' },
    spritePipelineHdr: { __brand: 'RP' },
    spritePipelineMsaa: { __brand: 'RP' },
    spritePipelineHdrMsaa: { __brand: 'RP' },
    perPassResources: { configured: true },
    cameraUniformBuffer: { __brand: 'Buf' },
    lightsUniformBuffer: { __brand: 'Buf' },
    skyIBLBuffer: { __brand: 'Buf' },
    meshStorageBuffer: { buffer: { __brand: 'Buf' }, writeBuffer: () => ({ ok: true }) },
    materialUBOBuffer: { __brand: 'Buf' },
    shadowParamsBuffer: { __brand: 'Buf' },
    defaultWhiteTextureView: { __brand: 'TV' },
    defaultNormalTextureView: { __brand: 'TV' },
    fallbackTextureView: { __brand: 'TV' },
    materialBindGroupLayout: { __brand: 'BGL' },
    meshBindGroupLayout: { __brand: 'BGL' },
    viewBindGroupLayout: { __brand: 'BGL' },
    instancesBindGroupLayout: { __brand: 'BGL' },
    shadowViewBindGroupLayout: { __brand: 'BGL' },
    standardBindGroup: { __brand: 'BG' },
    skyboxRenderPipeline: { __brand: 'RP' },
    skyboxBindGroupLayout: { __brand: 'BGL' },
    depthStencilState: { format: 'depth24plus-stencil8' },
    _skinBgCacheStats: { total: 0, capacity: 0 },
    device: { limits: { maxStorageBuffersPerShaderStage: 0 } },
    formatBgra8Unorm: 'bgra8unorm',
    shadowViewBindGroup: { __brand: 'BG' },
    shadowSampler: { __brand: 'S' },
    shadowViewTexture: { __brand: 'TV' },
  };
}

function makeMockDevice(_ps: MockObj): MockObj {
  return {
    __brand: 'Dev',
    lost: new Promise(() => {}),
    features: new Set<string>(),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    limits: { maxStorageBuffersPerShaderStage: 0 } as any,
    queue: { submit: () => undefined, writeBuffer: () => ({ ok: true }) },
    createBuffer: () => ({ ok: true, value: { __brand: 'Buf' } }),
    createTexture: () => ({ ok: true, value: { __brand: 'Tex' } }),
    createBindGroupLayout: () => ({ ok: true, value: { __brand: 'BGL' } }),
    createBindGroup: () => ({ ok: true, value: { __brand: 'BG' } }),
    createPipelineLayout: () => ({ ok: true, value: { __brand: 'PL' } }),
    createRenderPipeline: () => ({ ok: true, value: { __brand: 'RP' } }),
    createSampler: () => ({ ok: true, value: { __brand: 'S' } }),
    createShaderModule: () => ({ ok: true, value: { __brand: 'SM' } }),
    createTextureView: () => ({ ok: true, value: { __brand: 'TV' } }),
    createCommandEncoder: () => ({
      ok: true,
      value: {
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
          setViewport: () => undefined,
          setScissorRect: () => undefined,
          setBlendConstant: () => undefined,
          setStencilReference: () => undefined,
        }),
        finish: () => ({ __brand: 'CB' }),
      },
    }),
  };
}

function makeSurfaceCtx(
  cfgCalls: { n: number },
  ctxCalls: { n: number },
  failCount: number,
): MockObj {
  return {
    configure: () => {
      cfgCalls.n++;
      return { ok: true };
    },
    unconfigure: () => undefined,
    getCurrentTexture: () => {
      ctxCalls.n++;
      if (ctxCalls.n <= failCount) {
        return {
          ok: false,
          error: new RhiError({ code: 'webgpu-runtime-error', expected: 'failed', hint: 'retry' }),
        };
      }
      return { ok: true, value: { __brand: 'Tex' } };
    },
  };
}

function makeCameras(): MockObj[] {
  return [
    {
      fov: 1,
      aspect: 1,
      near: 0.1,
      far: 100,
      posX: 0,
      posY: 0,
      posZ: 10,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      viewMatrix: new Float32Array(16),
      projMatrix: new Float32Array(16),
      clearColor: [0, 0, 0, 1],
    },
  ];
}

function makeLights(): MockObj {
  return {
    directional: undefined,
    directionalCount: 0,
    point: [],
    spot: [],
    lightViewProj: undefined,
    splitPlanes: undefined,
    cascadeCount: undefined,
    cascadeBlendWidth: undefined,
    cascadeBlend: undefined,
    csmShadowMapView: undefined,
    csmShadowAtlasSlot: undefined,
    csmShadowSplitCount: undefined,
    csmShadowCascadeCount: undefined,
    csmActive: false,
    shadowMapSize: 0,
    depthBias: 0,
    normalBias: 0,
    directionalShadowQuality: undefined,
    pointShadow: [],
  };
}

function makeFrameState(): MockObj {
  return {
    frameNumber: 1,
    compiledFrameGraph: null,
    compiledFrameGraphGeneration: 0,
    retiredCompiledFrameGraphs: new Set(),
    instanceBuffers: new Map(),
    transientInstanceBuffers: [],
    warnedZeroLightStandard: false,
    warnedMultiLightDirectional: false,
    warnedSkyboxTonemapNone: false,
    warnedMissingBaseColorTextureHandles: new Set<number>(),
    warnedNineSliceScaleEntities: new Set<number>(),
    viewBindGroupCache: new Map(),
    meshBindGroupCache: new Map(),
    materialBgCache: new Map(),
    instancesBgCache: new Map(),
    handleToId: new WeakMap<object, number>(),
    nextHandleId: 0,
    installedPipelineHandle: 0,
    activePipeline: { buildGraph: () => null, execute: () => undefined },
    installedPipelineConfig: undefined,
    standardOncePerFrameFired: new Set(),
    pointShadowAtlas: null,
    pointShadowSnapshots: [],
    lastFoldBucketCount: 0,
  };
}

function makeDispatchCounts(): MockObj {
  return { mainForward: 0, shadowCaster: 0, transparent: 0, skybox: 0, postProcess: 0, unlit: 0 };
}

function makeBindGroupCounts(): MockObj {
  return { createBindGroup: 0, keys: [] };
}

function callRecordFrame(
  // biome-ignore lint/suspicious/noExplicitAny: mock internals
  internals: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock cameras
  cameras: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock lights
  lights: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock frameState
  frameState: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock dispatchCounts
  dispatchCounts: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock bindGroupCounts
  bindGroupCounts: any,
): void {
  void cameras;
  void lights;
  void frameState;
  void dispatchCounts;
  void bindGroupCounts;
  acquireSwapChainTarget(internals, internals.getPipelineState());
}

type DirectionalShadowAdmission = {
  readonly requested: 'off' | 'pcf1' | 'pcf3' | 'pcf5' | 'pcssMedium' | 'pcssHigh';
  readonly effective:
    | 'off'
    | 'pcf1'
    | 'pcf3'
    | 'pcf5'
    | 'pcssMedium'
    | 'pcssHigh'
    | 'rhi-null-structural';
  readonly status: 'accepted' | 'fallback' | 'rejected';
  readonly fallbackReason?: 'webgl2-unsupported' | 'rhi-null-structural' | 'candidate-failed';
  readonly lastKnownGood: boolean;
  readonly pixelEvidence: 'available' | 'not-available';
};

async function resolveDirectionalShadowAdmission(input: {
  readonly backendKind: 'webgpu' | 'wgpu-webgl2' | 'null';
  readonly requested: DirectionalShadowAdmission['requested'];
  readonly candidate: 'accepted' | 'failed';
  readonly lastKnownGood?: Exclude<
    DirectionalShadowAdmission['effective'],
    'off' | 'rhi-null-structural'
  >;
}): Promise<DirectionalShadowAdmission> {
  const module = (await import('../../../render/src/render-pipeline')) as Record<string, unknown>;
  const resolver = module.resolveDirectionalShadowBackendAdmission;
  expect(typeof resolver).toBe('function');
  return (resolver as (value: typeof input) => DirectionalShadowAdmission)(input);
}

describe('M3 backend admission and fallback truthfulness', () => {
  it('keeps an explicitly disabled Directional shadow off without fabricating a candidate', async () => {
    await expect(
      resolveDirectionalShadowAdmission({
        backendKind: 'webgpu',
        requested: 'off',
        candidate: 'failed',
      }),
    ).resolves.toMatchObject({
      requested: 'off',
      effective: 'off',
      status: 'accepted',
      lastKnownGood: false,
      pixelEvidence: 'not-available',
    });
  });

  it('admits a production WebGPU/Dawn candidate without converting PCSS to PCF', async () => {
    await expect(
      resolveDirectionalShadowAdmission({
        backendKind: 'webgpu',
        requested: 'pcssMedium',
        candidate: 'accepted',
      }),
    ).resolves.toMatchObject({
      requested: 'pcssMedium',
      effective: 'pcssMedium',
      status: 'accepted',
      lastKnownGood: false,
      pixelEvidence: 'available',
    });
  });

  it.each([
    ['pcssMedium', 'pcf3'],
    ['pcssHigh', 'pcf5'],
  ] as const)('maps WebGL2 %s to fixed effective %s', async (requested, effective) => {
    await expect(
      resolveDirectionalShadowAdmission({
        backendKind: 'wgpu-webgl2',
        requested,
        candidate: 'accepted',
      }),
    ).resolves.toMatchObject({
      requested,
      effective,
      status: 'fallback',
      fallbackReason: 'webgl2-unsupported',
      pixelEvidence: 'available',
    });
  });

  it('projects RhiNull as structural evidence and never as pixel evidence', async () => {
    await expect(
      resolveDirectionalShadowAdmission({
        backendKind: 'null',
        requested: 'pcssHigh',
        candidate: 'accepted',
      }),
    ).resolves.toMatchObject({
      requested: 'pcssHigh',
      effective: 'rhi-null-structural',
      status: 'fallback',
      fallbackReason: 'rhi-null-structural',
      pixelEvidence: 'not-available',
    });
  });

  it('rejects a capable candidate failure while retaining compatible LKG', async () => {
    const result = await resolveDirectionalShadowAdmission({
      backendKind: 'webgpu',
      requested: 'pcssHigh',
      candidate: 'failed',
      lastKnownGood: 'pcf3',
    });
    expect(result).toMatchObject({
      requested: 'pcssHigh',
      effective: 'pcf3',
      status: 'rejected',
      fallbackReason: 'candidate-failed',
      lastKnownGood: true,
      pixelEvidence: 'available',
    });
    expect(result.effective).not.toBe('pcf5');
  });

  it('keeps falsifiers observable instead of allowing fake effective mappings', async () => {
    const result = await resolveDirectionalShadowAdmission({
      backendKind: 'wgpu-webgl2',
      requested: 'pcssMedium',
      candidate: 'accepted',
    });
    expect(result.fallbackReason).toBe('webgl2-unsupported');
    expect(result.effective).toBe('pcf3');
    expect(result).not.toMatchObject({ effective: 'pcssMedium' });
  });
});

describe('M3 bounded Directional shadow inspection', () => {
  it('requires one detached projection with bounded tap and generation facts', async () => {
    const module = (await import(
      '../../../render/src/assembly/directional-shadow-inspection'
    )) as Record<string, unknown>;
    const project = module.projectDirectionalShadowInspection;
    expect(typeof project).toBe('function');
    const result = (project as (input: Record<string, unknown>) => Record<string, unknown>)({
      admission: {
        requested: 'pcssHigh',
        effective: 'pcssHigh',
        status: 'accepted',
        pixelEvidence: 'available',
      },
      cascadeCount: 4,
      mapSize: 2048,
      shadowMapBytes: 67_108_864,
      writerPasses: 4,
      blockerTaps: 16,
      filterTapUpperBound: 32,
      seamTapUpperBound: 96,
      deviceGeneration: 2,
      graphGeneration: 7,
    });
    expect(result).toMatchObject({
      requested: 'pcssHigh',
      effective: 'pcssHigh',
      cascadeCount: 4,
      mapSize: 2048,
      blockerTaps: 16,
      filterTapUpperBound: 32,
      seamTapUpperBound: 96,
      deviceGeneration: 2,
      graphGeneration: 7,
    });
    expect(Object.keys(result)).not.toContain('perPixel');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('projects production facts instead of fixed request, taps, or generations', async () => {
    const module = (await import(
      '../../../render/src/assembly/directional-shadow-inspection'
    )) as Record<string, unknown>;
    const projectSource = module.projectDirectionalShadowInspectionSource;
    expect(typeof projectSource).toBe('function');
    const project = projectSource as (input: Record<string, unknown>) => Record<string, unknown>;
    const first = project({
      requested: 'pcf3',
      candidate: 'accepted',
      cascadeCount: 3,
      mapSize: 1024,
      shadowMapBytes: 12_582_912,
      writerPasses: 3,
      deviceGeneration: 4,
      graphGeneration: 11,
      shadowReady: true,
    });
    const second = project({
      requested: 'pcssHigh',
      candidate: 'failed',
      lastKnownGood: 'pcf3',
      cascadeCount: 4,
      mapSize: 2048,
      shadowMapBytes: 67_108_864,
      writerPasses: 4,
      deviceGeneration: 5,
      graphGeneration: 12,
      shadowReady: false,
    });
    expect(first).toMatchObject({
      requested: 'pcf3',
      effective: 'pcf3',
      status: 'accepted',
      filterTapUpperBound: 9,
      seamTapUpperBound: 9,
      cascadeCount: 3,
      mapSize: 1024,
      deviceGeneration: 4,
      graphGeneration: 11,
    });
    expect(second).toMatchObject({
      requested: 'pcssHigh',
      effective: 'pcf3',
      status: 'rejected',
      lastKnownGood: true,
      blockerTaps: 16,
      filterTapUpperBound: 32,
      seamTapUpperBound: 96,
      cascadeCount: 4,
      mapSize: 2048,
      deviceGeneration: 5,
      graphGeneration: 12,
    });
    expect(second).not.toMatchObject({ requested: 'pcf3', status: 'accepted', shadowMapBytes: 0 });
  });
});

// ── w5: surface retry — reconfigure + retry once (AC-03) ─────────────────────

describe('Surface retry (w5)', () => {
  it('w5: getCurrentTexture fail-once -> reconfigure -> retry succeeds', () => {
    const cfgCalls = { n: 0 };
    const ctxCalls = { n: 0 };
    const ps = makePipelineState();
    const reg = new HealthListenerRegistry();
    const mockCtx = makeSurfaceCtx(cfgCalls, ctxCalls, 1);
    const dev = makeMockDevice(ps);

    // biome-ignore lint/suspicious/noExplicitAny: test internals
    const internals: any = {
      canvas: { width: 800, height: 600 },
      device: dev,
      context: mockCtx,
      getPipelineState: () => ps,
      assets: { register: () => ({ ok: true }), instantiate: () => ({ ok: true }) },
      gpuStore: {
        destroyAll: () => undefined,
        ensureResident: () => ({ ok: true }),
        getMeshGpuHandles: () => ({
          ok: true,
          value: {
            indexBuffer: { __brand: 'Buf' },
            vertexBuffer: { __brand: 'Buf' },
            indexFormat: 'uint32',
            indexCount: 0,
            vertexCount: 0,
          },
        }),
        getTextureView: () => ({ ok: true, value: { __brand: 'TV' } }),
        resolveHandleId: () => 0,
      },
      errorRegistry: { add: () => () => {}, fire: (_e: unknown) => {}, clear: () => {} },
      getMaterialShaderPipeline: undefined,
      getParamSchema: undefined,
      getMaterialBindGroupLayout: undefined,
      metrics: { increment: () => undefined, counter: () => 0 },
      growMeshSsbo: undefined,
      meshSsboState: undefined,
      buildPostProcessPipeline: undefined,
      healthRegistry: reg,
    };

    callRecordFrame(
      internals,
      makeCameras(),
      makeLights(),
      makeFrameState(),
      makeDispatchCounts(),
      makeBindGroupCounts(),
    );

    // AC-03: getCurrentTexture called twice (fail + retry)
    expect(ctxCalls.n).toBe(2);
    // AC-03: context configured (retry reconfigure)
    expect(cfgCalls.n).toBe(1);
  });

  it('w5(b): normal hot path — zero reconfigure calls (AC-05)', () => {
    const cfgCalls = { n: 0 };
    const ctxCalls = { n: 0 };
    const ps = makePipelineState();
    const mockCtx = makeSurfaceCtx(cfgCalls, ctxCalls, 0);
    const dev = makeMockDevice(ps);

    // biome-ignore lint/suspicious/noExplicitAny: test internals
    const internals: any = {
      canvas: { width: 800, height: 600 },
      device: dev,
      context: mockCtx,
      getPipelineState: () => ps,
      assets: { register: () => ({ ok: true }), instantiate: () => ({ ok: true }) },
      gpuStore: {
        destroyAll: () => undefined,
        ensureResident: () => ({ ok: true }),
        getMeshGpuHandles: () => ({
          ok: true,
          value: {
            indexBuffer: { __brand: 'Buf' },
            vertexBuffer: { __brand: 'Buf' },
            indexFormat: 'uint32',
            indexCount: 0,
            vertexCount: 0,
          },
        }),
        getTextureView: () => ({ ok: true, value: { __brand: 'TV' } }),
        resolveHandleId: () => 0,
      },
      errorRegistry: { add: () => () => {}, fire: (_e: unknown) => {}, clear: () => {} },
      getMaterialShaderPipeline: undefined,
      getParamSchema: undefined,
      getMaterialBindGroupLayout: undefined,
      metrics: { increment: () => undefined, counter: () => 0 },
      growMeshSsbo: undefined,
      meshSsboState: undefined,
      buildPostProcessPipeline: undefined,
      healthRegistry: new HealthListenerRegistry(),
    };

    callRecordFrame(
      internals,
      makeCameras(),
      makeLights(),
      makeFrameState(),
      makeDispatchCounts(),
      makeBindGroupCounts(),
    );

    // AC-05: normal hot path — getCurrentTexture once, reconfigure zero
    expect(ctxCalls.n).toBe(1);
    expect(cfgCalls.n).toBe(0);
  });

  it('keeps an existing configured LKG when a reconfigure candidate fails proof validation', () => {
    const cfgCalls = { n: 0 };
    const ctxCalls = { n: 0 };
    const ps = makePipelineState();
    const reg = new HealthListenerRegistry();
    const mockCtx = {
      ...makeSurfaceCtx(cfgCalls, ctxCalls, 1),
      presentationProof: { descriptor: true, acquisition: false, validation: true },
    };
    const pipelineState = ps as unknown as Parameters<typeof acquireSwapChainTarget>[1];
    const dev = makeMockDevice(ps);
    dev.caps = { backendKind: 'wgpu-webgl2', storageBuffer: false };
    const errors: unknown[] = [];

    // biome-ignore lint/suspicious/noExplicitAny: mock internals
    const internals: any = {
      canvas: { width: 800, height: 600 },
      device: dev,
      context: mockCtx,
      getPipelineState: () => ps,
      errorRegistry: {
        add: () => () => {},
        fire: (error: unknown) => errors.push(error),
        clear: () => {},
      },
      healthRegistry: reg,
    };

    const target = acquireSwapChainTarget(internals, pipelineState);

    expect(target).toBeNull();
    expect(cfgCalls.n).toBe(1);
    expect(ctxCalls.n).toBe(1);
    expect(ps.perPassResources.configured).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('keeps the first surface failure unconfigured and skips the retry', () => {
    const cfgCalls = { n: 0 };
    const ctxCalls = { n: 0 };
    const ps = makePipelineState();
    ps.perPassResources.configured = false;
    const mockCtx = {
      ...makeSurfaceCtx(cfgCalls, ctxCalls, 1),
      presentationProof: { descriptor: true, acquisition: false, validation: true },
    };
    const pipelineState = ps as unknown as Parameters<typeof acquireSwapChainTarget>[1];
    const dev = makeMockDevice(ps);
    dev.caps = { backendKind: 'wgpu-webgl2', storageBuffer: false };

    // biome-ignore lint/suspicious/noExplicitAny: mock internals
    const internals: any = {
      canvas: { width: 800, height: 600 },
      device: dev,
      context: mockCtx,
      getPipelineState: () => ps,
      errorRegistry: { add: () => () => {}, fire: () => {}, clear: () => {} },
      healthRegistry: new HealthListenerRegistry(),
    };

    expect(acquireSwapChainTarget(internals, pipelineState)).toBeNull();
    expect(cfgCalls.n).toBe(1);
    expect(ctxCalls.n).toBe(1);
    expect(ps.perPassResources.configured).toBe(false);
  });
});

// ── w6: consecutive surface failure -> internal-fault (AC-04) ────────────────

describe('Surface consecutive failure (w6)', () => {
  it('w6: both attempts fail -> health().reason is internal-fault with surface detail', () => {
    const cfgCalls = { n: 0 };
    const ctxCalls = { n: 0 };
    const ps = makePipelineState();
    const reg = new HealthListenerRegistry();
    const mockCtx = makeSurfaceCtx(cfgCalls, ctxCalls, 999);
    const dev = makeMockDevice(ps);

    // biome-ignore lint/suspicious/noExplicitAny: test internals
    const internals: any = {
      canvas: { width: 800, height: 600 },
      device: dev,
      context: mockCtx,
      getPipelineState: () => ps,
      assets: { register: () => ({ ok: true }), instantiate: () => ({ ok: true }) },
      gpuStore: {
        destroyAll: () => undefined,
        ensureResident: () => ({ ok: true }),
        getMeshGpuHandles: () => ({
          ok: true,
          value: {
            indexBuffer: { __brand: 'Buf' },
            vertexBuffer: { __brand: 'Buf' },
            indexFormat: 'uint32',
            indexCount: 0,
            vertexCount: 0,
          },
        }),
        getTextureView: () => ({ ok: true, value: { __brand: 'TV' } }),
        resolveHandleId: () => 0,
      },
      errorRegistry: { add: () => () => {}, fire: (_e: unknown) => {}, clear: () => {} },
      getMaterialShaderPipeline: undefined,
      getParamSchema: undefined,
      getMaterialBindGroupLayout: undefined,
      metrics: { increment: () => undefined, counter: () => 0 },
      growMeshSsbo: undefined,
      meshSsboState: undefined,
      buildPostProcessPipeline: undefined,
      healthRegistry: reg,
    };

    // Baseline: alive
    expect(reg.getLastSnapshot().reason).toBe('alive');

    callRecordFrame(
      internals,
      makeCameras(),
      makeLights(),
      makeFrameState(),
      makeDispatchCounts(),
      makeBindGroupCounts(),
    );

    // AC-04: health reason is internal-fault
    const snap = reg.getLastSnapshot();
    expect(snap.reason).toBe('internal-fault');
    if (snap.reason === 'internal-fault') {
      expect(snap.detail.message).toMatch(/surface/i);
    }
  });
});
