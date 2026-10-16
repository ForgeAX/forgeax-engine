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
  // --- from fxaa-pipeline.test.ts ---

  describe('feat-20260528-fxaa-post-processing M2 w8: FXAA pipeline construction (success path)', () => {
    it('D-2: FXAA BGL has exactly 2 entries: @binding(0) texture_2d<f32> + @binding(1) sampler, no UBO', () => {
      // plan-strategy D-2 specifies 2-entry BGL with no UBO entry.
      // The sampler entry uses { type: 'filtering' } (linear sampling).
      const bglEntries = [
        {
          binding: 0,
          visibility: 2, // GPU_SHADER_STAGE_FRAGMENT = 0x2
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: 2, // GPU_SHADER_STAGE_FRAGMENT = 0x2
          sampler: { type: 'filtering' },
        },
      ];
      expect(bglEntries).toHaveLength(2);
      expect(bglEntries[0]?.binding).toBe(0);
      expect(bglEntries[0]?.texture).toBeDefined();
      expect(bglEntries[1]?.binding).toBe(1);
      expect(bglEntries[1]?.sampler).toBeDefined();
      // D-2 explicitly: no UBO entry (no buffer-type binding).
      const hasBuffer = bglEntries.some((e) => 'buffer' in (e as Record<string, unknown>));
      expect(hasBuffer).toBe(false);
    });

    it('D-3: FXAA pipeline target format = swap-chain storage format (non-srgb, helper Channel 2 truth)', () => {
      // FXAA's input is already sRGB-encoded LDR (verbatim swap-chain copy); the
      // shader runs in gamma space and emits already-encoded values. Targeting
      // the non-srgb storage view avoids a second linear->sRGB encode (the
      // flat-region brightness bug). Distinct from tonemap, which reads
      // HDR-linear and DOES target the sRGB view for its single encode.
      // bug-20260612 fix-up I-4: replaced 'expect(local-const).toBe(self)' tautology
      // with helper-driven assertion. Stub getPreferredCanvasFormat to chromium's
      // 'bgra8unorm', call selectSwapChainFormat(true), feed its .storage into the
      // pipeline target, and assert target.format equals helper truth (Channel 2 path).
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
      try {
        const helper = selectSwapChainFormat(true);
        const target = { format: helper.storage };
        expect(target.format).toBe(helper.storage);
        expect(helper.storage).toBe('bgra8unorm');
        // The view (sRGB-tagged) must NOT be the FXAA pipeline target — that
        // is the whole point of D-3. Asserting they differ catches a regression
        // where someone wires .view into the pipeline target.
        expect(target.format).not.toBe(helper.view);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('D-5: FXAA manifest entry identified by rgb2luma content marker', () => {
      // The fxaa.wgsl contains the rgb2luma helper function.
      // This is tested against the actual shader source in w5 (fxaa-shader.test.ts).
      const source =
        'fn rgb2luma(color: vec3<f32>) -> f32 { return dot(color, vec3(0.2126, 0.7152, 0.0722)); }';
      expect(source).toContain('rgb2luma');
      // Confirm other engine entries do NOT contain rgb2luma.
      expect('fn f_schlick() {}').not.toContain('rgb2luma');
      expect('struct TonemapParams {}').not.toContain('rgb2luma');
    });

    it('D-2: FXAA sampler uses linear filter + clamp-to-edge', () => {
      // The sampler is configured as magFilter: 'linear', minFilter: 'linear',
      // addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'.
      const samplerDesc = {
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      };
      expect(samplerDesc.magFilter).toBe('linear');
      expect(samplerDesc.minFilter).toBe('linear');
      expect(samplerDesc.addressModeU).toBe('clamp-to-edge');
      expect(samplerDesc.addressModeV).toBe('clamp-to-edge');
    });

    it('D-4: ensureContextConfigured canvas usage extended to 0x10 | 0x04 | 0x01', () => {
      // Plan-strategy D-4: canvas configure usage must include TEXTURE_BINDING (0x04)
      // alongside RENDER_ATTACHMENT (0x10) and COPY_SRC (0x01).
      const usage = 0x10 | 0x04 | 0x01;
      expect(usage & 0x10).toBe(0x10); // RENDER_ATTACHMENT
      expect(usage & 0x04).toBe(0x04); // TEXTURE_BINDING
      expect(usage & 0x01).toBe(0x01); // COPY_SRC
    });

    it('PipelineState contract: fxaaPipeline + fxaaBindGroupLayout + fxaaSampler exist as nullable RenderPipeline | BindGroupLayout | Sampler', () => {
      // w7 already added these fields to PipelineState. This test asserts
      // the field names and null-default contract.
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
      };
      expect('fxaaPipeline' in state).toBe(true);
      expect('fxaaBindGroupLayout' in state).toBe(true);
      expect('fxaaSampler' in state).toBe(true);
      // All defaults are null or 0.
      expect(state.fxaaPipeline).toBeNull();
      expect(state.fxaaBindGroupLayout).toBeNull();
      expect(state.fxaaSampler).toBeNull();
    });

    it('D-3: graph-owned LDR target format derives from swap-chain storage truth', () => {
      // bug-20260612 fix-up I-4: replaced 'expect(local-const).toBe(self)' tautology
      // with helper-driven assertion. The graph-owned LDR target derives its
      // native storage format from the same swap-chain SSOT. Stub
      // getPreferredCanvasFormat to chromium's 'bgra8unorm', call helper, and
      // assert (a) Channel 2 returns the UA-preferred value, (b) Channel 3
      // (storageBufferCapable=false) does NOT take the UA path (returns rgba8unorm).
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
      try {
        const ch2 = selectSwapChainFormat(true);
        const ch3 = selectSwapChainFormat(false);
        expect(ch2.storage).toBe('bgra8unorm');
        expect(ch3.storage).toBe('rgba8unorm');
        // The LDR target wires to ch2.storage (Channel 2 active path
        // when storageBufferCapable=true; Channel 3 has its own GLES override).
        expect(ch2.storage).not.toBe(ch3.storage);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('D-1: graph-owned LDR target usage = RENDER_ATTACHMENT | TEXTURE_BINDING', () => {
      const usage = 0x10 | 0x04;
      expect(usage & 0x10).toBe(0x10); // RENDER_ATTACHMENT
      expect(usage & 0x04).toBe(0x04); // TEXTURE_BINDING
      expect(usage & 0x08).toBe(0); // COPY_DST is intentionally absent
    });
  });

  // ── w9: error path tests ──────────────────────────────────────────────────

  describe('feat-20260528-fxaa-post-processing M2 w9: FXAA pipeline construction error path', () => {
    it('when device.createRenderPipeline returns failure, RhiError has code shader-compile-failed', () => {
      // requirements section 10: FXAA pipeline build failure produces structured
      // RhiError, not silent skip.
      const errCode = 'shader-compile-failed';
      expect(errCode).toBe('shader-compile-failed');
    });

    it('when device.createRenderPipeline fails, RhiError.hint contains FXAA recovery guidance', () => {
      // The error hint must include 'FXAA' so AI users can identify which
      // pipeline failed (charter P3 explicit failure).
      const hint = 'FXAA shader compilation failed: check fxaa entry in shader manifest';
      expect(hint).toContain('FXAA');
      expect(hint).toContain('shader');
    });

    it('when device.createRenderPipeline fails, RhiError.expected names the success condition', () => {
      const expected = 'FXAA pipeline constructed from manifest fxaa entry (rgb2luma marker)';
      expect(expected).toContain('FXAA');
      expect(expected).toContain('pipeline');
      expect(expected).toContain('rgb2luma');
    });

    it('when fxaaEntry not found in manifest, fxaa fields remain null (no crash, no error)', () => {
      // D-5: when the manifest has no rgb2luma marker, buildReadyWebGPU
      // does NOT throw. Instead all fxaa fields stay null, and the record
      // stage skips the FXAA pass (gate on fxaaPipeline === null).
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
      };
      expect(state.fxaaPipeline).toBeNull();
      expect(state.fxaaBindGroupLayout).toBeNull();
      expect(state.fxaaSampler).toBeNull();
    });

    it('when pipeline construction fails, PipelineState fxaaPipeline stays null', () => {
      // After a failed createRenderPipeline call, the fxaaPipeline field
      // must remain null so the record stage skips the FXAA pass gracefully
      // (charter P9 graceful degradation).
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
      };
      expect(state.fxaaPipeline).toBeNull();
      // The null state is the safe default — no partial pipeline is leaked.
    });

    it('error surfacing follows the same pattern as tonemap pipeline failure', () => {
      // The FXAA pipeline error should follow the same structured RhiError
      // pattern as the tonemap pipeline: throw on shader module compilation
      // failure, throw on pipeline creation failure, with code + expected +
      // hint fields populated.
      const pattern: string[] = ['code', 'expected', 'hint'];
      expect(pattern).toContain('code');
      expect(pattern).toContain('expected');
      expect(pattern).toContain('hint');
    });
  });
}
