// @forgeax/engine-debug-draw -- shape geometry unit tests (w16/w17/w18/w19)
//
// Tests for 4 shape functions: line, aabb, sphere, frustum.
// Verifies vertex count, position layout, color packing (ColorLike -> u8x4 norm),
// and frustum singular-VP defence.

import { describe, expect, it, vi } from 'vitest';
import { DebugDraw, INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY } from '../src';
import { color as colorMath } from '@forgeax/engine-math';

function makeMockDevice() {
  return {
    destroyBuffer: vi.fn(),
    queue: { writeBuffer: vi.fn() },
  } as any;
}

function makeDd(initialCap = INITIAL_VERTEX_CAPACITY) {
  const device = makeMockDevice();
  return new DebugDraw(
    device,
    {} as any, // pipeline
    {} as any, // vbo
    {} as any, // uniformBuf
    {} as any, // bindGroup
    initialCap,
    MAX_VERTEX_CAPACITY,
  );
}

/** Unpack a packed u32 color to [r, g, b, a] bytes. */
function unpackColor(packed: number): [number, number, number, number] {
  return [
    packed & 0xff,
    (packed >> 8) & 0xff,
    (packed >> 16) & 0xff,
    (packed >> 24) & 0xff,
  ];
}

// ==========================================================================
// w16: line shape vertex count + position + color packing
// ==========================================================================

describe('w16: line shape geometry (AC-03)', () => {
  it('dd.line pushes exactly 2 vertices to staging', () => {
    const dd = makeDd();
    dd.line([0, 0, 0], [1, 2, 3], [1, 0, 0, 1]);
    expect(dd._stagingVertexCount).toBe(2);
  });

  it('vertex positions match input Vec3 values', () => {
    const dd = makeDd();
    const a: [number, number, number] = [1, 2, 3];
    const b: [number, number, number] = [4, 5, 6];
    dd.line(a, b, [1, 0, 0, 1]);

    const p0 = dd._getVertexPosition(0);
    const p1 = dd._getVertexPosition(1);
    expect(p0[0]).toBeCloseTo(a[0]);
    expect(p0[1]).toBeCloseTo(a[1]);
    expect(p0[2]).toBeCloseTo(a[2]);
    expect(p1[0]).toBeCloseTo(b[0]);
    expect(p1[1]).toBeCloseTo(b[1]);
    expect(p1[2]).toBeCloseTo(b[2]);
  });

  it('color param accepts ColorLike as plain [r,g,b,a] array', () => {
    const dd = makeDd();
    dd.line([0, 0, 0], [1, 1, 1], [0.2, 0.4, 0.6, 0.8]);

    const [r, g, b, a] = unpackColor(dd._getVertexPackedColor(0));
    expect(r).toBe(Math.round(0.2 * 255));
    expect(g).toBe(Math.round(0.4 * 255));
    expect(b).toBe(Math.round(0.6 * 255));
    expect(a).toBe(Math.round(0.8 * 255));
  });

  it('color param accepts ColorLike as Float32Array', () => {
    const dd = makeDd();
    const color32 = Float32Array.of(0.1, 0.3, 0.5, 0.7);
    dd.line([0, 0, 0], [1, 1, 1], color32);

    const [r, g, b, a] = unpackColor(dd._getVertexPackedColor(0));
    const rExpected = Math.round((color32[0] as number) * 255);
    const gExpected = Math.round((color32[1] as number) * 255);
    const bExpected = Math.round((color32[2] as number) * 255);
    const aExpected = Math.round((color32[3] as number) * 255);

    expect(r).toBe(rExpected);
    expect(g).toBe(gExpected);
    expect(b).toBe(bExpected);
    expect(a).toBe(aExpected);
  });

  it('color param accepts branded Color via math color.create()', () => {
    const dd = makeDd();
    const branded = colorMath.create(0.3, 0.6, 0.9, 0.5);
    dd.line([0, 0, 0], [1, 1, 1], branded);

    const [r, g, b, a] = unpackColor(dd._getVertexPackedColor(0));
    // branded Color uses Float32Array internally
    const rExpected = Math.round((branded[0] as number) * 255);
    const gExpected = Math.round((branded[1] as number) * 255);
    const bExpected = Math.round((branded[2] as number) * 255);
    const aExpected = Math.round((branded[3] as number) * 255);

    expect(r).toBe(rExpected);
    expect(g).toBe(gExpected);
    expect(b).toBe(bExpected);
    expect(a).toBe(aExpected);
  });

  it('color with alpha omitted defaults to 1.0', () => {
    const dd = makeDd();
    dd.line([0, 0, 0], [1, 1, 1], [1, 1, 1]);

    const [, , , a] = unpackColor(dd._getVertexPackedColor(0));
    expect(a).toBe(255);
  });

  it('color components clamped to [0,1] before pack', () => {
    const dd = makeDd();
    dd.line([0, 0, 0], [1, 1, 1], [-0.5, 1.5, 0.5, 0.5]);

    const [r, g] = unpackColor(dd._getVertexPackedColor(0));
    expect(r).toBe(0); // clamped from -0.5
    expect(g).toBe(255); // clamped from 1.5
  });

  it('both vertices get the same color', () => {
    const dd = makeDd();
    dd.line([0, 0, 0], [1, 1, 1], [0.25, 0.5, 0.75, 1]);

    expect(dd._getVertexPackedColor(0)).toBe(dd._getVertexPackedColor(1));
  });
});

