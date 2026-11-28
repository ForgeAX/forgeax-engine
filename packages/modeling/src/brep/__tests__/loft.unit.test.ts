import { describe, expect, it } from 'vitest';
import { cos, sin } from '../../dmath';
import { loft } from '../loft';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import type { Frame } from '../types';
import { validate } from '../validate';
import { boundaryEdges } from './support';

const frameAt = (z: number): Frame => ({ o: [0, 0, z], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
const square = (h: number) =>
  [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ] as const;

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function volumeOf(shape: Parameters<typeof measure>[0]): number {
  return must(measure(shape)).volume;
}

describe('loft', () => {
  it('ruled loft of two squares is an exact frustum', () => {
    const shape = must(
      loft({
        mode: 'ruled',
        sections: [
          { profile: square(1), frame: frameAt(0) },
          { profile: square(0.5), frame: frameAt(3) },
        ],
      }),
    );
    const report = validate(shape);
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.shells[0]?.euler).toBe(2);
    // h/3 (A1 + A2 + sqrt(A1 A2)) with A1 = 4, A2 = 1
    expect(volumeOf(shape)).toBeCloseTo(7, 9);
  });

  it('resamples profiles with different vertex counts by arc length', () => {
    const eight = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
    ] as const;
    const shape = must(
      loft({
        mode: 'ruled',
        sections: [
          { profile: square(1), frame: frameAt(0) },
          { profile: eight, frame: frameAt(2) },
        ],
      }),
    );
    expect(validate(shape).ok).toBe(true);
    expect(volumeOf(shape)).toBeCloseTo(8, 9);
  });

  it('aligns the start vertex of consecutive sections so a rotated vertex order gives a prism', () => {
    const rotated = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ] as const;
    const shape = must(
      loft({
        mode: 'ruled',
        sections: [
          { profile: square(1), frame: frameAt(0) },
          { profile: rotated, frame: frameAt(2) },
        ],
      }),
    );
    expect(validate(shape).ok).toBe(true);
    expect(volumeOf(shape)).toBeCloseTo(8, 9);
  });

  it('hollow ruled loft: frustum minus the hole frustum', () => {
    const shape = must(
      loft({
        mode: 'ruled',
        sections: [
          { profile: square(1), holes: [square(0.5)], frame: frameAt(0) },
          { profile: square(0.5), holes: [square(0.25)], frame: frameAt(3) },
        ],
      }),
    );
    const report = validate(shape);
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    // outer: 7; hole: h/3 (1 + 0.25 + 0.5) = 1.75
    expect(volumeOf(shape)).toBeCloseTo(5.25, 9);
    const mesh = must(tessellate(shape));
    expect(boundaryEdges(mesh)).toBe(0);
  });

  it('smooth three-section loft with 8-, 16- and 32-gon sections matches the integrated cross-section area', () => {
    const ngon = (r: number, n: number) =>
      Array.from(
        { length: n },
        (_, i) => [r * cos((2 * Math.PI * i) / n), r * sin((2 * Math.PI * i) / n)] as const,
      );
    // The reference resamples each regular n-gon at 32 equal arc-length points independently of loft().
    const ring32 = (r: number, n: number) =>
      Array.from({ length: 32 }, (_, k) => {
        const f = (k * n) / 32;
        const e = Math.floor(f);
        const u = f - e;
        const a = (2 * Math.PI * e) / n;
        const b = (2 * Math.PI * (e + 1)) / n;
        return [r * (cos(a) * (1 - u) + cos(b) * u), r * (sin(a) * (1 - u) + sin(b) * u)] as const;
      });
    const shape = must(
      loft({
        samples: 32,
        sections: [
          { profile: ngon(1, 8), frame: frameAt(0) },
          { profile: ngon(2, 16), frame: frameAt(2) },
          { profile: ngon(0.5, 32), frame: frameAt(4) },
        ],
      }),
    );
    const report = validate(shape);
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.shells[0]?.euler).toBe(2);
    const stations = [ring32(1, 8), ring32(2, 16), ring32(0.5, 32)];
    // z is linear in the rail parameter t; each rail is the quadratic through its three stations.
    const lagrange = (v: readonly [number, number, number], t: number) =>
      v[0] * 2 * (t - 0.5) * (t - 1) - v[1] * 4 * t * (t - 1) + v[2] * 2 * t * (t - 0.5);
    const area = (t: number) => {
      const ring = stations[0]?.map((_, k) => {
        const x = lagrange(stations.map((s) => s[k]?.[0] as number) as [number, number, number], t);
        const y = lagrange(stations.map((s) => s[k]?.[1] as number) as [number, number, number], t);
        return [x, y] as const;
      }) as (readonly [number, number])[];
      let a = 0;
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k] as readonly [number, number];
        const q = ring[(k + 1) % ring.length] as readonly [number, number];
        a += (p[0] * q[1] - q[0] * p[1]) / 2;
      }
      return a;
    };
    const steps = 2000;
    let reference = 0;
    for (let i = 0; i < steps; i++) reference += area((i + 0.5) / steps) / steps;
    reference *= 4;
    expect(Math.abs(volumeOf(shape) - reference) / reference).toBeLessThan(2e-3);
  });

  it('fails closed with model-partial when hole counts differ', () => {
    const result = loft({
      sections: [
        { profile: square(1), holes: [square(0.25)], frame: frameAt(0) },
        { profile: square(1), frame: frameAt(2) },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('model-partial');
      expect(JSON.stringify(result.error)).toContain('hole-count-mismatch');
    }
  });

  it('fails closed with model-partial when an L section lofts into its 180-degree rotation', () => {
    const lShape = [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ] as const;
    const result = loft({
      mode: 'ruled',
      sections: [
        { profile: lShape, frame: frameAt(0) },
        { profile: lShape.map(([x, y]) => [-x, -y] as const), frame: frameAt(2) },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('model-partial');
      expect(JSON.stringify(result.error)).toContain('loft-self-intersection');
    }
  });

  it('rejects sections that are not ordered along their frames', () => {
    const result = loft({
      sections: [
        { profile: square(1), frame: frameAt(2) },
        { profile: square(1), frame: frameAt(0) },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a damaged shape (moved vertex)', () => {
    const shape = must(
      loft({
        mode: 'ruled',
        sections: [
          { profile: square(1), frame: frameAt(0) },
          { profile: square(0.5), frame: frameAt(3) },
        ],
      }),
    );
    const vertices = shape.vertices.map((v, i) =>
      i === 0 ? { ...v, p: [v.p[0] + 0.2, v.p[1], v.p[2]] as [number, number, number] } : v,
    );
    expect(validate({ ...shape, vertices }).ok).toBe(false);
  });
});
