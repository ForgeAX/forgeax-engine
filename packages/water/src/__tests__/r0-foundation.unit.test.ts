import { createBoxGeometry } from '@forgeax/engine-geometry';
import { definePack, definePackageId } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { WaterBodySourceAsset } from '../contracts.js';
import { buildWaterPackOutputs } from '../pack-cook.js';
import { buildWaterPhysicsCandidateInput } from '../physics-candidate.js';
import { requireWaterValue } from '../required-value.js';
import { WaterSystem } from '../system.js';
import {
  cookWaterAsset,
  validateWaterAsset,
  validateWaterRuntimeAsset,
  waterRiverBakeGeometryProjectionHash,
} from '../validate.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const guid = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const body = (zoneGuid?: string): WaterBodySourceAsset => ({
  kind: 'water-body',
  type: 'river',
  surfaceMaterialGuid: guid('1'),
  ...(zoneGuid ? { zoneGuid } : {}),
  spline: {
    closed: false,
    points: [0, 1].map((x) => ({
      inputKey: x,
      positionM: [x, 2, 0] as const,
      arriveTangentM: [1, 0, 0] as const,
      leaveTangentM: [1, 0, 0] as const,
      up: [0, 1, 0] as const,
      rollAngle: 0,
      angleUnit: 'degrees' as const,
      widthM: 10,
      depthM: 1,
      velocityMPerSec: 1,
      audioIntensity: 0,
    })),
  },
  baseHeightM: 0,
  overlapPriority: 0,
  maxWaveHeightM: 0,
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'river-prism', enabled: true },
  queryFootprint: [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
});
const packageId = definePackageId('019a0000-0000-7000-8000-000000000496');
async function cookedBody(source: WaterBodySourceAsset) {
  const override =
    source.type === 'custom' && source.customMeshOverrideGuid
      ? createBoxGeometry(2, 1, 2).unwrap()
      : undefined;
  const packed = await buildWaterPackOutputs(
    { body: source },
    { packageId, ...(override ? { readByGuid: async () => ok(override) } : {}) },
  );
  if (!packed.ok || packed.value.body?.kind !== 'water-body')
    throw new Error(`Water test body must Pack cook: ${JSON.stringify(packed)}`);
  return packed.value.body;
}
describe('water R0 meters and Pack lifecycle', () => {
  it('keeps native ForgeAX m/XZ/+Y values unchanged through Pack output', async () => {
    const output = (
      await buildWaterPackOutputs(
        {
          'river/main': body(),
          'zone/main': {
            kind: 'water-zone',
            extentM: { spanXM: 10, spanZM: 20 },
            tileSizeM: 5,
            tessellationFactor: 6,
            lodScale: 1,
            waterInfo: {
              resolution: { widthPx: 256, heightPx: 256 },
              format: 'rgba16f',
              blurRadius: 0,
              localTessellation: false,
            },
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000200') },
      )
    ).unwrap();
    expect(output['river/main']?.kind).toBe('water-body');
    if (output['river/main']?.kind === 'water-body') {
      expect(output['river/main'].spline.points[0]).toMatchObject({
        positionM: [0, 2, 0],
        widthM: 10,
        velocityMPerSec: 1,
      });
      expect(output['river/main'].riverSegmentMeshGuids).toHaveLength(1);
    }
    expect(output['river/main/river-segment/0']?.kind).toBe('mesh');
    expect(output['zone/main']).toMatchObject({
      kind: 'water-zone',
      extentM: { spanXM: 10, spanZM: 20 },
      tileSizeM: 5,
    });
  });
  it('resolves a Custom collision Mesh from the Pack read closure without duplicating its GUID', async () => {
    const meshGuid = guid('8');
    const mesh = createBoxGeometry(2, 1, 2).unwrap();
    const source: WaterBodySourceAsset = {
      ...body(),
      type: 'custom',
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      collision: { type: 'custom-mesh', enabled: true, meshGuid },
      customMeshOverrideGuid: meshGuid,
    };
    const cooked = await buildWaterPackOutputs(
      { 'custom/pool': source },
      {
        packageId: definePackageId('019a0000-0000-7000-8000-000000000201'),
        readByGuid: async () => ok(mesh),
      },
    );
    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    expect(cooked.value['custom/pool']).toMatchObject({
      customMeshOverrideGuid: meshGuid,
      collision: { type: 'custom-mesh', meshGuid },
    });
    expect(cooked.value['custom/pool/collision']).toBeUndefined();
    const cookedBody = cooked.value['custom/pool'];
    expect(cookedBody?.kind).toBe('water-body');
    if (cookedBody?.kind !== 'water-body') return;
    expect(cookedBody.geometrySnapshot?.collisionDescriptor?.customMesh).toMatchObject({
      meshGuid,
      vertices: expect.any(Array),
      indices: expect.any(Array),
    });
    const candidate = buildWaterPhysicsCandidateInput({
      entity: 1,
      sourceKey: 'custom/pool',
      revision: 1,
      body: cookedBody,
      bodyWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      exclusionVolumes: [],
    }).unwrap();
    expect(candidate.bodyType).toBe('static');
    expect(candidate.shapes.map((shape) => shape.kind)).toEqual(['trimesh']);
  });
  it('validates the five durable schemas and rejects non-finite values', () => {
    expect(validateWaterAsset(body()).ok).toBe(true);
    expect(
      validateWaterAsset({
        ...body(),
        spline: {
          ...body().spline,
          points: [
            { ...requireWaterValue(body().spline.points[0]), positionM: [Number.NaN, 0, 0] },
          ],
        },
      }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        ...body(),
        type: 'custom',
        flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
        customMeshOverrideGuid: guid('8'),
        collision: {
          type: 'polygon',
          enabled: true,
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
        queryFootprint: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      }).ok,
    ).toBe(true);
    expect(
      validateWaterAsset({
        ...body(),
        type: 'custom',
        flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
        collision: { type: 'none', enabled: false },
      }).ok,
    ).toBe(true);
    expect(
      validateWaterAsset({
        ...body(),
        type: 'custom',
        flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
        collision: { type: 'none', enabled: false },
      }).ok,
    ).toBe(false);
    expect(validateWaterAsset({ ...body(), spline: { ...body().spline, closed: true } }).ok).toBe(
      false,
    );
    expect(
      validateWaterAsset({ ...body(), type: 'lake', spline: { ...body().spline, closed: false } })
        .ok,
    ).toBe(false);
    expect(validateWaterAsset({ ...body(), flags: {} as never }).ok).toBe(false);
    expect(
      validateWaterAsset({ ...body(), collision: { type: 'custom-mesh', enabled: true } }).ok,
    ).toBe(false);
    const ocean = {
      ...body(),
      type: 'ocean' as const,
      oceanExtentM: [100, 80] as const,
      spline: {
        closed: true,
        points: [
          requireWaterValue(body().spline.points[0]),
          {
            ...requireWaterValue(body().spline.points[1]),
            inputKey: 1,
            positionM: [1, 2, 0] as const,
          },
          {
            ...requireWaterValue(body().spline.points[1]),
            inputKey: 2,
            positionM: [0, 2, 1] as const,
          },
        ],
      },
    };
    expect(
      validateWaterAsset({
        ...ocean,
        collision: {
          type: 'polygon',
          enabled: true,
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      }).ok,
    ).toBe(false);
    expect(validateWaterAsset({ ...ocean, collision: { type: 'none', enabled: false } }).ok).toBe(
      true,
    );
    const oceanCollider = {
      ...ocean,
      collision: {
        type: 'polygon' as const,
        enabled: true,
        collisionHalfExtentsM: [100, 80] as const,
        collisionHalfHeightM: 12,
        collisionHeightOffsetM: -4,
      },
    };
    expect(validateWaterAsset(oceanCollider).ok).toBe(true);
    expect(
      validateWaterAsset({
        ...oceanCollider,
        collision: { ...oceanCollider.collision, collisionHalfHeightM: 0 },
      }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        ...oceanCollider,
        collision: { ...oceanCollider.collision, collisionHeightOffsetM: -25 },
      }).ok,
    ).toBe(false);
    const lake = {
      ...body(),
      type: 'lake' as const,
      spline: {
        closed: true,
        points: [
          requireWaterValue(body().spline.points[0]),
          {
            ...requireWaterValue(body().spline.points[1]),
            inputKey: 1,
            positionM: [1, 2, 0] as const,
          },
          {
            ...requireWaterValue(body().spline.points[1]),
            inputKey: 2,
            positionM: [0, 2, 1] as const,
          },
        ],
      },
      collision: {
        type: 'polygon' as const,
        enabled: true,
        channelDepthM: 20,
        collisionHeightOffsetM: -4,
      },
    };
    expect(validateWaterAsset(lake).ok).toBe(true);
    expect(
      validateWaterAsset({ ...lake, collision: { ...lake.collision, channelDepthM: Number.NaN } })
        .ok,
    ).toBe(false);
    expect(
      validateWaterAsset({ ...lake, collision: { ...lake.collision, collisionHeightOffsetM: -21 } })
        .ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        ...body(),
        collision: {
          type: 'polygon',
          enabled: true,
          points: [
            [0, 0],
            [1, 0],
          ],
        },
      }).ok,
    ).toBe(false);
    expect(validateWaterAsset({ ...body(), queryFootprint: [] }).ok).toBe(false);
    expect(
      validateWaterAsset({
        ...body(),
        queryFootprint: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        ...body(),
        queryFootprint: [
          [0, 0],
          [2, 2],
          [0, 2],
          [2, 0],
        ],
      }).ok,
    ).toBe(false);
    expect(validateWaterAsset({ ...body(), maxWaveHeightM: -0.1 }).ok).toBe(false);
    expect(
      validateWaterAsset({
        ...body(),
        spline: {
          ...body().spline,
          points: body().spline.points.map((point, index) =>
            index ? point : { ...point, depthM: -1 },
          ),
        },
      }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        ...body(),
        collision: {
          type: 'polygon',
          enabled: true,
          points: [
            [0, 0],
            [2, 2],
            [0, 2],
            [2, 0],
          ],
        },
      }).ok,
    ).toBe(false);
    const waves = {
      kind: 'water-wave-set',
      waveSource: {
        kind: 'generated',
        seed: 1,
        generatorId: 'test-generator',
        generatorVersion: '1',
        generatorConfig: {},
      },
      depthMaskM: 1,
      maxWaveHeightM: 0.5,
      timeSource: 'fixed-step',
    } as const;
    expect(validateWaterAsset(waves).ok).toBe(true);
    expect(
      validateWaterAsset({ ...waves, waveSource: { ...waves.waveSource, generatorConfig: [] } }).ok,
    ).toBe(false);
    expect(validateWaterRuntimeAsset(waves).ok).toBe(false);
    expect(
      validateWaterAsset({
        kind: 'water-simulation-recipe',
        system: 'fluid-simulation',
        solverMode: 'ripple',
        terrainMode: 'terrain',
        resolution: [256, 256],
        virtualFps: 30,
        injectionLimits: { height: { encodedRange: [-1, 1], unit: 'm' } },
        materialGuids: [],
        textureGuids: [],
      }).ok,
    ).toBe(false);
    expect(cookWaterAsset(waves).ok).toBe(false);
    const cooked = cookWaterAsset(waves, {
      generateWaves: () =>
        ok([{ directionXZ: [1, 0], wavelengthM: 2, amplitudeM: 0.25, steepness: 0.5 }]),
    }).unwrap();
    expect(cooked).toMatchObject({
      kind: 'water-wave-set',
      waves: [{ wavelengthM: 2, amplitudeM: 0.25 }],
      depthMaskM: 1,
      maxWaveHeightM: 0.5,
    });
    expect(validateWaterRuntimeAsset(cooked).ok).toBe(true);
    expect(validateWaterRuntimeAsset({ ...cooked, depthMaskM: -1 }).ok).toBe(false);
    expect(validateWaterRuntimeAsset({ ...cooked, sourceSeed: undefined }).ok).toBe(false);
    expect(
      validateWaterRuntimeAsset({ ...cooked, sourceMode: 'predefined', sourceSeed: 1 }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        kind: 'water-simulation-recipe',
        system: 'water-advanced',
        enabledFeatures: ['shallow'],
        shallowStageConfig: {
          gridResolution: [64, 64],
          stageOrder: ['height'],
          materialGuids: [],
          normalRtFormat: 'rgba16f',
          surprise: true,
        },
        substepConfig: { numSteps: 2, simSpeed: 1, timeStepSource: 'fixed-step' },
        materialGuids: [],
        textureGuids: [],
      }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        kind: 'water-simulation-recipe',
        system: 'water-advanced',
        enabledFeatures: ['shallow'],
        shallowStageConfig: {
          gridResolution: [64, 64],
          stageOrder: ['height'],
          materialGuids: [],
          normalRtFormat: 'rgba16f',
        },
        substepConfig: { numSteps: 0, simSpeed: 1, timeStepSource: 'fixed-step' },
        materialGuids: [],
        textureGuids: [],
      }).ok,
    ).toBe(false);
    const island = {
      kind: 'island',
      actorId: 'island/one',
      sourceKey: 'island/one',
      spline: {
        closed: true,
        points: [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ].map(([x, z], inputKey) => ({
          inputKey,
          positionM: [x, 0, z],
          arriveTangentM: [1, 0, 0],
          leaveTangentM: [1, 0, 0],
          up: [0, 1, 0],
          rollAngle: 0,
          angleUnit: 'degrees',
          widthM: 0,
          depthM: 0,
          velocityMPerSec: 0,
          audioIntensity: 0,
        })),
      },
      terrainRules: { falloffWidthM: 1, heightOffsetM: 0, weightLayer: 'land', weightValue: 1 },
    };
    const brush = {
      kind: 'water-brush-recipe',
      baseTerrainGuid: guid('1'),
      sourceBodyGuids: [],
      orderedActors: [island],
      curves: [],
      textures: [],
      outputTerrainSourceKey: 'terrain/out',
      terrainCapture: {
        worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        boundsXZ: { minM: [-0.5, -0.5], maxM: [7.5, 7.5] },
        resolutionPx: [8, 8],
        layerNameToIndex: { land: 0 },
      },
      rules: {
        falloff: { type: 'linear', widthM: 1, strength: 1 },
        blend: { type: 'alpha', alpha: 0.5 },
        heightRules: { mode: 'offset', offsetM: 0, velocityMPerSec: 0 },
        weightRules: { layer: 'land', value: 1, blend: 'add' },
      },
    };
    expect(validateWaterAsset(brush).ok).toBe(true);
    expect(
      validateWaterAsset({
        ...brush,
        orderedActors: [{ ...island, spline: { ...island.spline, closed: false } }],
      }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        ...brush,
        orderedActors: [
          {
            ...island,
            spline: {
              ...island.spline,
              points: [0, 0, 0, 0].map((_, i) =>
                requireWaterValue(island.spline.points[requireWaterValue([0, 2, 1, 3][i])]),
              ),
            },
          },
        ],
      }).ok,
    ).toBe(false);
    const mutablePoints = body().spline.points.map((point) => ({
      ...point,
      positionM: [...point.positionM] as [number, number, number],
    }));
    const shallowFrozenSource = Object.freeze({
      ...body(),
      spline: { closed: false, points: mutablePoints },
    });
    const frozenOutput = cookWaterAsset(shallowFrozenSource).unwrap();
    if (frozenOutput.kind === 'water-body') {
      expect(Object.isFrozen(frozenOutput.spline.points)).toBe(true);
      expect(Object.isFrozen(frozenOutput.spline.points[0]?.positionM)).toBe(true);
      requireWaterValue(mutablePoints[0]).positionM[0] = 99;
      expect(frozenOutput.spline.points[0]?.positionM[0]).toBe(0);
    }
    expect(
      validateWaterAsset({
        ...body(),
        spline: {
          ...body().spline,
          points: [{ ...requireWaterValue(body().spline.points[0]), alternatePosition: [0, 0, 0] }],
        },
      }).ok,
    ).toBe(false);
  });
  it('keeps a valid snapshot on failed replacement and invalidates old Zone indices on generation change', async () => {
    let liveZone:
      | {
          generation: number;
        }
      | undefined;
    const zoneGuid = guid('5');
    const system = new WaterSystem((candidateGuid) =>
      candidateGuid === zoneGuid ? liveZone : undefined,
    );
    system.mountBody(guid('4'), 'v1', await cookedBody(body(zoneGuid))).unwrap();
    liveZone = { generation: 1 };
    system.bindZoneIndex(guid('4'), zoneGuid, 1, 7).unwrap();
    system.clearDirty(guid('4'), ['geometry', 'collision']);
    expect([...requireWaterValue(system.snapshot(guid('4'))).dirty]).not.toContain('geometry');
    system.mountBody(guid('4'), 'v2', await cookedBody(body(zoneGuid))).unwrap();
    expect(system.zoneIndex(guid('4'), zoneGuid, 1)).toBeUndefined();
    expect(system.snapshot(guid('4'))?.dirty.has('geometry')).toBe(true);
    system.bindZoneIndex(guid('4'), zoneGuid, 1, 9).unwrap();
    const source = body(zoneGuid);
    const accepted = system.mountBody(guid('7'), 'v1', await cookedBody(source)).unwrap();
    (requireWaterValue(source.spline.points[0]).positionM as number[])[0] = 99;
    expect(requireWaterValue(accepted.asset.spline.points[0]).positionM[0]).toBe(0);
    expect(system.zoneIndex(guid('4'), zoneGuid, 1)).toBe(9);
    const failed = system.hotReloadBody(guid('4'), 'v2', {
      ...body(zoneGuid),
      baseHeightM: Number.NaN,
    });
    expect(failed.ok).toBe(false);
    expect(system.snapshot(guid('4'))?.sourceVersion).toBe('v2');
  });
  it('allows hot reload to make the initial Body admission when no Bake exists', async () => {
    const system = new WaterSystem(() => undefined);
    expect(system.snapshot(guid('3'))).toBeUndefined();
    const admitted = system
      .hotReloadBody(guid('3'), 'v1', await cookedBody(body()), guid('3'))
      .unwrap();
    expect(admitted.sourceVersion).toBe('v1');
    expect(admitted.sceneGeneration).toBeGreaterThan(0);
  });
  it('preserves versioned spline interpolation when mounting a cooked Body', async () => {
    const source: WaterBodySourceAsset = {
      ...body(),
      spline: {
        ...body().spline,
        interpolationVersion: 'water-spline/2',
        points: body().spline.points.map((point) => ({
          ...point,
          rotationQuat: [0, 0, 0, 1] as const,
          arriveRotationQuat: [0, 0, 0, 1] as const,
          leaveRotationQuat: [0, 0, 0, 1] as const,
        })),
      },
    };
    const cooked = await cookedBody(source);
    const mutableBody = {
      ...cooked,
      spline: {
        ...cooked.spline,
        points: cooked.spline.points.map((point) => ({
          ...point,
          rotationQuat: [...requireWaterValue(point.rotationQuat)] as [
            number,
            number,
            number,
            number,
          ],
          arriveRotationQuat: [...requireWaterValue(point.arriveRotationQuat)] as [
            number,
            number,
            number,
            number,
          ],
          leaveRotationQuat: [...requireWaterValue(point.leaveRotationQuat)] as [
            number,
            number,
            number,
            number,
          ],
        })),
      },
    };
    const system = new WaterSystem(() => undefined);
    const mounted = system.mountBody(guid('6'), 'v1', mutableBody).unwrap();
    (requireWaterValue(mutableBody.spline.points[0]).rotationQuat as number[])[0] = 1;
    (requireWaterValue(mutableBody.spline.points[0]).arriveRotationQuat as number[])[0] = 1;
    (requireWaterValue(mutableBody.spline.points[0]).leaveRotationQuat as number[])[0] = 1;
    expect(mounted.asset.spline.interpolationVersion).toBe('water-spline/2');
    expect(mounted.asset.spline.points[0]?.rotationQuat).toEqual([0, 0, 0, 1]);
    expect(mounted.asset.spline.points[0]?.arriveRotationQuat).toEqual([0, 0, 0, 1]);
    expect(mounted.asset.spline.points[0]?.leaveRotationQuat).toEqual([0, 0, 0, 1]);
    expect(Object.isFrozen(mounted.asset.spline.points[0]?.rotationQuat)).toBe(true);
    expect(Object.isFrozen(mounted.asset.spline.points[0]?.arriveRotationQuat)).toBe(true);
    expect(Object.isFrozen(mounted.asset.spline.points[0]?.leaveRotationQuat)).toBe(true);
    expect(validateWaterAsset(mounted.asset).ok).toBe(true);
    expect(
      buildWaterPhysicsCandidateInput({
        entity: 6,
        sourceKey: 'water:6',
        revision: mounted.outputGenerations.collision,
        body: mounted.asset,
        bodyWorldMatrixM: mounted.worldMatrixM,
        exclusionVolumes: mounted.exclusionVolumes,
      }).ok,
    ).toBe(true);
  });
  it('invalidates only outputs affected by hot-reloaded Body fields and retains accepted state on failure', async () => {
    const zoneGuid = guid('7');
    const system = new WaterSystem((candidate) =>
      candidate === zoneGuid ? { generation: 1 } : undefined,
    );
    const accepted = system.mountBody(guid('9'), 'v1', await cookedBody(body(zoneGuid))).unwrap();
    expect(accepted.outputs).toEqual({
      geometry: 'unsupported',
      waterInfo: 'unsupported',
      waterMesh: 'unsupported',
      terrainBrush: 'not-requested',
      collision: 'unsupported',
      query: 'unsupported',
      material: 'unsupported',
    });
    system.bindZoneIndex(guid('9'), zoneGuid, 1, 13).unwrap();
    system.clearDirty(guid('9'), [
      'geometry',
      'waterInfo',
      'waterMesh',
      'terrainBrush',
      'collision',
      'query',
      'material',
    ]);
    const materialReload = system
      .hotReloadBody(
        guid('9'),
        'v2',
        await cookedBody({ ...body(zoneGuid), surfaceMaterialGuid: guid('2') }),
      )
      .unwrap();
    expect([...materialReload.dirty]).toEqual(['waterMesh', 'material']);
    expect(materialReload.outputs.material).toBe('unsupported');
    expect(system.zoneIndex(guid('9'), zoneGuid, 1)).toBe(13);
    system.clearDirty(guid('9'), ['material', 'waterMesh']);
    const shapeReload = system
      .hotReloadBody(
        guid('9'),
        'v3',
        await cookedBody({
          ...body(zoneGuid),
          surfaceMaterialGuid: guid('2'),
          spline: {
            ...body().spline,
            points: body().spline.points.map((point) => ({ ...point, widthM: point.widthM + 2 })),
          },
        }),
      )
      .unwrap();
    expect([...shapeReload.dirty]).toEqual([
      'geometry',
      'query',
      'waterInfo',
      'waterMesh',
      'collision',
    ]);
    const custom = (participates: boolean) => ({
      ...body(),
      type: 'custom' as const,
      ...(participates ? { customMeshOverrideGuid: guid('9') } : {}),
      flags: {
        affectsWaterInfo: participates,
        affectsWaterMesh: participates,
        affectsLandscape: false,
      },
      collision: { type: 'none' as const, enabled: false },
    });
    const customSystem = new WaterSystem(() => undefined);
    customSystem.mountBody(guid('8'), 'v1', await cookedBody(custom(false))).unwrap();
    customSystem.clearDirty(guid('8'), [
      'geometry',
      'waterInfo',
      'waterMesh',
      'terrainBrush',
      'collision',
      'query',
      'material',
    ]);
    const participationReload = customSystem
      .hotReloadBody(guid('8'), 'v2', await cookedBody(custom(true)))
      .unwrap();
    expect([...participationReload.dirty]).toEqual(['waterInfo', 'waterMesh']);
    expect(participationReload.outputs).toEqual({
      geometry: 'unsupported',
      waterInfo: 'zone-unbound',
      waterMesh: 'zone-unbound',
      terrainBrush: 'not-requested',
      collision: 'not-requested',
      query: 'unsupported',
      material: 'unsupported',
    });
    const dirtyBeforeFailure = [...participationReload.dirty];
    const failed = customSystem.hotReloadBody(guid('8'), 'v3', {
      ...custom(true),
      baseHeightM: Number.NaN,
    });
    expect(failed.ok).toBe(false);
    const afterFailure = requireWaterValue(customSystem.snapshot(guid('8')));
    expect(afterFailure.sourceVersion).toBe('v2');
    expect(afterFailure.asset).toBe(participationReload.asset);
    expect([...afterFailure.dirty]).toEqual(dirtyBeforeFailure);
    expect(system.snapshot(guid('9'))?.sourceVersion).toBe('v3');
    expect(accepted.sourceVersion).toBe('v1');
  });
  it('clears exclusion snapshots and dirties queries when a body association or transform changes', async () => {
    const water = new WaterSystem(() => undefined);
    water.mountBody(guid('9'), '1', await cookedBody(body()), guid('9')).unwrap();
    const exclusion = {
      entity: 3,
      centerM: [1, 0, 0] as const,
      halfExtentsM: [2, 1, 2] as const,
      worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1],
    };
    water.setExclusionVolumes(guid('9'), [exclusion]).unwrap();
    water.clearDirty(guid('9'), [
      'geometry',
      'waterInfo',
      'waterMesh',
      'terrainBrush',
      'collision',
      'query',
      'material',
    ]);
    const movedReload = water
      .hotReloadBody(
        guid('9'),
        '2',
        await cookedBody(body()),
        guid('9'),
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 8, 0, 0, 1],
      )
      .unwrap();
    expect(movedReload.exclusionVolumes).toEqual([]);
    expect(movedReload.dirty.has('query')).toBe(true);
    water.setExclusionVolumes(guid('9'), [exclusion]).unwrap();
    water.clearDirty(guid('9'), ['query']);
    water
      .updateInstanceTransform(guid('9'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 0, 0, 1])
      .unwrap();
    expect(water.snapshot(guid('9'))?.exclusionVolumes).toEqual([]);
    expect(water.snapshot(guid('9'))?.dirty.has('query')).toBe(true);
    water.setExclusionVolumes(guid('9'), [exclusion]).unwrap();
    water.clearDirty(guid('9'), ['query']);
    expect(water.setExclusionVolumes(guid('9'), []).unwrap()).toBe(true);
    expect(water.snapshot(guid('9'))?.exclusionVolumes).toEqual([]);
    expect(water.snapshot(guid('9'))?.dirty.has('query')).toBe(true);
  });
  it('rebinds a normal-only Bake revision without staging another Native collision candidate', async () => {
    const system = new WaterSystem(() => undefined);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    const guidValue = guid('6');
    const mounted = system
      .mountBody(guidValue, 'v1', await cookedBody(body()), guidValue, identity)
      .unwrap();
    const geometryHash = waterRiverBakeGeometryProjectionHash(mounted.asset);
    expect(geometryHash).toMatch(/^[0-9a-f]{64}$/);
    if (!geometryHash) throw new Error('Expected a valid River Bake geometry projection hash');
    const grid = {
      width: 3,
      height: 3,
      originXZ: [0, 0] as const,
      originY: 0,
      spacingXZ: [1, 1] as const,
      samples: new Float32Array(36),
      lineage: {
        version: 'water-river-bake/2' as const,
        textureGuid: guid('7'),
        textureRevision: 8,
        normalTextureGuid: guid('8'),
        normalTextureRevision: 9,
        normalTextureFormat: 'rgba16float' as const,
        normalBasis: 'lattice-axis0-axis1-up/1' as const,
        sourceRecipeGuid: guid('9'),
        sourceRecipeVersion: 'sha256:river-bake-recipe',
        sourceBodyGuid: mounted.sourceAssetGuid,
        sourceBodyGeneration: mounted.sceneGeneration,
        simulationGeneration: 2,
        sequence: 3,
        frameId: 4,
        deviceGeneration: 5,
        graphGeneration: 6,
        sourceWorldMatrixM: identity,
        sourceGeometryProjectionHash: geometryHash,
        sourceFrame: { generation: 2, sequence: 3, step: 4, timeSeconds: 1.5 },
      },
    };
    system
      .publishBakedQueryGrid(guidValue, mounted.sceneGeneration, {
        kind: 'durable-pack',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid,
      })
      .unwrap();
    const outputGeneration = system.bakedQueryGridCandidateOutputGeneration(
      guidValue,
      mounted.sceneGeneration,
    );
    expect(outputGeneration).toBeDefined();
    if (outputGeneration === undefined) throw new Error('Expected a staged River Bake candidate');
    system
      .markBakedQueryGridCandidateQueued(guidValue, mounted.sceneGeneration, outputGeneration)
      .unwrap();
    system
      .markBakedQueryGridCandidateAdmitting(guidValue, mounted.sceneGeneration, outputGeneration)
      .unwrap();
    system
      .acceptBakedQueryGrid(guidValue, mounted.sceneGeneration, outputGeneration, {
        generation: 3,
        digest: 'sha256:native-river-bake',
      })
      .unwrap();
    const accepted = requireWaterValue(system.snapshot(guidValue));
    const collisionReceipt = accepted.outputReceipts.collision;
    const bakeRevision = system.bakedQueryRevision;
    expect(collisionReceipt).toBeDefined();

    system
      .publishBakedQueryGrid(guidValue, mounted.sceneGeneration, {
        kind: 'durable-pack',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid: {
          ...grid,
          lineage: { ...grid.lineage, normalTextureRevision: 10 },
        },
      })
      .unwrap();

    expect(
      system.bakedQueryGridCandidateOutputGeneration(guidValue, mounted.sceneGeneration),
    ).toBeUndefined();
    expect(system.bakedQueryGrid(guidValue, mounted.sceneGeneration)?.grid.lineage).toMatchObject({
      normalTextureGuid: guid('8'),
      normalTextureRevision: 10,
      normalBasis: 'lattice-axis0-axis1-up/1',
    });
    expect(system.bakedQueryRevision).toBe(bakeRevision + 1);
    expect(system.snapshot(guidValue)?.outputReceipts.collision).toEqual(collisionReceipt);
  });

  it('protects Native-attached River mutation ingress and permits only receipt-safe rebinds', async () => {
    const system = new WaterSystem(() => undefined);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] as const;
    const initial = system
      .mountBody(guid('6'), 'v1', await cookedBody(body()), guid('6'), identity, undefined, 6)
      .unwrap();
    system
      .publishBakedQueryGrid(guid('6'), initial.sceneGeneration, {
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
    const bakeGeneration = system.bakedQueryGridCandidateOutputGeneration(
      guid('6'),
      initial.sceneGeneration,
    );
    expect(bakeGeneration).toBeDefined();
    system
      .markBakedQueryGridCandidateQueued(
        guid('6'),
        initial.sceneGeneration,
        requiredFixtureValue(bakeGeneration),
      )
      .unwrap();
    system
      .markBakedQueryGridCandidateAdmitting(
        guid('6'),
        initial.sceneGeneration,
        requiredFixtureValue(bakeGeneration),
      )
      .unwrap();
    system
      .acceptBakedQueryGrid(
        guid('6'),
        initial.sceneGeneration,
        requiredFixtureValue(bakeGeneration),
        {
          generation: 3,
          digest: 'sha256:native-river-bake',
        },
      )
      .unwrap();
    const accepted = requireWaterValue(system.snapshot(guid('6')));
    const bakedBeforeRebind = system.bakedQueryGrid(guid('6'), accepted.sceneGeneration);
    const collisionBeforeRebind = accepted.outputReceipts.collision;
    expect(bakedBeforeRebind).toBeDefined();
    expect(collisionBeforeRebind).toBeDefined();

    const rebound = system
      .hotReloadBody(
        guid('6'),
        'v2',
        await cookedBody({ ...body(), surfaceMaterialGuid: guid('2') }),
        guid('6'),
        identity,
      )
      .unwrap();
    expect(rebound.sourceVersion).toBe('v2');
    expect(rebound.dirty.has('collision')).toBe(false);
    expect(rebound.outputReceipts.collision).toMatchObject({
      sourceVersion: 'v2',
      sceneGeneration: rebound.sceneGeneration,
      outputGeneration: collisionBeforeRebind?.outputGeneration,
      consumerGeneration: collisionBeforeRebind?.consumerGeneration,
      digest: collisionBeforeRebind?.digest,
    });
    expect(system.bakedQueryGrid(guid('6'), rebound.sceneGeneration)?.grid.samples).toEqual(
      bakedBeforeRebind?.grid.samples,
    );

    const beforeRejectedChanges = requireWaterValue(system.snapshot(guid('6')));
    expect(system.updateInstanceTransform(guid('6'), moved)).toMatchObject({
      ok: false,
      error: { code: 'query-data-unavailable' },
    });
    const changedGeometry = await cookedBody({
      ...body(),
      spline: {
        ...body().spline,
        points: body().spline.points.map((point) => ({ ...point, widthM: point.widthM + 1 })),
      },
    });
    expect(
      system.hotReloadBody(guid('6'), 'v3', changedGeometry, guid('6'), identity),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-source' },
    });
    expect(system.snapshot(guid('6'))).toMatchObject({
      sourceVersion: beforeRejectedChanges.sourceVersion,
      sceneGeneration: beforeRejectedChanges.sceneGeneration,
      worldMatrixM: identity,
    });

    system.stageRiverTransform(guid('6'), moved, [], rebound.dependencies).unwrap();
    const staged = requireWaterValue(system.sceneCandidateSnapshot(guid('6')));
    expect(system.sceneCandidateRequiresBakedGrid(guid('6'), staged.sceneGeneration)).toBe(true);
    expect(system.bakedQueryGrid(guid('6'), rebound.sceneGeneration)?.grid.samples).toEqual(
      bakedBeforeRebind?.grid.samples,
    );
    expect(system.hotReloadBody(guid('6'), 'v3', rebound.asset, guid('6'), identity)).toMatchObject(
      {
        ok: false,
        error: { code: 'query-data-unavailable' },
      },
    );
    expect(system.updateInstanceTransform(guid('6'), moved)).toMatchObject({
      ok: false,
      error: { code: 'query-data-unavailable' },
    });
    expect(system.sceneCandidateSnapshot(guid('6'))?.sceneGeneration).toBe(staged.sceneGeneration);
    expect(system.snapshot(guid('6'))?.sceneGeneration).toBe(beforeRejectedChanges.sceneGeneration);

    const collisionDisabled = await cookedBody({
      ...body(),
      collision: { type: 'river-prism', enabled: false },
    });
    const stagedQueryOnly = system
      .stageRiverReload(
        guid('6'),
        'v3-query-only',
        collisionDisabled,
        guid('6'),
        moved,
        [],
        rebound.dependencies,
      )
      .unwrap();
    expect(stagedQueryOnly.asset.collision.enabled).toBe(false);
    expect(system.sceneCandidateRequiresBakedGrid(guid('6'), stagedQueryOnly.sceneGeneration)).toBe(
      true,
    );
    expect(system.bakedQueryGrid(guid('6'), rebound.sceneGeneration)?.grid.samples).toEqual(
      bakedBeforeRebind?.grid.samples,
    );

    expect(system.clearBakedQueryGrid(guid('6'), stagedQueryOnly.sceneGeneration)).toEqual({
      ok: true,
      value: true,
    });
    expect(system.sceneCandidateRequiresBakedGrid(guid('6'), stagedQueryOnly.sceneGeneration)).toBe(
      false,
    );
    expect(system.bakedQueryGrid(guid('6'), rebound.sceneGeneration)?.grid.samples).toEqual(
      bakedBeforeRebind?.grid.samples,
    );
    const stagedBakeGeneration = system.bakedQueryGridCandidateOutputGeneration(
      guid('6'),
      stagedQueryOnly.sceneGeneration,
    );
    expect(stagedBakeGeneration).toBeDefined();
    system
      .markBakedQueryGridCandidateQueued(
        guid('6'),
        stagedQueryOnly.sceneGeneration,
        requiredFixtureValue(stagedBakeGeneration),
      )
      .unwrap();
    system
      .markBakedQueryGridCandidateAdmitting(
        guid('6'),
        stagedQueryOnly.sceneGeneration,
        requiredFixtureValue(stagedBakeGeneration),
      )
      .unwrap();
    system
      .acceptRiverSceneCandidate(
        guid('6'),
        stagedQueryOnly.sceneGeneration,
        requiredFixtureValue(stagedBakeGeneration),
        {
          generation: 4,
          digest: 'sha256-cleared-river-bake',
        },
      )
      .unwrap();
    expect(system.snapshot(guid('6'))?.sceneGeneration).toBe(stagedQueryOnly.sceneGeneration);
    expect(system.hasBakedQueryGrid(guid('6'), stagedQueryOnly.sceneGeneration)).toBe(false);

    const cpuOnly = new WaterSystem(() => undefined);
    cpuOnly.mountBody(guid('7'), 'v1', await cookedBody(body()), guid('7')).unwrap();
    expect(cpuOnly.updateInstanceTransform(guid('7'), moved).ok).toBe(true);
  });
  it('checks transformed exclusions in all three dimensions without a Physics collision receipt', async () => {
    const water = new WaterSystem(() => undefined);
    const noCollision = { ...body(), collision: { type: 'none' as const, enabled: false } };
    water.mountBody(guid('9'), '1', await cookedBody(noCollision), guid('9')).unwrap();
    water
      .setExclusionVolumes(guid('9'), [
        {
          entity: 5,
          centerM: [1, 0, 0],
          halfExtentsM: [2, 1, 2],
          worldMatrixM: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 4, 0, 0, 1],
        },
      ])
      .unwrap();
    expect(water.isPointExcluded(guid('9'), [6, 0, 0])).toBe(true);
    expect(water.isPointExcluded(guid('9'), [6, 1.01, 0])).toBe(false);
    expect(water.isPointExcluded(guid('9'), [10.1, 0, 0])).toBe(false);
  });
  it('routes optional Water fields to only their affected output categories', async () => {
    const system = new WaterSystem(() => undefined);
    let version = 0;
    const river = body();
    let current: WaterBodySourceAsset = {
      ...river,
      type: 'ocean' as const,
      oceanExtentM: [20, 20] as const,
      heightOffsetM: 0,
      spline: {
        closed: true,
        points: [
          {
            ...requireWaterValue(river.spline.points[0]),
            inputKey: 0,
            positionM: [0, 2, 0] as const,
          },
          {
            ...requireWaterValue(river.spline.points[1]),
            inputKey: 1,
            positionM: [2, 2, 0] as const,
          },
          {
            ...requireWaterValue(river.spline.points[1]),
            inputKey: 2,
            positionM: [2, 2, 2] as const,
          },
          {
            ...requireWaterValue(river.spline.points[0]),
            inputKey: 3,
            positionM: [0, 2, 2] as const,
          },
        ],
      },
      collision: { type: 'none' as const, enabled: false },
    };
    system.mountBody(guid('4'), String(version), await cookedBody(current)).unwrap();
    const landscapeSystem = new WaterSystem(() => undefined);
    const landscapeBody = { ...current, flags: { ...current.flags, affectsLandscape: true } };
    landscapeSystem.mountBody(guid('5'), 'v1', await cookedBody(landscapeBody)).unwrap();
    landscapeSystem.clearDirty(guid('5'), [
      'geometry',
      'waterInfo',
      'waterMesh',
      'terrainBrush',
      'collision',
      'query',
      'material',
    ]);
    const dilationReload = landscapeSystem
      .hotReloadBody(
        guid('5'),
        'dilation',
        await cookedBody({ ...landscapeBody, shapeDilationM: 12.5 }),
      )
      .unwrap();
    expect([...dilationReload.dirty].sort()).toEqual(['geometry', 'terrainBrush', 'waterInfo']);
    const cases = [
      [{ ...current, heightOffsetM: 0.25 }, ['waterInfo', 'waterMesh', 'query']],
      [
        {
          ...current,
          heightOffsetM: 0.25,
          waveBounds: { minimumM: -1, maximumM: 1, edgeBlendWidthM: 0.2 },
        },
        ['waterInfo', 'waterMesh', 'query'],
      ],
      [
        {
          ...current,
          heightOffsetM: 0.25,
          waveBounds: { minimumM: -1, maximumM: 1, edgeBlendWidthM: 0.2 },
          waveSetGuid: guid('3'),
        },
        ['waterInfo', 'waterMesh', 'query'],
      ],
      [
        {
          ...current,
          heightOffsetM: 0.25,
          waveBounds: { minimumM: -1, maximumM: 1, edgeBlendWidthM: 0.2 },
          waveSetGuid: guid('3'),
          waterInfoMaterialGuid: guid('2'),
        },
        ['material', 'waterInfo'],
      ],
      [
        {
          ...current,
          heightOffsetM: 0.25,
          waveBounds: { minimumM: -1, maximumM: 1, edgeBlendWidthM: 0.2 },
          waveSetGuid: guid('3'),
          waterInfoMaterialGuid: guid('2'),
          surfaceMaterialGuid: guid('5'),
        },
        ['material', 'waterMesh'],
      ],
      [
        {
          ...current,
          heightOffsetM: 0.25,
          waveBounds: { minimumM: -1, maximumM: 1, edgeBlendWidthM: 0.2 },
          waveSetGuid: guid('3'),
          waterInfoMaterialGuid: guid('2'),
          surfaceMaterialGuid: guid('5'),
          underwaterPostProcessMaterialGuid: guid('6'),
        },
        ['material'],
      ],
    ] as const;
    for (const [candidate, expected] of cases) {
      system.clearDirty(guid('4'), [
        'geometry',
        'waterInfo',
        'waterMesh',
        'terrainBrush',
        'collision',
        'query',
        'material',
      ]);
      const next = system
        .hotReloadBody(guid('4'), String(++version), await cookedBody(candidate))
        .unwrap();
      expect([...next.dirty].sort()).toEqual([...expected].sort());
      current = candidate;
    }
  });
  it('keeps collision output generations stable across unrelated and visible-only updates', async () => {
    const system = new WaterSystem(() => undefined);
    const source = {
      ...body(),
      type: 'ocean' as const,
      oceanExtentM: [100, 80] as const,
      collision: {
        type: 'polygon' as const,
        enabled: true,
        collisionHalfHeightM: 12,
        collisionHalfExtentsM: [40, 30] as const,
      },
      spline: {
        closed: true,
        points: [
          {
            ...requireWaterValue(body().spline.points[0]),
            positionM: [0, 0, 0] as const,
            arriveTangentM: [0, 0, 0] as const,
            leaveTangentM: [0, 0, 0] as const,
          },
          {
            ...requireWaterValue(body().spline.points[1]),
            inputKey: 1,
            positionM: [2, 0, 0] as const,
            arriveTangentM: [0, 0, 0] as const,
            leaveTangentM: [0, 0, 0] as const,
          },
          {
            ...requireWaterValue(body().spline.points[1]),
            inputKey: 2,
            positionM: [2, 0, 2] as const,
            arriveTangentM: [0, 0, 0] as const,
            leaveTangentM: [0, 0, 0] as const,
          },
          {
            ...requireWaterValue(body().spline.points[1]),
            inputKey: 3,
            positionM: [0, 0, 2] as const,
            arriveTangentM: [0, 0, 0] as const,
            leaveTangentM: [0, 0, 0] as const,
          },
        ],
      },
    };
    const mounted = system.mountBody(guid('4'), 'v1', await cookedBody(source)).unwrap();
    const collisionGeneration = mounted.outputGenerations.collision;
    system.clearDirty(guid('4'), [
      'geometry',
      'waterInfo',
      'waterMesh',
      'terrainBrush',
      'query',
      'material',
    ]);
    const materialReload = system
      .hotReloadBody(
        guid('4'),
        'v2',
        await cookedBody({ ...source, surfaceMaterialGuid: guid('2') }),
      )
      .unwrap();
    expect(materialReload.outputGenerations.collision).toBe(collisionGeneration);
    expect(materialReload.dirty.has('collision')).toBe(true);
    system.clearDirty(guid('4'), ['collision', 'material', 'waterMesh']);
    const visibleExtentReload = system
      .hotReloadBody(guid('4'), 'v3', await cookedBody({ ...source, oceanExtentM: [120, 80] }))
      .unwrap();
    expect(visibleExtentReload.outputGenerations.collision).toBe(collisionGeneration);
    expect(visibleExtentReload.outputGenerations.query).toBeGreaterThan(
      materialReload.outputGenerations.query,
    );
  });
  it('reports declared material slots, reference states and the unsupported water ABI', async () => {
    const source = {
      ...body(),
      riverToLakeTransitionMaterialGuid: guid('2'),
      waterInfoMaterialGuid: guid('3'),
    };
    const system = new WaterSystem(() => undefined);
    system.mountBody(guid('4'), 'v1', await cookedBody(source)).unwrap();
    const statuses = system.materialStatuses(guid('4'), (materialGuid) =>
      materialGuid === guid('1')
        ? {
            kind: 'valid',
            asset: { surface: { model: 'single-layer-medium' }, passes: [{ name: 'color' }] },
          }
        : materialGuid === guid('2')
          ? { kind: 'unavailable' }
          : { kind: 'invalid-kind' },
    );
    expect(statuses).toMatchObject([
      {
        slot: 'surface',
        guid: guid('1'),
        reference: 'valid',
        material: { form: 'root', surfaceModel: 'single-layer-medium', passes: ['color'] },
        waterAbi: 'unsupported',
        missingAbi: ['surface'],
      },
      {
        slot: 'river-to-lake-transition',
        guid: guid('2'),
        reference: 'unavailable',
        waterAbi: 'unsupported',
      },
      { slot: 'water-info', guid: guid('3'), reference: 'invalid-kind', waterAbi: 'unsupported' },
    ]);
  });
  it('marks only participating outputs dirty for Custom bodies on mount and transform changes', async () => {
    const system = new WaterSystem(() => undefined);
    const custom = (participates: boolean, customMeshOverrideGuid?: string) => ({
      ...body(),
      type: 'custom' as const,
      flags: {
        affectsWaterInfo: participates,
        affectsWaterMesh: participates,
        affectsLandscape: false,
      },
      collision: { type: 'none' as const, enabled: false },
      ...(customMeshOverrideGuid === undefined ? {} : { customMeshOverrideGuid }),
    });
    const defaultCustom = system
      .mountBody(guid('6'), 'v1', await cookedBody(custom(false)))
      .unwrap();
    expect([...defaultCustom.dirty]).toEqual(['geometry', 'query', 'material']);
    system.clearDirty(guid('6'), [...defaultCustom.dirty]);
    system
      .updateInstanceTransform(guid('6'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1])
      .unwrap();
    expect([...requireWaterValue(system.snapshot(guid('6'))).dirty]).toEqual(['geometry', 'query']);
    const overrideGuid = AssetGuid.format(AssetGuid.derive(packageId, 'custom/override'));
    const overrideMesh = createBoxGeometry(2, 1, 2).unwrap();
    const cookedOptedIn = await buildWaterPackOutputs(
      { body: custom(true, overrideGuid) },
      {
        packageId,
        readByGuid: async () => ({ ok: true as const, value: overrideMesh }),
      },
    );
    if (!cookedOptedIn.ok || cookedOptedIn.value.body?.kind !== 'water-body')
      throw new Error('Opted-in Custom test body must Pack cook with its override mesh');
    const optedIn = system.mountBody(guid('7'), 'v1', cookedOptedIn.value.body).unwrap();
    expect([...optedIn.dirty]).toEqual(['geometry', 'query', 'waterInfo', 'waterMesh', 'material']);
  });
  it('keeps accepted snapshot payloads and dirty views immutable', async () => {
    const source = {
      ...body(),
      underwaterSettings: { enabled: true, priority: 2, maxDepthM: 8 },
      geometryCook: { splineToleranceM: 0.1, collisionToleranceM: 0.2 },
      renderOptions: { castShadow: true, receiveShadow: true, visible: true },
      waveBounds: { minimumM: -1, maximumM: 1, edgeBlendWidthM: 0.5 },
    };
    const system = new WaterSystem(() => undefined);
    const snapshot = system.mountBody(guid('4'), 'v1', await cookedBody(source)).unwrap();
    expect(Object.isFrozen(snapshot.asset.underwaterSettings)).toBe(true);
    expect(Object.isFrozen(snapshot.asset.geometryCook)).toBe(true);
    expect(Object.isFrozen(snapshot.asset.renderOptions)).toBe(true);
    expect(Object.isFrozen(snapshot.asset.waveBounds)).toBe(true);
    expect(() => (snapshot.dirty as Set<string>).clear()).toThrow();
    snapshot.dirty.forEach((_value, _value2, view) => {
      expect(view).not.toHaveProperty('add');
      expect(view).not.toHaveProperty('delete');
    });
    expect(system.snapshot(guid('4'))?.dirty.size).toBeGreaterThan(0);
  });
  it('retains fixed CPU snapshot generations across reload and unmount', async () => {
    const system = new WaterSystem(() => undefined);
    system.mountBody(guid('4'), 'v1', await cookedBody({ ...body(), baseHeightM: 1 })).unwrap();
    const admitted = system.admitSnapshot(guid('4')).unwrap();
    const retained = system.retainSnapshot(admitted).unwrap();
    const oldGeneration = admitted.snapshot.sceneGeneration;
    expect(system.snapshotLeaseCount(guid('4'), oldGeneration)).toBe(2);
    system.hotReloadBody(guid('4'), 'v2', await cookedBody({ ...body(), baseHeightM: 2 })).unwrap();
    const current = system.admitSnapshot(guid('4')).unwrap();
    expect(current.snapshot.asset.baseHeightM).toBe(2);
    expect(admitted.snapshot.asset.baseHeightM).toBe(1);
    expect(retained.snapshot.sceneGeneration).toBe(oldGeneration);
    expect(system.snapshotLeaseCount(guid('4'), current.snapshot.sceneGeneration)).toBe(1);
    system.unmountBody(guid('4'));
    expect(admitted.snapshot.asset.baseHeightM).toBe(1);
    system.releaseSnapshot(admitted).unwrap();
    expect(system.snapshotLeaseCount(guid('4'), oldGeneration)).toBe(1);
    system.releaseSnapshot(retained).unwrap();
    expect(system.snapshotLeaseCount(guid('4'), oldGeneration)).toBe(0);
    expect(system.releaseSnapshot(admitted).ok).toBe(false);
    expect(system.retainSnapshot(retained).ok).toBe(false);
    system.releaseSnapshot(current).unwrap();
  });
  it('captures dependency payload versions in immutable snapshot leases', async () => {
    let dependency: {
      guid: string;
      kind: string;
      field: string;
      status: 'valid';
      version: string;
      payload: unknown;
    } = {
      guid: guid('1'),
      kind: 'material',
      field: 'surfaceMaterialGuid',
      status: 'valid',
      version: '1',
      payload: { kind: 'material', values: { roughness: 1 } },
    };
    const system = new WaterSystem(
      () => undefined,
      () => [dependency],
    );
    const mounted = system.mountBody(guid('4'), 'v1', await cookedBody(body())).unwrap();
    system.clearDirty(guid('4'), [
      'geometry',
      'waterInfo',
      'waterMesh',
      'terrainBrush',
      'collision',
      'query',
      'material',
    ]);
    const lease = system.admitSnapshot(guid('4')).unwrap();
    expect(lease.snapshot.dependencies[0]?.payload).toMatchObject({ values: { roughness: 1 } });
    dependency = {
      ...dependency,
      version: '2',
      payload: { kind: 'material', values: { roughness: 0.25 } },
    };
    expect(system.refreshDependencies(guid('4'), ['material', 'waterMesh']).unwrap()).toBe(true);
    const current = system.admitSnapshot(guid('4')).unwrap();
    expect(current.snapshot.sceneGeneration).toBeGreaterThan(mounted.sceneGeneration);
    expect(current.snapshot.dependencies[0]?.payload).toMatchObject({
      values: { roughness: 0.25 },
    });
    expect(lease.snapshot.dependencies[0]?.payload).toMatchObject({ values: { roughness: 1 } });
    expect(Object.isFrozen(lease.snapshot.dependencies[0]?.payload)).toBe(true);
    system.releaseSnapshot(lease).unwrap();
    system.releaseSnapshot(current).unwrap();
  });
  it('refreshes valid mesh inputs while retaining unrelated unavailable dependencies and old valid values', async () => {
    let dependencies = [
      {
        guid: guid('1'),
        kind: 'material',
        field: 'surfaceMaterialGuid',
        status: 'unavailable' as const,
      },
      { guid: guid('2'), kind: 'mesh', field: 'waterInfoMeshGuid', status: 'unavailable' as const },
    ];
    const system = new WaterSystem(
      () => undefined,
      () => dependencies,
    );
    system.mountBody(guid('4'), 'v1', await cookedBody(body())).unwrap();
    const old = system.admitSnapshot(guid('4')).unwrap();

    dependencies = [
      requiredFixtureValue(dependencies[0]),
      {
        guid: guid('2'),
        kind: 'mesh',
        field: 'waterInfoMeshGuid',
        status: 'valid',
        version: '1',
        payload: { kind: 'mesh' },
      },
    ];
    expect(system.refreshDependencies(guid('4'), ['geometry']).unwrap()).toBe(true);
    const accepted = system.admitSnapshot(guid('4')).unwrap();
    expect(accepted.snapshot.dependencies).toMatchObject([
      { field: 'surfaceMaterialGuid', status: 'unavailable' },
      { field: 'waterInfoMeshGuid', status: 'valid', version: '1' },
    ]);

    dependencies = [
      requiredFixtureValue(dependencies[0]),
      { ...requiredFixtureValue(dependencies[1]), status: 'unavailable' },
    ];
    expect(system.refreshDependencies(guid('4'), ['geometry']).unwrap()).toBe(false);
    expect(system.snapshot(guid('4'))?.dependencies[1]).toMatchObject({
      status: 'valid',
      version: '1',
    });

    dependencies = [
      ...dependencies,
      { guid: guid('3'), kind: 'mesh', field: 'dilatedWaterInfoMeshGuid', status: 'unavailable' },
    ];
    expect(system.refreshDependencies(guid('4'), ['geometry']).ok).toBe(false);
    expect(old.snapshot.dependencies[1]).toMatchObject({ status: 'unavailable' });
    system.releaseSnapshot(old).unwrap();
    system.releaseSnapshot(accepted).unwrap();
  });

  it('keeps Pack source identities deterministic', async () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('019a0000-0000-7000-8000-000000000201'),
      build: ({ packageId }) => buildWaterPackOutputs({ 'river/main': body() }, { packageId }),
    });
    const result = await definition.build({
      packageId: definePackageId('019a0000-0000-7000-8000-000000000201'),
      readByGuid: async () => ({ ok: false, error: new Error('unexpected asset read') }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value['river/main']?.kind).toBe('water-body');
  });
});
