import type { WaterBrushActorRules, WaterBrushRecipeAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  buildWaterBrushTerrainManifest,
  UE_DEFAULT_WATER_BRUSH_CURVE_KEY,
  WATER_BRUSH_REQUIRED_SHADER_VERSIONS,
  type WaterBrushTerrainManifest,
  waterBrushDepthVelocityDigest,
  waterBrushIslandSplineDigest,
} from '../brush-manifest.js';
import { migrateWaterBrushRecipeV0ToV1 } from '../brush-migration.js';
import { applyWaterBrushTerrainReadback, selectWaterBrushCacheInput } from '../brush-terrain.js';
import {
  UE_DEFAULT_WATER_BRUSH_CURVE_SHA256,
  waterBrushDefaultCurveR16fBytes,
} from '../ue-default-water-brush-curve.js';
import { validateWaterAsset } from '../validate.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const bodyOne = '019a0000-0000-7000-8000-000000000001';
const bodyTwo = '019a0000-0000-7000-8000-000000000002';
const curveGuid = '019a0000-0000-7000-8000-000000000003';
const textureGuid = '019a0000-0000-7000-8000-000000000004';
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const digestC = 'c'.repeat(64);

function bodySpline() {
  return {
    closed: false,
    points: [0, 1, 2].map((inputKey) => ({
      inputKey,
      positionM: [inputKey, 2, 0] as const,
      arriveTangentM: [1, 0, 0] as const,
      leaveTangentM: [1, 0, 0] as const,
      up: [0, 1, 0] as const,
      rollAngle: 0,
      angleUnit: 'degrees' as const,
      widthM: 8,
      depthM: 2 + inputKey,
      velocityMPerSec: 3 + inputKey,
      audioIntensity: 0,
    })),
  };
}

function bodyCaptureProvenance(
  meshDigest = digestA,
  _depthVelocityDigest = digestB,
  worldMatrixM: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  river = false,
  sourcePayloadDigest = digestC,
) {
  const depthVelocityDigest = waterBrushDepthVelocityDigest(bodySpline());
  return {
    source: 'pack-mesh' as const,
    sourcePayloadDigest,
    ...(river
      ? {
          riverSegmentMeshes: [0, 1].map((segmentIndex) => ({
            segmentIndex,
            meshGuid: `019a0000-0000-7000-8000-00000000009${segmentIndex}`,
            meshDigest,
          })),
        }
      : { meshGuid: '019a0000-0000-7000-8000-000000000099', meshDigest }),
    worldMatrixM,
    depthVelocityDigest,
  };
}

function islandCaptureProvenance(
  actor: ReturnType<typeof islandActor>,
  shapeMeshDigest = digestA,
  depthVelocityDigest = digestB,
  worldMatrixM: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
) {
  return {
    source: 'island-spline' as const,
    splineDigest: waterBrushIslandSplineDigest(actor.spline),
    shapeMeshDigest,
    shapeGeneratorVersion: 'island-spline-shape/1',
    worldMatrixM,
    depthVelocityDigest: waterBrushDepthVelocityDigest(actor.spline),
  };
}

const cacheByActor = (manifest: WaterBrushTerrainManifest, id: string) =>
  manifest.actorCaches.find((cache) => cache.actorId === id);

function actorRules(curve?: string, texture?: string): WaterBrushActorRules {
  return {
    falloff: { mode: 'width', widthM: 2, angleDegrees: 0, edgeOffsetM: 0, zOffsetM: 0 },
    blend: { type: 'alpha' },
    blurring: { enabled: true, radiusPx: 3 },
    curlNoise: { firstAmount: 0.2, firstTiling: 1, secondAmount: 0.1, secondTiling: 2 },
    curves: {
      useCurveChannel: !!curve,
      ...(curve ? { elevationCurveGuid: curve } : {}),
      channelEdgeOffsetM: 0,
      channelDepthM: 1,
      curveRampWidthM: 2,
    },
    displacement: {
      enabled: !!texture,
      heightM: 0.4,
      textureTiling: 1,
      ...(texture ? { textureGuid: texture } : {}),
      midpoint: 0.5,
      channel: 0,
      weightmapInfluence: 0.1,
    },
    smoothBlending: { innerDistanceM: 0, outerDistanceM: 1 },
    terracing: { alpha: 0.2, spacingM: 2, smoothness: 0.5, maskLengthM: 2, maskStartOffsetM: 0 },
    weightSettings: [
      {
        layerName: 'grass',
        falloffWidthM: 1,
        edgeOffsetM: 0,
        textureTiling: 1,
        textureInfluence: 0.2,
        midpoint: 0.5,
        finalOpacity: 1,
      },
      {
        layerName: 'water',
        falloffWidthM: 2,
        edgeOffsetM: 0,
        textureTiling: 2,
        textureInfluence: 0.5,
        midpoint: 0.5,
        finalOpacity: 0.75,
      },
    ],
  };
}

function islandActor() {
  return {
    kind: 'island' as const,
    actorId: 'island/one',
    fullName: '/Game/Water/Island_One',
    sourceKey: 'island/one',
    heightOffsetM: 0.25,
    spline: {
      closed: true,
      points: [
        [6, 2],
        [7, 2],
        [7, 3],
        [6, 3],
      ].map(([x, z], inputKey) => ({
        inputKey,
        positionM: [x, 0, z] as const,
        arriveTangentM: [1, 0, 0] as const,
        leaveTangentM: [1, 0, 0] as const,
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 0,
        depthM: 0,
        velocityMPerSec: 0,
        audioIntensity: 0,
      })),
    },
    rules: actorRules(),
  };
}

function recipe(): WaterBrushRecipeAsset {
  return {
    kind: 'water-brush-recipe',
    actorVersion: 1,
    baseTerrainGuid: bodyOne,
    sourceBodyGuids: [bodyOne, bodyTwo],
    orderedActors: [
      {
        kind: 'body',
        actorId: 'water/rivers/one',
        fullName: '/Game/Water/River_One',
        bodyType: 'river',
        bodyGuid: bodyOne,
        rules: actorRules(curveGuid, textureGuid),
      },
      {
        kind: 'body',
        actorId: 'water/rivers/alpha',
        fullName: '/Game/Water/River_Alpha',
        bodyType: 'river',
        bodyGuid: bodyOne,
        rules: actorRules(),
      },
      {
        kind: 'body',
        actorId: 'water/custom/transition',
        fullName: '/Game/Water/Custom_Transition',
        bodyType: 'custom',
        bodyGuid: bodyOne,
        rules: actorRules(),
      },
      islandActor(),
      {
        kind: 'body',
        actorId: 'water/rivers/two',
        fullName: '/Game/Water/Ocean_Two',
        bodyType: 'ocean',
        bodyGuid: bodyTwo,
        rules: actorRules(),
      },
      {
        kind: 'body',
        actorId: 'water/lakes/one',
        fullName: '/Game/Water/Lake_One',
        bodyType: 'lake',
        bodyGuid: bodyTwo,
        rules: actorRules(),
      },
    ],
    curves: [curveGuid],
    textures: [textureGuid],
    outputTerrainSourceKey: 'terrain/derived',
    terrainCapture: {
      worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      boundsXZ: { minM: [-0.5, -0.5], maxM: [7.5, 3.5] },
      resolutionPx: [8, 4],
      layerNameToIndex: { grass: 0, water: 1 },
    },
    rules: {
      falloff: { type: 'width', widthM: 0, strength: 1 },
      blend: { type: 'alpha', alpha: 1 },
      heightRules: { mode: 'offset', offsetM: 0, velocityMPerSec: 0 },
      weightRules: { layer: 'water', value: 0, blend: 'additive' },
    },
  };
}

