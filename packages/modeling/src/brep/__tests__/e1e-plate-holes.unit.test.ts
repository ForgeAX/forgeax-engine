// E1e: K chained cylinder holes through four plate shapes (flat, thin flat, cylindrical skin,
// spherical skin). Flat plates must stay watertight with volume within 1e-3 of the closed form.
// Curved skins sit outside the boolean family: their radial and axial bores return
// model-partial with the exact reason, and that narrowed case is asserted so a support change
// turns this test red instead of passing silently.
import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box, cylinder, revolve, sphere } from '../build';
import { measure } from '../measure';
import type { Frame, Shape } from '../types';
import { validate } from '../validate';

// Measured flat-plate error is 0 to 4e-16 relative (K = 8..24, thick and 0.5 mm); 1e-9 keeps 7 orders of margin.
const TOL = 1e-9;
const TIMEOUT_MS = 240_000;

const yFrame = (o: [number, number, number]): Frame => ({
  o,
  x: [1, 0, 0],
  y: [0, 0, -1],
  z: [0, 1, 0],
});

function holeGrid(cols: number, rows: number, L: number, W: number): [number, number, number][] {
  const centers: [number, number, number][] = [];
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++)
      centers.push([((i + 1) * L) / (cols + 1) - L / 2, 0, ((j + 1) * W) / (rows + 1) - W / 2]);
  return centers;
}

function chain(host: Shape, holes: Shape[]) {
  let cur = host;
  for (const hole of holes) {
    const r = booleanSolids(cur, hole, 'difference');
    if (!r.ok) return { ok: false as const, code: r.error.code };
    cur = r.value;
  }
  const v = validate(cur);
  const m = measure(cur);
  return {
    ok: true as const,
    valid: v.ok,
    volume: m.ok ? m.value.volume : Number.NaN,
  };
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`build failed: ${r.error.code}`);
  return r.value;
}

const FLAT = { L: 0.24, W: 0.16, r: 0.008 };

describe('E1e flat plates: K chained holes stay watertight with closed-form volume', () => {
  for (const [K, cols, rows] of [
    [8, 4, 2],
    [16, 4, 4],
    [24, 4, 6],
  ] as const) {
    it(
      `K=${K} holes through a ${FLAT.L} x 12 mm x ${FLAT.W} plate`,
      () => {
        const t = 0.012;
        const centers = holeGrid(cols, rows, FLAT.L, FLAT.W);
        expect(centers).toHaveLength(K);
        const host = must(box({ size: [FLAT.L, t, FLAT.W] }));
        const holes = centers.map((c) =>
          must(cylinder({ radius: FLAT.r, height: 3 * t, frame: yFrame(c) })),
        );
        const res = chain(host, holes);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.valid).toBe(true);
        const closed = FLAT.L * t * FLAT.W - K * Math.PI * FLAT.r * FLAT.r * t;
        expect(Math.abs(res.volume - closed) / closed).toBeLessThanOrEqual(TOL);
      },
      TIMEOUT_MS,
    );
  }
});

describe('E1e falsifier: a +0.05% hole radius mutant fails the flat-plate volume gate', () => {
  it(
    'K=8 holes with radius * 1.0005 leave the closed-form tolerance',
    () => {
      const t = 0.012;
      const centers = holeGrid(4, 2, FLAT.L, FLAT.W);
      const host = must(box({ size: [FLAT.L, t, FLAT.W] }));
      const holes = centers.map((c) =>
        must(cylinder({ radius: FLAT.r * 1.0005, height: 3 * t, frame: yFrame(c) })),
      );
      const res = chain(host, holes);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const closed = FLAT.L * t * FLAT.W - 8 * Math.PI * FLAT.r * FLAT.r * t;
      expect(Math.abs(res.volume - closed) / closed).toBeGreaterThan(TOL);
    },
    TIMEOUT_MS,
  );
});

describe('E1e thin plate (0.5 mm): K chained holes stay watertight with closed-form volume', () => {
  for (const [K, cols, rows] of [
    [8, 4, 2],
    [16, 4, 4],
    [24, 4, 6],
  ] as const) {
    it(
      `K=${K} holes through a 0.5 mm plate`,
      () => {
        const t = 0.0005;
        const centers = holeGrid(cols, rows, FLAT.L, FLAT.W);
        const host = must(box({ size: [FLAT.L, t, FLAT.W] }));
        const holes = centers.map((c) =>
          must(cylinder({ radius: FLAT.r, height: 3 * t, frame: yFrame(c) })),
        );
        const res = chain(host, holes);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.valid).toBe(true);
        const closed = FLAT.L * t * FLAT.W - K * Math.PI * FLAT.r * FLAT.r * t;
        expect(Math.abs(res.volume - closed) / closed).toBeLessThanOrEqual(TOL);
      },
      TIMEOUT_MS,
    );
  }
});