// ==========================================================================
// w17: aabb shape vertex count + geometry (AC-03)
// ==========================================================================

describe('w17: aabb shape geometry (AC-03)', () => {
  it('dd.aabb pushes exactly 24 vertices to staging', () => {
    const dd = makeDd();
    dd.aabb([0, 0, 0], [1, 1, 1], [0, 0, 1, 1]);
    expect(dd._stagingVertexCount).toBe(24);
  });

  it('aabb vertex positions are within [min,max] bounding box', () => {
    const dd = makeDd();
    const min: [number, number, number] = [-2, -1, 0];
    const max: [number, number, number] = [3, 4, 5];
    dd.aabb(min, max, [0, 0, 1, 1]);

    for (let i = 0; i < 24; i++) {
      const [x, y, z] = dd._getVertexPosition(i);
      expect(x).toBeGreaterThanOrEqual(min[0]);
      expect(x).toBeLessThanOrEqual(max[0]);
      expect(y).toBeGreaterThanOrEqual(min[1]);
      expect(y).toBeLessThanOrEqual(max[1]);
      expect(z).toBeGreaterThanOrEqual(min[2]);
      expect(z).toBeLessThanOrEqual(max[2]);
    }
  });

  it('aabb vertices form all 8 corner values', () => {
    const dd = makeDd();
    dd.aabb([0, 0, 0], [1, 2, 3], [0, 0, 1, 1]);

    const corners = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const [x, y, z] = dd._getVertexPosition(i);
      corners.add(`${x},${y},${z}`);
    }

    // All 8 corners should appear at least once
    expect(corners.has('0,0,0')).toBe(true);
    expect(corners.has('1,0,0')).toBe(true);
    expect(corners.has('0,2,0')).toBe(true);
    expect(corners.has('1,2,0')).toBe(true);
    expect(corners.has('0,0,3')).toBe(true);
    expect(corners.has('1,0,3')).toBe(true);
    expect(corners.has('0,2,3')).toBe(true);
    expect(corners.has('1,2,3')).toBe(true);
  });

  it('aabb color param accepts ColorLike', () => {
    const dd = makeDd();
    dd.aabb([0, 0, 0], [1, 1, 1], [1, 1, 0, 1]);

    const [r, g, b, a] = unpackColor(dd._getVertexPackedColor(0));
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(0);
    expect(a).toBe(255);
  });

  it('all aabb vertices share the same color', () => {
    const dd = makeDd();
    dd.aabb([0, 0, 0], [2, 2, 2], [0.1, 0.2, 0.3, 1]);

    const firstPacked = dd._getVertexPackedColor(0);
    for (let i = 1; i < 24; i++) {
      expect(dd._getVertexPackedColor(i)).toBe(firstPacked);
    }
  });
});

// ==========================================================================
// w18: sphere shape vertex count + geometry (segments=16 default)
// ==========================================================================

