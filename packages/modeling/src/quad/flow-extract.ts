import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from '../arrays';
import { type ModelingError, modelingError } from '../errors';
import type { PositionField } from './field';
import type { IntegerFlowResult } from './integer-flow';
import { cross3, dot3, type TriMesh, triTopology, type Vec3 } from './trimesh';

export interface FlowQuadMesh {
  readonly positions: Float64Array;
  /** Integer lattice coordinates paired with each output vertex. */
  readonly lattice: Int32Array;
  readonly quads: Uint32Array;
  /** Input triangle pair for each output quad. */
  readonly sourceFaces: Uint32Array;
  readonly sharp: readonly (readonly [number, number])[];
}

export interface FlowExtractReport {
  readonly inputFaces: number;
  readonly quads: number;
  readonly openEdges: number;
  readonly nonManifoldEdges: number;
  readonly invertedFoldedQuads: number;
  readonly degenerateQuads: number;
  readonly valence3: number;
  readonly valence5: number;
  readonly inputArea: number;
  readonly quadArea: number;
  readonly areaRatio: number;
}

export interface FlowExtractResult {
  readonly mesh: FlowQuadMesh;
  readonly report: FlowExtractReport;
}

interface Neighbor {
  readonly vertex: number;
  readonly dx: number;
  readonly dy: number;
}

interface TriangleCell {
  readonly face: number;
  readonly vertices: readonly [number, number, number];
  readonly corners: ReadonlyMap<string, number>;
}

interface Candidate {
  readonly faces: readonly [number, number];
  readonly vertices: readonly [number, number, number, number];
}

const MAX_COORDINATE = 0x3fffffff;
const COS_FEATURE = 0.8660254037844386;

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function latticeKey(x: number, y: number): string {
  return `${x},${y}`;
}

function failure(
  reason: string,
  expected: string,
  detail: Record<string, unknown> = {},
): ModelingError {
  return modelingError('model-partial', expected, {
    reason: `integer-map-${reason}`,
    ...detail,
  });
}

function vec(values: Float64Array, vertex: number): Vec3 {
  return [
    values[3 * vertex] as number,
    values[3 * vertex + 1] as number,
    values[3 * vertex + 2] as number,
  ];
}

function triangleNormal(mesh: TriMesh, face: number): Vec3 {
  const a = vec(mesh.positions, mesh.triangles[3 * face] as number);
  const b = vec(mesh.positions, mesh.triangles[3 * face + 1] as number);
  const c = vec(mesh.positions, mesh.triangles[3 * face + 2] as number);
  return cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
}

function add3(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function triangleArea(mesh: TriMesh, face: number): number {
  const n = triangleNormal(mesh, face);
  return Math.sqrt(dot3(n, n)) * 0.5;
}

function mapVertices(
  mesh: TriMesh,
  offsets: IntegerFlowResult['offsets'],
  finalChargeL1: number,
  flowDisabled: boolean,
): Result<Int32Array, ModelingError> {
  if (flowDisabled || finalChargeL1 !== 0)
    return err(
      failure('inconsistent', 'flow-enabled offsets with zero face charge', {
        flowDisabled,
        finalChargeL1,
      }),
    );

  const vertexCount = mesh.positions.length / 3;
  const meshEdges = new Set<string>();
  const adjacency: Neighbor[][] = Array.from({ length: vertexCount }, () => []);
  for (let face = 0; face < mesh.triangles.length / 3; face++)
    for (let k = 0; k < 3; k++) {
      const a = mesh.triangles[3 * face + k] as number;
      const b = mesh.triangles[3 * face + ((k + 1) % 3)] as number;
      meshEdges.add(edgeKey(a, b));
    }

  const found = new Set<string>();
  for (const row of offsets) {
    const [a, b] = row.vertices;
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      a < 0 ||
      b >= vertexCount ||
      a >= b ||
      !Number.isInteger(row.offset[0]) ||
      !Number.isInteger(row.offset[1])
    )
      return err(
        failure('edge-map-invalid', 'ordered mesh edges with integral offsets', {
          vertices: row.vertices,
        }),
      );
    const key = edgeKey(a, b);
    if (!meshEdges.has(key) || found.has(key))
      return err(failure('edge-map-invalid', 'one offset per mesh edge', { edge: key }));
    found.add(key);
    adjacency[a]?.push({ vertex: b, dx: row.offset[0], dy: row.offset[1] });
    adjacency[b]?.push({ vertex: a, dx: -row.offset[0], dy: -row.offset[1] });
  }
  for (const key of meshEdges)
    if (!found.has(key))
      return err(
        failure('edge-map-incomplete', 'one offset per mesh edge', {
          edge: key,
        }),
      );

  const lattice = new Int32Array(2 * vertexCount);
  const assigned = new Uint8Array(vertexCount);
  for (let seed = 0; seed < vertexCount; seed++) {
    if (assigned[seed] !== 0) continue;
    assigned[seed] = 1;
    const queue = [seed];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head] as number;
      for (const link of adjacency[current] ?? []) {
        const x = (lattice[2 * current] as number) + link.dx;
        const y = (lattice[2 * current + 1] as number) + link.dy;
        if (
          !Number.isSafeInteger(x) ||
          !Number.isSafeInteger(y) ||
          Math.abs(x) > MAX_COORDINATE ||
          Math.abs(y) > MAX_COORDINATE
        )
          return err(
            failure('coordinate-range', 'bounded integer coordinates', {
              edge: edgeKey(current, link.vertex),
            }),
          );
        if (assigned[link.vertex] !== 0) {
          if (lattice[2 * link.vertex] !== x || lattice[2 * link.vertex + 1] !== y)
            return err(
              failure('inconsistent', 'one global integer coordinate per mesh vertex', {
                edge: edgeKey(current, link.vertex),
                expected: [x, y],
                actual: [lattice[2 * link.vertex], lattice[2 * link.vertex + 1]],
              }),
            );
          continue;
        }
        assigned[link.vertex] = 1;
        lattice[2 * link.vertex] = x;
        lattice[2 * link.vertex + 1] = y;
        queue.push(link.vertex);
      }
    }
  }
  return ok(lattice);
}

