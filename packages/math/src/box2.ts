// box2.ts — 2D axis-aligned bounding box namespace (P12 / bounding_2d).
//
// Storage layout: Float32Array length 4 [minX, minY, maxX, maxY]. The surface
// mirrors box3 so an AI can transfer broad-phase code between dimensions without
// learning a second object model.

import type { Circle2Like } from './circle2';
import type { Vec2, Vec2Like } from './types';

/** 2D AABB storage: [minX, minY, maxX, maxY]. */
export type Box2 = Float32Array & { readonly __box2: void };

/** Readable 2D AABB input. */
export type Box2Like = ArrayLike<number>;

/** Create a 2D AABB. The default is the inverted-infinity empty box. */
export function create(
  minX = Number.POSITIVE_INFINITY,
  minY = Number.POSITIVE_INFINITY,
  maxX = Number.NEGATIVE_INFINITY,
  maxY = Number.NEGATIVE_INFINITY,
): Box2 {
  return Float32Array.of(minX, minY, maxX, maxY) as Box2;
}

/** Create an AABB from its center and non-negative half-size. */
export function fromCenter(out: Box2, center: Vec2Like, halfSize: Vec2Like): Box2 {
  const cx = center[0] as number;
  const cy = center[1] as number;
  const hx = Math.abs(halfSize[0] as number);
  const hy = Math.abs(halfSize[1] as number);
  out[0] = cx - hx;
  out[1] = cy - hy;
  out[2] = cx + hx;
  out[3] = cy + hy;
  return out;
}

/** Build the tightest AABB containing the given points. */
export function fromPoints(out: Box2, points: readonly Vec2Like[]): Box2 {
  out[0] = Number.POSITIVE_INFINITY;
  out[1] = Number.POSITIVE_INFINITY;
  out[2] = Number.NEGATIVE_INFINITY;
  out[3] = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i++) {
    const point = points[i] as Vec2Like;
    const x = point[0] as number;
    const y = point[1] as number;
    if (x < (out[0] as number)) out[0] = x;
    if (y < (out[1] as number)) out[1] = y;
    if (x > (out[2] as number)) out[2] = x;
    if (y > (out[3] as number)) out[3] = y;
  }
  return out;
}

/** Write the box center to out. Empty boxes produce non-finite values. */
export function center(out: Vec2, box: Box2Like): Vec2 {
  out[0] = ((box[0] as number) + (box[2] as number)) * 0.5;
  out[1] = ((box[1] as number) + (box[3] as number)) * 0.5;
  return out;
}

/** Write the box half-size to out. */
export function halfSize(out: Vec2, box: Box2Like): Vec2 {
  out[0] = ((box[2] as number) - (box[0] as number)) * 0.5;
  out[1] = ((box[3] as number) - (box[1] as number)) * 0.5;
  return out;
}

/** Write the closest point in the box to point. */
export function closestPoint(out: Vec2, box: Box2Like, point: Vec2Like): Vec2 {
  const x = point[0] as number;
  const y = point[1] as number;
  const minX = box[0] as number;
  const minY = box[1] as number;
  const maxX = box[2] as number;
  const maxY = box[3] as number;
  out[0] = x < minX ? minX : x > maxX ? maxX : x;
  out[1] = y < minY ? minY : y > maxY ? maxY : y;
  return out;
}

/** True when point is inside the box, including its boundary. */
export function containsPoint(box: Box2Like, point: Vec2Like): boolean {
  const x = point[0] as number;
  const y = point[1] as number;
  return (
    x >= (box[0] as number) &&
    x <= (box[2] as number) &&
    y >= (box[1] as number) &&
    y <= (box[3] as number)
  );
}

/** True when the box completely contains other, including touching edges. */
export function containsBox(box: Box2Like, other: Box2Like): boolean {
  return (
    (other[0] as number) >= (box[0] as number) &&
    (other[1] as number) >= (box[1] as number) &&
    (other[2] as number) <= (box[2] as number) &&
    (other[3] as number) <= (box[3] as number)
  );
}

/** True when two boxes overlap, including touching edges. */
export function intersectsBox(a: Box2Like, b: Box2Like): boolean {
  return (
    (a[2] as number) >= (b[0] as number) &&
    (a[0] as number) <= (b[2] as number) &&
    (a[3] as number) >= (b[1] as number) &&
    (a[1] as number) <= (b[3] as number)
  );
}

/** True when a box and a circle overlap, including tangent contact. */
export function intersectsCircle(box: Box2Like, circle: Circle2Like): boolean {
  const cx = circle[0] as number;
  const cy = circle[1] as number;
  const radius = circle[2] as number;
  if (radius < 0) return false;
  const closestX =
    cx < (box[0] as number)
      ? (box[0] as number)
      : cx > (box[2] as number)
        ? (box[2] as number)
        : cx;
  const closestY =
    cy < (box[1] as number)
      ? (box[1] as number)
      : cy > (box[3] as number)
        ? (box[3] as number)
        : cy;
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= radius * radius;
}

/** Return the smallest box containing a and b. */
export function merge(out: Box2, a: Box2Like, b: Box2Like): Box2 {
  out[0] = Math.min(a[0] as number, b[0] as number);
  out[1] = Math.min(a[1] as number, b[1] as number);
  out[2] = Math.max(a[2] as number, b[2] as number);
  out[3] = Math.max(a[3] as number, b[3] as number);
  return out;
}

/** Grow the box by a non-negative amount on each side. */
export function grow(out: Box2, box: Box2Like, amount: Vec2Like): Box2 {
  const x = Math.abs(amount[0] as number);
  const y = Math.abs(amount[1] as number);
  out[0] = (box[0] as number) - x;
  out[1] = (box[1] as number) - y;
  out[2] = (box[2] as number) + x;
  out[3] = (box[3] as number) + y;
  return out;
}

/** Shrink the box by a non-negative amount on each side. */
export function shrink(out: Box2, box: Box2Like, amount: Vec2Like): Box2 {
  const x = Math.abs(amount[0] as number);
  const y = Math.abs(amount[1] as number);
  out[0] = (box[0] as number) + x;
  out[1] = (box[1] as number) + y;
  out[2] = (box[2] as number) - x;
  out[3] = (box[3] as number) - y;
  return out;
}
