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
import { mockRenderBundles } from './mock-render-bundles';
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
  // --- from shadow-skip-non-triangle.test.ts ---

  const ENGINE = '../createRenderer';

  interface PassSpies {
    setIndexBuffer: ReturnType<typeof vi.fn>;
    setVertexBuffer: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
    drawIndexed: ReturnType<typeof vi.fn>;
  }

  function makePassSpies(): PassSpies {
    return {
      setIndexBuffer: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
    };
  }

  function makeMockGL2(): unknown {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
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

  // `shadow` spies receive every dispatch that occurs inside a render pass opened
  // with an empty colorAttachments array (the shadow pass). `main` spies receive
  // the rest. Routing is per-beginRenderPass so the same pass methods dispatch to
  // the right bucket.
  function makeMockGPUDevice(shadow: PassSpies, main: PassSpies): { device: unknown } {
    const lost = new Promise<unknown>(() => undefined);
    const passFor = (descriptor: unknown): PassSpies => {
      const d = descriptor as { colorAttachments?: readonly unknown[] };
      const isShadow = Array.isArray(d.colorAttachments) && d.colorAttachments.length === 0;
      return isShadow ? shadow : main;
    };
    const device = {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
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
      createBuffer: () => ({
        getMappedRange: () => new ArrayBuffer(64),
        unmap: () => undefined,
      }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: unknown) => {
          const spies = passFor(descriptor);
          return {
            setPipeline: () => undefined,
            setVertexBuffer: spies.setVertexBuffer,
            setIndexBuffer: spies.setIndexBuffer,
            setBindGroup: () => undefined,
            setStencilReference: () => undefined,
            setViewport: () => undefined,
            setScissorRect: () => undefined,
            draw: spies.draw,
            drawIndexed: spies.drawIndexed,
            end: () => undefined,
          };
        },
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
    return { device: mockRenderBundles(device) };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({ requestDevice: async () => deviceObj }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string, composedWgsl = '/* stub */') => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl,
      paramSchema: '[]',
      variants:
        identifier === 'forgeax::default-standard-pbr' ? standardMaterialShaderVariants() : [],
    });
    const manifest = {
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
        materialShaderStub(
          'forgeax::default-shadow-caster',
          '/* reserved shadow caster */ struct VsIn { @location(0) position: vec3<f32> };',
        ),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  type RendererLike = RendererType;

  async function importEngine(): Promise<{
    createRenderer: (...args: unknown[]) => Promise<{ unwrap(): RendererLike }>;
  }> {
    return (await import(ENGINE)) as never;
  }

  async function importEcs(): Promise<{
    World: new () => { spawn: (...componentDatas: unknown[]) => unknown };
  }> {
    return (await import('@forgeax/engine-ecs')) as never;
  }

  async function importComponents(): Promise<{
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    DirectionalLight: unknown;
  }> {
    return {
      ...(await import('@forgeax/engine-render')),
      ...(await import('@forgeax/engine-scene')),
    } as never;
  }

  function cameraTransform() {
    return {
      pos: [0, 0, 5],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  function originTransform() {
    return {
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  function indexedTriangleMesh(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(3 * 12),
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
      aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      materialSlots: [{ slotName: 'Default' }],
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
    };
  }

  function indexedLineMesh(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(2 * 12),
      indices: new Uint16Array([0, 1]),
      attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0]) },
      aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      materialSlots: [{ slotName: 'Default' }],
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 2,
          vertexCount: 2,
          materialSlot: 0,
          topology: 'line-list',
        },
      ],
    };
  }

  async function setupRenderer(
    shadow: PassSpies,
    main: PassSpies,
  ): Promise<{ renderer: RendererLike }> {
    const { device } = makeMockGPUDevice(shadow, main);
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const { createRenderer } = await importEngine();
    const renderer = (
      await createRenderer(makeMockCanvas(), {}, { shaderManifestUrl: buildManifestDataUrl() })
    ).unwrap();
    return { renderer };
  }

  describe('w12 - shadow caster skips non-triangle topology (AC-09)', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('records shadow draw ONLY for triangle-list; line-list is skipped', async () => {
      const shadow = makePassSpies();
      const main = makePassSpies();
      const { renderer } = await setupRenderer(shadow, main);
      const errors: string[] = [];
      subscribeRendererErrors(renderer, (e) => errors.push(e.code));

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();

      const triHandle = world.allocSharedRef('MeshAsset', indexedTriangleMesh()) as Handle<
        'MeshAsset',
        'shared'
      >;
      const lineHandle = world.allocSharedRef('MeshAsset', indexedLineMesh()) as Handle<
        'MeshAsset',
        'shared'
      >;

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
        { component: C.Transform, data: cameraTransform() },
      );
      world.spawn(
        {
          component: C.DirectionalLight,
          data: { direction: [0, -1, 0], mapSize: 512, cascadeCount: 1 },
        },
        { component: C.Transform, data: cameraTransform() },
      );
      world.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: triHandle } },
        { component: C.Transform, data: originTransform() },
      );
      world.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: lineHandle } },
        { component: C.Transform, data: originTransform() },
      );

      // The first frame exercises the real shadow pass. A second frame proves
      // the persistent directional-shadow cache can reuse that result without
      // re-recording the depth draws. Yield so any async shader-module
      // creation settles before the cached frame.
      drawPublished(renderer, world as WorldType);
      const firstShadowDrawCalls =
        shadow.drawIndexed.mock.calls.length + shadow.draw.mock.calls.length;
      await new Promise((r) => setTimeout(r, 0));
      shadow.drawIndexed.mockClear();
      shadow.draw.mockClear();
      drawPublished(renderer, world as WorldType);

      // Shadow pass drew exactly once (the triangle mesh), never the line mesh.
      const shadowDrawCalls = shadow.drawIndexed.mock.calls.length + shadow.draw.mock.calls.length;
      expect(firstShadowDrawCalls).toBe(1);
      expect(shadowDrawCalls).toBe(0);
      expect(errors).toEqual([]);
    });

    it('keeps the directional atlas when only the camera moves; a new caster redraws', async () => {
      const shadow = makePassSpies();
      const main = makePassSpies();
      const { renderer } = await setupRenderer(shadow, main);
      const errors: string[] = [];
      subscribeRendererErrors(renderer, (e) => errors.push(e.code));

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();
      const triHandle = world.allocSharedRef('MeshAsset', indexedTriangleMesh()) as Handle<
        'MeshAsset',
        'shared'
      >;
      const camera = world.spawn(
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
        { component: C.Transform, data: cameraTransform() },
      );
      world.spawn(
        {
          component: C.DirectionalLight,
          data: { direction: [0, -1, 0], mapSize: 512, cascadeCount: 1 },
        },
        { component: C.Transform, data: cameraTransform() },
      );
      world.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: triHandle } },
        { component: C.Transform, data: originTransform() },
      );
      const shadowDraws = () =>
        shadow.drawIndexed.mock.calls.length + shadow.draw.mock.calls.length;
      const drawFrame = async () => {
        await new Promise((r) => setTimeout(r, 0));
        shadow.drawIndexed.mockClear();
        shadow.draw.mockClear();
        drawPublished(renderer, world as WorldType);
        return shadowDraws();
      };

      drawPublished(renderer, world as WorldType);
      expect(shadowDraws()).toBe(1);
      // A sub-texel camera move changes the ECS but neither the cascade
      // matrices nor any caster: the retained atlas stays valid.
      world.set(camera, C.Transform, { pos: [0.0001, 0, 5] }).unwrap();
      expect(await drawFrame()).toBe(0);
      world.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: triHandle } },
        { component: C.Transform, data: originTransform() },
      );
      expect(await drawFrame()).toBe(2);
      expect(errors).toEqual([]);
    });
  });
}
