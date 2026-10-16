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
import {
  appendInjection,
  buildPbrPipelineLayouts,
  buildUnlitMaterialBgl,
} from '../../../render/src/pbr-pipeline';
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
  // --- from skylight-bind-group.test.ts ---

  // ─── Mock device helpers ─────────────────────────────────────────────────────
  //
  // We capture every descriptor written to the device so the test can assert
  // the fallback texture geometry without standing up a real GPU device. The
  // forgeax RHI surface returns Result<T,E>; the factory functions unwrap
  // (throw on error) like createRenderer's runShimSyncStep pattern, so mocks
  // always return `{ ok: true, value }`.

  interface CapturedTextureDescriptor {
    readonly label?: string;
    readonly size: { width: number; height: number; depthOrArrayLayers: number };
    readonly mipLevelCount: number;
    readonly sampleCount: number;
    readonly dimension: string;
    readonly format: string;
    readonly usage: number;
  }

  interface MockDevice {
    readonly createSampler: ReturnType<typeof vi.fn>;
    readonly createTexture: ReturnType<typeof vi.fn>;
    readonly createTextureView: ReturnType<typeof vi.fn>;
    readonly createBuffer: ReturnType<typeof vi.fn>;
  }

  interface MockQueue {
    readonly writeTexture: ReturnType<typeof vi.fn>;
    readonly writeBuffer: ReturnType<typeof vi.fn>;
  }

  function makeMockDevice(): MockDevice {
    const sampler = { __brand: 'Sampler', id: Math.random() } as unknown as Sampler;
    const tex = { __brand: 'Texture' } as unknown as Texture;
    const view = { __brand: 'TextureView' } as unknown as TextureView;
    const buf = { __brand: 'Buffer' } as unknown as Buffer;
    return {
      createSampler: vi.fn(() => ({ ok: true, value: sampler })),
      createTexture: vi.fn(() => ({ ok: true, value: tex })),
      createTextureView: vi.fn(() => ({ ok: true, value: view })),
      createBuffer: vi.fn(() => ({ ok: true, value: buf })),
    };
  }

  function makeMockQueue(): MockQueue {
    return {
      writeTexture: vi.fn(() => ({ ok: true, value: undefined })),
      writeBuffer: vi.fn(() => ({ ok: true, value: undefined })),
    };
  }

  // Helper: a stand-in 7-entry PBR material BGL (binding 0..6) matching
  // createRenderer.ts's `pbr-material-bgl` shape (UBO + sampler + texture *
  // 3 pairs). The test does not care about the exact texture/sampler kinds
  // at binding 0..6 -- only that the count is 7 and the bindings 7..13 sit
  // on top.
  function makeMaterialBglEntries(): GPUBindGroupLayoutEntry[] {
    const FRAGMENT = 0x2;
    return [
      { binding: 0, visibility: FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 3, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 5, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 6, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
    ];
  }

  function makeMaterialBindGroupEntries(): BindGroupEntry[] {
    const fakeBuf = { __brand: 'Buffer' } as unknown as Buffer;
    const fakeSampler = { __brand: 'Sampler' } as unknown as Sampler;
    const fakeView = { __brand: 'TextureView' } as unknown as TextureView;
    return [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: fakeBuf, offset: 0, size: 64 } } },
      { binding: 1, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 2, resource: { kind: 'textureView', value: fakeView } },
      { binding: 3, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 4, resource: { kind: 'textureView', value: fakeView } },
      { binding: 5, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 6, resource: { kind: 'textureView', value: fakeView } },
    ] as BindGroupEntry[];
  }

  // ─── Assertion (a): merged BGL is length 13 with Skylight bindings 7..12 ────

  describe('t40 round-4 (a) IBL injection shape', () => {
    it('returns 13 entries; binding 0..6 preserved; 7..13 in D-5 order [irrTex, irrSampler, prefTex, prefSampler, brdfTex, brdfSampler, uniform]', () => {
      const materialEntries = makeMaterialBglEntries();
      const merged = [...materialEntries, ...appendInjection(materialEntries, 'ibl')];

      expect(merged).toHaveLength(13);

      // binding 0..6 preserved verbatim
      for (let i = 0; i < 7; i++) {
        const original = materialEntries[i];
        const got = merged[i];
        expect(got?.binding).toBe(original?.binding);
      }

      // binding 7: irradianceMap (texture_cube)
      expect(merged[7]?.binding).toBe(7);
      expect((merged[7] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      // binding 8: irradianceSampler
      expect(merged[8]?.binding).toBe(8);
      expect((merged[8] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      // binding 9: prefilterMap (texture_cube)
      expect(merged[9]?.binding).toBe(9);
      expect((merged[9] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      // binding 10: prefilterSampler
      expect(merged[10]?.binding).toBe(10);
      expect((merged[10] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      // binding 11: brdfLut (texture_2d)
      expect(merged[11]?.binding).toBe(11);
      expect((merged[11] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        '2d',
      );
      // BRDF sampling shares irradianceSampler; binding 12 carries its uniform.
      expect(merged[12]?.binding).toBe(12);
      expect((merged[12] as { buffer?: { type: string } }).buffer?.type).toBe('uniform');
    });
  });

  // ─── Assertion (b): createSkylightFallback returns identity resource bundle ─

  describe('t40 round-4 (b) fallback identity bundle exists with no stand-alone bindGroup', () => {
    it('createSkylightFallback returns a bundle with texture / view / sampler / uniform handles', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      const fallback = createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );
      expect(fallback.irradianceTexture).not.toBeUndefined();
      expect(fallback.irradianceView).not.toBeUndefined();
      expect(fallback.prefilterTexture).not.toBeUndefined();
      expect(fallback.prefilterView).not.toBeUndefined();
      expect(fallback.brdfLutTexture).not.toBeUndefined();
      expect(fallback.brdfLutView).not.toBeUndefined();
      expect(fallback.sampler).not.toBeUndefined();
      expect(fallback.intensityBuffer).not.toBeUndefined();
      // round-4: no stand-alone bindGroup / layout field on the fallback
      expect((fallback as unknown as { bindGroup?: unknown }).bindGroup).toBeUndefined();
      expect((fallback as unknown as { layout?: unknown }).layout).toBeUndefined();
    });
  });

  // ─── Assertion (c): fallback texture_cube depthOrArrayLayers=6 + white
  // irradiance / prefilter + BRDF fallback data ───

  describe('t40 round-4 (c) fallback cube texture geometry + white-environment data', () => {
    it('fallback cube texture is depthOrArrayLayers=6; irradiance+prefilter are white and BRDF is [1, 0]', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );

      const cubeDescs = device.createTexture.mock.calls
        .map((args) => args[0] as CapturedTextureDescriptor)
        .filter((d) => d.size.depthOrArrayLayers === 6);
      expect(cubeDescs.length).toBeGreaterThanOrEqual(2);
      for (const desc of cubeDescs) {
        expect(desc.size.depthOrArrayLayers).toBe(6);
        expect(desc.size.width).toBe(1);
        expect(desc.size.height).toBe(1);
      }

      // Both cube maps upload six white faces in one call. The 1x1 BRDF fallback stores the
      // split-sum approximation A=1 / B=0 as rg16float. The mock returns one
      // shared texture object, so classify writes by payload bytes instead.
      let whiteCount = 0;
      let brdfApproxCount = 0;
      expect(queue.writeTexture.mock.calls.length).toBeGreaterThan(0);
      for (const call of queue.writeTexture.mock.calls) {
        const dataArg = call[1] as ArrayBufferView | undefined;
        if (dataArg === undefined) continue;
        const bytes = new Uint8Array(dataArg.buffer, dataArg.byteOffset, dataArg.byteLength);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const isWhiteHead =
          dv.getUint16(0, true) === 0x3c00 &&
          dv.getUint16(2, true) === 0x3c00 &&
          dv.getUint16(4, true) === 0x3c00 &&
          dv.getUint16(6, true) === 0x3c00;
        const isBrdfApprox =
          dv.getUint16(0, true) === 0x3c00 && dv.getUint16(2, true) === 0x0000 && !isWhiteHead;
        if (isWhiteHead) {
          expect(call[3]).toMatchObject({ depthOrArrayLayers: 6 });
          expect(dv.getUint16(5 * 256, true)).toBe(0x3c00);
          whiteCount += 1;
        } else if (isBrdfApprox) {
          brdfApproxCount += 1;
        } else {
          expect.fail('unexpected Skylight fallback texture payload');
        }
      }
      expect(whiteCount).toBe(2);
      expect(brdfApproxCount).toBe(1);
    });

    it('createSkylightFallback allocates exactly one sampler (reused across the 3 texture slots)', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );
      expect(device.createSampler).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Assertion (d): assembleMaterialWithSkylightEntries adds the engine-owned pair ───

  describe('t40 round-4 (d) assembleMaterialWithSkylightEntries shape', () => {
    it('returns 16 BindGroupEntry values; entry 7..13 reference the skylight resources', () => {
      const materialEntries = makeMaterialBindGroupEntries();
      const irrView = { __brand: 'TextureView', id: 1 } as unknown as TextureView;
      const irrSampler = { __brand: 'Sampler', id: 1 } as unknown as Sampler;
      const prefView = { __brand: 'TextureView', id: 2 } as unknown as TextureView;
      const prefSampler = { __brand: 'Sampler', id: 2 } as unknown as Sampler;
      const brdfView = { __brand: 'TextureView', id: 3 } as unknown as TextureView;
      const intensityBuf = { __brand: 'Buffer' } as unknown as Buffer;

      const merged = assembleMaterialWithSkylightEntries(materialEntries, {
        irradianceView: irrView,
        irradianceSampler: irrSampler,
        prefilterView: prefView,
        prefilterSampler: prefSampler,
        brdfLutView: brdfView,
        intensityBuffer: intensityBuf,
      });

      expect(merged).toHaveLength(16);
      expect(merged[15]).toMatchObject({
        binding: 47,
        resource: { kind: 'textureView', value: prefView },
      });

      // Skylight entries at binding 7..12 in D-5 order
      expect(merged[7]?.binding).toBe(7);
      expect(merged[7]?.resource).toEqual({ kind: 'textureView', value: irrView });
      expect(merged[8]?.binding).toBe(8);
      expect(merged[8]?.resource).toEqual({ kind: 'sampler', value: irrSampler });
      expect(merged[9]?.binding).toBe(9);
      expect(merged[9]?.resource).toEqual({ kind: 'textureView', value: prefView });
      expect(merged[10]?.binding).toBe(10);
      expect(merged[10]?.resource).toEqual({ kind: 'sampler', value: prefSampler });
      expect(merged[11]?.binding).toBe(11);
      expect(merged[11]?.resource).toEqual({ kind: 'textureView', value: brdfView });
      expect(merged[12]?.binding).toBe(12);
      expect(merged[12]?.binding).toBe(12);
      expect(merged[12]?.resource).toEqual({
        kind: 'buffer',
        value: { buffer: intensityBuf },
      });
      expect(merged[13]?.binding).toBe(13);
      expect(merged[14]?.binding).toBe(14);
    });

    it('derives IBL injection start from materialEntries.length (per-shader user-region, not a fixed 7)', () => {
      // Per-shader-derived BGL (feat-20260621): the user-region length is no
      // longer fixed at 7. assembleMaterialWithSkylightEntries injects the 6
      // skylight entries starting at materialEntries.length. Empty user-region
      // => IBL lands at binding 0..6 (no throw); the old fixed-7 guard is gone.
      const merged = assembleMaterialWithSkylightEntries([], {
        irradianceView: {} as TextureView,
        irradianceSampler: {} as Sampler,
        prefilterView: {} as TextureView,
        prefilterSampler: {} as Sampler,
        brdfLutView: {} as TextureView,
        intensityBuffer: {} as Buffer,
      });
      expect(merged).toHaveLength(9);
      expect(merged[0]?.binding).toBe(0);
      expect(merged[6]?.binding).toBe(6);
      expect(merged[7]?.binding).toBe(7);
      expect(merged[8]?.binding).toBe(47);
    });
  });
}
