import type { MeshAsset } from '@forgeax/engine-types';
import type { PointsLinesRetainedSnapshot } from './snapshot';

export interface PointsLinesExpandedGeometry {
  readonly key: string;
  readonly component: 'Points' | 'Lines';
  /** Source endpoints retained for the M3 triangle-expansion consumer. */
  readonly positions: Float32Array;
  /** Canonical position/normal/uv/tangent stream: endpoints, corner, neighbor and distance. */
  readonly vertices: Float32Array;
  /** Six indices per expanded quad. */
  readonly indices: Uint32Array;
  readonly sourceVertexCount: number;
  readonly pointCount: number;
  readonly segmentCount: number;
  readonly expandedVertexCount: number;
  readonly expandedIndexCount: number;
  readonly sourceBytes: number;
  readonly derivedBytes: number;
  readonly bounds: Float32Array;
}

/** Shared CPU expansion cache. Material generations are not geometry key data. */
export class PointsLinesExpansionCache {
  private readonly entries = new Map<string, PointsLinesExpandedGeometry>();

  getOrCreate(snapshot: PointsLinesRetainedSnapshot, mesh: MeshAsset): PointsLinesExpandedGeometry {
    if (snapshot.component === undefined || snapshot.style === undefined) {
      return emptyGeometry(snapshot);
    }
    const key = expansionKey(snapshot);
    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    const geometry = deriveExpandedGeometry(snapshot, mesh, key);
    this.entries.set(key, geometry);
    return geometry;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function expansionKey(snapshot: PointsLinesRetainedSnapshot): string {
  return `mesh:${snapshot.meshHandle}:${snapshot.meshGeneration}:component=${snapshot.component ?? 'none'}`;
}

function deriveExpandedGeometry(
  snapshot: PointsLinesRetainedSnapshot,
  mesh: MeshAsset,
  key: string,
): PointsLinesExpandedGeometry {
  const component = snapshot.component;
  const style = snapshot.style;
  if (component === undefined || style === undefined) return emptyGeometry(snapshot);
  const sourcePositions = readPositions(mesh);
  const positions: number[] = [];
  const vertices: number[] = [];
  const indices: number[] = [];
  let sourceCursor = 0;
  let pointCount = 0;
  let segmentCount = 0;
  const expectedTopology = component === 'Points' ? 'point-list' : 'line-list';
  for (const submesh of mesh.submeshes) {
    if (
      submesh.topology !== expectedTopology &&
      !(component === 'Lines' && submesh.topology === 'line-strip')
    ) {
      sourceCursor += submesh.vertexCount;
      continue;
    }
    const elements =
      mesh.indices !== undefined && submesh.indexCount > 0
        ? Array.from(
            mesh.indices.slice(submesh.indexOffset, submesh.indexOffset + submesh.indexCount),
          )
        : Array.from({ length: submesh.vertexCount }, (_, index) => sourceCursor + index);
    for (const index of elements) {
      const offset = index * 3;
      positions.push(
        sourcePositions[offset] ?? 0,
        sourcePositions[offset + 1] ?? 0,
        sourcePositions[offset + 2] ?? 0,
      );
    }
    if (component === 'Points') {
      pointCount += elements.length;
      for (const index of elements) {
        const offset = index * 3;
        const position = [
          sourcePositions[offset] ?? 0,
          sourcePositions[offset + 1] ?? 0,
          sourcePositions[offset + 2] ?? 0,
        ];
        if (style.kind !== 'points') continue;
        emitQuad(vertices, indices, position, position);
      }
    } else {
      const strip = submesh.topology === 'line-strip';
      const point = (element: number): readonly number[] => {
        const offset = (elements[element] ?? 0) * 3;
        return [
          sourcePositions[offset] ?? 0,
          sourcePositions[offset + 1] ?? 0,
          sourcePositions[offset + 2] ?? 0,
        ];
      };
      const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);
      // Collapse consecutive duplicates once, keeping strip construction linear
      // even for a long stationary trajectory. Preserve the repeated closing end.
      if (strip) {
        let count = 0;
        for (let i = 0; i < elements.length; i++) {
          if (count === 0 || !same(point(i), point(count - 1)))
            elements[count++] = elements[i] ?? 0;
        }
        elements.length = count;
      }
      const closed = strip && elements.length > 2 && same(point(0), point(elements.length - 1));
      let distance = 0;
      for (let element = 0; element + 1 < elements.length; element += strip ? 1 : 2) {
        const start = point(element);
        const end = point(element + 1);
        const length = Math.hypot(
          (end[0] ?? 0) - (start[0] ?? 0),
          (end[1] ?? 0) - (start[1] ?? 0),
          (end[2] ?? 0) - (start[2] ?? 0),
        );
        emitQuad(
          vertices,
          indices,
          start,
          end,
          strip ? point(element > 0 ? element - 1 : closed ? elements.length - 2 : 0) : start,
          strip
            ? point(element + 2 < elements.length ? element + 2 : closed ? 1 : element + 1)
            : end,
          distance,
          distance + length,
        );
        distance += length;
        segmentCount++;
      }
    }
    sourceCursor += submesh.vertexCount;
  }
  const expanded = new Float32Array(positions);
  const expandedVertices = new Float32Array(vertices);
  const expandedIndices = new Uint32Array(indices);
  return {
    key,
    component,
    positions: expanded,
    vertices: expandedVertices,
    indices: expandedIndices,
    sourceVertexCount: sourcePositions.length / 3,
    pointCount,
    segmentCount,
    expandedVertexCount: expandedVertices.length / 12,
    expandedIndexCount: expandedIndices.length,
    sourceBytes: mesh.vertices.byteLength + (mesh.indices?.byteLength ?? 0),
    derivedBytes: expandedVertices.byteLength + expandedIndices.byteLength,
    bounds: boundsOf(expanded),
  };
}

function emitQuad(
  vertices: number[],
  indices: number[],
  start: readonly number[],
  end: readonly number[],
  previous: readonly number[] = start,
  next: readonly number[] = end,
  startDistance = 0,
  endDistance = 0,
): void {
  const base = vertices.length / 12;
  const corners: readonly (readonly [number, number])[] = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];
  for (const [x, y] of corners) {
    vertices.push(
      start[0] ?? 0,
      start[1] ?? 0,
      start[2] ?? 0,
      end[0] ?? 0,
      end[1] ?? 0,
      end[2] ?? 0,
      x,
      y,
      ...(x < 0 ? previous : next),
      x < 0 ? startDistance : endDistance,
    );
  }
  indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
}

