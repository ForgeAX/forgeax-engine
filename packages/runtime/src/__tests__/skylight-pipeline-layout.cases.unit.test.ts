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
  // --- from skylight-pipeline-layout.test.ts ---

  const STORAGE_CAPS: PbrCaps = { storageBuffer: true };

  // ─── Mock device ────────────────────────────────────────────────────────────
  //
  // Captures every descriptor passed to createBindGroupLayout / createPipelineLayout
  // so the test inspects the final pipeline-layout shape without standing up a
  // real GPU.

  interface CapturedBgl {
    readonly label: string | undefined;
    readonly entries: readonly GPUBindGroupLayoutEntry[];
  }

  interface CapturedPipelineLayout {
    readonly label: string | undefined;
    readonly bindGroupLayouts: readonly unknown[];
  }

  interface MockDevice {
    readonly createBindGroupLayout: ReturnType<typeof vi.fn>;
    readonly createPipelineLayout: ReturnType<typeof vi.fn>;
    readonly capturedBgls: CapturedBgl[];
    readonly capturedPipelineLayouts: CapturedPipelineLayout[];
  }

  function makeMockDevice(): MockDevice {
    const capturedBgls: CapturedBgl[] = [];
    const capturedPipelineLayouts: CapturedPipelineLayout[] = [];
    const createBindGroupLayout = vi.fn(
      (desc: { label?: string; entries: readonly GPUBindGroupLayoutEntry[] }) => {
        const captured: CapturedBgl = { label: desc.label, entries: desc.entries };
        capturedBgls.push(captured);
        // Return an opaque BindGroupLayout handle (the captured descriptor) so
        // downstream `createPipelineLayout` calls can refer to it by identity.
        return { ok: true, value: captured };
      },
    );
    const createPipelineLayout = vi.fn(
      (desc: { label?: string; bindGroupLayouts: readonly unknown[] }) => {
        const captured: CapturedPipelineLayout = {
          label: desc.label,
          bindGroupLayouts: desc.bindGroupLayouts,
        };
        capturedPipelineLayouts.push(captured);
        return { ok: true, value: captured };
      },
    );
    return {
      createBindGroupLayout,
      createPipelineLayout,
      capturedBgls,
      capturedPipelineLayouts,
    };
  }

  // ─── (a)..(d) PBR pipeline layout shape ─────────────────────────────────────

  describe('t57 (M4 round-4) -- standardPipeline pipeline-layout shape', () => {
    it('(a) buildPbrPipelineLayouts returns bindGroupLayouts.length === 4 (no @group(4))', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      const result = buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      expect(result.bindGroupLayouts).toHaveLength(4);
      // And the captured pipeline layout descriptor matches.
      expect(device.capturedPipelineLayouts).toHaveLength(2);
      const layout = device.capturedPipelineLayouts.find((entry) => entry.label === 'pbr-pl');
      expect(layout?.bindGroupLayouts).toHaveLength(4);
      expect(layout?.label).toBe('pbr-pl');
    });

    it('(b) PBR material BGL has 32 entries with independent maps and shared backdrop sampling', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      const materialBgl = device.capturedBgls.find((b) => b.label === 'pbr-material-skylight-bgl');
      expect(materialBgl).toBeDefined();
      expect(materialBgl?.entries).toHaveLength(32);
      expect(materialBgl?.entries[30]).toMatchObject({
        binding: 46,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      });
    });

    it('(c) preserves user/IBL binding order and omits the redundant backdrop sampler', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      const materialBgl = device.capturedBgls.find((b) => b.label === 'pbr-material-skylight-bgl');
      expect(materialBgl).toBeDefined();
      const entries = materialBgl?.entries ?? [];
      // Logical slots 15/16 share the normal input pair; displacement occupies 23/24.
      expect(entries.slice(0, 29).map((entry) => entry.binding)).toEqual(
        Array.from({ length: 31 }, (_, binding) => binding).filter(
          (binding) => ![15, 16].includes(binding),
        ),
      );
      // Skylight texture, sampler, texture, sampler, LUT, uniform.
      expect((entries[23] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      expect((entries[24] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      expect((entries[25] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      expect((entries[26] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      expect((entries[27] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        '2d',
      );
      expect((entries[28] as { buffer?: { type: string } }).buffer?.type).toBe('uniform');
      // Standard reuses the IBL sampler; the backdrop texture retains binding 32.
      expect(entries.some((entry) => entry.binding === 31)).toBe(false);
      expect(entries[29]).toMatchObject({ binding: 32, texture: { viewDimension: '2d' } });
    });

    it('(d) bindGroupLayouts[0..3] order matches [view, material, meshArray, instances]', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      const result = buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      expect(result.bindGroupLayouts[0]).toBe(result.viewBgl);
      expect(result.bindGroupLayouts[1]).toBe(result.materialBgl);
      expect(result.bindGroupLayouts[2]).toBe(result.meshArrayBgl);
      expect(result.bindGroupLayouts[3]).toBe(result.instancesBgl);
      // Labels confirm slot identity.
      const view = device.capturedBgls.find((b) => b.label === 'pbr-view-bgl');
      const mesh = device.capturedBgls.find((b) => b.label === 'pbr-mesh-array-bgl');
      const instances = device.capturedBgls.find((b) => b.label === 'pbr-instances-bgl');
      expect(view).toBeDefined();
      expect(mesh).toBeDefined();
      expect(instances).toBeDefined();
    });
  });

  // ─── (e)(f) Unlit material BGL shape + name ─────────────────────────────────

  describe('t57 (M4 round-4) -- unlitPipeline material BGL shape', () => {
    it('(e) unlit material BGL retains only the 25-entry user region', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildUnlitMaterialBgl(device as any);
      const unlitBgl = device.capturedBgls.find((b) => b.label === 'unlit-material-bgl');
      expect(unlitBgl).toBeDefined();
      expect(unlitBgl?.entries).toHaveLength(25);
    });

    it("(f) PBR material BGL labelled 'pbr-material-skylight-bgl'; unlit labelled 'unlit-material-bgl'", () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildUnlitMaterialBgl(device as any);
      const pbr = device.capturedBgls.find((b) => b.label === 'pbr-material-skylight-bgl');
      const unlit = device.capturedBgls.find((b) => b.label === 'unlit-material-bgl');
      expect(pbr).toBeDefined();
      expect(unlit).toBeDefined();
    });
  });
}
