import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { textureContribution } from '@forgeax/engine-image';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import type { Asset, AssetKind } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { buildWaterPackOutputs, waterAssetDecoderContributions } from '@forgeax/engine-water';
import { describe, expect, it } from 'vitest';
import { normaliseForPack } from '../pack-value.js';
import {
  buildScriptablePack,
  buildScriptablePackWorklist,
  type ScriptablePackBuildProduct,
} from '../scriptable-pack-build-core.js';
import { createStandardAssetOutputProducerRegistry } from '../standard-output-producers.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const buildWaterWorklist = buildScriptablePackWorklist as unknown as (
  options: Parameters<typeof buildScriptablePackWorklist>[0] & {
    availableKinds: ReadonlyMap<string, string>;
  },
) => ReturnType<typeof buildScriptablePackWorklist>;

const packageId = definePackageId('019a0000-0000-7000-8000-000000000301');
const sourceKey = { material: 'material/root', zone: 'zone/main', body: 'river/main' } as const;
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));

function bodySource() {
  return {
    kind: 'water-body',
    type: 'river',
    spline: {
      closed: false,
      points: [0, 1].map((inputKey) => ({
        inputKey,
        positionM: [inputKey, 2, 0],
        arriveTangentM: [1, 0, 0],
        leaveTangentM: [1, 0, 0],
        up: [0, 1, 0],
        rollAngle: 0,
        angleUnit: 'degrees',
        widthM: 10,
        depthM: 1,
        velocityMPerSec: 1,
        audioIntensity: 0,
      })),
    },
    baseHeightM: 0,
    overlapPriority: 0,
    maxWaveHeightM: 0,
    surfaceMaterialGuid: guid(sourceKey.material),
    zoneGuid: guid(sourceKey.zone),
    flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
    collision: { type: 'river-prism', enabled: true },
    queryFootprint: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  };
}

