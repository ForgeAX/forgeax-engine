import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, hypot3, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  cross,
  dot,
  faceCentroid,
  faceNormal,
  newell,
  normalize,
  scale,
  type Tuple3,
} from './geom';
import type { EditMesh } from './mesh';
import type { RoleCounts } from './ops';
import type { FaceSelector } from './selectors';
import { SurfaceQuery } from './shrinkwrap';

/** Stamping within `warn` of the direction is safe, up to 90 critical, beyond an undercut. */
export type DraftClass = 'safe' | 'critical' | 'undercut';

export interface DraftFace {
  readonly face: number;
  /** Degrees between the face normal and the direction. */
  readonly angle: number;
  readonly class: DraftClass;
}

export interface DraftOptions {
  /** Pull direction (normalized here). */
  readonly direction: Tuple3;
  /** Faces to check (default all). */
  readonly faces?: FaceSelector;
  /** Degrees from the direction where the critical band starts (default 85). */
  readonly warn?: number;
}

export interface DraftReport {
  readonly faces: readonly DraftFace[];
  readonly critical: readonly number[];
  readonly undercut: readonly number[];
  /**
   * Faces the direction sees (not undercut by angle) whose ray along it hits another checked
   * face: a hidden pocket the die cannot reach (the ray rule).
   */
  readonly shadowed: readonly number[];
}

/** Degrees of rounding a face along the direction may show and still count as critical. */
const ANGLE_TOLERANCE = 1e-5;

/** @internal Classify one face normal against a unit direction. */
export function draftFace(
  face: number,
  normal: Tuple3,
  direction: Tuple3,
  warn: number,
): DraftFace {
  const [a, b] = [normal, direction];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const s = hypot3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  const angle = (atan2(s, c) * 180) / Math.PI;
  // Faces exactly along the direction (sides of a box) stay critical despite rounding.
  const cls = angle <= warn ? 'safe' : angle <= 90 + ANGLE_TOLERANCE ? 'critical' : 'undercut';
  return { face, angle, class: cls };
}

/** @internal Check `warn` and normalize `direction`. */
export function draftInputs(
  direction: Tuple3,
  warn: number,
): Result<{ direction: Tuple3; warn: number }, ModelingError> {
  const n = hypot3(...direction);
  if (!(n > 0) || !Number.isFinite(n) || !(warn > 0 && warn <= 90)) {
    return err(
      modelingError('model-invalid-argument', 'a non-zero direction and warn in (0, 90] degrees', {
        direction,
        warn,
      }),
    );
  }
  return ok({ direction: direction.map((x) => x / n) as Tuple3, warn });
}

/**
 * Draft against a pull direction: each face's angle to the direction and its
 * class, and the faces a ray along the direction finds hidden behind other faces.
 */
export function draft(
  source: { readonly editMesh: EditMesh; readonly poisoned?: ModelingError | undefined },
  options: DraftOptions,
): Result<DraftReport, ModelingError> {
  if (source.poisoned !== undefined) return err(source.poisoned);
  const inputs = draftInputs(options.direction, options.warn ?? 85);
  if (!inputs.ok) return inputs;
  const { direction, warn } = inputs.value;
  const mesh = source.editMesh;
  const ids = options.faces === undefined ? [...mesh.faces()] : options.faces.evaluate(mesh);
  const query = SurfaceQuery.of(mesh, ids);
  if (!query.ok) return query;
  const faces = ids.map((f) => draftFace(f, faceNormal(mesh, f), direction, warn));
  const lift = 1e-7;
  const shadowed = faces
    .filter((d) => d.class !== 'undercut')
    .filter((d) => {
      const n = faceNormal(mesh, d.face);
      const c = faceCentroid(mesh, d.face);
      const p: Tuple3 = [c[0] + n[0] * lift, c[1] + n[1] * lift, c[2] + n[2] * lift];
      return query.value.occluded(p, direction, d.face);
    })
    .map((d) => d.face);
  return ok({
    faces,
    critical: faces.filter((d) => d.class === 'critical').map((d) => d.face),
    undercut: faces.filter((d) => d.class === 'undercut').map((d) => d.face),
    shadowed,
  });
}

