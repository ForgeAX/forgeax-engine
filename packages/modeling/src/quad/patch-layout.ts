import { ok, type Result } from '@forgeax/engine-types';
import { cos } from '../dmath';
import type { ModelingError } from '../errors';
import { crossField } from './cross-field';
import type { CrossField } from './field';
import type { TriMesh } from './trimesh';

/**
 * Feature-bounded patch layout (M6). The cut network is the feature graph (dihedral above the threshold),
 * optional separatrices traced along a cross field from its singularities, and the dangling-end paths that
 * connect unfinished feature ends. Patches are the connected triangle components left after the cuts; tiny
 * patches are merged into their neighbour across non-feature cuts. Corners of a patch are boundary vertices
 * that are singular or whose cut degree is not two.
 */
export interface PatchLayout {
  /** Patch id per triangle, dense from 0. */
  readonly patchOf: Uint32Array;
  readonly patchCount: number;
  /** Undirected feature edges as vertex pairs, lower index first. */
  readonly featureEdges: readonly (readonly [number, number])[];
  /** Feature-graph vertices with degree other than two. */
  readonly corners: readonly number[];
  /** Fraction of feature edges that separate two patches (or touch a boundary). */
  readonly featureCoverage: number;
  /** Corner count per patch (see module comment). */
  readonly patchCorners: readonly number[];
  /** Patches whose corner count is not four: the layout-quality metric. */
  readonly patchesNotFour: number;
  /** Every cut edge (features, separatrices and dangling paths) as vertex pairs. */
  readonly cutEdges: readonly (readonly [number, number])[];
  /** Separatrix edges added by tracing (0 without a field). */
  readonly separatrixEdges: number;
  /** Singularities of the cross field (0 without a field). */
  readonly singularities: number;
}

export interface PatchOptions {
  /** Feature threshold in degrees (default 30). */
  readonly sharpDegrees?: number;
  /** Merge patches with fewer triangles than this into a neighbour (default 0 = off). */
  readonly minPatchTriangles?: number;
}

/** cos(30 degrees); a feature edge has adjacent-normal dot below this. */

interface Core {
  readonly edgeTris: Map<number, number[]>;
  readonly vcount: number;
  readonly ekey: (a: number, b: number) => number;
}

function triangleNormals(mesh: TriMesh): Float64Array {
  const p = mesh.positions;
  const t = mesh.triangles;
  const triCount = t.length / 3;
  const normals = new Float64Array(triCount * 3);
  for (let f = 0; f < triCount; f++) {
    const a = t[3 * f] as number;
    const b = t[3 * f + 1] as number;
    const c = t[3 * f + 2] as number;
    const ux = (p[3 * b] as number) - (p[3 * a] as number);
    const uy = (p[3 * b + 1] as number) - (p[3 * a + 1] as number);
    const uz = (p[3 * b + 2] as number) - (p[3 * a + 2] as number);
    const vx = (p[3 * c] as number) - (p[3 * a] as number);
    const vy = (p[3 * c + 1] as number) - (p[3 * a + 1] as number);
    const vz = (p[3 * c + 2] as number) - (p[3 * a + 2] as number);
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[3 * f] = nx / len;
    normals[3 * f + 1] = ny / len;
    normals[3 * f + 2] = nz / len;
  }
  return normals;
}

function buildCore(mesh: TriMesh): Core {
  const vcount = mesh.positions.length / 3;
  const ekey = (a: number, b: number): number => Math.min(a, b) * vcount + Math.max(a, b);
  const edgeTris = new Map<number, number[]>();
  const t = mesh.triangles;
  for (let f = 0; f < t.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const key = ekey(t[3 * f + k] as number, t[3 * f + ((k + 1) % 3)] as number);
      const list = edgeTris.get(key);
      if (list) list.push(f);
      else edgeTris.set(key, [f]);
    }
  }
  return { edgeTris, vcount, ekey };
}