function cellCandidates(mesh: TriMesh, lattice: Int32Array): Candidate[] {
  const cells = new Map<string, TriangleCell[]>();
  for (let face = 0; face < mesh.triangles.length / 3; face++) {
    const vertices = [
      mesh.triangles[3 * face] as number,
      mesh.triangles[3 * face + 1] as number,
      mesh.triangles[3 * face + 2] as number,
    ] as const;
    const points = vertices.map(
      (v) => [lattice[2 * v] as number, lattice[2 * v + 1] as number] as const,
    );
    const x0 = minOf(points.map((p) => p[0]));
    const y0 = minOf(points.map((p) => p[1]));
    const x1 = maxOf(points.map((p) => p[0]));
    const y1 = maxOf(points.map((p) => p[1]));
    if (x1 - x0 !== 1 || y1 - y0 !== 1) continue;
    const corners = new Map(points.map((p, i) => [latticeKey(p[0], p[1]), vertices[i] as number]));
    if (corners.size !== 3) continue;
    const key = latticeKey(x0, y0);
    const row = cells.get(key) ?? [];
    row.push({ face, vertices, corners });
    cells.set(key, row);
  }

  const candidates: Candidate[] = [];
  const usedFaces = new Set<number>();
  for (const [key, row] of cells) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    const cornerKeys = [
      latticeKey(x, y),
      latticeKey(x + 1, y),
      latticeKey(x + 1, y + 1),
      latticeKey(x, y + 1),
    ] as const;
    const triangles = row.sort((a, b) => a.face - b.face);
    for (let i = 0; i < triangles.length; i++) {
      const first = triangles[i] as TriangleCell;
      if (usedFaces.has(first.face)) continue;
      for (let j = i + 1; j < triangles.length; j++) {
        const second = triangles[j] as TriangleCell;
        if (usedFaces.has(second.face)) continue;
        const shared = first.vertices.filter((vertex) => second.vertices.includes(vertex));
        if (shared.length !== 2) continue;
        const diagonalCorners = shared.map((vertex) =>
          cornerKeys.indexOf(
            latticeKey(lattice[2 * vertex] as number, lattice[2 * vertex + 1] as number),
          ),
        );
        if (
          diagonalCorners.some((index) => index < 0) ||
          ((diagonalCorners[0] as number) + 2) % 4 !== diagonalCorners[1]
        )
          continue;
        const corners = cornerKeys.map(
          (corner) => first.corners.get(corner) ?? second.corners.get(corner),
        );
        if (corners.some((vertex) => vertex === undefined) || new Set(corners).size !== 4) continue;
        candidates.push({
          faces: [first.face, second.face],
          vertices: corners as [number, number, number, number],
        });
        usedFaces.add(first.face);
        usedFaces.add(second.face);
        break;
      }
    }
  }
  return candidates.sort((a, b) => a.faces[0] - b.faces[0] || a.faces[1] - b.faces[1]);
}

