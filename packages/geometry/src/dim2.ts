import { box2, box3, circle2 } from '@forgeax/engine-math';
import type { AssetError, MeshAsset, PrimitiveTopology } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { degenerate } from './box';
import { packInterleavedVertexAttributes } from './vertex-attribute-layout';

export type Vec2 = readonly [number, number];

export type Shape2d =
  | { readonly kind: 'circle'; readonly radius: number; readonly resolution?: number }
  | {
      readonly kind: 'circular-sector';
      readonly radius: number;
      readonly angle: number;
      readonly resolution?: number;
    }
  | {
      readonly kind: 'circular-segment';
      readonly radius: number;
      readonly angle: number;
      readonly resolution?: number;
    }
  | {
      readonly kind: 'ellipse';
      readonly halfWidth: number;
      readonly halfHeight: number;
      readonly resolution?: number;
    }
  | {
      readonly kind: 'annulus';
      readonly innerRadius: number;
      readonly outerRadius: number;
      readonly resolution?: number;
    }
  | {
      readonly kind: 'capsule';
      readonly radius: number;
      readonly halfLength: number;
      readonly resolution?: number;
    }
  | { readonly kind: 'rhombus'; readonly halfWidth: number; readonly halfHeight: number }
  | { readonly kind: 'rectangle'; readonly width: number; readonly height: number }
  | { readonly kind: 'regular-polygon'; readonly radius: number; readonly sides: number }
  | { readonly kind: 'triangle'; readonly vertices: readonly [Vec2, Vec2, Vec2] }
  | { readonly kind: 'segment'; readonly vertices: readonly [Vec2, Vec2] }
  | { readonly kind: 'polyline'; readonly vertices: readonly Vec2[] };

export type Shape2dPose = {
  readonly translation?: Vec2;
  readonly rotation?: number;
};

export type Shape2dMeshOptions = {
  readonly uv?: { readonly kind: 'circular-mask'; readonly angle: number };
};

export type Shape2dBounds = {
  readonly aabb: box2.Box2;
  readonly circle: circle2.Circle2;
};

type UvProjection = {
  readonly kind: 'circular-mask';
  readonly radius: number;
  readonly angle: number;
};

const DEFAULT_RESOLUTION = 32;

function invalid(detail: string): Result<never, AssetError> {
  return err(degenerate(detail));
}

function resolution(value: number | undefined): number | undefined {
  const resolved = value ?? DEFAULT_RESOLUTION;
  const integer = resolved | 0;
  return integer >= 3 && integer === resolved ? integer : undefined;
}

function finitePoint(point: Vec2): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function maskRadius(shape: Shape2d): number | undefined {
  switch (shape.kind) {
    case 'circle':
    case 'circular-sector':
    case 'circular-segment':
      return shape.radius;
    case 'ellipse':
    case 'annulus':
    case 'capsule':
    case 'rhombus':
    case 'rectangle':
    case 'regular-polygon':
    case 'triangle':
    case 'segment':
    case 'polyline':
      return undefined;
  }
}

function validateMeshOptions(
  shape: Shape2d,
  options: Shape2dMeshOptions | undefined,
): Result<UvProjection | undefined, AssetError> {
  const uv = options?.uv;
  if (uv === undefined) return ok(undefined);
  const radius = maskRadius(shape);
  return radius !== undefined && radius > 0 && Number.isFinite(uv.angle)
    ? ok({ kind: 'circular-mask', radius, angle: uv.angle })
    : invalid(`circular-mask UV requires a circular shape and finite angle`);
}

function area(points: readonly Vec2[]): number {
  let value = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    value += a[0] * b[1] - b[0] * a[1];
  }
  return value / 2;
}

function centroid(points: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
  }
  const count = Math.max(1, points.length);
  return [x / count, y / count];
}

function counterClockwise(points: readonly Vec2[]): Vec2[] {
  return area(points) < 0 ? [...points].reverse() : [...points];
}

function circleBoundary(radius: number, count: number, start = -Math.PI / 2): Vec2[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = start + (i / count) * Math.PI * 2;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const;
  });
}

