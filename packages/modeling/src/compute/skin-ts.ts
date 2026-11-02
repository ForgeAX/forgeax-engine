import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from '../arrays';
import { type ModelingError, modelingError } from '../errors';
import { decodeSnapshot } from '../fxem';
import type { Tuple3 } from '../geom';
import type { EditMesh } from '../mesh';
import { TS_BACKEND_IDENTITY } from './boolean-ts';
import type {
  BackendOutput,
  ComputeBackend,
  ComputeJobKind,
  ComputeJobRequest,
  ComputeLocation,
  SkinBindJobParams,
  SkinBone,
  WorkMeter,
} from './job';

const MAX_LOCATIONS = 32;
/** Weights per vertex in the output (the Skinning kernel's four influences). */
export const SKIN_INFLUENCES = 4;

/** Occupancy of one cell: outside the shape, on its surface, or enclosed by it. */
const EXTERIOR = 0;
const SURFACE = 1;
const INTERIOR = 2;

interface Grid {
  readonly origin: Tuple3;
  readonly size: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly state: Uint8Array;
}

function sub(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Tuple3, b: Tuple3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(a: Tuple3): number {
  return Math.sqrt(dot(a, a));
}

/** Distance from `p` to segment `a`-`b` (a point when they coincide). */
function segmentDistance(p: Tuple3, a: Tuple3, b: Tuple3): number {
  const m = sub(b, a);
  const t = sub(p, a);
  const c1 = dot(m, t);
  if (c1 <= 0) return length(t);
  const c2 = dot(m, m);
  if (c2 <= c1) return length(sub(p, b));
  const s = c1 / c2;
  return length([t[0] - m[0] * s, t[1] - m[1] * s, t[2] - m[2] * s]);
}

/** Distance to a bone fan: the segments from its root to every tip, or the root alone. */
export function boneDistance(bone: SkinBone, p: Tuple3): number {
  if (bone.tips.length === 0) return length(sub(p, bone.root));
  let best = Infinity;
  for (const tip of bone.tips) best = Math.min(best, segmentDistance(p, bone.root, tip));
  return best;
}

/** Separating-axis triangle / axis-aligned box overlap. */
function triangleBoxOverlap(
  center: Tuple3,
  half: number,
  a: Tuple3,
  b: Tuple3,
  c: Tuple3,
): boolean {
  const v0 = sub(a, center);
  const v1 = sub(b, center);
  const v2 = sub(c, center);
  const edges = [sub(v1, v0), sub(v2, v1), sub(v0, v2)];
  for (let axis = 0; axis < 3; axis++) {
    const lo = Math.min(v0[axis] as number, v1[axis] as number, v2[axis] as number);
    const hi = Math.max(v0[axis] as number, v1[axis] as number, v2[axis] as number);
    if (lo > half || hi < -half) return false;
  }
  const normal = cross(edges[0] as Tuple3, edges[1] as Tuple3);
  const r = half * (Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]));
  const s = dot(normal, v0);
  if (s > r || s < -r) return false;
  for (const e of edges) {
    for (let axis = 0; axis < 3; axis++) {
      const u: Tuple3 = [0, 0, 0];
      u[axis] = 1;
      const n = cross(u, e);
      const p0 = dot(n, v0);
      const p1 = dot(n, v1);
      const p2 = dot(n, v2);
      const rr = half * (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));
      if (Math.min(p0, p1, p2) > rr || Math.max(p0, p1, p2) < -rr) return false;
    }
  }
  return true;
}

/** Fan triangles of every face (faces are planar; the occupancy only needs coverage). */
function triangles(mesh: EditMesh): number[] {
  const out: number[] = [];
  for (const f of mesh.faces()) {
    const loop = mesh.faceVertices(f);
    for (let i = 1; i + 1 < loop.length; i++)
      out.push(loop[0] as number, loop[i] as number, loop[i + 1] as number);
  }
  return out;
}

