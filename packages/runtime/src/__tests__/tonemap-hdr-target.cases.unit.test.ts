// @ts-nocheck — merged file: indexed-access checks cascade across noUncheckedIndexedAccess for blocks originally outside src/ rootDir
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=44):
//   - packages/runtime/__tests__/antialias-from-f32.test.ts
//   - packages/runtime/src/__tests__/bloom-gating.test.ts
//   - packages/runtime/src/__tests__/camera-antialias.test.ts
//   - packages/runtime/src/__tests__/camera-bloom.test.ts
//   - packages/runtime/src/__tests__/camera-clear-schema.test.ts
//   - packages/runtime/src/__tests__/camera-ortho.test.ts
//   - packages/runtime/src/__tests__/fxaa-intermediate-texture.test.ts
//   - packages/runtime/src/__tests__/fxaa-pipeline.test.ts
//   - packages/runtime/src/__tests__/ibl-pipeline-cache.test.ts
//   - packages/runtime/src/__tests__/ibl-runtime-probe.test.ts
//   - packages/runtime/src/__tests__/render-system-record-warn-once.test.ts
//   - packages/runtime/src/__tests__/shadow-skip-non-triangle.test.ts
//   - packages/runtime/src/__tests__/skin-errors-kebab-case.test.ts
//   - packages/runtime/src/__tests__/skybox-error.test.ts
//   - packages/runtime/src/__tests__/skybox-shader-compile.test.ts
//   - packages/runtime/src/__tests__/skylight-bind-group.test.ts
//   - packages/runtime/src/__tests__/skylight-component.test.ts
//   - packages/runtime/src/__tests__/skylight-fallback-path.test.ts
//   - packages/runtime/src/__tests__/skylight-pipeline-layout.test.ts
//   - packages/runtime/src/__tests__/tonemap-hdr-target.test.ts
//   - packages/runtime/src/__tests__/tonemap-pipeline-split.test.ts
//   - packages/runtime/src/__tests__/zero-camera-clear-fallback.test.ts
//   - packages/runtime/src/components/__tests__/skin.test.ts
//   - packages/runtime/src/systems/__tests__/advance-animation-player.test.ts
//   - packages/runtime/src/systems/__tests__/graph-skybox.test.ts
//   - packages/runtime/src/systems/__tests__/propagate-transforms.test.ts
//   - packages/runtime/src/systems/__tests__/skin-cap-gate.test.ts
//   - packages/runtime/src/systems/__tests__/skin-instances-coexist.test.ts
//   - packages/runtime/src/systems/__tests__/skin-palette-extract.test.ts
//   - packages/runtime/src/systems/__tests__/skin-pipeline-routing.test.ts
//   - packages/runtime/src/systems/__tests__/skybox-extract.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-boundary.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-clamp.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-frame-duration-negative.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-frame-duration-zero.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-loop.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-override-probe.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-regions-mismatch.test.ts
//   - packages/runtime/src/systems/__tests__/tonemap.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort-config-get.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort-config-set.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort.test.ts
//   - packages/runtime/src/__tests__/render-system-multi-material.test.ts
//   - packages/runtime/src/__tests__/render-system-record-submesh.test.ts
//
// Paradigm: each block-scope wraps a source file. ancestorTitles[0] is the
// source-preserved inner describe (NOT the source filename for these 3 files
// — recovery path: vitest report ancestorTitles -> grep this file -> upstream
// `// ─── from <name>.test.ts ───` block separator -> source filename).
// Top-level imports merged + deduped.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationPlayer } from '@forgeax/engine-animation';
import type { AssetRuntimeErrorCode } from '@forgeax/engine-assets-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World as WorldType } from '@forgeax/engine-ecs';
import { ENTITY_NULL_RAW, World } from '@forgeax/engine-ecs';
import { SpriteAnimationInvalidError } from '@forgeax/engine-ecs/projection';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { RenderErrorCode, Renderer as RendererType } from '@forgeax/engine-render';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  MeshFilter,
  MeshRenderer,
  SkyboxBackground,
  Skylight,
} from '@forgeax/engine-render';
import type { BindGroupEntry, Buffer, Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok as rhiOk } from '@forgeax/engine-rhi';
import { ChildOf, Name, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader';
import type { SkinErrorCode } from '@forgeax/engine-skinning';
import {
  Skin,
  SkinInstancesCoexistForbiddenError,
  SkinJointCountExceededError,
  SkinJointDespawnedError,
  SkinJointPathUnresolvedError,
} from '@forgeax/engine-skinning';
import type {
  Handle,
  MaterialAsset,
  MeshAsset,
  SkeletonAsset,
  TextureFormat,
} from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldInternal } from '../../../ecs/src/world-internal';
import {
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  SpriteAnimation,
  SpriteRegionOverride,
} from '../../../render/src/components';
import {
  type CameraProjection,
  cameraProjectionFromF32,
} from '../../../render/src/components/camera';
import {
  assembleMaterialWithSkylightEntries,
  createSkylightFallback,
} from '../../../render/src/ibl/skylight-bind-group';
import { buildPbrPipelineLayouts, buildUnlitMaterialBgl } from '../../../render/src/pbr-pipeline';
import { INSTANCE_STORAGE_STRIDE_FLOATS } from '../../../render/src/record/mesh-ssbo';
import { selectSwapChainFormat } from '../../../render/src/render-system';
import { createSkinPaletteAllocator } from '../../../render/src/systems/skin-palette-allocator';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';
import { drawWithOwners } from './renderer-test-utils';