const inputs = (
  first: string,
  second = digestA,
  curve = digestA,
  texture = digestA,
  baseTerrain = digestA,
) => ({
  baseTerrainDigest: baseTerrain,
  actorInputDigests: {
    'water/rivers/one': first,
    'water/rivers/alpha': digestA,
    'water/rivers/two': second,
    'water/lakes/one': digestA,
    'water/custom/transition': digestA,
    'island/one': digestA,
  },
  actorIdentities: {
    'water/rivers/one': {
      kind: 'body' as const,
      bodyGuid: bodyOne,
      bodyType: 'river' as const,
      fullName: '/Game/Water/River_One',
      shapeDilationM: 40.96,
      spline: bodySpline(),
      captureProvenance: bodyCaptureProvenance(digestA, digestB, undefined, true),
    },
    'water/rivers/alpha': {
      kind: 'body' as const,
      bodyGuid: bodyOne,
      bodyType: 'river' as const,
      fullName: '/Game/Water/River_Alpha',
      shapeDilationM: 40.96,
      spline: bodySpline(),
      captureProvenance: bodyCaptureProvenance(digestA, digestB, undefined, true),
    },
    'water/rivers/two': {
      kind: 'body' as const,
      bodyGuid: bodyTwo,
      bodyType: 'ocean' as const,
      fullName: '/Game/Water/Ocean_Two',
      shapeDilationM: 40.96,
      spline: bodySpline(),
      captureProvenance: bodyCaptureProvenance(),
    },
    'water/lakes/one': {
      kind: 'body' as const,
      bodyGuid: bodyTwo,
      bodyType: 'lake' as const,
      fullName: '/Game/Water/Lake_One',
      shapeDilationM: 40.96,
      spline: bodySpline(),
      captureProvenance: bodyCaptureProvenance(),
    },
    'water/custom/transition': {
      kind: 'body' as const,
      bodyGuid: bodyOne,
      bodyType: 'custom' as const,
      fullName: '/Game/Water/Custom_Transition',
      shapeDilationM: 40.96,
      spline: bodySpline(),
      captureProvenance: bodyCaptureProvenance(),
    },
    'island/one': {
      kind: 'island' as const,
      sourceKey: 'island/one',
      fullName: '/Game/Water/Island_One',
      captureProvenance: islandCaptureProvenance(islandActor()),
    },
  },
  dependencyDigests: {
    [curveGuid]: curve,
    [textureGuid]: texture,
    [UE_DEFAULT_WATER_BRUSH_CURVE_KEY]: UE_DEFAULT_WATER_BRUSH_CURVE_SHA256,
  },
  shaderVersions: {
    capture: '1',
    detectEdges: '1',
    blurEdges: '1',
    jumpFlood: '1',
    cacheDistanceField: '1',
    heightComposite: '1',
    weightComposite: '1',
    velocityHeightComposite: '1',
    terrainReadback: '1',
    combine: '1',
  },
});

