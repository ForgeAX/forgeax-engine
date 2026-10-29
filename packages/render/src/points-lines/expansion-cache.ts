import type { MeshAsset } from '@forgeax/engine-types';
import type { PointsLinesPreparedSnapshot } from './snapshot';

export interface PointsLinesExpandedGeometry {
  readonly key: string;
  readonly component: 'Points' | 'Lines';
  /** Source endpoints retained for the M3 triangle-expansion consumer. */
  readonly positions: Float32Array;
  /**
   * Canonical position/normal/uv/tangent stream. Lines: endpoints, corner,
   * neighbor and distance. Points: center, (size scale, 0, 0), corner, RGBA tint.
   */
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
  private readonly identities = new WeakMap<MeshAsset, number>();
  private nextIdentity = 0;
  private readonly entries = new Map<string, PointsLinesExpandedGeometry>();
  /** Latest key per source slot: a newer mesh generation supersedes the older expansion. */
  private readonly latest = new Map<string, string>();

  getOrCreate(snapshot: PointsLinesPreparedSnapshot, mesh: MeshAsset): PointsLinesExpandedGeometry {
    if (snapshot.component === undefined || snapshot.style === undefined) {
      return emptyGeometry(snapshot);
    }
    let identity = this.identities.get(mesh);
    if (identity === undefined) {
      identity = ++this.nextIdentity;
      this.identities.set(mesh, identity);
    }
    const key = `${expansionKey(snapshot)}:source=${identity}`;
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const geometry = deriveExpandedGeometry(snapshot, mesh, key);
    // Per-frame JS writes (moving particles) bump the generation every frame;
    // retaining each superseded expansion would hold up to 256 stale copies.
    const slot = pointsLinesSourceSlot(snapshot);
    const superseded = this.latest.get(slot);
    if (superseded !== undefined && superseded !== key) this.entries.delete(superseded);
    this.latest.set(slot, key);
    this.entries.set(key, geometry);
    if (this.entries.size > 256) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return geometry;
  }

  clear(): void {
    this.entries.clear();
    this.latest.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Generation-free identity of one retained mesh source in one World. Its
 * prepared GPU buffers are reused across generations of the same source.
 */
export function pointsLinesSourceSlot(snapshot: PointsLinesPreparedSnapshot): string {
  return `world:${snapshot.worldId}:mesh:${snapshot.meshHandle}:component=${snapshot.component ?? 'none'}`;
}

function expansionKey(snapshot: PointsLinesPreparedSnapshot): string {
  return `mesh:${snapshot.meshHandle}:${snapshot.meshGeneration}:component=${snapshot.component ?? 'none'}`;
}

function deriveExpandedGeometry(
  snapshot: PointsLinesPreparedSnapshot,
  mesh: MeshAsset,
  key: string,
): PointsLinesExpandedGeometry {
  const component = snapshot.component;
  const style = snapshot.style;
  if (component === undefined || style === undefined) return emptyGeometry(snapshot);
  const sourcePositions = readPositions(mesh);
  if (component === 'Points') return expandPoints(mesh, sourcePositions, key);
  const positions: number[] = [];
  const vertices: number[] = [];
  const indices: number[] = [];
  let sourceCursor = 0;
  let segmentCount = 0;
  for (const submesh of mesh.submeshes) {
    if (submesh.topology !== 'line-list' && submesh.topology !== 'line-strip') {
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
        if (count === 0 || !same(point(i), point(count - 1))) elements[count++] = elements[i] ?? 0;
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
        strip ? point(element + 2 < elements.length ? element + 2 : closed ? 1 : element + 1) : end,
        distance,
        distance + length,
      );
      distance += length;
      segmentCount++;
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
    pointCount: 0,
    segmentCount,
    expandedVertexCount: expandedVertices.length / 12,
    expandedIndexCount: expandedIndices.length,
    sourceBytes: mesh.vertices.byteLength + (mesh.indices?.byteLength ?? 0),
    derivedBytes: expandedVertices.byteLength + expandedIndices.byteLength,
    bounds: boundsOf(expanded),
  };
}

/** Source element indices of every accepted point-list submesh, in draw order. */
function pointElements(mesh: MeshAsset): number[] {
  const elements: number[] = [];
  let sourceCursor = 0;
  for (const submesh of mesh.submeshes) {
    if (submesh.topology === 'point-list') {
      if (mesh.indices !== undefined && submesh.indexCount > 0) {
        const end = submesh.indexOffset + submesh.indexCount;
        for (let i = submesh.indexOffset; i < end; i++) elements.push(mesh.indices[i] ?? 0);
      } else {
        for (let i = 0; i < submesh.vertexCount; i++) elements.push(sourceCursor + i);
      }
    }
    sourceCursor += submesh.vertexCount;
  }
  return elements;
}

/** A Float32 view of an optional attribute stream; other storage reads as absent. */
function floatStream(value: ArrayBuffer | Float32Array | Uint16Array | undefined) {
  if (value instanceof Float32Array) return value;
  return value instanceof ArrayBuffer ? new Float32Array(value) : undefined;
}

const POINT_CORNERS = [-1, -1, -1, 1, 1, -1, 1, 1] as const;

/**
 * One camera-facing quad per point, written straight into typed arrays so a
 * per-frame position/colour write re-expands thousands of points cheaply.
 * The optional `color` stream tints a point; `uv1.x` scales its size.
 */
function expandPoints(
  mesh: MeshAsset,
  sourcePositions: Float32Array,
  key: string,
): PointsLinesExpandedGeometry {
  const elements = pointElements(mesh);
  const colors = floatStream(mesh.attributes.color);
  const sizes = floatStream(mesh.attributes.uv1);
  const count = elements.length;
  const positions = new Float32Array(count * 3);
  const vertices = new Float32Array(count * 48);
  const indices = new Uint32Array(count * 6);
  for (let point = 0; point < count; point++) {
    const source = elements[point] ?? 0;
    const x = sourcePositions[source * 3] ?? 0;
    const y = sourcePositions[source * 3 + 1] ?? 0;
    const z = sourcePositions[source * 3 + 2] ?? 0;
    positions.set([x, y, z], point * 3);
    const scale = sizes === undefined ? 1 : (sizes[source * 2] ?? 1);
    const tint = colors?.subarray(source * 4, source * 4 + 4);
    for (let corner = 0; corner < 4; corner++) {
      const offset = (point * 4 + corner) * 12;
      vertices[offset] = x;
      vertices[offset + 1] = y;
      vertices[offset + 2] = z;
      vertices[offset + 3] = scale;
      vertices[offset + 6] = POINT_CORNERS[corner * 2] ?? 0;
      vertices[offset + 7] = POINT_CORNERS[corner * 2 + 1] ?? 0;
      if (tint?.length === 4) vertices.set(tint, offset + 8);
      else vertices.fill(1, offset + 8, offset + 12);
    }
    const base = point * 4;
    indices.set([base, base + 1, base + 2, base + 2, base + 1, base + 3], point * 6);
  }
  return {
    key,
    component: 'Points',
    positions,
    vertices,
    indices,
    sourceVertexCount: sourcePositions.length / 3,
    pointCount: count,
    segmentCount: 0,
    expandedVertexCount: count * 4,
    expandedIndexCount: indices.length,
    sourceBytes: mesh.vertices.byteLength + (mesh.indices?.byteLength ?? 0),
    derivedBytes: vertices.byteLength + indices.byteLength,
    bounds: boundsOf(positions),
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

function emptyGeometry(snapshot: PointsLinesPreparedSnapshot): PointsLinesExpandedGeometry {
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
