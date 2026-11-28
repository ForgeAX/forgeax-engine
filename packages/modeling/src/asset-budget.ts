import type { MeshAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import type { Issue } from './report';

/** One exported mesh of an asset, identified by a stable part id. */
export interface AssetPart {
  readonly id: string;
  readonly mesh: MeshAsset;
}

export interface AssetStatsOptions {
  /** Side of the square texel-centre grid used for UV coverage and overlap. Default 512. */
  readonly uvGridSize?: number;
}

/**
 * UV facts of one material slot, namespaced per part as `${partId}/${slotName}`.
 *
 * The mesh alone cannot tell whether two slots share one atlas, so per-material overlap counts
 * only triangles of the same slot. Whole-asset numbers count every triangle together.
 */
export interface AssetMaterialUv {
  readonly material: string;
  readonly triangles: number;
  readonly uvCoverage: number;
  readonly uvOverlap: number;
}

/**
 * Measured facts of a finished asset.
 *
 * - `triangles` / `vertices`: from each submesh range and the position stream of every part.
 * - `materials`: distinct material slots used by any submesh, namespaced per part (a slot shared
 *   by two parts counts twice), so it is a conservative upper bound on distinct draw materials.
 * - `uvCoverage`: fraction of texel centres of an N x N grid over [0,1]^2 hit by at least one UV
 *   triangle. In [0, 1].
 * - `uvOverlap`: texels hit by two or more triangles divided by texels hit by one or more; 0 when
 *   nothing is hit. Shared edges do not count (top-left fill rule).
 * - `uvOutOfRange`: fraction of the summed UV triangle area lying outside [0,1]^2. In [0, 1].
 * - `perMaterial`: the same coverage and overlap per material slot.
 * - `texelSpread`: max / min texel density over non-degenerate triangles, density being
 *   sqrt(uvArea / worldArea). 1 when no triangle is measurable.
 * - `degenerateTriangles`: triangles with zero (relative) area in world or UV space.
 * - `rawBytes`: real vertex and index buffers as stored.
 * - `quantizedBytes`: estimate for a compact GPU layout, see QUANTIZED_VERTEX_BYTES.
 */
export interface AssetStats {
  readonly parts: number;
  readonly triangles: number;
  readonly vertices: number;
  readonly materials: number;
  readonly uvCoverage: number;
  readonly uvOverlap: number;
  readonly uvOutOfRange: number;
  readonly perMaterial: readonly AssetMaterialUv[];
  readonly texelSpread: number;
  readonly degenerateTriangles: number;
  readonly rawBytes: number;
  readonly quantizedBytes: number;
}

export type AssetBudgetCode =
  | 'budget-triangles'
  | 'budget-vertices'
  | 'budget-materials'
  | 'uv-coverage-low'
  | 'uv-overlap'
  | 'uv-out-of-range'
  | 'budget-texel-spread'
  | 'budget-degenerate'
  | 'budget-texture-bytes';

/**
 * Budget of one exported output form. It constrains what the asset is exported as, never the
 * source model: a B-rep or high-detail source is unconstrained, and each use case declares the
 * output profile its export must meet.
 *
 * The three UV limits apply only when `uniqueUv` is true. A profile for intentionally tiled UVs
 * sets it to false and then those limits are not checked.
 */
export interface AssetOutputProfile {
  readonly maxTriangles: number;
  readonly maxVertices: number;
  readonly maxMaterials: number;
  /** Byte limit of the baked textures an output ships with; checked only when texture bytes are passed. */
  readonly maxTextureBytes?: number;
  readonly uniqueUv: boolean;
  readonly minUvCoverage: number;
  readonly maxUvOverlap: number;
  readonly maxUvOutOfRange: number;
  readonly maxTexelSpread: number;
  readonly maxDegenerate: number;
}

export type AssetOutputProfileId =
  | 'mobile-hero'
  | 'mobile-prop'
  | 'mobile-scenery'
  | 'desktop-hero';

/**
 * Initial estimates, not calibrated on devices or frame budgets. They are starting points for
 * the fixed bench and must be revised against measured device evidence before they gate anything.
 * Every built-in profile requires unique UVs; a tiling scenery output needs its own profile.
 */
export const ASSET_OUTPUT_PROFILES: Readonly<Record<AssetOutputProfileId, AssetOutputProfile>> = {
  'mobile-hero': {
    maxTriangles: 30000,
    maxVertices: 20000,
    maxMaterials: 2,
    maxTextureBytes: 12 * 1024 * 1024,
    uniqueUv: true,
    minUvCoverage: 0.2,
    maxUvOverlap: 0.02,
    maxUvOutOfRange: 0.01,
    maxTexelSpread: 4,
    maxDegenerate: 0,
  },
  'mobile-prop': {
    maxTriangles: 8000,
    maxVertices: 6000,
    maxMaterials: 3,
    maxTextureBytes: 12 * 1024 * 1024,
    uniqueUv: true,
    minUvCoverage: 0.1,
    maxUvOverlap: 0.02,
    maxUvOutOfRange: 0.01,
    maxTexelSpread: 8,
    maxDegenerate: 0,
  },
  'mobile-scenery': {
    maxTriangles: 12000,
    maxVertices: 9000,
    maxMaterials: 4,
    maxTextureBytes: 12 * 1024 * 1024,
    uniqueUv: true,
    minUvCoverage: 0.05,
    maxUvOverlap: 0.02,
    maxUvOutOfRange: 0.01,
    maxTexelSpread: 16,
    maxDegenerate: 0,
  },
  'desktop-hero': {
    maxTriangles: 150000,
    maxVertices: 200000,
    maxMaterials: 8,
    maxTextureBytes: 32 * 1024 * 1024,
    uniqueUv: true,
    minUvCoverage: 0.2,
    maxUvOverlap: 0.02,
    maxUvOutOfRange: 0.01,
    maxTexelSpread: 4,
    maxDegenerate: 0,
  },
};

/**
 * Bytes of one baked map: RGBA8 texels, the packed mip chain counted with the same halving as the
 * texture writer. The bake builds exactly this layout, so the verdict can run before the bake.
 */
export function textureBytes(width: number, height: number, mips: boolean): number {
  let w = width;
  let h = height;
  let texels = w * h;
  while (mips && !(w === 1 && h === 1)) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    texels += w * h;
  }
  return texels * 4;
}

