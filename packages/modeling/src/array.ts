import { err, ok, type Result } from '@forgeax/engine-types';
import { append, copyEdgeIntent } from './connect';
import { type Frame, type PathInput, pathFrames, pathLength, samplePath } from './curve';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  type Axis,
  add,
  axisVector,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  type Tuple3,
} from './geom';
import type { EditMesh } from './mesh';
import {
  type Attribution,
  detachFaces,
  markRole,
  type RoleCounts,
  requireFinite,
  requireSegments,
  restoreFace,
  sharedVertices,
} from './ops';

/**
 * Copy placement. Linear and radial keep the original as copy 0; onCurve moves the
 * original onto the curve as copy 0, with local +Z along the tangent and +Y along
 * the rotation-minimizing up direction when `align` is on.
 */
export type ArrayOptions =
  | { readonly linear: { readonly count: number; readonly offset: Tuple3 } }
  | {
      readonly radial: {
        readonly count: number;
        readonly axis: Axis | Tuple3;
        /** Degrees: 360 (default) spaces copies evenly; less places the last copy at `angle`. */
        readonly angle?: number;
        readonly center?: Tuple3;
      };
    }
  | {
      readonly onCurve: {
        readonly count: number;
        readonly path: PathInput;
        /** The path closes; copies then space evenly around it. */
        readonly closed?: boolean;
        /** Turn each copy with the curve frame (default true); false only translates. */
        readonly align?: boolean;
        /** Initial up direction of the curve frame (default +Y). */
        readonly up?: Tuple3;
      };
    };

/** Rigid placement `p -> r * p + t`; `r` is row-major. */
interface Placement {
  readonly r: readonly number[];
  readonly t: Tuple3;
}

const IDENTITY: Placement = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function apply(placement: Placement, p: Tuple3): Tuple3 {
  const { r, t } = placement;
  return [
    (r[0] as number) * p[0] + (r[1] as number) * p[1] + (r[2] as number) * p[2] + t[0],
    (r[3] as number) * p[0] + (r[4] as number) * p[1] + (r[5] as number) * p[2] + t[1],
    (r[6] as number) * p[0] + (r[7] as number) * p[1] + (r[8] as number) * p[2] + t[2],
  ];
}

function isIdentity(placement: Placement): boolean {
  return (
    placement.r.every((v, i) => v === (IDENTITY.r[i] as number)) &&
    placement.t.every((v) => v === 0)
  );
}

function requireVector(name: string, v: Tuple3): Result<Tuple3, ModelingError> {
  for (const c of v) {
    const checked = requireFinite(name, c);
    if (!checked.ok) return checked;
  }
  return ok(v);
}

/** Rotation by `degrees` about the unit `axis` through `center` (Rodrigues, right-handed). */
function rotation(axis: Tuple3, degrees: number, center: Tuple3): Placement {
  const a = ((degrees % 360) * Math.PI) / 180;
  const c = cos(a);
  const s = sin(a);
  const [x, y, z] = axis;
  const k = 1 - c;
  const r = [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
  ];
  const turned = apply({ r, t: [0, 0, 0] }, center);
  return { r, t: sub(center, turned) };
}

function frameAt(
  frames: readonly Frame[],
  closed: boolean,
  total: number,
  s: number,
): { point: Tuple3; x: Tuple3; y: Tuple3; z: Tuple3 } {
  const n = frames.length;
  let i = 0;
  while (i + 1 < n && (frames[i + 1] as Frame).s <= s) i++;
  const a = frames[i] as Frame;
  const last = i === n - 1;
  if (last && !closed) return { point: a.point, x: a.x, y: a.y, z: a.tangent };
  const b = frames[(i + 1) % n] as Frame;
  const end = last ? total : b.s;
  const w = end > a.s ? (s - a.s) / (end - a.s) : 0;
  const point = add(a.point, scale(sub(b.point, a.point), w));
  const z = normalize(add(scale(a.tangent, 1 - w), scale(b.tangent, w)));
  const blended = add(scale(a.y, 1 - w), scale(b.y, w));
  const y = normalize(sub(blended, scale(z, dot(blended, z))));
  return { point, x: cross(y, z), y, z };
}

