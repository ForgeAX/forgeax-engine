import { createMeshBuilder, createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
} from '@forgeax/engine-pack/material-cook';
import type { AssetHandle } from '@forgeax/engine-types';
import { materialRecordFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { loadMaterialFixture } from '../../../assets-runtime/src/__tests__/fixtures/runtime-material';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { installDefaultAssetDecoders } from '../asset-contributions';
import { testAssets } from './helpers/runtime-assets';
// Consolidated by feat-20260608-ci-time-cut M5 w13/w14: merges
//   - render-system-extract.test.ts
//   - render-system-extract-material-inheritance.test.ts
//   - render-system-extract-sprite-slices.test.ts
//   - render-system-clear-camera.test.ts
// Each original file body sits in its own block-scope so helper names
// cannot collide; describe() inside still registers globally with vitest.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  SpotLight,
} from '@forgeax/engine-render';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialPass, MeshAsset } from '@forgeax/engine-types';
import { srgbChannelToLinear } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame, extractFrames } from '../../../render/src/render-system-extract-tail';
import { PersistentRenderScene } from '../../../render/src/scene/render-scene';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ─── from render-system-extract.test.ts ───
{
  // w9 -- render-system-extract consumer migration unit tests (M3, AC-07 / AC-15).
  //
  // Post-migration extract reads the single resolved `GlobalTransform.world` mat4
  // (written by propagateTransforms) for every world-space consumer; the legacy
  // GlobalTransform-column-switch + per-snapshot `mat4.compose` are gone.
  //
  // Five consumer classes covered:
  //   1. mesh-walk     -> RenderableSnapshot.transform.world is the 16-float
  //      column-major world mat4 (parent x child), copied straight from the
  //      GlobalTransform.world view; no per-snapshot compose.
  //   2. frustum cull  -> the cull AABB follows the world mat4 (a child placed
  //      off-screen by its parent is culled; in-screen is kept) -- same-source
  //      with the rendered world (AC-05 carried forward).
  //   3. camera view   -> CameraSnapshot.position is the world-space translation
  //      (mat4.getTranslation of GlobalTransform.world); a child camera reflects
  //      parent x child.
  //   4. light position -> point / spot light position is the world-space
  //      translation extracted from GlobalTransform.world (mat4.getTranslation).
  //   5. AC-15 zero-materialization -> the mesh-walk reads world through the
  //      column-level array view; it does NOT call `world.get` per renderable
  //      to materialize a `{}` whole-component object.
  //
  // extractFrame + propagateTransforms are pure CPU functions; no GPU is touched.

  function identity() {
    return {
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  const cameraData = {
    fov: 1.0,
    aspect: 1.0,
    near: 0.1,
    far: 100.0,
    projection: 0,
    left: -1,
    right: 1,
    bottom: -1,
    top: 1,
  };

  function perspectiveCameraData() {
    return {
      fov: Math.PI / 4,
      aspect: 1,
      near: 0.1,
      far: 100,
      projection: 0,
      left: -1,
      right: 1,
      bottom: -1,
      top: 1,
    };
  }

  function spawnCamera(world: World): void {
    world
      .spawn({ component: Transform, data: identity() }, { component: Camera, data: cameraData })
      .unwrap();
  }

  function registerMesh(world: World): AssetHandle<'mesh'> {
    return registerMeshWithAabb(world, new Float32Array([-1, -1, -1, 1, 1, 1]));
  }

  function registerMeshWithAabb(world: World, aabb: Float32Array | undefined): AssetHandle<'mesh'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices: positions,
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: positions },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      ...(aabb !== undefined ? { aabb } : {}),

      materialSlots: [{ slotName: 'Default' }],
    };
    return testAssets(world).create(mesh).unwrap();
  }

  function registerMaterial(world: World): AssetHandle<'material'> {
    return testAssets(world)
      .create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-unlit' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColor: [1, 1, 1] },
      })
      .unwrap();
  }

  describe('render-system-extract consumer migration (w9, AC-07 / AC-15)', () => {
    it('reuses one frame-local material snapshot for repeated shared handles', () => {
      const world = new World();
      spawnCamera(world);
      const assets = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerMesh(world);
      const material = registerMaterial(world);

      for (let index = 0; index < 64; index++) {
        world
          .spawn(
            {
              component: Transform,
              data: { ...identity(), pos: [0, 0, -index - 2] },
            },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
      }

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      expect(frame.renderables).toHaveLength(64);
      const first = frame.renderables[0]?.material;
      expect(first).toBeDefined();
      expect(new Set(frame.renderables.map((renderable) => renderable.material)).size).toBe(1);
      for (const renderable of frame.renderables) expect(renderable.material).toBe(first);
    });

    it('projects the cooked Standard artifact identity into extraction and dispatch', async () => {
      const world = new World();
      spawnCamera(world);
      const assets = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerMesh(world);
      const materialGuid = '019ffa97-4000-7000-8000-000000000101';
      const materialContext = {
        backend: 'webgpu' as const,
        capability: 'storage-buffer' as const,
        pipeline: 'forward' as const,
        geometry: 'mesh' as const,
        pass: 'forward' as const,
        profile: 'forgeax-material-wgsl-v1' as const,
        toolchain: 'naga-oil' as const,
        instrumentation: 'none' as const,
      };
      const author = {
        kind: 'material',
        passes: [
          {
            name: 'forward',
            program: {
              module: 'forgeax_material::standard',
              moduleSlots: { surface: 'game_3d::rusted_iron_surface' },
            },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
          {
            name: 'shadow-caster',
            program: {
              module: 'forgeax_material::standard',
              moduleSlots: { surface: 'game_3d::rusted_iron_surface' },
            },
            renderState: { tags: { LightMode: 'ShadowCaster' }, queue: 1000 },
          },
        ],
        parameters: [
          { name: 'baseColor', type: 'color' },
          { name: 'metallic', type: 'f32' },
          { name: 'roughness', type: 'f32' },
        ],
        values: { baseColor: [0.4, 0.45, 0.47, 1], metallic: 0.8, roughness: 0.25 },
      } satisfies MaterialAsset;
      const record = materialRecordFixture({
        guid: materialGuid,
        passes: author.passes,
        parameters: author.parameters,
        values: author.values,
      });
      const programs = author.passes.map((pass) => {
        const bytes = new TextEncoder().encode(`published Standard ${pass.name}`);
        const digest = createMaterialArtifactDigest(bytes);
        return {
          specializationKey: `program/${digest}`,
          artifact: {
            mediaType: 'text/wgsl' as const,
            path: `materials/${digest.slice(7)}.wgsl`,
            digest,
            bytes,
          },
          selections: [
            {
              pass: pass.name,
              context: {
                ...materialContext,
                pass: pass.name === 'shadow-caster' ? ('shadow' as const) : ('forward' as const),
              },
            },
          ],
        };
      });
      const artifactDigest = createMaterialProgramSetDigest(programs, author.passes);
      const material = (
        await loadMaterialFixture(assets, {
          ...record,
          programs,
          artifactDigest,
          receipt: { ...record.receipt, identity: { ...record.receipt.identity, artifactDigest } },
        })
      ).unwrap().handle;
      const cookedShaderId = programs[0]?.specializationKey;
      const cookedShadowShaderId = programs[1]?.specializationKey;
      expect(cookedShaderId).not.toBe(cookedShadowShaderId);
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, -2] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();

      const frame = extractFrame(world, prepareExtractContext(world, { assets, materialContext }));
      expect(frame.renderables[0]?.material.snapshot.materialShaderId).toBe(cookedShaderId);
      const materialDispatch = frame.dispatch.filter((entry) => entry.materialHandle === material);
      expect(materialDispatch).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tags: {
              LightMode: 'Forward',
              SurfaceKind: 'standard',
              SurfaceModule: 'game_3d::rusted_iron_surface',
              GeometryVariant: 'rigid',
            },
            materialShaderId: cookedShaderId,
          }),
          expect.objectContaining({
            tags: { LightMode: 'ShadowCaster' },
            materialShaderId: cookedShadowShaderId,
          }),
        ]),
      );
    });

    it('keeps custom Standard Surface fields in the extracted material ABI', () => {
      const world = new World();
      spawnCamera(world);
      const assets = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerMesh(world);
      const material = testAssets(world)
        .create(
          Materials.standard({
            surfaceModule: 'game_3d::rusted_iron_surface',
            parameters: [
              { name: 'ironColor', type: 'color' },
              { name: 'rustDark', type: 'color' },
              { name: 'rustBright', type: 'color' },
              { name: 'noiseScale', type: 'f32' },
            ],
            values: {
              ironColor: [0.4, 0.45, 0.47, 1],
              rustDark: [0.42, 0.085, 0.018, 1],
              rustBright: [0.95, 0.34, 0.055, 1],
              noiseScale: 1.85,
            },
          }),
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, -2] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      const snapshot = frame.renderables[0]?.material.snapshot;
      const schemaNames = snapshot?.materialParamSchema?.map((entry) => entry.name) ?? [];

      expect(schemaNames).toEqual(
        expect.arrayContaining(['ironColor', 'rustDark', 'rustBright', 'noiseScale']),
      );
      expect(snapshot?.paramSnapshot).toMatchObject({
        ironColor: [0.4, 0.45, 0.47].map(srgbChannelToLinear).concat(1),
        rustDark: [0.42, 0.085, 0.018].map(srgbChannelToLinear).concat(1),
        rustBright: [0.95, 0.34, 0.055].map(srgbChannelToLinear).concat(1),
        noiseScale: 1.85,
      });
    });

    it('mesh-walk: RenderableSnapshot.transform.world is the resolved world mat4 (parent x child), zero per-snapshot compose', () => {
      const world = new World();
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [12, 3, 5] } },
          { component: Camera, data: cameraData },
        )
        .unwrap();
      const parent = world
        .spawn({ component: Transform, data: { ...identity(), pos: [10, 0, 0] } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [2, 3, 0] } },
          { component: ChildOf, data: { parent } },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
            },
          },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.renderables.length).toBe(1);

      const w = frame.renderables[0]?.transform.world;
      expect(w).toBeInstanceOf(Float32Array);
      expect(w?.length).toBe(16);
      // world translation column (col3 = m[12,13,14]) = parent (10,0,0) + child local (2,3,0).
      expect(w?.[12]).toBeCloseTo(12, 5);
      expect(w?.[13]).toBeCloseTo(3, 5);
      expect(w?.[14]).toBeCloseTo(0, 5);
      // The snapshot world must equal the entity's GlobalTransform.world column byte-for-byte.
    });

    it('mesh-walk: unbound MeshFilter shared handle emits no renderable', () => {
      const world = new World();
      spawnCamera(world);
      const entity = world
        .spawn(
          { component: Transform, data: identity() },
          { component: MeshFilter, data: {} },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(0);
      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.renderables).toHaveLength(0);
    });

    it('mesh-walk: flat root world mat4 equals compose(local)', () => {
      const world = new World();
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [5, 6, 12] } },
          { component: Camera, data: cameraData },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [5, 6, 7], scale: [2, 1, 1] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
            },
          },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.renderables.length).toBe(1);
      const w = frame.renderables[0]?.transform.world as Float32Array;
      const expected = mat4.create();
      mat4.compose(expected, vec3.create(5, 6, 7), [0, 0, 0, 1], vec3.create(2, 1, 1));
      for (let i = 0; i < 16; i++) {
        expect(w[i]).toBeCloseTo((expected as unknown as number[])[i] as number, 5);
      }
    });

    it('camera view: child camera position reflects world translation (parent x child)', () => {
      const world = new World();
      const rig = world
        .spawn({ component: Transform, data: { ...identity(), pos: [0, 5, 0] } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [1, 0, 2] } },
          { component: ChildOf, data: { parent: rig } },
          { component: Camera, data: cameraData },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.cameras.length).toBe(1);
      const pos = frame.cameras[0]?.position;
      // rig (0,5,0) x camera local (1,0,2) -> world (1,5,2).
      expect(pos?.[0]).toBeCloseTo(1, 5);
      expect(pos?.[1]).toBeCloseTo(5, 5);
      expect(pos?.[2]).toBeCloseTo(2, 5);
    });

    it('light position: child point + spot light position reflects world translation', () => {
      const world = new World();
      const rig = world
        .spawn({ component: Transform, data: { ...identity(), pos: [0, 0, 7] } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [3, 0, 0] } },
          { component: ChildOf, data: { parent: rig } },
          { component: PointLight, data: { intensity: 1 } },
        )
        .unwrap();
      const spotRig = world
        .spawn({ component: Transform, data: { ...identity(), pos: [0, 4, 0] } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: identity() },
          { component: ChildOf, data: { parent: spotRig } },
          {
            component: SpotLight,
            data: { castShadow: true, direction: [0, -1, 0], intensity: 1 },
          },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.point.length).toBe(1);
      expect(frame.lights.point[0]?.position?.[0]).toBeCloseTo(3, 5);
      expect(frame.lights.point[0]?.position?.[2]).toBeCloseTo(7, 5);
      expect(frame.lights.spot.length).toBe(1);
      expect(frame.lights.spot[0]?.position?.[1]).toBeCloseTo(4, 5);
      // D-6 carried forward: spot direction stays from the SpotLight component.
      expect(frame.lights.spot[0]?.direction?.[1]).toBeCloseTo(-1, 5);
    });

    it('directional light snapshot is unchanged regardless of hierarchy (no Transform dependency)', () => {
      const world = new World();
      world
        .spawn({
          component: DirectionalLight,
          data: { castShadow: true, direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 },
        })
        .unwrap();
      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.directional).toBeDefined();
      expect(frame.lights.directional?.direction?.[1]).toBeCloseTo(-1, 5);
    });

    it('AC-05: cull AABB follows the world mat4 (parent off-screen -> child culled; in-screen -> kept)', () => {
      {
        const world = new World();
        const mesh = registerMesh(world);
        const mat = registerMaterial(world);
        world
          .spawn(
            { component: Transform, data: { ...identity(), pos: [0, 0, 5] } },
            { component: Camera, data: perspectiveCameraData() },
          )
          .unwrap();
        const parent = world
          .spawn({ component: Transform, data: { ...identity(), pos: [0, 0, 100] } })
          .unwrap();
        world
          .spawn(
            { component: Transform, data: identity() },
            { component: ChildOf, data: { parent } },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [mat] } },
          )
          .unwrap();
        expect(propagateTransforms(world).ok).toBe(true);
        const frame = extractFrame(world, prepareExtractContext(world));
        expect(frame.renderables).toHaveLength(0);
      }
      {
        const world = new World();
        const mesh = registerMesh(world);
        const mat = registerMaterial(world);
        world
          .spawn(
            { component: Transform, data: { ...identity(), pos: [0, 0, 5] } },
            { component: Camera, data: perspectiveCameraData() },
          )
          .unwrap();
        const parent = world.spawn({ component: Transform, data: identity() }).unwrap();
        world
          .spawn(
            { component: Transform, data: identity() },
            { component: ChildOf, data: { parent } },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [mat] } },
          )
          .unwrap();
        expect(propagateTransforms(world).ok).toBe(true);
        const frame = extractFrame(world, prepareExtractContext(world));
        expect(frame.renderables).toHaveLength(1);
      }
    });

    it('AC-02: builtin MeshAsset AABB enters the same frustum path as imported meshes', () => {
      const world = new World();
      spawnCamera(world);
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, 200] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
            },
          },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();

      expect(propagateTransforms(world).ok).toBe(true);
      const frame = extractFrame(world, prepareExtractContext(world));

      expect(frame.renderables).toHaveLength(0);
      expect(frame.frustumStats).toEqual({ culled: 1, total: 1 });
    });

    it('retains off-camera casters only for shadow dispatch and only inside a light frustum', () => {
      const world = new World();
      spawnCamera(world);
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, 2] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
            },
          },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      const light = world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, 5] } },
          { component: PointLight, data: { intensity: 10, range: 10 } },
          { component: PointLightShadow, data: { nearPlane: 0.1, farPlane: 10 } },
        )
        .unwrap();
      propagateTransforms(world).unwrap();
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.frustumStats).toEqual({ culled: 1, total: 1 });
      expect(frame.renderables).toHaveLength(1);
      expect(frame.dispatch.map((entry) => entry.tags.LightMode)).toEqual(['ShadowCaster']);
      expect(frame.dispatch.every((entry) => entry.renderableIndex === 0)).toBe(true);
      world.set(light, PointLightShadow, { farPlane: 1 }).unwrap();
      // Finite light range is the shadow extent; farPlane only controls unlimited lights.
      expect(extractFrame(world, prepareExtractContext(world)).renderables).toHaveLength(1);
      world.set(light, PointLight, { range: 1 }).unwrap();
      expect(extractFrame(world, prepareExtractContext(world)).renderables).toHaveLength(0);
      world.despawn(light).unwrap();
      expect(extractFrame(world, prepareExtractContext(world)).renderables).toHaveLength(0);
    });

    it('persistent composition retains shadow-only casters lit from another World', () => {
      const sceneWorld = new World();
      spawnCamera(sceneWorld);
      sceneWorld
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, 2] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(sceneWorld)
                .create(createPrimitiveMesh('cube').unwrap())
                .unwrap(),
            },
          },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      const lightWorld = new World();
      lightWorld
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, 5] } },
          { component: PointLight, data: { intensity: 10, range: 10 } },
          { component: PointLightShadow, data: { nearPlane: 0.1, farPlane: 10 } },
        )
        .unwrap();
      for (const world of [sceneWorld, lightWorld]) propagateTransforms(world).unwrap();
      const worlds = [sceneWorld, lightWorld];
      const owner = { cameraOwner: 0, resourceOwner: 0 };
      const scene = new PersistentRenderScene();
      const frame = scene.extractComposition(worlds, owner, testAssets(sceneWorld), () =>
        extractFrames(worlds, owner, undefined, undefined, { cull: 'none' }),
      );
      expect(frame.frustumStats).toEqual({ culled: 1, total: 1 });
      expect(frame.renderables).toHaveLength(1);
      expect(frame.dispatch.map((entry) => entry.tags.LightMode)).toEqual(['ShadowCaster']);
    });

    it('cross-world extract keeps frustum culling against the surfaced camera-owner camera', () => {
      const cameraWorld = new World();
      cameraWorld
        .spawn(
          { component: Transform, data: identity() },
          { component: Camera, data: perspectiveCameraData() },
        )
        .unwrap();

      const sceneWorld = new World();
      sceneWorld
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, 0] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(sceneWorld)
                .create(createPrimitiveMesh('cube').unwrap())
                .unwrap(),
            },
          },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      sceneWorld
        .spawn(
          { component: Transform, data: { ...identity(), pos: [0, 0, 200] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(sceneWorld)
                .create(createPrimitiveMesh('cube').unwrap())
                .unwrap(),
            },
          },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();

      propagateTransforms(cameraWorld).unwrap();
      propagateTransforms(sceneWorld).unwrap();

      const frame = extractFrames([cameraWorld, sceneWorld], { cameraOwner: 0, resourceOwner: 1 });

      expect(frame.renderables).toHaveLength(1);
      expect(frame.frustumStats).toEqual({ culled: 1, total: 2 });
    });

    it('derives canonical bounds from positions when authored mesh bounds are malformed', () => {
      const malformedAabbs: Array<Float32Array | undefined> = [
        undefined,
        new Float32Array([
          Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ]),
        new Float32Array([1, 0, 0, 0, 1, 1]),
        new Float32Array([0, 1, 0, 1, 0, 1]),
        new Float32Array([0, 0, 1, 1, 1, 0]),
        new Float32Array([Number.NaN, 0, 0, 1, 1, 1]),
        new Float32Array([0, 0, 0, Number.POSITIVE_INFINITY, 1, 1]),
        new Float32Array([0, 0, 0, 1]),
      ];

      for (const [index, aabb] of malformedAabbs.entries()) {
        const world = new World();
        spawnCamera(world);
        const mesh = registerMeshWithAabb(world, aabb);
        const material = registerMaterial(world);
        world
          .spawn(
            { component: Transform, data: { ...identity(), pos: [0, 0, 200] } },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();

        expect(propagateTransforms(world).ok).toBe(true);
        const frame = extractFrame(world, prepareExtractContext(world));

        // Managed admission derives finite bounds; the mesh behind the camera is culled.
        expect(testAssets(world).read(mesh).unwrap().aabb).toEqual(
          new Float32Array([0, 0, 0, 1, 1, 0]),
        );
        expect(frame.renderables, `malformed AABB case ${index}`).toHaveLength(0);
        expect(frame.frustumStats, `malformed AABB case ${index}`).toEqual({ culled: 1, total: 1 });
      }
    });

    it('AC-15: mesh-walk reads world via the column array view, not a per-renderable world.get materialization', () => {
      const world = new World();
      spawnCamera(world);
      world
        .spawn(
          { component: Transform, data: { ...identity(), pos: [1, 2, 3] } },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
            },
          },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      expect(propagateTransforms(world).ok).toBe(true);

      const getSpy = vi.spyOn(world, 'get');
      extractFrame(world, prepareExtractContext(world));
      // The mesh-walk must NOT call world.get(entity, Transform) to read the
      // resolved world mat4 -- it goes through the zero-materialization column
      // array view (_getArrayView). Any Transform materialization here would
      // re-introduce the per-frame `{}` allocation AC-15 forbids.
      const transformGets = getSpy.mock.calls.filter((c) => {
        const comp = c[1] as { name?: string } | undefined;
        return comp?.name === 'Transform';
      });
      expect(transformGets.length).toBe(0);
      getSpy.mockRestore();
    });
  });
}

