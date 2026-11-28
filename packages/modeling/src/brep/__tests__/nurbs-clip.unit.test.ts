import { describe, expect, it } from 'vitest';
import { clipBranchToFace } from '../nurbs-clip.ts';
import type { Curve } from '../types.ts';
import type { P3 } from '../vec.ts';

const TOL = 1e-7;
// Unit square in z = 0, counter-clockwise seen from +z.
const SQUARE: P3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];
const UP: P3 = [0, 0, 1];
// Horizontal line y = 0.5 running in +x, parameter x in [-1, 2].
const CROSS: Curve = { kind: 'line', o: [-1, 0.5, 0], d: [1, 0, 0] };

describe('clipBranchToFace', () => {
  it('clips a line crossing the square to its interior chord, endpoints on the boundary', () => {
    const r = clipBranchToFace(CROSS, -1, 2, SQUARE, UP, TOL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.p0[0]).toBeCloseTo(0, 6);
    expect(r.value.p1[0]).toBeCloseTo(1, 6);
    expect(r.value.p0[1]).toBeCloseTo(0.5, 6);
    expect(r.value.p1[1]).toBeCloseTo(0.5, 6);
  });

  it('refuses a branch that never reaches the face (deliberate break: must not return ok)', () => {
    const away: Curve = { kind: 'line', o: [-1, 5, 0], d: [1, 0, 0] };
    const r = clipBranchToFace(away, -1, 2, SQUARE, UP, TOL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect((r.error.detail as Record<string, unknown>).reason).toBe('clip-no-crossing');
  });

  it('refuses a branch that enters and leaves the face twice', () => {
    // A tall line bent across the square twice is not a line; a zig via a circle centred on the face.
    const ring: Curve = {
      kind: 'circle',
      frame: { o: [0.5, 0.5, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      radius: 0.3,
    };
    const r = clipBranchToFace(ring, 0, 2 * Math.PI, SQUARE, UP, TOL);
    expect(r.ok).toBe(false);
  });
});
