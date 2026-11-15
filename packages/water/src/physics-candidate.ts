import { mat4, quat, vec3 } from '@forgeax/engine-math';
import type {
  BodyMotion,
  DerivedPhysicsCandidateInput,
  DerivedShapeInput,
} from '@forgeax/engine-physics';
import { AssetError, canonicalJson, err, ok, type Result, sha256 } from '@forgeax/engine-types';
import cdt2d from 'cdt2d';
import type {
  Vec3,
  WaterBakedQueryGrid,
  WaterBodyAsset,
  WaterExclusionVolumeSnapshot,
} from './contracts.js';
import { requireWaterValue } from './required-value.js';
import { validateWaterRuntimeBody } from './validate.js';

type Face = Vec3[];
type Convex = Face[];
type Plane = Readonly<{ normal: Vec3; distance: number }>;
type RiverBakeCollisionSource = Readonly<{
  bodyGeneration: number;
  sourceBodyGuid: string;
  grid: WaterBakedQueryGrid;
}>;
type WaterPhysicsCandidateInput = Readonly<{
  entity: number;
  sourceKey: string;
  revision: number;
  body: WaterBodyAsset;
  bodyWorldMatrixM: readonly number[];
  exclusionVolumes: readonly WaterExclusionVolumeSnapshot[];
  riverBake?: RiverBakeCollisionSource;
  /** An authored body retains its rigid pose; Water supplies local geometry. */
  borrowedBodyPose?: Pick<BodyMotion, 'position' | 'rotation'>;
}>;

const failure = (expected: string, detail: unknown): Result<never, AssetError> =>
  err(
    new AssetError({
      code: 'asset-parse-failed',
      expected,
      hint: 'repair or simplify the water collision source and try again',
      detail: { field: 'water-physics-candidate', got: detail },
    }),
  );
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, value: number): Vec3 => [a[0] * value, a[1] * value, a[2] * value];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3): number => Math.hypot(...a);
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));
const key = (point: Vec3): string => point.map((value) => Math.round(value * 1e7) / 1e7).join(',');
const uniquePoints = (faces: readonly Face[]): Vec3[] => [
  ...new Map(faces.flat().map((point) => [key(point), point])).values(),
];
const positiveVolume = (points: readonly Vec3[]): boolean => {
  if (points.length < 4) return false;
  const origin = requireWaterValue(points[0]);
  for (let a = 1; a < points.length - 2; a++)
    for (let b = a + 1; b < points.length - 1; b++)
      for (let c = b + 1; c < points.length; c++) {
        if (
          Math.abs(
            dot(
              subtract(requireWaterValue(points[a]), origin),
              cross(
                subtract(requireWaterValue(points[b]), origin),
                subtract(requireWaterValue(points[c]), origin),
              ),
            ),
          ) > 1e-10
        )
          return true;
      }
  return false;
};

function boxPoly(min: Vec3, max: Vec3): Convex {
  const p: readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3] = [
    [min[0], min[1], min[2]],
    [min[0], min[1], max[2]],
    [min[0], max[1], min[2]],
    [min[0], max[1], max[2]],
    [max[0], min[1], min[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], min[2]],
    [max[0], max[1], max[2]],
  ];
  return [
    [p[0], p[1], p[3], p[2]],
    [p[4], p[6], p[7], p[5]],
    [p[0], p[4], p[5], p[1]],
    [p[2], p[3], p[7], p[6]],
    [p[0], p[2], p[6], p[4]],
    [p[1], p[5], p[7], p[3]],
  ];
}

function boxCorners(min: Vec3, max: Vec3): Vec3[] {
  return [
    [min[0], min[1], min[2]],
    [min[0], min[1], max[2]],
    [min[0], max[1], min[2]],
    [min[0], max[1], max[2]],
    [max[0], min[1], min[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], min[2]],
    [max[0], max[1], max[2]],
  ];
}

function trianglePrism(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  minY: number,
  maxY: number,
): Convex {
  const bottom: readonly [Vec3, Vec3, Vec3] = [
    [a[0], minY, a[1]],
    [b[0], minY, b[1]],
    [c[0], minY, c[1]],
  ];
  const top: readonly [Vec3, Vec3, Vec3] = [
    [a[0], maxY, a[1]],
    [b[0], maxY, b[1]],
    [c[0], maxY, c[1]],
  ];
  return [
    [...bottom],
    [...top],
    [bottom[0], bottom[1], top[1], top[0]],
    [bottom[1], bottom[2], top[2], top[1]],
    [bottom[2], bottom[0], top[0], top[2]],
  ];
}

