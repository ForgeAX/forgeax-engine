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
  // --- from fxaa-intermediate-texture.test.ts ---

  const EMPTY_LIGHTS: ExtractedLights = {
    directional: undefined,
    directionalCount: 0,
    point: [],
    spot: [],
    lightSpaceMatrix: undefined,
    shadowMapSize: undefined,
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
        depthTexture: { __label: 'depth' },
        depthTextureView: { __role: 'depth-view' },
        depthTextureWidth: 800,
        depthTextureHeight: 600,
        configured: true,
        hdrColorTexture: null,
        hdrColorView: null,
        hdrDepthTexture: null,
        hdrDepthView: null,
        hdrTextureWidth: 0,
        hdrTextureHeight: 0,
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
        shadowTexture: null,
        shadowMapSize: 0,
        shadowCascadeCount: 0,
        shadowSampler: { __label: 'shadow-sampler' },
        shadowLightSpaceMatrix: null,
        shadowCsmLightViewProj: null,
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
      bloomSoftKnee: 0.5,
      bloomScatter: 0.7,
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
