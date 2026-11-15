import {
  buildMeshCollision,
  meshFromInterleaved,
  prepareMeshData,
  withVertexColors,
} from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import type {
  ConvexCompoundShapeInput,
  DerivedPhysicsCandidateInput,
} from '@forgeax/engine-physics';
import {
  AssetError,
  err,
  type MeshAsset,
  ok,
  type Result,
  WATER_BODY_DEFAULT_SHAPE_DILATION_M,
} from '@forgeax/engine-types';
import cdt2d from 'cdt2d';
import { EndType, FillRule, inflatePathsD, JoinType, unionD } from 'clipper2-ts';
import {
  interpolateWaterSplineRotation,
  resolveWaterSplinePoints,
  type WaterSplinePoint,
} from './body-spline.js';
import type { Vec2, Vec3, WaterBodyAsset } from './contracts.js';
import { requireWaterValue } from './required-value.js';

export type WaterBoundary = Readonly<{
  outer: readonly Vec2[];
  holes: readonly (readonly Vec2[])[];
}>;

export type WaterBodyCollisionDescriptor = Readonly<{
  footprint: WaterBoundary;
  minimumYM: number;
  maximumYM: number;
  riverSegmentConvexes?: readonly (readonly (readonly Vec3[])[])[];
  riverSegmentConvexTopCapVertexIndices?: readonly (readonly (readonly number[])[])[];
  customMesh?: Readonly<{
    meshGuid: string;
    vertices: readonly number[];
    indices: readonly number[];
  }>;
}>;

export type WaterBodyGeometry = Readonly<{
  visibleMesh?: MeshAsset;
  visibleSegments?: readonly MeshAsset[];
  waterInfoMesh?: MeshAsset;
  dilatedWaterInfoMesh?: MeshAsset;
  brushShapeMesh?: MeshAsset;
  collisionMesh?: MeshAsset;
  riverSegments: readonly RiverSegmentGeometry[];
  queryFootprint: WaterBoundary;
  collisionFootprint: WaterBoundary | null;
  queryExclusions: readonly (readonly Vec2[])[];
  flowByVertex: Float32Array;
  maxWaveHeightM: number;
}>;

export type RiverSegmentGeometry = Readonly<{
  controlPointIndex: number;
  start: WaterSplinePoint;
  end: WaterSplinePoint;
  samples: readonly WaterSplinePoint[];
  forwardAxis: 'x';
  splineUpDir: Vec3;
  smoothInterpRollScale: false;
  startRollRadians: number;
  endRollRadians: number;
  startScaleM: Vec2;
  endScaleM: Vec2;
  visibleMesh: MeshAsset;
  collisionConvexes?: readonly Float32Array[];
}>;

const failure = (expected: string, detail: unknown): Result<never, AssetError> =>
  err(
    new AssetError({
      code: 'asset-parse-failed',
      expected,
      hint: 'repair the water body geometry source and cook it again',
      detail: { field: 'water-body-geometry', got: detail },
    }),
  );
const cross = (a: Vec2, b: Vec2, c: Vec2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const contains = (ring: readonly Vec2[], p: Vec2) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = requireWaterValue(ring[i]),
      b = requireWaterValue(ring[j]);
    if (on(a, b, p)) return false;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
};
const on = (a: Vec2, b: Vec2, p: Vec2) =>
  cross(a, b, p) === 0 &&
  p[0] >= Math.min(a[0], b[0]) &&
  p[0] <= Math.max(a[0], b[0]) &&
  p[1] >= Math.min(a[1], b[1]) &&
  p[1] <= Math.max(a[1], b[1]);
const intersects = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) =>
  (cross(a, b, c) > 0 !== cross(a, b, d) > 0 && cross(c, d, a) > 0 !== cross(c, d, b) > 0) ||
  on(a, b, c) ||
  on(a, b, d) ||
  on(c, d, a) ||
  on(c, d, b);
const signedArea = (ring: readonly Vec2[]) =>
  ring.reduce((sum, p, i) => {
    const q = requireWaterValue(ring[(i + 1) % ring.length]);
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0);
function orientBoundary(boundary: WaterBoundary): WaterBoundary {
  const outer = signedArea(boundary.outer) > 0 ? [...boundary.outer].reverse() : boundary.outer;
  const holes = boundary.holes.map((ring) => (signedArea(ring) < 0 ? [...ring].reverse() : ring));
  return { outer, holes };
}

function dilateBoundary(
  boundary: WaterBoundary,
  radius: number,
): Result<WaterBoundary, AssetError> {
  try {
    // Clipper2 expects positive outer rings and negative holes; the public WaterBoundary uses the inverse.
    const input = [boundary.outer, ...boundary.holes].map((ring, index) => {
      const positive = signedArea(ring) > 0;
      const shouldReverse = positive !== (index === 0);
      return (shouldReverse ? [...ring].reverse() : ring).map(([x, y]) => ({ x, y }));
    });
    const paths = inflatePathsD(input, radius, JoinType.Miter, EndType.Polygon, 2, 6);
    const outers = paths.filter(
      (ring) => signedArea(ring.map((point) => [point.x, point.y] satisfies Vec2)) > 0,
    );
    const holes = paths.filter(
      (ring) => signedArea(ring.map((point) => [point.x, point.y] satisfies Vec2)) < 0,
    );
    if (outers.length !== 1)
      return failure('Clipper2 offset preserving one WaterBody outer contour', {
        radius,
        outerCount: outers.length,
      });
    const result = orientBoundary({
      outer: requireWaterValue(outers[0]).map((point) => [point.x, point.y] satisfies Vec2),
      holes: holes.map((ring) => ring.map((point) => [point.x, point.y] satisfies Vec2)),
    });
    const checked = validateBoundary(result);
    return checked.ok ? ok(result) : checked;
  } catch (detail) {
    return failure('Clipper2 polygon offset for UE PolygonsOffset ShapeDilation', {
      radius,
      detail: String(detail),
    });
  }
}

function surfaceForBoundary(
  boundary: WaterBoundary,
  height: number | readonly number[],
): Result<MeshAsset, AssetError> {
  const checked = validateBoundary(boundary);
  if (!checked.ok) return checked;
  const edges: [number, number][] = [];
  let base = 0;
  for (const ring of [boundary.outer, ...boundary.holes]) {
    for (let index = 0; index < ring.length; index++)
      edges.push([base + index, base + ((index + 1) % ring.length)]);
    base += ring.length;
  }
  const triangles = cdt2d(
    checked.value.map((point) => [point[0], point[1]]),
    edges,
    { delaunay: true, interior: true, exterior: false },
  );
  return surfaceMesh(checked.value, triangles, height);
}

function validateSimpleWaterRings(rings: readonly (readonly Vec2[])[]): Result<void, AssetError> {
  for (const [ri, ring] of rings.entries()) {
    const ringArea = signedArea(ring);
    if (Math.abs(ringArea) < 1e-10) return failure('non-degenerate polygon rings', { ring: ri });
    for (let i = 0; i < ring.length; i++)
      for (let j = i + 1; j < ring.length; j++) {
        if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
        if (
          intersects(
            requireWaterValue(ring[i]),
            requireWaterValue(ring[(i + 1) % ring.length]),
            requireWaterValue(ring[j]),
            requireWaterValue(ring[(j + 1) % ring.length]),
          )
        )
          return failure('simple polygon rings without self-intersection', {
            ring: ri,
            edges: [i, j],
          });
      }
  }
  return ok(undefined);
}

function validateWaterRingSeparation(
  rings: readonly (readonly Vec2[])[],
): Result<void, AssetError> {
  for (let a = 0; a < rings.length; a++)
    for (let b = a + 1; b < rings.length; b++) {
      const left = requireWaterValue(rings[a]),
        right = requireWaterValue(rings[b]);
      for (let i = 0; i < left.length; i++)
        for (let j = 0; j < right.length; j++)
          if (
            intersects(
              requireWaterValue(left[i]),
              requireWaterValue(left[(i + 1) % left.length]),
              requireWaterValue(right[j]),
              requireWaterValue(right[(j + 1) % right.length]),
            )
          )
            return failure('separate nested polygon rings without touching boundaries', {
              rings: [a, b],
              edges: [i, j],
            });
      if (a === 0 && !contains(left, requireWaterValue(right[0])))
        return failure('holes strictly inside the outer contour', b);
      if (
        a > 0 &&
        (contains(left, requireWaterValue(right[0])) || contains(right, requireWaterValue(left[0])))
      )
        return failure('non-nested holes', { rings: [a, b] });
    }
  return ok(undefined);
}

function validateBoundary(boundary: WaterBoundary): Result<readonly Vec2[], AssetError> {
  const rings = [boundary.outer, ...boundary.holes],
    flat: Vec2[] = [];
  if (
    !rings.length ||
    rings.some(
      (ring) =>
        ring.length < 3 ||
        ring.length > 4096 ||
        ring.some((p) => p.length !== 2 || !p.every(Number.isFinite)),
    )
  )
    return failure('finite polygon rings with 3..4096 points', 'invalid ring');
  const simple = validateSimpleWaterRings(rings);
  if (!simple.ok) return simple;
  const separated = validateWaterRingSeparation(rings);
  if (!separated.ok) return separated;
  for (const ring of rings) flat.push(...ring);
  const points = flat.map((p) => [p[0], p[1]] as const),
    edges: [number, number][] = [];
  let base = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) edges.push([base + i, base + ((i + 1) % ring.length)]);
    base += ring.length;
  }
  const triangles = cdt2d(points, edges, { delaunay: true, interior: true, exterior: false });
  if (!triangles.length)
    return failure(
      'constrained Delaunay triangulation covering polygon domain',
      'empty triangulation',
    );
  const area = triangles.reduce(
    (sum, t) =>
      sum +
      Math.abs(
        cross(
          requireWaterValue(flat[requireWaterValue(t[0])]),
          requireWaterValue(flat[requireWaterValue(t[1])]),
          requireWaterValue(flat[requireWaterValue(t[2])]),
        ),
      ) /
        2,
    0,
  );
  const targetArea = rings.reduce(
    (sum, ring, i) => sum + ((i ? -1 : 1) * Math.abs(signedArea(ring))) / 2,
    0,
  );
  if (Math.abs(area - targetArea) > Math.max(1e-7, targetArea * 1e-8))
    return failure('triangles covering the complete polygon domain with holes excluded', {
      area,
      targetArea,
    });
  const seen = new Set<string>();
  for (const tri of triangles)
    for (let i = 0; i < 3; i++)
      seen.add(key(requireWaterValue(tri[i]), requireWaterValue(tri[(i + 1) % 3])));
  for (const edge of edges)
    if (!seen.has(key(edge[0], edge[1])))
      return failure('every contour and hole edge represented in triangulation', edge);
  return ok(flat);
}

function surfaceMesh(
  points: readonly Vec2[],
  triangles: readonly (readonly number[])[],
  height: number | readonly number[],
): Result<MeshAsset, AssetError> {
  const values = new Float32Array(points.length * 8);
  points.forEach((p, i) => {
    values.set(
      [
        p[0],
        typeof height === 'number' ? height : requireWaterValue(height[i]),
        p[1],
        0,
        1,
        0,
        p[0],
        p[1],
      ],
      i * 8,
    );
  });
  const indices: number[] = [];
  for (const tri of triangles)
    indices.push(requireWaterValue(tri[0]), requireWaterValue(tri[2]), requireWaterValue(tri[1]));
  return meshFromInterleaved(values, new Uint32Array(indices));
}

