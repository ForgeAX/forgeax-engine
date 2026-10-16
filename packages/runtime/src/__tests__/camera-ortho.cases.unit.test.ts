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
  // --- from camera-ortho.test.ts ---

  // Column-major 4x4 matrix-vector multiply (mat4 is column-major per
  // @forgeax/engine-math types.ts SSOT). Returns [cx, cy, cz, cw].
  function mulMat4Vec4(
    m: Mat4Like,
    v: readonly [number, number, number, number],
  ): [number, number, number, number] {
    const [x, y, z, w] = v;
    return [
      (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number) * w,
      (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number) * w,
      (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number) * w,
      (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number) * w,
    ];
  }

  describe('Camera schema (32 fields: projection, exposure, color grading, post-process, target, targetLayer, clearColor, and aspect-sync)', () => {
    it('Camera.schema has 32 fields including auto exposure and color grading state', () => {
      expect(Object.keys(Camera.fields).length).toBe(32);
      expect(componentFieldType(Camera, 'targetLayer')).toBe('u32');
      expect(componentFieldType(Camera, 'fov')).toBe('f32');
      expect(componentFieldType(Camera, 'aspect')).toBe('f32');
      expect(componentFieldType(Camera, 'near')).toBe('f32');
      expect(componentFieldType(Camera, 'far')).toBe('f32');
      expect(componentFieldType(Camera, 'projection')).toBe('f32');
      expect(componentFieldType(Camera, 'left')).toBe('f32');
      expect(componentFieldType(Camera, 'right')).toBe('f32');
      expect(componentFieldType(Camera, 'bottom')).toBe('f32');
      expect(componentFieldType(Camera, 'top')).toBe('f32');
      // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.2 (AC-01 + D-1).
      expect(componentFieldType(Camera, 'tonemap')).toBe('f32');
      expect(componentFieldType(Camera, 'exposure')).toBe('f32');
      // feat-20260827-auto-exposure-hdr-color-grading: exposure control state.
      expect(componentFieldType(Camera, 'exposureMode')).toBe('f32');
      expect(componentFieldType(Camera, 'compensationEv')).toBe('f32');
      expect(componentFieldType(Camera, 'rangeEv')).toBe('array<f32, 2>');
      expect(componentFieldType(Camera, 'rates')).toBe('array<f32, 2>');
      expect(componentFieldType(Camera, 'whitePoint')).toBe('f32');
      expect(componentFieldType(Camera, 'temperature')).toBe('f32');
      expect(componentFieldType(Camera, 'tint')).toBe('f32');
      expect(componentFieldType(Camera, 'colorLut')).toBe('shared<TextureAsset>');
      expect(componentFieldType(Camera, 'colorLutStrength')).toBe('f32');
      expect(componentFieldType(Camera, 'antialias')).toBe('f32');
      expect(componentFieldType(Camera, 'historyVersion')).toBe('u32');
      // feat-20260531-bloom-first-declarative-render-graph-pass / w2.
      expect(componentFieldType(Camera, 'bloom')).toBe('f32');
      expect(componentFieldType(Camera, 'bloomThreshold')).toBe('f32');
      expect(componentFieldType(Camera, 'bloomIntensity')).toBe('f32');
      expect(componentFieldType(Camera, 'bloomSoftKnee')).toBe('f32');
      expect(componentFieldType(Camera, 'bloomScatter')).toBe('f32');
      // feat-20260709 M3 / D-3: clear-color collapsed into one array<f32,4>.
      expect(componentFieldType(Camera, 'clearColor')).toBe('array<f32, 4>');
      // feat-20260617-host-engine-contract-and-video-cutscene / M3: aspect-sync
      // opt-out flag (bool column tier).
      expect(componentFieldType(Camera, 'autoAspect')).toBe('bool');
      // feat-20260927-order-independent-transparency: sorted vs weighted blended.
      expect(componentFieldType(Camera, 'transparency')).toBe('f32');
    });
  });

  describe('Camera.projection discriminator narrowing (AC-16)', () => {
    it('cameraProjectionFromF32 narrows 0 to perspective, 1 to orthographic', () => {
      const p: CameraProjection = cameraProjectionFromF32(CAMERA_PROJECTION_PERSPECTIVE);
      const o: CameraProjection = cameraProjectionFromF32(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(p).toBe('perspective');
      expect(o).toBe('orthographic');
    });

    it('defensive fall-back: unknown discriminator values narrow to perspective', () => {
      expect(cameraProjectionFromF32(2)).toBe('perspective');
      expect(cameraProjectionFromF32(-1)).toBe('perspective');
      expect(cameraProjectionFromF32(Number.NaN)).toBe('perspective');
    });

    it('world.spawn with orthographic data stores all 9 f32 fields losslessly', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: 0,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
            left: -10,
            right: 10,
            bottom: -10,
            top: 10,
          },
        })
        .unwrap();
      const r = world.get(e, Camera).unwrap();
      expect(r.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(r.left).toBe(-10);
      expect(r.right).toBe(10);
      expect(r.bottom).toBe(-10);
      expect(r.top).toBe(10);
      expect(cameraProjectionFromF32(r.projection)).toBe('orthographic');
    });
  });

  describe('Orthographic projection matrix NDC z ∈ [0, 1] (AC-16 numeric precision)', () => {
    it('point on the near plane maps to NDC z = 0', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, 10, -10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -0.1, 1]);
      const ndcZ = clip[2] / clip[3];
      expect(ndcZ).toBeCloseTo(0, 5);
    });

    it('point on the far plane maps to NDC z = 1', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, 10, -10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -100, 1]);
      const ndcZ = clip[2] / clip[3];
      expect(ndcZ).toBeCloseTo(1, 5);
    });

    it('point at the center of the ortho view maps to NDC x = 0 and y = 0', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, 10, -10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -50, 1]);
      expect(clip[0] / clip[3]).toBeCloseTo(0, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(0, 5);
    });

    it('off-center point maps to the expected NDC x/y inside [-1, 1]', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, 10, -10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [5, -5, -50, 1]);
      // x = 5 sits at 0.5 of the ortho half-extent 10
      expect(clip[0] / clip[3]).toBeCloseTo(0.5, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(-0.5, 5);
    });

    it('asymmetric ortho bounds preserve linear mapping to NDC [-1, 1] x/y', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, 0, 20, 10, 0, 0.1, 100);
      // midpoint of [0, 20] x [0, 10] = (10, 5) should map to NDC (0, 0)
      const clip = mulMat4Vec4(proj, [10, 5, -50, 1]);
      expect(clip[0] / clip[3]).toBeCloseTo(0, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(0, 5);
    });
  });
}
