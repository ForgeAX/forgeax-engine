import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from './arrays';
import { mergeFlags } from './crease';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { facesVolume, length, newell, orient2d, type Tuple3 } from './geom';
import { EDGE_SHARP, type EditMesh, NONE } from './mesh';
import {
  type Attribution,
  addFaces,
  type RoleCounts,
  requireFinite,
  requirePositive,
  requireSegments,
} from './ops';
import { convexPartition } from './polygon2d';

/** A 2D point: `[x, y]` for outlines, `[radius, y]` for revolve profiles. */
export type Point2 = readonly [number, number];

type Place = (x: number, y: number, z: number) => Tuple3;

function offsetBy(center: Tuple3 | undefined): Place {
  const [cx, cy, cz] = center ?? [0, 0, 0];
  return (x, y, z) => [x + cx, y + cy, z + cz];
}

function requireAngle(value: number | undefined): Result<number, ModelingError> {
  const angle = value ?? 360;
  const finite = requireFinite('angle', angle);
  if (!finite.ok) return finite;
  if (angle <= 0 || angle > 360) {
    return err(
      modelingError('model-invalid-argument', 'angle is in degrees, within (0, 360]', { angle }),
    );
  }
  return ok(angle);
}

function samePoint(a: Point2, b: Point2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Validate a 2D point list. A last point equal to the first closes the outline and
 * is dropped; consecutive duplicates are degenerate.
 */
export function readOutline(
  name: string,
  points: readonly Point2[],
  minimum: number,
): Result<{ points: Point2[]; closed: boolean }, ModelingError> {
  for (const p of points) {
    for (const c of p) {
      const checked = requireFinite(name, c);
      if (!checked.ok) return checked;
    }
  }
  const closed = points.length > minimum && samePoint(points[0] as Point2, points.at(-1) as Point2);
  const out = closed ? points.slice(0, -1) : [...points];
  if (out.length < minimum) {
    return err(
      modelingError('model-invalid-argument', `${name} has at least ${minimum} distinct points`, {
        count: out.length,
      }),
    );
  }
  const wraps = closed ? out.length : out.length - 1;
  for (let i = 0; i < wraps; i++) {
    if (samePoint(out[i] as Point2, out[(i + 1) % out.length] as Point2)) {
      return err(
        modelingError('model-degenerate', `consecutive ${name} points differ`, {
          index: i,
          point: out[i],
        }),
      );
    }
  }
  return ok({ points: out, closed });
}

/**
 * Effect assertion of closed generators: the new faces enclose a positive volume.
 * A non-positive volume means the outline runs the wrong way or crosses itself.
 */
export function requireOutwardShell(
  mesh: EditMesh,
  faces: readonly number[],
  hint: string,
): Result<void, ModelingError> {
  const volume = facesVolume(mesh, faces);
  if (volume > 0) return ok(undefined);
  return err(
    modelingError(
      'model-degenerate',
      'the closed surface faces outward (positive volume)',
      { volume },
      hint,
    ),
  );
}

// ---- revolve kernel ------------------------------------------------------------

interface Sweep {
  /** Author parameter name of `segments`, for error details. */
  readonly name: string;
  readonly segments: number;
  /** Degrees. */
  readonly angle: number;
  /** Degrees; 0 starts at +Z and the sweep turns toward +X (right-handed about +Y). */
  readonly startAngle: number;
}

interface SurfaceRoles {
  readonly side: string;
  readonly start: string;
  readonly end: string;
}

/**
 * Revolve a `[radius, y]` profile about +Y. The surface faces the right-hand side of
 * the profile direction, so a profile listed bottom to top faces outward. Profile
 * ends on the axis become poles; an end segment that also lies perpendicular to
 * the axis becomes one n-gon cap with a sharp rim instead of a triangle fan.
 */
function revolveSurface(
  mesh: EditMesh,
  points: readonly Point2[],
  sweep: Sweep,
  roles: SurfaceRoles,
  attribution: Attribution,
  place: Place,
): Result<{ counts: RoleCounts; faces: number[]; closed: boolean }, ModelingError> {
  const outline = readOutline('points', points, 2);
  if (!outline.ok) return outline;
  const { points: profile, closed: loop } = outline.value;
  const m = profile.length;
  for (const [j, p] of profile.entries()) {
    const onAxis = p[0] === 0;
    if (p[0] < 0 || (onAxis && (loop || (j > 0 && j < m - 1)))) {
      return err(
        modelingError(
          'model-invalid-argument',
          'profile radii are >= 0 and only the first and last points of an open profile lie on the axis',
          { index: j, point: p },
        ),
      );
    }
  }
  if (!loop && m === 2 && profile.every((p) => p[0] === 0)) {
    return err(
      modelingError('model-degenerate', 'the profile has a point off the axis', {
        points: profile,
      }),
    );
  }
  const full = sweep.angle === 360;
  const segments = requireSegments(sweep.name, sweep.segments, full ? 3 : 1);
  if (!segments.ok) return segments;
  const n = sweep.segments;
  const columns = full ? n : n + 1;
  const ids = profile.map((p) => {
    const count = p[0] === 0 ? 1 : columns;
    return Array.from({ length: count }, (_, i) => {
      const phi = ((sweep.startAngle + (i * sweep.angle) / n) * Math.PI) / 180;
      return mesh.addVertex(...place(p[0] * sin(phi), p[1], p[0] * cos(phi)));
    });
  });
  const at = (j: number, i: number): number => {
    const ring = ids[j] as number[];
    return ring.length === 1 ? (ring[0] as number) : (ring[i % columns] as number);
  };
  const isCap = (j: number, k: number, axisEnd: number): boolean =>
    !loop &&
    (profile[axisEnd] as Point2)[0] === 0 &&
    (profile[j] as Point2)[1] === (profile[k] as Point2)[1];

  const sides: number[][] = [];
  const caps: { role: string; loop: number[]; rim: number }[] = [];
  const spans = loop ? m : m - 1;
  for (let j = 0; j < spans; j++) {
    const k = (j + 1) % m;
    if (j === 0 && isCap(j, k, 0)) {
      const rim = Array.from({ length: columns }, (_, i) => at(k, columns - 1 - i));
      caps.push({ role: roles.start, loop: full ? rim : [at(j, 0), ...rim], rim: k });
      if (full) mesh.removeVertex(at(j, 0));
      continue;
    }
    if (k === m - 1 && isCap(j, k, k)) {
      const rim = Array.from({ length: columns }, (_, i) => at(j, i));
      caps.push({ role: roles.end, loop: full ? rim : [...rim, at(k, 0)], rim: j });
      if (full) mesh.removeVertex(at(k, 0));
      continue;
    }
    const jAxis = (profile[j] as Point2)[0] === 0;
    const kAxis = (profile[k] as Point2)[0] === 0;
    for (let i = 0; i < n; i++) {
      const a = at(j, i);
      const b = at(j, i + 1);
      const c = at(k, i + 1);
      const d = at(k, i);
      sides.push(jAxis ? [a, c, d] : kAxis ? [a, b, c] : [a, b, c, d]);
    }
  }
  const counts: RoleCounts = {};
  const faces: number[] = [];
  const added = addFaces(mesh, sides, attribution, roles.side, counts);
  if (!added.ok) return added;
  pushAll(faces, added.value);
  for (const cap of caps) {
    const capFace = addFaces(mesh, [cap.loop], attribution, cap.role, counts);
    if (!capFace.ok) return capFace;
    pushAll(faces, capFace.value);
    for (let i = 0; i < (full ? columns : columns - 1); i++) {
      const h = mesh.findHalf(at(cap.rim, i), at(cap.rim, i + 1));
      if (h !== NONE) mesh.eFlags[h >> 1] = mergeFlags(mesh.eFlags[h >> 1] as number, EDGE_SHARP);
    }
  }
  const closed =
    full && (loop || ((profile[0] as Point2)[0] === 0 && (profile[m - 1] as Point2)[0] === 0));
  return ok({ counts, faces, closed });
}

function closedShellRoles(
  mesh: EditMesh,
  surface: Result<{ counts: RoleCounts; faces: number[]; closed: boolean }, ModelingError>,
  hint: string,
): Result<RoleCounts, ModelingError> {
  if (!surface.ok) return surface;
  if (surface.value.closed) {
    const outward = requireOutwardShell(mesh, surface.value.faces, hint);
    if (!outward.ok) return outward;
  }
  return ok(surface.value.counts);
}

// ---- box, plane, polygon --------------------------------------------------------------

export interface BoxOptions {
  readonly size: Tuple3;
  readonly center?: Tuple3;
  readonly segments?: readonly [number, number, number];
}

export function appendBox(
  mesh: EditMesh,
  options: BoxOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  for (const [i, s] of options.size.entries()) {
    const checked = requirePositive(`size[${i}]`, s);
    if (!checked.ok) return checked;
  }
  const segments = options.segments ?? [1, 1, 1];
  for (const [i, n] of segments.entries()) {
    const checked = requireSegments(`segments[${i}]`, n, 1);
    if (!checked.ok) return checked;
  }
  const [sx, sy, sz] = options.size;
  const [cx, cy, cz] = options.center ?? [0, 0, 0];
  const [nx, ny, nz] = segments;
  const grid = new Map<string, number>();
  const vertex = (i: number, j: number, k: number): number => {
    const key = `${i},${j},${k}`;
    let v = grid.get(key);
    if (v === undefined) {
      v = mesh.addVertex(
        cx + (i / nx - 0.5) * sx,
        cy + (j / ny - 0.5) * sy,
        cz + (k / nz - 0.5) * sz,
      );
      grid.set(key, v);
    }
    return v;
  };
  const loops: number[][] = [];
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      loops.push([
        vertex(nx, j, k),
        vertex(nx, j + 1, k),
        vertex(nx, j + 1, k + 1),
        vertex(nx, j, k + 1),
      ]);
      loops.push([
        vertex(0, j, k),
        vertex(0, j, k + 1),
        vertex(0, j + 1, k + 1),
        vertex(0, j + 1, k),
      ]);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      loops.push([
        vertex(i, ny, k),
        vertex(i, ny, k + 1),
        vertex(i + 1, ny, k + 1),
        vertex(i + 1, ny, k),
      ]);
      loops.push([
        vertex(i, 0, k),
        vertex(i + 1, 0, k),
        vertex(i + 1, 0, k + 1),
        vertex(i, 0, k + 1),
      ]);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      loops.push([
        vertex(i, j, nz),
        vertex(i + 1, j, nz),
        vertex(i + 1, j + 1, nz),
        vertex(i, j + 1, nz),
      ]);
      loops.push([
        vertex(i, j, 0),
        vertex(i, j + 1, 0),
        vertex(i + 1, j + 1, 0),
        vertex(i + 1, j, 0),
      ]);
    }
  }
  const counts: RoleCounts = {};
  const added = addFaces(mesh, loops, attribution, 'face', counts);
  if (!added.ok) return added;
  return ok(counts);
}