// ─── from render-system-extract-material-inheritance.test.ts ───
{
  // Source parents resolve before adoption. Runtime variants copy the loaded
  // material and edit their own values without retaining a live parent chain.

  const FORWARD_PBR_PASS: MaterialPass = {
    name: 'Forward',
    program: { module: 'forgeax::default-standard-pbr' },
  };

  const FORWARD_UNLIT_PASS: MaterialPass = {
    name: 'Forward',
    program: { module: 'forgeax::default-unlit' },
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function registerTestMesh(world: World): AssetHandle<'mesh'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return testAssets(world)
      .create(
        createMeshBuilder({
          indices: new Uint16Array([0, 1, 2]),
          attributes: { position: positions },
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 3,
              vertexCount: 3,
              topology: 'triangle-list',
              materialSlot: 0,
            },
          ],

          materialSlots: [{ slotName: 'Default' }],
        })
          .build()
          .unwrap(),
      )
      .unwrap();
  }

  const materialSources = new WeakMap<
    AssetRegistry,
    Array<{ guid: string; asset: MaterialAsset; refs: string[] }>
  >();

  async function registerMaterial(
    assets: AssetRegistry,
    passes: MaterialPass[] | undefined,
    parentGuid?: string,
    values: MaterialAsset['values'] = {},
  ) {
    const guid = AssetGuid.format(AssetGuid.random());
    const asset = {
      kind: 'material' as const,
      ...(passes === undefined ? {} : { passes }),
      ...(parentGuid === undefined ? {} : { parent: parentGuid }),
      values,
    } as MaterialAsset;
    const entries = materialSources.get(assets) ?? [];
    entries.push({ guid, asset, refs: parentGuid === undefined ? [] : [parentGuid] });
    materialSources.set(assets, entries);
    publishRuntimeAssets(assets, entries);
    const handle = (await assets.load(guid, 'material')).unwrap();
    return { handle, guid };
  }

  function transformData(
    x: number,
    y: number,
    z: number,
  ): {
    pos: number[];
    quat: number[];
    scale: number[];
  } {
    return {
      pos: [x, y, z],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  function spawnRenderable(
    world: World,
    meshHandle: AssetHandle<'mesh'>,
    matHandle: AssetHandle<'material'>,
    x = 0,
    y = 0,
    z = 0,
  ): void {
    world
      .spawn(
        { component: Transform, data: transformData(x, y, z) },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
  }

  function spawnCamera(world: World): void {
    world
      .spawn(
        {
          component: Transform,
          data: transformData(0, 0, 5),
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
  }

  // ── Tests ────────────────────────────────────────────────────────────────────

  describe('render-system-extract source inheritance and managed runtime copies', () => {
    // ── (a) AC-05: inherit passes from parent ─────────────────────────────

    it('AC-05 core signal: child no-passes inherits passes from parent via extract', async () => {
      const world = new World();
      spawnCamera(world);
      const assets = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerTestMesh(world);

      const parentMat = await registerMaterial(assets, [FORWARD_PBR_PASS]);
      const childMat = await registerMaterial(assets, undefined, parentMat.guid);

      spawnRenderable(world, mesh, childMat.handle);

      propagateTransforms(world);

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      expect(frame.renderables.length).toBe(1);

      // AC-05: the child's snapshot should inherit passes from the parent,
      // yielding a non-undefined materialShaderId derived from the first pass.
      const snap = frame.renderables[0]?.material.snapshot;
      expect(snap).toBeDefined();
      expect(snap?.materialShaderId).toBe('forgeax::default-standard-pbr');
    });

    // ── (b) AC-06: shoot-76 equivalent (1 parent + 76 children) ─────────

    it('76 managed copies preserve a loaded material contract and accept independent values', async () => {
      const world = new World();
      spawnCamera(world);
      const assets = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerTestMesh(world);

      const parentMat = await registerMaterial(assets, [FORWARD_PBR_PASS]);

      const childCount = 76;
      for (let i = 0; i < childCount; i++) {
        const child = assets.copy(parentMat.handle).unwrap();
        assets.update(child, { values: { metallic: i / 100 } }).unwrap();
        // Spread across Z axis (0 to -60) so all entities stay within
        // the perspective camera frustum (far=100, fov=PI/4 at (0,0,5)).
        spawnRenderable(world, mesh, child, 0, 0, -i * 0.8);
      }

      propagateTransforms(world);

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));

      // AC-06: all 76 entities should produce renderables with non-empty
      // inherited passes.
      expect(frame.renderables.length).toBe(childCount);

      for (let i = 0; i < childCount; i++) {
        const snap = frame.renderables[i]?.material.snapshot;
        expect(snap?.materialShaderId).toBe('forgeax::default-standard-pbr');
        expect(snap?.metallic).toBe(i / 100);
      }
      expect(assets.read(parentMat.handle).unwrap().values?.metallic).toBeUndefined();
    });

    // ── (c) AC-06: values shallow-merge ───────────────────────────

    it('AC-06 values shallow-merge: child overrides parent, parent-only key retained', async () => {
      const world = new World();
      spawnCamera(world);
      const assets = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerTestMesh(world);

      const parentMat = await registerMaterial(assets, [FORWARD_PBR_PASS], undefined, {
        metallic: 0.3,
        roughness: 0.7,
      });
      const childMat = await registerMaterial(assets, undefined, parentMat.guid, {
        metallic: 0.9,
      });

      spawnRenderable(world, mesh, childMat.handle);

      propagateTransforms(world);

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      expect(frame.renderables.length).toBe(1);

      const snap = frame.renderables[0]?.material.snapshot;
      expect(snap).toBeDefined();
      expect(snap?.metallic).toBe(0.9);
      expect(snap?.roughness).toBe(0.7);
    });

    // ── (d) regression: no-parent path still works ─────────────────────

    it('no-parent regression: material without parent still extracts correctly', async () => {
      const world = new World();
      spawnCamera(world);
      const assets = new AssetRegistry({ shaderRegistry: makeMockShaderRegistry() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerTestMesh(world);

      const mat = await registerMaterial(assets, [FORWARD_UNLIT_PASS], undefined, {
        baseColor: [0.2, 0.3, 0.4],
      });

      spawnRenderable(world, mesh, mat.handle);

      propagateTransforms(world);

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      expect(frame.renderables.length).toBe(1);

      const snap = frame.renderables[0]?.material.snapshot;
      expect(snap).toBeDefined();
      expect(snap?.materialShaderId).toBe('forgeax::default-unlit');
      expect(snap?.baseColor[0]).toBeCloseTo(srgbChannelToLinear(0.2));
      expect(snap?.baseColor[1]).toBeCloseTo(srgbChannelToLinear(0.3));
      expect(snap?.baseColor[2]).toBeCloseTo(srgbChannelToLinear(0.4));
    });
  });
}

// --- from render-system-extract-sprite-slices.test.ts ---
{
  // Shared sprite parameters retain author values; drawing applies flips to
  // the selected shared or per-entity region without changing the material.

  function makeShaderRegistryWithSprite(): ShaderRegistry {
    const mockDevice: ShaderRegistryDevice = {
      createShaderModule() {
        return {
          ok: true,
          value: undefined,
          unwrap: () => undefined,
          unwrapOr: (d: unknown) => d,
        } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
      },
    };
    const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
    // Sprite paramSchema mirrors sprite.material.json post-w11. The four
    // UBO entries (colorTint / region / pivotAndSize / slicesAndMode) are
    // the WGSL Material struct field names; user-facing inputs
    // are normalized into the shared material parameter snapshot.
    // The texture entry uses the post-w11 baseColorTexture name (D-4).
    sr.installMaterialArtifact('forgeax::sprite', {
      source: 'fn main() {}',
      paramSchema: [
        { name: 'colorTint', type: 'vec4', default: [1.0, 1.0, 1.0, 1.0] },
        { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
        { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1.0, 1.0] },
        { name: 'slicesAndMode', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
        { name: 'baseColorTexture', type: 'texture2d' },
      ],
    });
    return sr;
  }

  const SPRITE_PASS: MaterialPass = {
    name: 'Sprite',
    program: { module: 'forgeax::sprite' },
    renderState: { queue: 3000 },
  };

  function identity() {
    return {
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  function registerSpriteMesh(world: World): AssetHandle<'mesh'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return testAssets(world)
      .create(
        createMeshBuilder({
          indices: new Uint16Array([0, 1, 2]),
          attributes: { position: positions },
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 3,
              vertexCount: 3,
              topology: 'triangle-list',
              materialSlot: 0,
            },
          ],

          materialSlots: [{ slotName: 'Default' }],
        })
          .build()
          .unwrap(),
      )
      .unwrap();
  }

  function spawnSpriteScene(values: Record<string, unknown>): {
    world: World;
    assets: AssetRegistry;
  } {
    const world = new World();
    const assets = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithSprite() });
    installDefaultAssetDecoders(assets);
    world.bindAssets(assets).unwrap();
    const mesh = registerSpriteMesh(world);
    const matHandle = testAssets(world)
      .create({
        kind: 'material',
        passes: [SPRITE_PASS],
        values,
      } as MaterialAsset)
      .unwrap();
    // Spawn a camera so extract has a viewport.
    world
      .spawn(
        { component: Transform, data: { ...identity(), pos: [0, 0, 5] } },
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
    // Spawn sprite entity.
    world
      .spawn(
        { component: Transform, data: identity() },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      )
      .unwrap();
    propagateTransforms(world);
    return { world, assets };
  }

  describe('render-system-extract sprite paramSnapshot slicesAndMode (M3 / w9)', () => {
    it('(1) no slicesAndMode in values -> paramSnapshot.slicesAndMode absent', () => {
      const { world, assets } = spawnSpriteScene({});
      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      // Renderable filter: post-ablation sprite carries forgeax::sprite
      // shaderId, NOT shadingModel='sprite' (the union member is gone in
      // AC-01).
      const renderable = frame.renderables.find(
        (r) => r.material.snapshot.materialShaderId === 'forgeax::sprite',
      );
      expect(renderable).toBeDefined();
      const snap = renderable?.material.snapshot.paramSnapshot;
      expect(snap).toBeDefined();
      // w0a SSOT-collapse fix: extract stage now explicitly seeds the
      // slicesAndMode slot with [0,0,0,0] when absent from values so
      // the record-stage UBO writer overrides the PBR baseline (which would
      // otherwise leave occlusionStrength=1 at offset 48 -> trips
      // useSlices=true in sprite.wgsl -> degenerate quad).
      expect(snap?.slicesAndMode).toEqual([0, 0, 0, 0]);
    });

    it('(2) stretch slicesAndMode [0.25,0.25,0.25,0.25] -> paramSnapshot.slicesAndMode verbatim', () => {
      const { world, assets } = spawnSpriteScene({
        slicesAndMode: [0.25, 0.25, 0.25, 0.25],
      });
      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      const renderable = frame.renderables.find(
        (r) => r.material.snapshot.materialShaderId === 'forgeax::sprite',
      );
      expect(renderable).toBeDefined();
      const snap = renderable?.material.snapshot.paramSnapshot;
      expect(snap?.slicesAndMode).toEqual([0.25, 0.25, 0.25, 0.25]);
    });

    it('(3) tile slicesAndMode [.25,.25,.25,-.25] -> .w negative sentinel verbatim', () => {
      // Post-fix-up F-1: callers encode tile mode at the call site by
      // supplying a negative `.w`; the extract path no longer folds a
      // separate `sliceMode` scalar (the shim layer is gone).
      const { world, assets } = spawnSpriteScene({
        slicesAndMode: [0.25, 0.25, 0.25, -0.25],
      });
      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      const renderable = frame.renderables.find(
        (r) => r.material.snapshot.materialShaderId === 'forgeax::sprite',
      );
      expect(renderable).toBeDefined();
      const snap = renderable?.material.snapshot.paramSnapshot;
      const slicesAndMode = snap?.slicesAndMode as readonly number[] | undefined;
      expect(slicesAndMode?.[0]).toBe(0.25);
      expect(slicesAndMode?.[1]).toBe(0.25);
      expect(slicesAndMode?.[2]).toBe(0.25);
      // Sentinel encoding: D-3 .w negative on tile mode (shader abs() recovers).
      expect(slicesAndMode?.[3]).toBe(-0.25);
    });

    it('(4) default identity region fold; pivotAndSize absent when not supplied', () => {
      const { world, assets } = spawnSpriteScene({});
      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      const renderable = frame.renderables.find(
        (r) => r.material.snapshot.materialShaderId === 'forgeax::sprite',
      );
      const snap = renderable?.material.snapshot.paramSnapshot;
      // Missing region uses the full texture; flips remain separate material values.
      expect(snap?.region).toEqual([0, 0, 1, 1]);
      // Post-fix-up F-1: no legacy `pivot` -> `pivotAndSize` fold; absence on
      // input means absence on snapshot (UBO writer fills std140 zero).
      expect(snap?.pivotAndSize).toBeUndefined();
    });

    it('(5) preserves flipX independently of the shared region for draw preparation', () => {
      const { world, assets } = spawnSpriteScene({ flipX: 1 });
      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      const renderable = frame.renderables.find(
        (r) => r.material.snapshot.materialShaderId === 'forgeax::sprite',
      );
      const snap = renderable?.material.snapshot.paramSnapshot;
      expect(snap?.region).toEqual([0, 0, 1, 1]);
      expect(snap?.flipX).toBe(1);
      expect(snap?.flipY).toBe(0);
    });
  });
}

// ─── from render-system-clear-camera.test.ts ───
{
  // @forgeax/engine-runtime/__tests__/render-system-clear-camera.test.ts -
  // feat-20260608-create-app-param-surface-trim / M1 / TASK-002.
  //
  // Asserts the clear-color flow from a Camera entity's SoA column into
  // the per-frame CameraSnapshot the record stage reads. The extract stage
  // is the boundary between the ECS column-views and the record stage's
  // GPU recording calls; once clearColor is on the snapshot, the record
  // stage can drop `internals.clearColor ?? [0.06, 0.06, 0.08, 1.0]` and
  // read directly from `cameras[0]` (first-archetype-hit per
  // requirements §OOS-2).
  //
  // feat-20260709 M3 / D-3: clear-color is one inline `array<f32,4>` column
  // (collapsed from the feat-20260608 clearR/G/B/A quartet) read on the hot
  // path as a stride-4 subscript, mirroring the light direction/color SoA
  // idiom.
  //
  // AC-03 asserts the boundary: if the snapshot does not surface clearColor,
  // the record stage cannot read it without re-walking the ECS, defeating the
  // SoA pipeline.

  function identityTransform() {
    return {
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  function spawnCamera(
    world: World,
    cam: { clearColor: readonly [number, number, number, number] },
  ) {
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1,
            near: 0.1,
            far: 100,
            clearColor: cam.clearColor,
          },
        },
      )
      .unwrap();
  }

  describe('render-system-extract clear-color SoA flow (TASK-002)', () => {
    it('CameraSnapshot surfaces clearColor read straight from the Camera SoA column', () => {
      const world = new World();
      spawnCamera(world, { clearColor: [0.25, 0.5, 0.75, 1.0] });
      propagateTransforms(world);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.cameras.length).toBe(1);
      const cam = frame.cameras[0];
      expect(cam).toBeDefined();
      if (!cam) return;
      expect(cam.clearColor[0]).toBeCloseTo(0.25, 6);
      expect(cam.clearColor[1]).toBeCloseTo(0.5, 6);
      expect(cam.clearColor[2]).toBeCloseTo(0.75, 6);
      expect(cam.clearColor[3]).toBeCloseTo(1.0, 6);
    });

    it('first-archetype-hit semantics: when N>1 cameras carry distinct clear, snapshot[0] is the first one', () => {
      const world = new World();
      spawnCamera(world, { clearColor: [0.1, 0.2, 0.3, 1.0] });
      spawnCamera(world, { clearColor: [0.9, 0.8, 0.7, 1.0] });
      propagateTransforms(world);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.cameras.length).toBeGreaterThanOrEqual(1);
      const cam0 = frame.cameras[0];
      expect(cam0).toBeDefined();
      if (!cam0) return;
      // The record stage uses cameras[0] (first-archetype-hit) per OOS-2;
      // assert the snapshot ordering preserves the spawn order so the
      // record stage's cameras[0] read is deterministic.
      expect(cam0.clearColor[0]).toBeCloseTo(0.1, 6);
      expect(cam0.clearColor[1]).toBeCloseTo(0.2, 6);
      expect(cam0.clearColor[2]).toBeCloseTo(0.3, 6);
    });

    it('Camera spawned without explicit clearColor defaults to transparent black [0,0,0,0]', () => {
      const world = new World();
      world
        .spawn(
          { component: Transform, data: identityTransform() },
          {
            component: Camera,
            data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
          },
        )
        .unwrap();
      propagateTransforms(world);
      const frame = extractFrame(world, prepareExtractContext(world));
      const cam = frame.cameras[0];
      expect(cam).toBeDefined();
      if (!cam) return;
      expect(Array.from(cam.clearColor)).toEqual([0, 0, 0, 0]);
    });
  });
}

