import { box3 } from '@forgeax/engine-math';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  err,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { packInterleavedVertexAttributes } from './vertex-attribute-layout';

const WELD_EPSILON = 1e-4;
const DEFAULT_THRESHOLD_DEGREES = 1;

type Vec3 = readonly [number, number, number];

interface Endpoint {
  readonly value: Vec3;
  readonly exactKey: string;
  readonly weldKey: string;
}

interface Triangle {
  readonly a: Endpoint;
  readonly b: Endpoint;
  readonly c: Endpoint;
  readonly normal: Vec3;
}

interface PreparedMesh {
  readonly triangles: readonly Triangle[];
}

interface WireEdge {
  readonly a: Endpoint;
  readonly b: Endpoint;
}

interface SurfaceEdge {
  readonly aWeldKey: string;
  readonly bWeldKey: string;
  a: Endpoint;
  b: Endpoint;
  readonly normals: Vec3[];
}

function parseFailure(field: string, value: unknown, reason: string): AssetError {
  return new AssetError({
    code: 'asset-parse-failed',
    expected: `a valid triangle-list MeshAsset: ${reason}`,
    hint: ASSET_ERROR_HINTS['asset-parse-failed'],
    detail: { field, value, reason },
  });
}

function f32Bits(value: number): number {
  const buffer = new ArrayBuffer(4);
  new Float32Array(buffer)[0] = value;
  return new Uint32Array(buffer)[0] as number;
}

function normalizedValue(value: number): number {
  return value === 0 ? 0 : value;
}

function exactKey(value: Vec3): string {
  return value
    .map((component) => f32Bits(normalizedValue(component)).toString(16).padStart(8, '0'))
    .join(':');
}

function weldComponent(value: number): string {
  const scaled = normalizedValue(value) / WELD_EPSILON;
  return String(Math.round(scaled));
}

function weldKey(value: Vec3): string {
  return value.map(weldComponent).join(':');
}

function endpoint(position: Vec3): Endpoint {
  const value: Vec3 = [
    normalizedValue(position[0]),
    normalizedValue(position[1]),
    normalizedValue(position[2]),
  ];
  return { value, exactKey: exactKey(value), weldKey: weldKey(value) };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEndpoint(left: Endpoint, right: Endpoint): number {
  return compareText(left.exactKey, right.exactKey);
}

function compareWireEdge(left: WireEdge, right: WireEdge): number {
  return compareEndpoint(left.a, right.a) || compareEndpoint(left.b, right.b);
}

function compareSurfaceEdge(left: SurfaceEdge, right: SurfaceEdge): number {
  return compareText(left.aWeldKey, right.aWeldKey) || compareText(left.bWeldKey, right.bWeldKey);
}

function readPosition(raw: Float32Array | ArrayBuffer): Float32Array {
  return raw instanceof Float32Array ? raw : new Float32Array(raw);
}

function validatePosition(source: MeshAsset): Result<Float32Array, AssetError> {
  if (source === null || typeof source !== 'object' || source.kind !== 'mesh') {
    return err(parseFailure('kind', source?.kind, 'kind must be mesh'));
  }
  const attributes = source.attributes;
  const raw = attributes?.position;
  if (raw === undefined) {
    return err(parseFailure('attributes.position', undefined, 'position is required'));
  }
  if (raw instanceof ArrayBuffer) {
    if (raw.byteLength % 4 !== 0) {
      return err(
        parseFailure(
          'attributes.position',
          raw.byteLength,
          'ArrayBuffer byte length must align to f32',
        ),
      );
    }
  } else if (!(raw instanceof Float32Array)) {
    return err(
      parseFailure(
        'attributes.position',
        raw === null ? null : typeof raw,
        'position storage must be Float32Array or ArrayBuffer',
      ),
    );
  }
  const position = readPosition(raw);
  if (position.length % 3 !== 0) {
    return err(
      parseFailure(
        'attributes.position',
        position.length,
        'position length must be divisible by 3',
      ),
    );
  }
  for (let index = 0; index < position.length; index += 1) {
    const value = position[index] as number;
    if (!Number.isFinite(value)) {
      return err(parseFailure('attributes.position', value, `position[${index}] must be finite`));
    }
  }
  return ok(position);
}

function validateThreshold(threshold: number): Result<number, AssetError> {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 180) {
    return err(
      parseFailure('thresholdAngleDegrees', threshold, 'threshold must be finite and in [0, 180]'),
    );
  }
  return ok(threshold);
}