function buildOceanSurfaceMesh(
  boundary: WaterBoundary,
  height: number,
): Result<MeshAsset, AssetError> {
  const island = boundary.holes[0];
  if (!island) return failure('Ocean island spline boundary', 'missing island ring');
  const outerX = boundary.outer.map((point) => point[0]),
    outerZ = boundary.outer.map((point) => point[1]);
  const islandX = island.map((point) => point[0]),
    islandZ = island.map((point) => point[1]);
  const outerLeft = Math.min(...outerX),
    outerRight = Math.max(...outerX),
    outerBottom = Math.min(...outerZ),
    outerTop = Math.max(...outerZ);
  const padding = 0.01;
  const innerLeft = Math.min(0, ...islandX) - padding,
    innerRight = Math.max(0, ...islandX) + padding;
  const innerBottom = Math.min(0, ...islandZ) - padding,
    innerTop = Math.max(0, ...islandZ) + padding;
  if (
    !(
      outerLeft < innerLeft &&
      innerLeft < innerRight &&
      innerRight < outerRight &&
      outerBottom < innerBottom &&
      innerBottom < innerTop &&
      innerTop < outerTop
    )
  ) {
    return failure('Ocean island bounds plus 1 cm margin strictly inside the Ocean bounds', {
      innerBounds: [innerLeft, innerBottom, innerRight, innerTop],
      outerBounds: [outerLeft, outerBottom, outerRight, outerTop],
    });
  }
  const innerRect: readonly Vec2[] = [
    [innerLeft, innerBottom],
    [innerRight, innerBottom],
    [innerRight, innerTop],
    [innerLeft, innerTop],
  ];
  const innerBoundary = orientBoundary({ outer: innerRect, holes: [island] });
  const checked = validateBoundary(innerBoundary);
  if (!checked.ok) return checked;
  const points: Vec2[] = [...checked.value];
  const edges: [number, number][] = [];
  let base = 0;
  for (const ring of [innerBoundary.outer, ...innerBoundary.holes]) {
    for (let i = 0; i < ring.length; i++) edges.push([base + i, base + ((i + 1) % ring.length)]);
    base += ring.length;
  }
  const triangles = cdt2d(
    points.map((point) => [point[0], point[1]]),
    edges,
    { delaunay: true, interior: true, exterior: false },
  ).map((triangle) => [...triangle]);
  const quads: readonly (readonly Vec2[])[] = [
    [
      [innerLeft, innerTop],
      [innerRight, innerTop],
      [innerRight, outerTop],
      [innerLeft, outerTop],
    ],
    [
      [innerRight, innerBottom],
      [innerRight, innerTop],
      [outerRight, innerTop],
      [outerRight, innerBottom],
    ],
    [
      [innerLeft, innerBottom],
      [innerRight, innerBottom],
      [innerRight, outerBottom],
      [innerLeft, outerBottom],
    ],
    [
      [outerLeft, innerBottom],
      [outerLeft, innerTop],
      [innerLeft, innerTop],
      [innerLeft, innerBottom],
    ],
    [
      [outerLeft, innerTop],
      [innerLeft, innerTop],
      [innerLeft, outerTop],
      [outerLeft, outerTop],
    ],
    [
      [innerRight, innerTop],
      [outerRight, innerTop],
      [outerRight, outerTop],
      [innerRight, outerTop],
    ],
    [
      [innerRight, outerBottom],
      [outerRight, outerBottom],
      [outerRight, innerBottom],
      [innerRight, innerBottom],
    ],
    [
      [outerLeft, outerBottom],
      [innerLeft, outerBottom],
      [innerLeft, innerBottom],
      [outerLeft, innerBottom],
    ],
  ];
  const vertexIndices = new Map(points.map((point, index) => [`${point[0]},${point[1]}`, index]));
  for (const quad of quads) {
    const indices = quad.map((point) => {
      const pointKey = `${point[0]},${point[1]}`;
      const existing = vertexIndices.get(pointKey);
      if (existing !== undefined) return existing;
      const index = points.length;
      points.push(point);
      vertexIndices.set(pointKey, index);
      return index;
    });
    const winding = cross(
      requireWaterValue(quad[0]),
      requireWaterValue(quad[3]),
      requireWaterValue(quad[1]),
    );
    if (winding > 0)
      triangles.push(
        [
          requireWaterValue(indices[0]),
          requireWaterValue(indices[3]),
          requireWaterValue(indices[1]),
        ],
        [
          requireWaterValue(indices[1]),
          requireWaterValue(indices[3]),
          requireWaterValue(indices[2]),
        ],
      );
    else
      triangles.push(
        [
          requireWaterValue(indices[0]),
          requireWaterValue(indices[1]),
          requireWaterValue(indices[3]),
        ],
        [
          requireWaterValue(indices[1]),
          requireWaterValue(indices[2]),
          requireWaterValue(indices[3]),
        ],
      );
  }
  return surfaceMesh(points, triangles, height);
}

function prismMesh(
  boundary: WaterBoundary,
  triangles: readonly (readonly number[])[],
  top: number | readonly number[],
  depth: number | readonly number[],
): Result<MeshAsset, AssetError> {
  const points = boundary.outer.concat(...boundary.holes),
    values: number[] = [],
    indices: number[] = [];
  const emit = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    expected: readonly [number, number, number],
  ) => {
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: [number, number, number] = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    if (n[0] * expected[0] + n[1] * expected[1] + n[2] * expected[2] < 0) {
      [b, c] = [c, b];
      n = [-n[0], -n[1], -n[2]];
    }
    const size = Math.hypot(...n);
    if (!(size > 0)) return;
    n = [n[0] / size, n[1] / size, n[2] / size];
    for (const p of [a, b, c]) {
      indices.push(values.length / 8);
      values.push(p[0], p[1], p[2], ...n, p[0], p[2]);
    }
  };
  for (const tri of triangles) {
    const position = (index: number, bottom: boolean): Vec3 => {
      const p = requireWaterValue(points[index]),
        y = typeof top === 'number' ? top : requireWaterValue(top[index]),
        d = typeof depth === 'number' ? depth : requireWaterValue(depth[index]);
      return [p[0], y - (bottom ? d : 0), p[1]];
    };
    emit(
      position(requireWaterValue(tri[0]), false),
      position(requireWaterValue(tri[1]), false),
      position(requireWaterValue(tri[2]), false),
      [0, 1, 0],
    );
    emit(
      position(requireWaterValue(tri[0]), true),
      position(requireWaterValue(tri[2]), true),
      position(requireWaterValue(tri[1]), true),
      [0, -1, 0],
    );
  }
  let base = 0;
  for (const ring of [boundary.outer, ...boundary.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = requireWaterValue(ring[i]),
        b = requireWaterValue(ring[(i + 1) % ring.length]);
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        nx = -dz,
        nz = dx;
      const topA = typeof top === 'number' ? top : requireWaterValue(top[base + i]),
        topB =
          typeof top === 'number' ? top : requireWaterValue(top[base + ((i + 1) % ring.length)]);
      const depthA = typeof depth === 'number' ? depth : requireWaterValue(depth[base + i]),
        depthB =
          typeof depth === 'number'
            ? depth
            : requireWaterValue(depth[base + ((i + 1) % ring.length)]);
      const p0: Vec3 = [a[0], topA - depthA, a[1]],
        p1: Vec3 = [b[0], topB - depthB, b[1]],
        p2: Vec3 = [b[0], topB, b[1]],
        p3: Vec3 = [a[0], topA, a[1]];
      emit(p0, p1, p2, [nx, 0, nz]);
      emit(p0, p2, p3, [nx, 0, nz]);
    }
    base += ring.length;
  }
  return meshFromInterleaved(new Float32Array(values), new Uint32Array(indices));
}

function splinePoint(a: WaterSplinePoint, b: WaterSplinePoint, t: number): WaterSplinePoint {
  const dt = b.inputKey - a.inputKey;
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1,
    h10 = t ** 3 - 2 * t ** 2 + t,
    h01 = -2 * t ** 3 + 3 * t ** 2,
    h11 = t ** 3 - t ** 2;
  const linear = a.interpolationMode === 'linear';
  const positionM = ([0, 1, 2] as const).map((axis) =>
    linear
      ? a.positionM[axis] * (1 - t) + b.positionM[axis] * t
      : h00 * a.positionM[axis] +
        h10 * dt * a.leaveTangentM[axis] +
        h01 * b.positionM[axis] +
        h11 * dt * b.arriveTangentM[axis],
  ) as [number, number, number];
  const derivative = ([0, 1, 2] as const).map((axis) =>
    linear
      ? (b.positionM[axis] - a.positionM[axis]) / dt
      : ((6 * t ** 2 - 6 * t) * a.positionM[axis]) / dt +
        (3 * t ** 2 - 4 * t + 1) * a.leaveTangentM[axis] +
        ((-6 * t ** 2 + 6 * t) * b.positionM[axis]) / dt +
        (3 * t ** 2 - 2 * t) * b.arriveTangentM[axis],
  ) as [number, number, number];
  const scalar = (x: number, y: number) => x * (1 - t) + y * t;
  const normalizedUpA = normalized(a.up),
    normalizedUpB = normalized(b.up);
  const upDot = Math.max(
    -1,
    Math.min(
      1,
      normalizedUpA[0] * normalizedUpB[0] +
        normalizedUpA[1] * normalizedUpB[1] +
        normalizedUpA[2] * normalizedUpB[2],
    ),
  );
  const upAngle = Math.acos(upDot);
  const up = normalized(
    upAngle < 1e-5
      ? (([0, 1, 2] as const).map((axis) => scalar(normalizedUpA[axis], normalizedUpB[axis])) as [
          number,
          number,
          number,
        ])
      : (([0, 1, 2] as const).map(
          (axis) =>
            (Math.sin((1 - t) * upAngle) * normalizedUpA[axis] +
              Math.sin(t * upAngle) * normalizedUpB[axis]) /
            Math.sin(upAngle),
        ) as [number, number, number]),
  );
  const rotationQuat = interpolateWaterSplineRotation(a, b, t);
  const orientationUp = rotationQuat
    ? normalized([
        2 * (rotationQuat[0] * rotationQuat[1] - rotationQuat[3] * rotationQuat[2]),
        1 - 2 * (rotationQuat[0] ** 2 + rotationQuat[2] ** 2),
        2 * (rotationQuat[1] * rotationQuat[2] + rotationQuat[3] * rotationQuat[0]),
      ])
    : up;
  const rollDelta = ((b.rollAngle - a.rollAngle + 540) % 360) - 180;
  return {
    ...a,
    inputKey: a.inputKey + dt * t,
    positionM,
    arriveTangentM: derivative,
    leaveTangentM: derivative,
    ...(rotationQuat ? { rotationQuat } : {}),
    widthM: scalar(a.widthM, b.widthM),
    depthM: scalar(a.depthM, b.depthM),
    velocityMPerSec: scalar(a.velocityMPerSec, b.velocityMPerSec),
    audioIntensity: scalar(a.audioIntensity, b.audioIntensity),
    up: Math.hypot(...orientationUp) > 1e-9 ? orientationUp : a.up,
    rollAngle: rotationQuat ? 0 : a.rollAngle + rollDelta * t,
  };
}