function meshDiagonal(mesh: TriMesh): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const axis = i % 3;
    lo[axis] = Math.min(lo[axis] as number, mesh.positions[i] as number);
    hi[axis] = Math.max(hi[axis] as number, mesh.positions[i] as number);
  }
  const dx = (hi[0] as number) - (lo[0] as number);
  const dy = (hi[1] as number) - (lo[1] as number);
  const dz = (hi[2] as number) - (lo[2] as number);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function quadArea(
  positions: Float64Array,
  quad: readonly [number, number, number, number],
): number {
  const p = quad.map((vertex) => vec(positions, vertex));
  const area = (a: Vec3, b: Vec3, c: Vec3): number => {
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = cross3(u, v);
    return 0.5 * Math.sqrt(dot3(cross, cross));
  };
  return (
    area(
      p[0] as [number, number, number],
      p[1] as [number, number, number],
      p[2] as [number, number, number],
    ) +
    area(
      p[0] as [number, number, number],
      p[2] as [number, number, number],
      p[3] as [number, number, number],
    )
  );
}

function quality(
  positions: Float64Array,
  quads: readonly (readonly [number, number, number, number])[],
  sources: readonly (readonly [number, number])[],
  input: TriMesh,
  remapped: readonly number[],
): Omit<FlowExtractReport, 'inputFaces'> & {
  readonly sharp: readonly (readonly [number, number])[];
} {
  const edgeCounts = new Map<string, number>();
  const neighbors = new Map<number, Set<number>>();
  const inputFaceByEdge = new Map<string, number[]>();
  let inputArea = 0;
  for (let face = 0; face < input.triangles.length / 3; face++) {
    inputArea += triangleArea(input, face);
    for (let k = 0; k < 3; k++) {
      const a = input.triangles[3 * face + k] as number;
      const b = input.triangles[3 * face + ((k + 1) % 3)] as number;
      const key = edgeKey(a, b);
      const row = inputFaceByEdge.get(key) ?? [];
      row.push(face);
      inputFaceByEdge.set(key, row);
    }
  }
  const sharpInputEdges = new Set<string>();
  for (const [key, faces] of inputFaceByEdge) {
    if (faces.length !== 2) continue;
    const a = triangleNormal(input, faces[0] as number);
    const b = triangleNormal(input, faces[1] as number);
    const denom = Math.sqrt(dot3(a, a) * dot3(b, b));
    if (denom > 0 && dot3(a, b) / denom < COS_FEATURE) sharpInputEdges.add(key);
  }

  let area = 0;
  let invertedFoldedQuads = 0;
  let degenerateQuads = 0;
  for (let q = 0; q < quads.length; q++) {
    const quad = quads[q] as readonly [number, number, number, number];
    const points = quad.map((vertex) => vec(positions, vertex));
    const normal: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const c = cross3(
        points[k] as [number, number, number],
        points[(k + 1) % 4] as [number, number, number],
      );
      normal[0] += c[0];
      normal[1] += c[1];
      normal[2] += c[2];
      const a = quad[k] as number;
      const b = quad[(k + 1) % 4] as number;
      const key = edgeKey(a, b);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      const aa = neighbors.get(a) ?? new Set<number>();
      const bb = neighbors.get(b) ?? new Set<number>();
      aa.add(b);
      bb.add(a);
      neighbors.set(a, aa);
      neighbors.set(b, bb);
    }
    const normalLength = Math.sqrt(dot3(normal, normal));
    let minScaled = Infinity;
    let shortest = Infinity;
    for (let k = 0; k < 4; k++) {
      const p = points[k] as [number, number, number];
      const next = points[(k + 1) % 4] as [number, number, number];
      const prev = points[(k + 3) % 4] as [number, number, number];
      const u: Vec3 = [next[0] - p[0], next[1] - p[1], next[2] - p[2]];
      const v: Vec3 = [prev[0] - p[0], prev[1] - p[1], prev[2] - p[2]];
      const ul = Math.sqrt(dot3(u, u));
      const vl = Math.sqrt(dot3(v, v));
      shortest = Math.min(shortest, ul);
      minScaled = Math.min(
        minScaled,
        normalLength > 0 && ul * vl > 0 ? dot3(cross3(u, v), normal) / (normalLength * ul * vl) : 0,
      );
    }
    const diagonal = meshDiagonal(input);
    const degenerate =
      normalLength <= 2e-12 * (diagonal * diagonal) || shortest <= 1e-12 * diagonal;
    if (degenerate) degenerateQuads++;
    const source = sources[q] as readonly [number, number];
    const refNormal = add3(triangleNormal(input, source[0]), triangleNormal(input, source[1]));
    if (!degenerate && (minScaled <= 0 || dot3(normal, refNormal) <= 0)) invertedFoldedQuads++;
    area += quadArea(positions, quad);
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  const boundary = new Set<number>();
  for (const [key, count] of edgeCounts) {
    if (count === 1) openEdges++;
    if (count > 2) nonManifoldEdges++;
    if (count !== 2) {
      const [a, b] = key.split(':').map(Number) as [number, number];
      boundary.add(a);
      boundary.add(b);
    }
  }
  let valence3 = 0;
  let valence5 = 0;
  for (const [vertex, linked] of neighbors) {
    if (boundary.has(vertex)) continue;
    if (linked.size === 3) valence3++;
    if (linked.size === 5) valence5++;
  }
  const sharp = new Map<string, readonly [number, number]>();
  for (let q = 0; q < quads.length; q++) {
    const quad = quads[q] as readonly [number, number, number, number];
    const sourceFaces = sources[q] as readonly [number, number];
    const sourceVertices = new Set<number>();
    for (const face of sourceFaces)
      for (let k = 0; k < 3; k++) sourceVertices.add(input.triangles[3 * face + k] as number);
    for (let k = 0; k < 4; k++) {
      const outputA = quad[k] as number;
      const outputB = quad[(k + 1) % 4] as number;
      const originalA = remapped[outputA];
      const originalB = remapped[outputB];
      if (
        originalA !== undefined &&
        originalB !== undefined &&
        sourceVertices.has(originalA) &&
        sourceVertices.has(originalB) &&
        sharpInputEdges.has(edgeKey(originalA, originalB))
      )
        sharp.set(edgeKey(outputA, outputB), [outputA, outputB]);
    }
  }

  return {
    quads: quads.length,
    openEdges,
    nonManifoldEdges,
    invertedFoldedQuads,
    degenerateQuads,
    valence3,
    valence5,
    inputArea,
    quadArea: area,
    areaRatio: inputArea > 0 ? area / inputArea : 0,
    sharp: [...sharp.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  };
}

export function extractFlowQuads(
  field: PositionField,
  flow: IntegerFlowResult,
): Result<FlowExtractResult, ModelingError> {
  const input = field.orientation.mesh;
  const topology = triTopology(input);
  if (!topology.ok) return topology;
  const mapped = mapVertices(
    input,
    flow.offsets,
    flow.report.finalChargeL1,
    flow.report.flowDisabled,
  );
  if (!mapped.ok) return mapped;

  const candidates = cellCandidates(input, mapped.value);
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const lattice: number[] = [];
  const quads: [number, number, number, number][] = [];
  const sources: [number, number][] = [];
  const ensureVertex = (source: number): number => {
    const existing = remap.get(source);
    if (existing !== undefined) return existing;
    const id = remap.size;
    remap.set(source, id);
    positions.push(
      input.positions[3 * source] as number,
      input.positions[3 * source + 1] as number,
      input.positions[3 * source + 2] as number,
    );
    lattice.push(mapped.value[2 * source] as number, mapped.value[2 * source + 1] as number);
    return id;
  };
  for (const candidate of candidates) {
    const loop = candidate.vertices.map(ensureVertex) as [number, number, number, number];
    const positionsArray = Float64Array.from(positions);
    const first = vec(positionsArray, loop[0]);
    const second = vec(positionsArray, loop[1]);
    const third = vec(positionsArray, loop[2]);
    const chart = cross3(
      [second[0] - first[0], second[1] - first[1], second[2] - first[2]],
      [third[0] - first[0], third[1] - first[1], third[2] - first[2]],
    );
    const reference = add3(
      triangleNormal(input, candidate.faces[0]),
      triangleNormal(input, candidate.faces[1]),
    );
    if (dot3(chart, reference) < 0) [loop[1], loop[3]] = [loop[3], loop[1]];
    quads.push(loop);
    sources.push([candidate.faces[0], candidate.faces[1]]);
  }

  const positionsArray = Float64Array.from(positions);
  const sourceVertexOf = Array.from(remap.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([vertex]) => vertex);
  const measured = quality(positionsArray, quads, sources, input, sourceVertexOf);
  const mesh: FlowQuadMesh = {
    positions: positionsArray,
    lattice: Int32Array.from(lattice),
    quads: Uint32Array.from(quads.flat()),
    sourceFaces: Uint32Array.from(sources.flat()),
    sharp: measured.sharp,
  };
  const { sharp: _sharp, ...report } = measured;
  return ok({
    mesh,
    report: { inputFaces: input.triangles.length / 3, ...report },
  });
}
