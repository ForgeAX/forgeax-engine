import { describe, expect, it } from 'vitest';
import { CASES, gridCube, lumpySphere } from '../cases.ts';
import { hausdorff, sharpCoverage, sharpEdges } from '../fidelity.ts';
import type { EvalMesh, Vec3 } from '../mesh.ts';
import { boundsOf } from '../mesh.ts';
import { evaluate } from '../metrics.ts';

const square: EvalMesh = {
  positions: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  faces: [[0, 1, 2, 3]],
};

describe('scaled Jacobian and aspect known answers', () => {
  it('unit square: sJ = 1 and aspect = 1', () => {
    const ev = evaluate(square);
    expect(ev.scaledJacobian.min).toBeCloseTo(1, 12);
    expect(ev.aspect.max).toBeCloseTo(1, 12);
  });

  it('equilateral triangle: sJ = sin 60 degrees, aspect = 1', () => {
    const tri: EvalMesh = {
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [0.5, Math.sqrt(3) / 2, 0],
      ],
      faces: [[0, 1, 2]],
    };
    const ev = evaluate(tri);
    expect(ev.scaledJacobian.min).toBeCloseTo(Math.sin(Math.PI / 3), 12);
    expect(ev.aspect.max).toBeCloseTo(1, 12);
  });

  it('rhombus with a 60 degree corner: sJ min = sin 60 degrees', () => {
    const rhombus: EvalMesh = {
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [1.5, Math.sqrt(3) / 2, 0],
        [0.5, Math.sqrt(3) / 2, 0],
      ],
      faces: [[0, 1, 2, 3]],
    };
    expect(evaluate(rhombus).scaledJacobian.min).toBeCloseTo(Math.sin(Math.PI / 3), 12);
  });

  it('regular 4 x 4 cube: sJ min = 1, aspect max = 1', () => {
    const ev = evaluate(gridCube(4, null));
    expect(ev.scaledJacobian.min).toBeCloseTo(1, 12);
    expect(ev.aspect.max).toBeCloseTo(1, 12);
  });

  it('distorted cube scores strictly below the regular cube', () => {
    const regular = evaluate(gridCube(4, null)).scaledJacobian.min;
    const distorted = evaluate(gridCube(4, { seed: 7, amount: 0.3 })).scaledJacobian.min;
    expect(distorted).toBeLessThan(regular);
  });

  it('regular 32-gon cap is not a quality failure: sJ summary covers triangles and quads only', () => {
    const sides = 32;
    const positions: Vec3[] = [[0, 0, 0] as Vec3];
    for (let i = 0; i < sides; i++) {
      const t = (2 * Math.PI * i) / sides;
      positions.push([Math.cos(t), Math.sin(t), 0] as Vec3);
    }
    const cap: EvalMesh = {
      positions,
      faces: [Array.from({ length: sides }, (_, i) => i + 1)],
    };
    const ev = evaluate(cap);
    expect(ev.counts.ngons).toBe(1);
    expect(ev.scaledJacobian.n).toBe(0);
    expect(ev.elements[0]?.sJ).toBeCloseTo(Math.sin((2 * Math.PI) / sides), 9);
  });
});

describe('valence and Gauss-Bonnet identity', () => {
  it('regular 4 x 4 cube: 8 singularities, deficit sum 8 = 4 * chi', () => {
    const ev = evaluate(gridCube(4, null));
    expect(ev.euler.chi).toBe(2);
    expect(ev.valence.singularities.count).toBe(8);
    expect(ev.euler.deficitSum).toBe(8);
    expect(ev.euler.expected).toBe(8);
    expect(ev.euler.ok).toBe(true);
  });
});

describe('broken elements are reported, never accepted', () => {
  const broken: EvalMesh = {
    positions: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 0, 0],
      [3, 0, 0],
      [5, 2, 0],
      [5, 0, 0],
      [3, 1.5, 0],
    ],
    faces: [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  };

  it('degenerate quad (repeated corner) is listed by id and counted', () => {
    const ev = evaluate(broken);
    expect(ev.degenerate.count).toBe(1);
    expect(ev.degenerate.ids).toEqual([0]);
  });

  it('bow-tie quad is listed as inverted (sJ <= 0) and counted', () => {
    const ev = evaluate(broken);
    expect(ev.inverted.ids).toEqual([1]);
    expect(ev.inverted.count).toBe(1);
  });

  it('bow-tie corner is measured negative, not clamped', () => {
    const ev = evaluate(broken);
    expect(ev.elements[1]?.sJ).toBeLessThan(0);
  });
});

describe('Hausdorff known answers', () => {
  it('a surface against its own copy is 0', () => {
    const d = boundsOf(square.positions).diag;
    expect(hausdorff(square, square, d).max).toBeCloseTo(0, 12);
  });

  it('a plane against the same plane shifted by 0.01 is 0.01', () => {
    const shifted: EvalMesh = {
      positions: square.positions.map(([x, y, z]) => [x, y, z + 0.01] as Vec3),
      faces: square.faces,
    };
    const d = boundsOf(square.positions).diag;
    expect(hausdorff(square, shifted, d).max).toBeCloseTo(0.01, 9);
  });
});

describe('sharp-edge coverage', () => {
  const cubeRef = gridCube(1, null);
  const diag = boundsOf(cubeRef.positions).diag;
  const sharp = sharpEdges(cubeRef, diag);

  it('cube has 12 sharp 90 degree edges', () => {
    expect(sharp.length).toBe(12);
    for (const e of sharp) expect(e.dihedralDeg).toBeCloseTo(90, 6);
  });

  it('the cube itself covers all sharp samples', () => {
    expect(sharpCoverage(cubeRef, diag, sharp)?.covered).toBe(1);
  });

  it('a smooth sphere covers no sharp samples (covered < 0.98)', () => {
    const sphere = lumpySphere(32, 16, 11);
    const sd = boundsOf(sphere.positions).diag;
    const cov = sharpCoverage(sphere, sd, sharp);
    expect(cov?.covered ?? 1).toBeLessThan(0.98);
  });
});

describe('case registry', () => {
  it('every case id is unique and ready cases build', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CASES)
      if (c.status === 'ready') expect(c.build().identity.faces.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('two evaluations of the same case are equal', () => {
    const a = JSON.stringify(evaluate(gridCube(4, { seed: 7, amount: 0.3 })));
    const b = JSON.stringify(evaluate(gridCube(4, { seed: 7, amount: 0.3 })));
    expect(a).toBe(b);
  });
});
