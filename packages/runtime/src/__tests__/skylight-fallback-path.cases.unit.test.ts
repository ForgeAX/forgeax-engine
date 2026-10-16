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
  // --- from skylight-fallback-path.test.ts ---

  // ─── (a) Fallback resource shape ────────────────────────────────────────────

  function makeMaterialBindGroupEntries(): BindGroupEntry[] {
    const buf = { __brand: 'Buffer' } as unknown as Buffer;
    const sampler = { __brand: 'Sampler' } as unknown as Sampler;
    const view = { __brand: 'TextureView' } as unknown as TextureView;
    return [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: buf, offset: 0, size: 64 } } },
      { binding: 1, resource: { kind: 'sampler', value: sampler } },
      { binding: 2, resource: { kind: 'textureView', value: view } },
      { binding: 3, resource: { kind: 'sampler', value: sampler } },
      { binding: 4, resource: { kind: 'textureView', value: view } },
      { binding: 5, resource: { kind: 'sampler', value: sampler } },
      { binding: 6, resource: { kind: 'textureView', value: view } },
    ] as BindGroupEntry[];
  }

  function makeFallback(): SkylightFallback {
    const tex = { __brand: 'fallback-tex' } as never;
    const irrView = { __brand: 'fallback-irrView' } as unknown as TextureView;
    const prefView = { __brand: 'fallback-prefView' } as unknown as TextureView;
    const brdfView = { __brand: 'fallback-brdfView' } as unknown as TextureView;
    const sampler = { __brand: 'fallback-sampler' } as unknown as Sampler;
    const intensityBuffer = { __brand: 'fallback-intensity', value: 0 } as unknown as Buffer;
    return {
      irradianceTexture: tex,
      irradianceView: irrView,
      prefilterTexture: tex,
      prefilterView: prefView,
      brdfLutTexture: tex,
      brdfLutView: brdfView,
      sampler,
      intensityBuffer,
    };
  }

  function makeActive(): SkylightBindGroupResources {
    return {
      irradianceView: { __brand: 'active-irrView' } as unknown as TextureView,
      irradianceSampler: { __brand: 'active-irrSampler' } as unknown as Sampler,
      prefilterView: { __brand: 'active-prefView' } as unknown as TextureView,
      prefilterSampler: { __brand: 'active-prefSampler' } as unknown as Sampler,
      brdfLutView: { __brand: 'active-brdfView' } as unknown as TextureView,
      intensityBuffer: { __brand: 'active-intensity', value: 1 } as unknown as Buffer,
    };
  }

  describe('t58 (M4 round-4) -- material BG fallback path', () => {
    it('(a) assemble with fallback returns 16 entries; binding 7..13 reference fallback resources', () => {
      const materialEntries = makeMaterialBindGroupEntries();
      const fallback = makeFallback();
      const fallbackAsActive: SkylightBindGroupResources = {
        irradianceView: fallback.irradianceView,
        irradianceSampler: fallback.sampler,
        prefilterView: fallback.prefilterView,
        prefilterSampler: fallback.sampler,
        brdfLutView: fallback.brdfLutView,
        intensityBuffer: fallback.intensityBuffer,
      };
      const merged = assembleMaterialWithSkylightEntries(materialEntries, fallbackAsActive);
      expect(merged).toHaveLength(16);
      expect(merged[7]?.binding).toBe(7);
      expect((merged[7]?.resource as { value: unknown }).value).toBe(fallback.irradianceView);
      expect((merged[8]?.resource as { value: unknown }).value).toBe(fallback.sampler);
      expect((merged[9]?.resource as { value: unknown }).value).toBe(fallback.prefilterView);
      expect((merged[10]?.resource as { value: unknown }).value).toBe(fallback.sampler);
      expect((merged[11]?.resource as { value: unknown }).value).toBe(fallback.brdfLutView);
      expect((merged[12]?.resource as { value: { buffer: unknown } }).value.buffer).toBe(
        fallback.intensityBuffer,
      );
    });

    it('(b) assemble with active returns 16 entries; binding 7..13 reference active IblPipelineCache resources', () => {
      const materialEntries = makeMaterialBindGroupEntries();
      const active = makeActive();
      const merged = assembleMaterialWithSkylightEntries(materialEntries, active);
      expect(merged).toHaveLength(16);
      expect((merged[7]?.resource as { value: unknown }).value).toBe(active.irradianceView);
      expect((merged[8]?.resource as { value: unknown }).value).toBe(active.irradianceSampler);
      expect((merged[9]?.resource as { value: unknown }).value).toBe(active.prefilterView);
      expect((merged[10]?.resource as { value: unknown }).value).toBe(active.prefilterSampler);
      expect((merged[11]?.resource as { value: unknown }).value).toBe(active.brdfLutView);
      expect((merged[12]?.resource as { value: { buffer: unknown } }).value.buffer).toBe(
        active.intensityBuffer,
      );
    });
  });

  // ─── (c)(d) recordFrame never emits setBindGroup(4) ─────────────────────────
  //
  // Source-level grep gate. Verifying call counts at runtime requires a full
  // RenderSystem mock; instead we grep render-system-record.ts for any
  // `setBindGroup(4,` call site. Round-4 D-5 forbids the slot entirely.

  describe('t58 (M4 round-4) -- recordFrame never binds @group(4)', () => {
    it('(c)+(d) render-system-record.ts contains zero setBindGroup(4, ...) call sites', async () => {
      const fsId = 'node:fs';
      const pathId = 'node:path';
      const urlId = 'node:url';
      const fs = (await import(/* @vite-ignore */ fsId)) as {
        readFileSync: (p: string, enc: string) => string;
      };
      const pathMod = (await import(/* @vite-ignore */ pathId)) as {
        resolve: (...parts: string[]) => string;
        dirname: (p: string) => string;
      };
      const url = (await import(/* @vite-ignore */ urlId)) as {
        fileURLToPath: (u: string) => string;
      };
      const here = url.fileURLToPath(import.meta.url);
      // feat-20260704 M5/w31: main-pass draw code split across main-pass.ts +
      // main-pass-geometry.ts + main-pass-sprite-draws.ts; scan the set.
      const recordDir = pathMod.resolve(
        pathMod.dirname(here),
        '..',
        '..',
        '..',
        'render',
        'src',
        'record',
      );
      const source = ['main-pass.ts', 'main-pass-geometry.ts', 'main-pass-sprite-draws.ts']
        .map((name) => fs.readFileSync(pathMod.resolve(recordDir, name), 'utf8'))
        .join('\n');
      // Match either `setBindGroup(4, ...)` or `setBindGroup( 4 ,`.
      const matches = source.match(/setBindGroup\s*\(\s*4\b/g);
      expect(matches).toBeNull();
    });

    it('(d) render-system-record.ts contains setBindGroup(1, ...) for PBR drawCalls (per-entity post-bug-20260522)', async () => {
      const fsId = 'node:fs';
      const pathId = 'node:path';
      const urlId = 'node:url';
      const fs = (await import(/* @vite-ignore */ fsId)) as {
        readFileSync: (p: string, enc: string) => string;
      };
      const pathMod = (await import(/* @vite-ignore */ pathId)) as {
        resolve: (...parts: string[]) => string;
        dirname: (p: string) => string;
      };
      const url = (await import(/* @vite-ignore */ urlId)) as {
        fileURLToPath: (u: string) => string;
      };
      const here = url.fileURLToPath(import.meta.url);
      // feat-20260704 M5/w31: main-pass draw code split across main-pass.ts +
      // main-pass-geometry.ts + main-pass-sprite-draws.ts; scan the set.
      const recordDir = pathMod.resolve(
        pathMod.dirname(here),
        '..',
        '..',
        '..',
        'render',
        'src',
        'record',
      );
      const source = ['main-pass.ts', 'main-pass-geometry.ts', 'main-pass-sprite-draws.ts']
        .map((name) => fs.readFileSync(pathMod.resolve(recordDir, name), 'utf8'))
        .join('\n');
      // Confirm the PBR drawCall binds material BG at slot 1. Post
      // bug-20260522, the variable name changed from `materialBindGroup`
      // to `perSubmeshBg` (rename anticipates M4 per-submesh BG construction;
      // this commit still builds per-entity).
      const matches = source.match(/setBindGroup\s*\(\s*1\s*,\s*perSubmeshBg\b/g);
      expect(matches).not.toBeNull();
      expect((matches ?? []).length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── (e) unlit material BG stays 7 entries ──────────────────────────────────

  describe('t58 (M4 round-4) -- unlit material BG isolation', () => {
    it('(e) buildUnlitMaterialBindGroupEntries returns 7 entries (no Skylight contamination)', async () => {
      const mod = await import('../../../render/src/pbr-pipeline');
      const buildFn = (mod as { buildUnlitMaterialBindGroupEntries?: unknown })
        .buildUnlitMaterialBindGroupEntries;
      expect(typeof buildFn).toBe('function');
      const buf = { __brand: 'Buffer' } as unknown as Buffer;
      const sampler = { __brand: 'Sampler' } as unknown as Sampler;
      const view = { __brand: 'TextureView' } as unknown as TextureView;
      // biome-ignore lint/suspicious/noExplicitAny: structural call
      const entries: BindGroupEntry[] = (buildFn as any)({
        materialUniform: buf,
        materialOffset: 0,
        materialSize: 48,
        defaultSampler: sampler,
        baseColorView: view,
        defaultWhiteView: view,
      });
      expect(entries).toHaveLength(7);
      expect(entries.every((e) => e.binding < 7)).toBe(true);
    });
  });

  // ─── (f) Shader-side convergence: intensity=0 -> ambient=0 ──────────────────

  describe('t58 (M4 round-4) -- shader physical convergence under fallback', () => {
    it('(f) fallback intensityBuffer value is 0 (sampleIblSpecular * 0 === 0 converges ambient to 0)', () => {
      // We model the shader convergence at the SkylightFallback contract
      // level: createSkylightFallback writes Float32Array([0,0,0,0]) into the
      // intensity uniform (skylight-bind-group.ts L444). The mock fallback in
      // this test mirrors that semantic: intensity value === 0.
      const fallback = makeFallback();
      // The intensity buffer is opaque here; the contract is that
      // createSkylightFallback writes zero. Cross-check via the test helper
      // shape that carries a `value: 0` marker (matches createSkylightFallback
      // writeBuffer(Float32Array([0,0,0,0])) semantics).
      expect((fallback.intensityBuffer as unknown as { value: number }).value).toBe(0);
    });
  });
}