/**
 * Occupancy grid over the mesh bounds plus one exterior cell on every side: surface
 * cells overlap a triangle, the exterior is flood-filled from the border through
 * non-surface cells (6-connected), everything else is interior.
 */
function occupancy(
  mesh: EditMesh,
  tris: readonly number[],
  resolution: number,
  work: WorkMeter,
): Grid | undefined {
  const lo: Tuple3 = [Infinity, Infinity, Infinity];
  const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k] as number, p[k] as number);
      hi[k] = Math.max(hi[k] as number, p[k] as number);
    }
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const size = extent / resolution;
  const origin: Tuple3 = [lo[0] - size, lo[1] - size, lo[2] - size];
  const count = (k: number) =>
    Math.max(1, Math.ceil(((hi[k] as number) - (lo[k] as number)) / size)) + 2;
  const nx = count(0);
  const ny = count(1);
  const nz = count(2);
  const state = new Uint8Array(nx * ny * nz).fill(INTERIOR);
  if (!work.spend(state.length)) return undefined;
  const cell = (x: number, k: number, n: number) =>
    Math.min(n - 1, Math.max(0, Math.floor((x - (origin[k] as number)) / size)));
  const half = size / 2;
  for (let t = 0; t < tris.length; t += 3) {
    const a = mesh.position(tris[t] as number);
    const b = mesh.position(tris[t + 1] as number);
    const c = mesh.position(tris[t + 2] as number);
    const span = (k: number, n: number): [number, number] => {
      const values = [a[k] as number, b[k] as number, c[k] as number];
      return [cell(minOf(values), k, n), cell(maxOf(values), k, n)];
    };
    const rx = span(0, nx);
    const ry = span(1, ny);
    const rz = span(2, nz);
    if (!work.spend((rx[1] - rx[0] + 1) * (ry[1] - ry[0] + 1) * (rz[1] - rz[0] + 1)))
      return undefined;
    for (let i = rx[0]; i <= rx[1]; i++) {
      for (let j = ry[0]; j <= ry[1]; j++) {
        for (let k = rz[0]; k <= rz[1]; k++) {
          const index = (k * ny + j) * nx + i;
          if (state[index] === SURFACE) continue;
          const center: Tuple3 = [
            origin[0] + (i + 0.5) * size,
            origin[1] + (j + 0.5) * size,
            origin[2] + (k + 0.5) * size,
          ];
          // A hair of slack keeps triangles lying exactly on a cell face in both cells.
          if (triangleBoxOverlap(center, half * (1 + 1e-6), a, b, c)) state[index] = SURFACE;
        }
      }
    }
  }
  const stack: number[] = [0];
  state[0] = EXTERIOR;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const i = index % nx;
    const j = Math.floor(index / nx) % ny;
    const k = Math.floor(index / (nx * ny));
    const visit = (ii: number, jj: number, kk: number) => {
      if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) return;
      const n = (kk * ny + jj) * nx + ii;
      if (state[n] !== INTERIOR) return;
      state[n] = EXTERIOR;
      stack.push(n);
    };
    visit(i - 1, j, k);
    visit(i + 1, j, k);
    visit(i, j - 1, k);
    visit(i, j + 1, k);
    visit(i, j, k - 1);
    visit(i, j, k + 1);
  }
  return { origin, size, nx, ny, nz, state };
}

const OFFSETS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) if (i !== 0 || j !== 0 || k !== 0) out.push([i, j, k]);
  return out;
})();

/**
 * Geodesic distance from one bone through the non-exterior cells (geodesic voxel route). Seeds are the domain cells within one cell diagonal of the
 * bone's nearest domain cell, at their straight distance: a bone inside a solid seeds
 * the cells it crosses, a bone inside an open sleeve seeds the sleeve's inner wall.
 * Label-correcting FIFO relaxation over 26 neighbors; unreached cells stay Infinity.
 */