/** Labels triangle components across uncut edges. */
function label(
  mesh: TriMesh,
  core: Core,
  cut: Set<number>,
): { patchOf: Uint32Array; count: number } {
  const t = mesh.triangles;
  const triCount = t.length / 3;
  const patchOf = new Uint32Array(triCount).fill(0xffffffff);
  let count = 0;
  for (let seed = 0; seed < triCount; seed++) {
    if (patchOf[seed] !== 0xffffffff) continue;
    const id = count++;
    const stack = [seed];
    patchOf[seed] = id;
    while (stack.length > 0) {
      const f = stack.pop() as number;
      for (let k = 0; k < 3; k++) {
        const key = core.ekey(t[3 * f + k] as number, t[3 * f + ((k + 1) % 3)] as number);
        if (cut.has(key)) continue;
        for (const g of core.edgeTris.get(key) ?? []) {
          if (patchOf[g] === 0xffffffff) {
            patchOf[g] = id;
            stack.push(g);
          }
        }
      }
    }
  }
  return { patchOf, count };
}

/** Merges each patch smaller than `min` into the neighbour it shares the most non-feature cut edges with. */
function mergeTiny(
  mesh: TriMesh,
  core: Core,
  cut: Set<number>,
  features: Set<number>,
  min: number,
): void {
  const t = mesh.triangles;
  for (let pass = 0; pass < 4; pass++) {
    const { patchOf, count } = label(mesh, core, cut);
    const size = new Array<number>(count).fill(0);
    for (const id of patchOf) size[id] = (size[id] ?? 0) + 1;
    let changed = false;
    for (let id = 0; id < count; id++) {
      if ((size[id] ?? 0) >= min) continue;
      // Shared non-feature cut edges per neighbouring patch.
      const shared = new Map<number, { count: number; keys: number[] }>();
      for (let f = 0; f < patchOf.length; f++) {
        if (patchOf[f] !== id) continue;
        for (let k = 0; k < 3; k++) {
          const key = core.ekey(t[3 * f + k] as number, t[3 * f + ((k + 1) % 3)] as number);
          if (features.has(key)) continue;
          for (const g of core.edgeTris.get(key) ?? []) {
            const other = patchOf[g] as number;
            if (other === id) continue;
            const entry = shared.get(other) ?? { count: 0, keys: [] };
            entry.count++;
            entry.keys.push(key);
            shared.set(other, entry);
          }
        }
      }
      let best: { count: number; keys: number[] } | undefined;
      for (const entry of shared.values()) if (!best || entry.count > best.count) best = entry;
      if (!best) continue;
      for (const key of best.keys) cut.delete(key);
      changed = true;
      break;
    }
    if (!changed) return;
  }
}

function at3(p: Float64Array, v: number): [number, number, number] {
  return [p[3 * v] as number, p[3 * v + 1] as number, p[3 * v + 2] as number];
}

/**
 * Field-aligned separatrices. From each singular vertex, for each field rotation whose direction points away from
 * it, walk face to face: the next edge is the one the field direction crosses (the exit edge with the largest
 * signed component along the direction), the direction is re-snapped to the nearest rotation in the new face, and
 * the walk ends on another singularity (committed), a feature edge, an existing cut, or a revisited vertex
 * (dead end, nothing committed). Only singularity-to-singularity or feature-terminated paths are returned.
 */
