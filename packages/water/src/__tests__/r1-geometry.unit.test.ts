import { readFileSync } from 'node:fs';
import { createBoxGeometry, withVertexColors } from '@forgeax/engine-geometry';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import type { MeshAsset, WaterBodyAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  buildRiverPhysicsCandidateInput,
  buildWaterBodyGeometry,
  flattenSplineSegments,
  riverSplineCollisionConvexes,
  sampleSplineSegments,
  type WaterBodyGeometry,
  waterBodyCollisionDescriptor,
} from '../body-geometry.js';
import {
  deleteWaterSplinePoint,
  duplicateWaterSplinePoint,
  duplicateWaterSplinePointInSpline,
  fixupWaterSpline,
  insertWaterSplinePoint,
  insertWaterSplinePointInSpline,
  migrateLegacyWaterSplineMetadataDefaults,
  propagateWaterSplineDefaultValue,
  resolveWaterSplinePoints,
} from '../body-spline.js';
import type { WaterBodySourceAsset } from '../contracts.js';
import { buildWaterPackOutputs } from '../pack-cook.js';
import { buildWaterPhysicsCandidateInput, waterBodyQueryPrismParts } from '../physics-candidate.js';
import { WaterSystem } from '../system.js';
import {
  validateWaterAsset,
  validateWaterRuntimeAsset,
  validateWaterRuntimeBody,
  waterQueryVolume,
} from '../validate.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const point = (
  inputKey: number,
  x: number,
  z: number,
  patch: Partial<WaterBodySourceAsset['spline']['points'][number]> = {},
) => ({
  inputKey,
  positionM: [x, 2, z] as const,
  arriveTangentM: [1, 0, 0] as const,
  leaveTangentM: [1, 0, 0] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 4,
  depthM: 3,
  velocityMPerSec: 1,
  audioIntensity: 0,
  ...patch,
});
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const riverMeshBodySetupEvidence = JSON.parse(
  readFileSync(new URL('./fixtures/ue-5.8.1-river-mesh-bodysetup.json', import.meta.url), 'utf8'),
) as {
  readonly engine: string;
  readonly units: string;
  readonly convexCount: number;
  readonly convexElements: readonly Readonly<{
    index: number;
    identityTransform: boolean;
    localVerticesCm: readonly (readonly [number, number, number])[];
  }>[];
};
const transformNoScale = (matrix: readonly number[], point: readonly number[]) => {
  const lengths = [0, 1, 2].map((column) =>
    Math.hypot(
      requiredFixtureValue(matrix[column * 4]),
      requiredFixtureValue(matrix[column * 4 + 1]),
      requiredFixtureValue(matrix[column * 4 + 2]),
    ),
  );
  return [0, 1, 2].map((row) =>
    [0, 1, 2].reduce(
      (sum, column) =>
        sum +
        (requiredFixtureValue(matrix[column * 4 + row]) / requiredFixtureValue(lengths[column])) *
          requiredFixtureValue(point[column]),
      requiredFixtureValue(matrix[12 + row]),
    ),
  );
};
const body = (
  type: WaterBodySourceAsset['type'],
  points: readonly WaterBodySourceAsset['spline']['points'][number][],
  closed = type === 'lake' || type === 'ocean',
): WaterBodySourceAsset => ({
  kind: 'water-body',
  type,
  spline: { closed, points },
  baseHeightM: 2,
  overlapPriority: 0,
  maxWaveHeightM: 1,
  surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: true },
  collision: {
    type: type === 'river' ? 'river-prism' : 'polygon',
    enabled: true,
    ...(type === 'lake' ? { channelDepthM: 6 } : {}),
    ...(type === 'ocean'
      ? { collisionHalfHeightM: 20, collisionHalfExtentsM: [20, 20] as const }
      : {}),
  },
  queryFootprint: [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
  ],
});
const loop = (positions: readonly (readonly [number, number])[]) =>
  positions.map(([x, z], inputKey) =>
    point(inputKey, x, z, { arriveTangentM: [0, 0, 0], leaveTangentM: [0, 0, 0] }),
  );
const areaXZ = (mesh: MeshAsset | undefined) => {
  if (!mesh?.indices) return 0;
  const positions = mesh.attributes.position as Float32Array;
  let area = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = requiredFixtureValue(mesh.indices[i]) * 3,
      b = requiredFixtureValue(mesh.indices[i + 1]) * 3,
      c = requiredFixtureValue(mesh.indices[i + 2]) * 3;
    area +=
      Math.abs(
        (requiredFixtureValue(positions[b]) - requiredFixtureValue(positions[a])) *
          (requiredFixtureValue(positions[c + 2]) - requiredFixtureValue(positions[a + 2])) -
          (requiredFixtureValue(positions[b + 2]) - requiredFixtureValue(positions[a + 2])) *
            (requiredFixtureValue(positions[c]) - requiredFixtureValue(positions[a])),
      ) / 2;
  }
  return area;
};

