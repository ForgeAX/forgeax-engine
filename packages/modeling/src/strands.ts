import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, hypot3, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  cross,
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  length,
  normalize,
  scale,
  sub,
  type Tuple3,
} from './geom';
import { faceContacts } from './intersect';
import { EditMesh, NONE } from './mesh';
import { markRole, type OpDiagnostic, type RoleCounts } from './ops';
import { pathExtrudeFaces } from './path-extrude';

export interface StrandsOptions {
  /** Number of strands (1 to 512). */
  readonly count: number;
  /**
   * Path of one strand in its root frame, from the root (first point near [0, 0, 0]):
   * x across, y along the root surface normal, z along `comb`.
   */
  readonly path: readonly Tuple3[];
  /** Direction the strands are combed toward (projected onto each root's tangent plane). */
  readonly comb: Tuple3;
  /**
   * How `comb` orients each strand: `'surface'` (default) projects it onto the root's
   * tangent plane; `'world'` keeps it as given, so the path lifts off the surface along y
   * and runs along the comb along z (long hair falls from upward-facing roots instead of
   * fanning out sideways).
   */
  readonly combFrame?: 'surface' | 'world';
  /** Faces per strand root, grown together (default 1). */
  readonly rootFaces?: number;
  /** Cross-section scale from root to tip, as for extrude along a path (default [1, 0.2]). */
  readonly scale?: number | readonly number[];
  /** Per-strand random variation: length factor range and comb turn in degrees (default none). */
  readonly vary?: { readonly length?: readonly [number, number]; readonly turn?: number };
  /** Variation seed (default 1). */
  readonly seed?: number;
}

const MAX_STRANDS = 512;
const MAX_REPORTED = 32;

