// ray2.ts — finite 2D ray and bounding-volume casts (P12 / bounding_2d).
//
// Ray2 storage: Float32Array [originX, originY, directionX, directionY, maxDistance].
// Direction is normalized at construction, matching ray.create. A finite max distance
// keeps ordinary ray tests and swept-volume tests on one small, composable surface.

import type { Box2Like } from './box2';
import type { Circle2Like } from './circle2';
import type { Vec2, Vec2Like } from './types';

/** 2D ray storage: [originX, originY, directionX, directionY, maxDistance]. */
export type Ray2 = Float32Array & { readonly __ray2: void };

/** Readable 2D ray input. */
export type Ray2Like = ArrayLike<number>;

/** Result shared by AABB, circle, and swept-volume intersection tests. */
export interface Ray2Intersection {
  hit: boolean;
  /** Entry distance along the normalized ray, clamped to zero when inside. */
  t: number;
}

/** Create a normalized finite 2D ray. `maxDistance` defaults to infinity. */
export function create(
  out?: Float32Array,
  origin?: Vec2Like,
  direction?: Vec2Like,
  maxDistance = Number.POSITIVE_INFINITY,
): Ray2 {
  const ray = out ?? new Float32Array(5);
  ray[0] = origin ? (origin[0] as number) : 0;
  ray[1] = origin ? (origin[1] as number) : 0;
  const dx = direction ? (direction[0] as number) : 0;
  const dy = direction ? (direction[1] as number) : 1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) {
    ray[2] = 0;
    ray[3] = 0;
  } else {
    const invLength = 1 / Math.sqrt(lengthSq);
    ray[2] = dx * invLength;
    ray[3] = dy * invLength;
  }
  ray[4] = maxDistance < 0 ? 0 : maxDistance;
  return ray as Ray2;
}

/** Copy the ray origin to out. */
export function getOrigin(out: Vec2, ray: Ray2Like): Vec2 {
  out[0] = ray[0] as number;
  out[1] = ray[1] as number;
  return out;
}

/** Copy the normalized ray direction to out. */
export function getDirection(out: Vec2, ray: Ray2Like): Vec2 {
  out[0] = ray[2] as number;
  out[1] = ray[3] as number;
  return out;
}

/** Return the ray's finite travel limit. */
export function getMaxDistance(ray: Ray2Like): number {
  return ray[4] as number;
}

/** Set the ray origin. */
export function setOrigin(ray: Ray2, origin: Vec2Like): Ray2 {
  ray[0] = origin[0] as number;
  ray[1] = origin[1] as number;
  return ray;
}

/** Set and normalize the ray direction. */
export function setDirection(ray: Ray2, direction: Vec2Like): Ray2 {
  const dx = direction[0] as number;
  const dy = direction[1] as number;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) {
    ray[2] = 0;
    ray[3] = 0;
  } else {
    const invLength = 1 / Math.sqrt(lengthSq);
    ray[2] = dx * invLength;
    ray[3] = dy * invLength;
  }
  return ray;
}

/** Set the ray's non-negative travel limit. */
export function setMaxDistance(ray: Ray2, maxDistance: number): Ray2 {
  ray[4] = maxDistance < 0 ? 0 : maxDistance;
  return ray;
}

/** Intersect a finite ray with an AABB using the 2D slab method. */
export function rayAabbIntersects(ray: Ray2Like, box: Box2Like): Ray2Intersection {
  return rayAabbValues(ray, box[0] as number, box[1] as number, box[2] as number, box[3] as number);
}

/** Intersect a finite ray with a bounding circle. */
export function rayCircleIntersects(ray: Ray2Like, circle: Circle2Like): Ray2Intersection {
  return rayCircleValues(ray, circle[0] as number, circle[1] as number, circle[2] as number);
}

/** Sweep an AABB along a finite ray and intersect it with a target AABB. */
export function aabbCastIntersects(
  ray: Ray2Like,
  moving: Box2Like,
  target: Box2Like,
): Ray2Intersection {
  // Minkowski difference: target ⊖ moving. This also preserves the moving
  // volume's offset relative to the ray origin, matching Bevy AabbCast2d.
  return rayAabbValues(
    ray,
    (target[0] as number) - (moving[2] as number),
    (target[1] as number) - (moving[3] as number),
    (target[2] as number) - (moving[0] as number),
    (target[3] as number) - (moving[1] as number),
  );
}

/** Sweep a circle along a finite ray and intersect it with a target circle. */
export function circleCastIntersects(
  ray: Ray2Like,
  moving: Circle2Like,
  target: Circle2Like,
): Ray2Intersection {
  return rayCircleValues(
    ray,
    (target[0] as number) - (moving[0] as number),
    (target[1] as number) - (moving[1] as number),
    (target[2] as number) + (moving[2] as number),
  );
}

function rayAabbValues(
  ray: Ray2Like,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Ray2Intersection {
  const ox = ray[0] as number;
  const oy = ray[1] as number;
  const dx = ray[2] as number;
  const dy = ray[3] as number;
  let near = 0;
  let far = ray[4] as number;

  if (minX > maxX || minY > maxY || far < 0) return miss();
  if (Math.abs(dx) < 1e-12) {
    if (ox < minX || ox > maxX) return miss();
  } else {
    let a = (minX - ox) / dx;
    let b = (maxX - ox) / dx;
    if (a > b) [a, b] = [b, a];
    if (a > near) near = a;
    if (b < far) far = b;
  }
  if (Math.abs(dy) < 1e-12) {
    if (oy < minY || oy > maxY) return miss();
  } else {
    let a = (minY - oy) / dy;
    let b = (maxY - oy) / dy;
    if (a > b) [a, b] = [b, a];
    if (a > near) near = a;
    if (b < far) far = b;
  }
  return near <= far && far >= 0 ? { hit: true, t: near } : miss();
}

function rayCircleValues(ray: Ray2Like, cx: number, cy: number, radius: number): Ray2Intersection {
  const ox = (ray[0] as number) - cx;
  const oy = (ray[1] as number) - cy;
  const dx = ray[2] as number;
  const dy = ray[3] as number;
  const maxDistance = ray[4] as number;
  if (radius < 0 || maxDistance < 0) return miss();
  const directionLengthSq = dx * dx + dy * dy;
  const radiusSq = radius * radius;
  const originDistanceSq = ox * ox + oy * oy;
  if (originDistanceSq <= radiusSq) return maxDistance >= 0 ? { hit: true, t: 0 } : miss();
  if (directionLengthSq < 1e-12) return miss();

  const projected = ox * dx + oy * dy;
  const constant = originDistanceSq - radiusSq;
  const discriminant = projected * projected - directionLengthSq * constant;
  if (discriminant < 0) return miss();
  const entry = (-projected - Math.sqrt(discriminant)) / directionLengthSq;
  const t = entry < 0 ? 0 : entry;
  return t <= maxDistance ? { hit: true, t } : miss();
}

function miss(): Ray2Intersection {
  return { hit: false, t: 0 };
}