/**
 * Quantized estimate per vertex: position 3 x uint16 + pad (8 bytes), octahedral normal (4),
 * octahedral tangent (4, assumed), uv0 2 x uint16 (4). Indices are uint16 when a part has at
 * most 65535 vertices, uint32 otherwise. The layout is an estimate, not the engine's packing.
 */
const QUANTIZED_VERTEX_BYTES = 20;
/** Relative tolerance on a triangle's doubled area against its squared edge lengths. */
const DEGENERATE_RELATIVE_AREA = 1e-12;
const DEFAULT_UV_GRID_SIZE = 512;
const MIN_UV_GRID_SIZE = 8;
const MAX_UV_GRID_SIZE = 4096;

type Point = readonly [number, number];

interface HalfPlane {
  readonly axis: 0 | 1;
  readonly value: number;
  readonly keepAbove: boolean;
}

const UNIT_SQUARE: readonly HalfPlane[] = [
  { axis: 0, value: 0, keepAbove: true },
  { axis: 0, value: 1, keepAbove: false },
  { axis: 1, value: 0, keepAbove: true },
  { axis: 1, value: 1, keepAbove: false },
];

function square(x: number): number {
  return x * x;
}

function isInside(p: Point, h: HalfPlane): boolean {
  return h.keepAbove ? p[h.axis] >= h.value : p[h.axis] <= h.value;
}