// ─── M2 / w3: extract MaterialSnapshot carries a 4th texture (heightTexture) ───
//
// feat-20260621-learn-render-5-5-parallax-mapping-demo-aligned-wit M2 / w3
//
// A custom parallax shader declares heightTexture (the 4th user-region texture).
// The extract stage must iterate derive(paramSchema).textureFieldNames so the
// heightTexture handle flows into the MaterialSnapshot. Today extract hardcodes
// the 3 standard texture fields, so the 4th texture's handle is silently
// dropped — this test is RED until w7 wires the iteration. Post-w7 the snapshot
// carries the handle under MaterialSnapshot.textureHandles (a field-name keyed
// map that holds every declared user-region texture handle).
{
  function makeShaderRegistryWithParallax(): ShaderRegistry {
    const mockDevice: ShaderRegistryDevice = {
      createShaderModule() {
        return {
          ok: true,
          value: undefined,
          unwrap: () => undefined,
          unwrapOr: (d: unknown) => d,
        } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
      },
    };
    const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
    sr.installMaterialArtifact('learn-render::5-5-parallax', {
      source: 'fn main() {}',
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
        { name: 'metallic', type: 'f32', default: 0.0 },
        { name: 'roughness', type: 'f32', default: 0.5 },
        { name: 'heightScale', type: 'f32', default: 0.1 },
        { name: 'algoMode', type: 'f32', default: 0.0 },
        { name: 'baseColorTexture', type: 'texture2d' },
        { name: 'metallicRoughnessTexture', type: 'texture2d' },
        { name: 'normalTexture', type: 'texture2d' },
        { name: 'heightTexture', type: 'texture2d' },
      ],
    });
    return sr;
  }

  function makeShaderRegistryWithEmptyBuiltinPbrSchema(): ShaderRegistry {
    const sr = makeShaderRegistryWithParallax();
    sr.installMaterialArtifact('forgeax::default-standard-pbr', {
      source: 'fn main() {}',
      paramSchema: [],
    });
    return sr;
  }

  const PARALLAX_PASS: MaterialPass = {
    name: 'Forward',
    program: { module: 'learn-render::5-5-parallax' },
  };

  function identityTx() {
    return {
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  function registerQuadMesh(world: World): AssetHandle<'mesh'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return testAssets(world)
      .create(
        createMeshBuilder({
          indices: new Uint16Array([0, 1, 2]),
          attributes: { position: positions },
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 3,
              vertexCount: 3,
              topology: 'triangle-list',
              materialSlot: 0,
            },
          ],

          materialSlots: [{ slotName: 'Default' }],
        })
          .build()
          .unwrap(),
      )
      .unwrap();
  }

  function makeTextureHandle(world: World): AssetHandle<'texture'> {
    return testAssets(world)
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        data: new Uint8Array([255, 255, 255, 255]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
      .unwrap();
  }

  describe('render-system-extract heightTexture (4th texture) snapshot pass-through (M2 w3)', () => {
    it('resolves a source GUID texture reference through the material owner path', async () => {
      const world = new World();
      const assets = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithParallax() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerQuadMesh(world);
      const textureGuid = AssetGuid.format(AssetGuid.random());
      const materialGuid = AssetGuid.format(AssetGuid.random());
      publishRuntimeAssets(assets, [
        {
          guid: textureGuid,
          asset: {
            kind: 'texture',
            shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
            format: 'rgba8unorm',
            data: new Uint8Array([255, 255, 255, 255]),
            colorSpace: 'linear',
            mips: { kind: 'none' },
          },
        },
        {
          guid: materialGuid,
          refs: [textureGuid],
          asset: {
            kind: 'material',
            passes: [PARALLAX_PASS],
            values: { baseColorTexture: { texture: textureGuid } },
          },
        },
      ]);
      const matHandle = (await assets.load(materialGuid, 'material')).unwrap();

      world
        .spawn(
          { component: Transform, data: identityTx() },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
        )
        .unwrap();
      propagateTransforms(world);

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      const textureHandle =
        frame.renderables[0]?.material.snapshot.textureHandles?.get('baseColorTexture');
      expect(textureHandle).toBeDefined();
      expect(textureHandle).toBe((await assets.load(textureGuid, 'texture')).unwrap());
      expect(assets.read(textureHandle as AssetHandle<'texture'>).unwrap().data).toEqual(
        new Uint8Array([255, 255, 255, 255]),
      );
    });

    it('MaterialSnapshot.textureHandles carries heightTexture handle (non-undefined, matches input)', () => {
      const world = new World();
      const assets = new AssetRegistry({ shaderRegistry: makeShaderRegistryWithParallax() });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerQuadMesh(world);

      const baseColorHandle = makeTextureHandle(world);
      const normalHandle = makeTextureHandle(world);
      const heightHandle = makeTextureHandle(world);

      const matHandle = testAssets(world)
        .create({
          kind: 'material',
          passes: [PARALLAX_PASS],
          values: {
            baseColor: [1, 1, 1, 1],
            heightScale: 0.1,
            algoMode: 0,
            baseColorTexture: baseColorHandle,
            normalTexture: normalHandle,
            heightTexture: heightHandle,
          },
        } as MaterialAsset)
        .unwrap();

      world
        .spawn(
          { component: Transform, data: { ...identityTx(), pos: [0, 0, 5] } },
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
      world
        .spawn(
          { component: Transform, data: identityTx() },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
        )
        .unwrap();
      propagateTransforms(world);

      const frame = extractFrame(world, prepareExtractContext(world, { assets }));
      const renderable = frame.renderables.find(
        (r) => r.material.snapshot.materialShaderId === 'learn-render::5-5-parallax',
      );
      expect(renderable).toBeDefined();
      // Every texture parameter shares the same owner-backed handle map.
      const snap = renderable?.material.snapshot;
      const heightFromSnap = snap?.textureHandles?.get('heightTexture');
      expect(heightFromSnap).toBeDefined();
      expect(heightFromSnap).toBe(heightHandle);
      // The standard fields also land in the same map (single SSOT path).
      expect(snap?.textureHandles?.get('baseColorTexture')).toBe(baseColorHandle);
      expect(snap?.textureHandles?.get('normalTexture')).toBe(normalHandle);
    });

    it('keeps built-in PBR texture handles when its manifest schema is empty', () => {
      const world = new World();
      const assets = new AssetRegistry({
        shaderRegistry: makeShaderRegistryWithEmptyBuiltinPbrSchema(),
      });
      installDefaultAssetDecoders(assets);
      world.bindAssets(assets).unwrap();
      const mesh = registerQuadMesh(world);
      const baseColorHandle = makeTextureHandle(world);
      const metallicRoughnessHandle = makeTextureHandle(world);
      const samplerHandle = testAssets(world)
        .create({
          kind: 'sampler',
          magFilter: 'nearest',
          minFilter: 'nearest',
        })
        .unwrap();
      const material = testAssets(world)
        .create({
          kind: 'material',
          passes: [
            {
              name: 'Forward',
              program: { module: 'forgeax::default-standard-pbr' },
              renderState: { tags: { LightMode: 'Forward' } },
            },
          ],
          values: {
            baseColor: [1, 1, 1, 1],
            baseColorTexture: {
              texture: baseColorHandle,
              sampler: samplerHandle,
            },
            metallicRoughnessTexture: metallicRoughnessHandle,
          },
        })
        .unwrap();

      world
        .spawn(
          { component: Transform, data: { ...identityTx(), pos: [0, 0, 5] } },
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
      world
        .spawn(
          { component: Transform, data: identityTx() },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      propagateTransforms(world);

      const snapshot = extractFrame(world, prepareExtractContext(world, { assets })).renderables[0]
        ?.material.snapshot;
      expect(snapshot?.textureHandles?.get('baseColorTexture')).toBe(baseColorHandle);
      expect(snapshot?.textureHandles?.get('metallicRoughnessTexture')).toBe(
        metallicRoughnessHandle,
      );
      expect(snapshot?.samplerHandles?.get('baseColorTexture')).toBe(samplerHandle);
    });
  });
}