export function sampleSplineSegments(
  body: WaterBodyAsset,
  toleranceM: number,
  bodyWorldMatrixM?: readonly number[],
): WaterSplinePoint[][] {
  const source = resolveWaterSplinePoints(body.spline),
    segments = body.spline.closed
      ? source.map((point, i) => {
          const next = requireWaterValue(source[(i + 1) % source.length]);
          if (i !== source.length - 1) return [point, next] as const;
          const keyStep =
            source.length > 1
              ? requireWaterValue(source[1]).inputKey - requireWaterValue(source[0]).inputKey
              : 1;
          return [point, { ...next, inputKey: point.inputKey + keyStep }] as const;
        })
      : source.slice(0, -1).map((point, i) => [point, requireWaterValue(source[i + 1])] as const);
  return segments.map(([a, b]) => {
    const reparam: { t: number; distanceM: number; point: WaterSplinePoint }[] = [];
    let distanceM = 0;
    for (let index = 0; index <= 10; index++) {
      const t = index / 10;
      const point = splinePoint(a, b, t);
      if (index > 0) distanceM = splineSegmentLength(a, b, t, bodyWorldMatrixM);
      reparam.push({ t, distanceM, point });
    }
    const totalDistanceM = requireWaterValue(reparam.at(-1)).distanceM;
    const atDistance = (distanceM: number): WaterSplinePoint => {
      let high = 1;
      while (high < reparam.length - 1 && requireWaterValue(reparam[high]).distanceM < distanceM)
        high++;
      const low = high - 1,
        start = requireWaterValue(reparam[low]),
        end = requireWaterValue(reparam[high]);
      const fraction =
        end.distanceM === start.distanceM
          ? 0
          : (distanceM - start.distanceM) / (end.distanceM - start.distanceM);
      return splinePoint(a, b, start.t + (end.t - start.t) * fraction);
    };
    const distanceToSegmentSquared = (
      point: WaterSplinePoint,
      start: WaterSplinePoint,
      end: WaterSplinePoint,
    ) => {
      const direction = transformSplineVector(
        bodyWorldMatrixM,
        end.positionM.map((value, axis) => value - requireWaterValue(start.positionM[axis])) as [
          number,
          number,
          number,
        ],
      );
      const lengthSquared = direction.reduce((sum, value) => sum + value * value, 0);
      const offset = transformSplineVector(
        bodyWorldMatrixM,
        point.positionM.map((value, axis) => value - requireWaterValue(start.positionM[axis])) as [
          number,
          number,
          number,
        ],
      );
      const fraction =
        lengthSquared > 0
          ? Math.max(
              0,
              Math.min(
                1,
                offset.reduce(
                  (sum, value, axis) => sum + value * requireWaterValue(direction[axis]),
                  0,
                ) / lengthSquared,
              ),
            )
          : 0;
      return offset.reduce(
        (sum, value, axis) => sum + (value - requireWaterValue(direction[axis]) * fraction) ** 2,
        0,
      );
    };
    const recurse = (
      startDistanceM: number,
      endDistanceM: number,
      depth: number,
    ): WaterSplinePoint[] => {
      const start = atDistance(startDistanceM),
        end = atDistance(endDistanceM);
      const middleDistanceM = startDistanceM + (endDistanceM - startDistanceM) / 2;
      const middle = atDistance(middleDistanceM);
      if (distanceToSegmentSquared(middle, start, end) > toleranceM * toleranceM && depth < 24) {
        const left = recurse(startDistanceM, middleDistanceM, depth + 1),
          right = recurse(middleDistanceM, endDistanceM, depth + 1);
        return [...left.slice(0, -1), ...right];
      }
      return [
        start,
        ...(start.positionM.every((value, axis) => value === end.positionM[axis]) ? [] : [end]),
      ];
    };
    if (totalDistanceM <= 0) return [requireWaterValue(reparam[0]).point];
    const samples: WaterSplinePoint[] = [];
    for (let step = 0; step < 2; step++) {
      const part = recurse((totalDistanceM * step) / 2, (totalDistanceM * (step + 1)) / 2, 0);
      samples.push(...(step === 0 ? part : part.slice(1)));
    }
    return samples;
  });
}

/** Mirrors USplineComponent's five-point Legendre-Gauss GetSegmentLength table in meter units. */
function transformSplineVector(
  matrix: readonly number[] | undefined,
  vector: readonly [number, number, number],
): [number, number, number] {
  if (!matrix) return [...vector];
  return [
    requireWaterValue(matrix[0]) * vector[0] +
      requireWaterValue(matrix[4]) * vector[1] +
      requireWaterValue(matrix[8]) * vector[2],
    requireWaterValue(matrix[1]) * vector[0] +
      requireWaterValue(matrix[5]) * vector[1] +
      requireWaterValue(matrix[9]) * vector[2],
    requireWaterValue(matrix[2]) * vector[0] +
      requireWaterValue(matrix[6]) * vector[1] +
      requireWaterValue(matrix[10]) * vector[2],
  ];
}

function splineSegmentLength(
  a: WaterSplinePoint,
  b: WaterSplinePoint,
  param: number,
  bodyWorldMatrixM?: readonly number[],
): number {
  const delta = b.inputKey - a.inputKey;
  if (a.interpolationMode === 'linear')
    return (
      Math.hypot(
        ...transformSplineVector(
          bodyWorldMatrixM,
          b.positionM.map((value, axis) => value - requireWaterValue(a.positionM[axis])) as [
            number,
            number,
            number,
          ],
        ),
      ) * param
    );
  const p0 = a.positionM,
    p1 = b.positionM;
  const t0 = a.leaveTangentM.map((value) => value * delta) as [number, number, number],
    t1 = b.arriveTangentM.map((value) => value * delta) as [number, number, number];
  const coefficient1 = ([0, 1, 2] as const).map(
    (axis) => ((p0[axis] - p1[axis]) * 2 + t0[axis] + t1[axis]) * 3,
  ) as [number, number, number];
  const coefficient2 = ([0, 1, 2] as const).map(
    (axis) => (p1[axis] - p0[axis]) * 6 - t0[axis] * 4 - t1[axis] * 2,
  ) as [number, number, number];
  const halfParam = param * 0.5;
  const quadrature: readonly (readonly [number, number])[] = [
    [0, 0.5688889],
    [-0.5384693, 0.47862867],
    [0.5384693, 0.47862867],
    [-0.90617985, 0.23692688],
    [0.90617985, 0.23692688],
  ];
  let length = 0;
  for (const [abscissa, weight] of quadrature) {
    const alpha = halfParam * (1 + abscissa);
    const derivative = transformSplineVector(
      bodyWorldMatrixM,
      ([0, 1, 2] as const).map(
        (axis) => (coefficient1[axis] * alpha + coefficient2[axis]) * alpha + t0[axis],
      ) as [number, number, number],
    );
    length += Math.hypot(...derivative) * weight;
  }
  return length * halfParam;
}

/** UE USplineComponent distance table: ten linear entries over the five-point segment integral. */
export function createWaterSplineDistanceSampler(
  spline: WaterBodyAsset['spline'],
  bodyWorldMatrixM?: readonly number[],
): Readonly<{ lengthM: number; sampleAtDistanceM(distanceM: number): WaterSplinePoint }> {
  const points = resolveWaterSplinePoints(spline);
  const pairs = spline.closed
    ? points.map((point, index) => {
        const next = requireWaterValue(points[(index + 1) % points.length]);
        return index === points.length - 1
          ? ([
              point,
              {
                ...next,
                inputKey:
                  point.inputKey +
                  requireWaterValue(points[1]).inputKey -
                  requireWaterValue(points[0]).inputKey,
              },
            ] as const)
          : ([point, next] as const);
      })
    : points
        .slice(0, -1)
        .map((point, index) => [point, requireWaterValue(points[index + 1])] as const);
  const tables = pairs.map(([a, b]) =>
    Array.from({ length: 11 }, (_, index) => ({
      t: index / 10,
      distanceM: splineSegmentLength(a, b, index / 10, bodyWorldMatrixM),
    })),
  );
  const segmentLengths = tables.map((table) => requireWaterValue(table.at(-1)).distanceM);
  const lengthM = segmentLengths.reduce((sum, value) => sum + value, 0);
  const sampleAtDistanceM = (distanceM: number): WaterSplinePoint => {
    if (!Number.isFinite(distanceM)) throw new RangeError('Spline distance must be finite');
    if (pairs.length === 0)
      throw new RangeError('Spline distance sampling requires at least two points');
    let remaining =
      spline.closed && lengthM > 0
        ? ((distanceM % lengthM) + lengthM) % lengthM
        : Math.max(0, Math.min(lengthM, distanceM));
    let segmentIndex = 0;
    while (
      segmentIndex < segmentLengths.length - 1 &&
      remaining > requireWaterValue(segmentLengths[segmentIndex])
    ) {
      remaining -= requireWaterValue(segmentLengths[segmentIndex]);
      segmentIndex++;
    }
    const [a, b] = requireWaterValue(pairs[segmentIndex]);
    const table = requireWaterValue(tables[segmentIndex]);
    let high = table.findIndex((entry) => entry.distanceM >= remaining);
    if (high < 1) high = 1;
    const start = requireWaterValue(table[high - 1]),
      end = requireWaterValue(table[Math.min(high, table.length - 1)]);
    const fraction =
      end.distanceM === start.distanceM
        ? 0
        : (remaining - start.distanceM) / (end.distanceM - start.distanceM);
    return splinePoint(a, b, start.t + (end.t - start.t) * Math.max(0, Math.min(1, fraction)));
  };
  return Object.freeze({ lengthM, sampleAtDistanceM });
}

export function flattenSplineSegments(
  segments: readonly (readonly WaterSplinePoint[])[],
  closed: boolean,
): WaterSplinePoint[] {
  const samples = segments.flatMap((segment, index) =>
    index === 0 ? [...segment] : segment.slice(1),
  );
  if (closed && samples.length > 1) {
    const first = requireWaterValue(samples[0]),
      last = requireWaterValue(samples.at(-1));
    if (
      first.positionM.every(
        (value, axis) => Math.abs(value - requireWaterValue(last.positionM[axis])) <= 1e-10,
      )
    )
      samples.pop();
  }
  return samples;
}

