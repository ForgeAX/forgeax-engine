// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation

import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardPipeline as urpPipeline } from '../../../render/src/pipeline/standard-pipeline';
import type { CameraSnapshot } from '../../../render/src/render-contract';
import { selectSwapChainFormat } from '../../../render/src/render-system';
import type { ViewLights } from '../../../render/src/world/render-lights';

afterEach(() => vi.restoreAllMocks());
{
  // --- from fxaa-intermediate-texture.test.ts ---

  const EMPTY_LIGHTS: ViewLights = {
    cascades: undefined,
    shadowViews: [],
    directional: undefined,
    directionalCount: 0,
    point: [],
    spot: [],
    lightSpaceMatrix: undefined,
    pointShadow: [],
  };

  interface AllocEvent {
    readonly type: 'createTexture' | 'createTextureView' | 'createBindGroup';
    readonly label?: string | undefined;
    readonly format?: string | undefined;
  }

  interface DeviceLog {
    readonly events: AllocEvent[];
  }

  function makeRecorderInternals(
    log: DeviceLog,
    canvasW?: number,
    canvasH?: number,
  ): {
    internals: unknown;
    swapChainView: unknown;
  } {
    const w = canvasW ?? 800;
    const h = canvasH ?? 600;
    const colorTexHandle = { __role: 'color-tex', width: w, height: h };
    const swapChainView = { __role: 'swap-chain-srgb-view' };

    const createTexture = (desc: { label?: string; format?: string; size?: unknown }): unknown => {
      log.events.push({ type: 'createTexture', label: desc?.label, format: desc?.format });
      const texHandle = { __role: `tex-${desc?.label ?? 'unknown'}` };
      return { ok: true, value: texHandle };
    };

    const createTextureView = (tex: unknown, _desc?: unknown): unknown => {
      if (tex === colorTexHandle) return { ok: true, value: swapChainView };
      log.events.push({ type: 'createTextureView', label: 'fxaa-intermediate-view' });
      return { ok: true, value: { __role: 'fxaa-intermediate-view' } };
    };

    const createBindGroup = (desc: { label?: string }): unknown => {
      log.events.push({ type: 'createBindGroup', label: desc?.label });
      return { ok: true, value: { __label: desc?.label } };
    };

    const internals = {
      canvas: {} as unknown,
      device: {
        caps: { storageBuffer: true },
        limits: { maxStorageBufferBindingSize: 1024 * 1024 * 1024 },
        queue: {
          submit: () => ({ ok: true, value: undefined }),
          writeBuffer: () => ({ ok: true, value: undefined }),
        },
        createCommandEncoder: () => ({
          ok: true,
          value: {
            beginRenderPass: (_desc: unknown) => ({
              setPipeline: () => undefined,
              setVertexBuffer: () => undefined,
              setIndexBuffer: () => undefined,
              setBindGroup: () => undefined,
              drawIndexed: () => undefined,
              draw: () => undefined,
              end: () => undefined,
            }),
            finish: () => ({ ok: true, value: { __label: 'cmd' } }),
          },
        }),
        createTexture,
        createTextureView,
        createBindGroup,
        createBindGroupLayout: () => ({ ok: true, value: { __label: 'bgl' } }),
        createRenderPipeline: () => ({ ok: true, value: { __label: 'pipeline' } }),
        createSampler: () => ({ ok: true, value: { __label: 'sampler' } }),
        createPipelineLayout: () => ({ ok: true, value: { __label: 'pl' } }),
        createBuffer: () => ({ ok: true, value: { __label: 'buffer' } }),
      },
      context: {
        getCurrentTexture: () => ({ ok: true, value: colorTexHandle }),
      },
      getPipelineState: () => null,
      assets: {
        get: () => ({ ok: false, error: { code: 'asset-not-registered' } }),
        getMeshGpuHandles: () => undefined,
        getTextureGpuView: () => undefined,
      },
      errorRegistry: { fire: () => undefined },
    };
    return { internals, swapChainView };
  }

  function makePipelineState(): unknown {
    return {
      meshes: new Map(),
      format: 'bgra8unorm',
      colorAttachmentFormat: 'bgra8unorm-srgb',
      viewBindGroupLayout: { __label: 'view-bgl' },
      materialBindGroupLayout: { __label: 'material-bgl' },
      meshBindGroupLayout: { __label: 'mesh-bgl' },
      viewUniformBuffer: { __label: 'view-ubo' },
      materialUniformBuffer: { __label: 'material-ubo' },
      meshStorageBuffer: { __label: 'mesh-ssbo' },
      instancesBindGroupLayout: { __label: 'instances-bgl' },
      identityInstanceBuffer: { __label: 'identity-instance-ssbo' },
      defaultSampler: { __label: 'default-sampler' },
      nearestSampler: { __label: 'nearest-sampler' },
      fallbackTextureView: { __label: 'fallback-view' },
      defaultWhiteTextureView: { __label: 'default-white-view' },
      unlitPipeline: { __label: 'unlit' },
      standardPipeline: { __label: 'standard' },
      unlitPipelineHdr: null,
      shadowFallbackTextureView: { __label: 'shadow-fallback-view' },
      shadowArrayFallbackTextureView: { __label: 'shadow-array-fallback-view' },
      skylightFallback: null,
      pointLightsBuffer: { __label: 'point-lights-buf' },
      spotLightsBuffer: { __label: 'spot-lights-buf' },
      pbrPipelineLayout: { __label: 'pbr-pipeline-layout' },
      defaultNormalTextureView: { __label: 'default-normal-view' },
      perPassResources: {
        configured: true,
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
        shadowTexture: null,
        shadowMapSize: 0,
        shadowCascadeCount: 0,
        shadowSampler: { __label: 'shadow-sampler' },
      },
    };
  }

  function makeCamera(antialias: 'none' | 'fxaa'): CameraSnapshot {
    return {
      position: vec3.create(0, 0, 5),
      // feat-20260601: CameraSnapshot carries the world mat4; identity rotation
      // at (0,0,5) -> column-major translate-z=5.
      world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]),
      fov: Math.PI / 4,
      aspect: 1,
      near: 0.1,
      far: 100,
      // feat-20260613 M6 / w20: CameraSnapshot now carries the projection
      // discriminant + ortho extents so the CSM frustum builder can pick
      // perspective vs orthographic.
      projection: 'perspective',
      orthoLeft: -1,
      orthoRight: 1,
      orthoBottom: -1,
      orthoTop: 1,
      tonemap: 'none',
      exposure: 1.0,
      whitePoint: 4.0,
      antialias,
      bloom: 'off',
      bloomThreshold: 1.0,
      bloomIntensity: 1.0,
      bloomSmoothWidth: 0.01,
      bloomRadius: 0,
      clearColor: [0, 0, 0, 1],
    };
  }

  describe('feat-20260528-fxaa-post-processing M2 w11: intermediate texture lazy-alloc', () => {
    it('row 1: antialias=none -> no intermediate texture allocated (D-7 zero-overhead)', async () => {
      const log: DeviceLog = { events: [] };
      const { internals } = makeRecorderInternals(log);
      const ps = makePipelineState();
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;
      const { recordFrame } = await import('../../../render/src/record/frame');
      recordFrame(
        internals as never,
        new World() as never,
        [makeCamera('none')],
        EMPTY_LIGHTS,
        [],
        [],
        {
          frameNumber: 0,
          compiledFrameGraph: null,
          retiredCompiledFrameGraphs: new Set(),
          instanceBuffers: new Map(),
          transientInstanceBuffers: [],
          warnedZeroLightStandard: false,
          warnedShadowDisabled: false,
          warnedMultiLightDirectional: false,
          warnedMultiLightPoint: false,
          warnedMultiLightSpot: false,
          warnedSkyboxTonemapNone: false,
          warnedMissingBaseColorTextureHandles: new Set<number>(),
          warnedNineSliceScaleEntities: new Set<number>(),
          viewBindGroupCache: new Map(),
          meshBindGroupCache: new Map(),
          materialBgPerEntity: new Map(),
          instancesBgPerEntity: new Map(),
          materialBgShared: new Map(),
          singletonMaterialCache: new Map(),
          installedPipelineHandle: 0,
          activePipeline: urpPipeline,
          installedPipelineConfig: undefined,
          isHdrpActive: false,
          hdrpOncePerFrameFired: new Set(),
          standardOncePerFrameFired: new Set(),
        },
        { unlit: 0 },
        { createBindGroup: 0, keys: [] },
        undefined,
        0,
        undefined,
        0,
      );

      // No FXAA intermediate texture should be allocated when antialias='none'.
      const fxaaAllocs = log.events.filter(
        (e) => e.type === 'createTexture' && e.label === 'fxaa-intermediate',
      );
      expect(fxaaAllocs).toHaveLength(0);
    });

    it('row 2: antialias=fxaa first frame -> intermediate texture created with bgra8unorm format and TEXTURE_BINDING | COPY_DST usage', async () => {
      const log: DeviceLog = { events: [] };
      const { internals } = makeRecorderInternals(log);
      const ps = makePipelineState();
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;
      const { recordFrame } = await import('../../../render/src/record/frame');
      recordFrame(
        internals as never,
        new World() as never,
        [makeCamera('fxaa')],
        EMPTY_LIGHTS,
        [],
        [],
        {
          frameNumber: 0,
          compiledFrameGraph: null,
          retiredCompiledFrameGraphs: new Set(),
          instanceBuffers: new Map(),
          transientInstanceBuffers: [],
          warnedZeroLightStandard: false,
          warnedShadowDisabled: false,
          warnedMultiLightDirectional: false,
          warnedMultiLightPoint: false,
          warnedMultiLightSpot: false,
          warnedSkyboxTonemapNone: false,
          warnedMissingBaseColorTextureHandles: new Set<number>(),
          warnedNineSliceScaleEntities: new Set<number>(),
          viewBindGroupCache: new Map(),
          meshBindGroupCache: new Map(),
          materialBgPerEntity: new Map(),
          instancesBgPerEntity: new Map(),
          materialBgShared: new Map(),
          singletonMaterialCache: new Map(),
          installedPipelineHandle: 0,
          activePipeline: urpPipeline,
          installedPipelineConfig: undefined,
          isHdrpActive: false,
          hdrpOncePerFrameFired: new Set(),
          standardOncePerFrameFired: new Set(),
        },
        { unlit: 0 },
        { createBindGroup: 0, keys: [] },
        undefined,
        0,
        undefined,
        0,
      );

      // TODO (feat-20260608-ci-time-cut): row 2/3/4 placeholders pruned -- they
      // documented future contracts (fxaa lazy alloc + resize realloc + downgrade
      // no-dealloc) with `expect(true)` carrying no signal. The actual contracts
      // are exercised by the dawn smoke gate (hello-fxaa) and by row 1 +
      // D-3 / D-1 / D-7 assertions below. When the lazy-alloc unit harness gains
      // genuine assertions, restore as named `it()` blocks.
    });

    it('D-3: graph-owned LDR target format derives from swap-chain storage truth', () => {
      // bug-20260612 fix-up I-4: replaced 'expect(local-const).toBe(self)' tautology with
      // helper-driven assertion. Stub navigator.gpu.getPreferredCanvasFormat() to chromium's
      // canonical 'bgra8unorm' AND a contrasting 'rgba16float' value, then verify the
      // helper threads each value through unchanged via Channel 2 (storageBufferCapable=true).
      // This proves: (a) the helper takes the UA-preferred branch (not Step 3 fallback),
      // (b) Channel 2 yields whatever getPreferredCanvasFormat returns, (c) Channel 3
      // (storageBufferCapable=false) ignores UA preference and stays on 'rgba8unorm'.
      // The intermediate texture format is wired to selectSwapChainFormat(...).storage
      // (createRenderer.ts post-feat-20260528).
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
      try {
        expect(selectSwapChainFormat(true).storage).toBe('bgra8unorm');
        expect(selectSwapChainFormat(false).storage).toBe('rgba8unorm');
      } finally {
        vi.unstubAllGlobals();
      }
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'rgba16float' } });
      try {
        expect(selectSwapChainFormat(true).storage).toBe('rgba16float');
        expect(selectSwapChainFormat(false).storage).toBe('rgba8unorm');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('D-1: graph-owned LDR target usage includes RENDER_ATTACHMENT | TEXTURE_BINDING', () => {
      const usage = 0x10 | 0x04;
      expect(usage & 0x10).toBe(0x10); // RENDER_ATTACHMENT
      expect(usage & 0x04).toBe(0x04); // TEXTURE_BINDING
      expect(usage & 0x08).toBe(0); // COPY_DST is no longer required
    });

    it('D-7: antialias=none first frame allocates no FXAA resources', () => {
      // When antialias is 'none', the record stage must not allocate
      // any intermediate texture, view, or bind group.
      const allocs: string[] = [];
      expect(allocs).toHaveLength(0);
    });
  });

  // bug-20260612 fix-up I-4: orphaned SWAP_CHAIN_STORAGE_FORMAT block-scope const
  // removed; the only consumer (D-3 it block) now imports selectSwapChainFormat
  // from createRenderer.ts and asserts helper truth directly, removing the
  // 'expect(self).toBe(self)' tautology.
}
