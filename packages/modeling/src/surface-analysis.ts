import type { MeshAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import { overlayMesh } from './diagnostics';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  checkCurve,
  checkSurface,
  curveCurvature,
  domain,
  type NurbsCurve,
  type NurbsSurface,
  surfaceCurvature,
  surfaceDerivatives,
  surfaceDomain,
} from './nurbs';

/**
 * Surface-quality views: zebra stripes, Gaussian and mean curvature
 * shading and curvature combs. Values come from the exact NURBS patch where a render
 * vertex still lies on one (found through its uv1 normalized patch coordinates), else
 * from a quadric fitted to the vertex's mesh neighbourhood around its smoothed normal.
 */
export interface SurfaceField {
  readonly positions: Float64Array;
  readonly normals: Float64Array;
  readonly indices: Uint32Array;
  readonly gaussian: Float64Array;
  readonly mean: Float64Array;
  /** Patch index (into the given surfaces) of exact vertices, -1 for mesh estimates. */
  readonly patch: Int32Array;
  /** Patch parameters (u, v) of exact vertices. */
  readonly parameters: Float64Array;
  readonly exactVertices: number;
}

/** Triangles with per-vertex RGBA, ready for an unlit vertex-color material. */
export interface ColoredTriangles {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly triangles: number;
}

/** Colored triangles as a MeshAsset (one `analysis` slot) for an unlit vertex-color material. */
export function coloredMesh(colored: ColoredTriangles): Result<MeshAsset, ModelingError> {
  const count = colored.positions.length / 3;
  if (count === 0 || colored.colors.length !== count * 4)
    return err(invalid('colored triangles hold one RGBA per vertex', { vertices: count }));
  return overlayMesh({ position: colored.positions, color: colored.colors }, 'triangle-list', {
    slot: 'analysis',
  });
}

export interface SurfaceFieldOptions {
  /** Largest distance between a render vertex and its patch point to count as exact (default 2e-5 m). */
  readonly tolerance?: number;
}

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Tuple3): Tuple3 => {
  const l = Math.sqrt(dot(a, a));
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

function invalid(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

function read3(data: ArrayLike<number>, i: number): Tuple3 {
  return [data[3 * i] as number, data[3 * i + 1] as number, data[3 * i + 2] as number];
}

/** Triangle indices of every triangle-list submesh. */
function meshTriangles(mesh: MeshAsset): Result<Uint32Array, ModelingError> {
  const position = mesh.attributes.position;
  if (!(position instanceof Float32Array) || position.length % 3 !== 0)
    return err(modelingError('model-precondition', 'the mesh carries float32 xyz positions', {}));
  const count = position.length / 3;
  const out: number[] = [];
  for (const submesh of mesh.submeshes) {
    if (submesh.topology !== 'triangle-list') continue;
    for (let i = submesh.indexOffset; i < submesh.indexOffset + submesh.indexCount; i++) {
      const r = mesh.indices === undefined ? i : (mesh.indices[i] as number);
      if (!(Number.isInteger(r) && r >= 0 && r < count))
        return err(
          modelingError('model-precondition', 'every index addresses a vertex', { at: i }),
        );
      out.push(r);
    }
  }
  if (out.length === 0)
    return err(modelingError('model-precondition', 'the mesh has triangles', {}));
  return ok(Uint32Array.from(out));
}

/** Quadric z = a x^2 + b x y + c y^2 over the neighbours in the tangent frame of `n`. */
function fitCurvature(p: Tuple3, n: Tuple3, neighbours: readonly Tuple3[]): [number, number] {
  const helper: Tuple3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross(n, helper));
  const e2 = cross(n, e1);
  // Normal equations of the 3-parameter least squares.
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  for (const q of neighbours) {
    const d = sub(q, p);
    const x = dot(d, e1);
    const y = dot(d, e2);
    const z = dot(d, n);
    const row = [x * x, x * y, y * y];
    for (let i = 0; i < 3; i++) {
      r[i] = (r[i] as number) + (row[i] as number) * z;
      for (let j = 0; j < 3; j++)
        m[3 * i + j] = (m[3 * i + j] as number) + (row[i] as number) * (row[j] as number);
    }
  }
  const [a, b, c] = solve3(m, r);
  return [4 * a * c - b * b, a + c];
}

function solve3(m: number[], r: number[]): [number, number, number] {
  const det = (q: number[]) =>
    (q[0] as number) * ((q[4] as number) * (q[8] as number) - (q[5] as number) * (q[7] as number)) -
    (q[1] as number) * ((q[3] as number) * (q[8] as number) - (q[5] as number) * (q[6] as number)) +
    (q[2] as number) * ((q[3] as number) * (q[7] as number) - (q[4] as number) * (q[6] as number));
  const d = det(m);
  if (!(Math.abs(d) > 1e-30)) return [0, 0, 0];
  const column = (k: number) =>
    m.map((v, i) => (i % 3 === k ? (r[Math.floor(i / 3)] as number) : v));
  return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d];
}

