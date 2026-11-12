import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import { atan2 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import type { Tuple3 } from '../geom';
import { EditMesh } from '../mesh';
import { orient2d } from '../predicates';
import { jobTriangles } from './boolean-ts';
import type {
  BackendOutput,
  ComputeJobRequest,
  SourceFaceProvenance,
  VoxelSign,
  WorkMeter,
} from './job';
import {
  PrimitiveGrid,
  segmentTriangle,
  solveSymmetric,
  soupVolume,
  triangleDistance2,
} from './mesh-query';

const AXES = [0, 1, 2] as const;

/**
 * TS baseline of the `voxel` job: narrow-band signed distance grids of mesh faces
 * (exact point-triangle distances within the band; sign by generalized winding number
 * or by ray crossings along the three grid axes) and their iso surfaces by Surface
 * Nets. A cell holds one vertex per surface sheet: the sign changes on each cube face
 * pair up (a face crossed four times pairs by the sign of its corner sum, the same
 * rule for both cells sharing it), so the quads form a closed oriented 2-manifold.
 */

/** Distance grid: samples at origin + (i, j, k) * voxelSize, x fastest. */
export interface SdfData {
  readonly origin: Tuple3;
  readonly voxelSize: number;
  readonly dims: readonly [number, number, number];
  /** Narrow band half-width in voxels; samples beyond it hold +-band * voxelSize. */
  readonly band: number;
  /** Signed distance in meters, negative inside. */
  readonly values: Float64Array;
  /** Source FXEM face nearest to each band sample, -1 beyond the band. */
  readonly nearest: Int32Array;
}

/** Largest grid the TS baseline builds (samples). */
export const MAX_SAMPLES = 1 << 24;

const MAGIC = 0x44535846; // 'FXSD'
const VERSION = 1;
const HEADER = 56;

/** Canonical little-endian bytes of a grid (the `voxel` job's grid input and output). */
export function encodeSdf(grid: SdfData): Uint8Array {
  const n = grid.values.length;
  const bytes = new Uint8Array(HEADER + n * 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, grid.dims[0], true);
  view.setUint32(12, grid.dims[1], true);
  view.setUint32(16, grid.dims[2], true);
  view.setUint32(20, grid.band, true);
  view.setFloat64(24, grid.origin[0], true);
  view.setFloat64(32, grid.origin[1], true);
  view.setFloat64(40, grid.origin[2], true);
  view.setFloat64(48, grid.voxelSize, true);
  for (let i = 0; i < n; i++) view.setFloat64(HEADER + i * 8, grid.values[i] as number, true);
  const base = HEADER + n * 8;
  for (let i = 0; i < n; i++) view.setInt32(base + i * 4, grid.nearest[i] as number, true);
  return bytes;
}

export function decodeSdf(bytes: Uint8Array): Result<SdfData, ModelingError> {
  const bad = (reason: string) =>
    err(modelingError('model-precondition', `a valid FXSD v${VERSION} grid (${reason})`, {}));
  if (bytes.length < HEADER) return bad('too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return bad('magic');
  if (view.getUint32(4, true) !== VERSION) return bad('version');
  const dims: [number, number, number] = [
    view.getUint32(8, true),
    view.getUint32(12, true),
    view.getUint32(16, true),
  ];
  const n = dims[0] * dims[1] * dims[2];
  if (dims.some((d) => d < 2) || n > MAX_SAMPLES || bytes.length !== HEADER + n * 12) {
    return bad('dimensions');
  }
  const values = new Float64Array(n);
  const nearest = new Int32Array(n);
  for (let i = 0; i < n; i++) values[i] = view.getFloat64(HEADER + i * 8, true);
  const base = HEADER + n * 8;
  for (let i = 0; i < n; i++) nearest[i] = view.getInt32(base + i * 4, true);
  return ok({
    origin: [view.getFloat64(24, true), view.getFloat64(32, true), view.getFloat64(40, true)],
    voxelSize: view.getFloat64(48, true),
    dims,
    band: view.getUint32(20, true),
    values,
    nearest,
  });
}

/** Trilinear sample of a grid, clamped to its box. */
export function sampleSdf(grid: SdfData, p: Tuple3): number {
  const [nx, ny, nz] = grid.dims;
  const f = AXES.map((d) => {
    const x = (p[d] - grid.origin[d]) / grid.voxelSize;
    const max = (grid.dims[d] as number) - 1;
    return x < 0 ? 0 : x > max ? max : x;
  }) as Tuple3;
  const i = Math.min(Math.floor(f[0]), nx - 2);
  const j = Math.min(Math.floor(f[1]), ny - 2);
  const k = Math.min(Math.floor(f[2]), nz - 2);
  const u = f[0] - i;
  const v = f[1] - j;
  const w = f[2] - k;
  const at = (a: number, b: number, c: number) =>
    grid.values[i + a + nx * (j + b + ny * (k + c))] as number;
  const x00 = at(0, 0, 0) * (1 - u) + at(1, 0, 0) * u;
  const x10 = at(0, 1, 0) * (1 - u) + at(1, 1, 0) * u;
  const x01 = at(0, 0, 1) * (1 - u) + at(1, 0, 1) * u;
  const x11 = at(0, 1, 1) * (1 - u) + at(1, 1, 1) * u;
  return (x00 * (1 - v) + x10 * v) * (1 - w) + (x01 * (1 - v) + x11 * v) * w;
}

// ---- triangle soups --------------------------------------------------------------

interface Soup {
  readonly points: Float64Array;
  readonly corners: Int32Array;
  /** Source FXEM face of each triangle. */
  readonly face: Int32Array;
}

function soupOf(mesh: EditMesh, faces: readonly number[]): Soup {
  const triangles = jobTriangles(mesh);
  const corners: number[] = [];
  const face: number[] = [];
  for (const f of faces) {
    const tris = triangles[f];
    if (tris === undefined) {
      // A self-overlapping face still bounds space: fan it from its first corner.
      const halves = mesh.faceHalves(f);
      for (let i = 1; i + 1 < halves.length; i++) {
        corners.push(
          mesh.hVert[halves[0] as number] as number,
          mesh.hVert[halves[i] as number] as number,
          mesh.hVert[halves[i + 1] as number] as number,
        );
        face.push(f);
      }
      continue;
    }
    for (const tri of tris) {
      for (const h of tri) corners.push(mesh.hVert[h] as number);
      face.push(f);
    }
  }
  return {
    points: mesh.pos.slice(0, mesh.vertexHighWater * 3),
    corners: Int32Array.from(corners),
    face: Int32Array.from(face),
  };
}

/** Vertex-connected parts of the faces, each in ascending face order, ordered by lowest face. */
function parts(mesh: EditMesh, faces: readonly number[]): number[][] {
  const parent = new Int32Array(mesh.vertexHighWater);
  for (let v = 0; v < parent.length; v++) parent[v] = v;
  const find = (v: number): number => {
    let r = v;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    while ((parent[v] as number) !== r) {
      const next = parent[v] as number;
      parent[v] = r;
      v = next;
    }
    return r;
  };
  for (const f of faces) {
    const vs = mesh.faceVertices(f);
    for (let i = 1; i < vs.length; i++) {
      const a = find(vs[0] as number);
      const b = find(vs[i] as number);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, number[]>();
  for (const f of faces) {
    const root = find(mesh.faceVertices(f)[0] as number);
    const list = groups.get(root);
    if (list === undefined) groups.set(root, [f]);
    else list.push(f);
  }
  return [...groups.values()].sort((a, b) => (a[0] as number) - (b[0] as number));
}

/**
 * Union operands: the vertex-connected parts, with every inward-facing closed part (a
 * cavity wall, negative volume) joined to the smallest outward part whose bounds hold
 * it. A cavity wall alone bounds nothing, so a separate operand would fill the cavity.
 */
function unionOperands(
  soup: Soup,
  groups: readonly number[][],
  faceTris: ReadonlyMap<number, readonly number[]>,
): number[][] {
  const facts = groups.map((group) => {
    const corners: number[] = [];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const f of group) {
      for (const t of faceTris.get(f) ?? []) {
        for (let k = 0; k < 3; k++) {
          const v = soup.corners[t * 3 + k] as number;
          corners.push(v);
          for (let c = 0; c < 3; c++) {
            const x = soup.points[v * 3 + c] as number;
            lo[c] = Math.min(lo[c] as number, x);
            hi[c] = Math.max(hi[c] as number, x);
          }
        }
      }
    }
    return { volume: soupVolume(soup.points, Int32Array.from(corners)), lo, hi };
  });
  const holds = (outer: number, inner: number) =>
    [0, 1, 2].every(
      (c) =>
        (facts[outer]?.lo[c] as number) <= (facts[inner]?.lo[c] as number) &&
        (facts[outer]?.hi[c] as number) >= (facts[inner]?.hi[c] as number),
    );
  const size = (g: number) =>
    [0, 1, 2].reduce(
      (product, c) => product * ((facts[g]?.hi[c] as number) - (facts[g]?.lo[c] as number)),
      1,
    );
  const owner = groups.map((_, g) => g);
  for (const [g, fact] of facts.entries()) {
    if (!(fact.volume < 0)) continue;
    let best = -1;
    for (const [o, other] of facts.entries()) {
      if (o === g || !(other.volume > 0) || !holds(o, g)) continue;
      if (best < 0 || size(o) < size(best)) best = o;
    }
    if (best >= 0) owner[g] = best;
  }
  const out = new Map<number, number[]>();
  for (const [g, group] of groups.entries()) {
    const target = out.get(owner[g] as number);
    if (target === undefined) out.set(owner[g] as number, [...group]);
    else pushAll(target, group);
  }
  return [...out.values()].map((faces) => faces.sort((a, b) => a - b));
}

// ---- grids ---------------------------------------------------------------------------

interface Lattice {
  readonly origin: Tuple3;
  readonly h: number;
  readonly dims: [number, number, number];
}

/**
 * Lattice phase in voxels. Samples sit at (k + PHASE) h: authored geometry at round
 * coordinates (a box face at a multiple of h) would otherwise put samples exactly on
 * the surface, where the sign is undecided and cell vertices stack on one point.
 */
const PHASE = 0.3819660112501051;

/** Grid around the faces' bounds plus `margin`, on the phased lattice of h. */
function lattice(soup: Soup, h: number, margin: number): Result<Lattice, ModelingError> {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.corners.length; i++) {
    const v = soup.corners[i] as number;
    for (const d of AXES) {
      const x = soup.points[v * 3 + d] as number;
      if (x < min[d]) min[d] = x;
      if (x > max[d]) max[d] = x;
    }
  }
  const lo = AXES.map((d) => Math.floor((min[d] - margin) / h - PHASE)) as Tuple3;
  const hi = AXES.map((d) => Math.ceil((max[d] + margin) / h - PHASE)) as Tuple3;
  const dims = AXES.map((d) => hi[d] - lo[d] + 1) as [number, number, number];
  const samples = dims[0] * dims[1] * dims[2];
  if (!(samples <= MAX_SAMPLES)) {
    return err(
      modelingError(
        'model-work-budget',
        `the voxel grid stays within ${MAX_SAMPLES} samples`,
        { dims, voxelSize: h, samples },
        'raise voxelSize (the sample count grows with its inverse cube) or voxelize fewer faces',
      ),
    );
  }
  return ok({ origin: [(lo[0] + PHASE) * h, (lo[1] + PHASE) * h, (lo[2] + PHASE) * h], h, dims });
}

/** Unsigned narrow-band distances of one soup; `nearest` holds the source face. */
function bandDistances(
  soup: Soup,
  tris: readonly number[],
  grid: Lattice,
  bandDistance: number,
  work: WorkMeter,
): Result<{ distance: Float64Array; nearest: Int32Array }, ModelingError> {
  const [nx, ny, nz] = grid.dims;
  const n = nx * ny * nz;
  const d2 = new Float64Array(n).fill(bandDistance * bandDistance);
  const nearest = new Int32Array(n).fill(-1);
  for (const t of tris) {
    const a = soup.corners[t * 3] as number;
    const b = soup.corners[t * 3 + 1] as number;
    const c = soup.corners[t * 3 + 2] as number;
    const pa: Tuple3 = [
      soup.points[a * 3] as number,
      soup.points[a * 3 + 1] as number,
      soup.points[a * 3 + 2] as number,
    ];
    const pb: Tuple3 = [
      soup.points[b * 3] as number,
      soup.points[b * 3 + 1] as number,
      soup.points[b * 3 + 2] as number,
    ];
    const pc: Tuple3 = [
      soup.points[c * 3] as number,
      soup.points[c * 3 + 1] as number,
      soup.points[c * 3 + 2] as number,
    ];
    const lo: Tuple3 = [0, 0, 0];
    const hi: Tuple3 = [0, 0, 0];
    for (const d of AXES) {
      const min = Math.min(pa[d], pb[d], pc[d]) - bandDistance;
      const max = Math.max(pa[d], pb[d], pc[d]) + bandDistance;
      lo[d] = Math.max(0, Math.ceil((min - grid.origin[d]) / grid.h));
      hi[d] = Math.min((grid.dims[d] as number) - 1, Math.floor((max - grid.origin[d]) / grid.h));
    }
    const count =
      Math.max(0, (hi[0] as number) - (lo[0] as number) + 1) *
      Math.max(0, (hi[1] as number) - (lo[1] as number) + 1) *
      Math.max(0, (hi[2] as number) - (lo[2] as number) + 1);
    if (!work.spend(count + 1)) return err(work.failure as ModelingError);
    const face = soup.face[t] as number;
    for (let k = lo[2]; k <= hi[2]; k++) {
      const z = grid.origin[2] + k * grid.h;
      for (let j = lo[1]; j <= hi[1]; j++) {
        const y = grid.origin[1] + j * grid.h;
        for (let i = lo[0]; i <= hi[0]; i++) {
          const x = grid.origin[0] + i * grid.h;
          const s = i + nx * (j + ny * k);
          const d = triangleDistance2(
            x,
            y,
            z,
            pa[0],
            pa[1],
            pa[2],
            pb[0],
            pb[1],
            pb[2],
            pc[0],
            pc[1],
            pc[2],
          );
          if (d < (d2[s] as number)) {
            d2[s] = d;
            nearest[s] = face;
          }
        }
      }
    }
  }
  const distance = new Float64Array(n);
  for (let s = 0; s < n; s++) distance[s] = Math.sqrt(d2[s] as number);
  return ok({ distance, nearest });
}

// ---- sign: ray crossings ----------------------------------------------------------------

/**
 * Inside flags by signed ray crossings along each grid axis (non-zero rule), voted
 * over the three axes: a point is inside when at least two axes say so, which
 * tolerates small holes that one axis looks through. Each grid line counts a
 * triangle once by the top-left rule on its exact 2D orientation, so lines through
 * shared edges and vertices of closed input count exactly one crossing.
 */
function parityInside(
  soup: Soup,
  tris: readonly number[],
  grid: Lattice,
  work: WorkMeter,
): Result<Uint8Array, ModelingError> {
  const [nx, ny, nz] = grid.dims;
  const votes = new Uint8Array(nx * ny * nz);
  const coord = (d: number, i: number) => (grid.origin[d] as number) + i * grid.h;
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const w = (axis + 2) % 3;
    const nu = grid.dims[u] as number;
    const nw = grid.dims[w] as number;
    const na = grid.dims[axis] as number;
    const lines = new Map<number, { at: number; dir: number }[]>();
    for (const t of tris) {
      const v = [0, 1, 2].map((k) => soup.corners[t * 3 + k] as number);
      let q = v.map((x) => [
        soup.points[x * 3 + u] as number,
        soup.points[x * 3 + w] as number,
        soup.points[x * 3 + axis] as number,
      ]) as [Tuple3, Tuple3, Tuple3];
      const area = orient2d(q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1]);
      if (area === 0) continue;
      // (u, w, axis) is right-handed, so a clockwise projection has its normal toward
      // -axis: a front face that a ray along +axis enters the solid through.
      const enter = area > 0 ? -1 : 1;
      if (area < 0) q = [q[0], q[2], q[1]];
      const minU = Math.max(
        0,
        Math.ceil((Math.min(q[0][0], q[1][0], q[2][0]) - (grid.origin[u] as number)) / grid.h),
      );
      const maxU = Math.min(
        nu - 1,
        Math.floor((Math.max(q[0][0], q[1][0], q[2][0]) - (grid.origin[u] as number)) / grid.h),
      );
      const minW = Math.max(
        0,
        Math.ceil((Math.min(q[0][1], q[1][1], q[2][1]) - (grid.origin[w] as number)) / grid.h),
      );
      const maxW = Math.min(
        nw - 1,
        Math.floor((Math.max(q[0][1], q[1][1], q[2][1]) - (grid.origin[w] as number)) / grid.h),
      );
      if (!work.spend(Math.max(1, (maxU - minU + 1) * (maxW - minW + 1)))) {
        return err(work.failure as ModelingError);
      }
      for (let iw = minW; iw <= maxW; iw++) {
        const y = coord(w, iw);
        for (let iu = minU; iu <= maxU; iu++) {
          const x = coord(u, iu);
          let inside = true;
          const e: number[] = [];
          for (let k = 0; k < 3 && inside; k++) {
            const a = q[k] as Tuple3;
            const b = q[(k + 1) % 3] as Tuple3;
            const o = orient2d(a[0], a[1], b[0], b[1], x, y);
            e.push(o);
            if (o < 0) inside = false;
            else if (o === 0) {
              // Top-left rule for a counter-clockwise triangle: left edges go down, top edges go left.
              const topLeft = b[1] < a[1] || (b[1] === a[1] && b[0] < a[0]);
              if (!topLeft) inside = false;
            }
          }
          if (!inside) continue;
          const total = (e[0] as number) + (e[1] as number) + (e[2] as number);
          const wa = (e[1] as number) / total;
          const wb = (e[2] as number) / total;
          const wc = (e[0] as number) / total;
          const at = wa * q[0][2] + wb * q[1][2] + wc * q[2][2];
          const key = iu + nu * iw;
          const list = lines.get(key);
          const crossing = { at, dir: enter };
          if (list === undefined) lines.set(key, [crossing]);
          else list.push(crossing);
        }
      }
    }
    for (const [key, list] of [...lines.entries()].sort((x, y) => x[0] - y[0])) {
      list.sort((x, y) => x.at - y.at || x.dir - y.dir);
      const iu = key % nu;
      const iw = (key - iu) / nu;
      let count = 0;
      let c = 0;
      for (let ia = 0; ia < na; ia++) {
        const x = coord(axis, ia);
        while (c < list.length && (list[c] as { at: number }).at < x) {
          count += (list[c] as { dir: number }).dir;
          c++;
        }
        if (count === 0) continue;
        const idx = [0, 0, 0];
        idx[axis] = ia;
        idx[u] = iu;
        idx[w] = iw;
        const s = (idx[0] as number) + nx * ((idx[1] as number) + ny * (idx[2] as number));
        votes[s] = (votes[s] as number) + 1;
      }
    }
  }
  const inside = new Uint8Array(votes.length);
  for (let s = 0; s < votes.length; s++) inside[s] = (votes[s] as number) >= 2 ? 1 : 0;
  return ok(inside);
}

