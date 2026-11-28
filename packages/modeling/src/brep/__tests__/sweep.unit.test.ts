import { describe, expect, it } from 'vitest';
import { cos, sin } from '../../dmath';
import { interpolate } from '../../nurbs';
import { measure } from '../measure';
import { sweep } from '../sweep';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';
import { boundaryEdges, meshEuler } from './support';

const profile = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [0.25, 0.25],
  [-0.25, 0.25],
] as const;
const pathFrame = {
  o: [0, 0, 0] as [number, number, number],
  x: [1, 0, 0] as [number, number, number],
  y: [0, 1, 0] as [number, number, number],
  z: [0, 0, 1] as [number, number, number],
};

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function buildCircleSweep() {
  return must(
    sweep({
      profile,
      path: { kind: 'circle', frame: pathFrame, radius: 4 },
      xHint: [0, 0, 1],
      stations: 17,
    }),
  );
}

describe('sweep', () => {
  it('builds a straight sweep with exact planar faces', () => {
    const shape = must(
      sweep({
        profile,
        path: { kind: 'line', o: [0, 0, 0], d: [0, 0, 1] },
      }),
    );
    expect(validate(shape).ok).toBe(true);
    expect(validate(shape).shells[0]?.euler).toBe(2);
    const measured = must(measure(shape));
    expect(measured.volume).toBeCloseTo(0.25, 10);
  });

  it('falsifier: curved sweep matches Pappus within the measured station error and stays watertight', () => {
    const polygonDisk = Array.from(
      { length: 16 },
      (_, i) => [0.25 * cos((2 * Math.PI * i) / 16), 0.25 * sin((2 * Math.PI * i) / 16)] as const,
    );
    const diskShape = must(
      sweep({
        profile: polygonDisk,
        path: { kind: 'circle', frame: pathFrame, radius: 4 },
        xHint: [0, 0, 1],
        stations: 17,
      }),
    );
    expect(validate(diskShape).ok).toBe(true);
    const diskMeasure = must(measure(diskShape));
    const polygonArea = polygonDisk.reduce((sum, p, i) => {
      const next = polygonDisk[(i + 1) % polygonDisk.length] as readonly [number, number];
      return sum + (p[0] * next[1] - next[0] * p[1]) / 2;
    }, 0);
    expect(Math.abs(diskMeasure.volume - 2 * Math.PI * 4 * polygonArea)).toBeLessThan(2e-4);
    expect(polygonArea).toBeGreaterThan(0);
    const shape = buildCircleSweep();
    const report = validate(shape);
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.shells[0]?.euler).toBe(0);
    expect(report.shells[0]?.genus).toBe(1);
    const exactPappus = 2 * Math.PI * 4 * 0.25;
    const measured = must(measure(shape));
    expect(Math.abs(measured.volume - exactPappus)).toBeLessThan(2e-4);
    const mesh = must(tessellate(shape));
    expect(boundaryEdges(mesh)).toBe(0);
    expect(meshEuler(mesh)).toBe(0);
  });

  it('falsifier: a holed profile gives a hollow tube whose volume matches Pappus on the ring area', () => {
    const ring = (r: number) =>
      Array.from(
        { length: 16 },
        (_, i) => [r * cos((2 * Math.PI * i) / 16), r * sin((2 * Math.PI * i) / 16)] as const,
      );
    const area = (pts: readonly (readonly [number, number])[]) =>
      pts.reduce((sum, p, i) => {
        const q = pts[(i + 1) % pts.length] as readonly [number, number];
        return sum + (p[0] * q[1] - q[0] * p[1]) / 2;
      }, 0);
    const shape = must(
      sweep({
        profile: ring(0.3),
        holes: [ring(0.15)],
        path: { kind: 'circle', frame: pathFrame, radius: 4 },
        xHint: [0, 0, 1],
        stations: 17,
      }),
    );
    const report = validate(shape);
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    const expected = 2 * Math.PI * 4 * (area(ring(0.3)) - area(ring(0.15)));
    expect(Math.abs(must(measure(shape)).volume - expected)).toBeLessThan(2e-3);
  });

  it('falsifier: twist rotates the end profile about the path and preserves volume', () => {
    const straight = must(
      interpolate(
        [
          [0, 0, 0],
          [0, 0, 1],
          [0, 0, 2],
          [0, 0, 3],
        ],
        { degree: 3 },
      ),
    );
    const slab = [
      [-1, -0.25],
      [1, -0.25],
      [1, 0.25],
      [-1, 0.25],
    ] as const;
    const spread = (twist: number) => {
      const shape = must(
        sweep({ profile: slab, path: { kind: 'nurbs', curve: straight }, twist, xHint: [1, 0, 0] }),
      );
      expect(validate(shape).ok).toBe(true);
      const top = shape.vertices.filter((v) => v.p[2] > 2.99).map((v) => v.p);
      const xs = top.map((p) => p[0]);
      const ys = top.map((p) => p[1]);
      return {
        dx: Math.max(...xs) - Math.min(...xs),
        dy: Math.max(...ys) - Math.min(...ys),
        volume: must(measure(shape)).volume,
      };
    };
    const flat = spread(0);
    const turned = spread(Math.PI / 2);
    expect(flat.dx).toBeCloseTo(2, 6);
    expect(turned.dx).toBeCloseTo(0.5, 6);
    expect(turned.dy).toBeCloseTo(2, 6);
    expect(turned.volume).toBeGreaterThan(0.9 * flat.volume);
  });

  it('fails closed with model-partial when the station count cannot follow the path', () => {
    const wiggle = must(
      interpolate(
        [
          [0, 0, 0],
          [3, 0, 0],
          [3, 3, 0],
          [0, 3, 0],
          [0, 6, 0],
          [3, 6, 0],
        ],
        { degree: 3 },
      ),
    );
    const result = sweep({
      profile,
      path: { kind: 'nurbs', curve: wiggle },
      stations: 9,
      fitTolerance: 0.001,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).toContain('station-fit-error');
  });

  it('rejects an intentionally moved vertex instead of accepting a corrupted solid', () => {
    const shape = buildCircleSweep();
    expect(validate(JSON.parse(JSON.stringify(shape)) as Shape).ok).toBe(true);
    const vertices = shape.vertices.map((v, i) =>
      i === 0 ? { ...v, p: [v.p[0] + 0.125, v.p[1], v.p[2]] as [number, number, number] } : v,
    );
    const damaged = { ...shape, vertices } as Shape;
    expect(validate(damaged).ok).toBe(false);
  });
});