/**
 * Normals and curvatures of every render vertex. Exact where the vertex's uv1 maps to a
 * point of one of `surfaces` within `tolerance` (normals then follow the mesh side);
 * elsewhere the mesh normal and a quadric fit over the vertex's one-ring (two-ring when
 * the one-ring has fewer than five vertices), with vertices welded by position and
 * normal so UV seams do not cut the neighbourhood while sharp edges do.
 */
export function surfaceField(
  mesh: MeshAsset,
  surfaces: readonly NurbsSurface[] = [],
  options: SurfaceFieldOptions = {},
): Result<SurfaceField, ModelingError> {
  const tolerance = options.tolerance ?? 2e-5;
  if (!(typeof tolerance === 'number' && Number.isFinite(tolerance) && tolerance > 0))
    return err(invalid('tolerance is positive', { tolerance }));
  for (const [index, surface] of surfaces.entries()) {
    const checked = checkSurface(surface);
    if (!checked.ok)
      return err({ ...checked.error, detail: { ...checked.error.detail, surface: index } });
  }
  const triangles = meshTriangles(mesh);
  if (!triangles.ok) return triangles;
  const indices = triangles.value;
  const position = mesh.attributes.position as Float32Array;
  const count = position.length / 3;
  const normal =
    mesh.attributes.normal instanceof Float32Array ? mesh.attributes.normal : undefined;
  const uv1 = mesh.attributes.uv1 instanceof Float32Array ? mesh.attributes.uv1 : undefined;
  const positions = Float64Array.from(position);
  const normals = new Float64Array(count * 3);
  if (normal !== undefined && normal.length === count * 3) normals.set(normal);
  else {
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]] as [number, number, number];
      const n = cross(
        sub(read3(positions, b), read3(positions, a)),
        sub(read3(positions, c), read3(positions, a)),
      );
      for (const v of [a, b, c])
        for (let k = 0; k < 3; k++)
          normals[3 * v + k] = (normals[3 * v + k] as number) + (n[k] as number);
    }
  }
  for (let v = 0; v < count; v++) normals.set(unit(read3(normals, v)), 3 * v);
  const gaussian = new Float64Array(count);
  const mean = new Float64Array(count);
  const patch = new Int32Array(count).fill(-1);
  const parameters = new Float64Array(count * 2);
  const boxes = surfaces.map((s) => {
    const lo: Tuple3 = [Infinity, Infinity, Infinity];
    const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
    for (const row of s.points)
      for (const p of row)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k] as number, (p[k] as number) - tolerance);
          hi[k] = Math.max(hi[k] as number, (p[k] as number) + tolerance);
        }
    return { lo, hi, domain: surfaceDomain(s) };
  });
  let exactVertices = 0;
  if (uv1 !== undefined && uv1.length === count * 2 && surfaces.length > 0) {
    for (let v = 0; v < count; v++) {
      const p = read3(positions, v);
      const s = uv1[2 * v] as number;
      const t = uv1[2 * v + 1] as number;
      if (!(s >= -1e-6 && s <= 1 + 1e-6 && t >= -1e-6 && t <= 1 + 1e-6)) continue;
      for (const [i, surface] of surfaces.entries()) {
        const box = boxes[i] as (typeof boxes)[number];
        if (
          [0, 1, 2].some(
            (k) =>
              (p[k] as number) < (box.lo[k] as number) || (p[k] as number) > (box.hi[k] as number),
          )
        )
          continue;
        const [[u0, u1], [v0, v1]] = box.domain;
        let u = u0 + (u1 - u0) * Math.min(1, Math.max(0, s));
        let w = v0 + (v1 - v0) * Math.min(1, Math.max(0, t));
        const start = (surfaceDerivatives(surface, u, w, 0)[0] as Tuple3[])[0] as Tuple3;
        if (Math.sqrt(dot(sub(start, p), sub(start, p))) > tolerance) continue;
        // One Gauss-Newton step removes the float32 rounding of uv1.
        const d = surfaceDerivatives(surface, u, w, 1);
        const su = (d[1] as Tuple3[])[0] as Tuple3;
        const sv = (d[0] as Tuple3[])[1] as Tuple3;
        const r = sub(p, start);
        const E = dot(su, su);
        const F = dot(su, sv);
        const G = dot(sv, sv);
        const det = E * G - F * F;
        if (det > 0) {
          u = Math.min(u1, Math.max(u0, u + (G * dot(su, r) - F * dot(sv, r)) / det));
          w = Math.min(v1, Math.max(v0, w + (E * dot(sv, r) - F * dot(su, r)) / det));
        }
        const c = surfaceCurvature(surface, u, w);
        if (c === undefined) continue;
        const flip = dot(c.normal, read3(normals, v)) < 0 ? -1 : 1;
        normals.set([c.normal[0] * flip, c.normal[1] * flip, c.normal[2] * flip], 3 * v);
        gaussian[v] = c.gaussian;
        mean[v] = c.mean * flip;
        patch[v] = i;
        parameters[2 * v] = u;
        parameters[2 * v + 1] = w;
        exactVertices++;
        break;
      }
    }
  }
  if (exactVertices < count) {
    // Weld render vertices that share position and normal into smooth vertices.
    const key = (v: number) =>
      `${position[3 * v]},${position[3 * v + 1]},${position[3 * v + 2]}|${normals[3 * v]},${normals[3 * v + 1]},${normals[3 * v + 2]}`;
    const ids = new Map<string, number>();
    const weld = new Int32Array(count);
    for (let v = 0; v < count; v++) {
      const k = key(v);
      let id = ids.get(k);
      if (id === undefined) {
        id = ids.size;
        ids.set(k, id);
      }
      weld[v] = id;
    }
    const rings: Set<number>[] = Array.from({ length: ids.size }, () => new Set<number>());
    const anyVertex = new Int32Array(ids.size);
    for (let v = 0; v < count; v++) anyVertex[weld[v] as number] = v;
    for (let t = 0; t < indices.length; t += 3) {
      const tri = [
        weld[indices[t] as number],
        weld[indices[t + 1] as number],
        weld[indices[t + 2] as number],
      ] as number[];
      for (let k = 0; k < 3; k++)
        for (let j = 0; j < 3; j++)
          if (j !== k) (rings[tri[k] as number] as Set<number>).add(tri[j] as number);
    }
    const values = new Map<number, [number, number]>();
    for (let v = 0; v < count; v++) {
      if ((patch[v] as number) >= 0) continue;
      const id = weld[v] as number;
      let value = values.get(id);
      if (value === undefined) {
        const ring = new Set(rings[id]);
        if (ring.size < 5)
          for (const q of [...ring])
            for (const r of rings[q] as Set<number>) if (r !== id) ring.add(r);
        const neighbours = [...ring].map((q) => read3(positions, anyVertex[q] as number));
        value =
          neighbours.length >= 3
            ? fitCurvature(read3(positions, v), read3(normals, v), neighbours)
            : [0, 0];
        values.set(id, value);
      }
      gaussian[v] = value[0];
      mean[v] = value[1];
    }
  }
  return ok({ positions, normals, indices, gaussian, mean, patch, parameters, exactVertices });
}

