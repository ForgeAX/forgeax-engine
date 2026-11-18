import { createBoxGeometry, decodeMeshBinary, packMeshBin } from '@forgeax/engine-geometry';
import { definePackageId } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { canonicalJson } from '@forgeax/engine-types';
import {
  buildWaterPackOutputs,
  type WaterBodyAsset,
  type WaterBrushActorCacheManifest,
  type WaterBrushTerrainManifest,
  waterBrushBodyCaptureInputDigest,
  waterBrushDepthVelocityDigest,
  waterBrushIslandSplineDigest,
} from '@forgeax/engine-water';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { expect, it } from 'vitest';
import {
  validateWaterBrushFrozenActor,
  type WaterBrushFrozenActorInput,
} from '../water-brush/capture-input.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const idA = '019a0000-0000-7000-8000-000000000001';
const idB = '019a0000-0000-7000-8000-000000000002';
const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const spline = {
  closed: false,
  points: [0, 1, 2].map((inputKey) => ({
    inputKey,
    positionM: [inputKey, 1, 0] as const,
    arriveTangentM: [1, 0, 0] as const,
    leaveTangentM: [1, 0, 0] as const,
    up: [0, 1, 0] as const,
    rollAngle: 0,
    angleUnit: 'degrees' as const,
    widthM: 5,
    depthM: 2,
    velocityMPerSec: 3,
    audioIntensity: 0,
  })),
};
const mesh = createBoxGeometry(1, 1, 1).unwrap();
const payload = packMeshBin(mesh, 'water-brush').unwrap();
const sourceBody = {
  kind: 'water-body' as const,
  type: 'river' as const,
  surfaceMaterialGuid: idA,
  spline: {
    closed: false,
    points: [0, 1, 2].map((inputKey) => ({
      inputKey,
      positionM: [inputKey, 1, 0] as const,
      arriveTangentM: [1, 0, 0] as const,
      leaveTangentM: [1, 0, 0] as const,
      up: [0, 1, 0] as const,
      rollAngle: 0,
      angleUnit: 'degrees' as const,
      widthM: 5,
      depthM: 2,
      velocityMPerSec: 3,
      audioIntensity: 0,
    })),
  },
  baseHeightM: 1,
  overlapPriority: 0,
  maxWaveHeightM: 0,
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'river-prism' as const, enabled: true },
  queryFootprint: [
    [0, 0],
    [1, 0],
    [1, 1],
  ] as const,
};
const sha = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const cache = (
  overrides: Partial<WaterBrushActorCacheManifest> = {},
  bodyAsset?: WaterBodyAsset,
  sourceBytes = payload,
  meshBytes: readonly Uint8Array[] = [payload, payload],
): WaterBrushActorCacheManifest => ({
  actorId: 'river/main',
  actorCapture: {
    kind: 'body',
    bodyGuid: idA,
    bodyType: 'river',
    spline: bodyAsset?.spline ?? spline,
  },
  inputDigest: 'a'.repeat(64),
  sourceInputDigest: bodyAsset ? waterBrushBodyCaptureInputDigest(bodyAsset) : sha(sourceBytes),
  captureProvenance: {
    source: 'pack-mesh',
    sourcePayloadDigest: sha(sourceBytes),
    riverSegmentMeshes: [
      {
        segmentIndex: 0,
        meshGuid: bodyAsset?.riverSegmentMeshGuids?.[0] ?? idA,
        meshDigest: sha(meshBytes[0] ?? payload),
      },
      {
        segmentIndex: 1,
        meshGuid: bodyAsset?.riverSegmentMeshGuids?.[1] ?? idB,
        meshDigest: sha(meshBytes[1] ?? payload),
      },
    ],
    worldMatrixM: matrix,
    depthVelocityDigest: waterBrushDepthVelocityDigest(bodyAsset?.spline ?? spline),
  },
  cacheKey: 'b'.repeat(64),
  textures: [],
  ...overrides,
});
const manifest = (actorCache: WaterBrushActorCacheManifest) =>
  ({ actorCaches: [actorCache] }) as unknown as WaterBrushTerrainManifest;

