// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
import type { AssetHandle } from '@forgeax/engine-types';
import { testAssets } from './helpers/runtime-assets';
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
//
// Source files (N=21):
//   - packages/runtime/src/__tests__/children.test.ts
//   - packages/runtime/src/__tests__/components.test.ts
//   - packages/runtime/src/__tests__/hierarchy-components.test.ts
//   - packages/runtime/src/__tests__/inspector-frustum-stats.test.ts
//   - packages/runtime/src/__tests__/layer-component.test.ts
//   - packages/runtime/src/__tests__/mesh-renderer-pickable.test.ts
//   - packages/runtime/src/__tests__/pick.test.ts
//   - packages/runtime/src/__tests__/register-inspector.test.ts
//   - packages/runtime/src/__tests__/relationship-migration-regression.test.ts
//   - packages/runtime/src/__tests__/scene-defaults.test.ts
//   - packages/runtime/src/__tests__/sort-key-component.test.ts
//   - packages/runtime/src/components/__tests__/animation-player.test.ts
//   - packages/runtime/src/components/__tests__/camera.test.ts
//   - packages/runtime/src/components/__tests__/layer.test.ts
//   - packages/runtime/src/components/__tests__/mesh-renderer.test.ts
//   - packages/runtime/src/components/__tests__/skybox-background.test.ts
//   - packages/runtime/src/components/__tests__/sort-key.test.ts
//   - packages/runtime/src/components/__tests__/sprite-components-schema.test.ts
//   - packages/runtime/src/components/__tests__/sprite-playback-mode.test.ts
//   - packages/runtime/src/components/__tests__/transform.test.ts
//   - packages/runtime/src/__tests__/mesh-renderer-multi-material.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { AnimationPlayer } from '@forgeax/engine-animation';
import {
  type Component,
  defineComponent,
  ENTITY_NULL_RAW,
  type EntityHandle,
  World,
} from '@forgeax/engine-ecs';
import { componentDefinition, componentId, componentSchema } from '@forgeax/engine-ecs/internal';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  DirectionalLight,
  Layer,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  perspective,
  SceneInstance,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  type SkyboxMode,
  SortKey,
  TONEMAP_NONE,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';
import {
  GlyphText,
  SpriteAnimation,
  SpriteRegionOverride,
  Tilemap,
} from '@forgeax/engine-render/authoring';
import * as SceneOwner from '@forgeax/engine-scene';
import {
  ChildOf,
  Children,
  GlobalTransform,
  propagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import type { SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { tonemapFromF32 } from '../../../render/src/components/camera';
import { skyboxModeFromF32 } from '../../../render/src/components/skybox-background';
import {
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  type SpritePlaybackMode,
  spritePlaybackModeFromU32,
} from '../../../render/src/components/sprite-playback-mode';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

{
  // --- from children.test.ts ---
  // w13 - Children component schema migration to `array<entity>` (M3).
  //
  // Locks AC-05 (requirements.md): the `entities: 'array<entity>'` field
  // resolves to a fresh `Uint32Array` snapshot at the get-site, and the
  // snapshot length reflects the live element count after
  // `world.push(parent, Children, 'entities', child)` /
  // `world.pop(parent, Children, 'entities')` mutation routes through the
  // M0/M1/M2 BufferPool slot + sidecar count column infrastructure.
  //
  // feat-20260515-buffer-array-vocab-collapse M3 / w17: rewritten for the
  // collapsed-vocab API surface -- the `VarArrayView<Entity>` wrapper was
  // retired (M2 / w10). AI users mutate via the three `world` commands and
  // read through the read-only `Uint32Array` snapshot; `snap.length` is the
  // live count, `snap[i]` is the packed Entity u32.
  //
  // Test path note: project convention places runtime tests under
  // `src/__tests__/` (TS rootDir = `./src`). The plan-tasks.json target path
  // `packages/runtime/src/components/__tests__/children.test.ts` lives outside
  // rootDir and would not be picked up by `tsc -b`. The test file therefore
  // lands under `src/__tests__/` to match the existing
  // `hierarchy-components.test.ts` convention.

  describe('w13 - Children { entities: array<entity> } schema (AC-05)', () => {
    it('componentSchema(Children).entities is the array<entity> keyword (no legacy `count` field)', () => {
      expect(Children.name).toBe('Children');
      expect(Object.keys(componentSchema(Children)).length).toBe(1);
      expect((componentSchema(Children) as Record<string, unknown>).entities).toBe('array<entity>');
      expect((componentSchema(Children) as Record<string, unknown>).count).toBeUndefined();
    });

    it('world.get(e, Children).entities is a Uint32Array snapshot with length reflecting initial payload', () => {
      const world = new World();
      world.components.register(ChildOf).unwrap();
      world.components.register(Children).unwrap();
      const parent = world.spawn().unwrap();
      const a = world.spawn({ component: ChildOf, data: { parent } }).unwrap();
      const b = world.spawn({ component: ChildOf, data: { parent } }).unwrap();
      const got = world.get(parent, Children).unwrap();
      // `Children` is an engine-maintained materialized target. Its snapshot
      // is read-only; source-side ChildOf writes are the only mutation route.
      expect(got.entities.length).toBe(2);
      expect(got.entities[0]).toBe(a);
      expect(got.entities[1]).toBe(b);
    });
  });
}

{
  // --- from components.test.ts ---
  // w7 - 5 component schema runtime registration + multi-component spawn (TDD red).
  //
  // Locks plan-strategy 7.2 naming + requirements IN-1 schema field set:
  //   Transform: pos:[f32x3] + quat:[f32x4] + scale:[f32x3] + shear:[f32x3]
  //   MeshFilter:         assetHandle:'asset<mesh>' (u32)
  //   MeshRenderer:       materials:'array<asset<material>>' (u32)
  //   Camera:             fov:f32 + aspect:f32 + near:f32 + far:f32   = 4 f32
  //   DirectionalLight: direction:[f32x3] + color:[f32x3] + intensity:f32 = 7 f32
  //
  // Storage shape: forgeax ECS columns store scalar fields as flat scalars
  // (`Float32Array` / `Uint32Array`) and vector / quaternion fields as inline
  // fixed-length array columns (`array<f32, N>`, e.g. `pos: [x, y, z]`).
  // The 5-component schema picks names that AI users see in `world.get(e, T)`
  // and `data: {...}` shapes.
  //
  // charter mapping: proposition 1 (single import + LSP hover discoverability) +
  // proposition 3 (machine-readable schema > prose) + proposition 5 (consistent
  // abstraction: components are flat-scalar SoA columns, not nested objects).

  describe('w7 - 5 component schemas register through defineComponent', () => {
    it('Transform has the four authored local affine array fields', () => {
      expect(Transform.name).toBe('Transform');
      expect(Object.keys(componentSchema(Transform)).length).toBe(4);
      // pos: inline [x, y, z]
      expect(componentSchema(Transform).pos).toBe('array<f32, 3>');
      // quat: inline [x, y, z, w] quaternion
      expect(componentSchema(Transform).quat).toBe('array<f32, 4>');
      // scale: inline [x, y, z]
      expect(componentSchema(Transform).scale).toBe('array<f32, 3>');
      expect(componentSchema(Transform).shear).toBe('array<f32, 3>');
      expect(GlobalTransform.name).toBe('GlobalTransform');
      expect(componentSchema(GlobalTransform).world).toBe('array<f32, 16>');
    });

    it('MeshFilter has 1 asset<mesh> field (assetHandle; M5 / w14)', () => {
      expect(MeshFilter.name).toBe('MeshFilter');
      expect(Object.keys(componentSchema(MeshFilter)).length).toBe(1);
      expect(componentSchema(MeshFilter).assetHandle).toBe('asset<mesh>');
    });

    it('MeshRenderer has materials, lighting channels and pipeline preparation', () => {
      expect(MeshRenderer.name).toBe('MeshRenderer');
      expect(componentSchema(MeshRenderer)).toEqual({
        materials: 'array<asset<material>>',
        lightingChannels: 'f64',
        preparePipelines: 'bool',
      });
    });

    it('Camera has 33 fields including target, targetLayer, exposure, and color grading columns', () => {
      expect(Camera.name).toBe('Camera');
      expect(Object.keys(componentSchema(Camera)).length).toBe(33);
      expect(componentSchema(Camera).targetLayer).toBe('u32');
      expect(componentSchema(Camera).fov).toBe('f32');
      expect(componentSchema(Camera).aspect).toBe('f32');
      expect(componentSchema(Camera).near).toBe('f32');
      expect(componentSchema(Camera).far).toBe('f32');
      expect(componentSchema(Camera).projection).toBe('f32');
      expect(componentSchema(Camera).left).toBe('f32');
      expect(componentSchema(Camera).right).toBe('f32');
      expect(componentSchema(Camera).bottom).toBe('f32');
      expect(componentSchema(Camera).top).toBe('f32');
      expect(componentSchema(Camera).historyVersion).toBe('u32');
      // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.2: AC-01 + D-1.
      expect(componentSchema(Camera).tonemap).toBe('f32');
      expect(componentSchema(Camera).exposure).toBe('f32');
      expect(componentSchema(Camera).whitePoint).toBe('f32');
      expect(componentSchema(Camera).antialias).toBe('f32');
      // feat-20260531-bloom-first-declarative-render-graph-pass / w2.
      expect(componentSchema(Camera).bloom).toBe('f32');
      expect(componentSchema(Camera).bloomThreshold).toBe('f32');
      expect(componentSchema(Camera).bloomIntensity).toBe('f32');
      expect(componentSchema(Camera).bloomSmoothWidth).toBe('f32');
      expect(componentSchema(Camera).bloomRadius).toBe('f32');
      // feat-20260709 M3: clear-color quartet collapsed into one inline
      // array<f32,4> column (clearColor); per-axis scalars are gone.
      expect(componentSchema(Camera).clearColor).toBe('array<f32, 4>');
      expect('clearR' in componentSchema(Camera)).toBe(false);
      expect('clearG' in componentSchema(Camera)).toBe(false);
      expect('clearB' in componentSchema(Camera)).toBe(false);
      expect('clearA' in componentSchema(Camera)).toBe(false);
      // feat-20260617-host-engine-contract-and-video-cutscene / M3: aspect-sync
      // opt-out flag (bool column tier, not f32).
      expect(componentSchema(Camera).autoAspect).toBe('bool');
      expect(componentSchema(Camera).exposureMode).toBe('f32');
      expect(componentSchema(Camera).compensationEv).toBe('f32');
      expect(componentSchema(Camera).rangeEv).toBe('array<f32, 2>');
      expect(componentSchema(Camera).rates).toBe('array<f32, 2>');
      expect(componentSchema(Camera).temperature).toBe('f32');
      expect(componentSchema(Camera).tint).toBe('f32');
      expect(componentSchema(Camera).colorLut).toBe('asset<texture>');
      expect(componentSchema(Camera).colorLutStrength).toBe('f32');
    });

    it('DirectionalLight includes lightingChannels alongside light and shadow fields', () => {
      // feat-20260621: DirectionalLightShadow merged into DirectionalLight via castShadow toggle.
      // shadowDistance replaced the nearPlane/farPlane pair (near derives from camera).
      // feat-20260709 M2: direction/color collapsed from 6 per-axis scalars to
      // two array<f32,3> columns (3 light fields: direction + color + intensity).
      expect(DirectionalLight.name).toBe('DirectionalLight');
      expect(Object.keys(componentSchema(DirectionalLight)).length).toBe(28);
      expect(componentSchema(DirectionalLight).lightingChannels).toBe('f64');
      expect(componentSchema(DirectionalLight).staggerCascades).toBe('bool');
      expect(componentDefinition(DirectionalLight).defaults?.staggerCascades).toBe(false);
      expect(componentDefinition(DirectionalLight).defaults?.staticShadowCache).toBe(true);
      expect(componentSchema(DirectionalLight).contactShadowLength).toBe('f32');
      // 3 light fields
      expect(componentSchema(DirectionalLight).direction).toBe('array<f32, 3>');
      expect(componentSchema(DirectionalLight).color).toBe('array<f32, 3>');
      expect(componentSchema(DirectionalLight).intensity).toBe('f32');
      // shadow gate + merged shadow quality and cadence fields
      expect(componentSchema(DirectionalLight).castShadow).toBe('bool');
      expect(componentSchema(DirectionalLight).mapSize).toBe('f32');
      expect(componentSchema(DirectionalLight).cascadeCount).toBe('f32');
      expect(componentSchema(DirectionalLight).splitLambda).toBe('f32');
      expect(componentSchema(DirectionalLight).cascadeBlend).toBe('f32');
      expect(componentSchema(DirectionalLight).depthBias).toBe('f32');
      expect(componentSchema(DirectionalLight).normalBias).toBe('f32');
      expect(componentSchema(DirectionalLight).shadowDistance).toBe('f32');
      expect(componentSchema(DirectionalLight).shadowFilter).toBe('enum');
      expect(componentSchema(DirectionalLight).shadowAngularRadius).toBe('f32');
      expect(componentSchema(DirectionalLight).maxPenumbraTexels).toBe('f32');
      expect('pcfKernelSize' in componentSchema(DirectionalLight)).toBe(false);
    });

    it('all 5 components are frozen tokens with owner-assigned identities', () => {
      expect(Object.isFrozen(Transform)).toBe(true);
      expect(Object.isFrozen(MeshFilter)).toBe(true);
      expect(Object.isFrozen(MeshRenderer)).toBe(true);
      expect(Object.isFrozen(Camera)).toBe(true);
      expect(Object.isFrozen(DirectionalLight)).toBe(true);
      for (const t of [Transform, MeshFilter, MeshRenderer, Camera, DirectionalLight]) {
        expect(typeof componentId(t)).toBe('number');
        expect(componentId(t)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('w7 - world.spawn({ component, data }) accepts each of the 5 components', () => {
    it('spawn Transform succeeds and stores the pos/quat/scale values', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Transform,
          data: { pos: [1, 2, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        })
        .unwrap();
      const r = world.get(e, Transform).unwrap();
      expect(Array.from(r.pos)).toEqual([1, 2, 3]);
      expect(Array.from(r.quat)).toEqual([0, 0, 0, 1]);
      expect(Array.from(r.scale)).toEqual([1, 1, 1]);
    });

    it('spawn MeshFilter with a managed Mesh reference succeeds', () => {
      const world = new World();
      const e = world
        .spawn({
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world)
              .create(createBoxGeometry(1, 1, 1).unwrap())
              .unwrap(),
          },
        })
        .unwrap();
      const r = world.get(e, MeshFilter).unwrap();
      expect(testAssets(world).read(r.assetHandle).unwrap().kind).toBe('mesh');
    });

    it('spawn MeshRenderer with a managed Material reference succeeds', () => {
      const world = new World();
      const e = world
        .spawn({
          component: MeshRenderer,
          data: {
            materials: [
              testAssets(world)
                .create(Materials.unlit([1, 1, 1, 1]))
                .unwrap(),
            ],
          },
        })
        .unwrap();
      const r = world.get(e, MeshRenderer).unwrap();
      const material = r.materials[0];
      if (material === undefined) throw new Error('Missing material binding');
      expect(testAssets(world).read(material).unwrap().kind).toBe('material');
    });

    it('spawn Camera with perspective parameters succeeds', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
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
        })
        .unwrap();
      const r = world.get(e, Camera).unwrap();
      expect(r.fov).toBeCloseTo(Math.PI / 4, 5);
      expect(r.far).toBe(100);
    });

    it('spawn DirectionalLight succeeds', () => {
      const world = new World();
      const e = world
        .spawn({
          component: DirectionalLight,
          data: {
            direction: [-0.5, -1, -0.3],
            color: [1, 1, 1],
            intensity: 1,
          },
        })
        .unwrap();
      const r = world.get(e, DirectionalLight).unwrap();
      expect(r.intensity).toBe(1);
      expect(r.color[0]).toBe(1);
    });

    it('multi-component spawn (Transform + MeshFilter + MeshRenderer + Camera) targets a single archetype', () => {
      const world = new World();
      const assets = testAssets(world);
      const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      const materialHandle = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
      const e = world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [0, 0, 0],
              quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          {
            component: MeshRenderer,
            data: {
              materials: [materialHandle],
            },
          },
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
      expect(world.get(e, Transform).unwrap().pos[0]).toBe(0);
      expect(world.get(e, MeshFilter).unwrap().assetHandle).toBe(meshHandle);
      expect(world.get(e, MeshRenderer).unwrap().materials[0]).toBe(materialHandle);
      expect(world.get(e, Camera).unwrap().far).toBe(100);
    });
  });

  describe('w7 - 5 component schemas remain unique tokens (no double registration / no name collision)', () => {
    it('5 components have 5 distinct componentId values', () => {
      const ids = new Set([
        componentId(Transform),
        componentId(MeshFilter),
        componentId(MeshRenderer),
        componentId(Camera),
        componentId(DirectionalLight),
      ]);
      expect(ids.size).toBe(5);
    });

    it('user-defined component with the same name shape compiles independently', () => {
      // Using the same user-style schema to confirm the 5 engine tokens do not
      // collide with downstream user code at the registry level. The user token
      // is a fresh allocation; it does not interfere with the 5 engine tokens.
      const UserPos = defineComponent('UserPos', { x: { type: 'f32' } });
      expect(componentId(UserPos)).not.toBe(componentId(Transform));
    });
  });
}

{
  // --- from hierarchy-components.test.ts ---
  // w5 - ChildOf / Children hierarchy component schema tests.
  //
  // Locks plan-strategy §D-P2 + requirements AC-12 schema field set:
  //   ChildOf:         { parent: 'entity' }
  //                    (M5 / w18 - migrated from raw 'ref' to schema-vocab
  //                    'entity' keyword; the parent column carries the encoded
  //                    Entity and the ECS does not bottom out dangling refs on
  //                    read - consumers check liveness themselves)
  //   Children:        { entities: 'array<entity>' } = variable-length
  //                    forward-list of child entity u32s (M3 / w13 of
  //                    feat-20260514-ecs-children-instances-managed-buffer-array
  //                    migrated from the legacy `count: 'u32'` advisory marker
  //                    to the real ECS-managed array storage path; AC-05).
  //                    The dedicated assertion lives in children.test.ts; this
  //                    file keeps an integration-shape spawn smoke for the
  //                    archetype-with-Children path.
  //
  // The resolved world transform is the `GlobalTransform.world` mat4 column;
  // Transform's generic ECS requirement materializes that carrier on normal
  // spawn/add paths. Propagation + hierarchy compose coverage lives in
  // render-system-extract.test.ts (GlobalTransform.world parent x child).
  //
  // charter mapping: proposition 2 (Bevy ChildOf/Children industry analog) +
  // proposition 3 (machine-readable schema > prose: grep componentSchema(ChildOf) /
  // componentSchema(Children) recovers shape).

  describe('w5 - ChildOf / Children register through defineComponent', () => {
    it('ChildOf has 1 entity field (parent) (M5 / w18)', () => {
      expect(ChildOf.name).toBe('ChildOf');
      expect(Object.keys(componentSchema(ChildOf)).length).toBe(1);
      expect(componentSchema(ChildOf).parent).toBe('entity');
    });

    it('Children has 1 array<entity> field (entities; M3 / w13 migration from legacy `count: u32`)', () => {
      expect(Children.name).toBe('Children');
      expect(Object.keys(componentSchema(Children)).length).toBe(1);
      expect((componentSchema(Children) as Record<string, unknown>).entities).toBe('array<entity>');
    });

    it('GlobalTransform carries the resolved world mat4 column', () => {
      const tKeys = Object.keys(componentSchema(GlobalTransform));
      expect(tKeys).toContain('world');
      expect(componentSchema(GlobalTransform).world).toBe('array<f32, 16>');
      expect(componentSchema(Transform).pos).toBe('array<f32, 3>');
      expect(componentSchema(Transform).quat).toBe('array<f32, 4>');
      expect(componentSchema(Transform).scale).toBe('array<f32, 3>');
      expect(componentSchema(Transform).shear).toBe('array<f32, 3>');
    });

    it('ChildOf / Children frozen tokens (schema immutable)', () => {
      expect(Object.isFrozen(componentSchema(ChildOf))).toBe(true);
      expect(Object.isFrozen(componentSchema(Children))).toBe(true);
    });

    it('spawn with ChildOf carries encoded Entity u32 through ref field round-trip', () => {
      const world = new World();
      const root = world
        .spawn({
          component: Transform,
          data: {
            pos: [0, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        })
        .unwrap();
      const child = world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [1, 0, 0],
              quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
          { component: ChildOf, data: { parent: root } },
        )
        .unwrap();
      const r = world.get(child, ChildOf);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.parent).toBe(root);
    });

    it('spawn with Transform + Children creates archetype with both components', () => {
      const world = new World();
      const root = world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [0, 0, 0],
              quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
          { component: Children, data: { entities: new Uint32Array([]) as never } },
        )
        .unwrap();
      const rt = world.get(root, Transform);
      expect(rt.ok).toBe(true);
      if (!rt.ok) return;
      expect(rt.value.quat[3]).toBe(1);
      expect(rt.value.scale[0]).toBe(1);
      const rc = world.get(root, Children);
      expect(rc.ok).toBe(true);
      if (!rc.ok) return;
      // The variable-length entities snapshot starts empty for a fresh spawn
      // with a zero-length payload; the snapshot length equals the live count.
      // A dedicated push/pop suite lives in children.test.ts.
      expect(rc.value.entities.length).toBe(0);
    });

    // Silence unused-import lint if defineComponent elsewhere; keep the symbol
    // reference so the test file double-checks barrel wiring side-effects.
    it('defineComponent type is re-exported through @forgeax/engine-ecs', () => {
      expect(typeof defineComponent).toBe('function');
    });
  });
}

{
  // --- from layer-component.test.ts ---
  // w07 - Layer component schema spawn (TDD red).
  //
  // feat-20260520-2d-sprite-layer-mvp M-2 w07 / requirements AC-06 + AC-18 path (1).
  //
  // Coverage:
  //   - 4 explicit Layer values: {-100, 0, 100, 1000} (background / default /
  //     foreground / UI). i32 schema must preserve negative values via two's
  //     complement (no schema-layer mutate). plan-strategy §7 M-2 acceptance
  //     anchor AC-06.
  //   - 1 fallback case: entity spawned without Layer must round-trip via the
  //     existing 4-layer spawn fallback chain (feat-20260517-spawn-default-
  //     fallback) — value defaults to 0 (i32 scalar default), no fifth fallback
  //     layer introduced (AC-18 path (1)).
  //
  // charter mapping: F1 (single-import barrel discovery) + P3 (explicit defaults
  // — i32 zero default surfaces as a read-back value, not undefined) +
  // P4 (consistent abstraction — Layer is a generic ECS render component, not a
  // 2D-only special; 3D entities may also carry Layer).
  //
  // TDD red: imports Layer from the runtime barrel; w11 implements the
  // component file + barrel re-export to turn this green.

  describe('w07 - Layer = defineComponent("Layer", { value: "i32" })', () => {
    it('has schema { value: "i32" } (1 i32 field)', () => {
      expect(Layer.name).toBe('Layer');
      expect(Object.keys(componentSchema(Layer)).length).toBe(1);
      expect(componentSchema(Layer).value).toBe('i32');
    });

    it("spawn Layer { value: -100 } (background) round-trips with two's complement", () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: -100 } }).unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(-100);
    });

    it('spawn Layer { value: 0 } (default / game layer) round-trips', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: 0 } }).unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(0);
    });

    it('spawn Layer { value: 100 } (foreground) round-trips', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: 100 } }).unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(100);
    });

    it('spawn Layer { value: 1000 } (UI) round-trips', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: 1000 } }).unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(1000);
    });

    it('spawn payload omitting value falls through 4-layer chain to schema default 0 (AC-18 path 1)', () => {
      // Entity spawned without Layer payload — the existing 4-layer spawn
      // fallback chain (feat-20260517-spawn-default-fallback) fills i32
      // scalar default 0. No fifth fallback layer is introduced for this
      // feat (AC-18 path 1). The call below uses an empty `data: {}` payload
      // (no value field). The spawn must succeed (Result.ok) and the
      // round-tripped value must be exactly 0.
      const world = new World();
      const spawnResult = world.spawn({ component: Layer, data: {} });
      expect(spawnResult.ok).toBe(true);
      const e = spawnResult.unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(0);
    });
  });
}