// ---- sign: generalized winding number -------------------------------------------------------

interface WindingNode {
  readonly center: Tuple3;
  /** Sum of the triangles' area vectors (half the cross products). */
  readonly area: Tuple3;
  readonly radius: number;
  readonly left: number;
  readonly right: number;
  /** Leaf triangle range [first, last) into `order`, or -1 for inner nodes. */
  readonly first: number;
  readonly last: number;
}

/**
 * Generalized winding number with a far-field dipole approximation of
 * node clusters (first order): a cluster farther than BETA times its radius
 * contributes its area vector's solid angle, nearer leaves are summed exactly.
 */
class WindingTree {
  private readonly nodes: WindingNode[] = [];
  private readonly order: number[];
  private static readonly BETA = 3;
  private static readonly LEAF = 8;

  private readonly soup: Soup;

  constructor(soup: Soup, tris: readonly number[]) {
    this.soup = soup;
    this.order = [...tris];
    this.build(0, this.order.length);
  }

  private corner(t: number, k: number): Tuple3 {
    const v = this.soup.corners[t * 3 + k] as number;
    return [
      this.soup.points[v * 3] as number,
      this.soup.points[v * 3 + 1] as number,
      this.soup.points[v * 3 + 2] as number,
    ];
  }

  private build(first: number, last: number): number {
    const index = this.nodes.length;
    const area: Tuple3 = [0, 0, 0];
    const center: Tuple3 = [0, 0, 0];
    const mean: Tuple3 = [0, 0, 0];
    let total = 0;
    const lo: Tuple3 = [Infinity, Infinity, Infinity];
    const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
    for (let i = first; i < last; i++) {
      const t = this.order[i] as number;
      const [a, b, c] = [this.corner(t, 0), this.corner(t, 1), this.corner(t, 2)];
      const ab: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n: Tuple3 = [
        (ab[1] * ac[2] - ab[2] * ac[1]) / 2,
        (ab[2] * ac[0] - ab[0] * ac[2]) / 2,
        (ab[0] * ac[1] - ab[1] * ac[0]) / 2,
      ];
      const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      for (const d of AXES) {
        area[d] += n[d];
        const centroid = (a[d] + b[d] + c[d]) / 3;
        center[d] += centroid * len;
        mean[d] += centroid;
        lo[d] = Math.min(lo[d], a[d], b[d], c[d]);
        hi[d] = Math.max(hi[d], a[d], b[d], c[d]);
      }
      total += len;
    }
    const count = last - first;
    for (const d of AXES) center[d] = total > 0 ? center[d] / total : mean[d] / count;
    let radius = 0;
    for (let i = first; i < last; i++) {
      for (let k = 0; k < 3; k++) {
        const p = this.corner(this.order[i] as number, k);
        const dx = p[0] - center[0];
        const dy = p[1] - center[1];
        const dz = p[2] - center[2];
        radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
    }
    this.nodes.push({ center, area, radius, left: -1, right: -1, first, last });
    if (count <= WindingTree.LEAF) return index;
    const axis =
      hi[0] - lo[0] >= hi[1] - lo[1] && hi[0] - lo[0] >= hi[2] - lo[2]
        ? 0
        : hi[1] - lo[1] >= hi[2] - lo[2]
          ? 1
          : 2;
    const key = (t: number) =>
      (this.corner(t, 0)[axis] + this.corner(t, 1)[axis] + this.corner(t, 2)[axis]) / 3;
    const slice = this.order.slice(first, last).sort((x, y) => key(x) - key(y) || x - y);
    for (let i = 0; i < slice.length; i++) this.order[first + i] = slice[i] as number;
    const mid = first + (count >> 1);
    const left = this.build(first, mid);
    const right = this.build(mid, last);
    this.nodes[index] = { center, area, radius, left, right, first: -1, last: -1 };
    return index;
  }

  /** Winding number at p; `visits` counts node and triangle evaluations. */
  at(p: Tuple3, visits: { n: number }): number {
    let total = 0;
    const stack = [0];
    while (stack.length > 0) {
      const node = this.nodes[stack.pop() as number] as WindingNode;
      visits.n++;
      const dx = node.center[0] - p[0];
      const dy = node.center[1] - p[1];
      const dz = node.center[2] - p[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > WindingTree.BETA * node.radius && dist > 0) {
        total += (node.area[0] * dx + node.area[1] * dy + node.area[2] * dz) / (dist * dist * dist);
        continue;
      }
      if (node.first < 0) {
        stack.push(node.right, node.left);
        continue;
      }
      for (let i = node.first; i < node.last; i++) {
        const t = this.order[i] as number;
        const a = this.corner(t, 0);
        const b = this.corner(t, 1);
        const c = this.corner(t, 2);
        const ax = a[0] - p[0];
        const ay = a[1] - p[1];
        const az = a[2] - p[2];
        const bx = b[0] - p[0];
        const by = b[1] - p[1];
        const bz = b[2] - p[2];
        const cx = c[0] - p[0];
        const cy = c[1] - p[1];
        const cz = c[2] - p[2];
        const la = Math.sqrt(ax * ax + ay * ay + az * az);
        const lb = Math.sqrt(bx * bx + by * by + bz * bz);
        const lc = Math.sqrt(cx * cx + cy * cy + cz * cz);
        const num = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
        const den =
          la * lb * lc +
          (ax * bx + ay * by + az * bz) * lc +
          (ax * cx + ay * cy + az * cz) * lb +
          (bx * cx + by * cy + bz * cz) * la;
        total += 2 * atan2(num, den);
        visits.n++;
      }
    }
    return total / (4 * Math.PI);
  }
}

/**
 * Inside flags by winding number >= 1/2. Band samples are evaluated; the samples
 * beyond the band form regions (6-connected) that take the unanimous sign of the
 * band samples they touch, and are evaluated sample by sample otherwise (open input
 * whose holes connect inside and outside).
 */
function windingInside(
  soup: Soup,
  tris: readonly number[],
  grid: Lattice,
  nearest: Int32Array,
  work: WorkMeter,
): Result<Uint8Array, ModelingError> {
  const [nx, ny, nz] = grid.dims;
  const n = nx * ny * nz;
  const tree = new WindingTree(soup, tris);
  const inside = new Uint8Array(n);
  const visits = { n: 0 };
  const point = (s: number): Tuple3 => {
    const i = s % nx;
    const j = ((s - i) / nx) % ny;
    const k = (s - i - nx * j) / (nx * ny);
    return [grid.origin[0] + i * grid.h, grid.origin[1] + j * grid.h, grid.origin[2] + k * grid.h];
  };
  const evaluate = (s: number): boolean => {
    visits.n = 0;
    inside[s] = tree.at(point(s), visits) >= 0.5 ? 1 : 0;
    return work.spend(visits.n);
  };
  for (let s = 0; s < n; s++) {
    if ((nearest[s] as number) >= 0 && !evaluate(s)) return err(work.failure as ModelingError);
  }
  const region = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const neighbours = (s: number, visit: (t: number) => void) => {
    const i = s % nx;
    const j = ((s - i) / nx) % ny;
    const k = (s - i - nx * j) / (nx * ny);
    if (i > 0) visit(s - 1);
    if (i < nx - 1) visit(s + 1);
    if (j > 0) visit(s - nx);
    if (j < ny - 1) visit(s + nx);
    if (k > 0) visit(s - nx * ny);
    if (k < nz - 1) visit(s + nx * ny);
  };
  let regions = 0;
  for (let seed = 0; seed < n; seed++) {
    if ((nearest[seed] as number) >= 0 || (region[seed] as number) >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    region[seed] = regions;
    let ins = 0;
    let outs = 0;
    while (head < tail) {
      const s = queue[head++] as number;
      neighbours(s, (t) => {
        if ((nearest[t] as number) >= 0) {
          if ((inside[t] as number) === 1) ins++;
          else outs++;
        } else if ((region[t] as number) < 0) {
          region[t] = regions;
          queue[tail++] = t;
        }
      });
    }
    if (!work.spend(tail)) return err(work.failure as ModelingError);
    if (ins === 0 || outs === 0) {
      const value = ins > 0 && outs === 0 ? 1 : 0;
      for (let q = 0; q < tail; q++) inside[queue[q] as number] = value;
    } else {
      for (let q = 0; q < tail; q++) {
        if (!evaluate(queue[q] as number)) return err(work.failure as ModelingError);
      }
    }
    regions++;
  }
  return ok(inside);
}

// ---- fields ----------------------------------------------------------------------------------

/** Signed narrow-band distance of one part on a lattice. */
function partField(
  soup: Soup,
  tris: readonly number[],
  grid: Lattice,
  band: number,
  sign: VoxelSign,
  work: WorkMeter,
): Result<{ values: Float64Array; nearest: Int32Array }, ModelingError> {
  const bandDistance = band * grid.h;
  const distances = bandDistances(soup, tris, grid, bandDistance, work);
  if (!distances.ok) return distances;
  const { distance, nearest } = distances.value;
  const inside =
    sign === 'parity'
      ? parityInside(soup, tris, grid, work)
      : windingInside(soup, tris, grid, nearest, work);
  if (!inside.ok) return inside;
  const values = new Float64Array(distance.length);
  for (let s = 0; s < values.length; s++) {
    const d = distance[s] as number;
    values[s] = (inside.value[s] as number) === 1 ? -d : d;
  }
  return ok({ values, nearest });
}

/** Polynomial smooth minimum (Quilez): equals min beyond k, blends within it. */
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const diff = a > b ? a - b : b - a;
  const h = diff < k ? (k - diff) / k : 0;
  return (a < b ? a : b) - (h * h * k) / 4;
}

export interface FieldOptions {
  readonly faces: readonly number[];
  readonly voxelSize: number;
  readonly band: number;
  readonly sign: VoxelSign;
  /**
   * Union the vertex-connected parts (each with its cavity walls) by `radius`; otherwise
   * the faces bound one field, so separate shells such as a cavity wall keep their sign.
   */
  readonly union: boolean;
  /** Smooth-union blend radius (meters); 0 is the hard union. */
  readonly radius: number;
  /** Extra grid margin beyond the band (meters). */
  readonly margin: number;
}

/** The (smooth) union of the signed distance fields of the faces' parts on one grid. */
export function buildField(
  mesh: EditMesh,
  options: FieldOptions,
  work: WorkMeter,
): Result<SdfData & { readonly parts: number }, ModelingError> {
  const soup = soupOf(mesh, options.faces);
  if (soup.face.length === 0) {
    return err(modelingError('model-precondition', 'the voxelized faces have area', {}));
  }
  const h = options.voxelSize;
  const grid = lattice(soup, h, (options.band + 2) * h + options.margin);
  if (!grid.ok) return grid;
  const faceTris = new Map<number, number[]>();
  for (let t = 0; t < soup.face.length; t++) {
    const f = soup.face[t] as number;
    const list = faceTris.get(f);
    if (list === undefined) faceTris.set(f, [t]);
    else list.push(t);
  }
  const groups = options.union
    ? unionOperands(soup, parts(mesh, options.faces), faceTris)
    : [[...options.faces]];
  let values: Float64Array | undefined;
  let nearest: Int32Array | undefined;
  for (const group of groups) {
    const tris = group.flatMap((f) => faceTris.get(f) ?? []);
    if (tris.length === 0) continue;
    const field = partField(soup, tris, grid.value, options.band, options.sign, work);
    if (!field.ok) return field;
    if (values === undefined || nearest === undefined) {
      values = field.value.values;
      nearest = field.value.nearest;
      continue;
    }
    for (let s = 0; s < values.length; s++) {
      const a = values[s] as number;
      const b = field.value.values[s] as number;
      if (b < a || (b === a && (nearest[s] as number) < 0))
        nearest[s] = field.value.nearest[s] as number;
      values[s] = smoothMin(a, b, options.radius);
    }
    if (!work.spend(values.length >> 4)) return err(work.failure as ModelingError);
  }
  const bandDistance = options.band * h;
  const out = values as Float64Array;
  const near = nearest as Int32Array;
  for (let s = 0; s < out.length; s++) {
    const v = out[s] as number;
    if (v > bandDistance) out[s] = bandDistance;
    else if (v < -bandDistance) out[s] = -bandDistance;
  }
  // The grid border is outside by construction (margin), so every iso surface closes.
  const [nx, ny, nz] = grid.value.dims;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i > 0 && j > 0 && k > 0 && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
        const s = i + nx * (j + ny * k);
        if ((out[s] as number) < bandDistance) out[s] = bandDistance;
      }
    }
  }
  return ok({
    origin: grid.value.origin,
    voxelSize: h,
    dims: grid.value.dims,
    band: options.band,
    values: out,
    nearest: near,
    parts: groups.length,
  });
}

