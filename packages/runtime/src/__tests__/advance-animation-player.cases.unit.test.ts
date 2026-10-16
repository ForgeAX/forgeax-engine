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
  // --- from advance-animation-player.test.ts ---

  const defaultTransform = {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };

  function makeSampler(
    input: number[],
    output: number[],
    interpolation: 'LINEAR' | 'STEP' = 'LINEAR',
  ): AnimationSampler {
    return {
      input: new Float32Array(input),
      output: new Float32Array(output),
      interpolation,
    };
  }

  function makeClip(duration: number, channels: AnimationClip['channels']): AnimationClip {
    return {
      kind: 'animation-clip',
      duration,
      channels,
    };
  }

  type TestResolver = { clips: Map<number, AnimationClip>; handles?: Map<number, number> };

  function makeResolver(clips: Map<number, AnimationClip>): TestResolver {
    return { clips };
  }

  function advanceAnimationPlayer(world: World, resolver: TestResolver, dt: number): void {
    const handles = resolver.handles ?? new Map<number, number>();
    resolver.handles = handles;
    for (const [raw, clip] of resolver.clips) {
      if (!handles.has(raw)) handles.set(raw, world.allocSharedRef('AnimationClip', clip));
    }
    const query = world.query({ with: [AnimationPlayer] }).unwrap();
    const allocated = new Set(handles.values());
    const players = Array.from(query, (row) => row.entity);
    for (const entity of players) {
      const player = world.get(entity, AnimationPlayer);
      if (!player.ok) continue;
      const clips = Array.from(player.value.clips, (handle) => {
        const mapped = handles.get(handle);
        return mapped ?? (allocated.has(handle) ? handle : 0);
      });
      world.set(entity, AnimationPlayer, { clips });
      const skin = world.get(entity, Skin);
      if (!skin.ok) continue;
      const targets: EntityHandle[] = [];
      for (const raw of skin.value.joints) {
        if (raw === ENTITY_NULL_RAW) continue;
        const target = raw as EntityHandle;
        const name = world.get(target, Name);
        if (!name.ok) continue;
        if (!world.get(target, ChildOf).ok) {
          world.addComponent(target, { component: ChildOf, data: { parent: entity } });
        }
        if (!world.get(target, AnimationTargetId).ok) {
          world.addComponent(target, {
            component: AnimationTargetId,
            data: { value: deriveAnimationTargetId([name.value.value]) },
          });
        }
        targets.push(target);
      }
      bindAnimationTargets(world, entity, targets);
    }
    canonicalAdvanceAnimationPlayer(world, dt);
  }

  // M2 / w3: spawn data migrated to SoA inline arrays. Single-clip legacy
  // path: clips[0] = handle, weights[0] = 1, speeds[0] = speed, times[0] = 0;
  // slots 1..3 stay zero. `world.set({ time: t })` becomes a partial column
  // write `world.set({ times: new Float64Array([t,0,0,0]) })`. Reads of
  // `.time` route through `.times[0]`. Old expectations preserved (time
  // advance / looping modulo / paused skip) — schema cut only.
  function spawnLegacySinglePlayer(
    world: World,
    clipId: number,
    overrides: { speed?: number; paused?: boolean; looping?: boolean } = {},
  ): EntityHandle {
    const speed = overrides.speed ?? 1;
    const paused = overrides.paused ?? false;
    const looping = overrides.looping ?? true;
    return world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [
            toShared<'AnimationClip'>(clipId),
            0 as Handle<'AnimationClip', 'shared'>,
            0 as Handle<'AnimationClip', 'shared'>,
            0 as Handle<'AnimationClip', 'shared'>,
          ],
          times: new Float64Array([0, 0, 0, 0]),
          weights: new Float32Array([1, 0, 0, 0]),
          speeds: new Float32Array([speed, 1, 1, 1]),
          paused,
          looping,
        },
      })
      .unwrap();
  }

  function readLegacyTime(world: World, e: EntityHandle): number {
    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { times: Float64Array };
    return ap.times[0] ?? 0;
  }

  function writeLegacyTime(world: World, e: EntityHandle, t: number): void {
    world.set(e, AnimationPlayer, { times: new Float64Array([t, 0, 0, 0]) });
  }

  describe('T-17 — advanceAnimationPlayer time advance (AC-17 / AC-18)', () => {
    it('advances time by speed * dt each tick (paused=false, looping=true)', () => {
      const world = new World();
      const clip = makeClip(10, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2 });
      writeLegacyTime(world, e, 0);

      advanceAnimationPlayer(world, resolver, 0.5);
      expect(readLegacyTime(world, e)).toBe(1.0);

      advanceAnimationPlayer(world, resolver, 0.5);
      expect(readLegacyTime(world, e)).toBe(2.0);
    });

    it('looping=true: time wraps around with modulo', () => {
      const world = new World();
      const clip = makeClip(3, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2, looping: true });
      writeLegacyTime(world, e, 2);

      advanceAnimationPlayer(world, resolver, 1.0); // 2 + 2*1 = 4, mod 3 = 1
      expect(readLegacyTime(world, e)).toBeCloseTo(1.0, 5);
    });

    it('looping=false: stops at duration', () => {
      const world = new World();
      const clip = makeClip(3, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2, looping: false });
      writeLegacyTime(world, e, 2);

      advanceAnimationPlayer(world, resolver, 1.0); // 2 + 2*1 = 4, clamp to 3
      expect(readLegacyTime(world, e)).toBe(3.0);
    });

    it('paused=true: time does not change', () => {
      const world = new World();
      const clip = makeClip(10, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2, paused: true });
      writeLegacyTime(world, e, 5);

      advanceAnimationPlayer(world, resolver, 0.5);
      expect(readLegacyTime(world, e)).toBe(5.0);
    });
  });

  describe('T-17 — advanceAnimationPlayer joint sampling no-crash (AC-17)', () => {
    it('LINEAR sampling with Skin+Transform: system runs without crash', () => {
      const world = new World();
      const sampler = makeSampler([0, 2], [0, 0, 0, 2, 4, 6], 'LINEAR');
      const clip = makeClip(2, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world.spawn({ component: Transform, data: defaultTransform }).unwrap();

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 1.0)).not.toThrow();
      // Time should have advanced.
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf).toBeDefined();
    });

    it('LINEAR rotation sampling with Skin+Transform: system runs without crash', () => {
      const world = new World();
      const halfSqrt2 = Math.sqrt(2) / 2;
      const sampler = makeSampler([0, 2], [0, 0, 0, 1, 0, halfSqrt2, 0, halfSqrt2], 'LINEAR');
      const clip = makeClip(2, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'rotation', sampler },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world.spawn({ component: Transform, data: defaultTransform }).unwrap();

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 1.0)).not.toThrow();
    });

    it('STEP interpolation with Skin+Transform: system runs without crash', () => {
      const world = new World();
      const sampler = makeSampler([0, 2], [0, 0, 0, 5, 5, 5], 'STEP');
      const clip = makeClip(2, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world.spawn({ component: Transform, data: defaultTransform }).unwrap();

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 1.5)).not.toThrow();
    });
  });

  describe('T-17 — edge cases', () => {
    it('entity without Skin/Transform is skipped gracefully', () => {
      const world = new World();
      const clip = makeClip(10, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      spawnLegacySinglePlayer(world, 1);

      expect(() => advanceAnimationPlayer(world, resolver, 1 / 60)).not.toThrow();
    });

    it('entity with unresolved clip handle is skipped', () => {
      const world = new World();
      const resolver = makeResolver(new Map());

      const e = spawnLegacySinglePlayer(world, 999);
      writeLegacyTime(world, e, 0);

      expect(() => advanceAnimationPlayer(world, resolver, 1 / 60)).not.toThrow();
      expect(readLegacyTime(world, e)).toBe(0);
    });

    it('zero duration clip does not crash', () => {
      const world = new World();
      const clip = makeClip(0, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2 });
      writeLegacyTime(world, e, 0);

      expect(() => advanceAnimationPlayer(world, resolver, 1.0)).not.toThrow();
    });
  });

  describe('T-17 — registerAdvanceAnimationPlayer schedule order (D-9)', () => {
    it('constant ADVANCE_ANIMATION_PLAYER_SYSTEM name matches', async () => {
      const { ADVANCE_ANIMATION_PLAYER_SYSTEM } = await import('@forgeax/engine-animation');
      expect(ADVANCE_ANIMATION_PLAYER_SYSTEM).toBe('advanceAnimationPlayer');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M2 / w6 — dev-mode warn throttle (plan-strategy D-2 / AC-05(d)).
  //
  // Three it blocks per the M2 mission brief:
  //   (a) 60 frames + same triple => warn fires exactly once
  //   (b) two distinct channelKeys (different chIdx) => 2 warns
  //   (c) same channelKey, two distinct reasons => 2 warns (key shape includes reason)
  //
  // Each `it` resets via `_resetAnimationWarnsForTests(world)` so the WeakMap
  // bag is fresh; vi.spyOn(console, 'warn') captures the fan-out and the
  // mock is restored at the test's end.
  //
  // Test scaffolding mirrors the T-17 helpers above (spawnLegacySinglePlayer
  // is single-clip; warn-pass tests need direct multi-slot setup or
  // unmapped target clips, so they use the SoA literal form inline).
  // ──────────────────────────────────────────────────────────────────────────

  describe('M2 / w6 — advanceAnimationPlayer dev-mode warn throttle (D-2)', () => {
    it('60 consecutive frames with same (entity, channel, reason) emit warn exactly once', async () => {
      const { _resetAnimationWarnsForTests } = await import('@forgeax/engine-animation');
      const world = new World();
      // Channel target ID has no matching bound target ID
      // — every frame triggers channel-target-missing on (entity, clip:1, ch:0).
      const sampler = makeSampler([0, 1], [0, 0, 0, 1, 1, 1], 'LINEAR');
      const clip = makeClip(1, [
        {
          targetId: deriveAnimationTargetId(['mismatched-leaf']),
          property: 'translation',
          sampler,
        },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'real-joint' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      _resetAnimationWarnsForTests(world);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let i = 0; i < 60; i++) {
          advanceAnimationPlayer(world, resolver, 1 / 60);
        }
        const targetMissingCalls = warnSpy.mock.calls.filter(
          (c) => (c[0] as { code?: string }).code === 'animation-target-missing',
        );
        expect(targetMissingCalls.length).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('two distinct channel indices on same entity each emit one warn (3 channels => 3 warns)', async () => {
      const { _resetAnimationWarnsForTests } = await import('@forgeax/engine-animation');
      const world = new World();
      // Three channels each targeting an unmapped ID — chIdx differs, so
      // the (entity, clip, chIdx, reason) key splits into 3 distinct entries
      // and the throttle should NOT collapse them.
      const sampler = makeSampler([0, 1], [0, 0, 0, 1, 1, 1], 'LINEAR');
      const clip = makeClip(1, [
        { targetId: deriveAnimationTargetId(['leaf-A']), property: 'translation', sampler },
        { targetId: deriveAnimationTargetId(['leaf-B']), property: 'translation', sampler },
        { targetId: deriveAnimationTargetId(['leaf-C']), property: 'translation', sampler },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'real-joint' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      _resetAnimationWarnsForTests(world);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let i = 0; i < 5; i++) advanceAnimationPlayer(world, resolver, 1 / 60);
        const targetMissingCalls = warnSpy.mock.calls.filter(
          (c) => (c[0] as { code?: string }).code === 'animation-target-missing',
        );
        expect(targetMissingCalls.length).toBe(3);
        const chIdxValues = targetMissingCalls.map(
          (c) => (c[0] as { detail: { channel: number } }).detail.channel,
        );
        expect(new Set(chIdxValues)).toEqual(new Set([0, 1, 2]));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('two distinct reasons on same channel emit two warns (key includes reason)', async () => {
      const { _resetAnimationWarnsForTests } = await import('@forgeax/engine-animation');
      const world = new World();
      // Slot 0: clip 1 has channel 0 = translation on 'real-joint' (resolves)
      //         and channel 1 = translation on 'unknown-joint' (target-missing).
      // Slot 1: clip 2 has only channel 0 = rotation on 'real-joint'.
      // After tick:
      //   - clip1.ch1 fires channel-target-missing (entity, 1, 1, target-missing).
      //   - The (real-joint, rotation) tuple is covered by slot1 but missing
      //     on slot0; slot1.ch0 fires channel-missing-on-some-slot
      //     (entity, 2, 0, missing-on-some-slot). The (real-joint, translation)
      //     tuple is covered by slot0 but missing on slot1; slot0.ch0 fires
      //     channel-missing-on-some-slot (entity, 1, 0, missing-on-some-slot).
      // So we expect: target-missing=1, missing-on-some-slot=2.
      const sampT = makeSampler([0, 1], [0, 0, 0, 1, 1, 1], 'LINEAR');
      const sampR = makeSampler([0, 1], [0, 0, 0, 1, 0, 0, 0, 1], 'LINEAR');
      const clip1 = makeClip(1, [
        {
          targetId: deriveAnimationTargetId(['real-joint']),
          property: 'translation',
          sampler: sampT,
        },
        {
          targetId: deriveAnimationTargetId(['unknown-joint']),
          property: 'translation',
          sampler: sampT,
        },
      ]);
      const clip2 = makeClip(1, [
        { targetId: deriveAnimationTargetId(['real-joint']), property: 'rotation', sampler: sampR },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clip1],
          [2, clip2],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'real-joint' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([0.5, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      _resetAnimationWarnsForTests(world);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let i = 0; i < 5; i++) advanceAnimationPlayer(world, resolver, 1 / 60);
        const targetCalls = warnSpy.mock.calls.filter(
          (c) => (c[0] as { code?: string }).code === 'animation-target-missing',
        );
        const missingCalls = warnSpy.mock.calls.filter(
          (c) => (c[0] as { code?: string }).code === 'animation-channel-missing',
        );
        expect(targetCalls.length).toBe(1);
        // Both translation-on-slot1 and rotation-on-slot0 are missing — two
        // distinct (clip, chIdx, missing-on-some-slot) keys.
        expect(missingCalls.length).toBe(2);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M3 / w8 — N-way weight blend matrix (plan-strategy §7 / AC-03/04/05).
  //
  // Ten it blocks covering normalized blend math, invalid-skip, per-channel
  // normalize, duration-modulo, negative-weight clamp, paused time-stasis,
  // resolver miss, and target-missing skips. All it blocks use the shared
  // makeSampler / makeClip / makeResolver helpers from the enclosing block.
  // ──────────────────────────────────────────────────────────────────────────

  describe('M3 N-way weight blend matrix', () => {
    it('single slot weights=[1,0,0,0] equals hard-cut (pos = clipA pos)', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [1, 2, 3, 10, 20, 30], 'LINEAR');
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5); // time=0.5 => lerp midway
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf.pos[0]).toBeCloseTo(5.5); // lerp(1,10,0.5) = 5.5
      expect(tf.pos[1]).toBeCloseTo(11); // lerp(2,20,0.5) = 11
      expect(tf.pos[2]).toBeCloseTo(16.5); // lerp(3,30,0.5) = 16.5
    });

    it('two-slot weights=[0.5,0.5,0,0] yields midpoint pose', () => {
      const world = new World();
      const sampT1 = makeSampler([0, 1], [0, 0, 0, 4, 0, 0], 'LINEAR'); // pos (2,0,0) at t=0.5
      const sampT2 = makeSampler([0, 1], [0, 0, 0, 0, 6, 0], 'LINEAR'); // pos (0,3,0) at t=0.5
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT1 },
      ]);
      const clipB = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT2 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([0.5, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5); // both at t=0.5
      const tf = world.get(jointE, Transform).unwrap();
      // clipA pos=(2,0,0), clipB pos=(0,3,0), blended=(1,1.5,0) with equal weights
      expect(tf.pos[0]).toBeCloseTo(1);
      expect(tf.pos[1]).toBeCloseTo(1.5);
      expect(tf.pos[2]).toBeCloseTo(0);
    });

    it('three-slot weights=[1/3,1/3,1/3,0] equal-weight blend', () => {
      const world = new World();
      const sampT1 = makeSampler([0, 1], [0, 0, 0, 3, 0, 0], 'LINEAR');
      const sampT2 = makeSampler([0, 1], [0, 0, 0, 0, 3, 0], 'LINEAR');
      const sampT3 = makeSampler([0, 1], [0, 0, 0, 0, 0, 3], 'LINEAR');
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT1 },
      ]);
      const clipB = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT2 },
      ]);
      const clipC = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT3 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
          [3, clipC],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              toShared<'AnimationClip'>(3),
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1 / 3, 1 / 3, 1 / 3, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5); // all at t=0.5
      const tf = world.get(jointE, Transform).unwrap();
      // Each clip at t=0.5: (1.5,0,0), (0,1.5,0), (0,0,1.5) => avg = (0.5,0.5,0.5)
      expect(tf.pos[0]).toBeCloseTo(0.5);
      expect(tf.pos[1]).toBeCloseTo(0.5);
      expect(tf.pos[2]).toBeCloseTo(0.5);
    });

    it('un-normalized weights [0.6,0.6,0,0] normalize to [0.5,0.5,0,0]', () => {
      const world = new World();
      const sampT1 = makeSampler([0, 1], [0, 0, 0, 10, 0, 0], 'LINEAR');
      const sampT2 = makeSampler([0, 1], [0, 0, 0, 0, 10, 0], 'LINEAR');
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT1 },
      ]);
      const clipB = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT2 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([0.6, 0.6, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5);
      const tf = world.get(jointE, Transform).unwrap();
      // Normalized blend: sumW=1.2, each w/Σw=0.5. pos = (5*0.5 + 0*0.5, 0*0.5 + 5*0.5) = (2.5, 2.5)
      expect(tf.pos[0]).toBeCloseTo(2.5);
      expect(tf.pos[1]).toBeCloseTo(2.5);
      // Weights column unchanged (weightsView reflects the original 0.6 values)
    });

    it('weights[i] < 0 clamped to 0 and NOT written back', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [0, 0, 0, 4, 4, 4], 'LINEAR');
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      const animE = world
        .spawn(
          {
            component: AnimationPlayer,
            data: {
              clips: [
                toShared<'AnimationClip'>(1),
                0 as Handle<'AnimationClip', 'shared'>,
                0 as Handle<'AnimationClip', 'shared'>,
                0 as Handle<'AnimationClip', 'shared'>,
              ],
              times: new Float64Array([0, 0, 0, 0]),
              weights: new Float32Array([-0.5, 0, 0, 0]),
              speeds: new Float32Array([1, 0, 0, 0]),
            },
          },
          {
            component: Skin,
            data: {
              skeleton: toShared<'SkeletonAsset'>(100),
              joints: new Uint32Array([jointE]),
            },
          },
          { component: Transform, data: defaultTransform },
        )
        .unwrap();

      // Negative weight clamped -> w=0, slot skipped (no accumulator writes).
      // Transform should remain at its default (position = 0).
      advanceAnimationPlayer(world, resolver, 0.5);
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf.pos[0]).toBe(0);
      expect(tf.pos[1]).toBe(0);
      expect(tf.pos[2]).toBe(0);

      // Read-back: weights[0] is still -0.5 (not written back per D-7).
      const apRes = world.get(animE, AnimationPlayer).unwrap() as unknown as {
        weights: Float32Array;
      };
      expect(apRes.weights[0]).toBe(-0.5);
    });

    it('paused=true does not advance times but still blends by current times', () => {
      const world = new World();
      const sampT1 = makeSampler([0, 1], [0, 0, 0, 10, 0, 0], 'LINEAR');
      const sampT2 = makeSampler([0, 1], [0, 0, 0, 0, 10, 0], 'LINEAR');
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT1 },
      ]);
      const clipB = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT2 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      const animE = world
        .spawn(
          {
            component: AnimationPlayer,
            data: {
              clips: [
                toShared<'AnimationClip'>(1),
                toShared<'AnimationClip'>(2),
                0 as Handle<'AnimationClip', 'shared'>,
                0 as Handle<'AnimationClip', 'shared'>,
              ],
              times: new Float64Array([0.5, 0.2, 0, 0]),
              weights: new Float32Array([0.5, 0.5, 0, 0]),
              speeds: new Float32Array([1, 1, 1, 1]),
              paused: true,
            },
          },
          {
            component: Skin,
            data: {
              skeleton: toShared<'SkeletonAsset'>(100),
              joints: new Uint32Array([jointE]),
            },
          },
          { component: Transform, data: defaultTransform },
        )
        .unwrap();

      advanceAnimationPlayer(world, resolver, 0.5);
      const tf = world.get(jointE, Transform).unwrap();
      // clipA at t=0.5: pos (5,0,0); clipB at t=0.2: pos (0,2,0)
      // blended: (2.5, 1.0, 0)
      expect(tf.pos[0]).toBeCloseTo(2.5);
      expect(tf.pos[1]).toBeCloseTo(1.0);

      // Times unchanged by paused gate
      const apRes = world.get(animE, AnimationPlayer).unwrap() as unknown as {
        times: Float64Array;
      };
      expect(apRes.times[0]).toBeCloseTo(0.5);
      expect(apRes.times[1]).toBeCloseTo(0.2);
    });

    it('resolver cache miss skips slot without warning', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [0, 0, 0, 10, 10, 10], 'LINEAR');
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));
      // clip handle 2 is not in resolver — resolver returns undefined, slot skipped.

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        advanceAnimationPlayer(world, resolver, 0.5);
        // clip 1 at t=0.5 with weight=1: pos=(5,5,5). Slot 2 skipped silently.
        const tf = world.get(jointE, Transform).unwrap();
        expect(tf.pos[0]).toBeCloseTo(5);
        expect(tf.pos[1]).toBeCloseTo(5);
        expect(tf.pos[2]).toBeCloseTo(5);
        // No warn emitted for resolver miss (AC-04: invalid handle / miss = silent skip).
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('clips[i]=0 invalid handle skips slot silently', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [3, 0, 0, 3, 0, 0], 'LINEAR');
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0);
      const tf = world.get(jointE, Transform).unwrap();
      // clipA at t=0 always gives pos=(3,0,0), regardless of other slots being 0.
      expect(tf.pos[0]).toBeCloseTo(3);
    });

    it('different durations each modulo independently without warning', () => {
      const world = new World();
      const sampTShort = makeSampler([0, 0.5], [0, 0, 0, 0.5, 0, 0], 'LINEAR');
      const sampTLong = makeSampler([0, 2], [0, 0, 0, 0, 2, 0], 'LINEAR');
      const clipShort = makeClip(0.5, [
        {
          targetId: deriveAnimationTargetId(['joint0']),
          property: 'translation',
          sampler: sampTShort,
        },
      ]);
      const clipLong = makeClip(2, [
        {
          targetId: deriveAnimationTargetId(['joint0']),
          property: 'translation',
          sampler: sampTLong,
        },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipShort],
          [2, clipLong],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([0.5, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      // Advance by 1.25 seconds.
      // clipShort (duration=0.5, looping): t = 0 + 1.25 = 1.25 -> 1.25 % 0.5 = 0.25 => pos=(0.25,0,0)
      // clipLong (duration=2, looping): t = 0 + 1.25 = 1.25 -> 1.25 % 2 = 1.25 => pos=(0,1.25,0)
      advanceAnimationPlayer(world, resolver, 1.25);
      const tf = world.get(jointE, Transform).unwrap();
      // 0.5*(0.25,0,0) + 0.5*(0,1.25,0) => (0.125, 0.625, 0)
      expect(tf.pos[0]).toBeCloseTo(0.125);
      expect(tf.pos[1]).toBeCloseTo(0.625);
    });

    it('targetId mismatch skips channel (no crash)', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [0, 0, 0, 4, 4, 4], 'LINEAR');
      const clip = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT },
        {
          targetId: deriveAnimationTargetId(['nonexistent-joint']),
          property: 'translation',
          sampler: sampT,
        },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      // Should not crash — the nonexistent-joint channel is skipped.
      expect(() => advanceAnimationPlayer(world, resolver, 0.5)).not.toThrow();
      // The joint0 channel still applies.
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf.pos[0]).toBeCloseTo(2); // lerp(0,4,0.5) = 2
    });

    it('two-slot quat nlerp with sign fix (opposite hemispheres)', () => {
      const world = new World();
      // Clip 1: quat rotates 90 degrees around y (0, 0.707, 0, 0.707)
      // Clip 2: quat rotates -90 degrees around y (0, -0.707, 0, 0.707)
      // Dot = 0*0 + 0.707*(-0.707) + 0*0 + 0.707*0.707 = -0.5 + 0.5 = 0.
      // Sign fix will negate one for short-arc nlerp.
      const sampR1 = makeSampler(
        [0, 1],
        [0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, Math.SQRT1_2],
        'LINEAR',
      );
      const sampR2 = makeSampler(
        [0, 1],
        [0, -Math.SQRT1_2, 0, Math.SQRT1_2, 0, -Math.SQRT1_2, 0, Math.SQRT1_2],
        'LINEAR',
      );
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'rotation', sampler: sampR1 },
      ]);
      const clipB = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'rotation', sampler: sampR2 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0.5, 0.5, 0, 0]),
            weights: new Float32Array([0.5, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 0.5)).not.toThrow();
      const tf = world.get(jointE, Transform).unwrap();
      // nlerp of equal-weight opposite y-rotations should give identity-ish result.
      // quatX/quatZ should stay near 0, quatW stays near 1.
      expect(Math.abs(tf.quat[1])).toBeLessThan(0.01);
      expect(tf.quat[3]).toBeGreaterThan(0.99);
    });

    it('speed<0 reverses time (looping wraparound)', () => {
      const world = new World();
      const sampT = makeSampler([0, 2], [0, 0, 0, 2, 0, 0], 'LINEAR');
      const clip = makeClip(2, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0.5, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([-2, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5); // t = 0.5 + (-2)*0.5 = -0.5 => -0.5 % 2 = -0.5 => -0.5+2=1.5
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf.pos[0]).toBeCloseTo(1.5); // lerp(0,2,0.75) = 1.5
    });

    it('entity with Skin but empty joints is skipped', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [0, 0, 0, 4, 4, 4], 'LINEAR');
      const clip = makeClip(1, [
        { targetId: deriveAnimationTargetId(['joint0']), property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array(0) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 0.5)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M3 / w9 — sample writes counting (per-joint single world.set, not
  // per-channel triple set). Spies on World.prototype.set to count calls
  // matching Transform writes on joint entities.
  // ──────────────────────────────────────────────────────────────────────────

  describe('M3 per-joint sample writes count assertion', () => {
    it('world.set callCount = joint count (not joints x channels)', () => {
      const world = new World();
      // 2 joints + 3 channels (translation/rotation/scale) per clip
      // = 2 clips x 2 joints x 3 channels = 12 channels total.
      // If per-channel set were kept, callCount would be 6 (2 joints x 3 channels).
      // With per-joint accumulator: callCount = 2 (one per joint).
      const sampT = makeSampler([0, 1], [0, 0, 0, 3, 0, 0], 'LINEAR');
      const sampR = makeSampler([0, 1], [0, 0, 0, 1, 0, 0, 0, 1], 'LINEAR');
      const sampS = makeSampler([0, 1], [1, 1, 1, 2, 2, 2], 'LINEAR');
      const clipA = makeClip(1, [
        { targetId: deriveAnimationTargetId(['jointA']), property: 'translation', sampler: sampT },
        { targetId: deriveAnimationTargetId(['jointA']), property: 'rotation', sampler: sampR },
        { targetId: deriveAnimationTargetId(['jointA']), property: 'scale', sampler: sampS },
        { targetId: deriveAnimationTargetId(['jointB']), property: 'translation', sampler: sampT },
        { targetId: deriveAnimationTargetId(['jointB']), property: 'rotation', sampler: sampR },
        { targetId: deriveAnimationTargetId(['jointB']), property: 'scale', sampler: sampS },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));

      const jointA = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'jointA' } },
        )
        .unwrap();
      const jointB = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'jointB' } },
        )
        .unwrap();

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float64Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: {
            skeleton: toShared<'SkeletonAsset'>(100),
            joints: new Uint32Array([jointA, jointB]),
          },
        },
        { component: Transform, data: defaultTransform },
      );

      // Spy on world.set — count calls whose first arg is jointA or jointB.
      const jointHandles = new Set<number>([
        jointA as unknown as number,
        jointB as unknown as number,
      ]);
      let setCount = 0;
      const origSet = world.set.bind(world);
      world.set = (...args: unknown[]) => {
        const entity = args[0] as unknown as number;
        if (jointHandles.has(entity)) setCount++;
        return origSet(...args) as ReturnType<typeof world.set>;
      };

      try {
        advanceAnimationPlayer(world, resolver, 0.5);
        // 2 joints, each receives exactly 1 set(Transform, partial).
        // NOT 6 (2 joints x 3 channels).
        expect(setCount).toBe(2);
      } finally {
        world.set = origSet;
      }
    });
  });
}