function crossing(a: Point, b: Point, h: HalfPlane): Point {
  const t = (h.value - a[h.axis]) / (b[h.axis] - a[h.axis]);
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

function polygonArea(poly: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Point;
    const q = poly[(i + 1) % poly.length] as Point;
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(twice) / 2;
}

/** Area of a UV triangle inside the unit square by Sutherland-Hodgman clipping. */
function clippedUnitArea(a: Point, b: Point, c: Point): number {
  let poly: Point[] = [a, b, c];
  for (const h of UNIT_SQUARE) {
    const next: Point[] = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i] as Point;
      const prev = poly[(i + poly.length - 1) % poly.length] as Point;
      const curIn = isInside(cur, h);
      const prevIn = isInside(prev, h);
      if (curIn) {
        if (!prevIn) next.push(crossing(prev, cur, h));
        next.push(cur);
      } else if (prevIn) {
        next.push(crossing(prev, cur, h));
      }
    }
    poly = next;
    if (poly.length < 3) return 0;
  }
  return polygonArea(poly);
}

/**
 * Marks every texel centre of an n x n grid over [0,1]^2 covered by the UV triangle. Counts
 * saturate at 2. A centre exactly on an edge belongs to exactly one of two triangles sharing that
 * edge (top-left rule), so a shared edge never produces overlap.
 */
function rasterize(grid: Uint8Array, n: number, a: Point, b: Point, c: Point): void {
  const twice = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (twice === 0 || !Number.isFinite(twice)) return;
  const [p, q, r] = twice > 0 ? [a, b, c] : [a, c, b];
  const edges = [
    [p, q],
    [q, r],
    [r, p],
  ].map(([f, t]) => {
    const f0 = f as Point;
    const t0 = t as Point;
    const dy = t0[1] - f0[1];
    const topLeft = dy > 0 || (dy === 0 && t0[0] < f0[0]);
    return { fx: f0[0], fy: f0[1], dx: t0[0] - f0[0], dy, topLeft };
  });
  const minX = Math.min(p[0], q[0], r[0]);
  const maxX = Math.max(p[0], q[0], r[0]);
  const minY = Math.min(p[1], q[1], r[1]);
  const maxY = Math.max(p[1], q[1], r[1]);
  const i0 = Math.max(0, Math.ceil(minX * n - 0.5));
  const i1 = Math.min(n - 1, Math.floor(maxX * n - 0.5));
  const j0 = Math.max(0, Math.ceil(minY * n - 0.5));
  const j1 = Math.min(n - 1, Math.floor(maxY * n - 0.5));
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) / n;
    for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) / n;
      let inside = true;
      for (const e of edges) {
        const side = e.dx * (y - e.fy) - e.dy * (x - e.fx);
        if (side < 0 || (side === 0 && !e.topLeft)) {
          inside = false;
          break;
        }
      }
      const index = j * n + i;
      if (inside && (grid[index] ?? 0) < 2) grid[index] = (grid[index] ?? 0) + 1;
    }
  }
}

function gridCoverage(grid: Uint8Array): { readonly coverage: number; readonly overlap: number } {
  let covered = 0;
  let doubled = 0;
  for (const count of grid) {
    if (count >= 1) covered++;
    if (count >= 2) doubled++;
  }
  return {
    coverage: covered / grid.length,
    overlap: covered === 0 ? 0 : doubled / covered,
  };
}

function invalid(reason: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError(
    'model-invalid-argument',
    'asset parts with finite position and uv0 streams, triangle topologies and in-range submeshes',
    { reason, ...detail },
  );
}

interface MaterialRaster {
  triangles: number;
  readonly grid: Uint8Array;
}

interface Accumulator {
  readonly gridSize: number;
  readonly grid: Uint8Array;
  readonly materials: Map<string, MaterialRaster>;
  triangles: number;
  uvArea: number;
  uvInsideArea: number;
  degenerate: number;
  minDensity: number;
  maxDensity: number;
}

function vertexIndex(indices: MeshAsset['indices'], start: number, k: number, fallback: number) {
  return indices === undefined ? fallback + k : (indices[start + k] ?? -1);
}