describe('water R1 body geometry', () => {
  it('keeps every default River spline mesh triangle front-facing', () => {
    const river = body('river', [point(0, 0, 0), point(1, 8, 0)], false);
    const geometry = buildWaterBodyGeometry(river);
    expect(geometry.ok).toBe(true);
    if (!geometry.ok) return;
    const mesh = geometry.value.riverSegments[0]?.visibleMesh;
    expect(mesh).toBeDefined();
    if (!mesh) return;
    const positions = mesh.attributes.position as Float32Array;
    const indices = requiredFixtureValue(mesh.indices);
    const yNormals = [];
    for (let index = 0; index < indices.length; index += 3) {
      const a = requiredFixtureValue(indices[index]) * 3,
        b = requiredFixtureValue(indices[index + 1]) * 3,
        c = requiredFixtureValue(indices[index + 2]) * 3;
      const abx = requiredFixtureValue(positions[b]) - requiredFixtureValue(positions[a]),
        abz = requiredFixtureValue(positions[b + 2]) - requiredFixtureValue(positions[a + 2]);
      const acx = requiredFixtureValue(positions[c]) - requiredFixtureValue(positions[a]),
        acz = requiredFixtureValue(positions[c + 2]) - requiredFixtureValue(positions[a + 2]);
      yNormals.push(abz * acx - abx * acz);
    }
    expect(yNormals.every((normal) => normal > 0)).toBe(true);
  });

  it('preserves simple River query contours and millimeter coordinates without union quantization', () => {
    const river = body(
      'river',
      [
        point(0, 0, 0, { positionM: [0.001, 2, 0], widthM: 4.001 }),
        point(1, 8, 0, { positionM: [8.001, 2, 0], widthM: 4.001 }),
      ],
      false,
    );
    const geometry = buildWaterBodyGeometry(river).unwrap();
    const outer = geometry.queryFootprint.outer;
    expect(outer[0]).toEqual([0.001, 2.0005]);
    expect(outer.at(-1)).toEqual([0.001, -2.0005]);
    const area =
      Math.abs(
        outer.reduce((sum, current, index) => {
          const next = requiredFixtureValue(outer[(index + 1) % outer.length]);
          return sum + current[0] * next[1] - next[0] * current[1];
        }, 0),
      ) / 2;
    expect(area).toBeCloseTo(32.008, 5);
  });

  it('keeps every Ocean stitch triangle front-facing around the central island hole', () => {
    const ocean = {
      ...body(
        'ocean',
        loop([
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]),
      ),
      oceanExtentM: [14, 10] as const,
      collision: { type: 'none' as const, enabled: false },
    };
    const geometry = buildWaterBodyGeometry(ocean);
    expect(geometry.ok).toBe(true);
    if (!geometry.ok || !geometry.value.visibleMesh) return;
    const positions = geometry.value.visibleMesh.attributes.position as Float32Array;
    const indices = requiredFixtureValue(geometry.value.visibleMesh.indices);
    const yNormals = [];
    for (let index = 0; index < indices.length; index += 3) {
      const a = requiredFixtureValue(indices[index]) * 3,
        b = requiredFixtureValue(indices[index + 1]) * 3,
        c = requiredFixtureValue(indices[index + 2]) * 3;
      const abx = requiredFixtureValue(positions[b]) - requiredFixtureValue(positions[a]),
        abz = requiredFixtureValue(positions[b + 2]) - requiredFixtureValue(positions[a + 2]);
      const acx = requiredFixtureValue(positions[c]) - requiredFixtureValue(positions[a]),
        acz = requiredFixtureValue(positions[c + 2]) - requiredFixtureValue(positions[a + 2]);
      yNormals.push(abz * acx - abx * acz);
    }
    expect(yNormals.length).toBeGreaterThan(0);
    expect(yNormals.every((normal) => normal > 0)).toBe(true);
    const quads = [
      [
        [-1.01, 1.01],
        [1.01, 1.01],
        [1.01, 5],
        [-1.01, 5],
      ],
      [
        [1.01, -1.01],
        [1.01, 1.01],
        [7, 1.01],
        [7, -1.01],
      ],
      [
        [-1.01, -1.01],
        [1.01, -1.01],
        [1.01, -5],
        [-1.01, -5],
      ],
      [
        [-7, -1.01],
        [-7, 1.01],
        [-1.01, 1.01],
        [-1.01, -1.01],
      ],
      [
        [-7, 1.01],
        [-1.01, 1.01],
        [-1.01, 5],
        [-7, 5],
      ],
      [
        [1.01, 1.01],
        [7, 1.01],
        [7, 5],
        [1.01, 5],
      ],
      [
        [1.01, -5],
        [7, -5],
        [7, -1.01],
        [1.01, -1.01],
      ],
      [
        [-7, -5],
        [-1.01, -5],
        [-1.01, -1.01],
        [-7, -1.01],
      ],
    ] as const;
    const firstQuadIndex = indices.length - quads.length * 6;
    for (const [quadIndex, quad] of quads.entries()) {
      const pair = Array.from(
        indices.slice(firstQuadIndex + quadIndex * 6, firstQuadIndex + quadIndex * 6 + 6),
      );
      const common = pair.slice(0, 3).filter((vertex) => pair.slice(3).includes(vertex));
      expect(
        common
          .map((vertex) => [
            Number(requiredFixtureValue(positions[vertex * 3]).toFixed(2)),
            Number(requiredFixtureValue(positions[vertex * 3 + 2]).toFixed(2)),
          ])
          .sort(),
      ).toEqual([quad[1], quad[3]].sort());
      const vertexPoints = pair.map(
        (vertex) =>
          [
            requiredFixtureValue(positions[vertex * 3]),
            requiredFixtureValue(positions[vertex * 3 + 2]),
          ] as const,
      );
      expect(new Set(vertexPoints.map(([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`))).toEqual(
        new Set(quad.map(([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`)),
      );
      const triangleArea = (triangle: readonly (readonly [number, number])[]) =>
        Math.abs(
          (requiredFixtureValue(triangle[1])[0] - requiredFixtureValue(triangle[0])[0]) *
            (requiredFixtureValue(triangle[2])[1] - requiredFixtureValue(triangle[0])[1]) -
            (requiredFixtureValue(triangle[1])[1] - requiredFixtureValue(triangle[0])[1]) *
              (requiredFixtureValue(triangle[2])[0] - requiredFixtureValue(triangle[0])[0]),
        ) / 2;
      const actualArea =
        triangleArea(vertexPoints.slice(0, 3)) + triangleArea(vertexPoints.slice(3, 6));
      const expectedArea =
        Math.abs(
          quad.reduce((sum, [x, z], index) => {
            const [nextX, nextZ] = requiredFixtureValue(quad[(index + 1) % quad.length]);
            return sum + x * nextZ - z * nextX;
          }, 0),
        ) / 2;
      expect(actualArea).toBeCloseTo(expectedArea, 5);
    }
  });

  it('encloses Hermite River height and depth extrema between control points', async () => {
    const high = {
      ...body('river', [
        point(0, 0, 0, { positionM: [0, 0, 0], leaveTangentM: [1, 10, 0], depthM: 1 }),
        point(1, 1, 0, { positionM: [1, 0, 0], arriveTangentM: [1, -10, 0], depthM: 1 }),
      ]),
      maxWaveHeightM: 0,
    };
    const low = {
      ...body('river', [
        point(0, 0, 0, { positionM: [0, 0, 0], leaveTangentM: [1, -10, 0], depthM: 1 }),
        point(1, 1, 0, { positionM: [1, 0, 0], arriveTangentM: [1, 10, 0], depthM: 1 }),
      ]),
      maxWaveHeightM: 0,
    };
    expect(waterQueryVolume(high)).toEqual({ version: 1, minimumYM: -1, maximumYM: 2.5 });
    expect(waterQueryVolume(low)).toEqual({ version: 1, minimumYM: -3.5, maximumYM: 0 });

    const varyingDepth = {
      ...body('river', [
        point(0, 0, 0, { positionM: [0, 0, 0], leaveTangentM: [1, 0, 0], depthM: 0 }),
        point(1, 1, 0, { positionM: [1, 0, 0], arriveTangentM: [1, 10, 0], depthM: 2 }),
      ]),
      maxWaveHeightM: 0,
    };
    expect(waterQueryVolume(varyingDepth).minimumYM).toBeLessThan(-2.9);

    const packed = await buildWaterPackOutputs(
      { river: high },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.river?.kind !== 'water-body') return;
    expect(packed.value.river.geometrySnapshot?.queryVolume).toMatchObject({
      minimumYM: -1,
      maximumYM: 2.5,
    });
  });

  it('publishes digest-verified query and collision snapshots and rejects source spoofing', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000299');
    const lake = body(
      'lake',
      loop([
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
      ]),
    );
    const packed = await buildWaterPackOutputs({ 'lake/snapshot': lake }, { packageId });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const cooked = packed.value['lake/snapshot'];
    expect(cooked?.kind).toBe('water-body');
    if (cooked?.kind !== 'water-body') return;
    expect(cooked.geometrySnapshot).toMatchObject({
      queryFootprint: {
        version: 1,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        outer: expect.any(Array),
        holes: [],
      },
      queryVolume: {
        version: 1,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        minimumYM: expect.any(Number),
        maximumYM: expect.any(Number),
      },
      collisionDescriptor: {
        version: 1,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        minimumYM: -4,
        maximumYM: 2,
      },
    });
    expect(cooked.geometrySnapshot?.collisionDescriptor?.riverSegmentConvexes).toBeUndefined();
    const modified = {
      ...cooked,
      geometrySnapshot: {
        ...requiredFixtureValue(cooked.geometrySnapshot),
        queryFootprint: {
          ...requiredFixtureValue(cooked.geometrySnapshot).queryFootprint,
          outer: [
            [-3, -2],
            [2, -2],
            [2, 2],
            [-3, 2],
          ] as const,
        },
      },
    };
    expect(validateWaterRuntimeAsset(modified).ok).toBe(false);

    const forged = {
      ...lake,
      visibleMeshGuid: '00000000-0000-7000-8000-000000000001',
      geometrySnapshot: cooked.geometrySnapshot,
    };
    const rejected = await buildWaterPackOutputs({ 'lake/forged': forged }, { packageId });
    expect(rejected.ok).toBe(false);
  });

  it('publishes River collision convex inputs in the signed Pack descriptor', async () => {
    const river = body('river', [point(0, 0, 0), point(1, 8, 0)]);
    const packed = await buildWaterPackOutputs(
      { river },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const cooked = packed.value.river;
    expect(cooked?.kind).toBe('water-body');
    if (cooked?.kind !== 'water-body') return;
    expect(cooked.geometrySnapshot?.collisionDescriptor?.riverSegmentConvexes?.[0]).toHaveLength(4);
    expect(validateWaterRuntimeAsset(cooked).ok).toBe(true);
    const descriptor = cooked.geometrySnapshot?.collisionDescriptor;
    if (descriptor?.version !== 2)
      throw new Error('River fixture requires the closed collision descriptor');
    const malformed = {
      ...cooked,
      geometrySnapshot: {
        ...requiredFixtureValue(cooked.geometrySnapshot),
        collisionDescriptor: Object.assign({}, descriptor, { customMesh: undefined }),
      },
    };
    expect(validateWaterRuntimeAsset(malformed).ok).toBe(false);
  });

  it('matches all exported UE RiverMesh BodySetup convex vertices after spline scaling', () => {
    expect(riverMeshBodySetupEvidence).toMatchObject({
      engine: 'UE 5.8.1 CL 56057345',
      units: 'cm',
      convexCount: 4,
    });
    expect(
      riverMeshBodySetupEvidence.convexElements.every(
        (convex) => convex.identityTransform && convex.localVerticesCm.length === 8,
      ),
    ).toBe(true);
    const points = resolveWaterSplinePoints({
      closed: false,
      points: [
        point(0, 0, 0, {
          positionM: [0, 2, 0],
          leaveTangentM: [8, 0, 0],
          arriveTangentM: [8, 0, 0],
          widthM: 4,
          depthM: 3,
        }),
        point(1, 8, 0, {
          positionM: [8, 2, 0],
          leaveTangentM: [8, 0, 0],
          arriveTangentM: [8, 0, 0],
          widthM: 4,
          depthM: 3,
        }),
      ],
    });
    const actualHulls = riverSplineCollisionConvexes(
      requiredFixtureValue(points[0]),
      requiredFixtureValue(points[1]),
    );
    const vertexKey = (vertex: readonly number[]) =>
      vertex.map((value) => Number(value.toFixed(5))).join(',');
    for (const evidence of riverMeshBodySetupEvidence.convexElements) {
      const actual = requiredFixtureValue(actualHulls[evidence.index]);
      const actualVertices = Array.from({ length: actual.length / 3 }, (_, index) => [
        requiredFixtureValue(actual[index * 3]),
        requiredFixtureValue(actual[index * 3 + 1]),
        requiredFixtureValue(actual[index * 3 + 2]),
      ]);
      const expectedVertices = evidence.localVerticesCm.map(([x, y, z]) => [
        x * 8,
        2 + z * 3,
        y * 4,
      ]);
      expect(actualVertices.map(vertexKey).sort()).toEqual(expectedVertices.map(vertexKey).sort());
    }
  });

  it('bounds varying-height River collision from emitted convexes and agrees with query and Physics', async () => {
    const source = {
      ...body('river', [
        point(0, 0, 0, { positionM: [0, 0, 0], leaveTangentM: [4, 12, 0], widthM: 3, depthM: 1 }),
        point(1, 8, 3, { positionM: [8, 7, 3], arriveTangentM: [4, -2, 0], widthM: 6, depthM: 4 }),
        point(2, 12, 4, {
          positionM: [12, 4, 4],
          arriveTangentM: [3, -5, 1],
          widthM: 4,
          depthM: 2,
        }),
      ]),
      maxWaveHeightM: 0,
    };
    const packed = await buildWaterPackOutputs(
      { river: source },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.river?.kind !== 'water-body') return;
    const cooked = packed.value.river;
    const descriptor = cooked.geometrySnapshot?.collisionDescriptor;
    expect(descriptor?.riverSegmentConvexes).toBeDefined();
    if (!descriptor?.riverSegmentConvexes) return;
    const emitted = descriptor.riverSegmentConvexes.flat(2);
    const minY = Math.min(...emitted.map((vertex) => vertex[1]));
    const maxY = Math.max(...emitted.map((vertex) => vertex[1]));
    expect(descriptor.minimumYM).toBeCloseTo(minY, 6);
    expect(descriptor.maximumYM).toBeCloseTo(maxY, 6);
    expect(descriptor.minimumYM).not.toBe(
      source.baseHeightM - Math.max(...source.spline.points.map((entry) => entry.depthM)),
    );

    const query = cooked.geometrySnapshot?.queryVolume;
    expect(query?.minimumYM).toBeLessThanOrEqual(minY);
    expect(query?.maximumYM).toBeGreaterThanOrEqual(maxY);
    const candidate = buildWaterPhysicsCandidateInput({
      entity: 1,
      sourceKey: 'river/test',
      revision: 1,
      body: cooked,
      bodyWorldMatrixM: identity,
      exclusionVolumes: [],
    }).unwrap();
    const pieces = candidate.shapes[0];
    expect(pieces?.kind).toBe('convex-compound');
    if (pieces?.kind !== 'convex-compound') return;
    const physicsY = pieces.pieces.flatMap((piece) =>
      Array.from(piece).filter((_, index) => index % 3 === 1),
    );
    expect(Math.min(...physicsY)).toBeCloseTo(minY, 6);
    expect(Math.max(...physicsY)).toBeCloseTo(maxY, 6);
    expect(validateWaterRuntimeAsset(cooked).ok).toBe(true);
  });

  it('retains the complete Cooked River affine matrix as its source-owned Physics authority', async () => {
    const matrix = [0, 1, 0, 0, -2, 0.5, 0, 0, -0.3, 0.25, 3, 0, 4, 5, 6, 1] as const;
    const source = body('river', [
      point(0, 0, 0, { leaveTangentM: [4, 0, 0] }),
      point(1, 4, 0, { arriveTangentM: [4, 0, 0] }),
    ]);
    const packed = await buildWaterPackOutputs(
      { river: source },
      {
        packageId: definePackageId('019a0000-0000-7000-8000-000000000299'),
        bodyWorldTransformsM: { river: matrix },
      },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.river?.kind !== 'water-body') return;
    const candidate = buildWaterPhysicsCandidateInput({
      entity: 31,
      sourceKey: 'river:affine',
      revision: 1,
      body: packed.value.river,
      bodyWorldMatrixM: matrix,
      exclusionVolumes: [],
    });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(candidate.value.sourceTransform?.sceneMatrix).toEqual(
      Array.from(Float32Array.from(matrix)),
    );
    expect(candidate.value.sourceTransform?.sceneMatrix[4]).toBe(-2);
    expect(candidate.value.sourceTransform?.sceneMatrix[8]).toBeCloseTo(-0.3, 6);
    expect(candidate.value.sourceTransform?.sceneMatrix[9]).toBe(0.25);
  });

  it.each([
    [0, 1, 0, 0, -2, 0.5, 0, 0, -0.3, 0.25, 3, 0, 4, 5, 6, 1],
    [-2, 0, 0, 0, 0.5, 3, 0, 0, 0.25, -0.3, 1, 0, 4, 5, 6, 1],
  ])('projects Cooked River affine geometry into a borrowed rigid pose (%j)', async (...matrix) => {
    const source = body('river', [
      point(0, 0, 0, { leaveTangentM: [4, 0, 0] }),
      point(1, 4, 0, { arriveTangentM: [4, 0, 0] }),
    ]);
    const packed = await buildWaterPackOutputs(
      { river: source },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const cooked: unknown = packed.value.river;
    expect(validateWaterRuntimeBody(cooked).ok).toBe(true);
    const input = {
      entity: 32,
      sourceKey: 'river:borrowed',
      revision: 1,
      body: validateWaterRuntimeBody(cooked).unwrap(),
      bodyWorldMatrixM: matrix,
      exclusionVolumes: [],
      borrowedBodyPose: {
        position: [8, 9, 10] as const,
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const,
      },
    };
    const candidate = buildWaterPhysicsCandidateInput(input).unwrap();
    expect(candidate.sourceTransform).toBeUndefined();
    expect(candidate.bodyType).toBeUndefined();
    const { borrowedBodyPose: _pose, ...sourceInput } = input;
    const canonical = buildWaterPhysicsCandidateInput({
      ...sourceInput,
      bodyWorldMatrixM: identity,
    }).unwrap();
    const actual = requiredFixtureValue(candidate.shapes[0]);
    const original = requiredFixtureValue(canonical.shapes[0]);
    expect(actual.kind).toBe('convex-compound');
    expect(original.kind).toBe('convex-compound');
    if (actual.kind !== 'convex-compound' || original.kind !== 'convex-compound') return;
    expect(actual.pieces).toHaveLength(original.pieces.length);
    for (const [pieceIndex, piece] of original.pieces.entries()) {
      const projected = requiredFixtureValue(actual.pieces[pieceIndex]);
      expect(projected).toHaveLength(piece.length);
      for (let i = 0; i < piece.length; i += 3) {
        const x = requiredFixtureValue(piece[i]);
        const y = requiredFixtureValue(piece[i + 1]);
        const z = requiredFixtureValue(piece[i + 2]);
        const world = [
          8 - requiredFixtureValue(projected[i + 1]),
          9 + requiredFixtureValue(projected[i]),
          10 + requiredFixtureValue(projected[i + 2]),
        ];
        for (const axis of [0, 1, 2]) {
          expect(world[axis]).toBeCloseTo(
            requiredFixtureValue(matrix[axis]) * x +
              requiredFixtureValue(matrix[4 + axis]) * y +
              requiredFixtureValue(matrix[8 + axis]) * z +
              requiredFixtureValue(matrix[12 + axis]),
            5,
          );
        }
      }
    }
    const moved = buildWaterPhysicsCandidateInput({
      ...input,
      borrowedBodyPose: { ...input.borrowedBodyPose, position: [9, 9, 10] },
    }).unwrap();
    expect(moved.inputDigest).not.toBe(candidate.inputDigest);
  });

  it('bounds large Custom trimesh descriptor ranges without argument spreading', () => {
    const source = {
      ...body('custom', [point(0, 0, 0), point(1, 2, 0)], false),
      collision: {
        type: 'custom-mesh' as const,
        enabled: true,
        meshGuid: '00000000-0000-7000-8000-000000000010',
      },
    };
    const base = createBoxGeometry(2, 2, 2).unwrap();
    const positions = new Float32Array(120_000 * 3);
    for (let i = 0; i < positions.length; i += 3) {
      const corner = (i / 3) % 8;
      positions[i] = corner & 1 ? 1 : -1;
      positions[i + 1] = corner & 2 ? 1 : -1;
      positions[i + 2] = corner & 4 ? 1 : -1;
    }
    const large = { ...base, attributes: { ...base.attributes, position: positions } } as MeshAsset;
    const descriptor = waterBodyCollisionDescriptor(source, undefined, large);
    expect(descriptor?.customMesh?.vertices).toHaveLength(positions.length);
  });

  it('versions Ocean footprint separately from vertical query and collision extents', async () => {
    const ocean = body(
      'ocean',
      loop([
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
      ]),
    );
    const source = {
      ...ocean,
      oceanExtentM: [100, 80] as const,
      collision: {
        type: 'polygon' as const,
        enabled: true,
        collisionHalfHeightM: 12,
        collisionHalfExtentsM: [50, 40] as const,
      },
    };
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000299');
    const first = await buildWaterPackOutputs({ ocean: source }, { packageId });
    const second = await buildWaterPackOutputs(
      { ocean: { ...source, heightOffsetM: 3 } },
      { packageId },
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const a = first.value.ocean,
      b = second.value.ocean;
    expect(a?.kind).toBe('water-body');
    expect(b?.kind).toBe('water-body');
    if (a?.kind !== 'water-body' || b?.kind !== 'water-body') return;
    expect(a.geometrySnapshot?.queryFootprint.digest).toBe(
      b.geometrySnapshot?.queryFootprint.digest,
    );
    expect(a.geometrySnapshot?.queryVolume.digest).not.toBe(b.geometrySnapshot?.queryVolume.digest);
    expect(a.geometrySnapshot?.collisionDescriptor?.digest).not.toBe(
      b.geometrySnapshot?.collisionDescriptor?.digest,
    );
  });

  it('keeps same-XZ vertically layered River query and collision consumers separate', async () => {
    const layeredBody = (baseY: number) =>
      body(
        'river',
        [
          point(0, 0, 0, {
            positionM: [0, baseY, 0],
            leaveTangentM: [8, 0, 0],
            widthM: 4,
            depthM: 2,
          }),
          point(1, 8, 0, {
            positionM: [8, baseY, 0],
            arriveTangentM: [8, 0, 0],
            widthM: 4,
            depthM: 2,
          }),
        ],
        false,
      );
    const packed = await buildWaterPackOutputs(
      { low: layeredBody(2), high: layeredBody(20) },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (
      !packed.ok ||
      packed.value.low?.kind !== 'water-body' ||
      packed.value.high?.kind !== 'water-body'
    )
      return;
    const low = packed.value.low,
      high = packed.value.high;
    expect(low.geometrySnapshot?.queryFootprint.outer).toEqual(
      high.geometrySnapshot?.queryFootprint.outer,
    );
    expect(low.geometrySnapshot?.queryVolume.maximumYM).toBeLessThan(
      high.geometrySnapshot?.queryVolume.minimumYM,
    );

    const lowQuery = waterBodyQueryPrismParts(low).unwrap();
    const highQuery = waterBodyQueryPrismParts(high).unwrap();
    const yBounds = (parts: readonly Float32Array[]) => {
      const values = parts.flatMap((part) =>
        Array.from({ length: part.length / 3 }, (_, index) =>
          requiredFixtureValue(part[index * 3 + 1]),
        ),
      );
      return [Math.min(...values), Math.max(...values)];
    };
    expect(yBounds(lowQuery)).toEqual([
      requiredFixtureValue(low.geometrySnapshot).queryVolume.minimumYM,
      requiredFixtureValue(low.geometrySnapshot).queryVolume.maximumYM,
    ]);
    expect(yBounds(highQuery)).toEqual([
      requiredFixtureValue(high.geometrySnapshot).queryVolume.minimumYM,
      requiredFixtureValue(high.geometrySnapshot).queryVolume.maximumYM,
    ]);

    const lowCandidate = buildWaterPhysicsCandidateInput({
      entity: 10,
      sourceKey: 'water:low',
      revision: 1,
      body: low,
      bodyWorldMatrixM: identity,
      exclusionVolumes: [],
    }).unwrap();
    const highCandidate = buildWaterPhysicsCandidateInput({
      entity: 11,
      sourceKey: 'water:high',
      revision: 1,
      body: high,
      bodyWorldMatrixM: identity,
      exclusionVolumes: [],
    }).unwrap();
    const collisionYBounds = (candidate: typeof lowCandidate) => {
      const shape = candidate.shapes[0];
      expect(shape?.kind).toBe('convex-compound');
      if (shape?.kind !== 'convex-compound') return [NaN, NaN];
      const values = shape.pieces.flatMap((piece) =>
        Array.from({ length: piece.length / 3 }, (_, index) =>
          requiredFixtureValue(piece[index * 3 + 1]),
        ),
      );
      return [Math.min(...values), Math.max(...values)];
    };
    expect(collisionYBounds(lowCandidate)).toEqual([
      requiredFixtureValue(requiredFixtureValue(low.geometrySnapshot).collisionDescriptor)
        .minimumYM,
      requiredFixtureValue(requiredFixtureValue(low.geometrySnapshot).collisionDescriptor)
        .maximumYM,
    ]);
    expect(collisionYBounds(highCandidate)).toEqual([
      requiredFixtureValue(requiredFixtureValue(high.geometrySnapshot).collisionDescriptor)
        .minimumYM,
      requiredFixtureValue(requiredFixtureValue(high.geometrySnapshot).collisionDescriptor)
        .maximumYM,
    ]);
    expect(collisionYBounds(lowCandidate)[1]).toBeLessThan(collisionYBounds(highCandidate)[0]);

    const water = new WaterSystem(() => undefined);
    const lowSnapshot = water.mountBody('layer/low', 'v1', low).unwrap();
    const highSnapshot = water.mountBody('layer/high', 'v1', high).unwrap();
    for (const [guid, snapshot, suffix] of [
      ['layer/low', lowSnapshot, 'low'],
      ['layer/high', highSnapshot, 'high'],
    ] as const) {
      water
        .acceptOutput(guid, 'query', snapshot.outputGenerations.query, {
          generation: 1,
          digest: `${suffix}-query`,
        })
        .unwrap();
      water
        .acceptOutput(guid, 'collision', snapshot.outputGenerations.collision, {
          generation: 1,
          digest: `${suffix}-collision`,
        })
        .unwrap();
    }
    expect(water.snapshot('layer/low')?.outputs).toMatchObject({
      query: 'ready',
      collision: 'ready',
    });
    expect(water.snapshot('layer/high')?.outputs).toMatchObject({
      query: 'ready',
      collision: 'ready',
    });
    expect(water.snapshot('layer/low')?.guid).not.toBe(water.snapshot('layer/high')?.guid);
  });

  it('triangulates Lake and Ocean domains with constrained edges and a preserved central hole', () => {
    const lake = buildWaterBodyGeometry(
      body(
        'lake',
        loop([
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ]),
      ),
    ).unwrap();
    expect(areaXZ(lake.visibleMesh)).toBeCloseTo(16, 7);
    expect(lake.visibleMesh?.attributes.position).toHaveLength(44 * 3);
    expect(lake.visibleMesh?.indices).toHaveLength(60 * 3);
    expect([
      ...requiredFixtureValue(requiredFixtureValue(lake.visibleMesh).indices).slice(0, 9),
    ]).toEqual([0, 11, 1, 12, 1, 11, 1, 12, 2]);
    expect([
      ...requiredFixtureValue(requiredFixtureValue(lake.visibleMesh).indices).slice(-9),
    ]).toEqual([42, 31, 41, 31, 42, 32, 43, 32, 42]);
    const lakeUv = requiredFixtureValue(lake.visibleMesh).attributes.uv as Float32Array;
    expect([...lakeUv.slice(0, 6)]).toEqual([1, 1, 0.89990234375, 1, 0.7998046875, 1]);
    expect([...lakeUv.slice(22, 24)]).toEqual([1, 0.66650390625]);
    expect(Math.min(...lakeUv.filter((_, index) => index % 2 === 0))).toBe(0);
    expect(Math.max(...lakeUv.filter((_, index) => index % 2 === 0))).toBe(1);
    expect(lake.waterInfoMesh?.vertices).not.toBe(lake.visibleMesh?.vertices);
    expect(lake.brushShapeMesh?.indices).toEqual(lake.waterInfoMesh?.indices);

    const ocean = buildWaterBodyGeometry(
      body(
        'ocean',
        loop([
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]),
      ),
      {
        oceanExtentM: [20, 20],
        exclusionRingsM: [
          [
            [5, 5],
            [7, 5],
            [7, 7],
            [5, 7],
          ],
        ],
      },
    ).unwrap();
    expect(areaXZ(ocean.visibleMesh)).toBeCloseTo(396, 6);
    const mesh = requiredFixtureValue(ocean.visibleMesh);
    for (let i = 0; i < requiredFixtureValue(mesh.indices).length; i += 3) {
      const position = mesh.attributes.position as Float32Array;
      const centerX =
        (requiredFixtureValue(position[requiredFixtureValue(mesh.indices[i]) * 3]) +
          requiredFixtureValue(position[requiredFixtureValue(mesh.indices[i + 1]) * 3]) +
          requiredFixtureValue(position[requiredFixtureValue(mesh.indices[i + 2]) * 3])) /
        3;
      const centerZ =
        (requiredFixtureValue(position[requiredFixtureValue(mesh.indices[i]) * 3 + 2]) +
          requiredFixtureValue(position[requiredFixtureValue(mesh.indices[i + 1]) * 3 + 2]) +
          requiredFixtureValue(position[requiredFixtureValue(mesh.indices[i + 2]) * 3 + 2])) /
        3;
      expect(Math.abs(centerX) < 1 && Math.abs(centerZ) < 1).toBe(false);
    }
    expect(ocean.collisionFootprint?.holes).toHaveLength(1);
    expect(ocean.collisionMesh?.collision?.indices.length).toBeGreaterThan(0);
    const oceanWithoutExclusions = buildWaterBodyGeometry(
      body(
        'ocean',
        loop([
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]),
      ),
      { oceanExtentM: [20, 20] },
    ).unwrap();
    expect(oceanWithoutExclusions.queryFootprint.holes).toHaveLength(1);
    expect(oceanWithoutExclusions.collisionFootprint?.holes).toHaveLength(0);
    expect(areaXZ(oceanWithoutExclusions.visibleMesh)).toBeCloseTo(396, 6);
  });

  it('orients concave outer and exclusion-hole prism walls from their directed edges', () => {
    const lShape = [
      [0, 0],
      [0, 3],
      [1, 3],
      [1, 1],
      [3, 1],
      [3, 0],
    ] as const;
    const assertWallWinding = (
      mesh: MeshAsset | undefined,
      x: number,
      minZ: number,
      maxZ: number,
      expectedNormalX: number,
    ) => {
      expect(mesh?.indices).toBeDefined();
      const positions = requiredFixtureValue(mesh).attributes.position as Float32Array;
      const expectedFaceCount = 2;
      let found = 0;
      for (
        let offset = 0;
        offset < requiredFixtureValue(requiredFixtureValue(mesh).indices).length;
        offset += 3
      ) {
        const ids = [
          requiredFixtureValue(requiredFixtureValue(requiredFixtureValue(mesh).indices)[offset]),
          requiredFixtureValue(
            requiredFixtureValue(requiredFixtureValue(mesh).indices)[offset + 1],
          ),
          requiredFixtureValue(
            requiredFixtureValue(requiredFixtureValue(mesh).indices)[offset + 2],
          ),
        ];
        const points = ids.map(
          (id) =>
            [
              requiredFixtureValue(positions[id * 3]),
              requiredFixtureValue(positions[id * 3 + 1]),
              requiredFixtureValue(positions[id * 3 + 2]),
            ] as const,
        );
        if (
          !points.every(
            ([px, , pz]) => Math.abs(px - x) < 1e-6 && pz >= minZ - 1e-6 && pz <= maxZ + 1e-6,
          )
        )
          continue;
        const [a, b, c] = points as [
          (typeof points)[number],
          (typeof points)[number],
          (typeof points)[number],
        ];
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const normalX =
          requiredFixtureValue(ab[1]) * requiredFixtureValue(ac[2]) -
          requiredFixtureValue(ab[2]) * requiredFixtureValue(ac[1]);
        expect(normalX * expectedNormalX).toBeGreaterThan(0);
        found++;
      }
      expect(found).toBe(expectedFaceCount);
    };
    const custom = {
      ...body('custom', [point(0, 0, 0), point(1, 2, 0)], false),
      collision: { type: 'polygon' as const, enabled: true, points: lShape },
    };
    const concave = buildWaterBodyGeometry(custom).unwrap();
    assertWallWinding(concave.collisionMesh, 1, 1, 3, 1);

    const oceanSource = {
      ...body(
        'ocean',
        loop([
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]),
      ),
      oceanExtentM: [10, 10] as const,
      collision: {
        type: 'polygon' as const,
        enabled: true,
        collisionHalfHeightM: 20,
        collisionHalfExtentsM: [5, 5] as const,
      },
    };
    const withHole = buildWaterBodyGeometry(oceanSource, { exclusionRingsM: [lShape] }).unwrap();
    assertWallWinding(withHole.collisionMesh, 1, 1, 3, -1);
  });

  it('cooks UE ShapeDilation as a separate type-specific WaterInfo product', async () => {
    const riverSource = {
      ...body('river', [point(0, 0, 0), point(1, 10, 0)], false),
      shapeDilationM: 2,
    };
    const river = buildWaterBodyGeometry(riverSource).unwrap();
    const riverRows =
      requiredFixtureValue(requiredFixtureValue(river.waterInfoMesh).attributes.position).length /
      3 /
      2;
    const dilatedRiver = requiredFixtureValue(river.dilatedWaterInfoMesh);
    const dilatedRiverPositions = dilatedRiver.attributes.position as Float32Array;
    const dilatedRiverVertexCount = dilatedRiverPositions.length / 3;
    expect(river.waterInfoMesh).toBeDefined();
    expect(riverRows).toBeGreaterThan(2);
    expect(dilatedRiverVertexCount).toBe((riverRows + 2) * 4);
    expect(requiredFixtureValue(dilatedRiver.indices).length).toBe((riverRows - 1) * 12 + 36);
    expect(areaXZ(river.waterInfoMesh)).toBeCloseTo(40, 4);
    expect(areaXZ(dilatedRiver)).toBeCloseTo(72, 4);
    expect(
      Math.min(
        ...Array.from({ length: dilatedRiverVertexCount }, (_, index) =>
          requiredFixtureValue(dilatedRiverPositions[index * 3]),
        ),
      ),
    ).toBeCloseTo(-2, 5);
    expect(
      Math.max(
        ...Array.from({ length: dilatedRiverVertexCount }, (_, index) =>
          requiredFixtureValue(dilatedRiverPositions[index * 3]),
        ),
      ),
    ).toBeCloseTo(12, 5);
    expect(
      Math.min(
        ...Array.from({ length: dilatedRiverVertexCount }, (_, index) =>
          requiredFixtureValue(dilatedRiverPositions[index * 3 + 2]),
        ),
      ),
    ).toBeCloseTo(-4, 5);
    expect(
      Math.max(
        ...Array.from({ length: dilatedRiverVertexCount }, (_, index) =>
          requiredFixtureValue(dilatedRiverPositions[index * 3 + 2]),
        ),
      ),
    ).toBeCloseTo(4, 5);
    expect(dilatedRiver.attributes.color).toBeUndefined();

    const rolledRiver = {
      ...riverSource,
      spline: {
        ...riverSource.spline,
        points: riverSource.spline.points.map((point) => ({ ...point, up: [0, 1, 1] as const })),
      },
    };
    const rolledDilation = requiredFixtureValue(
      buildWaterBodyGeometry(rolledRiver).unwrap().dilatedWaterInfoMesh,
    );
    const rolledPositions = rolledDilation.attributes.position as Float32Array;
    const firstSampleRow = 1,
      innerLeftY = requiredFixtureValue(rolledPositions[(firstSampleRow * 4 + 1) * 3 + 1]),
      innerRightY = requiredFixtureValue(rolledPositions[(firstSampleRow * 4 + 2) * 3 + 1]);
    const outerLeftY = requiredFixtureValue(rolledPositions[firstSampleRow * 4 * 3 + 1]),
      outerRightY = requiredFixtureValue(rolledPositions[(firstSampleRow * 4 + 3) * 3 + 1]);
    expect(innerLeftY).toBeCloseTo(2, 6);
    expect(innerRightY).toBeCloseTo(2, 6);
    expect(outerLeftY).not.toBeCloseTo(outerRightY, 4);

    const slopedRiver = {
      ...riverSource,
      spline: {
        ...riverSource.spline,
        points: riverSource.spline.points.map((point) => ({
          ...point,
          leaveTangentM: [1, 1, 0] as const,
          arriveTangentM: [1, 1, 0] as const,
        })),
      },
    };
    const slopedDilation = requiredFixtureValue(
      buildWaterBodyGeometry(slopedRiver).unwrap().dilatedWaterInfoMesh,
    );
    const slopedPositions = slopedDilation.attributes.position as Float32Array;
    expect(slopedPositions[0]).toBeCloseTo(-Math.SQRT2, 5);

    const square = {
      ...body(
        'lake',
        loop([
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ]),
      ),
      shapeDilationM: 4,
    };
    const squareGeometry = buildWaterBodyGeometry(square).unwrap();
    expect(areaXZ(squareGeometry.waterInfoMesh)).toBeCloseTo(16, 6);
    expect(areaXZ(squareGeometry.dilatedWaterInfoMesh)).toBeCloseTo(64, 6);
    const squarePositions = requiredFixtureValue(squareGeometry.dilatedWaterInfoMesh).attributes
      .position as Float32Array;
    expect(Math.min(...squarePositions.filter((_, index) => index % 3 === 0))).toBeCloseTo(-4, 5);
    expect(Math.max(...squarePositions.filter((_, index) => index % 3 === 0))).toBeCloseTo(4, 5);

    const concave = {
      ...body(
        'lake',
        loop([
          [0, 0],
          [6, 0],
          [6, 2],
          [2, 2],
          [2, 6],
          [0, 6],
        ]),
      ),
      shapeDilationM: 2,
    };
    const concaveGeometry = buildWaterBodyGeometry(concave).unwrap();
    expect(areaXZ(concaveGeometry.dilatedWaterInfoMesh)).toBeCloseTo(48, 5);
    const ocean = {
      ...body(
        'ocean',
        loop([
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ]),
      ),
      shapeDilationM: 2,
      oceanExtentM: [30, 30] as const,
    };
    const oceanGeometry = buildWaterBodyGeometry(ocean).unwrap();
    expect(areaXZ(oceanGeometry.waterInfoMesh)).toBeCloseTo(884, 5);
    expect(areaXZ(oceanGeometry.dilatedWaterInfoMesh)).toBeCloseTo(1020, 5);
    const dilatedOcean = requiredFixtureValue(oceanGeometry.dilatedWaterInfoMesh);
    const dilatedOceanPositions = dilatedOcean.attributes.position as Float32Array;
    for (let index = 0; index < requiredFixtureValue(dilatedOcean.indices).length; index += 3) {
      const centerX =
        (requiredFixtureValue(
          dilatedOceanPositions[requiredFixtureValue(dilatedOcean.indices[index]) * 3],
        ) +
          requiredFixtureValue(
            dilatedOceanPositions[requiredFixtureValue(dilatedOcean.indices[index + 1]) * 3],
          ) +
          requiredFixtureValue(
            dilatedOceanPositions[requiredFixtureValue(dilatedOcean.indices[index + 2]) * 3],
          )) /
        3;
      const centerZ =
        (requiredFixtureValue(
          dilatedOceanPositions[requiredFixtureValue(dilatedOcean.indices[index]) * 3 + 2],
        ) +
          requiredFixtureValue(
            dilatedOceanPositions[requiredFixtureValue(dilatedOcean.indices[index + 1]) * 3 + 2],
          ) +
          requiredFixtureValue(
            dilatedOceanPositions[requiredFixtureValue(dilatedOcean.indices[index + 2]) * 3 + 2],
          )) /
        3;
      expect(Math.abs(centerX) < 1 && Math.abs(centerZ) < 1).toBe(false);
    }
    const noDilation = buildWaterBodyGeometry({ ...square, shapeDilationM: 0 }).unwrap();
    expect(noDilation.dilatedWaterInfoMesh).toBeUndefined();

    const packed = await buildWaterPackOutputs(
      { lake: square },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.lake?.kind !== 'water-body') return;
    expect(packed.value.lake.dilatedWaterInfoMeshGuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(packed.value['lake/water-info-dilated']?.kind).toBe('mesh');
    expect(packed.value.lake.dilatedWaterInfoMeshGuid).not.toBe(
      packed.value.lake.waterInfoMeshGuid,
    );
    expect(packed.value.lake.waterGeometryVersion).toBe(2);
    const { dilatedWaterInfoMeshGuid: _dilatedGuid, ...missingDilatedOutput } = packed.value.lake;
    expect(validateWaterRuntimeBody(missingDilatedOutput).ok).toBe(false);
    const { waterInfoMeshGuid: _baseGuid, ...missingBaseOutput } = packed.value.lake;
    expect(validateWaterRuntimeBody(missingBaseOutput).ok).toBe(false);
    const {
      waterGeometryVersion: _version,
      dilatedWaterInfoMeshGuid: _legacyDilatedGuid,
      ...legacyBody
    } = packed.value.lake;
    expect(validateWaterRuntimeBody(legacyBody).ok).toBe(true);
  });

  it('includes the local origin in long, narrow non-centered Ocean island bounds before stitching the 1 cm ring', () => {
    const coordinates = [
      [10, 1],
      [26, 1],
      [26, 3],
      [10, 3],
    ] as const;
    const ocean = buildWaterBodyGeometry({
      ...body('ocean', loop(coordinates)),
      oceanExtentM: [100, 30],
      oceanCenterM: [0, 0],
      collision: { type: 'none', enabled: false },
    }).unwrap();
    expect(areaXZ(ocean.visibleMesh)).toBeCloseTo(100 * 30 - 16 * 2, 5);
    const mesh = requiredFixtureValue(ocean.visibleMesh);
    const positions = mesh.attributes.position as Float32Array;
    const vertexKeys = new Set(
      Array.from(
        { length: positions.length / 3 },
        (_, index) =>
          `${requiredFixtureValue(positions[index * 3]).toFixed(2)},${requiredFixtureValue(positions[index * 3 + 2]).toFixed(2)}`,
      ),
    );
    for (const corner of [
      [-50, -15],
      [50, -15],
      [50, 15],
      [-50, 15],
      [-0.01, -0.01],
      [26.01, -0.01],
      [26.01, 3.01],
      [-0.01, 3.01],
    ]) {
      expect(
        vertexKeys.has(
          `${requiredFixtureValue(corner[0]).toFixed(2)},${requiredFixtureValue(corner[1]).toFixed(2)}`,
        ),
      ).toBe(true);
    }
    const islandSampleCount = flattenSplineSegments(
      sampleSplineSegments(body('ocean', loop(coordinates), true), 0.1),
      true,
    ).length;
    expect(requiredFixtureValue(mesh.indices).length / 3).toBe(islandSampleCount + 20);
    const edgeUse = new Map<string, number>();
    for (let index = 0; index < requiredFixtureValue(mesh.indices).length; index += 3)
      for (let edge = 0; edge < 3; edge++) {
        const a = requiredFixtureValue(mesh.indices[index + edge]),
          b = requiredFixtureValue(mesh.indices[index + ((edge + 1) % 3)]);
        const edgeKey = a < b ? `${a}:${b}` : `${b}:${a}`;
        edgeUse.set(edgeKey, (edgeUse.get(edgeKey) ?? 0) + 1);
      }
    expect([...edgeUse.values()].every((count) => count === 1 || count === 2)).toBe(true);
    expect([...edgeUse.values()].filter((count) => count === 1)).toHaveLength(
      islandSampleCount + 12,
    );
    const uniqueVertices = [...new Set(requiredFixtureValue(mesh.indices))];
    for (const edge of edgeUse.keys()) {
      const [a, b] = edge.split(':').map(Number);
      const ax = requiredFixtureValue(positions[requiredFixtureValue(a) * 3]),
        az = requiredFixtureValue(positions[requiredFixtureValue(a) * 3 + 2]),
        bx = requiredFixtureValue(positions[requiredFixtureValue(b) * 3]),
        bz = requiredFixtureValue(positions[requiredFixtureValue(b) * 3 + 2]);
      for (const vertex of uniqueVertices) {
        if (vertex === a || vertex === b) continue;
        const px = requiredFixtureValue(positions[requiredFixtureValue(vertex) * 3]),
          pz = requiredFixtureValue(positions[requiredFixtureValue(vertex) * 3 + 2]);
        const crossValue = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
        const dot = (px - ax) * (bx - ax) + (pz - az) * (bz - az);
        const lengthSquared = (bx - ax) ** 2 + (bz - az) ** 2;
        expect(Math.abs(crossValue) <= 1e-5 && dot > 1e-5 && dot < lengthSquared - 1e-5).toBe(
          false,
        );
      }
    }
  });

  it('cooks Lake collision from the spline XZ bounds box, including a concave notch', () => {
    const lakeSource = {
      ...body(
        'lake',
        loop([
          [0, 0],
          [6, 0],
          [6, 2],
          [2, 2],
          [2, 6],
          [0, 6],
        ]),
      ),
      collision: {
        type: 'polygon' as const,
        enabled: true,
        channelDepthM: 6,
        collisionHeightOffsetM: 2,
      },
    };
    const lake = buildWaterBodyGeometry(lakeSource).unwrap();
    expect(lake.queryFootprint.outer.length).toBeGreaterThan(6);
    expect(lake.collisionFootprint?.outer).toEqual([
      [0, 6],
      [6, 6],
      [6, 0],
      [0, 0],
    ]);
    expect(areaXZ(lake.visibleMesh)).toBeCloseTo(36, 7);
    expect(areaXZ(lake.waterInfoMesh)).toBeCloseTo(20, 6);
    expect(lake.collisionMesh?.indices.length).toBeGreaterThan(0);
    const positions = requiredFixtureValue(lake.collisionMesh).attributes.position as Float32Array;
    expect(
      Math.min(
        ...Array.from({ length: positions.length / 3 }, (_, index) =>
          requiredFixtureValue(positions[index * 3 + 1]),
        ),
      ),
    ).toBe(-4);
    expect(
      Math.max(
        ...Array.from({ length: positions.length / 3 }, (_, index) =>
          requiredFixtureValue(positions[index * 3 + 1]),
        ),
      ),
    ).toBe(4);
    const oceanDescriptor = requiredFixtureValue(
      waterBodyCollisionDescriptor(
        {
          ...body(
            'ocean',
            loop([
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1],
            ]),
          ),
          heightOffsetM: 1,
          collision: {
            type: 'polygon',
            enabled: true,
            collisionHalfHeightM: 20,
            collisionHalfExtentsM: [20, 20],
            collisionHeightOffsetM: 2,
          },
        },
        [20, 20],
      ),
    );
    expect([oceanDescriptor.minimumYM, oceanDescriptor.maximumYM]).toEqual([-37, 5]);

    const bulgingLakePoints = [
      point(0, 0, 0, {
        positionM: [0, 0, 0],
        arriveTangentM: [0, 0, 0],
        leaveTangentM: [12, 0, -12],
      }),
      point(1, 4, 0, {
        positionM: [4, 0, 0],
        arriveTangentM: [-12, 0, 12],
        leaveTangentM: [0, 0, 0],
      }),
      point(2, 4, 4, { positionM: [4, 0, 4], arriveTangentM: [0, 0, 0], leaveTangentM: [0, 0, 0] }),
      point(3, 0, 4, { positionM: [0, 0, 4], arriveTangentM: [0, 0, 0], leaveTangentM: [0, 0, 0] }),
    ];
    const bulgingLake = body('lake', bulgingLakePoints);
    const bounds = requiredFixtureValue(waterBodyCollisionDescriptor(bulgingLake)).footprint.outer;
    expect(Math.max(...bounds.map(([x]) => x))).toBeCloseTo(4 * Math.SQRT2, 12);
    const boundsMesh = requiredFixtureValue(
      buildWaterBodyGeometry(bulgingLake).unwrap().visibleMesh,
    );
    const boundsPositions = boundsMesh.attributes.position as Float32Array;
    expect(
      Math.max(
        ...Array.from({ length: boundsPositions.length / 3 }, (_, index) =>
          requiredFixtureValue(boundsPositions[index * 3]),
        ),
      ),
    ).toBeCloseTo(4 * Math.SQRT2, 6);
  });

  it('keeps Lake collision as a world-axis-aligned spline bounds box under actor transforms', async () => {
    const lake = {
      ...body(
        'lake',
        loop([
          [0, 0],
          [6, 0],
          [6, 6],
          [0, 6],
        ]),
      ),
      collision: {
        type: 'polygon' as const,
        enabled: true,
        channelDepthM: 6,
        collisionHeightOffsetM: 2,
      },
    };
    const packed = await buildWaterPackOutputs(
      { lake },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.lake?.kind !== 'water-body') return;
    const cosine = Math.cos(Math.PI / 4),
      sine = Math.sin(Math.PI / 4);
    const matrix = [
      cosine * 2,
      0,
      -sine * 2,
      0,
      0,
      3,
      0,
      0,
      sine * 0.5,
      0,
      cosine * 0.5,
      0,
      5,
      7,
      -3,
      1,
    ] as const;
    const candidate = buildWaterPhysicsCandidateInput({
      entity: 10,
      sourceKey: 'lake:transformed',
      revision: 1,
      body: packed.value.lake,
      bodyWorldMatrixM: matrix,
      exclusionVolumes: [],
    }).unwrap();
    const shape = candidate.shapes[0];
    expect(shape?.kind).toBe('convex-compound');
    if (shape?.kind !== 'convex-compound') return;
    const sourceCorners = [0, 6].flatMap((x) =>
      [-4, 4].flatMap((y) => [0, 6].map((z) => [x, y, z])),
    );
    const transformed = sourceCorners.map(([x, y, z]) => [
      requiredFixtureValue(matrix[0]) * requiredFixtureValue(x) +
        requiredFixtureValue(matrix[4]) * requiredFixtureValue(y) +
        requiredFixtureValue(matrix[8]) * requiredFixtureValue(z) +
        requiredFixtureValue(matrix[12]),
      requiredFixtureValue(matrix[1]) * requiredFixtureValue(x) +
        requiredFixtureValue(matrix[5]) * requiredFixtureValue(y) +
        requiredFixtureValue(matrix[9]) * requiredFixtureValue(z) +
        requiredFixtureValue(matrix[13]),
      requiredFixtureValue(matrix[2]) * requiredFixtureValue(x) +
        requiredFixtureValue(matrix[6]) * requiredFixtureValue(y) +
        requiredFixtureValue(matrix[10]) * requiredFixtureValue(z) +
        requiredFixtureValue(matrix[14]),
    ]);
    const worldPoints = Array.from(
      { length: requiredFixtureValue(shape.pieces[0]).length / 3 },
      (_, index) => {
        const [x, y, z] = requiredFixtureValue(shape.pieces[0]).slice(index * 3, index * 3 + 3);
        return transformNoScale(matrix, [
          requiredFixtureValue(x),
          requiredFixtureValue(y),
          requiredFixtureValue(z),
        ]);
      },
    );
    for (let axis = 0; axis < 3; axis++) {
      const expected = transformed.map((point) => requiredFixtureValue(point[axis]));
      const actual = worldPoints.map((point) => requiredFixtureValue(point[axis]));
      expect(Math.min(...actual)).toBeCloseTo(Math.min(...expected), 5);
      expect(Math.max(...actual)).toBeCloseTo(Math.max(...expected), 5);
    }
  });

  it('cooks Lake visible mesh into actor-local vertices for a world-AABB while preserving WaterInfo geometry', () => {
    const lake = body(
      'lake',
      loop([
        [0, 0],
        [6, 0],
        [6, 6],
        [0, 6],
      ]),
    );
    const pitch = Math.PI / 6,
      pitchCos = Math.cos(pitch),
      pitchSin = Math.sin(pitch);
    const yaw = Math.PI / 4,
      yawCos = Math.cos(yaw),
      yawSin = Math.sin(yaw);
    const matrix = [
      yawCos * 2,
      0,
      -yawSin * 2,
      0,
      yawSin * pitchSin * 3,
      pitchCos * 3,
      yawCos * pitchSin * 3,
      0,
      yawSin * pitchCos * 0.5,
      -pitchSin * 0.5,
      yawCos * pitchCos * 0.5,
      0,
      5,
      7,
      -3,
      1,
    ] as const;
    const local = buildWaterBodyGeometry(lake).unwrap();
    const transformed = buildWaterBodyGeometry(lake, { bodyWorldMatrixM: matrix }).unwrap();
    const worldMesh = requiredFixtureValue(transformed.visibleMesh).attributes
      .position as Float32Array;
    const worldPoints = Array.from({ length: worldMesh.length / 3 }, (_, index) => {
      const [x, y, z] = [
        requiredFixtureValue(worldMesh[index * 3]),
        requiredFixtureValue(worldMesh[index * 3 + 1]),
        requiredFixtureValue(worldMesh[index * 3 + 2]),
      ];
      return [
        requiredFixtureValue(matrix[0]) * x +
          requiredFixtureValue(matrix[4]) * y +
          requiredFixtureValue(matrix[8]) * z +
          requiredFixtureValue(matrix[12]),
        requiredFixtureValue(matrix[1]) * x +
          requiredFixtureValue(matrix[5]) * y +
          requiredFixtureValue(matrix[9]) * z +
          requiredFixtureValue(matrix[13]),
        requiredFixtureValue(matrix[2]) * x +
          requiredFixtureValue(matrix[6]) * y +
          requiredFixtureValue(matrix[10]) * z +
          requiredFixtureValue(matrix[14]),
      ];
    });
    const expectedPoints = [0, 6].flatMap((x) =>
      [0, 6].map((z) => [
        requiredFixtureValue(matrix[0]) * x +
          requiredFixtureValue(matrix[4]) * 2 +
          requiredFixtureValue(matrix[8]) * z +
          requiredFixtureValue(matrix[12]),
        requiredFixtureValue(matrix[5]) * 2 + requiredFixtureValue(matrix[13]),
        requiredFixtureValue(matrix[2]) * x +
          requiredFixtureValue(matrix[6]) * 2 +
          requiredFixtureValue(matrix[10]) * z +
          requiredFixtureValue(matrix[14]),
      ]),
    );
    for (const axis of [0, 2]) {
      const expected = expectedPoints.map((point) => requiredFixtureValue(point[axis]));
      const actual = worldPoints.map((point) => requiredFixtureValue(point[axis]));
      expect(Math.min(...actual)).toBeCloseTo(Math.min(...expected), 5);
      expect(Math.max(...actual)).toBeCloseTo(Math.max(...expected), 5);
    }
    const normals = requiredFixtureValue(transformed.visibleMesh).attributes.normal as Float32Array;
    const c0 = [
        requiredFixtureValue(matrix[0]),
        requiredFixtureValue(matrix[1]),
        requiredFixtureValue(matrix[2]),
      ],
      c1 = [
        requiredFixtureValue(matrix[4]),
        requiredFixtureValue(matrix[5]),
        requiredFixtureValue(matrix[6]),
      ],
      c2 = [
        requiredFixtureValue(matrix[8]),
        requiredFixtureValue(matrix[9]),
        requiredFixtureValue(matrix[10]),
      ];
    const cross = (a: readonly number[], b: readonly number[]) => [
      requiredFixtureValue(a[1]) * requiredFixtureValue(b[2]) -
        requiredFixtureValue(a[2]) * requiredFixtureValue(b[1]),
      requiredFixtureValue(a[2]) * requiredFixtureValue(b[0]) -
        requiredFixtureValue(a[0]) * requiredFixtureValue(b[2]),
      requiredFixtureValue(a[0]) * requiredFixtureValue(b[1]) -
        requiredFixtureValue(a[1]) * requiredFixtureValue(b[0]),
    ];
    const dot = (a: readonly number[], b: readonly number[]) =>
      requiredFixtureValue(a[0]) * requiredFixtureValue(b[0]) +
      requiredFixtureValue(a[1]) * requiredFixtureValue(b[1]) +
      requiredFixtureValue(a[2]) * requiredFixtureValue(b[2]);
    const determinant = dot(c0, cross(c1, c2));
    const localNormal = [
      requiredFixtureValue(normals[0]),
      requiredFixtureValue(normals[1]),
      requiredFixtureValue(normals[2]),
    ];
    const cofactors = [cross(c1, c2), cross(c2, c0), cross(c0, c1)];
    const rawWorldNormal = [0, 1, 2].map(
      (axis) =>
        cofactors.reduce(
          (sum, cofactor, index) =>
            sum + requiredFixtureValue(cofactor[axis]) * requiredFixtureValue(localNormal[index]),
          0,
        ) / determinant,
    );
    const normalLength = Math.hypot(...rawWorldNormal);
    const worldNormal = rawWorldNormal.map((value) => value / normalLength);
    expect(worldNormal[0]).toBeCloseTo(0, 5);
    expect(worldNormal[1]).toBeCloseTo(1, 5);
    expect(worldNormal[2]).toBeCloseTo(0, 5);
    expect(transformed.waterInfoMesh?.attributes.position).toEqual(
      local.waterInfoMesh?.attributes.position,
    );
  });

  it('rejects invalid and intersecting contour rings before output', () => {
    const invalidLake = body('lake', [
      point(0, 0, 0),
      point(1, 2, 2),
      point(2, 0, 2),
      point(3, 2, 0),
    ]);
    expect(buildWaterBodyGeometry(invalidLake).ok).toBe(false);
    expect(
      buildWaterBodyGeometry(
        body(
          'ocean',
          loop([
            [-2, -2],
            [2, -2],
            [2, 2],
            [-2, 2],
          ]),
        ),
        { oceanExtentM: [3, 3] },
      ).ok,
    ).toBe(false);
  });

  it('cooks Ocean body extent independently of Zone span and without a loaded Zone', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000299');
    const zoneGuid = AssetGuid.format(AssetGuid.derive(packageId, 'zone/late'));
    const ocean = {
      ...body(
        'ocean',
        loop([
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]),
      ),
      oceanExtentM: [20, 12] as const,
      zoneGuid,
      savedZoneLocationWorldXZ: [0, 0] as const,
      collision: { type: 'none' as const, enabled: false },
    };
    const zone = {
      kind: 'water-zone' as const,
      extentM: { spanXM: 5, spanZM: 4 },
      tileSizeM: 1,
      tessellationFactor: 2,
      lodScale: 1,
      waterInfo: {
        resolution: { widthPx: 16, heightPx: 16 },
        format: 'rgba16f' as const,
        blurRadius: 0,
        localTessellation: false,
      },
    };
    const withLateZone = await buildWaterPackOutputs(
      { 'zone/late': zone, 'ocean/main': ocean },
      { packageId, bodyWorldTransformsM: { 'ocean/main': identity } },
    );
    expect(withLateZone.ok).toBe(true);
    if (!withLateZone.ok) return;
    const bodyOutput = withLateZone.value['ocean/main'];
    expect(bodyOutput).toMatchObject({ kind: 'water-body', oceanExtentM: [20, 12], zoneGuid });
    if (bodyOutput?.kind !== 'water-body' || !bodyOutput.visibleMeshGuid)
      throw new Error('Ocean visible mesh GUID missing');
    const visible = withLateZone.value['ocean/main/visible-mesh'] as MeshAsset;
    expect(areaXZ(visible)).toBeCloseTo(236, 6);
    const withoutZone = await buildWaterPackOutputs(
      { 'ocean/main': { ...ocean, zoneGuid: undefined } },
      { packageId, bodyWorldTransformsM: { 'ocean/main': identity } },
    );
    expect(withoutZone.ok).toBe(true);
    if (!withoutZone.ok) return;
    expect(withoutZone.value['ocean/main/visible-mesh']?.kind).toBe('mesh');
  });

  it('derives the Cooked Ocean local center from saved world XZ and the Pack authoring transform', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000298');
    const ocean = {
      ...body(
        'ocean',
        loop([
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ]),
      ),
      oceanExtentM: [40, 24] as const,
      centerOnWaterZone: true,
      savedZoneLocationWorldXZ: [1, 1] as const,
      collision: { type: 'none' as const, enabled: false },
    };
    const matrix = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 5, 0, 1] as const;
    const packed = await buildWaterPackOutputs(
      { 'ocean/main': ocean },
      { packageId, bodyWorldTransformsM: { 'ocean/main': matrix } },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value['ocean/main']?.kind !== 'water-body') return;
    const cooked = packed.value['ocean/main'];
    expect(cooked.oceanCenterM).toEqual([-1, 1]);
    expect(cooked.geometryAuthoringWorldMatrixM).toEqual(matrix);
    expect(cooked.geometrySnapshot?.queryFootprint.outer).toEqual(
      expect.arrayContaining([
        [-21, -11],
        [19, -11],
        [19, 13],
        [-21, 13],
      ]),
    );
    expect(validateWaterRuntimeAsset(cooked).ok).toBe(true);

    const localOcean = await buildWaterPackOutputs(
      { ocean: { ...ocean, centerOnWaterZone: false } },
      { packageId },
    );
    expect(
      localOcean.ok && localOcean.value.ocean?.kind === 'water-body'
        ? localOcean.value.ocean.oceanCenterM
        : undefined,
    ).toEqual([0, 0]);
    const missingTransform = await buildWaterPackOutputs({ ocean: { ...ocean } }, { packageId });
    expect(missingTransform).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-source',
        expected: expect.stringContaining('authoring Body world transform'),
      },
    });
    const missingSaved = await buildWaterPackOutputs(
      {
        ocean: {
          ...ocean,
          zoneGuid: '019a0000-0000-7000-8000-000000000299',
          savedZoneLocationWorldXZ: undefined,
        },
      },
      { packageId, bodyWorldTransformsM: { ocean: matrix } },
    );
    expect(missingSaved).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-source',
        expected: expect.stringContaining('savedZoneLocationWorldXZ'),
      },
    });
    const authoredCenter = await buildWaterPackOutputs(
      { ocean: { ...ocean, oceanCenterM: [3, 4] } as unknown },
      { packageId, bodyWorldTransformsM: { ocean: matrix } },
    );
    expect(authoredCenter).toMatchObject({
      ok: false,
      error: { code: 'invalid-source', expected: expect.stringContaining('without Pack-owned') },
    });
  });

  it('uses River tolerance sampling and UE PackFlowData magnitude/angle encoding', () => {
    const river = body(
      'river',
      [
        point(0, 0, 0, { leaveTangentM: [10, 0, 2], velocityMPerSec: -2 }),
        point(1, 10, 0, { arriveTangentM: [10, 0, -2], velocityMPerSec: -2 }),
      ],
      false,
    );
    const cooked = buildWaterBodyGeometry(river).unwrap();
    expect(cooked.visibleMesh).toBeUndefined();
    expect(cooked.visibleSegments).toHaveLength(1);
    expect(requiredFixtureValue(cooked.waterInfoMesh).vertices.length / 12).toBeGreaterThan(8);
    expect(cooked.waterInfoMesh?.submeshes[0]?.indexCount).toBeGreaterThan(0);
    const vertexColor = requiredFixtureValue(cooked.waterInfoMesh).attributes.color as Float32Array;
    expect(vertexColor.length / 4).toBe(cooked.flowByVertex.length / 2);
    for (let i = 0; i < cooked.flowByVertex.length; i += 2) {
      expect(cooked.flowByVertex[i]).toBeCloseTo(2 / 10.24, 5);
      expect(cooked.flowByVertex[i + 1]).toBeGreaterThanOrEqual(0);
      expect(cooked.flowByVertex[i + 1]).toBeLessThanOrEqual(1);
      expect(vertexColor[(i / 2) * 4]).toBeCloseTo(2 / 10.24, 5);
      expect(vertexColor[(i / 2) * 4 + 1]).toBe(cooked.flowByVertex[i + 1]);
    }
  });

  it('keeps UE River distance sampling seed points and honors Linear and auto-clamped point modes', () => {
    const straight = body(
      'river',
      [
        point(0, 0, 0, { positionM: [0, 0, 0], leaveTangentM: [10, 0, 0] }),
        point(1, 10, 0, { positionM: [10, 0, 0], arriveTangentM: [10, 0, 0] }),
      ],
      false,
    );
    const straightSamples = flattenSplineSegments(sampleSplineSegments(straight, 0.05), false);
    expect(straightSamples.map((sample) => sample.inputKey)).toEqual([0, 0.5, 1]);
    expect(straightSamples.map((sample) => sample.positionM)).toEqual([
      [0, 0, 0],
      [5, 0, 0],
      [10, 0, 0],
    ]);
    expect(straightSamples.map((sample) => sample.leaveTangentM)).toEqual([
      [10, 0, 0],
      [10, 0, 0],
      [10, 0, 0],
    ]);

    const linear = body(
      'river',
      [
        point(0, 0, 0, {
          positionM: [0, 0, 0],
          interpolationMode: 'linear',
          leaveTangentM: [0, 20, 0],
        }),
        point(1, 10, 0, {
          positionM: [10, 0, 0],
          interpolationMode: 'linear',
          arriveTangentM: [0, -20, 0],
        }),
      ],
      false,
    );
    expect(
      requiredFixtureValue(sampleSplineSegments(linear, 0.05)[0]).every(
        (sample) => Math.abs(sample.positionM[1]) < 1e-8,
      ),
    ).toBe(true);

    const clamped = body(
      'river',
      [
        point(0, 0, 0, { positionM: [0, 0, 0], interpolationMode: 'curve-clamped' }),
        point(1, 1, 0, { positionM: [1, 0, 0], interpolationMode: 'curve-clamped' }),
        point(2, 2, 0, { positionM: [2, 10, 0], interpolationMode: 'curve-clamped' }),
      ],
      false,
    );
    expect(
      Math.min(
        ...requiredFixtureValue(sampleSplineSegments(clamped, 0.05)[0]).map(
          (sample) => sample.positionM[1],
        ),
      ),
    ).toBeGreaterThanOrEqual(-1e-8);
    const nearClamp = body(
      'river',
      [
        point(0, 0, 0, { positionM: [0, 0, 0], interpolationMode: 'curve-clamped' }),
        point(1, 1, 0, { positionM: [1, 0.332, 0], interpolationMode: 'curve-clamped' }),
        point(2, 2, 0, { positionM: [2, 1, 0], interpolationMode: 'curve-clamped' }),
      ],
      false,
    );
    expect(
      requiredFixtureValue(resolveWaterSplinePoints(nearClamp.spline)[1]).leaveTangentM[1],
    ).toBeCloseTo(0.4994955, 5);

    const defaultCurvePoints = [
      point(0, 0, 0, { positionM: [0, 0, 0], leaveTangentM: [1, 0, 0] }),
      point(1, 1, 0, { positionM: [1, 0, 0], arriveTangentM: [1, 0, 0], leaveTangentM: [1, 0, 0] }),
      point(2, 2, 0, { positionM: [2, 10, 0], arriveTangentM: [1, 0, 0] }),
    ];
    const legacy = body('river', defaultCurvePoints, false);
    const versioned = {
      ...legacy,
      spline: {
        ...legacy.spline,
        interpolationVersion: 'ue-water-spline/1' as const,
        points: defaultCurvePoints.map((splinePoint) => ({
          ...splinePoint,
          rotationQuat: [0, 0, 0, 1] as const,
        })),
      },
    };
    expect(
      Math.min(
        ...requiredFixtureValue(sampleSplineSegments(legacy, 0.05)[0]).map(
          (sample) => sample.positionM[1],
        ),
      ),
    ).toBeGreaterThanOrEqual(-1e-8);
    expect(
      Math.min(
        ...requiredFixtureValue(sampleSplineSegments(versioned, 0.05)[0]).map(
          (sample) => sample.positionM[1],
        ),
      ),
    ).toBeLessThan(0);
    expect(
      validateWaterAsset({
        ...versioned,
        spline: {
          ...versioned.spline,
          points: versioned.spline.points.map((splinePoint, index) =>
            index === 1 ? { ...splinePoint, up: [1, 0, 0] as const } : splinePoint,
          ),
        },
      }).ok,
    ).toBe(false);

    const orientation = {
      ...body(
        'river',
        [
          point(0, 0, 0, {
            positionM: [0, 0, 0],
            interpolationMode: 'linear',
            rotationQuat: [0, 0, 0, 1],
          }),
          point(1, 10, 0, {
            positionM: [10, 0, 0],
            interpolationMode: 'linear',
            rotationQuat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
            up: [0, 0, 1],
          }),
        ],
        false,
      ),
      spline: {
        closed: false,
        interpolationVersion: 'ue-water-spline/1' as const,
        points: [
          point(0, 0, 0, {
            positionM: [0, 0, 0],
            interpolationMode: 'linear',
            rotationQuat: [0, 0, 0, 1],
          }),
          point(1, 10, 0, {
            positionM: [10, 0, 0],
            interpolationMode: 'linear',
            rotationQuat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
            up: [0, 0, 1],
          }),
        ],
      },
    };
    const middle = requiredFixtureValue(
      requiredFixtureValue(sampleSplineSegments(orientation, 0.05)[0]).find(
        (sample) => Math.abs(sample.inputKey - 0.5) < 1e-6,
      ),
    );
    expect(middle.up[0]).toBeCloseTo(0, 6);
    expect(middle.up[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(middle.up[2]).toBeCloseTo(Math.SQRT1_2, 5);

    const antipodal = {
      ...orientation,
      spline: {
        ...orientation.spline,
        points: [
          point(0, 0, 0, {
            positionM: [0, 0, 0],
            interpolationMode: 'linear',
            rotationQuat: [0, 0, 0, 1],
          }),
          point(1, 10, 0, {
            positionM: [10, 0, 0],
            interpolationMode: 'linear',
            rotationQuat: [0, 0, 0, -1],
          }),
        ],
      },
    };
    const antipodalMidpoint = requiredFixtureValue(
      requiredFixtureValue(sampleSplineSegments(antipodal, 0.05)[0])[1],
    );
    expect(antipodalMidpoint.up).toEqual([0, 1, 0]);

    const controlSign = {
      ...orientation,
      spline: {
        ...orientation.spline,
        points: [
          point(0, 0, 0, {
            positionM: [0, 0, 0],
            interpolationMode: 'curve-custom-tangent',
            rotationQuat: [0, 0, 0, 1],
            arriveRotationQuat: [0, 0, 0, 1],
            leaveRotationQuat: [0, 0, 0, 1],
          }),
          point(1, 10, 0, {
            positionM: [10, 0, 0],
            interpolationMode: 'curve-custom-tangent',
            rotationQuat: [0, 0, 0, 1],
            arriveRotationQuat: [
              Math.sin((100 * Math.PI) / 180),
              0,
              0,
              Math.cos((100 * Math.PI) / 180),
            ],
            leaveRotationQuat: [0, 0, 0, 1],
          }),
        ],
      },
    };
    const controlMidpoint = requiredFixtureValue(
      requiredFixtureValue(sampleSplineSegments(controlSign, 0.05)[0])[1],
    );
    expect(controlMidpoint.up[1]).toBeCloseTo(Math.cos((50 * Math.PI) / 180), 5);
    expect(controlMidpoint.up[2]).toBeCloseTo(Math.sin((50 * Math.PI) / 180), 5);

    const unsupported = {
      ...legacy,
      spline: {
        ...legacy.spline,
        points: legacy.spline.points.map((splinePoint, index) =>
          index === 0 ? { ...splinePoint, interpolationMode: 'constant' } : splinePoint,
        ),
      },
    };
    expect(validateWaterAsset(unsupported).ok).toBe(false);
    expect(validateWaterAsset({ ...legacy, heightOffsetM: 1 }).ok).toBe(false);
    expect(validateWaterAsset({ ...legacy, shapeDilationM: -0.01 }).ok).toBe(false);
  });

  it('uses resolved UE auto tangents consistently for River geometry, bounds, collision, query volume and insertion', () => {
    const versioned = {
      ...body(
        'river',
        [
          point(0, 0, 0, {
            positionM: [0, 0, 0],
            interpolationMode: 'curve',
            arriveTangentM: [0, 100, 0],
            leaveTangentM: [0, 100, 0],
            rotationQuat: [0, 0, 0, 1],
          }),
          point(1, 5, 2, {
            positionM: [5, 0, 2],
            interpolationMode: 'curve',
            arriveTangentM: [0, -100, 0],
            leaveTangentM: [0, -100, 0],
            rotationQuat: [0, 0, 0, 1],
          }),
          point(2, 10, 0, {
            positionM: [10, 3, 0],
            interpolationMode: 'curve',
            arriveTangentM: [0, 100, 0],
            leaveTangentM: [0, 100, 0],
            rotationQuat: [0, 0, 0, 1],
          }),
        ],
        false,
      ),
      spline: {
        closed: false,
        interpolationVersion: 'ue-water-spline/1' as const,
        points: [
          point(0, 0, 0, {
            positionM: [0, 0, 0],
            interpolationMode: 'curve',
            arriveTangentM: [0, 100, 0],
            leaveTangentM: [0, 100, 0],
            rotationQuat: [0, 0, 0, 1],
          }),
          point(1, 5, 2, {
            positionM: [5, 0, 2],
            interpolationMode: 'curve',
            arriveTangentM: [0, -100, 0],
            leaveTangentM: [0, -100, 0],
            rotationQuat: [0, 0, 0, 1],
          }),
          point(2, 10, 0, {
            positionM: [10, 3, 0],
            interpolationMode: 'curve',
            arriveTangentM: [0, 100, 0],
            leaveTangentM: [0, 100, 0],
            rotationQuat: [0, 0, 0, 1],
          }),
        ],
      },
    };
    const resolvedPoints = resolveWaterSplinePoints(versioned.spline);
    const resolved = { ...versioned, spline: { ...versioned.spline, points: resolvedPoints } };
    expect(requiredFixtureValue(resolvedPoints[0]).leaveTangentM).toEqual([5, 0, 2]);
    expect(requiredFixtureValue(resolvedPoints[1]).arriveTangentM).toEqual([5, 1.5, 0]);

    const cooked = buildWaterBodyGeometry(versioned).unwrap();
    const canonicalCooked = buildWaterBodyGeometry(resolved).unwrap();
    expect(cooked.queryFootprint).toEqual(canonicalCooked.queryFootprint);
    expect(cooked.riverSegments.map((segment) => segment.start.leaveTangentM)).toEqual(
      resolvedPoints.map((point) => point.leaveTangentM).slice(0, -1),
    );
    expect(cooked.riverSegments.map((segment) => segment.visibleMesh.attributes.position)).toEqual(
      canonicalCooked.riverSegments.map((segment) => segment.visibleMesh.attributes.position),
    );
    expect(cooked.riverSegments.map((segment) => segment.collisionConvexes)).toEqual(
      canonicalCooked.riverSegments.map((segment) => segment.collisionConvexes),
    );
    expect(waterBodyCollisionDescriptor(versioned)).toEqual(waterBodyCollisionDescriptor(resolved));
    expect(waterQueryVolume(versioned)).toEqual(waterQueryVolume(resolved));

    const lakePoints = loop([
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
    ]).map((splinePoint) => ({
      ...splinePoint,
      interpolationMode: 'curve' as const,
      arriveTangentM: [25, 30, -20] as const,
      leaveTangentM: [-25, -30, 20] as const,
      rotationQuat: [0, 0, 0, 1] as const,
    }));
    const versionedLake = {
      ...body('lake', lakePoints),
      spline: {
        closed: true,
        interpolationVersion: 'ue-water-spline/1' as const,
        points: lakePoints,
      },
    };
    const resolvedLake = {
      ...versionedLake,
      spline: { ...versionedLake.spline, points: resolveWaterSplinePoints(versionedLake.spline) },
    };
    expect(buildWaterBodyGeometry(versionedLake).unwrap().visibleMesh?.attributes.position).toEqual(
      buildWaterBodyGeometry(resolvedLake).unwrap().visibleMesh?.attributes.position,
    );
    expect(waterBodyCollisionDescriptor(versionedLake)).toEqual(
      waterBodyCollisionDescriptor(resolvedLake),
    );

    const autoSpline = versioned.spline;
    const autoPoints = resolveWaterSplinePoints(autoSpline);
    const p0 = requiredFixtureValue(autoPoints[0]),
      p1 = requiredFixtureValue(autoPoints[1]);
    const expectedAtHalf = [0, 1, 2].map(
      (axis) =>
        0.5 * requiredFixtureValue(p0.positionM[axis]) +
        0.125 * requiredFixtureValue(p0.leaveTangentM[axis]) +
        0.5 * requiredFixtureValue(p1.positionM[axis]) -
        0.125 * requiredFixtureValue(p1.arriveTangentM[axis]),
    );
    const inserted = insertWaterSplinePointInSpline(autoSpline, 1, 0.5).unwrap();
    expect(requiredFixtureValue(inserted[1]).positionM).toEqual(expectedAtHalf);
    expect(Math.abs(requiredFixtureValue(inserted[1]).positionM[1])).toBeLessThan(1);
    expect(requiredFixtureValue(inserted[0]).leaveTangentM).toEqual(
      requiredFixtureValue(versioned.spline.points[0]).leaveTangentM,
    );
  });

  it('matches UE five-point spline length reparameterization on an asymmetric high-curvature segment', () => {
    const curved = body(
      'river',
      [
        point(0, 0, 0, {
          positionM: [0, 0, 0],
          interpolationMode: 'curve-custom-tangent',
          leaveTangentM: [3, 10, 1],
        }),
        point(1, 8, 5, {
          positionM: [8, 2, 5],
          interpolationMode: 'curve-custom-tangent',
          arriveTangentM: [9, -4, 0],
        }),
      ],
      false,
    );
    const samples = requiredFixtureValue(sampleSplineSegments(curved, 0.05)[0]);
    const distanceMidpoint = samples.find((sample) => Math.abs(sample.inputKey - 0.5094428) < 1e-6);
    expect(distanceMidpoint).toBeDefined();
    expect(requiredFixtureValue(distanceMidpoint).inputKey).toBeCloseTo(0.5094428, 6);
    expect(requiredFixtureValue(distanceMidpoint).positionM[0]).toBeCloseTo(3.3352494, 5);
    expect(requiredFixtureValue(distanceMidpoint).positionM[1]).toBeCloseTo(2.7635417, 5);
    expect(requiredFixtureValue(distanceMidpoint).positionM[2]).toBeCloseTo(2.6934082, 5);
    expect(samples.length).toBeGreaterThan(3);

    const rotatedNonUniformScale = [0, 0, -2, 0, 0, 1, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 1] as const;
    const transformedSamples = requiredFixtureValue(
      sampleSplineSegments(curved, 0.05, rotatedNonUniformScale)[0],
    );
    const transformedMidpoint = transformedSamples.find(
      (sample) => Math.abs(sample.inputKey - 0.558943) < 1e-6,
    );
    expect(transformedMidpoint).toBeDefined();
    expect(requiredFixtureValue(transformedMidpoint).positionM[0]).toBeCloseTo(3.7900907, 5);
    expect(requiredFixtureValue(transformedMidpoint).positionM[1]).toBeCloseTo(2.8145041, 5);
    expect(requiredFixtureValue(transformedMidpoint).positionM[2]).toBeCloseTo(3.0487566, 5);
    const transformedGeometry = buildWaterBodyGeometry(curved, {
      bodyWorldMatrixM: rotatedNonUniformScale,
    }).unwrap();
    expect(requiredFixtureValue(transformedGeometry.riverSegments[0]).samples).toEqual(
      transformedSamples,
    );
    const collisionRing = requiredFixtureValue(
      waterBodyCollisionDescriptor(curved, undefined, undefined, rotatedNonUniformScale),
    ).footprint.outer;
    expect(collisionRing.map((position) => position.join(',')).sort()).toEqual(
      transformedGeometry.queryFootprint.outer.map((position) => position.join(',')).sort(),
    );
  });

  it('inserts mixed-mode V1 spline points using the outgoing segment interpolation mode', () => {
    const linearToCurve = {
      closed: false,
      interpolationVersion: 'ue-water-spline/1' as const,
      points: [
        point(0, 0, 0, {
          positionM: [0, 0, 0],
          interpolationMode: 'linear',
          leaveTangentM: [0, 500, 0],
          rotationQuat: [0, 0, 0, 1],
        }),
        point(1, 4, 0, {
          positionM: [4, 8, 0],
          interpolationMode: 'curve',
          arriveTangentM: [0, -500, 0],
          rotationQuat: [0, 0, 0, 1],
        }),
        point(2, 8, 0, {
          positionM: [8, 8, 0],
          interpolationMode: 'curve',
          rotationQuat: [0, 0, 0, 1],
        }),
      ],
    };
    const linearInserted = insertWaterSplinePointInSpline(linearToCurve, 1, 0.5).unwrap();
    expect(linearInserted[1]).toMatchObject({ interpolationMode: 'linear', positionM: [2, 4, 0] });
    const linearSamples = requiredFixtureValue(
      sampleSplineSegments(
        {
          ...body('river', linearInserted, false),
          spline: { ...linearToCurve, points: linearInserted },
        },
        100,
      )[0],
    );
    expect(requiredFixtureValue(linearSamples[1]).positionM).toEqual([1, 2, 0]);

    const curveToLinear = {
      ...linearToCurve,
      points: [
        {
          ...requiredFixtureValue(linearToCurve.points[0]),
          interpolationMode: 'curve' as const,
          leaveTangentM: [4, 16, 0] as const,
        },
        {
          ...requiredFixtureValue(linearToCurve.points[1]),
          interpolationMode: 'linear' as const,
          arriveTangentM: [4, -8, 0] as const,
        },
        requiredFixtureValue(linearToCurve.points[2]),
      ],
    };
    const resolvedCurve = resolveWaterSplinePoints(curveToLinear);
    const a = requiredFixtureValue(resolvedCurve[0]),
      b = requiredFixtureValue(resolvedCurve[1]);
    const expectedCurveMidpoint = [0, 1, 2].map(
      (axis) =>
        0.5 * requiredFixtureValue(a.positionM[axis]) +
        0.125 * requiredFixtureValue(a.leaveTangentM[axis]) +
        0.5 * requiredFixtureValue(b.positionM[axis]) -
        0.125 * requiredFixtureValue(b.arriveTangentM[axis]),
    );
    const curveInserted = insertWaterSplinePointInSpline(curveToLinear, 1, 0.5).unwrap();
    expect(requiredFixtureValue(curveInserted[1]).interpolationMode).toBe('curve');
    expect(requiredFixtureValue(curveInserted[1]).positionM).toEqual(expectedCurveMidpoint);

    const controlQuat = [
      Math.sin((100 * Math.PI) / 180),
      0,
      0,
      Math.cos((100 * Math.PI) / 180),
    ] as const;
    const customRotation = {
      closed: false,
      interpolationVersion: 'ue-water-spline/1' as const,
      points: [
        point(0, 0, 0, {
          positionM: [0, 0, 0],
          interpolationMode: 'curve-custom-tangent',
          leaveTangentM: [10, 0, 0],
          rotationQuat: [0, 0, 0, 1],
          arriveRotationQuat: [0, 0, 0, 1],
          leaveRotationQuat: [0, 0, 0, 1],
        }),
        point(1, 10, 0, {
          positionM: [10, 0, 0],
          interpolationMode: 'curve-custom-tangent',
          arriveTangentM: [10, 0, 0],
          rotationQuat: [0, 0, 0, 1],
          arriveRotationQuat: controlQuat,
          leaveRotationQuat: [0, 0, 0, 1],
        }),
      ],
    };
    const customBody = { ...body('river', customRotation.points, false), spline: customRotation };
    const actualSample = requiredFixtureValue(
      requiredFixtureValue(sampleSplineSegments(customBody, 100)[0])[1],
    );
    const customInserted = insertWaterSplinePointInSpline(customRotation, 1, 0.5).unwrap();
    expect(requiredFixtureValue(customInserted[1]).rotationQuat).toEqual(actualSample.rotationQuat);
    expect(requiredFixtureValue(customInserted[1]).up).toEqual(actualSample.up);
    expect(
      validateWaterAsset({ ...customBody, spline: { ...customRotation, points: customInserted } })
        .ok,
    ).toBe(true);
  });

  it('bakes a nonzero UE spline roll into V1 quaternion keys used by the WaterInfo frame', () => {
    const halfRoll = (15 * Math.PI) / 180;
    const rotationQuat = [Math.sin(halfRoll), 0, 0, Math.cos(halfRoll)] as const;
    const up = [0, Math.cos(2 * halfRoll), Math.sin(2 * halfRoll)] as const;
    const river = {
      ...body(
        'river',
        [
          point(0, 0, 0, { positionM: [0, 0, 0], interpolationMode: 'linear', rotationQuat, up }),
          point(1, 10, 0, { positionM: [10, 0, 0], interpolationMode: 'linear', rotationQuat, up }),
        ],
        false,
      ),
      spline: {
        closed: false,
        interpolationVersion: 'ue-water-spline/1' as const,
        points: [
          point(0, 0, 0, { positionM: [0, 0, 0], interpolationMode: 'linear', rotationQuat, up }),
          point(1, 10, 0, { positionM: [10, 0, 0], interpolationMode: 'linear', rotationQuat, up }),
        ],
      },
    };
    const geometry = buildWaterBodyGeometry(river).unwrap();
    const positions = requiredFixtureValue(geometry.waterInfoMesh).attributes
      .position as Float32Array;
    expect(positions[0]).toBe(0);
    expect(positions[1]).toBe(0);
    expect(positions[2]).toBeCloseTo(-2 * Math.cos(2 * halfRoll), 6);
    expect(positions[3]).toBe(0);
    expect(positions[4]).toBe(0);
    expect(positions[5]).toBeCloseTo(2 * Math.cos(2 * halfRoll), 6);
    expect(validateWaterAsset(river).ok).toBe(true);
  });

  it('encodes River flow heading from the curved spline tangent at each WaterInfo row', () => {
    const river = body(
      'river',
      [
        point(0, 0, 0, { leaveTangentM: [10, 0, 10], velocityMPerSec: 1 }),
        point(1, 10, 0, { arriveTangentM: [10, 0, -10], velocityMPerSec: 1 }),
      ],
      false,
    );
    const geometry = buildWaterBodyGeometry(river).unwrap();
    const samples = flattenSplineSegments(sampleSplineSegments(river, 0.05), false);
    const middleIndex = samples.reduce(
      (best, sample, index) =>
        Math.abs(sample.inputKey - 0.5) <
        Math.abs(requiredFixtureValue(samples[best]).inputKey - 0.5)
          ? index
          : best,
      0,
    );
    expect(middleIndex).toBeGreaterThan(0);
    const expected =
      Math.atan2(
        requiredFixtureValue(samples[middleIndex]).leaveTangentM[2],
        requiredFixtureValue(samples[middleIndex]).leaveTangentM[0],
      ) /
      (Math.PI * 2);
    const chordBasedHeading =
      Math.atan2(
        requiredFixtureValue(samples[middleIndex]).positionM[2] -
          requiredFixtureValue(samples[middleIndex - 1]).positionM[2],
        requiredFixtureValue(samples[middleIndex]).positionM[0] -
          requiredFixtureValue(samples[middleIndex - 1]).positionM[0],
      ) /
      (Math.PI * 2);
    expect(Math.abs(expected - chordBasedHeading)).toBeGreaterThan(0.01);
    expect(geometry.flowByVertex[middleIndex * 4 + 1]).toBeCloseTo(expected, 5);
  });

  it('uses the final ArriveTangent for an open River flow heading and WaterInfo cross-section', () => {
    const river = body(
      'river',
      [
        point(0, 0, 0, { leaveTangentM: [10, 0, 0] }),
        point(1, 10, 0, { arriveTangentM: [0, 0, 10], leaveTangentM: [10, 0, 0] }),
      ],
      false,
    );
    const geometry = buildWaterBodyGeometry(river).unwrap();
    const finalRow = geometry.flowByVertex.length / 4 - 1;
    expect(geometry.flowByVertex[finalRow * 4 + 1]).toBeCloseTo(0.25, 5);
    const positions = requiredFixtureValue(geometry.waterInfoMesh).attributes
      .position as Float32Array;
    expect(positions[finalRow * 6]).toBeCloseTo(12, 5);
    expect(positions[(finalRow * 2 + 1) * 3]).toBeCloseTo(8, 5);
  });

  it('emits one spline mesh and collision mesh per control-point segment with endpoint scales', () => {
    const river = body(
      'river',
      [
        point(0, 0, 0, { leaveTangentM: [8, 0, 0], widthM: 4, depthM: 2 }),
        point(1, 8, 4, {
          arriveTangentM: [8, 0, 0],
          leaveTangentM: [0, 0, 8],
          widthM: 10,
          depthM: 5,
        }),
        point(2, 12, 12, { arriveTangentM: [0, 0, 8], widthM: 6, depthM: 3 }),
      ],
      false,
    );
    const cooked = buildWaterBodyGeometry(river).unwrap();
    expect(cooked.riverSegments).toHaveLength(2);
    expect(cooked.collisionMesh).toBeUndefined();
    expect(cooked.riverSegments[0]).toMatchObject({
      controlPointIndex: 0,
      forwardAxis: 'x',
      splineUpDir: [0, 1, 0],
      startScaleM: [4, 2],
      endScaleM: [10, 5],
    });
    expect(cooked.riverSegments[1]).toMatchObject({
      controlPointIndex: 1,
      startScaleM: [10, 5],
      endScaleM: [6, 3],
    });
    expect(requiredFixtureValue(cooked.riverSegments[0]).samples.length).toBeGreaterThan(2);
    expect(requiredFixtureValue(cooked.riverSegments[1]).samples.length).toBeGreaterThan(2);
    expect(
      cooked.riverSegments.every(
        (segment) =>
          (segment.visibleMesh.attributes.position as Float32Array).length / 3 === 44 &&
          requiredFixtureValue(segment.visibleMesh.indices).length === 180 &&
          segment.collisionConvexes?.length === 4,
      ),
    ).toBe(true);
    expect(cooked.visibleMesh).toBeUndefined();
    expect(cooked.visibleSegments).toEqual(
      cooked.riverSegments.map((segment) => segment.visibleMesh),
    );
    expect(requiredFixtureValue(cooked.riverSegments[0]).visibleMesh).not.toBe(
      requiredFixtureValue(cooked.riverSegments[1]).visibleMesh,
    );
    const physicsInput = buildRiverPhysicsCandidateInput({
      entity: 7,
      sourceKey: 'river:main',
      revision: 1,
      segments: cooked.riverSegments,
    }).unwrap();
    expect(physicsInput.shapes[0]).toMatchObject({
      kind: 'convex-compound',
      id: 'water-river',
      revision: 1,
      pieces: expect.any(Array),
    });
    expect(
      physicsInput.shapes[0]?.kind === 'convex-compound' ? physicsInput.shapes[0].pieces : [],
    ).toHaveLength(8);
  });

  it('deforms the audited UE RiverMesh vertices and UVs using the X-axis slice transform', () => {
    const river = body(
      'river',
      [
        point(0, 0, 0, { leaveTangentM: [10, 0, 0], widthM: 4, depthM: 2 }),
        point(1, 10, 0, { arriveTangentM: [10, 0, 0], widthM: 8, depthM: 4 }),
      ],
      false,
    );
    const segment = requiredFixtureValue(buildWaterBodyGeometry(river).unwrap().riverSegments[0]);
    const position = segment.visibleMesh.attributes.position as Float32Array;
    const uv = segment.visibleMesh.attributes.uv as Float32Array;
    expect(position.length / 3).toBe(44);
    expect(segment.visibleMesh.indices?.length).toBe(180);
    expect([...position.slice(0, 3)]).toEqual([0, 2, -2]);
    expect([...position.slice(9, 12)]).toEqual([0, 2, 2]);
    expect([...position.slice(60, 63)]).toEqual([5, 2, -3]);
    expect([...uv.slice(0, 2)]).toEqual([1, 0]);
    expect([...uv.slice(40, 42)]).toEqual([0.5, 0]);
    expect(segment.collisionConvexes?.[0]?.length).toBe(24);
    expect([
      ...requiredFixtureValue(requiredFixtureValue(segment.collisionConvexes)[0]).slice(0, 3),
    ]).toEqual([0, 0, -2]);
    expect([...requiredFixtureValue(segment.visibleMesh.indices).slice(0, 6)]).toEqual([
      4, 0, 5, 1, 5, 0,
    ]);
    expect(
      requiredFixtureValue(segment.collisionConvexes).map((hull) => [
        Math.min(
          ...Array.from({ length: hull.length / 3 }, (_, i) => requiredFixtureValue(hull[i * 3])),
        ),
        Math.max(
          ...Array.from({ length: hull.length / 3 }, (_, i) => requiredFixtureValue(hull[i * 3])),
        ),
        Math.min(
          ...Array.from({ length: hull.length / 3 }, (_, i) =>
            requiredFixtureValue(hull[i * 3 + 2]),
          ),
        ),
        Math.max(
          ...Array.from({ length: hull.length / 3 }, (_, i) =>
            requiredFixtureValue(hull[i * 3 + 2]),
          ),
        ),
      ]),
    ).toEqual([
      [0, 2.5, -2.5, 2.5],
      [7.5, 10, -4, 4],
      [5, 7.5, -3.5, 3.5],
      [2.5, 5, -3, 3],
    ]);
  });

  it('keeps Custom geometry absent without an override and requires explicit mesh participation', () => {
    const custom = body('custom', [point(0, 0, 0), point(1, 2, 0)], false);
    const absent = buildWaterBodyGeometry(custom).unwrap();
    expect(absent.visibleMesh).toBeUndefined();
    expect(absent.waterInfoMesh).toBeUndefined();
    const overrideBase = createBoxGeometry(2, 1, 2).unwrap();
    const authoredColors = new Float32Array((overrideBase.attributes.position.length / 3) * 4);
    for (let vertex = 0; vertex < authoredColors.length / 4; vertex++)
      authoredColors.set([0.25, 0.5, 0.75, 1], vertex * 4);
    const override = withVertexColors(overrideBase, authoredColors).unwrap();
    const optedIn = buildWaterBodyGeometry(
      {
        ...custom,
        customMeshOverrideGuid: '00000000-0000-7000-8000-000000000009',
        flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      },
      { customOverride: override },
    ).unwrap();
    expect(optedIn.visibleMesh).toBe(override);
    expect(optedIn.visibleMesh?.attributes.color).toEqual(authoredColors);
    expect(optedIn.visibleMesh?.vertices).toBe(override.vertices);
    expect(optedIn.visibleMesh?.attributes.position).toEqual(override.attributes.position);
    expect(optedIn.waterInfoMesh?.attributes.position).toEqual(override.attributes.position);
    expect(optedIn.waterInfoMesh?.vertices).not.toBe(optedIn.visibleMesh?.vertices);
    expect(optedIn.waterInfoMesh?.attributes.color).not.toBe(override.attributes.color);
    expect(optedIn.waterInfoMesh?.attributes.color).not.toEqual(authoredColors);
  });

  it('publishes explicit Custom WaterInfo from its override without a dilated product', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000298');
    const overrideGuid = AssetGuid.format(AssetGuid.derive(packageId, 'mesh/custom'));
    const override = createBoxGeometry(2, 1, 2).unwrap();
    const source = {
      ...body('custom', [point(0, 0, 0), point(1, 2, 0)], false),
      customMeshOverrideGuid: overrideGuid,
      shapeDilationM: 4,
      flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
      collision: { type: 'none' as const, enabled: false },
    };
    const packed = await buildWaterPackOutputs(
      { 'custom/body': source },
      { packageId, readByGuid: async () => ({ ok: true as const, value: override }) },
    );
    expect(packed.ok, JSON.stringify(packed.ok ? undefined : packed.error)).toBe(true);
    if (!packed.ok) return;

    const cooked = packed.value['custom/body'] as WaterBodyAsset;
    expect(cooked).toMatchObject({
      kind: 'water-body',
      type: 'custom',
      customMeshOverrideGuid: overrideGuid,
      waterGeometryVersion: 2,
    });
    expect(cooked.waterInfoMeshGuid).toBe(
      AssetGuid.format(AssetGuid.derive(packageId, 'custom/body/water-info')),
    );
    expect(cooked.waterInfoMeshGuid).not.toBe(cooked.customMeshOverrideGuid);
    expect(cooked.dilatedWaterInfoMeshGuid).toBeUndefined();
    expect(packed.value['custom/body/water-info']).toMatchObject({ kind: 'mesh' });
    expect(validateWaterAsset(cooked).ok).toBe(true);
    expect(validateWaterRuntimeBody(cooked).ok).toBe(true);
    expect(
      validateWaterAsset({
        ...cooked,
        dilatedWaterInfoMeshGuid: AssetGuid.format(
          AssetGuid.derive(packageId, 'custom/body/water-info-dilated'),
        ),
      }).ok,
    ).toBe(false);

    const { waterInfoMeshGuid: _waterInfoMeshGuid, ...missingWaterInfo } = cooked;
    expect(validateWaterAsset(missingWaterInfo).ok).toBe(false);
    const withoutOverride = await buildWaterPackOutputs(
      {
        'custom/body': { ...source, customMeshOverrideGuid: undefined },
      },
      { packageId },
    );
    expect(withoutOverride.ok).toBe(false);
    if (!withoutOverride.ok)
      expect(withoutOverride.error.expected).toBe(
        'Custom WaterInfo participation requires customMeshOverrideGuid',
      );
  });

  it('matches WaterSplineMetadata insert, duplicate, delete and Fixup key behavior', () => {
    const source = [
      point(0, 0, 0, { widthM: 4, depthM: 2, velocityMPerSec: -2, audioIntensity: 0.2 }),
      point(1, 4, 0, { widthM: 12, depthM: 6, velocityMPerSec: 4, audioIntensity: 0.8 }),
    ];
    const inserted = insertWaterSplinePoint(source, 1, 0.25).unwrap();
    expect(inserted[1]).toMatchObject({ inputKey: 1, widthM: 6, depthM: 3, velocityMPerSec: -0.5 });
    expect(inserted[1]?.audioIntensity).toBeCloseTo(0.35, 12);
    expect(inserted[2]?.inputKey).toBe(2);
    expect(
      duplicateWaterSplinePoint(source, 1)
        .unwrap()
        .map((p) => [p.inputKey, p.widthM]),
    ).toEqual([
      [0, 4],
      [1, 12],
      [2, 12],
    ]);
    expect(
      deleteWaterSplinePoint(duplicateWaterSplinePoint(source, 1).unwrap(), 1)
        .unwrap()
        .map((p) => p.inputKey),
    ).toEqual([0, 1]);
    expect(
      fixupWaterSpline(source.map((p) => ({ ...p, inputKey: -2 }))).map((p) => p.inputKey),
    ).toEqual([0, 1]);
    expect(
      insertWaterSplinePoint(
        [
          { ...requiredFixtureValue(source[0]), inputKey: 0 },
          { ...requiredFixtureValue(source[1]), inputKey: 0 },
        ],
        1,
        0.5,
      ).ok,
    ).toBe(false);
    expect(insertWaterSplinePoint(source, 1, 0).unwrap()[1]?.positionM).toEqual(
      source[0]?.positionM,
    );
    expect(insertWaterSplinePoint(source, 1, 1).unwrap()[1]?.positionM).toEqual(
      source[1]?.positionM,
    );
  });

  it('keeps versioned UE auto-tangent spline identity and metadata when duplicating a point', () => {
    const points = [
      point(0, 0, 0, { positionM: [0, 0, 0], rotationQuat: [0, 0, 0, 1] }),
      point(1, 4, 2, { positionM: [4, 1, 2], rotationQuat: [0, 0, 0, 1], widthM: 8, depthM: 5 }),
      point(2, 9, 3, { positionM: [9, 0, 3], rotationQuat: [0, 0, 0, 1] }),
    ];
    const spline = { closed: false, interpolationVersion: 'ue-water-spline/1' as const, points };
    const duplicated = duplicateWaterSplinePointInSpline(spline, 1).unwrap();
    expect(duplicated.map((value) => value.inputKey)).toEqual([0, 1, 2, 3]);
    expect(duplicated[1]).toMatchObject({
      positionM: [4, 1, 2],
      rotationQuat: [0, 0, 0, 1],
      widthM: 8,
      depthM: 5,
    });
    expect(duplicated[2]).toMatchObject({
      positionM: [4, 1, 2],
      rotationQuat: [0, 0, 0, 1],
      widthM: 8,
      depthM: 5,
    });
    expect(
      requiredFixtureValue(resolveWaterSplinePoints({ ...spline, points: duplicated })[1])
        .leaveTangentM,
    ).toEqual([2, 0.5, 1]);
    expect(
      duplicateWaterSplinePointInSpline(
        { ...spline, points: points.map(({ rotationQuat: _rotation, ...value }) => value) },
        1,
      ).ok,
    ).toBe(false);
  });

  it('rejects a spline insertion whose River ribbon splits into disconnected query footprints', () => {
    const source = [
      point(0, 0, 0, {
        positionM: [0, 2, 0],
        leaveTangentM: [9, 3, 2],
        widthM: 4,
        depthM: 2,
        velocityMPerSec: -2,
        audioIntensity: 0.2,
      }),
      point(1, 8, 4, {
        positionM: [8, 4, 4],
        arriveTangentM: [2, -1, 8],
        widthM: 12,
        depthM: 10,
        velocityMPerSec: 4,
        audioIntensity: 0.8,
      }),
    ];
    const inserted = insertWaterSplinePoint(source, 1, 0.25).unwrap();
    expect(inserted[1]).toMatchObject({ widthM: 6, depthM: 4, velocityMPerSec: -0.5 });
    expect(inserted[1]?.audioIntensity).toBeCloseTo(0.35, 12);
    const afterGeometry = buildWaterBodyGeometry(body('river', inserted, false));
    expect(afterGeometry.ok).toBe(false);
    if (!afterGeometry.ok)
      expect(afterGeometry.error.expected).toBe(
        'one connected River WaterInfo/query footprint after ribbon union',
      );
  });

  it('preserves the curved River position and collision cross-section when inserting into a connected ribbon', () => {
    const source = [
      point(0, 0, 0, {
        positionM: [0, 2, 0],
        leaveTangentM: [8, 2, 4],
        widthM: 4,
        depthM: 2,
        velocityMPerSec: -2,
        audioIntensity: 0.2,
      }),
      point(1, 8, 4, {
        positionM: [8, 4, 4],
        arriveTangentM: [10, 0, 2],
        widthM: 12,
        depthM: 10,
        velocityMPerSec: 4,
        audioIntensity: 0.8,
      }),
    ];
    const inserted = insertWaterSplinePoint(source, 1, 0.25).unwrap();
    expect(inserted[1]).toMatchObject({ widthM: 6, depthM: 4, velocityMPerSec: -0.5 });
    expect(inserted[1]?.audioIntensity).toBeCloseTo(0.35, 12);
    expect(inserted[1]?.positionM).toEqual([1.90625, 2.59375, 1.09375]);
    expect(inserted[1]?.arriveTangentM).toEqual([1.84375, 0.65625, 1.15625]);
    expect(inserted[1]?.leaveTangentM).toEqual([5.53125, 1.96875, 3.46875]);
    expect(inserted[0]?.leaveTangentM).toEqual([2, 0.5, 1]);
    expect(inserted[2]?.arriveTangentM).toEqual([7.5, 0, 1.5]);
    const oldQuarterMetadata = {
      widthM:
        requiredFixtureValue(source[0]).widthM * 0.75 +
        requiredFixtureValue(source[1]).widthM * 0.25,
      depthM:
        requiredFixtureValue(source[0]).depthM * 0.75 +
        requiredFixtureValue(source[1]).depthM * 0.25,
    };
    expect(oldQuarterMetadata).toEqual({
      widthM: requiredFixtureValue(inserted[1]).widthM,
      depthM: requiredFixtureValue(inserted[1]).depthM,
    });
    const before = requiredFixtureValue(
      buildWaterBodyGeometry(body('river', source, false)).unwrap().riverSegments[0],
    );
    const after = requiredFixtureValue(
      buildWaterBodyGeometry(body('river', inserted, false)).unwrap().riverSegments[0],
    );
    const beforePositions = before.visibleMesh.attributes.position as Float32Array;
    const afterPositions = after.visibleMesh.attributes.position as Float32Array;
    for (let lateral = 0; lateral < 4; lateral++) {
      const beforeOffset = (2 * 4 + lateral) * 3;
      const afterOffset = (8 * 4 + lateral) * 3;
      expect([...afterPositions.slice(afterOffset, afterOffset + 3)]).toEqual([
        ...beforePositions.slice(beforeOffset, beforeOffset + 3),
      ]);
    }
    const oldQuarter = requiredFixtureValue(requiredFixtureValue(before.collisionConvexes)[0]);
    const insertedEndpoint = requiredFixtureValue(requiredFixtureValue(after.collisionConvexes)[1]);
    for (const vertex of [1, 3, 5, 7]) {
      const offset = vertex * 3;
      expect([...insertedEndpoint.slice(offset, offset + 3)]).toEqual([
        ...oldQuarter.slice(offset, offset + 3),
      ]);
    }
  });

  it('keeps V-03 River samples within the insertion error budget at common curve positions', () => {
    const original = body(
      'river',
      [
        point(0, 0, 0, {
          positionM: [0, 2, 0],
          leaveTangentM: [8, 2, 4],
          widthM: 4,
          depthM: 2,
          velocityMPerSec: -2,
          audioIntensity: 0.2,
        }),
        point(1, 8, 4, {
          positionM: [8, 4, 4],
          arriveTangentM: [10, 0, 2],
          widthM: 12,
          depthM: 10,
          velocityMPerSec: 4,
          audioIntensity: 0.8,
        }),
      ],
      false,
    );
    const insertedPoints = insertWaterSplinePoint(original.spline.points, 1, 0.25).unwrap();
    const evaluate = (
      points: readonly WaterBodySourceAsset['spline']['points'][number][],
      t: number,
      tangentScale = 1,
    ) => {
      const source = points;
      const a = requiredFixtureValue(source[0]),
        b = requiredFixtureValue(source[1]);
      const dt = b.inputKey - a.inputKey;
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1,
        h10 = t ** 3 - 2 * t ** 2 + t,
        h01 = -2 * t ** 3 + 3 * t ** 2,
        h11 = t ** 3 - t ** 2;
      const position = [0, 1, 2].map(
        (axis) =>
          h00 * requiredFixtureValue(a.positionM[axis]) +
          h10 * dt * requiredFixtureValue(a.leaveTangentM[axis]) +
          h01 * requiredFixtureValue(b.positionM[axis]) +
          h11 * dt * requiredFixtureValue(b.arriveTangentM[axis]),
      );
      const tangent = [0, 1, 2].map(
        (axis) =>
          (((6 * t ** 2 - 6 * t) * requiredFixtureValue(a.positionM[axis])) / dt +
            (3 * t ** 2 - 4 * t + 1) * requiredFixtureValue(a.leaveTangentM[axis]) +
            ((-6 * t ** 2 + 6 * t) * requiredFixtureValue(b.positionM[axis])) / dt +
            (3 * t ** 2 - 2 * t) * requiredFixtureValue(b.arriveTangentM[axis])) /
          tangentScale,
      );
      return {
        position,
        tangent,
        width: a.widthM * (1 - t) + b.widthM * t,
        depth: a.depthM * (1 - t) + b.depthM * t,
        velocity: a.velocityMPerSec * (1 - t) + b.velocityMPerSec * t,
        audio: a.audioIntensity * (1 - t) + b.audioIntensity * t,
      };
    };
    const distance = (a: readonly number[], b: readonly number[]) =>
      Math.hypot(...a.map((value, index) => value - requiredFixtureValue(b[index])));
    const errors = {
      positionM: 0,
      tangentMPerKey: 0,
      widthM: 0,
      depthM: 0,
      velocityMPerSec: 0,
      audioIntensity: 0,
    };
    for (let index = 0; index <= 100; index++) {
      const t = index / 100;
      const before = evaluate(original.spline.points, t);
      const after =
        t <= 0.25
          ? evaluate(insertedPoints.slice(0, 2), t / 0.25, 0.25)
          : evaluate(insertedPoints.slice(1, 3), (t - 0.25) / 0.75, 0.75);
      errors.positionM = Math.max(errors.positionM, distance(before.position, after.position));
      errors.tangentMPerKey = Math.max(
        errors.tangentMPerKey,
        distance(before.tangent, after.tangent),
      );
      errors.widthM = Math.max(errors.widthM, Math.abs(before.width - after.width));
      errors.depthM = Math.max(errors.depthM, Math.abs(before.depth - after.depth));
      errors.velocityMPerSec = Math.max(
        errors.velocityMPerSec,
        Math.abs(before.velocity - after.velocity),
      );
      errors.audioIntensity = Math.max(errors.audioIntensity, Math.abs(before.audio - after.audio));
    }
    expect(errors.positionM, JSON.stringify(errors)).toBeLessThan(1e-8);
    expect(errors.tangentMPerKey, JSON.stringify(errors)).toBeLessThan(1e-8);
    expect(errors.widthM, JSON.stringify(errors)).toBeLessThan(1e-8);
    expect(errors.depthM, JSON.stringify(errors)).toBeLessThan(1e-8);
    expect(errors.velocityMPerSec, JSON.stringify(errors)).toBeLessThan(1e-8);
    expect(errors.audioIntensity, JSON.stringify(errors)).toBeLessThan(1e-8);

    const toleranceM = 0.01;
    const beforeBody = {
      ...original,
      geometryCook: { splineToleranceM: toleranceM, collisionToleranceM: toleranceM },
    };
    const afterBody = { ...beforeBody, spline: { ...beforeBody.spline, points: insertedPoints } };
    const beforeSamples = requiredFixtureValue(sampleSplineSegments(beforeBody, toleranceM)[0]);
    const afterSampleSegments = sampleSplineSegments(afterBody, toleranceM);
    const afterSamples = flattenSplineSegments(afterSampleSegments, false);
    const interpolateSample = (
      samples: readonly WaterBodySourceAsset['spline']['points'][number][],
      key: number,
    ) => {
      let high = samples.findIndex((sample) => sample.inputKey >= key);
      if (high < 0) high = samples.length - 1;
      const low = requiredFixtureValue(samples[Math.max(0, high - 1)]),
        upper = requiredFixtureValue(samples[high]);
      const blend = (key - low.inputKey) / (upper.inputKey - low.inputKey || 1);
      const vector = (field: 'positionM' | 'arriveTangentM') =>
        [0, 1, 2].map(
          (axis) =>
            requiredFixtureValue(low[field][axis]) * (1 - blend) +
            requiredFixtureValue(upper[field][axis]) * blend,
        );
      const scalar = (field: 'widthM' | 'depthM' | 'velocityMPerSec' | 'audioIntensity') =>
        low[field] * (1 - blend) + upper[field] * blend;
      return {
        position: vector('positionM'),
        tangent: vector('arriveTangentM'),
        width: scalar('widthM'),
        depth: scalar('depthM'),
        velocity: scalar('velocityMPerSec'),
        audio: scalar('audioIntensity'),
      };
    };
    const sampledErrors = {
      positionM: 0,
      tangentMPerKey: 0,
      widthM: 0,
      depthM: 0,
      velocityMPerSec: 0,
      audioIntensity: 0,
    };
    for (let index = 0; index <= 100; index++) {
      const t = index / 100;
      const before = interpolateSample(beforeSamples, t);
      const tangentScale = t <= 0.25 ? 0.25 : 0.75;
      const afterSample =
        t <= 0.25
          ? interpolateSample(requiredFixtureValue(afterSampleSegments[0]), t / 0.25)
          : interpolateSample(requiredFixtureValue(afterSampleSegments[1]), 1 + (t - 0.25) / 0.75);
      const after = {
        ...afterSample,
        tangent: afterSample.tangent.map((value) => value / tangentScale),
      };
      sampledErrors.positionM = Math.max(
        sampledErrors.positionM,
        distance(before.position, after.position),
      );
      sampledErrors.tangentMPerKey = Math.max(
        sampledErrors.tangentMPerKey,
        distance(before.tangent, after.tangent),
      );
      sampledErrors.widthM = Math.max(sampledErrors.widthM, Math.abs(before.width - after.width));
      sampledErrors.depthM = Math.max(sampledErrors.depthM, Math.abs(before.depth - after.depth));
      sampledErrors.velocityMPerSec = Math.max(
        sampledErrors.velocityMPerSec,
        Math.abs(before.velocity - after.velocity),
      );
      sampledErrors.audioIntensity = Math.max(
        sampledErrors.audioIntensity,
        Math.abs(before.audio - after.audio),
      );
    }
    expect(sampledErrors.positionM, JSON.stringify(sampledErrors)).toBeLessThan(toleranceM * 2);
    expect(sampledErrors.tangentMPerKey, JSON.stringify(sampledErrors)).toBeLessThan(0.25);
    expect(sampledErrors.widthM, JSON.stringify(sampledErrors)).toBeLessThan(1e-8);
    expect(sampledErrors.depthM, JSON.stringify(sampledErrors)).toBeLessThan(1e-8);
    expect(sampledErrors.velocityMPerSec, JSON.stringify(sampledErrors)).toBeLessThan(1e-8);
    expect(sampledErrors.audioIntensity, JSON.stringify(sampledErrors)).toBeLessThan(1e-8);

    const beforeGeometry = buildWaterBodyGeometry(beforeBody).unwrap();
    const afterGeometry = buildWaterBodyGeometry(afterBody).unwrap();
    const meshSectionAt = (
      geometry: WaterBodyGeometry,
      samples: readonly WaterBodySourceAsset['spline']['points'][number][],
      key: number,
    ) => {
      const mesh = requiredFixtureValue(geometry.waterInfoMesh);
      const positions = mesh.attributes.position as Float32Array;
      let high = samples.findIndex((sample) => sample.inputKey >= key);
      if (high < 0) high = samples.length - 1;
      const low = Math.max(0, high - 1);
      const blend =
        (key - requiredFixtureValue(samples[low]).inputKey) /
        (requiredFixtureValue(samples[high]).inputKey -
          requiredFixtureValue(samples[low]).inputKey || 1);
      const edge = (row: number, side: number) =>
        Array.from(positions.slice(row * 6 + side * 3, row * 6 + side * 3 + 3));
      const left = [0, 1, 2].map(
        (axis) =>
          requiredFixtureValue(edge(low, 0)[axis]) * (1 - blend) +
          requiredFixtureValue(edge(high, 0)[axis]) * blend,
      );
      const right = [0, 1, 2].map(
        (axis) =>
          requiredFixtureValue(edge(low, 1)[axis]) * (1 - blend) +
          requiredFixtureValue(edge(high, 1)[axis]) * blend,
      );
      return {
        center: left.map((value, axis) => (value + requiredFixtureValue(right[axis])) / 2),
        width: distance(left, right),
      };
    };
    const meshErrors = { waterInfoPositionM: 0, waterInfoWidthM: 0, splineMeshPositionM: 0 };
    for (let index = 0; index <= 100; index++) {
      const t = index / 100;
      const afterKey = t <= 0.25 ? t / 0.25 : 1 + (t - 0.25) / 0.75;
      const before = meshSectionAt(beforeGeometry, beforeSamples, t);
      const after = meshSectionAt(afterGeometry, afterSamples, afterKey);
      meshErrors.waterInfoPositionM = Math.max(
        meshErrors.waterInfoPositionM,
        distance(before.center, after.center),
      );
      meshErrors.waterInfoWidthM = Math.max(
        meshErrors.waterInfoWidthM,
        Math.abs(before.width - after.width),
      );
      const segmentIndex = t <= 0.25 ? 0 : 1;
      const localT = t <= 0.25 ? t / 0.25 : (t - 0.25) / 0.75;
      const beforePositions = requiredFixtureValue(
        requiredFixtureValue(beforeGeometry.visibleSegments)[0],
      ).attributes.position as Float32Array;
      const afterPositions = requiredFixtureValue(
        requiredFixtureValue(afterGeometry.visibleSegments)[segmentIndex],
      ).attributes.position as Float32Array;
      const compareSegmentRow = (positions: Float32Array, parameter: number, lateral: number) => {
        const row = parameter * 10;
        const lower = Math.floor(row),
          upper = Math.min(10, lower + 1),
          blend = row - lower;
        const read = (index: number) =>
          [0, 1, 2].map((axis) =>
            requiredFixtureValue(positions[(index * 4 + lateral) * 3 + axis]),
          );
        const a = read(lower),
          b = read(upper);
        return a.map((value, axis) => value * (1 - blend) + requiredFixtureValue(b[axis]) * blend);
      };
      for (let lateral = 0; lateral < 4; lateral++) {
        meshErrors.splineMeshPositionM = Math.max(
          meshErrors.splineMeshPositionM,
          distance(
            compareSegmentRow(beforePositions, t, lateral),
            compareSegmentRow(afterPositions, localT, lateral),
          ),
        );
      }
    }
    expect(meshErrors.waterInfoPositionM, JSON.stringify(meshErrors)).toBeLessThan(
      toleranceM * 2 + 1e-5,
    );
    expect(meshErrors.waterInfoWidthM, JSON.stringify(meshErrors)).toBeLessThan(toleranceM);
    expect(meshErrors.splineMeshPositionM, JSON.stringify(meshErrors)).toBeLessThan(toleranceM * 3);

    const boundaryDistance = (
      left: readonly (readonly [number, number])[],
      right: readonly (readonly [number, number])[],
    ) => {
      const pointSegmentDistance = (
        point: readonly [number, number],
        start: readonly [number, number],
        end: readonly [number, number],
      ) => {
        const dx = end[0] - start[0],
          dz = end[1] - start[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / (dx * dx + dz * dz || 1),
          ),
        );
        return Math.hypot(point[0] - (start[0] + dx * t), point[1] - (start[1] + dz * t));
      };
      const directed = (
        from: readonly (readonly [number, number])[],
        to: readonly (readonly [number, number])[],
      ) =>
        Math.max(
          ...from.map((point) =>
            Math.min(
              ...to.map((start, index) =>
                pointSegmentDistance(
                  point,
                  start,
                  requiredFixtureValue(to[(index + 1) % to.length]),
                ),
              ),
            ),
          ),
        );
      return Math.max(directed(left, right), directed(right, left));
    };
    const queryErrorM = boundaryDistance(
      beforeGeometry.queryFootprint.outer,
      afterGeometry.queryFootprint.outer,
    );
    expect(queryErrorM, `query boundary Hausdorff error ${queryErrorM}m`).toBeLessThan(
      toleranceM * 3,
    );
    const physicsBefore = buildRiverPhysicsCandidateInput({
      entity: 1,
      sourceKey: 'river/before',
      revision: 1,
      segments: beforeGeometry.riverSegments,
    }).unwrap();
    const physicsAfter = buildRiverPhysicsCandidateInput({
      entity: 2,
      sourceKey: 'river/after',
      revision: 1,
      segments: afterGeometry.riverSegments,
    }).unwrap();
    const convexBounds = (candidate: typeof physicsBefore) => {
      const shape = candidate.shapes[0];
      expect(shape?.kind).toBe('convex-compound');
      if (shape?.kind !== 'convex-compound') return { min: [NaN, NaN, NaN], max: [NaN, NaN, NaN] };
      const vertices = shape.pieces
        .flatMap((piece) =>
          Array.from({ length: piece.length / 3 }, (_, index) => [
            requiredFixtureValue(piece[index * 3]),
            requiredFixtureValue(piece[index * 3 + 1]),
            requiredFixtureValue(piece[index * 3 + 2]),
          ]),
        )
        .flat();
      return {
        min: [0, 1, 2].map((axis) =>
          Math.min(...vertices.filter((_, index) => index % 3 === axis)),
        ),
        max: [0, 1, 2].map((axis) =>
          Math.max(...vertices.filter((_, index) => index % 3 === axis)),
        ),
      };
    };
    const beforeCollisionBounds = convexBounds(physicsBefore),
      afterCollisionBounds = convexBounds(physicsAfter);
    const collisionBoundsErrorM = Math.max(
      ...beforeCollisionBounds.min.map((value, axis) =>
        Math.abs(value - requiredFixtureValue(afterCollisionBounds.min[axis])),
      ),
      ...beforeCollisionBounds.max.map((value, axis) =>
        Math.abs(value - requiredFixtureValue(afterCollisionBounds.max[axis])),
      ),
    );
    expect(collisionBoundsErrorM, `collision bounds error ${collisionBoundsErrorM}m`).toBeLessThan(
      toleranceM * 3,
    );
  });

  it('covers V-03 midpoint duplicate and delete behavior with common-key diagnostics', () => {
    const sourcePoints = [
      point(0, 0, 0, { positionM: [0, 2, 0], leaveTangentM: [5, 0, 0], widthM: 2, depthM: 2 }),
      point(1, 5, 1, {
        positionM: [5, 2, 1],
        arriveTangentM: [5, 0, 0],
        leaveTangentM: [5, 0, 0],
        widthM: 2,
        depthM: 3,
      }),
      point(2, 10, 0, { positionM: [10, 2, 0], arriveTangentM: [5, 0, 0], widthM: 2, depthM: 2 }),
    ];
    const source = body('river', sourcePoints, false);
    const duplicated = duplicateWaterSplinePoint(sourcePoints, 1).unwrap();
    expect(duplicated.map((value) => value.inputKey)).toEqual([0, 1, 2, 3]);
    expect(duplicated[1]).toMatchObject({
      positionM: requiredFixtureValue(sourcePoints[1]).positionM,
      widthM: requiredFixtureValue(sourcePoints[1]).widthM,
      depthM: requiredFixtureValue(sourcePoints[1]).depthM,
    });
    expect(duplicated[2]).toMatchObject({
      positionM: requiredFixtureValue(sourcePoints[1]).positionM,
      widthM: requiredFixtureValue(sourcePoints[1]).widthM,
      depthM: requiredFixtureValue(sourcePoints[1]).depthM,
    });
    const restored = deleteWaterSplinePoint(duplicated, 1).unwrap();
    expect(restored).toEqual(sourcePoints);
    const sourceGeometry = buildWaterBodyGeometry(source).unwrap();
    const restoredGeometry = buildWaterBodyGeometry({
      ...source,
      spline: { ...source.spline, points: restored },
    }).unwrap();
    expect(restoredGeometry.queryFootprint).toEqual(sourceGeometry.queryFootprint);
    expect(
      restoredGeometry.riverSegments.map((segment) => [
        ...(segment.visibleMesh.attributes.position as Float32Array),
      ]),
    ).toEqual(
      sourceGeometry.riverSegments.map((segment) => [
        ...(segment.visibleMesh.attributes.position as Float32Array),
      ]),
    );
    expect(
      restoredGeometry.riverSegments.map((segment) =>
        segment.collisionConvexes?.map((hull) => [...hull]),
      ),
    ).toEqual(
      sourceGeometry.riverSegments.map((segment) =>
        segment.collisionConvexes?.map((hull) => [...hull]),
      ),
    );

    const deleted = deleteWaterSplinePoint(sourcePoints, 1).unwrap();
    const deletedBody = { ...source, spline: { ...source.spline, points: deleted } };
    const deletedGeometry = buildWaterBodyGeometry(deletedBody).unwrap();
    const beforeSamples = sampleSplineSegments(source, 0.05).flat();
    const afterSamples = sampleSplineSegments(deletedBody, 0.05).flat();
    const atKeyFraction = (samples: typeof beforeSamples, fraction: number) => {
      const target =
        fraction *
        (requiredFixtureValue(samples.at(-1)).inputKey - requiredFixtureValue(samples[0]).inputKey);
      let high = samples.findIndex((sample) => sample.inputKey >= target);
      if (high <= 0) high = 1;
      const low = requiredFixtureValue(samples[high - 1]),
        upper = requiredFixtureValue(samples[high]);
      const blend = (target - low.inputKey) / (upper.inputKey - low.inputKey || 1);
      return {
        positionM: [0, 1, 2].map(
          (axis) =>
            requiredFixtureValue(low.positionM[axis]) * (1 - blend) +
            requiredFixtureValue(upper.positionM[axis]) * blend,
        ),
        tangentMPerKey: [0, 1, 2].map(
          (axis) =>
            requiredFixtureValue(low.leaveTangentM[axis]) * (1 - blend) +
            requiredFixtureValue(upper.arriveTangentM[axis]) * blend,
        ),
        widthM: low.widthM * (1 - blend) + upper.widthM * blend,
        depthM: low.depthM * (1 - blend) + upper.depthM * blend,
      };
    };
    const errors = { positionM: 0, tangentMPerKey: 0, widthM: 0, depthM: 0 };
    const distance = (a: readonly number[], b: readonly number[]) =>
      Math.hypot(...a.map((value, index) => value - requiredFixtureValue(b[index])));
    for (let index = 0; index <= 100; index++) {
      const fraction = index / 100;
      const before = atKeyFraction(beforeSamples, fraction);
      const after = atKeyFraction(afterSamples, fraction);
      errors.positionM = Math.max(errors.positionM, distance(before.positionM, after.positionM));
      errors.tangentMPerKey = Math.max(
        errors.tangentMPerKey,
        distance(before.tangentMPerKey, after.tangentMPerKey),
      );
      errors.widthM = Math.max(errors.widthM, Math.abs(before.widthM - after.widthM));
      errors.depthM = Math.max(errors.depthM, Math.abs(before.depthM - after.depthM));
    }
    expect(Object.values(errors).every(Number.isFinite), JSON.stringify(errors)).toBe(true);
    expect(errors.positionM, JSON.stringify(errors)).toBeGreaterThan(1e-3);
    expect(deleted.map((value) => value.inputKey)).toEqual([0, 1]);
    expect(
      deleted.every((value) => Number.isFinite(value.widthM) && Number.isFinite(value.depthM)),
    ).toBe(true);
    expect(deletedGeometry.queryFootprint).not.toEqual(sourceGeometry.queryFootprint);
    expect(
      deletedGeometry.riverSegments.map((segment) => segment.collisionConvexes?.length),
    ).not.toEqual(sourceGeometry.riverSegments.map((segment) => segment.collisionConvexes?.length));
  });

  it('applies independent curve defaults, explicit legacy migration and default-only propagation', () => {
    const source = [
      point(0, 0, 0, { widthM: 4, depthM: 2, velocityMPerSec: 1.28, audioIntensity: 1 }),
      point(1, 4, 0, { widthM: 8, depthM: 3, velocityMPerSec: 7, audioIntensity: 0.3 }),
    ];
    const fixed = fixupWaterSpline(
      [
        {
          ...requiredFixtureValue(source[0]),
          widthM: undefined,
          depthM: undefined,
          velocityMPerSec: undefined,
          audioIntensity: undefined,
        } as never,
      ],
      { widthM: 6, depthM: 5, velocityMPerSec: 2, audioIntensity: 0.5 },
    );
    expect(fixed[0]).toMatchObject({
      widthM: 6,
      depthM: 5,
      velocityMPerSec: 2,
      audioIntensity: 0.5,
    });
    expect(propagateWaterSplineDefaultValue(source, 'widthM', 4, 10).map((p) => p.widthM)).toEqual([
      10, 8,
    ]);
    expect(
      propagateWaterSplineDefaultValue(source, 'velocityMPerSec', 1.28, 2).map(
        (p) => p.velocityMPerSec,
      ),
    ).toEqual([2, 7]);
    const migrated = migrateLegacyWaterSplineMetadataDefaults(
      {
        closed: false,
        points: [point(0, 0, 0, { widthM: 0.008, depthM: 0 }), requiredFixtureValue(source[1])],
      },
      '2.0.0',
    );
    expect(migrated.metadataDefaults).toEqual({
      widthM: 20.48,
      depthM: 1.5,
      velocityMPerSec: 1.28,
      audioIntensity: 1,
    });
    expect(migrated.points[0]).toMatchObject({ widthM: 20.48, depthM: 1.5 });
  });

  it('continues closed River keys and uses authored spline Up and Roll in the sampled frame', () => {
    const closedRiver = body(
      'river',
      [
        point(0, 0, 0, { leaveTangentM: [3, 0, 0], arriveTangentM: [0, 0, 3] }),
        point(1, 4, 0, { leaveTangentM: [0, 0, 3], arriveTangentM: [3, 0, 0] }),
        point(2, 4, 4, { leaveTangentM: [-3, 0, 0], arriveTangentM: [0, 0, 3] }),
      ],
      true,
    );
    const closing = requiredFixtureValue(sampleSplineSegments(closedRiver, 0.01).at(-1));
    expect(closing[0]?.inputKey).toBe(2);
    expect(closing.at(-1)?.inputKey).toBe(3);
    expect(closing[Math.floor(closing.length / 2)]?.positionM.every(Number.isFinite)).toBe(true);
    const insertedAtSeam = insertWaterSplinePoint(closedRiver.spline.points, 0, 0.5, true).unwrap();
    expect(insertedAtSeam).toHaveLength(4);
    expect(insertedAtSeam.map((point) => point.inputKey)).toEqual([0, 1, 2, 3]);
    expect(
      sampleSplineSegments(
        { ...closedRiver, spline: { closed: true, points: insertedAtSeam } },
        0.01,
      )
        .at(-1)
        ?.at(-1)?.inputKey,
    ).toBe(4);

    const rotated = body(
      'river',
      [
        point(0, 0, 0, { leaveTangentM: [10, 0, 0], up: [0, 0, 1], rollAngle: 90 }),
        point(1, 10, 0, { arriveTangentM: [10, 0, 0], up: [0, 0, 1], rollAngle: 90 }),
      ],
      false,
    );
    const segment = requiredFixtureValue(buildWaterBodyGeometry(rotated).unwrap().riverSegments[0]);
    expect(segment.splineUpDir).toEqual([0, 1, 0]);
    expect(segment.startRollRadians).toBe(0);
    expect(segment.endRollRadians).toBe(0);
    const position = segment.visibleMesh.attributes.position as Float32Array;
    expect([...position.slice(0, 3)]).toEqual([0, 2, -2]);
    const normals = segment.visibleMesh.attributes.normal as Float32Array;
    expect(normals[0]).toBeCloseTo(0, 7);
    expect(normals[1]).toBeCloseTo(1, 7);
    expect(normals[2]).toBeCloseTo(0, 7);

    const tilted = body(
      'river',
      [
        point(0, 0, 0, {
          positionM: [0, 2, 0],
          leaveTangentM: [10, 5, 0],
          up: [0, 0, 1],
          rollAngle: 20,
        }),
        point(1, 10, 0, {
          positionM: [10, 7, 0],
          arriveTangentM: [10, 5, 0],
          up: [0, 0, 1],
          rollAngle: 20,
        }),
      ],
      false,
    );
    const tiltedGeometry = buildWaterBodyGeometry(tilted).unwrap();
    const visiblePositions = requiredFixtureValue(tiltedGeometry.riverSegments[0]).visibleMesh
      .attributes.position as Float32Array;
    const infoPositions = requiredFixtureValue(tiltedGeometry.waterInfoMesh).attributes
      .position as Float32Array;
    expect([...visiblePositions.slice(0, 3)]).toEqual([0, 2, -2]);
    expect(infoPositions[0]).toBeCloseTo(-0.84048, 4);
    expect(infoPositions[2]).toBeCloseTo(-0.68404, 4);
    expect(infoPositions[1]).toBe(2);
    expect(infoPositions[3]).toBeCloseTo(0.84048, 4);
    expect(infoPositions[5]).toBeCloseTo(0.68404, 4);
    expect(infoPositions[4]).toBe(2);
  });

  it('cooks River, Lake, Ocean and Custom collision through the real Pack validation path', async () => {
    const packageId = definePackageId('019a0000-0000-7000-8000-000000000298');
    const river = body(
      'river',
      [point(0, 0, 0, { depthM: 2 }), point(1, 4, 0, { depthM: 2 })],
      false,
    );
    const lake = {
      ...body(
        'lake',
        loop([
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ]),
      ),
      collision: { type: 'polygon' as const, enabled: true, channelDepthM: 6 },
    };
    const ocean = {
      ...body(
        'ocean',
        loop([
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]),
      ),
      oceanExtentM: [20, 20] as const,
      collision: {
        type: 'polygon' as const,
        enabled: true,
        collisionHalfHeightM: 20,
        collisionHalfExtentsM: [10, 10] as const,
      },
    };
    const custom = {
      ...body('custom', [point(0, 0, 0), point(1, 2, 0)], false),
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      collision: {
        type: 'polygon' as const,
        enabled: true,
        points: [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ] as const,
      },
    };
    const packed = await buildWaterPackOutputs(
      { 'river/main': river, 'lake/main': lake, 'ocean/main': ocean, 'custom/main': custom },
      { packageId },
    );
    expect(packed.ok, JSON.stringify(packed.ok ? undefined : packed.error)).toBe(true);
    if (!packed.ok) return;
    expect(packed.value['lake/main']).toMatchObject({
      kind: 'water-body',
      collisionMeshGuid: expect.any(String),
    });
    expect(packed.value['ocean/main']).toMatchObject({
      kind: 'water-body',
      collisionMeshGuid: expect.any(String),
    });
    expect(packed.value['custom/main']).toMatchObject({
      kind: 'water-body',
      collisionMeshGuid: expect.any(String),
    });
    expect(packed.value['river/main']).toMatchObject({
      kind: 'water-body',
      riverSegmentMeshGuids: [expect.any(String)],
    });
  });

  it('unions overlapping River ribbon edges before validating a copied point recook', async () => {
    const points = [
      point(0, -8, -3, {
        positionM: [-8, 0.15, -3],
        arriveTangentM: [9, 0, 0],
        leaveTangentM: [9, 0, 0],
        widthM: 3.5,
        depthM: 0.8,
      }),
      point(1, 0, 0, {
        positionM: [0, 0.35, 0],
        arriveTangentM: [8, 1, 3],
        leaveTangentM: [8, 1, 3],
        widthM: 5.5,
        depthM: 1.1,
      }),
      point(2, 8, 5, {
        positionM: [8, 0.5, 5],
        arriveTangentM: [9, 0, 0],
        leaveTangentM: [9, 0, 0],
        widthM: 4.25,
        depthM: 0.9,
      }),
    ];
    const duplicated = duplicateWaterSplinePoint(points, 0)
      .unwrap()
      .map((point, index) =>
        index === 0
          ? { ...point, positionM: [-8.5, point.positionM[1], point.positionM[2]] as const }
          : point,
      );
    const source = { ...body('river', duplicated, false), shapeDilationM: 40.96 };
    const packed = await buildWaterPackOutputs(
      { 'river/main': source },
      {
        packageId: definePackageId('019a0000-0000-7000-8000-000000000299'),
        bodyWorldTransformsM: { 'river/main': identity },
      },
    );
    expect(packed.ok, JSON.stringify(packed.ok ? undefined : packed.error)).toBe(true);
    if (!packed.ok) return;
    const cooked = packed.value['river/main'];
    expect(validateWaterAsset(cooked).ok).toBe(true);
    expect(cooked).toMatchObject({
      kind: 'water-body',
      geometrySnapshot: { queryFootprint: { version: 1 } },
    });
    if (cooked.kind !== 'water-body') return;
    const riverCooked = cooked as Extract<WaterBodyAsset, { type: 'river' }>;
    const footprint = riverCooked.geometrySnapshot?.queryFootprint.outer;
    expect(footprint).toBeDefined();
    if (!footprint) return;
    const inside = (sample: readonly [number, number]) => {
      let contained = false;
      for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
        const a = requiredFixtureValue(footprint[i]),
          b = requiredFixtureValue(footprint[j]);
        if (
          a[1] > sample[1] !== b[1] > sample[1] &&
          sample[0] < ((b[0] - a[0]) * (sample[1] - a[1])) / (b[1] - a[1]) + a[0]
        )
          contained = !contained;
      }
      return contained;
    };
    const area =
      Math.abs(
        footprint.reduce((sum, point, index) => {
          const next = requiredFixtureValue(footprint[(index + 1) % footprint.length]);
          return sum + point[0] * next[1] - next[0] * point[1];
        }, 0),
      ) / 2;
    expect(area).toBeGreaterThan(1);
    for (const point of [
      [-8.5, -3],
      [-8.25, -3],
      [-8, -3],
      [-4, -1.5],
    ] as const)
      expect(inside(point)).toBe(true);
    expect(inside([20, 20])).toBe(false);
    const geometry = buildWaterBodyGeometry(riverCooked).unwrap();
    expect(geometry.riverSegments).toHaveLength(3);
    expect(
      buildRiverPhysicsCandidateInput({
        entity: 7,
        sourceKey: 'water:7',
        revision: 1,
        segments: geometry.riverSegments,
      }).ok,
    ).toBe(true);
  });

  it('rejects invalid Custom overrides and over-limit collision meshes without returning partial geometry', () => {
    const custom = body('custom', [point(0, 0, 0), point(1, 2, 0)], false);
    const invalidOverride = {
      vertices: new Float32Array(0),
      attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]) },
      indices: new Uint32Array([0, 1, 2]),
      submeshes: [{ topology: 'triangle-list', indexOffset: 0, indexCount: 3 }],
    } as unknown as MeshAsset;
    expect(
      buildWaterBodyGeometry(
        {
          ...custom,
          flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
        },
        { customOverride: invalidOverride },
      ).ok,
    ).toBe(false);

    const oversizedCollision = {
      vertices: new Float32Array(0),
      attributes: { position: new Float32Array(3_145_731) },
      indices: new Uint32Array(0),
      submeshes: [],
    } as unknown as MeshAsset;
    const collisionCustom = {
      ...custom,
      collision: {
        type: 'custom-mesh' as const,
        enabled: true,
        meshGuid: '00000000-0000-7000-8000-000000000010',
      },
    };
    expect(
      buildWaterBodyGeometry(collisionCustom, { customCollisionMesh: oversizedCollision }).ok,
    ).toBe(false);
  });

  it('subtracts fully contained Ocean exclusions while preserving separated and engulfing cases', async () => {
    const ocean = {
      ...body(
        'ocean',
        loop([
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]),
      ),
      oceanExtentM: [20, 20] as const,
      collision: {
        type: 'polygon' as const,
        enabled: true,
        collisionHalfHeightM: 20,
        collisionHalfExtentsM: [10, 10] as const,
      },
    };
    const packed = await buildWaterPackOutputs(
      { ocean },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.ocean?.kind !== 'water-body') return;
    const cookedOcean = packed.value.ocean;
    const volume = (
      centerM: readonly [number, number, number],
      halfExtentsM: readonly [number, number, number],
      worldMatrixM = identity,
    ) => ({ entity: 99, centerM, halfExtentsM, worldMatrixM });
    const candidate = (exclusionVolumes: readonly ReturnType<typeof volume>[]) =>
      buildWaterPhysicsCandidateInput({
        entity: 7,
        sourceKey: 'water:7',
        revision: 1,
        body: cookedOcean,
        bodyWorldMatrixM: identity,
        exclusionVolumes,
      }).unwrap();
    const baseline = candidate([]).shapes[0];
    expect(baseline?.kind).toBe('convex-compound');
    const contained = candidate([volume([0, -10, 0], [2, 2, 2])]).shapes[0];
    expect(contained?.kind === 'convex-compound' ? contained.pieces.length : 0).toBeGreaterThan(1);
    const heightSeparated = candidate([volume([0, 10, 0], [2, 1, 2])]).shapes[0];
    expect(heightSeparated?.kind === 'convex-compound' ? heightSeparated.pieces : []).toHaveLength(
      1,
    );
    const touching = candidate([volume([12, -10, 0], [2, 2, 2])]).shapes[0];
    expect(touching?.kind === 'convex-compound' ? touching.pieces : []).toHaveLength(1);

    const partial = candidate([volume([9, -10, 0], [2, 2, 2])]).shapes[0];
    expect(partial?.kind === 'convex-compound' ? partial.pieces.length : 0).toBeGreaterThan(1);
    const cosine = Math.cos(Math.PI / 4),
      sine = Math.sin(Math.PI / 4);
    const rotatedMatrix = [
      cosine,
      0,
      -sine,
      0,
      0,
      1,
      0,
      0,
      sine,
      0,
      cosine,
      0,
      9,
      -10,
      0,
      1,
    ] as const;
    const rotated = candidate([volume([0, 0, 0], [2, 2, 2], rotatedMatrix)]).shapes[0];
    expect(rotated?.kind === 'convex-compound' ? rotated.pieces.length : 0).toBeGreaterThan(1);
    const engulfing = candidate([volume([0, -18, 0], [11, 25, 11])]);
    expect(engulfing.shapes).toEqual([]);

    const river = {
      ...body(
        'river',
        [point(0, -10, 0, { positionM: [-10, 2, 0] }), point(1, 10, 0, { positionM: [10, 2, 0] })],
        false,
      ),
    };
    const packedRiver = await buildWaterPackOutputs(
      { river },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packedRiver.ok && packedRiver.value.river?.kind === 'water-body').toBe(true);
    if (!packedRiver.ok || packedRiver.value.river?.kind !== 'water-body') return;
    const riverBaseline = buildWaterPhysicsCandidateInput({
      entity: 8,
      sourceKey: 'river:8',
      revision: 1,
      body: packedRiver.value.river,
      bodyWorldMatrixM: identity,
      exclusionVolumes: [],
    }).unwrap();
    const riverExcluded = buildWaterPhysicsCandidateInput({
      entity: 8,
      sourceKey: 'river:8',
      revision: 1,
      body: packedRiver.value.river,
      bodyWorldMatrixM: identity,
      exclusionVolumes: [volume([0, -10, 0], [2, 2, 2])],
    }).unwrap();
    expect(riverExcluded.shapes).toEqual(riverBaseline.shapes);
    expect(riverExcluded.inputDigest).toBe(riverBaseline.inputDigest);

    const water = new WaterSystem(() => undefined);
    water.mountBody('ocean/body', 'ocean-v1', cookedOcean).unwrap();
    water.mountBody('river/body', 'river-v1', packedRiver.value.river).unwrap();
    const beforeOcean = requiredFixtureValue(water.snapshot('ocean/body'));
    const beforeRiver = requiredFixtureValue(water.snapshot('river/body'));
    const exclusion = volume([0, -10, 0], [2, 2, 2]);
    water.setExclusionVolumes('ocean/body', [exclusion]).unwrap();
    water.setExclusionVolumes('river/body', [exclusion]).unwrap();
    const afterOcean = requiredFixtureValue(water.snapshot('ocean/body'));
    const afterRiver = requiredFixtureValue(water.snapshot('river/body'));
    expect(water.isPointExcluded('ocean/body', [0, -10, 0])).toBe(true);
    expect(water.isPointExcluded('river/body', [0, -10, 0])).toBe(true);
    expect(afterOcean.outputGenerations.query).toBeGreaterThan(beforeOcean.outputGenerations.query);
    expect(afterOcean.outputGenerations.collision).toBeGreaterThan(
      beforeOcean.outputGenerations.collision,
    );
    expect(afterRiver.outputGenerations.query).toBeGreaterThan(beforeRiver.outputGenerations.query);
    expect(afterRiver.outputGenerations.collision).toBe(beforeRiver.outputGenerations.collision);
  });

  it('keeps Ocean collision extents axis-aligned and world-sized under rotated non-uniform actor scale', async () => {
    const ocean = {
      ...body(
        'ocean',
        loop([
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]),
      ),
      oceanExtentM: [20, 12] as const,
      collision: {
        type: 'polygon' as const,
        enabled: true,
        collisionHalfHeightM: 4,
        collisionHalfExtentsM: [10, 6] as const,
      },
    };
    const packed = await buildWaterPackOutputs(
      { ocean },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000299') },
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok || packed.value.ocean?.kind !== 'water-body') return;
    const cookedOcean = packed.value.ocean;
    const cosine = Math.cos(Math.PI / 4),
      sine = Math.sin(Math.PI / 4);
    const matrix = [
      cosine * 2,
      0,
      -sine * 2,
      0,
      0,
      3,
      0,
      0,
      sine * 0.5,
      0,
      cosine * 0.5,
      0,
      5,
      7,
      -3,
      1,
    ] as const;
    const candidate = buildWaterPhysicsCandidateInput({
      entity: 8,
      sourceKey: 'ocean:scaled',
      revision: 2,
      body: cookedOcean,
      bodyWorldMatrixM: matrix,
      exclusionVolumes: [],
    }).unwrap();
    const shape = candidate.shapes[0];
    expect(shape?.kind).toBe('convex-compound');
    if (shape?.kind !== 'convex-compound') return;
    const points = Array.from(
      { length: requiredFixtureValue(shape.pieces[0]).length / 3 },
      (_, index) => {
        const [x, y, z] = requiredFixtureValue(shape.pieces[0]).slice(index * 3, index * 3 + 3);
        return transformNoScale(matrix, [
          requiredFixtureValue(x),
          requiredFixtureValue(y),
          requiredFixtureValue(z),
        ]);
      },
    );
    for (const axis of [0, 1, 2]) {
      const values = points.map((point) => requiredFixtureValue(point[axis]));
      const expectedHalfExtent = requiredFixtureValue([10, 4, 6][axis]);
      const expectedCenter = requiredFixtureValue([5, 7 - 2, -3][axis]);
      expect(Math.min(...values)).toBeCloseTo(expectedCenter - expectedHalfExtent, 5);
      expect(Math.max(...values)).toBeCloseTo(expectedCenter + expectedHalfExtent, 5);
    }

    const pitch = Math.PI / 6,
      pitchCos = Math.cos(pitch),
      pitchSin = Math.sin(pitch);
    const yaw = Math.PI / 4,
      yawCos = Math.cos(yaw),
      yawSin = Math.sin(yaw);
    const pitchedAndRolled = [
      yawCos * 2,
      0,
      -yawSin * 2,
      0,
      yawSin * pitchSin * 3,
      pitchCos * 3,
      yawCos * pitchSin * 3,
      0,
      yawSin * pitchCos * 0.5,
      -pitchSin * 0.5,
      yawCos * pitchCos * 0.5,
      0,
      5,
      7,
      -3,
      1,
    ] as const;
    const rotated = buildWaterPhysicsCandidateInput({
      entity: 9,
      sourceKey: 'ocean:rotated',
      revision: 3,
      body: cookedOcean,
      bodyWorldMatrixM: pitchedAndRolled,
      exclusionVolumes: [],
    }).unwrap().shapes[0];
    expect(rotated?.kind).toBe('convex-compound');
    if (rotated?.kind !== 'convex-compound') return;
    const rotatedWorld = Array.from(
      { length: requiredFixtureValue(rotated.pieces[0]).length / 3 },
      (_, index) => {
        const [x, y, z] = requiredFixtureValue(rotated.pieces[0]).slice(index * 3, index * 3 + 3);
        return transformNoScale(pitchedAndRolled, [
          requiredFixtureValue(x),
          requiredFixtureValue(y),
          requiredFixtureValue(z),
        ]);
      },
    );
    const expectedCenter = [
      5 - yawSin * pitchSin * 2,
      7 - pitchCos * 2,
      -3 - yawCos * pitchSin * 2,
    ];
    for (const axis of [0, 1, 2]) {
      const values = rotatedWorld.map((point) => requiredFixtureValue(point[axis]));
      const expectedHalfExtent = requiredFixtureValue([10, 4, 6][axis]);
      expect(Math.min(...values)).toBeCloseTo(
        requiredFixtureValue(expectedCenter[axis]) - expectedHalfExtent,
        5,
      );
      expect(Math.max(...values)).toBeCloseTo(
        requiredFixtureValue(expectedCenter[axis]) + expectedHalfExtent,
        5,
      );
    }
  });
});