export type CurvatureKind = 'gaussian' | 'mean';

export interface CurvatureShadingOptions {
  readonly kind: CurvatureKind;
  /**
   * Values mapped to the ends of the diverging map (1/m^2 for Gaussian, 1/m for mean);
   * default per scene: the 95th percentile of |value|.
   */
  readonly range?: number;
}

const NEGATIVE: Tuple3 = [0.15, 0.3, 0.95];
const ZERO: Tuple3 = [0.96, 0.96, 0.96];
const POSITIVE: Tuple3 = [0.92, 0.18, 0.12];

/**
 * Diverging blue-white-red color of `x` in [-1, 1], as linear RGB for a vertex-color
 * material: the display color is interpolated, then squared (gamma 2 into linear).
 */
export function divergingColor(x: number): Tuple3 {
  const t = Math.min(1, Math.max(-1, x));
  const end = t < 0 ? NEGATIVE : POSITIVE;
  const a = Math.abs(t);
  const display = (k: 0 | 1 | 2) => ZERO[k] + (end[k] - ZERO[k]) * a;
  return [display(0) * display(0), display(1) * display(1), display(2) * display(2)];
}

/** Curvature-shaded triangles and the range the colors span. */
export function curvatureShading(
  field: SurfaceField,
  options: CurvatureShadingOptions,
): Result<
  ColoredTriangles & { readonly range: number; readonly kind: CurvatureKind },
  ModelingError
