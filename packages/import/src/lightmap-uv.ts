import { deriveVertexCount, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import {
  err,
  isTriangleTopology,
  type MeshAsset,
  ok,
  type Result,
  type UV_ATTRIBUTE_KEYS,
} from '@forgeax/engine-types';

/** A mesh UV set that can carry the lightmap parameterization; `uv1` by default. */
export type LightmapUvSet = (typeof UV_ATTRIBUTE_KEYS)[number];

export interface LightmapUvErrorDetailByCode {
  readonly 'lightmap-uv-missing': { readonly lodIndex: number; readonly uvSet: LightmapUvSet };
  readonly 'lightmap-uv-out-of-range': {
    readonly lodIndex: number;
    readonly uvSet: LightmapUvSet;
    readonly vertexIndex: number;
    readonly uv: readonly [number, number];
  };
  readonly 'lightmap-uv-overlap': {
    readonly lodIndex: number;
    readonly uvSet: LightmapUvSet;
    readonly triangles: readonly [number, number];
  };
  readonly 'lod-lightmap-uv-mismatch': {
    readonly lodIndex: number;
    readonly uvSet: LightmapUvSet;
    readonly triangle: number;
  };
}

export type LightmapUvErrorCode = keyof LightmapUvErrorDetailByCode;

interface LightmapUvErrorOf<K extends LightmapUvErrorCode> {
  readonly code: K;
  readonly expected: string;
  readonly hint: string;
  readonly detail: LightmapUvErrorDetailByCode[K];
}

export type LightmapUvError = {
  readonly [K in LightmapUvErrorCode]: LightmapUvErrorOf<K>;
}[LightmapUvErrorCode];

const LIGHTMAP_UV_ERROR_POLICY = {
  'lightmap-uv-missing': {
    expected: 'every LOD level of a baked mesh carries the lightmap UV set',
    hint: 'author or generate the lightmap UV set (uv1 by default) on every LOD level, then reimport',
  },
  'lightmap-uv-out-of-range': {
    expected: 'finite lightmap UVs inside [0, 1]',
    hint: 'repack the lightmap UV charts into the unit square, then reimport',
  },
  'lightmap-uv-overlap': {
    expected: 'non-overlapping lightmap UV charts',
    hint: 'unwrap the lightmap UV set so no two triangles share texels, then reimport',
  },
  'lod-lightmap-uv-mismatch': {
    expected: 'lower LOD lightmap UVs inside the LOD0 chart coverage',
    hint: 'lock lightmap chart borders when generating LODs to share the LOD0 lightmap; otherwise each LOD is baked separately',
  },
} as const satisfies Record<LightmapUvErrorCode, { expected: string; hint: string }>;

function lightmapUvError<K extends LightmapUvErrorCode>(
  code: K,
  detail: LightmapUvErrorDetailByCode[K],
): LightmapUvErrorOf<K> {
  const { expected, hint } = LIGHTMAP_UV_ERROR_POLICY[code];
  return { code, expected, hint, detail };
}

/**
 * Lightmap storage chosen for one baked mesh. `shared`: every lower LOD samples
 * the LOD0 lightmap (design §8.1 option B). `per-lod`: each level is baked on its
 * own (option A); `diagnostic` names the first level whose charts left LOD0.
 */
export type LightmapUvStorage =
  | { readonly storage: 'shared' }
  | {
      readonly storage: 'per-lod';
      readonly diagnostic: LightmapUvErrorOf<'lod-lightmap-uv-mismatch'>;
    };

// UV-space tolerance: well below one texel of a 4096^2 lightmap (2.4e-4).
const EPSILON = 1e-6;

interface UvTriangles {
  /** Six floats per triangle: u0 v0 u1 v1 u2 v2. */
  readonly coords: Float64Array;
  readonly count: number;
}

/**
 * Validate the lightmap UV set of a baked mesh across its LOD chain, LOD0 first.
 * Hard failures (missing, out of range, overlapping charts within a baked level)
 * return `err`; chart drift of a lower LOD selects per-LOD storage with a
 * `lod-lightmap-uv-mismatch` diagnostic instead of failing the import.
 */
export function validateLightmapUvs(
  levels: readonly [MeshAsset, ...MeshAsset[]],
  uvSet: LightmapUvSet = 'uv1',
): Result<LightmapUvStorage, LightmapUvError> {
  const triangles: UvTriangles[] = [];
  for (const [lodIndex, mesh] of levels.entries()) {
    const read = readUvTriangles(mesh, uvSet, lodIndex);
    if (!read.ok) return read;
    triangles.push(read.value);
  }
  const [lod0, ...lower] = triangles as [UvTriangles, ...UvTriangles[]];
  const lod0Overlap = findOverlap(lod0);
  if (lod0Overlap !== undefined) {
    return err(
      lightmapUvError('lightmap-uv-overlap', { lodIndex: 0, uvSet, triangles: lod0Overlap }),
    );
  }
  const lod0Grid = buildGrid(lod0);
  for (const [offset, level] of lower.entries()) {
    const triangle = findUncovered(level, lod0, lod0Grid);
    if (triangle === undefined) continue;
    const diagnostic = lightmapUvError('lod-lightmap-uv-mismatch', {
      lodIndex: offset + 1,
      uvSet,
      triangle,
    });
    for (const [lowerOffset, perLodLevel] of lower.entries()) {
      const overlap = findOverlap(perLodLevel);
      if (overlap !== undefined) {
        return err(
          lightmapUvError('lightmap-uv-overlap', {
            lodIndex: lowerOffset + 1,
            uvSet,
            triangles: overlap,
          }),
        );
      }
    }
    return ok({ storage: 'per-lod', diagnostic });
  }
  return ok({ storage: 'shared' });
}

function readUvTriangles(
  mesh: MeshAsset,
  uvSet: LightmapUvSet,
  lodIndex: number,
): Result<UvTriangles, LightmapUvError> {
  const projection = deriveVertexLayoutProjection(mesh.attributes);
  const entry = projection.attributes.find((attribute) => attribute.key === uvSet);
  if (entry === undefined) {
    return err(lightmapUvError('lightmap-uv-missing', { lodIndex, uvSet }));
  }
  const floats = mesh.vertices;
  const vertexCount = deriveVertexCount(mesh.vertices, projection) ?? 0;
  const strideFloats = projection.arrayStride / 4;
  const offsetFloats = entry.offset / 4;
  const uvs = new Float64Array(vertexCount * 2);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const u = floats[vertex * strideFloats + offsetFloats] ?? Number.NaN;
    const v = floats[vertex * strideFloats + offsetFloats + 1] ?? Number.NaN;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
      return err(
        lightmapUvError('lightmap-uv-out-of-range', {
          lodIndex,
          uvSet,
          vertexIndex: vertex,
          uv: [u, v],
        }),
      );
    }
    uvs[vertex * 2] = u;
    uvs[vertex * 2 + 1] = v;
  }
  const corners: number[] = [];
  for (const submesh of mesh.submeshes) {
    if (!isTriangleTopology(submesh.topology)) continue;
    const count = mesh.indices === undefined ? submesh.vertexCount : submesh.indexCount;
    const at = (i: number): number =>
      mesh.indices === undefined ? i : (mesh.indices[submesh.indexOffset + i] ?? -1);
    const step = submesh.topology === 'triangle-list' ? 3 : 1;
    for (let i = 0; i + 2 < count; i += step) {
      corners.push(at(i), at(i + 1), at(i + 2));
    }
  }
  const coords = new Float64Array(corners.length * 2);
  for (const [slot, vertex] of corners.entries()) {
    const inRange = vertex >= 0 && vertex < vertexCount;
    coords[slot * 2] = inRange ? (uvs[vertex * 2] ?? Number.NaN) : Number.NaN;
    coords[slot * 2 + 1] = inRange ? (uvs[vertex * 2 + 1] ?? Number.NaN) : Number.NaN;
  }
  return ok({ coords, count: corners.length / 3 });
}

