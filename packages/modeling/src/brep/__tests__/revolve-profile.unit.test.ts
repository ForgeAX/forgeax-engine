import { describe, expect, it } from 'vitest';
import { measure } from '../measure';
import { revolveProfile } from '../revolve-profile';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';
import { boundaryEdges } from './support';

const PI = Math.PI;

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function checked(shape: Shape, euler: number): number {
  const report = validate(shape);
  expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  expect(report.shells[0]?.euler).toBe(euler);
  expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
  return must(measure(shape)).volume;
}

const rect = (r0: number, r1: number, z0: number, z1: number) =>
  ({
    start: [r0, z0] as [number, number],
    segments: [
      { kind: 'line', to: [r1, z0] },
      { kind: 'line', to: [r1, z1] },
      { kind: 'line', to: [r0, z1] },
      { kind: 'line', to: [r0, z0] },
    ],
  }) as const;

describe('revolveProfile', () => {
  it('partial angle on a rectangle: Pappus volume, planar end caps, sphere of faces', () => {
    for (const angle of [PI / 2, PI, 1.7 * PI]) {
      const shape = must(revolveProfile({ ...rect(1, 2, 0, 1), angle }));
      // V = angle * area * centroid radius = angle * 1 * 1.5
      expect(checked(shape, 2)).toBeCloseTo(angle * 1.5, 9);
      expect(shape.faces).toHaveLength(6);
    }
  });

  it('full angle on a rectangle is a torus-like ring of genus 1', () => {
    const shape = must(revolveProfile(rect(1, 2, 0, 1)));
    expect(checked(shape, 0)).toBeCloseTo(2 * PI * 1.5, 9);
    expect(shape.faces).toHaveLength(4);
  });

  it('arc centred on the axis makes a sphere, full and partial', () => {
    const profile = {
      start: [0, -1] as [number, number],
      segments: [{ kind: 'arc', to: [0, 1], center: [0, 0] }],
    } as const;
    const full = must(revolveProfile(profile));
    expect(checked(full, 2)).toBeCloseTo((4 * PI) / 3, 9);
    expect(full.surfaces.some((s) => s.kind === 'sphere')).toBe(true);
    const wedge = must(revolveProfile({ ...profile, angle: PI / 2 }));
    expect(checked(wedge, 2)).toBeCloseTo((4 * PI) / 3 / 4, 9);
    expect(wedge.faces).toHaveLength(3);
  });

  it('arc centred off the axis makes a torus; Pappus 2 pi R * pi r^2', () => {
    const profile = {
      start: [4, 0] as [number, number],
      segments: [
        { kind: 'arc', to: [2, 0], center: [3, 0] },
        { kind: 'arc', to: [4, 0], center: [3, 0] },
      ],
    } as const;
    const full = must(revolveProfile(profile));
    expect(checked(full, 0)).toBeCloseTo(2 * PI * 3 * PI, 8);
    expect(full.surfaces.filter((s) => s.kind === 'torus')).toHaveLength(2);
    const quarter = must(revolveProfile({ ...profile, angle: PI / 2 }));
    expect(checked(quarter, 2)).toBeCloseTo((PI / 2) * 3 * PI, 8);
  });

  it('capsule: cylinder between two hemispheres', () => {
    const r = 0.5;
    const h = 2;
    const profile = {
      start: [0, -h / 2 - r] as [number, number],
      segments: [
        { kind: 'arc', to: [r, -h / 2], center: [0, -h / 2] },
        { kind: 'line', to: [r, h / 2] },
        { kind: 'arc', to: [0, h / 2 + r], center: [0, h / 2] },
      ],
    } as const;
    const expected = PI * r * r * h + (4 / 3) * PI * r * r * r;
    expect(checked(must(revolveProfile(profile)), 2)).toBeCloseTo(expected, 9);
    expect(checked(must(revolveProfile({ ...profile, angle: PI })), 2)).toBeCloseTo(
      expected / 2,
      9,
    );
  });

  it('flange disc with a rounded rim and a bore', () => {
    // Washer r in [1, 3], z in [0, 0.5] with a quarter-round outer top corner of radius 0.25.
    const shape = must(
      revolveProfile({
        start: [1, 0],
        segments: [
          { kind: 'line', to: [3, 0] },
          { kind: 'line', to: [3, 0.25] },
          { kind: 'arc', to: [2.75, 0.5], center: [2.75, 0.25] },
          { kind: 'line', to: [1, 0.5] },
          { kind: 'line', to: [1, 0] },
        ],
      }),
    );
    // Pappus: rectangle (area 1, centroid radius 2) minus the corner sliver between the corner and
    // the arc: area r^2 (1 - pi/4), centroid radius 2.75 + r / (6 (1 - pi/4)) with r = 0.25.
    const r = 0.25;
    const sliver = r * r * (1 - PI / 4);
    const sliverCentroid = 2.75 + r / (6 * (1 - PI / 4));
    expect(checked(shape, 0)).toBeCloseTo(2 * PI * (2 - sliver * sliverCentroid), 8);
    expect(shape.surfaces.map((x) => x.kind).sort()).toEqual(
      ['cylinder', 'cylinder', 'plane', 'plane', 'torus'].sort(),
    );
  });

  it('concave fillet (clockwise arc) between a hub and a flange', () => {
    const r = 0.25;
    const shape = must(
      revolveProfile({
        start: [1, 0],
        segments: [
          { kind: 'line', to: [4, 0] },
          { kind: 'line', to: [4, 0.5] },
          { kind: 'line', to: [2 + r, 0.5] },
          { kind: 'arc', to: [2, 0.5 + r], center: [2 + r, 0.5 + r], ccw: false },
          { kind: 'line', to: [2, 2] },
          { kind: 'line', to: [1, 2] },
          { kind: 'line', to: [1, 0] },
        ],
      }),
    );
    // flange ring pi (16 - 1) 0.5 + hub pi (4 - 1) 1.5, plus the fillet sliver in the inner corner.
    const sliver = r * r * (1 - PI / 4);
    const centroid = 2 + r - r / (6 * (1 - PI / 4));
    expect(checked(shape, 0)).toBeCloseTo(12 * PI + 2 * PI * sliver * centroid, 8);
    expect(shape.surfaces.filter((x) => x.kind === 'torus')).toHaveLength(1);
  });

  it('fails closed or rejects on unsupported input', () => {
    const code = (r: { ok: boolean; error?: { code: string; detail?: unknown } }) =>
      r.ok ? 'ok' : `${r.error?.code}:${JSON.stringify(r.error?.detail)}`;
    // arc whose centre is on the far side, crossing the axis
    expect(
      code(
        revolveProfile({
          start: [0, -1],
          segments: [{ kind: 'arc', to: [0, 1], center: [0, 0], ccw: false }],
        }) as never,
      ),
    ).toContain('arc-crosses-axis');
    // spindle torus (centre closer to the axis than its radius)
    expect(
      code(
        revolveProfile({
          start: [1, 0],
          segments: [
            { kind: 'arc', to: [-1 + 2, 0.0001], center: [0.5, 0] },
            { kind: 'line', to: [2, 3] },
            { kind: 'line', to: [1, 0] },
          ],
        }) as never,
      ),
    ).toMatch(/model-partial|model-invalid/);
    expect(
      code(
        revolveProfile({
          start: [1, 0],
          segments: [
            { kind: 'spline', to: [2, 0] },
            { kind: 'line', to: [2, 1] },
            { kind: 'line', to: [1, 0] },
          ],
        } as never) as never,
      ),
    ).toContain('profile-edge-kind');
    expect(code(revolveProfile({ ...rect(1, 2, 0, 1), angle: 0 }) as never)).toContain(
      'model-invalid-argument',
    );
    expect(code(revolveProfile({ ...rect(1, 2, 0, 1), angle: 7 }) as never)).toContain(
      'model-invalid-argument',
    );
    // clockwise profile
    expect(
      code(
        revolveProfile({
          start: [1, 0],
          segments: [
            { kind: 'line', to: [1, 1] },
            { kind: 'line', to: [2, 1] },
            { kind: 'line', to: [2, 0] },
            { kind: 'line', to: [1, 0] },
          ],
        }) as never,
      ),
    ).toContain('model-invalid-argument');
    // open profile that does not end on the axis
    expect(
      code(
        revolveProfile({
          start: [0, 0],
          segments: [
            { kind: 'line', to: [1, 0] },
            { kind: 'line', to: [1, 1] },
          ],
        }) as never,
      ),
    ).toContain('profile-not-on-axis');
  });
});