function boneField(grid: Grid, bone: SkinBone, work: WorkMeter): Float64Array | undefined {
  const { nx, ny, nz, size, origin, state } = grid;
  const field = new Float64Array(state.length).fill(Infinity);
  const straight = new Float64Array(state.length).fill(Infinity);
  let nearest = Infinity;
  if (!work.spend(state.length)) return undefined;
  for (let index = 0; index < state.length; index++) {
    if (state[index] === EXTERIOR) continue;
    const i = index % nx;
    const j = Math.floor(index / nx) % ny;
    const k = Math.floor(index / (nx * ny));
    const d = boneDistance(bone, [
      origin[0] + (i + 0.5) * size,
      origin[1] + (j + 0.5) * size,
      origin[2] + (k + 0.5) * size,
    ]);
    straight[index] = d;
    nearest = Math.min(nearest, d);
  }
  const reach = nearest + size * Math.sqrt(3);
  const queue: number[] = [];
  for (let index = 0; index < state.length; index++) {
    if ((straight[index] as number) <= reach) {
      field[index] = straight[index] as number;
      queue.push(index);
    }
  }
  const step = OFFSETS.map(([i, j, k]) => Math.sqrt(i * i + j * j + k * k) * size);
  for (let head = 0; head < queue.length; head++) {
    if ((head & 1023) === 0 && !work.spend(1024 * OFFSETS.length)) return undefined;
    const index = queue[head] as number;
    const i = index % nx;
    const j = Math.floor(index / nx) % ny;
    const k = Math.floor(index / (nx * ny));
    const current = field[index] as number;
    for (let o = 0; o < OFFSETS.length; o++) {
      const [di, dj, dk] = OFFSETS[o] as readonly [number, number, number];
      const ii = i + di;
      const jj = j + dj;
      const kk = k + dk;
      if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
      const n = (kk * ny + jj) * nx + ii;
      if (state[n] === EXTERIOR) continue;
      const candidate = current + (step[o] as number);
      if (candidate < (field[n] as number)) {
        field[n] = candidate;
        queue.push(n);
      }
    }
  }
  return field;
}

/** Geodesic distance of a vertex: its (or the nearest neighboring) domain cell plus the offset to it. */
function vertexDistance(grid: Grid, field: Float64Array, p: Tuple3): number {
  const { nx, ny, nz, size, origin } = grid;
  const c = [0, 1, 2].map((k) =>
    Math.min(
      ([nx, ny, nz][k] as number) - 1,
      Math.max(0, Math.floor(((p[k] as number) - (origin[k] as number)) / size)),
    ),
  ) as [number, number, number];
  let best = Infinity;
  for (const [di, dj, dk] of [[0, 0, 0] as const, ...OFFSETS]) {
    const i = c[0] + di;
    const j = c[1] + dj;
    const k = c[2] + dk;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    const d = field[(k * ny + j) * nx + i] as number;
    if (!Number.isFinite(d)) continue;
    const center: Tuple3 = [
      origin[0] + (i + 0.5) * size,
      origin[1] + (j + 0.5) * size,
      origin[2] + (k + 0.5) * size,
    ];
    best = Math.min(best, d + length(sub(center, p)));
    if (di === 0 && dj === 0 && dk === 0 && Number.isFinite(best)) return best;
  }
  return best;
}

/** Weight stiffness, then W = (1 / S(d))^2 on the diagonal-normalized distance. */
function falloff(distance: number, diagonal: number, stiffness: number): number {
  const x = Math.max(distance / diagonal, 1e-6);
  const s = (1 - stiffness) * x + stiffness * x * x;
  return 1 / (s * s);
}