function arcBoundary(radius: number, angle: number, count: number, start: number): Vec2[] {
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count;
    const current = start + angle * t;
    return [Math.cos(current) * radius, Math.sin(current) * radius] as const;
  });
}

function ellipseBoundary(halfWidth: number, halfHeight: number, count: number): Vec2[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (i / count) * Math.PI * 2;
    return [Math.cos(angle) * halfWidth, Math.sin(angle) * halfHeight] as const;
  });
}

function capsuleBoundary(radius: number, halfLength: number, count: number): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = (i / count) * Math.PI;
    points.push([Math.cos(angle) * radius, halfLength + Math.sin(angle) * radius]);
  }
  for (let i = 0; i <= count; i++) {
    const angle = Math.PI + (i / count) * Math.PI;
    points.push([Math.cos(angle) * radius, -halfLength + Math.sin(angle) * radius]);
  }
  points.pop();
  points.shift();
  return points;
}

function buildMesh(
  points: readonly Vec2[],
  indices: readonly number[],
  topology: PrimitiveTopology,
  uvProjection?: UvProjection,
): Result<MeshAsset, AssetError> {
  const positions = new Float32Array(points.length * 3);
  const normals = new Float32Array(points.length * 3);
  const uvs = new Float32Array(points.length * 2);
  const tangents = new Float32Array(points.length * 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }

  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    const [x, y] = point;
    const positionOffset = i * 3;
    const uvOffset = i * 2;
    const tangentOffset = i * 4;
    positions[positionOffset] = x;
    positions[positionOffset + 1] = y;
    normals[positionOffset + 2] = 1;
    const cos = uvProjection === undefined ? 1 : Math.cos(uvProjection.angle);
    const sin = uvProjection === undefined ? 0 : Math.sin(uvProjection.angle);
    const projectedX = x * cos - y * sin;
    const projectedY = x * sin + y * cos;
    const u =
      uvProjection === undefined
        ? (x - minX) / width
        : 0.5 + projectedX / (2 * uvProjection.radius);
    const v =
      uvProjection === undefined
        ? (maxY - y) / height
        : 0.5 - projectedY / (2 * uvProjection.radius);
    uvs[uvOffset] = u;
    uvs[uvOffset + 1] = v;
    tangents[tangentOffset] = 1;
    tangents[tangentOffset + 3] = 1;
  }

  const attributes = { position: positions, normal: normals, uv: uvs, tangent: tangents };
  const packed = packInterleavedVertexAttributes(attributes, points.length);
  if (!packed.ok) return packed;
  return ok({
    kind: 'mesh',
    vertices: packed.value.vertices,
    indices: new Uint32Array(indices),
    attributes,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: points.length,
        topology,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
    aabb: box3.fromPositions(box3.create(), positions),
  });
}

function fill(points: readonly Vec2[], uvProjection?: UvProjection): Result<MeshAsset, AssetError> {
  const boundary = counterClockwise(points);
  const center = centroid(boundary);
  const vertices = [center, ...boundary];
  const indices: number[] = [];
  for (let i = 0; i < boundary.length; i++) {
    const next = (i + 1) % boundary.length;
    indices.push(0, i + 1, next + 1);
  }
  return buildMesh(vertices, indices, 'triangle-list', uvProjection);
}

function ring(outer: readonly Vec2[], inner: readonly Vec2[]): Result<MeshAsset, AssetError> {
  const outside = counterClockwise(outer);
  const inside = counterClockwise(inner);
  const count = Math.min(outside.length, inside.length);
  const vertices = [...outside.slice(0, count), ...inside.slice(0, count)];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    indices.push(i, next, count + i, next, count + next, count + i);
  }
  return buildMesh(vertices, indices, 'triangle-list');
}

function segment(points: readonly Vec2[]): Result<MeshAsset, AssetError> {
  const indices: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) indices.push(i, i + 1);
  return buildMesh(points, indices, 'line-list');
}

