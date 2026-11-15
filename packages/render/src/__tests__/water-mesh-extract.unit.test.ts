import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { definePackageId } from '@forgeax/engine-pack/source';
import {
  propagateTransforms,
  Transform,
  WaterBodyInstance,
  WaterZoneInstance,
} from '@forgeax/engine-scene';
import {
  buildWaterPackOutputs,
  WATER_SYSTEM_RESOURCE,
  type WaterBodySourceAsset,
  type WaterDependencySnapshot,
  WaterSystem,
  type WaterZoneAsset,
} from '@forgeax/engine-water';
import { describe, expect, it, vi } from 'vitest';
import { buildCameraFrusta } from '../camera-frusta';
import { Camera } from '../components';
import { CameraView, cameraViewExtent } from '../components/camera-view';
import {
  StereoCamera,
  StereoLayoutValue,
  stereoEyeCameras,
  stereoEyeViewport,
} from '../components/stereo-camera';
import { renderFeatureViewIdentity } from '../features/view';
import { MaterialResource } from '../material-resource';
import { materialSourceScope } from '../material-source';
import { Materials } from '../materials';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import {
  cameraForView,
  type MaterialSnapshotContexts,
  prepareExtractContext,
  selectCameraRoles,
  type WaterMeshSourceState,
  type WaterMeshViewFacts,
} from '../render-system-extract';
import { extractFrame, extractSource } from '../render-system-extract-tail';
import {
  createPresentationDraws,
  missingDrawEvidence,
  projectDisplayRenderables,
} from '../render-system-presentation';
import { MaterialFrame } from '../scene/material-dispatch';
import { projectWaterMeshView } from '../water-mesh-source';
import { waterMeshTestAssets } from './water-mesh-assets.fixture';

const zoneGuid = '00000000-0000-7000-8000-000000000006';
const materialGuid = '00000000-0000-7000-8000-000000000001';

function cameraRotationTowardLake(eye: readonly [number, number, number]) {
  return quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]);
}

function spawnCamera(world: World, autoAspect = true) {
  return world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 4, 8],
          quat: cameraRotationTowardLake([0, 4, 8]),
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: 0,
          autoAspect,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
    )
    .unwrap();
}

type WaterMeshInputViewFact = readonly [string, number, number, number, readonly number[] | null];

function waterMeshInputViewFacts(frame: ReturnType<typeof extractSource>) {
  const refresh = frame.waterMeshOwnerRefreshes?.[0];
  if (refresh === undefined) throw new Error('WaterMesh fixture requires an owner refresh');
  const [views] = JSON.parse(refresh.inputKey) as [readonly WaterMeshInputViewFact[] | null];
  return views ?? [];
}

function waterMeshInputKey(frame: ReturnType<typeof extractSource>): string {
  const refresh = frame.waterMeshOwnerRefreshes?.[0];
  if (refresh === undefined) throw new Error('WaterMesh fixture requires an owner refresh');
  return refresh.inputKey;
}

function waterMeshSourceState(frame: ReturnType<typeof extractSource>): WaterMeshSourceState {
  const refresh = frame.waterMeshOwnerRefreshes?.[0];
  if (refresh === undefined) throw new Error('WaterMesh fixture requires an owner refresh');
  return {
    system: refresh.system,
    inputKey: refresh.inputKey,
    ownerEntityKeys: refresh.ownerEntityKeys,
    ownerSources: refresh.ownerSources,
  };
}

async function extractCrossWorldWaterMesh(
  bodyAsset: Parameters<WaterSystem['mountBody']>[2],
  options: {
    readonly canvasWidth: number;
    readonly canvasHeight: number;
    readonly cameraView?: {
      readonly viewport?: readonly [number, number, number, number];
      readonly resolutionScale?: number;
    } | null;
    readonly autoAspect?: boolean;
    readonly stereoLayout?: 'side-by-side' | 'top-bottom';
    readonly facts?: WaterMeshViewFacts | null;
  },
) {
  const cameraWorld = new World({ assets: await waterMeshTestAssets(materialGuid) });
  const cameraEntity = spawnCamera(cameraWorld, options.autoAspect ?? true);
  if (options.cameraView !== null) {
    const viewport = options.cameraView?.viewport ?? [0, 0, 1, 1];
    cameraWorld
      .addComponent(cameraEntity, {
        component: CameraView,
        data: {
          viewport: new Float32Array(viewport),
          resolutionScale: options.cameraView?.resolutionScale ?? 1,
        },
      })
      .unwrap();
  }
  if (options.stereoLayout !== undefined) {
    cameraWorld
      .addComponent(cameraEntity, {
        component: StereoCamera,
        data: { layout: StereoLayoutValue[options.stereoLayout] },
      })
      .unwrap();
  }

  const waterWorld = cameraWorld;
  waterWorld
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: WaterZoneInstance, data: { zone: 0 as never } },
    )
    .unwrap();
  const bodyEntity = waterWorld
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: WaterBodyInstance, data: { body: 0 as never } },
    )
    .unwrap();
  const water = new WaterSystem(
    (guid) => (guid === zoneGuid ? { generation: 1, asset: zone } : undefined),
    () => [],
    () => [{ guid: zoneGuid, generation: 1, asset: zone }],
  );
  water.mountBody(`scene-entity:${bodyEntity}`, '1', bodyAsset).unwrap();
  waterWorld.insertResource(WATER_SYSTEM_RESOURCE, water);

  const facts =
    options.facts === null
      ? undefined
      : (options.facts ?? {
          version: 1 as const,
          canvasExtent: { width: options.canvasWidth, height: options.canvasHeight },
          maxRenderShortSide: 0,
        });
  const frame = extractSource(waterWorld, undefined, undefined, {
    renderables: 'none',
    ...(facts === undefined ? {} : { waterMeshViewFacts: facts }),
  });
  return { cameraEntity, frame };
}

