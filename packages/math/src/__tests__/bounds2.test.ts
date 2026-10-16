import { describe, expect, it } from 'vitest';
import * as box2 from '../box2';
import * as circle2 from '../circle2';
import * as ray2 from '../ray2';
import * as vec2 from '../vec2';

function expectBox(
  box: box2.Box2Like,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  expect(box[0]).toBe(minX);
  expect(box[1]).toBe(minY);
  expect(box[2]).toBe(maxX);
  expect(box[3]).toBe(maxY);
}

describe('box2', () => {
  it('builds center/half-size and point-cloud bounds', () => {
    const out = box2.create();
    expect(box2.fromCenter(out, [2, -1], [3, 4])).toBe(out);
    expectBox(out, -1, -5, 5, 3);

    box2.fromPoints(out, [
      [-2, 4],
      [5, 0],
      [1, -3],
    ]);
    expectBox(out, -2, -3, 5, 4);
  });

  it('supports closest point, containment, merge, grow, and shrink', () => {
    const box = box2.create(-2, -1, 2, 3);
    const point = vec2.create();
    box2.closestPoint(point, box, [5, -4]);
    expect(point).toEqual(new Float32Array([2, -1]));
    expect(box2.containsPoint(box, [2, 3])).toBe(true);
    expect(box2.containsBox(box, box2.create(-1, 0, 1, 2))).toBe(true);

    const merged = box2.create();
    box2.merge(merged, box, box2.create(0, -4, 5, 1));
    expectBox(merged, -2, -4, 5, 3);
    box2.grow(merged, box, [1, 2]);
    expectBox(merged, -3, -3, 3, 5);
    box2.shrink(merged, box, [1, 1]);
    expectBox(merged, -1, 0, 1, 2);
  });

  it('intersects boxes and circles at the boundary', () => {
    const box = box2.create(-1, -1, 1, 1);
    expect(box2.intersectsBox(box, box2.create(1, 0, 2, 1))).toBe(true);
    expect(box2.intersectsBox(box, box2.create(1.01, 0, 2, 1))).toBe(false);
    expect(box2.intersectsCircle(box, circle2.create(2, 0, 1))).toBe(true);
    expect(box2.intersectsCircle(box, circle2.create(2.01, 0, 1))).toBe(false);
    expect(box2.intersectsCircle(box, Float32Array.of(0, 0, -1))).toBe(false);
  });
});

describe('circle2', () => {
  it('builds an enclosing circle from points and converts to an AABB', () => {
    const circle = circle2.create();
    circle2.fromPoints(circle, [
      [-2, 0],
      [2, 0],
      [0, 1],
    ]);
    expect(circle[0]).toBe(0);
    expect(circle[1]).toBe(0.5);
    expect(circle[2]).toBeCloseTo(2.06155, 4);

    const box = box2.create();
    circle2.toBox(box, circle);
    const radius = circle[2] as number;
    expectBox(box, -radius, 0.5 - radius, radius, 0.5 + radius);
  });

  it('handles closest point, intersections, and merge', () => {
    const circle = circle2.create(0, 0, 2);
    const point = vec2.create();
    circle2.closestPoint(point, circle, [4, 0]);
    expect(point).toEqual(new Float32Array([2, 0]));
    expect(circle2.containsPoint(circle, [2, 0])).toBe(true);
    expect(circle2.intersectsCircle(circle, circle2.create(3, 0, 1))).toBe(true);
    expect(circle2.intersectsCircle(circle, circle2.create(3.01, 0, 1))).toBe(false);
    expect(circle2.intersectsBox(circle, box2.create(-1, -1, 1, 1))).toBe(true);
    circle2.closestPoint(point, Float32Array.of(0, 0, -1), [4, 0]);
    expect(point).toEqual(new Float32Array([0, 0]));

    const merged = circle2.create();
    circle2.merge(merged, circle, circle2.create(5, 0, 1));
    expect(merged[0]).toBe(2);
    expect(merged[1]).toBe(0);
    expect(merged[2]).toBe(4);
  });
});

describe('ray2', () => {
  it('intersects AABBs from outside, from inside, and with parallel axes', () => {
    const ray = ray2.create(undefined, [-5, 0], [2, 0], 20);
    const box = box2.create(-1, -1, 1, 1);
    expect(ray2.rayAabbIntersects(ray, box)).toEqual({ hit: true, t: 4 });
    expect(ray2.rayAabbIntersects(ray2.create(undefined, [0, 0], [1, 0], 0), box)).toEqual({
      hit: true,
      t: 0,
    });
    expect(ray2.rayAabbIntersects(ray2.create(undefined, [-5, 2], [1, 0], 20), box).hit).toBe(
      false,
    );
    expect(ray2.rayAabbIntersects(ray2.create(undefined, [0, 0], [0, 1], 20), box)).toEqual({
      hit: true,
      t: 0,
    });
  });

  it('intersects circles and respects the finite maximum distance', () => {
    const hit = ray2.rayCircleIntersects(
      ray2.create(undefined, [-5, 0], [2, 0], 20),
      circle2.create(0, 0, 1),
    );
    expect(hit.hit).toBe(true);
    expect(hit.t).toBeCloseTo(4, 6);
    expect(
      ray2.rayCircleIntersects(ray2.create(undefined, [-5, 0], [1, 0], 3), circle2.create(0, 0, 1))
        .hit,
    ).toBe(false);
    expect(
      ray2.rayCircleIntersects(ray2.create(undefined, [0, 0], [1, 0], 0), circle2.create(0, 0, 1)),
    ).toEqual({ hit: true, t: 0 });
  });

  it('sweeps AABBs and circles through matching target volumes', () => {
    const ray = ray2.create(undefined, [0, 0], [0, 2], 20);
    const movingBox = box2.create(-1, -1, 1, 1);
    const targetBox = box2.create(-1, 4, 1, 6);
    expect(ray2.aabbCastIntersects(ray, movingBox, targetBox)).toEqual({ hit: true, t: 3 });

    const movingCircle = circle2.create(0, 0, 1);
    const targetCircle = circle2.create(0, 5, 1);
    const circleHit = ray2.circleCastIntersects(ray, movingCircle, targetCircle);
    expect(circleHit.hit).toBe(true);
    expect(circleHit.t).toBeCloseTo(3, 6);
    expect(ray2.circleCastIntersects(ray, movingCircle, circle2.create(3.1, 5, 1)).hit).toBe(false);
  });
});