/** Outer outline of any shape: an annulus's outer circle, an open path's own vertices. */
function shapeBoundary(shape: Shape2d, count: number): Vec2[] {
  switch (shape.kind) {
    case 'circle':
      return circleBoundary(shape.radius, count);
    case 'annulus':
      return circleBoundary(shape.outerRadius, count);
    case 'circular-sector':
      return [
        ...arcBoundary(shape.radius, shape.angle, count, -Math.PI / 2 - shape.angle / 2),
        [0, 0],
      ];
    case 'circular-segment':
      return arcBoundary(shape.radius, shape.angle, count, -Math.PI / 2 - shape.angle / 2);
    case 'ellipse':
      return ellipseBoundary(shape.halfWidth, shape.halfHeight, count);
    case 'capsule':
      return capsuleBoundary(shape.radius, shape.halfLength, Math.max(2, Math.floor(count / 2)));
    case 'rhombus':
      return [
        [0, shape.halfHeight],
        [shape.halfWidth, 0],
        [0, -shape.halfHeight],
        [-shape.halfWidth, 0],
      ];
    case 'rectangle':
      return [
        [-shape.width / 2, -shape.height / 2],
        [shape.width / 2, -shape.height / 2],
        [shape.width / 2, shape.height / 2],
        [-shape.width / 2, shape.height / 2],
      ];
    case 'regular-polygon':
      return Array.from({ length: shape.sides }, (_, i) => {
        const angle = -Math.PI / 2 + (i / shape.sides) * Math.PI * 2;
        return [Math.cos(angle) * shape.radius, Math.sin(angle) * shape.radius] as const;
      });
    case 'triangle':
    case 'segment':
    case 'polyline':
      return [...shape.vertices];
  }
}

function scaleAround(points: readonly Vec2[], factor: number): Vec2[] {
  const center = centroid(points);
  return points.map(([x, y]) => [
    center[0] + (x - center[0]) * factor,
    center[1] + (y - center[1]) * factor,
  ]);
}

function withResolution(
  value: number | undefined,
  valid: boolean,
  detail: string,
): Result<number, AssetError> {
  const count = resolution(value);
  return valid && count !== undefined ? ok(count) : invalid(detail);
}

function validateCommon(shape: Shape2d): Result<number, AssetError> {
  switch (shape.kind) {
    case 'circle':
      return withResolution(
        shape.resolution,
        shape.radius > 0 && Number.isFinite(shape.radius),
        `circle radius=${shape.radius}, resolution=${shape.resolution}`,
      );
    case 'circular-sector':
    case 'circular-segment':
      return withResolution(
        shape.resolution,
        shape.radius > 0 &&
          shape.angle > 0 &&
          shape.angle <= Math.PI * 2 &&
          Number.isFinite(shape.radius) &&
          Number.isFinite(shape.angle),
        `${shape.kind} radius=${shape.radius}, angle=${shape.angle}, resolution=${shape.resolution}`,
      );
    case 'ellipse':
      return withResolution(
        shape.resolution,
        shape.halfWidth > 0 &&
          shape.halfHeight > 0 &&
          Number.isFinite(shape.halfWidth) &&
          Number.isFinite(shape.halfHeight),
        `ellipse halfWidth=${shape.halfWidth}, halfHeight=${shape.halfHeight}, resolution=${shape.resolution}`,
      );
    case 'annulus':
      return withResolution(
        shape.resolution,
        shape.innerRadius >= 0 &&
          shape.outerRadius > shape.innerRadius &&
          Number.isFinite(shape.innerRadius) &&
          Number.isFinite(shape.outerRadius),
        `annulus innerRadius=${shape.innerRadius}, outerRadius=${shape.outerRadius}, resolution=${shape.resolution}`,
      );
    case 'capsule':
      return withResolution(
        shape.resolution,
        shape.radius > 0 &&
          shape.halfLength >= 0 &&
          Number.isFinite(shape.radius) &&
          Number.isFinite(shape.halfLength),
        `capsule radius=${shape.radius}, halfLength=${shape.halfLength}, resolution=${shape.resolution}`,
      );
    case 'rhombus':
      return shape.halfWidth > 0 &&
        shape.halfHeight > 0 &&
        Number.isFinite(shape.halfWidth) &&
        Number.isFinite(shape.halfHeight)
        ? ok(0)
        : invalid(`rhombus halfWidth=${shape.halfWidth}, halfHeight=${shape.halfHeight}`);
    case 'rectangle':
      return shape.width > 0 &&
        shape.height > 0 &&
        Number.isFinite(shape.width) &&
        Number.isFinite(shape.height)
        ? ok(0)
        : invalid(`rectangle width=${shape.width}, height=${shape.height}`);
    case 'regular-polygon':
      return shape.radius > 0 &&
        Number.isFinite(shape.radius) &&
        Number.isInteger(shape.sides) &&
        shape.sides >= 3
        ? ok(0)
        : invalid(`regular-polygon radius=${shape.radius}, sides=${shape.sides}`);
    case 'triangle':
      return shape.vertices.every(finitePoint) && Math.abs(area(shape.vertices)) > 1e-7
        ? ok(0)
        : invalid('triangle vertices must be finite and non-collinear');
    case 'segment':
      return shape.vertices.every(finitePoint) &&
        (shape.vertices[0][0] !== shape.vertices[1][0] ||
          shape.vertices[0][1] !== shape.vertices[1][1])
        ? ok(0)
        : invalid('segment endpoints must be finite and distinct');
    case 'polyline':
      return shape.vertices.length >= 2 && shape.vertices.every(finitePoint)
        ? ok(0)
        : invalid('polyline needs at least two finite vertices');
  }
}