// ---- Surface Nets ------------------------------------------------------------------------------

/** Cube corner offsets (corner c = dx + 2 dy + 4 dz) of the 12 cube edges: x, y, then z edges. */
const CUBE_EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** Cube faces: corners in cyclic order and the edges between consecutive corners. */
const CUBE_FACES: readonly {
  readonly corners: readonly number[];
  readonly edges: readonly number[];
}[] = [
  { corners: [0, 2, 6, 4], edges: [4, 10, 6, 8] },
  { corners: [1, 3, 7, 5], edges: [5, 11, 7, 9] },
  { corners: [0, 1, 5, 4], edges: [0, 9, 2, 8] },
  { corners: [2, 3, 7, 6], edges: [1, 11, 3, 10] },
  { corners: [0, 1, 3, 2], edges: [0, 5, 1, 4] },
  { corners: [4, 5, 7, 6], edges: [2, 7, 3, 6] },
];

/** Corner masks with a cube face crossed four times (inside corners on one diagonal). */
const AMBIGUOUS = Array.from({ length: 256 }, (_, mask) =>
  CUBE_FACES.some(({ corners }) => {
    const bits = corners.map((c) => (mask >> c) & 1);
    return bits[0] === bits[2] && bits[1] === bits[3] && bits[0] !== bits[1];
  }),
);