async function riverFixture(shapeDilationM = 0) {
  const packed = await buildWaterPackOutputs(
    { 'river/main': { ...sourceBody, shapeDilationM } },
    { packageId: definePackageId('019a0000-0000-7000-8000-000000000496') },
  );
  if (!packed.ok) throw new Error('Water body fixture failed to cook');
  const body = packed.value['river/main'] as WaterBodyAsset;
  const sourcePayloadBytes = new TextEncoder().encode(canonicalJson(body));
  const meshes = requiredFixtureValue(body.riverSegmentMeshGuids).map((meshGuid, index) => {
    const asset = packed.value[`river/main/river-segment/${index}`] as MeshAsset;
    const refs = asset.materialSlots.flatMap((slot) => {
      if (slot.defaultMaterial === undefined) return [];
      if (!(slot.defaultMaterial instanceof Uint8Array))
        throw new Error('Cooked mesh default material must be an asset GUID');
      return [AssetGuid.format(slot.defaultMaterial)];
    });
    return { meshGuid, payloadBytes: packMeshBin(asset, `river/${index}`, refs).unwrap(), refs };
  });
  return { body, sourcePayloadBytes, meshes };
}

it('recooks shape dilation without changing the canonical capture projection', async () => {
  const first = await riverFixture(0);
  const second = await riverFixture(12.5);
  const firstRecord = first.body as unknown as Record<string, unknown>;
  const secondRecord = second.body as unknown as Record<string, unknown>;
  const changedFields = [
    ...new Set([...Object.keys(firstRecord), ...Object.keys(secondRecord)]),
  ].filter((key) => canonicalJson(firstRecord[key]) !== canonicalJson(secondRecord[key]));
  expect(changedFields.sort()).toEqual(['dilatedWaterInfoMeshGuid', 'shapeDilationM']);
  expect(waterBrushBodyCaptureInputDigest(first.body)).toBe(
    waterBrushBodyCaptureInputDigest(second.body),
  );
  expect(sha(first.sourcePayloadBytes)).not.toBe(sha(second.sourcePayloadBytes));
  expect(second.body.riverSegmentMeshGuids).toEqual(first.body.riverSegmentMeshGuids);
  expect(second.body.geometrySnapshot).toEqual(first.body.geometrySnapshot);
});

function riverInput(
  fixture: Awaited<ReturnType<typeof riverFixture>>,
  overrides: Partial<Extract<WaterBrushFrozenActorInput, { kind: 'body' }>> = {},
): Extract<WaterBrushFrozenActorInput, { kind: 'body' }> {
  return {
    kind: 'body',
    actorId: 'river/main',
    bodyGuid: idA,
    sourcePayloadBytes: fixture.sourcePayloadBytes,
    meshes: fixture.meshes,
    ...overrides,
  };
}

it('accepts frozen Body JSON bytes and ordered Pack segment mesh payloads after digest and structure checks', async () => {
  const fixture = await riverFixture();
  const actorCache = cache(
    {},
    fixture.body,
    fixture.sourcePayloadBytes,
    fixture.meshes.map((item) => item.payloadBytes),
  );
  const result = validateWaterBrushFrozenActor(manifest(actorCache), riverInput(fixture), 7);
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  if (result.ok) {
    expect(result.value).toMatchObject({
      actorId: 'river/main',
      kind: 'body',
      captureGeneration: 7,
      worldMatrixM: matrix,
    });
    expect(result.value.body).toEqual(fixture.body);
    const decoded = requiredFixtureValue(result.value.packMeshes[0]).decoded;
    expect(decoded.attributes.color).toBeDefined();
    const positions = requiredFixtureValue(decoded.attributes.position);
    if (!(positions instanceof Float32Array)) throw new Error('Decoded positions must be float32');
    expect(decoded.vertices.length / 16).toBe(positions.length / 3);
    expect(result.value.packMeshes[0]?.decoded.vertices).toEqual(
      decodeMeshBinary(
        requiredFixtureValue(fixture.meshes[0]).payloadBytes,
        requiredFixtureValue(fixture.meshes[0]).refs,
      )?.vertices,
    );
  }
});