export interface PlaneOptions {
  /** Extent along X. */
  readonly width: number;
  /** Extent along Y. */
  readonly height: number;
  readonly widthSegments?: number;
  readonly heightSegments?: number;
  readonly center?: Tuple3;
}

/** A quad grid in XY facing +Z. */
export function appendPlane(
  mesh: EditMesh,
  options: PlaneOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  for (const name of ['width', 'height'] as const) {
    const checked = requirePositive(name, options[name]);
    if (!checked.ok) return checked;
  }
  const nx = options.widthSegments ?? 1;
  const ny = options.heightSegments ?? 1;
  for (const [name, n] of [
    ['widthSegments', nx],
    ['heightSegments', ny],
  ] as const) {
    const checked = requireSegments(name, n, 1);
    if (!checked.ok) return checked;
  }
  const place = offsetBy(options.center);
  const ids: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      ids.push(
        mesh.addVertex(
          ...place((i / nx - 0.5) * options.width, (j / ny - 0.5) * options.height, 0),
        ),
      );
    }
  }
  const at = (i: number, j: number) => ids[j * (nx + 1) + i] as number;
  const loops: number[][] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++)
      loops.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  }
  const counts: RoleCounts = {};
  const added = addFaces(mesh, loops, attribution, 'face', counts);
  if (!added.ok) return added;
  return ok(counts);
}