function makeRiverSegments(
  body: WaterBodyAsset,
  groups: readonly (readonly WaterSplinePoint[])[],
): Result<readonly RiverSegmentGeometry[], AssetError> {
  const result: RiverSegmentGeometry[] = [];
  const source = resolveWaterSplinePoints(body.spline);
  for (let i = 0; i < groups.length; i++) {
    const samples = requireWaterValue(groups[i]),
      start = requireWaterValue(source[i]),
      end = requireWaterValue(source[(i + 1) % source.length]);
    const geometryEnd =
      body.spline.closed && i === source.length - 1
        ? {
            ...end,
            inputKey:
              start.inputKey +
              requireWaterValue(source[1]).inputKey -
              requireWaterValue(source[0]).inputKey,
          }
        : end;
    const visible = defaultRiverSplineMesh(start, geometryEnd);
    if (!visible.ok) return visible;
    const segment: RiverSegmentGeometry = {
      controlPointIndex: i,
      start,
      end,
      samples,
      forwardAxis: 'x',
      splineUpDir: [0, 1, 0],
      smoothInterpRollScale: false,
      startRollRadians: 0,
      endRollRadians: 0,
      startScaleM: [start.widthM, start.depthM],
      endScaleM: [end.widthM, end.depthM],
      visibleMesh: visible.value,
      ...(body.collision.enabled
        ? { collisionConvexes: riverSplineCollisionConvexes(start, geometryEnd) }
        : {}),
    };
    result.push(Object.freeze(segment));
  }
  return ok(Object.freeze(result));
}

function riverOutline(points: readonly WaterSplinePoint[]): Result<WaterBoundary, AssetError> {
  const left: Vec2[] = [],
    right: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = requireWaterValue(points[i]),
      lateral = riverWaterInfoLateral(
        p,
        i === points.length - 1 ? p.arriveTangentM : p.leaveTangentM,
      ),
      width = p.widthM * 0.5,
      nx = lateral[0] * width,
      nz = lateral[1] * width;
    left.push([p.positionM[0] - nx, p.positionM[2] - nz]);
    right.push([p.positionM[0] + nx, p.positionM[2] + nz]);
  }
  const rawBoundary: WaterBoundary = { outer: [...left, ...right.reverse()], holes: [] };
  if (isSimpleRiverRing(rawBoundary.outer)) return ok(rawBoundary);
  try {
    const paths = unionD([rawBoundary.outer.map(([x, y]) => ({ x, y }))], [], FillRule.NonZero, 6);
    const rings = paths.map((ring) => ring.map(({ x, y }) => [x, y] satisfies Vec2));
    const outers = rings.filter((ring) => signedArea(ring) > 0);
    if (outers.length !== 1)
      return failure('one connected River WaterInfo/query footprint after ribbon union', {
        outerCount: outers.length,
        rings: rings.length,
      });
    const boundary = orientBoundary({
      outer: requireWaterValue(outers[0]),
      holes: rings.filter((ring) => signedArea(ring) < 0),
    });
    const checked = validateBoundary(boundary);
    return checked.ok ? ok(boundary) : checked;
  } catch (detail) {
    return failure('Clipper2 union for overlapping River ribbon edges', String(detail));
  }
}

function isSimpleRiverRing(ring: readonly Vec2[]): boolean {
  if (ring.length < 3 || Math.abs(signedArea(ring)) <= 1e-10) return false;
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    if (
      requireWaterValue(ring[index])[0] === requireWaterValue(ring[next])[0] &&
      requireWaterValue(ring[index])[1] === requireWaterValue(ring[next])[1]
    )
      return false;
    for (let other = index + 1; other < ring.length; other++) {
      if (other === index + 1 || (index === 0 && other === ring.length - 1)) continue;
      if (
        intersects(
          requireWaterValue(ring[index]),
          requireWaterValue(ring[next]),
          requireWaterValue(ring[other]),
          requireWaterValue(ring[(other + 1) % ring.length]),
        )
      )
        return false;
    }
  }
  return true;
}

function splineBounds(body: WaterBodyAsset): Readonly<{ minM: Vec3; maxM: Vec3 }> {
  const source = resolveWaterSplinePoints(body.spline);
  const segments = body.spline.closed
    ? source.map((point, index) => {
        const next = requireWaterValue(source[(index + 1) % source.length]);
        return index === source.length - 1
          ? ([
              point,
              {
                ...next,
                inputKey:
                  point.inputKey +
                  requireWaterValue(source[1]).inputKey -
                  requireWaterValue(source[0]).inputKey,
              },
            ] as const)
          : ([point, next] as const);
      })
    : source
        .slice(0, -1)
        .map((point, index) => [point, requireWaterValue(source[index + 1])] as const);
  const min: [number, number, number] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ],
    max: [number, number, number] = [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
  const include = (point: WaterSplinePoint) => {
    for (const [axis, coordinate] of [0, 1, 2].entries()) {
      min[axis] = Math.min(
        requireWaterValue(min[axis]),
        requireWaterValue(point.positionM[coordinate]),
      );
      max[axis] = Math.max(
        requireWaterValue(max[axis]),
        requireWaterValue(point.positionM[coordinate]),
      );
    }
  };
  for (const [a, b] of segments) {
    include(a);
    include(b);
    const keyDelta = b.inputKey - a.inputKey;
    for (const [boundAxis, coordinate] of [0, 1, 2].entries()) {
      const p0 = requireWaterValue(a.positionM[coordinate]),
        p1 = requireWaterValue(b.positionM[coordinate]);
      const m0 = requireWaterValue(a.leaveTangentM[coordinate]) * keyDelta,
        m1 = requireWaterValue(b.arriveTangentM[coordinate]) * keyDelta;
      const cubic = 2 * p0 + m0 - 2 * p1 + m1,
        quadratic = -3 * p0 - 2 * m0 + 3 * p1 - m1,
        linear = m0;
      const roots: number[] = [];
      if (Math.abs(cubic) <= 1e-14) {
        if (Math.abs(quadratic) > 1e-14) roots.push(-linear / (2 * quadratic));
      } else {
        const discriminant = 4 * quadratic * quadratic - 12 * cubic * linear;
        if (discriminant >= 0) {
          const root = Math.sqrt(discriminant);
          roots.push((-2 * quadratic - root) / (6 * cubic), (-2 * quadratic + root) / (6 * cubic));
        }
      }
      for (const t of roots)
        if (t > 0 && t < 1) {
          const point = splinePoint(a, b, t);
          min[boundAxis] = Math.min(
            requireWaterValue(min[boundAxis]),
            requireWaterValue(point.positionM[coordinate]),
          );
          max[boundAxis] = Math.max(
            requireWaterValue(max[boundAxis]),
            requireWaterValue(point.positionM[coordinate]),
          );
        }
    }
  }
  return { minM: min, maxM: max };
}

function splineBoundsXZ(body: WaterBodyAsset): readonly [number, number, number, number] {
  const bounds = splineBounds(body);
  return [bounds.minM[0], bounds.minM[2], bounds.maxM[0], bounds.maxM[2]];
}

export type WaterBodyRenderBounds = Readonly<{
  componentYM: readonly [number, number];
  rasterYM: readonly [number, number];
  captureYM: readonly [number, number];
}>;

/** Component, raster and aggregate capture ranges have distinct UE expansion rules. */
export function waterBodyRenderBounds(
  body: WaterBodyAsset,
  matrix: readonly number[],
  staticMeshPositions: readonly ArrayLike<number>[] = [],
): WaterBodyRenderBounds | undefined {
  const meshMin = [Infinity, Infinity, Infinity],
    meshMax = [-Infinity, -Infinity, -Infinity];
  for (const positions of staticMeshPositions)
    for (let i = 0; i < positions.length; i += 3)
      for (let axis = 0; axis < 3; axis++) {
        meshMin[axis] = Math.min(
          requireWaterValue(meshMin[axis]),
          requireWaterValue(positions[i + axis]),
        );
        meshMax[axis] = Math.max(
          requireWaterValue(meshMax[axis]),
          requireWaterValue(positions[i + axis]),
        );
      }
  let min = [...meshMin],
    max = [...meshMax];
  if (body.type === 'lake') {
    const bounds = splineBounds(body);
    min = [...bounds.minM];
    max = [...bounds.maxM];
  } else if (body.type === 'ocean') {
    const extent = body.oceanExtentM;
    if (!extent) return undefined;
    const center = body.oceanCenterM ?? [0, 0];
    const halfX =
      extent[0] /
      (2 *
        Math.hypot(
          requireWaterValue(matrix[0]),
          requireWaterValue(matrix[1]),
          requireWaterValue(matrix[2]),
        ));
    const halfZ =
      extent[1] /
      (2 *
        Math.hypot(
          requireWaterValue(matrix[8]),
          requireWaterValue(matrix[9]),
          requireWaterValue(matrix[10]),
        ));
    min = [center[0] - halfX, body.baseHeightM - (body.channelDepthM ?? 0), center[1] - halfZ];
    max = [center[0] + halfX, body.baseHeightM + (body.channelDepthM ?? 0), center[1] + halfZ];
  }
  if (body.type === 'lake' || body.type === 'river') {
    min[1] = requireWaterValue(min[1]) - (body.channelDepthM ?? 0);
    max[1] = requireWaterValue(max[1]) + (body.maxWaveHeightOffsetM ?? 0);
  }
  const worldY = (low: readonly number[], high: readonly number[]): readonly [number, number] => {
    let minimum = requireWaterValue(matrix[13]),
      maximum = minimum;
    for (let axis = 0; axis < 3; axis++) {
      const a = requireWaterValue(matrix[axis * 4 + 1]) * requireWaterValue(low[axis]),
        b = requireWaterValue(matrix[axis * 4 + 1]) * requireWaterValue(high[axis]);
      minimum += Math.min(a, b);
      maximum += Math.max(a, b);
    }
    return [minimum, maximum];
  };
  const componentYM = worldY(min, max);
  if (!componentYM.every(Number.isFinite)) return undefined;
  const envelope = body.maxWaveHeightM;
  const meshYM = body.type === 'river' ? worldY(meshMin, meshMax) : componentYM;
  const rasterYM: readonly [number, number] =
    body.type === 'river'
      ? [meshYM[0] - envelope, meshYM[1] + envelope]
      : [componentYM[0], componentYM[1] + envelope];
  const captureYM: readonly [number, number] = [
    componentYM[0] - envelope - 0.01,
    componentYM[1] + envelope + 0.01,
  ];
  return Object.freeze({ componentYM, rasterYM, captureYM });
}

const LAKE_MESH_COLUMNS = 11;
const LAKE_MESH_ROWS = 4;
const lakeMeshUv = (index: number, divisions: number): number =>
  halfFloat.f16ToF32(halfFloat.f32ToF16(1 - index / divisions));

function lakeMeshTriangleIndices(): number[] {
  const indices: number[] = [];
  for (let row = 0; row < LAKE_MESH_ROWS - 1; row++)
    for (let column = 0; column < LAKE_MESH_COLUMNS - 1; column++) {
      const topLeft = row * LAKE_MESH_COLUMNS + column;
      const bottomLeft = (row + 1) * LAKE_MESH_COLUMNS + column;
      indices.push(topLeft, bottomLeft, topLeft + 1, bottomLeft + 1, topLeft + 1, bottomLeft);
    }
  return indices;
}

