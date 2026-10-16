// @forgeax/engine-debug-draw -- arrow + axes gizmo unit tests (solo round 20260713-222551)
//
// Regression guard for the friction that motivated the primitives: DebugDraw had
// line/aabb/sphere/frustum but no arrow (line + head) or axes (the RGB local-frame triad),
// so visualizing an entity's orientation forced hand-assembling arrowhead segments + axis
// endpoints + the color convention. These tests pin:
//   arrow: 1 (1) 10 vertices (body + 4 head segments), (2) body runs start->end,
//          (3) the 4 head segments all originate at `end` (head sits at the tip),
//          (4) zero-length arrow degrades to the 2-vertex body only,
//          (5) shared color across all vertices.
//   axes:  (6) 30 vertices (3 arrows x 10), (7) colors are X=red/Y=green/Z=blue,
//          (8) each axis arrow originates at the transform translation,
//          (9) a yawed transform's X arrow points along the ROTATED local X (not world X).

import { color as colorMath, mat4, quat, vec3 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import { DebugDraw, INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY } from '../src';

function makeDd() {
  const device = { destroyBuffer: vi.fn(), queue: { writeBuffer: vi.fn() } } as any;
  return new DebugDraw(
    device,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    INITIAL_VERTEX_CAPACITY,
    MAX_VERTEX_CAPACITY,
  );
}

function unpackColor(packed: number): [number, number, number, number] {
  return [packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, (packed >> 24) & 0xff];
}

describe('arrow gizmo geometry', () => {
  it('pushes 10 vertices (body + 4 head segments)', () => {
    const dd = makeDd();
    dd.arrow([0, 0, 0], [0, 0, 5], [1, 1, 1, 1]);
    expect(dd._stagingVertexCount).toBe(10);
  });

  it('body segment runs start -> end', () => {
    const dd = makeDd();
    dd.arrow([1, 2, 3], [1, 2, 8], [1, 1, 1, 1]);
    const p0 = dd._getVertexPosition(0);
    const p1 = dd._getVertexPosition(1);
    expect([p0[0], p0[1], p0[2]]).toEqual([1, 2, 3]);
    expect([p1[0], p1[1], p1[2]]).toEqual([1, 2, 8]);
  });

  it('the 4 head segments all originate at `end` (arrowhead sits at the tip)', () => {
    const dd = makeDd();
    const end: [number, number, number] = [0, 0, 5];
    dd.arrow([0, 0, 0], end, [1, 1, 1, 1]);
    // Vertices 2,4,6,8 are the head-segment starts — each must be `end`.
    for (const i of [2, 4, 6, 8]) {
      const p = dd._getVertexPosition(i);
      expect(p[0]).toBeCloseTo(end[0], 5);
      expect(p[1]).toBeCloseTo(end[1], 5);
      expect(p[2]).toBeCloseTo(end[2], 5);
    }
  });

  it('zero-length arrow degrades to the 2-vertex body only', () => {
    const dd = makeDd();
    dd.arrow([2, 2, 2], [2, 2, 2], [1, 1, 1, 1]);
    expect(dd._stagingVertexCount).toBe(2);
  });

  it('all vertices share the arrow color', () => {
    const dd = makeDd();
    dd.arrow([0, 0, 0], [0, 0, 5], [0.2, 0.4, 0.6, 1]);
    for (let i = 0; i < dd._stagingVertexCount; i++) {
      const [r, g, b] = unpackColor(dd._getVertexPackedColor(i));
      expect(r).toBe(Math.round(0.2 * 255));
      expect(g).toBe(Math.round(0.4 * 255));
      expect(b).toBe(Math.round(0.6 * 255));
    }
  });
});

describe('axes gizmo geometry', () => {
  it('pushes 30 vertices (3 arrows x 10)', () => {
    const dd = makeDd();
    dd.axes(mat4.identity(mat4.create()), 1);
    expect(dd._stagingVertexCount).toBe(30);
  });

  it('axis colors are X=red, Y=green, Z=blue', () => {
    const dd = makeDd();
    dd.axes(mat4.identity(mat4.create()), 1);
    // Each arrow is 10 vertices; vertex 0 of each block carries that axis's color.
    const [rx, gx, bx] = unpackColor(dd._getVertexPackedColor(0)); // X
    const [ry, gy, by] = unpackColor(dd._getVertexPackedColor(10)); // Y
    const [rz, gz, bz] = unpackColor(dd._getVertexPackedColor(20)); // Z
    expect([rx, gx, bx]).toEqual([255, 0, 0]);
    expect([ry, gy, by]).toEqual([0, 255, 0]);
    expect([rz, gz, bz]).toEqual([0, 0, 255]);
  });

  it('each axis arrow originates at the transform translation', () => {
    const dd = makeDd();
    const m = mat4.create();
    mat4.identity(m);
    // Set translation (col 3) to (5, 6, 7).
    (m as unknown as number[])[12] = 5;
    (m as unknown as number[])[13] = 6;
    (m as unknown as number[])[14] = 7;
    dd.axes(m, 2);
    for (const block of [0, 10, 20]) {
      const p = dd._getVertexPosition(block); // body start of each arrow
      expect(p[0]).toBeCloseTo(5, 5);
      expect(p[1]).toBeCloseTo(6, 5);
      expect(p[2]).toBeCloseTo(7, 5);
    }
  });

  it("a yawed transform's X arrow points along the ROTATED local X, not world X", () => {
    const dd = makeDd();
    // 90 deg yaw about +Y: local +X maps to world -Z.
    const q = quat.eulerY(Math.PI / 2);
    const m = mat4.fromQuat(mat4.create(), q);
    const length = 3;
    dd.axes(m, length);
    // Arrow 0 (X) body end is vertex 1.
    const end = dd._getVertexPosition(1);
    // Expected local-X endpoint: origin(0) + length * rotated(+X) = length * (0,0,-1).
    const rotatedX = quat.transformVec3(vec3.create(), q, new Float32Array([1, 0, 0]) as any);
    expect(end[0]).toBeCloseTo(length * (rotatedX[0] as number), 4);
    expect(end[1]).toBeCloseTo(length * (rotatedX[1] as number), 4);
    expect(end[2]).toBeCloseTo(length * (rotatedX[2] as number), 4);
    // Sanity: it is NOT world +X.
    expect(end[0]).not.toBeCloseTo(length, 2);
    void colorMath;
  });
});