function traceSeparatrices(
  mesh: TriMesh,
  core: Core,
  field: CrossField,
  features: Set<number>,
  singular: Set<number>,
  cutSoFar: ReadonlySet<number>,
): number[] {
  const t = mesh.triangles;
  const p = mesh.positions;
  const triCount = t.length / 3;
  const normals = field.normal;
  const dirs = field.direction;
  const faceIncident = new Map<number, number[]>();
  for (let f = 0; f < triCount; f++) {
    for (let k = 0; k < 3; k++) {
      const v = t[3 * f + k] as number;
      const list = faceIncident.get(v);
      if (list) list.push(f);
      else faceIncident.set(v, [f]);
    }
  }
  const cross = (u: number[], v: number[]): number[] => {
    const [u0 = 0, u1 = 0, u2 = 0] = u;
    const [v0 = 0, v1 = 0, v2 = 0] = v;
    return [u1 * v2 - u2 * v1, u2 * v0 - u0 * v2, u0 * v1 - u1 * v0];
  };
  const dot = (u: number[], v: number[]): number => {
    const [u0 = 0, u1 = 0, u2 = 0] = u;
    const [v0 = 0, v1 = 0, v2 = 0] = v;
    return u0 * v0 + u1 * v1 + u2 * v2;
  };
  const rotations = (f: number): number[][] => {
    const q = [dirs[3 * f] as number, dirs[3 * f + 1] as number, dirs[3 * f + 2] as number];
    const n = [
      normals[3 * f] as number,
      normals[3 * f + 1] as number,
      normals[3 * f + 2] as number,
    ];
    const nq = cross(n, q);
    return [q, nq, q.map((x) => -x), nq.map((x) => -x)];
  };
  const snapTo = (f: number, d: number[]): number[] => {
    let best = rotations(f)[0] ?? d;
    let score = -Infinity;
    for (const r of rotations(f)) {
      const sc = dot(r, d);
      if (sc > score) {
        score = sc;
        best = r;
      }
    }
    return best;
  };
  const cut = new Set<number>(cutSoFar);
  const added: number[] = [];
  const stepLimit = 4 * triCount + 8;
  const usedStart = new Set<number>();
  for (const s of singular) {
    const ps = at3(p, s);
    for (const f0 of faceIncident.get(s) ?? []) {
      for (const r0 of rotations(f0)) {
        // Only rotations pointing away from the singular vertex.
        const a = t[3 * f0] as number;
        const b = t[3 * f0 + 1] as number;
        const c = t[3 * f0 + 2] as number;
        const centre = [0, 1, 2].map(
          (i) =>
            ((p[3 * a + i] as number) + (p[3 * b + i] as number) + (p[3 * c + i] as number)) / 3 -
            (ps[i] as number),
        );
        if (dot(r0, centre) <= 0) continue;
        let d = r0;
        let face = f0;
        let P: number[] = [...ps];
        let from = s;
        const path: number[] = [];
        const visited = new Set<number>([s]);
        let reached = false;
        for (let step = 0; step < stepLimit; step++) {
          // Segment-triangle crossing: the ray P + t*d leaves this face through the edge whose endpoints lie on
          // opposite sides of the ray (in the face plane) and whose crossing lies ahead of P.
          const nrm = [
            normals[3 * face] as number,
            normals[3 * face + 1] as number,
            normals[3 * face + 2] as number,
          ];
          const vs = [0, 1, 2].map((k) => t[3 * face + k] as number);
          const side = vs.map((w) => {
            const x = [0, 1, 2].map((i) => (p[3 * w + i] as number) - (P[i] ?? 0));
            return dot(cross(d, x), nrm);
          });
          let exitEdge = -1;
          for (let k = 0; k < 3; k++) {
            const a = vs[k] as number;
            const b = vs[(k + 1) % 3] as number;
            const sa = side[k] as number;
            const sb = side[(k + 1) % 3] as number;
            if (a === from || b === from) continue;
            // Zero side counts as positive so a ray running along a triangle edge still exits through a neighbour.
            const pa = sa >= 0 ? 1 : -1;
            const pb = sb >= 0 ? 1 : -1;
            if (pa === pb) continue;
            exitEdge = core.ekey(a, b);
            break;
          }
          if (exitEdge < 0) break;
          const [ea, eb] = [
            Math.floor(exitEdge / core.vcount),
            exitEdge - Math.floor(exitEdge / core.vcount) * core.vcount,
          ];
          if (cut.has(exitEdge)) break;
          path.push(exitEdge);
          const landed = singular.has(ea) ? ea : singular.has(eb) ? eb : -1;
          if (landed >= 0 || features.has(exitEdge)) {
            reached = true;
            break;
          }
          const next = (core.edgeTris.get(exitEdge) ?? []).find((g) => g !== face);
          if (next === undefined) break;
          const far = visited.has(ea) ? eb : ea;
          if (visited.has(far)) break;
          visited.add(far);
          // Advance the point to the middle of the crossed edge and snap the direction into the new face.
          P = [0, 1, 2].map(
            (i) => (((p[3 * ea + i] as number) + (p[3 * eb + i] as number)) / 2) as number,
          );
          d = snapTo(next, d);
          from = far === ea ? eb : ea;
          face = next;
        }
        if (!reached) continue;
        const first = path[0] as number;
        if (usedStart.has(first)) continue;
        usedStart.add(first);
        for (const key of path) {
          cut.add(key);
          added.push(key);
        }
      }
    }
  }
  return [...new Set(added)];
}

