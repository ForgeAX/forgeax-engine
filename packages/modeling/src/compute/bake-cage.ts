import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { cross, dot, length, newell, normalize, sub, type Tuple3 } from '../geom';
import { type EditMesh, NONE } from '../mesh';
import { TriangleBvh } from './bvh';
import type { BakeCage, BakeDirection, BakeJobParams } from './job';

/**
 * Bake groups, cage and ray direction fields. A group is a set of faces
 * tagged `<prefix><id>` on both meshes; correspondence never leaves its group. The direction field gives each base sample its ray: averaged normals
 * welded by position inside the group (smooth cage), the exported shading normals, the
 * face normals, or a blend from averaged at hard edges to face normals away from them.
 */

/** Group of every face of a mesh (index into `ids`), or an error for two group tags on one face. */
export interface FaceGroups {
  readonly ids: readonly string[];
  /** Per FXEM face id: group index, NONE for dead faces. */
  readonly face: Int32Array;
}

export function faceGroups(
  mesh: EditMesh,
  prefix: string | undefined,
  input: 'base' | 'detail',
): Result<FaceGroups, ModelingError> {
  const face = new Int32Array(mesh.faceHighWater).fill(NONE);
  const tags: { tag: number; id: string }[] = [];
  if (prefix !== undefined) {
    for (const [tag, name] of mesh.tagNames.entries()) {
      if (name.startsWith(prefix)) tags.push({ tag, id: name.slice(prefix.length) });
    }
  }
  const names: string[] = [];
  const index = new Map<string, number>();
  for (const f of mesh.faces()) {
    let id = '';
    let found: string | undefined;
    for (const t of tags) {
      if (!mesh.hasTag(f, t.tag)) continue;
      if (found !== undefined) {
        return err(
          modelingError(
            'model-precondition',
            'a face belongs to at most one bake group',
            { input, face: f, groups: [found, t.id] },
            `tag each face with one ${prefix}<id> tag`,
          ),
        );
      }
      found = t.id;
      id = t.id;
    }
    let g = index.get(id);
    if (g === undefined) {
      g = names.length;
      names.push(id);
      index.set(id, g);
    }
    face[f] = g;
  }
  return ok({ ids: names, face });
}

/** Faces of a mesh carrying a tag (empty when the tag is absent). */
export function taggedFaces(mesh: EditMesh, tag: string | undefined): Uint8Array {
  const out = new Uint8Array(mesh.faceHighWater);
  if (tag === undefined) return out;
  const t = mesh.tagNames.indexOf(tag);
  if (t < 0) return out;
  for (const f of mesh.faces()) if (mesh.hasTag(f, t)) out[f] = 1;
  return out;
}

const positionKey = (p: Tuple3, g: number) => `${p[0]},${p[1]},${p[2]}|${g}`;

/**
 * Angle-weighted face normals summed over every corner at one position inside one group:
 * vertices of split or appended parts weld, so the field is continuous across hard edges.
 */
export function averagedNormals(
  mesh: EditMesh,
  group: Int32Array,
): (v: number, g: number) => Tuple3 {
  const sums = new Map<string, Tuple3>();
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    const ps = vs.map((v) => mesh.position(v));
    const n = normalize(newell(ps));
    const g = group[f] as number;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i] as Tuple3;
      const a = sub(ps[(i + ps.length - 1) % ps.length] as Tuple3, p);
      const b = sub(ps[(i + 1) % ps.length] as Tuple3, p);
      const angle = atan2(length(cross(a, b)), dot(a, b));
      const key = positionKey(p, g);
      const s = sums.get(key) ?? [0, 0, 0];
      sums.set(key, [s[0] + n[0] * angle, s[1] + n[1] * angle, s[2] + n[2] * angle]);
    }
  }
  return (v, g) => normalize(sums.get(positionKey(mesh.position(v), g)) ?? [0, 0, 0]);
}

/**
 * Base triangles with the per-corner direction candidates of the field. `averaged` and
 * `shading` hold three xyz per triangle corner; `face` one xyz per triangle.
 */
export interface BaseTriangles {
  readonly position: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  /** Per triangle: group index. */
  readonly group: Int32Array;
  readonly averaged: Float64Array;
  readonly shading: Float64Array;
  readonly face: Float64Array;
  /** Per triangle: its face carries the group's `{ face: tag }` direction tag. */
  readonly tagged: Uint8Array;
}