function lakeBoundsMesh(
  body: WaterBodyAsset,
  height: number,
  bodyWorldMatrixM?: readonly number[],
): Result<MeshAsset, AssetError> {
  const [minX, minZ, maxX, maxZ] = splineBoundsXZ(body);
  if (!(maxX > minX && maxZ > minZ))
    return failure('non-degenerate exact Hermite spline XZ bounds for Lake visible mesh', [
      minX,
      minZ,
      maxX,
      maxZ,
    ]);
  let worldBounds: readonly [number, number, number, number] = [minX, minZ, maxX, maxZ];
  let worldY = height;
  let toLocal: ((point: Vec3) => Vec3) | undefined;
  let localNormal: Vec3 = [0, 1, 0];
  let flipWinding = false;
  if (bodyWorldMatrixM) {
    if (bodyWorldMatrixM.length !== 16 || !bodyWorldMatrixM.every(Number.isFinite))
      return failure('finite Body world transform for Lake world-AABB mesh', bodyWorldMatrixM);
    const matrix = bodyWorldMatrixM;
    const transform = (point: Vec3): Vec3 => [
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
    const c0 = [
        requireWaterValue(matrix[0]),
        requireWaterValue(matrix[1]),
        requireWaterValue(matrix[2]),
      ],
      c1 = [
        requireWaterValue(matrix[4]),
        requireWaterValue(matrix[5]),
        requireWaterValue(matrix[6]),
      ],
      c2 = [
        requireWaterValue(matrix[8]),
        requireWaterValue(matrix[9]),
        requireWaterValue(matrix[10]),
      ];
    const cross = (a: readonly number[], b: readonly number[]) => [
      requireWaterValue(a[1]) * requireWaterValue(b[2]) -
        requireWaterValue(a[2]) * requireWaterValue(b[1]),
      requireWaterValue(a[2]) * requireWaterValue(b[0]) -
        requireWaterValue(a[0]) * requireWaterValue(b[2]),
      requireWaterValue(a[0]) * requireWaterValue(b[1]) -
        requireWaterValue(a[1]) * requireWaterValue(b[0]),
    ];
    const dot = (a: readonly number[], b: readonly number[]) =>
      requireWaterValue(a[0]) * requireWaterValue(b[0]) +
      requireWaterValue(a[1]) * requireWaterValue(b[1]) +
      requireWaterValue(a[2]) * requireWaterValue(b[2]);
    const determinant = dot(c0, cross(c1, c2));
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
      return failure('invertible Body transform for Lake world-AABB mesh', bodyWorldMatrixM);
    const worldCorners = [
      [minX, height, minZ],
      [maxX, height, minZ],
      [maxX, height, maxZ],
      [minX, height, maxZ],
    ] as const;
    const transformed = worldCorners.map(transform);
    const minWorldX = Math.min(...transformed.map((point) => point[0])),
      maxWorldX = Math.max(...transformed.map((point) => point[0]));
    const minWorldZ = Math.min(...transformed.map((point) => point[2])),
      maxWorldZ = Math.max(...transformed.map((point) => point[2]));
    worldBounds = [minWorldX, minWorldZ, maxWorldX, maxWorldZ];
    worldY = transform([0, height, 0])[1];
    const cofactor0 = cross(c1, c2),
      cofactor1 = cross(c2, c0),
      cofactor2 = cross(c0, c1);
    toLocal = (point) => {
      const relative = [
        point[0] - requireWaterValue(matrix[12]),
        point[1] - requireWaterValue(matrix[13]),
        point[2] - requireWaterValue(matrix[14]),
      ];
      return [
        dot(relative, cofactor0) / determinant,
        dot(relative, cofactor1) / determinant,
        dot(relative, cofactor2) / determinant,
      ];
    };
    const up = [
      requireWaterValue(matrix[1]),
      requireWaterValue(matrix[5]),
      requireWaterValue(matrix[9]),
    ];
    const upLength = Math.hypot(...up);
    if (!(upLength > 1e-12))
      return failure('invertible world-up normal for Lake world-AABB mesh', bodyWorldMatrixM);
    localNormal = [
      requireWaterValue(up[0]) / upLength,
      requireWaterValue(up[1]) / upLength,
      requireWaterValue(up[2]) / upLength,
    ];
    flipWinding = determinant < 0;
  }
  const [worldMinX, worldMinZ, worldMaxX, worldMaxZ] = worldBounds;
  const centerX = (worldMinX + worldMaxX) / 2,
    centerZ = (worldMinZ + worldMaxZ) / 2;
  const extentX = (worldMaxX - worldMinX) / 2,
    extentZ = (worldMaxZ - worldMinZ) / 2;
  const values = new Float32Array(LAKE_MESH_COLUMNS * LAKE_MESH_ROWS * 8);
  for (let row = 0; row < LAKE_MESH_ROWS; row++)
    for (let column = 0; column < LAKE_MESH_COLUMNS; column++) {
      const id = row * LAKE_MESH_COLUMNS + column;
      const x = 1 - (2 * column) / (LAKE_MESH_COLUMNS - 1);
      const z = 1 - (2 * row) / (LAKE_MESH_ROWS - 1);
      const world: Vec3 = [centerX + x * extentX, worldY, centerZ + z * extentZ];
      const position = toLocal?.(world) ?? world;
      values.set(
        [
          position[0],
          position[1],
          position[2],
          localNormal[0],
          localNormal[1],
          localNormal[2],
          lakeMeshUv(column, LAKE_MESH_COLUMNS - 1),
          lakeMeshUv(row, LAKE_MESH_ROWS - 1),
        ],
        id * 8,
      );
    }
  const indices = lakeMeshTriangleIndices();
  if (flipWinding)
    for (let index = 0; index < indices.length; index += 3)
      [indices[index + 1], indices[index + 2]] = [
        requireWaterValue(indices[index + 2]),
        requireWaterValue(indices[index + 1]),
      ];
  return meshFromInterleaved(values, new Uint32Array(indices));
}

export function waterBodyCollisionDescriptor(
  body: WaterBodyAsset,
  oceanHalfExtentsM: Vec2 | undefined = body.collision.collisionHalfExtentsM,
  customCollisionMesh?: MeshAsset,
  bodyWorldMatrixM?: readonly number[],
): WaterBodyCollisionDescriptor | null {
  if (!body.collision.enabled) return null;
  if (body.geometrySnapshot) return body.geometrySnapshot.collisionDescriptor;
  const resolveHeightBounds = () => {
    const centerOffset = (body.collision.collisionHeightOffsetM ?? 0) / 2;
    let minimumYM: number, maximumYM: number;
    if (body.type === 'lake') {
      if (!body.collision.channelDepthM || !(body.collision.channelDepthM > 0)) return null;
      const halfHeight = body.collision.channelDepthM / 2 + centerOffset;
      if (!(halfHeight > 0)) return null;
      const center = body.baseHeightM - body.collision.channelDepthM / 2 + centerOffset;
      minimumYM = center - halfHeight;
      maximumYM = center + halfHeight;
    } else if (body.type === 'ocean') {
      if (!body.collision.collisionHalfHeightM || !(body.collision.collisionHalfHeightM > 0))
        return null;
      const halfHeight = body.collision.collisionHalfHeightM + centerOffset;
      if (!(halfHeight > 0)) return null;
      const center =
        body.baseHeightM +
        (body.heightOffsetM ?? 0) -
        body.collision.collisionHalfHeightM +
        centerOffset;
      minimumYM = center - halfHeight;
      maximumYM = center + halfHeight;
    } else {
      const top = body.baseHeightM + centerOffset;
      const points = resolveWaterSplinePoints(body.spline);
      const depth = Math.max(0, ...points.map((point) => point.depthM));
      minimumYM = top - depth;
      maximumYM = top;
    }

    return { minimumYM, maximumYM };
  };
  const heights = resolveHeightBounds();
  if (heights === null) return null;
  let { minimumYM, maximumYM } = heights;
  const resolveCustomMesh = (): WaterBodyCollisionDescriptor | null => {
    if (
      body.collision.type === 'custom-mesh' &&
      customCollisionMesh?.indices instanceof Uint32Array &&
      customCollisionMesh.attributes.position instanceof Float32Array
    ) {
      const vertices = customCollisionMesh.attributes.position;
      const indices = customCollisionMesh.indices;
      if (
        vertices.length < 9 ||
        vertices.length % 3 ||
        indices.length < 3 ||
        indices.length % 3 ||
        [...indices].some((index) => index >= vertices.length / 3)
      )
        return null;
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (let index = 0; index < vertices.length; index += 3) {
        minX = Math.min(minX, requireWaterValue(vertices[index]));
        maxX = Math.max(maxX, requireWaterValue(vertices[index]));
        minY = Math.min(minY, requireWaterValue(vertices[index + 1]));
        maxY = Math.max(maxY, requireWaterValue(vertices[index + 1]));
        minZ = Math.min(minZ, requireWaterValue(vertices[index + 2]));
        maxZ = Math.max(maxZ, requireWaterValue(vertices[index + 2]));
      }
      if (!(maxX > minX && maxZ > minZ)) return null;
      const footprint: WaterBoundary = {
        outer: [
          [minX, minZ],
          [maxX, minZ],
          [maxX, maxZ],
          [minX, maxZ],
        ],
        holes: [],
      };
      minimumYM = minY;
      maximumYM = maxY;
      return Object.freeze({
        footprint,
        minimumYM,
        maximumYM,
        customMesh: {
          meshGuid: requireWaterValue(body.collision.meshGuid),
          vertices: [...vertices],
          indices: [...indices],
        },
      });
    } else return null;
  };
  if (body.type === 'custom' && body.collision.type === 'custom-mesh') return resolveCustomMesh();
  const resolveFootprint = (): WaterBoundary | null => {
    let footprint: WaterBoundary;
    if (body.type === 'river') {
      const samplingMatrix = bodyWorldMatrixM ?? body.geometryAuthoringWorldMatrixM;
      const samples = flattenSplineSegments(
        sampleSplineSegments(body, body.geometryCook?.splineToleranceM ?? 0.05, samplingMatrix),
        body.spline.closed,
      );
      const outline = riverOutline(samples);
      if (!outline.ok) return null;
      footprint = outline.value;
    } else if (body.type === 'ocean') {
      if (
        !oceanHalfExtentsM ||
        oceanHalfExtentsM.some((value) => !(value > 0) || !Number.isFinite(value))
      )
        return null;
      const [halfWidth, halfDepth] = oceanHalfExtentsM;
      footprint = {
        outer: [
          [-halfWidth, -halfDepth],
          [halfWidth, -halfDepth],
          [halfWidth, halfDepth],
          [-halfWidth, halfDepth],
        ],
        holes: [],
      };
    } else if (body.type === 'custom') {
      if (body.collision.type === 'polygon' && body.collision.points)
        footprint = { outer: body.collision.points, holes: [] };
      else return null;
    } else if (body.type === 'lake') {
      const [minX, minZ, maxX, maxZ] = splineBoundsXZ(body);
      footprint = {
        outer: [
          [minX, minZ],
          [maxX, minZ],
          [maxX, maxZ],
          [minX, maxZ],
        ],
        holes: [],
      };
    } else return null;

    return footprint;
  };
  const footprint = resolveFootprint();
  if (footprint === null) return null;
  const resolveRiverConvexes = (): WaterBodyCollisionDescriptor | null => {
    const points = resolveWaterSplinePoints(body.spline);
    const convexes = points
      .slice(0, -1)
      .map((start, index) =>
        riverSplineCollisionConvexes(start, requireWaterValue(points[index + 1])),
      );
    const riverSegmentConvexes = convexes.map((segment) =>
      segment.map((hull) => {
        const points: Vec3[] = [];
        for (let i = 0; i < hull.length; i += 3)
          points.push([
            requireWaterValue(hull[i]),
            requireWaterValue(hull[i + 1]),
            requireWaterValue(hull[i + 2]),
          ]);
        return points;
      }),
    );
    if (!riverSegmentConvexes.length) return null;
    minimumYM = Infinity;
    maximumYM = -Infinity;
    for (const segment of riverSegmentConvexes)
      for (const hull of segment)
        for (const point of hull) {
          minimumYM = Math.min(minimumYM, point[1]);
          maximumYM = Math.max(maximumYM, point[1]);
        }
    const riverSegmentConvexTopCapVertexIndices = Object.freeze(
      riverSegmentConvexes.map((segment) =>
        Object.freeze(segment.map(() => Object.freeze([4, 5, 6, 7]))),
      ),
    );
    return Object.freeze({
      footprint,
      minimumYM,
      maximumYM,
      riverSegmentConvexes,
      riverSegmentConvexTopCapVertexIndices,
    });
  };
  if (body.type === 'river') return resolveRiverConvexes();
  return Object.freeze({ footprint, minimumYM, maximumYM });
}

export function waterBodyCollisionBoundary(
  body: WaterBodyAsset,
  oceanHalfExtentsM: Vec2 | undefined = body.collision.collisionHalfExtentsM,
): WaterBoundary | null {
  return waterBodyCollisionDescriptor(body, oceanHalfExtentsM)?.footprint ?? null;
}

function riverSurfaceMesh(points: readonly WaterSplinePoint[]): Result<MeshAsset, AssetError> {
  const vertices: number[] = [],
    indices: number[] = [];
  let distance = 0;
  for (let i = 0; i < points.length; i++) {
    const p = requireWaterValue(points[i]);
    if (i > 0)
      distance += Math.hypot(
        p.positionM[0] - requireWaterValue(points[i - 1]).positionM[0],
        p.positionM[2] - requireWaterValue(points[i - 1]).positionM[2],
      );
    const lateral = riverWaterInfoLateral(
        p,
        i === points.length - 1 ? p.arriveTangentM : p.leaveTangentM,
      ),
      nx = (lateral[0] * p.widthM) / 2,
      nz = (lateral[1] * p.widthM) / 2;
    vertices.push(p.positionM[0] - nx, p.positionM[1], p.positionM[2] - nz, 0, 1, 0, distance, 0);
    vertices.push(p.positionM[0] + nx, p.positionM[1], p.positionM[2] + nz, 0, 1, 0, distance, 1);
  }
  for (let row = 0; row < points.length - 1; row++) {
    const l0 = row * 2,
      r0 = l0 + 1,
      l1 = l0 + 2,
      r1 = l0 + 3;
    indices.push(l0, r0, r1, l0, r1, l1);
  }
  return meshFromInterleaved(new Float32Array(vertices), new Uint32Array(indices));
}

function dilatedRiverSurfaceMesh(
  points: readonly WaterSplinePoint[],
  dilationM: number,
): Result<MeshAsset, AssetError> {
  const vertices: number[] = [],
    indices: number[] = [];
  const rows: {
    point: WaterSplinePoint;
    distance: number;
    tangentSign: number;
    sampleIndex: number;
  }[] = [];
  let distance = 0;
  rows.push({ point: requireWaterValue(points[0]), distance, tangentSign: -1, sampleIndex: 0 });
  for (let index = 0; index < points.length; index++) {
    const point = requireWaterValue(points[index]);
    if (index > 0)
      distance += Math.hypot(
        point.positionM[0] - requireWaterValue(points[index - 1]).positionM[0],
        point.positionM[2] - requireWaterValue(points[index - 1]).positionM[2],
      );
    rows.push({ point, distance, tangentSign: 0, sampleIndex: index });
  }
  rows.push({
    point: requireWaterValue(points.at(-1)),
    distance,
    tangentSign: 1,
    sampleIndex: points.length - 1,
  });
  for (const [rowIndex, row] of rows.entries()) {
    const { point } = row;
    const isTerminal = rowIndex === 0 || rowIndex === rows.length - 1;
    const tangentSource =
      rowIndex === rows.length - 1 ||
      (rowIndex > 0 && rowIndex < rows.length - 1 && row.sampleIndex === points.length - 1)
        ? point.arriveTangentM
        : point.leaveTangentM;
    const frame = riverPointFrame({ ...point, leaveTangentM: tangentSource }, true);
    const extension: Vec3 = isTerminal
      ? [
          frame.direction[0] * row.tangentSign * dilationM,
          0,
          frame.direction[2] * row.tangentSign * dilationM,
        ]
      : [0, 0, 0];
    const halfWidth = point.widthM / 2;
    const innerOffset: Vec3 = [frame.lateral[0] * halfWidth, 0, frame.lateral[2] * halfWidth];
    const dilationOffset = frame.lateral.map((value) => value * dilationM) as [
      number,
      number,
      number,
    ];
    const lateralOffsets: readonly Vec3[] = [
      [
        -innerOffset[0] - dilationOffset[0],
        -dilationOffset[1],
        -innerOffset[2] - dilationOffset[2],
      ],
      [-innerOffset[0], 0, -innerOffset[2]],
      [innerOffset[0], 0, innerOffset[2]],
      [innerOffset[0] + dilationOffset[0], dilationOffset[1], innerOffset[2] + dilationOffset[2]],
    ];
    for (const [column, lateralOffset] of lateralOffsets.entries()) {
      const position: Vec3 = [
        point.positionM[0] + extension[0] + lateralOffset[0],
        point.positionM[1] + lateralOffset[1],
        point.positionM[2] + extension[2] + lateralOffset[2],
      ];
      vertices.push(...position, ...frame.up, row.distance, column / 3);
    }
  }
  for (let row = 0; row < rows.length - 1; row++) {
    const left = row * 4;
    const bands = row === 0 || row === rows.length - 2 ? [0, 1, 2] : [0, 2];
    for (const inner of bands) {
      const a = left + inner,
        b = a + 1,
        c = a + 4,
        d = a + 5;
      indices.push(a, b, d, a, d, c);
    }
  }
  const normalSums = new Float64Array(rows.length * 4 * 3);
  for (let index = 0; index < indices.length; index += 3) {
    const a = requireWaterValue(indices[index]),
      b = requireWaterValue(indices[index + 1]),
      c = requireWaterValue(indices[index + 2]);
    const ax = requireWaterValue(vertices[a * 8]),
      ay = requireWaterValue(vertices[a * 8 + 1]),
      az = requireWaterValue(vertices[a * 8 + 2]);
    const ab: Vec3 = [
      requireWaterValue(vertices[b * 8]) - ax,
      requireWaterValue(vertices[b * 8 + 1]) - ay,
      requireWaterValue(vertices[b * 8 + 2]) - az,
    ];
    const ac: Vec3 = [
      requireWaterValue(vertices[c * 8]) - ax,
      requireWaterValue(vertices[c * 8 + 1]) - ay,
      requireWaterValue(vertices[c * 8 + 2]) - az,
    ];
    const faceNormal = cross3(ab, ac);
    for (const vertex of [a, b, c])
      for (let axis = 0; axis < 3; axis++)
        normalSums[vertex * 3 + axis] =
          requireWaterValue(normalSums[vertex * 3 + axis]) + requireWaterValue(faceNormal[axis]);
  }
  for (let vertex = 0; vertex < rows.length * 4; vertex++) {
    const normal = normalized([
      requireWaterValue(normalSums[vertex * 3]),
      requireWaterValue(normalSums[vertex * 3 + 1]),
      requireWaterValue(normalSums[vertex * 3 + 2]),
    ]);
    const resolved = Math.hypot(...normal) > 1e-12 ? normal : ([0, 1, 0] satisfies Vec3);
    vertices[vertex * 8 + 3] = resolved[0];
    vertices[vertex * 8 + 4] = resolved[1];
    vertices[vertex * 8 + 5] = resolved[2];
  }
  return meshFromInterleaved(new Float32Array(vertices), new Uint32Array(indices));
}

const RIVER_MESH_LATERAL = [-0.5, -1 / 6, 1 / 6, 0.5] as const;
const RIVER_COLLISION_HULLS = [
  [0, 0.25],
  [0.75, 1],
  [0.5, 0.75],
  [0.25, 0.5],
] as const;

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalized(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return length > 1e-12 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, 0];
}