{
  // --- from relationship-migration-regression.test.ts ---
  // relationship-migration-regression.test.ts -- unit project (t21, M4).
  // Zero-regression + auto-sync verification for the ChildOf/Children
  // relationship migration (t20).
  //
  // Two orthogonal guarantees after ChildOf gained its `relationship` block:
  //   AC-25 reader path unchanged -- propagateTransforms still walks ChildOf.parent
  //     upward and composes child.GlobalTransform.world = parent.world x
  //     compose(child local). The migration must NOT alter this output.
  //   AC-25 mirror auto-maintained -- spawning / removing / reparenting ChildOf
  //     now auto-updates the parent's Children.entities list (the OOS-10 manual-
  //     sync contract is retired). This is the new behaviour the migration adds.
  //
  // CPU-only (no GPU access): propagateTransforms is pure matrix math and the
  // bidirectional sync is pure ECS bookkeeping, so this runs in the unit layer
  // alongside the pixel-readback propagate coverage in the dawn layer (AC-04).

  function transformData(x: number, y: number, z: number) {
    return { pos: [x, y, z], quat: [0, 0, 0, 1], scale: [1, 1, 1] };
  }

  describe('relationship-migration-regression (t21 / AC-25 / AC-26)', () => {
    it('ChildOf remains the writable relationship source token', () => {
      expect(ChildOf.name).toBe('ChildOf');
    });

    it('propagateTransforms reader path unchanged: child composes parent x local translation', () => {
      const world = new World();
      const parent = world.spawn({ component: Transform, data: transformData(10, 0, 0) }).unwrap();
      const child = world
        .spawn(
          { component: Transform, data: transformData(1, 2, 3) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      // feat-20260601: the resolved world transform lives on GlobalTransform.world
      // (a 16-float column-major mat4); the translation column is m[12,13,14].
      const t = world.get(child, GlobalTransform);
      expect(t.ok).toBe(true);
      if (!t.ok) return;
      const w = t.value.world;
      // parent translates +10 X, child local +1/+2/+3 -> world 11/2/3.
      expect(w[12]).toBeCloseTo(11, 5);
      expect(w[13]).toBeCloseTo(2, 5);
      expect(w[14]).toBeCloseTo(3, 5);
    });

    it('spawning ChildOf auto-appends the child to parent.Children.entities (OOS-10 retired)', () => {
      const world = new World();
      // Mirror must be registered before the holder is used (M2 contract:
      // the relationship hook resolves Children by name from the registry).
      const parent = world.spawn({ component: Transform, data: transformData(0, 0, 0) }).unwrap();
      const a = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();
      const b = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();

      const snap = world.get(parent, Children);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      expect(Array.from(snap.value.entities)).toEqual([a, b]);
    });

    it('removing ChildOf prunes the child from parent.Children.entities', () => {
      const world = new World();
      const parent = world.spawn({ component: Transform, data: transformData(0, 0, 0) }).unwrap();
      const a = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();
      const b = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();

      world.removeComponent(a, ChildOf).unwrap();

      const snap = world.get(parent, Children);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      expect(Array.from(snap.value.entities)).toEqual([b]);
    });

    it('reparent (exclusive re-add) moves the child between parent Children lists', () => {
      const world = new World();
      const oldParent = world
        .spawn({ component: Transform, data: transformData(0, 0, 0) })
        .unwrap();
      const newParent = world
        .spawn({ component: Transform, data: transformData(0, 0, 0) })
        .unwrap();
      const child = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent: oldParent } },
        )
        .unwrap();

      // Atomic detach-then-attach reparent via the M3 Commands surface.
      world.reparent(child, newParent, ChildOf, { parent: newParent }).unwrap();

      const oldSnap = world.get(oldParent, Children);
      const newSnap = world.get(newParent, Children);
      expect(oldSnap.ok && newSnap.ok).toBe(true);
      if (!oldSnap.ok || !newSnap.ok) return;
      expect(Array.from(oldSnap.value.entities)).toEqual([]);
      expect(Array.from(newSnap.value.entities)).toEqual([child]);

      // Reader path: ChildOf.parent now points at newParent.
      const co = world.get(child, ChildOf);
      expect(co.ok).toBe(true);
      if (!co.ok) return;
      expect(co.value.parent).toBe(newParent);
    });
  });

  // feat-20260602 M2 / w7: relationship-mirror validation moved into
  // `defineComponent` (define-time fail-fast). The runtime ChildOf holder
  // declares `mirror: 'Children'`, so the component barrel must export Children
  // (the mirror) before ChildOf (the holder) -- otherwise `defineComponent`
  // throws RelationshipMirrorComponentNotRegisteredError while the package is
  // being evaluated. This block is the load-bearing guard for that barrel
  // ordering: a clean dynamic import proves the module-evaluation order
  // satisfies the mirror-before-holder define-time contract.
  describe('relationship-migration-regression (feat-20260602 M2 / w7 barrel order)', () => {
    it('imports @forgeax/engine-runtime without throwing on module evaluation', async () => {
      const mod = await import('@forgeax/engine-scene');
      expect(mod.Children).toBeDefined();
      expect(mod.ChildOf).toBeDefined();
    });

    it('runtime scene barrel exposes both relationship tokens', async () => {
      const { ChildOf, Children } = await import('@forgeax/engine-scene');
      expect(ChildOf.name).toBe('ChildOf');
      expect(Children.name).toBe('Children');
      expect((componentSchema(Children) as Record<string, string>).entities).toBe('array<entity>');
    });
  });
}