function readPositions(mesh: MeshAsset): Float32Array {
  const attribute = mesh.attributes.position;
  if (attribute instanceof Float32Array && attribute.length >= 3) {
    return attribute;
  }
  const vertexCount = mesh.vertices.length / 3;
  const stride = vertexCount > 0 ? mesh.vertices.length / vertexCount : 3;
  const positions = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const source = vertex * stride;
    positions.set(mesh.vertices.subarray(source, source + 3), vertex * 3);
  }
  return positions;
}

function boundsOf(positions: Float32Array): Float32Array {
  if (positions.length === 0) return new Float32Array(0);
  const bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let index = 0; index < positions.length; index += 3) {
    bounds[0] = Math.min(bounds[0] ?? Infinity, positions[index] ?? 0);
    bounds[1] = Math.min(bounds[1] ?? Infinity, positions[index + 1] ?? 0);
    bounds[2] = Math.min(bounds[2] ?? Infinity, positions[index + 2] ?? 0);
    bounds[3] = Math.max(bounds[3] ?? -Infinity, positions[index] ?? 0);
    bounds[4] = Math.max(bounds[4] ?? -Infinity, positions[index + 1] ?? 0);
    bounds[5] = Math.max(bounds[5] ?? -Infinity, positions[index + 2] ?? 0);
  }
  return bounds;
}

function emptyGeometry(snapshot: PointsLinesRetainedSnapshot): PointsLinesExpandedGeometry {
  return {
    key: `empty:${snapshot.entityKey}`,
    component: snapshot.component ?? 'Points',
    positions: new Float32Array(0),
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    sourceVertexCount: 0,
    pointCount: 0,
    segmentCount: 0,
    expandedVertexCount: 0,
    expandedIndexCount: 0,
    sourceBytes: 0,
    derivedBytes: 0,
    bounds: new Float32Array(0),
  };
}