function riverPointFrame(point: WaterSplinePoint, useAuthoredOrientation: boolean) {
  const direction = normalized(point.leaveTangentM);
  const sourceUp = useAuthoredOrientation ? point.up : ([0, 1, 0] as const);
  const dot = sourceUp[0] * direction[0] + sourceUp[1] * direction[1] + sourceUp[2] * direction[2];
  const projectedUp = normalized([
    sourceUp[0] - direction[0] * dot,
    sourceUp[1] - direction[1] * dot,
    sourceUp[2] - direction[2] * dot,
  ]);
  const referenceUp =
    Math.hypot(...projectedUp) > 1e-9
      ? projectedUp
      : normalized(cross3(normalized(cross3(direction, [0, 1, 0])), direction));
  let lateral = normalized(cross3(direction, referenceUp));
  let up = normalized(cross3(lateral, direction));
  const roll = useAuthoredOrientation ? (point.rollAngle * Math.PI) / 180 : 0;
  if (roll !== 0) {
    const cosine = Math.cos(roll),
      sine = Math.sin(roll);
    const rolledLateral: Vec3 = [
      lateral[0] * cosine + up[0] * sine,
      lateral[1] * cosine + up[1] * sine,
      lateral[2] * cosine + up[2] * sine,
    ];
    const rolledUp: Vec3 = [
      up[0] * cosine - lateral[0] * sine,
      up[1] * cosine - lateral[1] * sine,
      up[2] * cosine - lateral[2] * sine,
    ];
    lateral = rolledLateral;
    up = rolledUp;
  }
  return { direction, lateral, up };
}

function riverWaterInfoLateral(point: WaterSplinePoint, tangent = point.leaveTangentM): Vec2 {
  const lateral = riverPointFrame({ ...point, leaveTangentM: tangent }, true).lateral;
  return Math.hypot(lateral[0], lateral[2]) > 1e-9 ? [lateral[0], lateral[2]] : [0, 0];
}

function riverSplineFrame(
  a: WaterSplinePoint,
  b: WaterSplinePoint,
  t: number,
  useAuthoredOrientation: boolean,
) {
  const point = splinePoint(a, b, t),
    frame = riverPointFrame(point, useAuthoredOrientation);
  const scale: Vec2 = [a.widthM + (b.widthM - a.widthM) * t, a.depthM + (b.depthM - a.depthM) * t];
  return { point, ...frame, scale };
}