> {
  if (options.kind !== 'gaussian' && options.kind !== 'mean')
    return err(invalid('kind is gaussian or mean', { kind: options.kind }));
  const values = options.kind === 'gaussian' ? field.gaussian : field.mean;
  let range = options.range;
  if (range === undefined) {
    const sorted = Array.from(values, Math.abs).sort((a, b) => a - b);
    range = (sorted[Math.floor(0.95 * (sorted.length - 1))] as number) || 1;
  }
  if (!(Number.isFinite(range) && range > 0)) return err(invalid('range is positive', { range }));
  const n = field.indices.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = field.indices[i] as number;
    positions.set(field.positions.subarray(3 * v, 3 * v + 3), 3 * i);
    const c = divergingColor((values[v] as number) / range);
    colors.set([c[0], c[1], c[2], 1], 4 * i);
  }
  return ok({ positions, colors, triangles: n / 3, range, kind: options.kind });
}

export interface ZebraOptions {
  /** Eye position (perspective) or, with `direction`, an orthographic view. */
  readonly eye?: Tuple3;
  /** Direction from the subject toward the eye (orthographic views). */
  readonly direction?: Tuple3;
  /** Screen axes of the camera; the stripes run along `right` turned by `orientation`. */
  readonly right: Tuple3;
  readonly up: Tuple3;
  /** Angular width of one stripe of the light tube environment, degrees (default 4). */
  readonly width?: number;
  /** Stripe direction, degrees counter-clockwise from screen right (default 0: horizontal). */
  readonly orientation?: number;
  /** Largest triangle subdivision depth where stripes cross densely (default 3). */
  readonly refine?: number;
}

/** Linear stripe colors (display 0.94 and 0.06, squared). */
const LIGHT: readonly number[] = [0.8836, 0.8836, 0.8836, 1];
const DARK: readonly number[] = [0.0036, 0.0036, 0.0049, 1];

interface ZebraVertex {
  readonly p: Tuple3;
  readonly n: Tuple3;
  readonly patch: number;
  readonly u: number;
  readonly v: number;
}

/**
 * The reflection-line field shared by `zebraStripes` and `highlightLines`: the view ray
 * at `p` reflected about the normal `n`, as its angle around the stripe axis divided by
 * the stripe width, so stripe borders (reflection lines) lie at integral values. `period`
 * is the value range of one turn; the branch cut faces away from the viewer.
 * @internal
 */
export function reflectionPhase(options: ZebraOptions): Result<
  {
    readonly phase: (p: Tuple3, n: Tuple3) => number;
    /** Cosine of the angle between the reflected ray and the stripe axis (1 at the pole). */
    readonly axial: (p: Tuple3, n: Tuple3) => number;
    readonly period: number;
  },
  ModelingError
> {
  const width = options.width ?? 4;
  if (!(Number.isFinite(width) && width > 0 && width <= 90))
    return err(invalid('stripe width is in (0, 90] degrees', { width }));
  if ((options.eye === undefined) === (options.direction === undefined))
    return err(invalid('a zebra view gives either an eye or a direction', {}));
  const orientation = ((options.orientation ?? 0) * Math.PI) / 180;
  const right = unit(options.right);
  const up = unit(options.up);
  const toward = unit(cross(right, up));
  // Stripe axis in the screen plane; the reference direction faces the viewer.
  const ca = cos(orientation);
  const sa = sin(orientation);
  const axis = unit([
    right[0] * ca + up[0] * sa,
    right[1] * ca + up[1] * sa,
    right[2] * ca + up[2] * sa,
  ]);
  const e1 = toward;
  const e2 = cross(axis, e1);
  const step = (width * Math.PI) / 180;
  const direction = options.direction;
  const eye = options.eye as Tuple3;
  const reflected = (p: Tuple3, n: Tuple3): Tuple3 => {
    const view =
      direction !== undefined
        ? unit([-direction[0], -direction[1], -direction[2]])
        : unit(sub(p, eye));
    const k = 2 * dot(view, n);
    return [view[0] - k * n[0], view[1] - k * n[1], view[2] - k * n[2]];
  };
  const phase = (p: Tuple3, n: Tuple3): number => {
    const r = reflected(p, n);
    return atan2(dot(r, e2), dot(r, e1)) / step;
  };
  const axial = (p: Tuple3, n: Tuple3): number => Math.abs(dot(unit(reflected(p, n)), axis));
  return ok({ phase, axial, period: (2 * Math.PI) / step });
}