export interface CornerSource {
  /** Render vertex (index into `position`) of each triangle corner. */
  readonly indices: ArrayLike<number>;
  readonly position: ArrayLike<number>;
  /** FXEM face of each triangle. */
  readonly triangleFace: ArrayLike<number>;
  /** FXEM vertex of each render vertex. */
  readonly vertex: (r: number) => number;
  /** Shading normal of each render vertex. */
  readonly shading: (r: number) => Tuple3;
}

export function baseTriangles(
  mesh: EditMesh,
  source: CornerSource,
  groups: FaceGroups,
  directions: readonly BakeDirection[],
): BaseTriangles {
  const triangles = source.indices.length / 3;
  const averagedOf = averagedNormals(mesh, groups.face);
  const group = new Int32Array(triangles);
  const averaged = new Float64Array(triangles * 9);
  const shading = new Float64Array(triangles * 9);
  const face = new Float64Array(triangles * 3);
  const tagged = new Uint8Array(triangles);
  const faceNormal = new Map<number, Tuple3>();
  const tagIndex = directions.map((d) =>
    typeof d === 'object' && 'face' in d ? mesh.tagNames.indexOf(d.face) : -1,
  );
  for (let t = 0; t < triangles; t++) {
    const f = source.triangleFace[t] as number;
    const g = groups.face[f] as number;
    group[t] = g;
    let n = faceNormal.get(f);
    if (n === undefined) {
      n = normalize(newell(mesh.faceVertices(f).map((v) => mesh.position(v))));
      faceNormal.set(f, n);
    }
    face.set(n, t * 3);
    const tag = tagIndex[g] as number;
    tagged[t] = tag >= 0 && mesh.hasTag(f, tag) ? 1 : 0;
    for (let k = 0; k < 3; k++) {
      const r = source.indices[t * 3 + k] as number;
      averaged.set(averagedOf(source.vertex(r), g), t * 9 + k * 3);
      shading.set(source.shading(r), t * 9 + k * 3);
    }
  }
  return {
    position: source.position,
    indices: source.indices,
    group,
    averaged,
    shading,
    face,
    tagged,
  };
}

/**
 * Hard edges of the base as segments in a uniform grid of cell `radius`: edges whose two
 * faces disagree on a shading normal at either end, or belong to different groups.
 */
export class HardEdges {
  private readonly cells = new Map<string, number[]>();
  private readonly segments: number[] = [];

  readonly radius: number;

  constructor(mesh: EditMesh, source: CornerSource, groups: FaceGroups, radius: number) {
    this.radius = radius;
    const render = new Map<string, number>();
    const triangles = source.indices.length / 3;
    for (let t = 0; t < triangles; t++) {
      const f = source.triangleFace[t] as number;
      for (let k = 0; k < 3; k++) {
        const r = source.indices[t * 3 + k] as number;
        render.set(`${f}:${source.vertex(r)}`, r);
      }
    }
    for (const e of mesh.edges()) {
      const f1 = mesh.hFace[e * 2] as number;
      const f2 = mesh.hFace[e * 2 + 1] as number;
      if (f1 === NONE || f2 === NONE) continue;
      const [a, b] = mesh.edgeVertices(e);
      let hard = groups.face[f1] !== groups.face[f2];
      for (const v of [a, b]) {
        const r1 = render.get(`${f1}:${v}`);
        const r2 = render.get(`${f2}:${v}`);
        if (r1 === undefined || r2 === undefined) continue;
        if (dot(source.shading(r1), source.shading(r2)) < 1 - 1e-6) hard = true;
      }
      if (hard) this.add(mesh.position(a), mesh.position(b));
    }
  }

  private cell(p: readonly number[]): [number, number, number] {
    return [0, 1, 2].map((c) => Math.floor((p[c] as number) / this.radius)) as [
      number,
      number,
      number,
    ];
  }

  private add(a: Tuple3, b: Tuple3): void {
    const s = this.segments.length / 6;
    this.segments.push(...a, ...b);
    const lo = this.cell([0, 1, 2].map((c) => Math.min(a[c] as number, b[c] as number)));
    const hi = this.cell([0, 1, 2].map((c) => Math.max(a[c] as number, b[c] as number)));
    for (let x = lo[0]; x <= hi[0]; x++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let z = lo[2]; z <= hi[2]; z++) {
          const key = `${x},${y},${z}`;
          const list = this.cells.get(key);
          if (list === undefined) this.cells.set(key, [s]);
          else list.push(s);
        }
      }
    }
  }

  get count(): number {
    return this.segments.length / 6;
  }

  /** Distance from p to the nearest hard edge, capped at `radius`. */
  distance(p: Tuple3): number {
    const [cx, cy, cz] = this.cell(p);
    let best = this.radius;
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          for (const s of this.cells.get(`${x},${y},${z}`) ?? []) {
            const o = s * 6;
            const a: Tuple3 = [
              this.segments[o] as number,
              this.segments[o + 1] as number,
              this.segments[o + 2] as number,
            ];
            const d = sub(
              [
                this.segments[o + 3] as number,
                this.segments[o + 4] as number,
                this.segments[o + 5] as number,
              ],
              a,
            );
            const ap = sub(p, a);
            const dd = dot(d, d);
            const u = dd > 0 ? Math.max(0, Math.min(1, dot(ap, d) / dd)) : 0;
            const q = sub(ap, [d[0] * u, d[1] * u, d[2] * u]);
            best = Math.min(best, length(q));
          }
        }
      }
    }
    return best;
  }
}

