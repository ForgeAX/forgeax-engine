import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type NurbsCurve, type NurbsSurface, nurbs } from '../nurbs';
import { sel } from '../selectors';
import { type SplitCut, type SurfacePatch, splitAlong } from '../surface';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

const steps = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

/** A doubly curved, non-orthogonally parametrized 0.6 m x 0.5 m panel (a roof-like crown). */
function panel(): NurbsSurface {
  const rows = steps(6).map((a) =>
    steps(6).map((b): Tuple3 => {
      const x = -0.3 + 0.6 * a + 0.08 * b;
      const z = -0.25 + 0.5 * b;
      return [x, 0.12 - 0.6 * x * x - 0.5 * z * z + 0.1 * x * z, z];
    }),
  );
  return unwrap(nurbs.grid(rows));
}

/** A curve on the surface along the straight (u, v) line from `from` to `to` (normalized). */
function onSurface(
  s: NurbsSurface,
  from: [number, number],
  to: [number, number],
  lift = 0,
): NurbsCurve {
  const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(s);
  const points = steps(200).map((k): Tuple3 => {
    const p = nurbs.surfacePoint(
      s,
      u0 + (u1 - u0) * (from[0] + (to[0] - from[0]) * k),
      v0 + (v1 - v0) * (from[1] + (to[1] - from[1]) * k),
    );
    return [p[0], p[1] + lift, p[2]];
  });
  return unwrap(nurbs.approximate(points, { controlPoints: 24 }));
}

/** A flat 0.2 m x 0.2 m plane: x = 0.2 u, z = 0.2 v. */
function plane(): NurbsSurface {
  return unwrap(
    nurbs.grid(steps(4).map((a) => steps(4).map((b): Tuple3 => [0.2 * a, 0, 0.2 * b]))),
  );
}

/** A curve through the surface points at the normalized (u, v) of `f(k)`, k in [0, 1]. */
function uvCurve(
  s: NurbsSurface,
  f: (k: number) => readonly [number, number],
  n = 400,
  controlPoints = 80,
): NurbsCurve {
  const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(s);
  const points = steps(n).map((k): Tuple3 => {
    const [a, b] = f(k);
    return nurbs.surfacePoint(s, u0 + (u1 - u0) * a, v0 + (v1 - v0) * b);
  });
  return unwrap(nurbs.approximate(points, { controlPoints }));
}

/** On the plane: legs at x = 0.1 -+ r from z = 0 to 0.1 joined by a half circle of radius r. */
const uTurn = (r: number) => (k: number) => {
  const leg = 0.1;
  const s = k * (2 * leg + Math.PI * r);
  if (s < leg) return [(0.1 - r) / 0.2, s / 0.2] as const;
  if (s < leg + Math.PI * r) {
    const a = Math.PI - (s - leg) / r;
    return [(0.1 + r * Math.cos(a)) / 0.2, (leg + r * Math.sin(a)) / 0.2] as const;
  }
  return [(0.1 + r) / 0.2, (leg - (s - leg - Math.PI * r)) / 0.2] as const;
};

const precondition = (r: ReturnType<typeof splitAlong>) => {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected a precondition');
  expect(r.error.code).toBe('model-precondition');
  return r.error;
};

function gauge(patch: SurfacePatch, cut: SplitCut) {
  const r = unwrap(splitAlong(patch, cut, { gap: 0.0035, names: ['left', 'right'] }));
  const m = model();
  // The default snap (chord / 4) would move trim vertices up to 0.25 mm onto grid nodes.
  m.surface({ patches: [r.a, r.b], label: 'panels', snap: 2e-5 });
  for (const tag of ['left', 'right'])
    m.shell(sel.tag(tag), { thickness: 0.003, label: `${tag}-wall` });
  expect(m.poisoned).toBeUndefined();
  const report = unwrap(m.shutLines({ table: [{ id: 'S', parts: ['left', 'right'], zone: 'A' }] }));
  return { split: r, row: report.rows[0] };
}

