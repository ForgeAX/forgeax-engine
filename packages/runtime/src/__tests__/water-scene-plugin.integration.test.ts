import { createWorldContext, defineSystem, FixedUpdate, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/source';
import {
  Collider,
  DerivedPhysicsError,
  PhysicsSimulation,
  PhysicsSync,
  type PhysicsWorld,
  PhysicsWorldResource,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import physics3d, { PhysicsCollisionSync } from '@forgeax/engine-physics-rapier3d';
import type { Plugin } from '@forgeax/engine-plugin';
import { resolveVisibility, Visibility, VisibilityStateValue } from '@forgeax/engine-render';
import { createWaterUnderwaterFeature } from '@forgeax/engine-render/internal';
import {
  ChildOf,
  scenePlugin,
  Transform,
  WaterBodyInstance,
  WaterContactProbeSet,
  WaterExclusionMode,
  WaterExclusionVolume,
  WaterPontoonSet,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine-scene';
import {
  type Asset,
  type AssetHandle,
  type MaterialAsset,
  type MeshAsset,
  ok,
  standardSurfaceParameters,
  type WaterBodyAsset,
} from '@forgeax/engine-types';
import {
  buildRiverPhysicsCandidateInput,
  buildWaterBodyGeometry,
  buildWaterPackOutputs,
  cookWaterAsset,
  decodeWaterRiverBake,
  WaterQueryFlags,
  type WaterSystem,
  waterRiverBakeGeometryProjectionHash,
} from '@forgeax/engine-water';
import { assert, describe, expect, it, vi } from 'vitest';
import { runtimeAssets } from '../../../assets-runtime/src/internal/runtime-assets.js';
import { makeZeroCameraFallbackSnapshot } from '../../../render/src/record/frame-snapshot';
import { buildTerrainAssets } from '../../../terrain/src/closure.js';
import { WATER_BUOYANCY_RESOURCE, type WaterBuoyancyState } from '../water-buoyancy.js';
import {
  publishWaterRiverBake,
  reconcileWaterScene,
  reconcileWaterSceneCollisions,
  registryWaterMaterialReference,
  resolveWaterSceneDependencyHandle,
  WATER_SCENE_STATUS_RESOURCE,
  WATER_SYSTEM_RESOURCE,
  type WaterSceneAssetAccess,
  type WaterSceneStatus,
  waterExclusionIntersectsBody,
  waterScenePlugin,
  waterSceneRiverBakeNormalTexture,
  waterSceneSnapshot,
  waterSceneWaterInfoGeometry,
  waterSceneZoneSnapshot,
} from '../water-scene-plugin';
import { WaterBuoyancy, WaterSceneCollisionReconcile } from '../water-system-order.js';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { testAssets } from './helpers/runtime-assets';
import {
  admitRiverCollider,
  body,
  bodyGuid,
  childMaterialGuid,
  cookedBody,
  createWaterPhysics,
  identity,
  lLake,
  lRiver,
  materialGuid,
  oceanPatchRecipe,
  publishWaterMeshTestAssets,
  registerWaterZoneTerrainProviderTests,
  requiredFixtureValue,
  requiredValue,
  riverBakeNormalTexture,
  riverBakeRecipeAsset,
  riverBakeTexture,
  staticBody,
  waterTestPackage,
  yRotationTransformMatrix,
  zone,
  zoneGuid,
} from './helpers/water-scene-fixtures';

registerWaterZoneTerrainProviderTests();

describe('water exclusion narrow phase', () => {
  it('uses the authoritative Lake query footprint instead of its collision bounds box', async () => {
    const lake = await cookedBody(lLake());
    expect(waterExclusionIntersectsBody(lake, identity, [4, 0, 4], [0.5, 0.5, 0.5], identity)).toBe(
      false,
    );
    expect(waterExclusionIntersectsBody(lake, identity, [1, 0, 4], [0.5, 0.5, 0.5], identity)).toBe(
      true,
    );
  });

  it('rejects a box in an L-bend River AABB gap outside every cooked segment convex', async () => {
    expect(
      waterExclusionIntersectsBody(
        await cookedBody(lRiver()),
        identity,
        [3, 0, 3],
        [0.5, 0.5, 0.5],
        identity,
      ),
    ).toBe(false);
  });

  it('respects Ocean holes and queries bodies independently of collision enablement', async () => {
    const island = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ] as const;
    const ocean: WaterBodyAsset = await cookedBody({
      ...body(),
      type: 'ocean',
      oceanExtentM: [20, 20],
      centerOnWaterZone: false,
      spline: {
        closed: true,
        points: island.map(([x, z], inputKey) => ({
          inputKey,
          positionM: [x, 0, z] as const,
          arriveTangentM: [0, 0, 0] as const,
          leaveTangentM: [0, 0, 0] as const,
          up: [0, 1, 0] as const,
          rollAngle: 0,
          angleUnit: 'degrees' as const,
          widthM: 1,
          depthM: 1,
          velocityMPerSec: 0,
          audioIntensity: 0,
        })),
      },
      collision: { type: 'none', enabled: false },
    });
    expect(
      waterExclusionIntersectsBody(ocean, identity, [0, 0, 0], [0.5, 0.5, 0.5], identity),
    ).toBe(false);
    expect(
      waterExclusionIntersectsBody(ocean, identity, [6, 0, 0], [0.5, 0.5, 0.5], identity),
    ).toBe(true);
    const noCollisionRiver = await cookedBody({
      ...lRiver(),
      collision: { type: 'none' as const, enabled: false },
    });
    expect(
      waterExclusionIntersectsBody(
        noCollisionRiver,
        identity,
        [1, 0, 0],
        [0.5, 0.5, 0.5],
        identity,
      ),
    ).toBe(true);
    expect(
      waterExclusionIntersectsBody(
        noCollisionRiver,
        identity,
        [1, -100, 0],
        [0.5, 0.5, 0.5],
        identity,
      ),
    ).toBe(true);
    expect(
      waterExclusionIntersectsBody(
        noCollisionRiver,
        identity,
        [1, -100, 20],
        [0.5, 0.5, 0.5],
        identity,
      ),
    ).toBe(false);
  });
});

describe('water Scene lifecycle plugin', () => {
  it('reuses current Registry Terrain snapshots across contact Updates and multi-point queries', async () => {
    const world = new World();
    const assets = testAssets(world);
    const queryZoneGuid = '019a0000-0000-7000-8000-000000000680';
    const queryBodyGuid = '019a0000-0000-7000-8000-000000000681';
    const queryTerrainGuid = '019a0000-0000-7000-8000-000000000682';
    const queryWaveGuid = '019a0000-0000-7000-8000-000000000683';
    const terrainMaterialGuid = '019a0000-0000-7000-8000-000000000684';
    const terrainMaterial = {
      kind: 'material' as const,
      colorSpace: 'linear' as const,
      parameters: standardSurfaceParameters([]),
      values: { baseColor: [0.25, 0.5, 0.75, 1] },
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    };
    const derivedGuids = new Map<string, string>();
    const derivedGuid = (key: string) => {
      let guid = derivedGuids.get(key);
      if (!guid) {
        guid = `019a0000-0000-7000-8000-${(0x685 + derivedGuids.size).toString(16).padStart(12, '0')}`;
        derivedGuids.set(key, guid);
      }
      return guid;
    };
    const terrainOutputs = buildTerrainAssets(
      {
        columns: 4,
        rows: 2,
        spacing: 2,
        subsectionVertices: 2,
        heights: new Float32Array(8).fill(-1),
        weights: new Float32Array(8).fill(1),
        layers: [{ material: terrainMaterialGuid, blend: 'weight' }],
      },
      derivedGuid,
      { [terrainMaterialGuid]: terrainMaterial },
    ).unwrap();
    const terrainAsset = terrainOutputs.terrain as Extract<Asset, { kind: 'terrain' }>;
    const terrainRefs = [
      ...new Set([
        ...terrainAsset.grids,
        ...terrainAsset.layers.map((layer) => layer.material),
        ...terrainAsset.sections.flatMap((section) => [
          section.heightTexture,
          section.weightTexture,
          section.material,
        ]),
      ]),
    ];
    const terrainEntries = Object.entries(terrainOutputs)
      .filter(([key]) => key !== 'terrain')
      .map(([key, payload]) => ({
        guid: derivedGuid(key),
        kind: payload.kind,
        refs:
          payload.kind === 'material'
            ? [
                derivedGuid('height'),
                derivedGuid('section/0/weights'),
                derivedGuid('control-sampler'),
              ]
            : [],
        artifacts: {},
        payload,
      }));
    terrainEntries.push({
      guid: terrainMaterialGuid,
      kind: 'material',
      refs: [],
      artifacts: {},
      payload: terrainMaterial,
    });
    const waveSet = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0 }],
      },
      depthMaskM: 4,
      maxWaveHeightM: 0.5,
      timeSource: 'scene-clock',
    }).unwrap();
    const lake = await cookedBody({
      ...lLake(),
      zoneGuid: queryZoneGuid,
      waveSetGuid: queryWaveGuid,
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      collision: { type: 'none', enabled: false },
    });
    publishTestAssets(assets, [
      {
        guid: queryBodyGuid,
        kind: 'water-body',
        payload: lake,
        refs: [queryZoneGuid, materialGuid, queryWaveGuid],
        artifacts: {},
      },
      { guid: queryZoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      { guid: queryWaveGuid, kind: 'water-wave-set', payload: waveSet, refs: [], artifacts: {} },
      ...terrainEntries,
      {
        guid: queryTerrainGuid,
        kind: 'terrain',
        payload: terrainAsset,
        refs: terrainRefs,
        artifacts: {},
      },
    ]);
    const bodyHandle = (await assets.load(queryBodyGuid, 'water-body')).unwrap();
    const zoneHandle = (await assets.load(queryZoneGuid, 'water-zone')).unwrap();
    const terrainHandle = (await assets.load(queryTerrainGuid, 'terrain')).unwrap();
    (await assets.load(queryWaveGuid, 'water-wave-set')).unwrap();
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    const registryRead = vi.spyOn(assets, 'read');
    const terrainReads = () =>
      registryRead.mock.calls.filter(([handle]) => Number(handle) === Number(terrainHandle)).length;
    try {
      const bodyEntity = world
        .spawn(
          { component: Transform },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform },
          { component: WaterZoneInstance, data: { zone: zoneHandle } },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform },
          { component: WaterTerrainProvider, data: { terrain: terrainHandle } },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform },
          {
            component: WaterContactProbeSet,
            data: { body: bodyEntity, centersM: [1, 0, 1], radiiM: [10] },
          },
        )
        .unwrap();

      const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      const query = (x: number, z: number) => {
        const result = water.queryBody(`scene-entity:${bodyEntity}`, {
          positionM: [x, 0, z],
          flags: WaterQueryFlags.ComputeLocation | WaterQueryFlags.ComputeDepth,
          timeSeconds: 0,
        });
        if (!result.ok) throw result.error;
        expect(result.value.terrainSample?.heightM).toBe(-1);
        expect(result.value.source).toBe('terrain');
      };

      world.update(1 / 60).unwrap();
      expect(terrainReads()).toBe(1);
      for (let frame = 0; frame < 3; frame++) {
        world.update(1 / 60).unwrap();
        query(0.5, 0.5);
        query(2.5, 1.5);
        query(4.5, 0.5);
      }
      expect(terrainReads()).toBe(1);

      const records = runtimeAssets(assets);
      const liveBorrow = records.borrow.bind(records);
      const borrowSpy = vi.spyOn(records, 'borrow');
      borrowSpy.mockImplementation(<T>(handle: number) =>
        Number(handle) === Number(terrainHandle)
          ? ok({ kind: 'texture' } as unknown as T)
          : liveBorrow<T>(handle),
      );
      try {
        const unavailable = water.queryBody(`scene-entity:${bodyEntity}`, {
          positionM: [2.5, 1, 1],
          flags: WaterQueryFlags.ComputeLocation | WaterQueryFlags.ComputeDepth,
          timeSeconds: 0,
        });
        if (!unavailable.ok) throw unavailable.error;
        expect(unavailable.value.terrainSample).toBeUndefined();
        expect(unavailable.value.source).toBe('spline');
        expect(terrainReads()).toBe(1);
      } finally {
        borrowSpy.mockRestore();
      }

      assets
        .replace(terrainHandle, {
          ...terrainAsset,
          heights: new Float32Array(8).fill(-3),
          heightRange: [-3, -1],
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      const revisedReads = terrainReads();
      expect(revisedReads).toBe(2);
      const revised = water.queryBody(`scene-entity:${bodyEntity}`, {
        positionM: [2.5, 1, 1],
        flags: WaterQueryFlags.ComputeLocation | WaterQueryFlags.ComputeDepth,
        timeSeconds: 0,
      });
      if (!revised.ok) throw revised.error;
      expect(revised.value.terrainSample?.heightM).toBe(-3);
      expect(revised.value.depthM).toBe(3);
      world.update(1 / 60).unwrap();
      expect(terrainReads()).toBe(revisedReads);
    } finally {
      registryRead.mockRestore();
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it.each([
    undefined,
    0x0002_0002,
  ])('selects native Water collision using the World trace setting and frame visibility (%s)', async (underwaterTraceFilterMask) => {
    const world = new World();
    const assets = testAssets(world);
    const source = lLake();
    publishTestAssets(assets, [
      {
        guid: bodyGuid,
        kind: 'water-body',
        payload: await cookedBody({
          ...source,
          underwaterPostProcessMaterialGuid: childMaterialGuid,
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { ...source.collision, collisionGroups: 0x0002_ffff },
        }),
        refs: [materialGuid, zoneGuid, childMaterialGuid],
        artifacts: {},
      },
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      {
        guid: childMaterialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [
      provideAssets,
      scenePlugin(),
      physics3d,
      waterScenePlugin(
        underwaterTraceFilterMask === undefined ? {} : { underwaterTraceFilterMask },
      ),
    ]);
    try {
      const parent = world.spawn({ component: Transform }, { component: Visibility }).unwrap();
      const handle = (await assets.load(bodyGuid, 'water-body')).unwrap();
      const entity = world
        .spawn(
          { component: Transform },
          { component: WaterBodyInstance, data: { body: handle } },
          { component: ChildOf, data: { parent } },
          { component: Visibility },
        )
        .unwrap();
      for (let frame = 0; frame < 5; frame++) world.update(1 / 60).unwrap();
      const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      expect(waterSceneSnapshot(world, entity)?.outputs.collision).toBe('ready');
      const feature = createWaterUnderwaterFeature();
      const camera = { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(1, -1, 1) };
      let frameNumber = 0;
      const extract = (snapshot = resolveVisibility(world)) => {
        feature
          .extract({
            world,
            owner: 0,
            frameNumber: ++frameNumber,
            visibilitySnapshot: snapshot,
            views: [{ identity: 'main', render: true, selectedCamera: camera }],
          })
          .unwrap();
        return requiredFixtureValue(water.viewState('main')).unwrap();
      };
      const visible = extract();
      expect(visible.selectedBody).toBe(
        underwaterTraceFilterMask === undefined ? undefined : `scene-entity:${entity}`,
      );
      if (underwaterTraceFilterMask === undefined) {
        expect(visible.trace.coarse).toEqual([]);
        return;
      }
      expect(visible).toMatchObject({ audioUnderwater: true, visualPpActive: true });
      const heldVisible = resolveVisibility(world);
      world.set(parent, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
      expect(extract(heldVisible).selectedBody).toBe(`scene-entity:${entity}`);
      const hidden = extract();
      expect(hidden.selectedBody).toBeUndefined();
      expect(hidden).toMatchObject({
        audioUnderwater: false,
        visualPpActive: false,
        immersionDepthM: -0.01,
      });
      world.set(parent, Visibility, { state: VisibilityStateValue.inherited }).unwrap();
      expect(extract().selectedBody).toBe(`scene-entity:${entity}`);
      world.set(entity, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
      expect(extract().selectedBody).toBeUndefined();
      world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
      expect(extract().selectedBody).toBe(`scene-entity:${entity}`);
      expect(water.setUnderwaterTraceFilterMask(0x0001_0001)).toMatchObject({ ok: true });
      expect(extract().selectedBody).toBeUndefined();
      expect(water.setUnderwaterTraceFilterMask(0x1_0000_0000)).toMatchObject({
        ok: false,
        error: { code: 'water-view-input-invalid' },
      });
      expect(extract().selectedBody).toBeUndefined();
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('loads and retains Body-declared non-Mesh dependencies for the live Body roster', async () => {
    const world = new World();
    const assets = testAssets(world);
    const waveGuid = '019a0000-0000-7000-8000-000000000415';
    const lateWaveGuid = '019a0000-0000-7000-8000-000000000416';
    const waveSet = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0 }],
      },
      depthMaskM: 4,
      maxWaveHeightM: 0.5,
      timeSource: 'fixed-step',
    }).unwrap();
    const waterBody = {
      ...body(),
      waveSetGuid: waveGuid,
      collision: { type: 'none' as const, enabled: false },
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
    };
    const bodyKey = 'river/non-mesh-dependencies';
    const lateBodyKey = 'river/late-non-mesh-dependency';
    const packed = await buildWaterPackOutputs(
      {
        [bodyKey]: waterBody,
        [lateBodyKey]: { ...waterBody, waveSetGuid: lateWaveGuid },
      },
      { packageId: waterTestPackage },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value[bodyKey]?.kind !== 'water-body')
      throw new Error('Water dependency body must cook');
    const cookedBodyGuid = AssetGuid.format(AssetGuid.derive(waterTestPackage, bodyKey));
    publishTestAssets(assets, [
      ...Object.entries(packed.value).map(([key, payload]) => ({
        guid: AssetGuid.format(AssetGuid.derive(waterTestPackage, key)),
        kind: payload.kind,
        payload,
        refs:
          payload.kind === 'water-body'
            ? [
                zoneGuid,
                materialGuid,
                key === bodyKey ? waveGuid : lateWaveGuid,
                ...(payload.riverSegmentMeshGuids ?? []),
                payload.waterInfoMeshGuid,
                payload.dilatedWaterInfoMeshGuid,
              ].filter((guid): guid is string => typeof guid === 'string')
            : [],
        artifacts: {},
      })),
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      { guid: waveGuid, kind: 'water-wave-set', payload: waveSet, refs: [], artifacts: {} },
      { guid: lateWaveGuid, kind: 'water-wave-set', payload: waveSet, refs: [], artifacts: {} },
    ]);
    const zoneHandle = (await assets.load(zoneGuid, 'water-zone')).unwrap();
    const bodyHandle = (await assets.load(cookedBodyGuid, 'water-body')).unwrap();
    const lateBodyHandle = (
      await assets.load(
        AssetGuid.format(AssetGuid.derive(waterTestPackage, lateBodyKey)),
        'water-body',
      )
    ).unwrap();
    const originalLoad = assets.load.bind(assets);
    const loadSpy = vi.spyOn(assets, 'load');
    const releaseSpy = vi.spyOn(assets, 'release');
    let failWaveSetOnce = true;
    let rejectMaterialOnce = true;
    loadSpy.mockImplementation(((guid: string, kind: string) => {
      const kindName = typeof kind === 'string' ? kind : (kind as { kind?: string }).kind;
      if (guid === materialGuid && kindName === 'material' && rejectMaterialOnce) {
        rejectMaterialOnce = false;
        return Promise.reject(
          Object.assign(new Error('injected material load rejection'), {
            code: 'fixture-material-load-rejected',
            expected: 'the fixture material load resolves',
            hint: 'retry the fixture material dependency',
            detail: { source: 'integration-test' },
          }),
        );
      }
      if (guid === waveGuid && kindName === 'water-wave-set' && failWaveSetOnce) {
        failWaveSetOnce = false;
        return Promise.resolve({
          ok: false,
          error: Object.assign(new Error('injected WaveSet load failure'), {
            code: 'fixture-wave-load-failed',
            expected: 'the fixture WaveSet load succeeds',
            hint: 'retry the fixture dependency',
          }),
        });
      }
      return originalLoad(guid, kind as never);
    }) as typeof assets.load);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterZoneInstance, data: { zone: zoneHandle } },
        )
        .unwrap();
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      const sharedEntity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const snapshot = () => requiredFixtureValue(waterSceneSnapshot(world, entity));
      for (
        let attempt = 0;
        attempt < 30 &&
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus).waterDependencyFailures
          .length < 2;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        world.update(1 / 60).unwrap();
      }
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterDependencyFailures,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            guid: waveGuid,
            kind: 'water-wave-set',
            code: 'fixture-wave-load-failed',
            expected: 'the fixture WaveSet load succeeds',
            hint: 'retry the fixture dependency',
          }),
          expect.objectContaining({
            guid: materialGuid,
            kind: 'material',
            code: 'fixture-material-load-rejected',
            expected: 'the fixture material load resolves',
            hint: 'retry the fixture material dependency',
            detail: { source: 'integration-test' },
          }),
        ]),
      );
      for (let frame = 0; frame < 65; frame += 1) world.update(1 / 60).unwrap();
      for (
        let attempt = 0;
        attempt < 30 &&
        snapshot().dependencies.some(
          (dependency) => dependency.kind !== 'mesh' && dependency.status !== 'valid',
        );
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        world.update(1 / 60).unwrap();
      }
      expect(failWaveSetOnce).toBe(false);
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterDependencyFailures,
      ).toEqual([]);
      expect(
        snapshot()
          .dependencies.filter((dependency) => dependency.kind !== 'mesh')
          .map(({ guid, status }) => [guid, status]),
      ).toEqual(
        expect.arrayContaining([
          [zoneGuid, 'valid'],
          [materialGuid, 'valid'],
          [waveGuid, 'valid'],
        ]),
      );
      const dependencyLoadCalls = loadSpy.mock.calls.filter(
        ([guid, kind]) => kind !== 'mesh' && [zoneGuid, materialGuid, waveGuid].includes(guid),
      );
      expect(dependencyLoadCalls.map(([guid]) => guid).sort()).toEqual(
        [materialGuid, materialGuid, waveGuid, waveGuid, zoneGuid].sort(),
      );
      const ownedHandles = new Set<number>();
      const ownedByGuid = new Map<string, AssetHandle>();
      for (let index = 0; index < loadSpy.mock.calls.length; index += 1) {
        const [guid, kind] = requiredFixtureValue(loadSpy.mock.calls[index]);
        if (kind === 'mesh' || ![zoneGuid, materialGuid, waveGuid].includes(guid)) continue;
        const loaded = await requiredFixtureValue(loadSpy.mock.results[index]).value.catch(
          () => undefined,
        );
        if (loaded?.ok) {
          ownedHandles.add(loaded.value);
          if (guid === waveGuid || guid === materialGuid) ownedByGuid.set(guid, loaded.value);
        }
      }
      expect(ownedHandles.size).toBe(3);
      const retainedDependencies = new Map([
        [
          `water-wave-set\u0000${waveGuid}`.toLowerCase(),
          requiredFixtureValue(ownedByGuid.get(waveGuid)),
        ],
        [
          `material\u0000${materialGuid}`.toLowerCase(),
          requiredFixtureValue(ownedByGuid.get(materialGuid)),
        ],
      ]);
      const selectedWaveHandle = resolveWaterSceneDependencyHandle(
        'water-wave-set',
        waveGuid,
        new Map(),
        retainedDependencies,
        undefined,
      );
      const selectedMaterialHandle = resolveWaterSceneDependencyHandle(
        'material',
        materialGuid,
        new Map(),
        retainedDependencies,
        undefined,
      );
      expect(assets.read(requiredFixtureValue(selectedWaveHandle)).unwrap()).toMatchObject({
        kind: 'water-wave-set',
      });
      expect(assets.read(requiredFixtureValue(selectedMaterialHandle)).unwrap()).toMatchObject({
        kind: 'material',
      });

      const heldDependency = snapshot().dependencies.find(
        (dependency) => dependency.guid === materialGuid,
      );
      assert(heldDependency);
      const readSpy = vi.spyOn(assets, 'read');
      const materialReads = () =>
        readSpy.mock.calls.filter(([handle]) => handle === selectedMaterialHandle);
      for (let frame = 0; frame < 4; frame += 1) world.update(1 / 60).unwrap();
      expect(materialReads()).toHaveLength(0);
      assets
        .update(selectedMaterialHandle as AssetHandle<'material'>, { values: { roughness: 0.4 } })
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(materialReads()).toHaveLength(1);
      expect(
        snapshot().dependencies.find((dependency) => dependency.guid === materialGuid)?.payload,
      ).toMatchObject({ values: { roughness: 0.4 } });
      expect(heldDependency.payload).toMatchObject({ values: {} });
      for (let frame = 0; frame < 4; frame += 1) world.update(1 / 60).unwrap();
      expect(materialReads()).toHaveLength(1);
      readSpy.mockRestore();

      world.despawn(entity).unwrap();
      world.update(1 / 60).unwrap();
      expect(releaseSpy.mock.calls.filter(([handle]) => ownedHandles.has(handle))).toHaveLength(0);
      world.despawn(sharedEntity).unwrap();
      world.update(1 / 60).unwrap();
      expect(releaseSpy.mock.calls.filter(([handle]) => ownedHandles.has(handle))).toHaveLength(3);

      let resolveLateLoad: (() => void) | undefined;
      let lateWaveHandle: number | undefined;
      loadSpy.mockImplementation(((guid: string, kind: string) => {
        const kindName = typeof kind === 'string' ? kind : (kind as { kind?: string }).kind;
        if (guid === lateWaveGuid && kindName === 'water-wave-set')
          return new Promise((resolve) => {
            void originalLoad(guid, kind as never).then((result) => {
              if (result.ok) lateWaveHandle = result.value;
              resolveLateLoad = () => resolve(result as never);
            });
          });
        return originalLoad(guid, kind as never);
      }) as typeof assets.load);
      const lateEntity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: lateBodyHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      for (let attempt = 0; attempt < 30 && resolveLateLoad === undefined; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolveLateLoad).toBeDefined();
      expect(lateWaveHandle).toBeDefined();
      world.despawn(lateEntity).unwrap();
      await ctx.fiber.dispose();
      resolveLateLoad?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(releaseSpy.mock.calls.filter(([handle]) => handle === lateWaveHandle)).toHaveLength(1);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('loads and accepts the complete generated mesh closure from Zone and Body instances', async () => {
    const world = new World();
    const assets = testAssets(world);
    const bodyKey = 'river/loaded-geometry';
    const replacementBodyKey = 'river/replacement-geometry';
    const packed = await buildWaterPackOutputs(
      {
        [bodyKey]: body(),
        [replacementBodyKey]: { ...body(), baseHeightM: 1 },
      },
      { packageId: waterTestPackage },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value[bodyKey]?.kind !== 'water-body')
      throw new Error('River fixture must cook');
    const cooked = packed.value[bodyKey];
    const prepareLoadedWaterMeshEntries = () => {
      const generatedRefs = [
        ...(cooked.riverSegmentMeshGuids ?? []),
        cooked.waterInfoMeshGuid,
        cooked.dilatedWaterInfoMeshGuid,
      ].filter((guid): guid is string => typeof guid === 'string');
      const entries = Object.entries(packed.value).map(([sourceKey, payload]) => ({
        guid: AssetGuid.format(AssetGuid.derive(waterTestPackage, sourceKey)),
        kind: payload.kind,
        payload,
        refs:
          payload.kind === 'water-body'
            ? [
                zoneGuid,
                materialGuid,
                ...(payload.riverSegmentMeshGuids ?? []),
                payload.waterInfoMeshGuid,
                payload.dilatedWaterInfoMeshGuid,
              ].filter((guid): guid is string => typeof guid === 'string')
            : [],
        artifacts: {},
      }));
      entries.push(
        { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
        {
          guid: materialGuid,
          kind: 'material',
          payload: {
            kind: 'material',
            passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
            values: {},
          },
          refs: [],
          artifacts: {},
        },
      );
      return { generatedRefs, entries };
    };
    const { generatedRefs, entries } = prepareLoadedWaterMeshEntries();
    await publishWaterMeshTestAssets(assets, entries);
    const zoneHandle = (await assets.load(zoneGuid, 'water-zone')).unwrap();
    const bodyHandle = (
      await assets.load(AssetGuid.format(AssetGuid.derive(waterTestPackage, bodyKey)), 'water-body')
    ).unwrap();
    const replacementHandle = (
      await assets.load(
        AssetGuid.format(AssetGuid.derive(waterTestPackage, replacementBodyKey)),
        'water-body',
      )
    ).unwrap();
    const originalLoad = assets.load.bind(assets);
    const readReplacementWaterMeshGuids = () => {
      const replacementCooked = packed.value[replacementBodyKey];
      if (replacementCooked?.kind !== 'water-body')
        throw new Error('Replacement River fixture must cook');
      const replacementMeshGuids = [
        ...(replacementCooked.riverSegmentMeshGuids ?? []),
        replacementCooked.waterInfoMeshGuid,
        replacementCooked.dilatedWaterInfoMeshGuid,
      ].filter((guid): guid is string => typeof guid === 'string');
      return replacementMeshGuids;
    };
    const replacementMeshGuids = readReplacementWaterMeshGuids();
    const meshLoadSpy = vi.spyOn(assets, 'load');
    const releaseSpy = vi.spyOn(assets, 'release');
    const deferredMeshResolutions: Array<() => void> = [];
    const deferredMeshFailures: Array<() => void> = [];
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    const originalMeshHandles = new Set<number>();
    try {
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterZoneInstance, data: { zone: zoneHandle } },
        )
        .unwrap();
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      const sharedEntity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const water = world.getResource(
        WATER_SYSTEM_RESOURCE,
      ) as import('@forgeax/engine-water').WaterSystem;
      let first = requiredFixtureValue(waterSceneSnapshot(world, entity));
      expect(
        first.dependencies.filter((dependency) => generatedRefs.includes(dependency.guid)),
      ).toMatchObject(generatedRefs.map(() => ({ status: 'pending' })));
      for (
        let attempt = 0;
        attempt < 30 &&
        (first.outputs.geometry !== 'ready' ||
          waterSceneWaterInfoGeometry(world, entity) === undefined ||
          waterSceneWaterInfoGeometry(world, sharedEntity) === undefined);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        world.update(1 / 60).unwrap();
        first = requiredFixtureValue(waterSceneSnapshot(world, entity));
      }
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterGeometryMeshFailures,
      ).toEqual([]);
      expect(first.dirty.has('geometry')).toBe(false);
      expect(first.outputs.geometry).toBe('ready');
      expect(first.outputReceipts.geometry).toMatchObject({
        outputGeneration: first.outputGenerations.geometry,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const waterInfoGeometry = waterSceneWaterInfoGeometry(world, entity);
      expect(waterInfoGeometry).toMatchObject({
        bodyEntity: entity,
        sourceAssetGuid: first.sourceAssetGuid,
        geometryGeneration: first.outputGenerations.geometry,
        geometryReceipt: first.outputReceipts.geometry,
        undilated: { guid: cooked.waterInfoMeshGuid, mesh: { kind: 'mesh' } },
        dilated: { guid: cooked.dilatedWaterInfoMeshGuid, mesh: { kind: 'mesh' } },
      });
      expect(waterInfoGeometry).not.toHaveProperty('exclusionVolumes');
      const meshLoadCalls = meshLoadSpy.mock.calls.filter(([, kind]) => kind === 'mesh');
      expect(meshLoadCalls.map(([guid]) => guid).sort()).toEqual(
        [...new Set(generatedRefs)].sort(),
      );
      const initialHandlesByGuid = new Map<string, number>();
      for (let index = 0; index < meshLoadSpy.mock.calls.length; index += 1) {
        const [guid, kind] = requiredFixtureValue(meshLoadSpy.mock.calls[index]);
        if (kind !== 'mesh') continue;
        const loaded = await requiredFixtureValue(meshLoadSpy.mock.results[index]).value;
        const retainInitialWaterMeshHandle = () => {
          if (loaded.ok && typeof loaded.value === 'number')
            initialHandlesByGuid.set(guid, loaded.value);
        };
        retainInitialWaterMeshHandle();
      }
      expect(initialHandlesByGuid.size).toBe(generatedRefs.length);
      for (const handle of initialHandlesByGuid.values()) originalMeshHandles.add(handle);
      const assertLoadedWaterMeshQueryLifecycle = () => {
        const visibleMeshGuid = first.asset.riverSegmentMeshGuids?.[0];
        if (visibleMeshGuid === undefined)
          throw new Error('River fixture must include a visible mesh');
        const visibleMeshHandle = initialHandlesByGuid.get(visibleMeshGuid);
        if (visibleMeshHandle === undefined) throw new Error('Visible River mesh must be loaded');
        const visibleMesh = assets
          .read(visibleMeshHandle as AssetHandle<'mesh', MeshAsset>)
          .unwrap();
        expect(visibleMesh.vertices).toBeInstanceOf(Float32Array);
        const defaultMaterial = visibleMesh.materialSlots[0]?.defaultMaterial;
        expect(typeof defaultMaterial).toBe('number');
        expect(assets.read(defaultMaterial as AssetHandle<'material', Asset>).unwrap().kind).toBe(
          'material',
        );
        expect(first.dirty.has('query')).toBe(false);
        expect(first.outputs.query).toBe('ready');
        expect(first.outputReceipts.query).toMatchObject({
          outputGeneration: first.outputGenerations.query,
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        });

        const priorReceipt = requiredFixtureValue(first.outputReceipts.geometry);
        const priorQueryReceipt = requiredFixtureValue(first.outputReceipts.query);
        water.invalidate(first.guid, ['geometry']);
        expect(waterSceneWaterInfoGeometry(world, entity)).toBeUndefined();
        const missingInfoDependency: WaterSceneAssetAccess = {
          sourceGuid: () => first.sourceAssetGuid,
          version: () => Number(first.sourceVersion),
          read: () => cooked,
          dependency: (guid, kind) => {
            const dependency = first.dependencies.find(
              (candidate) =>
                candidate.guid.toLowerCase() === guid.toLowerCase() && candidate.kind === kind,
            );
            return dependency?.field === 'dilatedWaterInfoMeshGuid'
              ? { guid, kind, status: 'unavailable' }
              : dependency;
          },
        };
        reconcileWaterScene(
          world,
          missingInfoDependency,
          water,
          world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus,
        );
        const rejected = requiredFixtureValue(water.snapshot(first.guid));
        expect(rejected.dirty.has('geometry')).toBe(true);
        expect(rejected.outputs.geometry).toBe('stale');
        expect(rejected.outputReceipts.geometry).toEqual(priorReceipt);

        world.update(1 / 60).unwrap();
        const refreshed = requiredFixtureValue(waterSceneSnapshot(world, entity));
        expect(refreshed.outputs.geometry).toBe('ready');
        expect(refreshed.outputReceipts.geometry?.outputGeneration).toBeGreaterThan(
          priorReceipt.outputGeneration,
        );
        expect(refreshed.outputReceipts.geometry?.consumerGeneration).toBeGreaterThan(
          priorReceipt.consumerGeneration,
        );
        expect(refreshed.outputs.query).toBe('ready');

        const queryBeforeBodyUpdate = requiredFixtureValue(refreshed.outputReceipts.query);
        expect(
          assets.replace(bodyHandle, {
            ...refreshed.asset,
            overlapPriority: refreshed.asset.overlapPriority + 1,
          } as Asset).ok,
        ).toBe(true);
        world.update(1 / 60).unwrap();
        const bodyUpdated = requiredFixtureValue(waterSceneSnapshot(world, entity));
        expect(bodyUpdated.outputs.query).toBe('ready');
        expect(bodyUpdated.outputReceipts.query?.outputGeneration).toBeGreaterThan(
          queryBeforeBodyUpdate.outputGeneration,
        );
        expect(bodyUpdated.outputReceipts.query?.consumerGeneration).toBeGreaterThan(
          queryBeforeBodyUpdate.consumerGeneration,
        );

        const exclusionEntity = world
          .spawn(
            { component: Transform, data: { pos: [0.5, 0, 0] } },
            {
              component: WaterExclusionVolume,
              data: {
                mode: WaterExclusionMode.addListedBodiesToExclusion,
                waterBodies: [entity],
                centerM: [0, 0, 0],
                halfExtentsM: [0.5, 0.5, 0.5],
              },
            },
          )
          .unwrap();
        world.update(1 / 60).unwrap();
        const excluded = requiredFixtureValue(waterSceneSnapshot(world, entity));
        expect(excluded.outputs.query).toBe('ready');
        expect(waterSceneWaterInfoGeometry(world, entity)).toMatchObject({
          undilated: { guid: cooked.waterInfoMeshGuid },
          dilated: { guid: cooked.dilatedWaterInfoMeshGuid },
        });
        expect(excluded.outputReceipts.query?.outputGeneration).toBe(
          excluded.outputGenerations.query,
        );
        expect(excluded.outputReceipts.query?.digest).not.toBe(
          bodyUpdated.outputReceipts.query?.digest,
        );
        world.despawn(exclusionEntity).unwrap();
        world.update(1 / 60).unwrap();
        expect(waterSceneSnapshot(world, entity)?.outputs.query).toBe('ready');
        expect(priorQueryReceipt.outputGeneration).toBe(first.outputGenerations.query);
      };
      assertLoadedWaterMeshQueryLifecycle();
      const replacementLoadCallStart = meshLoadSpy.mock.calls.length;
      let failReplacementLoad = true;
      let deferReplacementFailures = false;
      let deferReplacementLoads = false;
      const installReplacementWaterMeshLoadFixture = () => {
        meshLoadSpy.mockImplementation(((guid: string, kind: string) => {
          if (kind === 'mesh' && replacementMeshGuids.includes(guid) && failReplacementLoad) {
            failReplacementLoad = false;
            return Promise.resolve({
              ok: false,
              error: Object.assign(new Error('injected mesh load failure'), {
                code: 'fixture-load-failed',
              }),
            });
          }
          if (kind === 'mesh' && replacementMeshGuids.includes(guid) && deferReplacementFailures) {
            return new Promise((resolve) => {
              deferredMeshFailures.push(() =>
                resolve({
                  ok: false,
                  error: Object.assign(new Error('late mesh load failure'), {
                    code: 'fixture-late-load-failed',
                  }),
                }),
              );
            });
          }
          if (kind === 'mesh' && replacementMeshGuids.includes(guid) && deferReplacementLoads) {
            return new Promise((resolve) => {
              void originalLoad(guid, kind as never).then((result) => {
                deferredMeshResolutions.push(() => resolve(result));
              });
            });
          }
          return originalLoad(guid, kind as never);
        }) as typeof assets.load);
      };
      installReplacementWaterMeshLoadFixture();
      world.set(sharedEntity, WaterBodyInstance, { body: replacementHandle }).unwrap();
      world.update(1 / 60).unwrap();
      let replacementGeometry = waterSceneWaterInfoGeometry(world, sharedEntity);
      for (let attempt = 0; attempt < 90 && replacementGeometry === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        world.update(1 / 60).unwrap();
        replacementGeometry = waterSceneWaterInfoGeometry(world, sharedEntity);
      }
      expect(failReplacementLoad).toBe(false);
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterGeometryMeshFailures,
      ).toEqual([]);
      expect(replacementGeometry).toMatchObject({
        sourceAssetGuid: AssetGuid.format(AssetGuid.derive(waterTestPackage, replacementBodyKey)),
      });
      const replacementHandlesByGuid = new Map<string, number>();
      for (
        let index = replacementLoadCallStart;
        index < meshLoadSpy.mock.calls.length;
        index += 1
      ) {
        const [guid, kind] = requiredFixtureValue(meshLoadSpy.mock.calls[index]);
        const skipUnrelatedReplacementMeshCall = () => {
          if (kind !== 'mesh' || !replacementMeshGuids.includes(guid)) return true;

          return false;
        };
        if (skipUnrelatedReplacementMeshCall()) continue;
        const loaded = await requiredFixtureValue(meshLoadSpy.mock.results[index]).value;
        const retainReplacementWaterMeshHandle = () => {
          if (loaded.ok && typeof loaded.value === 'number')
            replacementHandlesByGuid.set(guid, loaded.value);
        };
        retainReplacementWaterMeshHandle();
      }
      const assertReplacementWaterMeshRelease = () => {
        expect(replacementHandlesByGuid.size).toBe(replacementMeshGuids.length);
        expect(
          releaseSpy.mock.calls.filter(([handle]) => originalMeshHandles.has(handle)),
        ).toHaveLength(0);
        world.despawn(sharedEntity).unwrap();
        world.update(1 / 60).unwrap();
        const replacementMeshHandles = new Set(replacementHandlesByGuid.values());
        expect(replacementMeshHandles.size).toBe(replacementMeshGuids.length);
        expect(
          releaseSpy.mock.calls.filter(([handle]) => replacementMeshHandles.has(handle)),
        ).toHaveLength(replacementMeshGuids.length);
      };
      assertReplacementWaterMeshRelease();
      deferReplacementFailures = true;
      const removedEntity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: replacementHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(deferredMeshFailures).toHaveLength(replacementMeshGuids.length);
      world.despawn(removedEntity).unwrap();
      world.update(1 / 60).unwrap();
      for (const resolve of deferredMeshFailures.splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterGeometryMeshFailures,
      ).toEqual([]);
      deferReplacementFailures = false;
      const inFlightReleaseCountBefore = releaseSpy.mock.calls.length;
      deferReplacementLoads = true;
      const inFlightLoadCallStart = meshLoadSpy.mock.calls.length;
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: replacementHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deferredMeshResolutions).toHaveLength(replacementMeshGuids.length);
      await ctx.fiber.dispose();
      for (const resolve of deferredMeshResolutions.splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const inFlightHandles = new Set<number>();
      const inFlightHandlesByGuid = new Map<string, number>();
      for (let index = inFlightLoadCallStart; index < meshLoadSpy.mock.calls.length; index += 1) {
        const [guid, kind] = requiredFixtureValue(meshLoadSpy.mock.calls[index]);
        const skipUnrelatedInFlightMeshCall = () => {
          if (kind !== 'mesh' || !replacementMeshGuids.includes(guid)) return true;

          return false;
        };
        if (skipUnrelatedInFlightMeshCall()) continue;
        const loaded = await requiredFixtureValue(meshLoadSpy.mock.results[index]).value;
        const retainInFlightWaterMeshHandle = () => {
          if (loaded.ok && typeof loaded.value === 'number')
            inFlightHandlesByGuid.set(guid, loaded.value);
        };
        retainInFlightWaterMeshHandle();
      }
      for (const handle of inFlightHandlesByGuid.values()) inFlightHandles.add(handle);
      expect(inFlightHandlesByGuid.size).toBe(replacementMeshGuids.length);
      expect(
        releaseSpy.mock.calls
          .slice(inFlightReleaseCountBefore)
          .filter(([handle]) => inFlightHandles.has(handle)),
      ).toHaveLength(inFlightHandles.size);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
    expect(
      releaseSpy.mock.calls.filter(([handle]) => originalMeshHandles.has(handle)),
    ).toHaveLength(generatedRefs.length);
  });

  it('admits a legacy cooked Body without a v2 dilated WaterInfo mesh', async () => {
    const world = new World();
    const assets = testAssets(world);
    const bodyKey = 'river/legacy-geometry';
    const { zoneGuid: _zoneGuid, ...source } = body();
    const packed = await buildWaterPackOutputs(
      { [bodyKey]: source },
      { packageId: waterTestPackage },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value[bodyKey]?.kind !== 'water-body')
      throw new Error('Legacy River fixture must cook');
    const cooked = packed.value[bodyKey];
    const {
      waterGeometryVersion: _version,
      dilatedWaterInfoMeshGuid: _dilated,
      ...legacy
    } = cooked;
    const generatedRefs = [
      ...(legacy.riverSegmentMeshGuids ?? []),
      legacy.waterInfoMeshGuid,
    ].filter((guid): guid is string => typeof guid === 'string');
    const entries = Object.entries(packed.value).map(([sourceKey, payload]) => ({
      guid: AssetGuid.format(AssetGuid.derive(waterTestPackage, sourceKey)),
      kind: payload.kind,
      payload: sourceKey === bodyKey ? legacy : payload,
      refs: sourceKey === bodyKey ? [materialGuid, ...generatedRefs] : [],
      artifacts: {},
    }));
    entries.push({
      guid: materialGuid,
      kind: 'material',
      payload: {
        kind: 'material',
        passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
        values: {},
      },
      refs: [],
      artifacts: {},
    });
    await publishWaterMeshTestAssets(assets, entries);
    for (const [sourceKey, payload] of Object.entries(packed.value)) {
      if (payload.kind === 'mesh') {
        (
          await assets.load(AssetGuid.format(AssetGuid.derive(waterTestPackage, sourceKey)), 'mesh')
        ).unwrap();
      }
    }
    const bodyHandle = (
      await assets.load(AssetGuid.format(AssetGuid.derive(waterTestPackage, bodyKey)), 'water-body')
    ).unwrap();
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const snapshot = requiredFixtureValue(waterSceneSnapshot(world, entity));
      expect(snapshot.asset.waterGeometryVersion).toBeUndefined();
      expect(snapshot.asset.dilatedWaterInfoMeshGuid).toBeUndefined();
      expect(snapshot.dirty.has('geometry')).toBe(false);
      expect(snapshot.outputs.geometry).toBe('ready');
      expect(snapshot.outputReceipts.geometry?.digest).toMatch(/^[0-9a-f]{64}$/);
      const waterInfoGeometry = waterSceneWaterInfoGeometry(world, entity);
      expect(waterInfoGeometry?.undilated.guid).toBe(legacy.waterInfoMeshGuid);
      expect(waterInfoGeometry).not.toHaveProperty('dilated');
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('resolves explicitly enabled Custom WaterInfo from its accepted override-derived mesh', async () => {
    const world = new World();
    const assets = testAssets(world);
    const bodyKey = 'custom/water-info';
    const overrideGuid = '019a0000-0000-7000-8000-0000000004a1';
    const override = createBoxGeometry(2, 1, 2).unwrap();
    const { zoneGuid: _zoneGuid, ...riverSource } = body();
    const source = {
      ...riverSource,
      type: 'custom' as const,
      customMeshOverrideGuid: overrideGuid,
      flags: { affectsWaterInfo: true, affectsWaterMesh: false, affectsLandscape: false },
      collision: { type: 'none' as const, enabled: false },
    };
    const packed = await buildWaterPackOutputs(
      { [bodyKey]: source },
      {
        packageId: waterTestPackage,
        readByGuid: async () => ok(override),
      },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value[bodyKey]?.kind !== 'water-body')
      throw new Error('Custom WaterInfo fixture must cook');
    const cooked = packed.value[bodyKey];
    expect(cooked.waterInfoMeshGuid).toBeDefined();
    expect(cooked.dilatedWaterInfoMeshGuid).toBeUndefined();
    const generatedRefs = [cooked.waterInfoMeshGuid].filter(
      (guid): guid is string => typeof guid === 'string',
    );
    const entries = Object.entries(packed.value).map(([sourceKey, payload]) => ({
      guid: AssetGuid.format(AssetGuid.derive(waterTestPackage, sourceKey)),
      kind: payload.kind,
      payload,
      refs: sourceKey === bodyKey ? [materialGuid, overrideGuid, ...generatedRefs] : [],
      artifacts: {},
    }));
    entries.push(
      { guid: overrideGuid, kind: 'mesh', payload: override, refs: [], artifacts: {} },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
    );
    publishTestAssets(assets, entries);
    for (const [sourceKey, payload] of Object.entries(packed.value))
      if (payload.kind === 'mesh')
        await assets.load(AssetGuid.format(AssetGuid.derive(waterTestPackage, sourceKey)), 'mesh');
    await assets.load(overrideGuid, 'mesh');
    const bodyHandle = (
      await assets.load(AssetGuid.format(AssetGuid.derive(waterTestPackage, bodyKey)), 'water-body')
    ).unwrap();
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const snapshot = requiredFixtureValue(waterSceneSnapshot(world, entity));
      expect(snapshot.outputs.geometry).toBe('ready');
      expect(snapshot.asset.flags.affectsWaterInfo).toBe(true);
      expect(snapshot.asset.type).toBe('custom');
      expect(waterSceneWaterInfoGeometry(world, entity)).toMatchObject({
        geometryGeneration: snapshot.outputGenerations.geometry,
        undilated: { guid: cooked.waterInfoMeshGuid, mesh: { kind: 'mesh' } },
      });
      expect(waterSceneWaterInfoGeometry(world, entity)).not.toHaveProperty('dilated');
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .unsupportedCustomParticipation,
      ).not.toContain(`scene-entity:${entity}`);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('accepts valid Cooked geometry when rendering and WaterInfo request no mesh products', async () => {
    const world = new World();
    const assets = testAssets(world);
    const bodyKey = 'river/hidden-geometry';
    const { zoneGuid: _zoneGuid, ...source } = body();
    const packed = await buildWaterPackOutputs(
      {
        [bodyKey]: {
          ...source,
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { type: 'none', enabled: false },
          renderOptions: { castShadow: false, receiveShadow: false, visible: false },
        },
      },
      { packageId: waterTestPackage },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value[bodyKey]?.kind !== 'water-body')
      throw new Error('Hidden River fixture must cook');
    const cooked = packed.value[bodyKey];
    expect(cooked.riverSegmentMeshGuids).toBeUndefined();
    const bodyGuid = AssetGuid.format(AssetGuid.derive(waterTestPackage, bodyKey));
    publishTestAssets(assets, [
      { guid: bodyGuid, kind: 'water-body', payload: cooked, refs: [materialGuid], artifacts: {} },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          parameters: [{ name: 'factor', type: 'f32' }],
          values: { factor: 1 },
        },
        refs: [],
        artifacts: {},
      },
    ]);
    const bodyHandle = (await assets.load(bodyGuid, 'water-body')).unwrap();
    const materialHandle = (await assets.load(materialGuid, 'material')).unwrap();
    const read = vi.spyOn(assets, 'read');
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const snapshot = requiredFixtureValue(waterSceneSnapshot(world, entity));
      expect(snapshot.dirty.has('geometry')).toBe(false);
      expect(snapshot.outputs.geometry).toBe('ready');
      expect(snapshot.outputReceipts.geometry?.digest).toMatch(/^[0-9a-f]{64}$/);
      const material = (value: typeof snapshot) =>
        value.dependencies.find((dependency) => dependency.guid === materialGuid)
          ?.payload as MaterialAsset;
      expect(material(snapshot).values?.factor).toBe(1);
      read.mockClear();
      for (let frame = 0; frame < 3; frame++) world.update(1 / 60).unwrap();
      expect(read.mock.calls.filter(([handle]) => handle === materialHandle)).toHaveLength(0);

      assets.update(materialHandle, { values: { factor: 2 } }).unwrap();
      world.update(1 / 60).unwrap();
      const changed = waterSceneSnapshot(world, entity);
      if (!changed) throw new Error('Updated Water snapshot is missing');
      expect(material(changed).values?.factor).toBe(2);
      expect(material(snapshot).values?.factor).toBe(1);
      expect(read.mock.calls.filter(([handle]) => handle === materialHandle)).toHaveLength(1);
      read.mockClear();
      world.update(1 / 60).unwrap();
      expect(read.mock.calls.filter(([handle]) => handle === materialHandle)).toHaveLength(0);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('reports requires-recook when world-dependent Lake geometry moves from its Pack authoring transform', async () => {
    const world = new World();
    const assets = testAssets(world);
    const lakeGuid = AssetGuid.format(AssetGuid.derive(waterTestPackage, 'lake/main'));
    const lakeSource: WaterBodyAsset = {
      ...body(),
      type: 'lake',
      spline: {
        closed: true,
        points: [
          { ...requiredFixtureValue(body().spline.points[0]), inputKey: 0, positionM: [-2, 0, -2] },
          { ...requiredFixtureValue(body().spline.points[0]), inputKey: 1, positionM: [2, 0, -2] },
          { ...requiredFixtureValue(body().spline.points[0]), inputKey: 2, positionM: [2, 0, 2] },
          { ...requiredFixtureValue(body().spline.points[0]), inputKey: 3, positionM: [-2, 0, 2] },
        ],
      },
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      collision: { type: 'none', enabled: false },
      renderOptions: { castShadow: false, receiveShadow: false, visible: false },
      zoneGuid: undefined,
    };
    const authoredPosition = [1.15, 0.25, -0.7] as const;
    const authoredAngle = Math.PI / 4;
    const authoredScale = [1.15, 1.05, 0.9] as const;
    const authoredWorldMatrix = yRotationTransformMatrix(
      authoredPosition,
      authoredAngle,
      authoredScale,
    );
    const packed = await buildWaterPackOutputs(
      { 'lake/main': lakeSource },
      { packageId: waterTestPackage, bodyWorldTransformsM: { 'lake/main': authoredWorldMatrix } },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value['lake/main']?.kind !== 'water-body')
      throw new Error('Lake fixture must cook');
    publishTestAssets(assets, [
      {
        guid: lakeGuid,
        kind: 'water-body',
        payload: packed.value['lake/main'],
        refs: [materialGuid],
        artifacts: {},
      },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const lakeHandle = (await assets.load(lakeGuid, 'water-body')).unwrap();
      const entity = world
        .spawn(
          {
            component: Transform,
            data: {
              pos: authoredPosition,
              quat: [0, Math.sin(authoredAngle / 2), 0, Math.cos(authoredAngle / 2)],
              scale: authoredScale,
            },
          },
          { component: WaterBodyInstance, data: { body: lakeHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterGeometryRecookRequired,
      ).toEqual([]);
      expect(waterSceneSnapshot(world, entity)?.worldMatrixM[12]).toBeCloseTo(authoredPosition[0]);
      world
        .set(entity, Transform, {
          pos: [5, 0, 0],
          quat: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)],
          scale: [2, 3, 0.5],
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      const status = world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus;
      expect(status.waterGeometryRecookRequired).toEqual([
        expect.objectContaining({ entity, bodyGuid: lakeGuid, code: 'requires-recook' }),
      ]);
      expect(waterSceneSnapshot(world, entity)?.worldMatrixM[12]).toBeCloseTo(authoredPosition[0]);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('accepts quantized centered Ocean transform and requires recook after a materially changed pose', async () => {
    const world = new World();
    const assets = testAssets(world);
    const oceanGuid = AssetGuid.format(AssetGuid.derive(waterTestPackage, 'ocean/centered'));
    const authoredPosition = [1.15, 0.25, -0.7] as const;
    const authoredAngle = Math.PI / 4;
    const authoredScale = [1.15, 1.05, 0.9] as const;
    const authoredWorldMatrix = yRotationTransformMatrix(
      authoredPosition,
      authoredAngle,
      authoredScale,
    );
    const { zoneGuid: _zoneGuid, ...riverSource } = body();
    const oceanPoints = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ] as const;
    const oceanSource: WaterBodyAsset = {
      ...riverSource,
      type: 'ocean',
      oceanExtentM: [20, 20],
      centerOnWaterZone: true,
      spline: {
        closed: true,
        points: oceanPoints.map(([x, z], inputKey) => ({
          ...requiredFixtureValue(body().spline.points[0]),
          inputKey,
          positionM: [x, 0, z] as const,
          arriveTangentM: [0, 0, 0] as const,
          leaveTangentM: [0, 0, 0] as const,
        })),
      },
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      collision: { type: 'none', enabled: false },
      renderOptions: { castShadow: false, receiveShadow: false, visible: false },
    };
    const packed = await buildWaterPackOutputs(
      { 'ocean/centered': oceanSource },
      {
        packageId: waterTestPackage,
        bodyWorldTransformsM: { 'ocean/centered': authoredWorldMatrix },
      },
    );
    expect(packed.ok, JSON.stringify(packed.ok ? undefined : packed.error)).toBe(true);
    if (!packed.ok || packed.value['ocean/centered']?.kind !== 'water-body')
      throw new Error('Centered Ocean fixture must cook');
    publishTestAssets(assets, [
      {
        guid: oceanGuid,
        kind: 'water-body',
        payload: packed.value['ocean/centered'],
        refs: [materialGuid],
        artifacts: {},
      },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const handle = (await assets.load(oceanGuid, 'water-body')).unwrap();
      const entity = world
        .spawn(
          {
            component: Transform,
            data: {
              pos: authoredPosition,
              quat: [0, Math.sin(authoredAngle / 2), 0, Math.cos(authoredAngle / 2)],
              scale: authoredScale,
            },
          },
          { component: WaterBodyInstance, data: { body: handle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterGeometryRecookRequired,
      ).toEqual([]);
      world
        .set(entity, Transform, {
          pos: [5, 0, 0],
          quat: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)],
          scale: [2, 3, 0.5],
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterGeometryRecookRequired,
      ).toEqual([
        expect.objectContaining({ entity, bodyGuid: oceanGuid, code: 'requires-recook' }),
      ]);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('requires River recook when a curved spline is placed under a different distance metric', async () => {
    const world = new World();
    const assets = testAssets(world);
    const riverGuid = AssetGuid.format(AssetGuid.derive(waterTestPackage, 'river/curved'));
    const points = [
      { positionM: [0, 0, 0], arriveTangentM: [0, 0, 0], leaveTangentM: [10, 0, 20] },
      { positionM: [10, 0, 0], arriveTangentM: [10, 0, -8], leaveTangentM: [10, 0, 8] },
      { positionM: [20, 0, 10], arriveTangentM: [8, 0, 10], leaveTangentM: [0, 0, 0] },
    ] as const;
    const riverSource: WaterBodyAsset = {
      ...body(),
      spline: {
        closed: false,
        points: points.map((point, inputKey) => ({
          ...point,
          inputKey,
          positionM: point.positionM as readonly [number, number, number],
          arriveTangentM: point.arriveTangentM as readonly [number, number, number],
          leaveTangentM: point.leaveTangentM as readonly [number, number, number],
          up: [0, 1, 0] as const,
          rollAngle: 0,
          angleUnit: 'degrees' as const,
          widthM: 4,
          depthM: 1,
          velocityMPerSec: 0,
          audioIntensity: 0,
        })),
      },
    };
    const authoredScale = [1.15, 1.05, 0.9] as const;
    const authoredWorldMatrix = [
      authoredScale[0],
      0,
      0,
      0,
      0,
      authoredScale[1],
      0,
      0,
      0,
      0,
      authoredScale[2],
      0,
      0,
      0,
      0,
      1,
    ] as const;
    const packed = await buildWaterPackOutputs(
      { 'river/curved': riverSource },
      {
        packageId: waterTestPackage,
        bodyWorldTransformsM: { 'river/curved': authoredWorldMatrix },
      },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value['river/curved']?.kind !== 'water-body')
      throw new Error('Curved River fixture must cook');
    expect(packed.value['river/curved'].geometryAuthoringWorldMatrixM).toEqual(authoredWorldMatrix);
    publishTestAssets(assets, [
      {
        guid: riverGuid,
        kind: 'water-body',
        payload: packed.value['river/curved'],
        refs: [materialGuid, zoneGuid],
        artifacts: {},
      },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const handle = (await assets.load(riverGuid, 'water-body')).unwrap();
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], scale: authoredScale } },
          { component: WaterBodyInstance, data: { body: handle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(
        (world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus)
          .waterGeometryRecookRequired,
      ).toEqual([]);
      world.set(entity, Transform, { pos: [0, 0, 0], scale: [10, 1, 1] }).unwrap();
      world.update(1 / 60).unwrap();
      const status = world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus;
      expect(status.waterGeometryRecookRequired).toEqual([
        expect.objectContaining({ entity, bodyGuid: riverGuid, code: 'requires-recook' }),
      ]);
      expect(waterSceneSnapshot(world, entity)?.worldMatrixM[0]).toBeCloseTo(authoredScale[0]);

      const parent = world
        .spawn({ component: Transform, data: { pos: [0, 0, 0], scale: [2, 1, 1] } })
        .unwrap();
      const shearedEntity = world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 0], quat: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] },
          },
          { component: ChildOf, data: { parent } },
          { component: WaterBodyInstance, data: { body: handle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const shearStatus = world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus;
      expect(shearStatus.waterGeometryRecookRequired).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entity: shearedEntity,
            bodyGuid: riverGuid,
            code: 'requires-recook',
          }),
        ]),
      );
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('mounts, hot-reloads and unmounts bodies from Scene component instances', async () => {
    const world = new World();
    const assets = testAssets(world);
    const physics = await createWaterPhysics();
    const cookedRiver = await cookedBody({ ...body(), surfaceMaterialGuid: childMaterialGuid });
    world.insertResource(PhysicsWorldResource, physics);
    publishTestAssets(assets, [
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: childMaterialGuid,
        kind: 'material',
        payload: { kind: 'material', parent: materialGuid, values: { roughness: 0.2 } },
        refs: [materialGuid],
        artifacts: {},
      },
      {
        guid: bodyGuid,
        kind: 'water-body',
        payload: cookedRiver,
        refs: [childMaterialGuid, zoneGuid],
        artifacts: {},
      },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const bodyHandle = (await assets.load(bodyGuid, 'water-body')).unwrap();
      const zoneHandle = (await assets.load(zoneGuid, 'water-zone')).unwrap();
      await assets.load(materialGuid, 'material');
      await assets.load(childMaterialGuid, 'material');
      const bodyEntity = world
        .spawn(
          { component: Transform, data: { pos: [10, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      const secondBodyEntity = world
        .spawn(
          { component: Transform, data: { pos: [25, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      const pose = (x: number) => ({
        position: { x, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      });
      physics.ensureBody(bodyEntity, pose(10), staticBody, undefined);
      physics.ensureBody(secondBodyEntity, pose(25), staticBody, undefined);
      admitRiverCollider(physics, bodyEntity, body(), 1);
      admitRiverCollider(physics, secondBodyEntity, body(), 1);
      const acceptedPhysicsPublication = requiredFixtureValue(
        physics.getDerivedPublication(bodyEntity),
      );
      expect(physics.getDerivedCollisionReceipt(bodyEntity)).toMatchObject({
        publication: acceptedPhysicsPublication,
        shapes: [{ kind: 'convex-compound', id: 'water-river' }],
      });
      const zoneEntity = world
        .spawn(
          { component: Transform, data: { pos: [3, 0, -4] } },
          { component: WaterZoneInstance, data: { zone: zoneHandle } },
        )
        .unwrap();
      const exclusionEntity = world
        .spawn(
          { component: Transform, data: { pos: [10, 1, 0] } },
          {
            component: WaterExclusionVolume,
            data: { centerM: [1, 0, 0], halfExtentsM: [2, 1, 3] },
          },
        )
        .unwrap();

      world.update(1 / 60).unwrap();
      const water = world.getResource(
        WATER_SYSTEM_RESOURCE,
      ) as import('@forgeax/engine-water').WaterSystem;
      const status = world.getResource(WATER_SCENE_STATUS_RESOURCE) as WaterSceneStatus;
      const firstSnapshots = water
        .snapshots()
        .filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid);
      expect(firstSnapshots).toHaveLength(2);
      expect(
        firstSnapshots.every(
          (snapshot) => snapshot.dirty.has('geometry') && snapshot.outputs.geometry !== 'ready',
        ),
      ).toBe(true);
      const firstQuery = requiredFixtureValue(waterSceneSnapshot(world, bodyEntity));
      const secondQuery = requiredFixtureValue(waterSceneSnapshot(world, secondBodyEntity));
      expect(firstQuery.outputs.query).toBe('ready');
      expect(secondQuery.outputs.query).toBe('ready');
      expect(firstQuery.outputReceipts.query?.outputGeneration).toBe(
        firstQuery.outputGenerations.query,
      );
      expect(secondQuery.outputReceipts.query?.outputGeneration).toBe(
        secondQuery.outputGenerations.query,
      );
      expect(firstQuery.outputReceipts.query?.digest).not.toBe(
        secondQuery.outputReceipts.query?.digest,
      );
      const secondQueryReceipt = requiredFixtureValue(secondQuery.outputReceipts.query);
      expect(waterSceneSnapshot(world, bodyEntity)?.exclusionVolumes).toHaveLength(1);
      expect(waterSceneSnapshot(world, secondBodyEntity)?.exclusionVolumes).toHaveLength(0);
      expect(waterSceneSnapshot(world, bodyEntity)?.exclusionVolumes[0]?.worldMatrixM[12]).toBe(10);
      const adoptedPublication = assets.source(bodyHandle).unwrap()?.publication;
      expect(adoptedPublication).toBeDefined();
      expect(requiredFixtureValue(firstSnapshots[0]).sourcePublication).toMatchObject({
        sourceRevision: requiredFixtureValue(adoptedPublication).sourceRevision,
        generation: requiredFixtureValue(adoptedPublication).generation,
        digest: requiredFixtureValue(adoptedPublication).digest,
        outputSetDigest: requiredFixtureValue(adoptedPublication).outputSetDigest,
      });
      const fixedSceneSnapshot = requiredFixtureValue(waterSceneSnapshot(world, bodyEntity));
      expect(fixedSceneSnapshot.sourcePublication).toEqual(
        requiredFixtureValue(firstSnapshots[0]).sourcePublication,
      );
      expect(firstSnapshots.every((snapshot) => snapshot.binding.kind === 'bound')).toBe(true);
      expect(
        firstSnapshots
          .map((snapshot) => snapshot.worldMatrixM[12])
          .sort((a, b) => requiredFixtureValue(a) - requiredFixtureValue(b)),
      ).toEqual([10, 25]);
      for (const snapshot of firstSnapshots)
        water.clearDirty(snapshot.guid, [
          'geometry',
          'waterInfo',
          'waterMesh',
          'terrainBrush',
          'collision',
          'query',
          'material',
        ]);
      world
        .set(exclusionEntity, WaterExclusionVolume, {
          waterBodies: [bodyEntity],
          mode: WaterExclusionMode.removeListedBodiesFromExclusion,
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(waterSceneSnapshot(world, bodyEntity)?.exclusionVolumes).toHaveLength(0);
      expect(waterSceneSnapshot(world, secondBodyEntity)?.exclusionVolumes).toHaveLength(0);
      expect(waterSceneSnapshot(world, bodyEntity)?.outputs.query).toBe('ready');
      expect(waterSceneSnapshot(world, bodyEntity)?.outputReceipts.query?.outputGeneration).toBe(
        waterSceneSnapshot(world, bodyEntity)?.outputGenerations.query,
      );
      expect(waterSceneSnapshot(world, bodyEntity)?.outputReceipts.query?.digest).not.toBe(
        firstQuery.outputReceipts.query?.digest,
      );
      expect(waterSceneSnapshot(world, secondBodyEntity)?.outputReceipts.query?.digest).toBe(
        secondQueryReceipt.digest,
      );
      world
        .set(exclusionEntity, WaterExclusionVolume, {
          waterBodies: [],
          mode: WaterExclusionMode.removeListedBodiesFromExclusion,
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      world.set(exclusionEntity, Transform, { pos: [12, 1, -1] }).unwrap();
      world.update(1 / 60).unwrap();
      const exclusionUpdated = requiredFixtureValue(waterSceneSnapshot(world, bodyEntity));
      expect(exclusionUpdated.exclusionVolumes[0]).toMatchObject({
        entity: exclusionEntity,
        centerM: [1, 0, 0],
        halfExtentsM: [2, 1, 3],
        worldMatrixM: expect.arrayContaining([expect.any(Number)]),
      });
      expect(exclusionUpdated.exclusionVolumes[0]?.worldMatrixM.slice(12, 15)).toEqual([12, 1, -1]);
      expect(exclusionUpdated.outputs.query).toBe('ready');
      expect(exclusionUpdated.dirty.has('query')).toBe(false);
      expect(exclusionUpdated.outputReceipts.query?.outputGeneration).toBe(
        exclusionUpdated.outputGenerations.query,
      );
      for (const snapshot of water.snapshots()) water.clearDirty(snapshot.guid, ['query']);
      expect(
        water.materialStatuses(requiredFixtureValue(firstSnapshots[0]).guid, (guid) =>
          registryWaterMaterialReference(assets, guid),
        ),
      ).toMatchObject([
        {
          slot: 'surface',
          guid: childMaterialGuid,
          reference: 'valid',
          material: { form: 'child', passes: ['main'] },
          waterAbi: 'unsupported',
        },
      ]);
      expect(registryWaterMaterialReference(assets, materialGuid)).toMatchObject({
        kind: 'valid',
        asset: { passes: [{ name: 'main' }] },
      });
      expect(registryWaterMaterialReference(assets, childMaterialGuid)).toMatchObject({
        kind: 'valid',
        asset: { parent: materialGuid, passes: [{ name: 'main' }] },
      });
      const boundGeneration =
        requiredFixtureValue(firstSnapshots[0]).binding.kind === 'bound'
          ? requiredFixtureValue(firstSnapshots[0]).binding.zoneGeneration
          : -1;
      const movedInstance = requiredValue(
        firstSnapshots.find((snapshot) => snapshot.worldMatrixM[12] === 10),
        'moved zone instance',
      );
      water.bindZoneIndex(movedInstance.guid, zoneGuid, boundGeneration, 13).unwrap();
      expect(requiredFixtureValue(firstSnapshots[0]).binding).toMatchObject({
        worldMatrixM: expect.arrayContaining([expect.any(Number)]),
      });
      expect(
        requiredFixtureValue(firstSnapshots[0]).binding.kind === 'bound'
          ? requiredFixtureValue(firstSnapshots[0]).binding.worldMatrixM[12]
          : -1,
      ).toBe(3);
      world.set(zoneEntity, Transform, { pos: [8, 0, 2] }).unwrap();
      world.update(1 / 60).unwrap();
      const movedZoneSnapshots = water
        .snapshots()
        .filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid);
      const movedZoneGeneration =
        requiredFixtureValue(movedZoneSnapshots[0]).binding.kind === 'bound'
          ? requiredFixtureValue(movedZoneSnapshots[0]).binding.zoneGeneration
          : -1;
      expect(waterSceneZoneSnapshot(world, zoneGuid)).toMatchObject({
        sourceRevision: assets.revision(zoneHandle).unwrap(),
        generation: movedZoneGeneration,
      });
      expect(movedZoneGeneration).toBeGreaterThan(boundGeneration);
      expect(
        requiredFixtureValue(movedZoneSnapshots[0]).binding.kind === 'bound'
          ? requiredFixtureValue(movedZoneSnapshots[0]).binding.worldMatrixM.slice(12, 15)
          : [],
      ).toEqual([8, 0, 2]);
      expect(water.zoneIndex(movedInstance.guid, zoneGuid, boundGeneration)).toBeUndefined();
      reconcileWaterScene(
        world,
        { sourceGuid: () => zoneGuid, version: () => 1, read: () => zone },
        water,
        status,
        () => [Number.NaN],
      );
      expect(status.invalidZoneTransforms).toEqual([`scene-entity:${zoneEntity}`]);
      const acceptedAfterInvalidZone = requiredFixtureValue(water.snapshot(movedInstance.guid));
      expect(acceptedAfterInvalidZone.binding).toMatchObject({
        kind: 'bound',
        zoneGeneration: movedZoneGeneration,
        worldMatrixM: expect.any(Array),
      });
      expect(
        acceptedAfterInvalidZone.binding.kind === 'bound'
          ? acceptedAfterInvalidZone.binding.worldMatrixM[12]
          : -1,
      ).toBe(8);
      expect([...acceptedAfterInvalidZone.dirty].sort()).toEqual(['waterInfo', 'waterMesh']);
      reconcileWaterScene(
        world,
        {
          sourceGuid: () => bodyGuid,
          version: () => Number(requiredFixtureValue(firstSnapshots[0]).sourceVersion),
          read: () => body(),
        },
        water,
        status,
        (entity) =>
          entity === bodyEntity
            ? [Number.NaN]
            : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, entity === secondBodyEntity ? 25 : 0, 0, 0, 1],
      );
      expect(status.invalidBodyTransforms).toEqual([`scene-entity:${bodyEntity}`]);
      expect(water.snapshot(`scene-entity:${bodyEntity}`)?.worldMatrixM[12]).toBe(10);
      world.update(1 / 60).unwrap();
      expect(status.invalidZoneTransforms).toEqual([]);
      const first = requiredFixtureValue(firstSnapshots[0]);
      expect(first?.sourceVersion).toMatch(/^\d+$/);
      for (const snapshot of firstSnapshots)
        water.clearDirty(snapshot.guid, [
          'geometry',
          'waterInfo',
          'waterMesh',
          'collision',
          'query',
        ]);
      world.set(bodyEntity, Transform, { pos: [12, 0, 0] }).unwrap();
      world.update(1 / 60).unwrap();
      const moved = water.snapshots().filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid);
      const movedSnapshot = requiredFixtureValue(
        moved.find((snapshot) => snapshot.worldMatrixM[12] === 12),
      );
      expect(movedSnapshot.dirty.has('geometry')).toBe(true);
      expect(movedSnapshot.sceneGeneration).toBeGreaterThan(movedInstance.sceneGeneration);
      expect(water.zoneIndex(movedSnapshot.guid, zoneGuid, boundGeneration)).toBeUndefined();
      expect(water.updateInstanceTransform(movedSnapshot.guid, [Number.NaN])).toMatchObject({
        ok: false,
        error: { code: 'invalid-source' },
      });
      expect(waterSceneSnapshot(world, bodyEntity)?.exclusionVolumes).toHaveLength(1);
      world.set(bodyEntity, Transform, { pos: [100, 0, 0] }).unwrap();
      world.update(1 / 60).unwrap();
      expect(waterSceneSnapshot(world, bodyEntity)?.exclusionVolumes).toHaveLength(0);
      world.set(bodyEntity, Transform, { pos: [12, 0, 0] }).unwrap();
      world.update(1 / 60).unwrap();
      expect(waterSceneSnapshot(world, bodyEntity)?.exclusionVolumes).toHaveLength(1);

      const access: WaterSceneAssetAccess = {
        sourceGuid: () => bodyGuid,
        version: () => undefined,
        read: () => undefined,
      };
      reconcileWaterScene(world, access, water, status);
      expect(
        water.snapshots().filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid),
      ).toHaveLength(2);
      reconcileWaterScene(world, { ...access, version: () => 999 }, water, status);
      expect(
        water
          .snapshots()
          .filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid)
          .every((snapshot) => snapshot.sourceVersion === first.sourceVersion),
      ).toBe(true);

      const duplicateZone = world
        .spawn({ component: WaterZoneInstance, data: { zone: zoneHandle } })
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(status.duplicateZoneAssetGuids).toEqual([zoneGuid]);
      expect(
        water
          .snapshots()
          .filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid)
          .every((snapshot) => snapshot.binding.kind === 'zone-unbound'),
      ).toBe(true);
      world.despawn(duplicateZone).unwrap();
      world.update(1 / 60).unwrap();
      expect(status.duplicateZoneAssetGuids).toEqual([]);
      expect(
        water
          .snapshots()
          .filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid)
          .every((snapshot) => snapshot.binding.kind === 'bound'),
      ).toBe(true);

      const beforeZoneRemount = requiredFixtureValue(water.snapshot(movedInstance.guid));
      const priorZoneGeneration =
        beforeZoneRemount.binding.kind === 'bound' ? beforeZoneRemount.binding.zoneGeneration : -1;
      water.bindZoneIndex(movedInstance.guid, zoneGuid, priorZoneGeneration, 13).unwrap();
      for (const snapshot of water.snapshots())
        water.clearDirty(snapshot.guid, [
          'geometry',
          'waterInfo',
          'waterMesh',
          'terrainBrush',
          'collision',
          'query',
          'material',
        ]);
      const retiringViewId = 'camera:zone-unload';
      const retiringZone = water.zoneSnapshots().find((snapshot) => snapshot.guid === zoneGuid);
      if (retiringZone === undefined) throw new Error('Zone unload fixture lost its accepted Zone');
      expect(
        water.buildZoneMeshView(zoneGuid, retiringZone.generation, retiringZone.asset, {
          viewId: retiringViewId,
          observerM: [0, 4, 0],
        }).ok,
      ).toBe(true);
      expect(water.waterMeshCandidateViews(retiringViewId)).toHaveLength(1);
      world.despawn(zoneEntity).unwrap();
      world.update(1 / 60).unwrap();
      expect(water.waterMeshCandidateViews(retiringViewId)).toEqual([]);
      expect(water.snapshot(movedInstance.guid)?.binding.kind).toBe('zone-unbound');
      expect([...requiredFixtureValue(water.snapshot(movedInstance.guid)).dirty].sort()).toEqual([
        'waterInfo',
        'waterMesh',
      ]);
      for (const snapshot of water.snapshots())
        water.clearDirty(snapshot.guid, [
          'geometry',
          'waterInfo',
          'waterMesh',
          'terrainBrush',
          'collision',
          'query',
          'material',
        ]);
      const remountedZoneEntity = world
        .spawn(
          { component: Transform, data: { pos: [8, 0, 2] } },
          { component: WaterZoneInstance, data: { zone: zoneHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const afterZoneRemount = requiredFixtureValue(water.snapshot(movedInstance.guid));
      const remountedZoneGeneration =
        afterZoneRemount.binding.kind === 'bound' ? afterZoneRemount.binding.zoneGeneration : -1;
      expect(remountedZoneGeneration).toBeGreaterThan(priorZoneGeneration);
      expect([...afterZoneRemount.dirty].sort()).toEqual(['waterInfo', 'waterMesh']);
      water.bindZoneIndex(movedInstance.guid, zoneGuid, remountedZoneGeneration, 13).unwrap();
      expect(water.zoneIndex(movedInstance.guid, zoneGuid, remountedZoneGeneration)).toBe(13);
      expect(water.zoneIndex(movedInstance.guid, zoneGuid, priorZoneGeneration)).toBeUndefined();
      world.despawn(remountedZoneEntity).unwrap();
      const activeZoneEntity = world
        .spawn(
          { component: Transform, data: { pos: [8, 0, 2] } },
          { component: WaterZoneInstance, data: { zone: zoneHandle } },
        )
        .unwrap();
      world.update(1 / 60).unwrap();

      const movedSource = {
        ...body(),
        spline: {
          ...body().spline,
          points: body().spline.points.map((point) => ({
            ...point,
            positionM: [point.positionM[0], point.positionM[1], point.positionM[2] + 100] as const,
          })),
        },
      };
      expect(buildWaterBodyGeometry(movedSource).ok).toBe(true);
      const movedCook = await cookedBody(movedSource);
      const movedGeometry = buildWaterBodyGeometry(movedSource).unwrap();
      physics.step(1 / 60);
      const acceptedCurrentPublication = requiredFixtureValue(
        physics.getDerivedPublication(bodyEntity),
      );
      expect(physics.getDerivedCollisionReceipt(bodyEntity)?.publication).toBe(
        acceptedCurrentPublication,
      );
      const movedInput = buildRiverPhysicsCandidateInput({
        entity: bodyEntity,
        sourceKey: `water:scene-entity:${bodyEntity}`,
        revision: acceptedCurrentPublication.revision + 1,
        segments: movedGeometry.riverSegments,
      }).unwrap();
      const movedCandidate = physics.prepareDerivedShapeCandidate(movedInput).unwrap();
      physics.admitDerivedShapeCandidatesGuarded([movedCandidate], () => false).unwrap();
      physics.step(1 / 60);
      expect(physics.getDerivedPublication(bodyEntity)).toBe(acceptedCurrentPublication);
      expect(physics.getDerivedCollisionReceipt(bodyEntity)?.publication).toBe(
        acceptedCurrentPublication,
      );
      expect(assets.replace(bodyHandle, movedCook as Asset).ok).toBe(true);
      world.update(1 / 60).unwrap();
      expect(waterSceneSnapshot(world, bodyEntity)?.asset.spline.points[0]?.positionM[2]).toBe(100);
      expect(waterSceneSnapshot(world, bodyEntity)?.exclusionVolumes).toHaveLength(0);
      expect(physics.getDerivedCollisionReceipt(bodyEntity)?.publication).toBe(
        acceptedCurrentPublication,
      );
      expect(assets.replace(bodyHandle, (await cookedBody(body())) as Asset).ok).toBe(true);
      world.update(1 / 60).unwrap();
      const acceptedSourceVersion = requiredFixtureValue(
        water.snapshot(`scene-entity:${bodyEntity}`),
      ).sourceVersion;

      const rejected = assets.replace(bodyHandle, { ...body(), baseHeightM: Number.NaN } as Asset);
      expect(rejected.ok).toBe(false);
      world.update(1 / 60).unwrap();
      expect(
        water
          .snapshots()
          .filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid)
          .every(
            (snapshot) =>
              snapshot.sourceVersion === acceptedSourceVersion && snapshot.asset.baseHeightM === 0,
          ),
      ).toBe(true);

      const replaced = assets.replace(
        bodyHandle,
        (await cookedBody({ ...body(), baseHeightM: 1 })) as Asset,
      );
      expect(replaced.ok).toBe(true);
      world.update(1 / 60).unwrap();
      expect(
        water
          .snapshots()
          .filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid)
          .every(
            (snapshot) =>
              snapshot.sourceVersion !== first.sourceVersion && snapshot.asset.baseHeightM === 1,
          ),
      ).toBe(true);
      expect(waterSceneSnapshot(world, bodyEntity)?.sourcePublication).toEqual(
        adoptedPublication && {
          sourceRevision: adoptedPublication.sourceRevision,
          generation: adoptedPublication.generation,
          digest: adoptedPublication.digest,
          outputSetDigest: adoptedPublication.outputSetDigest,
        },
      );

      world.despawn(bodyEntity).unwrap();
      world.update(1 / 60).unwrap();
      const remaining = water
        .snapshots()
        .filter((snapshot) => snapshot.sourceAssetGuid === bodyGuid);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.asset.baseHeightM).toBe(1);
      const secondReceipt = physics.getDerivedCollisionReceipt(secondBodyEntity);
      expect(secondReceipt?.shapes.length).toBeGreaterThan(0);
      const prepareCandidate = physics.prepareDerivedShapeCandidate.bind(physics);
      let failRetirementOnce = true;
      physics.prepareDerivedShapeCandidate = (input) => {
        if (failRetirementOnce && input.entity === secondBodyEntity && input.shapes.length === 0) {
          failRetirementOnce = false;
          return {
            ok: false,
            error: new DerivedPhysicsError(
              'derived-candidate-invalid',
              'injected retirement preparation failure',
              'retry the pending retirement',
              { entity: secondBodyEntity, reason: 'test injection' },
            ),
          };
        }
        return prepareCandidate(input);
      };
      world.removeComponent(secondBodyEntity, WaterBodyInstance).unwrap();
      world.update(0).unwrap();
      expect(failRetirementOnce).toBe(true);
      expect(physics.getDerivedCollisionReceipt(secondBodyEntity)).toBe(secondReceipt);
      expect(
        status.waterCollisionFailures.some(
          (failure) => failure.entity === secondBodyEntity && failure.stage === 'retire',
        ),
      ).toBe(false);
      world.update(1 / 60).unwrap();
      expect(
        status.waterCollisionFailures.some(
          (failure) => failure.entity === secondBodyEntity && failure.stage === 'retire',
        ),
      ).toBe(true);
      expect(
        status.waterCollisionFailures.find((failure) => failure.entity === secondBodyEntity),
      ).toMatchObject({
        code: 'derived-candidate-invalid',
        expected: 'injected retirement preparation failure',
        hint: 'retry the pending retirement',
        detail: {
          code: 'derived-candidate-invalid',
          entity: secondBodyEntity,
          reason: 'test injection',
        },
      });
      expect(physics.getDerivedCollisionReceipt(secondBodyEntity)?.shapes.length).toBeGreaterThan(
        0,
      );
      physics.prepareDerivedShapeCandidate = prepareCandidate;
      world.update(1 / 60).unwrap();
      physics.step(1 / 60);
      world.update(1 / 60).unwrap();
      const retiredReceipt = physics.getDerivedCollisionReceipt(secondBodyEntity);
      expect(
        status.waterCollisionFailures.some((failure) => failure.entity === secondBodyEntity),
      ).toBe(false);
      expect(retiredReceipt?.publication.revision).toBeGreaterThan(
        requiredFixtureValue(secondReceipt).publication.revision,
      );
      expect(retiredReceipt?.shapes).toEqual([]);
      world
        .addComponent(secondBodyEntity, {
          component: WaterBodyInstance,
          data: { body: bodyHandle },
        })
        .unwrap();
      world.update(0).unwrap();
      expect(physics.getDerivedCollisionReceipt(secondBodyEntity)).toBe(retiredReceipt);
      world.update(1 / 60).unwrap();
      expect(physics.getDerivedCollisionReceipt(secondBodyEntity)).toBe(retiredReceipt);
      physics.step(1 / 60);
      world.update(1 / 60).unwrap();
      expect(physics.getDerivedCollisionReceipt(secondBodyEntity)?.shapes.length).toBeGreaterThan(
        0,
      );
      world.despawn(secondBodyEntity).unwrap();
      world.update(1 / 60).unwrap();
      expect(water.snapshots()).toHaveLength(0);
      world.despawn(activeZoneEntity).unwrap();
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
      physics.dispose();
    }
  });

  it('mounts and retires water collision through the ordinary physics component lifecycle', async () => {
    const world = new World();
    const assets = testAssets(world);
    publishTestAssets(assets, [
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: bodyGuid,
        kind: 'water-body',
        payload: await cookedBody(body()),
        refs: [materialGuid, zoneGuid],
        artifacts: {},
      },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, physics3d]);
    const waterFiber = ctx.plugin(waterScenePlugin());
    await waterFiber;
    const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
    const advance = (frames = 1) => {
      for (let frame = 0; frame < frames; frame++) world.update(1 / 60).unwrap();
    };
    try {
      const handle = (await assets.load(bodyGuid, 'water-body')).unwrap();
      const entity = world
        .spawn({ component: Transform }, { component: WaterBodyInstance, data: { body: handle } })
        .unwrap();
      const shared = world
        .spawn(
          { component: Transform, data: { pos: [20, 0, 0] } },
          {
            component: RigidBody,
            data: { type: RigidBodyTypeValue.kinematic, mass: 4, linearDamping: 0.25 },
          },
          { component: Collider, data: {} },
          { component: WaterBodyInstance, data: { body: handle } },
        )
        .unwrap();
      const authoredBody = { ...world.get(shared, RigidBody).unwrap() };
      const authoredCollider = { ...world.get(shared, Collider).unwrap() };
      const status = world.getResource<WaterSceneStatus>(WATER_SCENE_STATUS_RESOURCE);
      advance();
      expect(world.hasComponent(entity, RigidBody)).toBe(true);
      expect(physics.hasBody(entity)).toBe(false);
      expect(waterSceneSnapshot(world, entity)?.outputs.collision).not.toBe('ready');
      expect(physics.getDerivedCollisionReceipt?.(entity)).toBeUndefined();
      expect(status.waterCollisionFailures).toEqual([]);
      advance(3);
      expect(physics.hasBody(entity)).toBe(true);
      expect(waterSceneSnapshot(world, entity)?.outputs.collision).toBe('ready');
      const live = requiredFixtureValue(physics.getDerivedCollisionReceipt?.(entity));
      expect(live.shapes.length).toBeGreaterThan(0);
      expect(physics.getDerivedCollisionReceipt?.(shared)?.shapes.length).toBeGreaterThan(0);
      expect(physics.getDerivedBodyType?.(shared)).toBe('kinematic');
      expect(physics.raycast(vec3.create(20, 3, 0), vec3.create(0, -1, 0), 4)?.entity).toBe(shared);
      expect(physics.getDerivedCollisionReceipt?.(shared)?.sourceTransform).toBeUndefined();
      expect(physics.getDerivedCollisionReceipt?.(entity)?.sourceTransform).toBeDefined();
      expect(waterSceneSnapshot(world, shared)?.outputs.collision).toBe('ready');
      const sharedReceipt = physics.getDerivedCollisionReceipt?.(shared);
      advance(2);
      expect(physics.getDerivedCollisionReceipt?.(shared)).toBe(sharedReceipt);
      world.set(shared, Transform, { pos: [24, 0, 0] }).unwrap();
      advance(4);
      expect(physics.getDerivedBodyType?.(shared)).toBe('kinematic');
      expect(waterSceneSnapshot(world, shared)?.worldMatrixM[12]).toBe(24);
      expect(waterSceneSnapshot(world, shared)?.outputs.collision).toBe('ready');
      expect(physics.getDerivedCollisionReceipt?.(shared)?.sourceTransform).toBeUndefined();
      expect(physics.raycast(vec3.create(24, 3, 0), vec3.create(0, -1, 0), 4)?.entity).toBe(shared);
      world.set(shared, Transform, { pos: [20, 0, 0] }).unwrap();
      advance(4);

      const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      const captureSnapshot = water.snapshot.bind(water);
      let collisionSourceReads = 0;
      const snapshotSpy = vi.spyOn(water, 'snapshot').mockImplementation((guid) => {
        const snapshot = captureSnapshot(guid);
        if (!snapshot || guid !== `scene-entity:${entity}`) return snapshot;
        return {
          ...snapshot,
          get asset() {
            collisionSourceReads++;
            return snapshot.asset;
          },
        };
      });
      try {
        for (let tick = 0; tick < 20; tick++) reconcileWaterSceneCollisions(world, water, status);
        expect(collisionSourceReads).toBe(0);
        expect(physics.getDerivedCollisionReceipt?.(entity)).toEqual(live);

        assert(physics.prepareDerivedShapeCandidate);
        const displaced = physics.prepareDerivedShapeCandidate({
          entity,
          sourceKey: live.sourceKey,
          revision: live.publication.revision,
          inputDigest: 'external-water-collision-replacement',
          shapes: [],
        });
        expect(displaced).toMatchObject({
          ok: false,
          error: { code: 'derived-candidate-stale' },
        });
        physics.removeEntity(entity);
        expect(physics.getDerivedCollisionReceipt?.(entity)).toBeUndefined();
        expect(physics.hasBody(entity)).toBe(false);
        reconcileWaterSceneCollisions(world, water, status);
        expect(collisionSourceReads).toBeGreaterThan(0);
        physics.ensureBody(
          entity,
          {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
          },
          staticBody,
          undefined,
        );
      } finally {
        snapshotSpy.mockRestore();
      }
      advance(3);
      expect(physics.getDerivedCollisionReceipt?.(entity)?.publication.inputDigest).toBe(
        live.publication.inputDigest,
      );
      expect(physics.hasBody(entity)).toBe(true);
      expect(physics.getDerivedCollisionReceipt?.(entity)?.publication.shapeIds).toEqual(
        live.publication.shapeIds,
      );

      const prepare = requiredFixtureValue(physics.prepareDerivedShapeCandidate).bind(physics);
      physics.prepareDerivedShapeCandidate = (input) =>
        input.entity === entity && input.shapes.length === 0
          ? {
              ok: false,
              error: new DerivedPhysicsError(
                'derived-candidate-invalid',
                'injected retirement preparation failure',
                'retry the pending retirement',
                { entity, reason: 'test injection' },
              ),
            }
          : prepare(input);
      world.removeComponent(entity, WaterBodyInstance).unwrap();
      advance(2);
      expect(status.waterCollisionFailures).toEqual([
        expect.objectContaining({ entity, stage: 'retire' }),
      ]);
      expect(world.hasComponent(entity, RigidBody)).toBe(true);
      expect(physics.getDerivedCollisionReceipt?.(entity)?.publication.revision).toBe(
        live.publication.revision,
      );
      physics.prepareDerivedShapeCandidate = prepare;
      advance(3);
      expect(world.hasComponent(entity, RigidBody)).toBe(false);
      expect(physics.hasBody(entity)).toBe(false);
      expect(status.waterCollisionFailures).toEqual([]);

      world.addComponent(entity, { component: WaterBodyInstance, data: { body: handle } }).unwrap();
      advance(4);
      expect(waterSceneSnapshot(world, entity)?.outputs.collision).toBe('ready');
      world.set(entity, RigidBody, { mass: 3 }).unwrap();
      world.removeComponent(entity, WaterBodyInstance).unwrap();
      advance(3);
      expect(world.get(entity, RigidBody).unwrap().mass).toBe(3);
      expect(physics.hasBody(entity)).toBe(true);
      world.removeComponent(entity, RigidBody).unwrap();
      advance();
      world.addComponent(entity, { component: WaterBodyInstance, data: { body: handle } }).unwrap();
      advance(4);
      await waterFiber.ctx.fiber.dispose();
      expect(world.hasComponent(entity, RigidBody)).toBe(false);
      expect(physics.getDerivedCollisionReceipt?.(shared)).toBeUndefined();
      expect(world.hasResource(WATER_SYSTEM_RESOURCE)).toBe(false);
      advance(3);
      expect(world.hasComponent(entity, RigidBody)).toBe(false);
      expect(physics.hasBody(entity)).toBe(false);
      expect(world.get(shared, RigidBody).unwrap()).toEqual(authoredBody);
      expect(world.get(shared, Collider).unwrap()).toEqual(authoredCollider);
      expect(physics.hasBody(shared)).toBe(true);
      expect(physics.getDerivedBodyType?.(shared)).toBe('kinematic');
      expect(physics.getDerivedCollisionReceipt?.(shared)).toBeUndefined();
      expect(physics.raycast(vec3.create(20, 3, 0), vec3.create(0, -1, 0), 4)?.entity).toBe(shared);
      expect(world.hasResource(WATER_SYSTEM_RESOURCE)).toBe(false);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('retires the live water collision receipt when the plugin is disposed', async () => {
    const world = new World();
    const assets = testAssets(world);
    const physics = await createWaterPhysics();
    world.insertResource(PhysicsWorldResource, physics);
    publishTestAssets(assets, [
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: bodyGuid,
        kind: 'water-body',
        payload: await cookedBody(body()),
        refs: [materialGuid, zoneGuid],
        artifacts: {},
      },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const bodyHandle = (await assets.load(bodyGuid, 'water-body')).unwrap();
      const entity = world
        .spawn(
          { component: Transform },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      const otherEntity = world
        .spawn(
          { component: Transform, data: { pos: [10, 0, 0] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      physics.ensureBody(
        entity,
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        staticBody,
        undefined,
      );
      physics.ensureBody(
        otherEntity,
        {
          position: { x: 10, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        staticBody,
        undefined,
      );
      world.update(0).unwrap();
      expect(physics.getDerivedCollisionReceipt(entity)).toBeUndefined();
      expect(physics.getDerivedCollisionReceipt(otherEntity)).toBeUndefined();
      world.update(1 / 60).unwrap();
      expect(physics.getDerivedCollisionReceipt(entity)).toBeUndefined();
      expect(physics.getDerivedCollisionReceipt(otherEntity)).toBeUndefined();
      physics.step(1 / 60);
      world.update(1 / 60).unwrap();
      const liveReceipt = requiredFixtureValue(physics.getDerivedCollisionReceipt(entity));
      const otherLiveReceipt = requiredFixtureValue(
        physics.getDerivedCollisionReceipt(otherEntity),
      );
      expect(liveReceipt.sourceKey).toBe(`water:scene-entity:${entity}`);
      expect(liveReceipt.shapes.length).toBeGreaterThan(0);
      expect(otherLiveReceipt.shapes.length).toBeGreaterThan(0);

      const prepareCandidate = physics.prepareDerivedShapeCandidate.bind(physics);
      physics.prepareDerivedShapeCandidate = (input) => {
        if (input.entity === entity && input.shapes.length === 0) {
          return {
            ok: false,
            error: new DerivedPhysicsError(
              'derived-candidate-invalid',
              'injected retirement preparation failure',
              'retry the pending retirement',
              { entity, reason: 'test injection' },
            ),
          };
        }
        return prepareCandidate(input);
      };
      world.removeComponent(entity, WaterBodyInstance).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.getResource(WATER_SYSTEM_RESOURCE)).toBeDefined();
      expect(
        (
          world.getResource(WATER_SYSTEM_RESOURCE) as import('@forgeax/engine-water').WaterSystem
        ).snapshot(`scene-entity:${entity}`),
      ).toBeUndefined();
      expect(physics.getDerivedCollisionReceipt(entity)?.shapes.length).toBeGreaterThan(0);
      expect(physics.getDerivedCollisionReceipt(otherEntity)?.shapes.length).toBeGreaterThan(0);

      const retireDerivedSource = requiredFixtureValue(physics.retireDerivedSource).bind(physics);
      physics.retireDerivedSource = async (credential) => {
        if (credential === physics.getDerivedCollisionReceipt(entity)?.publication) {
          return {
            ok: false,
            error: new DerivedPhysicsError(
              'derived-candidate-invalid',
              'injected source retirement failure',
              'retry source retirement after native cleanup recovers',
              { entity, reason: 'test injection' },
            ),
          };
        }
        return retireDerivedSource(credential);
      };
      await ctx.fiber.dispose();
      expect(world.getResource(WATER_SYSTEM_RESOURCE)).toBeDefined();
      expect(physics.getDerivedCollisionReceipt(entity)?.shapes.length).toBeGreaterThan(0);
    } finally {
      await ctx.fiber.dispose().catch(() => undefined);
      assets.dispose();
      physics.dispose();
    }
  });

  it('retires an OceanPatch handle when its World plugin is disposed', async () => {
    const world = new World();
    const assets = testAssets(world);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [provideAssets, scenePlugin(), waterScenePlugin()]);
    try {
      const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      const patch = water.requestOceanPatch(oceanPatchRecipe).unwrap();
      patch.bindNativeSourceTime({}, 0, 0).unwrap();
      patch.update(1 / 60).unwrap();
      const frame = patch.frame();
      expect(frame).toBeDefined();
      if (!frame) throw new Error('expected an issued OceanPatch frame');
      patch.submitted(frame).unwrap();

      await ctx.fiber.dispose();

      expect(patch.inspect().state).toEqual({ status: 'retired' });
      expect(patch.update(1 / 60).ok).toBe(false);
      expect(patch.frame()).toBeUndefined();
      expect(
        patch.completed(frame, { frameId: 1, deviceGeneration: 0, graphGeneration: 1 }, 32, false)
          .ok,
      ).toBe(false);
      expect(patch.inspect().state).toEqual({ status: 'retired' });
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('admits a staged River transform before its first Native collision publication', async () => {
    const world = new World();
    const assets = testAssets(world);
    publishTestAssets(assets, [
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      {
        guid: bodyGuid,
        kind: 'water-body',
        payload: await cookedBody(body()),
        refs: [materialGuid, zoneGuid],
        artifacts: {},
      },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [
      provideAssets,
      scenePlugin(),
      physics3d,
      waterScenePlugin(),
    ]);
    try {
      const handle = (await assets.load(bodyGuid, 'water-body')).unwrap();
      const entity = world
        .spawn({ component: Transform }, { component: WaterBodyInstance, data: { body: handle } })
        .unwrap();
      const instanceGuid = `scene-entity:${entity}`;
      const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);

      world.update(0).unwrap();
      const acceptedA = water.snapshot(instanceGuid);
      expect(acceptedA?.worldMatrixM[12]).toBe(0);
      expect(physics.getDerivedCollisionReceipt?.(entity)).toBeUndefined();

      world.set(entity, Transform, { pos: [1, 0, 0] }).unwrap();
      world.update(0).unwrap();
      expect(water.snapshot(instanceGuid)?.worldMatrixM[12]).toBe(0);
      expect(water.sceneCandidateSnapshot(instanceGuid)?.worldMatrixM[12]).toBe(1);
      expect(physics.getDerivedCollisionReceipt?.(entity)).toBeUndefined();

      world.update(1 / 60).unwrap();
      const acceptedB = requiredFixtureValue(waterSceneSnapshot(world, entity));
      const receiptB = physics.getDerivedCollisionReceipt?.(entity);
      expect(receiptB?.publication.revision).toBe(
        acceptedB.outputReceipts.collision?.outputGeneration,
      );
      expect(acceptedB.worldMatrixM[12]).toBe(1);
      expect(water.sceneCandidateSnapshot(instanceGuid)).toBeUndefined();
      const nativePose = physics.getBodyMotion?.(entity);
      expect(nativePose?.ok && nativePose.value.position).toEqual([1, 0, 0]);
      expect(physics.raycast(vec3.create(1.5, 1, 0), vec3.create(0, -1, 0), 2)?.entity).toBe(
        entity,
      );
      expect(physics.raycast(vec3.create(0.5, 1, 0), vec3.create(0, -1, 0), 2)).toBeUndefined();
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('retires River collision before a saved disable and requires unmount before kind replacement', async () => {
    const world = new World();
    const assets = testAssets(world);
    const initialRiver = await cookedBody(body());
    const disabledRiver = await cookedBody({
      ...body(),
      collision: { type: 'none', enabled: false },
    });
    publishTestAssets(assets, [
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      {
        guid: childMaterialGuid,
        kind: 'material',
        payload: { kind: 'material', parent: materialGuid, values: { roughness: 0.2 } },
        refs: [materialGuid],
        artifacts: {},
      },
      {
        guid: bodyGuid,
        kind: 'water-body',
        payload: initialRiver,
        refs: [materialGuid, zoneGuid],
        artifacts: {},
      },
    ]);
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [
      provideAssets,
      scenePlugin(),
      physics3d,
      waterScenePlugin(),
    ]);
    const advance = (frames = 1) => {
      for (let frame = 0; frame < frames; frame++) world.update(1 / 60).unwrap();
    };
    try {
      await assets.load(materialGuid, 'material');
      await assets.load(childMaterialGuid, 'material');
      const bodyHandle = (await assets.load(bodyGuid, 'water-body')).unwrap();
      const entity = world
        .spawn(
          { component: Transform },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
      const guid = `scene-entity:${entity}`;
      const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
      for (let frame = 0; frame < 6 && !physics.getDerivedCollisionReceipt?.(entity); frame++)
        advance();
      const mountedRiver = requiredFixtureValue(waterSceneSnapshot(world, entity));
      const mountedNative = physics.getDerivedCollisionReceipt?.(entity);
      expect(mountedRiver.asset.type).toBe('river');
      expect(mountedRiver.asset.collision.enabled).toBe(true);
      expect(mountedNative?.shapes.length).toBeGreaterThan(0);
      expect(physics.raycast(vec3.create(0.9, 1, 0), vec3.create(0, -1, 0), 2)?.entity).toBe(
        entity,
      );

      const capturedSamples = new Float32Array(5 * 5 * 4);
      for (let sample = 0; sample < 25; sample++) capturedSamples.set([3, 4, 0, 0], sample * 4);
      const capturedLineage = {
        version: 'water-river-bake/1' as const,
        textureGuid: `019a0000-0000-7000-8000-000000000405`,
        textureRevision: 1,
        sourceRecipeGuid: `019a0000-0000-7000-8000-000000000406`,
        sourceRecipeVersion: 'sha256:river-toggle-source',
        sourceBodyGuid: bodyGuid,
        sourceBodyGeneration: mountedRiver.sceneGeneration,
        simulationGeneration: 1,
        sequence: 1,
        frameId: 1,
        deviceGeneration: 0,
        graphGeneration: 1,
      };
      water
        .publishBakedQueryGrid(guid, mountedRiver.sceneGeneration, {
          kind: 'live-capture',
          enabled: true,
          componentValid: true,
          dataValid: true,
          grid: {
            width: 5,
            height: 5,
            originXZ: [-2, -2],
            originY: 0,
            spacingXZ: [1, 1],
            samples: capturedSamples,
            lineage: capturedLineage,
          },
        })
        .unwrap();
      for (
        let frame = 0;
        frame < 6 && !water.bakedQueryGrid(guid, mountedRiver.sceneGeneration);
        frame++
      )
        advance();
      const acceptedRiver = requiredFixtureValue(waterSceneSnapshot(world, entity));
      const acceptedNative = physics.getDerivedCollisionReceipt?.(entity);
      const bakedBeforeToggle = water.bakedQueryGrid(guid, acceptedRiver.sceneGeneration);
      expect(bakedBeforeToggle?.grid.lineage).toEqual(capturedLineage);
      expect(acceptedNative?.shapes.length).toBeGreaterThan(0);

      const prepare = requiredFixtureValue(physics.prepareDerivedShapeCandidate).bind(physics);
      let rejectEmptyOnce = true;
      physics.prepareDerivedShapeCandidate = (input) => {
        if (
          input.entity === entity &&
          input.sourceKey === `water:${guid}` &&
          input.shapes.length === 0 &&
          rejectEmptyOnce
        ) {
          rejectEmptyOnce = false;
          return {
            ok: false,
            error: new DerivedPhysicsError(
              'derived-candidate-invalid',
              'injected River collision retirement preparation failure',
              'retry the saved collision disable after Native preparation recovers',
              { entity, reason: 'test injection' },
            ),
          };
        }
        return prepare(input);
      };
      expect(assets.replace(bodyHandle, disabledRiver as Asset).ok).toBe(true);
      world.update(0).unwrap();
      const stagedDisable = requiredFixtureValue(water.sceneCandidateSnapshot(guid));
      const stagedBake = water.bakedQueryGridCandidate(guid, stagedDisable.sceneGeneration);
      expect(stagedBake).toMatchObject({
        lineage: capturedLineage,
        samples: bakedBeforeToggle?.grid.samples,
      });
      expect(water.snapshot(guid)?.sourceVersion).toBe(acceptedRiver.sourceVersion);
      expect(water.snapshot(guid)?.asset.collision.enabled).toBe(true);
      expect(physics.getDerivedCollisionReceipt?.(entity)).toBe(acceptedNative);

      advance();
      expect(rejectEmptyOnce).toBe(false);
      expect(water.snapshot(guid)?.sourceVersion).toBe(acceptedRiver.sourceVersion);
      expect(water.snapshot(guid)?.asset.collision.enabled).toBe(true);
      expect(physics.getDerivedCollisionReceipt?.(entity)).toBe(acceptedNative);
      expect(
        world
          .getResource<WaterSceneStatus>(WATER_SCENE_STATUS_RESOURCE)
          .waterCollisionFailures.some(
            (failure) => failure.entity === entity && failure.stage === 'prepare',
          ),
      ).toBe(true);

      for (let frame = 0; frame < 6 && water.snapshot(guid)?.asset.collision.enabled; frame++)
        advance();
      const disabledSnapshot = requiredFixtureValue(waterSceneSnapshot(world, entity));
      const retiredNative = physics.getDerivedCollisionReceipt?.(entity);
      expect(disabledSnapshot.asset.collision.enabled).toBe(false);
      expect(disabledSnapshot.outputReceipts.collision).toBeUndefined();
      expect(water.bakedQueryGrid(guid, disabledSnapshot.sceneGeneration)?.grid).toMatchObject({
        lineage: capturedLineage,
        samples: bakedBeforeToggle?.grid.samples,
      });
      expect(retiredNative?.publication.revision).toBeGreaterThan(
        requiredFixtureValue(acceptedNative).publication.revision,
      );
      expect(retiredNative?.shapes).toEqual([]);
      expect(retiredNative?.sourceTransform).toBeUndefined();
      expect(physics.raycast(vec3.create(0.9, 1, 0), vec3.create(0, -1, 0), 2)).toBeUndefined();

      expect(assets.replace(bodyHandle, initialRiver as Asset).ok).toBe(true);
      world.update(0).unwrap();
      expect(water.snapshot(guid)?.asset.collision.enabled).toBe(false);
      expect(physics.getDerivedCollisionReceipt?.(entity)).toBe(retiredNative);
      for (let frame = 0; frame < 6 && !water.snapshot(guid)?.asset.collision.enabled; frame++)
        advance();
      const reenabled = requiredFixtureValue(waterSceneSnapshot(world, entity));
      const reenabledNative = physics.getDerivedCollisionReceipt?.(entity);
      expect(reenabled.asset.collision.enabled).toBe(true);
      expect(reenabledNative?.shapes.length).toBeGreaterThan(0);
      expect(reenabled.outputReceipts.collision).toMatchObject({
        outputGeneration: reenabledNative?.publication.revision,
        consumerGeneration: reenabledNative?.publication.generation,
        digest: reenabledNative?.publication.inputDigest,
      });
      expect(water.bakedQueryGrid(guid, reenabled.sceneGeneration)?.grid).toMatchObject({
        lineage: capturedLineage,
        samples: bakedBeforeToggle?.grid.samples,
      });
      expect(physics.raycast(vec3.create(0.9, 4, 0), vec3.create(0, -1, 0), 2)?.entity).toBe(
        entity,
      );

      const materialRebound = await cookedBody({
        ...body(),
        surfaceMaterialGuid: childMaterialGuid,
      });
      const beforeRebind = reenabledNative;
      const bakeBeforeRebind = water.bakedQueryGrid(guid, reenabled.sceneGeneration)?.grid;
      expect(assets.replace(bodyHandle, materialRebound as Asset).ok).toBe(true);
      world.update(0).unwrap();
      const rebound = requiredFixtureValue(waterSceneSnapshot(world, entity));
      expect(rebound.sourceVersion).not.toBe(reenabled.sourceVersion);
      expect(rebound.asset.surfaceMaterialGuid).toBe(childMaterialGuid);
      expect(rebound.outputReceipts.collision).toMatchObject({
        outputGeneration: beforeRebind?.publication.revision,
        consumerGeneration: beforeRebind?.publication.generation,
        digest: beforeRebind?.publication.inputDigest,
      });
      expect(physics.getDerivedCollisionReceipt?.(entity)).toBe(beforeRebind);
      expect(water.bakedQueryGrid(guid, rebound.sceneGeneration)?.grid).toMatchObject({
        lineage: capturedLineage,
        samples: bakeBeforeRebind?.samples,
      });

      const replacementLake = await cookedBody(lLake());
      expect(assets.replace(bodyHandle, replacementLake as Asset).ok).toBe(true);
      world.update(0).unwrap();
      expect(water.snapshot(guid)?.asset.type).toBe('river');
      expect(physics.getDerivedCollisionReceipt?.(entity)).toBe(beforeRebind);
      expect(
        world
          .getResource<WaterSceneStatus>(WATER_SCENE_STATUS_RESOURCE)
          .waterCollisionFailures.some(
            (failure) =>
              failure.entity === entity &&
              typeof failure.detail === 'object' &&
              failure.detail !== null &&
              'sourceOwnershipExit' in failure.detail,
          ),
      ).toBe(true);

      world.removeComponent(entity, WaterBodyInstance).unwrap();
      for (
        let frame = 0;
        frame < 8 && physics.getDerivedCollisionReceipt?.(entity)?.shapes.length !== 0;
        frame++
      )
        advance();
      expect(water.snapshot(guid)).toBeUndefined();
      expect(physics.getDerivedCollisionReceipt?.(entity)?.shapes).toEqual([]);
      world
        .addComponent(entity, {
          component: WaterBodyInstance,
          data: { body: bodyHandle },
        })
        .unwrap();
      for (
        let frame = 0;
        frame < 8 && physics.getDerivedCollisionReceipt?.(entity)?.shapes.length === 0;
        frame++
      )
        advance();
      expect(water.snapshot(guid)?.asset.type).toBe('lake');
      expect(physics.getDerivedCollisionReceipt?.(entity)?.shapes.length).toBeGreaterThan(0);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('commits paired River Bake receipts to the Scene lease before the next buoyancy source step', async () => {
    const world = new World();
    const assets = testAssets(world);
    const runtimeBodyAsset = await cookedBody(body());
    const geometryProjectionHash = waterRiverBakeGeometryProjectionHash(runtimeBodyAsset);
    if (!geometryProjectionHash) throw new Error('Expected a valid cooked River projection hash');
    const bakeAssets = [0, 1, 2].map((index) => {
      const recipeGuid = AssetGuid.format(
        AssetGuid.derive(waterTestPackage, `bake/recipe/${index}`),
      );
      const textureGuid = AssetGuid.format(
        AssetGuid.derive(waterTestPackage, `bake/texture/${index}`),
      );
      const normalTextureGuid = AssetGuid.format(
        AssetGuid.derive(waterTestPackage, `bake/normal/${index}`),
      );
      return {
        index,
        recipeGuid,
        textureGuid,
        normalTextureGuid,
        sourceBodyGeneration: index === 0 ? 1 : 2,
        heightM: index === 0 ? 0.3 : index === 1 ? 0.6 : 0.9,
      };
    });
    publishTestAssets(assets, [
      { guid: zoneGuid, kind: 'water-zone', payload: zone, refs: [], artifacts: {} },
      {
        guid: materialGuid,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
          values: {},
        },
        refs: [],
        artifacts: {},
      },
      {
        guid: bodyGuid,
        kind: 'water-body',
        payload: runtimeBodyAsset,
        refs: [materialGuid, zoneGuid],
        artifacts: {},
      },
      ...bakeAssets.flatMap(({ index, recipeGuid, textureGuid, normalTextureGuid }) => [
        {
          guid: recipeGuid,
          kind: 'water-simulation-recipe' as const,
          payload: riverBakeRecipeAsset(
            recipeGuid,
            textureGuid,
            normalTextureGuid,
            bodyGuid,
            bakeAssets[index]?.sourceBodyGeneration ?? 1,
            `sha256:river-bake-recipe-${index}`,
            identity,
            geometryProjectionHash,
          ),
          refs: [textureGuid, normalTextureGuid, bodyGuid],
          artifacts: {},
        },
        {
          guid: textureGuid,
          kind: 'texture' as const,
          payload: riverBakeTexture(index === 0 ? 0.3 : index === 1 ? 0.6 : 0.9),
          refs: [],
          artifacts: {},
        },
        {
          guid: normalTextureGuid,
          kind: 'texture' as const,
          payload: riverBakeNormalTexture(index === 1 ? [0.6, 0, 0.8] : [0, 0, 1]),
          refs: [],
          artifacts: {},
        },
      ]),
    ]);
    const bakeHandles = await Promise.all(
      bakeAssets.map(async ({ recipeGuid, textureGuid, normalTextureGuid }) => ({
        recipe: (await assets.load(recipeGuid, 'water-simulation-recipe')).unwrap(),
        texture: (await assets.load(textureGuid, 'texture')).unwrap(),
        normal: (await assets.load(normalTextureGuid, 'texture')).unwrap(),
      })),
    );
    const provideAssets: Plugin = {
      name: 'test-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const ctx = await createWorldContext(world, [
      provideAssets,
      scenePlugin(),
      physics3d,
      waterScenePlugin(),
    ]);
    const advance = (frames = 1) => {
      for (let frame = 0; frame < frames; frame++) world.update(1 / 60).unwrap();
    };
    let captureTrace = false;
    let invalidateCandidateBody = false;
    let deferAdmissionInvalidation = false;
    try {
      const handle = (await assets.load(bodyGuid, 'water-body')).unwrap();
      const waterEntity = world
        .spawn({ component: Transform }, { component: WaterBodyInstance, data: { body: handle } })
        .unwrap();
      const root = world
        .spawn(
          { component: Transform, data: { pos: [0.5, -0.2, 0] } },
          { component: RigidBody, data: { mass: 100_000, gravityScale: 0 } },
          {
            component: Collider,
            data: { isSensor: true, halfExtents: [0.01, 0.01, 0.01] },
          },
          {
            component: WaterPontoonSet,
            data: { anchorsM: [0, 0, 0], radiiM: [0.5] },
          },
        )
        .unwrap();
      const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
      const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      const instanceGuid = `scene-entity:${waterEntity}`;
      const traceFor = () => {
        const selected = world
          .getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE)
          .steps.find((row) => row.entity === root)?.result;
        if (!selected?.ok) throw new Error('Missing successful Water buoyancy step');
        const trace = selected.value.pontoons[0];
        if (!trace) throw new Error('Missing pontoon trace');
        return trace;
      };
      const captured: ReturnType<typeof traceFor>[] = [];
      world
        .addSystem(
          FixedUpdate,
          defineSystem({
            name: 'captureRiverBakeBuoyancyTrace',
            after: [WaterBuoyancy],
            before: [PhysicsSimulation],
            queries: [],
            fn: () => {
              if (captureTrace) captured.push(traceFor());
            },
          }),
        )
        .unwrap();
      world
        .addSystem(
          FixedUpdate,
          defineSystem({
            name: 'invalidateStagedRiverBakeBody',
            after: [PhysicsSync],
            before: [WaterSceneCollisionReconcile],
            queries: [],
            fn: () => {
              if (!invalidateCandidateBody) return;
              invalidateCandidateBody = false;
              water.invalidate(instanceGuid, ['material']);
            },
          }),
        )
        .unwrap();
      world
        .addSystem(
          FixedUpdate,
          defineSystem({
            name: 'invalidateRiverBakeAfterNativeStage',
            after: [PhysicsSimulation],
            before: [PhysicsCollisionSync],
            queries: [],
            fn: () => {
              if (!deferAdmissionInvalidation) return;
              deferAdmissionInvalidation = false;
              water.invalidate(instanceGuid, ['material']);
            },
          }),
        )
        .unwrap();
      advance(8);

      expect(physics.getSensorOverlaps?.(root).unwrap().current).toContainEqual(
        expect.objectContaining({ entity: waterEntity }),
      );
      const initial = requiredFixtureValue(waterSceneSnapshot(world, waterEntity));
      const initialPhysics = requiredFixtureValue(
        physics.getDerivedCollisionReceipt?.(waterEntity),
      );
      expect(initial.outputReceipts.collision).toMatchObject({
        outputGeneration: initialPhysics.publication.revision,
        consumerGeneration: initialPhysics.publication.generation,
        digest: initialPhysics.publication.inputDigest,
      });
      expect(traceFor().candidateRoster[0]?.result).toMatchObject({
        ok: true,
        value: { source: 'spline' },
      });
      const nativePose = () => {
        const motion = physics.getBodyMotion?.(waterEntity);
        if (!motion?.ok) throw new Error('Missing live Native Water pose');
        return motion.value;
      };
      const capRay = () => physics.raycast(vec3.create(0.9, 1, 0), vec3.create(0, -1, 0), 2);
      expect(nativePose()).toMatchObject({ position: [0, 0, 0], rotation: [0, 0, 0, 1] });
      expect(capRay()?.entity).toBe(waterEntity);
      expect(capRay()?.point[1]).toBeCloseTo(0, 5);

      const movedProbe = physics.setBodyMotion?.(root, {
        position: [0.5, 0.15, 0],
        rotation: [0, 0, 0, 1],
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      });
      if (!movedProbe?.ok) throw new Error('Could not place the probe above the cooked River cap');
      advance();
      expect(physics.getSensorOverlaps?.(root).unwrap().current).not.toContainEqual(
        expect.objectContaining({ entity: waterEntity }),
      );
      // Buoyancy consumes the last completed sensor roster, so let it observe
      // the just-published empty step before asserting the dry candidate set.
      advance();
      expect(traceFor().candidateRoster).toEqual([]);
      expect(capRay()?.entity).toBe(waterEntity);
      expect(capRay()?.point[1]).toBeCloseTo(0, 5);

      let bakePublication = 0;
      const publishGrid = async (heightM: number, fixtureIndex?: number) => {
        const index = fixtureIndex ?? bakePublication++;
        const currentBody = water.snapshot(instanceGuid);
        if (!currentBody) throw new Error('Missing current River Body snapshot for Bake fixture');
        const fixture = bakeAssets[index];
        const handles = bakeHandles[index];
        if (!fixture || !handles) throw new Error('Missing prepublished River Bake fixture');
        const { textureGuid, normalTextureGuid } = fixture;
        const {
          recipe: recipeHandle,
          texture: textureHandle,
          normal: normalTextureHandle,
        } = handles;
        const recipe = assets.read(recipeHandle).unwrap();
        const texture = assets.read(textureHandle).unwrap();
        const normalTexture = assets.read(normalTextureHandle).unwrap();
        const loadedTextureGuid = textureGuid;
        const textureRevision = assets.revision(textureHandle).unwrap();
        const normalTextureRevision = assets.revision(normalTextureHandle).unwrap();
        if (
          recipe.kind !== 'water-simulation-recipe' ||
          recipe.system !== 'water-advanced' ||
          texture.kind !== 'texture' ||
          normalTexture.kind !== 'texture' ||
          !loadedTextureGuid
        )
          throw new Error('Expected the exact published River Bake texture pair');
        const grid = decodeWaterRiverBake(recipe, {
          version: 'water-river-bake/2',
          grid: {
            kind: 'loaded-texture-asset',
            handle: textureHandle,
            guid: loadedTextureGuid,
            revision: textureRevision,
            asset: texture,
          },
          normal: {
            kind: 'loaded-texture-asset',
            handle: normalTextureHandle,
            guid: normalTextureGuid,
            revision: normalTextureRevision,
            asset: normalTexture,
          },
        }).unwrap();
        if (heightM !== fixture.heightM)
          throw new Error('River Bake publication must match its prepublished height fixture');
        return publishWaterRiverBake(
          world,
          instanceGuid,
          currentBody.sceneGeneration,
          grid,
          normalTextureHandle,
        );
      };
      deferAdmissionInvalidation = true;
      (await publishGrid(0.3)).unwrap();
      captureTrace = true;
      advance();
      captureTrace = false;

      const preBakeReceiptTrace = captured[0];
      expect(preBakeReceiptTrace?.candidateRoster).toEqual([]);
      expect(traceFor()).toBe(preBakeReceiptTrace);
      const acceptedBake = requiredFixtureValue(waterSceneSnapshot(world, waterEntity));
      const acceptedBakePhysicsA = requiredFixtureValue(
        physics.getDerivedCollisionReceipt?.(waterEntity),
      );
      expect(nativePose()).toMatchObject({ position: [0, 0, 0], rotation: [0, 0, 0, 1] });
      expect(capRay()?.entity).toBe(waterEntity);
      expect(capRay()?.point[1]).toBeCloseTo(0.3, 4);
      expect(acceptedBake.outputReceipts.collision).toMatchObject({
        outputGeneration: acceptedBakePhysicsA.publication.revision,
        consumerGeneration: acceptedBakePhysicsA.publication.generation,
        digest: acceptedBakePhysicsA.publication.inputDigest,
      });
      expect(acceptedBake.outputReceipts.collision?.outputGeneration).toBeGreaterThan(
        requiredFixtureValue(initial.outputReceipts.collision).outputGeneration,
      );
      world.update(0).unwrap();
      expect(waterSceneSnapshot(world, waterEntity)?.outputReceipts.collision).toEqual(
        acceptedBake.outputReceipts.collision,
      );
      expect(physics.getDerivedCollisionReceipt?.(waterEntity)).toEqual(acceptedBakePhysicsA);
      expect(traceFor()).toBe(preBakeReceiptTrace);

      captureTrace = true;
      advance();
      captureTrace = false;
      const followingTrace = captured[1];
      expect(followingTrace?.candidateRoster[0]?.result).toMatchObject({
        ok: true,
        value: { source: 'baked' },
      });
      expect(followingTrace?.selectedBodyGuid).toBe(acceptedBake.guid);
      expect(followingTrace?.selectedBodyGeneration).toBe(acceptedBake.sceneGeneration);
      const followingForce = world
        .getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE)
        .forceEvents.find((event) => event.rootEntity === root);
      expect(followingForce).toMatchObject({
        bodyGuid: acceptedBake.guid,
        bodyGeneration: acceptedBake.sceneGeneration,
      });
      expect(followingForce?.forceN[1]).toBeGreaterThan(0);

      const originalPrepareCandidate = physics.prepareDerivedShapeCandidate;
      const originalCancelCandidate = physics.cancelDerivedShapeCandidate;
      if (!originalPrepareCandidate || !originalCancelCandidate)
        throw new Error('Rapier must expose real derived candidate preparation and cancellation');
      let preparedCandidates = 0;
      let cancelledCandidates = 0;
      physics.prepareDerivedShapeCandidate = (input) => {
        preparedCandidates++;
        return originalPrepareCandidate.call(physics, input);
      };
      physics.cancelDerivedShapeCandidate = (candidate) => {
        cancelledCandidates++;
        return originalCancelCandidate.call(physics, candidate);
      };
      const collisionStatus = world.getResource<WaterSceneStatus>(WATER_SCENE_STATUS_RESOURCE);
      let acceptedBakeB!: NonNullable<ReturnType<typeof waterSceneSnapshot>>;
      let acceptedBakePhysicsB!: NonNullable<
        ReturnType<NonNullable<typeof physics.getDerivedCollisionReceipt>>
      >;
      try {
        (await publishGrid(0.6, 1)).unwrap();
        const stagedBakeBody = requiredFixtureValue(water.snapshot(instanceGuid));
        const acceptedBakeRevisionA = water.bakedQueryGridCandidateOutputGeneration(
          instanceGuid,
          stagedBakeBody.sceneGeneration,
        );
        if (acceptedBakeRevisionA === undefined)
          throw new Error('Expected the height-changing River Bake candidate to stage');

        reconcileWaterSceneCollisions(world, water, collisionStatus);
        expect(preparedCandidates).toBe(1);
        const normalHandleB = bakeHandles[1]?.normal;
        const fixtureB = bakeAssets[1];
        if (!normalHandleB || !fixtureB) throw new Error('Missing queued River Bake pair B');
        const oldNormalRevisionB = assets.revision(normalHandleB).unwrap();
        assets.replace(normalHandleB, riverBakeNormalTexture([0.6, 0, 0.8])).unwrap();
        const updatedNormalRevisionB = assets.revision(normalHandleB).unwrap();
        expect(updatedNormalRevisionB).toBeGreaterThan(oldNormalRevisionB);
        (await publishGrid(0.6, 1)).unwrap();

        expect(
          water.bakedQueryGridCandidateOutputGeneration(
            instanceGuid,
            stagedBakeBody.sceneGeneration,
          ),
        ).toBe(acceptedBakeRevisionA);
        expect(
          water.bakedQueryGridCandidate(instanceGuid, stagedBakeBody.sceneGeneration)?.lineage,
        ).toMatchObject({
          normalTextureGuid: fixtureB.normalTextureGuid,
          normalTextureRevision: updatedNormalRevisionB,
        });
        reconcileWaterSceneCollisions(world, water, collisionStatus);
        expect(preparedCandidates).toBe(1);
        expect(cancelledCandidates).toBe(0);
        const acceptedNormalBeforeReceipt = waterSceneRiverBakeNormalTexture(world, waterEntity);
        if (!acceptedNormalBeforeReceipt)
          throw new Error('Expected Runtime to retain the last accepted solver-normal version');
        expect(acceptedNormalBeforeReceipt.revision).toBe(
          assets.revision(requiredFixtureValue(bakeHandles[0]).normal).unwrap(),
        );
        expect(acceptedNormalBeforeReceipt.texture.data).toEqual(
          (assets.read(requiredFixtureValue(bakeHandles[0]).normal).unwrap() as TextureAsset).data,
        );

        advance();
        acceptedBakeB = requiredFixtureValue(waterSceneSnapshot(world, waterEntity));
        acceptedBakePhysicsB = requiredFixtureValue(
          physics.getDerivedCollisionReceipt?.(waterEntity),
        );
        expect(capRay()?.entity).toBe(waterEntity);
        expect(capRay()?.point[1]).toBeCloseTo(0.6, 3);
        expect(acceptedBakeB.outputReceipts.collision).toMatchObject({
          outputGeneration: acceptedBakeRevisionA,
          consumerGeneration: acceptedBakePhysicsB.publication.generation,
          digest: acceptedBakePhysicsB.publication.inputDigest,
        });
        expect(acceptedBakePhysicsB.publication.revision).toBe(acceptedBakeRevisionA);
        expect(
          water.bakedQueryGrid(instanceGuid, acceptedBakeB.sceneGeneration)?.grid.lineage,
        ).toMatchObject({
          normalTextureGuid: fixtureB.normalTextureGuid,
          normalTextureRevision: updatedNormalRevisionB,
        });
        expect(preparedCandidates).toBe(1);
        expect(cancelledCandidates).toBe(0);

        const bakeRevisionBeforeNormalOnlyRebind = water.bakedQueryRevision;
        assets.replace(normalHandleB, riverBakeNormalTexture([0.8, 0, 0.6])).unwrap();
        const acceptedNormalRevisionB = assets.revision(normalHandleB).unwrap();
        (await publishGrid(0.6, 1)).unwrap();
        expect(water.bakedQueryRevision).toBe(bakeRevisionBeforeNormalOnlyRebind + 1);
        expect(
          water.bakedQueryGrid(instanceGuid, acceptedBakeB.sceneGeneration)?.grid.lineage,
        ).toMatchObject({
          normalTextureGuid: fixtureB.normalTextureGuid,
          normalTextureRevision: acceptedNormalRevisionB,
        });
        advance();
        acceptedBakeB = requiredFixtureValue(waterSceneSnapshot(world, waterEntity));
        expect(physics.getDerivedCollisionReceipt?.(waterEntity)).toEqual(acceptedBakePhysicsB);
        expect(preparedCandidates).toBe(1);
        expect(cancelledCandidates).toBe(0);

        const acceptedNormal = waterSceneRiverBakeNormalTexture(world, waterEntity);
        if (!acceptedNormal)
          throw new Error('Expected Runtime to retain the accepted solver-normal version');
        const acceptedNormalBytes = acceptedNormal.texture.data;
        expect(acceptedNormal.revision).toBe(acceptedNormalRevisionB);
        assets.replace(normalHandleB, riverBakeNormalTexture([0, 0, 0])).unwrap();
        const currentNormal = assets.read(normalHandleB).unwrap();
        const currentRecipe = assets
          .read(requiredFixtureValue(bakeHandles[1]).recipe)
          .unwrap() as ReturnType<typeof riverBakeRecipeAsset>;
        const currentGrid = assets.read(requiredFixtureValue(bakeHandles[1]).texture).unwrap();
        const rejectedDecode = decodeWaterRiverBake(currentRecipe, {
          version: 'water-river-bake/2',
          grid: {
            kind: 'loaded-texture-asset',
            handle: requiredFixtureValue(bakeHandles[1]).texture,
            guid: fixtureB.textureGuid,
            revision: assets.revision(requiredFixtureValue(bakeHandles[1]).texture).unwrap(),
            asset: currentGrid as TextureAsset,
          },
          normal: {
            kind: 'loaded-texture-asset',
            handle: normalHandleB,
            guid: fixtureB.normalTextureGuid,
            revision: assets.revision(normalHandleB).unwrap(),
            asset: currentNormal as TextureAsset,
          },
        });
        expect(rejectedDecode.ok).toBe(false);
        expect(
          decodeWaterRiverBake(currentRecipe, {
            version: 'water-river-bake/2',
            grid: {
              kind: 'loaded-texture-asset',
              handle: requiredFixtureValue(bakeHandles[1]).texture,
              guid: fixtureB.textureGuid,
              revision: assets.revision(requiredFixtureValue(bakeHandles[1]).texture).unwrap(),
              asset: currentGrid as TextureAsset,
            },
          } as never).ok,
        ).toBe(false);
        const retainedNormal = waterSceneRiverBakeNormalTexture(world, waterEntity);
        expect(retainedNormal).toMatchObject({ revision: acceptedNormalRevisionB });
        expect(retainedNormal?.texture.data).toEqual(acceptedNormalBytes);
        expect(
          water.bakedQueryGrid(instanceGuid, acceptedBakeB.sceneGeneration)?.grid.lineage,
        ).toMatchObject({ normalTextureRevision: acceptedNormalRevisionB });
        expect(physics.getDerivedCollisionReceipt?.(waterEntity)).toEqual(acceptedBakePhysicsB);
      } finally {
        physics.prepareDerivedShapeCandidate = originalPrepareCandidate;
        physics.cancelDerivedShapeCandidate = originalCancelCandidate;
      }

      const acceptedBakeRevision = requiredFixtureValue(
        acceptedBakeB.outputReceipts.collision,
      ).outputGeneration;
      const acceptedBakePhysics = acceptedBakePhysicsB;
      (await publishGrid(0.9, 2)).unwrap();
      const stagedBakeBody = requiredFixtureValue(water.snapshot(instanceGuid));
      const rejectedBakeRevision = water.bakedQueryGridCandidateOutputGeneration(
        instanceGuid,
        stagedBakeBody.sceneGeneration,
      );
      if (rejectedBakeRevision === undefined)
        throw new Error('Expected a replacement River Bake to have a staged collision revision');
      invalidateCandidateBody = true;
      captureTrace = true;
      advance();
      captureTrace = false;
      const sourceChangedTrace = captured[2];
      expect(sourceChangedTrace?.candidateRoster[0]?.result).toMatchObject({
        ok: true,
        value: { source: 'baked' },
      });
      expect(sourceChangedTrace?.selectedBodyGuid).toBe(acceptedBake.guid);
      expect(sourceChangedTrace?.selectedBodyGeneration).toBe(
        water.snapshot(instanceGuid)?.sceneGeneration,
      );
      const retainedBakeForce = world
        .getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE)
        .forceEvents.find((event) => event.rootEntity === root);
      expect(retainedBakeForce).toMatchObject({
        bodyGuid: acceptedBake.guid,
        bodyGeneration: water.snapshot(instanceGuid)?.sceneGeneration,
      });
      expect(retainedBakeForce?.forceN[1]).toBeGreaterThan(0);
      expect(waterSceneSnapshot(world, waterEntity)?.outputReceipts.collision).toMatchObject({
        outputGeneration: acceptedBakeRevision,
        digest: acceptedBakePhysics.publication.inputDigest,
      });
      expect(physics.getDerivedCollisionReceipt?.(waterEntity)).toEqual(acceptedBakePhysics);
      expect(physics.getDerivedCollisionReceipt?.(waterEntity)?.publication.revision).toBeLessThan(
        rejectedBakeRevision,
      );

      captureTrace = true;
      advance();
      captureTrace = false;
      const recoveredLease = requiredFixtureValue(waterSceneSnapshot(world, waterEntity));
      const recoveredPhysics = requiredFixtureValue(
        physics.getDerivedCollisionReceipt?.(waterEntity),
      );
      expect(recoveredLease.outputReceipts.collision).toMatchObject({
        outputGeneration: recoveredPhysics.publication.revision,
        consumerGeneration: recoveredPhysics.publication.generation,
        digest: recoveredPhysics.publication.inputDigest,
      });
      expect(recoveredPhysics.publication.revision).toBe(acceptedBakeRevision);
      expect(recoveredPhysics).toEqual(acceptedBakePhysics);
      expect(
        water.bakedQueryGrid(instanceGuid, recoveredLease.sceneGeneration)?.grid.samples[0],
      ).toBeCloseTo(0.6, 3);
      expect(captured[3]?.candidateRoster[0]?.result).toMatchObject({
        ok: true,
        value: { source: 'baked' },
      });
      const acceptedNormalBeforeClear = waterSceneRiverBakeNormalTexture(world, waterEntity);
      if (!acceptedNormalBeforeClear)
        throw new Error('Expected the accepted River Bake normal before clear');
      const nativeBeforeClear = requiredFixtureValue(
        physics.getDerivedCollisionReceipt?.(waterEntity),
      );
      expect(water.clearBakedQueryGrid(instanceGuid, recoveredLease.sceneGeneration).unwrap()).toBe(
        true,
      );
      const pendingClearRevision = water.bakedQueryGridCandidateOutputGeneration(
        instanceGuid,
        recoveredLease.sceneGeneration,
      );
      if (pendingClearRevision === undefined)
        throw new Error('Expected a Native-admitted River Bake clear candidate');
      reconcileWaterSceneCollisions(world, water, collisionStatus);
      expect(waterSceneRiverBakeNormalTexture(world, waterEntity)).toMatchObject({
        revision: acceptedNormalBeforeClear.revision,
      });
      for (
        let frame = 0;
        frame < 8 && water.bakedQueryGrid(instanceGuid, recoveredLease.sceneGeneration);
        frame++
      )
        advance();
      expect(water.bakedQueryGrid(instanceGuid, recoveredLease.sceneGeneration)).toBeUndefined();
      expect(waterSceneRiverBakeNormalTexture(world, waterEntity)).toBeUndefined();
      expect(
        physics.getDerivedCollisionReceipt?.(waterEntity)?.publication.revision,
      ).toBeGreaterThan(nativeBeforeClear.publication.revision);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });
});