/**
 * Zebra stripes: each point reflects the view ray about its normal, and the reflected
 * direction's angle around the stripe axis picks a stripe of a cylinder of parallel
 * light tubes. Triangles are split exactly along the stripe borders of the linearly
 * interpolated angle; triangles spanning more than two stripes subdivide first,
 * re-evaluating exact patch points and normals when all three corners lie on one patch.
 */
export function zebraStripes(
  field: SurfaceField,
  surfaces: readonly NurbsSurface[],
  options: ZebraOptions,
): Result<ColoredTriangles, ModelingError> {
  const width = options.width ?? 4;
  const refine = options.refine ?? 3;
  if (!(Number.isFinite(width) && width > 0 && width <= 90))
    return err(invalid('stripe width is in (0, 90] degrees', { width }));
  if (!(Number.isInteger(refine) && refine >= 0 && refine <= 6))
    return err(invalid('refine is an integer from 0 to 6', { refine }));
  const reflection = reflectionPhase(options);
  if (!reflection.ok) return reflection;
  const { period } = reflection.value;
  const phase = (x: ZebraVertex): number => reflection.value.phase(x.p, x.n);
  const vertexOf = (i: number): ZebraVertex => {
    const v = field.indices[i] as number;
    return {
      p: read3(field.positions, v),
      n: read3(field.normals, v),
      patch: field.patch[v] as number,
      u: field.parameters[2 * v] as number,
      v: field.parameters[2 * v + 1] as number,
    };
  };
  const midpoint = (a: ZebraVertex, b: ZebraVertex): ZebraVertex => {
    if (a.patch >= 0 && a.patch === b.patch) {
      const u = (a.u + b.u) / 2;
      const v = (a.v + b.v) / 2;
      const c = surfaceCurvature(surfaces[a.patch] as NurbsSurface, u, v);
      if (c !== undefined) {
        const flip = dot(c.normal, a.n) < 0 ? -1 : 1;
        return {
          p: c.point,
          n: [c.normal[0] * flip, c.normal[1] * flip, c.normal[2] * flip],
          patch: a.patch,
          u,
          v,
        };
      }
    }
    return {
      p: [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (a.p[2] + b.p[2]) / 2],
      n: unit([a.n[0] + b.n[0], a.n[1] + b.n[1], a.n[2] + b.n[2]]),
      patch: -1,
      u: 0,
      v: 0,
    };
  };
  const positions: number[] = [];
  const colors: number[] = [];
  const emit = (corners: readonly ZebraVertex[], values: readonly number[]) => {
    // Unwrap the angle across the branch cut behind the viewer.
    const f = [...values];
    const lo = minOf(f);
    for (let k = 0; k < 3; k++)
      if ((f[k] as number) - lo > period / 2) f[k] = (f[k] as number) - period;
    const min = Math.floor(minOf(f));
    const max = Math.floor(maxOf(f));
    for (let band = min; band <= max; band++) {
      let polygon = corners.map((c, k) => ({ p: c.p, f: f[k] as number }));
      polygon = clip(polygon, band, 1);
      polygon = clip(polygon, band + 1, -1);
      if (polygon.length < 3) continue;
      const color = (band & 1) === 0 ? LIGHT : DARK;
      for (let k = 1; k + 1 < polygon.length; k++)
        for (const q of [polygon[0], polygon[k], polygon[k + 1]] as typeof polygon) {
          pushAll(positions, q.p);
          pushAll(colors, color);
        }
    }
  };
  const triangle = (a: ZebraVertex, b: ZebraVertex, c: ZebraVertex, depth: number) => {
    const values = [phase(a), phase(b), phase(c)];
    const spread = maxOf(values) - minOf(values);
    if (depth < refine && spread > 2 && spread < period / 2) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca2 = midpoint(c, a);
      triangle(a, ab, ca2, depth + 1);
      triangle(ab, b, bc, depth + 1);
      triangle(ca2, bc, c, depth + 1);
      triangle(ab, bc, ca2, depth + 1);
      return;
    }
    emit([a, b, c], values);
  };
  for (let i = 0; i < field.indices.length; i += 3)
    triangle(vertexOf(i), vertexOf(i + 1), vertexOf(i + 2), 0);
  return ok({
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colors),
    triangles: positions.length / 9,
  });
}