function componentFieldType(component: { fields: Record<string, { type: string }> }, name: string) {
  return component.fields[name]?.type;
}

function componentFieldDefault(
  component: { fields: Record<string, { default?: unknown }> },
  name: string,
) {
  return component.fields[name]?.default;
}

function componentSchemaTypes(component: { fields: Record<string, { type: string }> }) {
  return Object.fromEntries(
    Object.entries(component.fields).map(([name, field]) => [name, field.type]),
  );
}

afterEach(() => vi.restoreAllMocks());

type RendererErrorObservation = {
  readonly code: string;
  readonly detail?: unknown;
  readonly hint?: string;
};

function unwrapRendererError(value: unknown): RendererErrorObservation {
  let current = value as RendererErrorObservation;
  while (
    current.detail !== undefined &&
    typeof current.detail === 'object' &&
    current.detail !== null
  ) {
    const cause = (current.detail as { cause?: unknown }).cause;
    if (
      cause === undefined ||
      typeof cause !== 'object' ||
      cause === null ||
      typeof (cause as { code?: unknown }).code !== 'string'
    ) {
      break;
    }
    current = cause as RendererErrorObservation;
  }
  return current;
}

function subscribeRendererErrors(
  renderer: RendererType,
  listener: (error: RendererErrorObservation) => void,
): () => void {
  return renderer.subscribe((event) => {
    if (event.kind === 'error') listener(unwrapRendererError(event.error));
  });
}

function drawPublished(renderer: RendererType, world: WorldType) {
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  world.update().unwrap();
  return drawWithOwners(renderer, world);
}

// feat-20260704-runtime-tier1-decomposition M2 / w12: reconstitute the
// eliminated top-level RuntimeErrorCode aggregate union (D-3) as a test-local
// alias so the exhaustive-switch bodies below stay byte-identical (AC-09).
type RuntimeLayerErrorCode = RenderErrorCode | AssetRuntimeErrorCode | SkinErrorCode;