export interface PolygonOptions {
  /** Counter-clockwise outline seen from the face normal side. */
  readonly points: readonly Tuple3[];
}

export function appendPolygon(
  mesh: EditMesh,
  options: PolygonOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  if (options.points.length < 3) {
    return err(
      modelingError('model-invalid-argument', 'a polygon has at least 3 points', {
        count: options.points.length,
      }),
    );
  }
  for (const p of options.points) {
    for (const c of p) {
      const checked = requireFinite('points', c);
      if (!checked.ok) return checked;
    }
  }
  if (length(newell([...options.points])) <= 1e-12) {
    return err(
      modelingError('model-degenerate', 'a polygon has non-zero area', { points: options.points }),
    );
  }
  const loop = options.points.map((p) => mesh.addVertex(p[0], p[1], p[2]));
  const counts: RoleCounts = {};
  const added = addFaces(mesh, [loop], attribution, 'face', counts);
  if (!added.ok) return added;
  return ok(counts);
}

// ---- revolved primitives ------------------------------------------------------------------

export interface RevolveOptions {
  /** `[radius, y]` profile, bottom to top for an outward surface; first == last closes it. */
  readonly points: readonly Point2[];
  readonly segments: number;
  /** Swept angle in degrees (default 360). */
  readonly angle?: number;
}