{
  // --- from scene-defaults.test.ts ---
  // scene-defaults.test - default-value 4-layer fallback (w20 TDD red).
  //
  // Coverage map (anchored to requirements §AC-07 / §AC-11 / §AC-12 +
  // §default-value mechanism + plan-strategy §D-P3 / §D-P4):
  //
  //   (a) AC-07 layer 1 explicit Scene value:
  //       SceneEntity.components.Transform.pos = [1.5, 0, 0] -> instantiate ->
  //       pos === [1.5, 0, 0]. Explicit Scene value beats every layer 2/3
  //       default (no setOverride written, so overrides() stays empty).
  //
  //   (b) AC-11 layer 2 component-level defaults (D-P3 add-only minor):
  //       defineComponent('Transform',
  //         { pos: { type: 'array<f32, 3>', default: new Float32Array([0, 7, 0]) } });
  //       SceneEntity does NOT write pos -> instantiate -> pos === [0, 7, 0].
  //
  //   (c) AC-12 layer 3 TS type defaults + NULL_ENTITY sentinel:
  //       Three layers all silent on pos -> pos === [0, 0, 0] (TS array<f32, N>
  //       zero-fill default).
  //       'entity' typed field with no source value -> NULL_ENTITY sentinel
  //       (raw u32 = 0xffffffff per ENTITY_NULL_RAW SSOT). Layer 3 silent --
  //       MUST NOT throw 'scene-default-missing'; charter tension explicitly
  //       captured in requirements + plan-strategy.
  //
  //   (d) layer-boundary discipline:
  //       Known schema field name + missing value -> walks layer 1 -> 2 -> 3
  //       chain (this test file).
  //       Unknown field name (typo 'pozX') -> ajv fail-fast rejects upstream
  //       at pack-schema validate, never reaching instantiate -- that path is
  //       owned by AC-08 in packages/pack scene-schema tests (M1 / w4 covers
  //       it). The boundary is "known name + missing value = silent fallback;
  //       unknown name = fail-fast" -- this file asserts the silent half so
  //       the contract is bidirectionally pinned.
  //
  // w22 (ImplementerAgent M4) lands the impl in
  // packages/ecs/src/scene-instance-container.ts; this file is the red phase.

  // M3 ECS-fication: scene-instance container API replaced; tests use
  // world.instantiateScene + registerSceneAsset (allocUniqueRef + toShared)
  // and read mapping via the SceneInstance component on the synthetic root.
  // SceneInstance schema must be locally registered so resolveComponent finds
  // it during instantiateScene (matches the runtime schema definition).
  defineComponent('SceneInstance', {
    source: { type: 'asset<scene>' },
    mapping: { type: 'array<entity>' },
    state: { type: 'unique<SceneInstanceState>' },
  });

  function buildScene(nodes: readonly (SceneEntity & { readonly key: string })[]): SceneAsset {
    return {
      kind: 'scene',
      entities: Object.fromEntries(
        nodes.map(({ key, components, instance }) => [
          key,
          { components, ...(instance === undefined ? {} : { instance }) },
        ]),
      ),
    };
  }

  function registerSceneAsset(
    world: World,
    asset: SceneAsset,
    components: readonly Component[] = [Transform],
  ): AssetHandle<'scene'> {
    for (const component of [SceneInstance, ChildOf, Children, ...components]) {
      world.components.register(component).unwrap();
    }
    return testAssets(world).create(asset).unwrap();
  }

  function firstNodeEntity(world: World, root: EntityHandle): EntityHandle {
    // entityToLocalId.keys() iterates in topo-sort spawn order; first key is
    // localId 0's live Entity. Robust against the mapping[0]===0 encoding
    // (gen=0+idx=0 produces raw u32 0, which is a valid Entity not "empty").
    const stateRes = SceneOwner.worldGetSceneInstanceState(world, root);
    if (!stateRes.ok) throw new Error('SceneInstance state lookup failed');
    const it = stateRes.value.entityToLocalId.keys();
    const first = it.next();
    if (first.done) throw new Error('entityToLocalId empty');
    return first.value;
  }

  describe('default-value 4-layer fallback (w20 / AC-07 + AC-11 + AC-12)', () => {
    it('AC-07 layer 1: explicit Scene value beats every default', () => {
      const Transform = defineComponent('Transform', {
        pos: { type: 'array<f32, 3>', default: new Float32Array([99, 99, 99]) },
      });
      const world = new World();
      world.components.register(Transform).unwrap();

      const nodes: Parameters<typeof buildScene>[0] = [
        {
          key: 'entity-0',
          components: { Transform: { pos: [1.5, 0, 0] } },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes), [Transform]);
      const r = SceneOwner.worldInstantiateScene(world, handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const t = world.get(e, Transform).unwrap();
      expect(Array.from(t.pos)).toEqual([1.5, 0, 0]);
      // overrides stay empty - no setSceneOverride was called. M3 reads them
      // from the SceneInstanceState payload via getSceneInstanceState.
      const stateRes = SceneOwner.worldGetSceneInstanceState(world, r.value.root);
      expect(stateRes.ok).toBe(true);
      if (!stateRes.ok) return;
      expect(stateRes.value.overrides.size).toBe(0);
    });

    it('AC-11 layer 2: component-level defaults fill missing fields (D-P3)', () => {
      const Transform = defineComponent('Transform', {
        pos: { type: 'array<f32, 3>', default: new Float32Array([0, 7, 0]) },
      });
      const world = new World();
      world.components.register(Transform).unwrap();

      // Node omits pos entirely -> layer 2 fills the whole array column with
      // the field-descriptor default [0, 7, 0] (beats the layer-3 zero-fill,
      // asserted in the next test).
      const nodes: Parameters<typeof buildScene>[0] = [
        {
          key: 'entity-0',
          components: { Transform: {} },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes), [Transform]);
      const r = SceneOwner.worldInstantiateScene(world, handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const t = world.get(e, Transform).unwrap();
      expect(Array.from(t.pos)).toEqual([0, 7, 0]);
    });

    it('AC-12 layer 3: TS type defaults silently fill three-layer-empty fields', () => {
      const Transform = defineComponent('Transform', {
        pos: 'array<f32, 3>',
        flag: 'bool',
        kind: 'u32',
      });
      const world = new World();
      world.components.register(Transform).unwrap();

      // No defaults at the component level; node writes nothing. Three-layer
      // chain leaves pos / flag / kind empty -> layer 3 fills with TS type
      // defaults. AC-12 mandates this path is SILENT (no error code).
      const nodes: Parameters<typeof buildScene>[0] = [
        {
          key: 'entity-0',
          components: { Transform: {} },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes), [Transform]);
      const r = SceneOwner.worldInstantiateScene(world, handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const t = world.get(e, Transform).unwrap();
      expect(Array.from(t.pos)).toEqual([0, 0, 0]); // array<f32, 3> -> zero-fill
      expect(t.flag).toBe(false); // bool -> false (read back as 0/1)
      expect(t.kind).toBe(0); // u32 -> 0
    });

    it('AC-12 layer 3: entity-typed field falls back to NULL_ENTITY sentinel', () => {
      const TargetSlot = defineComponent('TargetSlot', { target: 'entity' });
      const world = new World();
      world.components.register(TargetSlot).unwrap();

      // Node declares TargetSlot with NO target value -> three layers silent
      // -> layer 3 must store ENTITY_NULL_RAW (0xffffffff) sentinel in the u32
      // column. On read, readRow decodes ENTITY_NULL_RAW back to JS null (the
      // null-sentinel mapping is a storage-level convention, not a liveness check).
      // Both shapes are pinned here so a regression in either direction trips
      // this test:
      //   - storage layer: ENTITY_NULL_RAW is the sentinel SSOT
      //   - read layer:    null is what the AI user observes after world.get
      const nodes: Parameters<typeof buildScene>[0] = [
        {
          key: 'entity-0',
          components: { TargetSlot: {} },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes), [TargetSlot]);
      const r = SceneOwner.worldInstantiateScene(world, handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const slot = world.get(e, TargetSlot).unwrap();
      // Read-side: ENTITY_NULL_RAW storage maps back to null; layer 3 silent
      // path must NOT emit any error code.
      expect(slot.target).toBe(null);
      // SSOT pin: verify ENTITY_NULL_RAW is the agreed sentinel (so the
      // contract between layer 3 and the storage column stays bidirectional).
      expect(ENTITY_NULL_RAW).toBe(0xffffffff);
    });

    it('layer chain order: layer 1 > layer 2 > layer 3 priority discipline', () => {
      // Compose all three layers in one node so the priority chain is
      // observable in a single instantiate roundtrip (one field per layer;
      // array columns fill whole-field, not per-lane):
      //   pos:   layer 1 wins (explicit Scene value)
      //   quat:  layer 2 wins (component default)
      //   scale: layer 3 wins (silent TS default)
      const Transform = defineComponent('Transform', {
        pos: { type: 'array<f32, 3>', default: new Float32Array([99, 99, 99]) },
        quat: { type: 'array<f32, 4>', default: new Float32Array([0, 7, 0, 1]) },
        scale: 'array<f32, 3>',
      });
      const world = new World();
      world.components.register(Transform).unwrap();

      const nodes: Parameters<typeof buildScene>[0] = [
        {
          key: 'entity-0',
          components: { Transform: { pos: [1.5, 0, 0] } },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes), [Transform]);
      const r = SceneOwner.worldInstantiateScene(world, handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const t = world.get(e, Transform).unwrap();
      expect(Array.from(t.pos)).toEqual([1.5, 0, 0]); // layer 1 wins (explicit beats default 99)
      expect(Array.from(t.quat)).toEqual([0, 7, 0, 1]); // layer 2 wins (component default beats type 0)
      expect(Array.from(t.scale)).toEqual([0, 0, 0]); // layer 3 wins (TS array<f32, N> zero-fill)
    });

    it('layer 3 silent path: no error code surface on three-layer-empty schema field', () => {
      // Charter tension declared in requirements §default-value mechanism +
      // plan-strategy §3.3 §error-model: layer 3 MUST be silent. This test
      // pins the negative -- the Result must be ok and no error-shaped value
      // surfaces to the caller.
      const Transform = defineComponent('Transform', {
        pos: 'array<f32, 3>',
      });
      const world = new World();
      world.components.register(Transform).unwrap();

      const nodes: Parameters<typeof buildScene>[0] = [
        { key: 'entity-0', components: { Transform: {} } },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes), [Transform]);
      const r = SceneOwner.worldInstantiateScene(world, handle);
      expect(r.ok).toBe(true);
      // No 'scene-default-missing' / similar code surfaces. Asserted at the
      // Result envelope -- if w22 ever introduces such a code in the silent
      // path this assertion flips red.
    });
  });
}

{
  // --- from sort-key-component.test.ts ---
  // w08 - SortKey component schema spawn (TDD red).
  //
  // feat-20260520-2d-sprite-layer-mvp M-2 w08 / requirements AC-07 + AC-19 (4).
  //
  // Coverage:
  //   - SortKey { value: 1.5 } round-trips with f32 precision.
  //   - spawn without SortKey reads back default 0.0 (f32 scalar default
  //     via the 4-layer fallback chain — feat-20260517-spawn-default-fallback).
  //   - Layer { value: 100 } + SortKey { value: -2.0 } co-exist on one entity
  //     (multi-component spawn targets a single archetype).
  //
  // Transparent ordering is owned by `TransparentSortCache`
  // (render/src/systems/transparent-dispatch.ts) — this task only validates that SortKey is a registerable scalar f32 component
  // with the expected read-back path. charter mapping: F1 + P3 + P4 (Layer +
  // SortKey are generic ECS renderer components, not 2D-only specials).
  //
  // TDD red: w12 implements the component file + barrel re-export to turn
  // this green.

  describe('w08 - SortKey = defineComponent("SortKey", { value: "f32" })', () => {
    it('has schema { value: "f32" } (1 f32 field)', () => {
      expect(SortKey.name).toBe('SortKey');
      expect(Object.keys(componentSchema(SortKey)).length).toBe(1);
      expect(componentSchema(SortKey).value).toBe('f32');
    });

    it('spawn SortKey { value: 1.5 } round-trips within f32 precision', () => {
      const world = new World();
      const e = world.spawn({ component: SortKey, data: { value: 1.5 } }).unwrap();
      const r = world.get(e, SortKey).unwrap();
      expect(r.value).toBeCloseTo(1.5, 5);
    });

    it('spawn payload omitting value falls through 4-layer chain to f32 default 0', () => {
      const world = new World();
      const spawnResult = world.spawn({ component: SortKey, data: {} });
      expect(spawnResult.ok).toBe(true);
      const e = spawnResult.unwrap();
      const r = world.get(e, SortKey).unwrap();
      expect(r.value).toBe(0);
    });

    it('Layer + SortKey co-exist on a single entity (multi-component spawn)', () => {
      const world = new World();
      const e = world
        .spawn(
          { component: Layer, data: { value: 100 } },
          { component: SortKey, data: { value: -2.0 } },
        )
        .unwrap();
      const layerRead = world.get(e, Layer).unwrap();
      const sortKeyRead = world.get(e, SortKey).unwrap();
      expect(layerRead.value).toBe(100);
      expect(sortKeyRead.value).toBeCloseTo(-2.0, 5);
    });
  });
}

{
  // Direct and graph playback share one schema; masks are World-local bindings.
  describe('AnimationPlayer schema', () => {
    it('registers the twelve playback and graph fields', () => {
      expect(AnimationPlayer.name).toBe('AnimationPlayer');
      const schema = componentSchema(AnimationPlayer) as Record<string, unknown>;
      expect(Object.keys(schema).length).toBe(12);
      expect(schema).toEqual({
        clips: 'array<asset<animation-clip>>',
        times: 'array<f64>',
        weights: 'array<f32>',
        speeds: 'array<f32>',
        masks: 'array<shared<AnimationMask>>',
        graph: 'asset<animation-graph>',
        nodeWeights: 'array<f32>',
        nodeTimes: 'array<f64>',
        nodeSpeeds: 'array<f32>',
        nodeMasks: 'array<shared<AnimationMask>>',
        paused: 'bool',
        looping: 'bool',
      });
    });

    it('componentSchema(AnimationPlayer).clips is variable array<asset<animation-clip>> (SoA keyword)', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).clips).toBe(
        'array<asset<animation-clip>>',
      );
    });

    it('componentSchema(AnimationPlayer).times is variable array<f64>', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).times).toBe(
        'array<f64>',
      );
    });

    it('componentSchema(AnimationPlayer).weights is variable array<f32>', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).weights).toBe(
        'array<f32>',
      );
    });

    it('componentSchema(AnimationPlayer).speeds is variable array<f32>', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).speeds).toBe(
        'array<f32>',
      );
    });

    it('componentSchema(AnimationPlayer).paused is bool', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).paused).toBe('bool');
    });

    it('componentSchema(AnimationPlayer).looping is bool', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).looping).toBe('bool');
    });

    it('componentSchema(AnimationPlayer).graph is asset<animation-graph> (M3 / w24 graph handle)', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).graph).toBe(
        'asset<animation-graph>',
      );
    });

    it('componentSchema(AnimationPlayer).nodeWeights is variable array<f32> (M3 / w24 per-node knob)', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).nodeWeights).toBe(
        'array<f32>',
      );
    });

    it('componentSchema(AnimationPlayer).nodeTimes is variable array<f64> (M3 / w24 per-node seek time)', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).nodeTimes).toBe(
        'array<f64>',
      );
    });

    it('componentSchema(AnimationPlayer).nodeSpeeds is variable array<f32> (M3 / w24 per-node speed)', () => {
      expect((componentSchema(AnimationPlayer) as Record<string, unknown>).nodeSpeeds).toBe(
        'array<f32>',
      );
    });

    it('old field clip is absent from schema (AC-02 type-level error)', () => {
      expect(componentSchema(AnimationPlayer)).not.toHaveProperty('clip');
    });

    it('old field time is absent from schema (AC-02 type-level error)', () => {
      expect(componentSchema(AnimationPlayer)).not.toHaveProperty('time');
    });

    it('old field speed is absent from schema (AC-02 type-level error)', () => {
      expect(componentSchema(AnimationPlayer)).not.toHaveProperty('speed');
    });

    it('AnimationPlayer spawn yields variable SoA defaults: clips/times/weights/speeds all empty, paused=false, looping=true (M1 / w4 variable columns, speeds default [])', () => {
      const world = new World();
      const e = world
        .spawn({
          component: AnimationPlayer,
          data: {},
        })
        .unwrap();
      const ap = world.get(e, AnimationPlayer).unwrap() as unknown as {
        clips: Uint32Array;
        times: Float64Array;
        weights: Float32Array;
        speeds: Float32Array;
        paused: boolean;
        looping: boolean;
      };
      // Variable columns default to empty (no slot active). Consumers write all
      // four columns length-synced when spawning an active player (M1 / w7).
      expect(ap.clips).toBeInstanceOf(Uint32Array);
      expect(ap.clips.length).toBe(0);
      expect(ap.times).toBeInstanceOf(Float64Array);
      expect(ap.times.length).toBe(0);
      expect(ap.weights).toBeInstanceOf(Float32Array);
      expect(ap.weights.length).toBe(0);
      // speeds layer-2 default retired to [] (was [1,1,1,1]); a variable column
      // cannot carry a fixed-width "play at 1x" default without desyncing from
      // an empty clips column.
      expect(ap.speeds).toBeInstanceOf(Float32Array);
      expect(ap.speeds.length).toBe(0);
      expect(ap.paused).toBe(false);
      expect(ap.looping).toBe(true);
    });

    it('AnimationPlayer spawn with explicit SoA data overrides defaults', () => {
      const world = new World();
      const clips = [1, 2, 3, 4].map((duration) =>
        testAssets(world).create({ kind: 'animation-clip', duration, channels: [] }).unwrap(),
      );
      const e = world
        .spawn({
          component: AnimationPlayer,
          data: {
            clips,
            times: new Float64Array([0, 1.5, 0, 0]),
            weights: new Float32Array([0.7, 0.3, 0, 0]),
            speeds: new Float32Array([1, 0.5, 0, 0]),
            paused: true,
            looping: false,
          },
        })
        .unwrap();
      const ap = world.get(e, AnimationPlayer).unwrap() as unknown as {
        clips: Uint32Array;
        times: Float64Array;
        weights: Float32Array;
        speeds: Float32Array;
        paused: boolean;
        looping: boolean;
      };
      expect(ap.clips[0]).toBe(clips[0]);
      expect(ap.clips[1]).toBe(clips[1]);
      expect(ap.clips[2]).toBe(clips[2]);
      expect(ap.clips[3]).toBe(clips[3]);
      expect(ap.times[0]).toBe(0);
      expect(ap.times[1]).toBeCloseTo(1.5, 5);
      expect(ap.weights[0]).toBeCloseTo(0.7, 5);
      expect(ap.weights[1]).toBeCloseTo(0.3, 5);
      expect(ap.speeds[0]).toBeCloseTo(1, 5);
      expect(ap.speeds[1]).toBeCloseTo(0.5, 5);
      expect(ap.paused).toBe(true);
      expect(ap.looping).toBe(false);
    });

    it('AnimationPlayer set(times) updates the times array column', () => {
      const world = new World();
      const e = world
        .spawn({
          component: AnimationPlayer,
          data: {},
        })
        .unwrap();
      world.set(e, AnimationPlayer, { times: new Float64Array([2.0, 0, 0, 0]) });
      const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { times: Float64Array };
      expect(ap.times[0]).toBeCloseTo(2.0, 5);
    });
  });
}