/**
 * The unit ray direction (pointing out of the base) at barycentric `w` of base triangle
 * `t` under `direction`; `shadingNormal` is the sample's interpolated shading normal.
 */
export function rayDirection(
  base: BaseTriangles,
  t: number,
  w: readonly number[],
  direction: BakeDirection,
  p: Tuple3,
  hard: HardEdges | undefined,
): Tuple3 {
  const lerp = (a: Float64Array): Tuple3 => {
    const out: Tuple3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      for (let c = 0; c < 3; c++)
        out[c] = (out[c] as number) + (w[k] as number) * (a[t * 9 + k * 3 + c] as number);
    }
    return normalize(out);
  };
  const face: Tuple3 = [
    base.face[t * 3] as number,
    base.face[t * 3 + 1] as number,
    base.face[t * 3 + 2] as number,
  ];
  if (direction === 'averaged') return lerp(base.averaged);
  if (direction === 'shading') return lerp(base.shading);
  if (direction === 'face') return face;
  if ('face' in direction) return base.tagged[t] === 1 ? face : lerp(base.averaged);
  const averaged = lerp(base.averaged);
  const s = Math.min(1, (hard as HardEdges).distance(p) / direction.blend);
  const k = s * s * (3 - 2 * s);
  return normalize([
    averaged[0] * (1 - k) + face[0] * k,
    averaged[1] * (1 - k) + face[1] * k,
    averaged[2] * (1 - k) + face[2] * k,
  ]);
}

/** Smallest cosine between a corresponding detail triangle and the ray direction. */
export const FACING_MIN = 0.1;
/** Detail sample points per group diagonal of the automatic cage estimate. */
const CAGE_SAMPLES = 64;
/**
 * Whether a sample's ray is (partly) an averaged cage ray: `'averaged'`, the untagged faces
 * of `{ face }`, and `{ blend }` within its blend distance of a hard edge.
 */
export function averagedPart(
  base: BaseTriangles,
  t: number,
  direction: BakeDirection,
  p: Tuple3,
  hard: HardEdges | undefined,
): boolean {
  if (direction === 'averaged') return true;
  if (direction === 'shading' || direction === 'face') return false;
  if ('face' in direction) return base.tagged[t] !== 1;
  return (hard as HardEdges).distance(p) < direction.blend;
}

/** Margin of the automatic cage over the largest measured deviation. */
export const CAGE_MARGIN = 1.05;
/** Smallest automatic offset and depth as a fraction of the group diagonal. */
export const CAGE_FLOOR = 1e-3;
/** Largest automatic offset or depth as a fraction of the group diagonal before it is an error. */
export const CAGE_LIMIT = 0.2;

export interface ResolvedCage {
  readonly offset: number;
  readonly maxRay: number;
  /** Bounding box diagonal of the group's base and detail. */
  readonly diagonal: number;
}

/** Points of a triangle on a barycentric grid of at most `spacing` (corners included). */
function trianglePoints(
  a: Tuple3,
  b: Tuple3,
  c: Tuple3,
  spacing: number,
  visit: (q: Tuple3, w: readonly number[]) => void,
): void {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const longest = Math.max(length(ab), length(ac), length(sub(ab, ac)));
  const m = Math.min(CAGE_SAMPLES, Math.max(1, Math.ceil(longest / spacing)));
  for (let i = 0; i <= m; i++) {
    for (let j = 0; i + j <= m; j++) {
      visit(
        [
          a[0] + (ab[0] * i + ac[0] * j) / m,
          a[1] + (ab[1] * i + ac[1] * j) / m,
          a[2] + (ab[2] * i + ac[2] * j) / m,
        ],
        [1 - (i + j) / m, i / m, j / m],
      );
    }
  }
}