function triangleTriples(
  topology: string,
  span: number,
  indices: MeshAsset['indices'],
  start: number,
): number[][] | undefined {
  const at = (k: number) => vertexIndex(indices, start, k, start);
  if (topology === 'triangle-list') {
    if (span % 3 !== 0) return undefined;
    const out: number[][] = [];
    for (let k = 0; k < span; k += 3) out.push([at(k), at(k + 1), at(k + 2)]);
    return out;
  }
  const out: number[][] = [];
  for (let k = 0; k + 2 < span; k++) out.push([at(k), at(k + 1), at(k + 2)]);
  return out;
}

function measureTriangle(
  position: Float32Array,
  uv: Float32Array,
  t: readonly [number, number, number],
  acc: Accumulator,
  material: MaterialRaster,
): void {
  acc.triangles++;
  material.triangles++;
  const [ia, ib, ic] = t;
  const pos = (i: number, axis: number) => position[3 * i + axis] ?? 0;
  const e1 = [0, 1, 2].map((k) => pos(ib, k) - pos(ia, k));
  const e2 = [0, 1, 2].map((k) => pos(ic, k) - pos(ia, k));
  const cross = [
    (e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0),
    (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0),
    (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0),
  ];
  const worldTwice = Math.sqrt(
    square(cross[0] ?? 0) + square(cross[1] ?? 0) + square(cross[2] ?? 0),
  );
  const worldSq =
    square(e1[0] ?? 0) +
    square(e1[1] ?? 0) +
    square(e1[2] ?? 0) +
    square(e2[0] ?? 0) +
    square(e2[1] ?? 0) +
    square(e2[2] ?? 0) +
    square((e2[0] ?? 0) - (e1[0] ?? 0)) +
    square((e2[1] ?? 0) - (e1[1] ?? 0)) +
    square((e2[2] ?? 0) - (e1[2] ?? 0));

  const u = (i: number): Point => [uv[2 * i] ?? 0, uv[2 * i + 1] ?? 0];
  const ua = u(ia);
  const ub = u(ib);
  const uc = u(ic);
  const du0 = ub[0] - ua[0];
  const du1 = ub[1] - ua[1];
  const dv0 = uc[0] - ua[0];
  const dv1 = uc[1] - ua[1];
  const uvTwice = Math.abs(du0 * dv1 - du1 * dv0);
  const uvSq =
    square(du0) + square(du1) + square(dv0) + square(dv1) + square(dv0 - du0) + square(dv1 - du1);

  acc.uvArea += uvTwice / 2;
  acc.uvInsideArea += clippedUnitArea(ua, ub, uc);
  rasterize(acc.grid, acc.gridSize, ua, ub, uc);
  rasterize(material.grid, acc.gridSize, ua, ub, uc);
  if (
    worldTwice <= DEGENERATE_RELATIVE_AREA * worldSq ||
    uvTwice <= DEGENERATE_RELATIVE_AREA * uvSq
  ) {
    acc.degenerate++;
    return;
  }
  const density = Math.sqrt(uvTwice / worldTwice);
  if (density < acc.minDensity) acc.minDensity = density;
  if (density > acc.maxDensity) acc.maxDensity = density;
}

function allFinite(values: Float32Array): boolean {
  for (const v of values) if (!Number.isFinite(v)) return false;
  return true;
}