/** Revolve about +Y; roles `side`, plus `bottom`/`top` for flat end caps. */
export function appendRevolve(
  mesh: EditMesh,
  options: RevolveOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  const angle = requireAngle(options.angle);
  if (!angle.ok) return angle;
  return closedShellRoles(
    mesh,
    revolveSurface(
      mesh,
      options.points,
      { name: 'segments', segments: options.segments, angle: angle.value, startAngle: 0 },
      { side: 'side', start: 'bottom', end: 'top' },
      attribution,
      offsetBy(undefined),
    ),
    'list the profile from bottom to top (bottom-to-top order) and keep it free of self-crossings',
  );
}

export interface CylinderOptions {
  readonly radiusTop: number;
  readonly radiusBottom: number;
  readonly height: number;
  readonly radialSegments: number;
  readonly heightSegments?: number;
  /** Omit the caps (default false). */
  readonly openEnded?: boolean;
  readonly center?: Tuple3;
}

/**
 * Cylinder along +Y with n-gon caps and sharp cap rims; a zero
 * radius ends in a pole instead. Roles `side`, `top` and `bottom`.
 */
export function appendCylinder(
  mesh: EditMesh,
  options: CylinderOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  for (const name of ['radiusTop', 'radiusBottom'] as const) {
    const checked = requireFinite(name, options[name]);
    if (!checked.ok) return checked;
    if (options[name] < 0) {
      return err(
        modelingError('model-invalid-argument', `${name} is >= 0`, { [name]: options[name] }),
      );
    }
  }
  if (options.radiusTop === 0 && options.radiusBottom === 0) {
    return err(
      modelingError('model-invalid-argument', 'radiusTop or radiusBottom is greater than 0', {
        radiusTop: 0,
        radiusBottom: 0,
      }),
    );
  }
  const height = requirePositive('height', options.height);
  if (!height.ok) return height;
  const rows = options.heightSegments ?? 1;
  const checkedRows = requireSegments('heightSegments', rows, 1);
  if (!checkedRows.ok) return checkedRows;
  const { radiusTop: top, radiusBottom: bottom } = options;
  const half = options.height / 2;
  const profile: Point2[] = [];
  const caps = !(options.openEnded ?? false);
  if (caps && bottom > 0) profile.push([0, -half]);
  for (let k = 0; k <= rows; k++) {
    const t = k / rows;
    const r = k === 0 ? bottom : k === rows ? top : bottom + (top - bottom) * t;
    profile.push([r, k === rows ? half : -half + options.height * t]);
  }
  if (caps && top > 0) profile.push([0, half]);
  return closedShellRoles(
    mesh,
    revolveSurface(
      mesh,
      profile,
      { name: 'radialSegments', segments: options.radialSegments, angle: 360, startAngle: 0 },
      { side: 'side', start: 'bottom', end: 'top' },
      attribution,
      offsetBy(options.center),
    ),
    'report this input: a capped cylinder always encloses positive volume',
  );
}

