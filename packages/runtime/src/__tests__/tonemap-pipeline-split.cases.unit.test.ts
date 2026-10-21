// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardPipeline as urpPipeline } from '../../../render/src/pipeline/standard-pipeline';
import { emptyFrameRecordingOutputs } from '../../../render/src/record/frame-snapshot';
import type { CameraSnapshot } from '../../../render/src/render-contract';
import type { ExtractedLights } from '../../../render/src/render-system-extract';

afterEach(() => vi.restoreAllMocks());
{
  // --- from tonemap-pipeline-split.test.ts ---

  // feat-20260519-light-casters-point-spot-pbr: ExtractedLights three-bucket
  // shape (replaces the legacy `LightSnapshot[]` shape pre-merge). Tonemap
  // routing tests do not exercise the lighting path, so the empty bucket
  // (no directional + zero point/spot) is the valid neutral fixture.
  const EMPTY_LIGHTS: ExtractedLights = {
    directional: undefined,
    directionalCount: 0,
    point: [],
    spot: [],
    rect: [],
    lightSpaceMatrix: undefined,
    shadowMapSize: undefined,
    pointShadow: [],
  };

  interface PassEvent {
    readonly type:
      | 'beginRenderPass'
      | 'setPipeline'
      | 'setBindGroup'
      | 'draw'
      | 'drawIndexed'
      | 'end'
      | 'createBindGroup'
      | 'createTexture'
      | 'writeBuffer';
    readonly label?: string | undefined;
    readonly view?: unknown;
    readonly format?: string | undefined;
    readonly pipeline?: unknown;
    readonly bgLabel?: string | undefined;
    readonly buffer?: unknown;
    readonly drawArg?: number | undefined;
  }

  interface DeviceLog {
    readonly events: PassEvent[];
  }

  function makeRecorderInternals(log: DeviceLog): unknown {
    // Mark sentinel objects per role so the log distinguishes pipelines.
    const fakeUnlitPipeline = { __role: 'unlit' };
    const fakeUnlitHdrPipeline = { __role: 'unlit-hdr' };
    const fakeStandardPipeline = { __role: 'standard' };
    const fakeStandardHdrPipeline = { __role: 'standard-hdr' };
    const fakeTonemapPipeline = { __role: 'tonemap' };
    const swapChainView = { __role: 'swap-chain-srgb-view' };
    const hdrColorView = { __role: 'hdr-color-view' };
    const hdrDepthView = { __role: 'hdr-depth-view' };
    const swapDepthView = { __role: 'depth-view' };
    const hdrColorTexHandle = { __role: 'hdr-color-tex' };
    const hdrDepthTexHandle = { __role: 'hdr-depth-tex' };
    const fakeColorTex = {
      width: 800,
      height: 600,
      createView: () => swapChainView,
    };

    const beginRenderPass = (desc: { colorAttachments?: Array<{ view?: unknown }> }): unknown => {
      const view = desc?.colorAttachments?.[0]?.view;
      log.events.push({
        type: 'beginRenderPass',
        view,
      });
      return {
        setPipeline(p: unknown): void {
          const role =
            p === fakeUnlitPipeline
              ? 'unlit'
              : p === fakeUnlitHdrPipeline
                ? 'unlit-hdr'
                : p === fakeStandardPipeline
                  ? 'standard'
                  : p === fakeStandardHdrPipeline
                    ? 'standard-hdr'
                    : p === fakeTonemapPipeline
                      ? 'tonemap'
                      : 'unknown';
          log.events.push({ type: 'setPipeline', label: role });
        },
        setVertexBuffer(): void {
          // unused
        },
        setIndexBuffer(): void {
          // unused
        },
        setBindGroup(_idx: number, bg: { __label?: string }): void {
          log.events.push({ type: 'setBindGroup', bgLabel: bg?.__label });
        },
        drawIndexed(): void {
          log.events.push({ type: 'drawIndexed' });
        },
        draw(arg: number): void {
          log.events.push({ type: 'draw', drawArg: arg });
        },
        end(): void {
          log.events.push({ type: 'end' });
        },
      };
    };

    const internals = {
      canvas: {} as unknown,
      device: {
        features: new Set(),
        caps: { storageBuffer: true, backendKind: 'webgpu' },
        limits: { maxStorageBufferBindingSize: 1024 * 1024 * 1024 },
        queue: {
          submit: () => ({ ok: true, value: undefined }),
          writeBuffer: (buffer: { __label?: string }) => {
            log.events.push({ type: 'writeBuffer', buffer });
            return { ok: true, value: undefined };
          },
        },
        createCommandEncoder: () => ({
          ok: true,
          value: {
            beginRenderPass,
            finish: () => ({ ok: true, value: { __label: 'cmd' } }),
          },
        }),
        createTextureView: (texture: unknown) => {
          // The current swap-chain texture (fakeColorTex) returns the
          // pre-stamped `swapChainView` sentinel so the test can distinguish
          // it from HDR-view sentinels stamped by `createTexture`.
          if (
            texture === fakeColorTex ||
            (typeof texture === 'object' &&
              texture !== null &&
              'width' in texture &&
              'height' in texture)
          ) {
            return { ok: true, value: swapChainView };
          }
          if (texture === hdrColorTexHandle) {
            return { ok: true, value: hdrColorView };
          }
          if (texture === hdrDepthTexHandle) {
            return { ok: true, value: hdrDepthView };
          }
          return { ok: true, value: { __role: 'view' } };
        },
        createTexture: (desc: { format?: string; label?: string }) => {
          log.events.push({ type: 'createTexture', format: desc?.format, label: desc?.label });
          let value: unknown;
          // M1 / w7: labels changed from manual ensureLazyTexture prefixes
          // ('render-system-hdr-*') to graph addColorTarget resource names.
          if (desc?.label === 'hdrColor') {
            value = hdrColorTexHandle;
          } else if (desc?.label === 'hdrDepth') {
            value = hdrDepthTexHandle;
          } else if (desc?.label === 'depth') {
            value = { createView: () => swapDepthView };
          } else {
            value = {
              createView: () => ({ __role: `${desc?.format ?? 'unknown'}-view` }),
            };
          }
          return { ok: true, value };
        },
        createBindGroup: (desc: { label?: string }) => {
          log.events.push({ type: 'createBindGroup', label: desc?.label });
          return { ok: true, value: { __label: desc?.label } };
        },
      },
      context: {
        getCurrentTexture: () => ({ ok: true, value: fakeColorTex }),
      },
      getPipelineState: () => null,
      assets: {
        catalogEpoch: 0,
        get: () => ({ ok: false, error: { code: 'asset-not-registered' } }),
        getMeshGpuHandles: () => undefined,
        getTextureGpuView: () => undefined,
      },
      deviceScope: { generation: 0 },
      gpuStore: { meshResidencyEpoch: 0 },
      errorRegistry: {
        fire: () => undefined,
      },
      _fakes: {
        fakeUnlitPipeline,
        fakeUnlitHdrPipeline,
        fakeStandardPipeline,
        fakeStandardHdrPipeline,
        fakeTonemapPipeline,
        swapChainView,
        hdrColorView,
        hdrDepthView,
        swapDepthView,
      },
    };
    return internals;
  }

  function makePipelineState(internals: { _fakes: Record<string, unknown> }): unknown {
    const f = internals._fakes;
    return {
      device: (internals as { device?: unknown }).device,
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
      unlitPipeline: f.fakeUnlitPipeline,
      standardPipeline: f.fakeStandardPipeline,
      // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w10:
      // sprite-specific PipelineState fields removed (AC-12). Sprite PSO
      // now flows through the same generic per-MaterialShader pipeline cache
      // every other transparent material uses (plan-strategy D-7).
      unlitPipelineHdr: f.fakeUnlitHdrPipeline,
      perPassResources: {
        configured: true,
      },
    };
  }

  function makeCamera(tonemap: 'none' | 'reinhard-extended'): CameraSnapshot {
    return {
      position: vec3.create(0, 0, 5),
      // feat-20260601: CameraSnapshot carries the world mat4; identity rotation
      // at (0,0,5) -> column-major translate-z=5.
      world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]),
      fov: Math.PI / 4,
      aspect: 1,
      near: 0.1,
      far: 100,
      // feat-20260613 M6 / w20: CameraSnapshot now carries projection +
      // ortho extents (see CSM frustum-fit fix in render-system-extract).
      projection: 'perspective',
      orthoLeft: -1,
      orthoRight: 1,
      orthoBottom: -1,
      orthoTop: 1,
      tonemap,
      exposure: 1.0,
      whitePoint: 4.0,
      antialias: 'none',
      bloom: 'off',
      bloomThreshold: 1.0,
      bloomIntensity: 1.0,
      bloomSmoothWidth: 0.01,
      bloomRadius: 0,
      clearColor: [0, 0, 0, 1],
    };
  }

  describe('feat-20260519-tonemap-reinhard-mvp T-M3.1: record-stage tonemap routing', () => {
    it('row 1: tonemap=none camera writes linear LDR graph output + emits NO tonemap pass (AC-03(c) / AC-11)', async () => {
      const log: DeviceLog = { events: [] };
      const internals = makeRecorderInternals(log);
      const ps = makePipelineState(internals as never);
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;
      const { recordFrame } = await import('../../../render/src/record/frame');
      const cameras = [makeCamera('none')];
      recordFrame(
        internals as never,
        new World() as never,
        cameras,
        EMPTY_LIGHTS,
        [],
        [],
        {
          frameNumber: 0,
          compiledFrameGraph: null,
          frameOutputs: emptyFrameRecordingOutputs(),
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

      // M1 / w7: the render-graph allocates ALL color targets (including HDR)
      // at buildGraph compile time, not lazily per-frame. Native tonemap='none'
      // uses the graph-owned linear-LDR target and its output hand-off, not the
      // HDR view; the tonemap shader pass is skipped.
      // The assertion below verifies the pass routing, not the allocation gate.
      // (Row 2 covers the actual HDR texture allocation labels.)

      // No tonemap setPipeline event (no tonemap pass was encoded).
      const tonemapSets = log.events.filter(
        (e) => e.type === 'setPipeline' && e.label === 'tonemap',
      );
      expect(tonemapSets).toHaveLength(0);
    });
  });
}