function measurePart(part: AssetPart, acc: Accumulator): ModelingError | undefined {
  const { mesh } = part;
  const position = mesh.attributes.position;
  const uv = mesh.attributes.uv;
  if (!(position instanceof Float32Array) || position.length === 0 || position.length % 3 !== 0) {
    return invalid('position-stream', { part: part.id });
  }
  if (!allFinite(position)) return invalid('position-stream', { part: part.id });
  const vertexCount = position.length / 3;
  if (!(uv instanceof Float32Array) || uv.length !== vertexCount * 2 || !allFinite(uv)) {
    return invalid('uv0-stream', { part: part.id });
  }
  if (mesh.submeshes.length === 0) return invalid('no-submeshes', { part: part.id });
  for (const sub of mesh.submeshes) {
    if (sub.topology !== 'triangle-list' && sub.topology !== 'triangle-strip') {
      return invalid('topology', { part: part.id, topology: sub.topology });
    }
    const slot = mesh.materialSlots[sub.materialSlot];
    if (slot === undefined) return invalid('material-slot', { part: part.id });
    const key = `${part.id}/${slot.slotName}`;
    let material = acc.materials.get(key);
    if (material === undefined) {
      material = { triangles: 0, grid: new Uint8Array(acc.gridSize * acc.gridSize) };
      acc.materials.set(key, material);
    }
    const indexed = mesh.indices !== undefined;
    const span = indexed ? sub.indexCount : sub.vertexCount;
    const start = indexed ? sub.indexOffset : 0;
    const total = indexed ? (mesh.indices?.length ?? 0) : vertexCount;
    if (start + span > total) return invalid('submesh-range', { part: part.id });
    const triples = triangleTriples(sub.topology, span, mesh.indices, start);
    if (triples === undefined) return invalid('triangle-list-count', { part: part.id });
    for (const t of triples) {
      if (t.some((v) => !(v >= 0 && v < vertexCount))) {
        return invalid('index-out-of-range', { part: part.id });
      }
      measureTriangle(position, uv, t as [number, number, number], acc, material);
    }
  }
  return undefined;
}

/**
 * Measures a finished asset made of one or more exported parts. Fails closed with a Result err
 * for anything it cannot measure exactly: missing or non-finite streams, unsupported topologies,
 * submesh ranges outside the index buffer, out-of-range indices, or an invalid UV grid size.
 */
export function assetStats(
  parts: readonly AssetPart[],
  options: AssetStatsOptions = {},
): Result<AssetStats, ModelingError> {
  const gridSize = options.uvGridSize ?? DEFAULT_UV_GRID_SIZE;
  if (!Number.isInteger(gridSize) || gridSize < MIN_UV_GRID_SIZE || gridSize > MAX_UV_GRID_SIZE) {
    return err(invalid('uv-grid-size', { value: gridSize }));
  }
  if (parts.length === 0) return err(invalid('no-parts'));
  const acc: Accumulator = {
    gridSize,
    grid: new Uint8Array(gridSize * gridSize),
    materials: new Map<string, MaterialRaster>(),
    triangles: 0,
    uvArea: 0,
    uvInsideArea: 0,
    degenerate: 0,
    minDensity: Number.POSITIVE_INFINITY,
    maxDensity: 0,
  };
  let vertices = 0;
  let rawBytes = 0;
  let quantizedBytes = 0;
  for (const part of parts) {
    const before = acc.triangles;
    const failure = measurePart(part, acc);
    if (failure !== undefined) return err(failure);
    const partVertices = (part.mesh.attributes.position as Float32Array).length / 3;
    const partTriangles = acc.triangles - before;
    const indexBytes = partVertices <= 0xffff ? 2 : 4;
    vertices += partVertices;
    rawBytes += part.mesh.vertices.byteLength + (part.mesh.indices?.byteLength ?? 0);
    quantizedBytes += partVertices * QUANTIZED_VERTEX_BYTES + partTriangles * 3 * indexBytes;
  }
  const texelSpread =
    acc.maxDensity > 0 && acc.minDensity > 0 ? acc.maxDensity / acc.minDensity : 1;
  const whole = gridCoverage(acc.grid);
  const outside = acc.uvArea > 0 ? (acc.uvArea - acc.uvInsideArea) / acc.uvArea : 0;
  const perMaterial: AssetMaterialUv[] = [...acc.materials].map(([material, raster]) => {
    const own = gridCoverage(raster.grid);
    return {
      material,
      triangles: raster.triangles,
      uvCoverage: own.coverage,
      uvOverlap: own.overlap,
    };
  });
  return ok({
    parts: parts.length,
    triangles: acc.triangles,
    vertices,
    materials: acc.materials.size,
    uvCoverage: whole.coverage,
    uvOverlap: whole.overlap,
    uvOutOfRange: Math.min(1, Math.max(0, outside)),
    perMaterial,
    texelSpread,
    degenerateTriangles: acc.degenerate,
    rawBytes,
    quantizedBytes,
  });
}

