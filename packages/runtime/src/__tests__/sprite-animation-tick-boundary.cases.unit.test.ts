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
  // --- from sprite-animation-tick-boundary.test.ts ---

  function setDt(world: World, dt: number): void {
    world[worldInternal].getClockWriter().time.delta = dt;
  }

  function expectRegion(
    world: World,
    entity: EntityHandle,
    expected: readonly [number, number, number, number],
  ): void {
    const sro = world.get(entity, SpriteRegionOverride).unwrap();
    expect(sro.region.length).toBe(4);
    expect(sro.region[0]).toBeCloseTo(expected[0], 6);
    expect(sro.region[1]).toBeCloseTo(expected[1], 6);
    expect(sro.region[2]).toBeCloseTo(expected[2], 6);
    expect(sro.region[3]).toBeCloseTo(expected[3], 6);
  }

  describe('spriteAnimationTickSystem - boundaries (M4 T-22)', () => {
    it('(1) dt=30s does NOT second-clamp (R-TIME-1) and produces a finite advance', () => {
      // frameDuration = 0.5 is exactly representable in IEEE 754 f32
      // (the SpriteAnimation.frameDuration column storage type) so
      // 30 / 0.5 = 60 advances has no rounding-error tail. With
      // frameCount=4 the loop wraps to (60 mod 4) = 0; accumDt residue
      // is 0 exactly. Picking f32-exact constants keeps the assertion
      // deterministic without weakening the "no second-clamp" detector
      // — a regression that second-clamps Time.delta to e.g. 0.25 would
      // advance only floor(0.25 / 0.5) = 0 frames (currentFrame stays
      // at 0 but accumDt would be 0.25, not 0); a clamp to 0.5 would
      // advance 1 frame -> currentFrame === 1; either way the
      // assertions below diverge from the no-clamp branch.
      const world = new World();
      const regions = new Float32Array([
        0.0, 0, 0.25, 1, 0.25, 0, 0.25, 1, 0.5, 0, 0.25, 1, 0.75, 0, 0.25, 1,
      ]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0.5,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      setDt(world, 30);
      const r = spriteAnimationTickSystem(world);
      expect(r.ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(Number.isFinite(snap.currentFrame)).toBe(true);
      expect(Number.isFinite(snap.accumDt)).toBe(true);
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
      expectRegion(world, entity, [0.0, 0, 0.25, 1]);
    });

    it('(2) frameCount=1 static sprite stays at currentFrame=0 (LOOP)', () => {
      const world = new World();
      const regions = new Float32Array([0.0, 0.0, 1.0, 1.0]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 1,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      // Three ticks with dt large enough to drain frameDuration each time.
      // frameCount=1 means there is only one frame; both LOOP and CLAMP
      // collapse to "stay at 0" (LOOP wraps `(0 + 1) % 1 = 0`, CLAMP
      // narrows to `min(0+1, 0) = 0`).
      for (let i = 0; i < 3; i++) {
        setDt(world, 0.5);
        expect(spriteAnimationTickSystem(world).ok).toBe(true);
      }

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expectRegion(world, entity, [0.0, 0.0, 1.0, 1.0]);
    });

    it('(2b) frameCount=1 static sprite stays at currentFrame=0 (CLAMP)', () => {
      const world = new World();
      const regions = new Float32Array([0.0, 0.0, 1.0, 1.0]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 1,
            frameDuration: 0.1,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expectRegion(world, entity, [0.0, 0.0, 1.0, 1.0]);
    });

    it('(3) manual setFrame: world.set(SpriteAnimation, { currentFrame: 2, accumDt: 0 }) is honoured next tick', () => {
      const world = new World();
      const regions = new Float32Array([
        0.0, 0, 0.25, 1, 0.25, 0, 0.25, 1, 0.5, 0, 0.25, 1, 0.75, 0, 0.25, 1,
      ]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      // Manual seek to frame 2.
      world.set(entity, SpriteAnimation, { currentFrame: 2, accumDt: 0 }).unwrap();
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeCloseTo(0, 6);
      }

      // Next tick: dt=0.05 < frameDuration so currentFrame STAYS at 2 and
      // accumDt becomes 0.05. A regression that re-initialised
      // currentFrame to 0 on a missing-SpriteRegionOverride observation
      // would flip the value back; the assertion catches that.
      setDt(world, 0.05);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeCloseTo(0.05, 6);
      }
      // The override slot is also written from currentFrame=2 (not 0) so
      // the rendered region is regions[8..12] = [0.5, 0, 0.25, 1].
      expectRegion(world, entity, [0.5, 0, 0.25, 1]);

      // Then dt=0.06 -> accumDt=0.11 -> advance once -> currentFrame=3,
      // accumDt=0.01.
      setDt(world, 0.06);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(3);
        expect(snap.accumDt).toBeCloseTo(0.01, 6);
      }
      expectRegion(world, entity, [0.75, 0, 0.25, 1]);
    });
  });
}
