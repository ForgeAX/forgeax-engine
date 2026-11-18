import { Time, World } from '@forgeax/engine-ecs';
import { interleavedMesh } from '@forgeax/engine-geometry';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import {
  ok,
  type TerrainAsset,
  type WaterBodyAsset,
  type WaterZoneAsset,
} from '@forgeax/engine-types';
import {
  buildWaterPackOutputs,
  decodeWaterInfoGroundHeight,
  WATER_SYSTEM_RESOURCE,
  WATER_WAVE_LWC_TILE_LENGTH_M,
  type WaterBodySnapshot,
  WaterSystem,
  type WaterZoneGroundSnapshot,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFeaturePlanContext, RenderFeatureWork } from '../../features/plan';
import type {
  RenderFeatureGraphResourceState,
  RenderFeatureSubmission,
} from '../../features/types';
import { materialDepthStencil } from '../../material-render-state';
import {
  createWaterInfoFeature,
  inspectWaterInfoPublications,
  isWaterInfoBodyGeometryAccepted,
  isWaterInfoGroundCurrent,
  type WaterInfoPublicationInput,
  waterInfoFramePublicationForRenderer,
  waterInfoTargetRosterIsValid,
} from '../water-info-feature';
import {
  waterInfoClearWgsl,
  waterInfoFinalizeWgsl,
  waterInfoMergeWgsl,
} from '../water-info-producer';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

function bodyGeometryState(overrides: Record<string, unknown> = {}) {
  return {
    dirty: new Set(),
    outputs: { geometry: 'ready' },
    outputGenerations: { geometry: 4 },
    outputReceipts: { geometry: { outputGeneration: 4 } },
    ...overrides,
  } as unknown as Pick<
    WaterBodySnapshot,
    'dirty' | 'outputs' | 'outputGenerations' | 'outputReceipts'
  >;
}

function submissionForWaterInfoWork(work: readonly RenderFeatureWork[]): RenderFeatureSubmission {
  return {
    works: work.map((row) => ({
      scope: row.scope,
      passes: row.passes.map((pass) => ({
        name: pass.name,
        ...(pass.kind === 'raster'
          ? { graphics: { draws: pass.draws.map((draw) => ({ kind: draw.draw.kind })) } }
          : {}),
        ...(pass.kind === 'compute'
          ? { resolvedGpuComputeDispatchCount: pass.dispatches.length }
          : {}),
      })),
    })),
  };
}

function waterInfoPlanContext(frameNumber: number): RenderFeaturePlanContext {
  return {
    caps: {
      compute: true,
      storageBuffer: true,
      storageTexture: true,
      rgba16floatRenderable: true,
      rgba16floatStorage: true,
    } as never,
    frame: { frameNumber },
    generation: 1,
    views: [],
  };
}

function submissionForWaterInfoFrame(
  feature: ReturnType<typeof createWaterInfoFeature>,
  frame: Parameters<NonNullable<typeof feature.plan>>[0],
  frameNumber: number,
): RenderFeatureSubmission {
  const plan = feature.plan(frame, waterInfoPlanContext(frameNumber));
  if (!plan.ok) throw plan.error;
  return submissionForWaterInfoWork(plan.value.work);
}