interface Grid {
  readonly size: number;
  readonly cells: readonly number[][];
}

function cellOf(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.floor(value * size)));
}

function triangleCells(
  tris: UvTriangles,
  t: number,
  size: number,
): readonly [number, number, number, number] {
  const c = tris.coords;
  const o = t * 6;
  const us = [c[o] ?? 0, c[o + 2] ?? 0, c[o + 4] ?? 0];
  const vs = [c[o + 1] ?? 0, c[o + 3] ?? 0, c[o + 5] ?? 0];
  return [
    cellOf(Math.min(...us) - EPSILON, size),
    cellOf(Math.min(...vs) - EPSILON, size),
    cellOf(Math.max(...us) + EPSILON, size),
    cellOf(Math.max(...vs) + EPSILON, size),
  ];
}

function buildGrid(tris: UvTriangles): Grid {
  const size = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(tris.count))));
  const cells: number[][] = Array.from({ length: size * size }, () => []);
  for (let t = 0; t < tris.count; t += 1) {
    const [x0, y0, x1, y1] = triangleCells(tris, t, size);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) cells[y * size + x]?.push(t);
    }
  }
  return { size, cells };
}

function signedArea(c: Float64Array, o: number): number {
  const [ax, ay, bx, by, cx, cy] = [c[o], c[o + 1], c[o + 2], c[o + 3], c[o + 4], c[o + 5]] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Separating-axis test that ignores contact along shared edges or vertices. */
function trianglesOverlap(c: Float64Array, a: number, b: number): boolean {
  for (const [owner, other] of [
    [a, b],
    [b, a],
  ] as const) {
    for (let edge = 0; edge < 3; edge += 1) {
      const p = owner * 6 + edge * 2;
      const q = owner * 6 + ((edge + 1) % 3) * 2;
      const nx = (c[q + 1] ?? 0) - (c[p + 1] ?? 0);
      const ny = (c[p] ?? 0) - (c[q] ?? 0);
      const length = Math.hypot(nx, ny);
      if (length === 0) continue;
      let minA = Number.POSITIVE_INFINITY;
      let maxA = Number.NEGATIVE_INFINITY;
      let minB = Number.POSITIVE_INFINITY;
      let maxB = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < 3; k += 1) {
        const da =
          ((c[owner * 6 + k * 2] ?? 0) * nx + (c[owner * 6 + k * 2 + 1] ?? 0) * ny) / length;
        const db =
          ((c[other * 6 + k * 2] ?? 0) * nx + (c[other * 6 + k * 2 + 1] ?? 0) * ny) / length;
        minA = Math.min(minA, da);
        maxA = Math.max(maxA, da);
        minB = Math.min(minB, db);
        maxB = Math.max(maxB, db);
      }
      if (Math.min(maxA, maxB) - Math.max(minA, minB) <= EPSILON) return false;
    }
  }
  return true;
}

