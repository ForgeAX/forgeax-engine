import { describe, expect, it } from 'vitest';
import { box, cone, cylinder, extrude, sphere, torus } from '../../build';
import { dist3, len3, type P3, sub3 } from '../../vec';
import { sectionByPlane } from '../section';
import { silhouette } from '../silhouette';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const length = (pts: readonly P3[], closed: boolean): number => {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += dist3(pts[i] as P3, pts[i + 1] as P3);
  return closed ? s + dist3(pts[pts.length - 1] as P3, pts[0] as P3) : s;
};

describe('plane section', () => {
  it('cuts a box into one closed loop of the right perimeter', () => {
    const s = must(box({ size: [2, 3, 4] }));
    const r = must(sectionByPlane(s, { origin: [0, 0, 0.3], normal: [0, 0, 1] }));
    expect(r.curves.length).toBe(1);
    const c = r.curves[0] as (typeof r.curves)[number];
    expect(c.closed).toBe(true);
    expect(c.faces.length).toBeGreaterThanOrEqual(4);
    expect(length(c.points, true)).toBeCloseTo(10, 6);
    expect(r.residual).toBeLessThan(1e-9);
    expect(r.coplanarFaces).toEqual([]);
  });

  it('reports the face that lies in the plane instead of curves', () => {
    const s = must(box({ size: [2, 3, 4] }));
    const r = must(sectionByPlane(s, { origin: [0, 0, 2], normal: [0, 0, 1] }));
    expect(r.coplanarFaces.length).toBe(1);
  });

  it('a sphere cut is a circle on the sphere', () => {
    const s = must(sphere({ radius: 1.2 }));
    const r = must(sectionByPlane(s, { origin: [0, 0, 0.5], normal: [0, 0, 1] }));
    expect(r.curves.length).toBe(1);
    const c = r.curves[0] as (typeof r.curves)[number];
    expect(c.closed).toBe(true);
    const rho = Math.sqrt(1.44 - 0.25);
    for (const p of c.points) {
      expect(Math.abs(len3(p) - 1.2)).toBeLessThan(1e-9);
      expect(Math.abs(p[2] - 0.5)).toBeLessThan(1e-9);
    }
    // The chord polyline lies inside the circle by its sag only.
    expect(1 - length(c.points, true) / (2 * Math.PI * rho)).toBeLessThan(1e-3);
    expect(r.chordResidual).toBeLessThan(1e-3);
  });

  it('a torus cut through its axis gives two circles', () => {
    const s = must(torus({ major: 3, minor: 1 }));
    const r = must(sectionByPlane(s, { origin: [0, 0, 0], normal: [0, 1, 0] }));
    expect(r.curves.length).toBe(2);
    for (const c of r.curves) {
      expect(c.closed).toBe(true);
      for (const p of c.points) {
        const ring = Math.sqrt(p[0] * p[0] + p[1] * p[1]) - 3;
        expect(Math.abs(ring * ring + p[2] * p[2] - 1)).toBeLessThan(1e-9);
      }
    }
  });

  it('a slanted cut of a cone is one closed curve on the cone', () => {
    const s = must(cone({ radius: 2, height: 3 }));
    const r = must(sectionByPlane(s, { origin: [0, 0, 0], normal: [0.2, 0, 1] }));
    expect(r.curves.length).toBe(1);
    expect((r.curves[0] as (typeof r.curves)[number]).closed).toBe(true);
    expect(r.residual).toBeLessThan(1e-9);
  });

  it('keeps the outer loop and the hole loop of a holed plate separate', () => {
    const plate = must(
      extrude({
        profile: [
          [0, 0],
          [6, 0],
          [6, 4],
          [0, 4],
        ],
        holes: [
          [
            [2, 1],
            [4, 1],
            [4, 3],
            [2, 3],
          ],
        ],
        depth: 2,
      }),
    );
    const r = must(sectionByPlane(plate, { origin: [0, 0, 1], normal: [0, 0, 1] }));
    expect(r.curves.length).toBe(2);
    expect(r.curves.map((c) => Math.round(length(c.points, true))).sort((a, b) => a - b)).toEqual([
      8, 20,
    ]);
  });

  it('a plane that misses the shape gives nothing, and a plane with no normal is rejected', () => {
    const s = must(box({ size: [2, 3, 4] }));
    expect(must(sectionByPlane(s, { origin: [0, 0, 9], normal: [0, 0, 1] })).curves).toEqual([]);
    const bad = sectionByPlane(s, { origin: [0, 0, 0], normal: [0, 0, 0] });
    expect(bad.ok).toBe(false);
  });

  it('an open cut of a cylinder side ends at the cap rims', () => {
    const s = must(cylinder({ radius: 1.5, height: 3 }));
    const r = must(sectionByPlane(s, { origin: [0, 0, 0], normal: [1, 0, 0] }));
    expect(r.curves.length).toBe(1);
    const c = r.curves[0] as (typeof r.curves)[number];
    expect(c.closed).toBe(true);
    // A rectangle 3 by 3 through the axis.
    expect(length(c.points, true)).toBeCloseTo(12, 5);
  });
});

describe('silhouette', () => {
  it('a sphere seen along z has its equator as the contour', () => {
    const s = must(sphere({ radius: 1.2 }));
    const r = must(silhouette(s, { kind: 'orthographic', direction: [0, 0, -1] }));
    expect(r.contours.length).toBe(1);
    const c = r.contours[0] as (typeof r.contours)[number];
    expect(c.closed).toBe(true);
    for (const p of c.points) {
      expect(Math.abs(p[2])).toBeLessThan(1e-9);
      expect(Math.abs(len3(p) - 1.2)).toBeLessThan(1e-9);
    }
    expect(r.residual).toBeLessThan(1e-9);
  });

  it('a perspective eye sees a smaller circle of tangency than the equator', () => {
    const s = must(sphere({ radius: 1 }));
    const r = must(silhouette(s, { kind: 'perspective', eye: [0, 0, 4] }));
    const c = r.contours[0] as (typeof r.contours)[number];
    // Tangency circle height is r^2 / d = 0.25.
    for (const p of c.points) expect(Math.abs(p[2] - 0.25)).toBeLessThan(1e-9);
  });

  it('an oblique view of a box picks the six edges around its outline', () => {
    const s = must(box({ size: [2, 3, 4] }));
    const r = must(silhouette(s, { kind: 'orthographic', direction: [1, 2, -3] }));
    expect(r.contours).toEqual([]);
    expect(r.edges.length).toBe(6);
    const total = r.edges.reduce((a, e) => a + len3(sub3(e[e.length - 1] as P3, e[0] as P3)), 0);
    expect(total).toBeCloseTo(2 * 2 + 2 * 3 + 2 * 4, 9);
  });

  it('a view along a cylinder side has the cap rims as edges and two side lines as contour', () => {
    const s = must(cylinder({ radius: 1.5, height: 3 }));
    const r = must(silhouette(s, { kind: 'orthographic', direction: [0, 1, 0] }));
    expect(r.contours.length).toBe(2);
    for (const c of r.contours) {
      expect(c.closed).toBe(false);
      for (const p of c.points) expect(Math.abs(Math.abs(p[0]) - 1.5)).toBeLessThan(1e-9);
    }
  });
});