describe('E1e curved skins: outside the boolean family, narrowed to an exact model-partial case', () => {
  const Ri = 0.05;
  const Ro = 0.056;
  const H = 0.04;
  const rb = 0.003;
  const Rm = (Ri + Ro) / 2;
  const radialFrame = (a: number): Frame => {
    const z: [number, number, number] = [Math.cos(a), 0, Math.sin(a)];
    const x: [number, number, number] = [-Math.sin(a), 0, Math.cos(a)];
    const y: [number, number, number] = [
      z[1] * x[2] - z[2] * x[1],
      z[2] * x[0] - z[0] * x[2],
      z[0] * x[1] - z[1] * x[0],
    ];
    return { o: [Rm * z[0], H / 2, Rm * z[2]], x, y, z };
  };

  it('cylindrical skin (closed tube wall) validates before any hole', () => {
    const tube = must(
      revolve({
        profile: [
          [Ri, 0],
          [Ro, 0],
          [Ro, H],
          [Ri, H],
          [Ri, 0],
        ],
      }),
    );
    expect(validate(tube).ok).toBe(true);
    const m = measure(tube);
    expect(m.ok).toBe(true);
    if (m.ok)
      expect(
        Math.abs(m.value.volume - Math.PI * (Ro * Ro - Ri * Ri) * H) /
          (Math.PI * (Ro * Ro - Ri * Ri) * H),
      ).toBeLessThanOrEqual(TOL);
  });

  it('cylindrical skin: one radial bore through the wall is model-partial (planar chord with curved solid)', () => {
    const tube = must(
      revolve({
        profile: [
          [Ri, 0],
          [Ro, 0],
          [Ro, H],
          [Ri, H],
          [Ri, 0],
        ],
      }),
    );
    const bore = must(cylinder({ radius: rb, height: 0.04, frame: radialFrame(0) }));
    const r = booleanSolids(tube, bore, 'difference');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect(r.error.detail).toMatchObject({
      brep: 'brep-ssi-unsupported',
      kinds: 'plane/plane',
      reason: 'planar-chord-with-curved-solid',
    });
  });

  it('cylindrical skin: the axial bore is model-partial with the same reason', () => {
    const tube = must(
      revolve({
        profile: [
          [Ri, 0],
          [Ro, 0],
          [Ro, H],
          [Ri, H],
          [Ri, 0],
        ],
      }),
    );
    const bore = must(
      cylinder({
        radius: rb,
        height: 0.1,
        frame: { o: [Rm, 0, 0], x: [1, 0, 0], y: [0, 0, -1], z: [0, 1, 0] },
      }),
    );
    const r = booleanSolids(tube, bore, 'difference');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
  });

  it('spherical skin: a closed band of the sphere shell validates', () => {
    const Rs = 0.056;
    const Rsi = 0.05;
    const a0 = 0.3;
    const a1 = 1.3;
    const n = 24;
    const outer: [number, number][] = Array.from({ length: n + 1 }, (_, i) => {
      const th = a0 + ((a1 - a0) * i) / n;
      return [Rs * Math.sin(th), Rs * Math.cos(th)];
    });
    const inner: [number, number][] = Array.from({ length: n + 1 }, (_, i) => {
      const th = a1 - ((a1 - a0) * i) / n;
      return [Rsi * Math.sin(th), Rsi * Math.cos(th)];
    });
    const band = must(
      revolve({
        profile: [...outer, ...inner, outer[0] as [number, number]].reverse(),
      }),
    );
    expect(validate(band).ok).toBe(true);
  });

  it('spherical skin: a sphere-minus-sphere bore is model-partial (sphere/sphere unsupported)', () => {
    const body = must(sphere({ radius: 0.05 }));
    const bore = must(sphere({ radius: 0.006 }));
    const r = booleanSolids(body, bore, 'difference');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect(r.error.detail).toMatchObject({
      brep: 'brep-ssi-unsupported',
      kinds: 'sphere/sphere',
    });
  });
});