function findOverlap(tris: UvTriangles): readonly [number, number] | undefined {
  const grid = buildGrid(tris);
  const bounds = Array.from({ length: tris.count }, (_, t) => triangleCells(tris, t, grid.size));
  for (let cell = 0; cell < grid.cells.length; cell += 1) {
    const members = grid.cells[cell] ?? [];
    const x = cell % grid.size;
    const y = Math.floor(cell / grid.size);
    for (let i = 0; i < members.length; i += 1) {
      const a = members[i] ?? 0;
      if (Math.abs(signedArea(tris.coords, a * 6)) <= EPSILON * EPSILON) continue;
      for (let j = i + 1; j < members.length; j += 1) {
        const b = members[j] ?? 0;
        if (Math.abs(signedArea(tris.coords, b * 6)) <= EPSILON * EPSILON) continue;
        const ba = bounds[a];
        const bb = bounds[b];
        // Test each pair only in the first cell both triangles share.
        if (ba === undefined || bb === undefined) continue;
        if (x !== Math.max(ba[0], bb[0]) || y !== Math.max(ba[1], bb[1])) continue;
        if (trianglesOverlap(tris.coords, a, b)) return [a, b];
      }
    }
  }
  return undefined;
}

function covers(c: Float64Array, t: number, u: number, v: number): boolean {
  const o = t * 6;
  const area = signedArea(c, o);
  if (Math.abs(area) <= EPSILON * EPSILON) return false;
  for (let edge = 0; edge < 3; edge += 1) {
    const p = o + edge * 2;
    const q = o + ((edge + 1) % 3) * 2;
    const px = c[p] ?? 0;
    const py = c[p + 1] ?? 0;
    const cross = ((c[q] ?? 0) - px) * (v - py) - ((c[q + 1] ?? 0) - py) * (u - px);
    const edgeLength = Math.hypot((c[q] ?? 0) - px, (c[q + 1] ?? 0) - py);
    if ((area > 0 ? cross : -cross) < -EPSILON * edgeLength) return false;
  }
  return true;
}

/** First lower-LOD triangle with a vertex, edge midpoint, or centroid outside LOD0 charts. */
function findUncovered(level: UvTriangles, lod0: UvTriangles, grid: Grid): number | undefined {
  const c = level.coords;
  for (let t = 0; t < level.count; t += 1) {
    const o = t * 6;
    const [ax, ay, bx, by, cx, cy] = [c[o], c[o + 1], c[o + 2], c[o + 3], c[o + 4], c[o + 5]] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const samples: readonly (readonly [number, number])[] = [
      [ax, ay],
      [bx, by],
      [cx, cy],
      [(ax + bx) / 2, (ay + by) / 2],
      [(bx + cx) / 2, (by + cy) / 2],
      [(cx + ax) / 2, (cy + ay) / 2],
      [(ax + bx + cx) / 3, (ay + by + cy) / 3],
    ];
    for (const [u, v] of samples) {
      const cell = grid.cells[cellOf(v, grid.size) * grid.size + cellOf(u, grid.size)] ?? [];
      if (!cell.some((candidate) => covers(lod0.coords, candidate, u, v))) return t;
    }
  }
  return undefined;
}