{
  // --- from camera.test.ts ---
  // feat-20260602-ecs-component-type-field-reflection-metadata-base / M5 / w14.
  //
  // Camera SSOT invariant guards (AC-07). Two concerns:
  //
  //   (a) Full 21-field snapshot tests for perspective() / orthographic() factory
  //       functions — every field value is asserted to match the pre-migration
  //       reference. These guards ensure the w13 SSOT refactoring (deleting
  //       CameraDataPod, deriving factory base from Camera token defaults) does
  //       not change any field-level behavior.
  //
  //   (b) Camera.fields reflection guard: 17 f32 fields, each with type:'f32'.
  //       After w13 deletes CameraDataPod, the factory return type is also verified
  //       to be derivable from the Camera token (no standalone interface).
  //
  // Anchors: requirements AC-07 (camera SSOT guard), plan-strategy D-A4
  // (keep factories, delete CameraDataPod), plan-tasks.json w14/w13.

  // ────────────────────────────────────────────────────────────────────────────
  // w14-a: 21-field value snapshot (AC-07 invariant guard for w13 SSOT
  //        refactoring — every field value must stay byte-identical)
  // ────────────────────────────────────────────────────────────────────────────

  describe('camera factory 33-field schema snapshot (w14 AC-07 invariant)', () => {
    it('perspective({ fov: Math.PI/3, aspect: 16/9 }) — all 20 fields match reference', () => {
      const pod = perspective({ fov: Math.PI / 3, aspect: 16 / 9 });
      // Caller-supplied projection with shared clip defaults
      expect(pod.fov).toBeCloseTo(Math.PI / 3, 6);
      expect(pod.aspect).toBeCloseTo(16 / 9, 6);
      expect(pod.near).toBeCloseTo(0.1, 6);
      expect(pod.far).toBe(2000);
      // Projection discriminator
      expect(pod.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      // Ortho quartet defaults
      expect(pod.left).toBe(-1);
      expect(pod.right).toBe(1);
      expect(pod.bottom).toBe(-1);
      expect(pod.top).toBe(1);
      // Tonemap trio defaults
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
      // Post-processing defaults
      expect(pod.antialias).toBe(ANTIALIAS_NONE);
      expect(pod.historyVersion).toBe(0);
      expect(pod.bloom).toBe(BLOOM_DISABLED);
      expect(pod.bloomThreshold).toBeCloseTo(1, 6);
      expect(pod.bloomIntensity).toBeCloseTo(0.5, 6);
      expect(pod.bloomSmoothWidth).toBeCloseTo(0.01, 6);
      expect(pod.bloomRadius).toBeCloseTo(0, 6);
      // Clear-color default: transparent black array [0,0,0,0] (feat-20260709 M3;
      // E9 factory-pathway carries the new array default via
      // cameraPodFromDefaults()).
      expect(Array.from(pod.clearColor)).toEqual([0, 0, 0, 0]);
      // aspect-sync opt-out default (feat-20260617 / M3)
      expect(pod.autoAspect).toBe(true);
    });

    it('perspective({ fov: 45, aspect: 4/3, near: 0.01, far: 1000 }) — explicit overrides, rest defaults', () => {
      const pod = perspective({ fov: 45, aspect: 4 / 3, near: 0.01, far: 1000 });
      expect(pod.fov).toBe(45);
      expect(pod.aspect).toBeCloseTo(4 / 3, 6);
      expect(pod.near).toBeCloseTo(0.01, 6);
      expect(pod.far).toBe(1000);
      expect(pod.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      expect(pod.left).toBe(-1);
      expect(pod.right).toBe(1);
      expect(pod.bottom).toBe(-1);
      expect(pod.top).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
      expect(pod.antialias).toBe(ANTIALIAS_NONE);
      expect(pod.bloom).toBe(BLOOM_DISABLED);
      expect(pod.bloomThreshold).toBeCloseTo(1, 6);
      expect(pod.bloomIntensity).toBeCloseTo(0.5, 6);
      expect(pod.bloomSmoothWidth).toBeCloseTo(0.01, 6);
      expect(pod.bloomRadius).toBeCloseTo(0, 6);
    });

    it('orthographic({ left: -10, right: 10, bottom: -10, top: 10 }) — all 20 fields match reference', () => {
      const pod = orthographic({ left: -10, right: 10, bottom: -10, top: 10 });
      // Ortho bounds — caller-supplied
      expect(pod.left).toBe(-10);
      expect(pod.right).toBe(10);
      expect(pod.bottom).toBe(-10);
      expect(pod.top).toBe(10);
      expect(pod.near).toBeCloseTo(0.1, 6);
      expect(pod.far).toBe(2000);
      // Perspective fields sentinel
      expect(pod.fov).toBe(0);
      expect(pod.aspect).toBe(1);
      expect(pod.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      // Tonemap trio defaults
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
      // Post-processing defaults
      expect(pod.antialias).toBe(ANTIALIAS_NONE);
      expect(pod.historyVersion).toBe(0);
      expect(pod.bloom).toBe(BLOOM_DISABLED);
      expect(pod.bloomThreshold).toBeCloseTo(1, 6);
      expect(pod.bloomIntensity).toBeCloseTo(0.5, 6);
      expect(pod.bloomSmoothWidth).toBeCloseTo(0.01, 6);
      expect(pod.bloomRadius).toBeCloseTo(0, 6);
      // Clear-color default: transparent black array [0,0,0,0] (feat-20260709 M3).
      expect(Array.from(pod.clearColor)).toEqual([0, 0, 0, 0]);
      // aspect-sync opt-out default (feat-20260617 / M3): the sidecar only
      // touches perspective cameras, but the column default is shared.
      expect(pod.autoAspect).toBe(true);
    });

    it('orthographic({ ..., near: -1, far: 1 }) — explicit near/far overrides', () => {
      const pod = orthographic({ left: 0, right: 800, bottom: 600, top: 0, near: -1, far: 1 });
      expect(pod.left).toBe(0);
      expect(pod.right).toBe(800);
      expect(pod.bottom).toBe(600);
      expect(pod.top).toBe(0);
      expect(pod.near).toBe(-1);
      expect(pod.far).toBe(1);
      expect(pod.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(pod.fov).toBe(0);
      expect(pod.aspect).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
    });

    it('perspective + orthographic 32-field payload counts (32 factory Camera values)', () => {
      const p = perspective({ fov: 60, aspect: 4 / 3 });
      const o = orthographic({ left: -1, right: 1, bottom: -1, top: 1 });
      // Both return exactly 32 values (including targetLayer 0): Camera.fields also
      // includes the optional target reference, which factories intentionally leave unset.
      // The returned values include exposure and color grading columns +
      // autoAspect bool column; feat-20260709 M3 collapsed the 4-scalar
      // clear-color quartet into one inline array<f32,4>).
      expect(Object.keys(p).length).toBe(32);
      expect(Object.keys(o).length).toBe(32);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Camera.fields reflection guard (AC-07 SSOT — 18 f32 fields)
  // ────────────────────────────────────────────────────────────────────────────

  describe('Camera.fields reflection (w14 AC-07 SSOT)', () => {
    it('Camera.fields has exactly 33 keys matching the Camera column set', () => {
      const keys = Object.keys(Camera.fields).sort();
      expect(keys).toEqual([
        'antialias',
        'aspect',
        'autoAspect',
        'bloom',
        'bloomIntensity',
        'bloomRadius',
        'bloomSmoothWidth',
        'bloomThreshold',
        'bottom',
        'clearColor',
        'colorLut',
        'colorLutStrength',
        'compensationEv',
        'exposure',
        'exposureMode',
        'far',
        'fov',
        'historyVersion',
        'left',
        'near',
        'projection',
        'projectionOffset',
        'rangeEv',
        'rates',
        'right',
        'target',
        'targetLayer',
        'temperature',
        'tint',
        'tonemap',
        'top',
        'transparency',
        'whitePoint',
      ]);
    });

    it('every Camera.fields entry has the declared numeric, bool, or array storage kind', () => {
      for (const key of Object.keys(Camera.fields) as Array<keyof typeof Camera.fields>) {
        const expected =
          key === 'autoAspect'
            ? 'bool'
            : key === 'clearColor'
              ? 'array<f32, 4>'
              : key === 'rangeEv' || key === 'rates' || key === 'projectionOffset'
                ? 'array<f32, 2>'
                : key === 'colorLut'
                  ? 'asset<texture>'
                  : key === 'historyVersion' || key === 'targetLayer'
                    ? 'u32'
                    : key === 'target'
                      ? 'shared<RenderTarget>'
                      : 'f32';
        expect(Camera.fields[key].type).toBe(expected);
      }
    });

    it('Camera.fields is frozen', () => {
      expect(Object.isFrozen(Camera.fields)).toBe(true);
    });

    it("Camera.fields defaults match factory reference values (confirmed by w14-a's snapshot)", () => {
      // The per-field defaults stored in Camera.fields after M3 migration
      // should align with what perspective() / orthographic() use as
      // their base values. Field of view and aspect remain explicit; both
      // projection factories inherit the same near/far defaults.
      const d = Camera.fields;
      expect(d.projection.default).toBe(0);
      expect(Array.from(d.projectionOffset.default as Float32Array)).toEqual([0, 0]);
      expect(d.left.default).toBe(-1);
      expect(d.right.default).toBe(1);
      expect(d.bottom.default).toBe(-1);
      expect(d.top.default).toBe(1);
      expect(d.tonemap.default).toBe(0);
      expect(d.exposure.default).toBeCloseTo(1.0, 6);
      expect(d.whitePoint.default).toBeCloseTo(4.0, 6);
      expect(d.antialias.default).toBe(0);
      expect(d.historyVersion.default).toBe(0);
      expect(d.targetLayer.default).toBe(0);
      expect(d.bloom.default).toBe(0);
      expect(d.bloomThreshold.default).toBeCloseTo(1, 6);
      expect(d.bloomIntensity.default).toBeCloseTo(0.5, 6);
      expect(d.bloomSmoothWidth.default).toBeCloseTo(0.01, 6);
      expect(d.bloomRadius.default).toBeCloseTo(0, 6);
      // Clear-color default: explicit layer-2 transparent black array (feat-20260709
      // M3; array layer-3 fallback is all-zero so the default MUST be explicit,
      // D-5).
      expect(Array.from(d.clearColor.default as Float32Array)).toEqual([0, 0, 0, 0]);
      // aspect-sync opt-out default (feat-20260617 / M3).
      expect(d.autoAspect.default).toBe(true);
      expect(d.exposureMode.default).toBe(0);
      expect(d.compensationEv.default).toBe(0);
      expect(Array.from(d.rangeEv.default as Float32Array)).toEqual([-8, 8]);
      expect(Array.from(d.rates.default as Float32Array)).toEqual([3, 1]);
      expect(d.temperature.default).toBe(6504);
      expect(d.tint.default).toBe(0);
      expect(d.colorLut.default).toBe(0);
      expect(d.colorLutStrength.default).toBe(1);
      expect(d.transparency.default).toBe(0);
      // Projection shape stays explicit; clip defaults belong to Camera.
      expect(d.fov.default).toBeUndefined();
      expect(d.aspect.default).toBeUndefined();
      expect(d.near.default).toBe(0.1);
      expect(d.far.default).toBe(2000);
    });
  });

  describe('componentDefinition(Camera).defaults — frozen token defaults map (AC-07 + feat-20260528-fxaa-post-processing + feat-20260531-bloom + feat-20260608-clear-color)', () => {
    it('componentDefinition(Camera).defaults includes exposure and color grading defaults', () => {
      expect(componentDefinition(Camera).defaults).toEqual({
        near: 0.1,
        far: 2000,
        projection: 0,
        projectionOffset: new Float32Array([0, 0]),
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
        tonemap: 0,
        exposure: 1.0,
        whitePoint: 4.0,
        antialias: 0,
        historyVersion: 0,
        targetLayer: 0,
        bloom: 0,
        bloomThreshold: 1,
        bloomIntensity: 0.5,
        bloomSmoothWidth: 0.01,
        bloomRadius: 0,
        clearColor: new Float32Array([0, 0, 0, 0]),
        autoAspect: true,
        exposureMode: 0,
        compensationEv: 0,
        rangeEv: new Float32Array([-8, 8]),
        rates: new Float32Array([3, 1]),
        temperature: 6504,
        tint: 0,
        colorLut: 0,
        colorLutStrength: 1,
        transparency: 0,
      });
    });

    it('componentDefinition(Camera).defaults is deep-frozen (Object.isFrozen returns true)', () => {
      expect(componentDefinition(Camera).defaults).toBeDefined();
      // Object.isFrozen is true for any frozen object; defineComponent
      // freezes the per-component defaults map at registration time.
      expect(Object.isFrozen(componentDefinition(Camera).defaults)).toBe(true);
    });

    it('componentDefinition(Camera).defaults carries clip distances while fov and aspect stay explicit', () => {
      const d = componentDefinition(Camera).defaults as
        | Readonly<Record<string, unknown>>
        | undefined;
      expect(d).toBeDefined();
      if (d === undefined) return;
      expect('fov' in d).toBe(false);
      expect('aspect' in d).toBe(false);
      expect(d.near).toBe(0.1);
      expect(d.far).toBe(2000);
    });
  });

  describe('Camera 4-field perspective spawn — token defaults fill ortho quartet (AC-07 runtime)', () => {
    it('world.spawn({ component: Camera, data: { fov, aspect, near, far } }) yields projection === 0 + ortho defaults', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 16 / 9,
            near: 0.1,
            far: 100,
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();

      // Layer-1: explicit values pass through (f32 round on 16 / 9).
      expect(row.fov).toBeCloseTo(Math.PI / 4, 6);
      expect(row.aspect).toBeCloseTo(16 / 9, 6);
      expect(row.near).toBeCloseTo(0.1, 6);
      expect(row.far).toBe(100);

      // Layer-2 (token defaults): projection + 4 ortho fields + 3 tonemap fields.
      expect(row.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      expect(row.left).toBe(-1);
      expect(row.right).toBe(1);
      expect(row.bottom).toBe(-1);
      expect(row.top).toBe(1);
      expect(row.tonemap).toBe(TONEMAP_NONE);
      expect(row.exposure).toBeCloseTo(1.0, 6);
      expect(row.whitePoint).toBeCloseTo(4.0, 6);
    });

    it('explicit ortho override path: caller passes projection + 4 ortho fields, defaults yield', () => {
      // Token defaults must NOT clobber explicit caller input -- this is
      // the layer-1 wins clause from research section F1.
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: 0,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: 1,
            left: -10,
            right: 10,
            bottom: -10,
            top: 10,
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();
      expect(row.projection).toBe(1);
      expect(row.left).toBe(-10);
      expect(row.right).toBe(10);
      expect(row.bottom).toBe(-10);
      expect(row.top).toBe(10);
    });
  });

  // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.1 + T-M1.2.
  //
  // Camera tonemap field surface (AC-01 + AC-04 + AC-05 + AC-06). Three
  // schema columns (tonemap / exposure / whitePoint) plus a string-literal
  // closed union map (TONEMAP_NONE / TONEMAP_REINHARD_EXTENDED +
  // tonemapFromF32) following the same shape as projection +
  // cameraProjectionFromF32. Defaults: { tonemap: 0, exposure: 1.0,
  // whitePoint: 4.0 } belong to the layer-2 token defaults map (D-1 + D-7
  // in plan-strategy section 2.3). Spawn-time numeric range fail-fast is
  // out of scope per O1 (plan-decisions L-O1) — shader floor max(Y, 1e-5)
  // guards exposure / whitePoint == 0 from NaN.
  describe('Camera tonemap mapping (AC-01)', () => {
    it('TONEMAP_NONE === 0 + TONEMAP_REINHARD_EXTENDED === 1 (numeric encoding)', () => {
      expect(TONEMAP_NONE).toBe(0);
      expect(TONEMAP_REINHARD_EXTENDED).toBe(1);
    });

    it('tonemapFromF32(0) === "none" + tonemapFromF32(1) === "reinhard-extended"', () => {
      expect(tonemapFromF32(0)).toBe('none');
      expect(tonemapFromF32(1)).toBe('reinhard-extended');
    });

    it('tonemapFromF32 maps all 8 modes correctly', () => {
      expect(tonemapFromF32(2)).toBe('linear');
      expect(tonemapFromF32(3)).toBe('cineon');
      expect(tonemapFromF32(4)).toBe('aces-filmic');
      expect(tonemapFromF32(5)).toBe('agx');
      expect(tonemapFromF32(6)).toBe('neutral');
      expect(TONEMAP_REINHARD).toBe(7);
      expect(tonemapFromF32(TONEMAP_REINHARD)).toBe('reinhard');
    });

    it('tonemapFromF32 falls back to "none" for out-of-range numeric (defensive)', () => {
      expect(tonemapFromF32(-1)).toBe('none');
      expect(tonemapFromF32(8)).toBe('none');
      expect(tonemapFromF32(NaN)).toBe('none');
    });
  });

  describe('Camera 7-field perspective + opt-in tonemap spawn (AC-01 runtime)', () => {
    it('spawn with tonemap "reinhard-extended" path keeps numeric encoding 1', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 16 / 9,
            near: 0.1,
            far: 100,
            tonemap: TONEMAP_REINHARD_EXTENDED,
            exposure: 1.0,
            whitePoint: 4.0,
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();
      expect(row.tonemap).toBe(TONEMAP_REINHARD_EXTENDED);
      expect(row.exposure).toBeCloseTo(1.0, 6);
      expect(row.whitePoint).toBeCloseTo(4.0, 6);
      // Layer-2: ortho quartet still defaulted.
      expect(row.left).toBe(-1);
      expect(row.right).toBe(1);
    });

    it('explicit non-default exposure + whitePoint pass through layer-1 wins', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 16 / 9,
            near: 0.1,
            far: 100,
            tonemap: TONEMAP_REINHARD_EXTENDED,
            exposure: 2.5,
            whitePoint: 8.0,
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();
      expect(row.exposure).toBeCloseTo(2.5, 6);
      expect(row.whitePoint).toBeCloseTo(8.0, 6);
    });
  });

  // M2 / w9: Camera.perspective / Camera.orthographic static factory tests
  // (feat-20260525-boilerplate-reduction-pod-defaults-factories)
  //
  // Covers AC-05 + AC-06 (perspective + orthographic returns with defaults).
  // Plan-strategy section 5.2 unit-test requirement + section 5.3 testing points.
  describe('perspective factory', () => {
    it('perspective({ fov: 60, aspect: 4/3 }) returns POD with projection=0, near=0.1, far=2000', () => {
      const pod = perspective({ fov: 60, aspect: 4 / 3 });
      expect(pod.fov).toBe(60);
      expect(pod.aspect).toBeCloseTo(4 / 3, 6);
      expect(pod.near).toBeCloseTo(0.1, 6);
      expect(pod.far).toBe(2000);
      expect(pod.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      expect(pod.left).toBe(-1);
      expect(pod.right).toBe(1);
      expect(pod.bottom).toBe(-1);
      expect(pod.top).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
    });

    it('perspective({ fov: 45, aspect: 16/9, near: 0.01, far: 1000 }) returns explicit overrides', () => {
      const pod = perspective({ fov: 45, aspect: 16 / 9, near: 0.01, far: 1000 });
      expect(pod.fov).toBe(45);
      expect(pod.aspect).toBeCloseTo(16 / 9, 6);
      expect(pod.near).toBeCloseTo(0.01, 6);
      expect(pod.far).toBe(1000);
      expect(pod.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      // Ortho quartet + tonemap get defaults.
      expect(pod.left).toBe(-1);
      expect(pod.right).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
    });

    it('perspective return value has all 32 factory Camera fields', () => {
      const pod = perspective({ fov: 60, aspect: 4 / 3 });
      const keys = Object.keys(pod).sort();
      expect(keys).toEqual([
        'antialias',
        'aspect',
        'autoAspect',
        'bloom',
        'bloomIntensity',
        'bloomRadius',
        'bloomSmoothWidth',
        'bloomThreshold',
        'bottom',
        'clearColor',
        'colorLut',
        'colorLutStrength',
        'compensationEv',
        'exposure',
        'exposureMode',
        'far',
        'fov',
        'historyVersion',
        'left',
        'near',
        'projection',
        'projectionOffset',
        'rangeEv',
        'rates',
        'right',
        'targetLayer',
        'temperature',
        'tint',
        'tonemap',
        'top',
        'transparency',
        'whitePoint',
      ]);
    });
  });

  describe('orthographic factory', () => {
    it('orthographic({ left: -10, right: 10, bottom: -10, top: 10 }) returns POD with projection=1, near=0.1, far=2000', () => {
      const pod = orthographic({ left: -10, right: 10, bottom: -10, top: 10 });
      expect(pod.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(pod.left).toBe(-10);
      expect(pod.right).toBe(10);
      expect(pod.bottom).toBe(-10);
      expect(pod.top).toBe(10);
      expect(pod.near).toBeCloseTo(0.1, 6);
      expect(pod.far).toBe(2000);
      // Perspective fields get sensible defaults (fov=0, aspect=1 for ortho).
      expect(pod.fov).toBe(0);
      expect(pod.aspect).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
    });

    it('orthographic({ left: 0, right: 800, bottom: 600, top: 0, near: -1, far: 1 }) returns explicit overrides', () => {
      const pod = orthographic({
        left: 0,
        right: 800,
        bottom: 600,
        top: 0,
        near: -1,
        far: 1,
      });
      expect(pod.left).toBe(0);
      expect(pod.right).toBe(800);
      expect(pod.bottom).toBe(600);
      expect(pod.top).toBe(0);
      expect(pod.near).toBe(-1);
      expect(pod.far).toBe(1);
      expect(pod.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
    });
  });
}

{
  // --- from layer.test.ts ---
  // feat-20260525-boilerplate-reduction-pod-defaults-factories / M1 / w3b.
  //
  // Layer defaults fill regression barrier (AC-04 sweep table #14).
  // Three concerns:
  //
  //   (a) `componentDefinition(Layer).defaults` is a frozen map asserting `{ value: 0 }`
  //       (default game layer, charter P1 progressive disclosure).
  //
  //   (b) `world.spawn({ component: Layer, data: {} })` yields `value === 0`
  //       (the default game layer convention).
  //
  //   (c) `world.spawn` with an explicit `value: 100` preserves the explicit
  //       value -- layer-2 defaults do NOT overwrite layer-1 explicit input.
  //
  // Anchors: requirements AC-04 (sweep table #14 Layer defaults-added);
  // plan-strategy section 2 sweep pre-judgment table.

  describe('componentDefinition(Layer).defaults -- frozen map assertion (AC-04 #14)', () => {
    it('componentDefinition(Layer).defaults equals { value: 0 }', () => {
      expect(componentDefinition(Layer).defaults).toEqual({ value: 0 });
    });

    it('componentDefinition(Layer).defaults is deep-frozen (Object.isFrozen returns true)', () => {
      expect(componentDefinition(Layer).defaults).toBeDefined();
      expect(Object.isFrozen(componentDefinition(Layer).defaults as object)).toBe(true);
    });
  });

  describe('Layer spawn with data: {} -- default game layer (AC-04)', () => {
    it('spawn Layer with data: {} yields value === 0', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: {} }).unwrap();
      const row = world.get(e, Layer).unwrap();

      expect(row.value).toBe(0);
    });
  });

  describe('Layer spawn with explicit value -- layer-1 wins (AC-04)', () => {
    it('spawn Layer with explicit value: 100 preserves the explicit value', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: 100 } }).unwrap();
      const row = world.get(e, Layer).unwrap();

      expect(row.value).toBe(100);
    });
  });
}

{
  // --- from mesh-renderer.test.ts ---
  // feat-20260608-mesh-multi-section-primitive-multi-material-slot M2 / w8.
  //
  // MeshRenderer schema migration barrier: material field removed, materials
  // array added.
  //
  //   (a) `componentDefinition(MeshRenderer).defaults` is a frozen map asserting
  //       `{ materials: [], lightingChannels: 0xffffffff, preparePipelines: false }` (empty array routes to D-Q7 case B default
  //       material path).
  //
  //   (b) `world.spawn({ component: MeshRenderer, data: {} })` produces a row
  //       with `materials === []` (the D-Q7 case B path, mid-grey default).
  //
  //   (c) `world.spawn` with an explicit materials array round-trips: write
  //       and read-back the materials array.
  //
  //   (d) `world.spawn` with the old `material` field (singular) is a TS
  //       compile-time error (verified via test-d.ts).

  describe('componentDefinition(MeshRenderer).defaults — frozen map assertion (w8)', () => {
    it('componentDefinition(MeshRenderer).defaults retains material, lighting and preparation defaults', () => {
      expect(componentDefinition(MeshRenderer).defaults).toEqual({
        materials: [],
        lightingChannels: 0xffffffff,
        preparePipelines: false,
      });
    });

    it('componentDefinition(MeshRenderer).defaults is deep-frozen (Object.isFrozen returns true)', () => {
      expect(componentDefinition(MeshRenderer).defaults).toBeDefined();
      expect(Object.isFrozen(componentDefinition(MeshRenderer).defaults as object)).toBe(true);
    });
  });

  describe('MeshRenderer spawn with data: {} — D-Q7 case B path (w8)', () => {
    it('spawn MeshRenderer with data: {} produces materials column === empty Uint32Array', () => {
      const world = new World();
      const e = world.spawn({ component: MeshRenderer, data: {} }).unwrap();
      const row = world.get(e, MeshRenderer).unwrap();

      // materials column defaults to empty array for D-Q7 case B;
      // runtime type is Uint32Array (handles stored as u32).
      expect(row.materials).toBeInstanceOf(Uint32Array);
      expect((row.materials as unknown as Uint32Array).length).toBe(0);
    });
  });

  describe('MeshRenderer spawn with explicit materials array — round-trip (w8)', () => {
    it('spawn with explicit materials array preserves the handle values as Uint32Array', () => {
      const world = new World();

      const matHandle = testAssets(world)
        .create({
          kind: 'material',
          values: { baseColor: [1, 0, 0, 1] },
          passes: [{ name: 'forward', program: { module: 'project::standard' } }],
        })
        .unwrap();

      expect(matHandle).toBeGreaterThan(0);

      const e = world.spawn({ component: MeshRenderer, data: { materials: [matHandle] } }).unwrap();
      const row = world.get(e, MeshRenderer).unwrap();

      // Runtime: Uint32Array with the handle value
      expect(row.materials).toBeInstanceOf(Uint32Array);
      expect((row.materials as unknown as Uint32Array)[0]).toBe(matHandle);
    });

    it('spawn with multiple materials round-trips Uint32Array', () => {
      const world = new World();

      const m0 = testAssets(world)
        .create(Materials.unlit([1, 0, 0, 1]))
        .unwrap();
      const m1 = testAssets(world)
        .create(Materials.unlit([0, 1, 0, 1]))
        .unwrap();

      const e = world.spawn({ component: MeshRenderer, data: { materials: [m0, m1] } }).unwrap();
      const row = world.get(e, MeshRenderer).unwrap();

      expect(row.materials).toBeInstanceOf(Uint32Array);
      expect((row.materials as unknown as Uint32Array).length).toBe(2);
      expect((row.materials as unknown as Uint32Array)[0]).toBe(m0);
      expect((row.materials as unknown as Uint32Array)[1]).toBe(m1);
    });
  });
}

{
  // --- from skybox-background.test.ts ---
  // feat-20260531-skybox-env-background / M1 / w2.
  //
  // SkyboxBackground component unit tests (TDD red phase -- the component
  // source file does not exist yet; this test will turn green after w1
  // creates skybox-background.ts, barrel, and top-level re-export).
  //
  // Covers:
  //   (a) Spawning an entity with SkyboxBackground can be queried via
  //       world.query row iteration (AC-01).
  //   (b) skyboxModeFromF32(0) returns 'cubemap' with TS narrow type
  //       (no `as` cast, AC-01).
  //   (c) SKYBOX_MODE_CUBEMAP === 0 invariant (non-zero sentinel guard,
  //       AC-01).
  //   (d) defaults: { mode: SKYBOX_MODE_CUBEMAP } takes effect -- spawn
  //       without `mode` yields mode === 0 (AC-01).
  //   (e) The mapper function uses exhaustive switch (no `default` branch,
  //       AC-02).
  //
  // Anchors: requirements AC-01 / AC-02; plan-strategy D-5 (f32 enum
  // column + mapper); research Finding 6 (camera.ts:51,105,145,221-237
  // cameraProjectionFromF32 pattern); plan-tasks.json w2 acceptanceCheck.

  describe('SkyboxBackground — component schema (AC-01)', () => {
    it('SKYBOX_MODE_CUBEMAP equals 0 (non-zero guard)', () => {
      expect(SKYBOX_MODE_CUBEMAP).toBe(0);
    });

    it('SkyboxBackground is a defineComponent token', () => {
      expect(SkyboxBackground).toBeDefined();
      expect(typeof SkyboxBackground.name).toBe('string');
    });

    it('defaults: { mode: SKYBOX_MODE_CUBEMAP } yields mode===0 on spawn without mode', () => {
      const world = new World();
      const handle = testAssets(world)
        .create({
          kind: 'equirect',
          width: 2,
          height: 1,
          format: 'rgba16float',
          data: new Uint8Array(16),
          colorSpace: 'linear',
        })
        .unwrap();
      const e = world
        .spawn({
          component: SkyboxBackground,
          data: {
            equirect: handle,
          },
        })
        .unwrap();
      const row = world.get(e, SkyboxBackground).unwrap();
      expect(row.mode).toBe(SKYBOX_MODE_CUBEMAP);
    });

    it('entity with SkyboxBackground is hit by a single-component query', () => {
      const world = new World();
      const handle = testAssets(world)
        .create({
          kind: 'equirect',
          width: 2,
          height: 1,
          format: 'rgba16float',
          data: new Uint8Array(16),
          colorSpace: 'linear',
        })
        .unwrap();
      world
        .spawn({
          component: SkyboxBackground,
          data: {
            equirect: handle,
            mode: SKYBOX_MODE_CUBEMAP,
          },
        })
        .unwrap();

      const query = world.query({ with: [SkyboxBackground] }).unwrap();
      expect([...query].length).toBe(1);
    });

    it('world.get returns the equirect handle (u32-stored)', () => {
      const world = new World();
      const handle = testAssets(world)
        .create({
          kind: 'equirect',
          width: 2,
          height: 1,
          format: 'rgba16float',
          data: new Uint8Array(16),
          colorSpace: 'linear',
        })
        .unwrap();
      const e = world
        .spawn({
          component: SkyboxBackground,
          data: { equirect: handle, mode: 0 },
        })
        .unwrap();
      const row = world.get(e, SkyboxBackground).unwrap();
      expect(row.equirect).toBe(handle);
    });
  });

  describe('skyboxModeFromF32 — mapper (AC-01 / AC-02)', () => {
    it('skyboxModeFromF32(0) returns "cubemap" (string literal, not widened to string)', () => {
      const result = skyboxModeFromF32(0);
      expect(result).toBe('cubemap');
      // TS narrow: type is literal 'cubemap', not widened `string`.
      expectTypeOf(result).toEqualTypeOf<'cubemap'>();
    });

    it('skyboxModeFromF32(unknown) also returns "cubemap" (only mode exists)', () => {
      // Currently only one mode exists; any value maps to 'cubemap'.
      const result = skyboxModeFromF32(99);
      expect(result).toBe('cubemap');
      expectTypeOf(result).toEqualTypeOf<'cubemap'>();
    });

    it('switch on SkyboxMode is exhaustive (no `as` cast in test)', () => {
      // This demonstrates that the consumer-side switch on SkyboxMode is
      // exhaustive -- when a future mode is added, TS will catch the missing
      // branch at compile time.
      const mode: SkyboxMode = skyboxModeFromF32(0);
      let hit = false;
      switch (mode) {
        case 'cubemap':
          hit = true;
          break;
        // No `default` branch -- TS enforces exhaustiveness when new
        // members are added to SkyboxMode.
      }
      expect(hit).toBe(true);
    });
  });
}

{
  // --- from sort-key.test.ts ---
  // feat-20260525-boilerplate-reduction-pod-defaults-factories / M1 / w3c.
  //
  // SortKey defaults fill regression barrier (AC-04 sweep table #15).
  // Three concerns:
  //
  //   (a) `componentDefinition(SortKey).defaults` is a frozen map asserting `{ value: 0 }`
  //       (value 0 means 'no override, use mode formula' per transparent-sort
  //       algorithm semantics, charter P1 progressive disclosure).
  //
  //   (b) `world.spawn({ component: SortKey, data: {} })` yields `value === 0`
  //       (the 'no override' sentinel).
  //
  //   (c) `world.spawn` with an explicit `value: -100` preserves the explicit
  //       value -- layer-2 defaults do NOT overwrite layer-1 explicit input.
  //
  // Anchors: requirements AC-04 (sweep table #15 SortKey defaults-added);
  // plan-strategy section 2 sweep pre-judgment table.

  describe('componentDefinition(SortKey).defaults -- frozen map assertion (AC-04 #15)', () => {
    it('componentDefinition(SortKey).defaults equals { value: 0 }', () => {
      expect(componentDefinition(SortKey).defaults).toEqual({ value: 0 });
    });

    it('componentDefinition(SortKey).defaults is deep-frozen (Object.isFrozen returns true)', () => {
      expect(componentDefinition(SortKey).defaults).toBeDefined();
      expect(Object.isFrozen(componentDefinition(SortKey).defaults as object)).toBe(true);
    });
  });

  describe('SortKey spawn with data: {} -- no-override sentinel (AC-04)', () => {
    it('spawn SortKey with data: {} yields value === 0', () => {
      const world = new World();
      const e = world.spawn({ component: SortKey, data: {} }).unwrap();
      const row = world.get(e, SortKey).unwrap();

      expect(row.value).toBe(0);
    });
  });

  describe('SortKey spawn with explicit value -- layer-1 wins (AC-04)', () => {
    it('spawn SortKey with explicit value: -100 preserves the explicit value', () => {
      const world = new World();
      const e = world.spawn({ component: SortKey, data: { value: -100 } }).unwrap();
      const row = world.get(e, SortKey).unwrap();

      expect(row.value).toBe(-100);
    });
  });
}

{
  // --- from sprite-components-schema.test.ts ---
  // feat-20260521-sprite-atlas-animation / M2 / T-10.
  //
  // TDD red phase: this runtime suite exercises `world.spawn` + `world.get`
  // round-trips for the two new sprite-only ECS components — both of which
  // land in T-11 (SpriteRegionOverride) + T-12 (SpriteAnimation). Before
  // those impl tasks land the imports `../sprite-region-override` /
  // `../sprite-animation` fail to resolve and the suite stays red. After
  // T-11 + T-12 the imports resolve, `defineComponent` accepts the schema
  // keywords (no `SchemaUnsupportedFieldError` / `ManagedArrayElementType-
  // NotAllowedError`), and the spawn / get assertions turn green.
  //
  // Why a runtime test on top of the T-08 / T-09 type-d coverage?
  // Plan-strategy section 4 risk R-SCHEMA-1 + R-SCHEMA-2 explicitly cite the
  // ECS schema whitelist (`SchemaFieldType`) as the structural failure mode:
  // the type-d files prove the literals look right at TS edge, but the
  // runtime `defineComponent` call still has to walk the schema and accept
  // `'array<f32, 4>'` (fixed-length) + `'array<f32>'` (variable) + the
  // scalar `'u32'` / `'f32'` quartet without throwing. T-10 is the
  // behavioural witness for those two risks.
  //
  // Default-value coverage (component-default-fallback layer-3, AC-02 +
  // requirements section 2.3 defaults column):
  //   - `currentFrame: 'u32'`   -> 0   (scalar layer-3 fallback)
  //   - `accumDt: 'f32'`        -> 0   (scalar layer-3 fallback)
  //   - `playbackMode: 'u32'`   -> 0   (= SPRITE_PLAYBACK_MODE_LOOP, the
  //                                     default playbackMode per AC-02 +
  //                                     requirements section 2.3 footnote
  //                                     "default 'loop'")
  // The spawn payload thus only needs to carry frameCount / frameDuration /
  // regions for an entity to be observable; AI users get a meaningful
  // 4-step minimal walk-cycle by passing one Float32Array of length
  // frameCount * 4.
  //
  // Anchors: plan-tasks.json T-10 (acceptanceCheck: T-11 + T-12 land then
  // region round-trip + 6-field default-value + length round-trip + no
  // SchemaUnsupportedFieldError); plan-strategy section 4 R-SCHEMA-1 + R-
  // SCHEMA-2 reaction; research F-5; requirements section AC-01 + AC-02 +
  // section 2.3 (defaults column) + section 2.4; charter F1 + P3.

  describe('SpriteRegionOverride — defineComponent does not throw (R-SCHEMA-2)', () => {
    it("name + schema lock match the M2 D-6 contract (region: 'array<f32, 4>')", () => {
      expect(SpriteRegionOverride.name).toBe('SpriteRegionOverride');
      expect(Object.keys(componentSchema(SpriteRegionOverride)).length).toBe(1);
      expect((componentSchema(SpriteRegionOverride) as Record<string, unknown>).region).toBe(
        'array<f32, 4>',
      );
    });
  });

  describe('SpriteRegionOverride — spawn + get round-trip (AC-01 + AC-03 producer)', () => {
    it('region [0.5, 0, 0.5, 1] round-trips byte-for-byte', () => {
      const world = new World();
      const region = new Float32Array([0.5, 0, 0.5, 1]);
      const e = world.spawn({ component: SpriteRegionOverride, data: { region } }).unwrap();
      const snap = world.get(e, SpriteRegionOverride).unwrap();
      expect(snap.region).toBeInstanceOf(Float32Array);
      expect(snap.region.length).toBe(4);
      expect(snap.region[0]).toBeCloseTo(0.5, 6);
      expect(snap.region[1]).toBeCloseTo(0, 6);
      expect(snap.region[2]).toBeCloseTo(0.5, 6);
      expect(snap.region[3]).toBeCloseTo(1, 6);
    });

    it('region overwrite via world.set updates the snapshot', () => {
      const world = new World();
      const e = world
        .spawn({
          component: SpriteRegionOverride,
          data: { region: new Float32Array([0, 0, 1, 1]) },
        })
        .unwrap();

      world
        .set(e, SpriteRegionOverride, { region: new Float32Array([0.25, 0.25, 0.5, 0.5]) })
        .unwrap();

      const snap = world.get(e, SpriteRegionOverride).unwrap();
      expect(snap.region.length).toBe(4);
      expect(snap.region[0]).toBeCloseTo(0.25, 6);
      expect(snap.region[2]).toBeCloseTo(0.5, 6);
    });
  });

  describe('SpriteAnimation — defineComponent does not throw (R-SCHEMA-1)', () => {
    it('name + schema lock match the M2 D-5 + D-6 contract (6 fields)', () => {
      expect(SpriteAnimation.name).toBe('SpriteAnimation');

      const schema = componentSchema(SpriteAnimation) as Record<string, unknown>;
      expect(Object.keys(schema).length).toBe(6);
      expect(schema.frameCount).toBe('u32');
      expect(schema.frameDuration).toBe('f32');
      expect(schema.currentFrame).toBe('u32');
      expect(schema.accumDt).toBe('f32');
      expect(schema.regions).toBe('array<f32>');
      expect(schema.playbackMode).toBe('u32');
    });
  });

  describe('SpriteAnimation — spawn + get round-trip (AC-02 + section 2.3)', () => {
    it('4-frame walk cycle round-trips through ECS columns', () => {
      const world = new World();
      const frameCount = 4;
      const regions = new Float32Array(frameCount * 4);
      for (let i = 0; i < frameCount; i++) {
        regions[i * 4 + 0] = i * 0.25;
        regions[i * 4 + 1] = 0;
        regions[i * 4 + 2] = 0.25;
        regions[i * 4 + 3] = 1;
      }
      const e = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();
      const snap = world.get(e, SpriteAnimation).unwrap();
      expect(snap.frameCount).toBe(frameCount);
      expect(snap.frameDuration).toBeCloseTo(0.1, 6);
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
      expect(snap.regions).toBeInstanceOf(Float32Array);
      expect(snap.regions.length).toBe(frameCount * 4);
      expect(snap.regions[2 * 4 + 0]).toBeCloseTo(0.5, 6);
      expect(snap.playbackMode).toBe(SPRITE_PLAYBACK_MODE_LOOP);
    });

    it('clamp playback mode encodes as numeric 1 in the column', () => {
      const world = new World();
      const e = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 3,
            frameDuration: 0.1,
            regions: new Float32Array(3 * 4),
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();
      const snap = world.get(e, SpriteAnimation).unwrap();
      expect(snap.playbackMode).toBe(1);
      expect(snap.playbackMode).toBe(SPRITE_PLAYBACK_MODE_CLAMP);
    });

    it('layer-3 defaults fill currentFrame=0 / accumDt=0 / playbackMode=0 when omitted', () => {
      const world = new World();
      const e = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 2,
            frameDuration: 0.05,
            regions: new Float32Array([0, 0, 0.5, 1, 0.5, 0, 0.5, 1]),
          },
        })
        .unwrap();
      const snap = world.get(e, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
      expect(snap.playbackMode).toBe(SPRITE_PLAYBACK_MODE_LOOP);
      expect(snap.regions.length).toBe(2 * 4);
    });

    it('variable regions length round-trip — frameCount * 4 invariant is data not schema', () => {
      // Schema does not constrain regions.length; the M4 sprite-animation-tick
      // system enforces `regions.length === frameCount * 4` at first
      // observation (D-1 fail-fast path). This test only locks the bytes
      // round-trip — feeding 12 floats with frameCount === 3 returns 12 floats.
      const world = new World();
      const regions = new Float32Array([0, 0, 0.33, 1, 0.33, 0, 0.33, 1, 0.66, 0, 0.34, 1]);
      const e = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 3,
            frameDuration: 0.2,
            regions,
          },
        })
        .unwrap();
      const snap = world.get(e, SpriteAnimation).unwrap();
      expect(snap.regions.length).toBe(12);
      expect(snap.regions[4]).toBeCloseTo(0.33, 6);
    });
  });
}

