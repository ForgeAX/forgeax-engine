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

// Split source block: GPU resource symmetric release contract.
// ── feat-20260612-skin-palette-per-frame-upload M2: extractFrame hasSkin ──
// Helpers shared by m2-1..m2-4 tests covering the T-21 placeholder retirement
// (real allocator wiring + 3 new SkinExtractErrorCode routings + assets===null
// bind-pose equivalence).

{
  // ── Helpers ──

  async function _loadM4Libs() {
    const { err: m4err, ok: m4ok, RhiError } = await import('@forgeax/engine-rhi');
    return { m4err, m4ok, RhiError, GpuBuffer };
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import return types are opaque
  function _mkBufDevice(m4err: any, m4ok: any, RhiError: any) {
    const destroyedSet = new WeakSet<object>();
    const dev = {
      destroyBuffer(buf: object) {
        if (destroyedSet.has(buf))
          return m4err(new RhiError({ code: 'destroy-after-destroy', expected: '', hint: '' }));
        destroyedSet.add(buf);
        return m4ok(undefined);
      },
    };
    return dev as never;
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import return type is opaque
  function _mkBufEntry(GpuBuffer: any, dev: never, bl: number, av: number) {
    return {
      buffer: new GpuBuffer(dev, {} as never),
      uploadedByteLength: bl,
      uploadedArchVersion: av,
    };
  }

  // ── createRenderer integration harness (drives the real record passes) ──
  //
  // A WebGPU-shaped mock device whose createBuffer hands back raw handles
  // that record their own .destroy() invocations. The runtime wraps each in a
  // GpuBuffer; the F12 set-before-destroy path calls GpuBuffer.destroy() ->
  // rhi-webgpu destroyBuffer -> rawBuf.destroy(), landing in `destroyed`.

  interface IntegrationBufLog {
    created: Array<{ handle: object; label: string | undefined; size: number; usage: number }>;
    destroyed: object[];
  }

  // The per-entity instance-transform buffer is the only buffer created with
  // usage STORAGE|COPY_DST (128|8 = 136) at the packed storage instance byte
  // size. Storage carries current and previous mat4 values, so each instance
  // occupies `INSTANCE_STORAGE_STRIDE_FLOATS` f32 values. Matching BOTH usage
  // and size pins the F12 destroy to the instance buffer, not an incidental
  // same-sized transient / uniform buffer elsewhere in the frame.
  const INSTANCE_USAGE = 128 | 8;
  const INSTANCE_BYTES = (instanceCount: number): number =>
    instanceCount * INSTANCE_STORAGE_STRIDE_FLOATS * 4;

  function latestInstanceBuffer(log: IntegrationBufLog, instanceCount: number): object {
    const created = log.created.filter(
      (c) => c.usage === INSTANCE_USAGE && c.size === INSTANCE_BYTES(instanceCount),
    );
    const latest = created[created.length - 1];
    if (latest === undefined) throw new Error('instance buffer was not created');
    return latest.handle;
  }

  function initialRawDepthParamsBuffer(log: IntegrationBufLog): object {
    const initial = log.created.find(
      (created) =>
        created.label === 'post-process-params-forgeax.single-layer-medium-raw-depth' &&
        created.size === 16,
    );
    if (initial === undefined) throw new Error('raw-depth params buffer was not created');
    return initial.handle;
  }

  function makeIntegrationCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') {
          return {
            __mockTag: 'webgl2',
            getExtension: () => null,
            getParameter: () => 1,
            isContextLost: () => false,
          };
        }
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  function makeIntegrationDevice(
    log: IntegrationBufLog,
    opts?: { destroyThrows?: boolean },
  ): unknown {
    const lost = new Promise<unknown>(() => undefined);
    const destroyedSet = new WeakSet<object>();
    return {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      // maxStorageBuffersPerShaderStage > 0 => rhi-webgpu caps.storageBuffer
      // true (device.ts:406) => the instance buffer takes the STORAGE path
      // (usage 136), distinguishing it from uniform buffers in the frame.
      limits: {
        maxStorageBufferBindingSize: 1024 * 1024 * 1024,
        maxStorageBuffersPerShaderStage: 8,
      },
      queue: {
        submit: () => undefined,
        onSubmittedWorkDone: () => Promise.resolve(undefined),
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: (desc: { label?: string; size?: number; usage?: number }) => {
        const raw = {
          __role: `buffer-${log.created.length}`,
          destroy: () => {
            if (opts?.destroyThrows) throw new Error('mock destroy failure');
            if (destroyedSet.has(raw)) return;
            destroyedSet.add(raw);
            log.destroyed.push(raw);
          },
          getMappedRange: () => new ArrayBuffer(desc?.size ?? 64),
          unmap: () => undefined,
        };
        log.created.push({
          handle: raw,
          label: desc?.label,
          size: desc?.size ?? 0,
          usage: desc?.usage ?? 0,
        });
        return raw;
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          setBindGroup: () => undefined,
          setViewport: () => undefined,
          setStencilReference: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
  }

  function makeIntegrationGPU(device: unknown): unknown {
    return {
      requestAdapter: async () => ({ requestDevice: async () => device }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const integrationNavigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  // The shadow-caster shader registration gates recordShadowPass: with it,
  // the shadow pass records instances BEFORE the main pass each frame and so
  // owns the F12 set-before-destroy (render-system-record.ts:3323); without
  // it recordShadowPass early-exits (shadow PSO null) and the main pass owns
  // the F12 destroy (:4521). Each w13 sub-test selects the manifest that
  // isolates the production site it falsifies, so disabling that exact line
  // turns exactly that sub-test red.
  function buildIntegrationManifestUrl(withShadowCaster: boolean): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants:
        identifier === 'forgeax::default-standard-pbr' ? standardMaterialShaderVariants() : [],
    });
    const entries: Array<{ hash: string; wgsl: string; glsl: string; bindings: string }> = [
      { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      {
        hash: 'tonemap0',
        wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
        glsl: '',
        bindings: '',
      },
    ];
    const materialShaders = [
      materialShaderStub('forgeax::default-standard-pbr'),
      materialShaderStub('forgeax::default-unlit'),
    ];
    if (withShadowCaster) {
      materialShaders.push(
        materialShaderStub(
          'forgeax::default-shadow-caster',
          '/* reserved shadow caster - @location(0) position vertex-only */',
        ),
      );
    }
    const manifest = {
      entries,
      materialShaders,
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  type IntegrationRenderer = RendererType;

  interface IntegrationWorld {
    spawn: (...a: unknown[]) => { unwrap: () => unknown };
    set: (...a: unknown[]) => unknown;
  }

  interface IntegrationComponents {
    Transform: unknown;
    GlobalTransform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    Instances: unknown;
    DirectionalLight: unknown;
    HANDLE_CUBE: unknown;
  }

  async function bootIntegrationRenderer(
    device: unknown,
    withShadowCaster = false,
  ): Promise<{
    renderer: IntegrationRenderer;
    world: IntegrationWorld;
    C: IntegrationComponents;
    errors: { code: string }[];
  }> {
    vi.stubGlobal('navigator', { ...integrationNavigator, gpu: makeIntegrationGPU(device) });
    const { createRenderer } = (await import('../createRenderer')) as {
      createRenderer: (...args: unknown[]) => Promise<{ unwrap(): IntegrationRenderer }>;
    };
    const renderer = (
      await createRenderer(
        makeIntegrationCanvas(),
        {},
        { shaderManifestUrl: buildIntegrationManifestUrl(withShadowCaster) },
      )
    ).unwrap();
    const { World: WorldCtor } = (await import('@forgeax/engine-ecs')) as unknown as {
      World: new () => IntegrationWorld;
    };
    const C = {
      ...(await import('@forgeax/engine-render')),
      ...(await import('@forgeax/engine-scene')),
      ...(await import('@forgeax/engine-assets-runtime')),
    } as unknown as IntegrationComponents;
    const errors: { code: string }[] = [];
    subscribeRendererErrors(renderer, (e) => errors.push(e));
    return { renderer, world: new WorldCtor(), C, errors };
  }

  function spawnCamera(world: IntegrationWorld, C: IntegrationComponents): void {
    world.spawn(
      {
        component: C.Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
      {
        component: C.Transform,
        data: {
          pos: [0, 0, 5],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
    );
  }

  function spawnInstancedCube(
    world: IntegrationWorld,
    C: IntegrationComponents,
    instanceCount: number,
  ): unknown {
    return world
      .spawn(
        { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
        { component: C.MeshRenderer, data: {} },
        {
          component: C.Transform,
          data: {
            pos: [0, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        { component: C.GlobalTransform, data: {} },
        { component: C.Instances, data: { transforms: new Float32Array(instanceCount * 16) } },
      )
      .unwrap();
  }

  // ── w14: AC-07 B-family error strategy ──
  //
  // dispose-path sub-cases drive the real disposeInstanceBuffers (already
  // correct round 1); the F12 sub-case drives the real record pass with a
  // destroy that fails (rawBuf.destroy throws -> rhi-webgpu surfaces
  // webgpu-runtime-error -> the F12 production fires errorRegistry + sweeps on).

  describe('instance buffer error strategy (AC-07) [w14]', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('disposeInstanceBuffers: destroy clears map, isDestroyed gate skips pre-destroyed entries', async () => {
      const { m4err, m4ok, RhiError, GpuBuffer } = await _loadM4Libs();
      const dev = _mkBufDevice(m4err, m4ok, RhiError);

      const e1 = _mkBufEntry(GpuBuffer, dev, 256, 1);
      const e2 = _mkBufEntry(GpuBuffer, dev, 512, 2);
      e2.buffer.destroy(); // pre-destroy
      const map = new Map<number, ReturnType<typeof _mkBufEntry>>();
      map.set(1, e1);
      map.set(2, e2);

      const fires: unknown[] = [];
      disposeInstanceBuffers(map, {
        fire: (e: unknown) => {
          fires.push(e);
        },
      });

      expect(e1.buffer.isDestroyed).toBe(true);
      expect(e2.buffer.isDestroyed).toBe(true);
      expect(map.size).toBe(0);
      expect(fires).toHaveLength(0);
    });

    it('disposeInstanceBuffers: sweep continues, all non-pre-destroyed entries destroyed', async () => {
      const { m4err, m4ok, RhiError, GpuBuffer } = await _loadM4Libs();
      const dev = _mkBufDevice(m4err, m4ok, RhiError);

      const e1 = _mkBufEntry(GpuBuffer, dev, 256, 1);
      const e2 = _mkBufEntry(GpuBuffer, dev, 512, 2);
      const e3 = _mkBufEntry(GpuBuffer, dev, 768, 3);
      e2.buffer.destroy(); // pre-destroy
      const map = new Map<number, ReturnType<typeof _mkBufEntry>>();
      map.set(1, e1);
      map.set(2, e2);
      map.set(3, e3);

      const fires: unknown[] = [];
      disposeInstanceBuffers(map, {
        fire: (e: unknown) => {
          fires.push(e);
        },
      });

      expect(e1.buffer.isDestroyed).toBe(true);
      expect(e3.buffer.isDestroyed).toBe(true);
      expect(map.size).toBe(0);
      expect(fires).toHaveLength(0);
    });

    it('disposeInstanceBuffers: without errorRegistry parameter, no fire (no crash)', async () => {
      const { m4err, m4ok, RhiError, GpuBuffer } = await _loadM4Libs();
      const dev = _mkBufDevice(m4err, m4ok, RhiError);

      const e1 = _mkBufEntry(GpuBuffer, dev, 256, 1);
      const map = new Map<number, ReturnType<typeof _mkBufEntry>>();
      map.set(1, e1);

      // Call without errorRegistry — should not throw.
      disposeInstanceBuffers(map);

      expect(e1.buffer.isDestroyed).toBe(true);
      expect(map.size).toBe(0);
    });

    it('F12 set-before-destroy failure fires errorRegistry + sweep continues (real record pass)', async () => {
      const log: IntegrationBufLog = { created: [], destroyed: [] };
      const device = makeIntegrationDevice(log, { destroyThrows: true });
      const { renderer, world, C, errors } = await bootIntegrationRenderer(device);

      spawnCamera(world, C);
      const cube = spawnInstancedCube(world, C, 2);

      // Frame 1: allocate the instance buffer (fingerprint = 2 instances).
      drawPublished(renderer, world as WorldType);

      // Frame 2: fingerprint mismatch -> F12 destroys the old buffer, whose
      // raw .destroy() throws -> rhi-webgpu webgpu-runtime-error -> the F12
      // production fires errorRegistry and continues to set the new buffer.
      world.set(cube, C.Instances, { transforms: new Float32Array(3 * 16) });
      drawPublished(renderer, world as WorldType);

      // Sweep continued: a fresh (larger) instance buffer was still allocated
      // after the failed destroy. The failure surfaced as a fired error.
      expect(errors.some((e) => e.code === 'webgpu-runtime-error')).toBe(true);
      expect(log.created.length).toBeGreaterThan(0);
    });
  });

  // ── w13: AC-06 B-family F12 set-before-destroy (real recordMainPass + recordShadowPass) ──

  describe('instance buffer F12 set-before-destroy (AC-06) [w13]', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('main pass: fingerprint change destroys the old cached buffer before set', async () => {
      const log: IntegrationBufLog = { created: [], destroyed: [] };
      const device = makeIntegrationDevice(log);
      const { renderer, world, C, errors } = await bootIntegrationRenderer(device);

      spawnCamera(world, C);
      const cube = spawnInstancedCube(world, C, 2);

      // Frame 1: cold allocate the 2-instance buffer (256 B).
      drawPublished(renderer, world as WorldType);
      expect(errors).toHaveLength(0);
      const createdAfterF1 = log.created.length;
      expect(createdAfterF1).toBeGreaterThan(0);
      const oldInstanceBuffer = latestInstanceBuffer(log, 2);
      // Renderer boot replaces the eager 16 B raw-depth params candidate with
      // the recovery-owned publication before this frame. Preserve that real
      // cleanup evidence while pinning the F12 invariant to its own buffer.
      expect(log.destroyed).toContain(initialRawDepthParamsBuffer(log));
      expect(log.destroyed).not.toContain(oldInstanceBuffer);

      // Frame 2: 2 -> 3 instances => byteLength fingerprint mismatch => the
      // main-pass F12 path (render-system-record.ts:4521) destroys the old
      // 256 B buffer, then sets a fresh 384 B one. No shadow-caster shader is
      // registered, so recordShadowPass early-exits and the main pass is the
      // sole F12 owner this frame.
      world.set(cube, C.Instances, { transforms: new Float32Array(3 * 16) });
      drawPublished(renderer, world as WorldType);

      // The destroyed buffer is specifically the old instance buffer (STORAGE
      // usage, 256 B), not an incidental destroy elsewhere. Disabling :4521
      // drops it.
      expect(log.destroyed.includes(oldInstanceBuffer)).toBe(true);
      // A new (larger) 384 B instance buffer replaced the destroyed one.
      expect(
        log.created.some((c) => c.usage === INSTANCE_USAGE && c.size === INSTANCE_BYTES(3)),
      ).toBe(true);
    });

    it('shadow pass: fingerprint change destroys the old cached buffer before set', async () => {
      const log: IntegrationBufLog = { created: [], destroyed: [] };
      const device = makeIntegrationDevice(log);
      // withShadowCaster=true registers forgeax::default-shadow-caster so
      // recordShadowPass runs.
      const { renderer, world, C } = await bootIntegrationRenderer(device, true);

      spawnCamera(world, C);
      // DirectionalLight with castShadow => recordShadowPass runs and
      // records the instance entity BEFORE the main pass, so the shadow F12
      // path (render-system-record.ts:3323) owns the destroy this frame.
      world.spawn({
        component: C.DirectionalLight,
        data: {
          direction: [-0.5, -1, -0.3],
          color: [1, 1, 1],
          intensity: 1,
          cascadeCount: 1,
          mapSize: 1024,
        },
      });
      const cube = spawnInstancedCube(world, C, 2);

      drawPublished(renderer, world as WorldType);
      const oldInstanceBuffer = latestInstanceBuffer(log, 2);
      expect(log.destroyed).toContain(initialRawDepthParamsBuffer(log));
      expect(log.destroyed).not.toContain(oldInstanceBuffer);

      world.set(cube, C.Instances, { transforms: new Float32Array(3 * 16) });
      drawPublished(renderer, world as WorldType);

      // The shadow pass records the instance entity before the main pass, so
      // it owns the F12 destroy of the old (STORAGE, 256 B) instance buffer
      // this frame. Disabling :3323 drops this assertion (main reuses the
      // already-updated entry and never re-destroys).
      expect(log.destroyed.includes(oldInstanceBuffer)).toBe(true);
      expect(
        log.created.some((c) => c.usage === INSTANCE_USAGE && c.size === INSTANCE_BYTES(3)),
      ).toBe(true);
    });
  });

  // ── w15: AC-10 WeakMap chain behavior invariants ──
  //
  // feat-20260622-handle-to-id-allocator-elimination: the old
  // getOrAssignHandleId is gone; the old numeric counter is removed. WeakMap chain
  // determinism replaces it — same handle object identity → same
  // leaf BG, different handles → different leaf.

  describe('WeakMap chain behavior invariants [w15]', () => {
    it('same handle object in chain → same leaf BindGroup (deterministic)', () => {
      const root = new WeakMap<object, unknown>();
      const h1 = {};
      const h2 = {};

      // We simulate the chain by building two levels manually for the test
      const inner = new WeakMap<object, unknown>();
      root.set(h1, inner);
      const leaf = new Map<string, unknown>();
      inner.set(h2, leaf);
      const bg1 = { __label: 'bg-1' };
      leaf.set('variant-a', bg1);

      // Same handle path → same leaf entry
      const innerCheck = root.get(h1) as WeakMap<object, unknown>;
      expect(innerCheck).toBeDefined();
      const leafCheck = innerCheck.get(h2) as Map<string, unknown>;
      expect(leafCheck).toBeDefined();
      expect(leafCheck.get('variant-a')).toBe(bg1);
      expect(leafCheck.get('variant-a')).toBe(bg1);

      // Different variant on same chain → different leaf entry
      const bg2 = { __label: 'bg-2' };
      leaf.set('variant-b', bg2);
      expect(leaf.get('variant-a')).toBe(bg1);
      expect(leaf.get('variant-b')).toBe(bg2);
      expect(bg1).not.toBe(bg2);
    });

    it('different handle objects → different chain position → different leaf', () => {
      const root = new WeakMap<object, unknown>();
      const hA = {};
      const hB = {};
      const innerA = new WeakMap<object, unknown>();
      const innerB = new WeakMap<object, unknown>();
      const leafA = new Map<string, unknown>();
      const leafB = new Map<string, unknown>();
      innerA.set({}, leafA);
      innerB.set({}, leafB);
      root.set(hA, innerA);
      root.set(hB, innerB);

      // Different root-level key → completely independent chains
      const chainA = root.get(hA) as WeakMap<object, unknown>;
      const chainB = root.get(hB) as WeakMap<object, unknown>;
      expect(chainA).not.toBe(chainB);

      // No shared leaf — hA's chain entries don't hit hB's chain
      leafA.set('v', 'from-A');
      leafB.set('v', 'from-B');
      expect(
        (root.get(hA) as WeakMap<object, unknown>).get({}) as Map<string, unknown>,
      ).toBeUndefined();
    });

    it('grow miss: new inner buffer is new WeakMap key → cache miss (AC-07)', () => {
      // AC-07: when mesh SSBO grows, the inner buffer object is replaced.
      // The old inner buffer was a WeakMap key in the chain; the new one is
      // a different object, so chain lookup naturally misses.
      const root = new WeakMap<object, unknown>();
      const oldBuf = {};
      const inner = new WeakMap<object, unknown>();
      const leaf = new Map<string, unknown>();
      inner.set({}, leaf);
      root.set(oldBuf, inner);

      // Old buffer hits
      expect(root.has(oldBuf)).toBe(true);

      // New buffer (grow replacement) misses
      const newBuf = {};
      expect(root.has(newBuf)).toBe(false);
      expect(oldBuf).not.toBe(newBuf);
    });
  });
}