function invalid(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

/** Adding `f` to the patch `group` would make a vertex where the patch meets itself. */
function pinches(mesh: EditMesh, group: ReadonlySet<number>, f: number): boolean {
  const inside = (g: number) => g === f || group.has(g);
  for (const v of mesh.faceVertices(f)) {
    let outgoing = 0;
    for (const g of [...group, f]) {
      for (const h of mesh.faceHalves(g)) {
        if ((mesh.hVert[h] as number) !== v) continue;
        const across = mesh.hFace[h ^ 1] as number;
        if (across === NONE || !inside(across)) outgoing++;
      }
    }
    if (outgoing > 1) return true;
  }
  return false;
}

/**
 * Hair cards / strand array: `count` strands grow from a face region (a scalp) along one
 * authored path placed in each root's frame (surface normal, comb direction), with seeded
 * per-strand length and comb-turn variation. Roots are spread by area (farthest-point
 * order over the face centroids, so the spread is even and deterministic); each strand is
 * `extrude` along its path from the `rootFaces` region faces nearest its root. Strands get
 * role `strand` (walls) and `tip`; tag `strand:<i>` names each one.
 */
export function strands(
  mesh: EditMesh,
  faces: readonly number[],
  options: StrandsOptions,
  label: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const count = options?.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_STRANDS) {
    return invalid(`count is an integer from 1 to ${MAX_STRANDS}`, { count });
  }
  const rootFaces = options.rootFaces ?? 1;
  if (!Number.isInteger(rootFaces) || rootFaces < 1) {
    return invalid('rootFaces is an integer >= 1', { rootFaces });
  }
  if (count * rootFaces > faces.length) {
    return invalid('the region has count x rootFaces faces', {
      count,
      rootFaces,
      faces: faces.length,
    });
  }
  const finite3 = (v: unknown): v is Tuple3 =>
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((c) => typeof c === 'number' && Number.isFinite(c));
  if (!Array.isArray(options.path) || options.path.length < 2 || !options.path.every(finite3)) {
    return invalid('path is two or more [x, y, z] points', { path: options.path });
  }
  if (!finite3(options.comb) || length(options.comb) === 0) {
    return invalid('comb is three finite numbers, not all zero', { comb: options.comb });
  }
  const combFrame = options.combFrame ?? 'surface';
  if (combFrame !== 'surface' && combFrame !== 'world') {
    return invalid("combFrame is 'surface' or 'world'", { combFrame });
  }
  const range = options.vary?.length ?? [1, 1];
  const turn = options.vary?.turn ?? 0;
  if (!(range[0] > 0 && range[1] >= range[0]) || !Number.isFinite(turn)) {
    return invalid('vary.length is [min, max] with 0 < min <= max; vary.turn is finite degrees', {
      vary: options.vary,
    });
  }
  let seed = Math.floor(options.seed ?? 1) % 2147483647 || 1;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  // Roots: farthest-point order over face centroids, starting from the largest face.
  const centers = new Map(faces.map((f) => [f, faceCentroid(mesh, f)]));
  const area = new Map(faces.map((f) => [f, faceArea(mesh, f)]));
  const sorted = [...faces].sort(
    (a, b) => (area.get(b) as number) - (area.get(a) as number) || a - b,
  );
  // Flat centroid and distance arrays over region order: this loop is count x faces.
  const xyz = new Float64Array(faces.length * 3);
  for (const [i, f] of faces.entries()) xyz.set(centers.get(f) as Tuple3, i * 3);
  const nearest = new Float64Array(faces.length).fill(Infinity);
  const roots: number[] = [];
  let next = faces.indexOf(sorted[0] as number);
  while (roots.length < count) {
    roots.push(faces[next] as number);
    const cx = xyz[next * 3] as number;
    const cy = xyz[next * 3 + 1] as number;
    const cz = xyz[next * 3 + 2] as number;
    let best = -1;
    let far = -1;
    for (let i = 0; i < faces.length; i++) {
      const d = Math.min(
        nearest[i] as number,
        hypot3(
          (xyz[i * 3] as number) - cx,
          (xyz[i * 3 + 1] as number) - cy,
          (xyz[i * 3 + 2] as number) - cz,
        ),
      );
      nearest[i] = d;
      const f = faces[i] as number;
      if (d > far || (d === far && f < (faces[best] as number))) {
        far = d;
        best = i;
      }
    }
    next = best;
  }
  // Root groups: each root grows over edge-adjacent free faces, nearest first, keeping the
  // group one pinch-free patch (a group meeting itself at a vertex cannot be extruded);
  // computed before any edit.
  const region = new Set(faces);
  const taken = new Set<number>();
  let short = 0;
  const groups = roots.map((seed) => {
    const c = centers.get(seed) as Tuple3;
    // A root already in an earlier group starts from the nearest free face instead.
    let root = seed;
    if (taken.has(root)) {
      let bestDistance = Infinity;
      for (const f of faces) {
        if (taken.has(f)) continue;
        const d = length(sub(centers.get(f) as Tuple3, c));
        if (d < bestDistance) {
          bestDistance = d;
          root = f;
        }
      }
    }
    const group = [root];
    const inGroup = new Set(group);
    taken.add(root);
    while (group.length < rootFaces) {
      let best = -1;
      let bestDistance = Infinity;
      for (const f of group) {
        for (const h of mesh.faceHalves(f)) {
          const g = mesh.hFace[h ^ 1] as number;
          if (g === NONE || !region.has(g) || taken.has(g) || inGroup.has(g)) continue;
          const d = length(sub(centers.get(g) as Tuple3, c));
          if (d < bestDistance || (d === bestDistance && g < best)) {
            if (pinches(mesh, inGroup, g)) continue;
            best = g;
            bestDistance = d;
          }
        }
      }
      if (best < 0) break;
      group.push(best);
      inGroup.add(best);
      taken.add(best);
    }
    if (group.length < rootFaces) short++;
    return { group, center: c, normal: faceNormal(mesh, root) };
  });
  // Each group's shared vertices from one pass over the mesh, before any strand grows (as
  // `sharedVertices` with open boundaries): a strand's extrusion only rewires its own
  // group's vertices, so later groups keep theirs, and no strand rescans the mesh.
  const groupOf = new Map<number, number>();
  const groupsAt = new Map<number, number[]>();
  for (const [i, { group }] of groups.entries()) {
    for (const f of group) {
      groupOf.set(f, i);
      for (const v of mesh.faceVertices(f)) {
        const at = groupsAt.get(v);
        if (at === undefined) groupsAt.set(v, [i]);
        else if (!at.includes(i)) at.push(i);
      }
    }
  }
  const sharedOf = groups.map(() => new Set<number>());
  for (let h = 0; h < mesh.halfHighWater; h++) {
    const f = mesh.hFace[h] as number;
    if (f === NONE) continue;
    const v = mesh.hVert[h] as number;
    const own = groupOf.get(f);
    for (const i of groupsAt.get(v) ?? []) if (i !== own) sharedOf[i]?.add(v);
    if (own !== undefined && (mesh.hFace[h ^ 1] as number) === NONE) {
      sharedOf[own]?.add(v).add(mesh.hVert[mesh.hNext[h] as number] as number);
    }
  }
  const comb = normalize(options.comb);
  const counts: RoleCounts = {};
  const strandFaces: number[][] = [];
  let combDegenerate = 0;
  for (const [i, { group, center, normal }] of groups.entries()) {
    const a = ((random() * 2 - 1) * turn * Math.PI) / 180;
    let t: Tuple3;
    let across: Tuple3;
    if (combFrame === 'world') {
      // The comb turned about the root normal (Rodrigues), kept out of the tangent plane.
      t = add(
        add(scale(comb, cos(a)), scale(cross(normal, comb), sin(a))),
        scale(normal, dot(normal, comb) * (1 - cos(a))),
      );
      across = cross(normal, t);
      if (length(across) < 0.1) {
        combDegenerate++;
        across = cross(normal, Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
      }
      across = normalize(across);
    } else {
      let tangent = sub(comb, scale(normal, dot(comb, normal)));
      // Within ~6 degrees of the normal the projected comb direction is noise: comb sideways.
      if (length(tangent) < 0.1) {
        combDegenerate++;
        tangent = normalize(cross(normal, Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
      }
      tangent = normalize(tangent);
      const across0 = normalize(cross(normal, tangent));
      t = add(scale(tangent, cos(a)), scale(across0, sin(a)));
      across = normalize(cross(normal, t));
    }
    const k = range[0] + (range[1] - range[0]) * random();
    const path = options.path.map((p) =>
      add(center, add(add(scale(across, p[0] * k), scale(normal, p[1] * k)), scale(t, p[2] * k))),
    );
    const grown = pathExtrudeFaces(
      mesh,
      group.filter((f) => mesh.isFaceAlive(f)),
      { path, scale: options.scale ?? [1, 0.2] },
      0,
      tolerance,
      diagnostics,
      sharedOf[i],
    );
    if (!grown.ok) {
      return err(
        modelingError(
          grown.error.code,
          grown.error.expected,
          { ...grown.error.detail, strand: i },
          grown.error.hint,
        ),
      );
    }
    const strandTag = mesh.tagIndex(`strand:${i}`, true);
    const { walls, top: tops } = grown.value;
    strandFaces.push([...walls, ...tops]);
    for (const f of [...walls, ...tops]) mesh.addTag(f, strandTag);
    markRole(mesh, walls, label, 'strand', counts);
    markRole(mesh, tops, label, 'tip', counts);
  }
  if (short > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${short} strand root(s) found fewer than ${rootFaces} connected free faces; they grew from fewer`,
      detail: { roots: short, rootFaces },
    });
  }
  // Strands crossing each other (clumps grown too close or combed into one another),
  // checked on a copy of the strand faces alone (shared vertices kept), so the cost
  // follows the strands, not the head they grow on.
  const strandsOnly = new EditMesh();
  const copyOf = new Map<number, number>();
  const owner = new Map<number, number>();
  const original = new Map<number, number>();
  for (const [i, faces] of strandFaces.entries()) {
    for (const f of faces) {
      const loop = mesh.faceVertices(f).map((v) => {
        let c = copyOf.get(v);
        if (c === undefined) {
          c = strandsOnly.addVertex(...mesh.position(v));
          copyOf.set(v, c);
        }
        return c;
      });
      const added = strandsOnly.addFace(loop);
      if (!added.ok) continue;
      owner.set(added.value, i);
      original.set(added.value, f);
    }
  }
  const crossings = faceContacts(strandsOnly, Number.MAX_SAFE_INTEGER, tolerance).contacts.filter(
    (c) => c.contact === 'cross' && owner.get(c.faces[0]) !== owner.get(c.faces[1]),
  );
  if (crossings.length > 0) {
    const pairs = [
      ...new Set(
        crossings.map((c) => {
          const a = owner.get(c.faces[0]) as number;
          const b = owner.get(c.faces[1]) as number;
          return a < b ? `${a},${b}` : `${b},${a}`;
        }),
      ),
    ].map((k) => k.split(',').map(Number) as [number, number]);
    diagnostics.push({
      severity: 'warn',
      message: `${pairs.length} strand pair(s) cross each other: thin the count, shorten them or vary the comb`,
      detail: {
        pairs: pairs.slice(0, MAX_REPORTED),
        count: pairs.length,
        faces: crossings
          .slice(0, MAX_REPORTED)
          .map((c) => [original.get(c.faces[0]), original.get(c.faces[1])]),
      },
    });
  }
  if (combDegenerate > 0) {
    diagnostics.push({
      severity: 'warn',
      message:
        combFrame === 'world'
          ? `${combDegenerate} root(s) face along the comb direction; their strand cross-sections turn arbitrarily`
          : `${combDegenerate} root(s) face along the comb direction; their strands comb sideways`,
      detail: { roots: combDegenerate },
    });
  }
  diagnostics.push({
    severity: 'info',
    message: `strands grew ${count} strand(s) from ${faces.length} region faces`,
    detail: { count, rootFaces, seed: options.seed ?? 1 },
  });
  return ok(counts);
}