function validateSubmeshShape(source: MeshAsset, positionCount: number): Result<void, AssetError> {
  if (!Array.isArray(source.submeshes) || source.submeshes.length === 0) {
    return err(parseFailure('submeshes', source.submeshes, 'at least one submesh is required'));
  }
  const indexed = source.indices !== undefined;
  if (!indexed && source.submeshes.length !== 1) {
    return err(
      parseFailure('submeshes', source.submeshes.length, 'non-indexed meshes require one submesh'),
    );
  }
  if (!indexed && positionCount % 3 !== 0) {
    return err(
      parseFailure(
        'attributes.position',
        positionCount,
        'non-indexed positions require triangle cardinality',
      ),
    );
  }
  for (let index = 0; index < source.submeshes.length; index += 1) {
    const submesh = source.submeshes[index];
    if (submesh === undefined || submesh === null || submesh.topology !== 'triangle-list') {
      return err(
        parseFailure(
          `submeshes[${index}].topology`,
          submesh?.topology,
          'topology must be triangle-list',
        ),
      );
    }
    if (!Number.isInteger(submesh.indexOffset) || submesh.indexOffset < 0) {
      return err(
        parseFailure(
          `submeshes[${index}].indexOffset`,
          submesh.indexOffset,
          'index offset must be a non-negative integer',
        ),
      );
    }
    if (!Number.isInteger(submesh.indexCount) || submesh.indexCount < 0) {
      return err(
        parseFailure(
          `submeshes[${index}].indexCount`,
          submesh.indexCount,
          'index count must be a non-negative integer',
        ),
      );
    }
    if (
      !Number.isInteger(submesh.vertexCount) ||
      submesh.vertexCount < 0 ||
      submesh.vertexCount > positionCount
    ) {
      return err(
        parseFailure(
          `submeshes[${index}].vertexCount`,
          submesh.vertexCount,
          'vertex count must be an integer within position count',
        ),
      );
    }
    if (submesh.indexCount % 3 !== 0) {
      return err(
        parseFailure(
          `submeshes[${index}].indexCount`,
          submesh.indexCount,
          'index count must be divisible by 3',
        ),
      );
    }
    if (!indexed && submesh.indexOffset !== 0) {
      return err(
        parseFailure(
          `submeshes[${index}].indexOffset`,
          submesh.indexOffset,
          'non-indexed submesh index offset must be zero',
        ),
      );
    }
    if (!indexed && submesh.indexCount !== 0) {
      return err(
        parseFailure(
          `submeshes[${index}].indexCount`,
          submesh.indexCount,
          'non-indexed submesh index count must be zero',
        ),
      );
    }
    if (!indexed && submesh.vertexCount !== positionCount) {
      return err(
        parseFailure(
          `submeshes[${index}].vertexCount`,
          submesh.vertexCount,
          'non-indexed submesh must span all positions',
        ),
      );
    }
  }
  return ok(undefined);
}

