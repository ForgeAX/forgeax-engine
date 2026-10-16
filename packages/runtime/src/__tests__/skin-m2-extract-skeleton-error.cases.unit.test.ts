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
import { buildMeshAttributeMapForUvSets } from '@forgeax/engine-geometry';
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

// Split source block: skin M2 skeleton resolve error path.
// ── feat-20260612-skin-palette-per-frame-upload M2: extractFrame hasSkin ──
// Helpers shared by m2-1..m2-4 tests covering the T-21 placeholder retirement
// (real allocator wiring + 3 new SkinExtractErrorCode routings + assets===null
// bind-pose equivalence).

const SKIN_M2_AABB = new Float32Array([-1, -1, -1, 1, 1, 1]);
// Skinned: 18 floats / vertex × 3 vertices = 54 (12 base + skinIndex u16x4 packed in 2 floats at slots 12-13 + skinWeight vec4 at slots 14-17).
// validateMeshPayload (asset-registry feat: validateMeshPayload skin-aware stride) rejects skin meshes at the 12F stride.
const SKIN_M2_TRIANGLE_VERTICES = new Float32Array([
  // v0: pos (0,0,0) | normal (0,0,1) | uv (0,0) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  // v1: pos (1,0,0) | normal (0,0,1) | uv (1,0) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  // v2: pos (0,1,0) | normal (0,0,1) | uv (0,1) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
]);
const SKIN_M2_TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

const SKIN_M2_IDENTITY_TRANSFORM = {
  pos: [0, 0, 0],
  quat: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function makeSkinM2AssetRegistry(): AssetRegistry {
  const shaderRegistry = makeMockShaderRegistry();
  shaderRegistry.installMaterialArtifact('forgeax::pbr-skin', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'metallic', type: 'f32', default: 0.0 },
      { name: 'roughness', type: 'f32', default: 0.5 },
    ],
  });
  return new AssetRegistry(shaderRegistry);
}

function registerSkinM2Mesh(world: World): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: SKIN_M2_TRIANGLE_VERTICES,
    indices: new Uint16Array([0, 1, 2]),
    attributes: {
      ...buildMeshAttributeMapForUvSets(1),
      position: SKIN_M2_TRIANGLE_POSITIONS,
      skinIndex: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    },
    aabb: SKIN_M2_AABB,
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
  });
}

function registerSkinM2PbrSkinMaterial(world: World): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::pbr-skin' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 1, 1] },
  });
}

function registerSkinM2Skeleton(
  world: World,
  jointCount: number,
): Handle<'SkeletonAsset', 'shared'> {
  const ibm = new Float32Array(jointCount * 16);
  for (let j = 0; j < jointCount; j++) {
    ibm[j * 16 + 0] = 1;
    ibm[j * 16 + 5] = 1;
    ibm[j * 16 + 10] = 1;
    ibm[j * 16 + 15] = 1;
  }
  return world.allocSharedRef<'SkeletonAsset', SkeletonAsset>('SkeletonAsset', {
    kind: 'skeleton',
    inverseBindMatrices: ibm,
    jointCount,
  });
}