function riverLocalToWorld(
  a: WaterSplinePoint,
  b: WaterSplinePoint,
  local: Vec3,
): { position: Vec3; up: Vec3 } {
  const frame = riverSplineFrame(a, b, local[0], false);
  const position: Vec3 = [
    frame.point.positionM[0] +
      frame.lateral[0] * local[1] * frame.scale[0] +
      frame.up[0] * local[2] * frame.scale[1],
    frame.point.positionM[1] +
      frame.lateral[1] * local[1] * frame.scale[0] +
      frame.up[1] * local[2] * frame.scale[1],
    frame.point.positionM[2] +
      frame.lateral[2] * local[1] * frame.scale[0] +
      frame.up[2] * local[2] * frame.scale[1],
  ];
  return {
    position,
    up: frame.up,
  };
}

function defaultRiverSplineMesh(
  a: WaterSplinePoint,
  b: WaterSplinePoint,
): Result<MeshAsset, AssetError> {
  // Audited /Water/Meshes/RiverMesh: 11 longitudinal rows by 4 width samples; 44 vertices and 60 triangles.
  const values = new Float32Array(44 * 8),
    colors = new Float32Array(44 * 4),
    indices: number[] = [];
  for (let xIndex = 0; xIndex <= 10; xIndex++) {
    const x = xIndex / 10;
    const point = splinePoint(a, b, x);
    const flow = riverVertexFlow(point.velocityMPerSec, point.leaveTangentM);
    for (let lateralIndex = 0; lateralIndex < RIVER_MESH_LATERAL.length; lateralIndex++) {
      const lateral = requireWaterValue(RIVER_MESH_LATERAL[lateralIndex]),
        vertex = xIndex * 4 + lateralIndex;
      const transformed = riverLocalToWorld(a, b, [x, lateral, 0]);
      values.set([...transformed.position, ...transformed.up, 1 - x, lateral + 0.5], vertex * 8);
      colors.set([...flow, 0, 0], vertex * 4);
    }
  }
  for (let x = 0; x < 10; x++)
    for (let y = 0; y < 3; y++) {
      const lowerStart = x * 4 + y,
        upperStart = (x + 1) * 4 + y;
      // UE's local X/Y/Z to ForgeAX X/Z/Y basis is mirrored, so reverse each face for +Y normals.
      indices.push(
        upperStart,
        lowerStart,
        upperStart + 1,
        lowerStart + 1,
        upperStart + 1,
        lowerStart,
      );
    }
  const mesh = meshFromInterleaved(values, new Uint32Array(indices));
  return mesh.ok ? withVertexColors(mesh.value, colors) : mesh;
}

function riverVertexFlow(velocityMPerSec: number, tangent: Vec3): Vec2 {
  let speed = velocityMPerSec;
  let angle = Math.atan2(tangent[2], tangent[0]);
  if (angle < 0) angle += Math.PI * 2;
  if (speed < 0) {
    speed = -speed;
    angle = (angle + Math.PI) % (Math.PI * 2);
  }
  return [Math.min(speed / 10.24, 1), angle / (Math.PI * 2)];
}

export function riverSplineCollisionConvexes(
  a: WaterSplinePoint,
  b: WaterSplinePoint,
): readonly Float32Array[] {
  return Object.freeze(
    RIVER_COLLISION_HULLS.map(([minX, maxX]) => {
      const vertices: number[] = [];
      for (const local of [
        [minX, -0.5, -1],
        [maxX, -0.5, -1],
        [minX, 0.5, -1],
        [maxX, 0.5, -1],
        [minX, -0.5, 0],
        [maxX, -0.5, 0],
        [minX, 0.5, 0],
        [maxX, 0.5, 0],
      ] as const)
        vertices.push(...riverLocalToWorld(a, b, local).position);
      return new Float32Array(vertices);
    }),
  );
}

export function buildRiverPhysicsCandidateInput(input: {
  entity: number;
  sourceKey: string;
  revision: number;
  segments: readonly RiverSegmentGeometry[];
}): Result<DerivedPhysicsCandidateInput, AssetError> {
  const pieces = input.segments.flatMap((segment) => segment.collisionConvexes ?? []);
  if (!pieces.length)
    return failure(
      'River collision enabled and source convex groups available',
      input.segments.length,
    );
  const shape: ConvexCompoundShapeInput = {
    kind: 'convex-compound',
    id: 'water-river',
    revision: input.revision,
    pieces,
  };
  return ok({
    entity: input.entity,
    sourceKey: input.sourceKey,
    revision: input.revision,
    bodyType: 'static',
    shapes: [shape],
  });
}