import {
  AnimationTargetId,
  bindAnimationTargets,
  advanceAnimationPlayer as canonicalAdvanceAnimationPlayer,
} from '@forgeax/engine-animation';
import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import { DeviceScope } from '../../../render/src/device/device-scope';
import { GpuBuffer } from '../../../render/src/gpu-resource';
import { getOrCreateIblCache, hasIblCache } from '../../../render/src/ibl/IblPipelineCache';
import {
  disposeInstanceBuffers,
  type InstanceBufferCacheEntry,
} from '../../../render/src/instance-buffer-cache';
import { standardPipeline as urpPipeline } from '../../../render/src/pipeline/standard-pipeline';
import { ZERO_CAMERA_CLEAR_FALLBACK } from '../../../render/src/record/frame-snapshot';
import {
  warnMultiLightDirectional,
  warnMultiLightPoint,
  warnMultiLightSpot,
} from '../../../render/src/record/helpers';
import type { CameraSnapshot } from '../../../render/src/render-contract';
import {
  type ExtractedLights,
  prepareExtractContext,
} from '../../../render/src/render-system-extract';
import { extractFrame, extractFrames } from '../../../render/src/render-system-extract-tail';
import {
  getTransparentSortConfig,
  setTransparentSortConfig,
  TRANSPARENT_SORT_CONFIG_KEY,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../../../render/src/systems/transparent-sort-config';
import { spriteAnimationTickSystem } from '../systems/sprite-animation-tick';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

void [
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  AnimationPlayer,
  AnimationTargetId,
  AssetRegistry,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  ChildOf,
  DeviceScope,
  ENTITY_NULL_RAW,
  GpuBuffer,
  INSTANCE_STORAGE_STRIDE_FLOATS,
  MeshFilter,
  MeshRenderer,
  Name,
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  Skin,
  SkinInstancesCoexistForbiddenError,
  SkinJointCountExceededError,
  SkinJointDespawnedError,
  SkinJointPathUnresolvedError,
  SkyboxBackground,
  Skylight,
  SpriteAnimation,
  SpriteAnimationInvalidError,
  SpriteRegionOverride,
  TONEMAP_LUMINANCE_EPSILON,
  TRANSPARENT_SORT_CONFIG_KEY,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
  Transform,
  World,
  ZERO_CAMERA_CLEAR_FALLBACK,
  afterEach,
  assembleMaterialWithSkylightEntries,
  beforeAll,
  beforeEach,
  bindAnimationTargets,
  buildPbrPipelineLayouts,
  buildUnlitMaterialBgl,
  cameraProjectionFromF32,
  canonicalAdvanceAnimationPlayer,
  componentFieldDefault,
  componentFieldType,
  componentSchemaTypes,
  createSkinPaletteAllocator,
  createSkylightFallback,
  deriveAnimationTargetId,
  describe,
  disposeInstanceBuffers,
  drawPublished,
  drawWithOwners,
  expect,
  extractFrame,
  extractFrames,
  fileURLToPath,
  getOrCreateIblCache,
  getTransparentSortConfig,
  hasIblCache,
  it,
  makeMockShaderRegistry,
  mat4,
  prepareExtractContext,
  propagateTransforms,
  readFileSync,
  resolve,
  rhiOk,
  selectSwapChainFormat,
  setTransparentSortConfig,
  spriteAnimationTickSystem,
  standardMaterialShaderVariants,
  subscribeRendererErrors,
  toShared,
  unwrapRendererError,
  urpPipeline,
  vec3,
  vi,
  warnMultiLightDirectional,
  warnMultiLightPoint,
  warnMultiLightSpot,
  worldInternal,
];
type __MergedKeep =
  | AssetRuntimeErrorCode
  | BindGroupEntry
  | Buffer
  | CameraProjection
  | CameraSnapshot
  | EntityHandle
  | ExtractedLights
  | Handle
  | InstanceBufferCacheEntry
  | MaterialAsset
  | MeshAsset
  | RenderErrorCode
  | RendererErrorObservation
  | RendererType
  | RuntimeLayerErrorCode
  | Sampler
  | SkeletonAsset
  | SkinErrorCode
  | Texture
  | TextureFormat
  | TextureView
  | WorldType;

{
  // --- from tonemap-hdr-target.test.ts ---

  const ENGINE = '../createRenderer';

  // ─── Mock helpers (mirrors renderer-ready.test.ts shape) ───────────────────

  function makeMockGL2(): Record<string, unknown> {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    return {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({
              createView: () => ({}),
              width: 800,
              height: 600,
            }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
  }

  interface CallRecord {
    readonly type: string;
    readonly label?: string | undefined;
    readonly code?: string | undefined;
    readonly format?: string | undefined;
    readonly size?: number | undefined;
    readonly entries?: number | undefined;
    readonly fragmentTargets?: readonly string[] | undefined;
    readonly fragmentSource?: string | undefined;
  }

  interface DeviceCallLog {
    readonly records: CallRecord[];
  }

  function makeMockDevice(log: DeviceCallLog): unknown {
    const lost = new Promise<unknown>(() => undefined);
    return {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      // Model a native WebGPU device: this test exercises the preferred
      // swap-chain format selected by the storage-buffer path.  An empty
      // limits object describes a downlevel device and correctly selects the
      // rgba fallback instead.
      limits: {
        maxStorageBuffersPerShaderStage: 8,
      },
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
        onSubmittedWorkDone: async () => undefined,
      },
      createShaderModule: (desc: { label?: string; code: string }) => {
        log.records.push({ type: 'createShaderModule', label: desc.label, code: desc.code });
        return { code: desc.code, getCompilationInfo: async () => ({ messages: [] }) };
      },
      createBindGroupLayout: (desc: { label?: string; entries?: unknown[] }) => {
        log.records.push({
          type: 'createBindGroupLayout',
          label: desc?.label,
          entries: Array.isArray(desc?.entries) ? desc.entries.length : 0,
        });
        return {};
      },
      createPipelineLayout: (desc: { label?: string }) => {
        log.records.push({ type: 'createPipelineLayout', label: desc?.label });
        return {};
      },
      createRenderPipeline: (desc: {
        label?: string;
        fragment?: { module?: { code?: string }; targets?: Array<{ format?: string }> };
      }) => {
        const targets = desc?.fragment?.targets ?? [];
        const formats = targets.map((t) => t?.format ?? '<missing>');
        log.records.push({
          type: 'createRenderPipeline',
          label: desc?.label,
          fragmentTargets: formats,
          fragmentSource: desc.fragment?.module?.code,
        });
        return {};
      },
      createBindGroup: () => ({}),
      createBuffer: (desc: { label?: string; size?: number }) => {
        log.records.push({
          type: 'createBuffer',
          label: desc?.label,
          size: desc?.size,
        });
        return {
          getMappedRange: () => new ArrayBuffer(64),
          unmap: () => undefined,
        };
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setBindGroup: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: (desc: { label?: string; format?: string }) => {
        log.records.push({ type: 'createTexture', label: desc?.label, format: desc?.format });
        return {
          createView: () => ({}),
        };
      },
      createTextureView: () => ({}),
      createSampler: (desc: { label?: string }) => {
        log.records.push({ type: 'createSampler', label: desc?.label });
        return {};
      },
      destroy: () => undefined,
    };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({
        requestDevice: async () => deviceObj,
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const pbrSource = '/* mock pbr.wgsl - calls f_schlick( for PBR direct lighting */';
  const unlitSource = '/* mock unlit.wgsl - constant-shading path */';
  const tonemapSource = '/* mock tonemap.wgsl - struct TonemapParams { exposure: f32 }; */';

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: identifier === 'forgeax::default-standard-pbr' ? pbrSource : unlitSource,
      paramSchema: '[]',
      variants:
        identifier === 'forgeax::default-standard-pbr'
          ? standardMaterialShaderVariants(pbrSource)
          : [],
    });
    const manifest = {
      entries: [
        {
          hash: 'pbr00000',
          wgsl: pbrSource,
          glsl: '',
          bindings: '',
        },
        {
          hash: 'unlit000',
          wgsl: unlitSource,
          glsl: '',
          bindings: '',
        },
        {
          hash: 'tonemap0',
          wgsl: tonemapSource,
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  // ─── Tests ─────────────────────────────────────────────────────────────────

  const baseNavigator = { userAgent: 'mock-engine-test' } as unknown as Navigator;

  beforeEach(() => {
    vi.stubGlobal('navigator', { ...baseNavigator });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('feat-20260519-tonemap-reinhard-mvp T-M2.4 / T-M2.5: HDR target + tonemap pipeline shape', () => {
    // feat-20260621 M-A3 (D-5): the prior "row 1" asserting boot-time creation of
    // a dedicated tonemap pipeline / 3-entry BGL / sampler / 16 B params UBO is
    // deleted. The built-in tonemap now registers on the unified post-process
    // channel (`postProcess.register('forgeax::tonemap', { source, params })`);
    // its pipeline + BGL + sampler compile lazily on the first tonemap frame
    // (dispatchFullscreenPass), not at boot. The 3-entry BGL shape +
    // params-UBO byteSize=16 are covered by dispatch-fullscreen-pass-params.unit.
    // test.ts; observable tonemap output is smoke-gated (w12, plan-strategy R-1).
    it('row 2: unlit bootstrap preserves both attachments and Standard waits for admitted material requests', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (canvas: unknown, opts?: unknown, bundler?: unknown) => Promise<unknown>;
      };
      const result = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      expect(result.ok).toBe(true);
      result.unwrap();

      // bug-20260612: sRGB siblings stay on the swap-chain srgb view; Channel 2
      // (storageBufferCapable=true) follows getPreferredCanvasFormat() — mocked
      // as 'bgra8unorm' here for Chromium parity, paired with 'bgra8unorm-srgb'.
      const unlitSrgb = log.records.find(
        (r) => r.type === 'createRenderPipeline' && r.label === 'pbr-pipeline-unlit',
      );
      expect(unlitSrgb?.fragmentTargets).toEqual(['bgra8unorm-srgb']);
      expect(
        log.records.filter(
          (r) =>
            r.type === 'createRenderPipeline' &&
            /^pbr-pipeline-standard(?:-hdr)?$/.test(r.label ?? ''),
        ),
      ).toEqual([]);

      // HDR variants ship the rgba16float target.
      const unlitHdr = log.records.find(
        (r) => r.type === 'createRenderPipeline' && r.label === 'pbr-pipeline-unlit-hdr',
      );
      expect(unlitHdr).toBeDefined();
      expect(unlitHdr?.fragmentTargets).toEqual(['rgba16float']);
      expect(unlitHdr?.fragmentSource).toBe(unlitSource);
      // Standard attachment admission is exercised after real material publication
      // and draw in native-shader-labels.dawn.test.ts, instead of unused boot PSOs.
    });

    it('row 3: lazy HDR colour + depth attachments start null (AC-03(c) zero-cost on tonemap none path)', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (...args: unknown[]) => Promise<{ ok: boolean; unwrap(): RendererType }>;
      };
      const result = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      expect(result.ok).toBe(true);
      result.unwrap();

      // No `createTexture(format='rgba16float')` call for the HDR colour
      // attachment before any opt-in frame. The geometry-side fallback
      // white texture is 'rgba8unorm'; the depth attachment is
      // 'depth24plus-stencil8'. An HDR-target rgba16float allocation only fires
      // inside the record stage when the active camera carries
      // tonemap !== 'none'. AC-03(c).
      //
      // feat-20260520-skylight-ibl-cubemap M2 round-2 / t40 + plan-strategy
      // D-5 carve-out: the skylight fallback bundle allocates two 1x1
      // rgba16float texture_cubes (labels `skylight-fallback-irradiance-cube`
      // / `skylight-fallback-prefilter-cube`) inside createRenderer. They
      // are NOT HDR colour attachments -- they seed the @group(4) fallback
      // bind group so PBR pipelines dispatch with ambient=0 when no Skylight
      // ECS entity exists. Filter by label so the AC-03(c) lazy-HDR contract
      // remains testable.
      //
      // tweak-20260608-rhi-hdr-renderable-caps-and-warn-once M1 carve-out:
      // RhiCaps probe creates a 1x1 rgba16float texture (label
      // `forgeax-caps-probe-rgba16float-renderable`) during deriveCaps to
      // test if the format is RENDER_ATTACHMENT-renderable. NOT an HDR
      // colour attachment -- a one-shot probe destroyed immediately. Filter
      // by label so the AC-03(c) lazy-HDR contract remains testable.
      // The neutral normal-map fallback uses float16 to represent 0.5 exactly;
      // it is a 1x1 sampled material input, not a scene HDR attachment.
      const hdrTextureCalls = log.records.filter(
        (r) =>
          r.type === 'createTexture' &&
          r.format === 'rgba16float' &&
          r.label !== 'fallback-normal-1x1' &&
          !(r.label?.startsWith('skylight-fallback-') ?? false) &&
          !(r.label?.startsWith('forgeax-caps-probe-') ?? false),
      );
      expect(hdrTextureCalls.map((record) => record.label)).toEqual([]);
    });

    it('row 4: engine modules prewarm at boot while the tonemap pipeline waits for its first frame', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (...args: unknown[]) => Promise<{ ok: boolean; unwrap(): RendererType }>;
      };
      const result = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      expect(result.ok).toBe(true);
      result.unwrap();

      const moduleSources = log.records
        .filter((r) => r.type === 'createShaderModule')
        .map((r) => r.code);
      expect(moduleSources).toContain(pbrSource);
      expect(moduleSources).toContain(unlitSource);
      // The unified channel prewarms its module so the first synchronous frame
      // does not wait for compilation; pipeline admission still belongs to draw.
      expect(moduleSources).toContain(tonemapSource);
      expect(
        log.records.filter(
          (record) =>
            record.type === 'createRenderPipeline' && record.fragmentSource === tonemapSource,
        ),
      ).toEqual([]);
    });
  });
}
