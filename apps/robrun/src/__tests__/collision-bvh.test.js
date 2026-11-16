import assert from 'node:assert/strict';
import test from 'node:test';
import { closestTriangleSegment, createCollisionBvh } from '../collision-bvh.js';

const point = (...values) => new Float32Array(values);
test('triangle closest points cover vertex, edge and face regions', () => {
  const vertices = [point(0, 0, 0), point(2, 0, 0), point(0, 0, 2)];
  for (const [source, expected] of [
    [
      [-1, 1, -1],
      [0, 0, 0],
    ],
    [
      [3, 1, -1],
      [2, 0, 0],
    ],
    [
      [-1, 1, 3],
      [0, 0, 2],
    ],
    [
      [1, 1, -1],
      [1, 0, 0],
    ],
    [
      [-1, 1, 1],
      [0, 0, 1],
    ],
    [
      [2, 1, 2],
      [1, 0, 1],
    ],
    [
      [0.5, 1, 0.5],
      [0.5, 0, 0.5],
    ],
  ]) {
    const triangle = point(0, 0, 0),
      capsule = point(0, 0, 0),
      position = point(...source);
    const distance = closestTriangleSegment(triangle, capsule, position, position, ...vertices);
    assert.deepEqual(Array.from(triangle), expected);
    assert.deepEqual(Array.from(capsule), source);
    assert.ok(Math.abs(distance - Math.hypot(...source.map((v, i) => v - expected[i]))) < 1e-6);
  }
});
test('capsule closest points preserve floor and wall clearance', () => {
  const triangle = point(0, 0, 0),
    capsule = point(0, 0, 0);
  let distance = closestTriangleSegment(
    triangle,
    capsule,
    point(0, 0.2, 0),
    point(0, 1.2, 0),
    point(-2, 0, -2),
    point(2, 0, -2),
    point(0, 0, 2),
  );
  assert.ok(Math.abs(distance - 0.2) < 1e-6);
  assert.ok(Math.abs(triangle[1]) < 1e-6);
  assert.ok(Math.abs(capsule[1] - 0.2) < 1e-6);
  distance = closestTriangleSegment(
    triangle,
    capsule,
    point(0.2, 0.5, 0),
    point(0.2, 1.5, 0),
    point(0, 0, -2),
    point(0, 3, -2),
    point(0, 1.5, 2),
  );
  assert.ok(Math.abs(distance - 0.2) < 1e-6);
});
test('BVH returns nearest double sided hit with far bound and traverses all partition leaves', () => {
  const positions = [],
    indices = [];
  for (let i = 0; i < 64; i++) {
    const base = positions.length / 3,
      x = i * 4;
    positions.push(x - 1, 0, -1, x + 1, 0, -1, x, 0, 1);
    indices.push(base, base + 1, base + 2);
  }
  const bvh = createCollisionBvh(new Float32Array(positions), new Uint32Array(indices));
  assert.ok(bvh.nodeCount > 1);
  for (let i = 0; i < 64; i++) {
    assert.equal(bvh.raycast(point(i * 4, 3, 0), point(0, -1, 0), 2), null);
    assert.ok(Math.abs(bvh.raycast(point(i * 4, 3, 0), point(0, -1, 0), 4).distance - 3) < 1e-6);
    assert.ok(bvh.raycast(point(i * 4, -3, 0), point(0, 1, 0), 4));
  }
  assert.equal(bvh.raycast(point(0, 3, 10), point(0, -1, 0), 4), null);
  let count = 0;
  bvh.query(new Float32Array([-2, -1, -2, 260, 1, 2]), () => count++);
  assert.equal(count, 64);
});
