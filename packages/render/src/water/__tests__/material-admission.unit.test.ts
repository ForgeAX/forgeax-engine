import { defineResource, World } from '@forgeax/engine-ecs';
import { definePackageId } from '@forgeax/engine-pack/source';
import {
  buildWaterPackOutputs,
  WATER_SYSTEM_RESOURCE,
  WaterSystem,
  type WaterZoneAsset,
} from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import { waterMeshTestAssets } from '../../__tests__/water-mesh-assets.fixture';
import { worldRenderResources } from '../../publication/resource-scope';
import type { MaterialSnapshot } from '../../render-system-extract';
import {
  requireWaterMaterialConsumers,
  waterMaterialNeedsSourceSnapshot,
} from '../material-admission';

const guid = (suffix: string) => `00000000-0000-7000-8000-00000000000${suffix}`;
const point = (inputKey: number, x: number, z: number) => ({
  inputKey,
  positionM: [x, 0, z] as const,
  arriveTangentM: [0, 0, 0] as const,
  leaveTangentM: [0, 0, 0] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 4,
  depthM: 2,
  velocityMPerSec: 0,
  audioIntensity: 0,
  interpolationMode: 'linear' as const,
  rotationQuat: [0, 0, 0, 1] as const,
});

it('admits a non-Water World without treating a diagnostic namesake as Water', () => {
  const world = new World();
  world.insertResource(defineResource<string>('WaterSystem'), 'independent owner');
  expect(() =>
    requireWaterMaterialConsumers(worldRenderResources(world), material(24)),
  ).not.toThrow();
  expect(world.hasResource(WATER_SYSTEM_RESOURCE)).toBe(false);
});
const zone: WaterZoneAsset = {
  kind: 'water-zone',
  extentM: { spanXM: 16, spanZM: 16 },
  tileSizeM: 4,
  tessellationFactor: 1,
  lodScale: 1,
  waterInfo: {
    resolution: { widthPx: 16, heightPx: 16 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: false,
  },
};
const baked = {
  kind: 'live-capture' as const,
  enabled: true,
  componentValid: true,
  dataValid: true,
  grid: {
    width: 3,
    height: 3,
    originXZ: [0, 0] as const,
    originY: 0,
    spacingXZ: [1, 1] as const,
    samples: new Float32Array(36),
  },
};
const material = (binding: number, water = true) =>
  ({
    materialProgramInputs: {
      forward: {
        entryPoints: [{ name: 'fs_main', stage: 'fragment', bindings: [{ group: 2, binding }] }],
        ...(water ? { systemInputs: { water: 'water-frame/3' } } : {}),
      },
    },
  }) as unknown as MaterialSnapshot;

it.each([
  false,
  true,
])('admits shared transition replacement against every actual sampled Body (submitted=%s)', async (submitted) => {
  const assets = await waterMeshTestAssets(guid('1'));
  try {
    const world = new World({ assets });
    const water = new WaterSystem((requested) =>
      requested === guid('6') ? { generation: 1, asset: zone } : undefined,
    );
    const common = {
      kind: 'water-body' as const,
      zoneGuid: guid('6'),
      surfaceMaterialGuid: guid('2'),
      baseHeightM: 0,
      overlapPriority: 0,
      maxWaveHeightM: 0,
      flags: { affectsWaterInfo: false, affectsWaterMesh: true, affectsLandscape: false },
      collision: { type: 'none' as const, enabled: false },
    };
    const packed = (
      await buildWaterPackOutputs(
        {
          river: {
            ...common,
            type: 'river',
            riverToLakeTransitionMaterialGuid: guid('1'),
            spline: { closed: false, points: [point(0, -8, 0), point(1, 8, 0)] },
            queryFootprint: [
              [-8, -2],
              [8, -2],
              [8, 2],
              [-8, 2],
            ],
          },
          lake: {
            ...common,
            type: 'lake',
            overlapPriority: 10,
            spline: {
              closed: true,
              points: [point(0, 0, -4), point(1, 8, -4), point(2, 8, 4), point(3, 0, 4)],
            },
            queryFootprint: [
              [0, -4],
              [8, -4],
              [8, 4],
              [0, 4],
            ],
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000489') },
      )
    ).unwrap();
    const river = water.mountBody(guid('3'), '1', packed.river).unwrap();
    const lake = water.mountBody(guid('4'), '1', packed.lake).unwrap();
    water.publishBakedQueryGrid(river.guid, river.sceneGeneration, baked).unwrap();
    const candidate = water
      .buildZoneMeshView(guid('6'), 1, zone, { viewId: 'main', observerM: [0, 4, 0] })
      .unwrap();
    expect(
      candidate.receipt.instances.some(
        (instance) =>
          instance.ownerGuid === river.guid &&
          instance.transitionRenderIndex > 0 &&
          instance.transitionBodyGuid === lake.guid,
      ),
    ).toBe(true);
    if (submitted)
      expect(water.acceptWaterMeshView(guid('6'), 'main', candidate.publicationGeneration)).toBe(
        true,
      );
    world.insertResource(WATER_SYSTEM_RESOURCE, water);
    const scope = worldRenderResources(world);
    const candidateMaterial = { ...material(24), materialHandle: scope.handleForGuid(guid('1')) };
    expect(() => requireWaterMaterialConsumers(scope, candidateMaterial)).toThrow(
      expect.objectContaining({
        code: 'query-data-unavailable',
        detail: { bodyGuid: lake.guid, bodyGeneration: lake.sceneGeneration },
      }),
    );
    water.publishBakedQueryGrid(lake.guid, lake.sceneGeneration, baked).unwrap();
    expect(() => requireWaterMaterialConsumers(scope, candidateMaterial)).not.toThrow();
  } finally {
    assets.dispose();
  }
});

it('retains binding16-only Water sources and ignores unclassified group2 collisions', () => {
  expect(waterMaterialNeedsSourceSnapshot(material(16))).toBe(true);
  expect(waterMaterialNeedsSourceSnapshot(material(16, false))).toBe(false);
  expect(waterMaterialNeedsSourceSnapshot(material(24))).toBe(true);
  expect(waterMaterialNeedsSourceSnapshot(material(25))).toBe(false);
});