{
  // --- from sprite-playback-mode.test.ts ---
  // feat-20260521-sprite-atlas-animation / M1 / T-06.
  //
  // TDD red phase: packages/runtime/src/components/sprite-playback-mode.ts
  // does not yet exist — these constant + mapper assertions stay red until
  // T-07 lands the SSOT (plan-strategy section 2 D-5 / requirements
  // section AC-02 + section 2.3).
  //
  // The shape mirrors `packages/render/src/components/camera.ts:72-90`
  // Tonemap block (TONEMAP_NONE = 0 / TONEMAP_REINHARD_EXTENDED = 1 +
  // `type Tonemap = 'none' | 'reinhard-extended'` + `tonemapFromF32`)
  // because ECS schema whitelist SchemaFieldType does not accept string-
  // literal unions for `playbackMode` (research F-2 + F-5). The mapper
  // pattern lets the ECS column stay `'u32'` while AI users still consume
  // `'loop' | 'clamp'` literal-union narrowing in TS land.
  //
  // Anchors: plan-strategy section 2 D-5 + section 3.1 PR block SPM (sprite-
  //          playback-mode) + section 4 risk R-SCHEMA-1 reaction; research
  //          F-2 + F-5; requirements section AC-02 + section 2.3 playbackMode
  //          row; charter P4 consistent abstraction (same shape as M1
  //          tonemap-encoding so AI users keep one mental model).

  describe('sprite-playback-mode SSOT — constants', () => {
    it('SPRITE_PLAYBACK_MODE_LOOP === 0 (u32 column encoding)', () => {
      expect(SPRITE_PLAYBACK_MODE_LOOP).toBe(0);
    });

    it('SPRITE_PLAYBACK_MODE_CLAMP === 1 (u32 column encoding)', () => {
      expect(SPRITE_PLAYBACK_MODE_CLAMP).toBe(1);
    });

    it('constants are typed as numeric literals (not widened to number)', () => {
      expectTypeOf(SPRITE_PLAYBACK_MODE_LOOP).toEqualTypeOf<0>();
      expectTypeOf(SPRITE_PLAYBACK_MODE_CLAMP).toEqualTypeOf<1>();
    });
  });

  describe('sprite-playback-mode SSOT — SpritePlaybackMode type', () => {
    it("SpritePlaybackMode is exactly 'loop' | 'clamp'", () => {
      expectTypeOf<SpritePlaybackMode>().toEqualTypeOf<'loop' | 'clamp'>();
    });

    it("'loop' is assignable to SpritePlaybackMode", () => {
      const mode: SpritePlaybackMode = 'loop';
      expect(mode).toBe('loop');
    });

    it("'clamp' is assignable to SpritePlaybackMode", () => {
      const mode: SpritePlaybackMode = 'clamp';
      expect(mode).toBe('clamp');
    });
  });

  describe('spritePlaybackModeFromU32 — u32 to string-literal translator', () => {
    it('spritePlaybackModeFromU32(0) === "loop"', () => {
      expect(spritePlaybackModeFromU32(0)).toBe('loop');
    });

    it('spritePlaybackModeFromU32(1) === "clamp"', () => {
      expect(spritePlaybackModeFromU32(1)).toBe('clamp');
    });

    it('out-of-range numerics fall back to "loop" (charter P4 no silent exception)', () => {
      // Mirror cameraProjectionFromF32 / tonemapFromF32: defensive default
      // for uninitialised / stale numeric values. The schema layer already
      // guarantees the column carries a u32, but AI users may pass through a
      // hand-set numeric that escapes the [0, 1] range.
      expect(spritePlaybackModeFromU32(2)).toBe('loop');
      expect(spritePlaybackModeFromU32(-1)).toBe('loop');
      expect(spritePlaybackModeFromU32(NaN)).toBe('loop');
    });

    it('return type narrows to SpritePlaybackMode (string-literal union)', () => {
      expectTypeOf(spritePlaybackModeFromU32(0)).toEqualTypeOf<SpritePlaybackMode>();
    });

    it('round-trip: SPRITE_PLAYBACK_MODE_LOOP -> "loop" / SPRITE_PLAYBACK_MODE_CLAMP -> "clamp"', () => {
      expect(spritePlaybackModeFromU32(SPRITE_PLAYBACK_MODE_LOOP)).toBe('loop');
      expect(spritePlaybackModeFromU32(SPRITE_PLAYBACK_MODE_CLAMP)).toBe('clamp');
    });
  });
}