/**
 * Next step for each failing code. Every hint points at the output, never at the source model:
 * the same source can be exported at a lower tessellation tolerance, lowpoly or as an LOD.
 */
const OUTPUT_HINTS: Readonly<Record<AssetBudgetCode, string>> = {
  'budget-triangles':
    'derive a lighter output from the same source: lower the tessellation tolerance, or export a lowpoly or LOD variant',
  'budget-vertices':
    'derive a lighter output from the same source: lower the tessellation tolerance, or export a lowpoly or LOD variant',
  'budget-materials':
    'merge material slots in the output, or export a variant that uses fewer material slots',
  'uv-coverage-low':
    'repack the output UVs so islands fill more of the unit square; very low coverage wastes texel space',
  'uv-overlap':
    're-unwrap or repack the output UVs so islands do not stack; check perMaterial to see whether one slot overlaps itself',
  'uv-out-of-range':
    'move the output UVs into the unit square by re-unwrapping or repacking; intentionally tiled UVs need a profile with uniqueUv false',
  'budget-texel-spread':
    'equalize texel density in the output UVs (uv.auto or a per-island scale), not the source geometry',
  'budget-texture-bytes':
    'lower the bake resolution or the number of baked maps, or ship the map at a smaller size for this profile',
  'budget-degenerate':
    'remove zero-area triangles from the output with the export cleanup, then re-export',
};

/**
 * Compares measured stats with one output profile, given by id or as a caller-declared object.
 * Each violated limit yields one error issue carrying the measured value, the limit and a hint
 * that points at the output; `ok` is true only when no limit is violated.
 */
export function checkAssetBudget(
  stats: AssetStats,
  profile: AssetOutputProfileId | AssetOutputProfile,
  textures?: { readonly bytes: number },
): { readonly ok: boolean; readonly issues: readonly Issue<AssetBudgetCode>[] } {
  const limits = typeof profile === 'string' ? ASSET_OUTPUT_PROFILES[profile] : profile;
  const issues: Issue<AssetBudgetCode>[] = [];
  const fail = (code: AssetBudgetCode, detail: Record<string, unknown>): void => {
    issues.push({
      code,
      severity: 'error',
      detail: {
        profile: typeof profile === 'string' ? profile : 'custom',
        hint: OUTPUT_HINTS[code],
        ...detail,
      },
    });
  };
  if (stats.triangles > limits.maxTriangles) {
    fail('budget-triangles', { measured: stats.triangles, limit: limits.maxTriangles });
  }
  if (stats.vertices > limits.maxVertices) {
    fail('budget-vertices', { measured: stats.vertices, limit: limits.maxVertices });
  }
  if (stats.materials > limits.maxMaterials) {
    fail('budget-materials', { measured: stats.materials, limit: limits.maxMaterials });
  }
  if (limits.uniqueUv) {
    if (stats.uvCoverage < limits.minUvCoverage) {
      fail('uv-coverage-low', { measured: stats.uvCoverage, limit: limits.minUvCoverage });
    }
    if (stats.uvOverlap > limits.maxUvOverlap) {
      fail('uv-overlap', { measured: stats.uvOverlap, limit: limits.maxUvOverlap });
    }
    if (stats.uvOutOfRange > limits.maxUvOutOfRange) {
      fail('uv-out-of-range', { measured: stats.uvOutOfRange, limit: limits.maxUvOutOfRange });
    }
  }
  if (stats.texelSpread > limits.maxTexelSpread) {
    fail('budget-texel-spread', { measured: stats.texelSpread, limit: limits.maxTexelSpread });
  }
  if (stats.degenerateTriangles > limits.maxDegenerate) {
    fail('budget-degenerate', { measured: stats.degenerateTriangles, limit: limits.maxDegenerate });
  }
  if (textures !== undefined && limits.maxTextureBytes !== undefined) {
    if (textures.bytes > limits.maxTextureBytes) {
      fail('budget-texture-bytes', { measured: textures.bytes, limit: limits.maxTextureBytes });
    }
  }
  return { ok: issues.length === 0, issues };
}