export interface ConeOptions {
  readonly radius: number;
  readonly height: number;
  readonly radialSegments: number;
  readonly heightSegments?: number;
  readonly openEnded?: boolean;
  readonly center?: Tuple3;
}

/** Cone: apex at +height/2. Roles `side` and `bottom`. */
export function appendCone(
  mesh: EditMesh,
  options: ConeOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  const radius = requirePositive('radius', options.radius);
  if (!radius.ok) return radius;
  return appendCylinder(
    mesh,
    { ...options, radiusTop: 0, radiusBottom: options.radius },
    attribution,
  );
}

export interface SphereOptions {
  readonly radius: number;
  /** Segments around +Y (>= 3). */
  readonly widthSegments: number;
  /** Segments from pole to pole (>= 2). */
  readonly heightSegments: number;
  readonly center?: Tuple3;
}

/** Sphere: quad bands with triangle fans at the poles; role `face`. */
export function appendSphere(
  mesh: EditMesh,
  options: SphereOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  const radius = requirePositive('radius', options.radius);
  if (!radius.ok) return radius;
  const rows = requireSegments('heightSegments', options.heightSegments, 2);
  if (!rows.ok) return rows;
  const r = options.radius;
  const h = options.heightSegments;
  const profile: Point2[] = [[0, -r]];
  for (let k = 1; k < h; k++) {
    const theta = (Math.PI * k) / h;
    profile.push([r * sin(theta), -r * cos(theta)]);
  }
  profile.push([0, r]);
  return closedShellRoles(
    mesh,
    revolveSurface(
      mesh,
      profile,
      { name: 'widthSegments', segments: options.widthSegments, angle: 360, startAngle: 0 },
      { side: 'face', start: 'face', end: 'face' },
      attribution,
      offsetBy(options.center),
    ),
    'report this input: a sphere always encloses positive volume',
  );
}

export interface TorusOptions {
  /** Distance from the center to the middle of the tube. */
  readonly radius: number;
  /** Tube radius; less than `radius`. */
  readonly tube: number;
  /** Segments around the tube cross-section (>= 3). */
  readonly radialSegments: number;
  /** Segments along the ring. */
  readonly tubularSegments: number;
  /** Swept ring angle in degrees (default 360), starting at +X toward +Y. */
  readonly angle?: number;
  readonly center?: Tuple3;
}

/** Torus: the ring lies in XY around +Z; role `face`. */
export function appendTorus(
  mesh: EditMesh,
  options: TorusOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  for (const name of ['radius', 'tube'] as const) {
    const checked = requirePositive(name, options[name]);
    if (!checked.ok) return checked;
  }
  if (options.tube >= options.radius) {
    return err(
      modelingError('model-invalid-argument', 'tube is less than radius', {
        radius: options.radius,
        tube: options.tube,
      }),
    );
  }
  const sections = requireSegments('radialSegments', options.radialSegments, 3);
  if (!sections.ok) return sections;
  const angle = requireAngle(options.angle);
  if (!angle.ok) return angle;
  const profile: Point2[] = [];
  for (let k = 0; k < options.radialSegments; k++) {
    const v = (2 * Math.PI * k) / options.radialSegments;
    profile.push([options.radius + options.tube * cos(v), options.tube * sin(v)]);
  }
  profile.push(profile[0] as Point2);
  const offset = offsetBy(options.center);
  return closedShellRoles(
    mesh,
    revolveSurface(
      mesh,
      profile,
      {
        name: 'tubularSegments',
        segments: options.tubularSegments,
        angle: angle.value,
        startAngle: 90,
      },
      { side: 'face', start: 'face', end: 'face' },
      attribution,
      // Rotate the +Y revolve axis onto +Z (x, y, z) -> (x, -z, y).
      (x, y, z) => offset(x, -z, y),
    ),
    'report this input: a torus always encloses positive volume',
  );
}