export function buildWaterBodyGeometry(
  body: WaterBodyAsset,
  options: {
    oceanExtentM?: Vec2;
    oceanCenterM?: Vec2;
    bodyWorldMatrixM?: readonly number[];
    customOverride?: MeshAsset;
    customCollisionMesh?: MeshAsset;
    exclusionRingsM?: readonly (readonly Vec2[])[];
  } = {},
): Result<WaterBodyGeometry, AssetError> {
  let boundary: WaterBoundary,
    triangles: number[][] = [],
    visibleMesh: MeshAsset | undefined,
    oceanSurface: MeshAsset | undefined;
  const samplingMatrix = options.bodyWorldMatrixM ?? body.geometryAuthoringWorldMatrixM;
  const sourceSplineTolerance = () =>
    body.geometryCook?.splineToleranceM ?? (body.type === 'river' ? 0.05 : 0.1);
  const sampledSegments = sampleSplineSegments(body, sourceSplineTolerance(), samplingMatrix);
  const samples = flattenSplineSegments(sampledSegments, body.spline.closed);
  const riverSegments =
    body.type === 'river'
      ? makeRiverSegments(body, sampledSegments)
      : ok([] as readonly RiverSegmentGeometry[]);
  if (!riverSegments.ok) return riverSegments;
  const prepareBoundary = (): Result<WaterBoundary, AssetError> => {
    let boundary: WaterBoundary;
    if (body.type === 'river') {
      const outline = riverOutline(samples);
      if (!outline.ok) return outline;
      boundary = outline.value;
    } else if (body.type === 'lake')
      boundary = { outer: samples.map((p) => [p.positionM[0], p.positionM[2]]), holes: [] };
    else if (body.type === 'ocean') {
      const oceanExtentM = options.oceanExtentM ?? body.oceanExtentM;
      if (!oceanExtentM || oceanExtentM.some((v) => !(v > 0) || !Number.isFinite(v)))
        return failure('positive Ocean body extent in meters', oceanExtentM);
      const hole = samples.map((p) => [p.positionM[0], p.positionM[2]] satisfies Vec2);
      const [x, z] = options.oceanCenterM ?? body.oceanCenterM ?? [0, 0],
        [sx, sz] = oceanExtentM;
      boundary = {
        outer: [
          [x - sx / 2, z - sz / 2],
          [x + sx / 2, z - sz / 2],
          [x + sx / 2, z + sz / 2],
          [x - sx / 2, z + sz / 2],
        ],
        holes: [hole],
      };
    } else {
      if (body.customMeshOverrideGuid && !options.customOverride)
        return failure('resolved Custom override MeshAsset', body.customMeshOverrideGuid);
      if (options.customOverride) {
        const validatedOverride = prepareMeshData(options.customOverride, 'custom override');
        if (!validatedOverride.ok)
          return failure('valid Custom override MeshAsset', validatedOverride.error);
      }
      visibleMesh = options.customOverride;
      boundary = { outer: body.queryFootprint, holes: [] };
    }

    return ok(boundary);
  };
  const preparedBoundary = prepareBoundary();
  if (!preparedBoundary.ok) return preparedBoundary;
  boundary = orientBoundary(preparedBoundary.value);
  const prepareVisibleSurface = (): Result<void, AssetError> => {
    if (body.type !== 'custom') {
      let flat = boundary.outer.concat(...boundary.holes);
      if (body.type === 'ocean') {
        const made = buildOceanSurfaceMesh(boundary, body.baseHeightM + (body.heightOffsetM ?? 0));
        if (!made.ok) return made;
        oceanSurface = made.value;
        visibleMesh = oceanSurface;
      } else if (body.type !== 'river') {
        const valid = validateBoundary(boundary);
        if (!valid.ok) return valid;
        flat = [...valid.value];
        triangles = cdt2d(
          flat.map((p) => [p[0], p[1]]),
          [boundary.outer, ...boundary.holes].flatMap((ring, ri) => {
            const base = [boundary.outer, ...boundary.holes]
              .slice(0, ri)
              .reduce((sum, r) => sum + r.length, 0);
            return ring.map(
              (_, i) => [base + i, base + ((i + 1) % ring.length)] as [number, number],
            );
          }),
          { delaunay: true, interior: true, exterior: false },
        );
      }
      if (body.type !== 'ocean') {
        const height =
          body.type === 'river'
            ? [
                ...samples.map((p) => p.positionM[1]),
                ...samples.map((p) => p.positionM[1]).reverse(),
              ]
            : body.baseHeightM;
        const made =
          body.type === 'river'
            ? riverSurfaceMesh(samples)
            : body.type === 'lake'
              ? lakeBoundsMesh(body, body.baseHeightM, options.bodyWorldMatrixM)
              : surfaceMesh(flat, triangles, height);
        if (!made.ok) return made;
        visibleMesh = made.value;
      }
    }

    return ok(undefined);
  };
  const visibleSurface = prepareVisibleSurface();
  if (!visibleSurface.ok) return visibleSurface;
  const depth = Math.max(0, ...samples.map((point) => point.depthM));
  const validateCollisionDimensions = (): Result<void, AssetError> => {
    if (
      body.collision.enabled &&
      body.type === 'lake' &&
      (!body.collision.channelDepthM || !(body.collision.channelDepthM > 0))
    )
      return failure(
        'positive Lake collision channelDepthM in meters',
        body.collision.channelDepthM,
      );
    if (
      body.collision.enabled &&
      body.type === 'ocean' &&
      (!body.collision.collisionHalfHeightM || !(body.collision.collisionHalfHeightM > 0))
    )
      return failure(
        'positive Ocean collisionHalfHeightM in meters',
        body.collision.collisionHalfHeightM,
      );
    if (
      body.collision.enabled &&
      body.type === 'ocean' &&
      (!body.collision.collisionHalfExtentsM ||
        body.collision.collisionHalfExtentsM.some((value) => !(value > 0)))
    )
      return failure(
        'positive Ocean collision XZ world half extents in meters',
        body.collision.collisionHalfExtentsM,
      );
    if (
      body.collision.enabled &&
      (body.type === 'river' || body.type === 'custom') &&
      body.collision.type !== 'custom-mesh' &&
      depth <= 0
    )
      return failure('positive point depth in meters for River or Custom collision', depth);

    return ok(undefined);
  };
  const collisionDimensions = validateCollisionDimensions();
  if (!collisionDimensions.ok) return collisionDimensions;
  const collisionDescriptor = waterBodyCollisionDescriptor(
    body,
    body.collision.collisionHalfExtentsM,
    options.customCollisionMesh,
    samplingMatrix,
  );
  const baseCollisionBoundary = collisionDescriptor?.footprint ?? null;
  const collisionBoundary = baseCollisionBoundary
    ? orientBoundary(
        body.type === 'ocean'
          ? { outer: baseCollisionBoundary.outer, holes: options.exclusionRingsM ?? [] }
          : baseCollisionBoundary,
      )
    : null;
  const triangulateCollision = (): Result<number[][], AssetError> => {
    let collisionTriangles = triangles;
    if (
      collisionBoundary &&
      body.collision.enabled &&
      body.type !== 'river' &&
      body.collision.type !== 'custom-mesh'
    ) {
      const checked = validateBoundary(collisionBoundary);
      if (!checked.ok) return checked;
      const edges: [number, number][] = [];
      let start = 0;
      for (const ring of [collisionBoundary.outer, ...collisionBoundary.holes]) {
        for (let i = 0; i < ring.length; i++)
          edges.push([start + i, start + ((i + 1) % ring.length)]);
        start += ring.length;
      }
      collisionTriangles = cdt2d(
        checked.value.map((p) => [p[0], p[1]]),
        edges,
        { delaunay: true, interior: true, exterior: false },
      );
    }

    return ok(collisionTriangles);
  };
  const triangulatedCollision = triangulateCollision();
  if (!triangulatedCollision.ok) return triangulatedCollision;
  const collisionTriangles = triangulatedCollision.value;
  const boundaryValues = (field: 'height' | 'depth') =>
    (collisionBoundary?.outer ?? boundary.outer)
      .concat(...(collisionBoundary?.holes ?? []))
      .map((p) => {
        let nearest = requireWaterValue(samples[0]),
          best = Number.POSITIVE_INFINITY;
        for (const sample of samples) {
          const distance = (p[0] - sample.positionM[0]) ** 2 + (p[1] - sample.positionM[2]) ** 2;
          if (distance < best) {
            best = distance;
            nearest = sample;
          }
        }
        return field === 'height' ? nearest.positionM[1] : nearest.depthM;
      });
  const collisionTop =
    body.type === 'river'
      ? boundaryValues('height')
      : (collisionDescriptor?.maximumYM ?? body.baseHeightM);
  const collisionDepth =
    body.type === 'river'
      ? boundaryValues('depth')
      : collisionDescriptor
        ? collisionDescriptor.maximumYM - collisionDescriptor.minimumYM
        : depth;
  const prepareCollisionSurface = () => {
    if (body.type === 'custom' && body.collision.enabled && body.collision.type === 'river-prism')
      return failure('Custom collision type none, polygon or custom-mesh', body.collision.type);
    const resolveCollisionMesh = () =>
      collisionBoundary &&
      body.type !== 'river' &&
      body.collision.enabled &&
      body.collision.type !== 'custom-mesh'
        ? prismMesh(collisionBoundary, collisionTriangles, collisionTop, collisionDepth)
        : body.type !== 'river' &&
            body.collision.enabled &&
            body.collision.type === 'custom-mesh' &&
            options.customCollisionMesh
          ? ok(options.customCollisionMesh)
          : undefined;
    const collision = resolveCollisionMesh();
    if (
      body.collision.enabled &&
      body.collision.type === 'custom-mesh' &&
      !options.customCollisionMesh
    )
      return failure('resolved Custom collision MeshAsset', body.collision.meshGuid);
    if (collision && !collision.ok) return collision;
    const collisionMesh = collision?.ok ? buildMeshCollision(collision.value) : undefined;
    if (collisionMesh && !collisionMesh.ok) return collisionMesh;

    return ok(
      collision?.ok && collisionMesh?.ok
        ? { ...collision.value, collision: collisionMesh.value }
        : undefined,
    );
  };
  const collisionSurface = prepareCollisionSurface();
  if (!collisionSurface.ok) return collisionSurface;
  const prepareDerivedSurfaces = () => {
    const height =
      body.type === 'river'
        ? [...samples.map((p) => p.positionM[1]), ...samples.map((p) => p.positionM[1]).reverse()]
        : body.baseHeightM + (body.type === 'ocean' ? (body.heightOffsetM ?? 0) : 0);
    const makeSurface = () =>
      body.type === 'river'
        ? riverSurfaceMesh(samples)
        : body.type === 'ocean'
          ? ok(requireWaterValue(oceanSurface))
          : surfaceMesh(boundary.outer.concat(...boundary.holes), triangles, height);
    const waterInfo =
      body.flags.affectsWaterInfo && body.type !== 'custom' ? makeSurface() : undefined;
    const brushShape =
      body.flags.affectsLandscape && body.type !== 'custom' ? makeSurface() : undefined;
    const prepareDilatedWaterInfo = (): Result<
      Result<MeshAsset, AssetError> | undefined,
      AssetError
    > => {
      const shapeDilationM = body.shapeDilationM ?? WATER_BODY_DEFAULT_SHAPE_DILATION_M;
      let dilatedWaterInfo: Result<MeshAsset, AssetError> | undefined;
      if (body.flags.affectsWaterInfo && body.type !== 'custom' && shapeDilationM > 0) {
        if (body.type === 'river')
          dilatedWaterInfo = dilatedRiverSurfaceMesh(samples, shapeDilationM);
        else {
          const dilated = dilateBoundary(boundary, shapeDilationM / 2);
          if (!dilated.ok) return dilated;
          dilatedWaterInfo = surfaceForBoundary(
            dilated.value,
            body.type === 'ocean' ? body.baseHeightM + (body.heightOffsetM ?? 0) : body.baseHeightM,
          );
        }
      }

      return ok(dilatedWaterInfo);
    };
    const dilation = prepareDilatedWaterInfo();
    if (!dilation.ok) return dilation;
    const dilatedWaterInfo = dilation.value;
    if (waterInfo && !waterInfo.ok) return waterInfo;
    if (brushShape && !brushShape.ok) return brushShape;
    if (dilatedWaterInfo && !dilatedWaterInfo.ok) return dilatedWaterInfo;

    return ok({
      waterInfo: waterInfo?.ok ? waterInfo.value : undefined,
      brushShape: brushShape?.ok ? brushShape.value : undefined,
      dilatedWaterInfo: dilatedWaterInfo?.ok ? dilatedWaterInfo.value : undefined,
    });
  };
  const derivedSurfaces = prepareDerivedSurfaces();
  if (!derivedSurfaces.ok) return derivedSurfaces;
  const { waterInfo, brushShape, dilatedWaterInfo } = derivedSurfaces.value;
  const prepareRiverFlow = () => {
    const flowByVertex = new Float32Array(
      body.type === 'river' ? ((visibleMesh?.vertices.length ?? 0) / 12) * 2 : 0,
    );
    if (body.type === 'river' && visibleMesh) {
      for (let vertex = 0; vertex < flowByVertex.length / 2; vertex++) {
        const point = requireWaterValue(samples[Math.floor(vertex / 2)]);
        const tangent =
          !body.spline.closed && Math.floor(vertex / 2) === samples.length - 1
            ? point.arriveTangentM
            : point.leaveTangentM;
        flowByVertex.set(riverVertexFlow(point.velocityMPerSec, tangent), vertex * 2);
      }
    }
    const colors = new Float32Array((flowByVertex.length / 2) * 4);
    for (let i = 0; i < flowByVertex.length / 2; i++)
      colors.set(
        [requireWaterValue(flowByVertex[i * 2]), requireWaterValue(flowByVertex[i * 2 + 1]), 0, 0],
        i * 4,
      );

    return { flowByVertex, colors };
  };
  const { flowByVertex, colors } = prepareRiverFlow();
  const addFlow = (mesh: MeshAsset | undefined) => {
    if (!mesh || (body.type !== 'river' && body.type !== 'custom')) return undefined;
    const position = mesh.attributes.position;
    if (body.type === 'custom' && !(position instanceof Float32Array))
      return failure('Float32Array positions for Custom water flow colour projection', position);
    const meshColors =
      body.type === 'river'
        ? colors
        : new Float32Array(
            (requireWaterValue(position instanceof Float32Array ? position : undefined).length /
              3) *
              4,
          );
    return withVertexColors(mesh, meshColors);
  };
  const prepareFlowPublication = () => {
    const prepareSurfaceFlow = () => {
      const visibleWithFlow = body.type === 'custom' ? undefined : addFlow(visibleMesh);
      const waterInfoWithFlow = body.flags.affectsWaterInfo
        ? addFlow(
            waterInfo !== undefined
              ? waterInfo
              : body.type === 'custom'
                ? options.customOverride
                : undefined,
          )
        : undefined;
      const dilatedWaterInfoMesh = dilatedWaterInfo;
      const brushWithFlow = body.flags.affectsLandscape
        ? addFlow(
            brushShape !== undefined
              ? brushShape
              : body.type === 'custom'
                ? options.customOverride
                : undefined,
          )
        : undefined;

      return { visibleWithFlow, waterInfoWithFlow, brushWithFlow, dilatedWaterInfoMesh };
    };
    const { visibleWithFlow, waterInfoWithFlow, brushWithFlow, dilatedWaterInfoMesh } =
      prepareSurfaceFlow();
    if (visibleWithFlow && !visibleWithFlow.ok) return visibleWithFlow;
    if (waterInfoWithFlow && !waterInfoWithFlow.ok) return waterInfoWithFlow;
    if (brushWithFlow && !brushWithFlow.ok) return brushWithFlow;
    visibleMesh = visibleWithFlow?.value ?? visibleMesh;
    const waterInfoMesh =
      waterInfoWithFlow?.value ??
      (body.flags.affectsWaterInfo
        ? waterInfo !== undefined
          ? waterInfo
          : body.type === 'custom'
            ? options.customOverride
            : undefined
        : undefined);
    const brushShapeMesh =
      brushWithFlow?.value ??
      (body.flags.affectsLandscape
        ? brushShape !== undefined
          ? brushShape
          : body.type === 'custom'
            ? options.customOverride
            : undefined
        : undefined);

    return ok({ visibleMesh, waterInfoMesh, brushShapeMesh, dilatedWaterInfoMesh });
  };
  const flowPublication = prepareFlowPublication();
  if (!flowPublication.ok) return flowPublication;
  const { waterInfoMesh, brushShapeMesh, dilatedWaterInfoMesh } = flowPublication.value;
  const publishGeometry = (): Result<WaterBodyGeometry, AssetError> => {
    return ok(
      Object.freeze({
        ...(body.type !== 'river' && flowPublication.value.visibleMesh !== undefined
          ? { visibleMesh: flowPublication.value.visibleMesh }
          : {}),
        ...(body.type === 'river' && body.renderOptions?.visible !== false
          ? {
              visibleSegments: Object.freeze(
                riverSegments.value.map((segment) => segment.visibleMesh),
              ),
            }
          : {}),
        ...(waterInfoMesh === undefined ? {} : { waterInfoMesh }),
        ...(dilatedWaterInfoMesh === undefined ? {} : { dilatedWaterInfoMesh }),
        ...(brushShapeMesh === undefined ? {} : { brushShapeMesh }),
        ...(collisionSurface.value === undefined ? {} : { collisionMesh: collisionSurface.value }),
        riverSegments: riverSegments.value,
        queryFootprint: body.geometrySnapshot?.queryFootprint ?? boundary,
        collisionFootprint:
          body.collision.enabled && body.type !== 'river' ? collisionBoundary : null,
        queryExclusions: options.exclusionRingsM ?? [],
        flowByVertex,
        maxWaveHeightM: body.maxWaveHeightM,
      }),
    );
  };
  return publishGeometry();
}