export interface ApplyDraftOptions {
  /** Draft angle in degrees, in (0, 45). */
  readonly angle: number;
  /** Pull direction (normalized here); drafted walls lean toward it. */
  readonly direction: Tuple3;
  /** Planar faces perpendicular to `direction` whose plane keeps its size. */
  readonly neutral: FaceSelector;
  readonly label?: string;
  readonly tag?: string;
}

interface Plane {
  readonly n: Tuple3;
  readonly d: number;
}

const PARALLEL = 1e-9;

function nonPrism(face: number, what: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError(
    'model-precondition',
    `applyDraft ${what}`,
    { reason: 'draft-non-prism', face, ...detail },
    'v1 drafts planar prism walls parallel to the direction about a planar neutral face perpendicular to it; split or rebuild other shapes first',
  );
}

function planeOfFace(mesh: EditMesh, f: number, tolerance: number): Plane | undefined {
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  const n = normalize(newell(points));
  if (!(hypot3(...n) > 0)) return undefined;
  const d = dot(n, points[0] as Tuple3);
  return points.every((p) => Math.abs(dot(n, p) - d) <= tolerance) ? { n, d } : undefined;
}

/**
 * The point nearest `p` on the planes of a greedily chosen independent subset of `planes`
 * (one point for three, a line for two), or undefined when none is chosen.
 */
function settle(p: Tuple3, planes: readonly Plane[]): Tuple3 | undefined {
  const basis: Plane[] = [];
  for (const plane of planes) {
    if (basis.length === 3) break;
    const [a, b] = basis;
    const independent =
      a === undefined
        ? true
        : b === undefined
          ? hypot3(...cross(a.n, plane.n)) > 1e-6
          : Math.abs(dot(a.n, cross(b.n, plane.n))) > 1e-6;
    if (independent) basis.push(plane);
  }
  if (basis.length === 0) return undefined;
  // x = p + sum(l_j n_j) with Gram(n) l = d - n . p: the least change that meets every plane.
  const k = basis.length;
  const g = basis.map((u) => basis.map((v) => dot(u.n, v.n)));
  const r = basis.map((u) => u.d - dot(u.n, p));
  for (let c = 0; c < k; c++) {
    const pivot = (g[c] as number[])[c] as number;
    for (let row = c + 1; row < k; row++) {
      const f = ((g[row] as number[])[c] as number) / pivot;
      for (let col = c; col < k; col++) {
        (g[row] as number[])[col] =
          ((g[row] as number[])[col] as number) - f * ((g[c] as number[])[col] as number);
      }
      r[row] = (r[row] as number) - f * (r[c] as number);
    }
  }
  const l: number[] = new Array(k).fill(0);
  for (let row = k - 1; row >= 0; row--) {
    let sum = r[row] as number;
    for (let col = row + 1; col < k; col++)
      sum -= ((g[row] as number[])[col] as number) * (l[col] as number);
    l[row] = sum / ((g[row] as number[])[row] as number);
  }
  return basis.reduce((x, plane, j) => add(x, scale(plane.n, l[j] as number)), p);
}

/**
 * @internal Draft the selected prism walls: each wall plane turns by `angle` about its line on
 * the neutral plane, leaning toward the pull direction, and every moved vertex is re-solved on
 * its incident planes. Vertices on the neutral plane keep their exact positions.
 */