export interface SurfaceOptions {
  readonly iso: number;
  readonly smooth: number;
  readonly sharp: boolean;
  /**
   * Hermite data of `sharp`: every crossing of grid edge a->b (inside to outside) with a
   * source triangle facing along it, with that face's unit normal. Surface Nets keeps
   * the one where the sampled field is closest to the level (within half a voxel):
   * interpolating the distance misplaces crossings near a corner (it is radial there)
   * and the finite-difference gradient smears across the corner cell. Crossings of
   * blends, offsets and buried source faces fail the field check and keep both.
   */
  readonly hermite?: (
    a: Tuple3,
    b: Tuple3,
  ) => readonly { readonly point: Tuple3; readonly normal: Tuple3 }[];
}

export interface Surface {
  readonly mesh: EditMesh;
  /** Per face id of `mesh`: the nearest source face, or -1. */
  readonly source: Int32Array;
  /** Cell vertices placed on a feature (dual contouring rank >= 2). */
  readonly features: number;
}

/**
 * Iso surface of a grid by Surface Nets: one vertex per surface sheet of a cell at
 * the mean of its edge crossings (or the dual contouring minimizer with `sharp`),
 * one quad per crossed grid edge, outward oriented. `smooth` sweeps move each
 * non-feature vertex to the mean of its neighbours, back onto the iso level by one
 * gradient step and inside its cell.
 */
