import { expect, it } from 'vitest';
import { harborHull } from '../../../harbor-assets';

it('authors a detailed outward keel with finite textured vertices at the admitted craft dimensions', () => {
  const mesh = harborHull(4.6, 1.84);
  const positions = mesh.attributes.position as Float32Array;
  const uv = mesh.attributes.uv as Float32Array;
  const indices = mesh.indices;
  if (indices === undefined) throw new Error('The authored hull requires indexed triangles');
  expect(positions.length / 3).toBeGreaterThan(300);
  expect(uv.length).toBe((positions.length / 3) * 2);
  expect(Array.from(positions).every(Number.isFinite)).toBe(true);
  expect(Math.min(...Array.from(positions).filter((_value, index) => index % 3 === 0))).toBeCloseTo(
    -2.3,
  );
  expect(Math.max(...Array.from(positions).filter((_value, index) => index % 3 === 0))).toBeCloseTo(
    2.3,
  );
  let keelTriangles = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const [ai, bi, ci] = Array.from(indices.slice(index, index + 3));
    if (ai === undefined || bi === undefined || ci === undefined)
      throw new Error('Incomplete hull triangle');
    const point = (vertex: number) => {
      const [x, y, z] = Array.from(positions.slice(vertex * 3, vertex * 3 + 3));
      if (x === undefined || y === undefined || z === undefined)
        throw new Error('Missing hull position');
      return { x, y, z };
    };
    const a = point(ai),
      b = point(bi),
      c = point(ci);
    const normalY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (
      Math.max(Math.abs(a.z), Math.abs(b.z), Math.abs(c.z)) < 0.25 &&
      Math.max(a.y, b.y, c.y) < -0.2
    ) {
      expect(normalY).toBeLessThan(0);
      keelTriangles++;
    }
  }
  expect(keelTriangles).toBeGreaterThan(10);
});