const cornerOf = (
  mesh: { readonly position: ArrayLike<number>; readonly indices: ArrayLike<number> },
  t: number,
  k: number,
): Tuple3 => {
  const i = mesh.indices[t * 3 + k] as number;
  return [
    mesh.position[i * 3] as number,
    mesh.position[i * 3 + 1] as number,
    mesh.position[i * 3 + 2] as number,
  ];
};

/**
 * Resolve a group's cage. Auto parts measure, both ways, how far along the ray the
 * detail stands from the base: every detail sample against its nearest base point
 * (floaters and bumps above the base) and every base sample against its nearest detail
 * point that faces the ray (a convex low edge outside a rounded high). The distance is
 * taken along the ray to the detail triangle's plane (on facets within 15 degrees of the
 * ray, the sample's own distance along the ray); samples lie on a grid of 1/64 of
 * the group diagonal. Largest outward -> offset, largest inward -> depth, times
 * `CAGE_MARGIN`.
 */
export function resolveCage(
  cage: BakeCage,
  id: string,
  base: BaseTriangles,
  baseTris: readonly number[],
  detail: { readonly position: ArrayLike<number>; readonly indices: ArrayLike<number> },
  detailTris: readonly number[],
  direction: BakeDirection,
  hard: HardEdges | undefined,
): Result<ResolvedCage, ModelingError> {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const [mesh, tris] of [
    [base, baseTris],
    [detail, detailTris],
  ] as const) {
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const p = cornerOf(mesh, t, k);
        for (let c = 0; c < 3; c++) {
          lo[c] = Math.min(lo[c] as number, p[c] as number);
          hi[c] = Math.max(hi[c] as number, p[c] as number);
        }
      }
    }
  }
  const diagonal = length([
    (hi[0] as number) - (lo[0] as number),
    (hi[1] as number) - (lo[1] as number),
    (hi[2] as number) - (lo[2] as number),
  ]);
  if (cage.offset !== 'auto' && cage.maxRay !== 'auto') {
    return ok({ offset: cage.offset, maxRay: cage.maxRay, diagonal });
  }
  const subset = (
    mesh: { readonly position: ArrayLike<number>; readonly indices: ArrayLike<number> },
    tris: readonly number[],
  ) => {
    const local = new Uint32Array(tris.length * 3);
    for (const [i, t] of tris.entries()) {
      for (let k = 0; k < 3; k++) local[i * 3 + k] = mesh.indices[t * 3 + k] as number;
    }
    return new TriangleBvh(mesh.position, local);
  };
  const baseBvh = subset(base, baseTris);
  const detailBvh = subset(detail, detailTris);
  const detailNormal = detailTris.map((t) =>
    normalize(
      cross(
        sub(cornerOf(detail, t, 1), cornerOf(detail, t, 0)),
        sub(cornerOf(detail, t, 2), cornerOf(detail, t, 0)),
      ),
    ),
  );
  const spacing = diagonal / CAGE_SAMPLES;
  let outward = 0;
  let inward = 0;
  const measure = (p: Tuple3, c: Tuple3, q: Tuple3, n: Tuple3) => {
    const facing = dot(c, n);
    if (!(facing > -STEEP_COS)) return;
    // Distance along the ray through p to the detail's plane at q; a steep facet (a wall
    // the ray runs along) would multiply q's sideways offset by 1 / facing, so it counts
    // q's own distance along the ray (audit A2).
    const s = facing >= STEEP_COS ? dot(sub(q, p), n) / facing : dot(sub(q, p), c);
    outward = Math.max(outward, s);
    inward = Math.max(inward, -s);
  };
  const baseAt = (bt: number, w: readonly number[]) => {
    const p: Tuple3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = cornerOf(base, bt, k);
      for (let c = 0; c < 3; c++) p[c] = (p[c] as number) + (w[k] as number) * (v[c] as number);
    }
    return { p, c: rayDirection(base, bt, w, direction, p, hard) };
  };
  for (const [i, t] of detailTris.entries()) {
    const n = detailNormal[i] as Tuple3;
    if (!(length(n) > 0)) continue;
    trianglePoints(
      cornerOf(detail, t, 0),
      cornerOf(detail, t, 1),
      cornerOf(detail, t, 2),
      spacing,
      (q) => {
        const near = baseBvh.nearest(q);
        if (near === undefined) return;
        const { p, c } = baseAt(baseTris[near.triangle] as number, [
          1 - near.u - near.v,
          near.u,
          near.v,
        ]);
        measure(p, c, q, n);
      },
    );
  }
  for (const bt of baseTris) {
    trianglePoints(
      cornerOf(base, bt, 0),
      cornerOf(base, bt, 1),
      cornerOf(base, bt, 2),
      spacing,
      (_, w) => {
        const { p, c } = baseAt(bt, w);
        const near = detailBvh.nearest(
          p,
          (local) => dot(detailNormal[local] as Tuple3, c) > FACING_MIN,
        );
        if (near === undefined) return;
        const dt = detailTris[near.triangle] as number;
        const a = cornerOf(detail, dt, 0);
        const q: Tuple3 = [0, 0, 0];
        const b = cornerOf(detail, dt, 1);
        const d = cornerOf(detail, dt, 2);
        for (let k = 0; k < 3; k++)
          q[k] =
            (a[k] as number) +
            near.u * ((b[k] as number) - (a[k] as number)) +
            near.v * ((d[k] as number) - (a[k] as number));
        measure(p, c, q, detailNormal[near.triangle] as Tuple3);
      },
    );
  }
  const floor = CAGE_FLOOR * diagonal;
  const offset = cage.offset === 'auto' ? Math.max(floor, outward * CAGE_MARGIN) : cage.offset;
  const depth = Math.max(floor, inward * CAGE_MARGIN);
  const maxRay = cage.maxRay === 'auto' ? offset + depth : cage.maxRay;
  const limit = CAGE_LIMIT * diagonal;
  if ((cage.offset === 'auto' && offset > limit) || (cage.maxRay === 'auto' && depth > limit)) {
    return err(
      modelingError(
        'model-precondition',
        `the automatic cage of a bake group stays within ${CAGE_LIMIT * 100}% of its diagonal`,
        { group: id, offset, depth, diagonal, limit },
        'split the parts into bake groups (tags.groupPrefix) so each base faces its own detail, or set cage.offset / cage.maxRay explicitly',
      ),
    );
  }
  return ok({ offset, maxRay, diagonal });
}