/** Keep the part of a polygon where `sign * (f - level) >= 0`, interpolating along edges. */
function clip(
  polygon: readonly { p: Tuple3; f: number }[],
  level: number,
  sign: 1 | -1,
): { p: Tuple3; f: number }[] {
  const out: { p: Tuple3; f: number }[] = [];
  for (let k = 0; k < polygon.length; k++) {
    const a = polygon[k] as { p: Tuple3; f: number };
    const b = polygon[(k + 1) % polygon.length] as { p: Tuple3; f: number };
    const da = sign * (a.f - level);
    const db = sign * (b.f - level);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push({
        p: [
          a.p[0] + (b.p[0] - a.p[0]) * t,
          a.p[1] + (b.p[1] - a.p[1]) * t,
          a.p[2] + (b.p[2] - a.p[2]) * t,
        ],
        f: level,
      });
    }
  }
  return out;
}

export interface CombOptions {
  /** Samples along the curve (default 64, 2 to 1024). */
  readonly samples?: number;
  /**
   * Tooth length per unit curvature, meters^2; default: the longest tooth is 15 % of the
   * curve length, less on gentle lines (curvature below 1 / length counts as 1 / length).
   */
  readonly scale?: number;
}

export interface CurvatureComb {
  /** Line-list positions: the teeth, then the envelope through their tips. */
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly scale: number;
  readonly maxCurvature: number;
}

const TOOTH: readonly number[] = [0.2, 0.75, 1, 1];
const ENVELOPE: readonly number[] = [1, 0.55, 0.1, 1];

/**
 * Curvature comb of a curve: at each sample a tooth from the curve away from its center
 * of curvature, of length curvature x `scale`, and the envelope through the tooth tips.
 * Teeth jump to the other side at an inflection.
 */
export function curvatureComb(
  curve: NurbsCurve,
  options: CombOptions = {},
): Result<CurvatureComb, ModelingError> {
  const checked = checkCurve(curve);
  if (!checked.ok) return checked;
  const samples = options.samples ?? 64;
  if (!(Number.isInteger(samples) && samples >= 2 && samples <= 1024))
    return err(invalid('comb samples is an integer from 2 to 1024', { samples }));
  if (options.scale !== undefined && !(Number.isFinite(options.scale) && options.scale > 0))
    return err(invalid('comb scale is positive', { scale: options.scale }));
  const [t0, t1] = domain(curve);
  const points = Array.from({ length: samples }, (_, k) =>
    curveCurvature(curve, t0 + ((t1 - t0) * k) / (samples - 1)),
  );
  let length = 0;
  for (let k = 1; k < samples; k++) {
    const d = sub(
      (points[k] as (typeof points)[number]).point,
      (points[k - 1] as (typeof points)[number]).point,
    );
    length += Math.sqrt(dot(d, d));
  }
  const maxCurvature = maxOf(points.map((p) => p.curvature));
  // Gentle lines keep short teeth: the default never scales curvature below 1 / length up.
  const scale =
    options.scale ?? (length > 0 ? (0.15 * length) / Math.max(maxCurvature, 1 / length) : 0);
  const positions: number[] = [];
  const colors: number[] = [];
  const tips = points.map(
    (c): Tuple3 => [
      c.point[0] - c.normal[0] * c.curvature * scale,
      c.point[1] - c.normal[1] * c.curvature * scale,
      c.point[2] - c.normal[2] * c.curvature * scale,
    ],
  );
  for (const [k, c] of points.entries()) {
    positions.push(...c.point, ...(tips[k] as Tuple3));
    colors.push(...TOOTH, ...TOOTH);
  }
  for (let k = 1; k < samples; k++) {
    positions.push(...(tips[k - 1] as Tuple3), ...(tips[k] as Tuple3));
    colors.push(...ENVELOPE, ...ENVELOPE);
  }
  return ok({
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colors),
    scale,
    maxCurvature,
  });
}
