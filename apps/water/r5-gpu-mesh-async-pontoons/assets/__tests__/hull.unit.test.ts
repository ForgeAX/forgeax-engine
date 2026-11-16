import { expect, it } from 'vitest';
import { hull } from '../estuary.pack';

it('authors an outward closed hull for ordinary back-face culling', () => {
  const mesh = hull();
  const positions = mesh.attributes.position as Float32Array;
  const indices = mesh.indices!;
  const center = [0, 0, 0];
  for (let i = 0; i < positions.length; i++) center[i % 3]! += positions[i]! / (positions.length / 3);
  let signedVolume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const points = [indices[i]!, indices[i + 1]!, indices[i + 2]!].map(index => Array.from(positions.subarray(index * 3, index * 3 + 3)));
    const [a, b, c] = points as [number[], number[], number[]];
    const ab = b.map((value, axis) => value - a[axis]!), ac = c.map((value, axis) => value - a[axis]!);
    const normal = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
    const outward = a.map((value, axis) => (value + b[axis]! + c[axis]!) / 3 - center[axis]!);
    expect(normal.reduce((sum, value, axis) => sum + value * outward[axis]!, 0), `triangle ${i / 3}`).toBeGreaterThan(0);
    signedVolume += a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) + a[1]! * (b[2]! * c[0]! - b[0]! * c[2]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  }
  expect(signedVolume / 6).toBeCloseTo(4.66736, 5);
});