function settingsOf(params: BakeJobParams, id: string) {
  const settings = params.groups;
  return settings !== undefined && Object.hasOwn(settings, id) ? settings[id] : undefined;
}

export function cageOf(params: BakeJobParams, id: string): BakeCage {
  const own = settingsOf(params, id)?.cage;
  return {
    offset: own?.offset ?? params.cage.offset,
    maxRay: own?.maxRay ?? params.cage.maxRay,
  };
}

export function directionOf(params: BakeJobParams, id: string): BakeDirection {
  return settingsOf(params, id)?.direction ?? params.direction;
}

/** Cosine below which a detail wall stands too close to the ray to be seen (75 degrees off the ray). */
export const STEEP_COS = 0.2588190451025207;

/**
 * Fraction of a group's detail area (floaters excluded) whose faces stand within 15
 * degrees of the ray at their nearest base point (V3): walls the rays run along, which
 * no bake can see. Engraving and boss walls show only through height and AO unless they
 * are sloped or chamfered.
 */
export function steepFraction(
  base: BaseTriangles,
  baseTris: readonly number[],
  detail: { readonly position: ArrayLike<number>; readonly indices: ArrayLike<number> },
  detailTris: readonly number[],
  direction: BakeDirection,
  hard: HardEdges | undefined,
): number {
  if (baseTris.length === 0 || detailTris.length === 0) return 0;
  const local = new Uint32Array(baseTris.length * 3);
  for (const [i, t] of baseTris.entries()) {
    for (let k = 0; k < 3; k++) local[i * 3 + k] = base.indices[t * 3 + k] as number;
  }
  const bvh = new TriangleBvh(base.position, local);
  let steep = 0;
  let total = 0;
  for (const t of detailTris) {
    const a = cornerOf(detail, t, 0);
    const n = cross(sub(cornerOf(detail, t, 1), a), sub(cornerOf(detail, t, 2), a));
    const area = length(n) / 2;
    if (!(area > 0)) continue;
    total += area;
    const centroid: Tuple3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p = cornerOf(detail, t, k);
      for (let c = 0; c < 3; c++) centroid[c] = (centroid[c] as number) + (p[c] as number) / 3;
    }
    const near = bvh.nearest(centroid);
    if (near === undefined) continue;
    const bt = baseTris[near.triangle] as number;
    const w = [1 - near.u - near.v, near.u, near.v];
    const p: Tuple3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = cornerOf(base, bt, k);
      for (let c = 0; c < 3; c++) p[c] = (p[c] as number) + (w[k] as number) * (v[c] as number);
    }
    const c = rayDirection(base, bt, w, direction, p, hard);
    if (Math.abs(dot(normalize(n), c)) < STEEP_COS) steep += area;
  }
  return total > 0 ? steep / total : 0;
}