// ---- extruded outline ------------------------------------------------------------------------

export interface ExtrudePolygonOptions {
  /** `[x, y]` outline in the XY plane, either winding; first == last is accepted. */
  readonly points: readonly Point2[];
  /** Outlines of through holes strictly inside `points`, either winding. */
  readonly holes?: readonly (readonly Point2[])[];
  /** Extent along +Z from z = 0. */
  readonly depth: number;
  /** Segments along the depth (default 1). */
  readonly steps?: number;
}

export function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  if (
    Math.max(a[0], b[0]) < Math.min(c[0], d[0]) ||
    Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
    Math.max(a[1], b[1]) < Math.min(c[1], d[1]) ||
    Math.max(c[1], d[1]) < Math.min(a[1], b[1])
  ) {
    return false;
  }
  const d1 = orient2d(a[0], a[1], b[0], b[1], c[0], c[1]);
  const d2 = orient2d(a[0], a[1], b[0], b[1], d[0], d[1]);
  const d3 = orient2d(c[0], c[1], d[0], d[1], a[0], a[1]);
  const d4 = orient2d(c[0], c[1], d[0], d[1], b[0], b[1]);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  const within = (p: Point2, q: Point2, r: Point2) =>
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1]);
  return (
    (d1 === 0 && within(a, b, c)) ||
    (d2 === 0 && within(a, b, d)) ||
    (d3 === 0 && within(c, d, a)) ||
    (d4 === 0 && within(c, d, b))
  );
}

function signedArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point2;
    const b = points[(i + 1) % points.length] as Point2;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area;
}

function insideOutline(outline: readonly Point2[], p: Point2): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i] as Point2;
    const b = outline[j] as Point2;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Validate the outline and its holes as one material domain: no loop crosses itself
 * or another, and every hole lies inside the outline and outside the other holes.
 * Returns the outline counter-clockwise and the holes clockwise.
 */
function readDomain(
  options: ExtrudePolygonOptions,
): Result<{ outline: Point2[]; holes: Point2[][] }, ModelingError> {
  const loops: Point2[][] = [];
  for (const [index, source] of [options.points, ...(options.holes ?? [])].entries()) {
    const read = readOutline(index === 0 ? 'points' : 'holes', source, 3);
    if (!read.ok) return read;
    loops.push(read.value.points);
  }
  const segments = loops.flatMap((loop, l) =>
    loop.map((_, i) => ({
      l,
      i,
      n: loop.length,
      a: loop[i] as Point2,
      b: loop[(i + 1) % loop.length] as Point2,
    })),
  );
  for (let s = 0; s < segments.length; s++) {
    const p = segments[s] as (typeof segments)[number];
    for (let t = s + 1; t < segments.length; t++) {
      const q = segments[t] as (typeof segments)[number];
      if (
        Math.max(p.a[0], p.b[0]) < Math.min(q.a[0], q.b[0]) ||
        Math.max(q.a[0], q.b[0]) < Math.min(p.a[0], p.b[0]) ||
        Math.max(p.a[1], p.b[1]) < Math.min(q.a[1], q.b[1]) ||
        Math.max(q.a[1], q.b[1]) < Math.min(p.a[1], p.b[1])
      )
        continue;
      if (p.l === q.l && ((q.i - p.i + p.n) % p.n <= 1 || (p.i - q.i + p.n) % p.n <= 1)) continue;
      if (segmentsCross(p.a, p.b, q.a, q.b)) {
        return err(
          modelingError(
            'model-invalid-argument',
            p.l === q.l
              ? 'the outline does not cross itself'
              : 'outline and holes do not cross or touch',
            p.l === q.l && p.l === 0
              ? { edges: [p.i, q.i] }
              : { loops: [p.l, q.l], edges: [p.i, q.i] },
          ),
        );
      }
    }
  }
  for (const [l, loop] of loops.entries()) {
    if (signedArea(loop) === 0) {
      return err(
        modelingError('model-degenerate', 'the outline has non-zero area', {
          ...(l === 0 ? {} : { hole: l - 1 }),
          points: loop,
        }),
      );
    }
  }
  const [outline, ...holes] = loops as [Point2[], ...Point2[][]];
  for (const [h, hole] of holes.entries()) {
    const probe = hole[0] as Point2;
    if (
      !insideOutline(outline, probe) ||
      holes.some((other, k) => k !== h && insideOutline(other, probe))
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'every hole lies inside the outline and outside the other holes',
          {
            hole: h,
          },
        ),
      );
    }
  }
  return ok({
    outline: signedArea(outline) < 0 ? [...outline].reverse() : outline,
    holes: holes.map((hole) => (signedArea(hole) > 0 ? [...hole].reverse() : hole)),
  });
}