describe('water ScriptablePack production', () => {
  it('propagates missing Ocean authoring transforms as a structured Pack cook error', async () => {
    const point = (inputKey: number, x: number, z: number) => ({
      ...bodySource().spline.points[0],
      inputKey,
      positionM: [x, 0, z],
      arriveTangentM: [0, 0, 0],
      leaveTangentM: [0, 0, 0],
    });
    const ocean = {
      ...bodySource(),
      type: 'ocean',
      spline: {
        closed: true,
        points: [point(0, -1, -1), point(1, 1, -1), point(2, 1, 1), point(3, -1, 1)],
      },
      oceanExtentM: [20, 20],
      centerOnWaterZone: true,
      savedZoneLocationWorldXZ: [0, 0],
      collision: { type: 'none', enabled: false },
    };
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: ({ packageId, readByGuid }) =>
        buildWaterPackOutputs({ [sourceKey.body]: ocean }, { packageId, readByGuid }),
    });
    const built = await buildScriptablePack({
      definition,
      sourcePath: 'missing-ocean-authoring-transform.pack.ts',
      outputs: createStandardAssetOutputProducerRegistry(),
    });
    expect(built).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-source',
        expected: expect.stringContaining('authoring Body world transform'),
      },
    });
  });

  it('revalidates Water reference kinds for cache hits against the current catalog', async () => {
    const externalGuids = new Set([guid(sourceKey.material), guid(sourceKey.zone)]);
    const goodKinds = new Map([
      [guid(sourceKey.material), 'material'],
      [guid(sourceKey.zone), 'water-zone'],
    ]);
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: ({ packageId, readByGuid }) =>
        buildWaterPackOutputs({ [sourceKey.body]: bodySource() }, { packageId, readByGuid }),
    });
    const outputs = createStandardAssetOutputProducerRegistry();
    let cachedProduct: ScriptablePackBuildProduct | undefined;
    const subject = { definition, sourcePath: 'cached-water.pack.ts' };
    const initial = await buildWaterWorklist({
      subjects: [subject],
      outputs,
      availableGuids: externalGuids,
      availableKinds: goodKinds,
      cache: {
        read: async () => undefined,
        write: async (_subject, value) => {
          cachedProduct = value;
        },
      },
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    const result = await buildWaterWorklist({
      subjects: [subject],
      outputs,
      availableGuids: externalGuids,
      availableKinds: new Map([
        [guid(sourceKey.material), 'water-zone'],
        [guid(sourceKey.zone), 'water-zone'],
      ]),
      cache: { read: async () => cachedProduct, write: async () => undefined },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-output-reference-kind-invalid',
        detail: {
          sourceKey: sourceKey.body,
          field: 'surfaceMaterialGuid',
          expectedKind: 'material',
          actualKind: 'water-zone',
        },
      },
    });
  });

  it('rejects a local Water reference whose Pack output kind is wrong before publication', async () => {
    const wrongSurface = guid(sourceKey.zone);
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: ({ packageId, readByGuid }) =>
        buildWaterPackOutputs(
          {
            [sourceKey.zone]: {
              kind: 'water-zone',
              extentM: { spanXM: 10, spanZM: 10 },
              tileSizeM: 1,
              tessellationFactor: 2,
              lodScale: 1,
              waterInfo: {
                resolution: { widthPx: 16, heightPx: 16 },
                format: 'rgba16f',
                blurRadius: 0,
                localTessellation: false,
              },
            },
            [sourceKey.body]: { ...bodySource(), surfaceMaterialGuid: wrongSurface },
          },
          { packageId, readByGuid },
        ),
    });
    const built = await buildScriptablePack({
      definition,
      sourcePath: 'bad-water.pack.ts',
      outputs: createStandardAssetOutputProducerRegistry(),
    });
    expect(built).toMatchObject({
      ok: false,
      error: {
        code: 'pack-output-reference-kind-invalid',
        detail: {
          field: 'surfaceMaterialGuid',
          expectedKind: 'material',
          actualKind: 'water-zone',
        },
      },
    });
  });

  it('rejects a Water dependency missing from the complete Pack and Catalog closure', async () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: ({ packageId, readByGuid }) =>
        buildWaterPackOutputs({ [sourceKey.body]: bodySource() }, { packageId, readByGuid }),
    });
    const built = await buildWaterWorklist({
      subjects: [{ definition, sourcePath: 'missing-water-dependency.pack.ts' }],
      outputs: createStandardAssetOutputProducerRegistry(),
      availableGuids: new Set(),
      availableKinds: new Map(),
    });
    expect(built).toMatchObject({ ok: false, error: { code: 'pack-output-reference-missing' } });
  });

  it('publishes native ForgeAX meter sources through Pack v2 and loads the body before its Zone', async () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: async ({ packageId, readByGuid }) => {
        const water = await buildWaterPackOutputs(
          {
            [sourceKey.zone]: {
              kind: 'water-zone',
              extentM: { spanXM: 10, spanZM: 10 },
              tileSizeM: 1,
              tessellationFactor: 6,
              lodScale: 1,
              farMaterialGuid: guid(sourceKey.material),
              waterInfo: {
                resolution: { widthPx: 64, heightPx: 64 },
                format: 'rgba16f',
                blurRadius: 0,
                localTessellation: false,
              },
            },
            [sourceKey.body]: bodySource(),
            'wave/shared': {
              kind: 'water-wave-set',
              waveSource: {
                kind: 'predefined',
                waves: [{ directionXZ: [1, 0], wavelengthM: 2.5, amplitudeM: 1, steepness: 0.5 }],
              },
              depthMaskM: 1,
              maxWaveHeightM: 1,
              timeSource: 'scene-clock',
            },
            'brush/river': {
              kind: 'water-brush-recipe',
              baseTerrainGuid: guid('terrain/base'),
              sourceBodyGuids: [guid(sourceKey.body)],
              orderedActors: ['river/main'],
              terrainCapture: {
                worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                boundsXZ: { minM: [-0.5, -0.5], maxM: [7.5, 7.5] },
                resolutionPx: [8, 8],
                layerNameToIndex: { Water: 0 },
              },
              curves: [],
              textures: [],
              outputTerrainSourceKey: 'terrain/coast-after-water',
              rules: {
                falloff: { type: 'smooth', widthM: 2, strength: 1 },
                blend: { type: 'alpha', alpha: 1 },
                heightRules: { mode: 'raise', offsetM: 0, velocityMPerSec: 0 },
                weightRules: { layer: 'Water', value: 1, blend: 'replace' },
              },
            },
            'simulation/fluid': {
              kind: 'water-simulation-recipe',
              system: 'fluid-simulation',
              configurationVersion: 1,
              solverMode: 'ripple',
              terrainMode: 'none',
              resolution: [64, 64],
              virtualFps: 30,
              maxStepsPerFrame: 5,
              gridExtentM: [20, 20],
              waveFoam: { resolution: 64, gridExtentM: 20 },
              maxImpulses: 64,
              impulseNoiseGuid: guid('texture/impulse-noise'),
              targets: Object.fromEntries(
                Object.entries({
                  height: 'ripple-height-m',
                  velocity: 'velocity-xz-m/s',
                  normalHeight: 'normal-xz-height-m',
                  forces: 'height-foam-mask',
                  velocityForces: 'velocity-xz-m/s',
                  wave: 'wave-foam',
                  foam: 'foam',
                }).map(([key, channels]) => [
                  key,
                  {
                    format: 'rgba16float',
                    filter: 'linear',
                    address: 'repeat',
                    origin: 'top-left',
                    channels,
                    clear: [0, 0, 0, 1],
                  },
                ]),
              ),
              injectionLimits: {
                heightDeltaM: { encodedRange: [-2, 2], unit: 'm' },
                foamStrength: { encodedRange: [0, 4], unit: 'unitless' },
              },
              parameters: {
                travelSpeed: 0.95,
                rippleDamping: 0.01,
                rippleFoamDamping: 0.998,
                rippleFoamErasure: 0.1,
                fluidDampingPerSecond: 0.1,
                gravityMPerSecSquared: 9.8,
                shallowEdgeLengthM: 0.001,
                shallowFadingBackPerSecond: 0.25,
                terrainUseWaterDepthOnly: 0,
                shallowFoamFadePerSecond: 2,
                shallowFoamInjection: 0.5,
                shallowVelocityForFoamMPerSecond: 1.28,
                shallowFoamSlopeMinimum: 0.5,
                shallowFoamSlopeRange: 0.05,
                shallowNormalHeightScale: 5,
                constantWaterDepthM: 2,
                evaporationMPerSecond: 0,
                maskThreshold: 0.5,
                normalHeightScale: 1,
                normalDefaultDepthM: 0,
                normalFoamAmount: 0.01,
                normalFoamHeightScale: 16,
                normalEdgeFalloff: 0.2,
                waveNormalAmount: 10,
                waveNormalBias: 0,
                waveMinimumHeightM: 0.48,
                waveHeightDivisorM: 0.48,
                waveEdgeFalloff: 0.2,
                waveTimeBiasSeconds: 0,
                foamFadePerFrame: 0,
                foamDiffusion: 0.5,
                foamEdgeFalloff: 0.2,
                foamWetPerMeter: 2,
                foamWetFadePerFrame: 0.001,
                foamToneMapDensity: 0.1,
              },
              shallowFoamEnabled: true,
              foamEnabled: true,
              materialGuids: [],
              textureGuids: [],
            },
          },
          { packageId, readByGuid },
        );
        return water.ok
          ? ok({
              ...water.value,
              [sourceKey.material]: { kind: 'material', values: { roughness: 1 } } as const,
              'texture/impulse-noise': {
                kind: 'texture',
                shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
                format: 'rgba8unorm-srgb',
                colorSpace: 'srgb',
                data: new Uint8Array([127, 127, 127, 255]),
                mips: { kind: 'none' },
              } as const,
            })
          : water;
      },
    });
    const built = await buildScriptablePack({
      definition,
      sourcePath: 'coast.pack.ts',
      outputs: createStandardAssetOutputProducerRegistry(),
      availableGuids: new Set([guid('terrain/base')]),
    });
    if (!built.ok) throw built.error;

    const bodyGuid = guid(sourceKey.body);
    const riverSegmentKey = `${sourceKey.body}/river-segment/0`;
    const riverSegmentGuid = guid(riverSegmentKey);
    const waterInfoGuid = guid(`${sourceKey.body}/water-info`);
    const dilatedWaterInfoGuid = guid(`${sourceKey.body}/water-info-dilated`);
    const zoneGuid = guid(sourceKey.zone);
    const materialGuid = guid(sourceKey.material);
    const bodyOutput = built.value.product.assets.find((asset) => asset.guid === bodyGuid);
    expect(bodyOutput).toMatchObject({
      kind: 'water-body',
      payload: { surfaceMaterialGuid: materialGuid },
    });
    expect(bodyOutput?.payload).toMatchObject({
      spline: {
        points: [
          { positionM: [0, 2, 0], widthM: 10, depthM: 1, velocityMPerSec: 1, up: [0, 1, 0] },
          { positionM: [1, 2, 0], widthM: 10, depthM: 1, velocityMPerSec: 1, up: [0, 1, 0] },
        ],
      },
      maxWaveHeightM: 0,
    });
    expect(bodyOutput?.payload).toMatchObject({ riverSegmentMeshGuids: [riverSegmentGuid] });
    expect(bodyOutput?.refs.map((ref) => ref.guid).sort()).toEqual(
      [materialGuid, zoneGuid, riverSegmentGuid, waterInfoGuid, dilatedWaterInfoGuid].sort(),
    );
    const riverSegmentOutput = built.value.product.assets.find(
      (asset) => asset.guid === riverSegmentGuid,
    );
    expect(riverSegmentOutput).toMatchObject({ kind: 'mesh', payload: { kind: 'mesh' } });
    expect(
      built.value.product.assets.find((asset) => asset.guid === dilatedWaterInfoGuid),
    ).toMatchObject({ kind: 'mesh', payload: { kind: 'mesh' } });
    expect(
      built.value.product.assets
        .find((asset) => asset.guid === zoneGuid)
        ?.refs.map((ref) => ref.guid),
    ).toEqual([materialGuid]);
    const waveOutput = built.value.product.assets.find(
      (asset) => asset.guid === guid('wave/shared'),
    );
    expect(waveOutput).toMatchObject({
      kind: 'water-wave-set',
      payload: { waves: [{ wavelengthM: 2.5, amplitudeM: 1 }] },
    });
    expect(
      built.value.product.assets
        .find((asset) => asset.guid === guid('brush/river'))
        ?.refs.map((ref) => ref.guid)
        .sort(),
    ).toEqual([bodyGuid, guid('terrain/base')].sort());
    expect(
      built.value.product.assets
        .find((asset) => asset.guid === guid('simulation/fluid'))
        ?.refs.map((ref) => ref.guid),
    ).toEqual([guid('texture/impulse-noise')]);
    expect(built.value.stagedOutputs.map((output) => AssetGuid.format(output.guid)).sort()).toEqual(
      [
        bodyGuid,
        riverSegmentGuid,
        waterInfoGuid,
        dilatedWaterInfoGuid,
        materialGuid,
        zoneGuid,
        guid('wave/shared'),
        guid('brush/river'),
        guid('simulation/fluid'),
        guid('texture/impulse-noise'),
      ].sort(),
    );
    expect(built.value.stagedOutputs.every((output) => output.digest?.startsWith('sha256:'))).toBe(
      true,
    );
    expect(built.value.externalEvidence).toContainEqual({
      guid: guid('terrain/base'),
      usage: 'reference',
    });
    expect(
      built.value.externalEvidence.find((evidence) => evidence.guid === guid('terrain/base')),
    ).not.toHaveProperty('digest');

    const packUrl = 'https://water.invalid/coast.pack.json';
    const published = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath: 'coast.pack.ts',
      sourceRevision: built.value.product.sourceRevision,
      inputFingerprint: built.value.inputFingerprint,
      packageUrl: packUrl,
      sourceKeys: new Map(
        built.value.stagedOutputs.map((output) => [
          AssetGuid.format(output.guid).toLowerCase(),
          output.sourceKey,
        ]),
      ),
      pack: {
        assets: built.value.product.assets.map((asset) => ({
          guid: asset.guid,
          kind: asset.kind,
          payload: asset.payload,
          refs: asset.refs.map((ref) => ref.guid),
          artifacts: {},
        })),
      },
    });
    expect(published.publication.receipt.inputFingerprint).toBe(built.value.inputFingerprint);
    expect(published.publication.outputs).toHaveLength(built.value.stagedOutputs.length);
    for (const output of built.value.stagedOutputs) {
      const row = published.publication.outputs.find(
        (candidate) => candidate.guid === AssetGuid.format(output.guid),
      );
      expect(row).toMatchObject({
        sourceKey: output.sourceKey,
        kind: output.asset.kind,
        refs: expect.any(Array),
        digest: expect.stringMatching(/^sha256:/),
      });
    }
    const entries = built.value.product.assets.map((asset) => {
      const output = built.value.stagedOutputs.find(
        (candidate) => AssetGuid.format(candidate.guid) === asset.guid,
      );
      if (!output) throw new Error(`Missing staged output ${asset.guid}`);
      return {
        guid: asset.guid,
        kind: asset.kind,
        packageUrl: packUrl,
        sourcePath: 'coast.pack.ts',
        publication: published.publication,
        sourceKey: output.sourceKey,
      };
    });
    const assets = new AssetRegistry();
    assets.installDecoder(textureContribution.kind, textureContribution.decoder);
    for (const contribution of waterAssetDecoderContributions)
      assets.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
    assets.setCatalogSource(
      createCatalogSource({
        entries,
        fetch: async () => Response.json(normaliseForPack(published.pack)),
      }),
    );
    try {
      const loaded = await assets.load(bodyGuid, 'water-body');
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const runtimeBody = assets.read(loaded.value).unwrap();
      expect(runtimeBody.kind).toBe('water-body');
      if (runtimeBody.kind === 'water-body')
        expect(runtimeBody.spline.points[1]).toMatchObject({
          positionM: [1, 2, 0],
          depthM: 1,
          velocityMPerSec: 1,
          up: [0, 1, 0],
        });
      expect(assets.inspect().assets.some((asset) => asset.guid === zoneGuid)).toBe(false);
      const fluidGuid = guid('simulation/fluid');
      const fluidOutput = built.value.product.assets.find((asset) => asset.guid === fluidGuid);
      expect(fluidOutput?.refs).toContainEqual(
        expect.objectContaining({
          guid: guid('texture/impulse-noise'),
          sourceField: { fieldName: 'impulseNoiseGuid' },
        }),
      );
      const fluid = assets
        .read((await assets.load(fluidGuid, 'water-simulation-recipe')).unwrap())
        .unwrap();
      expect(fluid).toMatchObject({ impulseNoiseGuid: guid('texture/impulse-noise') });
      const noise = assets
        .read((await assets.load(guid('texture/impulse-noise'), 'texture')).unwrap())
        .unwrap();
      expect(noise).toMatchObject({ kind: 'texture', format: 'rgba8unorm-srgb' });
      if (noise.kind === 'texture') expect(Array.from(noise.data)).toEqual([127, 127, 127, 255]);
    } finally {
      assets.dispose();
    }
  });

  it('re-cooks the River segment output roster after spline point insertion or deletion', async () => {
    const source = bodySource();
    const build = async (points: typeof source.spline.points) =>
      buildScriptablePack({
        definition: definePack({
          schemaVersion: '2.0.0',
          packageId,
          build: ({ packageId, readByGuid }) =>
            buildWaterPackOutputs(
              {
                [sourceKey.body]: { ...source, spline: { ...source.spline, points } },
              },
              { packageId, readByGuid },
            ),
        }),
        sourcePath: 'river-roster.pack.ts',
        outputs: createStandardAssetOutputProducerRegistry(),
        availableGuids: new Set([guid(sourceKey.material), guid(sourceKey.zone)]),
      });
    const first = await build(source.spline.points);
    const insertedPoint = {
      ...requiredFixtureValue(source.spline.points[1]),
      inputKey: 2,
      positionM: [2, 2, 0],
    };
    const afterInsert = await build([...source.spline.points, insertedPoint]);
    const afterDelete = await build(source.spline.points);
    if (!first.ok) throw first.error;
    if (!afterInsert.ok) throw afterInsert.error;
    if (!afterDelete.ok) throw afterDelete.error;
    expect(first.value.stagedOutputs.map((output) => output.sourceKey).sort()).toEqual([
      sourceKey.body,
      `${sourceKey.body}/river-segment/0`,
      `${sourceKey.body}/water-info`,
      `${sourceKey.body}/water-info-dilated`,
    ]);
    expect(afterInsert.value.stagedOutputs.map((output) => output.sourceKey).sort()).toEqual([
      sourceKey.body,
      `${sourceKey.body}/river-segment/0`,
      `${sourceKey.body}/river-segment/1`,
      `${sourceKey.body}/water-info`,
      `${sourceKey.body}/water-info-dilated`,
    ]);
    expect(afterDelete.value.stagedOutputs.map((output) => output.sourceKey).sort()).toEqual([
      sourceKey.body,
      `${sourceKey.body}/river-segment/0`,
      `${sourceKey.body}/water-info`,
      `${sourceKey.body}/water-info-dilated`,
    ]);
    expect(
      afterDelete.value.stagedOutputs.some((output) =>
        output.sourceKey.endsWith('/river-segment/1'),
      ),
    ).toBe(false);
    expect(
      AssetGuid.format(
        requiredFixtureValue(
          first.value.stagedOutputs.find((output) => output.sourceKey.endsWith('/river-segment/0')),
        ).guid,
      ),
    ).toBe(
      AssetGuid.format(
        requiredFixtureValue(
          afterInsert.value.stagedOutputs.find((output) =>
            output.sourceKey.endsWith('/river-segment/0'),
          ),
        ).guid,
      ),
    );
  });

  it('cooks editable Pack JSON wave source through the ordinary water output producer', async () => {
    const source = {
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [{ directionXZ: [0, 1], wavelengthM: 4, amplitudeM: 0.75, steepness: 0.4 }],
      },
      depthMaskM: 2,
      maxWaveHeightM: 1.5,
      timeSource: 'fixed-step',
    } as const;
    const producer = createStandardAssetOutputProducerRegistry().get('water-wave-set');
    if (!producer) throw new Error('water-wave-set producer is not registered');
    const produced = await producer.produce({
      guid: guid('waves/editable'),
      sourceKey: 'waves/editable',
      sourcePath: 'coast.pack.json',
      asset: source as unknown as Asset,
    });
    if (!produced.ok) throw produced.error;
    expect(produced.value.payload).toMatchObject({
      kind: 'water-wave-set',
      sourceMode: 'predefined',
      waves: [{ directionXZ: [0, 1], wavelengthM: 4, amplitudeM: 0.75 }],
      depthMaskM: 2,
      maxWaveHeightM: 1.5,
    });
  });
});
