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
import {
  emptyFrameRecordingOutputs,
  ZERO_CAMERA_CLEAR_FALLBACK,
} from '../../../render/src/record/frame-snapshot';
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

  function makePipelineState(
    internals: { _fakes: Record<string, unknown> },
    hdrAlreadyAllocated: boolean,
  ): unknown {
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
        depthTexture: { __label: 'depth' },
        depthTextureView: f.swapDepthView,
        depthTextureWidth: 800,
        depthTextureHeight: 600,
        configured: true,
        hdrColorTexture: hdrAlreadyAllocated ? { __label: 'hdr-color' } : null,
        hdrColorView: hdrAlreadyAllocated ? f.hdrColorView : null,
        hdrDepthTexture: hdrAlreadyAllocated ? { __label: 'hdr-depth' } : null,
        hdrDepthView: hdrAlreadyAllocated ? f.hdrDepthView : null,
        hdrTextureWidth: hdrAlreadyAllocated ? 800 : 0,
        hdrTextureHeight: hdrAlreadyAllocated ? 600 : 0,
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
      bloomSoftKnee: 0.5,
      bloomScatter: 0.7,
      clearColor: [0, 0, 0, 1],
    };
  }

  describe('feat-20260519-tonemap-reinhard-mvp T-M3.1: record-stage tonemap routing', () => {
    it('row 1: tonemap=none camera writes linear LDR graph output + emits NO tonemap pass (AC-03(c) / AC-11)', async () => {
      const log: DeviceLog = { events: [] };
      const internals = makeRecorderInternals(log);
      const ps = makePipelineState(internals as never, false);
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

  // ── w12: AC-05 B-family F11 despawn -> per-frame poll destroy ─────────────
  //
  // Round 2 fix-up (implement-review §5 Issue 1): the F11 cleanup loop lives
  // in recordFrame (render-system-record.ts ~:2245) — it iterates
  // frameState.instanceBuffers.entries() and, for any key NOT in the current
  // validated-renderable set, destroys the GpuBuffer then deletes the Map
  // entry. The previous w12 test drove `disposeInstanceBuffers` (a different
  // function sharing only the isDestroyed+destroy idiom), so disabling the
  // F11 production destroy left it green. This test drives the REAL
  // recordFrame: pre-seed instanceBuffers with a live GpuBuffer keyed at an
  // entity that is NOT among the rendered entities (empty renderables ->
  // empty validated set), then assert recordFrame destroyed it. Flip the
  // production `entry.buffer.destroy()` at :2248 to a no-op and this fails.
  describe('instance buffer per-frame poll destroy (AC-05 F11) [w12]', () => {
    // Minimal device whose destroyBuffer records each handle it destroys, so
    // the assertion observes the real GpuBuffer.destroy() -> device.destroyBuffer
    // routing rather than re-checking a copied isDestroyed flag.
    // biome-ignore lint/suspicious/noExplicitAny: dynamic-import rhi shim types are opaque
    function makeBufRecorderDevice(rhiErrFn: any, rhiOkFn: any, RhiErrorCtor: any) {
      const destroyed = new WeakSet<object>();
      const destroyedHandles: object[] = [];
      const device = {
        destroyBuffer(buf: object) {
          if (destroyed.has(buf)) {
            return rhiErrFn(
              new RhiErrorCtor({ code: 'destroy-after-destroy', expected: '', hint: '' }),
            );
          }
          destroyed.add(buf);
          destroyedHandles.push(buf);
          return rhiOkFn(undefined);
        },
      };
      return { device, destroyedHandles };
    }

    it('despawned key (not in validated set): recordFrame destroys GpuBuffer + deletes Map entry', async () => {
      const { recordFrame } = await import('../../../render/src/record/frame');
      const { err: rhiErrFn, RhiError: RhiErrorCtor } = await import('@forgeax/engine-rhi');
      const { device: bufDev, destroyedHandles } = makeBufRecorderDevice(
        rhiErrFn,
        rhiOk,
        RhiErrorCtor,
      );

      const log: DeviceLog = { events: [] };
      const internals = makeRecorderInternals(log);
      const ps = makePipelineState(internals as never, false);
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;

      // Pre-seed the per-frame instance-buffer cache with one live entry whose
      // key (999) belongs to an entity that is NOT rendered this frame.
      const staleHandle = { __role: 'stale-instance-buffer' };
      const staleBuffer = new GpuBuffer(bufDev as never, staleHandle as never);
      const instanceBuffers = new Map<number, InstanceBufferCacheEntry>();
      instanceBuffers.set(999, {
        buffer: staleBuffer,
        uploadedArchVersion: 1,
        uploadedByteLength: 256,
      });

      const cameras = [makeCamera('none')];
      recordFrame(
        internals as never,
        new World() as never,
        cameras,
        EMPTY_LIGHTS,
        [], // no renderables -> validated set is empty -> key 999 is orphaned
        [],
        {
          frameNumber: 0,
          compiledFrameGraph: null,
          frameOutputs: emptyFrameRecordingOutputs(),
          retiredCompiledFrameGraphs: new Set(),
          instanceBuffers,
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

      // F11 production loop destroyed the orphaned buffer + dropped the key.
      expect(staleBuffer.isDestroyed).toBe(true);
      expect(destroyedHandles).toContain(staleHandle);
      expect(instanceBuffers.has(999)).toBe(false);
    });

    it('isDestroyed dedup: a pre-destroyed orphan is not double-destroyed (still removed)', async () => {
      const { recordFrame } = await import('../../../render/src/record/frame');
      const { err: rhiErrFn, RhiError: RhiErrorCtor } = await import('@forgeax/engine-rhi');
      const { device: bufDev, destroyedHandles } = makeBufRecorderDevice(
        rhiErrFn,
        rhiOk,
        RhiErrorCtor,
      );

      const log: DeviceLog = { events: [] };
      const internals = makeRecorderInternals(log);
      const ps = makePipelineState(internals as never, false);
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;

      const staleHandle = { __role: 'pre-destroyed-instance-buffer' };
      const staleBuffer = new GpuBuffer(bufDev as never, staleHandle as never);
      staleBuffer.destroy(); // pre-destroy: isDestroyed gate must skip re-destroy
      const preDestroyCount = destroyedHandles.length;

      const instanceBuffers = new Map<number, InstanceBufferCacheEntry>();
      instanceBuffers.set(7, {
        buffer: staleBuffer,
        uploadedArchVersion: 2,
        uploadedByteLength: 512,
      });

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
          frameOutputs: emptyFrameRecordingOutputs(),
          retiredCompiledFrameGraphs: new Set(),
          instanceBuffers,
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

      // isDestroyed gate skipped the second destroy; key still dropped.
      expect(destroyedHandles.length).toBe(preDestroyCount);
      expect(instanceBuffers.has(7)).toBe(false);
    });
  });
}
