import { describe, expect, it } from 'vitest';
import { path } from '../curve';
import { cos } from '../dmath';
import { meshVolume, segmentsFor } from '../geom';
import { type Model, model } from '../model';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function count(radius: number, tolerance: number, minimum = 3): number {
  const r = segmentsFor(radius, tolerance, minimum);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const sagitta = (radius: number, n: number): number => radius * (1 - cos(Math.PI / n));

function snapshotOf(build: (m: Model) => void): string {
  const m = model();
  build(m);
  return Buffer.from(m.snapshot()).toString('base64');
}

describe('segmentsFor', () => {
  it('matches the hand values', () => {
    expect(count(1, 0.01)).toBe(23);
    expect(count(1, 1e-4)).toBe(223);
    expect(count(0.5, 0.01)).toBe(16);
    expect(count(1, 1.9)).toBe(3);
    expect(count(1, 1.9, 5)).toBe(5);
  });

  it('is monotone in the radius and in the tolerance', () => {
    let last = 0;
    for (let r = 0.01; r < 10; r *= 1.3) {
      const n = count(r, 1e-3 * 0.01 + 5e-4);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    last = Number.POSITIVE_INFINITY;
    for (let tol = 1e-6; tol < 0.5; tol *= 1.7) {
      const n = count(1, tol);
      expect(n).toBeLessThanOrEqual(last);
      last = n;
    }
  });

  it('keeps the chord sagitta within the tolerance, tightly, over 10^4 random inputs', () => {
    const next = prng(20261102);
    for (let i = 0; i < 10_000; i++) {
      const r = 10 ** (next() * 4 - 3);
      const tol = r * 10 ** (next() * 4 - 4.5);
      const n = count(r, tol);
      expect(sagitta(r, n)).toBeLessThanOrEqual(tol * (1 + 1e-12));
      if (n > 3) expect(sagitta(r, n - 1)).toBeGreaterThan(tol * (1 - 1e-12));
    }
  });

  it('rejects a non-positive, too large or non-finite input', () => {
    for (const [r, tol] of [
      [1, 0],
      [1, -1],
      [1, 2],
      [1, Number.NaN],
      [0, 0.1],
      [-1, 0.1],
      [Number.POSITIVE_INFINITY, 1],
    ] as const) {
      const out = segmentsFor(r, tol);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('model-invalid-argument');
    }
  });
});

describe('tolerance on primitives and helix', () => {
  it('equals the explicit count byte for byte', () => {
    const n = count(1, 0.01);
    expect(
      snapshotOf((m) =>
        m.cylinder({ radiusTop: 1, radiusBottom: 0.5, height: 2, tolerance: 0.01 }),
      ),
    ).toBe(
      snapshotOf((m) =>
        m.cylinder({ radiusTop: 1, radiusBottom: 0.5, height: 2, radialSegments: n }),
      ),
    );
    expect(snapshotOf((m) => m.cone({ radius: 1, height: 2, tolerance: 0.01 }))).toBe(
      snapshotOf((m) => m.cone({ radius: 1, height: 2, radialSegments: n })),
    );
    expect(snapshotOf((m) => m.sphere({ radius: 1, tolerance: 0.01 }))).toBe(
      snapshotOf((m) =>
        m.sphere({ radius: 1, widthSegments: n, heightSegments: Math.ceil(n / 2) }),
      ),
    );
    const tube = count(0.1, 0.01);
    const ring = count(0.6, 0.01);
    expect(snapshotOf((m) => m.torus({ radius: 0.5, tube: 0.1, tolerance: 0.01 }))).toBe(
      snapshotOf((m) =>
        m.torus({ radius: 0.5, tube: 0.1, radialSegments: tube, tubularSegments: ring }),
      ),
    );
  });

  it('refines the sphere volume toward the analytic value as the tolerance shrinks', () => {
    const exact = (4 / 3) * Math.PI;
    let last = Number.POSITIVE_INFINITY;
    for (const tol of [0.1, 0.03, 0.01, 0.003]) {
      const m = model();
      m.sphere({ radius: 1, tolerance: tol });
      const gap = exact - meshVolume(m.editMesh);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(last);
      last = gap;
    }
  });

  it('samples a helix at the per-turn count the tolerance derives', () => {
    const n = count(0.01, 1e-5);
    const a = path.helix({ radius: 0.01, pitch: 0.002, turns: 2, tolerance: 1e-5 });
    const b = path.helix({ radius: 0.01, pitch: 0.002, turns: 2, segments: n });
    const wire = (spec: typeof a) =>
      snapshotOf((m) =>
        m.sweep({
          profile: [
            [0.0005, 0],
            [0, 0.0005],
            [-0.0005, 0],
            [0, -0.0005],
          ],
          path: spec,
        }),
      );
    expect(wire(a)).toBe(wire(b));
  });

  it('rejects both or neither of a segment count and a tolerance', () => {
    const cases: [string, (m: Model) => void][] = [
      [
        'cylinder both',
        (m) =>
          m.cylinder({
            radiusTop: 1,
            radiusBottom: 1,
            height: 1,
            radialSegments: 8,
            tolerance: 0.01,
          } as never),
      ],
      [
        'cylinder neither',
        (m) => m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1 } as never),
      ],
      [
        'cone both',
        (m) => m.cone({ radius: 1, height: 1, radialSegments: 8, tolerance: 0.01 } as never),
      ],
      [
        'sphere both',
        (m) =>
          m.sphere({ radius: 1, widthSegments: 8, heightSegments: 4, tolerance: 0.01 } as never),
      ],
      [
        'sphere height with tolerance',
        (m) => m.sphere({ radius: 1, heightSegments: 4, tolerance: 0.01 } as never),
      ],
      [
        'torus both',
        (m) =>
          m.torus({
            radius: 1,
            tube: 0.2,
            radialSegments: 8,
            tubularSegments: 8,
            tolerance: 0.01,
          } as never),
      ],
      [
        'torus tubular with tolerance',
        (m) => m.torus({ radius: 1, tube: 0.2, tubularSegments: 8, tolerance: 0.01 } as never),
      ],
      [
        'cylinder too coarse',
        (m) => m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, tolerance: 5 }),
      ],
      [
        'helix both',
        (m) =>
          m.sweep({
            profile: [
              [0.1, 0],
              [0, 0.1],
              [-0.1, 0],
            ],
            path: path.helix({
              radius: 1,
              pitch: 1,
              turns: 1,
              segments: 8,
              tolerance: 0.01,
            } as never),
          }),
      ],
    ];
    for (const [name, body] of cases) {
      const m = model();
      const out = m.try(body);
      expect(out.ok, name).toBe(false);
      if (!out.ok) expect(out.error.code, name).toBe('model-invalid-argument');
    }
  });
});
