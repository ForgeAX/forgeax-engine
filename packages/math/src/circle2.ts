// circle2.ts — 2D bounding-circle namespace (P12 / bounding_2d).

import * as box2 from './box2';
import type { Vec2, Vec2Like } from './types';

/** 2D bounding circle storage: Float32Array [centerX, centerY, radius]. */
export type Circle2 = Float32Array & { readonly __circle2: void };

/** Readable 2D bounding-circle input. */
export type Circle2Like = ArrayLike<number>;

/** Create a bounding circle. Negative radius is clamped to zero. */
export function create(cx = 0, cy = 0, radius = 0): Circle2 {
  return Float32Array.of(cx, cy, radius < 0 ? 0 : radius) as Circle2;
}

/** Build a circle centered at the point-cloud AABB center and enclosing all points. */
export function fromPoints(out: Circle2, points: readonly Vec2Like[]): Circle2 {
  if (points.length === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = -1;
    return out;
  }
  const bounds = box2.create();
  box2.fromPoints(bounds, points);
  const cx = ((bounds[0] as number) + (bounds[2] as number)) * 0.5;
  const cy = ((bounds[1] as number) + (bounds[3] as number)) * 0.5;
  let radiusSq = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i] as Vec2Like;
    const dx = (point[0] as number) - cx;
    const dy = (point[1] as number) - cy;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > radiusSq) radiusSq = distanceSq;
  }
  out[0] = cx;
  out[1] = cy;
  out[2] = Math.sqrt(radiusSq);
  return out;
}

/** Build the smallest AABB containing the circle. */
export function toBox(out: box2.Box2, circle: Circle2Like): box2.Box2 {
  const cx = circle[0] as number;
  const cy = circle[1] as number;
  const radius = circle[2] as number;
  out[0] = cx - radius;
  out[1] = cy - radius;
  out[2] = cx + radius;
  out[3] = cy + radius;
  return out;
}

/** Write the circle center to out. */
export function center(out: Vec2, circle: Circle2Like): Vec2 {
  out[0] = circle[0] as number;
  out[1] = circle[1] as number;
  return out;
}

/** Return the circle radius. */
export function radius(circle: Circle2Like): number {
  return circle[2] as number;
}

/** Write the closest point in the circle to point. */
export function closestPoint(out: Vec2, circle: Circle2Like, point: Vec2Like): Vec2 {
  const dx = (point[0] as number) - (circle[0] as number);
  const dy = (point[1] as number) - (circle[1] as number);
  const distanceSq = dx * dx + dy * dy;
  const r = circle[2] as number;
  if (r < 0) {
    out[0] = circle[0] as number;
    out[1] = circle[1] as number;
    return out;
  }
  if (distanceSq <= r * r || distanceSq < 1e-12) {
    out[0] = point[0] as number;
    out[1] = point[1] as number;
    return out;
  }
  const scale = r / Math.sqrt(distanceSq);
  out[0] = (circle[0] as number) + dx * scale;
  out[1] = (circle[1] as number) + dy * scale;
  return out;
}

/** True when point is inside the circle, including its boundary. */
export function containsPoint(circle: Circle2Like, point: Vec2Like): boolean {
  const dx = (point[0] as number) - (circle[0] as number);
  const dy = (point[1] as number) - (circle[1] as number);
  const r = circle[2] as number;
  return r >= 0 && dx * dx + dy * dy <= r * r;
}

/** True when two circles overlap, including tangent contact. */
export function intersectsCircle(a: Circle2Like, b: Circle2Like): boolean {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  const radius = (a[2] as number) + (b[2] as number);
  return (a[2] as number) >= 0 && (b[2] as number) >= 0 && dx * dx + dy * dy <= radius * radius;
}

/** True when the circle overlaps the box, including tangent contact. */
export function intersectsBox(circle: Circle2Like, box: box2.Box2Like): boolean {
  return box2.intersectsCircle(box, circle);
}

/** Return the smallest circle containing both circles. */
export function merge(out: Circle2, a: Circle2Like, b: Circle2Like): Circle2 {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const ar = a[2] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const br = b[2] as number;
  const dx = bx - ax;
  const dy = by - ay;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (ar >= distance + br) return createInto(out, ax, ay, ar);
  if (br >= distance + ar) return createInto(out, bx, by, br);
  if (distance < 1e-12) return createInto(out, ax, ay, Math.max(ar, br));
  const nextRadius = (distance + ar + br) * 0.5;
  const shift = (nextRadius - ar) / distance;
  return createInto(out, ax + dx * shift, ay + dy * shift, nextRadius);
}

function createInto(out: Circle2, cx: number, cy: number, r: number): Circle2 {
  out[0] = cx;
  out[1] = cy;
  out[2] = r;
  return out;
}