function spawnSkinM2Camera(world: World): void {
  world
    .spawn(
      { component: Transform, data: { ...SKIN_M2_IDENTITY_TRANSFORM, pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
    )
    .unwrap();
}

function spawnSkinM2Joint(world: World): EntityHandle {
  return world
    .spawn({ component: Transform, data: SKIN_M2_IDENTITY_TRANSFORM })
    .unwrap() as unknown as EntityHandle;
}

function spawnSkinM2SkinnedEntity(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  matHandle: Handle<'MaterialAsset', 'shared'>,
  skeletonHandle: Handle<'SkeletonAsset', 'shared'>,
  jointEntities: readonly EntityHandle[],
): EntityHandle {
  const joints = new Uint32Array(jointEntities.length);
  for (let j = 0; j < jointEntities.length; j++) {
    joints[j] = jointEntities[j] as unknown as number;
  }
  return world
    .spawn(
      { component: Transform, data: SKIN_M2_IDENTITY_TRANSFORM },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      { component: Skin, data: { skeleton: skeletonHandle, joints } },
    )
    .unwrap() as unknown as EntityHandle;
}

type SkinM2StubAllocator = {
  buffer: null;
  allocatePersistentSlice(input: {
    identity: string;
    generation: number;
    jointCount: number;
    bounds?: Float32Array;
  }): SkinM2PersistentReceipt;
  observePersistentJoints(
    identity: string,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Float32Array[],
  ): readonly number[];
  allocateSlice(jointCount: number): { jointCount: number; byteOffset: number; buffer: null };
  writeJointPalette(
    slice: { jointCount: number; byteOffset: number },
    ibms: readonly Float32Array[],
    jointWorlds: readonly Float32Array[],
  ): void;
  beginFrame(): void;
  endFrame(): void;
  releasePersistentSlice(identity: string): void;
  writePersistentJointPalette(receipt: SkinM2PersistentReceipt): void;
  resetForFrame(): void;
  _resetCount(): number;
  _writeCount(): number;
};

type SkinM2PersistentReceipt = {
  identity: string;
  generation: number;
  jointCount: number;
  byteOffset: number;
  buffer: null;
};

function makeSkinM2StubAllocator(): SkinM2StubAllocator {
  let cursor = 0;
  let resetCount = 0;
  let writeCount = 0;
  return {
    buffer: null,
    allocateSlice(jointCount: number) {
      const offset = cursor;
      // 256-aligned bump (mirrors real allocator dyn-offset alignment).
      cursor = (cursor + jointCount * 64 + 255) & ~255;
      return { jointCount, byteOffset: offset, buffer: null };
    },
    writeJointPalette() {
      writeCount++;
    },
    observePersistentJoints() {
      return [];
    },
    allocatePersistentSlice(input) {
      const slice = this.allocateSlice(input.jointCount);
      return {
        ...slice,
        identity: input.identity,
        generation: input.generation,
        fence: 1,
        customDataStart: 0,
        storageOrUniform: 'storage',
        dirtyRanges: [{ startJoint: 0, jointCount: input.jointCount }],
        uploadBytes: input.jointCount * 64,
        ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
      };
    },
    writePersistentJointPalette() {
      writeCount++;
    },
    beginFrame() {},
    endFrame() {},
    releasePersistentSlice() {},
    resetForFrame() {
      cursor = 0;
      resetCount++;
    },
    _resetCount: () => resetCount,
    _writeCount: () => writeCount,
  };
}

type ExtractFramesWithPipeline = (
  worlds: readonly World[],
  owner: number,
  a: AssetRegistry | null,
  p: { skinPaletteAllocator: SkinM2StubAllocator },
) => ReturnType<typeof extractFrames>;

{
  // --- m2-3: skeleton-resolve-failed routing + continue ---
  describe('feat-20260612 M2 / m2-3: skeleton-resolve-failed routing', () => {
    it('Skin.skeleton points at unregistered handle -> _routeError(skeleton-resolve-failed) + continue (m2-3)', () => {
      const world = new World();
      const assets = makeSkinM2AssetRegistry();
      const meshHandle = registerSkinM2Mesh(world);
      const matHandle = registerSkinM2PbrSkinMaterial(world);
      const skeletonHandleGood = registerSkinM2Skeleton(world, 1);
      // Synthesize an unregistered skeleton handle: a numeric id (>= BUILTIN_BASE)
      // that was never minted in world.sharedRefs. resolveAssetHandle(world, handle)
      // on this handle returns asset-not-found.
      const skeletonHandleMissing = registerSkinM2Skeleton(world, 1);
      spawnSkinM2Camera(world);
      const jointBad = spawnSkinM2Joint(world);
      const jointGood = spawnSkinM2Joint(world);
      // Bad-skin entity (skeleton handle dangling).
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandleMissing, [jointBad]);
      // Simulate a producer releasing a payload while ECS still contains the
      // handle. Normal ECS writes reject stale handles before they reach the
      // render extractor; this preserves the extractor's recovery regression.
      world.sharedRefs.release(skeletonHandleMissing);
      world.sharedRefs.release(skeletonHandleMissing);
      // Sibling well-formed skinned entity in the same frame.
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandleGood, [jointGood]);
      propagateTransforms(world);

      const allocator = makeSkinM2StubAllocator();
      const pipelineState = { skinPaletteAllocator: allocator };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const frame = (extractFrames as unknown as ExtractFramesWithPipeline)(
        [world],
        0,
        assets,
        pipelineState,
      );

      // Exactly one error: skeleton-resolve-failed for the bad entity.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [ctxArg, errArg] = errorSpy.mock.calls[0] ?? [];
      expect((errArg as { code: string }).code).toBe('skeleton-resolve-failed');
      expect(String(ctxArg)).toContain('skeleton-resolve-failed');
      // continue semantics: sibling well-formed entity still emerges with skin.
      const skinned = frame.renderables.filter((r) => r.skin !== undefined);
      expect(skinned.length).toBe(1);
    });
  });
}
