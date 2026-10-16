import { describe, expect, it } from 'vitest';
import { createBlendSpace1D, createBlendSpace2D } from '../index';

describe('TypeScript BlendSpace sampling', () => {
  it('interpolates neighboring 1D samples in author order and clamps outside the range', () => {
    const samples = [2, -1, 0];
    const space = createBlendSpace1D(samples).unwrap();
    const weights = new Float32Array(3).fill(9);
    space.sample(weights, 1).unwrap();
    expect([...weights]).toEqual([0.5, 0, 0.5]);
    space.sample(weights, -5).unwrap();
    expect([...weights]).toEqual([0, 1, 0]);
    space.sample(weights, 5).unwrap();
    expect([...weights]).toEqual([1, 0, 0]);
    samples[0] = 100;
    space.sample(weights, 1).unwrap();
    expect([...weights]).toEqual([0.5, 0, 0.5]);
  });

  it('supports a single 1D sample and rejects duplicate/non-finite samples', () => {
    const weights = new Float32Array(1);
    createBlendSpace1D([7]).unwrap().sample(weights, -3).unwrap();
    expect(weights[0]).toBe(1);
    for (const samples of [[], [0, 0], [0, Number.NaN], [0, Infinity]]) {
      const result = createBlendSpace1D(samples);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('animation-blend-space-invalid');
    }
  });

  it('samples a 2D triangle mesh, including shared edges, vertices and nearest boundaries', () => {
    const points: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const triangles: [number, number, number][] = [
      [0, 1, 2],
      [0, 2, 3],
    ];
    const space = createBlendSpace2D({ points, triangles }).unwrap();
    const weights = new Float32Array(4).fill(9);
    space.sample(weights, 0, 0).unwrap();
    expect([...weights]).toEqual([0.5, 0, 0.5, 0]);
    space.sample(weights, 0, -0.5).unwrap();
    expect([...weights]).toEqual([0.5, 0.25, 0.25, 0]);
    space.sample(weights, 2, 0).unwrap();
    expect([...weights]).toEqual([0, 0.5, 0.5, 0]);
    space.sample(weights, -3, 3).unwrap();
    expect([...weights]).toEqual([0, 0, 0, 1]);
    points[0] = [100, 100];
    triangles[0] = [3, 3, 3];
    space.sample(weights, -1, -1).unwrap();
    expect([...weights]).toEqual([1, 0, 0, 0]);
  });

  it('reproduces affine fields and continuous weights across triangle boundaries', () => {
    const space = createBlendSpace2D({
      points: [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ],
      triangles: [
        [0, 1, 2],
        [0, 2, 3],
      ],
    }).unwrap();
    const weights = new Float32Array(4);
    for (let y = 0; y <= 2; y += 0.125) {
      for (let x = 0; x <= 2; x += 0.125) {
        space.sample(weights, x, y).unwrap();
        expect([...weights].every((weight) => weight >= 0 && weight <= 1)).toBe(true);
        expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
        expect(2 * ((weights[1] ?? 0) + (weights[2] ?? 0))).toBeCloseTo(x, 6);
        expect(2 * ((weights[2] ?? 0) + (weights[3] ?? 0))).toBeCloseTo(y, 6);
      }
    }
  });

  it('validates authored topology and leaves output untouched on invalid runtime inputs', () => {
    for (const triangles of [[], [[0, 1, 9]], [[0, 0, 1]]] as const) {
      expect(
        createBlendSpace2D({
          points: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          triangles,
        }).ok,
      ).toBe(false);
    }
    expect(
      createBlendSpace2D({
        points: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        triangles: [[0, 1, 2]],
      }).ok,
    ).toBe(false);
    const space = createBlendSpace2D({
      points: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      triangles: [[0, 1, 2]],
    }).unwrap();
    const weights = new Float32Array([7, 8, 9]);
    expect(space.sample(weights, Number.NaN, 0).ok).toBe(false);
    expect([...weights]).toEqual([7, 8, 9]);
    const wrongSize = new Float32Array([5, 6]);
    expect(space.sample(wrongSize, 0, 0).ok).toBe(false);
    expect([...wrongSize]).toEqual([5, 6]);
  });
});
