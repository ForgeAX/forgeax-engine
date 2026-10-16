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
import {
  ChildOf,
  GlobalTransform,
  Name,
  propagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
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
import { componentId } from '../../../ecs/src/component';
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
  // --- from propagate-transforms.test.ts ---

  interface LocalTrs {
    pos: number[];
    quat: number[];
    scale: number[];
  }

  function trs(overrides: Partial<LocalTrs> = {}): LocalTrs {
    return {
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      ...overrides,
    };
  }

  /** Independent reference compose(local.TRS) for in-test expectation. */
  function composeLocal(t: LocalTrs): Float32Array {
    const out = mat4.create();
    mat4.compose(out, t.pos, t.quat, t.scale);
    return out;
  }

  function readWorld(world: World, entity: EntityHandle): Float32Array {
    return world.get(entity, GlobalTransform).unwrap().world as Float32Array;
  }

  function expectMatClose(actual: Float32Array, expected: Float32Array): void {
    for (let i = 0; i < 16; i++) {
      expect(actual[i]).toBeCloseTo(expected[i] as number, 5);
    }
  }

  describe('w7 - propagate writes GlobalTransform.world mat4 (AC-05 / AC-06)', () => {
    it('root: world == compose(local.TRS) element-wise epsilon<=1e-5 (AC-06)', () => {
      const world = new World();
      const local = trs({ pos: [3, 4, 5], scale: [2, 2, 2] });
      const root = world.spawn({ component: Transform, data: local }).unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const view = readWorld(world, root);
      expectMatClose(view, composeLocal(local));
    });

    it('flat (no ChildOf, no extra component): world == compose(local) without registering anything (AC-06)', () => {
      const world = new World();
      // 90deg rotation about +Z: quat (0, 0, sin45, cos45) = (0, 0, SQRT1_2, SQRT1_2).
      const local = trs({ pos: [0, 7, 0], quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
      const flat = world.spawn({ component: Transform, data: local }).unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const view = readWorld(world, flat);
      expectMatClose(view, composeLocal(local));
    });

    it('child: world == parent.world x compose(local) element-wise epsilon<=1e-5 (AC-05)', () => {
      const world = new World();
      const parentLocal = trs({ pos: [10, 0, 0], scale: [2, 2, 2] });
      const childLocal = trs({ pos: [2, 3, 0] });
      const parent = world.spawn({ component: Transform, data: parentLocal }).unwrap();
      const child = world
        .spawn({ component: Transform, data: childLocal }, { component: ChildOf, data: { parent } })
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      // parent.world = compose(parentLocal); child.world = parent.world x compose(childLocal).
      const expectedParent = composeLocal(parentLocal);
      const expectedChild = mat4.create();
      mat4.multiply(expectedChild, expectedParent, composeLocal(childLocal));

      expectMatClose(readWorld(world, parent), expectedParent);
      expectMatClose(readWorld(world, child), expectedChild);

      // Sanity on the composed translation: parent scales child local pos by 2,
      // adds parent translation -> (10 + 2*2, 0 + 2*3, 0) = (14, 6, 0).
      const cv = readWorld(world, child);
      expect(cv[12]).toBeCloseTo(14, 5);
      expect(cv[13]).toBeCloseTo(6, 5);
      expect(cv[14]).toBeCloseTo(0, 5);
    });

    it('deep chain grandparent -> parent -> child: world stacks left-multiplied (AC-05)', () => {
      const world = new World();
      const gpLocal = trs({ pos: [1, 0, 0] });
      const pLocal = trs({ pos: [2, 0, 0] });
      const cLocal = trs({ pos: [4, 0, 0] });
      const gp = world.spawn({ component: Transform, data: gpLocal }).unwrap();
      const p = world
        .spawn({ component: Transform, data: pLocal }, { component: ChildOf, data: { parent: gp } })
        .unwrap();
      const c = world
        .spawn({ component: Transform, data: cLocal }, { component: ChildOf, data: { parent: p } })
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const gpWorld = composeLocal(gpLocal);
      const pWorld = mat4.create();
      mat4.multiply(pWorld, gpWorld, composeLocal(pLocal));
      const cWorld = mat4.create();
      mat4.multiply(cWorld, pWorld, composeLocal(cLocal));

      expectMatClose(readWorld(world, gp), gpWorld);
      expectMatClose(readWorld(world, p), pWorld);
      expectMatClose(readWorld(world, c), cWorld);

      // 1 + 2 + 4 = 7 along x.
      expect(readWorld(world, c)[12]).toBeCloseTo(7, 5);
    });

    it('ChildOf referencing a despawned parent: hierarchy-broken (existing missing-parent semantics)', () => {
      const world = new World();
      const ghost = world.spawn({ component: Transform, data: trs() }).unwrap();
      world.despawn(ghost).unwrap();
      const parent = world.spawn({ component: Transform, data: trs() }).unwrap();
      const child = world
        .spawn({ component: Transform, data: trs() }, { component: ChildOf, data: { parent } })
        .unwrap();

      // Public relationship writes reject stale targets.  Deliberately corrupt
      // only the source column through the package-internal seam to preserve
      // this diagnostic regression for malformed imported/editor state.
      const archetype = world[worldInternal].getEntityArchetype(child);
      const record = world[worldInternal].getRecords()[child & 0xffffff];
      if (archetype === undefined || record === undefined) throw new Error('child row missing');
      const tableRow = archetype.rows[record.archetypeRow];
      if (tableRow === undefined) throw new Error('child table row missing');
      const table = world[worldInternal].getGraph().tables[archetype.tableId];
      const parentColumn = table?.storage.get(componentId(ChildOf))?.fields.get('parent');
      if (parentColumn === undefined) throw new Error('ChildOf.parent column missing');
      parentColumn.view[tableRow] = ghost as number;

      const r = propagateTransforms(world);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('hierarchy-broken');
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.expected.length).toBeGreaterThan(0);
    });
  });
}