describe('splitAlong', () => {
  it('an isoparm cut of a doubly curved patch keeps a constant 3.5 mm gap', () => {
    const s = panel();
    const [[u0, u1]] = nurbs.surfaceDomain(s);
    const { split, row } = gauge({ surface: s, flip: true }, { iso: 'u', t: u0 + 0.4 * (u1 - u0) });
    expect(split.deviation).toBe(0);
    expect([split.a.name, split.b.name]).toEqual(['left', 'right']);
    expect(split.a.flip).toBe(true);
    const gap = row?.gap as { min: number; max: number; mean: number };
    expect(row?.samples).toBeGreaterThan(40);
    expect(Math.abs(gap.mean - 0.0035)).toBeLessThan(5e-5);
    expect(gap.max - gap.min).toBeLessThanOrEqual(1e-4);
    expect(row?.failures).toEqual([]);
  });

  it('a slanted curve on the surface cuts with a constant gap', () => {
    const s = panel();
    const { split, row } = gauge(
      { surface: s, flip: true },
      { curve: onSurface(s, [0.3, 0], [0.65, 1]) },
    );
    expect(split.deviation).toBeLessThan(1e-5);
    const gap = row?.gap as { min: number; max: number; mean: number };
    expect(row?.samples).toBeGreaterThan(40);
    expect(Math.abs(gap.mean - 0.0035)).toBeLessThan(5e-5);
    expect(gap.max - gap.min).toBeLessThanOrEqual(1e-4);
    expect(row?.failures).toEqual([]);
  });

  it('falsifier: a curve 1 mm off the surface, or ending inside it, is a precondition', () => {
    const s = panel();
    const lifted = splitAlong(
      { surface: s },
      { curve: onSurface(s, [0.3, 0], [0.65, 1], 0.001) },
      { gap: 0.0035, names: ['a', 'b'] },
    );
    expect(lifted.ok).toBe(false);
    if (lifted.ok) return;
    expect(lifted.error.code).toBe('model-precondition');
    expect(lifted.error.detail?.distance).toBeGreaterThan(0.0009);
    expect((lifted.error.detail?.at as Tuple3).length).toBe(3);
    const short = splitAlong(
      { surface: s },
      { curve: onSurface(s, [0.3, 0], [0.5, 0.7]) },
      { gap: 0.0035, names: ['a', 'b'] },
    );
    expect(short.ok).toBe(false);
    if (short.ok) return;
    expect(short.error.code).toBe('model-precondition');
    expect(short.error.detail?.end).toBe('end');
  });

  it('rejects an out-of-domain parameter, a zero gap and repeated names', () => {
    const s = panel();
    const [[u0, u1]] = nurbs.surfaceDomain(s);
    const iso: SplitCut = { iso: 'u', t: (u0 + u1) / 2 };
    const codes = [
      splitAlong({ surface: s }, { iso: 'u', t: u1 }, { gap: 0.0035, names: ['a', 'b'] }),
      splitAlong({ surface: s }, { iso: 'v', t: -1 }, { gap: 0.0035, names: ['a', 'b'] }),
      splitAlong({ surface: s }, iso, { gap: 0, names: ['a', 'b'] }),
      splitAlong({ surface: s }, iso, { gap: Number.NaN, names: ['a', 'b'] }),
      splitAlong({ surface: s }, iso, { gap: 0.0035, names: ['a', 'a'] }),
      splitAlong({ surface: s }, iso, { gap: 0.0035, names: ['a', ''] }),
    ].map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes).toEqual(new Array(6).fill('model-invalid-argument'));
  });

  it('a v isoparm cut and existing uv trims carry over to the halves', () => {
    const s = panel();
    const [, [v0, v1]] = nurbs.surfaceDomain(s);
    const r = unwrap(
      splitAlong(
        {
          surface: s,
          trims: [
            {
              uv: [
                [0.1, 0.1],
                [0.2, 0.1],
                [0.2, 0.2],
                [0.1, 0.2],
              ],
            },
          ],
        },
        { iso: 'v', t: v0 + 0.5 * (v1 - v0) },
        { gap: 0.0035, names: ['low', 'high'] },
      ),
    );
    expect(r.a.trims?.length).toBe(2);
    expect(r.b.trims?.length).toBe(2);
    const m = model();
    m.surface({ patches: [r.a, r.b], label: 'panels' });
    expect(m.poisoned).toBeUndefined();
    expect(m.count(sel.tag('low'))).toBeGreaterThan(0);
    expect(m.count(sel.tag('high'))).toBeGreaterThan(0);
  });

  it('split halves take a return flange along a ringed cut, keeping the gap (B15 audit A3)', () => {
    // Before: the trims reached 0.05 past the domain, so the trim ring left the patch,
    // and without a ring the cut cells left faces 0.18 mm wide along the fold.
    const s = panel();
    const [[u0, u1]] = nurbs.surfaceDomain(s);
    // The iso halves fold the cut and their other edges as two flanges (per edge, by the
    // `trim` faces of the ring); the curve halves take one flange on every open edge.
    const square = { reach: 0.012, depth: 0.004 } as const;
    const perEdge = (tag: string) => [
      { ...square, at: sel.tag(tag).and(sel.tag('trim')) },
      { ...square, reach: 0.008, at: sel.tag(tag).minus(sel.tag('trim')) },
    ];
    const cuts: [SplitCut, { ring?: number }, { trimRing?: number }, boolean][] = [
      [{ iso: 'u', t: u0 + 0.4 * (u1 - u0) }, {}, { trimRing: 0.004 }, true],
      [{ curve: onSurface(s, [0.3, 0], [0.65, 1]) }, { ring: 0.004 }, {}, false],
    ];
    for (const [cut, split, surface, edges] of cuts) {
      const r = unwrap(
        splitAlong({ surface: s, flip: true }, cut, {
          gap: 0.0035,
          names: ['left', 'right'],
          ...split,
        }),
      );
      for (const half of [r.a, r.b]) {
        const trim = half.trims?.at(-1) as { uv: { outer: [number, number][] }[] };
        for (const p of trim.uv[0]?.outer ?? [])
          for (const x of p) expect(x >= 0 && x <= 1).toBe(true);
      }
      const m = model();
      m.surface({ patches: [r.a, r.b], label: 'panels', snap: 2e-5, ...surface });
      expect(m.poisoned).toBeUndefined();
      for (const tag of ['left', 'right']) {
        const op = m.shell(sel.tag(tag), {
          thickness: 0.001,
          label: `${tag}-wall`,
          flange: edges ? perEdge(tag) : square,
        });
        expect(op.status, op.error?.expected).toBe('ok');
      }
      expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
      const row = unwrap(m.shutLines({ table: [{ id: 'S', parts: ['left', 'right'], zone: 'A' }] }))
        .rows[0];
      expect(row?.failures).toEqual([]);
      expect(Math.abs((row?.gap?.median ?? 0) - 0.0035)).toBeLessThan(5e-5);
    }
    const bare = unwrap(
      splitAlong({ surface: s, flip: true }, cuts[0]?.[0] as SplitCut, {
        gap: 0.0035,
        names: ['l', 'r'],
      }),
    );
    const m = model();
    m.surface({ patches: [bare.a, bare.b], label: 'panels', snap: 2e-5 });
    const op = m.shell(sel.tag('l'), { thickness: 0.001, flange: { reach: 0.012, depth: 0.004 } });
    expect(op.error?.code).toBe('model-precondition');
  });

  it('split halves take a rounded fold on the cut and square folds elsewhere (B15 audit A3 residual)', {
    timeout: 120_000,
  }, () => {
    // Before: the round's bevel slid the patch-side edge of the cut's triangulated corner
    // cell as far as that cell's diagonal (no width fit), re-cut the coplanar outer walls into
    // slivers the fold's other bends then clamped on, and the curve halves' bands touched
    // themselves at a vertex (non-manifold end walls, even for square folds).
    const s = panel();
    const [[u0, u1]] = nurbs.surfaceDomain(s);
    const cuts: [string, SplitCut][] = [
      ['iso', { iso: 'u', t: u0 + 0.4 * (u1 - u0) }],
      ['curve', { curve: onSurface(s, [0.3, 0], [0.65, 1]) }],
    ];
    const folds: [string, { radius?: number; round?: number }][] = [
      ['square', {}],
      ['radius', { radius: 0.001 }],
      ['round', { round: 0.001 }],
    ];
    for (const [cutName, cut] of cuts) {
      const r = unwrap(
        splitAlong({ surface: s, flip: true }, cut, {
          gap: 0.0035,
          names: ['left', 'right'],
          ring: 0.004,
        }),
      );
      const visual: Record<string, number> = {};
      for (const [foldName, fold] of folds) {
        const m = model();
        m.surface({ patches: [r.a, r.b], label: 'panels', snap: 2e-5 });
        for (const tag of ['left', 'right']) {
          const flange = { reach: 0.02, depth: 0.008 };
          const op = m.shell(sel.tag(tag), {
            thickness: 0.0015,
            direction: 'in',
            label: `${tag}-wall`,
            flange: [
              { ...flange, ...fold, at: sel.tag(tag).and(sel.tag('trim')) },
              { ...flange, at: sel.tag(tag).minus(sel.tag('trim')) },
            ],
          });
          expect(op.status, `${cutName} ${foldName}: ${op.error?.expected}`).toBe('ok');
        }
        expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
        const row = unwrap(
          m.shutLines({ table: [{ id: 'S', parts: ['left', 'right'], zone: 'A' }] }),
        ).rows[0];
        expect(Math.abs((row?.gap?.median ?? 0) - 0.0035)).toBeLessThan(5e-5);
        visual[foldName] = row?.visualGap?.median ?? 0;
        // A 1 mm inner radius rounds the skin at 2.5 mm, past zone A's edge radius (1.2 mm).
        expect(row?.failures).toEqual(foldName === 'radius' ? ['visual-gap'] : []);
      }
      expect(visual.round).toBeGreaterThan((visual.square ?? 0) + 0.001);
      expect(visual.radius).toBeGreaterThan((visual.round ?? 0) + 0.001);
    }
  });

  it('curve halves take one rounded fold on every open edge over a wide trim ring', {
    timeout: 120_000,
  }, () => {
    const s = panel();
    const r = unwrap(
      splitAlong(
        { surface: s, flip: true },
        { curve: onSurface(s, [0.3, 0], [0.65, 1]) },
        {
          gap: 0.0035,
          names: ['left', 'right'],
        },
      ),
    );
    for (const fold of [{ radius: 0.001 }, { round: 0.002 }]) {
      const m = model();
      m.surface({ patches: [r.a, r.b], label: 'panels', snap: 2e-5, trimRing: 0.013 });
      for (const tag of ['left', 'right']) {
        const op = m.shell(sel.tag(tag), {
          thickness: 0.001,
          label: `${tag}-wall`,
          flange: { reach: 0.012, depth: 0.004, ...fold },
        });
        expect(op.status, op.error?.expected).toBe('ok');
      }
      expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
      const row = unwrap(m.shutLines({ table: [{ id: 'S', parts: ['left', 'right'], zone: 'A' }] }))
        .rows[0];
      expect(Math.abs((row?.gap?.median ?? 0) - 0.0035)).toBeLessThan(5e-5);
    }
  });

  it('falsifier: a cut tighter than half the gap or crossing itself is a precondition (A8)', {
    timeout: 60_000,
  }, () => {
    const p = plane();
    const cut = (f: (k: number) => readonly [number, number], n: number, cps: number) =>
      splitAlong(
        { surface: p },
        { curve: uvCurve(p, f, n, cps) },
        { gap: 0.0035, names: ['a', 'b'] },
      );
    // The audit's U-turn at r = 1.5 mm returned ok with a folded trim (gap 2.99 mm).
    const error = precondition(cut(uTurn(0.0015), 1600, 300));
    expect(error.detail?.radius).toBeLessThan(0.0015);
    expect(error.detail?.minRadius).toBe(0.00175);
    expect((error.detail?.at as Tuple3).length).toBe(3);
    expect(cut(uTurn(0.005), 800, 200).ok).toBe(true);
    // A loop of radius 25 mm that crosses its own entry leg.
    const loop: [number, number][] = [];
    let [x, z, h] = [0.06, 0, Math.PI / 3];
    const ds = 0.0005;
    const step = (turn: number) => {
      loop.push([x, z]);
      h -= turn;
      x += ds * Math.cos(h);
      z += ds * Math.sin(h);
    };
    for (let s = 0; s < 0.07; s += ds) step(0);
    for (let a = 0; a < (340 * Math.PI) / 180; a += ds / 0.025) step(ds / 0.025);
    while (z + ds * Math.sin(h) < 0.2) step(0);
    loop.push([x + ((0.2 - z) / Math.sin(h)) * Math.cos(h), 0.2]);
    const crossing = splitAlong(
      { surface: p },
      {
        curve: unwrap(
          nurbs.approximate(
            loop.map(([a, b]): Tuple3 => [a, 0, b]),
            { controlPoints: 160 },
          ),
        ),
      },
      { gap: 0.0035, names: ['a', 'b'] },
    );
    expect(precondition(crossing).expected).toContain('does not cross itself');
  });

  it('a cut overshooting the patch side by micrometers keeps finite trims (A9)', () => {
    const p = plane();
    for (const ext of [1e-5, 1e-4, 2.5e-4]) {
      const r = unwrap(
        splitAlong(
          { surface: p },
          { curve: uvCurve(p, (k) => [0.4, -ext + (1 + 2 * ext) * k]) },
          { gap: 0.0035, names: ['a', 'b'] },
        ),
      );
      for (const half of [r.a, r.b]) {
        const trim = half.trims?.at(-1) as { uv: { outer: [number, number][] }[] };
        expect(trim.uv[0]?.outer.flat().every(Number.isFinite)).toBe(true);
      }
      const m = model();
      m.surface({ patches: [r.a, r.b], label: 'panels', snap: 2e-5 });
      expect(m.poisoned).toBeUndefined();
    }
  });

  it('falsifier: a half left empty or in two pieces is a precondition (A10)', {
    timeout: 60_000,
  }, () => {
    const p = plane();
    const cut = (f: (k: number) => readonly [number, number]) =>
      splitAlong({ surface: p }, { curve: uvCurve(p, f) }, { gap: 0.0035, names: ['a', 'b'] });
    // Along the side, 1 mm from it, and bulging to 0.5 mm from the far side.
    expect(precondition(cut((k) => [k, 0])).detail).toMatchObject({ name: 'b', pieces: 0 });
    expect(precondition(cut((k) => [k, 0.005])).detail).toMatchObject({ name: 'b', pieces: 0 });
    expect(
      precondition(cut((k) => [0.5 + 0.4975 * Math.sin(Math.PI * k), k])).detail,
    ).toMatchObject({
      name: 'b',
      pieces: 2,
    });
    expect(cut((k) => [0.5 + 0.475 * Math.sin(Math.PI * k), k]).ok).toBe(true);
  });
});
