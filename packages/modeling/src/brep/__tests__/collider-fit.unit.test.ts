import { describe, expect, it } from 'vitest';
import { box, cylinder, sphere, torus } from '../build';
import { colliderFit } from '../collider-fit';
import type { Shape } from '../types';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('collider fit report (X7, data only)', () => {
  it('a box fits its own box candidate exactly', () => {
    const shape: Shape = must(box({ size: [2, 3, 4] }));
    const report = must(colliderFit(shape));
    const b = report.candidates.find((c) => c.kind === 'box');
    expect(b).toBeDefined();
    expect(b?.volumeRatio).toBeCloseTo(1, 9);
    expect(b?.kind === 'box' && b.maxDeviation).toBeLessThan(1e-9);
  });

  it('a sphere fits its sphere candidate within tessellation error', () => {
    const shape: Shape = must(sphere({ radius: 1 }));
    const report = must(colliderFit(shape));
    const s = report.candidates.find((c) => c.kind === 'sphere');
    expect(s?.volumeRatio).toBeGreaterThan(0.95);
    expect(s?.volumeRatio).toBeLessThan(1.05);
    expect(s?.kind === 'sphere' && s.maxDeviation).toBeLessThan(0.05);
  });

  it('a cylinder hull is an inscribed polytope: volume ratio just below 1', () => {
    const shape: Shape = must(cylinder({ radius: 1, height: 2 }));
    const report = must(colliderFit(shape));
    const hull = report.candidates.find((c) => c.kind === 'convex-hull');
    // Hull vertices lie on the solid's surface, so their polytope is inside the solid.
    expect(hull?.volumeRatio).toBeLessThanOrEqual(1 + 1e-9);
    expect(hull?.volumeRatio).toBeGreaterThan(0.9);
  });

  it('falsifier: a sphere is not fit by a box at the sphere volume', () => {
    const shape: Shape = must(sphere({ radius: 1 }));
    const report = must(colliderFit(shape));
    const b = report.candidates.find((c) => c.kind === 'box');
    expect(b?.volumeRatio).toBeGreaterThan(1.2);
  });
  it('a box hull over its corner samples is the box itself', () => {
    const shape: Shape = must(box({ size: [2, 3, 4] }));
    const report = must(colliderFit(shape));
    const hull = report.candidates.find((c) => c.kind === 'convex-hull');
    expect(hull?.volumeRatio).toBeCloseTo(1, 9);
  });

  it('a torus hull exceeds the solid: concavity shows as a hull ratio above 1', () => {
    const shape: Shape = must(torus({ major: 2, minor: 0.5 }));
    const report = must(colliderFit(shape));
    const hull = report.candidates.find((c) => c.kind === 'convex-hull');
    expect(hull?.volumeRatio).toBeGreaterThan(1.5);
  });
  it('deviation sees straight side walls that carry no mesh vertices', () => {
    // The cylinder side at radius 1 lies sqrt(2) - 1 inside the rim radius; rim vertices alone report 0.
    const shape: Shape = must(cylinder({ radius: 1, height: 2 }));
    const report = must(colliderFit(shape));
    const s = report.candidates.find((c) => c.kind === 'sphere');
    expect(s?.kind === 'sphere' && s.maxDeviation).toBeGreaterThan(0.3);
  });
});