describe('w18: sphere shape geometry (AC-03)', () => {
  it('dd.sphere with default segments=16 pushes exactly 96 vertices', () => {
    const dd = makeDd();
    dd.sphere([0, 0, 0], 1, [0, 1, 0, 1]);
    expect(dd._stagingVertexCount).toBe(96); // 3 planes * 2 vertices/seg * 16 segs
  });

  it('sphere with custom segments produces correct vertex count', () => {
    const dd = makeDd();
    dd.sphere([0, 0, 0], 1, [0, 1, 0, 1], 8);
    expect(dd._stagingVertexCount).toBe(48); // 3 * 2 * 8
  });

  it('all sphere vertices are at radius distance from center', () => {
    const dd = makeDd();
    const center: [number, number, number] = [10, 20, 30];
    const radius = 5;
    dd.sphere(center, radius, [0, 1, 0, 1]);

    for (let i = 0; i < 96; i++) {
      const [x, y, z] = dd._getVertexPosition(i);
      const dx = x - center[0];
      const dy = y - center[1];
      const dz = z - center[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      expect(dist).toBeCloseTo(radius, 5);
    }
  });

  it('sphere color param accepts ColorLike', () => {
    const dd = makeDd();
    dd.sphere([0, 0, 0], 2, [0, 1, 0, 1]);

    const [r, g, b, a] = unpackColor(dd._getVertexPackedColor(0));
    expect(r).toBe(0);
    expect(g).toBe(255);
    expect(b).toBe(0);
    expect(a).toBe(255);
  });

  it('all sphere vertices share the same color', () => {
    const dd = makeDd();
    dd.sphere([0, 0, 0], 1, [0.5, 0.25, 0.75, 1]);

    const firstPacked = dd._getVertexPackedColor(0);
    for (let i = 1; i < 96; i++) {
      expect(dd._getVertexPackedColor(i)).toBe(firstPacked);
    }
  });
});

// ==========================================================================
// w19: frustum shape vertex count + singular VP defence
// ==========================================================================

// A valid WebGPU-style perspective projection (z maps to [0,1] NDC, matches mat4.perspective).
function makeValidVP(): [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] {
  // fov=90deg, aspect=1, near=0.1, far=100
  const f = 1.0; // 1/tan(fov/2) for fov=90
  const n = 0.1;
  const far = 100;
  const nf = 1 / (n - far);
  return [
    f, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * n * nf, 0,
  ];
}

// A singular matrix (all zeros) for degenerate frustum test
const SINGULAR_VP: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] = [
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
];

describe('w19: frustum shape geometry (AC-03)', () => {
  it('dd.frustum with valid VP pushes exactly 24 vertices', () => {
    const dd = makeDd();
    const vp = makeValidVP();
    dd.frustum(vp, [1, 1, 0, 1]);
    expect(dd._stagingVertexCount).toBe(24);
  });

  it('frustum color param accepts ColorLike', () => {
    const dd = makeDd();
    dd.frustum(makeValidVP(), [1, 1, 0, 1]);

    const [r, g, b, a] = unpackColor(dd._getVertexPackedColor(0));
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(0);
    expect(a).toBe(255);
  });

  it('all frustum vertices share the same color', () => {
    const dd = makeDd();
    dd.frustum(makeValidVP(), [0.2, 0.8, 0.4, 1]);

    const firstPacked = dd._getVertexPackedColor(0);
    for (let i = 1; i < 24; i++) {
      expect(dd._getVertexPackedColor(i)).toBe(firstPacked);
    }
  });

  it('frustum with near-singular VP triggers console.warn and no-op', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dd = makeDd();
    dd.frustum(SINGULAR_VP, [1, 1, 0, 1]);

    expect(dd._stagingVertexCount).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('frustum with near-singular VP does not throw', () => {
    const dd = makeDd();
    expect(() => dd.frustum(SINGULAR_VP, [1, 1, 0, 1])).not.toThrow();
  });

  it('frustum with singular VP does not affect subsequent shape calls', () => {
    const dd = makeDd();
    dd.frustum(SINGULAR_VP, [1, 1, 0, 1]); // no-op
    dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]); // should still work

    expect(dd._stagingVertexCount).toBe(2);
  });
});