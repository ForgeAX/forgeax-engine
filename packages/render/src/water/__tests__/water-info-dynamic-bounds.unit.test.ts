import { World } from '@forgeax/engine-ecs';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import {
  buildWaterPackOutputs,
  WATER_SYSTEM_RESOURCE,
  type WaterBakedQueryLineage,
  type WaterBodyAsset,
  WaterSystem,
  type WaterZoneAsset,
} from '@forgeax/engine-water';
import { describe, expect, it } from 'vitest';
import type { RenderFeaturePlanContext } from '../../features/plan';
import type { RenderFeatureExtractContext } from '../../features/types';
import {
  createWaterInfoFeature,
  createWaterInfoSourceFeature,
  waterInfoFramePublication,
  waterInfoFramePublicationForRenderer,
} from '../water-info-feature';
import { buildWaterMaterialFrameUpload } from '../wave-material';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing dynamic bounds fixture value');
  return value;
}

async function fixture(localTessellation: boolean, bound = true) {
  const packageId = definePackageId('019a0000-0000-7000-8000-000000000488');
  const zoneGuid = AssetGuid.format(AssetGuid.derive(packageId, 'zone'));
  const zone: WaterZoneAsset = {
    kind: 'water-zone',
    extentM: { spanXM: 16, spanZM: 16 },
    tileSizeM: 4,
    tessellationFactor: 1,
    lodScale: 1,
    waterInfo: {
      resolution: { widthPx: 32, heightPx: 32 },
      format: 'rgba16f',
      blurRadius: 0,
      localTessellation,
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
  });
  const packed = (
    await buildWaterPackOutputs(
      {
        body: {
          kind: 'water-body',
          type: 'lake',
          ...(bound ? { zoneGuid } : {}),
          spline: {
            closed: true,
            points: [point(0, -2, -2), point(1, 2, -2), point(2, 2, 2), point(3, -2, 2)],
          },
          baseHeightM: 0,
          overlapPriority: 0,
          maxWaveHeightM: 0,
          surfaceMaterialGuid: AssetGuid.format(AssetGuid.derive(packageId, 'material')),
          flags: { affectsWaterInfo: true, affectsWaterMesh: false, affectsLandscape: false },
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
  const liveZone = {
    guid: zoneGuid,
    generation: 3,
    asset: zone,
    worldMatrixM: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 13, 0, -9, 1],
  };
  let enumeratedZones = [liveZone];
  const outputByGuid = new Map(
    Object.entries(packed).map(([key, asset]) => [
      AssetGuid.format(AssetGuid.derive(packageId, key)).toLowerCase(),
      asset,
    ]),
  );
  const system = new WaterSystem(
    (guid) => (guid === zoneGuid ? liveZone : undefined),
    (asset) =>
      ['waterInfoMeshGuid', 'dilatedWaterInfoMeshGuid', 'visibleMeshGuid'].flatMap((field) => {
        const guid = asset[field as keyof typeof asset] as string | undefined;
        if (guid === undefined) return [];
        const payload = outputByGuid.get(guid.toLowerCase());
        return payload === undefined
          ? []
          : [
              {
                guid,
                field,
                kind: 'mesh' as const,
                status: 'valid' as const,
                payload: payload as never,
              },
            ];
      }),
    () => enumeratedZones,
  );
  const body = system.mountBody('body', '1', packed.body as WaterBodyAsset).unwrap();
  const world = new World();
  world.insertResource(WATER_SYSTEM_RESOURCE, system);
  world.update(1 / 60).unwrap();
  const context = (
    frameNumber = 1,
    cameraPosition: readonly [number, number, number] = [19, 4, -20],
  ): RenderFeatureExtractContext => ({
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
        identity: 'bounds-view',
        render: true,
        frame: {
          view: {
            identity: 'bounds-view',
            width: 64,
            height: 64,
            cameraRevision: 0,
            deviceGeneration: 1,
            cameraPosition,
          },
        },
      },
    ],
  });
  return {
    system,
    body,
    zoneGuid,
    context,
    acceptGeometry: () =>
      system
        .acceptOutput('body', 'geometry', body.outputGenerations.geometry, {
          generation: 1,
          digest: 'dynamic-bounds-geometry',
        })
        .unwrap(),
    setEnumeratedZones: (generation?: number) => {
      enumeratedZones = generation === undefined ? [] : [{ ...liveZone, generation }];
    },
  };
}

const planContext: RenderFeaturePlanContext = {
  caps: {
    compute: true,
    storageBuffer: true,
    storageTexture: true,
    rgba16floatRenderable: true,
    rgba16floatStorage: true,
  } as never,
  frame: { frameNumber: 1 },
  generation: 1,
  views: [{ identity: 'bounds-view', render: true, sceneData: { deviceGeneration: 1 } }] as never,
};

// The local default diameter [512, 512] scales by the Zone's X/Z axes [2, 3];
// camera [19, -20] snaps to the nearest 4 m tile as [20, -20].
const localDynamicBounds = [20, -20, 1024, 1536] as const;

describe('source-owned Water Body dynamic bounds', () => {
  it.each([
    [false, [13, -9, 32, 48]],
    [true, localDynamicBounds],
  ] as const)('publishes actual Zone/view bounds with localTessellation=%s without an Info target', async (local, expected) => {
    const { context } = await fixture(local);
    const source = createWaterInfoSourceFeature().extract(context()).unwrap();
    expect(source.views[0]?.captures).toEqual([]);
    expect(source.views[0]?.bodies[0]).toMatchObject({
      kind: 'independent',
      waveBody: {
        dynamicBoundsCenterExtentXZ: expected,
        heightSource: { kind: 'fixed' },
      },
    });
    const receiver = createWaterInfoFeature();
    expect(receiver.plan(structuredClone(source) as never, planContext).ok).toBe(true);
    const publication = required(
      waterInfoFramePublicationForRenderer(receiver, 'bounds-view', 1, 1),
    );
    expect(publication.targets).toEqual([]);
    expect(publication.rows.size).toBe(0);
    expect(publication.waveUploadPlan.bodyData[0]?.dynamicBoundsCenterExtentXZ).toEqual(expected);
    expect(publication.waveUploadPlan.bodyBuffer.byteLength).toBe(128);
    const upload = buildWaterMaterialFrameUpload(publication.waveUploadPlan, new Map());
    expect(upload.bodyData).toEqual(publication.waveUploadPlan.bodyBuffer);
    expect(upload.waterInfoDescriptorDynamicOffsets.size).toBe(0);
    expect(
      createWaterInfoFeature().extract(context()).unwrap().views[0]?.publication.waveBodies[0]
        ?.dynamicBoundsCenterExtentXZ,
    ).toEqual(expected);
  });

  it('leaves an unbound Body without bounds and encodes the bypass', async () => {
    const { context } = await fixture(true, false);
    const publication = required(
      createWaterInfoFeature().extract(context()).unwrap().views[0],
    ).publication;
    expect(publication.waveBodies[0]).not.toHaveProperty('dynamicBoundsCenterExtentXZ');
    expect(publication.waveUploadPlan.bodyData[0]).not.toHaveProperty(
      'dynamicBoundsCenterExtentXZ',
    );
    expect(publication.waveUploadPlan.bodyBuffer.slice(112, 128)).toEqual(new Uint8Array(16));
  });

  it.each([
    undefined,
    2,
  ])('rejects a bound Body without its exact accepted Zone generation %s', async (generation) => {
    const { context, setEnumeratedZones } = await fixture(false);
    setEnumeratedZones(generation);
    expect(createWaterInfoSourceFeature().extract(context()).ok).toBe(false);
    expect(createWaterInfoFeature().extract(context()).ok).toBe(false);
  });

  it('detaches bounds across wire materialization and public publication reads', async () => {
    const { context } = await fixture(true);
    const input = structuredClone(createWaterInfoSourceFeature().extract(context()).unwrap());
    const receiver = createWaterInfoFeature();
    expect(receiver.plan(input as never, planContext).ok).toBe(true);
    const row = required(required(input.views[0]).bodies[0]).waveBody.dynamicBoundsCenterExtentXZ;
    Object.assign(required(row), { 0: 999 });
    const publication = required(waterInfoFramePublication(receiver, 'bounds-view', 1, 1));
    const internal = required(waterInfoFramePublicationForRenderer(receiver, 'bounds-view', 1, 1));
    expect(publication.waveBodies[0]?.dynamicBoundsCenterExtentXZ).not.toBe(
      internal.waveBodies[0]?.dynamicBoundsCenterExtentXZ,
    );
    expect(publication.waveUploadPlan.bodyData[0]?.dynamicBoundsCenterExtentXZ).not.toBe(
      internal.waveUploadPlan.bodyData[0]?.dynamicBoundsCenterExtentXZ,
    );
    expect(publication.waveBodies[0]?.dynamicBoundsCenterExtentXZ).toEqual(localDynamicBounds);
    expect(publication.waveUploadPlan.bodyData[0]?.dynamicBoundsCenterExtentXZ).toEqual([
      ...localDynamicBounds,
    ]);
    expect(Object.isFrozen(publication.waveBodies[0]?.dynamicBoundsCenterExtentXZ)).toBe(true);
    expect(
      Object.isFrozen(publication.waveUploadPlan.bodyData[0]?.dynamicBoundsCenterExtentXZ),
    ).toBe(true);
  });

  it('roundtrips accepted live Bake lineage and strips malformed optional lineage at the wire boundary', async () => {
    const { system, body, context } = await fixture(false);
    const lineage = {
      version: 'water-river-bake/1' as const,
      textureGuid: 'baked-texture',
      textureRevision: 11,
      sourceRecipeGuid: 'bake-recipe',
      sourceRecipeVersion: 'sha256:bake-recipe',
      sourceBodyGuid: body.sourceAssetGuid,
      sourceBodyGeneration: body.sceneGeneration,
      simulationGeneration: 4,
      sequence: 9,
      frameId: 12,
      deviceGeneration: 2,
      graphGeneration: 6,
    };
    const lineageWithExtraMetadata: WaterBakedQueryLineage & { extraMetadata: string } = {
      ...lineage,
      extraMetadata: 'must be projected away',
    };
    const samples = new Float32Array(3 * 3 * 4);
    system
      .publishBakedQueryGrid('body', body.sceneGeneration, {
        kind: 'live-capture',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid: {
          originXZ: [-1, -1],
          originY: 3,
          spacingXZ: [1, 1],
          width: 3,
          height: 3,
          samples,
          lineage: lineageWithExtraMetadata,
        },
      })
      .unwrap();
    const source = createWaterInfoSourceFeature().extract(context()).unwrap();
    const wire = structuredClone(source);
    const wireGrid = required(required(wire.views[0]).bodies[0]).waveBody.bakedGrid;
    expect(wireGrid?.lineage).toEqual(lineage);
    const receiver = createWaterInfoFeature();
    expect(receiver.plan(wire, planContext).ok).toBe(true);
    const publication = required(
      waterInfoFramePublicationForRenderer(receiver, 'bounds-view', 1, 1),
    );
    expect(publication.waveBodies[0]?.bakedGrid?.lineage).toEqual(lineage);
    expect(publication.waveUploadPlan.bakedSources[0]?.lineage).toEqual(lineage);

    const malformed = structuredClone(source);
    const malformedLineage = required(
      required(required(malformed.views[0]).bodies[0]).waveBody.bakedGrid,
    ).lineage as unknown as Record<string, unknown>;
    malformedLineage.textureRevision = -1;
    const malformedReceiver = createWaterInfoFeature();
    expect(malformedReceiver.plan(malformed, planContext).ok).toBe(true);
    const stripped = required(
      waterInfoFramePublicationForRenderer(malformedReceiver, 'bounds-view', 1, 1),
    );
    expect(stripped.waveBodies[0]?.bakedGrid?.lineage).toBeUndefined();
    expect(stripped.waveUploadPlan.bakedSources[0]?.lineage).toBeUndefined();
  });

  it.each(
    [
      [0, 0, 0, 16],
      [0, 0, 16, -1],
      [NaN, 0, 16, 16],
      [0, 0, 16],
      [0, 0, Number.MIN_VALUE, 16],
    ].map((bounds) => ({ bounds })),
  )('rejects malformed bounds in the cloned wire $bounds', async ({ bounds }) => {
    const { context } = await fixture(false);
    const input = structuredClone(createWaterInfoSourceFeature().extract(context()).unwrap());
    Object.assign(required(required(input.views[0]).bodies[0]).waveBody, {
      dynamicBoundsCenterExtentXZ: bounds,
    });
    expect(createWaterInfoFeature().plan(input as never, planContext).ok).toBe(false);
  });

  it('keeps actual capture bounds with the candidate and rejects a conflicting wire Body', async () => {
    const { system, zoneGuid, context, acceptGeometry } = await fixture(true);
    acceptGeometry();
    system.observeZoneGroundInputs(zoneGuid, 3, []);
    const input = structuredClone(createWaterInfoSourceFeature().extract(context()).unwrap());
    const view = required(input.views[0]);
    const capture = required(view.captures[0]);
    const body = required(view.bodies[0]);
    expect(capture.context.centerXZ).toEqual(localDynamicBounds.slice(0, 2));
    expect(body.waveBody.dynamicBoundsCenterExtentXZ).toEqual(localDynamicBounds);
    const receiver = createWaterInfoFeature();
    expect(receiver.plan(input as never, planContext).ok).toBe(true);
    const publication = required(
      waterInfoFramePublicationForRenderer(receiver, 'bounds-view', 1, 1),
    );
    expect(publication.waveBodies[0]?.dynamicBoundsCenterExtentXZ).toEqual([
      ...capture.context.centerXZ,
      ...capture.context.extentXZ,
    ]);
    Object.assign(body.waveBody, { dynamicBoundsCenterExtentXZ: [0, 0, 32, 48] });
    expect(createWaterInfoFeature().plan(input as never, planContext).ok).toBe(false);
  });
});
