import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { type LoopEdge, ShapeAssembler } from './assembler';
import type { ToleranceOptions } from './tolerance';
import { brepError, type Shape } from './types';
import { cross3, dist3, HALF_PI, type P2, type P3, sub3, unit3 } from './vec';

export interface DraftedPrismOptions extends ToleranceOptions {
  /** Convex outline in the world xy plane, either winding, without collinear vertices. */
  readonly profile: readonly P2[];
  /** Extent along +z from the bottom face at z = 0. */
  readonly height: number;
  /** Draft angle from the z axis in radians, 0 <= angle < pi/2. Sides lean inward as they rise. */
  readonly angle: number;
  readonly label?: string;
}

/**
 * A convex prism whose side faces are tilted inward by a draft angle. The bottom face is the
 * profile at z = 0; the top face is the profile mitred inward by `height * tan(angle)`, so each
 * side is a plane through its bottom edge and its inward-shifted top edge. Angle 0 is a plain
 * prism. Built from planes directly, with no boolean or loft.
 */
export function draftedPrism(options: DraftedPrismOptions): Result<Shape, ModelingError> {
  const bad = (why: string, ids?: Record<string, unknown>) =>
    err(brepError('brep-bad-argument', why, ids));
  const { profile, height, angle } = options;
  if (!(Number.isFinite(height) && height > 0)) {
    return bad('height is a finite number greater than 0');
  }
  if (!(Number.isFinite(angle) && angle >= 0 && angle < HALF_PI)) {
    return bad('angle is a finite number in [0, pi/2)');
  }
  if (!Array.isArray(profile) || profile.length < 3) return bad('profile of at least 3 points');
  if (!profile.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
    return bad('profile points are finite');
  }
  let twiceArea = 0;
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i] as P2;
    const q = profile[(i + 1) % profile.length] as P2;
    twiceArea += p[0] * q[1] - q[0] * p[1];
  }
  if (twiceArea === 0) return bad('profile with non-zero area');
  const ccw: P2[] = twiceArea > 0 ? [...profile] : [...profile].reverse();
  const n = ccw.length;
  const edge = (i: number): P2 => {
    const p = ccw[i] as P2;
    const q = ccw[(i + 1) % n] as P2;
    return [q[0] - p[0], q[1] - p[1]];
  };
  const inward: P2[] = [];
  for (let i = 0; i < n; i++) {
    const e = edge(i);
    const len = Math.sqrt(e[0] * e[0] + e[1] * e[1]);
    inward.push([-e[1] / len, e[0] / len]);
  }
  for (let i = 0; i < n; i++) {
    const a = edge(i);
    const b = edge((i + 1) % n);
    if (a[0] * b[1] - a[1] * b[0] <= 0) {
      return bad('profile convex without collinear vertices', { reason: 'profile-not-convex' });
    }
  }

  const d = (height * sin(angle)) / cos(angle);
  const top: P2[] = ccw.map((p, i) => {
    const a = inward[(i + n - 1) % n] as P2;
    const b = inward[i] as P2;
    const k = 1 + a[0] * b[0] + a[1] * b[1];
    return [p[0] + (d * (a[0] + b[0])) / k, p[1] + (d * (a[1] + b[1])) / k];
  });
  for (let i = 0; i < n; i++) {
    const e = edge(i);
    const t = top[i] as P2;
    const u = top[(i + 1) % n] as P2;
    if ((u[0] - t[0]) * e[0] + (u[1] - t[1]) * e[1] <= 0) {
      return bad('draft collapses the top outline', { reason: 'draft-collapses' });
    }
  }

  let lo: P2 = ccw[0] as P2;
  let hi: P2 = lo;
  for (const p of ccw) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
  }
  const ex = hi[0] - lo[0];
  const ey = hi[1] - lo[1];
  const diag = Math.sqrt(ex * ex + ey * ey + height * height);
  const made = ShapeAssembler.create(diag, options);
  if (!made.ok) return made;
  const asm = made.value;
  const label = options.label ?? 'drafted-prism';

  const lines = new Map<string, number>();
  const line = (a: P3, b: P3): LoopEdge => {
    const va = asm.vertex(a);
    const vb = asm.vertex(b);
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    let found = lines.get(key);
    if (found === undefined) {
      const curve = asm.curve({ kind: 'line', o: a, d: unit3(sub3(b, a)) });
      found = asm.edge(curve, 0, dist3(a, b));
      lines.set(key, found);
    }
    return { edge: found };
  };

  // A planar face with outward normal `normal`. The loop is reordered to counter-clockwise in
  // the face frame so that its boundary normal agrees with the surface normal.
  const planar = (pts: P3[], normal: P3, name: string): Result<number, ModelingError> => {
    const o = pts[0] as P3;
    const x = unit3(sub3(pts[1] as P3, o));
    const z = unit3(normal);
    const y = cross3(z, x);
    const coords = pts.map((p): P2 => {
      const v = sub3(p, o);
      return [v[0] * x[0] + v[1] * x[1] + v[2] * x[2], v[0] * y[0] + v[1] * y[1] + v[2] * y[2]];
    });
    let area = 0;
    for (let i = 0; i < coords.length; i++) {
      const p = coords[i] as P2;
      const q = coords[(i + 1) % coords.length] as P2;
      area += p[0] * q[1] - q[0] * p[1];
    }
    const loopPts = area > 0 ? pts : [...pts].reverse();
    const surface = asm.surface({ kind: 'plane', frame: { o, x, y, z } });
    const loop = loopPts.map((p, k) => line(p, loopPts[(k + 1) % loopPts.length] as P3));
    const l = asm.loop(surface, loop, true);
    if (!l.ok) return l;
    return ok(asm.face(surface, [l.value], false, name));
  };

  const at = (p: P2, z: number): P3 => [p[0], p[1], z];
  const faces: number[] = [];
  const add = (r: Result<number, ModelingError>): ModelingError | undefined => {
    if (!r.ok) return r.error;
    faces.push(r.value);
    return undefined;
  };
  const failure = [
    add(
      planar(
        ccw.map((p) => at(p, 0)),
        [0, 0, -1],
        `${label}.bottom`,
      ),
    ),
    add(
      planar(
        top.map((p) => at(p, height)),
        [0, 0, 1],
        `${label}.top`,
      ),
    ),
  ];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = at(ccw[i] as P2, 0);
    const q = at(ccw[j] as P2, 0);
    const t = at(top[i] as P2, height);
    const u = at(top[j] as P2, height);
    const dir = unit3(sub3(q, p));
    const up = sub3(t, p);
    const outward: P3 = [-(inward[i] as P2)[0], -(inward[i] as P2)[1], 0];
    let normal = cross3(dir, up);
    if (normal[0] * outward[0] + normal[1] * outward[1] < 0) {
      normal = [-normal[0], -normal[1], -normal[2]];
    }
    failure.push(add(planar([p, q, u, t], normal, `${label}.side${i}`)));
  }
  const first = failure.find((f) => f !== undefined);
  if (first !== undefined) return err(first);
  asm.shell(faces);
  return asm.finish();
}