function bodyConvexes(
  body: WaterBodyAsset,
  bodyWorldMatrixM: readonly number[],
  riverBake?: RiverBakeCollisionSource,
): Result<Convex[], AssetError> {
  const checked = validateWaterRuntimeBody(body);
  if (!checked.ok)
    return failure(
      'digest-verified cooked WaterBody before collision candidate generation',
      checked.error,
    );
  if (!body.collision.enabled) return ok([]);
  if (body.type === 'river') {
    const descriptor = body.geometrySnapshot?.collisionDescriptor;
    if (!descriptor?.riverSegmentConvexes)
      return failure('digest-verified cooked River convex inputs', body.type);
    if (riverBake) return riverConvexesWithBake(body, bodyWorldMatrixM, riverBake);
    return ok(
      descriptor.riverSegmentConvexes.flatMap((segment) =>
        segment.map((points) => convexHullFaces(points)),
      ),
    );
  }
  const descriptor = body.geometrySnapshot?.collisionDescriptor;
  if (!descriptor) return failure('enabled water collision has a finite 3D descriptor', body.type);
  if (body.type === 'custom' && body.collision.type === 'custom-mesh')
    return descriptor.version === 1 && descriptor.customMesh
      ? ok([])
      : failure('Cooked Custom trimesh payload', body.collision.meshGuid);
  const [minX, maxX] = [
    Math.min(...descriptor.footprint.outer.map((point) => point[0])),
    Math.max(...descriptor.footprint.outer.map((point) => point[0])),
  ];
  const [minZ, maxZ] = [
    Math.min(...descriptor.footprint.outer.map((point) => point[1])),
    Math.max(...descriptor.footprint.outer.map((point) => point[1])),
  ];
  const minY = descriptor.minimumYM,
    maxY = descriptor.maximumYM;
  if (!(maxX > minX && maxZ > minZ && maxY > minY))
    return failure('water collision bounds have positive volume', {
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
    });
  if (body.type === 'custom' && body.collision.type === 'polygon') {
    const points = requireWaterValue(body.collision.points);
    const triangles = cdt2d(
      points.map((point) => [point[0], point[1]]),
      points.map((_, index) => [index, (index + 1) % points.length]),
      { delaunay: true, interior: true, exterior: false },
    );
    return triangles.length
      ? ok(
          triangles.map((triangle) =>
            trianglePrism(
              requireWaterValue(points[requireWaterValue(triangle[0])]),
              requireWaterValue(points[requireWaterValue(triangle[1])]),
              requireWaterValue(points[requireWaterValue(triangle[2])]),
              minY,
              maxY,
            ),
          ),
        )
      : failure('Custom collision polygon triangulates into convex prisms', points);
  }
  if (body.type === 'ocean') {
    return oceanCollisionConvex(bodyWorldMatrixM, [minX, minY, minZ], [maxX, maxY, maxZ]);
  }
  if (body.type === 'lake') {
    const worldBoundsForLake = worldBounds(
      boxCorners([minX, minY, minZ], [maxX, maxY, maxZ]),
      bodyWorldMatrixM,
    );
    const localPoints = boxCorners(worldBoundsForLake.min, worldBoundsForLake.max).map((point) =>
      inverseTransformPositionNoScale(bodyWorldMatrixM, point),
    );
    if (!localPoints.every((point): point is Vec3 => point !== undefined))
      return failure(
        'invertible Body transform for world-AABB Lake collision box',
        bodyWorldMatrixM,
      );
    return ok([convexHullFaces(localPoints)]);
  }
  return ok([boxPoly([minX, minY, minZ], [maxX, maxY, maxZ])]);
}

