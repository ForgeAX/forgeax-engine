import { expect, it } from 'vitest';
import { compute2dBounds, create2dGeometry, type Shape2d } from '../dim2';

const curves = [
  { kind: 'circle', radius: 2 },
  { kind: 'annulus', outerRadius: 2, innerRadius: 0.5 },
  { kind: 'ellipse', halfWidth: 3, halfHeight: 1 },
  { kind: 'capsule', radius: 1, halfLength: 2 },
  { kind: 'circular-sector', radius: 2, angle: Math.PI * 1.3 },
  { kind: 'circular-segment', radius: 2, angle: Math.PI * 0.7 },
] as const;

it.each(curves)('$kind bounds are independent of tessellation and enclose the curve', (shape) => {
  const fine = create2dGeometry({ ...shape, resolution: 512 }).unwrap();
  const positions = fine.attributes.position;
  if (!(positions instanceof Float32Array)) throw new Error('missing positions');
  for (const rotation of [0, 0.37, Math.PI / 2, -2.2, 4 * Math.PI + 0.37]) {
    const pose = { translation: [5, -3] as const, rotation };
    const coarse = compute2dBounds({ ...shape, resolution: 3 }, pose).unwrap();
    const precise = compute2dBounds({ ...shape, resolution: 512 }, pose).unwrap();
    expect(coarse).toEqual(precise);
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] as number,
        y = positions[i + 1] as number;
      const tx = 5 + x * Math.cos(rotation) - y * Math.sin(rotation);
      const ty = -3 + x * Math.sin(rotation) + y * Math.cos(rotation);
      expect(tx).toBeGreaterThanOrEqual((coarse.aabb[0] as number) - 1e-6);
      expect(ty).toBeGreaterThanOrEqual((coarse.aabb[1] as number) - 1e-6);
      expect(tx).toBeLessThanOrEqual((coarse.aabb[2] as number) + 1e-6);
      expect(ty).toBeLessThanOrEqual((coarse.aabb[3] as number) + 1e-6);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual((coarse.circle[2] as number) + 1e-6);
    }
  }
});

it('retains polygon extrema and shape admission while bounding curves analytically', () => {
  const shape: Shape2d = {
    kind: 'triangle',
    vertices: [
      [-1, 0],
      [2, 0],
      [0, 3],
    ],
  };
  expect([...compute2dBounds(shape).unwrap().aabb]).toEqual([-1, 0, 2, 3]);
  expect([...compute2dBounds({ kind: 'circle', radius: 2, resolution: 3 }).unwrap().aabb]).toEqual([
    -2, -2, 2, 2,
  ]);
  expect(compute2dBounds({ kind: 'circle', radius: 2, resolution: 2 }).ok).toBe(false);
  expect(compute2dBounds(shape, { rotation: Infinity }).ok).toBe(false);
});