export function applyDraft(
  mesh: EditMesh,
  faces: readonly number[],
  neutral: readonly number[],
  options: ApplyDraftOptions,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const n = hypot3(...options.direction);
  if (!(n > 0) || !Number.isFinite(n) || !(options.angle > 0 && options.angle < 45)) {
    return err(
      modelingError('model-invalid-argument', 'a non-zero direction and angle in (0, 45) degrees', {
        direction: options.direction,
        angle: options.angle,
      }),
    );
  }
  const dir = options.direction.map((x) => x / n) as Tuple3;
  let height: number | undefined;
  for (const f of neutral) {
    const plane = planeOfFace(mesh, f, tolerance);
    if (plane === undefined || Math.abs(Math.abs(dot(plane.n, dir)) - 1) > PARALLEL) {
      return err(
        nonPrism(f, 'needs a planar neutral face perpendicular to the direction', {
          role: 'neutral',
        }),
      );
    }
    const h = dot(dir, mesh.position(mesh.faceVertices(f)[0] as number));
    if (height !== undefined && Math.abs(h - height) > tolerance) {
      return err(
        nonPrism(f, 'needs coplanar neutral faces', {
          role: 'neutral',
          height: h,
          expected: height,
        }),
      );
    }
    height ??= h;
  }
  if (height === undefined) return err(nonPrism(-1, 'needs a neutral face', { role: 'neutral' }));
  const a = (options.angle * Math.PI) / 180;
  const [ca, sa] = [cos(a), sin(a)];
  const planes = new Map<number, Plane>();
  const drafted = new Map<number, Plane>();
  for (const f of faces) {
    const plane = planeOfFace(mesh, f, tolerance);
    if (plane === undefined) return err(nonPrism(f, 'drafts planar faces'));
    if (Math.abs(dot(plane.n, dir)) > PARALLEL) {
      return err(
        nonPrism(f, 'drafts walls parallel to the direction', { cosine: dot(plane.n, dir) }),
      );
    }
    // The pivot line: on the wall and on the neutral plane; the new plane contains it.
    const pivot = add(scale(plane.n, plane.d), scale(dir, height));
    const turned = normalize(add(scale(plane.n, ca), scale(dir, sa)));
    drafted.set(f, { n: turned, d: dot(turned, pivot) });
  }
  const around = new Map<number, number[]>();
  for (const f of mesh.faces()) {
    for (const v of mesh.faceVertices(f)) {
      const list = around.get(v);
      if (list === undefined) around.set(v, [f]);
      else list.push(f);
    }
  }
  const moved = new Map<number, Tuple3>();
  for (const f of faces) {
    for (const v of mesh.faceVertices(f)) {
      if (moved.has(v)) continue;
      const p = mesh.position(v);
      const t = dot(dir, p) - height;
      if (Math.abs(t) <= tolerance) continue;
      const incident: Plane[] = [];
      for (const g of around.get(v) as number[]) {
        let plane = drafted.get(g) ?? planes.get(g);
        if (plane === undefined) {
          plane = planeOfFace(mesh, g, tolerance);
          if (plane === undefined)
            return err(nonPrism(g, 'needs planar faces around drafted walls', { vertex: v }));
          planes.set(g, plane);
        }
        if (
          !incident.some(
            (q) => dot(q.n, plane.n) > 1 - PARALLEL && Math.abs(q.d - plane.d) <= tolerance,
          )
        ) {
          incident.push(plane);
        }
      }
      const solved = settle(p, [...incident, { n: dir, d: dot(dir, p) }]);
      if (solved === undefined)
        return err(nonPrism(f, 'meets each moved vertex in one point', { vertex: v }));
      const q = solved;
      const off = incident.find((plane) => Math.abs(dot(plane.n, q) - plane.d) > tolerance);
      if (off !== undefined)
        return err(nonPrism(f, 'moves vertices with at most three distinct planes', { vertex: v }));
      moved.set(v, q);
    }
  }
  const before = new Map([...moved.keys()].map((v) => [v, mesh.position(v)] as const));
  const touched = new Set<number>();
  for (const v of moved.keys()) for (const g of around.get(v) as number[]) touched.add(g);
  const normals = new Map(
    [...touched].map(
      (g) => [g, newell(mesh.faceVertices(g).map((v) => mesh.position(v)))] as const,
    ),
  );
  for (const [v, q] of moved) mesh.setPosition(v, q[0], q[1], q[2]);
  for (const g of touched) {
    const now = newell(mesh.faceVertices(g).map((v) => mesh.position(v)));
    const was = normals.get(g) as Tuple3;
    if (!(hypot3(...now) > tolerance * tolerance) || !(dot(now, was) > 0)) {
      for (const [v, p] of before) mesh.setPosition(v, p[0], p[1], p[2]);
      return err(
        modelingError(
          'model-degenerate',
          'drafted walls stay apart up to the far cap',
          { face: g, angle: options.angle },
          'reduce the angle or the wall height; the walls cross before the far cap',
        ),
      );
    }
  }
  return ok({ drafted: faces.length });
}
