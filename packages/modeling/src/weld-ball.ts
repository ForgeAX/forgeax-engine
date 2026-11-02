import { cos, hypot3, sin } from './dmath';
import { add, cross, dot, normalize, scale, sub, type Tuple3 } from './geom';

/** An infinite cylinder: unit axis through `origin`. */
export interface BallCylinder {
  readonly kind: 'cylinder';
  readonly origin: Tuple3;
  readonly axis: Tuple3;
  readonly radius: number;
}

export interface BallSphere {
  readonly kind: 'sphere';
  readonly centre: Tuple3;
  readonly radius: number;
}

export type BallPrimitive = BallCylinder | BallSphere;

/** A ball of radius rho touching both primitives from outside, with its two contact points. */
export interface BallStation {
  readonly centre: Tuple3;
  readonly contactA: Tuple3;
  readonly contactB: Tuple3;
}

const TAU = 6.283185307179586;
const MIN_STATIONS = 16;
const MAX_STATIONS = 512;

export function axisFrame(axis: Tuple3): [Tuple3, Tuple3] {
  const helper: Tuple3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize(cross(axis, helper));
  return [e1, cross(axis, e1)];
}

function onAxis(p: Tuple3, c: BallCylinder): Tuple3 {
  return add(c.origin, scale(c.axis, dot(sub(p, c.origin), c.axis)));
}

function touch(p: Tuple3, prim: BallPrimitive): Tuple3 {
  const from = prim.kind === 'sphere' ? prim.centre : onAxis(p, prim);
  const d = sub(p, from);
  return add(from, scale(d, prim.radius / hypot3(d[0], d[1], d[2])));
}

/**
 * Deterministic station count for a spine around a tube of radius `radius`: one station per
 * rho/2 of arc, so the count depends on the two radii only.
 */
export function stationCount(radius: number, rho: number): number {
  const n = Math.ceil((TAU * (radius + rho)) / (0.5 * rho));
  return Math.max(MIN_STATIONS, Math.min(MAX_STATIONS, n));
}

/**
 * The rolling-ball station at angle `theta` around the thinner cylinder `b` of a
 * cylinder/cylinder pair: the ball centre lies at distance `b.radius + rho` from b's axis and
 * `a.radius + rho` from a's axis. `side` (+1 or -1) picks the root along b's axis, the side of
 * a the branch leaves on. Undefined when no such ball exists (rho >= the thin radius, or the
 * axes are parallel).
 */
export function cylinderPairStation(
  a: BallCylinder,
  b: BallCylinder,
  rho: number,
  theta: number,
  side: 1 | -1,
): BallStation | undefined {
  const [e1, e2] = axisFrame(b.axis);
  const ring = scale(add(scale(e1, cos(theta)), scale(e2, sin(theta))), b.radius + rho);
  const p0 = add(b.origin, ring);
  const u = sub(b.axis, scale(a.axis, dot(b.axis, a.axis)));
  const w = sub(sub(p0, a.origin), scale(a.axis, dot(sub(p0, a.origin), a.axis)));
  const qa = dot(u, u);
  if (qa < 1e-12) return undefined;
  const qb = 2 * dot(u, w);
  const reach = a.radius + rho;
  const disc = qb * qb - 4 * qa * (dot(w, w) - reach * reach);
  if (disc < 0) return undefined;
  const t = (-qb + side * Math.sqrt(disc)) / (2 * qa);
  const centre = add(p0, scale(b.axis, t));
  return { centre, contactA: touch(centre, a), contactB: touch(centre, b) };
}

/**
 * The station at angle `theta` of a cylinder/sphere pair: the ball centre lies on a circle
 * about the cylinder axis at the height where its distance to the sphere centre is
 * `sphere.radius + rho`. `side` picks the sphere centre's +axis or -axis side. Undefined when
 * the sphere and cylinder leave no room for the ball.
 */
export function cylinderSphereStation(
  cylinder: BallCylinder,
  sphere: BallSphere,
  rho: number,
  theta: number,
  side: 1 | -1,
): BallStation | undefined {
  const radial = cylinder.radius + rho;
  const reach = sphere.radius + rho;
  const sq = reach * reach - radial * radial;
  if (sq < 0) return undefined;
  const foot = onAxis(sphere.centre, cylinder);
  const [e1, e2] = axisFrame(cylinder.axis);
  const ring = scale(add(scale(e1, cos(theta)), scale(e2, sin(theta))), radial);
  const centre = add(add(foot, scale(cylinder.axis, side * Math.sqrt(sq))), ring);
  return { centre, contactA: touch(centre, cylinder), contactB: touch(centre, sphere) };
}