function oceanCollisionConvex(
  bodyWorldMatrixM: readonly number[],
  [minX, minY, minZ]: Vec3,
  [maxX, maxY, maxZ]: Vec3,
): Result<Convex[], AssetError> {
  const localCenter: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const worldCenter = transformPositionNoScale(bodyWorldMatrixM, localCenter);
  const halfExtents: Vec3 = [(maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2];
  const points: Vec3[] = [];
  for (const x of [-halfExtents[0], halfExtents[0]])
    for (const y of [-halfExtents[1], halfExtents[1]])
      for (const z of [-halfExtents[2], halfExtents[2]]) {
        const local = inverseTransformPositionNoScale(bodyWorldMatrixM, [
          worldCenter[0] + x,
          worldCenter[1] + y,
          worldCenter[2] + z,
        ]);
        if (!local)
          return failure(
            'invertible Body transform for world-space Ocean collision box',
            bodyWorldMatrixM,
          );
        points.push(local);
      }
  return ok([convexHullFaces(points)]);
}

function convexHullFaces(points: readonly Vec3[]): Convex {
  const unique = [...new Map(points.map((point) => [key(point), point])).values()];
  const faces = new Map<string, Face>();
  for (let i = 0; i < unique.length; i++)
    for (let j = i + 1; j < unique.length; j++)
      for (let k = j + 1; k < unique.length; k++) {
        const normal = cross(
          subtract(requireWaterValue(unique[j]), requireWaterValue(unique[i])),
          subtract(requireWaterValue(unique[k]), requireWaterValue(unique[i])),
        );
        if (length(normal) < 1e-9) continue;
        const offsets = unique.map((point) =>
          dot(subtract(point, requireWaterValue(unique[i])), normal),
        );
        if (!(offsets.every((value) => value <= 1e-8) || offsets.every((value) => value >= -1e-8)))
          continue;
        const coplanar = unique.filter(
          (_, index) => Math.abs(requireWaterValue(offsets[index])) <= 1e-8,
        );
        const center = scale(coplanar.reduce(add, [0, 0, 0]), 1 / coplanar.length);
        const n = normalize(normal);
        const u = normalize(subtract(requireWaterValue(coplanar[0]), center));
        const v = cross(n, u);
        coplanar.sort(
          (a, b) =>
            Math.atan2(dot(subtract(a, center), v), dot(subtract(a, center), u)) -
            Math.atan2(dot(subtract(b, center), v), dot(subtract(b, center), u)),
        );
        const faceKey = coplanar.map(key).sort().join('|');
        faces.set(faceKey, coplanar);
      }
  return [...faces.values()];
}

function transformPoint(matrix: readonly number[], point: Vec3): Vec3 {
  return [
    requireWaterValue(matrix[0]) * point[0] +
      requireWaterValue(matrix[4]) * point[1] +
      requireWaterValue(matrix[8]) * point[2] +
      requireWaterValue(matrix[12]),
    requireWaterValue(matrix[1]) * point[0] +
      requireWaterValue(matrix[5]) * point[1] +
      requireWaterValue(matrix[9]) * point[2] +
      requireWaterValue(matrix[13]),
    requireWaterValue(matrix[2]) * point[0] +
      requireWaterValue(matrix[6]) * point[1] +
      requireWaterValue(matrix[10]) * point[2] +
      requireWaterValue(matrix[14]),
  ];
}

function transformPositionNoScale(matrix: readonly number[], point: Vec3): Vec3 {
  const axes: Vec3[] = [
    [requireWaterValue(matrix[0]), requireWaterValue(matrix[1]), requireWaterValue(matrix[2])],
    [requireWaterValue(matrix[4]), requireWaterValue(matrix[5]), requireWaterValue(matrix[6])],
    [requireWaterValue(matrix[8]), requireWaterValue(matrix[9]), requireWaterValue(matrix[10])],
  ];
  const normalizedAxes = axes.map((axis) => normalize(axis));
  const coordinate = (row: 0 | 1 | 2) =>
    requireWaterValue(requireWaterValue(normalizedAxes[0])[row]) * point[0] +
    requireWaterValue(requireWaterValue(normalizedAxes[1])[row]) * point[1] +
    requireWaterValue(requireWaterValue(normalizedAxes[2])[row]) * point[2] +
    requireWaterValue(matrix[12 + row]);
  return [coordinate(0), coordinate(1), coordinate(2)];
}

function inverseTransformPoint(matrix: readonly number[], point: Vec3): Vec3 | undefined {
  const c0: Vec3 = [
      requireWaterValue(matrix[0]),
      requireWaterValue(matrix[1]),
      requireWaterValue(matrix[2]),
    ],
    c1: Vec3 = [
      requireWaterValue(matrix[4]),
      requireWaterValue(matrix[5]),
      requireWaterValue(matrix[6]),
    ],
    c2: Vec3 = [
      requireWaterValue(matrix[8]),
      requireWaterValue(matrix[9]),
      requireWaterValue(matrix[10]),
    ];
  const det = dot(c0, cross(c1, c2));
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const relative: Vec3 = [
    point[0] - requireWaterValue(matrix[12]),
    point[1] - requireWaterValue(matrix[13]),
    point[2] - requireWaterValue(matrix[14]),
  ];
  return [
    dot(relative, cross(c1, c2)) / det,
    dot(relative, cross(c2, c0)) / det,
    dot(relative, cross(c0, c1)) / det,
  ];
}

function bakedSurfaceInBounds(
  grid: WaterBakedQueryGrid,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): number | undefined {
  const firstX = Math.max(0, Math.ceil((minX - grid.originXZ[0]) / grid.spacingXZ[0]));
  const lastX = Math.min(grid.width - 1, Math.floor((maxX - grid.originXZ[0]) / grid.spacingXZ[0]));
  const firstZ = Math.max(0, Math.ceil((minZ - grid.originXZ[1]) / grid.spacingXZ[1]));
  const lastZ = Math.min(
    grid.height - 1,
    Math.floor((maxZ - grid.originXZ[1]) / grid.spacingXZ[1]),
  );
  let maximum: number | undefined;
  for (let z = firstZ; z <= lastZ; z++)
    for (let x = firstX; x <= lastX; x++) {
      const sample = (z * grid.width + x) * 4;
      if (requireWaterValue(grid.samples[sample + 1]) <= 1e-7) continue;
      const surface = grid.originY + requireWaterValue(grid.samples[sample]);
      if (maximum === undefined || surface > maximum) maximum = surface;
    }
  return maximum;
}

function riverConvexesWithBake(
  body: WaterBodyAsset,
  bodyWorldMatrixM: readonly number[],
  source: RiverBakeCollisionSource,
): Result<Convex[], AssetError> {
  const descriptor = body.geometrySnapshot?.collisionDescriptor;
  const convexes = descriptor?.riverSegmentConvexes;
  const topCaps = descriptor?.riverSegmentConvexTopCapVertexIndices;
  const lineage = source.grid.lineage;
  if (
    descriptor?.version !== 2 ||
    !convexes ||
    !topCaps ||
    !lineage ||
    (lineage.version !== 'water-river-bake/1' && lineage.version !== 'water-river-bake/2') ||
    lineage.textureRevision === undefined ||
    lineage.sourceBodyGuid.toLowerCase() !== source.sourceBodyGuid.toLowerCase() ||
    lineage.sourceBodyGeneration !== source.bodyGeneration ||
    !Number.isSafeInteger(source.bodyGeneration) ||
    source.bodyGeneration < 0 ||
    bodyWorldMatrixM.length !== 16 ||
    !bodyWorldMatrixM.every(Number.isFinite)
  )
    return failure(
      'current-generation River Bake lineage and version-2 cooked River top-cap roles',
      { descriptorVersion: descriptor?.version, bodyGeneration: source.bodyGeneration },
    );
  const grid = source.grid;
  const checkedGrid = validateRiverBakeCollisionGrid(grid);
  if (!checkedGrid.ok) return checkedGrid;
  const pieces: Convex[] = [];
  const appendBakeAdjustedConvexes = () => {
    for (const [segmentIndex, segment] of convexes.entries())
      for (const [hullIndex, localPoints] of segment.entries()) {
        const cap = topCaps[segmentIndex]?.[hullIndex];
        if (
          !cap ||
          cap.length !== 4 ||
          cap.some((index, roleIndex) => index !== [4, 5, 6, 7][roleIndex]) ||
          localPoints.length !== 8
        )
          return failure('cooker-authored River convex with explicit vertices 4–7 as its top cap', {
            segmentIndex,
            hullIndex,
            cap,
          });
        const worldPoints = localPoints.map((point) => transformPoint(bodyWorldMatrixM, point));
        if (worldPoints.some((point) => !point.every(Number.isFinite)))
          return failure('finite world-space cooked River convex points', {
            segmentIndex,
            hullIndex,
          });
        const minX = Math.min(...worldPoints.map((point) => point[0])),
          maxX = Math.max(...worldPoints.map((point) => point[0]));
        const minZ = Math.min(...worldPoints.map((point) => point[2])),
          maxZ = Math.max(...worldPoints.map((point) => point[2]));
        const maximumSurface = bakedSurfaceInBounds(grid, minX, maxX, minZ, maxZ);
        if (maximumSurface === undefined) {
          pieces.push(convexHullFaces(localPoints));
          continue;
        }
        for (const index of cap) {
          const point = requireWaterValue(worldPoints[index]);
          if (maximumSurface > point[1]) worldPoints[index] = [point[0], maximumSurface, point[2]];
        }
        const modifiedLocal = worldPoints.map((point) =>
          inverseTransformPoint(bodyWorldMatrixM, point),
        );
        if (!modifiedLocal.every((point): point is Vec3 => point !== undefined))
          return failure(
            'invertible current River Body transform for Bake-adjusted convex points',
            bodyWorldMatrixM,
          );
        pieces.push(convexHullFaces(modifiedLocal));
      }
    return undefined;
  };
  const convexFailure = appendBakeAdjustedConvexes();
  if (convexFailure !== undefined) return convexFailure;
  return ok(pieces);
}

function validateRiverBakeCollisionGrid(grid: WaterBakedQueryGrid): Result<void, AssetError> {
  if (
    !Number.isSafeInteger(grid.width) ||
    !Number.isSafeInteger(grid.height) ||
    grid.width < 3 ||
    grid.height < 3 ||
    !Number.isFinite(grid.originY) ||
    !grid.originXZ.every(Number.isFinite) ||
    !grid.spacingXZ.every((value) => Number.isFinite(value) && value > 0) ||
    grid.samples.length !== grid.width * grid.height * 4 ||
    !grid.samples.every(Number.isFinite) ||
    grid.samples.some((value, index) => index % 4 === 1 && value < 0)
  )
    return failure('finite RGBA River Bake grid on its accepted world lattice', grid);
  return ok(undefined);
}

function inverseTransformPositionNoScale(matrix: readonly number[], point: Vec3): Vec3 | undefined {
  const axes: Vec3[] = [
    [requireWaterValue(matrix[0]), requireWaterValue(matrix[1]), requireWaterValue(matrix[2])],
    [requireWaterValue(matrix[4]), requireWaterValue(matrix[5]), requireWaterValue(matrix[6])],
    [requireWaterValue(matrix[8]), requireWaterValue(matrix[9]), requireWaterValue(matrix[10])],
  ];
  const normalizedAxes = axes.map((axis) => normalize(axis));
  if (normalizedAxes.some((axis) => length(axis) < 1e-9)) return undefined;
  const relative: Vec3 = [
    point[0] - requireWaterValue(matrix[12]),
    point[1] - requireWaterValue(matrix[13]),
    point[2] - requireWaterValue(matrix[14]),
  ];
  return [
    dot(relative, requireWaterValue(normalizedAxes[0])),
    dot(relative, requireWaterValue(normalizedAxes[1])),
    dot(relative, requireWaterValue(normalizedAxes[2])),
  ];
}

function exclusionCornersInBody(
  exclusion: WaterExclusionVolumeSnapshot,
  bodyWorldMatrixM: readonly number[],
  noScale = false,
): Vec3[] | undefined {
  const points: Vec3[] = [];
  for (const x of [-exclusion.halfExtentsM[0], exclusion.halfExtentsM[0]])
    for (const y of [-exclusion.halfExtentsM[1], exclusion.halfExtentsM[1]])
      for (const z of [-exclusion.halfExtentsM[2], exclusion.halfExtentsM[2]]) {
        const localExclusionPoint: Vec3 = [
          exclusion.centerM[0] + x,
          exclusion.centerM[1] + y,
          exclusion.centerM[2] + z,
        ];
        const worldPoint = transformPoint(exclusion.worldMatrixM, localExclusionPoint);
        const bodyPoint = noScale
          ? inverseTransformPositionNoScale(bodyWorldMatrixM, worldPoint)
          : inverseTransformPoint(bodyWorldMatrixM, worldPoint);
        if (!bodyPoint) return undefined;
        points.push(bodyPoint);
      }
  return points;
}

function cutterPlanes(corners: readonly Vec3[]): Plane[] {
  const center = scale(corners.reduce(add, [0, 0, 0]), 1 / corners.length);
  const faces = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  return faces.map((indices) => {
    const p0 = requireWaterValue(corners[requireWaterValue(indices[0])]),
      p1 = requireWaterValue(corners[requireWaterValue(indices[1])]),
      p2 = requireWaterValue(corners[requireWaterValue(indices[2])]);
    let normal = normalize(cross(subtract(p1, p0), subtract(p2, p0)));
    if (dot(normal, subtract(p0, center)) < 0) normal = scale(normal, -1);
    return { normal, distance: dot(normal, p0) };
  });
}

function clip(poly: Convex, plane: Plane, keepInside: boolean): Convex {
  const signed = (point: Vec3) => dot(plane.normal, point) - plane.distance;
  const isKept = (distance: number) => (keepInside ? distance <= 1e-8 : distance >= -1e-8);
  const clippedFaces: Face[] = [],
    cap = new Map<string, Vec3>();
  for (const face of poly) {
    const output: Vec3[] = [];
    for (let i = 0; i < face.length; i++) {
      const a = requireWaterValue(face[i]),
        b = requireWaterValue(face[(i + 1) % face.length]),
        da = signed(a),
        db = signed(b),
        insideA = isKept(da),
        insideB = isKept(db);
      if (insideA) output.push(a);
      if (insideA !== insideB) {
        const t = da / (da - db);
        const point = add(a, scale(subtract(b, a), t));
        output.push(point);
        cap.set(key(point), point);
      }
    }
    const compact = output.filter(
      (point, index) => index === 0 || key(point) !== key(requireWaterValue(output[index - 1])),
    );
    if (
      compact.length > 2 &&
      key(requireWaterValue(compact[0])) === key(requireWaterValue(compact.at(-1)))
    )
      compact.pop();
    if (compact.length >= 3) clippedFaces.push(compact);
  }
  if (cap.size >= 3) {
    const points = [...cap.values()],
      center = scale(points.reduce(add, [0, 0, 0]), 1 / points.length);
    const reference =
      Math.abs(plane.normal[0]) < 0.8 ? ([1, 0, 0] satisfies Vec3) : ([0, 1, 0] satisfies Vec3);
    const u = normalize(cross(plane.normal, reference)),
      v = cross(plane.normal, u);
    points.sort(
      (a, b) =>
        Math.atan2(dot(subtract(a, center), v), dot(subtract(a, center), u)) -
        Math.atan2(dot(subtract(b, center), v), dot(subtract(b, center), u)),
    );
    clippedFaces.push(points);
  }
  return clippedFaces;
}

function subtractBox(poly: Convex, planes: readonly Plane[]): Convex[] {
  let inside = poly;
  const outside: Convex[] = [];
  for (const plane of planes) {
    const outsidePart = clip(inside, plane, false);
    if (positiveVolume(uniquePoints(outsidePart))) outside.push(outsidePart);
    inside = clip(inside, plane, true);
    if (!positiveVolume(uniquePoints(inside))) break;
  }
  return outside;
}

function worldBounds(
  points: readonly Vec3[],
  matrix: readonly number[],
  noScale = false,
): Readonly<{ min: Vec3; max: Vec3 }> {
  const world = points.map((point) =>
    noScale ? transformPositionNoScale(matrix, point) : transformPoint(matrix, point),
  );
  const minimum = (axis: 0 | 1 | 2) =>
    Math.min(...world.map((point) => requireWaterValue(point[axis])));
  const maximum = (axis: 0 | 1 | 2) =>
    Math.max(...world.map((point) => requireWaterValue(point[axis])));
  return {
    min: [minimum(0), minimum(1), minimum(2)],
    max: [maximum(0), maximum(1), maximum(2)],
  };
}

function exclusionBounds(
  exclusion: WaterExclusionVolumeSnapshot,
): Readonly<{ min: Vec3; max: Vec3 }> {
  const corners: Vec3[] = [];
  for (const x of [-exclusion.halfExtentsM[0], exclusion.halfExtentsM[0]])
    for (const y of [-exclusion.halfExtentsM[1], exclusion.halfExtentsM[1]])
      for (const z of [-exclusion.halfExtentsM[2], exclusion.halfExtentsM[2]])
        corners.push(
          transformPoint(exclusion.worldMatrixM, [
            exclusion.centerM[0] + x,
            exclusion.centerM[1] + y,
            exclusion.centerM[2] + z,
          ]),
        );
  const minimum = (axis: 0 | 1 | 2) =>
    Math.min(...corners.map((point) => requireWaterValue(point[axis])));
  const maximum = (axis: 0 | 1 | 2) =>
    Math.max(...corners.map((point) => requireWaterValue(point[axis])));
  return { min: [minimum(0), minimum(1), minimum(2)], max: [maximum(0), maximum(1), maximum(2)] };
}

function overlaps(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  return ([0, 1, 2] as const).every(
    (axis) => a.min[axis] <= b.max[axis] && a.max[axis] >= b.min[axis],
  );
}

function subtractWaterCollisionExclusions(
  input: {
    readonly body: WaterBodyAsset;
    readonly bodyWorldMatrixM: readonly number[];
    readonly exclusionVolumes: readonly WaterExclusionVolumeSnapshot[];
  },
  pieces: Convex[],
): Result<Convex[], AssetError> {
  const bodyPoints = pieces.flatMap(uniquePoints);
  const bodyBounds = worldBounds(bodyPoints, input.bodyWorldMatrixM, input.body.type === 'ocean');
  for (const exclusion of input.exclusionVolumes) {
    if (input.body.type !== 'ocean') break;
    const bounds = exclusionBounds(exclusion);
    if (!overlaps(bodyBounds, bounds)) continue;
    const corners = exclusionCornersInBody(
      exclusion,
      input.bodyWorldMatrixM,
      input.body.type === 'ocean',
    );
    if (!corners)
      return failure(
        'invertible Body transform for exclusion collision cooking',
        input.bodyWorldMatrixM,
      );
    const planes = cutterPlanes(corners);
    pieces = pieces.flatMap((piece) => subtractBox(piece, planes));
    if (pieces.length > 512)
      return failure('Ocean/Body exclusion convex decomposition within 512 pieces', pieces.length);
  }
  return ok(pieces);
}

function waterBorrowedWorldToBody(
  input: WaterPhysicsCandidateInput,
): Result<readonly number[] | undefined, AssetError> {
  if (input.borrowedBodyPose === undefined) return ok(undefined);
  if (input.body.type !== 'river')
    return failure('borrowed rigid pose projection is defined for River geometry', input.body.type);
  const { position, rotation } = input.borrowedBodyPose;
  if (
    position.length !== 3 ||
    rotation.length !== 4 ||
    !position.every(Number.isFinite) ||
    !rotation.every(Number.isFinite) ||
    Math.abs(Math.hypot(...rotation) - 1) > 1e-5
  )
    return failure('finite rigid pose with unit rotation', input.borrowedBodyPose);
  const affine = decomposeWaterSourceTransform(input.bodyWorldMatrixM);
  if (!affine.ok) return affine;
  const rigidMatrix = mat4.compose(mat4.create(), position, rotation, [1, 1, 1]);
  return ok(Array.from(mat4.invert(mat4.create(), rigidMatrix)));
}

function waterCandidateSourceTransform(
  input: WaterPhysicsCandidateInput,
): Result<DerivedPhysicsCandidateInput['sourceTransform'], AssetError> {
  return input.body.type === 'river' &&
    input.body.collision.enabled &&
    input.borrowedBodyPose === undefined
    ? decomposeWaterSourceTransform(input.bodyWorldMatrixM)
    : ok(undefined);
}

/** Build a single Physics-owned candidate, with exclusions applied as exact convex half-space differences. */
export function buildWaterPhysicsCandidateInput(
  input: WaterPhysicsCandidateInput,
): Result<DerivedPhysicsCandidateInput, AssetError> {
  const projection = waterBorrowedWorldToBody(input);
  if (!projection.ok) return projection;
  const borrowedWorldToBody = projection.value;
  const initial = bodyConvexes(input.body, input.bodyWorldMatrixM, input.riverBake);
  if (!initial.ok) return initial;
  let pieces = initial.value;
  const exclusions = subtractWaterCollisionExclusions(input, pieces);
  if (!exclusions.ok) return exclusions;
  pieces = exclusions.value;
  const pointSets = pieces.map((piece) => uniquePoints(piece)).filter(positiveVolume);
  if (pointSets.length > 512)
    return failure('water convex collision within 512 pieces', pointSets.length);
  const shapes: DerivedShapeInput[] = pointSets.length
    ? [
        {
          kind: 'convex-compound',
          id: 'water-collision-v1',
          revision: input.revision,
          pieces: pointSets.map(
            (points) =>
              new Float32Array(
                points.flatMap((point) =>
                  borrowedWorldToBody === undefined
                    ? [...point]
                    : transformPoint(
                        borrowedWorldToBody,
                        transformPoint(input.bodyWorldMatrixM, point),
                      ),
                ),
              ),
          ),
        },
      ]
    : [];
  if (input.body.type === 'custom' && input.body.collision.type === 'custom-mesh') {
    const descriptor = input.body.geometrySnapshot?.collisionDescriptor;
    const customMesh = descriptor?.version === 1 ? descriptor.customMesh : undefined;
    if (!customMesh || customMesh.meshGuid !== input.body.collision.meshGuid)
      return failure(
        'digest-verified Cooked Custom trimesh payload',
        input.body.collision.meshGuid,
      );
    shapes.push({
      kind: 'trimesh',
      id: 'water-custom-trimesh-v1',
      revision: input.revision,
      vertices: new Float32Array(customMesh.vertices),
      indices: new Uint32Array(customMesh.indices),
    });
  }
  const shape = shapes.map((value) => ({
    ...value,
    isSensor: true,
    collisionGroups: input.body.collision.collisionGroups ?? 0xffffffff,
  }));
  const riverBake = input.riverBake
    ? (() => {
        const { grid } = input.riverBake;
        const surfaceSamples = new Float32Array(grid.width * grid.height * 2);
        for (let cell = 0; cell < grid.width * grid.height; cell++) {
          surfaceSamples[cell * 2] = requireWaterValue(grid.samples[cell * 4]);
          surfaceSamples[cell * 2 + 1] = requireWaterValue(grid.samples[cell * 4 + 1]);
        }
        return {
          sourceBodyGuid: input.riverBake.sourceBodyGuid,
          bodyGeneration: input.riverBake.bodyGeneration,
          digest: sha256(
            canonicalJson({
              originXZ: grid.originXZ,
              originY: grid.originY,
              spacingXZ: grid.spacingXZ,
              width: grid.width,
              height: grid.height,
              surfaceSamples: Array.from(surfaceSamples),
            }),
          ),
        };
      })()
    : undefined;
  const collisionSource = {
    type: input.body.type,
    spline: input.body.spline,
    baseHeightM: input.body.baseHeightM,
    heightOffsetM: input.body.heightOffsetM,
    collision: input.body.collision,
    geometryDescriptorDigest: input.body.geometrySnapshot?.collisionDescriptor?.digest,
    geometryAuthoringWorldMatrixM: input.body.geometryAuthoringWorldMatrixM,
    ...(input.body.type === 'ocean'
      ? { collisionHalfExtentsM: input.body.collision.collisionHalfExtentsM }
      : {}),
    ...(riverBake ? { riverBake } : {}),
  };
  const collisionExclusions = input.body.type === 'ocean' ? input.exclusionVolumes : [];
  const inputDigest = sha256(
    canonicalJson({
      entity: input.entity,
      sourceKey: input.sourceKey,
      revision: input.revision,
      body: collisionSource,
      bodyWorldMatrixM: input.bodyWorldMatrixM,
      ...(input.borrowedBodyPose === undefined ? {} : { borrowedBodyPose: input.borrowedBodyPose }),
      exclusionVolumes: collisionExclusions,
      shapes: shape,
    }),
  );
  const transformed = waterCandidateSourceTransform(input);
  if (!transformed.ok) return transformed;
  const sourceTransform = transformed.value;
  return ok({
    entity: input.entity,
    sourceKey: input.sourceKey,
    revision: input.revision,
    inputDigest,
    ...(input.borrowedBodyPose === undefined ? { bodyType: 'static' as const } : {}),
    shapes: shape,
    ...(sourceTransform === undefined ? {} : { sourceTransform }),
  });
}

function decomposeWaterSourceTransform(
  matrix: readonly number[],
): Result<NonNullable<DerivedPhysicsCandidateInput['sourceTransform']>, AssetError> {
  const sceneMatrix = new Float32Array(matrix);
  const position = vec3.create();
  const rotation = quat.create();
  const scale = vec3.create();
  const shear = vec3.create();
  if (!mat4.decomposeAffine(position, rotation, scale, shear, sceneMatrix))
    return failure(
      'finite, invertible affine River Scene matrix for Native pose projection',
      matrix,
    );
  return ok({
    sceneMatrix: Object.freeze(Array.from(sceneMatrix)),
  });
}

/** Triangulated 3D query volume derived from the Pack-authoritative footprint. */
export function waterBodyQueryPrismParts(
  body: WaterBodyAsset,
): Result<readonly Float32Array[], AssetError> {
  const checked = validateWaterRuntimeBody(body);
  if (!checked.ok)
    return failure('digest-verified cooked WaterBody before query generation', checked.error);
  const boundary = body.geometrySnapshot?.queryFootprint;
  if (!boundary) return failure('digest-verified Pack query footprint', body.type);
  const rings = [boundary.outer, ...boundary.holes];
  const points = rings.flatMap((ring) =>
    ring.map((point) => [point[0], point[1]] as [number, number]),
  );
  const edges: [number, number][] = [];
  let offset = 0;
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++)
      edges.push([offset + index, offset + ((index + 1) % ring.length)]);
    offset += ring.length;
  }
  const triangles = cdt2d(points, edges, { delaunay: true, interior: true, exterior: false });
  if (!triangles.length)
    return failure('query footprint triangulates into exclusion-test regions', boundary);
  const minimumY = requireWaterValue(body.geometrySnapshot).queryVolume.minimumYM;
  const maximumY = requireWaterValue(body.geometrySnapshot).queryVolume.maximumYM;
  const parts = triangles.map((triangle) => {
    const vertices: number[] = [];
    for (const index of triangle) {
      const point = requireWaterValue(points[index]);
      vertices.push(point[0], minimumY, point[1], point[0], maximumY, point[1]);
    }
    return new Float32Array(vertices);
  });
  return ok(Object.freeze(parts));
}