/** Clamped cotangent edge weights of the fan triangulation, as CSR neighbor lists. */
function cotanNeighbors(
  mesh: EditMesh,
  tris: readonly number[],
  vertexCount: number,
): { start: Int32Array; neighbor: Int32Array; weight: Float64Array } {
  const edges = new Map<number, number>();
  const add = (a: number, b: number, w: number) => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a;
    edges.set(key, (edges.get(key) ?? 0) + w);
  };
  for (let t = 0; t < tris.length; t += 3) {
    const ids = [tris[t], tris[t + 1], tris[t + 2]] as [number, number, number];
    const p = ids.map((v) => mesh.position(v)) as [Tuple3, Tuple3, Tuple3];
    for (let corner = 0; corner < 3; corner++) {
      const o = p[corner] as Tuple3;
      const a = (corner + 1) % 3;
      const b = (corner + 2) % 3;
      const u = sub(p[a] as Tuple3, o);
      const v = sub(p[b] as Tuple3, o);
      const area2 = length(cross(u, v));
      const cot = area2 > 1e-20 ? dot(u, v) / area2 : 0;
      // Clamp: obtuse corners must not make weights negative.
      add(ids[a] as number, ids[b] as number, Math.min(1e3, Math.max(1e-3, cot)) / 2);
    }
  }
  const lists: [number, number][][] = Array.from({ length: vertexCount }, () => []);
  for (const key of [...edges.keys()].sort((x, y) => x - y)) {
    const a = Math.floor(key / vertexCount);
    const b = key % vertexCount;
    const w = edges.get(key) as number;
    (lists[a] as [number, number][]).push([b, w]);
    (lists[b] as [number, number][]).push([a, w]);
  }
  const start = new Int32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++)
    start[v + 1] = (start[v] as number) + (lists[v] as []).length;
  const neighbor = new Int32Array(start[vertexCount] as number);
  const weight = new Float64Array(start[vertexCount] as number);
  for (let v = 0; v < vertexCount; v++) {
    for (const [k, [n, w]] of (lists[v] as [number, number][]).entries()) {
      neighbor[(start[v] as number) + k] = n;
      weight[(start[v] as number) + k] = w;
    }
  }
  return { start, neighbor, weight };
}

function rejectParams(expected: string, detail: Record<string, unknown>) {
  return err(modelingError('model-invalid-argument', expected, detail));
}

function checkParams(p: SkinBindJobParams, vertexCount: number): Result<void, ModelingError> {
  const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!Array.isArray(p.bones) || p.bones.length === 0 || p.bones.length > 0xffff) {
    return rejectParams('one to 65535 bones', { bones: p.bones?.length });
  }
  for (const [b, bone] of p.bones.entries()) {
    const points = [bone.root, ...(bone.tips ?? [])];
    if (!points.every((q) => Array.isArray(q) && q.length === 3 && q.every(finite))) {
      return rejectParams('bone roots and tips are finite [x, y, z]', { bone: b });
    }
  }
  if (!Number.isInteger(p.resolution) || p.resolution < 4 || p.resolution > 256) {
    return rejectParams('resolution is an integer in [4, 256]', { resolution: p.resolution });
  }
  if (!finite(p.stiffness) || p.stiffness < 0 || p.stiffness > 1) {
    return rejectParams('stiffness in [0, 1]', { stiffness: p.stiffness });
  }
  if (!Number.isInteger(p.smoothing) || p.smoothing < 0 || p.smoothing > 1000) {
    return rejectParams('smoothing is an iteration count in [0, 1000]', { smoothing: p.smoothing });
  }
  if (!finite(p.smoothingStrength) || p.smoothingStrength <= 0 || p.smoothingStrength > 1) {
    return rejectParams('smoothingStrength in (0, 1]', { smoothingStrength: p.smoothingStrength });
  }
  if (
    !Number.isInteger(p.maxInfluences) ||
    p.maxInfluences < 1 ||
    p.maxInfluences > SKIN_INFLUENCES
  ) {
    return rejectParams(`maxInfluences is an integer in [1, ${SKIN_INFLUENCES}]`, {
      maxInfluences: p.maxInfluences,
    });
  }
  if (!finite(p.prune) || p.prune < 0 || p.prune >= 0.5) {
    return rejectParams('prune in [0, 0.5)', { prune: p.prune });
  }
  const pins = p.pins ?? [];
  if (pins.length % 2 !== 0) return rejectParams('pins are [vertex, bone] pairs', {});
  for (let i = 0; i < pins.length; i += 2) {
    const v = pins[i] as number;
    const b = pins[i + 1] as number;
    if (
      !Number.isInteger(v) ||
      v < 0 ||
      v >= vertexCount ||
      !Number.isInteger(b) ||
      b < 0 ||
      b >= p.bones.length
    ) {
      return rejectParams('pins name input vertices and bones', { pin: i / 2, vertex: v, bone: b });
    }
  }
  return ok(undefined);
}