it('skips local GPU WaterMesh owner matching when every accepted zone lacks a GPU mesh', () => {
  const zoneGuid = '019ffa97-7000-7000-8000-000000000099';
  const zoneAsset: WaterZoneAsset = {
    kind: 'water-zone',
    extentM: { spanXM: 16, spanZM: 16 },
    tileSizeM: 8,
    tessellationFactor: 1,
    lodScale: 1,
    waterInfo: {
      resolution: { widthPx: 16, heightPx: 16 },
      format: 'rgba16f',
      blurRadius: 0,
      localTessellation: false,
      localExtentM: [16, 100, 16],
    },
  };
  const zone = {
    guid: zoneGuid,
    generation: 1,
    asset: zoneAsset,
    worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
  const water = new WaterSystem(
      (guid) => (guid === zoneGuid ? { generation: 1, asset: zoneAsset } : undefined),
      () => [],
      () => [zone],
    ),
    snapshots = vi.spyOn(water, 'snapshots'),
    roster = vi.spyOn(water, 'waterMeshOwnerRoster');
  const world = new World();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  const result = createWaterInfoFeature().extract({
    world: world,
    frameNumber: 1,
    caps: {
      compute: true,
      storageBuffer: true,
      rgba16floatRenderable: true,
      rgba16floatStorage: true,
    } as never,
    views: [
      {
        identity: 'no-gpu-mesh-view',
        render: true,
        frame: {
          view: {
            identity: 'no-gpu-mesh-view',
            width: 64,
            height: 64,
            cameraRevision: 0,
            deviceGeneration: 1,
            cameraPosition: [0, 4, 0],
          },
        },
      },
    ],
  });
  expect(result.ok).toBe(true);
  expect(result.ok ? (result.value.views[0]?.gpuMeshes ?? []) : undefined).toEqual([]);
  // The accepted proxy roster is still published once above. The four body
  // snapshots belong to the existing WaterInfo passes; local GPU admission
  // adds no fifth snapshot/filter walk.
  expect(roster).toHaveBeenCalledOnce();
  expect(snapshots).toHaveBeenCalledTimes(4);
});

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

describe('WaterInfo submission target roster', () => {
  const target = (targetName: string, write: boolean) => ({
    targetName,
    targetFormat: 'rgba16float' as const,
    write,
  });

  it('rejects duplicate names and multiple writers for one format while allowing retained targets', () => {
    expect(
      waterInfoTargetRosterIsValid([
        target('water-info-current', true),
        target('water-info-current', false),
      ]),
    ).toBe(false);
    expect(
      waterInfoTargetRosterIsValid([
        target('water-info-current', true),
        target('water-info-next', true),
      ]),
    ).toBe(false);
    expect(
      waterInfoTargetRosterIsValid([
        target('water-info-next', true),
        target('water-info-previous', false),
      ]),
    ).toBe(true);
  });
});

describe('WaterInfo work program declarations', () => {
  it('builds writer programs only for formats with a writing target', () => {
    const feature = createWaterInfoFeature();
    const viewIdentity = 'writer-filter-view';
    const graphOwner = Object.freeze({});
    const planContext = (frameNumber: number): RenderFeaturePlanContext => ({
      caps: {
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatRenderable: true,
        rgba16floatStorage: true,
        rgba32floatRenderable: true,
        rgba32floatStorage: true,
      } as never,
      frame: { frameNumber },
      generation: 1,
      views: [
        {
          identity: viewIdentity,
          render: true,
          graphResources: { owner: graphOwner, retained: true },
          frame: { frameNumber },
          targets: [],
          sceneData: { deviceGeneration: 1 } as never,
        },
      ],
    });
    const makeCapture = (
      format: 'rgba16f' | 'rgba32f',
      sourceDigest: string,
    ): WaterInfoPublicationInput['views'][number]['captures'][number] => {
      const zoneGuid = `zone-${format}`;
      const zone = {
        guid: zoneGuid,
        generation: 1,
        worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        asset: {
          kind: 'water-zone' as const,
          extentM: { spanXM: 16, spanZM: 16 },
          tileSizeM: 8,
          tessellationFactor: 1,
          lodScale: 1,
          waterInfo: {
            resolution: { widthPx: 32, heightPx: 32 },
            format,
            blurRadius: 0,
            localTessellation: false,
            localExtentM: [16, 100, 16] as const,
          },
        },
      };
      const contextFormat = format === 'rgba32f' ? 'rgba32f' : 'rgba16f';
      return {
        worldId: 0,
        worldIdentity: 'writer-filter-world',
        zoneGuid,
        zone,
        context: {
          zoneGuid: JSON.stringify(['writer-filter-world', zoneGuid]),
          viewId: 'shared',
          centerXZ: [0, 0],
          extentXZ: [16, 16],
          waterYMinM: 0,
          waterYMaxM: 10,
          groundYMinM: -10,
          maxVelocityMPerSec: 10.24,
          format: contextFormat,
          widthPx: 32,
          heightPx: 32,
          blurRadius: 0,
          zoneGeneration: 1,
          sourceDigest,
        },
        captureZM: 0,
        waterVertices: new Float32Array(0),
        groundVertices: new Float32Array(0),
        dilationVertices: new Float32Array(0),
      };
    };
    const makeInput = (
      sourceFrameGeneration: number,
      rgba16Digest: string,
      rgba32Digest: string,
    ): WaterInfoPublicationInput => {
      const captures = [makeCapture('rgba16f', rgba16Digest), makeCapture('rgba32f', rgba32Digest)];
      const bodies: WaterInfoPublicationInput['views'][number]['bodies'][number][] = captures.map(
        (capture, index) => {
          const bodyGuid = `body-${index}`;
          const bodyGeneration = 1;
          const zoneGeneration = capture.zone.generation;
          return {
            kind: 'water-info',
            ownerKey: waterBodyOwnerKey(
              capture.worldIdentity,
              bodyGuid,
              bodyGeneration,
              zoneGeneration,
            ),
            worldId: capture.worldId,
            worldIdentity: capture.worldIdentity,
            bodyGuid,
            bodyGeneration,
            outputGeneration: 1,
            zoneGuid: capture.zoneGuid,
            zoneGeneration,
            targetFormat: capture.context.format === 'rgba32f' ? 'rgba32float' : 'rgba16float',
            waveBody: {
              worldId: capture.worldId,
              worldIdentity: capture.worldIdentity,
              bodyGuid,
              bodyGeneration,
              zoneGeneration,
              waveSet: {
                inputDigest: '0'.repeat(64),
                waves: [],
                depthMaskM: 0,
                maxWaveHeightM: 0,
                timeSource: 'scene-clock',
              },
              timeSeconds: 0,
              previousTimeSeconds: 0,
              baseHeightM: 0,
              tileOriginWorldXZ: [0, 0],
              tileLengthM: WATER_WAVE_LWC_TILE_LENGTH_M,
              heightSource: {
                kind: 'fixed',
                fixedHeightM: 0,
                fixedDepthM: 0,
                fixedVelocityXZ: [0, 0],
              },
              dynamicBoundsCenterExtentXZ: [0, 0, 16, 16],
              supportsWaves: false,
              usesFlatSurfaceHeight: true,
              meshEdgeOverlayEnabled: false,
            },
          };
        },
      );
      return {
        kind: 'forgeax-water-info-input',
        version: 6,
        sourceSession: 'writer-filter-session',
        sourceFrameGeneration,
        views: [
          {
            viewIdentity,
            sourceFrameGeneration,
            captures,
            bodies,
            meshOwners: [],
            meshCandidates: [],
            gpuMeshes: [],
          },
        ],
      };
    };
    const resourceNames = (plan: RenderFeaturePlan) =>
      plan.work.flatMap((work) => work.resources).map((resource) => resource.name);
    const typedResourceNames = (
      plan: RenderFeaturePlan,
      kind: 'compute-program' | 'graphics-program' | 'graphics-bindings' | 'compute-bindings',
    ) =>
      plan.work
        .flatMap((work) => work.resources)
        .filter((resource) => resource.kind === kind)
        .map((resource) => resource.name)
        .sort();
    const makePlan = (input: WaterInfoPublicationInput, frameNumber: number) => {
      const result = feature.plan(input, planContext(frameNumber));
      if (!result.ok) throw result.error;
      expect(result.ok).toBe(true);
      return result.value;
    };
    const firstInput = makeInput(1, '16-first', '32-first');
    const firstPlan = makePlan(firstInput, 1);
    expect(typedResourceNames(firstPlan, 'compute-program')).toEqual(
      [
        'water-info-blur-program-rgba16float',
        'water-info-clear-program-rgba16float',
        'water-info-finalize-program-rgba16float',
        'water-info-merge-program-rgba16float',
        'water-info-retain-program-rgba16float',
        'water-info-blur-program-rgba32float',
        'water-info-clear-program-rgba32float',
        'water-info-finalize-program-rgba32float',
        'water-info-merge-program-rgba32float',
        'water-info-retain-program-rgba32float',
      ].sort(),
    );
    expect(typedResourceNames(firstPlan, 'graphics-program')).toEqual(
      [
        'water-info-raster-dilation-program-rgba16float',
        'water-info-raster-ground-program-rgba16float',
        'water-info-raster-water-program-rgba16float',
        'water-info-raster-dilation-program-rgba32float',
        'water-info-raster-ground-program-rgba32float',
        'water-info-raster-water-program-rgba32float',
      ].sort(),
    );
    feature.onFrameSubmitted?.(firstInput, submissionForWaterInfoWork(firstPlan.work));

    const changedInput = makeInput(2, '16-changed', '32-first');
    const changedPlan = makePlan(changedInput, 2);
    expect(typedResourceNames(changedPlan, 'compute-program')).toEqual(
      [
        'water-info-blur-program-rgba16float',
        'water-info-clear-program-rgba16float',
        'water-info-finalize-program-rgba16float',
        'water-info-merge-program-rgba16float',
        'water-info-retain-program-rgba16float',
        'water-info-retain-program-rgba32float',
      ].sort(),
    );
    expect(typedResourceNames(changedPlan, 'graphics-program')).toEqual(
      [
        'water-info-raster-dilation-program-rgba16float',
        'water-info-raster-ground-program-rgba16float',
        'water-info-raster-water-program-rgba16float',
      ].sort(),
    );
    expect(typedResourceNames(changedPlan, 'graphics-bindings')).toEqual(
      [
        'water-info-raster-dilation-program-rgba16float-bindings',
        'water-info-raster-ground-program-rgba16float-bindings',
        'water-info-raster-water-program-rgba16float-bindings',
      ].sort(),
    );
    expect(typedResourceNames(changedPlan, 'compute-bindings')).toContain(
      'water-info-retain-bindings-water-info-array-rgba32float-epoch-0-bank-0',
    );
    expect(resourceNames(changedPlan)).toContain(
      'water-info-clear-bindings-water-info-array-rgba16float-epoch-1-bank-0',
    );
    feature.onFrameSubmitted?.(changedInput, submissionForWaterInfoWork(changedPlan.work));

    const retainInput = makeInput(3, '16-changed', '32-first');
    const retainPlan = makePlan(retainInput, 3);
    expect(typedResourceNames(retainPlan, 'compute-program')).toEqual(
      ['water-info-retain-program-rgba16float', 'water-info-retain-program-rgba32float'].sort(),
    );
    expect(typedResourceNames(retainPlan, 'graphics-program')).toEqual([]);
    expect(typedResourceNames(retainPlan, 'graphics-bindings')).toEqual([]);
    expect(typedResourceNames(retainPlan, 'compute-bindings')).toEqual(
      [
        'water-info-retain-bindings-water-info-array-rgba16float-epoch-1-bank-0',
        'water-info-retain-bindings-water-info-array-rgba32float-epoch-0-bank-0',
      ].sort(),
    );
    expect(
      retainPlan.work
        .flatMap((work) => work.passes)
        .map((pass) => pass.name)
        .sort(),
    ).toEqual(
      [
        'water-info-retain-water-info-array-rgba16float-epoch-1-bank-0',
        'water-info-retain-water-info-array-rgba32float-epoch-0-bank-0',
      ].sort(),
    );
  });
});

describe('WaterInfo startup input readiness', () => {
  it('advances previous wave time only on accepted submission and converges at a paused time', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000490');
    const point = (inputKey: number, x: number, z: number) => ({
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
      interpolationMode: 'linear' as const,
      rotationQuat: [0, 0, 0, 1] as const,
    });
    const packed = (
      await buildWaterPackOutputs(
        {
          body: {
            kind: 'water-body',
            type: 'lake',
            spline: {
              closed: true,
              points: [point(0, -2, -2), point(1, 2, -2), point(2, 2, 2), point(3, -2, 2)],
            },
            baseHeightM: 0,
            overlapPriority: 0,
            maxWaveHeightM: 0,
            surfaceMaterialGuid: AssetGuid.format(AssetGuid.derive(packageId, 'material')),
            flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
            collision: { type: 'none', enabled: false },
            queryFootprint: [
              [-2, -2],
              [2, -2],
              [2, 2],
              [-2, 2],
            ],
          },
        },
        { packageId },
      )
    ).unwrap();
    const system = new WaterSystem(() => undefined);
    system.mountBody('body', '1', packed.body).unwrap();
    const world = new World();
    world.insertResource(WATER_SYSTEM_RESOURCE, system);
    const feature = createWaterInfoFeature();
    const extract = (frameNumber: number) =>
      feature
        .extract({
          world: world,
          frameNumber,
          caps: {
            compute: true,
            storageBuffer: true,
            rgba16floatRenderable: true,
            rgba16floatStorage: true,
          } as never,
          views: [
            {
              identity: 'time-view',
              render: true,
              frame: {
                view: {
                  identity: 'time-view',
                  width: 64,
                  height: 64,
                  cameraRevision: 0,
                  deviceGeneration: 1,
                  cameraPosition: [0, 4, 0],
                },
              },
            },
          ],
        })
        .unwrap();
    const bodyTime = (frame: ReturnType<typeof extract>) => {
      const body = frame.views[0]?.publication.waveUploadPlan.bodyData[0];
      if (body === undefined) throw new Error('missing independent Body wave data');
      return { timeSeconds: body.timeSeconds, previousTimeSeconds: body.previousTimeSeconds };
    };
    world.update(1 / 60).unwrap();
    const initialTime = world.getResource(Time).elapsed;
    const first = extract(1);
    expect(bodyTime(first)).toEqual({ timeSeconds: initialTime, previousTimeSeconds: initialTime });
    feature.onFrameSubmitted?.(first, submissionForWaterInfoFrame(feature, first, 1));
    world.update(1 / 60).unwrap();
    const aborted = extract(2);
    const abortedSubmission = submissionForWaterInfoFrame(feature, aborted, 2);
    feature.onFrameAborted?.(aborted);
    feature.onFrameSubmitted?.(aborted, abortedSubmission);
    world.update(1 / 60).unwrap();
    const rejected = extract(3);
    expect(bodyTime(rejected).previousTimeSeconds).toBe(initialTime);
    feature.onFrameSubmitted?.(rejected, { works: [] });
    world.update(1 / 60).unwrap();
    const pausedTime = world.getResource(Time).elapsed;
    const stepped = extract(4);
    expect(bodyTime(stepped)).toEqual({
      timeSeconds: pausedTime,
      previousTimeSeconds: initialTime,
    });
    feature.onFrameSubmitted?.(stepped, submissionForWaterInfoFrame(feature, stepped, 4));
    const settled = extract(5);
    expect(bodyTime(settled)).toEqual({ timeSeconds: pausedTime, previousTimeSeconds: pausedTime });
    feature.onFrameSubmitted?.(settled, submissionForWaterInfoFrame(feature, settled, 5));
    expect(bodyTime(extract(6))).toEqual({
      timeSeconds: pausedTime,
      previousTimeSeconds: pausedTime,
    });
  });

  it('defers an explicitly pending independent WaveSet and admits its refreshed generation', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000489');
    const waveSetGuid = AssetGuid.format(AssetGuid.derive(packageId, 'waves'));
    const point = (inputKey: number, x: number, z: number) => ({
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
      interpolationMode: 'linear' as const,
      rotationQuat: [0, 0, 0, 1] as const,
    });
    const packed = (
      await buildWaterPackOutputs(
        {
          body: {
            kind: 'water-body',
            type: 'lake',
            spline: {
              closed: true,
              points: [point(0, -2, -2), point(1, 2, -2), point(2, 2, 2), point(3, -2, 2)],
            },
            baseHeightM: 0,
            overlapPriority: 0,
            maxWaveHeightM: 0.2,
            surfaceMaterialGuid: AssetGuid.format(AssetGuid.derive(packageId, 'material')),
            flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
            collision: { type: 'none', enabled: false },
            queryFootprint: [
              [-2, -2],
              [2, -2],
              [2, 2],
              [-2, 2],
            ],
          },
        },
        { packageId },
      )
    ).unwrap();
    let available = false;
    const waveSet = (
      await buildWaterPackOutputs(
        {
          waves: {
            kind: 'water-wave-set',
            waveSource: {
              kind: 'predefined',
              waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.1, steepness: 0 }],
            },
            depthMaskM: 4,
            maxWaveHeightM: 0.2,
            timeSource: 'scene-clock',
          },
        },
        { packageId },
      )
    ).unwrap().waves;
    let payload: unknown = waveSet;
    const system = new WaterSystem(
      () => undefined,
      () => [
        {
          guid: waveSetGuid,
          field: 'waveSetGuid',
          kind: 'water-wave-set',
          status: available ? 'valid' : 'pending',
          ...(available ? { payload } : {}),
        },
        {
          guid: AssetGuid.format(AssetGuid.derive(packageId, 'collision')),
          field: 'collisionMeshGuid',
          kind: 'mesh',
          status: 'unavailable',
        },
      ],
    );
    const mounted = system
      .mountBody('body', '1', { ...(packed.body as WaterBodyAsset), waveSetGuid })
      .unwrap();
    const world = new World();
    world.insertResource(WATER_SYSTEM_RESOURCE, system);
    world.update(1 / 60).unwrap();
    const feature = createWaterInfoFeature();
    const extract = (frameNumber: number) =>
      feature.extract({
        world: world,
        frameNumber,
        caps: {
          compute: true,
          storageBuffer: true,
          rgba16floatRenderable: true,
          rgba16floatStorage: true,
        } as never,
        views: [
          {
            identity: 'test-view',
            render: true,
            frame: {
              view: {
                identity: 'test-view',
                width: 64,
                height: 64,
                cameraRevision: 0,
                deviceGeneration: 1,
                cameraPosition: [0, 4, 0],
              },
            },
          },
        ],
      });
    const pending = extract(1).unwrap();
    expect(pending.views[0]?.publication.waveBodies).toEqual([]);
    available = true;
    expect(system.refreshDependencies('body', ['waterInfo', 'query', 'material']).unwrap()).toBe(
      true,
    );
    const admitted = extract(2).unwrap();
    expect(admitted.views[0]?.publication.waveBodies[0]).toMatchObject({
      bodyGuid: 'body',
      bodyGeneration: system.snapshot('body')?.sceneGeneration,
      waveSetGuid,
    });
    const admittedView = requiredValue(admitted.views[0], 'admitted view');
    const admittedWaveBody = requiredValue(
      admittedView.publication.waveBodies[0],
      'admitted wave body',
    );
    expect(admittedWaveBody.bodyGeneration).toBeGreaterThan(mounted.sceneGeneration);
    payload = { ...waveSet, waves: [] };
    expect(system.refreshDependencies('body', ['waterInfo', 'query', 'material']).unwrap()).toBe(
      true,
    );
    expect(extract(3).ok).toBe(false);
  });

  it('declares raster material shaders through the engine registry contract', () => {
    const feature = createWaterInfoFeature();
    expect(feature.shaderModuleMode).toBe('immediate');
    expect(feature.requiredMaterialShaders).toEqual([
      'forgeax::water-info-raster-water',
      'forgeax::water-info-raster-ground',
      'forgeax::water-info-raster-dilation',
    ]);
  });

  it('uses the 2D output extent when finalizing an array slice', () => {
    const shader = waterInfoFinalizeWgsl('rgba16float');
    expect(shader).toContain('let size = textureDimensions(output);');
    expect(shader).toContain('if (id.x >= size.x || id.y >= size.y) { return; }');
    expect(shader).not.toContain('size.z');
  });

  it('clears the requested array layers without reading a nonexistent 2D extent component', () => {
    const shader = waterInfoClearWgsl('rgba16float');
    expect(shader).toContain('let size = textureDimensions(output);');
    expect(shader).toContain('if (id.x >= size.x || id.y >= size.y) { return; }');
    expect(shader).not.toContain('size.z');
  });

  it('keeps the ground channel on the shared water maximum', () => {
    const shader = waterInfoMergeWgsl('rgba16float');
    expect(shader).toContain('let groundNormalized = normalizeRange(groundY, ranges.z, ranges.y);');
    expect(shader).toContain(
      'textureStore(output, vec2<i32>(id.xy), vec4<f32>(0.0, 0.0, 0.0, groundNormalized));',
    );
  });

  it('defers a Zone while the participating Body geometry is dirty or not accepted', () => {
    expect(
      isWaterInfoBodyGeometryAccepted(bodyGeometryState({ dirty: new Set(['geometry']) })),
    ).toBe(false);
    expect(
      isWaterInfoBodyGeometryAccepted(bodyGeometryState({ outputs: { geometry: 'unsupported' } })),
    ).toBe(false);
    expect(isWaterInfoBodyGeometryAccepted(bodyGeometryState({ outputReceipts: {} }))).toBe(false);
    expect(
      isWaterInfoBodyGeometryAccepted(
        bodyGeometryState({ outputReceipts: { geometry: { outputGeneration: 3 } } }),
      ),
    ).toBe(false);
  });

  it('accepts only the current Body geometry receipt', () => {
    expect(isWaterInfoBodyGeometryAccepted(bodyGeometryState())).toBe(true);
  });

  it('accepts dirty Zone ground input from the matching Zone generation', () => {
    expect(isWaterInfoGroundCurrent(undefined, 7)).toBe(true);
    expect(
      isWaterInfoGroundCurrent({ dirty: false, zoneGeneration: 7 } as WaterZoneGroundSnapshot, 7),
    ).toBe(true);
    expect(
      isWaterInfoGroundCurrent({ dirty: true, zoneGeneration: 7 } as WaterZoneGroundSnapshot, 7),
    ).toBe(true);
    expect(
      isWaterInfoGroundCurrent({ dirty: false, zoneGeneration: 6 } as WaterZoneGroundSnapshot, 7),
    ).toBe(false);
  });

  it('defers pending Body geometry and accepts dirty ground only from submitted captures', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000499');
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const zoneGuid = guid('zone/main');
    const zone: WaterZoneAsset = {
      kind: 'water-zone',
      extentM: { spanXM: 16, spanZM: 16 },
      tileSizeM: 8,
      tessellationFactor: 1,
      lodScale: 1,
      waterInfo: {
        resolution: { widthPx: 32, heightPx: 32 },
        format: 'rgba16f',
        blurRadius: 0,
        localTessellation: true,
        localExtentM: [16, 100, 16],
      },
    };
    const point = (inputKey: number, x: number, z: number) => ({
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
      interpolationMode: 'linear' as const,
      rotationQuat: [0, 0, 0, 1] as const,
    });
    const lake = (baseHeightM: number) =>
      ({
        kind: 'water-body',
        type: 'lake',
        zoneGuid,
        spline: {
          closed: true,
          points: [point(0, -2, -2), point(1, 2, -2), point(2, 2, 2), point(3, -2, 2)],
        },
        baseHeightM,
        overlapPriority: 0,
        maxWaveHeightM: 0.2,
        surfaceMaterialGuid: guid('material/lake'),
        flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
        collision: { type: 'none', enabled: false },
        queryFootprint: [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ],
      }) as const;
    const packed = await buildWaterPackOutputs(
      { 'body/lake': lake(0), 'body/lake-pending': lake(0.5) },
      { packageId },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const outputByGuid = new Map(
      Object.entries(packed.value).map(([key, asset]) => [
        guid(key).toLowerCase(),
        asset.kind === 'mesh' ? interleavedMesh(asset) : asset,
      ]),
    );
    const dependencyFields = [
      'waterInfoMeshGuid',
      'dilatedWaterInfoMeshGuid',
      'visibleMeshGuid',
    ] as const;
    const water = new WaterSystem(
      (candidate) => (candidate === zoneGuid ? { generation: 1, asset: zone } : undefined),
      (asset) =>
        dependencyFields.flatMap((field) => {
          const dependencyGuid = asset[field];
          if (!dependencyGuid) return [];
          const payload = outputByGuid.get(dependencyGuid.toLowerCase());
          return payload === undefined
            ? []
            : [{ guid: dependencyGuid, field, kind: 'mesh', status: 'valid' as const, payload }];
        }),
      () => [{ guid: zoneGuid, generation: 1, asset: zone }],
    );
    const ownerGuid = 'scene-entity:water-info-stable';
    const pendingOwnerGuid = 'scene-entity:water-info-pending';
    const body = packed.value['body/lake'] as WaterBodyAsset;
    const stableBody = water.mountBody(ownerGuid, '1', body).unwrap();
    water
      .acceptOutput(ownerGuid, 'geometry', stableBody.outputGenerations.geometry, {
        generation: 1,
        digest: 'geometry-stable',
      })
      .unwrap();
    water
      .buildZoneMeshView(zoneGuid, 1, zone, { viewId: 'test-view', observerM: [0, 4, 0] })
      .unwrap();
    const world = new World();
    world.insertResource(WATER_SYSTEM_RESOURCE, water);
    world.update(1 / 60).unwrap();
    const feature = createWaterInfoFeature();
    const errors: unknown[] = [];
    let graphResources: RenderFeatureGraphResourceState | undefined = {
      owner: Object.freeze({}),
      retained: true,
    };
    const extract = (
      frameNumber: number,
      deviceGeneration = 1,
      cameraPosition: readonly [number, number, number] = [0, 4, 0],
    ) => {
      const result = feature.extract({
        world: world,
        frameNumber,
        caps: {
          compute: true,
          storageBuffer: true,
          rgba16floatRenderable: true,
          rgba16floatStorage: true,
        } as never,
        views: [
          {
            identity: 'test-view',
            render: true,
            ...(graphResources === undefined ? {} : { graphResources }),
            frame: {
              view: {
                identity: 'test-view',
                width: 64,
                height: 64,
                cameraRevision: 0,
                deviceGeneration,
                cameraPosition,
              },
            },
          },
        ],
        reportError: (error) => errors.push(error),
      });
      if (!result.ok) throw result.error;
      return result.value;
    };

    const initialFrame = extract(1);
    expect(initialFrame.views[0]?.captures).toHaveLength(1);
    expect(initialFrame.views[0]?.publication.waveBodies[0]?.dynamicBoundsCenterExtentXZ).toEqual([
      0, 0, 16, 16,
    ]);
    const initialView = requiredValue(initialFrame.views[0], 'initial view');
    const initialCapture = requiredValue(initialView.captures[0], 'initial capture');
    expect(initialCapture.context.groundYMinM).toBe(initialCapture.context.waterYMinM - 30);
    expect(initialFrame.views[0]?.publication.targets.some((target) => target.write)).toBe(true);
    const plan = feature.plan(initialFrame, {
      caps: {
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatRenderable: true,
        rgba16floatStorage: true,
      } as never,
      frame: { frameNumber: 1 },
      generation: 1,
      views: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw plan.error;
    const computePrograms = plan.value.work
      .flatMap((work) => work.resources)
      .filter((resource) => resource.kind === 'compute-program');
    expect(computePrograms).toHaveLength(5);
    expect(computePrograms.every((program) => program.preparePipelines === true)).toBe(true);
    const rasterPrograms = plan.value.work
      .flatMap((work) => work.resources)
      .filter((resource) => resource.kind === 'graphics-program');
    expect(rasterPrograms).toHaveLength(3);
    expect(rasterPrograms.every((program) => program.program.preparePipelines === true)).toBe(true);
    expect(
      rasterPrograms.every(
        (program) =>
          materialDepthStencil('depth32float', program.program.renderState).depthCompare === 'less',
      ),
    ).toBe(true);
    expect(
      plan.value.work
        .flatMap((work) => work.passes)
        .filter((pass) => pass.kind === 'raster')
        .every((pass) => pass.depthStencilAttachment?.depthClearValue === 1),
    ).toBe(true);
    const rasterBindings = plan.value.work
      .flatMap((work) => work.resources)
      .filter((resource) => resource.kind === 'graphics-bindings');
    expect(rasterBindings).toHaveLength(3);
    expect(rasterBindings.every((binding) => Object.keys(binding.values).length === 0)).toBe(true);
    const rasterDraws = plan.value.work
      .flatMap((work) => work.passes)
      .filter((pass) => pass.kind === 'raster')
      .flatMap((pass) => pass.draws);
    expect(rasterDraws.length).toBeGreaterThan(0);
    for (const draw of rasterDraws) {
      expect(draw.bindings).toHaveLength(1);
      const binding = rasterBindings.find((candidate) => candidate.name === draw.bindings[0]);
      expect(binding?.program).toBe(draw.program);
    }
    expect(errors).toEqual([]);
    expect(inspectWaterInfoPublications(feature, 1)).toEqual([]);
    feature.onFrameSubmitted?.(initialFrame, submissionForWaterInfoWork(plan.value.work));
    feature.onFrameReceipt?.(
      {
        frameId: 1,
        deviceGeneration: 1,
        presentation: 'ready',
        completed: Promise.resolve(ok(undefined)),
      },
      Promise.resolve(ok([])),
    );
    await Promise.resolve();
    const observed = inspectWaterInfoPublications(feature, 1);
    expect(observed[0]?.frameGeneration).toBe(1);
    expect(observed[0]?.rows.some((row) => row.bodyGuid === ownerGuid)).toBe(true);
    expect(inspectWaterInfoPublications(feature, 2)).toEqual([]);
    requiredFixtureValue(
      (requiredFixtureValue(observed[0]).targets as { targetName: string }[])[0],
    ).targetName = 'detached-edit';
    expect(inspectWaterInfoPublications(feature, 1)[0]?.targets[0]?.targetName).not.toBe(
      'detached-edit',
    );
    const acceptedStable = requiredFixtureValue(water.snapshot(ownerGuid));
    const acceptedStableWaterInfo = acceptedStable.outputReceipts.waterInfo;
    expect(acceptedStableWaterInfo).toMatchObject({
      outputGeneration: stableBody.outputGenerations.waterInfo,
      consumerGeneration: 1,
      digest: initialCapture.context.sourceDigest,
    });
    expect(acceptedStable.dirty.has('waterInfo')).toBe(false);
    expect(acceptedStable.dirty.has('material')).toBe(true);
    expect(acceptedStable.outputReceipts.material).toBeUndefined();

    const pendingBody = water
      .mountBody(pendingOwnerGuid, '1', packed.value['body/lake-pending'] as WaterBodyAsset)
      .unwrap();
    const pendingFrame = extract(2, 1, [11, 4, 15]);
    expect(pendingFrame.views[0]?.captures).toHaveLength(0);
    expect(
      pendingFrame.views[0]?.publication.waveBodies.find((body) => body.bodyGuid === ownerGuid)
        ?.dynamicBoundsCenterExtentXZ,
    ).toEqual([0, 0, 16, 16]);
    expect(
      pendingFrame.views[0]?.publication.waveBodies.find(
        (body) => body.bodyGuid === pendingOwnerGuid,
      )?.dynamicBoundsCenterExtentXZ,
    ).toEqual([8, 16, 16, 16]);
    expect(pendingFrame.views[0]?.publication.targets).toEqual(
      initialFrame.views[0]?.publication.targets.map((target) => ({ ...target, write: false })),
    );
    expect(
      [...requiredFixtureValue(pendingFrame.views[0]).publication.rows.values()].map(
        (row) => row.bodyGuid,
      ),
    ).toContain(ownerGuid);
    expect(errors).toEqual([]);
    const retainedSubmission = submissionForWaterInfoFrame(feature, pendingFrame, 2);
    expect(retainedSubmission.works[0]?.passes.map((pass) => pass.name)).toEqual(
      pendingFrame.views[0]?.publication.targets.map(
        (target) => `water-info-retain-${target.targetName}`,
      ),
    );
    feature.onFrameSubmitted?.(pendingFrame, retainedSubmission);
    const committedPublication = waterInfoFramePublicationForRenderer(feature, 'test-view', 2, 1);
    expect(committedPublication?.frameGeneration).toBe(2);
    expect(water.snapshot(ownerGuid)?.outputReceipts.waterInfo?.consumerGeneration).toBe(1);
    expect(water.snapshot(pendingOwnerGuid)?.outputReceipts.waterInfo).toBeUndefined();
    expect(water.snapshot(pendingOwnerGuid)?.dirty.has('waterInfo')).toBe(true);

    water
      .acceptOutput(pendingOwnerGuid, 'geometry', pendingBody.outputGenerations.geometry, {
        generation: 2,
        digest: 'geometry-pending',
      })
      .unwrap();
    const ground = water.observeZoneGroundInputs(zoneGuid, 1, []);
    expect(ground?.dirty).toBe(true);
    const abortedFrame = extract(3);
    expect(inspectWaterInfoPublications(feature, 1)[0]?.frameGeneration).toBe(2);
    expect(abortedFrame.views[0]?.captures).toHaveLength(1);
    expect(abortedFrame.views[0]?.captures[0]?.groundGeneration).toBe(ground?.generation);
    expect(abortedFrame.views[0]?.publication.targets.some((target) => target.write)).toBe(true);
    feature.onFrameAborted?.(abortedFrame);
    expect(inspectWaterInfoPublications(feature, 1)[0]?.frameGeneration).toBe(2);
    expect(waterInfoFramePublicationForRenderer(feature, 'test-view', 3, 1)).toBe(
      committedPublication,
    );
    expect(water.zoneGroundSnapshot(zoneGuid)?.dirty).toBe(true);
    expect(water.snapshot(pendingOwnerGuid)?.outputReceipts.waterInfo).toBeUndefined();
    expect(water.snapshot(pendingOwnerGuid)?.dirty.has('waterInfo')).toBe(true);

    const submittedFrame = extract(4);
    expect(submittedFrame.views[0]?.captures).toHaveLength(1);
    expect(submittedFrame.views[0]?.publication.targets.some((target) => target.write)).toBe(true);
    feature.onFrameSubmitted?.(
      submittedFrame,
      submissionForWaterInfoFrame(feature, submittedFrame, 4),
    );
    expect(water.zoneGroundSnapshot(zoneGuid)?.dirty).toBe(false);
    const acceptedPending = requiredFixtureValue(water.snapshot(pendingOwnerGuid));
    expect(acceptedPending.outputReceipts.waterInfo).toMatchObject({
      outputGeneration: pendingBody.outputGenerations.waterInfo,
      consumerGeneration: 4,
      digest: requiredFixtureValue(requiredFixtureValue(submittedFrame.views[0]).captures[0])
        .context.sourceDigest,
    });
    expect(acceptedPending.dirty.has('waterInfo')).toBe(false);
    expect(acceptedPending.dirty.has('material')).toBe(true);
    expect(acceptedPending.outputReceipts.material).toBeUndefined();

    const invalidated = water.invalidateZoneGround(zoneGuid, 1).unwrap();
    const staleFrame = extract(5);
    expect(staleFrame.views[0]?.captures[0]?.groundGeneration).toBe(invalidated.generation);
    expect(staleFrame.views[0]?.publication.targets.some((target) => target.write)).toBe(true);
    const receiptBeforeStaleSubmit = water.snapshot(pendingOwnerGuid)?.outputReceipts.waterInfo;
    water.observeZoneGroundInputs(zoneGuid, 1, [
      {
        entity: 7,
        terrainGuid: guid('terrain/new'),
        terrainVersion: 1,
        worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        boundsXZ: { minM: [-4, -4], maxM: [4, 4] },
        terrainAsset: {
          kind: 'terrain',
          columns: 2,
          rows: 2,
          spacing: 4,
          subsectionVertices: 2,
          heights: new Float32Array([100, 110, 100, 110]),
          weights: new Float32Array(0),
          layers: [],
          materialEncoding: { kind: 'weights' },
          heightRange: [100, 110],
          sections: [],
          grids: [],
        },
      },
    ]);
    feature.onFrameSubmitted?.(staleFrame, submissionForWaterInfoFrame(feature, staleFrame, 5));
    const latestGround = water.zoneGroundSnapshot(zoneGuid);
    expect(latestGround?.generation).toBeGreaterThan(invalidated.generation);
    expect(latestGround?.dirty).toBe(true);
    expect(water.snapshot(pendingOwnerGuid)?.outputReceipts.waterInfo).toEqual(
      receiptBeforeStaleSubmit,
    );
    expect(errors).toEqual([]);

    const incompleteFrame = extract(6);
    expect(incompleteFrame.views[0]?.captures).toHaveLength(1);
    expect(incompleteFrame.views[0]?.publication.targets.some((target) => target.write)).toBe(true);
    const completeSubmission = submissionForWaterInfoFrame(feature, incompleteFrame, 6);
    const withoutFinalize = {
      works: completeSubmission.works.map((work) => ({
        ...work,
        passes: work.passes.filter((pass) => !pass.name.startsWith('water-info-finalize-')),
      })),
    } satisfies RenderFeatureSubmission;
    const receiptBeforeIncomplete = water.snapshot(pendingOwnerGuid)?.outputReceipts.waterInfo;
    feature.onFrameSubmitted?.(incompleteFrame, withoutFinalize);
    expect(water.snapshot(pendingOwnerGuid)?.outputReceipts.waterInfo).toEqual(
      receiptBeforeIncomplete,
    );
    expect(waterInfoFramePublicationForRenderer(feature, 'test-view', 6, 1)?.frameGeneration).toBe(
      5,
    );

    const primaryOwner = {};
    const composedOwner = {};
    const writes = (frame: ReturnType<typeof extract>) =>
      frame.views[0]?.publication.targets.map((target) => target.write);
    graphResources = { owner: primaryOwner, retained: true };
    const primary = extract(7);
    expect(writes(primary)).toEqual([true]);
    feature.onFrameSubmitted?.(primary, submissionForWaterInfoFrame(feature, primary, 7));
    expect(writes(extract(8))).toEqual([false]);

    graphResources = { owner: primaryOwner, retained: false };
    const released = extract(9);
    expect(writes(released)).toEqual([true]);
    feature.onFrameSubmitted?.(released, { works: [] });
    expect(writes(extract(10))).toEqual([true]);
    const delayedPrimary = extract(11);
    const delayedSubmission = submissionForWaterInfoFrame(feature, delayedPrimary, 11);

    graphResources = { owner: composedOwner, retained: true };
    expect(writes(extract(12))).toEqual([true]);
    feature.onFrameSubmitted?.(delayedPrimary, delayedSubmission);
    const composed = extract(13);
    expect(writes(composed)).toEqual([true]);
    feature.onFrameSubmitted?.(composed, submissionForWaterInfoFrame(feature, composed, 13));
    expect(writes(extract(14))).toEqual([false]);

    graphResources = { owner: primaryOwner, retained: true };
    expect(writes(extract(15))).toEqual([true]);

    graphResources = undefined;
    const unknownAllocation = extract(16);
    expect(writes(unknownAllocation)).toEqual([true]);
    feature.onFrameSubmitted?.(
      unknownAllocation,
      submissionForWaterInfoFrame(feature, unknownAllocation, 16),
    );
    expect(writes(extract(17))).toEqual([true]);

    expect(water.zoneMeshView(zoneGuid, 'test-view')).toBeDefined();
    water
      .buildZoneMeshView(zoneGuid, 1, zone, { viewId: 'test-view', observerM: [0, 4, 0] })
      .unwrap();
    expect(water.waterMeshCandidateViews('test-view')).toHaveLength(1);
    extract(18, 2);
    expect(water.zoneMeshView(zoneGuid, 'test-view')).toBeUndefined();
    expect(water.waterMeshCandidateViews('test-view')).toEqual([]);
  });

  it('normalizes WaterInfo height from participants and keeps fixed-height rows current without stale captures', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000500');
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const zoneGuid = guid('zone/main');
    const zone: WaterZoneAsset = {
      kind: 'water-zone',
      extentM: { spanXM: 16, spanZM: 16 },
      tileSizeM: 8,
      tessellationFactor: 1,
      lodScale: 1,
      waterInfo: {
        resolution: { widthPx: 32, heightPx: 32 },
        format: 'rgba16f',
        blurRadius: 0,
        localTessellation: false,
      },
    };
    const point = (inputKey: number, x: number, z: number) => ({
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
      interpolationMode: 'linear' as const,
      rotationQuat: [0, 0, 0, 1] as const,
    });
    const lake = (affectsWaterInfo: boolean) =>
      ({
        kind: 'water-body',
        type: 'lake',
        zoneGuid,
        spline: {
          closed: true,
          points: [point(0, -2, -2), point(1, 2, -2), point(2, 2, 2), point(3, -2, 2)],
        },
        baseHeightM: 0,
        overlapPriority: 0,
        maxWaveHeightM: 0.2,
        surfaceMaterialGuid: guid(`material/lake/${affectsWaterInfo}`),
        flags: { affectsWaterInfo, affectsWaterMesh: true, affectsLandscape: false },
        collision: { type: 'none', enabled: false },
        queryFootprint: [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ],
      }) as const;
    const terrain: TerrainAsset = {
      kind: 'terrain',
      columns: 2,
      rows: 2,
      spacing: 4,
      subsectionVertices: 2,
      heights: new Float32Array([100, 110, 100, 110]),
      weights: new Float32Array(0),
      layers: [],
      materialEncoding: { kind: 'weights' },
      heightRange: [100, 110],
      sections: [],
      grids: [],
    };
    const packed = await buildWaterPackOutputs(
      { 'body/participant': lake(true), 'body/fixed': lake(false) },
      { packageId },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const outputByGuid = new Map(
      Object.entries(packed.value).map(([key, asset]) => [guid(key).toLowerCase(), asset]),
    );
    const dependencyFields = [
      'waterInfoMeshGuid',
      'dilatedWaterInfoMeshGuid',
      'visibleMeshGuid',
    ] as const;
    const makeSystem = (includeParticipant: boolean) => {
      const system = new WaterSystem(
        (candidate) => (candidate === zoneGuid ? { generation: 1, asset: zone } : undefined),
        (asset) =>
          dependencyFields.flatMap((field) => {
            const dependencyGuid = asset[field];
            if (!dependencyGuid) return [];
            const payload = outputByGuid.get(dependencyGuid.toLowerCase());
            return payload === undefined
              ? []
              : [
                  {
                    guid: dependencyGuid,
                    field,
                    kind: 'mesh' as const,
                    status: 'valid' as const,
                    payload,
                  },
                ];
          }),
        () => [{ guid: zoneGuid, generation: 1, asset: zone }],
      );
      if (includeParticipant) {
        const ownerGuid = 'scene-entity:water-info-participant';
        const body = system
          .mountBody(ownerGuid, '1', packed.value['body/participant'] as WaterBodyAsset)
          .unwrap();
        system
          .acceptOutput(ownerGuid, 'geometry', body.outputGenerations.geometry, {
            generation: 1,
            digest: 'participant-geometry',
          })
          .unwrap();
      }
      const fixedOwnerGuid = 'scene-entity:water-info-fixed';
      const fixed = system
        .mountBody(
          fixedOwnerGuid,
          '1',
          packed.value['body/fixed'] as WaterBodyAsset,
          fixedOwnerGuid,
          [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 500, 0, 1],
        )
        .unwrap();
      system.observeZoneGroundInputs(zoneGuid, 1, [
        {
          entity: 1,
          terrainGuid: guid('terrain/high'),
          terrainVersion: 1,
          worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          boundsXZ: { minM: [-4, -4], maxM: [4, 4] },
          terrainAsset: terrain,
        },
      ]);
      const world = new World();
      world.insertResource(WATER_SYSTEM_RESOURCE, system);
      world.update(1 / 60).unwrap();
      return { system, world, fixedOwnerGuid, fixed };
    };
    const feature = createWaterInfoFeature();
    const extract = (world: World, frameNumber: number) => {
      const result = feature.extract({
        world: world,
        frameNumber,
        caps: {
          compute: true,
          storageBuffer: true,
          rgba16floatRenderable: true,
          rgba16floatStorage: true,
        } as never,
        views: [
          {
            identity: 'test-view',
            render: true,
            frame: {
              view: {
                identity: 'test-view',
                width: 64,
                height: 64,
                cameraRevision: 0,
                deviceGeneration: 1,
                cameraPosition: [0, 4, 0],
              },
            },
          },
        ],
      });
      if (!result.ok) throw result.error;
      return result.value;
    };

    const { system, world, fixedOwnerGuid, fixed } = makeSystem(true);
    const acceptedGroundBefore = requiredFixtureValue(system.zoneGroundSnapshot(zoneGuid));
    const originalTerrainHeights = Array.from(
      requiredFixtureValue(requiredFixtureValue(acceptedGroundBefore.providers[0]).terrainAsset)
        .heights,
    );
    const fullGroundSnapshotRead = vi.spyOn(system, 'zoneGroundSnapshot');
    const mixed = extract(world, 1);
    const mixedCapture = mixed.views[0]?.captures[0];
    expect(mixedCapture).toBeDefined();
    const initialGroundVertices = [...requiredFixtureValue(mixedCapture).groundVertices];
    expect(mixedCapture?.context.waterYMinM).toBeGreaterThan(-10);
    expect(mixedCapture?.context.waterYMaxM).toBeLessThan(10);
    expect(mixedCapture?.context.groundYMinM).toBe(100);
    expect(mixedCapture?.context.groundYMinM).toBeGreaterThan(
      mixedCapture?.context.waterYMaxM ?? 0,
    );
    const fixedRow = [...requiredFixtureValue(mixed.views[0]).publication.rows.values()].find(
      (row) => row.bodyGuid === fixedOwnerGuid,
    );
    const fixedWave = requiredFixtureValue(mixed.views[0]).publication.waveBodies.find(
      (body) => body.bodyGuid === fixedOwnerGuid,
    );
    expect(fixed?.dirty.has('geometry')).toBe(true);
    expect(fixedWave).toMatchObject({
      bodyGeneration: fixed.sceneGeneration,
      heightSource: { kind: 'fixed', fixedHeightM: 500 },
    });
    expect(fixedRow?.bodyGeneration).toBe(fixed.sceneGeneration);
    expect(fixedRow?.context.waterYMinM).toBe(mixedCapture?.context.waterYMinM);
    expect(
      new DataView(requiredFixtureValue(fixedRow).descriptor.buffer).getFloat32(20, true),
    ).toBeCloseTo(mixedCapture?.context.waterYMaxM ?? 0, 6);
    expect(mixed.views[0]?.publication.targets.some((target) => target.write)).toBe(true);
    expect(fullGroundSnapshotRead).toHaveBeenCalledTimes(1);
    feature.onFrameSubmitted?.(mixed, submissionForWaterInfoFrame(feature, mixed, 1));
    const stableWarm = extract(world, 2);
    expect(stableWarm.views[0]?.captures[0]?.groundGeneration).toBe(
      acceptedGroundBefore.generation,
    );
    expect(fullGroundSnapshotRead).toHaveBeenCalledTimes(2);
    feature.onFrameSubmitted?.(stableWarm, submissionForWaterInfoFrame(feature, stableWarm, 2));
    expect(fullGroundSnapshotRead).toHaveBeenCalledTimes(2);
    const stableHit = extract(world, 3);
    expect(stableHit.views[0]?.captures[0]).toBe(stableWarm.views[0]?.captures[0]);
    expect(stableHit.views[0]?.publication.targets.some((target) => target.write)).toBe(true);
    expect(fullGroundSnapshotRead).toHaveBeenCalledTimes(2);

    const revisedTerrain: TerrainAsset = {
      ...terrain,
      heights: new Float32Array([200, 210, 200, 210]),
      heightRange: [200, 210],
    };
    const revisedGround = requiredFixtureValue(
      system.observeZoneGroundInputs(zoneGuid, 1, [
        {
          entity: 1,
          terrainGuid: guid('terrain/high'),
          terrainVersion: 2,
          worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          boundsXZ: { minM: [-4, -4], maxM: [4, 4] },
          terrainAsset: revisedTerrain,
        },
      ]),
    );
    expect(revisedGround.generation).toBeGreaterThan(acceptedGroundBefore.generation);
    const revisionFrame = extract(world, 4);
    const revisionCapture = revisionFrame.views[0]?.captures[0];
    expect(revisionCapture).toBeDefined();
    expect(revisionCapture).not.toBe(mixedCapture);
    expect(revisionCapture?.groundGeneration).toBe(revisedGround.generation);
    expect(revisionCapture?.context.groundYMinM).toBe(200);
    expect(fullGroundSnapshotRead).toHaveBeenCalledTimes(3);
    expect(
      Array.from(
        requiredFixtureValue(requiredFixtureValue(acceptedGroundBefore.providers[0]).terrainAsset)
          .heights,
      ),
    ).toEqual(originalTerrainHeights);
    expect(mixedCapture?.groundGeneration).toBe(acceptedGroundBefore.generation);
    expect([...requiredFixtureValue(mixedCapture).groundVertices]).toEqual(initialGroundVertices);
    feature.onFrameSubmitted?.(
      revisionFrame,
      submissionForWaterInfoFrame(feature, revisionFrame, 4),
    );
    expect(fullGroundSnapshotRead).toHaveBeenCalledTimes(3);

    system.observeZoneGroundInputs(zoneGuid, 1, [
      {
        entity: 1,
        terrainGuid: guid('terrain/high'),
        terrainVersion: 1,
        worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        boundsXZ: { minM: [-4, -4], maxM: [4, 4] },
        terrainAsset: terrain,
      },
    ]);

    system.unmountBody('scene-entity:water-info-participant');
    const fixedOnly = extract(world, 5);
    expect(fixedOnly.views[0]?.captures).toHaveLength(1);
    expect(fixedOnly.views[0]?.captures[0]?.context.waterYMinM).toBe(0);
    expect(fixedOnly.views[0]?.captures[0]?.context.waterYMaxM).toBe(110);
    expect(fixedOnly.views[0]?.captures[0]?.context.groundYMinM).toBe(100);
    expect(fixedOnly.views[0]?.captures[0]?.waterVertices).toHaveLength(0);
    expect(fixedOnly.views[0]?.captures[0]?.dilationVertices).toHaveLength(0);
    const fixedOnlyContext = requiredFixtureValue(
      requiredFixtureValue(fixedOnly.views[0]).captures[0],
    ).context;
    const groundMinRawA =
      (100 - fixedOnlyContext.groundYMinM) /
      (fixedOnlyContext.waterYMaxM - fixedOnlyContext.groundYMinM);
    const groundMaxRawA =
      (110 - fixedOnlyContext.groundYMinM) /
      (fixedOnlyContext.waterYMaxM - fixedOnlyContext.groundYMinM);
    expect([groundMinRawA, groundMaxRawA]).toEqual([0, 1]);
    expect(decodeWaterInfoGroundHeight([0, 0, 0, groundMinRawA], fixedOnlyContext)).toBe(100);
    expect(decodeWaterInfoGroundHeight([0, 0, 0, groundMaxRawA], fixedOnlyContext)).toBe(110);
    expect(fixedOnly.views[0]?.publication.targets.some((target) => target.write)).toBe(true);
    expect(
      [...requiredFixtureValue(fixedOnly.views[0]).publication.rows.values()].map(
        (row) => row.bodyGuid,
      ),
    ).toEqual([fixedOwnerGuid]);
    const fixedOnlyRow = [
      ...requiredFixtureValue(fixedOnly.views[0]).publication.rows.values(),
    ].find((row) => row.bodyGuid === fixedOwnerGuid);
    expect(fixedOnlyRow?.bodyGeneration).toBe(fixed.sceneGeneration);
    expect(
      new DataView(requiredValue(fixedOnlyRow, 'fixed-only row').descriptor.buffer).getFloat32(
        20,
        true,
      ),
    ).toBe(110);
    expect(fixedOnly.views[0]?.publication.waveBodies.map((body) => body.bodyGuid)).toEqual([
      fixedOwnerGuid,
    ]);
    expect(fixedOnly.views[0]?.publication.waveBodies[0]?.heightSource).toMatchObject({
      kind: 'fixed',
      fixedHeightM: 500,
    });
    feature.onFrameSubmitted?.(fixedOnly, submissionForWaterInfoFrame(feature, fixedOnly, 5));

    system.unobserveZoneGround(zoneGuid);
    const fixedWithoutTerrain = extract(world, 6);
    expect(fixedWithoutTerrain.views[0]?.captures).toHaveLength(1);
    expect(fixedWithoutTerrain.views[0]?.captures[0]?.context.waterYMinM).toBe(0);
    expect(fixedWithoutTerrain.views[0]?.captures[0]?.context.waterYMaxM).toBe(0);
    expect(fixedWithoutTerrain.views[0]?.captures[0]?.context.groundYMinM).toBe(-30);
    expect(fixedWithoutTerrain.views[0]?.captures[0]?.waterVertices).toHaveLength(0);
    expect(fixedWithoutTerrain.views[0]?.captures[0]?.groundVertices).toHaveLength(0);
    expect(fixedWithoutTerrain.views[0]?.captures[0]?.dilationVertices).toHaveLength(0);
    const noStorageContext: RenderFeaturePlanContext = {
      ...waterInfoPlanContext(6),
      limits: { maxStorageBufferBindingSize: 0 },
    };
    const nonemptyPlan = feature.plan(fixedWithoutTerrain, noStorageContext);
    expect(nonemptyPlan.ok).toBe(false);
    feature.onFrameSubmitted?.(
      fixedWithoutTerrain,
      submissionForWaterInfoFrame(feature, fixedWithoutTerrain, 6),
    );
    expect(waterInfoFramePublicationForRenderer(feature, 'test-view', 6, 1)?.frameGeneration).toBe(
      6,
    );

    system.unmountBody(fixedOwnerGuid);
    const empty = extract(world, 7);
    expect(empty.views[0]?.captures).toHaveLength(0);
    expect(empty.views[0]?.publication.rows.size).toBe(0);
    expect(empty.views[0]?.publication.waveBodies).toHaveLength(0);
    expect(empty.views[0]?.publication.targets).toHaveLength(0);
    const emptyPlan = feature.plan(empty, {
      ...noStorageContext,
      frame: { frameNumber: 7 },
    });
    expect(emptyPlan.ok).toBe(true);
    expect(emptyPlan.ok ? emptyPlan.value.work : undefined).toEqual([
      { scope: { view: 'test-view' }, resources: [], passes: [] },
    ]);
    fullGroundSnapshotRead.mockRestore();
  });
});
