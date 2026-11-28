import { describe, expect, it } from 'vitest';
import { type PolyMesh, meshSurface } from '../mesh-scene.ts';
import type { P3 } from '../scene.ts';

/**
 * A square with a V notch cut from its top edge. Corner 0 sees the reflex notch corner 3 across the
 * interior, so a fan from corner 0 emits the triangle (0, 2, 3) wound against the face normal.
 */
const NOTCHED: PolyMesh = {
  positions: [
    [0, 0, 0],
    [4, 0, 0],
    [4, 4, 0],
    [2, 1, 0],
    [0, 4, 0],
  ],
  faces: [[0, 1, 2, 3, 4]],
};

function cross(a: P3, b: P3): P3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function sub(a: P3, b: P3): P3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

describe('meshSurface on concave faces', () => {
  it('emits only triangles wound with the face normal, so a concave notch never shades as a back face', () => {
    const tris = meshSurface(NOTCHED);
    // The face normal is +Z (counter-clockwise in XY): every triangle must keep a positive Z normal.
    expect(tris.length).toBe(3);
    for (const t of tris) {
      const n = cross(sub(t.b, t.a), sub(t.c, t.a));
      expect(n[2]).toBeGreaterThan(0);
    }
  });

  it('covers the notched face exactly: triangle areas sum to the polygon area', () => {
    const tris = meshSurface(NOTCHED);
    const area = tris.reduce((sum, t) => {
      const n = cross(sub(t.b, t.a), sub(t.c, t.a));
      return sum + Math.abs(n[2]) / 2;
    }, 0);
    // Shoelace area of the square 16 less the notch: 10 square units.
    expect(area).toBeCloseTo(10, 9);
  });
});