export function surfaceNets(
  grid: SdfData,
  options: SurfaceOptions,
  work: WorkMeter,
): Result<Surface, ModelingError> {
  const [nx, ny, nz] = grid.dims;
  const h = grid.voxelSize;
  const f = new Float64Array(grid.values.length);
  for (let s = 0; s < f.length; s++) f[s] = (grid.values[s] as number) - options.iso;
  const inside = (s: number) => (f[s] as number) < 0;
  const levels: SdfData = { ...grid, values: f };
  const sample = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const corner = (i: number, j: number, k: number, c: number) =>
    sample(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
  const gradient = (s: number): Tuple3 => {
    const i = s % nx;
    const j = ((s - i) / nx) % ny;
    const k = (s - i - nx * j) / (nx * ny);
    const g: Tuple3 = [0, 0, 0];
    const ids = [i, j, k];
    const strides = [1, nx, nx * ny];
    for (const d of AXES) {
      const x = ids[d] as number;
      const n = grid.dims[d] as number;
      const stride = strides[d] as number;
      const lo = x > 0 ? s - stride : s;
      const hi = x < n - 1 ? s + stride : s;
      g[d] = ((f[hi] as number) - (f[lo] as number)) / ((hi === lo ? 1 : (hi - lo) / stride) * h);
    }
    return g;
  };
  const position = (s: number): Tuple3 => {
    const i = s % nx;
    const j = ((s - i) / nx) % ny;
    const k = (s - i - nx * j) / (nx * ny);
    return [grid.origin[0] + i * h, grid.origin[1] + j * h, grid.origin[2] + k * h];
  };
  /** Pairing of a cube face crossed four times: true when the corner sum is inside. */
  const faceCenterInside = (samples: readonly number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    let sum = 0;
    for (const s of sorted) sum += f[s] as number;
    return sum < 0;
  };

  const maskOf = (i: number, j: number, k: number) => {
    let mask = 0;
    for (let c = 0; c < 8; c++) if (inside(corner(i, j, k, c))) mask |= 1 << c;
    return mask;
  };
  /** Grid-wide id of cube face `face` of cell (i, j, k): its lowest corner sample and axis. */
  const faceKey = (i: number, j: number, k: number, face: number) => {
    const axis = face >> 1;
    const high = face & 1;
    return (
      sample(
        i + (axis === 0 ? high : 0),
        j + (axis === 1 ? high : 0),
        k + (axis === 2 ? high : 0),
      ) *
        3 +
      axis
    );
  };
  /**
   * Ambiguous faces (four crossings) whose default pairing is reversed. Both cells of a
   * face read the same entry, so they always agree.
   */
  const flipped = new Set<number>();
  /**
   * Surface sheets of a cell: the crossed edges and, per crossed edge, the smallest edge
   * of its sheet (one vertex each). Each cube face pairs its crossings; an ambiguous
   * face pairs them by its center value unless the face is `flipped`. `doubled` lists
   * the ambiguous faces whose two segments belong to one sheet.
   */
  const sheets = (i: number, j: number, k: number, mask: number) => {
    const crossed = CUBE_EDGES.map(([a, b]) => ((mask >> a) & 1) !== ((mask >> b) & 1));
    const parent = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const find = (x: number): number => {
      while ((parent[x] as number) !== x) x = parent[x] as number;
      return x;
    };
    const join = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    const ambiguous: number[] = [];
    for (const [index, face] of CUBE_FACES.entries()) {
      const e = face.edges;
      const hits = e.filter((x) => crossed[x] === true);
      if (hits.length === 2) join(hits[0] as number, hits[1] as number);
      else if (hits.length === 4) {
        ambiguous.push(index);
        const samples = face.corners.map((c) => corner(i, j, k, c));
        const q0Inside = ((mask >> (face.corners[0] as number)) & 1) === 1;
        const pairFirst = faceCenterInside(samples) === q0Inside;
        if (pairFirst !== flipped.has(faceKey(i, j, k, index))) {
          join(e[0] as number, e[1] as number);
          join(e[2] as number, e[3] as number);
        } else {
          join(e[3] as number, e[0] as number);
          join(e[1] as number, e[2] as number);
        }
      }
    }
    const root = CUBE_EDGES.map((_, x) => (crossed[x] ? find(x) : -1));
    const doubled = ambiguous.filter((index) => {
      const e = (CUBE_FACES[index] as (typeof CUBE_FACES)[number]).edges;
      return root[e[0] as number] === root[e[2] as number];
    });
    return { crossed, root, doubled };
  };
  /** The cell on the other side of cube face `face`, or undefined at the grid boundary. */
  const across = (i: number, j: number, k: number, face: number) => {
    const step = (face & 1) === 1 ? 1 : -1;
    const at = [i, j, k];
    at[face >> 1] = (at[face >> 1] as number) + step;
    const [a, b, c] = at as [number, number, number];
    if (a < 0 || b < 0 || c < 0 || a + 1 >= nx || b + 1 >= ny || c + 1 >= nz) return undefined;
    return { at: [a, b, c] as const, face: face ^ 1 };
  };
  // A face whose two segments join one sheet on both sides would give the two cell
  // vertices four quads (a non-manifold edge): a tunnel one voxel wide. Reversing its
  // pairing splits both sheets and joins none, so one pass in face order resolves all.
  const conflicts: number[] = [];
  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const mask = maskOf(i, j, k);
        if (!(AMBIGUOUS[mask] as boolean)) continue;
        for (const face of sheets(i, j, k, mask).doubled) {
          if ((face & 1) === 0) continue;
          const other = across(i, j, k, face);
          if (other === undefined) continue;
          const [a, b, c] = other.at;
          if (sheets(a, b, c, maskOf(a, b, c)).doubled.includes(other.face)) {
            conflicts.push(faceKey(i, j, k, face), i, j, k, face);
          }
        }
      }
    }
  }
  for (let q = 0; q < conflicts.length; q += 5) {
    const [key, i, j, k, face] = conflicts.slice(q, q + 5) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const other = across(i, j, k, face) as NonNullable<ReturnType<typeof across>>;
    const [a, b, c] = other.at;
    if (
      sheets(i, j, k, maskOf(i, j, k)).doubled.includes(face) &&
      sheets(a, b, c, maskOf(a, b, c)).doubled.includes(other.face)
    ) {
      flipped.add(key);
    }
  }

  const out = new EditMesh();
  const cellVertex = new Map<number, Int32Array>();
  const cellOf: number[] = [];
  const featureVertex: boolean[] = [];
  let features = 0;
  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const mask = maskOf(i, j, k);
        if (mask === 0 || mask === 255) continue;
        const { crossed, root: rootOf } = sheets(i, j, k, mask);
        const ids = new Int32Array(12).fill(-1);
        const cell = sample(i, j, k);
        for (let root = 0; root < 12; root++) {
          if (!crossed[root] || rootOf[root] !== root) continue;
          const members: number[] = [];
          for (let x = 0; x < 12; x++) if (crossed[x] && rootOf[x] === root) members.push(x);
          const points: Tuple3[] = [];
          const normals: Tuple3[] = [];
          for (const x of members) {
            const [ca, cb] = CUBE_EDGES[x] as readonly [number, number];
            const sa = corner(i, j, k, ca);
            const sb = corner(i, j, k, cb);
            const fa = f[sa] as number;
            const fb = f[sb] as number;
            const t = fa / (fa - fb);
            const pa = position(sa);
            const pb = position(sb);
            const crossing: Tuple3 = [
              pa[0] + (pb[0] - pa[0]) * t,
              pa[1] + (pb[1] - pa[1]) * t,
              pa[2] + (pb[2] - pa[2]) * t,
            ];
            if (options.sharp) {
              const candidates =
                options.hermite === undefined
                  ? []
                  : fa < 0
                    ? options.hermite(pa, pb)
                    : options.hermite(pb, pa);
              let hermite: { readonly point: Tuple3; readonly normal: Tuple3 } | undefined;
              let level = h / 2;
              for (const c of candidates) {
                const off = Math.abs(sampleSdf(levels, c.point));
                if (off <= level) {
                  level = off;
                  hermite = c;
                }
              }
              if (hermite !== undefined) {
                points.push(hermite.point);
                normals.push(hermite.normal);
                continue;
              }
              const ga = gradient(sa);
              const gb = gradient(sb);
              const g: Tuple3 = [
                ga[0] + (gb[0] - ga[0]) * t,
                ga[1] + (gb[1] - ga[1]) * t,
                ga[2] + (gb[2] - ga[2]) * t,
              ];
              const len = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
              if (len > 0) normals.push([g[0] / len, g[1] / len, g[2] / len]);
            }
            points.push(crossing);
          }
          const mean: Tuple3 = [0, 0, 0];
          for (const p of points) for (const d of AXES) mean[d] += p[d] / points.length;
          let p = mean;
          let feature = false;
          if (options.sharp && normals.length === points.length) {
            const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            const b = [0, 0, 0];
            for (let q = 0; q < normals.length; q++) {
              const n = normals[q] as Tuple3;
              const r = points[q] as Tuple3;
              const offset =
                n[0] * (r[0] - mean[0]) + n[1] * (r[1] - mean[1]) + n[2] * (r[2] - mean[2]);
              for (const x of AXES) {
                b[x] = (b[x] as number) + n[x] * offset;
                for (const y of AXES) a[x * 3 + y] = (a[x * 3 + y] as number) + n[x] * n[y];
              }
            }
            const solved = solveSymmetric(3, a, b, 0.1);
            const lo = position(cell);
            const x = AXES.map((d) => mean[d] + (solved.x[d] as number)) as Tuple3;
            // A minimizer outside its cell belongs to a neighbour's feature; clamping it
            // could stack two cell vertices on one cell face, so take the mass point.
            if (AXES.every((d) => x[d] >= lo[d] && x[d] <= lo[d] + h)) {
              p = x;
              feature = solved.rank >= 2;
            }
          }
          const v = out.addVertex(p[0], p[1], p[2]);
          cellOf[v] = cell;
          featureVertex[v] = feature;
          if (feature) features++;
          for (const x of members) ids[x] = v;
        }
        cellVertex.set(cell, ids);
      }
    }
    if (!work.spend(nx * ny)) return err(work.failure as ModelingError);
  }

  const source: number[] = [];
  /** Cosine-free facing test: the triangle's area vector along the outward axis direction. */
  const facing = (x: number, y: number, z: number, axis: number, sign: number) => {
    const p = out.position(x);
    const q = out.position(y);
    const r = out.position(z);
    const u: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const w: Tuple3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n: Tuple3 = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    return sign * (n[axis] as number);
  };
  /**
   * One face per crossed grid edge, oriented outward along `axis`. Sharp placement can
   * twist a quad across a feature; it then splits along the diagonal whose triangles
   * both face outward (the better one when neither does).
   */
  const quad = (
    a: number,
    b: number,
    axis: number,
    cells: readonly (readonly [number, number])[],
  ) => {
    const loop = cells.map(([cell, edge]) => (cellVertex.get(cell) as Int32Array)[edge] as number);
    const sign = inside(a) ? 1 : -1;
    if (sign < 0) loop.reverse();
    const [v0, v1, v2, v3] = loop as [number, number, number, number];
    const first = Math.min(facing(v0, v1, v2, axis, sign), facing(v0, v2, v3, axis, sign));
    const second = Math.min(facing(v1, v2, v3, axis, sign), facing(v1, v3, v0, axis, sign));
    const loops =
      first > 0 && second > 0
        ? [loop]
        : first >= second
          ? [
              [v0, v1, v2],
              [v0, v2, v3],
            ]
          : [
              [v1, v2, v3],
              [v1, v3, v0],
            ];
    const na = grid.nearest[a] as number;
    const nb = grid.nearest[b] as number;
    const nearer = Math.abs(f[a] as number) <= Math.abs(f[b] as number) ? [na, nb] : [nb, na];
    const from = (nearer[0] as number) >= 0 ? (nearer[0] as number) : (nearer[1] as number);
    for (const l of loops) {
      const added = out.addFace(l);
      if (!added.ok) return added;
      source[added.value] = from;
    }
    return ok(loops.length);
  };
  for (let k = 1; k + 1 < nz; k++) {
    for (let j = 1; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const a = sample(i, j, k);
        const b = sample(i + 1, j, k);
        if (inside(a) === inside(b)) continue;
        const r = quad(a, b, 0, [
          [sample(i, j - 1, k - 1), 3],
          [sample(i, j, k - 1), 2],
          [sample(i, j, k), 0],
          [sample(i, j - 1, k), 1],
        ]);
        if (!r.ok) return r;
      }
    }
  }
  for (let k = 1; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 1; i + 1 < nx; i++) {
        const a = sample(i, j, k);
        const b = sample(i, j + 1, k);
        if (inside(a) === inside(b)) continue;
        const r = quad(a, b, 1, [
          [sample(i - 1, j, k - 1), 7],
          [sample(i - 1, j, k), 5],
          [sample(i, j, k), 4],
          [sample(i, j, k - 1), 6],
        ]);
        if (!r.ok) return r;
      }
    }
  }
  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 1; j + 1 < ny; j++) {
      for (let i = 1; i + 1 < nx; i++) {
        const a = sample(i, j, k);
        const b = sample(i, j, k + 1);
        if (inside(a) === inside(b)) continue;
        const r = quad(a, b, 2, [
          [sample(i - 1, j - 1, k), 11],
          [sample(i, j - 1, k), 10],
          [sample(i, j, k), 8],
          [sample(i - 1, j, k), 9],
        ]);
        if (!r.ok) return r;
      }
    }
  }
  if (!work.spend(out.faceCount)) return err(work.failure as ModelingError);

  if (options.smooth > 0) {
    const vertices = out.vertices();
    const neighbours: number[][] = vertices.map(() => []);
    for (const e of out.edges()) {
      const [a, b] = out.edgeVertices(e);
      (neighbours[a] as number[]).push(b);
      (neighbours[b] as number[]).push(a);
    }
    const field: SdfData = { ...grid, values: f };
    for (let sweep = 0; sweep < options.smooth; sweep++) {
      const next = vertices.map((v) => {
        const p = out.position(v);
        const list = neighbours[v] as number[];
        if (featureVertex[v] === true || list.length === 0) return p;
        const q: Tuple3 = [0, 0, 0];
        for (const n of list) {
          const r = out.position(n);
          for (const d of AXES) q[d] += r[d] / list.length;
        }
        const value = sampleSdf(field, q);
        const g: Tuple3 = AXES.map((d) => {
          const e: Tuple3 = [q[0], q[1], q[2]];
          const step = h / 2;
          e[d] += step;
          const up = sampleSdf(field, e);
          e[d] -= 2 * step;
          return (up - sampleSdf(field, e)) / (2 * step);
        }) as Tuple3;
        const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
        if (g2 > 0) for (const d of AXES) q[d] -= (value * g[d]) / g2;
        const lo = position(cellOf[v] as number);
        return AXES.map((d) =>
          q[d] < lo[d] ? lo[d] : q[d] > lo[d] + h ? lo[d] + h : q[d],
        ) as Tuple3;
      });
      for (const [index, v] of vertices.entries()) {
        const p = next[index] as Tuple3;
        out.setPosition(v, p[0], p[1], p[2]);
      }
      if (!work.spend(vertices.length * 8)) return err(work.failure as ModelingError);
    }
  }
  return ok({ mesh: out, source: Int32Array.from(source), features });
}