function validateIndices(source: MeshAsset, positionCount: number): Result<void, AssetError> {
  const indices = source.indices;
  if (indices === undefined) return ok(undefined);
  if (!(indices instanceof Uint16Array) && !(indices instanceof Uint32Array)) {
    return err(
      parseFailure('indices', indices, 'indices storage must be Uint16Array or Uint32Array'),
    );
  }
  for (let index = 0; index < source.submeshes.length; index += 1) {
    const submesh = source.submeshes[index];
    if (submesh === undefined) continue;
    if (submesh.indexOffset + submesh.indexCount > indices.length) {
      return err(
        parseFailure(`submeshes[${index}]`, submesh, 'submesh index range exceeds indices length'),
      );
    }
    for (
      let offset = submesh.indexOffset;
      offset < submesh.indexOffset + submesh.indexCount;
      offset += 1
    ) {
      const value = indices[offset] as number;
      if (!Number.isInteger(value) || value < 0 || value >= positionCount) {
        return err(
          parseFailure(`indices[${offset}]`, value, 'index must address a position vertex'),
        );
      }
    }
  }
  return ok(undefined);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | undefined {
  const normal = cross(subtract(b, a), subtract(c, a));
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!Number.isFinite(length) || length === 0) return undefined;
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

function positionAt(position: Float32Array, index: number): Vec3 {
  const base = index * 3;
  return [position[base] as number, position[base + 1] as number, position[base + 2] as number];
}

function makeTriangle(
  position: Float32Array,
  indices: readonly [number, number, number],
): Triangle | undefined {
  const a = endpoint(positionAt(position, indices[0]));
  const b = endpoint(positionAt(position, indices[1]));
  const c = endpoint(positionAt(position, indices[2]));
  const normal = triangleNormal(a.value, b.value, c.value);
  return normal === undefined ? undefined : { a, b, c, normal };
}

function collectTriangles(source: MeshAsset, position: Float32Array): Triangle[] {
  const triangles: Triangle[] = [];
  for (const submesh of source.submeshes) {
    if (source.indices === undefined) {
      for (let offset = 0; offset < submesh.vertexCount; offset += 3) {
        const triangle = makeTriangle(position, [offset, offset + 1, offset + 2]);
        if (triangle !== undefined) triangles.push(triangle);
      }
      continue;
    }
    for (
      let offset = submesh.indexOffset;
      offset < submesh.indexOffset + submesh.indexCount;
      offset += 3
    ) {
      const a = source.indices[offset] as number;
      const b = source.indices[offset + 1] as number;
      const c = source.indices[offset + 2] as number;
      const triangle = makeTriangle(position, [a, b, c]);
      if (triangle !== undefined) triangles.push(triangle);
    }
  }
  return triangles;
}

function prepare(source: MeshAsset, threshold?: number): Result<PreparedMesh, AssetError> {
  const positionResult = validatePosition(source);
  if (!positionResult.ok) return positionResult;
  if (threshold !== undefined) {
    const thresholdResult = validateThreshold(threshold);
    if (!thresholdResult.ok) return thresholdResult;
  }
  const submeshResult = validateSubmeshShape(source, positionResult.value.length / 3);
  if (!submeshResult.ok) return submeshResult;
  const indexResult = validateIndices(source, positionResult.value.length / 3);
  if (!indexResult.ok) return indexResult;
  return ok({ triangles: collectTriangles(source, positionResult.value) });
}

function addWireEdge(edges: Map<string, WireEdge>, left: Endpoint, right: Endpoint): void {
  if (left.exactKey === right.exactKey) return;
  const [a, b] = compareEndpoint(left, right) < 0 ? [left, right] : [right, left];
  const key = `${a.exactKey}|${b.exactKey}`;
  if (!edges.has(key)) edges.set(key, { a, b });
}

function collectWireEdges(triangles: readonly Triangle[]): WireEdge[] {
  const edges = new Map<string, WireEdge>();
  for (const triangle of triangles) {
    addWireEdge(edges, triangle.a, triangle.b);
    addWireEdge(edges, triangle.b, triangle.c);
    addWireEdge(edges, triangle.c, triangle.a);
  }
  return Array.from(edges.values()).sort(compareWireEdge);
}

function updateRepresentative(current: Endpoint, candidate: Endpoint): Endpoint {
  return compareEndpoint(candidate, current) < 0 ? candidate : current;
}

function addSurfaceEdge(
  edges: Map<string, SurfaceEdge>,
  left: Endpoint,
  right: Endpoint,
  normal: Vec3,
): void {
  if (left.weldKey === right.weldKey) return;
  const leftFirst = compareText(left.weldKey, right.weldKey) < 0;
  const a = leftFirst ? left : right;
  const b = leftFirst ? right : left;
  const key = `${a.weldKey}|${b.weldKey}`;
  const current = edges.get(key);
  if (current === undefined) {
    edges.set(key, {
      aWeldKey: a.weldKey,
      bWeldKey: b.weldKey,
      a,
      b,
      normals: [normal],
    });
    return;
  }
  current.a = updateRepresentative(current.a, a);
  current.b = updateRepresentative(current.b, b);
  current.normals.push(normal);
}

function collectSurfaceEdges(triangles: readonly Triangle[]): SurfaceEdge[] {
  const edges = new Map<string, SurfaceEdge>();
  for (const triangle of triangles) {
    addSurfaceEdge(edges, triangle.a, triangle.b, triangle.normal);
    addSurfaceEdge(edges, triangle.b, triangle.c, triangle.normal);
    addSurfaceEdge(edges, triangle.c, triangle.a, triangle.normal);
  }
  return Array.from(edges.values()).sort(compareSurfaceEdge);
}

function keepSurfaceEdge(edge: SurfaceEdge, thresholdDegrees: number): boolean {
  if (edge.normals.length !== 2) return true;
  const first = edge.normals[0];
  const second = edge.normals[1];
  if (first === undefined || second === undefined) return true;
  const dot = Math.min(
    1,
    Math.max(-1, first[0] * second[0] + first[1] * second[1] + first[2] * second[2]),
  );
  return dot <= Math.cos((thresholdDegrees * Math.PI) / 180);
}

function lineMesh(edges: readonly WireEdge[]): Result<MeshAsset, AssetError> {
  const positions = new Float32Array(edges.length * 6);
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const edge = edges[edgeIndex] as WireEdge;
    positions.set(edge.a.value, edgeIndex * 6);
    positions.set(edge.b.value, edgeIndex * 6 + 3);
  }
  const vertexCount = positions.length / 3;
  const attributes: VertexAttributeMap = {
    position: positions,
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    tangent: new Float32Array(vertexCount * 4),
  };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) return err(packed.error);
  return ok({
    kind: 'mesh',
    vertices: packed.value.vertices,
    attributes,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 0,
        vertexCount,
        topology: 'line-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
    aabb: box3.fromPositions(box3.create(), positions),
  });
}

/** Convert every unique exact triangle edge into a sorted non-indexed line carrier. */
export function createWireframeGeometry(source: MeshAsset): Result<MeshAsset, AssetError> {
  const prepared = prepare(source);
  if (!prepared.ok) return prepared;
  return lineMesh(collectWireEdges(prepared.value.triangles));
}

/** Convert boundary, non-manifold, and threshold-surviving surface edges into a line carrier. */
export function createEdgesGeometry(
  source: MeshAsset,
  thresholdAngleDegrees: number = DEFAULT_THRESHOLD_DEGREES,
): Result<MeshAsset, AssetError> {
  const prepared = prepare(source, thresholdAngleDegrees);
  if (!prepared.ok) return prepared;
  const edges = collectSurfaceEdges(prepared.value.triangles).filter((edge) =>
    keepSurfaceEdge(edge, thresholdAngleDegrees),
  );
  return lineMesh(edges.map(({ a, b }) => ({ a, b })));
}