{
  // --- from transform.test.ts ---
  // feat-20260525-boilerplate-reduction-pod-defaults-factories / M1 / w1.
  //
  // Transform defaults fill regression barrier (AC-02 + AC-03). Three
  // concerns:
  //
  //   (a) `world.spawn({ component: Transform, data: {} })` returns identity
  //       transform (pos/quat/scale all identity values), verifying that the
  //       layer-2 defaults map fills every schema field.
  //
  //   (b) `world.spawn({ component: Transform, data: { pos: [0, 0, 2] } })`
  //       returns pos=[0,0,2] with remaining fields at identity defaults,
  //       verifying that layer-1 explicit values take priority over layer-2
  //       defaults.
  //
  //   (c) `world.set` partial patch on Transform does not affect unfilled
  //       columns, verifying the column-wise set semantics.
  //
  // Anchors: requirements AC-02 / AC-03; plan-strategy section 5.1 TDD
  // red-green-refactor + section 5.2 unit test requirements.

  describe('Transform defaults fill — identity spawn (AC-02)', () => {
    it('world.spawn({ component: Transform, data: {} }) returns identity transform', () => {
      const world = new World();
      const e = world.spawn({ component: Transform, data: {} }).unwrap();
      const row = world.get(e, Transform).unwrap();

      expect(Array.from(row.pos)).toEqual([0, 0, 0]);
      expect(Array.from(row.quat)).toEqual([0, 0, 0, 1]);
      expect(Array.from(row.scale)).toEqual([1, 1, 1]);
    });
  });

  describe('Transform partial override — layer-1 wins over layer-2 defaults (AC-03)', () => {
    it('world.spawn with only pos=[0,0,2] yields identity on all other fields', () => {
      const world = new World();
      const e = world.spawn({ component: Transform, data: { pos: [0, 0, 2] } }).unwrap();
      const row = world.get(e, Transform).unwrap();

      expect(Array.from(row.pos)).toEqual([0, 0, 2]);
      expect(Array.from(row.quat)).toEqual([0, 0, 0, 1]);
      expect(Array.from(row.scale)).toEqual([1, 1, 1]);
    });
  });

  describe('Transform new schema — local pos/quat/scale array cols + world array<f32,16> (AC-01)', () => {
    it('spawn data:{} yields identity local TRS + identity world mat4 (16 contiguous f32)', () => {
      const world = new World();
      const e = world.spawn({ component: Transform, data: {} }).unwrap();
      const row = world.get(e, Transform).unwrap();
      const global = world.get(e, GlobalTransform).unwrap();

      // local pos/quat/scale inline array columns at identity.
      expect(Array.from(row.pos)).toEqual([0, 0, 0]);
      expect(Array.from(row.quat)).toEqual([0, 0, 0, 1]);
      expect(Array.from(row.scale)).toEqual([1, 1, 1]);

      // world array<f32,16> resolves to a Float32Array view of 16 contiguous
      // floats. Default fill is the identity mat4 (column-major).
      const w = global.world as Float32Array;
      expect(w).toBeInstanceOf(Float32Array);
      expect(w.length).toBe(16);
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      for (let i = 0; i < 16; i++) {
        expect(w[i]).toBeCloseTo(identity[i] as number, 5);
      }
    });
  });

  describe('Transform world.set — partial patch does not affect unfilled columns', () => {
    it('world.set partial patch on Transform leaves unreferenced columns unchanged', () => {
      const world = new World();
      const e = world.spawn({ component: Transform, data: { pos: [5, 3, 10] } }).unwrap();

      // Partial set: only the pos column (the patch unit is the whole inline
      // array field; quat/scale columns are not referenced).
      world.set(e, Transform, { pos: [25, 3, 10] }).unwrap();

      const after = world.get(e, Transform).unwrap();
      expect(Array.from(after.pos)).toEqual([25, 3, 10]);
      // Identity defaults still in place for unset columns.
      expect(Array.from(after.quat)).toEqual([0, 0, 0, 1]);
      expect(Array.from(after.scale)).toEqual([1, 1, 1]);
    });
  });
}