/**
 * `skin.bind` TS baseline. Input: one FXEM; output 0: Uint16 bone indices and output 1:
 * Float32 weights, SKIN_INFLUENCES per input vertex in FXEM vertex order, sorted by
 * weight (unused slots 0 / 0). Pinned vertices take their bone with weight 1 and hold
 * it through smoothing; a vertex no bone reaches through the grid falls back to straight
 * distances and makes the result `partial`.
 */
export function runSkinBindJob(
  request: ComputeJobRequest<'skin.bind'>,
  work: WorkMeter,
): Result<BackendOutput<'skin.bind'>, ModelingError> {
  if (request.inputs.length !== 1) {
    return rejectParams('skin.bind takes one FXEM input', { inputs: request.inputs.length });
  }
  const decoded = decodeSnapshot(request.inputs[0] as Uint8Array);
  if (!decoded.ok) return decoded;
  const mesh = decoded.value;
  const params = request.params;
  const vertexCount = mesh.vertexCount;
  const checked = checkParams(params, vertexCount);
  if (!checked.ok) return checked;
  if (vertexCount === 0 || mesh.faceCount === 0) {
    return err(modelingError('model-degenerate', 'the skinned region has faces', {}));
  }
  const bones = params.bones;
  const B = bones.length;
  const tris = triangles(mesh);
  const grid = occupancy(mesh, tris, params.resolution, work);
  if (grid === undefined) return err(work.failure as ModelingError);
  const positions = mesh.vertices().map((v) => mesh.position(v));
  let diagonal = 0;
  {
    const lo: Tuple3 = [Infinity, Infinity, Infinity];
    const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
    for (const p of positions) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] as number, p[k] as number);
        hi[k] = Math.max(hi[k] as number, p[k] as number);
      }
    }
    diagonal = Math.max(length(sub(hi, lo)), 1e-12);
  }

  const dense = new Float64Array(vertexCount * B);
  const reached = new Uint8Array(vertexCount);
  for (let b = 0; b < B; b++) {
    const field = boneField(grid, bones[b] as SkinBone, work);
    if (field === undefined) return err(work.failure as ModelingError);
    for (let v = 0; v < vertexCount; v++) {
      const d = vertexDistance(grid, field, positions[v] as Tuple3);
      if (Number.isFinite(d)) {
        dense[v * B + b] = falloff(d, diagonal, params.stiffness);
        reached[v] = 1;
      }
    }
  }
  const locations: ComputeLocation[] = [];
  let unreached = 0;
  for (let v = 0; v < vertexCount; v++) {
    if (reached[v] === 1) continue;
    unreached++;
    for (let b = 0; b < B; b++) {
      dense[v * B + b] = falloff(
        boneDistance(bones[b] as SkinBone, positions[v] as Tuple3),
        diagonal,
        params.stiffness,
      );
    }
    if (locations.length < MAX_LOCATIONS) {
      locations.push({
        reason: 'unreached',
        position: positions[v] as Tuple3,
        detail: { vertex: v },
      });
    }
  }
  const normalizeRow = (row: Float64Array, v: number) => {
    let total = 0;
    for (let b = 0; b < B; b++) total += row[v * B + b] as number;
    if (total > 0) for (let b = 0; b < B; b++) row[v * B + b] = (row[v * B + b] as number) / total;
  };
  for (let v = 0; v < vertexCount; v++) normalizeRow(dense, v);

  const pinned = new Int32Array(vertexCount).fill(-1);
  const pins = params.pins ?? [];
  for (let i = 0; i < pins.length; i += 2) pinned[pins[i] as number] = pins[i + 1] as number;
  const pin = (row: Float64Array) => {
    for (let v = 0; v < vertexCount; v++) {
      const b = pinned[v] as number;
      if (b < 0) continue;
      row.fill(0, v * B, (v + 1) * B);
      row[v * B + b] = 1;
    }
  };
  pin(dense);

  let current = dense;
  if (params.smoothing > 0) {
    const { start, neighbor, weight } = cotanNeighbors(mesh, tris, vertexCount);
    let next = new Float64Array(current.length);
    const alpha = params.smoothingStrength;
    for (let iteration = 0; iteration < params.smoothing; iteration++) {
      if (!work.spend(current.length + neighbor.length * B))
        return err(work.failure as ModelingError);
      for (let v = 0; v < vertexCount; v++) {
        const s = start[v] as number;
        const e = start[v + 1] as number;
        let total = 0;
        for (let k = s; k < e; k++) total += weight[k] as number;
        for (let b = 0; b < B; b++) {
          const own = current[v * B + b] as number;
          if (total <= 0) {
            next[v * B + b] = own;
            continue;
          }
          let sum = 0;
          for (let k = s; k < e; k++)
            sum += (weight[k] as number) * (current[(neighbor[k] as number) * B + b] as number);
          next[v * B + b] = (1 - alpha) * own + (alpha * sum) / total;
        }
      }
      pin(next);
      [current, next] = [next, current];
    }
  }

  const influence = new Uint16Array(vertexCount * SKIN_INFLUENCES);
  const weights = new Float32Array(vertexCount * SKIN_INFLUENCES);
  let used = 0;
  let maxUsed = 0;
  let pruned = 0;
  const order = Array.from({ length: B }, (_, b) => b);
  for (let v = 0; v < vertexCount; v++) {
    const row = order
      .map((b) => [b, current[v * B + b] as number] as const)
      .sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    const kept = row
      .slice(0, params.maxInfluences)
      .filter(([, w], i) => i === 0 || w >= params.prune);
    pruned += row.filter(([, w]) => w > 0).length - kept.length;
    let total = 0;
    for (const [, w] of kept) total += w;
    for (const [i, [b, w]] of kept.entries()) {
      influence[v * SKIN_INFLUENCES + i] = b;
      weights[v * SKIN_INFLUENCES + i] = total > 0 ? w / total : i === 0 ? 1 : 0;
    }
    used += kept.length;
    maxUsed = Math.max(maxUsed, kept.length);
  }
  let interior = 0;
  for (const s of grid.state) if (s !== EXTERIOR) interior++;
  return ok({
    status: unreached > 0 ? 'partial' : 'ok',
    outputs: [new Uint8Array(influence.buffer), new Uint8Array(weights.buffer)],
    provenance: null,
    metrics: {
      vertices: vertexCount,
      bones: B,
      cells: grid.state.length,
      domainCells: interior,
      cellSize: grid.size,
      unreached,
      meanInfluences: used / vertexCount,
      maxInfluences: maxUsed,
      pruned,
    },
    locations,
  });
}

/** TypeScript baseline of `skin.bind`. */
export const tsSkinBackend: ComputeBackend = {
  name: 'ts',
  identity: TS_BACKEND_IDENTITY,
  supports: (kind: ComputeJobKind) => kind === 'skin.bind',
  quality: () => 'baseline',
  run<K extends ComputeJobKind>(
    request: ComputeJobRequest<K>,
    work: WorkMeter,
  ): Result<BackendOutput<K>, ModelingError> {
    return runSkinBindJob(request as ComputeJobRequest<'skin.bind'>, work) as Result<
      BackendOutput<K>,
      ModelingError
    >;
  },
};
