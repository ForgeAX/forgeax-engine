import { err, type Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { type LoopEdge, ShapeAssembler } from './assembler';
import type { ToleranceOptions } from './tolerance';
import { brepError, type Frame, type Shape } from './types';
import { cross3, dist3, type P2, type P3, sub3, unit3 } from './vec';

export interface FilletPrismOptions extends ToleranceOptions {
  /** Simple polygon in the world xy plane, either winding, without collinear vertices. */
  readonly profile: readonly P2[];
  /** Extent along +z from z = 0 to z = height. */
  readonly height: number;
  /** One radius per profile vertex; 0 leaves that vertex sharp. Reflex vertices get a concave fillet. */
  readonly radii: readonly number[];
  readonly label?: string;
}

interface Corner {
  readonly r: number;
  /** Signed turn angle at the vertex, positive for a left turn of a CCW profile. */
  readonly delta: number;
  readonly tin: P2;
  readonly tout: P2;
  readonly centre: P2;
  readonly axis: P2;
}

const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const len2 = (a: P2): number => Math.sqrt(a[0] * a[0] + a[1] * a[1]);
const unit2 = (a: P2): P2 => {
  const l = len2(a);
  return [a[0] / l, a[1] / l];
};
const lift = (p: P2, z: number): P3 => [p[0], p[1], z];

/**
 * A prism whose selected vertical edges are rounded by per-vertex radii. A convex vertex gets a
 * cylindrical band outward; a reflex vertex gets a concave band. Radius 0 keeps the edge sharp.
 * Built from planes and cylinder bands with no boolean.
 *
 * At a vertex with turn angle delta and radius r the tangent length is t = r tan(|delta|/2). The
 * corner removes r^2 (tan(delta/2) - delta/2) of area (negative for reflex corners). Then
 *   volume = H * A,   A = A_poly - sum r^2 (tan(delta/2) - delta/2)
 *   area   = 2 A + H (P - 2 sum t + sum r |delta|)
 */
export function filletPrism(options: FilletPrismOptions): Result<Shape, ModelingError> {
  const bad = (why: string, ids?: Record<string, unknown>) =>
    err(brepError('brep-bad-argument', why, ids));
  const { profile, height: H } = options;
  if (!(Number.isFinite(H) && H > 0)) return bad('height is a finite number greater than 0');
  if (!Array.isArray(profile) || profile.length < 3) return bad('profile of at least 3 points');
  if (!profile.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
    return bad('profile points are finite');
  }
  if (!Array.isArray(options.radii) || options.radii.length !== profile.length) {
    return bad('one radius per profile vertex');
  }
  if (!options.radii.every((r) => Number.isFinite(r) && r >= 0)) {
    return bad('radii are finite and not negative');
  }
  let twiceArea = 0;
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i] as P2;
    const q = profile[(i + 1) % profile.length] as P2;
    twiceArea += p[0] * q[1] - q[0] * p[1];
  }
  if (twiceArea === 0) return bad('profile with non-zero area');
  const ccw: P2[] = twiceArea > 0 ? [...profile] : [...profile].reverse();
  const radii: number[] = twiceArea > 0 ? [...options.radii] : [...options.radii].reverse();
  const n = ccw.length;
  const at = (i: number): P2 => ccw[((i % n) + n) % n] as P2;

  const corners: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const v = at(i);
    const ein = unit2(sub2(v, at(i - 1)));
    const eout = unit2(sub2(at(i + 1), v));
    const delta = atan2(ein[0] * eout[1] - ein[1] * eout[0], ein[0] * eout[0] + ein[1] * eout[1]);
    if (Math.abs(delta) < 1e-12)
      return bad('profile without collinear vertices', { reason: 'profile-not-convex' });
    const r = radii[i] as number;
    const t = r > 0 ? (r * Math.abs(sin(delta / 2))) / cos(delta / 2) : 0;
    const tin: P2 = [v[0] - t * ein[0], v[1] - t * ein[1]];
    const tout: P2 = [v[0] + t * eout[0], v[1] + t * eout[1]];
    const s = delta > 0 ? 1 : -1;
    const centre: P2 = [tin[0] - s * r * ein[1], tin[1] + s * r * ein[0]];
    const axis = unit2(sub2(tin, centre));
    corners.push({ r, delta, tin, tout, centre, axis });
  }
  for (let i = 0; i < n; i++) {
    const c = corners[i] as Corner;
    const d = corners[(i + 1) % n] as Corner;
    const tangent = len2(sub2(at(i + 1), at(i)));
    const used = len2(sub2(at(i), c.tout)) + len2(sub2(d.tin, at(i + 1)));
    if (used >= tangent)
      return bad('fillets overlap along an edge', { reason: 'fillet-too-large' });
  }

  const label = options.label ?? 'filleted-prism';
  let lo = at(0);
  let hi = lo;
  for (const p of ccw) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
  }
  const ex = hi[0] - lo[0];
  const ey = hi[1] - lo[1];
  const made = ShapeAssembler.create(Math.sqrt(ex * ex + ey * ey + H * H), options);
  if (!made.ok) return made;
  const asm = made.value;

  const lines = new Map<string, number>();
  const line = (a: P3, b: P3): LoopEdge => {
    const va = asm.vertex(a);
    const vb = asm.vertex(b);
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    let found = lines.get(key);
    if (found === undefined) {
      found = asm.edge(asm.curve({ kind: 'line', o: a, d: unit3(sub3(b, a)) }), 0, dist3(a, b));
      lines.set(key, found);
    }
    return { edge: found };
  };
  const arcs = new Map<string, number>();
  const arc = (k: number, h: number): LoopEdge => {
    const key = `${k}:${h}`;
    let found = arcs.get(key);
    if (found === undefined) {
      const c = corners[k] as Corner;
      const sigma = c.delta > 0 ? 1 : -1;
      const frame: Frame = {
        o: [c.centre[0], c.centre[1], h],
        x: [c.axis[0], c.axis[1], 0],
        y: [-sigma * c.axis[1], sigma * c.axis[0], 0],
        z: [0, 0, sigma],
      };
      found = asm.edge(asm.curve({ kind: 'circle', frame, radius: c.r }), 0, Math.abs(c.delta));
      arcs.set(key, found);
    }
    return { edge: found };
  };

  const faces: number[] = [];
  const failures: (ModelingError | undefined)[] = [];
  const planeFace = (frame: Frame, loop: LoopEdge[], name: string): ModelingError | undefined => {
    const surface = asm.surface({ kind: 'plane', frame });
    const l = asm.loop(surface, loop, true);
    if (!l.ok) return l.error;
    faces.push(asm.face(surface, [l.value], false, name));
    return undefined;
  };

  // Outline loops: for each profile edge, its straight run then the arc at the next corner.
  const top: LoopEdge[] = [];
  const bottom: LoopEdge[] = [];
  for (let i = 0; i < n; i++) {
    const c = corners[i] as Corner;
    const d = corners[(i + 1) % n] as Corner;
    top.push(line(lift(c.tout, H), lift(d.tin, H)));
    bottom.push(line(lift(c.tout, 0), lift(d.tin, 0)));
    if (d.r > 0) {
      top.push(arc((i + 1) % n, H));
      bottom.push(arc((i + 1) % n, 0));
    }
  }
  failures.push(
    planeFace({ o: [0, 0, H], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, top, `${label}.top`),
  );
  failures.push(
    planeFace(
      { o: [0, 0, 0], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
      [...bottom].reverse(),
      `${label}.bottom`,
    ),
  );

  // Straight side between the tangent points of consecutive corners. Frame x runs along the side,
  // y is world +z, and z = x cross y points outward for a CCW profile.
  for (let i = 0; i < n; i++) {
    const c = corners[i] as Corner;
    const d = corners[(i + 1) % n] as Corner;
    const p = lift(c.tout, 0);
    const q = lift(d.tin, 0);
    const dir = unit3(sub3(q, p));
    const frame: Frame = { o: p, x: dir, y: [0, 0, 1], z: cross3(dir, [0, 0, 1]) };
    failures.push(
      planeFace(
        frame,
        [
          line(p, q),
          line(q, lift(d.tin, H)),
          line(lift(d.tin, H), lift(c.tout, H)),
          line(lift(c.tout, H), p),
        ],
        `${label}.side${i}`,
      ),
    );
  }

  // Vertical cylinder band at each rounded corner. Convex bands face outward; reflex bands are
  // concave, so their solid lies on the axis side and the surface is reversed.
  for (let k = 0; k < n; k++) {
    const c = corners[k] as Corner;
    if (c.r === 0) continue;
    const frame: Frame = {
      o: [c.centre[0], c.centre[1], 0],
      x: [c.axis[0], c.axis[1], 0],
      y: [-c.axis[1], c.axis[0], 0],
      z: [0, 0, 1],
    };
    const surface = asm.surface({ kind: 'cylinder', frame, radius: c.r });
    const loop = asm.loop(
      surface,
      [
        arc(k, 0),
        line(lift(c.tout, 0), lift(c.tout, H)),
        arc(k, H),
        line(lift(c.tin, H), lift(c.tin, 0)),
      ],
      true,
    );
    if (!loop.ok) {
      failures.push(loop.error);
      continue;
    }
    faces.push(asm.face(surface, [loop.value], c.delta < 0, `${label}.round${k}`));
  }

  const first = failures.find((f) => f !== undefined);
  if (first !== undefined) return err(first);
  asm.shell(faces);
  return asm.finish();
}
