import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { assert, describe, expect, it, vi } from 'vitest';
import * as bodySpline from '../body-spline.js';
import { snapshotWaterBakedQueryLineage } from '../contracts.js';
import {
  buildWaterMeshView,
  createWaterInfoContext,
  decodeWaterInfoGroundHeight,
  decodeWaterInfoHeight,
  decodeWaterInfoVelocity,
  evaluateGerstnerWavesCpuFull,
  evaluateGerstnerWavesCpuSimple,
  queryWaterBodySnapshot,
  SIMPLE_GERSTNER_WAVE_GENERATOR_ID,
  SIMPLE_GERSTNER_WAVE_GENERATOR_VERSION,
  WATER_WAVE_LWC_TILE_LENGTH_M,
  type WaterBodySourceAsset,
  type WaterInfoSliceReservation,
  type WaterQueryBodySnapshot,
  WaterQueryFlags,
  WaterSystem,
  type WaterZoneAsset,
  waterInfoWorldToUv,
  waterWaveDepthAttenuation,
} from '../index.js';
import { buildWaterPackOutputs } from '../pack-cook.js';
import { buildWaterZoneMeshViewForRenderer } from '../system-internal.js';
import {
  cookWaterAsset,
  validateWaterAsset,
  waterRiverBakeGeometryProjectionHash,
} from '../validate.js';
import * as waterMesh from '../water-mesh.js';
import { isWaterMeshLayoutReceiptValid } from '../water-mesh-abi.js';
import { buildWaterWaveUploadBody, cookGerstnerWaveSet } from '../waves.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const guid = (suffix: string) => `00000000-0000-7000-8000-00000000000${suffix}`;
const point = (inputKey: number, x: number, z: number) => ({
  inputKey,
  positionM: [x, 2, z] as const,
  arriveTangentM: [1, 0, 0] as const,
  leaveTangentM: [1, 0, 0] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 4,
  depthM: 3,
  velocityMPerSec: 2,
  audioIntensity: 0,
});
const river = (waveSetGuid?: string): WaterBodySourceAsset => ({
  kind: 'water-body',
  type: 'river',
  ...(waveSetGuid ? { waveSetGuid } : {}),
  surfaceMaterialGuid: guid('1'),
  baseHeightM: 2,
  overlapPriority: 0,
  maxWaveHeightM: 0.5,
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'river-prism', enabled: true },
  spline: { closed: false, points: [point(0, 0, 0), point(1, 8, 0)] },
  queryFootprint: [
    [-2, -2],
    [10, -2],
    [10, 2],
    [-2, 2],
  ],
});
const oceanWindowZone = (gpuMesh = false): WaterZoneAsset => ({
  kind: 'water-zone',
  extentM: { spanXM: 4096, spanZM: 4096 },
  tileSizeM: 8,
  tessellationFactor: 2,
  lodScale: 1,
  farMeshBoundary: 'view-window',
  farExtentM: { spanXM: 6000, spanZM: 6000 },
  farMaterialGuid: guid('8'),
  ...(gpuMesh
    ? { gpuMesh: { supersampling: 1, msaaSamples: 1, occlusion: 'disabled' } as const }
    : {}),
  waterInfo: {
    resolution: { widthPx: 32, heightPx: 32 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: true,
    localExtentM: [256, 100, 256],
  },
});
const oceanWindowSystem = (zone: WaterZoneAsset) => {
  const zoneGuid = guid('6');
  return new WaterSystem(
    (requested) => (requested === zoneGuid ? { generation: 1, asset: zone } : undefined),
    () => [],
    () => [{ guid: zoneGuid, generation: 1, asset: zone }],
  );
};
const mountWindowOcean = async (system: WaterSystem) => {
  const packed = (
    await buildWaterPackOutputs(
      {
        body: {
          ...river(),
          type: 'ocean',
          zoneGuid: guid('6'),
          oceanExtentM: [20000, 20000],
          centerOnWaterZone: false,
          spline: {
            closed: true,
            points: [point(0, -1, -1), point(1, 1, -1), point(2, 1, 1), point(3, -1, 1)],
          },
          collision: { type: 'polygon', enabled: false },
        },
      },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000501') },
    )
  ).unwrap();
  if (packed.body?.kind !== 'water-body') throw new Error('Ocean window fixture must cook');
  system.mountBody(guid('7'), '1', packed.body).unwrap();
};

describe('water R2 mesh, WaterInfo, waves, and body query', () => {
  it('admits and cooks an explicit Ocean view-window far boundary only with its complete source inputs', () => {
    const source = oceanWindowZone();
    expect(validateWaterAsset(source).ok).toBe(true);
    expect(cookWaterAsset(source).unwrap()).toMatchObject({
      farMeshBoundary: 'view-window',
      waterInfo: { localTessellation: true, localExtentM: [256, 100, 256] },
    });
    for (const invalid of [
      { ...source, farMeshBoundary: 'observer' },
      { ...source, waterInfo: { ...source.waterInfo, localTessellation: false } },
      { ...source, farExtentM: undefined },
      { ...source, farMaterialGuid: undefined },
    ]) {
      expect(validateWaterAsset(invalid).ok).toBe(false);
      expect(cookWaterAsset(invalid).ok).toBe(false);
    }
  });
  it('rejects a view-window far boundary without an active Ocean owner', () => {
    const zone = oceanWindowZone();
    const system = oceanWindowSystem(zone);
    expect(
      buildWaterZoneMeshViewForRenderer(system, guid('6'), 1, zone, {
        viewId: 'main',
        observerM: [0, 4, 0],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-source', expected: expect.stringContaining('active Ocean') },
    });
  });
  it('keeps query-only Bake lineage generation-qualified and preserves explicit clear semantics', async () => {
    const packed = await buildWaterPackOutputs(
      { body: { ...river(), collision: { type: 'river-prism', enabled: false } } },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000499') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.body?.kind !== 'water-body') return;
    const system = new WaterSystem(() => undefined);
    const snapshot = system.mountBody(guid('4'), 'v1', packed.value.body).unwrap();
    expect(snapshot.asset.geometrySnapshot?.collisionDescriptor).toBeNull();
    const geometryHash = waterRiverBakeGeometryProjectionHash(snapshot.asset);
    expect(geometryHash).toMatch(/^[0-9a-f]{64}$/);
    const lineage = {
      version: 'water-river-bake/1' as const,
      textureGuid: guid('1'),
      textureRevision: 8,
      sourceRecipeGuid: guid('2'),
      sourceRecipeVersion: 'sha256:source-recipe',
      sourceBodyGuid: guid('4'),
      sourceBodyGeneration: snapshot.sceneGeneration,
      simulationGeneration: 2,
      sequence: 3,
      frameId: 4,
      deviceGeneration: 5,
      graphGeneration: 6,
    };
    const samples = new Float32Array(3 * 3 * 4);
    for (let index = 0; index < 9; index += 1) samples.set([0.5, 1.25, 0.75, -0.25], index * 4);
    const originXZ: [number, number] = [-1, -1];
    const spacingXZ: [number, number] = [1, 1];
    const grid = {
      originXZ,
      originY: 0,
      spacingXZ,
      width: 3,
      height: 3,
      samples,
      lineage,
    };
    const publish = (candidate: typeof grid) =>
      system.publishBakedQueryGrid(guid('4'), snapshot.sceneGeneration, {
        kind: 'live-capture',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid: candidate,
      });

    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const lineageV2 = {
      ...lineage,
      version: 'water-river-bake/2' as const,
      normalTextureGuid: guid('8'),
      normalTextureRevision: 9,
      normalTextureFormat: 'rgba16float' as const,
      normalBasis: 'lattice-axis0-axis1-up/1' as const,
      sourceWorldMatrixM: matrix,
      sourceGeometryProjectionHash: requiredFixtureValue(geometryHash),
      sourceFrame: { generation: 2, sequence: 3, step: 4, timeSeconds: 1.5 },
    };
    for (const sourceFrame of [
      { ...lineageV2.sourceFrame, generation: 3 },
      { ...lineageV2.sourceFrame, sequence: 4 },
      { ...lineageV2.sourceFrame, step: 0 },
    ])
      expect(snapshotWaterBakedQueryLineage({ ...lineageV2, sourceFrame })).toBeUndefined();
    expect(
      publish({
        ...grid,
        lineage: { ...lineageV2, sourceFrame: { ...lineageV2.sourceFrame, step: 0 } },
      } as never),
    ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });

    expect(
      publish({
        ...grid,
        lineage: { ...lineage, sourceBodyGeneration: snapshot.sceneGeneration - 1 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'query-data-unavailable', detail: { publication: 'live-capture' } },
    });

    expect(publish({ ...grid, lineage: { ...lineage, textureGuid: '' } } as never).ok).toBe(true);
    expect(
      system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)?.grid.lineage,
    ).toBeUndefined();
    expect(
      publish({ ...grid, lineage: { ...lineage, graphGeneration: undefined } } as never).ok,
    ).toBe(true);
    expect(
      system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)?.grid.lineage,
    ).toBeUndefined();

    expect(publish({ ...grid, lineage: undefined } as never).ok).toBe(true);
    expect(
      system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)?.grid.lineage,
    ).toBeUndefined();

    expect(publish(grid).ok).toBe(true);
    const durableV1 = system.publishBakedQueryGrid(guid('4'), snapshot.sceneGeneration, {
      kind: 'durable-pack',
      enabled: true,
      componentValid: true,
      dataValid: true,
      grid: { ...grid, samples: new Float32Array(samples.length).fill(8) },
    });
    expect(durableV1).toMatchObject({
      ok: false,
      error: {
        code: 'query-data-unavailable',
        detail: { publication: 'durable-pack', lineageVersion: 'water-river-bake/1' },
      },
    });
    expect(system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)?.grid.samples[0]).toBe(0.5);
    lineage.textureGuid = '';
    lineage.textureRevision = -1;
    originXZ[0] = 100;
    spacingXZ[0] = 50;
    samples.fill(99);
    const accepted = system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)?.grid;
    expect(accepted).toMatchObject({
      originXZ: [-1, -1],
      spacingXZ: [1, 1],
      lineage: { textureGuid: guid('1'), textureRevision: 8 },
    });
    expect(accepted?.samples[0]).toBe(0.5);
    expect(Object.isFrozen(accepted?.lineage)).toBe(true);

    const moved = [...matrix];
    moved[12] = 3;
    expect(system.updateInstanceTransform(guid('4'), moved)).toMatchObject({
      ok: false,
      error: { code: 'query-data-unavailable' },
    });
    expect(
      system.hotReloadBody(guid('4'), 'v2', packed.value.body, guid('4'), moved),
    ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
    expect(system.snapshot(guid('4'))?.worldMatrixM).toEqual(matrix);
    expect(system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)?.grid.samples[0]).toBe(0.5);
    expect(system.clearBakedQueryGrid(guid('4'), snapshot.sceneGeneration)).toMatchObject({
      ok: true,
      value: true,
    });
    expect(system.updateInstanceTransform(guid('4'), moved).ok).toBe(true);
  });
  it('rejects an unavailable view window instead of using a fixed far boundary', async () => {
    const zone = { ...oceanWindowZone(), extentM: { spanXM: 512, spanZM: 512 } };
    const system = oceanWindowSystem(zone);
    await mountWindowOcean(system);
    vi.spyOn(system, 'zoneViewWindow').mockReturnValue(undefined);
    expect(
      buildWaterZoneMeshViewForRenderer(system, guid('6'), 1, zone, {
        viewId: 'main',
        observerM: [512, 4, 0],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-source', expected: expect.stringContaining('view window') },
    });
  });
  it.each([
    false,
    true,
  ])('fills the opt-in local Ocean window boundary with gpuMesh=%s', async (gpuMesh) => {
    const zoneGuid = guid('6');
    const zone = oceanWindowZone(gpuMesh);
    const system = oceanWindowSystem(zone);
    await mountWindowOcean(system);
    for (const x of [512, 1024, -512]) {
      const view = { viewId: 'main', observerM: [x, 4, 0] as const };
      const built = buildWaterZoneMeshViewForRenderer(system, zoneGuid, 1, zone, view).unwrap();
      const window = system.zoneViewWindow(zoneGuid, view.viewId, view.observerM);
      assert(window);
      const far = built.receipt.instances.filter((tile) => tile.far);
      for (const [px, pz] of [
        [window.meshOriginXZ[0] - 1, 0],
        [window.meshOriginXZ[0] + window.meshExtentXZ[0] + 1, 0],
        [x, window.meshOriginXZ[1] - 1],
        [x, window.meshOriginXZ[1] + window.meshExtentXZ[1] + 1],
      ] as const)
        expect(
          far.some(
            (tile) =>
              px >= tile.originXZ[0] &&
              px <= tile.originXZ[0] + tile.extentXZ[0] &&
              pz >= tile.originXZ[1] &&
              pz <= tile.originXZ[1] + tile.extentXZ[1],
          ),
          `coverage ${px},${pz}`,
        ).toBe(true);
    }
  });
  it.each([
    false,
    true,
  ])('joins far geometry to the effective clipped window when tile rounding expands the mesh, gpuMesh=%s', async (gpuMesh) => {
    const zone = {
      ...oceanWindowZone(gpuMesh),
      tileSizeM: 3,
      waterInfo: { ...oceanWindowZone().waterInfo, localExtentM: [128, 100, 128] as const },
    };
    const system = oceanWindowSystem(zone);
    await mountWindowOcean(system);
    const view = { viewId: 'rounded', observerM: [0, 4, 0] as const };
    const built = buildWaterZoneMeshViewForRenderer(system, guid('6'), 1, zone, view).unwrap();
    const window = system.zoneViewWindow(guid('6'), view.viewId, view.observerM);
    assert(window);
    expect(window.meshExtentXZ).toEqual([192, 192]);
    const far = built.receipt.instances.filter((tile) => tile.far);
    expect(far).toHaveLength(8);
    for (const [x, z] of [
      [64.1, 0],
      [-64.1, 0],
      [0, 64.1],
      [0, -64.1],
    ] as const)
      expect(
        far.some(
          (tile) =>
            x >= tile.originXZ[0] &&
            x <= tile.originXZ[0] + tile.extentXZ[0] &&
            z >= tile.originXZ[1] &&
            z <= tile.originXZ[1] + tile.extentXZ[1],
        ),
      ).toBe(true);
  });
  it.each([
    ['joined', true, [0, 0], 15],
    ['no-far', false, [0, 0], 0],
    ['sliding', true, [4, 0], 12],
  ] as const)('publishes only emitted flat far adjacency for %s near bounds', (_name, far, shift, expected) => {
    const result = buildWaterMeshView(
      {
        zoneGuid: 'zone',
        zoneGeneration: 1,
        originXZ: [-8 + shift[0], -8 + shift[1]],
        extentM: [16, 16],
        tileSizeM: 4,
        tessellationFactor: 3,
        lodScale: 1,
        ...(far
          ? {
              far: {
                extentM: [32, 32] as const,
                materialKey: 'far',
                oceanHeight: 'mean' as const,
                innerBoundsXZ: { minM: [-8, -8] as const, maxM: [8, 8] as const },
              },
            }
          : {}),
        bodies: [
          {
            guid: 'sea',
            generation: 1,
            type: 'ocean',
            visible: true,
            affectsWaterMesh: true,
            priority: 0,
            materialKey: 'near',
            waveOriginXZ: [0, 0],
            baseHeightM: 2,
            maxWaveHeightM: 0.5,
            polygon: {
              outer: [
                [-100, -100],
                [100, -100],
                [100, 100],
                [-100, 100],
              ],
              holes: [
                [
                  [-1, -1],
                  [-1, 1],
                  [1, 1],
                  [1, -1],
                ],
              ],
            },
          },
        ],
      },
      {
        viewId: 'main',
        observerM: [0, 4, 0],
        waterInfoBoundsXZ: {
          minM: [-8 + shift[0], -8 + shift[1]],
          maxM: [8 + shift[0], 8 + shift[1]],
        },
      },
    ).unwrap();
    const near = result.instances.filter((tile) => !tile.far);
    expect(near.length).toBeGreaterThan(0);
    for (const tile of near) {
      expect(tile).toHaveProperty('flatFarBoundaryMask', expected);
      const index = result.instances.indexOf(tile);
      expect(new DataView(result.instanceBytes.buffer).getUint32(index * 96 + 92, true)).toBe(
        expected,
      );
    }
    expect(
      result.instances
        .filter((tile) => tile.far)
        .every((tile) => 'flatFarBoundaryMask' in tile && tile.flatFarBoundaryMask === 0),
    ).toBe(true);
    expect(
      isWaterMeshLayoutReceiptValid(
        { ...result.layout, schemaVersion: 6 } as never,
        result.instanceBytes,
        result.coverageBytes,
      ),
    ).toBe(false);
  });
  it('requires emitted same-generation, same-height far geometry for boundary continuity', () => {
    const receipt = buildWaterMeshView(
      {
        zoneGuid: 'zone',
        zoneGeneration: 1,
        originXZ: [-8, -8],
        extentM: [16, 16],
        tileSizeM: 4,
        tessellationFactor: 3,
        lodScale: 1,
        nearMesh: 'gpu',
        far: { extentM: [32, 32], materialKey: 'far', oceanHeight: 'mean' },
        bodies: [
          {
            guid: 'sea',
            generation: 2,
            type: 'ocean',
            visible: true,
            affectsWaterMesh: true,
            priority: 0,
            materialKey: 'near',
            waveOriginXZ: [0, 0],
            baseHeightM: 2,
            maxWaveHeightM: 0.5,
          },
        ],
      },
      { viewId: 'main', observerM: [0, 4, 0] },
    ).unwrap();
    const bounds = { minM: [-8, -8] as const, maxM: [8, 8] as const };
    const mask = (tiles = receipt.instances, owner = 'sea', generation = 2, height = 2) =>
      waterMesh.waterMeshFlatFarBoundaryMask(tiles, owner, generation, height, bounds);
    expect(mask()).toBe(15);
    expect(mask([], 'sea')).toBe(0);
    expect(mask(receipt.instances, 'coast')).toBe(0);
    expect(mask(receipt.instances, 'sea', 3)).toBe(0);
    expect(mask(receipt.instances, 'sea', 2, 2.5)).toBe(0);
    expect(mask(receipt.instances.map((tile) => ({ ...tile, far: false })))).toBe(0);
    expect(
      waterMesh.waterMeshFlatFarBoundaryMask(receipt.instances, 'sea', 2, 2, {
        minM: [-4, -4],
        maxM: [4, 4],
      }),
    ).toBe(0);
  });
  it('retains the eight static far quads without building CPU near occupancy for GPU WaterMesh', () => {
    const receipt = buildWaterMeshView(
      {
        zoneGuid: 'zone',
        zoneGeneration: 1,
        originXZ: [-8, -8],
        extentM: [16, 16],
        tileSizeM: 4,
        tessellationFactor: 3,
        lodScale: 1,
        nearMesh: 'gpu',
        far: { extentM: [32, 32], materialKey: 'far' },
        bodies: [
          {
            guid: 'sea',
            generation: 1,
            type: 'ocean',
            visible: true,
            affectsWaterMesh: true,
            priority: 0,
            materialKey: 'near',
            waveOriginXZ: [0, 0],
            baseHeightM: 2,
            maxWaveHeightM: 0.25,
          },
        ],
      },
      { viewId: 'main', observerM: [64, 4, 64] },
    ).unwrap();
    expect(receipt).toMatchObject({ leafCount: 0, selectedTileCount: 0, farInstanceCount: 8 });
    expect(receipt.instances).toHaveLength(8);
    expect(
      receipt.instances.every((instance) => instance.far && instance.materialKey === 'far'),
    ).toBe(true);
    expect(receipt.instances.some((instance) => instance.originXZ[0] === 8)).toBe(true);
  });
  it.each([
    'geometry',
    'transform',
    'source',
  ] as const)('rejects a Baked material replacement when its combined %s edit invalidates the accepted grid', async (edit) => {
    const packed = (
      await buildWaterPackOutputs(
        { body: { ...river(), collision: { type: 'river-prism', enabled: false } } },
        {
          packageId: definePackageId('019a0000-0000-7000-8000-000000000498'),
        },
      )
    ).unwrap();
    if (packed.body === undefined) throw new Error('missing cooked Body');
    const system = new WaterSystem(
      () => undefined,
      (asset) => [
        {
          guid: asset.surfaceMaterialGuid,
          field: 'surfaceMaterialGuid',
          kind: 'material',
          status: 'valid',
          version: asset.surfaceMaterialGuid === guid('2') ? '2' : '1',
          materialRequiresBakedSource: asset.surfaceMaterialGuid === guid('2'),
        },
      ],
    );
    const initial = system.mountBody(guid('4'), 'v1', packed.body).unwrap();
    system
      .publishBakedQueryGrid(guid('4'), initial.sceneGeneration, {
        kind: 'live-capture',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid: {
          width: 3,
          height: 3,
          originXZ: [0, 0],
          originY: 0,
          spacingXZ: [1, 1],
          samples: new Float32Array(36),
        },
      })
      .unwrap();
    const matrix = [...initial.worldMatrixM];
    if (edit === 'transform') matrix[12] = 1;
    const candidate = (
      await buildWaterPackOutputs(
        {
          body: {
            ...river(),
            surfaceMaterialGuid: guid('2'),
            ...(edit === 'geometry'
              ? {
                  spline: {
                    ...river().spline,
                    points: river().spline.points.map((point) => ({
                      ...point,
                      depthM: point.depthM + 1,
                    })),
                  },
                }
              : {}),
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000498') },
      )
    ).unwrap().body;
    if (candidate === undefined) throw new Error('missing cooked candidate Body');
    const result = system.hotReloadBody(
      guid('4'),
      'v2',
      candidate,
      edit === 'source' ? guid('5') : guid('4'),
      matrix,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
    expect(system.snapshot(guid('4'))).toMatchObject({
      sceneGeneration: initial.sceneGeneration,
      sourceVersion: initial.sourceVersion,
      sourceAssetGuid: initial.sourceAssetGuid,
      asset: initial.asset,
      worldMatrixM: initial.worldMatrixM,
      dependencies: initial.dependencies,
      outputGenerations: initial.outputGenerations,
    });
    expect(system.hasBakedQueryGrid(guid('4'), initial.sceneGeneration)).toBe(true);
    const materialOnly = system
      .hotReloadBody(guid('4'), 'v2', { ...packed.body, surfaceMaterialGuid: guid('2') })
      .unwrap();
    expect(system.hasBakedQueryGrid(guid('4'), materialOnly.sceneGeneration)).toBe(true);
    const queryCandidate = (
      await buildWaterPackOutputs(
        {
          body: {
            ...river(),
            surfaceMaterialGuid: guid('2'),
            spline: {
              ...river().spline,
              points: river().spline.points.map((point) => ({
                ...point,
                depthM: point.depthM + 2,
              })),
            },
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000498') },
      )
    ).unwrap().body;
    expect(system.clearBakedQueryGrid(guid('4'), materialOnly.sceneGeneration)).toMatchObject({
      ok: true,
      value: true,
    });
    const changedQuery = system.hotReloadBody(guid('4'), 'v3', queryCandidate).unwrap();
    expect(system.hasBakedQueryGrid(guid('4'), changedQuery.sceneGeneration)).toBe(false);
  });

  it('returns a validation error for malformed nested asset data without throwing', () => {
    const malformed = { ...river(), collision: null };
    const sparseFootprint: unknown[] = [];
    sparseFootprint[0] = [-2, -2];
    sparseFootprint[2] = [10, -2];
    sparseFootprint[3] = [10, 2];
    sparseFootprint[4] = [-2, 2];

    expect(() => validateWaterAsset(malformed)).not.toThrow();
    expect(validateWaterAsset(malformed)).toMatchObject({
      ok: false,
      error: { code: 'invalid-source' },
    });
    expect(() => validateWaterAsset({ ...river(), queryFootprint: sparseFootprint })).not.toThrow();
    expect(validateWaterAsset({ ...river(), queryFootprint: sparseFootprint })).toMatchObject({
      ok: false,
      error: { code: 'invalid-source' },
    });
  });

  it('builds opted-in Custom WaterMesh from cooked mesh rings while preserving other body types', async () => {
    const zoneGuid = guid('6');
    const zone = {
      kind: 'water-zone' as const,
      extentM: { spanXM: 16, spanZM: 16 },
      tileSizeM: 4,
      tessellationFactor: 1,
      lodScale: 1,
      waterInfo: {
        resolution: { widthPx: 64, heightPx: 64 },
        format: 'rgba16f' as const,
        blurRadius: 0,
        localTessellation: false,
      },
    };
    const closedPoints = [point(0, -2, -2), point(1, 2, -2), point(2, 2, 2), point(3, -2, 2)];
    const meshOverrideGuid = guid('8');
    const overrideMesh = createBoxGeometry(2, 1, 2).unwrap();
    const sources: readonly Readonly<{
      bodyGuid: string;
      source: WaterBodySourceAsset;
      customOverride?: boolean;
    }>[] = [
      {
        bodyGuid: guid('1'),
        source: { ...river(), zoneGuid },
      },
      {
        bodyGuid: guid('2'),
        source: {
          ...river(),
          type: 'lake',
          zoneGuid,
          spline: { closed: true, points: closedPoints },
          collision: { type: 'polygon', enabled: true, channelDepthM: 6 },
        },
      },
      {
        bodyGuid: guid('3'),
        source: {
          ...river(),
          type: 'ocean',
          zoneGuid,
          spline: { closed: true, points: closedPoints },
          collision: { type: 'none', enabled: false },
          oceanExtentM: [8, 8],
          centerOnWaterZone: false,
        },
      },
      {
        bodyGuid: guid('4'),
        source: {
          ...river(),
          type: 'custom',
          zoneGuid,
          customMeshOverrideGuid: meshOverrideGuid,
          flags: { affectsWaterInfo: false, affectsWaterMesh: true, affectsLandscape: false },
          collision: { type: 'none', enabled: false },
          queryFootprint: [
            [-4, -4],
            [4, -4],
            [4, 4],
            [-4, 4],
          ],
        },
        customOverride: true,
      },
    ];
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000498');
    const expectCoverageBounds = (
      coverage: readonly (readonly [number, number])[],
      expected: readonly (readonly [number, number])[],
    ) => {
      expect(Math.min(...coverage.map(([x]) => x))).toBeCloseTo(
        Math.min(...expected.map(([x]) => x)),
        6,
      );
      expect(Math.max(...coverage.map(([x]) => x))).toBeCloseTo(
        Math.max(...expected.map(([x]) => x)),
        6,
      );
      expect(Math.min(...coverage.map(([, z]) => z))).toBeCloseTo(
        Math.min(...expected.map(([, z]) => z)),
        6,
      );
      expect(Math.max(...coverage.map(([, z]) => z))).toBeCloseTo(
        Math.max(...expected.map(([, z]) => z)),
        6,
      );
    };

    for (const { bodyGuid, source, customOverride } of sources) {
      const packed = await buildWaterPackOutputs(
        { body: source },
        {
          packageId,
          ...(customOverride
            ? {
                readByGuid: async () => ({ ok: true as const, value: overrideMesh }),
              }
            : {}),
        },
      );
      expect(packed.ok).toBe(true);
      if (!packed.ok || packed.value.body?.kind !== 'water-body') return;

      const system = new WaterSystem((requestedGuid) =>
        requestedGuid === zoneGuid ? { generation: 1, asset: zone } : undefined,
      );
      const mounted = system.mountBody(bodyGuid, 'v1', packed.value.body);
      expect(mounted.ok).toBe(true);
      if (!mounted.ok) return;

      const riverTransform = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1] as const;
      if (source.type === 'river') {
        const riverHulls =
          packed.value.body.geometrySnapshot?.collisionDescriptor?.riverSegmentConvexes?.flat() ??
          [];
        expect(riverHulls.length).toBeGreaterThan(1);
        expect(system.updateInstanceTransform(bodyGuid, riverTransform).ok).toBe(true);
      }

      const built = system.buildZoneMeshView(zoneGuid, 1, zone, {
        viewId: 'main',
        observerM: [0, 4, 0],
      });
      expect(built.ok).toBe(true);
      if (!built.ok) continue;

      const tiles = built.value.receipt.instances.filter((tile) => tile.ownerGuid === bodyGuid);
      expect(tiles.length).toBeGreaterThan(0);
      const coveragePoints = tiles.flatMap((tile) =>
        (tile.coverageRings ?? []).flatMap((ring) =>
          ring.map(([x, z]) => [tile.originXZ[0] + x, tile.originXZ[1] + z] as const),
        ),
      );
      expect(coveragePoints.length).toBeGreaterThan(0);
      expect(coveragePoints.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z))).toBe(true);

      if (source.type === 'river') {
        const expectedPoints = (packed.value.body.geometrySnapshot?.queryFootprint.outer ?? []).map(
          ([x, z]) =>
            [
              riverTransform[0] * x + riverTransform[8] * z + riverTransform[12],
              riverTransform[2] * x + riverTransform[10] * z + riverTransform[14],
            ] as const,
        );
        expectCoverageBounds(coveragePoints, expectedPoints);
      } else if (source.type === 'lake') {
        const expectedPoints =
          packed.value.body.geometrySnapshot?.collisionDescriptor?.footprint.outer;
        expect(expectedPoints).toBeDefined();
        if (expectedPoints) expectCoverageBounds(coveragePoints, expectedPoints);
      } else if (source.type === 'ocean') {
        const expectedPoints = packed.value.body.geometrySnapshot?.queryFootprint.outer;
        expect(expectedPoints).toBeDefined();
        if (expectedPoints) expectCoverageBounds(coveragePoints, expectedPoints);
      }
      if (source.type !== 'custom') continue;

      const cookedRings = packed.value.body.geometrySnapshot?.waterMeshFootprint?.rings;
      expect(cookedRings).toBeDefined();
      if (!cookedRings) continue;
      const expectedPoints = cookedRings.flat();
      expectCoverageBounds(coveragePoints, expectedPoints);
    }
  });

  it('retires unloaded Zone and inactive view publications while retaining failed replacements', async () => {
    const zoneGuid = guid('6');
    const bodyGuid = guid('7');
    const zone = {
      kind: 'water-zone' as const,
      extentM: { spanXM: 16, spanZM: 16 },
      tileSizeM: 4,
      tessellationFactor: 1,
      lodScale: 1,
      waterInfo: {
        resolution: { widthPx: 32, heightPx: 32 },
        format: 'rgba16f' as const,
        blurRadius: 0,
        localTessellation: false,
      },
    };
    const packed = await buildWaterPackOutputs(
      { body: { ...river(), zoneGuid } },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000501') },
    );
    if (!packed.ok || packed.value.body?.kind !== 'water-body')
      throw new Error('WaterMesh lifecycle fixture must cook');
    let generation = 1;
    let liveZone = zone;
    const makeSystem = () => {
      const system = new WaterSystem((requested) =>
        requested === zoneGuid ? { generation, asset: liveZone } : undefined,
      );
      system.mountBody(bodyGuid, '1', packed.value.body).unwrap();
      return system;
    };
    const water = makeSystem();
    const otherWorldWater = makeSystem();
    const view = (viewId: string) => ({ viewId, observerM: [0, 4, 0] as const });
    const accepted = water.buildZoneMeshView(zoneGuid, 1, zone, view('camera:a')).unwrap();
    expect(accepted.receipt.buckets.flatMap((bucket) => bucket.ownerDraws).length).toBeGreaterThan(
      0,
    );
    expect(water.acceptWaterMeshView(zoneGuid, 'camera:a', accepted.publicationGeneration)).toBe(
      true,
    );
    water.buildZoneMeshView(zoneGuid, 1, zone, view('camera:b')).unwrap();
    otherWorldWater.buildZoneMeshView(zoneGuid, 1, zone, view('camera:a')).unwrap();

    generation = 2;
    liveZone = { ...zone, tileSizeM: 0 };
    expect(water.buildZoneMeshView(zoneGuid, 2, liveZone, view('camera:a')).ok).toBe(false);
    expect(water.zoneMeshView(zoneGuid, 'camera:a')?.publicationGeneration).toBe(
      accepted.publicationGeneration,
    );
    expect(water.waterMeshOwnerRoster('camera:a')).toHaveLength(1);
    const ownerRosterScopes: string[] = [];
    const observedOwners = water.waterMeshOwnerRoster('camera:a', {
      begin(operation) {
        ownerRosterScopes.push(`+${operation}`);
        return { end: () => ownerRosterScopes.push(`-${operation}`) };
      },
    });
    expect(observedOwners).toEqual(water.waterMeshOwnerRoster('camera:a'));
    expect(ownerRosterScopes).toEqual(['+water/mesh/owner-roster', '-water/mesh/owner-roster']);

    water.retireWaterMeshViewsExcept(['camera:a']);
    expect(water.waterMeshCandidateViews('camera:b')).toEqual([]);
    expect(water.zoneMeshView(zoneGuid, 'camera:a')).toBeDefined();
    water.retireWaterMeshZone(zoneGuid);
    expect(water.zoneMeshView(zoneGuid, 'camera:a')).toBeUndefined();
    expect(water.waterMeshOwnerRoster('camera:a')).toEqual([]);
    expect(otherWorldWater.waterMeshCandidateViews('camera:a')).toHaveLength(1);

    liveZone = zone;
    const next = water.buildZoneMeshView(zoneGuid, 2, zone, view('camera:a')).unwrap();
    expect(water.acceptWaterMeshView(zoneGuid, 'camera:a', next.publicationGeneration)).toBe(true);
    water.observeWaterMeshViewDevice('camera:a', 3);
    water.observeWaterMeshViewDevice('camera:a', 4);
    expect(water.zoneMeshView(zoneGuid, 'camera:a')).toBeUndefined();
    expect(water.waterMeshOwnerRoster('camera:a')).toEqual([]);
  });

  it('reuses unchanged mesh work while observing all view inputs, accepted generations and retirement', async () => {
    const zoneGuid = guid('6'),
      bodyGuid = guid('7');
    const zone = {
      kind: 'water-zone' as const,
      extentM: { spanXM: 16, spanZM: 16 },
      tileSizeM: 4,
      tessellationFactor: 1,
      lodScale: 1,
      waterInfo: {
        resolution: { widthPx: 32, heightPx: 32 },
        format: 'rgba16f' as const,
        blurRadius: 0,
        localTessellation: false,
      },
    };
    const packed = (
      await buildWaterPackOutputs(
        { body: { ...river(), zoneGuid } },
        {
          packageId: definePackageId('019a0000-0000-7000-8000-000000000501'),
        },
      )
    ).unwrap();
    if (packed.body?.kind !== 'water-body') throw new Error('WaterMesh reuse fixture must cook');
    const system = new WaterSystem((requested) =>
      requested === zoneGuid ? { generation: 1, asset: zone } : undefined,
    );
    system.mountBody(bodyGuid, '1', packed.body).unwrap();
    const view = {
      viewId: 'reuse',
      observerM: [0, 4, 0] as [number, number, number],
      frustumPlanes: [{ normal: [1, 0, 0] as [number, number, number], distance: 100 }],
      waterInfoBoundsXZ: { minM: [-8, -8] as [number, number], maxM: [8, 8] as [number, number] },
    };
    const build = vi.spyOn(waterMesh, 'buildWaterMeshView');
    const render = (input = view) =>
      buildWaterZoneMeshViewForRenderer(system, zoneGuid, 1, zone, input);
    try {
      const first = render().unwrap();
      expect(first.receipt.instances.length).toBeGreaterThan(0);
      expect(render().unwrap()).toBe(first);
      expect(build).toHaveBeenCalledTimes(1);
      const signatureScopes: string[] = [];
      const copyWorkCounts: number[] = [];
      const digestWorkCounts: number[] = [];
      const observe = {
        begin(operation: string) {
          signatureScopes.push(`+${operation}`);
          if (operation === 'water/mesh/publication-copy') {
            const cloneProbe = vi.spyOn(Reflect, 'ownKeys');
            return {
              end: () => {
                copyWorkCounts.push(cloneProbe.mock.calls.length);
                cloneProbe.mockRestore();
                signatureScopes.push(`-${operation}`);
              },
            };
          }
          if (operation === 'water/mesh/publication-signature-match') {
            const serializeProbe = vi.spyOn(Object, 'entries');
            return {
              end: () => {
                digestWorkCounts.push(serializeProbe.mock.calls.length);
                serializeProbe.mockRestore();
                signatureScopes.push(`-${operation}`);
              },
            };
          }
          return { end: () => signatureScopes.push(`-${operation}`) };
        },
      };
      const profiledCached = system.buildZoneMeshView(zoneGuid, 1, zone, view, observe).unwrap();
      expect(profiledCached).not.toBe(first);
      expect(profiledCached.receipt).not.toBe(first.receipt);
      expect(profiledCached.receipt.instances).toEqual(first.receipt.instances);
      expect(copyWorkCounts[0]).toBeGreaterThan(0);
      expect(signatureScopes).toEqual([
        '+water/mesh/input-signature-match',
        '-water/mesh/input-signature-match',
        '+water/mesh/publication-copy',
        '-water/mesh/publication-copy',
      ]);
      signatureScopes.length = 0;
      const digestView = { ...view, viewId: 'digest-scope' };
      expect(system.buildZoneMeshView(zoneGuid, 1, zone, digestView, observe).ok).toBe(true);
      expect(digestWorkCounts[0]).toBeGreaterThan(0);
      expect(copyWorkCounts[1]).toBeGreaterThan(0);
      expect(signatureScopes).toEqual([
        '+water/mesh/input-signature-match',
        '-water/mesh/input-signature-match',
        '+water/mesh/publication-signature-match',
        '-water/mesh/publication-signature-match',
        '+water/mesh/publication-copy',
        '-water/mesh/publication-copy',
      ]);
      expect(system.acceptWaterMeshView(zoneGuid, view.viewId, first.publicationGeneration)).toBe(
        true,
      );
      signatureScopes.length = 0;
      const held = system.zoneMeshView(zoneGuid, view.viewId, observe);
      assert(held);
      expect(held).not.toBe(first);
      expect(held.receipt).not.toBe(first.receipt);
      expect(copyWorkCounts[2]).toBeGreaterThan(0);
      expect(signatureScopes).toEqual([
        '+water/mesh/publication-copy',
        '-water/mesh/publication-copy',
      ]);
      expect(render().unwrap()).toBe(first);
      expect(build).toHaveBeenCalledTimes(2);
      const publicCopy = system.buildZoneMeshView(zoneGuid, 1, zone, view).unwrap();
      expect(publicCopy).not.toBe(first);
      expect(publicCopy.receipt).not.toBe(first.receipt);
      const callerBytes = publicCopy.receipt.instanceBytes;
      const ownerBytes = first.receipt.instanceBytes;
      const originalByte = ownerBytes[0];
      assert(originalByte !== undefined);
      callerBytes[0] = originalByte ^ 0xff;
      expect(render().unwrap().receipt.instanceBytes).toBe(first.receipt.instanceBytes);
      expect(ownerBytes[0]).toBe(originalByte);

      const [plane] = view.frustumPlanes;
      assert(plane);
      for (const change of [
        () => {
          view.observerM[0] += 1;
        },
        () => {
          view.observerM[1] += 2;
        },
        () => {
          view.observerM[2] += 1;
        },
        () => {
          plane.distance += 1;
        },
        () => {
          plane.normal[2] += 0.1;
        },
        () => {
          view.waterInfoBoundsXZ.minM[0] += 1;
        },
        () => {
          view.waterInfoBoundsXZ.maxM[1] -= 1;
        },
        () => {
          zone.extentM.spanXM += 4;
        },
      ]) {
        const before = build.mock.calls.length;
        change();
        expect(render().ok).toBe(true);
        expect(build.mock.calls.length).toBe(before + 1);
      }
      const candidate = render().unwrap();
      expect(system.waterMeshCandidateViews(view.viewId)).toHaveLength(1);
      signatureScopes.length = 0;
      const publicCandidates = system.waterMeshCandidateViews(view.viewId, observe);
      expect(publicCandidates).toHaveLength(1);
      expect(publicCandidates[0]).not.toBe(candidate);
      expect(copyWorkCounts[3]).toBeGreaterThan(0);
      expect(signatureScopes).toEqual([
        '+water/mesh/publication-copy',
        '-water/mesh/publication-copy',
      ]);
      expect(render().unwrap()).toBe(candidate);
      const beforeFailure = build.mock.calls.length;
      expect(render({ ...view, observerM: [Number.NaN, 4, 0] }).ok).toBe(false);
      expect(build).toHaveBeenCalledTimes(beforeFailure + 1);
      expect(render().unwrap()).toBe(candidate);
      expect(
        system.acceptWaterMeshView(zoneGuid, view.viewId, candidate.publicationGeneration),
      ).toBe(true);
      expect(held.publicationGeneration).toBe(first.publicationGeneration);
      expect(held.receipt.instances).toEqual(first.receipt.instances);

      const beforeInvalidation = build.mock.calls.length;
      system.invalidate(bodyGuid, ['waterMesh']);
      expect(render().unwrap().sourceGenerations[bodyGuid]).not.toBe(
        first.sourceGenerations[bodyGuid],
      );
      expect(build).toHaveBeenCalledTimes(beforeInvalidation + 1);
      const prior = render().unwrap();
      system.unmountBody(bodyGuid);
      system.mountBody(bodyGuid, '2', packed.body).unwrap();
      expect(render().unwrap().sourceGenerations[bodyGuid]).not.toBe(
        prior.sourceGenerations[bodyGuid],
      );
      const beforeRetirement = build.mock.calls.length;
      system.retireWaterMeshView(view.viewId);
      expect(render().ok).toBe(true);
      expect(build).toHaveBeenCalledTimes(beforeRetirement + 1);
    } finally {
      build.mockRestore();
    }
  });

  it('keeps occlusion callbacks live when their captured state changes without changing identity', async () => {
    const zoneGuid = guid('6'),
      bodyGuid = guid('7');
    const zone = {
      kind: 'water-zone' as const,
      extentM: { spanXM: 16, spanZM: 16 },
      tileSizeM: 4,
      tessellationFactor: 1,
      lodScale: 1,
      waterInfo: {
        resolution: { widthPx: 32, heightPx: 32 },
        format: 'rgba16f' as const,
        blurRadius: 0,
        localTessellation: false,
      },
    };
    const packed = (
      await buildWaterPackOutputs(
        { body: { ...river(), zoneGuid } },
        {
          packageId: definePackageId('019a0000-0000-7000-8000-000000000501'),
        },
      )
    ).unwrap();
    if (packed.body?.kind !== 'water-body')
      throw new Error('WaterMesh occlusion fixture must cook');
    const system = new WaterSystem((requested) =>
      requested === zoneGuid ? { generation: 1, asset: zone } : undefined,
    );
    system.mountBody(bodyGuid, '1', packed.body).unwrap();
    let hidden = false;
    const view = {
      viewId: 'live-occlusion',
      observerM: [0, 4, 0] as const,
      occluded: () => hidden,
    };
    expect(
      buildWaterZoneMeshViewForRenderer(system, zoneGuid, 1, zone, view).unwrap().receipt.instances
        .length,
    ).toBeGreaterThan(0);
    hidden = true;
    expect(
      buildWaterZoneMeshViewForRenderer(system, zoneGuid, 1, zone, view).unwrap().receipt.instances,
    ).toHaveLength(0);
    hidden = false;
    expect(
      buildWaterZoneMeshViewForRenderer(system, zoneGuid, 1, zone, view).unwrap().receipt.instances
        .length,
    ).toBeGreaterThan(0);
  });

  it('builds per-view leaves with owner and clipped coverage in a stable tile layout', () => {
    const result = buildWaterMeshView(
      {
        zoneGuid: guid('2'),
        zoneGeneration: 3,
        originXZ: [0, 0],
        extentM: [8, 8],
        tileSizeM: 4,
        tessellationFactor: 1,
        lodScale: 1,
        bodies: [
          {
            guid: guid('3'),
            generation: 7,
            type: 'lake',
            visible: true,
            affectsWaterMesh: true,
            priority: 4,
            materialKey: 'water',
            waveOriginXZ: [0, 0],
            baseHeightM: 2,
            maxWaveHeightM: 0.5,
            polygon: {
              outer: [
                [0, 0],
                [8, 0],
                [8, 8],
                [0, 8],
              ],
              holes: [
                [
                  [3, 3],
                  [5, 3],
                  [5, 5],
                  [3, 5],
                ],
              ],
            },
          },
        ],
      },
      { viewId: 'main', observerM: [2, 4, 2] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedTileCount).toBe(4);
    expect(
      result.value.instances.every(
        (tile) => tile.ownerGuid === guid('3') && tile.ownerGeneration === 7,
      ),
    ).toBe(true);
    expect(result.value.instances.some((tile) => tile.coverageRings?.length)).toBe(true);
    expect(result.value.layout).toMatchObject({ schemaVersion: 7, strideBytes: 96 });
    expect(result.value.layout.coverageByteLength).toBeGreaterThan(0);
    const tileWords = new DataView(
      result.value.instanceBytes.buffer,
      result.value.instanceBytes.byteOffset,
      result.value.instanceBytes.byteLength,
    );
    const coverageWords = new DataView(
      result.value.coverageBytes.buffer,
      result.value.coverageBytes.byteOffset,
      result.value.coverageBytes.byteLength,
    );
    const instanceWordCount = result.value.instanceBytes.byteLength / 4;
    result.value.instances.forEach((tile, index) => {
      const rings = tile.coverageRings ?? [];
      const wordOffset = tileWords.getUint32(index * 96 + 72, true);
      expect(tileWords.getUint32(index * 96 + 76, true)).toBe(rings.length);
      if (!rings.length) return;
      let pointWord = wordOffset - instanceWordCount + 1 + rings.length;
      rings.forEach((ring, ringIndex) => {
        expect(
          coverageWords.getUint32((wordOffset - instanceWordCount + 1 + ringIndex) * 4, true),
        ).toBe(ring.length);
        ring.forEach(([x, z]) => {
          expect(coverageWords.getFloat32(pointWord++ * 4, true)).toBeCloseTo(x, 5);
          expect(coverageWords.getFloat32(pointWord++ * 4, true)).toBeCloseTo(z, 5);
        });
      });
    });
    expect(
      buildWaterMeshView(
        {
          zoneGuid: guid('2'),
          zoneGeneration: 3,
          originXZ: [0, 0],
          extentM: [8, 8],
          tileSizeM: 4,
          tessellationFactor: 9,
          lodScale: 1,
          bodies: [],
        },
        { viewId: 'main', observerM: [0, 0, 0] },
      ).ok,
    ).toBe(false);
  });

  it('clips River tiles to the cooked diagonal footprint', () => {
    const result = buildWaterMeshView(
      {
        zoneGuid: guid('2'),
        zoneGeneration: 3,
        originXZ: [0, 0],
        extentM: [8, 8],
        tileSizeM: 4,
        tessellationFactor: 2,
        lodScale: 1,
        bodies: [
          {
            guid: guid('3'),
            generation: 7,
            type: 'river',
            visible: true,
            affectsWaterMesh: true,
            priority: 0,
            materialKey: 'river',
            waveOriginXZ: [0, 0],
            baseHeightM: 0,
            maxWaveHeightM: 0,
            polygon: {
              outer: [
                [0, 0],
                [2, 0],
                [8, 6],
                [8, 8],
                [6, 8],
                [0, 2],
              ],
            },
          },
        ],
      },
      { viewId: 'main', observerM: [4, 4, 4] },
    );
    if (!result.ok) throw new Error('diagonal River fixture failed to build');
    const upperLeft = result.value.instances.find(
      (tile) => tile.originXZ[0] === 0 && tile.originXZ[1] === 4,
    );
    expect(upperLeft).toBeDefined();
    expect(upperLeft?.coverageRings?.flat().every(([x]) => x >= 2)).toBe(true);
  });

  it('keeps near and far material buckets as separate draws for one WaterMesh owner', () => {
    const ownerGuid = guid('3');
    const result = buildWaterMeshView(
      {
        zoneGuid: guid('2'),
        zoneGeneration: 3,
        originXZ: [0, 0],
        extentM: [8, 8],
        tileSizeM: 4,
        tessellationFactor: 1,
        lodScale: 1,
        far: {
          extentM: [8, 8],
          materialKey: 'far-water',
          ownerGuid,
          waterLevelM: 0,
        },
        bodies: [
          {
            guid: ownerGuid,
            generation: 7,
            type: 'lake',
            visible: true,
            affectsWaterMesh: true,
            priority: 4,
            materialKey: 'water',
            waveOriginXZ: [0, 0],
            baseHeightM: 0,
            maxWaveHeightM: 0,
            polygon: {
              outer: [
                [0, 0],
                [8, 0],
                [8, 8],
                [0, 8],
              ],
            },
          },
        ],
      },
      { viewId: 'main', observerM: [4, 4, 4] },
    );
    if (!result.ok) throw new Error('near/far WaterMesh fixture failed to build');

    const ownerBuckets = result.value.buckets.filter((bucket) =>
      bucket.ownerDraws.some((draw) => draw.ownerGuid === ownerGuid),
    );
    expect(ownerBuckets.some((bucket) => bucket.materialKey === 'water')).toBe(true);
    expect(ownerBuckets.some((bucket) => bucket.materialKey === 'far-water')).toBe(true);
    const ownerDraws = ownerBuckets.flatMap((bucket) =>
      bucket.ownerDraws.filter((draw) => draw.ownerGuid === ownerGuid),
    );
    expect(ownerDraws.length).toBeGreaterThan(1);
  });

  it.each([
    0, 1, 2.2, 17,
  ])('retains the default far ocean plane below its %sm wave envelope', (maxWaveHeightM) => {
    const result = buildWaterMeshView(
      {
        zoneGuid: guid('2'),
        zoneGeneration: 3,
        originXZ: [0, 0],
        extentM: [8, 8],
        tileSizeM: 4,
        tessellationFactor: 1,
        lodScale: 1,
        far: { extentM: [8, 8], materialKey: 'far-ocean' },
        bodies: [
          {
            guid: guid('3'),
            generation: 7,
            type: 'ocean',
            visible: true,
            affectsWaterMesh: true,
            priority: 0,
            materialKey: 'ocean',
            waveOriginXZ: [0, 0],
            baseHeightM: 2,
            maxWaveHeightM,
            polygon: {
              outer: [
                [0, 0],
                [8, 0],
                [8, 8],
                [0, 8],
              ],
            },
          },
        ],
      },
      { viewId: 'main', observerM: [4, 4, 4] },
    );
    if (!result.ok) throw new Error('far ocean fixture failed to build');
    const far = result.value.instances.filter((tile) => tile.far);
    expect(far.map((tile) => tile.waterYM)).toEqual(Array(8).fill(2 - maxWaveHeightM));
    expect(far.map((tile) => [tile.yMinM, tile.yMaxM])).toEqual(
      Array.from({ length: 8 }, () => [2 - maxWaveHeightM, 2 + maxWaveHeightM]),
    );
    expect(result.value.instances.filter((tile) => !tile.far).map((tile) => tile.waterYM)).toEqual(
      expect.arrayContaining([2]),
    );
  });

  it('keeps the far ring on Zone bounds while the near grid spans snapped power-of-two half extents', () => {
    const result = buildWaterMeshView(
      {
        zoneGuid: guid('2'),
        zoneGeneration: 3,
        originXZ: [-96, -96],
        extentM: [192, 192],
        tileSizeM: 8,
        tessellationFactor: 2,
        lodScale: 1,
        far: { extentM: [16, 16], materialKey: 'far-ocean' },
        bodies: [
          {
            guid: guid('3'),
            generation: 7,
            type: 'ocean',
            visible: true,
            affectsWaterMesh: true,
            priority: 0,
            materialKey: 'ocean',
            waveOriginXZ: [0, 0],
            baseHeightM: 0,
            maxWaveHeightM: 1,
            polygon: {
              outer: [
                [-128, -128],
                [128, -128],
                [128, 128],
                [-128, 128],
              ],
            },
          },
        ],
      },
      { viewId: 'main', observerM: [0, 8, 0] },
    );
    if (!result.ok) throw new Error('snapped near/far fixture failed to build');
    const near = result.value.instances.filter((tile) => !tile.far);
    const far = result.value.instances.filter((tile) => tile.far);
    expect(Math.min(...near.map((tile) => tile.originXZ[0]))).toBe(-128);
    expect(Math.max(...near.map((tile) => tile.originXZ[0] + tile.extentXZ[0]))).toBe(128);
    expect(Math.min(...near.map((tile) => tile.originXZ[1]))).toBe(-128);
    expect(Math.max(...near.map((tile) => tile.originXZ[1] + tile.extentXZ[1]))).toBe(128);
    expect(far).toHaveLength(8);
    expect(far.some((tile) => tile.originXZ[0] + tile.extentXZ[0] === -96)).toBe(true);
    expect(far.some((tile) => tile.originXZ[0] === 96)).toBe(true);
  });

  it('preserves local morph inputs at far world origins and limits height morph to the lowest LOD', () => {
    const origin = 16_777_216;
    const result = buildWaterMeshView(
      {
        zoneGuid: guid('2'),
        zoneGeneration: 3,
        originXZ: [origin, origin],
        extentM: [32, 32],
        tileSizeM: 4,
        tessellationFactor: 3,
        lodScale: 1,
        bodies: [
          {
            guid: guid('3'),
            generation: 7,
            type: 'lake',
            visible: true,
            affectsWaterMesh: true,
            priority: 0,
            materialKey: 'lake',
            waveOriginXZ: [origin + 5, origin - 6],
            baseHeightM: 0,
            maxWaveHeightM: 0,
            polygon: {
              outer: [
                [origin + 1, origin + 1],
                [origin + 31, origin + 1],
                [origin + 31, origin + 31],
                [origin + 1, origin + 31],
              ],
            },
          },
        ],
      },
      { viewId: 'far-origin', observerM: [origin + 16, 4 * (2 + Math.SQRT2 / 2), origin + 16] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const farLodTile = result.value.instances.find(
      (tile) => tile.originXZ[0] === origin && tile.originXZ[1] === origin,
    );
    const lowLodTile = result.value.instances.find((tile) => tile.lod0 === 0 && tile.shouldMorph);
    expect(farLodTile).toBeDefined();
    expect(lowLodTile?.heightMorph01).toBeCloseTo(0.5, 3);
    expect(farLodTile?.lod0).toBeGreaterThan(0);
    expect(farLodTile?.heightMorph01).toBe(0);
    expect(farLodTile?.cameraRelativeXZ).toEqual([16, 16]);
    expect(farLodTile?.waveOriginOffsetXZ).toEqual([-5, 6]);
    expect(
      farLodTile?.coverageRings?.flat().every(([x, z]) => x >= 0 && x <= 4 && z >= 0 && z <= 4),
    ).toBe(true);
    expect(Math.fround(origin + 1) - Math.fround(origin)).toBe(0);
    const tileIndex = farLodTile === undefined ? -1 : result.value.instances.indexOf(farLodTile);
    const recordView = new DataView(
      result.value.instanceBytes.buffer,
      result.value.instanceBytes.byteOffset,
      result.value.instanceBytes.byteLength,
    );
    expect(recordView.getFloat32(tileIndex * 96 + 80, true)).toBe(16);
    expect(recordView.getFloat32(tileIndex * 96 + 84, true)).toBe(16);
    expect(result.value.layout).toMatchObject({ schemaVersion: 7, strideBytes: 96 });
  });

  it('selects partial priority/transition owners, morphs by water height, and emits eight far instances', () => {
    const riverInput = {
      guid: guid('3'),
      generation: 7,
      type: 'river' as const,
      visible: true,
      affectsWaterMesh: true,
      priority: 0,
      materialKey: 'river',
      transitionTo: 'lake' as const,
      transitionMaterialKey: 'river-lake',
      waveOriginXZ: [0, 0] as const,
      baseHeightM: 2,
      maxWaveHeightM: 1,
      polygon: {
        outer: [
          [0, 0],
          [8, 0],
          [8, 4],
          [0, 4],
        ] as const,
      },
    };
    const lakeInput = {
      guid: guid('4'),
      generation: 2,
      type: 'lake' as const,
      visible: true,
      affectsWaterMesh: true,
      priority: 10,
      materialKey: 'lake',
      waveOriginXZ: [1, 2] as const,
      baseHeightM: 100,
      maxWaveHeightM: 1,
      polygon: {
        outer: [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ] as const,
      },
    };
    const transition = buildWaterMeshView(
      {
        zoneGuid: guid('2'),
        zoneGeneration: 3,
        originXZ: [0, 0],
        extentM: [8, 8],
        tileSizeM: 4,
        tessellationFactor: 1,
        lodScale: 1,
        far: { extentM: [16, 16], ownerGuid: guid('3'), materialKey: 'far', waterLevelM: -10 },
        bodies: [riverInput, lakeInput],
      },
      { viewId: 'main', observerM: [1, 2, 1] },
    );
    expect(transition.ok).toBe(true);
    if (!transition.ok) return;
    expect(
      transition.value.instances.some(
        (tile) =>
          tile.ownerGuid === guid('3') &&
          tile.materialKey === 'river-lake' &&
          tile.transitionRenderIndex > 0,
      ),
    ).toBe(true);
    const transitionTile = transition.value.instances.find(
      (tile) => tile.ownerGuid === guid('3') && tile.materialKey === 'river-lake',
    );
    expect(transitionTile).toMatchObject({
      ownerGuid: guid('3'),
      ownerGeneration: 7,
      transitionBodyGuid: guid('4'),
      transitionBodyGeneration: 2,
      waterYM: 100,
    });
    expect(transitionTile?.waveOriginOffsetXZ).toEqual([
      (transitionTile?.originXZ[0] ?? 0) - 1,
      (transitionTile?.originXZ[1] ?? 0) - 2,
    ]);
    expect(
      transition.value.instances.some(
        (tile) => tile.ownerGuid === guid('3') && tile.materialKey === 'river',
      ),
    ).toBe(true);
    expect(transition.value.instances.filter((tile) => tile.far)).toHaveLength(8);
    expect(
      transition.value.instances
        .filter((tile) => tile.far)
        .every((tile) => tile.waterYM === -10 && tile.ownerGuid === guid('3')),
    ).toBe(true);
    const farTiles = transition.value.instances.filter((tile) => tile.far);
    expect(farTiles.reduce((sum, tile) => sum + tile.extentXZ[0] * tile.extentXZ[1], 0)).toBe(
      (8 + 2 * 16) ** 2 - 8 ** 2,
    );
    expect(Math.min(...farTiles.map((tile) => tile.originXZ[0]))).toBe(-16);
    expect(Math.max(...farTiles.map((tile) => tile.originXZ[0] + tile.extentXZ[0]))).toBe(24);
    for (let left = 0; left < farTiles.length; left++) {
      for (let right = left + 1; right < farTiles.length; right++) {
        const a = farTiles[left];
        const b = farTiles[right];
        if (!a || !b) continue;
        const overlapX = Math.max(
          0,
          Math.min(a.originXZ[0] + a.extentXZ[0], b.originXZ[0] + b.extentXZ[0]) -
            Math.max(a.originXZ[0], b.originXZ[0]),
        );
        const overlapZ = Math.max(
          0,
          Math.min(a.originXZ[1] + a.extentXZ[1], b.originXZ[1] + b.extentXZ[1]) -
            Math.max(a.originXZ[1], b.originXZ[1]),
        );
        expect(overlapX * overlapZ).toBe(0);
      }
    }

    const broadBody = {
      guid: guid('6'),
      generation: 1,
      type: 'lake' as const,
      visible: true,
      affectsWaterMesh: true,
      priority: 0,
      materialKey: 'broad',
      waveOriginXZ: [0, 0] as const,
      baseHeightM: 0,
      maxWaveHeightM: 0,
      polygon: {
        outer: [
          [-1, -1],
          [33, -1],
          [33, 33],
          [-1, 33],
        ] as const,
      },
    };
    const buildAtHeight = (observerY: number) =>
      buildWaterMeshView(
        {
          zoneGuid: guid('2'),
          zoneGeneration: 3,
          originXZ: [0, 0],
          extentM: [32, 32],
          tileSizeM: 4,
          tessellationFactor: 3,
          lodScale: 1,
          bodies: [broadBody],
        },
        { viewId: 'height', observerM: [0, observerY, 0] },
      );
    const near = buildAtHeight(0);
    const morphed = buildAtHeight(4 * (2 + 2 ** 0.5 / 2));
    const distantHeight = buildAtHeight(1000);
    expect(near.ok && Math.min(...near.value.instances.map((tile) => tile.lod0))).toBe(0);
    expect(
      morphed.ok &&
        morphed.value.instances.some(
          (tile) => tile.heightMorph01 > 0.49 && tile.heightMorph01 < 0.51,
        ),
    ).toBe(true);
    expect(distantHeight.ok && distantHeight.value.instances).toHaveLength(1);
    expect(distantHeight.ok && distantHeight.value.instances[0]).toMatchObject({
      lod0: 3,
      lod1: 3,
    });
  });

  it('decodes WaterInfo meters and meters-per-second, including the B=0 no-water sentinel', () => {
    const zone = {
      waterInfo: {
        format: 'rgba32f',
        resolution: { widthPx: 64, heightPx: 32 },
        blurRadius: 3,
        localTessellation: true,
      },
      extentM: { spanXM: 100, spanZM: 50 },
    } as Parameters<typeof createWaterInfoContext>[0]['zone'];
    const reservation: WaterInfoSliceReservation = {
      zoneGuid: guid('2'),
      viewId: 'view-a',
      slice: 2,
      deviceGeneration: 5,
      reservationGeneration: 1,
    };
    const context = createWaterInfoContext(
      {
        zoneGuid: guid('2'),
        viewId: 'view-a',
        zone,
        centerXZ: [10, -5],
        waterYMinM: -2,
        waterYMaxM: 8,
        groundYMinM: -10,
        maxVelocityMPerSec: 4,
        zoneGeneration: 3,
        deviceGeneration: 5,
        frameGeneration: 9,
        sourceDigest: 'source',
      },
      reservation,
    );
    expect(context).toBeDefined();
    if (!context) return;
    expect(context).toMatchObject({
      format: 'rgba32f',
      widthPx: 64,
      heightPx: 32,
      blurRadius: 3,
      slice: 2,
    });
    expect(waterInfoWorldToUv(context, [10, -5])).toEqual([0.5, 0.5]);
    expect(waterInfoWorldToUv(context, [100, 100])).toEqual([1, 1]);
    const pixel = [0.75, 0.25, 0.5, 0.5] as const;
    expect(decodeWaterInfoVelocity(pixel, 4)).toEqual([2, -2]);
    expect(decodeWaterInfoGroundHeight(pixel, context)).toBe(-1);
    expect(decodeWaterInfoHeight(pixel, context)).toBe(3);
    expect(decodeWaterInfoHeight([0, 0, 0, 0], context)).toBe(-12.56);
    expect(
      createWaterInfoContext(
        {
          zoneGuid: guid('2'),
          viewId: 'view-a',
          zone: { ...zone, waterInfo: { ...zone.waterInfo, blurRadius: 99 } },
          centerXZ: [0, 0],
          waterYMinM: 0,
          waterYMaxM: 1,
          groundYMinM: 0,
          maxVelocityMPerSec: 1,
          zoneGeneration: 3,
          deviceGeneration: 5,
          frameGeneration: 10,
          sourceDigest: 'blur',
        },
        reservation,
      )?.blurRadius,
    ).toBe(16);
    expect(
      createWaterInfoContext(
        {
          zoneGuid: guid('2'),
          viewId: 'wrong-view',
          zone,
          centerXZ: [0, 0],
          waterYMinM: 0,
          waterYMaxM: 1,
          groundYMinM: 0,
          maxVelocityMPerSec: 1,
          zoneGeneration: 3,
          deviceGeneration: 5,
          frameGeneration: 9,
          sourceDigest: 'source',
        },
        reservation,
      ),
    ).toBeUndefined();
  });

  it('keeps wave cooking bounded and CPU simple/full evaluation numeric', () => {
    const waveSet = cookGerstnerWaveSet({
      kind: 'water-wave-set',
      sourceMode: 'predefined',
      waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0 }],
      inputDigest: 'a'.repeat(64),
      depthMaskM: 4,
      maxWaveHeightM: 0.5,
      timeSource: 'fixed-step',
    });
    expect(waveSet.ok).toBe(true);
    if (!waveSet.ok) return;
    const input = {
      waves: waveSet.value.waves,
      positionXZ: [0, 0] as const,
      timeSeconds: 0,
      depthM: 4,
      depthMaskM: 0,
    };
    expect(waterWaveDepthAttenuation(2, 4)).toBeCloseTo(1 - Math.exp(-1));
    expect(evaluateGerstnerWavesCpuSimple(input)).toBeCloseTo(0.5);
    const full = evaluateGerstnerWavesCpuFull(input);
    expect(full.displacementM).toEqual([0, 0.5, 0]);
    expect(full.normalYUp).toHaveLength(3);
    expect(full.velocityMPerSec.every(Number.isFinite)).toBe(true);
    const wave = waveSet.value.waves[0];
    expect(wave).toBeDefined();
    if (!wave) return;
    const quarterPeriod = Math.PI / (2 * wave.omegaPerSec);
    expect(evaluateGerstnerWavesCpuSimple({ ...input, timeSeconds: quarterPeriod })).toBeCloseTo(
      0,
      8,
    );
    expect(evaluateGerstnerWavesCpuSimple(input)).toBe(evaluateGerstnerWavesCpuSimple(input));
    const edgeInput = { waves: waveSet.value.waves, timeSeconds: 0, depthM: 4, depthMaskM: 0 };
    expect(
      evaluateGerstnerWavesCpuSimple({
        ...edgeInput,
        positionXZ: [WATER_WAVE_LWC_TILE_LENGTH_M / 2, 0],
      }),
    ).toBeCloseTo(0.5);
    const insideBlend = WATER_WAVE_LWC_TILE_LENGTH_M / 2 - 4;
    expect(
      evaluateGerstnerWavesCpuSimple({ ...edgeInput, positionXZ: [insideBlend, 0] }),
    ).toBeCloseTo(0.5 * Math.cos(insideBlend * wave.kPerM), 8);
    expect(
      cookGerstnerWaveSet({
        kind: 'water-wave-set',
        sourceMode: 'predefined',
        waves: [{ directionXZ: [0, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0.4 }],
        inputDigest: 'a'.repeat(64),
        depthMaskM: 4,
        maxWaveHeightM: 0.5,
        timeSource: 'fixed-step',
      }).ok,
    ).toBe(false);
    const generatedSource = (seed: number) => ({
      kind: 'water-wave-set' as const,
      waveSource: {
        kind: 'generated' as const,
        seed,
        generatorId: SIMPLE_GERSTNER_WAVE_GENERATOR_ID,
        generatorVersion: SIMPLE_GERSTNER_WAVE_GENERATOR_VERSION,
        generatorConfig: {
          count: 3,
          randomness: 0.5,
          wavelengthMinM: 8,
          wavelengthMaxM: 16,
          wavelengthFalloff: 1,
          amplitudeMinM: 0.1,
          amplitudeMaxM: 0.2,
          amplitudeFalloff: 1,
          windAngleDegrees: 15,
          directionAngularSpreadDegrees: 25,
          largeWaveSteepness: 0.5,
          smallWaveSteepness: 0.1,
          steepnessFalloff: 1,
        },
      },
      depthMaskM: 5,
      maxWaveHeightM: 1,
      timeSource: 'fixed-step' as const,
    });
    const seed42a = cookWaterAsset(generatedSource(42));
    const seed42b = cookWaterAsset(generatedSource(42));
    const seed43 = cookWaterAsset(generatedSource(43));
    expect(seed42a.ok && seed42b.ok && seed42a.value.inputDigest).toBe(
      seed42b.ok && seed42b.value.inputDigest,
    );
    expect(seed42a.ok && seed42b.ok && seed42a.value.waves).toEqual(
      seed42b.ok && seed42b.value.waves,
    );
    expect(seed42a.ok && seed43.ok && seed42a.value.waves).not.toEqual(
      seed43.ok && seed43.value.waves,
    );
  });

  it('retains admitted wave preparation across query and upload consumers while borrowed snapshots stay live', async () => {
    const waveSetGuid = guid('9');
    const waveSet = {
      kind: 'water-wave-set' as const,
      sourceMode: 'predefined' as const,
      waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.25, steepness: 0 }],
      inputDigest: 'a'.repeat(64),
      depthMaskM: 0,
      maxWaveHeightM: 0.5,
      timeSource: 'fixed-step' as const,
    };
    const dependency = {
      field: 'waveSetGuid' as const,
      guid: waveSetGuid,
      kind: 'water-wave-set' as const,
      status: 'valid' as const,
      payload: waveSet,
    };
    const packed = (
      await buildWaterPackOutputs(
        {
          body: {
            ...river(waveSetGuid),
            type: 'lake',
            underwaterPostProcessMaterialGuid: guid('8'),
            collision: { type: 'polygon', enabled: false },
            spline: { closed: true, points: [point(0, -1, -1), point(1, 1, -1), point(2, 1, 1)] },
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000582') },
      )
    ).unwrap();
    assert(packed.body?.kind === 'water-body');
    let available = true;
    const system = new WaterSystem(
      () => undefined,
      () => [available ? dependency : { ...dependency, status: 'unavailable' as const }],
    );
    const snapshot = system
      .mountBody(
        guid('4'),
        'v1',
        packed.body,
        guid('4'),
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        undefined,
        11,
      )
      .unwrap();
    const context = {
      worldId: 1,
      worldIdentity: 'wave-preparation-world',
      timeSeconds: 0,
      previousTimeSeconds: 0,
      heightSource: { kind: 'fixed' as const },
    };
    const upload = () => system.buildWaveUploadPlan(() => context).unwrap();
    const first = upload();
    const query = {
      positionM: [0, 0, 0] as const,
      flags: WaterQueryFlags.ComputeLocation | WaterQueryFlags.IncludeWaves,
      timeSeconds: 0,
    };
    const firstQuery = system.queryBody(guid('4'), query);
    expect(firstQuery.ok).toBe(true);
    const surface = (result: ReturnType<typeof queryWaterBodySnapshot>) => {
      assert(result.ok);
      return result.value.surfaceM;
    };
    const selectView = () =>
      system
        .updateViewState(
          {
            viewId: 'wave-preparation-view',
            traceGeneration: 1,
            positionM: [0, 0, 0],
            timeSeconds: 0,
            nearPlaneCornerDistanceM: 0.05,
          },
          {
            sweepSphereAll: () =>
              ok([
                {
                  entity: 11,
                  colliderId: 11,
                  timeOfImpact: 0,
                  point: vec3.create(0, -1, 0),
                  normal: vec3.create(0, 1, 0),
                  initialOverlap: true,
                },
              ]),
          },
        )
        .unwrap();
    const firstView = selectView();
    expect(firstView.candidates[0]).toMatchObject({
      hasWaves: true,
      query: { waveInfo: { heightM: 0.25 } },
    });
    expect(upload().waves[0]).toBe(first.waves[0]);
    const firstWave = waveSet.waves[0];
    assert(firstWave);
    firstWave.amplitudeM = 0.125;
    expect(surface(system.queryBody(guid('4'), query))).toEqual(surface(firstQuery));
    expect(upload().waves[0]).toBe(first.waves[0]);
    available = false;
    expect(system.refreshDependencies(guid('4'), ['query'])).toEqual({ ok: true, value: false });
    expect(upload().waves[0]).toBe(first.waves[0]);
    available = true;
    expect(system.refreshDependencies(guid('4'), ['query']).unwrap()).toBe(true);
    const refreshed = upload();
    expect(refreshed.waves[0]).not.toBe(first.waves[0]);
    expect(refreshed.waves[0]?.amplitudeM).toBe(0.125);
    expect(selectView().candidates[0]?.query?.waveInfo?.heightM).toBe(0.125);
    expect(firstView.candidates[0]?.query?.waveInfo?.heightM).toBe(0.25);
    expect(first.waves[0]?.amplitudeM).toBe(0.25);
    expect(surface(queryWaterBodySnapshot(snapshot, query))).toEqual(surface(firstQuery));

    const borrowed = { ...snapshot, dependencies: [dependency] };
    const borrowedFirst = queryWaterBodySnapshot(borrowed, query);
    const borrowedUpload = buildWaterWaveUploadBody(borrowed, context).unwrap();
    firstWave.amplitudeM = 0.375;
    expect(surface(queryWaterBodySnapshot(borrowed, query))).not.toEqual(surface(borrowedFirst));
    expect(buildWaterWaveUploadBody(borrowed, context).unwrap().waveSet.waves[0]?.amplitudeM).toBe(
      0.375,
    );
    expect(borrowedUpload.waveSet.waves[0]?.amplitudeM).toBe(0.125);
    expect(
      system.hotReloadBody(guid('4'), 'invalid', { ...packed.body, maxWaveHeightM: -1 }).ok,
    ).toBe(false);
    expect(upload().waves[0]).toBe(refreshed.waves[0]);
    expect(selectView().candidates[0]?.query?.waveInfo?.heightM).toBe(0.125);
    const reloaded = system.hotReloadBody(guid('4'), 'v2', packed.body).unwrap();
    expect(reloaded.sceneGeneration).toBeGreaterThan(snapshot.sceneGeneration);
    const afterReload = upload();
    expect(afterReload.waves[0]).not.toBe(refreshed.waves[0]);
    expect(afterReload.waves[0]?.amplitudeM).toBe(0.375);
    expect(selectView().candidates[0]?.query?.waveInfo?.heightM).toBe(0.375);
    expect(firstView.candidates[0]?.query?.waveInfo?.heightM).toBe(0.25);
    expect(refreshed.waves[0]?.amplitudeM).toBe(0.125);
  });

  it('queries the final closed spline segment with the next sequential input key', async () => {
    const packed = (
      await buildWaterPackOutputs(
        {
          body: {
            ...river(),
            type: 'lake',
            collision: { type: 'polygon', enabled: false },
            spline: {
              closed: true,
              points: [point(0, 0, 0), point(1, 8, 0), point(2, 8, 8), point(3, 0, 8)].map(
                (value) => ({ ...value, interpolationMode: 'linear' as const }),
              ),
            },
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000584') },
      )
    ).unwrap();
    assert(packed.body?.kind === 'water-body');
    const system = new WaterSystem(() => undefined);
    const snapshot = system.mountBody(guid('4'), 'v1', packed.body).unwrap();
    const input = {
      positionM: [-1, 2, 4] as const,
      flags: WaterQueryFlags.ComputeVelocity,
      timeSeconds: 0,
    };
    const implicit = system.queryBody(guid('4'), input);
    assert(implicit.ok);
    expect(implicit.value.splineKey).toBeCloseTo(3.5, 12);
    expect(implicit.value.velocityMPerSec).toEqual([0, 0, -2]);
    const explicit = queryWaterBodySnapshot(snapshot, { ...input, splineKey: 3.5 });
    assert(explicit.ok);
    expect(explicit.value.velocityMPerSec).toEqual([0, 0, -2]);
    expect(queryWaterBodySnapshot(snapshot, { ...input, splineKey: 4.01 })).toMatchObject({
      ok: false,
      error: { code: 'query-data-unavailable' },
    });
  });

  it('observes query work with balanced scopes without changing query results', async () => {
    const packed = (
      await buildWaterPackOutputs(
        { body: river() },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000586') },
      )
    ).unwrap();
    assert(packed.body?.kind === 'water-body');
    const system = new WaterSystem(() => undefined);
    system.mountBody(guid('4'), 'v1', packed.body).unwrap();
    const input = {
      positionM: [3, 1, 0.5] as const,
      flags:
        WaterQueryFlags.ComputeLocation |
        WaterQueryFlags.ComputeNormal |
        WaterQueryFlags.ComputeDepth |
        WaterQueryFlags.ComputeVelocity |
        WaterQueryFlags.IncludeWaves,
      timeSeconds: 0,
    };
    const expected = system.queryBody(guid('4'), input);
    const queryProjection = (result: ReturnType<WaterSystem['queryBody']>) => {
      assert(result.ok);
      return { ...result.value, valid: [...result.value.valid] };
    };
    const stack: string[] = [];
    const observedNames: string[] = [];
    const observed = system.queryBody(guid('4'), input, {
      begin(operation) {
        observedNames.push(operation);
        stack.push(operation);
        return {
          end() {
            expect(stack.pop()).toBe(operation);
          },
        };
      },
    });

    expect(queryProjection(observed)).toEqual(queryProjection(expected));
    expect(stack).toEqual([]);
    expect(observedNames).toEqual(
      expect.arrayContaining(['water/query/terrain-routing', 'water/query/spline-evaluation']),
    );
    expect(
      queryProjection(
        system.queryBody(guid('4'), input, {
          begin() {
            throw new Error('diagnostics failure');
          },
        }),
      ),
    ).toEqual(queryProjection(expected));
  });

  it('prepares admitted spline queries once while borrowed metadata remains live', async () => {
    const source = river();
    const packed = (
      await buildWaterPackOutputs(
        { body: source },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000585') },
      )
    ).unwrap();
    assert(packed.body?.kind === 'water-body');
    const system = new WaterSystem(() => undefined);
    const snapshot = system.mountBody(guid('4'), 'v1', packed.body).unwrap();
    const input = {
      positionM: [3, 1, 0.5] as const,
      flags:
        WaterQueryFlags.ComputeLocation |
        WaterQueryFlags.ComputeNormal |
        WaterQueryFlags.ComputeDepth |
        WaterQueryFlags.ComputeVelocity,
      timeSeconds: 0,
    };
    const values = (result: ReturnType<typeof queryWaterBodySnapshot>) => {
      assert(result.ok);
      return { ...result.value, valid: [...result.value.valid] };
    };
    const expected = values(queryWaterBodySnapshot(snapshot, input));
    const resolve = vi.spyOn(bodySpline, 'resolveWaterSplinePoints');
    try {
      expect(values(system.queryBody(guid('4'), input))).toEqual(expected);
      expect(values(system.queryBody(guid('4'), input))).toEqual(expected);
      expect(resolve).not.toHaveBeenCalled();
      const borrowed = {
        ...snapshot,
        asset: {
          ...snapshot.asset,
          spline: {
            ...snapshot.asset.spline,
            points: snapshot.asset.spline.points.map((value) => ({ ...value })),
          },
        },
      };
      expect(values(queryWaterBodySnapshot(borrowed, input))).toEqual(expected);
      for (const value of borrowed.asset.spline.points) value.velocityMPerSec = 7;
      const changed = values(queryWaterBodySnapshot(borrowed, input));
      expect(changed.velocityMPerSec).not.toEqual(expected.velocityMPerSec);
      expect(resolve).toHaveBeenCalled();
      resolve.mockClear();
      expect(values(system.queryBody(guid('4'), input))).toEqual(expected);
      expect(resolve).not.toHaveBeenCalled();
      expect(
        system.hotReloadBody(guid('4'), 'invalid', { ...packed.body, maxWaveHeightM: -1 }).ok,
      ).toBe(false);
      expect(values(system.queryBody(guid('4'), input))).toEqual(expected);
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
    }
    const reloaded = (
      await buildWaterPackOutputs(
        {
          body: {
            ...source,
            spline: {
              ...source.spline,
              points: source.spline.points.map((value) => ({ ...value, velocityMPerSec: 7 })),
            },
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000585') },
      )
    ).unwrap();
    assert(reloaded.body?.kind === 'water-body');
    const current = system.hotReloadBody(guid('4'), 'v2', reloaded.body).unwrap();
    expect(values(system.queryBody(guid('4'), input)).velocityMPerSec).not.toEqual(
      expected.velocityMPerSec,
    );
    expect(values(system.queryBody(guid('4'), input))).toEqual(
      values(queryWaterBodySnapshot(current, input)),
    );
    expect(values(queryWaterBodySnapshot(snapshot, input))).toEqual(expected);
  });

  it.each(
    (['linear', 'curve', 'curve-clamped', 'curve-custom-tangent'] as const).flatMap((mode) =>
      [false, true].map((closed) => ({ mode, closed })),
    ),
  )('matches live $mode spline queries with closed=$closed after admission and pose edits', async ({
    mode,
    closed,
  }) => {
    const packed = (
      await buildWaterPackOutputs(
        {
          body: {
            ...river(),
            type: closed ? 'lake' : 'custom',
            flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
            collision: { type: 'none', enabled: false },
            queryFootprint: [
              [-8, -8],
              [16, -8],
              [16, 16],
              [-8, 16],
            ],
            spline: {
              closed,
              interpolationVersion: 'ue-water-spline/1',
              points: [point(0, 0, 0), point(1, 8, 4), point(2, 3, 8), point(3, -2, 4)].map(
                (value, index) => ({
                  ...value,
                  positionM: [value.positionM[0], index - 1, value.positionM[2]] as const,
                  interpolationMode: mode,
                  rotationQuat: [0, 0, 0, 1] as const,
                  arriveRotationQuat: [0, 0, 0, 1] as const,
                  leaveRotationQuat: [0, 0, 0, 1] as const,
                  arriveTangentM: [2, 1, -1] as const,
                  leaveTangentM: [-1, -0.5, 2] as const,
                  velocityMPerSec: index * 0.75,
                }),
              ),
            },
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000586') },
      )
    ).unwrap();
    assert(packed.body?.kind === 'water-body');
    const system = new WaterSystem(() => undefined);
    system.mountBody(guid('4'), 'v1', packed.body).unwrap();
    for (const translation of [0, 16]) {
      const matrix = closed
        ? ([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, translation, 3, -5, 1] as const)
        : ([1.5, 0, -0.5, 0, 0.25, 2, 0, 0, 0.5, 0, 1.5, 0, translation, 3, -5, 1] as const);
      system.updateInstanceTransform(guid('4'), matrix).unwrap();
      const snapshot = system.snapshot(guid('4'));
      assert(snapshot);
      for (const local of [
        [-1, 0, 2],
        [0, 1, 0],
        [5, 2, 4],
        [10, 0, 5],
        [1, 2, 7],
      ] as const) {
        const positionM = [
          matrix[0] * local[0] + matrix[4] * local[1] + matrix[8] * local[2] + matrix[12],
          matrix[1] * local[0] + matrix[5] * local[1] + matrix[9] * local[2] + matrix[13],
          matrix[2] * local[0] + matrix[6] * local[1] + matrix[10] * local[2] + matrix[14],
        ] as const;
        const input = {
          positionM,
          flags:
            WaterQueryFlags.ComputeLocation |
            WaterQueryFlags.ComputeNormal |
            WaterQueryFlags.ComputeVelocity |
            WaterQueryFlags.ComputeDepth,
          timeSeconds: 0,
        };
        const expected = queryWaterBodySnapshot(snapshot, input);
        const actual = system.queryBody(guid('4'), input);
        assert(expected.ok && actual.ok);
        assert(actual.value.splineKey !== undefined && expected.value.splineKey !== undefined);
        assert(actual.value.depthM !== undefined && expected.value.depthM !== undefined);
        expect(actual.value.splineKey).toBeCloseTo(expected.value.splineKey, 9);
        expect(actual.value.depthM).toBeCloseTo(expected.value.depthM, 9);
        for (const field of ['locationM', 'normalYUp', 'velocityMPerSec'] as const)
          for (let axis = 0; axis < 3; axis++)
            expect(actual.value[field]?.[axis]).toBeCloseTo(expected.value[field]?.[axis] ?? 0, 9);
        expect([...actual.value.valid]).toEqual([...expected.value.valid]);
        expect(
          system.queryBody(guid('4'), { ...input, splineKey: closed ? 4.01 : 3.01 }),
        ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
      }
    }
  });

  it('projects admitted query data without producing full output snapshots and keeps live Zone resolution detached', async () => {
    const packed = (
      await buildWaterPackOutputs(
        {
          body: {
            ...river(),
            type: 'lake',
            zoneGuid: guid('6'),
            collision: { type: 'polygon', enabled: false },
            spline: { closed: true, points: [point(0, -2, -2), point(1, 2, -2), point(2, 0, 2)] },
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000583') },
      )
    ).unwrap();
    assert(packed.body?.kind === 'water-body');
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let zoneGeneration: number | undefined = 1;
    const order: string[] = [];
    const held: WaterQueryBodySnapshot[] = [];
    const system = new WaterSystem(
      () => {
        order.push('zone');
        return zoneGeneration === undefined
          ? undefined
          : { generation: zoneGeneration, worldMatrixM: matrix };
      },
      () => [],
      () => [],
      (body) => {
        order.push('terrain');
        held.push(body);
        return undefined;
      },
    );
    const mounted = system.mountBody(guid('4'), 'v1', packed.body).unwrap();
    const snapshot = vi.spyOn(system, 'snapshot');
    order.length = 0;
    const query = {
      get positionM() {
        order.push('position');
        return [0, 0, 0] as const;
      },
      flags: WaterQueryFlags.ComputeDepth,
      timeSeconds: 0,
    };
    const first = system.queryBody(guid('4'), query);
    assert(first.ok);
    const sample = (result: ReturnType<typeof queryWaterBodySnapshot>) => {
      assert(result.ok);
      return { ...result.value, valid: [...result.value.valid] };
    };
    expect(snapshot).not.toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(['zone', 'position']);
    expect(order.at(-1)).toBe('position');
    expect(held[0]).toEqual({
      guid: guid('4'),
      sceneGeneration: mounted.sceneGeneration,
      asset: mounted.asset,
      worldMatrixM: mounted.worldMatrixM,
      binding: mounted.binding,
      dependencies: mounted.dependencies,
      exclusionVolumes: mounted.exclusionVolumes,
    });
    expect(Object.isFrozen(held[0])).toBe(true);
    matrix[12] = 8;
    zoneGeneration = 2;
    expect(sample(system.queryBody(guid('4'), query))).toEqual(sample(first));
    expect(held[1]?.binding).toMatchObject({ kind: 'bound', zoneGeneration: 2 });
    assert(held[1]?.binding.kind === 'bound');
    expect(held[1].binding.worldMatrixM[12]).toBe(8);
    assert(held[0]?.binding.kind === 'bound');
    expect(held[0].binding.worldMatrixM[12]).toBe(0);
    expect(held[0].binding.zoneGeneration).toBe(1);
    zoneGeneration = undefined;
    expect(system.queryBody(guid('4'), query).ok).toBe(true);
    expect(held[2]?.binding).toEqual({
      kind: 'zone-unbound',
      requestedGuid: guid('6'),
      retryOnCatalogChange: true,
    });
    expect(system.queryBody(guid('4'), null as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid-query-flags' },
    });
    expect(system.queryBody(guid('5'), query)).toMatchObject({
      ok: false,
      error: { code: 'body-unregistered' },
    });
    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
    expect(system.snapshot(guid('4'))).toMatchObject({
      outputGenerations: mounted.outputGenerations,
      outputReceipts: mounted.outputReceipts,
      outputs: { query: mounted.outputs.query },
    });
    expect(sample(first)).toEqual(sample(queryWaterBodySnapshot(mounted, query)));
  });

  it('queries only the requested Body and rejects invalid flags, stale generations, and invalid explicit spline keys', async () => {
    const packed = await buildWaterPackOutputs(
      { body: { ...river(), collision: { type: 'river-prism', enabled: false } } },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000496') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.body?.kind !== 'water-body') return;
    const system = new WaterSystem(() => undefined);
    const snapshot = system.mountBody(guid('4'), 'v1', packed.value.body).unwrap();
    const sparseMatrix: number[] = [1];
    sparseMatrix.length = 16;
    expect(system.updateInstanceTransform(guid('4'), sparseMatrix)).toMatchObject({
      ok: false,
      error: { code: 'invalid-source' },
    });
    expect(system.queryBody(guid('4'), null as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid-query-flags' },
    });
    expect(queryWaterBodySnapshot(snapshot, null as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid-query-flags' },
    });
    const sparsePosition: number[] = [0];
    sparsePosition.length = 3;
    expect(
      queryWaterBodySnapshot(snapshot, {
        positionM: sparsePosition as never,
        flags: 0,
        timeSeconds: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-query-flags' } });
    expect(
      system.publishBakedQueryGrid(guid('4'), snapshot.sceneGeneration, null as never),
    ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
    const bakedGrid = {
      originXZ: [-1, -1] as const,
      originY: 0,
      spacingXZ: [1, 1] as const,
      width: 3,
      height: 3,
      samples: new Float32Array(3 * 3 * 4),
    };
    for (let index = 0; index < 9; index += 1)
      bakedGrid.samples.set([0.5, 1.25, 0.75, -0.25], index * 4);
    const disabledBakedSource = {
      kind: 'live-capture' as const,
      enabled: false,
      componentValid: true,
      dataValid: true,
      grid: bakedGrid,
    };
    expect(
      system.publishBakedQueryGrid(guid('4'), snapshot.sceneGeneration, disabledBakedSource),
    ).toMatchObject({
      ok: false,
      error: { code: 'query-data-unavailable' },
    });
    expect(system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)).toBeUndefined();
    expect(
      system.publishBakedQueryGrid(guid('4'), snapshot.sceneGeneration, {
        ...disabledBakedSource,
        enabled: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      system.queryBody(guid('4'), {
        positionM: [0.5, 1, 0.5],
        flags: WaterQueryFlags.ComputeDepth | WaterQueryFlags.ComputeVelocity,
        timeSeconds: 0,
      }),
    ).toMatchObject({
      ok: true,
      value: { source: 'baked', depthM: 1.25, velocityMPerSec: [0.75, 0, -0.25] },
    });
    expect(system.clearBakedQueryGrid(guid('4'), snapshot.sceneGeneration)).toEqual({
      ok: true,
      value: true,
    });
    expect(system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)).toBeUndefined();
    expect(system.clearBakedQueryGrid(guid('4'), snapshot.sceneGeneration)).toEqual({
      ok: true,
      value: false,
    });
    expect(
      system.queryBody(guid('4'), {
        positionM: [0.5, 1, 0.5],
        flags: WaterQueryFlags.ComputeDepth,
        timeSeconds: 0,
      }),
    ).toMatchObject({ ok: true, value: { source: 'spline', depthM: 3 } });
    system
      .publishBakedQueryGrid(guid('4'), snapshot.sceneGeneration, {
        ...disabledBakedSource,
        enabled: true,
      })
      .unwrap();
    system.invalidate(guid('4'), ['query']);
    const nextSnapshot = system.snapshot(guid('4'));
    if (nextSnapshot === undefined) throw new Error('query fixture lost its mounted Body');
    expect(system.clearBakedQueryGrid(guid('4'), snapshot.sceneGeneration)).toMatchObject({
      ok: false,
      error: {
        code: 'stale-generation',
        detail: {
          expectedGeneration: snapshot.sceneGeneration,
          actualGeneration: nextSnapshot.sceneGeneration,
        },
      },
    });
    expect(system.clearBakedQueryGrid(guid('4'), nextSnapshot.sceneGeneration)).toEqual({
      ok: true,
      value: false,
    });
    expect(system.bakedQueryGrid(guid('4'), snapshot.sceneGeneration)).toBeDefined();
    expect(
      system.queryBody(guid('4'), {
        positionM: [0.5, 1, 0.5],
        flags: WaterQueryFlags.ComputeDepth,
        timeSeconds: 0,
      }),
    ).toMatchObject({ ok: true, value: { source: 'spline', depthM: 3 } });
    system
      .publishBakedQueryGrid(guid('4'), nextSnapshot.sceneGeneration, {
        ...disabledBakedSource,
        enabled: true,
      })
      .unwrap();
    expect(system.clearBakedQueryGrid(guid('4'), nextSnapshot.sceneGeneration)).toEqual({
      ok: true,
      value: true,
    });
    system
      .publishBakedQueryGrid(guid('4'), nextSnapshot.sceneGeneration, {
        ...disabledBakedSource,
        enabled: true,
      })
      .unwrap();
    const reloadedSnapshot = system.hotReloadBody(guid('4'), 'v2', packed.value.body).unwrap();
    expect(system.bakedQueryGrid(guid('4'), nextSnapshot.sceneGeneration)).toBeUndefined();
    expect(system.bakedQueryGrid(guid('4'), reloadedSnapshot.sceneGeneration)).toMatchObject({
      enabled: true,
      grid: disabledBakedSource.grid,
    });
    expect(
      system.queryBody(guid('4'), {
        positionM: [0.5, 1, 0.5],
        flags: WaterQueryFlags.ComputeDepth,
        timeSeconds: 0,
      }),
    ).toMatchObject({ ok: true, value: { source: 'baked' } });
    expect(system.clearBakedQueryGrid(guid('4'), reloadedSnapshot.sceneGeneration)).toEqual({
      ok: true,
      value: true,
    });
    expect(system.bakedQueryGrid(guid('4'), reloadedSnapshot.sceneGeneration)).toBeUndefined();
    expect(
      system.queryBody(guid('4'), {
        positionM: [0.5, 1, 0.5],
        flags: WaterQueryFlags.ComputeDepth,
        timeSeconds: 0,
      }),
    ).toMatchObject({ ok: true, value: { source: 'spline', depthM: 3 } });
    expect(system.clearBakedQueryGrid(guid('missing'), 1)).toMatchObject({
      ok: false,
      error: { code: 'missing-dependency' },
    });
    const deeperSource = river();
    const deeperPacked = await buildWaterPackOutputs(
      {
        body: {
          ...deeperSource,
          spline: {
            ...deeperSource.spline,
            points: deeperSource.spline.points.map((splinePoint) => ({
              ...splinePoint,
              depthM: 7,
            })),
          },
        },
      },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000497') },
    );
    expect(deeperPacked.ok).toBe(true);
    if (!deeperPacked.ok || deeperPacked.value.body?.kind !== 'water-body') return;
    system.mountBody(guid('5'), 'v1', deeperPacked.value.body).unwrap();
    const query = queryWaterBodySnapshot(snapshot, {
      positionM: [100, 5, 100],
      flags: WaterQueryFlags.ComputeDepth | WaterQueryFlags.ComputeVelocity,
      timeSeconds: 0,
    });
    expect(query.ok).toBe(true);
    if (query.ok) {
      expect(query.value.bodyGuid).toBe(guid('4'));
      expect(query.value.depthM).toBe(3);
      expect(query.value.velocityMPerSec).toEqual([2, 0, 0]);
      expect([...query.value.valid]).toEqual(['location', 'depth', 'velocity']);
      expect(query.value.adjustedFlags & WaterQueryFlags.ComputeLocation).toBeTruthy();
    }
    expect(
      queryWaterBodySnapshot(undefined, { positionM: [0, 0, 0], flags: 0, timeSeconds: 0 }),
    ).toMatchObject({ ok: false, error: { code: 'body-unregistered' } });
    expect(
      queryWaterBodySnapshot(snapshot, {
        positionM: [0, 0, 0],
        flags: WaterQueryFlags.SimpleWaves,
        timeSeconds: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-query-flags' } });
    expect(
      queryWaterBodySnapshot(snapshot, {
        positionM: [0, 0, 0],
        flags: WaterQueryFlags.IncludeWaves,
        timeSeconds: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-query-flags' } });
    expect(
      queryWaterBodySnapshot(snapshot, {
        positionM: [0, 0, 0],
        flags: WaterQueryFlags.ComputeDepth,
        timeSeconds: 0,
        expectedBodyGeneration: snapshot.sceneGeneration + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'stale-generation' } });
    expect(
      queryWaterBodySnapshot(snapshot, {
        positionM: [100, 5, 100],
        flags: WaterQueryFlags.ComputeDepth,
        timeSeconds: 0,
        splineKey: 100,
      }),
    ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
    expect(
      system.queryBody(guid('6'), { positionM: [0, 0, 0], flags: 0, timeSeconds: 0 }),
    ).toMatchObject({ ok: false, error: { code: 'body-unregistered' } });
    expect(
      system.queryBody(guid('5'), {
        positionM: [100, 5, 100],
        flags: WaterQueryFlags.ComputeDepth,
        timeSeconds: 0,
      }),
    ).toMatchObject({ ok: true, value: { bodyGuid: guid('5'), depthM: 7 } });

    const excludedSnapshot = {
      ...snapshot,
      exclusionVolumes: [
        {
          entity: 9,
          centerM: [0, 0, 0] as const,
          halfExtentsM: [1, 1, 1] as const,
          worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 5, 100, 1] as const,
        },
      ],
    };
    const excluded = queryWaterBodySnapshot(excludedSnapshot, {
      positionM: [100, 5, 100],
      flags: WaterQueryFlags.ComputeDepth | WaterQueryFlags.ComputeVelocity,
      timeSeconds: 0,
    });
    expect(excluded).toMatchObject({
      ok: true,
      value: {
        excluded: true,
        source: 'exclusion',
        locationM: [100, 5, 100],
        velocityMPerSec: [0, 0, 0],
      },
    });

    const samples = new Float32Array(3 * 3 * 4);
    for (let index = 0; index < 9; index++) samples.set([1, 2, 3, -1], index * 4);
    const bakedInput = {
      positionM: [0.5, 0, 0.5] as const,
      flags:
        WaterQueryFlags.ComputeLocation |
        WaterQueryFlags.ComputeDepth |
        WaterQueryFlags.ComputeVelocity,
      timeSeconds: 0,
      baked: {
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid: {
          originXZ: [0, 0] as const,
          originY: 10,
          spacingXZ: [1, 1] as const,
          width: 3,
          height: 3,
          samples,
        },
      },
    };
    expect(queryWaterBodySnapshot(snapshot, bakedInput)).toMatchObject({
      ok: true,
      value: { source: 'baked', locationM: [0.5, 11, 0.5], depthM: 2, velocityMPerSec: [3, 0, -1] },
    });
    expect(
      queryWaterBodySnapshot(snapshot, {
        ...bakedInput,
        baked: { ...bakedInput.baked, grid: null as never },
      }),
    ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
    expect(queryWaterBodySnapshot(snapshot, { ...bakedInput, positionM: [0, 0, 0] })).toMatchObject(
      {
        ok: true,
        value: { source: 'baked', locationM: [0, 10, 0], depthM: 0, velocityMPerSec: [0, 0, 0] },
      },
    );
  });
});