export function create2dGeometry(
  shape: Shape2d,
  options?: Shape2dMeshOptions,
): Result<MeshAsset, AssetError> {
  const checked = validateCommon(shape);
  if (!checked.ok) return checked;
  const meshOptions = validateMeshOptions(shape, options);
  if (!meshOptions.ok) return meshOptions;
  const boundary = shapeBoundary(shape, checked.value);
  if (shape.kind === 'segment' || shape.kind === 'polyline') return segment(boundary);
  if (shape.kind === 'annulus') {
    return ring(boundary, circleBoundary(shape.innerRadius, checked.value));
  }
  return fill(boundary, meshOptions.value);
}

export function compute2dBounds(
  shape: Shape2d,
  pose: Shape2dPose = {},
): Result<Shape2dBounds, AssetError> {
  const checked = validateCommon(shape);
  if (!checked.ok) return checked;
  const translation = pose.translation ?? [0, 0];
  const rotation = pose.rotation ?? 0;
  if (!finitePoint(translation) || !Number.isFinite(rotation)) {
    return invalid('2d bounds pose must contain finite translation and rotation');
  }
  const points = shapeBoundary(shape, checked.value);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const transformed = points.map(
    ([x, y]) => [translation[0] + x * cos - y * sin, translation[1] + x * sin + y * cos] as const,
  );
  let radius = 0;
  for (const [x, y] of points) radius = Math.max(radius, Math.hypot(x, y));
  return ok({
    aabb: box2.fromPoints(box2.create(), transformed),
    circle: circle2.create(translation[0], translation[1], radius),
  });
}

export function create2dRingGeometry(
  shape: Shape2d,
  thickness: number,
  resolutionOverride?: number,
): Result<MeshAsset, AssetError> {
  if (!(thickness > 0) || !Number.isFinite(thickness))
    return invalid(`ring thickness=${thickness}`);
  const checked = validateCommon(shape);
  if (!checked.ok) return checked;
  if (shape.kind === 'segment' || shape.kind === 'polyline' || shape.kind === 'annulus') {
    return invalid(`rings require a closed non-annulus shape, got ${shape.kind}`);
  }
  const count = resolutionOverride === undefined ? checked.value : resolution(resolutionOverride);
  if (count === undefined) return invalid(`ring resolution=${resolutionOverride}`);
  const outer = shapeBoundary(shape, count);
  const extent = Math.max(...outer.map(([x, y]) => Math.hypot(x, y)));
  const factor = (extent - thickness) / extent;
  if (!(factor > 1e-5))
    return invalid(`ring thickness=${thickness} exceeds shape extent=${extent}`);
  return ring(outer, scaleAround(outer, factor));
}