function resolvedView(world: World) {
  const entityKey = spawnCamera(world);
  const camera = selectCameraRoles(world, entityKey).display[0];
  if (!camera) throw new Error('WaterMesh extraction fixture requires a camera');
  return { extent: { width: 64, height: 64 }, camera: camera as CameraSnapshot };
}

function lake(): WaterBodySourceAsset {
  const points = [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
  ] as const;
  return {
    kind: 'water-body',
    type: 'lake',
    zoneGuid,
    surfaceMaterialGuid: materialGuid,
    spline: {
      closed: true,
      points: points.map(([x, z], inputKey) => ({
        inputKey,
        positionM: [x, 0, z] as const,
        arriveTangentM: [0, 0, 0] as const,
        leaveTangentM: [0, 0, 0] as const,
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 1,
        depthM: 2,
        velocityMPerSec: 0,
        audioIntensity: 0,
      })),
    },
    baseHeightM: 0,
    overlapPriority: 0,
    maxWaveHeightM: 0.25,
    flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
    collision: { type: 'polygon', enabled: true, channelDepthM: 4 },
    queryFootprint: points,
  };
}

const zone: WaterZoneAsset = {
  kind: 'water-zone',
  extentM: { spanXM: 16, spanZM: 16 },
  tileSizeM: 4,
  tessellationFactor: 1,
  lodScale: 1,
  waterInfo: {
    resolution: { widthPx: 64, heightPx: 64 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: false,
  },
};

describe('WaterMesh source extraction', () => {
  it.each([
    'unlit',
    'standard',
  ] as const)('retains every %s material root when a later WaterMesh owner candidate fails', async (model) => {
    const farGuid = '00000000-0000-7000-8000-00000000000d';
    const bodyGuid = '00000000-0000-7000-8000-00000000000e';
    const material = (red: number) =>
      model === 'unlit'
        ? Materials.unlit([red, 0.3, 0.8, 1])
        : Materials.standard({ baseColor: [red, 0.3, 0.8, 1] });
    const assets = await waterMeshTestAssets(
      materialGuid,
      new Map([
        [materialGuid, material(0.2)],
        [farGuid, material(0.4)],
      ]),
    );
    const world = new World({ assets });
    const view = resolvedView(world);
    world
      .spawn(
        { component: Transform, data: {} },
        { component: WaterZoneInstance, data: { zone: 0 as never } },
      )
      .unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: WaterBodyInstance, data: { body: 0 as never } },
      )
      .unwrap();
    const farZone: WaterZoneAsset = {
      ...zone,
      farExtentM: { spanXM: 32, spanZM: 32 },
      farMaterialGuid: farGuid,
      farOwnerBodyGuid: bodyGuid,
      farWaterLevelM: 0,
    };
    const water = new WaterSystem(
      (guid) => (guid === zoneGuid ? { generation: 1, asset: farZone } : undefined),
      () => [],
      () => [{ guid: zoneGuid, generation: 1, asset: farZone }],
    );
    const cooked = await buildWaterPackOutputs(
      { body: lake() },
      {
        packageId: definePackageId('019a0000-0000-7000-8000-000000000504'),
      },
    );
    if (!cooked.ok || cooked.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh multi-material fixture must cook');
    water.mountBody(`scene-entity:${entity}`, '1', cooked.value.body, bodyGuid).unwrap();
    world.insertResource(WATER_SYSTEM_RESOURCE, water);
    const materialSnapshotContexts: MaterialSnapshotContexts = new Map();
    let accepted: WaterMeshSourceState | undefined;
    const extract = () => {
      const frame = extractFrame(
        world,
        prepareExtractContext(world, {
          renderables: 'none',
          cull: 'none',
          view,
          materialSnapshotContexts,
          ...(accepted === undefined ? {} : { waterMeshSourceState: accepted }),
        }),
      );
      const refresh = frame.waterMeshOwnerRefreshes?.[0];
      if (refresh !== undefined)
        accepted = {
          system: refresh.system,
          inputKey: refresh.inputKey,
          ownerEntityKeys: refresh.ownerEntityKeys,
          ownerSources: refresh.ownerSources,
        };
      const row = frame.renderables.find((row) => row.entityKey === entity);
      if (row === undefined) throw new Error('WaterMesh multi-material owner is missing');
      return row;
    };
    const from = MaterialResource.from.bind(MaterialResource);
    const cause = new Error('second material candidate rejected');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      extract();
      const first = extract();
      expect(first.materials).toHaveLength(2);
      const handles = first.materials.map((resource) => resource.snapshot.materialHandle);
      const snapshots = first.materials.map((resource) => resource.snapshot);
      const firstHandle = handles[0];
      const secondHandle = handles[1];
      if (firstHandle === undefined || secondHandle === undefined)
        throw new Error('WaterMesh multi-material handles are missing');
      for (const snapshot of snapshots) {
        expect(snapshot.sourceAssets).toBeDefined();
        expect(Object.values(snapshot.materialProgramInputs ?? {})).toEqual([]);
      }
      assets.replace(firstHandle as never, material(0.6)).unwrap();
      assets.replace(secondHandle as never, material(0.9)).unwrap();
      const resolved: number[] = [];
      const fault = vi.spyOn(MaterialResource, 'from').mockImplementation((snapshot) => {
        if (snapshot.materialHandle === secondHandle && (snapshot.baseColor[0] ?? 0) > 0.8)
          throw cause;
        if (snapshot.materialHandle === firstHandle && (snapshot.baseColor[0] ?? 0) > 0.5)
          resolved.push(firstHandle);
        return from(snapshot);
      });
      try {
        const rejected = extract();
        expect(resolved.length).toBeGreaterThan(0);
        expect(rejected.materials).toEqual(first.materials);
        for (const [index, resource] of first.materials.entries()) {
          expect(resource.snapshot).toBe(snapshots[index]);
          expect(rejected.materials[index]).toBe(resource);
          expect(rejected.materials[index]?.snapshot.sourceAssets).toBe(
            snapshots[index]?.sourceAssets,
          );
        }
      } finally {
        fault.mockRestore();
      }
      const retried = extract();
      expect(retried.materials[0]?.snapshot.baseColor[0]).toBeCloseTo(0.6, 5);
      expect(retried.materials[1]?.snapshot.baseColor[0]).toBeCloseTo(0.9, 5);
      for (const [index, resource] of retried.materials.entries()) {
        expect(resource).not.toBe(first.materials[index]);
        expect(resource.snapshot.sourceAssets).not.toBe(snapshots[index]?.sourceAssets);
      }
    } finally {
      errors.mockRestore();
      assets.dispose();
    }
  });

  it('keeps the accepted material source across drained view extractions and replaces only its revision', async () => {
    const assets = await waterMeshTestAssets(materialGuid);
    const world = new World({ assets });
    const view = resolvedView(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterZoneInstance, data: { zone: 0 as never } },
      )
      .unwrap();
    const bodyEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterBodyInstance, data: { body: 0 as never } },
      )
      .unwrap();
    const water = new WaterSystem(
      (guid) => (guid === zoneGuid ? { generation: 1, asset: zone } : undefined),
      () => [],
      () => [{ guid: zoneGuid, generation: 1, asset: zone }],
    );
    const packed = await buildWaterPackOutputs(
      { body: lake() },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000503') },
    );
    if (!packed.ok || packed.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh material residency fixture must cook');
    water.mountBody(`scene-entity:${bodyEntity}`, '1', packed.value.body).unwrap();
    world.insertResource(WATER_SYSTEM_RESOURCE, water);
    const materialSnapshotContexts: MaterialSnapshotContexts = new Map();
    const extract = () =>
      extractFrame(
        world,
        prepareExtractContext(world, {
          renderables: 'none',
          cull: 'none',
          view,
          materialSnapshotContexts,
        }),
      );
    const material = (frame: ReturnType<typeof extract>) => {
      const selected = frame.renderables.find((row) => row.entityKey === bodyEntity)?.materials[0];
      if (selected?.snapshot.sourceAssets === undefined)
        throw new Error('WaterMesh fixture requires an accepted material source');
      return selected;
    };
    try {
      extract();
      const first = material(extract());
      const source = first.snapshot.sourceAssets;
      const sourceWorld = worldRenderResources(world);
      const fixed = materialSourceScope(sourceWorld, source);
      for (let frame = 0; frame < 3; frame++) {
        const next = material(extract());
        expect(next).toBe(first);
        expect(next.snapshot.sourceAssets).toBe(source);
        expect(materialSourceScope(sourceWorld, next.snapshot.sourceAssets)).toBe(fixed);
      }
      const handle = sourceWorld.handleForGuid(materialGuid);
      if (handle === undefined) throw new Error('WaterMesh fixture lost its material');
      const held = first.snapshot;
      assets.replace(handle as never, Materials.unlit([0.8, 0.2, 0.1, 1])).unwrap();
      const changed = material(extract());
      expect(changed.snapshot.sourceAssets).not.toBe(source);
      expect(materialSourceScope(sourceWorld, changed.snapshot.sourceAssets)).not.toBe(fixed);
      expect(held.sourceAssets).toBe(source);
      expect(held.baseColor[0]).toBeCloseTo(0.2, 5);
      expect(changed.snapshot.baseColor[0]).toBeCloseTo(0.8, 5);
      expect(fixed.resolveAsset(handle).unwrap()).toMatchObject({
        values: { baseColor: [0.2, 0.4, 0.8, 1] },
      });
    } finally {
      assets.dispose();
    }
  });

  it('retires and restores WaterBody-only raster demand while preserving ordinary geometry', async () => {
    const world = new World({ assets: await waterMeshTestAssets(materialGuid) });
    const view = resolvedView(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterZoneInstance, data: { zone: 0 as never } },
      )
      .unwrap();
    const bodyEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterBodyInstance, data: { body: 0 as never } },
      )
      .unwrap();
    const water = new WaterSystem(
      (guid) => (guid === zoneGuid ? { generation: 1, asset: zone } : undefined),
      () => [],
      () => [{ guid: zoneGuid, generation: 1, asset: zone }],
    );
    const packed = await buildWaterPackOutputs(
      { body: lake() },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000495') },
    );
    if (!packed.ok || packed.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh fixture body must cook successfully');
    water.mountBody(`scene-entity:${bodyEntity}`, '1', packed.value.body).unwrap();
    world.insertResource(WATER_SYSTEM_RESOURCE, water);

    const firstFrame = extractFrame(
      world,
      prepareExtractContext(world, { renderables: 'none', cull: 'none', view }),
    );
    expect(firstFrame.renderables.at(0)?.waterMeshSource?.views).toEqual([]);
    const frame = extractFrame(
      world,
      prepareExtractContext(world, {
        renderables: 'none',
        cull: 'none',
        view,
        waterMeshSourceState: waterMeshSourceState(firstFrame),
      }),
    );

    expect(frame.renderables).toHaveLength(1);
    expect(frame.renderables.at(0)).toMatchObject({
      entityKey: bodyEntity,
      waterMeshSource: {
        guid: `scene-entity:${bodyEntity}`,
        views: expect.any(Array),
      },
    });
    expect(frame.renderables.at(0)?.generatedMesh).toBeUndefined();
    expect(frame.renderables.at(0)?.waterMeshSource?.views[0]?.viewIdentity).toBe(
      renderFeatureViewIdentity(view.camera),
    );
    expect(frame.renderables.at(0)?.waterMeshSource?.views[0]?.draws.length).toBeGreaterThan(0);

    const owner = frame.renderables.at(0);
    if (owner?.waterMeshSource === undefined)
      throw new Error('WaterMesh fixture requires its owner source');
    const viewIdentity = renderFeatureViewIdentity(view.camera);
    const active = projectWaterMeshView(frame, new MaterialFrame(undefined), viewIdentity);
    expect(active.frame.renderables.length).toBeGreaterThan(0);
    const dispatch = active.frame.dispatch.at(0);
    if (dispatch === undefined) throw new Error('WaterMesh fixture requires display dispatch');
    const { waterMeshSource: _waterMeshSource, ...ordinaryOwner } = owner;
    const ordinary = {
      ...ordinaryOwner,
      entityKey: Number(bodyEntity) + 1000,
      generatedMesh: createPrimitiveMesh('cube').unwrap(),
    };
    const retained = {
      ...frame,
      renderables: [owner, ordinary],
      dispatch: [
        { ...dispatch, renderableIndex: 0 },
        { ...dispatch, renderableIndex: 1, entityIndex: ordinary.entityKey },
      ],
    };
    const acceptedBody = water.snapshot(`scene-entity:${bodyEntity}`);
    if (acceptedBody === undefined) throw new Error('WaterMesh fixture lost its accepted Body');
    water
      .mountBody(`scene-entity:${bodyEntity}`, '2', {
        ...acceptedBody.asset,
        flags: { ...acceptedBody.asset.flags, affectsWaterMesh: false },
      })
      .unwrap();
    const disabled = extractFrame(
      world,
      prepareExtractContext(world, {
        renderables: 'none',
        cull: 'none',
        view,
        waterMeshSourceState: waterMeshSourceState(frame),
      }),
    );
    expect(water.snapshot(`scene-entity:${bodyEntity}`)?.outputs.waterMesh).toBe('not-requested');
    expect(water.snapshot(`scene-entity:${bodyEntity}`)?.asset.flags.affectsWaterInfo).toBe(true);
    const off = projectWaterMeshView(
      retained,
      active.materials,
      viewIdentity,
      disabled.renderables,
    );
    expect(off.frame.renderables).toEqual([ordinary]);
    expect(off.frame.dispatch).toEqual([
      { ...dispatch, renderableIndex: 0, entityIndex: ordinary.entityKey },
    ]);
    const display = projectDisplayRenderables(off.frame.renderables, off.frame.dispatch);
    expect(display).toEqual([ordinary]);
    expect(
      missingDrawEvidence(
        display,
        createPresentationDraws(),
        worldRenderResources(world),
        {} as RenderSystemInternals,
      ),
    ).toEqual({ code: 'draw-entity-missing', entity: ordinary.entityKey });
    const noWater = projectWaterMeshView(
      frame,
      active.materials,
      viewIdentity,
      disabled.renderables,
    );
    expect(noWater.frame.renderables).toEqual([]);
    expect(noWater.frame.dispatch).toEqual([]);
    const combined = {
      ...owner,
      generatedMesh: ordinary.generatedMesh,
      materials: [owner.material, ...owner.materials],
      materialBindingSources: ['mesh-default' as const, ...owner.materialBindingSources],
      waterMeshSource: { ...owner.waterMeshSource, materialStartIndex: 1 },
    };
    const combinedOff = projectWaterMeshView(
      { ...retained, renderables: [combined], dispatch: [{ ...dispatch, renderableIndex: 0 }] },
      active.materials,
      viewIdentity,
      disabled.renderables,
    );
    expect(combinedOff.frame.renderables).toHaveLength(1);
    expect(combinedOff.frame.renderables.at(0)?.generatedMesh).toBe(ordinary.generatedMesh);
    expect(combinedOff.frame.renderables.at(0)?.materials).toEqual([owner.material]);
    expect(combinedOff.frame.renderables.at(0)?.waterMeshSource).toBeUndefined();
    water.mountBody(`scene-entity:${bodyEntity}`, '3', packed.value.body).unwrap();
    let restored = extractFrame(
      world,
      prepareExtractContext(world, {
        renderables: 'none',
        cull: 'none',
        view,
        waterMeshSourceState: waterMeshSourceState(disabled),
      }),
    );
    restored = extractFrame(
      world,
      prepareExtractContext(world, {
        renderables: 'none',
        cull: 'none',
        view,
        waterMeshSourceState: waterMeshSourceState(restored),
      }),
    );
    const on = projectWaterMeshView(
      noWater.frame,
      noWater.materials,
      viewIdentity,
      restored.renderables,
    );
    expect(on.frame.renderables.length).toBeGreaterThan(0);
    expect(
      on.frame.renderables.every(
        (row) =>
          row.waterOwner?.generation ===
          water.snapshot(`scene-entity:${bodyEntity}`)?.sceneGeneration,
      ),
    ).toBe(true);
  });

  it.each([
    'pending',
    'wrong-kind',
    'unavailable',
    'failed',
  ] as const)('retains a complete WaterMesh owner for a %s material and retries', async (status) => {
    const assets = await waterMeshTestAssets(materialGuid);
    const world = new World({ assets });
    const view = resolvedView(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterZoneInstance, data: { zone: 0 as never } },
      )
      .unwrap();
    const bodyEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterBodyInstance, data: { body: 0 as never } },
      )
      .unwrap();
    let dependency: WaterDependencySnapshot = {
      guid: materialGuid,
      kind: 'material',
      field: 'surfaceMaterialGuid',
      status: 'valid',
    };
    const water = new WaterSystem(
      (guid) => (guid === zoneGuid ? { generation: 1, asset: zone } : undefined),
      () => [dependency],
      () => [{ guid: zoneGuid, generation: 1, asset: zone }],
    );
    const packed = await buildWaterPackOutputs(
      { body: lake() },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000502') },
    );
    if (!packed.ok || packed.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh material retry fixture must cook');
    water.mountBody(`scene-entity:${bodyEntity}`, '1', packed.value.body).unwrap();
    world.insertResource(WATER_SYSTEM_RESOURCE, water);
    const extract = (state?: WaterMeshSourceState) =>
      extractFrame(
        world,
        prepareExtractContext(world, {
          renderables: 'none',
          cull: 'none',
          view,
          ...(state === undefined ? {} : { waterMeshSourceState: state }),
        }),
      );
    const initial = extract();
    const accepted = extract(waterMeshSourceState(initial));
    const acceptedOwner = accepted.renderables.find((row) => row.entityKey === bodyEntity);
    expect(acceptedOwner?.waterMeshSource?.views[0]?.draws.length).toBeGreaterThan(0);
    const originalSnapshot = water.snapshot.bind(water);
    const dependencySnapshot = vi.spyOn(water, 'snapshot').mockImplementation((guid) => {
      const snapshot = originalSnapshot(guid);
      return snapshot === undefined ? undefined : { ...snapshot, dependencies: [dependency] };
    });
    const materialWorld = worldRenderResources(world);
    const handle = materialWorld.handleForGuid(materialGuid);
    if (handle === undefined) throw new Error('WaterMesh material fixture lost its handle');
    const originalResolve = materialWorld.resolveAsset.bind(materialWorld);
    const originalHandle = materialWorld.handleForGuid.bind(materialWorld);
    dependency =
      status === 'failed'
        ? {
            guid: materialGuid,
            kind: 'material',
            field: 'surfaceMaterialGuid',
            status,
            failure: {
              code: 'load-failed',
              expected: 'material bytes',
              hint: 'repair material source',
            },
          }
        : {
            guid: materialGuid,
            kind: 'material',
            field: 'surfaceMaterialGuid',
            status: status === 'wrong-kind' ? 'valid' : status,
          };
    const missingHandle = vi
      .spyOn(materialWorld, 'handleForGuid')
      .mockImplementation((guid) =>
        guid === materialGuid && status !== 'wrong-kind' ? undefined : originalHandle(guid),
      );
    const wrongKind = createPrimitiveMesh('cube').unwrap();
    const wrongKindResolve = vi
      .spyOn(materialWorld, 'resolveAsset')
      .mockImplementation((candidate, revision) =>
        candidate === handle && status === 'wrong-kind'
          ? ({ ok: true, value: wrongKind } as never)
          : originalResolve(candidate, revision),
      );
    const routedErrors: unknown[] = [];
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation((_context, error) => routedErrors.push(error));
    try {
      const retained = extract(waterMeshSourceState(accepted));
      const retainedOwner = retained.renderables.find((row) => row.entityKey === bodyEntity);
      expect(retainedOwner?.waterMeshSource).toEqual(acceptedOwner?.waterMeshSource);
      expect(
        retainedOwner?.materials.find((material) => material.snapshot.materialHandle === handle)
          ?.snapshot.baseColor,
      ).toEqual(
        acceptedOwner?.materials.find((material) => material.snapshot.materialHandle === handle)
          ?.snapshot.baseColor,
      );
      if (status === 'pending') {
        expect(routedErrors).toEqual([]);
        expect(retained.waterMeshOwnerRefreshes?.[0]?.inputKey).toBe(
          waterMeshSourceState(accepted).inputKey,
        );
      } else
        expect(routedErrors).toContainEqual(
          expect.objectContaining({
            code: 'resource-not-ready',
            detail: expect.objectContaining({ owner: 'material', actual: materialGuid }),
          }),
        );

      wrongKindResolve.mockRestore();
      missingHandle.mockRestore();
      dependency = {
        guid: materialGuid,
        kind: 'material',
        field: 'surfaceMaterialGuid',
        status: 'valid',
      };
      assets.replace(handle as never, Materials.unlit([0.8, 0.2, 0.1, 1])).unwrap();
      const retried = extract(waterMeshSourceState(retained));
      const retriedOwner = retried.renderables.find((row) => row.entityKey === bodyEntity);
      expect(retriedOwner?.waterMeshSource?.views[0]?.draws.length).toBeGreaterThan(0);
      expect(
        retriedOwner?.materials.find((material) => material.snapshot.materialHandle === handle)
          ?.snapshot.baseColor[0],
      ).toBeCloseTo(0.8, 5);
    } finally {
      wrongKindResolve.mockRestore();
      missingHandle.mockRestore();
      errorLog.mockRestore();
      dependencySnapshot.mockRestore();
      assets.dispose();
    }
  });

  it('builds one stable WaterMesh bundle for every display CameraView and stereo eye', async () => {
    const world = new World({ assets: await waterMeshTestAssets(materialGuid) });
    const firstCamera = spawnCamera(world, false);
    const stereoCamera = spawnCamera(world, false);
    world.addComponent(firstCamera, { component: CameraView, data: { order: 0 } }).unwrap();
    world.addComponent(stereoCamera, { component: CameraView, data: { order: 1 } }).unwrap();
    world.addComponent(stereoCamera, { component: StereoCamera, data: {} }).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterZoneInstance, data: { zone: 0 as never } },
      )
      .unwrap();
    const bodyEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterBodyInstance, data: { body: 0 as never } },
      )
      .unwrap();
    const water = new WaterSystem(
      (guid) => (guid === zoneGuid ? { generation: 1, asset: zone } : undefined),
      () => [],
      () => [{ guid: zoneGuid, generation: 1, asset: zone }],
    );
    const packed = await buildWaterPackOutputs(
      { body: lake() },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000496') },
    );
    if (!packed.ok || packed.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh multi-view fixture body must cook successfully');
    water.mountBody(`scene-entity:${bodyEntity}`, '1', packed.value.body).unwrap();
    world.insertResource(WATER_SYSTEM_RESOURCE, water);
    propagateTransforms(world).unwrap();

    const extract = (sourceState?: WaterMeshSourceState) =>
      extractFrame(
        world,
        prepareExtractContext(world, {
          renderables: 'none',
          cull: 'none',
          ...(sourceState === undefined ? {} : { waterMeshSourceState: sourceState }),
        }),
      );
    const firstFrame = extract();
    expect(
      firstFrame.renderables.find((row) => row.entityKey === bodyEntity)?.waterMeshSource?.views,
    ).toEqual([]);
    const frame = extract(waterMeshSourceState(firstFrame));
    const source = frame.renderables.find((row) => row.entityKey === bodyEntity)?.waterMeshSource;
    const expectedViews = frame.cameras
      .flatMap((camera) =>
        (camera.eye === undefined ? stereoEyeCameras(camera) : [camera]).map(
          renderFeatureViewIdentity,
        ),
      )
      .sort();
    expect(frame.cameras).toHaveLength(2);
    expect(source?.views.map((view) => view.viewIdentity)).toEqual(expectedViews);
    expect(source?.views.every((view) => view.draws.length > 0)).toBe(true);
    expect(waterMeshInputViewFacts(frame)).toHaveLength(3);
    expect(waterMeshInputViewFacts(frame).every((view) => view[4] !== null)).toBe(true);
    const initialRefresh = frame.waterMeshOwnerRefreshes?.[0];
    if (initialRefresh === undefined)
      throw new Error('WaterMesh multi-view fixture requires its initial owner refresh');

    const movedEye: [number, number, number] = [2, 4, 8];
    world
      .set(stereoCamera, Transform, {
        pos: movedEye,
        quat: cameraRotationTowardLake(movedEye),
      })
      .unwrap();
    propagateTransforms(world).unwrap();
    const moved = extract(waterMeshSourceState(frame));
    const movedRefresh = moved.waterMeshOwnerRefreshes?.[0];
    if (movedRefresh === undefined)
      throw new Error('WaterMesh moved-camera fixture requires a refreshed owner roster');
    expect(movedRefresh.inputKey).not.toBe(initialRefresh.inputKey);
    const movedViews = moved.renderables.find((row) => row.entityKey === bodyEntity)
      ?.waterMeshSource?.views;
    expect(movedViews).toHaveLength(3);
    expect(movedViews?.every((view) => view.draws.length > 0)).toBe(true);
    expect(waterMeshInputViewFacts(moved)).toHaveLength(3);
    expect(waterMeshInputViewFacts(moved).every((view) => view[4] !== null)).toBe(true);

    world.despawn(stereoCamera).unwrap();
    const retired = extract(waterMeshSourceState(moved));
    expect(waterMeshInputViewFacts(retired)).toHaveLength(1);
    for (const viewId of expectedViews.filter((id) => id !== `camera:${Number(firstCamera)}`)) {
      expect(water.waterMeshCandidateViews(viewId)).toEqual([]);
      expect(water.zoneMeshView(zoneGuid, viewId)).toBeUndefined();
    }
  });

  it('resolves auto-aspect WaterMesh frusta from source canvas, viewport, and scale facts', async () => {
    const packed = await buildWaterPackOutputs(
      { body: lake() },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000497') },
    );
    if (!packed.ok || packed.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh cross-World fixture body must cook successfully');
    const bodyAsset = packed.value.body;
    const base = await extractCrossWorldWaterMesh(bodyAsset, {
      canvasWidth: 127,
      canvasHeight: 64,
      cameraView: {},
    });
    const widerCanvas = await extractCrossWorldWaterMesh(bodyAsset, {
      canvasWidth: 191,
      canvasHeight: 64,
      cameraView: {},
    });
    const halfViewport = await extractCrossWorldWaterMesh(bodyAsset, {
      canvasWidth: 127,
      canvasHeight: 64,
      cameraView: { viewport: [0, 0, 0.5, 1] },
    });
    const reducedScale = await extractCrossWorldWaterMesh(bodyAsset, {
      canvasWidth: 127,
      canvasHeight: 64,
      cameraView: { resolutionScale: 0.75 },
    });
    const baseKey = waterMeshInputKey(base.frame);
    const baseViews = waterMeshInputViewFacts(base.frame);
    expect(
      base.frame.cameras.find((camera) => camera.entityKey === base.cameraEntity)?.autoAspect,
    ).toBe(true);
    expect(baseViews).toHaveLength(1);
    const baseFrustum = baseViews[0]?.[4];
    expect(baseFrustum).toEqual(expect.any(Array));

    for (const variant of [widerCanvas, halfViewport, reducedScale]) {
      expect(waterMeshInputKey(variant.frame)).not.toBe(baseKey);
      expect(waterMeshInputViewFacts(variant.frame)[0]?.[4]).not.toEqual(baseFrustum);
    }
  });

  it('splits stereo WaterMesh frusta using each layout eye physical canvas extent', async () => {
    const packed = await buildWaterPackOutputs(
      { body: lake() },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000498') },
    );
    if (!packed.ok || packed.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh stereo fixture body must cook successfully');
    const eyeAspectByLayout = new Map<'side-by-side' | 'top-bottom', number>();

    for (const layout of ['side-by-side', 'top-bottom'] as const) {
      const { cameraEntity, frame } = await extractCrossWorldWaterMesh(packed.value.body, {
        canvasWidth: 128,
        canvasHeight: 96,
        cameraView: {},
        stereoLayout: layout,
      });
      const sourceCamera = frame.cameras.find((camera) => camera.entityKey === cameraEntity);
      if (sourceCamera?.stereo === undefined || sourceCamera.view === undefined)
        throw new Error('WaterMesh stereo fixture requires the selected source camera');
      const views = waterMeshInputViewFacts(frame);
      expect(views).toHaveLength(2);

      const eyeAspects: number[] = [];
      for (const eye of ['left', 'right'] as const) {
        const viewport = stereoEyeViewport(
          sourceCamera.view.viewport,
          sourceCamera.stereo,
          eye,
          new Float32Array(4),
        );
        const extent = cameraViewExtent({ ...sourceCamera.view, viewport }, 128, 96);
        const expectedCamera = cameraForView(frame.cameras, cameraEntity, {
          width: extent.renderWidth,
          height: extent.renderHeight,
          eye,
        });
        if (expectedCamera === undefined)
          throw new Error('WaterMesh stereo fixture eye camera did not resolve');
        const expectedFrustum = buildCameraFrusta([expectedCamera])[0];
        const actualView = views.find(
          ([viewIdentity]) => viewIdentity === renderFeatureViewIdentity(expectedCamera),
        );
        expect(actualView?.[4]).toEqual(Array.from(expectedFrustum ?? new Float32Array(0)));
        eyeAspects.push(extent.renderWidth / extent.renderHeight);
      }

      expect(eyeAspects[0]).toBe(eyeAspects[1]);
      expect(views[0]?.[4]).not.toEqual(views[1]?.[4]);
      eyeAspectByLayout.set(layout, eyeAspects[0] ?? 0);
    }

    expect(eyeAspectByLayout.get('side-by-side')).not.toBe(eyeAspectByLayout.get('top-bottom'));
  });

  it('keeps auto-aspect WaterMesh frusta conservative when source view facts are absent or invalid', async () => {
    const packed = await buildWaterPackOutputs(
      { body: lake() },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000499') },
    );
    if (!packed.ok || packed.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh unresolved-view fixture body must cook successfully');
    const noFacts = await extractCrossWorldWaterMesh(packed.value.body, {
      canvasWidth: 128,
      canvasHeight: 64,
      cameraView: null,
      facts: null,
    });
    const invalidFacts = await extractCrossWorldWaterMesh(packed.value.body, {
      canvasWidth: 128,
      canvasHeight: 64,
      cameraView: null,
      facts: {
        version: 1,
        canvasExtent: { width: 0, height: 64 },
        maxRenderShortSide: 0,
      },
    });
    expect(waterMeshInputViewFacts(noFacts.frame).map((view) => view[4])).toEqual([null]);
    expect(waterMeshInputViewFacts(invalidFacts.frame).map((view) => view[4])).toEqual([null]);

    const fixedAspect = await extractCrossWorldWaterMesh(packed.value.body, {
      canvasWidth: 128,
      canvasHeight: 64,
      cameraView: null,
      autoAspect: false,
      facts: null,
    });
    expect(waterMeshInputViewFacts(fixedAspect.frame)[0]?.[4]).not.toBeNull();
  });

  it('does not enumerate Zones for an empty WaterSystem on a quiet frame', () => {
    const world = new World();
    const enumerateZones = vi.fn(() => []);
    const water = new WaterSystem(
      () => undefined,
      () => [],
      enumerateZones,
    );
    const snapshots = vi.spyOn(water, 'snapshots');
    world.insertResource(WATER_SYSTEM_RESOURCE, water);

    const frame = extractFrame(
      world,
      prepareExtractContext(world, {
        renderables: 'none',
        cull: 'none',
        view: resolvedView(world),
      }),
    );

    expect(frame.renderables).toEqual([]);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(enumerateZones).not.toHaveBeenCalled();
  });
});