function layoutCore(
  mesh: TriMesh,
  options: PatchOptions,
  extra: (features: Set<number>, core: Core, cut: ReadonlySet<number>) => number[],
): {
  layout: Omit<PatchLayout, 'singularities' | 'separatrixEdges'>;
  sepCount: number;
  core: Core;
} {
  const threshold = cos(((options.sharpDegrees ?? 30) * Math.PI) / 180);
  const core = buildCore(mesh);
  const normals = triangleNormals(mesh);
  const cut = new Set<number>();
  const features = new Set<number>();
  const featureEdges: [number, number][] = [];
  const featureDegree = new Map<number, number>();
  for (const [key, tris] of core.edgeTris) {
    if (tris.length !== 2) continue;
    const [f, g] = tris as [number, number];
    const dot =
      (normals[3 * f] as number) * (normals[3 * g] as number) +
      (normals[3 * f + 1] as number) * (normals[3 * g + 1] as number) +
      (normals[3 * f + 2] as number) * (normals[3 * g + 2] as number);
    if (dot >= threshold) continue;
    cut.add(key);
    features.add(key);
    const a = Math.floor(key / core.vcount);
    const b = key - a * core.vcount;
    featureEdges.push([a, b]);
    featureDegree.set(a, (featureDegree.get(a) ?? 0) + 1);
    featureDegree.set(b, (featureDegree.get(b) ?? 0) + 1);
  }
  featureEdges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const corners = [...featureDegree.entries()]
    .filter(([, d]) => d !== 2)
    .map(([v]) => v)
    .sort((x, y) => x - y);

  const sep = extra(features, core, cut);
  for (const key of sep) cut.add(key);
  const sepCount = sep.length;

  // Dangling feature ends (degree 1) do not separate patches: extend each by a shortest vertex path to the cut network.
  const vertexNeighbours = new Map<number, number[]>();
  for (const key of core.edgeTris.keys()) {
    const a = Math.floor(key / core.vcount);
    const b = key - a * core.vcount;
    (vertexNeighbours.get(a) ?? vertexNeighbours.set(a, []).get(a))?.push(b);
    (vertexNeighbours.get(b) ?? vertexNeighbours.set(b, []).get(b))?.push(a);
  }
  const cutVertices = new Set<number>();
  for (const key of cut) {
    cutVertices.add(Math.floor(key / core.vcount));
    cutVertices.add(key - Math.floor(key / core.vcount) * core.vcount);
  }
  for (const [v, d] of featureDegree) {
    if (d !== 1) continue;
    const parent = new Map<number, number>([[v, v]]);
    const queue = [v];
    let hit = -1;
    for (let head = 0; head < queue.length && hit < 0; head++) {
      const u = queue[head] as number;
      for (const w of vertexNeighbours.get(u) ?? []) {
        if (parent.has(w)) continue;
        parent.set(w, u);
        if (cutVertices.has(w) && w !== v) {
          hit = w;
          break;
        }
        queue.push(w);
      }
    }
    if (hit < 0) continue;
    for (let u = hit; u !== v; u = parent.get(u) as number) {
      const pu = parent.get(u) as number;
      const key = core.ekey(u, pu);
      cut.add(key);
      cutVertices.add(u);
      cutVertices.add(pu);
    }
  }

  if ((options.minPatchTriangles ?? 0) > 0) {
    mergeTiny(mesh, core, cut, features, options.minPatchTriangles as number);
  }

  const { patchOf, count } = label(mesh, core, cut);

  // Coverage gate: every feature edge must separate two different patches (or touch a boundary).
  let covered = 0;
  for (const [a, b] of featureEdges) {
    const tris = core.edgeTris.get(core.ekey(a, b)) ?? [];
    const ids = new Set(tris.map((f) => patchOf[f]));
    if (ids.size > 1 || tris.length !== 2) covered++;
  }
  const featureCoverage = featureEdges.length === 0 ? 1 : covered / featureEdges.length;

  // Corner metric per patch.
  const cutDegree = new Map<number, number>();
  for (const key of cut) {
    const a = Math.floor(key / core.vcount);
    const b = key - a * core.vcount;
    cutDegree.set(a, (cutDegree.get(a) ?? 0) + 1);
    cutDegree.set(b, (cutDegree.get(b) ?? 0) + 1);
  }
  const t = mesh.triangles;
  const patchVerts: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (let f = 0; f < t.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const v = t[3 * f + k] as number;
      // A vertex lies on this patch boundary when one of its cut edges is adjacent to the patch.
      const id = patchOf[f] as number;
      patchVerts[id]?.add(v);
    }
  }
  const patchCorners: number[] = [];
  for (let id = 0; id < count; id++) {
    let c = 0;
    for (const v of patchVerts[id] ?? []) {
      const onBoundary = [...(vertexNeighbours.get(v) ?? [])].some((w) => {
        const key = core.ekey(v, w);
        if (!cut.has(key)) return false;
        return (core.edgeTris.get(key) ?? []).some((g) => patchOf[g] === id);
      });
      if (!onBoundary) continue;
      if ((cutDegree.get(v) ?? 0) !== 2) c++;
    }
    patchCorners.push(c);
  }
  const patchesNotFour = patchCorners.filter((c) => c !== 4).length;

  return {
    layout: {
      patchOf,
      patchCount: count,
      featureEdges,
      corners,
      featureCoverage,
      patchCorners,
      patchesNotFour,
      cutEdges: [...cut].map((key): [number, number] => {
        const a = Math.floor(key / core.vcount);
        return [a, key - a * core.vcount];
      }),
    },
    sepCount,
    core,
  };
}

/** Feature-only layout (M6 skeleton, no field). */
export function layoutPatches(mesh: TriMesh, options: PatchOptions = {}): PatchLayout {
  const { layout } = layoutCore(mesh, options, () => []);
  return { ...layout, separatrixEdges: 0, singularities: 0 };
}

/** Field-driven layout: cross-field singularities, separatrices traced along the field, tiny patches merged. */
export function layoutPatchesAlongField(
  input: TriMesh,
  options: PatchOptions = {},
): Result<PatchLayout, ModelingError> {
  const cf = crossField(input, { sharpDegrees: options.sharpDegrees ?? 30 });
  if (!cf.ok) return cf;
  const field = cf.value.field;
  const mesh = field.mesh;
  const singularVertices = new Set<number>();
  for (const s of field.singularities) if (s.index !== 0) singularVertices.add(s.at);
  let sepCount = 0;
  const { layout } = layoutCore(mesh, options, (features, core, cut) => {
    const edges = traceSeparatrices(mesh, core, field, features, singularVertices, cut);
    sepCount = edges.length;
    return edges;
  });
  return ok({ ...layout, separatrixEdges: sepCount, singularities: singularVertices.size });
}