/**
 * Extrude without bevel: caps at z = 0 (`bottom`) and z = depth
 * (`top`) with sharp rims, smooth `side` walls and, around each hole, smooth `hole`
 * walls. Without holes each cap is one n-gon; with holes each cap is a convex
 * partition of the domain (the same faces on both caps).
 */
export function appendExtrudePolygon(
  mesh: EditMesh,
  options: ExtrudePolygonOptions,
  attribution: Attribution,
  place: Place = (x, y, z) => [x, y, z],
): Result<RoleCounts, ModelingError> {
  const domain = readDomain(options);
  if (!domain.ok) return domain;
  const depth = requirePositive('depth', options.depth);
  if (!depth.ok) return depth;
  const steps = options.steps ?? 1;
  const checkedSteps = requireSegments('steps', steps, 1);
  if (!checkedSteps.ok) return checkedSteps;
  const { outline, holes } = domain.value;
  const loops = [outline, ...holes];
  const points = loops.flat();
  const starts: number[] = [];
  let offset = 0;
  for (const loop of loops) {
    starts.push(offset);
    offset += loop.length;
  }
  let caps: number[][] = [points.map((_, i) => i)];
  if (holes.length > 0) {
    const partition = convexPartition(
      points,
      outline.map((_, i) => i),
      holes.map((hole, h) => hole.map((_, i) => (starts[h + 1] as number) + i)),
    );
    if (!partition.ok) return partition;
    caps = partition.value;
  }
  const rings = Array.from({ length: steps + 1 }, (_, s) => {
    const z = s === steps ? options.depth : (options.depth * s) / steps;
    return points.map((p) => mesh.addVertex(...place(p[0], p[1], z)));
  });
  const bottom = rings[0] as number[];
  const top = rings[steps] as number[];
  const walls: number[][] = [];
  const holeWalls: number[][] = [];
  for (const [l, loop] of loops.entries()) {
    const base = starts[l] as number;
    const n = loop.length;
    for (let s = 0; s < steps; s++) {
      const lower = rings[s] as number[];
      const upper = rings[s + 1] as number[];
      for (let i = 0; i < n; i++) {
        const a = base + i;
        const b = base + ((i + 1) % n);
        (l === 0 ? walls : holeWalls).push([
          lower[a] as number,
          lower[b] as number,
          upper[b] as number,
          upper[a] as number,
        ]);
      }
    }
  }
  const counts: RoleCounts = {};
  const faces: number[] = [];
  for (const [role, faceLoops] of [
    ['side', walls],
    ['hole', holeWalls],
    ['top', caps.map((cap) => cap.map((i) => top[i] as number))],
    ['bottom', caps.map((cap) => cap.map((i) => bottom[i] as number).reverse())],
  ] as const) {
    if (faceLoops.length === 0) continue;
    const added = addFaces(mesh, faceLoops, attribution, role, counts);
    if (!added.ok) return added;
    pushAll(faces, added.value);
  }
  for (const ring of [bottom, top]) {
    for (const [l, loop] of loops.entries()) {
      const base = starts[l] as number;
      for (let i = 0; i < loop.length; i++) {
        const h = mesh.findHalf(
          ring[base + i] as number,
          ring[base + ((i + 1) % loop.length)] as number,
        );
        if (h !== NONE) mesh.eFlags[h >> 1] = mergeFlags(mesh.eFlags[h >> 1] as number, EDGE_SHARP);
      }
    }
  }
  const outward = requireOutwardShell(mesh, faces, 'report this input');
  if (!outward.ok) return outward;
  return ok(counts);
}