// ---- job ---------------------------------------------------------------------------------------

/** Crossings of a grid edge with nearby source triangles facing along it (Hermite candidates). */
function hermiteOf(
  mesh: EditMesh,
  faces: readonly number[],
  h: number,
  work: WorkMeter,
): NonNullable<SurfaceOptions['hermite']> {
  const soup = soupOf(mesh, faces);
  const grid = new PrimitiveGrid(soup.points, soup.corners);
  const corner = (t: number, k: number): Tuple3 => {
    const v = soup.corners[t * 3 + k] as number;
    return [
      soup.points[v * 3] as number,
      soup.points[v * 3 + 1] as number,
      soup.points[v * 3 + 2] as number,
    ];
  };
  return (a, b) => {
    const mid: Tuple3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const candidates = grid.near(mid, h);
    work.spend(candidates.length + 1);
    const out: { point: Tuple3; normal: Tuple3 }[] = [];
    for (const t of candidates) {
      const p = corner(t, 0);
      const q = corner(t, 1);
      const r = corner(t, 2);
      const along = segmentTriangle(a, b, p, q, r);
      if (along === undefined) continue;
      const e1: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const e2: Tuple3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const n: Tuple3 = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      if (!(l > 0) || n[0] * (b[0] - a[0]) + n[1] * (b[1] - a[1]) + n[2] * (b[2] - a[2]) <= 0)
        continue;
      out.push({
        point: [
          a[0] + (b[0] - a[0]) * along,
          a[1] + (b[1] - a[1]) * along,
          a[2] + (b[2] - a[2]) * along,
        ],
        normal: [n[0] / l, n[1] / l, n[2] / l],
      });
    }
    return out;
  };
}