{
  // --- from mesh-renderer-multi-material.test.ts ---
  // mesh-renderer-multi-material.test.ts — unit tests for render-system-extract
  // count-mismatch validation (feat-20260608-mesh-multi-section-primitive-multi-material-slot
  // M2 / w12).
  //
  // Anchors: requirements AC-05 (a); plan-strategy §2 D-3 (read-side interception);
  // plan-strategy §5.3 key test points "AC-03/AC-05 three triggers".

  describe('render-system-extract count-mismatch (w12, AC-05 a)', () => {
    it('single mesh single material: extract succeeds', () => {
      const world = new World();
      const assets = testAssets(world);

      const matHandle = testAssets(world)
        .create({
          kind: 'material',
          values: { baseColor: [1, 0, 0, 1] },
          passes: [{ name: 'forward', program: { module: 'project::standard' } }],
        })
        .unwrap();

      const meshHandle = testAssets(world)
        .create({
          kind: 'mesh',
          vertices: new Float32Array(4 * 3),
          indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
          attributes: { position: new Float32Array(4 * 3) },
          materialSlots: [{ slotName: 'Default' }],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 6,
              vertexCount: 4,
              materialSlot: 0,
              topology: 'triangle-list' as const,
            },
          ],
        })
        .unwrap();

      world.spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      );

      // Extract should not crash; count matches (1 submesh, 1 material).
      // The renderable may be empty (material resolves to 0 passes with mock
      // ShaderRegistry) but the key assertion: no crash and count-mismatch
      // error is NOT triggered.
      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      expect(frame.renderables).toBeDefined();
    });

    it('materials: [] with submeshes: [1] routes through D-Q7 case B mid-grey default (preserves legacy single-mesh-no-material path)', () => {
      const world = new World();

      const assets = testAssets(world);

      const meshHandle = testAssets(world)
        .create({
          kind: 'mesh',
          vertices: new Float32Array(4 * 3),
          indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
          attributes: { position: new Float32Array(4 * 3) },
          materialSlots: [{ slotName: 'Default' }],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 6,
              vertexCount: 4,
              materialSlot: 0,
              topology: 'triangle-list' as const,
            },
          ],
        })
        .unwrap();

      world.spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      );

      // materials.length=0 routes through D-Q7 case B (defaultMaterialSnapshot
      // mid-grey unlit) without triggering mesh-renderer-material-count-mismatch
      // -- count-mismatch only applies to non-empty materials whose length
      // disagrees with submeshes.length. Backward-compat preserved for legacy
      // `data: {}` spawn shape (charter P5 consistent abstraction).
      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      expect(frame.renderables.length).toBe(1);
    });

    it('materials overflow emits a diagnostic and ignores the extra override', () => {
      const world = new World();

      const assets = testAssets(world);

      const matHandle = testAssets(world)
        .create({
          kind: 'material',
          values: { baseColor: [1, 0, 0, 1] },
          passes: [{ name: 'forward', program: { module: 'project::standard' } }],
        })
        .unwrap();

      const meshHandle = testAssets(world)
        .create({
          kind: 'mesh',
          vertices: new Float32Array(4 * 3),
          indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
          attributes: { position: new Float32Array(4 * 3) },
          materialSlots: [{ slotName: 'Default' }],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 6,
              vertexCount: 4,
              materialSlot: 0,
              topology: 'triangle-list' as const,
            },
          ],
        })
        .unwrap();

      world.spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [matHandle, matHandle] } },
      );

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      // Owner validation is diagnostic and non-fatal: the malformed extra
      // override is ignored while the valid first material still renders.
      expect(frame.renderables).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // feat-20260709 M3 / w11: Camera clearColor + GlyphText color + Tilemap
  // tileSize vec collapse -- schema shape, explicit layer-2 defaults, and
  // spawn-omit equivalence (AC-01 / E1 / E9). D-5 (non-zero array defaults
  // declared explicitly at layer 2, since the array layer-3 fallback is
  // all-zero).
  // ────────────────────────────────────────────────────────────────────────
  describe('M3 vec-collapse schema + defaults (w11 AC-01 / E1 / E9)', () => {
    it('Camera.clearColor is array<f32,4> with explicit layer-2 default [0,0,0,0]', () => {
      expect(componentSchema(Camera).clearColor).toBe('array<f32, 4>');
      expect(Array.from(Camera.fields.clearColor.default as Float32Array)).toEqual([0, 0, 0, 0]);
    });

    it('GlyphText.color is array<f32,4> with explicit layer-2 default [1,1,1,1]; per-axis scalars gone', () => {
      expect(componentSchema(GlyphText).color).toBe('array<f32, 4>');
      expect('colorR' in componentSchema(GlyphText)).toBe(false);
      expect('colorG' in componentSchema(GlyphText)).toBe(false);
      expect('colorB' in componentSchema(GlyphText)).toBe(false);
      expect('colorA' in componentSchema(GlyphText)).toBe(false);
      expect(Array.from(GlyphText.fields.color.default as Float32Array)).toEqual([1, 1, 1, 1]);
    });

    it('Tilemap.tileSize is array<f32,2> with explicit layer-2 default [1,1]; per-axis scalars gone', () => {
      expect(componentSchema(Tilemap).tileSize).toBe('array<f32, 2>');
      expect('tileSizeX' in componentSchema(Tilemap)).toBe(false);
      expect('tileSizeY' in componentSchema(Tilemap)).toBe(false);
      expect(Array.from(Tilemap.fields.tileSize.default as Float32Array)).toEqual([1, 1]);
    });

    it('E1: Camera spawned with clearColor omitted resolves to [0,0,0,0]', () => {
      const world = new World();
      const e = world
        .spawn({ component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } })
        .unwrap();
      const row = world.get(e, Camera).unwrap();
      expect(Array.from(row.clearColor)).toEqual([0, 0, 0, 0]);
    });

    it('E1: GlyphText spawned with color omitted resolves to [1,1,1,1] (equal to old scalar default)', () => {
      const world = new World();
      const e = world
        .spawn({ component: GlyphText, data: { fontHandle: 0 as never, text: 'x', fontSize: 16 } })
        .unwrap();
      const row = world.get(e, GlyphText).unwrap();
      expect(Array.from(row.color)).toEqual([1, 1, 1, 1]);
    });

    it('E1: Tilemap spawned with tileSize omitted resolves to [1,1] (equal to old scalar default)', () => {
      const world = new World();
      const e = world.spawn({ component: Tilemap, data: { cols: 4, rows: 4 } }).unwrap();
      const row = world.get(e, Tilemap).unwrap();
      expect(Array.from(row.tileSize)).toEqual([1, 1]);
    });

    it('E9: perspective() / orthographic() factories flow the new clearColor array default through cameraPodFromDefaults() (zero signature change)', () => {
      const p = perspective({ fov: Math.PI / 3, aspect: 4 / 3 });
      const o = orthographic({ left: -1, right: 1, bottom: -1, top: 1 });
      // The factory output carries the array-shaped clearColor field verbatim
      // from Camera.fields defaults -- no per-axis scalar keys survive.
      expect(Array.from(p.clearColor)).toEqual([0, 0, 0, 0]);
      expect(Array.from(o.clearColor)).toEqual([0, 0, 0, 0]);
      expect('clearR' in p).toBe(false);
      expect('clearR' in o).toBe(false);
    });

    it('E9: factory spread + clearColor override lands the authored color', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 3, aspect: 4 / 3 }),
            clearColor: [0.4, 0.6, 1, 1],
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();
      expect(Array.from(row.clearColor)).toEqual([Math.fround(0.4), Math.fround(0.6), 1, 1]);
    });
  });
}