function placements(options: ArrayOptions, tolerance: number): Result<Placement[], ModelingError> {
  const keys = Object.keys(options).filter(
    (k) => k === 'linear' || k === 'radial' || k === 'onCurve',
  );
  if (keys.length !== 1) {
    return err(
      modelingError('model-invalid-argument', 'exactly one of linear, radial or onCurve', {
        modes: keys,
      }),
    );
  }
  if ('linear' in options) {
    const { count, offset } = options.linear;
    const checkedCount = requireSegments('linear.count', count, 2);
    if (!checkedCount.ok) return checkedCount;
    const checked = requireVector('linear.offset', offset);
    if (!checked.ok) return checked;
    if (length(offset) <= tolerance) {
      return err(
        modelingError('model-invalid-argument', 'linear.offset is longer than the tolerance', {
          offset,
        }),
      );
    }
    return ok(Array.from({ length: count }, (_, i) => ({ r: IDENTITY.r, t: scale(offset, i) })));
  }
  if ('radial' in options) {
    const { count, angle = 360, center = [0, 0, 0] } = options.radial;
    const checkedCount = requireSegments('radial.count', count, 2);
    if (!checkedCount.ok) return checkedCount;
    const checkedAngle = requireFinite('radial.angle', angle);
    if (!checkedAngle.ok) return checkedAngle;
    if (angle <= 0 || angle > 360) {
      return err(
        modelingError('model-invalid-argument', 'radial.angle is in degrees, within (0, 360]', {
          angle,
        }),
      );
    }
    const checkedCenter = requireVector('radial.center', center);
    if (!checkedCenter.ok) return checkedCenter;
    const raw =
      typeof options.radial.axis === 'string'
        ? axisVector(options.radial.axis)
        : options.radial.axis;
    const checkedAxis = requireVector('radial.axis', raw);
    if (!checkedAxis.ok) return checkedAxis;
    if (length(raw) === 0)
      return err(
        modelingError('model-invalid-argument', 'radial.axis is a non-zero vector', { axis: raw }),
      );
    const axis = normalize(raw);
    const step = angle === 360 ? 360 / count : angle / (count - 1);
    return ok(
      Array.from({ length: count }, (_, i) =>
        i === 0 ? IDENTITY : rotation(axis, step * i, center),
      ),
    );
  }
  const { count, path, closed = false, align = true, up = [0, 1, 0] } = options.onCurve;
  const checkedCount = requireSegments('onCurve.count', count, 1);
  if (!checkedCount.ok) return checkedCount;
  const checkedUp = requireVector('onCurve.up', up);
  if (!checkedUp.ok) return checkedUp;
  const sampled = samplePath(path, closed, tolerance);
  if (!sampled.ok) return sampled;
  const framed = pathFrames(sampled.value, closed, 'rmf', length(up) === 0 ? [0, 1, 0] : up);
  if (!framed.ok) return framed;
  const total = pathLength(sampled.value, closed);
  return ok(
    Array.from({ length: count }, (_, i) => {
      const s = closed ? (total * i) / count : count === 1 ? 0 : (total * i) / (count - 1);
      const f = frameAt(framed.value, closed, total, s);
      const r = align
        ? [f.x[0], f.y[0], f.z[0], f.x[1], f.y[1], f.z[1], f.x[2], f.y[2], f.z[2]]
        : IDENTITY.r;
      return { r, t: f.point };
    }),
  );
}

export type ArrayTarget = { readonly faces: readonly number[] } | { readonly source: EditMesh };

/**
 * Merge `count` rigidly placed copies of faces (or of another mesh) into the mesh.
 * Copy `i` gets tag `<prefix>:<i>`; with a label, the new copies get role `copy`,
 * otherwise they keep their source origins (design 6.1: roles survive arrays).
 * Selected faces that move (onCurve) must not share vertices with other faces.
 */
export function arrayCopies(
  mesh: EditMesh,
  target: ArrayTarget,
  options: ArrayOptions,
  attribution: Attribution,
  prefix: string,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const placed = placements(options, tolerance);
  if (!placed.ok) return placed;
  const counts: RoleCounts = {};
  const tagOf = (i: number) => mesh.tagIndex(`${prefix}:${i}`, true);
  const decorate = (faces: readonly number[], i: number) => {
    const tag = tagOf(i);
    for (const f of faces) {
      mesh.addTag(f, tag);
      if (attribution.tag >= 0) mesh.addTag(f, attribution.tag);
    }
  };
  if ('source' in target) {
    for (const [i, placement] of placed.value.entries()) {
      const before = new Set(mesh.faces());
      const appended = append(mesh, target.source, {}, { label: 0, material: 0, tag: -1 });
      if (!appended.ok) return appended;
      const added = mesh.faces().filter((f) => !before.has(f));
      const vertices = new Set<number>();
      for (const f of added) for (const v of mesh.faceVertices(f)) vertices.add(v);
      for (const v of vertices) mesh.setPosition(v, ...apply(placement, mesh.position(v)));
      decorate(added, i);
      markRole(mesh, added, attribution.label, 'copy', counts);
    }
    return ok(counts);
  }
  const faces = target.faces;
  const first = placed.value[0] as Placement;
  if (!isIdentity(first)) {
    const shared = sharedVertices(mesh, faces, false);
    if (shared.size > 0) {
      return err(
        modelingError(
          'model-precondition',
          'the arrayed faces share no vertex with other faces (onCurve moves the original)',
          { sharedVertices: shared.size },
          'select whole parts, or disconnect() the faces first',
        ),
      );
    }
  }
  const saved = detachFaces(mesh, faces);
  const scratch = mesh.clone();
  const originals = new Set<number>();
  for (const s of saved) for (const v of s.loop) originals.add(v);
  for (const [i, placement] of placed.value.entries()) {
    if (i === 0) {
      for (const v of originals) mesh.setPosition(v, ...apply(placement, scratch.position(v)));
      decorate(faces, 0);
      if (!isIdentity(placement)) counts.moved = faces.length;
      continue;
    }
    const copyOf = new Map<number, number>();
    for (const v of originals)
      copyOf.set(v, mesh.addVertex(...apply(placement, scratch.position(v))));
    const copies: number[] = [];
    for (const s of saved) {
      const restored = restoreFace(mesh, scratch, s, (v) => copyOf.get(v) as number);
      if (!restored.ok) return restored;
      copies.push(restored.value);
    }
    copyEdgeIntent(
      scratch,
      mesh,
      saved.map((s) => s.loop),
      (v) => copyOf.get(v) as number,
    );
    decorate(copies, i);
    markRole(mesh, copies, attribution.label, 'copy', counts);
  }
  return ok(counts);
}