function closedVolume(mesh: EditMesh): number {
  const corners: number[] = [];
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    for (let i = 1; i + 1 < vs.length; i++)
      corners.push(vs[0] as number, vs[i] as number, vs[i + 1] as number);
  }
  return soupVolume(mesh.pos, Int32Array.from(corners));
}

/** Output FXEM of a surface and its provenance in FXEM face order. */
function surfaceOutput(
  surface: Surface,
  sourceFaces: number,
): { bytes: Uint8Array; provenance: SourceFaceProvenance } {
  const { faceMap } = surface.mesh.compact();
  const face = new Int32Array(surface.mesh.faceCount).fill(-1);
  for (const f of surface.mesh.faces()) {
    const s = surface.source[f] as number;
    face[faceMap[f] as number] = s >= 0 && s < sourceFaces ? s : -1;
  }
  return { bytes: encodeSnapshot(surface.mesh), provenance: { face } };
}

export function runVoxelJob(
  request: ComputeJobRequest<'voxel'>,
  work: WorkMeter,
): Result<BackendOutput<'voxel'>, ModelingError> {
  const p = request.params;
  const surfaceOptions: SurfaceOptions = {
    iso: p.iso ?? 0,
    smooth: p.smooth ?? 0,
    sharp: p.sharp ?? false,
  };
  if (p.operation === 'mesh') {
    const grid = decodeSdf(request.inputs[0] ?? new Uint8Array());
    if (!grid.ok) return grid;
    let hermite: SurfaceOptions['hermite'];
    const sourceBytes = request.inputs[1];
    if (sourceBytes !== undefined && surfaceOptions.sharp && surfaceOptions.iso === 0) {
      const source = decodeSnapshot(sourceBytes);
      if (!source.ok) return source;
      hermite = hermiteOf(source.value, source.value.faces(), grid.value.voxelSize, work);
    }
    const surface = surfaceNets(
      grid.value,
      hermite === undefined ? surfaceOptions : { ...surfaceOptions, hermite },
      work,
    );
    if (!surface.ok) return surface;
    let sources = 0;
    for (const s of grid.value.nearest) if (s + 1 > sources) sources = s + 1;
    const out = surfaceOutput(surface.value, sources);
    return ok({
      status: 'ok',
      outputs: [out.bytes],
      provenance: [out.provenance],
      metrics: {
        samples: grid.value.values.length,
        faces: surface.value.mesh.faceCount,
        vertices: surface.value.mesh.vertexCount,
        features: surface.value.features,
        volume: closedVolume(surface.value.mesh),
      },
      locations: [],
    });
  }
  const decoded = decodeSnapshot(request.inputs[0] ?? new Uint8Array());
  if (!decoded.ok) return decoded;
  const mesh = decoded.value;
  const faces = p.faces === 'all' ? mesh.faces() : [...p.faces];
  const margin =
    p.operation === 'union'
      ? (p.radius ?? 0)
      : p.operation === 'offset'
        ? Math.max(0, p.distance ?? 0)
        : 0;
  const field = buildField(
    mesh,
    {
      faces,
      voxelSize: p.voxelSize,
      band: p.band,
      sign: p.sign,
      union: p.operation === 'union',
      radius: p.operation === 'union' ? (p.radius ?? 0) : 0,
      margin: margin + Math.max(0, surfaceOptions.iso),
    },
    work,
  );
  if (!field.ok) return field;
  let inside = 0;
  for (const v of field.value.values) if (v < 0) inside++;
  const metrics: Record<string, number> = {
    samples: field.value.values.length,
    insideSamples: inside,
    parts: field.value.parts,
    dimX: field.value.dims[0],
    dimY: field.value.dims[1],
    dimZ: field.value.dims[2],
  };
  if (p.operation === 'sdf') {
    return ok({
      status: 'ok',
      outputs: [encodeSdf(field.value)],
      provenance: [],
      metrics,
      locations: [],
    });
  }
  const iso = surfaceOptions.iso + (p.operation === 'offset' ? (p.distance ?? 0) : 0);
  const surface = surfaceNets(
    field.value,
    {
      ...surfaceOptions,
      iso,
      ...(surfaceOptions.sharp && iso === 0
        ? { hermite: hermiteOf(mesh, faces, p.voxelSize, work) }
        : {}),
    },
    work,
  );
  if (!surface.ok) return surface;
  const out = surfaceOutput(surface.value, mesh.faceCount);
  return ok({
    status: 'ok',
    outputs: [out.bytes],
    provenance: [out.provenance],
    metrics: {
      ...metrics,
      faces: surface.value.mesh.faceCount,
      vertices: surface.value.mesh.vertexCount,
      features: surface.value.features,
      volume: closedVolume(surface.value.mesh),
    },
    locations: [],
  });
}