it('rejects changed source bytes, wrong mesh order/GUIDs and ignores caller-supplied decoded meshes', async () => {
  const fixture = await riverFixture();
  const actorCache = cache(
    {},
    fixture.body,
    fixture.sourcePayloadBytes,
    fixture.meshes.map((item) => item.payloadBytes),
  );
  expect(
    validateWaterBrushFrozenActor(
      manifest(actorCache),
      riverInput(fixture, { sourcePayloadBytes: Uint8Array.of(9) }),
      1,
    ).ok,
  ).toBe(false);
  const otherValidBodyBytes = new TextEncoder().encode(
    canonicalJson({ ...fixture.body, overlapPriority: fixture.body.overlapPriority + 1 }),
  );
  expect(
    validateWaterBrushFrozenActor(
      manifest(actorCache),
      riverInput(fixture, { sourcePayloadBytes: otherValidBodyBytes }),
      1,
    ).ok,
  ).toBe(false);
  expect(
    validateWaterBrushFrozenActor(
      manifest(actorCache),
      riverInput(fixture, { meshes: [...fixture.meshes].reverse() }),
      1,
    ).ok,
  ).toBe(false);
  expect(
    validateWaterBrushFrozenActor(manifest(actorCache), riverInput(fixture, { bodyGuid: idB }), 1)
      .ok,
  ).toBe(false);
  const unrelated = createBoxGeometry(2, 1, 1).unwrap();
  const meshes = fixture.meshes.map((item) => ({
    ...item,
    decoded: unrelated,
  })) as unknown as Extract<WaterBrushFrozenActorInput, { kind: 'body' }>['meshes'];
  const result = validateWaterBrushFrozenActor(
    manifest(actorCache),
    riverInput(fixture, { meshes }),
    1,
  );
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  if (result.ok)
    expect(result.value.packMeshes[0]?.decoded.vertices).toEqual(
      decodeMeshBinary(
        requiredFixtureValue(fixture.meshes[0]).payloadBytes,
        requiredFixtureValue(fixture.meshes[0]).refs,
      )?.vertices,
    );
});

it('rejects frozen mesh bytes whose default material references are missing', async () => {
  const fixture = await riverFixture();
  const actorCache = cache(
    {},
    fixture.body,
    fixture.sourcePayloadBytes,
    fixture.meshes.map((item) => item.payloadBytes),
  );
  const meshes = fixture.meshes.map((item) => ({ ...item, refs: [] }));
  expect(
    validateWaterBrushFrozenActor(manifest(actorCache), riverInput(fixture, { meshes }), 1).ok,
  ).toBe(false);
});

it('validates Island input from its frozen recipe spline and height offset without caller meshes', () => {
  const islandSpline = { ...spline, closed: true };
  const actorCache = {
    ...cache(),
    actorId: 'island/one',
    actorCapture: {
      kind: 'island' as const,
      sourceKey: 'island/one',
      heightOffsetM: 0.25,
      spline: islandSpline,
    },
    captureProvenance: {
      source: 'island-spline' as const,
      splineDigest: waterBrushIslandSplineDigest(islandSpline),
      shapeMeshDigest: 'c'.repeat(64),
      shapeGeneratorVersion: 'island-spline-shape/1',
      worldMatrixM: matrix,
      depthVelocityDigest: waterBrushDepthVelocityDigest(islandSpline),
    },
  };
  const input: WaterBrushFrozenActorInput = {
    kind: 'island',
    actorId: 'island/one',
    sourceKey: 'island/one',
    spline: islandSpline,
    heightOffsetM: 0.25,
  };
  expect(validateWaterBrushFrozenActor(manifest(actorCache), input, 3).ok).toBe(true);
  expect(
    validateWaterBrushFrozenActor(manifest(actorCache), { ...input, heightOffsetM: 0.5 }, 3).ok,
  ).toBe(false);
});
