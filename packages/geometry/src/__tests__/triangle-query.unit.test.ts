import { describe, expect, it } from 'vitest';
import {
  createTriangleQuery,
  type QueryTriangle,
  triangleDistanceSquared,
} from '../triangle-query';

describe('shared offline triangle acceleration', () => {
  it('preserves equal-distance primitive identity when a slab rounds above the triangle hit', () => {
    const right: QueryTriangle = [
      [0, 0, 0],
      [3, 0, 0],
      [3, 2, 0],
    ];
    const left: QueryTriangle = [
      [0, 2, 0],
      [3, 0, 0],
      [0, 0, 0],
    ];
    const exhaustive = createTriangleQuery([right, left]);
    const tree = createTriangleQuery([right, ...Array.from({ length: 8 }, () => left)]);
    for (const sign of [1, -1]) {
      const expected = { primitive: -1, distance: 0, frontFace: false };
      const actual = { ...expected };
      expect(exhaustive.trace(expected, [1.5, 0.5, -0.3 * sign], [0, 0, 0.1 * sign], 0, 10)).toBe(
        true,
      );
      expect(expected.primitive).toBe(0);
      expect(tree.trace(actual, [1.5, 0.5, -0.3 * sign], [0, 0, 0.1 * sign], 0, 10)).toBe(true);
      expect(actual).toEqual(expected);
      const saved = { ...actual };
      expect(
        tree.trace(
          actual,
          [1.5, 0.5, -0.3 * sign],
          [0, 0, 0.1 * sign],
          0,
          expected.distance - Number.EPSILON * 4,
        ),
      ).toBe(false);
      expect(
        tree.trace(
          actual,
          [1.5, 0.5, -0.3 * sign],
          [0, 0, 0.1 * sign],
          expected.distance + Number.EPSILON * 4,
          10,
        ),
      ).toBe(false);
      expect(actual).toEqual(saved);
    }
  });

  it('keeps nearby tiled surfaces within budget despite large distant triangle bounds', () => {
    const triangles: QueryTriangle[] = [];
    for (let i = 0; i < 256; i++) {
      const x = (i % 16) * 0.1,
        y = Math.floor(i / 16) * 0.1;
      triangles.push([
        [x, y, 0],
        [x + 0.08, y, 0],
        [x, y + 0.08, 0],
      ]);
    }
    for (let i = 0; i < 32; i++) {
      const z = 1 + i * 0.1;
      triangles.push([
        [-100, -100, z],
        [100, -100, z],
        [0, 100, z],
      ]);
    }
    const query = createTriangleQuery(triangles);
    const rayBudget = { remaining: 32 },
      nearestBudget = { remaining: 32 };
    const hit = { primitive: -1, distance: -1, frontFace: false };
    for (let i = 0; i < 16; i++) {
      const origin = [i * 0.1 + 0.02, 0.02, -1] as const;
      expect(query.trace(hit, origin, [0, 0, 1], 0, 100, rayBudget)).toBe(true);
      expect(hit).toEqual({ primitive: i, distance: 1, frontFace: false });
      expect(query.nearestSquared(origin, 100, nearestBudget)).toBe(1);
    }
  });

  it('matches exhaustive single-triangle queries for general three-dimensional geometry', () => {
    const triangles: QueryTriangle[] = Array.from({ length: 96 }, (_, i) => {
      const point = (v: number): [number, number, number] => [
        Math.sin(v * 1.31) * 4,
        Math.cos(v * 2.71) * 3,
        Math.sin(v * 0.87) * 5,
      ];
      return [point(i * 3), point(i * 3 + 1), point(i * 3 + 2)];
    });
    const query = createTriangleQuery(triangles);
    const leaves = triangles.map((triangle) => createTriangleQuery([triangle]));
    for (let i = 0; i < 128; i++) {
      const origin = [Math.sin(i) * 8, Math.cos(i * 1.13) * 8, Math.sin(i * 1.77) * 8] as const;
      const direction = [-origin[0] + 0.1, -origin[1] + 0.2, -origin[2] - 0.3] as const;
      const expected = { primitive: -1, distance: 2, frontFace: false };
      const candidate = { ...expected };
      let found = false;
      for (let primitive = 0; primitive < leaves.length; primitive++) {
        const leaf = leaves[primitive];
        if (!leaf) throw new Error('missing triangle oracle');
        if (
          leaf.trace(candidate, origin, direction, 0.01, expected.distance) &&
          (!found || candidate.distance < expected.distance)
        ) {
          Object.assign(expected, candidate, { primitive });
          found = true;
        }
      }
      const actual = { primitive: -1, distance: 2, frontFace: false };
      expect(query.trace(actual, origin, direction, 0.01, 2)).toBe(found);
      expect(actual).toEqual(expected);
      const distance = Math.min(...triangles.map((t) => triangleDistanceSquared(origin, t)));
      expect(query.nearestSquared(origin)).toBeCloseTo(distance, 12);
    }
  });

  it('spends a bounded nearest-query budget on the nearby leaf before distant geometry', () => {
    const triangles: QueryTriangle[] = Array.from({ length: 128 }, (_, i) => [
      [i * 10, 0, 0],
      [i * 10, 1, 0],
      [i * 10, 0, 1],
    ]);
    const query = createTriangleQuery(triangles);
    expect(query.nearestSquared([1270, 0.2, 0.2], Infinity, { remaining: 2 })).toBe(0);
    expect(query.nearestSquared([1271, 0.2, 0.2], Infinity, { remaining: 2 })).toBe(1);
    expect(query.nearestSquared([1271, 0.2, 0.2], Infinity, { remaining: 1 })).toBeNull();
    expect(query.nearestSquared([1271, 0.2, 0.2], 0.5, { remaining: 0 })).toBe(0.25);
  });

  it('shares actual nearest work across unequal queries without reusing an exhausted result', () => {
    const triangles: QueryTriangle[] = Array.from({ length: 16 }, (_, i) => [
      [i, 0, 0],
      [i, 1, 0],
      [i, 0, 1],
    ]);
    const query = createTriangleQuery(triangles),
      budget = { remaining: 4 };
    expect(query.nearestSquared([15, 0.2, 0.2], Infinity, budget)).toBe(0);
    expect(budget.remaining).toBe(2);
    expect(query.nearestSquared([0, 0.2, 0.2], Infinity, budget)).toBe(0);
    expect(budget.remaining).toBe(0);
    expect(query.nearestSquared([8, 0.2, 0.2], Infinity, budget)).toBeNull();
    expect(query.nearestSquared([100, 0, 0], 1, budget)).toBe(1);
  });

  it('matches analytic face, edge, vertex and degenerate distances', () => {
    const triangle: QueryTriangle = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    expect(triangleDistanceSquared([0.2, 0.3, 2], triangle)).toBeCloseTo(4, 12);
    expect(triangleDistanceSquared([1, 1, 2], triangle)).toBeCloseTo(4.5, 12);
    expect(triangleDistanceSquared([-1, -2, 3], triangle)).toBeCloseTo(14, 12);
    expect(
      triangleDistanceSquared(
        [0.5, 2, 3],
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
        ],
      ),
    ).toBe(13);
    expect(
      triangleDistanceSquared(
        [1, 2, 3],
        [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
      ),
    ).toBe(14);
  });

  it('matches a tiled rectangle oracle and traverses all concave depth layers', () => {
    const triangles: QueryTriangle[] = [];
    for (let z = 0; z < 8; z++)
      for (let y = -4; y < 4; y += 0.5)
        for (let x = -4; x < 4; x += 0.5) {
          triangles.push([
            [x, y, z],
            [x + 0.5, y, z],
            [x, y + 0.5, z],
          ]);
          triangles.push([
            [x + 0.5, y, z],
            [x + 0.5, y + 0.5, z],
            [x, y + 0.5, z],
          ]);
        }
    const original = JSON.stringify(triangles);
    const query = createTriangleQuery(triangles);
    expect(query.nodeCount).toBeGreaterThan(1);
    expect(query.nodeCount).toBeLessThan(triangles.length);
    for (let i = 0; i < 300; i++) {
      const x = Math.sin(i * 1.31) * 6,
        y = Math.cos(i * 2.27) * 6,
        z = Math.sin(i * 0.87) * 10;
      const dz = Math.abs(z - Math.max(0, Math.min(7, Math.round(z))));
      const exact = Math.max(0, Math.abs(x) - 4) ** 2 + Math.max(0, Math.abs(y) - 4) ** 2 + dz ** 2;
      expect(query.nearestSquared([x, y, z])).toBeCloseTo(exact, 10);
      expect(query.nearestSquared([x, y, z], 0.25)).toBeCloseTo(Math.min(exact, 0.25 ** 2), 10);
    }
    const hit = { primitive: -1, distance: -1, frontFace: false };
    for (let layer = 7; layer >= 0; layer--) {
      expect(query.trace(hit, [0.12, 0.23, 9], [0, 0, -2], (8 - layer) / 2 + 0.01, 6)).toBe(true);
      expect(hit.distance).toBeCloseTo((9 - layer) / 2, 12);
      expect(hit.frontFace).toBe(true);
    }
    expect(query.trace(hit, [0.12, 0.23, -1], [0, 0, 1], 0, 20)).toBe(true);
    expect(hit.distance).toBe(1);
    expect(hit.frontFace).toBe(false);
    const last = { ...hit };
    expect(query.trace(hit, [5, 0, 9], [0, 0, -2], 0, 6)).toBe(false);
    expect(hit).toEqual(last);
    expect(query.trace(hit, [0.12, 0.23, 9], [0, 0, -2], 0, 0.9)).toBe(false);
    expect(JSON.stringify(triangles)).toBe(original);
  });

  it('keeps deterministic primitive ties and handles an empty query', () => {
    const triangle: QueryTriangle = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const query = createTriangleQuery(Array.from({ length: 30 }, () => triangle));
    const hit = { primitive: -1, distance: -1, frontFace: false };
    expect(query.trace(hit, [0.1, 0.2, 1], [0, 0, -1], 0, 1)).toBe(true);
    expect(hit.primitive).toBe(0);
    const empty = createTriangleQuery([]);
    expect(empty.nearestSquared([0, 0, 0])).toBe(Infinity);
    expect(empty.trace(hit, [0, 0, 1], [0, 0, -1], 0, 2)).toBe(false);
  });
});