describe('Water Brush Terrain manifest', () => {
  it('rejects malformed island identity before accepting valid rules and spline', () => {
    for (const patch of [
      { kind: 'unknown' },
      { sourceKey: '' },
      { heightOffsetM: Number.NaN },
      { fullName: '' },
    ]) {
      const candidate = recipe();
      const actor = { ...islandActor(), ...patch };
      expect(validateWaterAsset({ ...candidate, orderedActors: [actor] }).ok).toBe(false);
    }
  });
  it('records explicit pixel-center world mapping and per-actor UE RT/cache layouts', () => {
    const manifest = buildWaterBrushTerrainManifest(recipe(), inputs(digestA)).unwrap();
    expect(manifest.pixelCenterMapping.originWorldM).toEqual([0, 0, 0]);
    expect(manifest.pixelCenterMapping.stepWorldXM).toEqual([1, 0, 0]);
    expect(manifest.pixelCenterMapping.stepWorldZM).toEqual([0, 0, 1]);
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({
        name: 'actor:water/rivers/one:water-depth-and-velocity',
        format: 'rgba32float',
        widthPx: 8,
        heightPx: 4,
      }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({
        name: 'actor:water/rivers/one:depth-and-shape',
        format: 'rg32float',
      }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({
        name: 'actor:water/rivers/one:jump-flood-a',
        format: 'rgba32float',
      }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({
        name: 'actor:water/rivers/one:distance-height-depth-velocity',
        format: 'rgba32float',
        temporary: false,
      }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({
        name: 'actor:water/rivers/alpha:distance-height-depth-velocity',
        format: 'rgba32float',
        temporary: false,
      }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({
        name: 'actor:island/one:distance-height-depth-velocity',
        format: 'rg16float',
        temporary: false,
      }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({ name: 'weight:grass:ping', format: 'r8unorm' }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({
        name: `curve-lut:${curveGuid}`,
        widthPx: 256,
        heightPx: 1,
        format: 'r16float',
      }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({
        name: `curve-lut:${UE_DEFAULT_WATER_BRUSH_CURVE_KEY}`,
        widthPx: 256,
        heightPx: 1,
        format: 'r16float',
      }),
    );
    expect(manifest.actorCaches).toHaveLength(6);
    expect(cacheByActor(manifest, 'water/rivers/one')?.captureProvenance).toEqual(
      bodyCaptureProvenance(digestA, digestB, undefined, true),
    );
    expect(manifest.actorPassPlan[0]).toMatchObject({
      actorId: 'water/rivers/two',
      blurPassCount: 3,
      jumpFloodPassCount: 3,
      jfaStepOffsets: [4, 2, 1],
      heightRead: 'height-ping',
      heightWrite: 'height-pong',
      velocityHeightRead: 'combined-velocity-height-a',
      velocityHeightWrite: 'combined-velocity-height-b',
    });
    expect(manifest.actorPassPlan.map((actor) => actor.actorId)).toEqual([
      'water/rivers/two',
      'water/lakes/one',
      'water/rivers/alpha',
      'water/rivers/one',
      'water/custom/transition',
      'island/one',
    ]);
    expect(manifest.actorPassPlan[1]).toMatchObject({
      actorId: 'water/lakes/one',
      heightRead: 'height-pong',
      heightWrite: 'height-ping',
      velocityHeightRead: 'combined-velocity-height-b',
      velocityHeightWrite: 'combined-velocity-height-a',
    });
    expect(manifest.actorPassPlan[0]?.weightPasses).toEqual([
      { layerName: 'grass', read: 'weight:grass:ping', write: 'weight:grass:pong' },
      { layerName: 'water', read: 'weight:water:ping', write: 'weight:water:pong' },
    ]);
    expect(manifest.actorPassPlan[1]?.weightPasses).toEqual([
      { layerName: 'grass', read: 'weight:grass:pong', write: 'weight:grass:ping' },
      { layerName: 'water', read: 'weight:water:pong', write: 'weight:water:ping' },
    ]);
    expect(manifest.managerDefaults).toEqual({
      version: 'UE-5.8.1-WaterBrushManager-CDO-R1',
      canvasSegmentSizeM: 10.24,
      splineMeshExtensionM: 0,
    });
    expect(manifest.actorPassPlan[0]?.bodyComposite).toMatchObject({
      shapeDilationM: 40.96,
      splineMeshExtensionM: 0,
    });
    expect(manifest.actorPassPlan.at(-1)?.actorId).toBe('island/one');
    expect(manifest.actorPassPlan.at(-1)).not.toHaveProperty('velocityHeightRead');
    expect(manifest.actorPassPlan.at(-1)).not.toHaveProperty('bodyComposite');
    expect(manifest.initialization).toMatchObject({
      heightInput: 'base-combined-result',
      weightInput: 'base-combined-result',
      velocityHeightClearM: [0, 0, -163.84, 1],
      jumpFloodClear: [0, 0, 0, 0],
    });
  });

  it('requires neutral v1 legacy globals so operational rules have one actor-level source', () => {
    const source = recipe();
    expect(validateWaterAsset(source).ok).toBe(true);
    expect(
      validateWaterAsset({
        ...source,
        rules: { ...source.rules, falloff: { ...source.rules.falloff, widthM: 2 } },
      }).ok,
    ).toBe(false);
    expect(
      validateWaterAsset({
        ...source,
        rules: { ...source.rules, weightRules: { ...source.rules.weightRules, value: 1 } },
      }).ok,
    ).toBe(false);
  });

  it('accepts an explicit curve channel using the verified UE default FloatCurve', () => {
    const source = recipe();
    const defaultCurveSource = {
      ...source,
      orderedActors: source.orderedActors.map((actor) =>
        actor.kind === 'body' && actor.actorId === 'water/rivers/alpha'
          ? {
              ...actor,
              rules: { ...actor.rules, curves: { ...actor.rules.curves, useCurveChannel: true } },
            }
          : actor,
      ),
    };
    expect(validateWaterAsset(defaultCurveSource).ok).toBe(true);
    const baseInputs = inputs(digestA);
    const first = buildWaterBrushTerrainManifest(defaultCurveSource, baseInputs).unwrap();
    const changedDefault = buildWaterBrushTerrainManifest(defaultCurveSource, {
      ...baseInputs,
      dependencyDigests: {
        ...baseInputs.dependencyDigests,
        [UE_DEFAULT_WATER_BRUSH_CURVE_KEY]: digestB,
      },
    });
    expect(changedDefault.ok).toBe(false);
    expect(cacheByActor(first, 'water/rivers/alpha')?.cacheKey).toBeDefined();
    expect(
      buildWaterBrushTerrainManifest(defaultCurveSource, {
        ...baseInputs,
        dependencyDigests: {
          ...baseInputs.dependencyDigests,
          [UE_DEFAULT_WATER_BRUSH_CURVE_KEY]: undefined,
        },
      }).ok,
    ).toBe(false);
  });

  it('ships the UE 5.8.1 default curve bytes and preserves Islands registration order', () => {
    const curveBytes = waterBrushDefaultCurveR16fBytes();
    expect(curveBytes.byteLength).toBe(512);
    expect(curveBytes[510]).toBe(0);
    expect(curveBytes[511]).toBe(0x3c);
    curveBytes[0] = 0xff;
    expect(waterBrushDefaultCurveR16fBytes()[0]).toBe(0);

    const first = islandActor();
    const second = {
      ...islandActor(),
      actorId: 'island/registered-second',
      sourceKey: 'island/registered-second',
      fullName: '/Game/Water/Island_A',
    };
    const islandRecipe = { ...recipe(), sourceBodyGuids: [], orderedActors: [first, second] };
    const baseInputs = inputs(digestA);
    const manifest = buildWaterBrushTerrainManifest(islandRecipe, {
      ...baseInputs,
      actorInputDigests: { 'island/one': digestA, 'island/registered-second': digestB },
      actorIdentities: {
        'island/one': {
          kind: 'island',
          sourceKey: 'island/one',
          fullName: first.fullName,
          captureProvenance: islandCaptureProvenance(first),
        },
        'island/registered-second': {
          kind: 'island',
          sourceKey: 'island/registered-second',
          fullName: second.fullName,
          captureProvenance: islandCaptureProvenance(second, digestB),
        },
      },
    }).unwrap();
    expect(manifest.actorPassPlan.map(({ actorId }) => actorId)).toEqual([
      'island/one',
      'island/registered-second',
    ]);
  });

  it('accepts finite weight opacity outside the normalized range and leaves R8 quantization to composition', () => {
    const source = recipe();
    const outside = {
      ...source,
      orderedActors: source.orderedActors.map((actor) =>
        actor.kind === 'body' && actor.actorId === 'water/rivers/alpha'
          ? {
              ...actor,
              rules: {
                ...actor.rules,
                weightSettings: actor.rules.weightSettings.map((setting, index) =>
                  index === 0
                    ? { ...setting, finalOpacity: 1.4 }
                    : { ...setting, finalOpacity: -0.25 },
                ),
              },
            }
          : actor,
      ),
    };
    expect(validateWaterAsset(outside).ok).toBe(true);
    expect(buildWaterBrushTerrainManifest(outside, inputs(digestA)).ok).toBe(true);
  });

  it('resolves omitted Body actor IDs from distinct stable Body GUIDs', () => {
    const bodyThree = '019a0000-0000-7000-8000-000000000005';
    const actors = [
      {
        kind: 'body' as const,
        fullName: '/Water/Ocean',
        bodyType: 'ocean' as const,
        bodyGuid: bodyOne,
        rules: actorRules(),
      },
      {
        kind: 'body' as const,
        fullName: '/Water/Lake',
        bodyType: 'lake' as const,
        bodyGuid: bodyTwo,
        rules: actorRules(),
      },
      {
        kind: 'body' as const,
        fullName: '/Water/River',
        bodyType: 'river' as const,
        bodyGuid: bodyThree,
        rules: actorRules(),
      },
    ];
    const source = {
      ...recipe(),
      orderedActors: actors,
      sourceBodyGuids: [bodyOne, bodyTwo, bodyThree],
    } as WaterBrushRecipeAsset;
    expect(validateWaterAsset(source).ok).toBe(true);
    const baseInputs = inputs(digestA);
    const actorIdentities = {
      [bodyOne]: {
        kind: 'body' as const,
        bodyGuid: bodyOne,
        bodyType: 'ocean' as const,
        fullName: '/Water/Ocean',
        shapeDilationM: 40.96,
        spline: bodySpline(),
        captureProvenance: bodyCaptureProvenance(),
      },
      [bodyTwo]: {
        kind: 'body' as const,
        bodyGuid: bodyTwo,
        bodyType: 'lake' as const,
        fullName: '/Water/Lake',
        shapeDilationM: 40.96,
        spline: bodySpline(),
        captureProvenance: bodyCaptureProvenance(),
      },
      [bodyThree]: {
        kind: 'body' as const,
        bodyGuid: bodyThree,
        bodyType: 'river' as const,
        fullName: '/Water/River',
        shapeDilationM: 40.96,
        spline: bodySpline(),
        captureProvenance: bodyCaptureProvenance(digestA, digestB, undefined, true),
      },
    };
    const manifest = buildWaterBrushTerrainManifest(source, {
      ...baseInputs,
      actorIdentities,
      actorInputDigests: { [bodyOne]: digestA, [bodyTwo]: digestA, [bodyThree]: digestA },
    }).unwrap();
    expect(manifest.actorPassPlan.map((pass) => pass.actorId)).toEqual([
      bodyOne,
      bodyTwo,
      bodyThree,
    ]);
  });

  it('invalidates distance caches only for inputs consumed by CacheDistanceField', () => {
    const first = buildWaterBrushTerrainManifest(recipe(), inputs(digestA)).unwrap();
    const changedFirstActor = buildWaterBrushTerrainManifest(recipe(), inputs(digestB)).unwrap();
    const changedCurve = buildWaterBrushTerrainManifest(
      recipe(),
      inputs(digestA, digestA, digestB),
    ).unwrap();
    const changedTexture = buildWaterBrushTerrainManifest(
      recipe(),
      inputs(digestA, digestA, digestA, digestB),
    ).unwrap();
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedFirstActor, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/two')?.cacheKey).toBe(
      cacheByActor(changedFirstActor, 'water/rivers/two')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedCurve, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/two')?.cacheKey).toBe(
      cacheByActor(changedCurve, 'water/rivers/two')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).toBe(
      cacheByActor(changedTexture, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/two')?.cacheKey).toBe(
      cacheByActor(changedTexture, 'water/rivers/two')?.cacheKey,
    );
    expect(first.cacheKey).not.toBe(changedCurve.cacheKey);
    const baseInputs = inputs(digestA);
    const changedDefaultCurve = buildWaterBrushTerrainManifest(recipe(), {
      ...baseInputs,
      dependencyDigests: {
        ...baseInputs.dependencyDigests,
        [UE_DEFAULT_WATER_BRUSH_CURVE_KEY]: digestB,
      },
    });
    expect(changedDefaultCurve.ok).toBe(false);
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).toBeDefined();
    const source = recipe();
    const changedComposition = buildWaterBrushTerrainManifest(
      {
        ...source,
        orderedActors: source.orderedActors.map((actor) =>
          actor.kind === 'body' && actor.actorId === 'water/rivers/one'
            ? {
                ...actor,
                rules: {
                  ...actor.rules,
                  blend: { type: 'max' },
                  weightSettings: actor.rules.weightSettings.map((setting) => ({
                    ...setting,
                    finalOpacity: 0.25,
                  })),
                },
              }
            : actor,
        ),
      },
      inputs(digestA),
    ).unwrap();
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).toBe(
      cacheByActor(changedComposition, 'water/rivers/one')?.cacheKey,
    );
    expect(changedComposition.cacheKey).not.toBe(first.cacheKey);
    const firstInputs = inputs(digestA);
    const firstRiver = requiredFixtureValue(firstInputs.actorIdentities['water/rivers/one']);
    const changedMeshDigest = buildWaterBrushTerrainManifest(recipe(), {
      ...firstInputs,
      actorIdentities: {
        ...firstInputs.actorIdentities,
        'water/rivers/one': {
          ...firstRiver,
          captureProvenance: bodyCaptureProvenance(digestB, digestB, undefined, true),
        },
      },
    }).unwrap();
    const changedRiverSegment = buildWaterBrushTerrainManifest(recipe(), {
      ...firstInputs,
      actorIdentities: {
        ...firstInputs.actorIdentities,
        'water/rivers/one': {
          ...firstRiver,
          captureProvenance: {
            ...bodyCaptureProvenance(digestA, digestB, undefined, true),
            riverSegmentMeshes: [
              {
                segmentIndex: 0,
                meshGuid: '019a0000-0000-7000-8000-000000000098',
                meshDigest: digestB,
              },
              {
                segmentIndex: 1,
                meshGuid: '019a0000-0000-7000-8000-000000000090',
                meshDigest: digestA,
              },
            ],
          },
        },
      },
    }).unwrap();
    const changedPose = buildWaterBrushTerrainManifest(recipe(), {
      ...firstInputs,
      actorIdentities: {
        ...firstInputs.actorIdentities,
        'water/rivers/one': {
          ...firstRiver,
          captureProvenance: bodyCaptureProvenance(
            digestA,
            digestB,
            [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1],
            true,
          ),
        },
      },
    }).unwrap();
    const changedBodySpline = {
      ...firstRiver.spline,
      points: firstRiver.spline.points.map((point, index) =>
        index === 1 ? { ...point, depthM: point.depthM + 1 } : point,
      ),
    };
    const changedDepthVelocity = buildWaterBrushTerrainManifest(recipe(), {
      ...firstInputs,
      actorIdentities: {
        ...firstInputs.actorIdentities,
        'water/rivers/one': {
          ...firstRiver,
          spline: changedBodySpline,
          captureProvenance: {
            ...bodyCaptureProvenance(digestA, digestB, undefined, true),
            depthVelocityDigest: waterBrushDepthVelocityDigest(changedBodySpline),
          },
        },
      },
    }).unwrap();
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedMeshDigest, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedRiverSegment, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedPose, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedDepthVelocity, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/alpha')?.cacheKey).toBe(
      cacheByActor(changedMeshDigest, 'water/rivers/alpha')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/alpha')?.cacheKey).toBe(
      cacheByActor(changedRiverSegment, 'water/rivers/alpha')?.cacheKey,
    );
    expect(
      buildWaterBrushTerrainManifest(recipe(), {
        ...firstInputs,
        actorIdentities: {
          ...firstInputs.actorIdentities,
          'water/rivers/one': {
            ...firstRiver,
            captureProvenance: {
              ...firstRiver.captureProvenance,
              riverSegmentMeshes: [
                {
                  segmentIndex: 1,
                  meshGuid: '019a0000-0000-7000-8000-000000000099',
                  meshDigest: digestA,
                },
                {
                  segmentIndex: 1,
                  meshGuid: '019a0000-0000-7000-8000-000000000090',
                  meshDigest: digestA,
                },
              ],
            },
          },
        },
      }).ok,
    ).toBe(false);
    const changedShape = buildWaterBrushTerrainManifest(recipe(), {
      ...firstInputs,
      actorIdentities: {
        ...firstInputs.actorIdentities,
        'water/rivers/one': {
          ...firstRiver,
          shapeDilationM: 12.5,
          captureProvenance: { ...firstRiver.captureProvenance, sourcePayloadDigest: digestB },
        },
      },
    }).unwrap();
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).toBe(
      cacheByActor(changedShape, 'water/rivers/one')?.cacheKey,
    );
    expect(
      changedShape.actorPassPlan.find((pass) => pass.actorId === 'water/rivers/one')?.bodyComposite
        ?.shapeDilationM,
    ).toBe(12.5);
    expect(changedShape.cacheKey).not.toBe(first.cacheKey);

    const changedCacheShader = buildWaterBrushTerrainManifest(recipe(), {
      ...baseInputs,
      shaderVersions: { ...baseInputs.shaderVersions, cacheDistanceField: '2' },
    }).unwrap();
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedCacheShader, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/alpha')?.cacheKey).not.toBe(
      cacheByActor(changedCacheShader, 'water/rivers/alpha')?.cacheKey,
    );
  });

  it('keys Island capture from its frozen spline and generated shape provenance without inventing a mesh GUID', () => {
    const source = recipe();
    const first = buildWaterBrushTerrainManifest(source, inputs(digestA)).unwrap();
    const changedIsland = islandActor();
    const movedPoint = requiredFixtureValue(changedIsland.spline.points[0]);
    const moved = {
      ...changedIsland,
      spline: {
        ...changedIsland.spline,
        points: [
          {
            ...movedPoint,
            positionM: [
              movedPoint.positionM[0] + 0.25,
              movedPoint.positionM[1],
              movedPoint.positionM[2],
            ] as const,
          },
          ...changedIsland.spline.points.slice(1),
        ],
      },
    };
    const changedRecipe = {
      ...source,
      orderedActors: source.orderedActors.map((actor) => (actor.kind === 'island' ? moved : actor)),
    };
    const base = inputs(digestA);
    const changed = buildWaterBrushTerrainManifest(changedRecipe, {
      ...base,
      actorIdentities: {
        ...base.actorIdentities,
        'island/one': {
          kind: 'island',
          sourceKey: 'island/one',
          fullName: moved.fullName,
          captureProvenance: islandCaptureProvenance(moved, digestB),
        },
      },
    }).unwrap();
    expect(cacheByActor(first, 'island/one')?.cacheKey).not.toBe(
      cacheByActor(changed, 'island/one')?.cacheKey,
    );
    expect(cacheByActor(changed, 'island/one')?.captureProvenance).toMatchObject({
      source: 'island-spline',
      splineDigest: waterBrushIslandSplineDigest(moved.spline),
      shapeMeshDigest: digestB,
    });
    expect(cacheByActor(changed, 'island/one')?.captureProvenance).not.toHaveProperty('meshGuid');
  });

  it('keys all actor caches on the Terrain transform and RT mapping and rejects missing actors', () => {
    const first = buildWaterBrushTerrainManifest(recipe(), inputs(digestA)).unwrap();
    const changedBase = buildWaterBrushTerrainManifest(
      recipe(),
      inputs(digestA, digestA, digestA, digestA, digestB),
    ).unwrap();
    const changedTerrain = buildWaterBrushTerrainManifest(
      {
        ...recipe(),
        terrainCapture: { ...recipe().terrainCapture, resolutionPx: [16, 8] as const },
      },
      inputs(digestA),
    ).unwrap();
    const changedTerrainRotationAndScale = buildWaterBrushTerrainManifest(
      {
        ...recipe(),
        terrainCapture: {
          ...recipe().terrainCapture,
          worldMatrixM: [0, 0, -2, 0, 0, 1, 0, 0, 3, 0, 0, 0, 0, 0, 0, 1],
        },
      },
      inputs(digestA),
    ).unwrap();
    expect(first.cacheKey).not.toBe(changedBase.cacheKey);
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).toBe(
      cacheByActor(changedBase, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedTerrain, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/one')?.cacheKey).not.toBe(
      cacheByActor(changedTerrainRotationAndScale, 'water/rivers/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'island/one')?.cacheKey).not.toBe(
      cacheByActor(changedTerrainRotationAndScale, 'island/one')?.cacheKey,
    );
    expect(cacheByActor(first, 'water/rivers/two')?.cacheKey).not.toBe(
      cacheByActor(changedTerrain, 'water/rivers/two')?.cacheKey,
    );
    expect(
      buildWaterBrushTerrainManifest(recipe(), { ...inputs(digestA), actorInputDigests: {} }).ok,
    ).toBe(false);
    const actorIdentities = inputs(digestA).actorIdentities;
    expect(
      buildWaterBrushTerrainManifest(recipe(), {
        ...inputs(digestA),
        actorIdentities: {
          ...actorIdentities,
          'water/rivers/two': {
            ...requiredFixtureValue(actorIdentities['water/rivers/two']),
            bodyType: 'river',
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      buildWaterBrushTerrainManifest(recipe(), {
        ...inputs(digestA),
        actorIdentities: {
          ...actorIdentities,
          'water/rivers/two': {
            ...requiredFixtureValue(actorIdentities['water/rivers/two']),
            captureProvenance: {
              ...requiredFixtureValue(actorIdentities['water/rivers/two']).captureProvenance,
              meshDigest: 'bad',
            },
          },
        },
      }).ok,
    ).toBe(false);
    const river = requiredFixtureValue(actorIdentities['water/rivers/one']);
    expect(
      buildWaterBrushTerrainManifest(recipe(), {
        ...inputs(digestA),
        actorIdentities: {
          ...actorIdentities,
          'water/rivers/one': {
            ...river,
            captureProvenance: {
              ...river.captureProvenance,
              meshGuid: '019a0000-0000-7000-8000-000000000099',
            } as never,
          },
        },
      }).ok,
    ).toBe(false);
    const ocean = requiredFixtureValue(actorIdentities['water/rivers/two']);
    expect(
      buildWaterBrushTerrainManifest(recipe(), {
        ...inputs(digestA),
        actorIdentities: {
          ...actorIdentities,
          'water/rivers/two': {
            ...ocean,
            captureProvenance: {
              ...ocean.captureProvenance,
              riverSegmentMeshes: [
                {
                  segmentIndex: 0,
                  meshGuid: '019a0000-0000-7000-8000-000000000001',
                  meshDigest: digestA,
                },
              ],
            } as never,
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      buildWaterBrushTerrainManifest(recipe(), {
        ...inputs(digestA),
        actorIdentities: {
          ...actorIdentities,
          'water/rivers/one': {
            ...river,
            captureProvenance: {
              ...river.captureProvenance,
              riverSegmentMeshes: [
                {
                  segmentIndex: 0,
                  meshGuid: '019a0000-0000-7000-8000-000000000099',
                  meshDigest: digestA,
                },
                {
                  segmentIndex: 1,
                  meshGuid: '019A0000-0000-7000-8000-000000000099',
                  meshDigest: digestB,
                },
              ],
            },
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      buildWaterBrushTerrainManifest(recipe(), {
        ...inputs(digestA),
        actorIdentities: {
          ...actorIdentities,
          'water/rivers/two': {
            ...requiredFixtureValue(actorIdentities['water/rivers/two']),
            captureProvenance: {
              ...requiredFixtureValue(actorIdentities['water/rivers/two']).captureProvenance,
              worldMatrixM: new Array(16).fill(0),
            },
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      buildWaterBrushTerrainManifest(recipe(), {
        ...inputs(digestA),
        actorIdentities: {
          ...actorIdentities,
          'water/rivers/two': {
            ...requiredFixtureValue(actorIdentities['water/rivers/two']),
            captureProvenance: {
              ...requiredFixtureValue(actorIdentities['water/rivers/two']).captureProvenance,
              worldMatrixM: [1, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            },
          },
        },
      }).ok,
    ).toBe(false);
    for (const version of WATER_BRUSH_REQUIRED_SHADER_VERSIONS) {
      const shaderVersions: Record<string, string> = { ...inputs(digestA).shaderVersions };
      delete shaderVersions[version];
      expect(
        buildWaterBrushTerrainManifest(recipe(), { ...inputs(digestA), shaderVersions }).ok,
      ).toBe(false);
    }
  });

  it('migrates legacy source-key actors to typed body actors with stable IDs', () => {
    const legacy = {
      kind: 'water-brush-recipe' as const,
      baseTerrainGuid: bodyOne,
      sourceBodyGuids: [],
      orderedActors: [
        'river/main',
        {
          kind: 'island',
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
              positionM: [x, 0, z] as const,
              arriveTangentM: [1, 0, 0] as const,
              leaveTangentM: [1, 0, 0] as const,
              up: [0, 1, 0] as const,
              rollAngle: 0,
              angleUnit: 'degrees' as const,
              widthM: 0,
              depthM: 0,
              velocityMPerSec: 0,
              audioIntensity: 0,
            })),
          },
          terrainRules: {
            falloffWidthM: 1,
            heightOffsetM: 2.75,
            weightLayer: 'grass',
            weightValue: 1,
          },
        },
      ],
      curves: [],
      textures: [],
      outputTerrainSourceKey: 'terrain/derived',
      rules: {
        falloff: { type: 'width', widthM: 2, strength: 1 },
        blend: { type: 'alpha', alpha: 1 },
        heightRules: { mode: 'offset', offsetM: 0, velocityMPerSec: 0 },
        weightRules: { layer: 'water', value: 1, blend: 'additive' },
      },
    };
    const migrated = migrateWaterBrushRecipeV0ToV1(legacy, recipe().terrainCapture, (key) =>
      key === 'river/main'
        ? { bodyGuid: bodyOne, bodyType: 'river', fullName: '/Game/Water/River_Main' }
        : undefined,
    ).unwrap();
    expect(migrated.actorVersion).toBe(1);
    expect(migrated.orderedActors[0]).toMatchObject({
      kind: 'body',
      actorId: 'river/main',
      bodyGuid: bodyOne,
    });
    expect(migrated.orderedActors[1]).toMatchObject({
      kind: 'island',
      actorId: 'island/one',
      heightOffsetM: 2.75,
      rules: { weightSettings: [expect.objectContaining({ layerName: 'grass', finalOpacity: 1 })] },
    });
    expect(migrated.orderedActors[1]).not.toHaveProperty('terrainRules');
    expect(migrated.sourceBodyGuids).toContain(bodyOne);
    expect(migrated.rules).toEqual({
      falloff: { type: 'width', widthM: 0, strength: 1 },
      blend: { type: 'alpha', alpha: 1 },
      heightRules: { mode: 'offset', offsetM: 0, velocityMPerSec: 0 },
      weightRules: { layer: 'grass', value: 0, blend: 'additive' },
    });
    const malformedLegacy = {
      ...legacy,
      orderedActors: [{ kind: 'body', actorId: 'bad', bodyGuid: bodyOne, rules: actorRules() }],
    } as never;
    const malformed = () =>
      migrateWaterBrushRecipeV0ToV1(malformedLegacy, recipe().terrainCapture, () => ({
        bodyGuid: bodyOne,
        bodyType: 'river',
        fullName: '/Game/Water/River_Main',
      }));
    expect(malformed).not.toThrow();
    expect(malformed().ok).toBe(false);
    const malformedRules = { ...legacy, rules: undefined } as never;
    const rejectsMalformedRules = () =>
      migrateWaterBrushRecipeV0ToV1(malformedRules, recipe().terrainCapture, () => ({
        bodyGuid: bodyOne,
        bodyType: 'river',
        fullName: '/Game/Water/River_Main',
      }));
    expect(rejectsMalformedRules).not.toThrow();
    expect(rejectsMalformedRules().ok).toBe(false);
    const legacyAngle = {
      ...legacy,
      rules: { ...legacy.rules, falloff: { ...legacy.rules.falloff, type: 'angle' } },
    };
    expect(
      migrateWaterBrushRecipeV0ToV1(legacyAngle, recipe().terrainCapture, () => ({
        bodyGuid: bodyOne,
        bodyType: 'river',
        fullName: '/Game/Water/River_Main',
      })),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-source',
        expected: expect.stringContaining('explicit UE angleDegrees'),
      },
    });
    const rejectsChanged = (rules: WaterBrushRecipeAsset['rules']) =>
      expect(
        migrateWaterBrushRecipeV0ToV1({ ...legacy, rules }, recipe().terrainCapture, () => ({
          bodyGuid: bodyOne,
          bodyType: 'river',
          fullName: '/Game/Water/River_Main',
        })).ok,
      ).toBe(false);
    rejectsChanged({ ...legacy.rules, falloff: { ...legacy.rules.falloff, strength: 0.75 } });
    rejectsChanged({ ...legacy.rules, blend: { ...legacy.rules.blend, alpha: 0.5 } });
    rejectsChanged({ ...legacy.rules, heightRules: { ...legacy.rules.heightRules, offsetM: 1 } });
    rejectsChanged({
      ...legacy.rules,
      weightRules: { ...legacy.rules.weightRules, blend: 'replace' },
    });
  });

  it('does not allocate composite velocity-height targets for Island-only recipes', () => {
    const first = islandActor();
    const second = {
      ...islandActor(),
      actorId: 'island/two',
      fullName: '/Game/Water/Island_Two',
      sourceKey: 'island/two',
    };
    const islandRecipe = { ...recipe(), sourceBodyGuids: [], orderedActors: [first, second] };
    const baseInputs = inputs(digestA);
    const manifest = buildWaterBrushTerrainManifest(islandRecipe, {
      ...baseInputs,
      actorInputDigests: { 'island/one': digestA, 'island/two': digestB },
      actorIdentities: {
        'island/one': requiredFixtureValue(baseInputs.actorIdentities['island/one']),
        'island/two': {
          kind: 'island',
          sourceKey: 'island/two',
          fullName: '/Game/Water/Island_Two',
          captureProvenance: islandCaptureProvenance(second, digestB),
        },
      },
    }).unwrap();
    expect(
      manifest.textures.filter(({ name }) => name.startsWith('combined-velocity-height-')),
    ).toEqual([]);
    expect(manifest.actorPassPlan).toHaveLength(2);
    expect(
      manifest.actorPassPlan.every(
        (pass) => !('velocityHeightRead' in pass) && !('velocityHeightWrite' in pass),
      ),
    ).toBe(true);
    expect(manifest.actorCaches.map((cache) => cache.actorId)).toEqual([
      'island/one',
      'island/two',
    ]);
  });

  it('allows height-only actors while preserving every captured Terrain weight layer', () => {
    const source = recipe();
    const orderedActors = source.orderedActors.map((actor) => ({
      ...actor,
      rules: { ...actor.rules, weightSettings: [] },
    }));
    const heightOnlyRecipe = { ...source, orderedActors };
    const manifest = buildWaterBrushTerrainManifest(heightOnlyRecipe, inputs(digestA)).unwrap();
    expect(
      manifest.actorPassPlan.every(
        (pass) => pass.weightPasses.length === 0 && pass.weightLayerNames.length === 0,
      ),
    ).toBe(true);
    expect(manifest.terrainReadbackLayout.weightTexturesByLayer).toEqual({
      grass: expect.any(String),
      water: expect.any(String),
    });
    const terrain = {
      columns: 8,
      rows: 4,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array(32),
      weights: new Float32Array(64),
      layers: [
        { material: 'grass', blend: 'weight' as const },
        { material: 'water', blend: 'weight' as const },
      ],
    };
    const grass = new Float32Array(32).fill(0.2),
      water = new Float32Array(32).fill(0.8);
    const output = applyWaterBrushTerrainReadback(terrain, manifest, {
      widthPx: 8,
      heightPx: 4,
      heightsM: new Float32Array(32),
      weightsByLayer: { grass, water },
    }).unwrap();
    expect([...output.weights.filter((_, index) => index % 2 === 0)]).toEqual([...grass]);
    expect([...output.weights.filter((_, index) => index % 2 === 1)]).toEqual([...water]);
  });

  it('selects UE cache input by raw radius while exposing the actual final ping-pong target', () => {
    for (const enabled of [false, true]) {
      const source = recipe();
      const modified = {
        ...source,
        orderedActors: source.orderedActors.map((actor) =>
          actor.kind === 'body' && actor.actorId === 'water/rivers/one'
            ? { ...actor, rules: { ...actor.rules, blurring: { enabled, radiusPx: 13 } } }
            : actor,
        ),
      };
      const manifest = buildWaterBrushTerrainManifest(modified, inputs(digestA)).unwrap();
      const actorPass = requiredFixtureValue(
        manifest.actorPassPlan.find((pass) => pass.actorId === 'water/rivers/one'),
      );
      expect(actorPass.jumpFloodPassCount).toBe(3);
      expect(actorPass.blurPassCount).toBe(enabled ? 9 : 0);
      expect(actorPass.jumpFloodCachePassIndex).toBe(16);
      expect(actorPass.jumpFloodCacheParity).toBe(0);
      expect(actorPass.jumpFloodCacheTarget).toBe('jump-flood-a');
      expect(actorPass.jumpFloodCacheSelectedTarget).toBe('jump-flood-a');
      expect(actorPass.jumpFloodExecutedFinalTarget).toBe(
        enabled ? 'jump-flood-a' : 'jump-flood-b',
      );
      const cachePixels = selectWaterBrushCacheInput(actorPass, {
        'jump-flood-a': new Float32Array([0.125]),
        'jump-flood-b': new Float32Array([0.875]),
      });
      expect(cachePixels[0]).toBe(0.125);
      const executedPixels =
        actorPass.jumpFloodExecutedFinalTarget === 'jump-flood-a' ? 0.125 : 0.875;
      if (actorPass.jumpFloodCacheSelectedTarget === actorPass.jumpFloodExecutedFinalTarget) {
        expect(cachePixels[0]).toBe(executedPixels);
      } else {
        expect(cachePixels[0]).not.toBe(executedPixels);
      }
    }

    const source = recipe();
    const radiusTen = {
      ...source,
      orderedActors: source.orderedActors.map((actor) =>
        actor.kind === 'body' && actor.actorId === 'water/rivers/one'
          ? { ...actor, rules: { ...actor.rules, blurring: { enabled: true, radiusPx: 10 } } }
          : actor,
      ),
    };
    const actorPass = requiredFixtureValue(
      buildWaterBrushTerrainManifest(radiusTen, inputs(digestA))
        .unwrap()
        .actorPassPlan.find((pass) => pass.actorId === 'water/rivers/one'),
    );
    expect(actorPass.blurPassCount).toBe(9);
    expect(actorPass.jumpFloodCacheSelectedTarget).toBe('jump-flood-b');
    expect(actorPass.jumpFloodExecutedFinalTarget).toBe('jump-flood-a');
    const cachePixels = selectWaterBrushCacheInput(actorPass, {
      'jump-flood-a': new Float32Array([0.125]),
      'jump-flood-b': new Float32Array([0.875]),
    });
    expect(cachePixels[0]).toBe(0.875);
  });

  it('allocates independent ping-pong targets for more than two weight layers', () => {
    const source = recipe();
    const layerNameToIndex = { ...source.terrainCapture.layerNameToIndex, stone: 2 };
    const orderedActors = source.orderedActors.map((actor) =>
      actor.kind === 'body' && actor.actorId === 'water/rivers/one'
        ? {
            ...actor,
            rules: {
              ...actor.rules,
              weightSettings: [
                ...actor.rules.weightSettings,
                {
                  layerName: 'stone',
                  falloffWidthM: 3,
                  edgeOffsetM: 0,
                  textureTiling: 1,
                  textureInfluence: 0,
                  midpoint: 0.5,
                  finalOpacity: 1,
                },
              ],
            },
          }
        : actor,
    );
    const manifest = buildWaterBrushTerrainManifest(
      { ...source, terrainCapture: { ...source.terrainCapture, layerNameToIndex }, orderedActors },
      inputs(digestA),
    ).unwrap();
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({ name: 'weight:stone:ping', format: 'r8unorm' }),
    );
    expect(manifest.textures).toContainEqual(
      expect.objectContaining({ name: 'weight:stone:pong', format: 'r8unorm' }),
    );
    expect(
      manifest.actorPassPlan.find((pass) => pass.actorId === 'water/rivers/one')?.weightPasses,
    ).toContainEqual({ layerName: 'stone', read: 'weight:stone:ping', write: 'weight:stone:pong' });
  });

  it('maps each uniquely valued RT pixel to the matching Terrain vertex after translation and scale', () => {
    const captured = {
      ...recipe(),
      terrainCapture: {
        ...recipe().terrainCapture,
        worldMatrixM: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 10, 0, -4, 1],
      },
    };
    const manifest = buildWaterBrushTerrainManifest(captured, inputs(digestA)).unwrap();
    expect(manifest.pixelCenterMapping.originWorldM).toEqual([10, 0, -4]);
    expect(manifest.pixelCenterMapping.stepWorldXM).toEqual([2, 0, 0]);
    expect(manifest.pixelCenterMapping.stepWorldZM).toEqual([0, 0, 2]);
    const terrain = {
      columns: 8,
      rows: 4,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array(32).fill(-1),
      weights: new Float32Array(64).fill(-1),
      layers: [
        { material: 'grass', blend: 'weight' as const },
        { material: 'water', blend: 'weight' as const },
      ],
    };
    const heightsM = Float32Array.from({ length: 32 }, (_, index) => index + 100);
    const grass = Float32Array.from({ length: 32 }, (_, index) => index / 32);
    const water = Float32Array.from({ length: 32 }, (_, index) => 1 - index / 32);
    const result = applyWaterBrushTerrainReadback(terrain, manifest, {
      widthPx: 8,
      heightPx: 4,
      heightsM,
      weightsByLayer: { grass, water },
    }).unwrap();
    expect([...result.heights]).toEqual([...heightsM]);
    for (let index = 0; index < 32; index++) {
      expect(result.weights[index * 2]).toBe(grass[index]);
      expect(result.weights[index * 2 + 1]).toBe(water[index]);
    }
  });

  it('maps a rotated, non-uniformly scaled Terrain capture without changing local RT sampling', () => {
    const captured = {
      ...recipe(),
      terrainCapture: {
        ...recipe().terrainCapture,
        worldMatrixM: [0, 0, -2, 0, 0, 1, 0, 0, 3, 0, 0, 0, 10, 0, -4, 1],
      },
    };
    const manifest = buildWaterBrushTerrainManifest(captured, inputs(digestA)).unwrap();
    expect(manifest.pixelCenterMapping.originWorldM).toEqual([10, 0, -4]);
    expect(manifest.pixelCenterMapping.stepWorldXM).toEqual([0, 0, -2]);
    expect(manifest.pixelCenterMapping.stepWorldZM).toEqual([3, 0, 0]);
    const terrain = {
      columns: 8,
      rows: 4,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array(32),
      weights: new Float32Array(64),
      layers: [
        { material: 'grass', blend: 'weight' as const },
        { material: 'water', blend: 'weight' as const },
      ],
    };
    const heightsM = Float32Array.from({ length: 32 }, (_, index) => index + 10);
    const result = applyWaterBrushTerrainReadback(terrain, manifest, {
      widthPx: 8,
      heightPx: 4,
      heightsM,
      weightsByLayer: {
        grass: new Float32Array(32).fill(0.25),
        water: new Float32Array(32).fill(0.75),
      },
    }).unwrap();
    expect([...result.heights]).toEqual([...heightsM]);
    expect([...result.weights.filter((_, index) => index % 2 === 0)]).toEqual(
      new Array(32).fill(0.25),
    );
    expect([...result.weights.filter((_, index) => index % 2 === 1)]).toEqual(
      new Array(32).fill(0.75),
    );
  });

  it('rejects a nonfinite Terrain sample mapping before publishing readback', () => {
    const manifest = buildWaterBrushTerrainManifest(recipe(), inputs(digestA)).unwrap();
    const terrain = {
      columns: 8,
      rows: 4,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array(32),
      weights: new Float32Array(64),
      layers: [
        { material: 'grass', blend: 'weight' as const },
        { material: 'water', blend: 'weight' as const },
      ],
    };
    const readback = {
      widthPx: 8,
      heightPx: 4,
      heightsM: new Float32Array(32),
      weightsByLayer: { grass: new Float32Array(32), water: new Float32Array(32) },
    };
    for (const step of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const malformed = {
        ...manifest,
        pixelCenterMapping: {
          ...manifest.pixelCenterMapping,
          stepLocalXZ: [step, 1] as const,
        },
      };
      const result = applyWaterBrushTerrainReadback(terrain, malformed, readback);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-source');
    }
    expect(terrain.heights.every((value) => value === 0)).toBe(true);
  });

  it('resamples readback at Terrain vertices and preserves explicit named-layer indices', () => {
    const captured = {
      ...recipe(),
      terrainCapture: {
        ...recipe().terrainCapture,
        boundsXZ: { minM: [-1, -0.5] as const, maxM: [3, 1.5] as const },
        resolutionPx: [2, 2] as const,
      },
    };
    const manifest = buildWaterBrushTerrainManifest(captured, inputs(digestA)).unwrap();
    const terrain = {
      columns: 3,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array(6).fill(0),
      weights: new Float32Array(12).fill(0),
      layers: [
        { material: 'grass', blend: 'weight' as const },
        { material: 'water', blend: 'weight' as const },
      ],
    };
    const output = applyWaterBrushTerrainReadback(terrain, manifest, {
      widthPx: 2,
      heightPx: 2,
      heightsM: new Float32Array([10, 20, 10, 20]),
      weightsByLayer: {
        grass: new Float32Array([0.1, 0.2, 0.1, 0.2]),
        water: new Float32Array([0.7, 0.8, 0.7, 0.8]),
      },
    }).unwrap();
    expect([...output.heights]).toEqual([10, 15, 20, 10, 15, 20]);
    [...output.weights.filter((_, index) => index % 2 === 0)].forEach((value, index) => {
      expect(value).toBeCloseTo(requiredFixtureValue([0.1, 0.15, 0.2, 0.1, 0.15, 0.2][index]), 6);
    });
    [...output.weights.filter((_, index) => index % 2 === 1)].forEach((value, index) => {
      expect(value).toBeCloseTo(requiredFixtureValue([0.7, 0.75, 0.8, 0.7, 0.75, 0.8][index]), 6);
    });
    expect(
      applyWaterBrushTerrainReadback(
        { ...terrain, columns: 4, heights: new Float32Array(8), weights: new Float32Array(16) },
        manifest,
        {
          widthPx: 2,
          heightPx: 2,
          heightsM: new Float32Array(4),
          weightsByLayer: { grass: new Float32Array(4), water: new Float32Array(4) },
        },
      ).ok,
    ).toBe(false);
    expect(
      applyWaterBrushTerrainReadback(terrain, manifest, {
        widthPx: 2,
        heightPx: 2,
        heightsM: new Float32Array([Number.NaN, 20, 10, 20]),
        weightsByLayer: { grass: new Float32Array(4), water: new Float32Array(4) },
      }).ok,
    ).toBe(false);
    expect(
      applyWaterBrushTerrainReadback(terrain, manifest, {
        widthPx: 2,
        heightPx: 2,
        heightsM: new Float32Array(4),
        weightsByLayer: { grass: new Float32Array([0, 0, 0, 2]), water: new Float32Array(4) },
      }).ok,
    ).toBe(false);
  });
});
