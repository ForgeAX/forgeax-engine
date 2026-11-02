import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { coverageRegions } from '../watertight-coverage';

function normalize(groups: number[][]): number[][] {
  return groups
    .map((group) => group.slice().sort((a, b) => a - b))
    .sort((a, b) => (a[0] as number) - (b[0] as number));
}

function oracle(points: readonly Tuple3[], link: number): number[][] {
  const unseen = new Set(points.map((_point, i) => i));
  const groups: number[][] = [];
  for (let start = 0; start < points.length; start++) {
    if (!unseen.delete(start)) continue;
    const group = [start];
    for (let cursor = 0; cursor < group.length; cursor++) {
      const a = points[group[cursor] as number] as Tuple3;
      for (const index of unseen) {
        const b = points[index] as Tuple3;
        const x = a[0] - b[0],
          y = a[1] - b[1],
          z = a[2] - b[2];
        if (Math.sqrt(x * x + y * y + z * z) <= link) {
          unseen.delete(index);
          group.push(index);
        }
      }
    }
    groups.push(group);
  }
  return normalize(groups);
}

describe('coverage region connectivity', () => {
  it('matches a complete distance graph for duplicates, bridges, cell corners and seeded clouds', () => {
    const spacing = 0.04,
      link = spacing * 1.5;
    let seed = 271828;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const clouds: Tuple3[][] = [
      Array.from({ length: 128 }, (_unused, i) => [i % 2 ? 0.2 : 0, 0, 0]),
      Array.from({ length: 64 }, (_unused, i) => [(i - 32) * link * 0.9, 0, 0]),
      [
        [0, 0, 0],
        [link, 0, 0],
        [link, link, link],
        [-link, 0, 0],
        [link * 0.5, link * 0.5, 0],
      ],
      Array.from({ length: 160 }, () => [
        random() * 0.3 - 0.15,
        random() * 0.3 - 0.15,
        random() * 0.3 - 0.15,
      ]),
    ];
    clouds.push([
      [Number.NaN, 0, 0],
      [Number.NaN, 0, 0],
      [0, 0, 0],
    ]);
    for (const points of clouds) {
      const actual = coverageRegions(
        points,
        new Float64Array(points.length).fill(1),
        new Float64Array(points.length).fill(1),
        new Int32Array(points.length).fill(-1),
        0.5,
        spacing,
      );
      expect(normalize(actual)).toEqual(oracle(points, link));
    }
  });
});
