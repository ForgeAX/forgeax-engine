import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { EditMesh } from '../mesh';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { DTS_ZONES, type DtsRow, measureShutLines } from '../shut-lines';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

/**
 * Two panels in z = 0 facing +z, 3 mm sheet, shut line along y at x = `offset`: panel `a`
 * ends at x = offset - gapAt(y) / 2, panel `b` starts at offset + gapAt(y) / 2 (raised by
 * `step`). `round` rounds each panel's skin edges with that radius (0 keeps them square), a
 * labeled bevel; its faces carry the edge-treatment flag the gauge steps over.
 * Tags (and labels) are `prefix` + 'a' / 'b'; `into` adds the pair to an existing session.
 */
function pair(
  options: {
    gap?: (y: number) => number;
    step?: number;
    round?: [number, number];
    prefix?: string;
    offset?: number;
    into?: Model;
    /** Edge vertex ys (default every 50 mm). */
    ys?: readonly number[];
  } = {},
): Model {
  const m = options.into ?? model();
  const gapAt = options.gap ?? (() => 0.0035);
  const prefix = options.prefix ?? '';
  const x0 = options.offset ?? 0;
  const ys = options.ys ?? Array.from({ length: 9 }, (_, k) => -0.2 + (0.4 * k) / 8);
  for (const [side, name, z] of [
    [-1, 'a', 0],
    [1, 'b', options.step ?? 0],
  ] as const) {
    const near = ys.map((y): Tuple3 => [x0 + (side * gapAt(y)) / 2, y, z]);
    const bottom: Tuple3 = [x0 + side * 0.3, -0.2, z];
    const top: Tuple3 = [x0 + side * 0.3, 0.2, z];
    // Counter-clockwise seen from +z: panel a runs up its near edge, panel b down it.
    const ring = side === -1 ? [bottom, ...near, top] : [bottom, top, ...[...near].reverse()];
    const tag = `${prefix}${name}`;
    m.polygon({ points: ring, tag, label: tag });
    m.shell(sel.tag(tag), { thickness: 0.003, label: `${tag}-wall` });
    const r = options.round?.[side === -1 ? 0 : 1] ?? 0;
    if (r > 0)
      m.bevel(sel.createdBy(tag).boundary(), { width: r, segments: 6, label: `${tag}-round` });
  }
  return m;
}

const row = (extra: Partial<DtsRow> = {}): DtsRow => ({
  id: 'D',
  parts: ['a', 'b'],
  zone: 'A',
  ...extra,
});

/**
 * Two panels meeting at a G0 crease of `degrees` across the shut (like a sill crease), both
 * shelled 3 mm, 3.5 mm apart in plan. The skin lines cross at the gap's centre, or at panel
 * b's edge (`at: 'edge'`: panel a flat, b rising from its own edge); `lift` raises panel b.
 */
function creased(degrees: number, at: 'centre' | 'edge' = 'centre', lift = 0): Model {
  const m = model();
  const half = Math.tan((degrees * Math.PI) / 360);
  const [ta, tb] = at === 'centre' ? [half, half] : [0, Math.tan((degrees * Math.PI) / 180)];
  const ys = Array.from({ length: 9 }, (_, k) => -0.2 + (0.4 * k) / 8);
  const g = 0.00175;
  const x0 = at === 'centre' ? 0 : g;
  const za = (x: number) => ta * (x0 - x);
  const zb = (x: number) => tb * (x - x0) + lift;
  m.polygon({
    points: [
      [-0.3, -0.2, za(-0.3)],
      ...ys.map((y): Tuple3 => [-g, y, za(-g)]),
      [-0.3, 0.2, za(-0.3)],
    ],
    tag: 'a',
    label: 'a',
  });
  m.shell(sel.tag('a'), { thickness: 0.003, label: 'a-wall' });
  m.polygon({
    points: [
      [0.3, -0.2, zb(0.3)],
      [0.3, 0.2, zb(0.3)],
      ...[...ys].reverse().map((y): Tuple3 => [g, y, zb(g)]),
    ],
    tag: 'b',
    label: 'b',
  });
  m.shell(sel.tag('b'), { thickness: 0.003, label: 'b-wall' });
  return m;
}

describe('measureShutLines', () => {
  it('a crease across the shut: measured; centred reads no step, off-centre its mismatch', () => {
    const measure = (degrees: number, at: 'centre' | 'edge', lift = 0) => {
      const m = creased(degrees, at, lift);
      expect(m.poisoned).toBeUndefined();
      return unwrap(measureShutLines(m.editMesh, { table: [row()] })).rows[0];
    };
    for (const degrees of [25, 40]) {
      const centred = measure(degrees, 'centre');
      expect(centred?.coverage, `${degrees} deg coverage`).toBeGreaterThanOrEqual(0.98);
      expect(centred?.gap?.median, `${degrees} deg gap`).toBeCloseTo(0.0035, 4);
      // A16: the sections reach their theoretical edges on their skin lines (no lip term).
      expect(centred?.flush, `${degrees} deg centred flush`).toBeLessThan(1e-5);
      // The skins cross at b's edge: their edges sit gap x sin(angle / 2) apart along the
      // bisector (a minimum-separation rule would read 0 here).
      const off = measure(degrees, 'edge');
      expect(off?.coverage).toBeGreaterThanOrEqual(0.98);
      expect(off?.flush, `${degrees} deg off-centre flush`).toBeCloseTo(
        0.0035 * Math.sin((degrees * Math.PI) / 360),
        4,
      );
      // The centred crease with panel b 0.5 mm proud: a real step at a crease fails zone A.
      const stepped = measure(degrees, 'centre', 0.0005);
      expect(stepped?.flush, `${degrees} deg stepped flush`).toBeCloseTo(
        0.0005 * Math.cos((degrees * Math.PI) / 360),
        4,
      );
      expect(stepped?.failures).toContain('flush');
    }
  });

  it('A15: centred creases of 45 degrees or more are measured, not dropped', () => {
    for (const degrees of [50, 60]) {
      const m = creased(degrees, 'centre');
      expect(m.poisoned).toBeUndefined();
      const r = unwrap(measureShutLines(m.editMesh, { table: [row()] })).rows[0];
      expect(r?.coverage, `${degrees} deg coverage`).toBeGreaterThanOrEqual(0.98);
      expect(Math.abs((r?.gap?.median as number) - 0.0035), `${degrees} deg gap`).toBeLessThan(
        5e-5,
      );
      expect(r?.flush, `${degrees} deg flush`).toBeLessThan(0.0003);
    }
  });

  it('a skin rolling tightly right past its edge is followed to the edge (D10)', () => {
    // Panel b leaves its edge flat and flush with panel a, then rolls down: curvature ramps
    // up from 2.5 mm back to 170 /m over 4-7 mm and out again by 8.5 mm (44 degrees in all),
    // as the roof rail meeting the door glass does.
    const g = 0.00175;
    const kappa = (d: number) => {
      const ramp = (a: number, b: number) => Math.min(1, Math.max(0, (d - a) / (b - a)));
      return 170 * (ramp(0.0025, 0.004) - ramp(0.007, 0.0085));
    };
    const profile: [number, number][] = [[g, 0]];
    let [x, z, angle] = [g, 0, 0];
    const ds = 0.00005;
    for (let d = 0; d < 0.3 - g - 1e-9; d += ds) {
      angle += kappa(d + ds / 2) * ds;
      x += Math.cos(angle) * ds;
      z -= Math.sin(angle) * ds;
      const back = d + ds;
      if (back <= 0.012 ? Math.round(back / ds) % 5 === 0 : Math.round(back / ds) % 400 === 0)
        profile.push([x, z]);
    }
    const m = model();
    m.polygon({
      points: [
        [-0.3, -0.2, 0],
        [-g, -0.2, 0],
        [-g, 0.2, 0],
        [-0.3, 0.2, 0],
      ],
      tag: 'a',
      label: 'a',
    });
    m.shell(sel.tag('a'), { thickness: 0.003, label: 'a-wall' });
    for (let i = 0; i + 1 < profile.length; i++) {
      const [x0, z0] = profile[i] as [number, number];
      const [x1, z1] = profile[i + 1] as [number, number];
      m.polygon({
        points: [
          [x1, -0.2, z1],
          [x1, 0.2, z1],
          [x0, 0.2, z0],
          [x0, -0.2, z0],
        ],
        tag: 'b',
        label: 'b',
      });
    }
    m.weld({ distance: 1e-7 });
    m.shell(sel.tag('b'), { thickness: 0.003, label: 'b-wall' });
    expect(m.poisoned).toBeUndefined();
    const r = unwrap(measureShutLines(m.editMesh, { table: [row()] })).rows[0];
    expect(r?.coverage).toBeGreaterThanOrEqual(0.98);
    expect(Math.abs((r?.gap?.median as number) - 0.0035)).toBeLessThan(5e-5);
    expect(Math.abs((r?.gap?.min as number) - 0.0035)).toBeLessThan(5e-5);
    expect(r?.flush).toBeLessThan(0.0003);
    expect(r?.failures).toEqual([]);
  });

  it('a uniform 3.5 mm seam passes zone A', () => {
    const m = pair();
    expect(m.poisoned).toBeUndefined();
    const r = unwrap(measureShutLines(m.editMesh, { table: [row()] })).rows[0];
    expect(r?.failures).toEqual([]);
    expect(r?.gap?.mean).toBeCloseTo(0.0035, 5);
    expect(r?.gap?.max).toBeLessThan(0.0035 + 2e-5);
    expect(r?.flush).toBeLessThan(1e-5);
    expect(r?.parallelism).toBeLessThan(2e-5);
    expect(r?.samples).toBeGreaterThan(40);
  });

  it('a seam tapering from 3 to 5 mm fails on parallelism (and its band)', () => {
    const m = pair({ gap: (y) => 0.003 + 0.002 * ((y + 0.2) / 0.4) });
    const r = unwrap(measureShutLines(m.editMesh, { table: [row()] })).rows[0];
    expect(r?.failures).toContain('parallelism');
    expect(r?.parallelism).toBeGreaterThan(0.0015);
    // Inside its band the taper itself fails.
    const inside = pair({ gap: (y) => 0.0033 + 0.0004 * ((y + 0.2) / 0.4) });
    const t = unwrap(measureShutLines(inside.editMesh, { table: [row()] })).rows[0];
    expect(t?.failures).toEqual(['parallelism']);
  });

  it('a 1 mm step fails flush', () => {
    const r = unwrap(measureShutLines(pair({ step: 0.001 }).editMesh, { table: [row()] })).rows[0];
    expect(r?.failures).toEqual(['flush']);
    expect(r?.flush).toBeCloseTo(0.001, 4);
  });

  it('a mirrored pair 0.4 mm wider than its twin fails symmetry', () => {
    const m = pair({ prefix: 'l-', offset: -1, gap: () => 0.0033 });
    pair({ prefix: 'r-', offset: 1, gap: () => 0.0037, into: m });
    const table: DtsRow[] = [
      { id: 'L', parts: ['l-a', 'l-b'], zone: 'A', mirror: 'R' },
      { id: 'R', parts: ['r-a', 'r-b'], zone: 'A', mirror: 'L' },
    ];
    const r = unwrap(measureShutLines(m.editMesh, { table })).rows;
    expect(r.map((x) => x.failures)).toEqual([['symmetry'], ['symmetry']]);
    expect(r[0]?.symmetryDelta).toBeCloseTo(0.0004, 4);
    const same = pair({ prefix: 'l-', offset: -1 });
    pair({ prefix: 'r-', offset: 1, into: same });
    expect(unwrap(measureShutLines(same.editMesh, { table })).pass).toBe(true);
  });

  it('falsifier: a 3 mm edge round instead of 1 mm widens the visual gap, not the gap', () => {
    const r1 = unwrap(
      measureShutLines(pair({ round: [0.001, 0.001] }).editMesh, { table: [row()] }),
    ).rows[0];
    const r3 = unwrap(
      measureShutLines(pair({ round: [0.003, 0.001] }).editMesh, { table: [row()] }),
    ).rows[0];
    expect(Math.abs((r3?.gap?.mean as number) - (r1?.gap?.mean as number))).toBeLessThan(5e-5);
    expect(r1?.gap?.mean).toBeCloseTo(0.0035, 4);
    expect((r3?.visualGap?.mean as number) - (r1?.visualGap?.mean as number)).toBeGreaterThan(
      0.0015,
    );
    // The 1 mm rounds leave their skins about 0.6 mm before the edge (0.1 mm drop).
    expect(r1?.visualGap?.mean).toBeGreaterThan(0.0035 + 0.001);
  });

  it('validate({ shutLines }) reports the failing rows as shut-line errors', () => {
    const m = pair({ step: 0.001 });
    const report = m.validate({ shutLines: { table: [row()] } });
    const issues = report.issues.filter((i) => i.code === 'shut-line');
    expect(issues.map((i) => [i.severity, i.detail.id, i.detail.failures])).toEqual([
      ['error', 'D', ['flush']],
    ]);
    expect(report.pass).toBe(false);
    expect(pair().validate({ shutLines: { table: [row()] } }).pass).toBe(true);
    expect(
      pair()
        .validate({ shutLines: { table: [row()] } })
        .issues.filter((i) => i.code === 'shut-line'),
    ).toEqual([]);
    expect(unwrap(pair().shutLines({ table: [row()] })).pass).toBe(true);
  });

  it('drops stations with no theoretical edge (a turned edge) instead of reporting meters', () => {
    // Panel b's last 4 mm turn down 70 degrees at the shut line: its edge wall lies
    // within 45 degrees of its skin there.
    const m = model();
    pair({ into: m, prefix: 'flat-' });
    const t = (70 * Math.PI) / 180;
    const x1 = 0.00175 + 0.004 * Math.cos(t);
    const ring: Tuple3[] = [
      [x1, -0.2, 0.1],
      [0.3, -0.2, 0.1],
      [0.3, 0.2, 0.1],
      [x1, 0.2, 0.1],
    ];
    const lip: Tuple3[] = [
      [0.00175, -0.2, 0.1 - 0.004 * Math.sin(t)],
      [x1, -0.2, 0.1],
      [x1, 0.2, 0.1],
      [0.00175, 0.2, 0.1 - 0.004 * Math.sin(t)],
    ];
    m.polygon({ points: ring, tag: 'turned', label: 'turned' });
    m.polygon({ points: lip, tag: 'turned', label: 'turned-lip' });
    m.weld({ distance: 1e-6 });
    m.shell(sel.tag('turned'), { thickness: 0.003, label: 'turned-wall' });
    m.polygon({
      points: [
        [-0.3, -0.2, 0.1],
        [-0.00175, -0.2, 0.1],
        [-0.00175, 0.2, 0.1],
        [-0.3, 0.2, 0.1],
      ],
      tag: 'left',
      label: 'left',
    });
    m.shell(sel.tag('left'), { thickness: 0.003, label: 'left-wall' });
    expect(m.poisoned).toBeUndefined();
    const r = unwrap(
      measureShutLines(m.editMesh, { table: [row({ id: 'T', parts: ['left', 'turned'] })] }),
    ).rows[0];
    expect(r?.skipped).toBeGreaterThan(0);
    for (const v of [r?.gap?.min, r?.gap?.max])
      if (v !== undefined) expect(Math.abs(v)).toBeLessThan(0.02);
    const flat = unwrap(
      measureShutLines(m.editMesh, { table: [row({ id: 'F', parts: ['flat-a', 'flat-b'] })] }),
    ).rows[0];
    expect(flat?.skipped).toBe(0);
    expect(flat?.coverage).toBe(1);
    expect(flat?.gap?.median).toBeCloseTo(0.0035, 5);
    expect(flat?.gap?.p10).toBeLessThanOrEqual(flat?.gap?.p90 as number);
  });

  it('rejects malformed tables; a seam it cannot find is unmeasured', () => {
    const m = pair();
    for (const table of [
      [],
      [row({ parts: ['a', 'a'] })],
      [row(), row()],
      [row({ mirror: 'X' })],
      [row({ zone: 'Z' as never })],
      // A5: a row mirroring itself, or a mirror that does not name it back.
      [row({ mirror: 'D' })],
      [row({ mirror: 'E' }), row({ id: 'E' })],
      // A6: limits are finite and only tighten the zone's.
      [row({ limits: { gap: [Number.NaN, Number.NaN], flush: Number.NaN } })],
      [row({ limits: { gap: [0, 1], flush: 1, parallelism: 1 } })],
      [row({ limits: { gap: [0.0036, 0.0034] } })],
      [row({ limits: { visualGap: 0.01 } })],
      [row({ limits: { gaps: [0.0033, 0.0037] } as never })],
    ]) {
      const r = measureShutLines(m.editMesh, { table });
      expect(r.ok ? '' : r.error.code).toBe('model-invalid-argument');
    }
    const lost = unwrap(measureShutLines(m.editMesh, { table: [row({ parts: ['a', 'nowhere'] })] }))
      .rows[0];
    expect(lost?.failures).toEqual(['unmeasured']);
    expect(DTS_ZONES.A.gap).toEqual([0.00325, 0.00375]);
  });

  it('checks a seam against the panel break drawn for it', () => {
    const run = (points: [number, number][], extra: Record<string, unknown> = {}) => {
      const m = pair();
      m.drawing({
        name: 'sheet',
        views: [{ id: 'front', ortho: 'front' }],
        items: [
          {
            id: 'shut',
            view: 'front',
            role: 'break',
            kind: 'curve',
            curve: { kind: 'polyline', points },
            ...extra,
          } as never,
        ],
      });
      return unwrap(m.shutLines({ table: [row({ break: { drawing: 'sheet', item: 'shut' } })] }))
        .rows[0];
    };
    const on = run([
      [0, -0.2],
      [0, 0.2],
    ]);
    expect(on?.failures).toEqual([]);
    expect(on?.break?.max as number).toBeLessThan(0.0005);
    expect(on?.break?.coverage as number).toBeGreaterThan(0.98);
    // The seam 5 mm off the drawn break fails.
    expect(
      run([
        [0.005, -0.2],
        [0.005, 0.2],
      ])?.failures,
    ).toEqual(['break']);
    // A break drawn 20 cm longer at each end fails coverage unless it declares the inset.
    expect(
      run([
        [0, -0.4],
        [0, 0.4],
      ])?.failures,
    ).toEqual(['break']);
    expect(
      run(
        [
          [0, -0.4],
          [0, 0.4],
        ],
        { inset: 0.21 },
      )?.failures,
    ).toEqual([]);
    // A row break that names no break curve is an argument error.
    const m = pair();
    expect(m.shutLines({ table: [row({ break: { drawing: 'none', item: 'x' } })] }).ok).toBe(false);
  });
});

describe('shut-line gauge holes (B15 audit)', () => {
  const ys = (...extra: number[]) =>
    [...Array.from({ length: 9 }, (_, k) => -0.2 + (0.4 * k) / 8), ...extra].sort((a, b) => a - b);

  it('A1: a 13 mm slot beyond reach over 280 of 400 mm fails coverage', () => {
    const slot = (y: number) => (Math.abs(y) < 0.145 ? 0.013 : 0.0035);
    const m = pair({
      gap: slot,
      ys: [-0.2, -0.15, -0.14, -0.1, -0.05, 0, 0.05, 0.1, 0.14, 0.15, 0.2],
    });
    const r = unwrap(measureShutLines(m.editMesh, { table: [row()] })).rows[0];
    expect(r?.failures).toContain('coverage');
    expect(r?.coverage).toBeLessThan(0.5);
    expect(r?.skipped).toBeGreaterThan(40);
    // The uniform seam measures every station away from its ends.
    const u = unwrap(measureShutLines(pair().editMesh, { table: [row()] })).rows[0];
    expect([u?.skipped, u?.coverage]).toEqual([0, 1]);
  });

  it('A2: validate fails on a failing or unmeasured row', () => {
    const m = pair({ gap: () => 0.008 });
    const report = m.validate({
      shutLines: { table: [row(), { id: 'X', parts: ['ghost-1', 'ghost-2'] }] },
    });
    expect(report.pass).toBe(false);
    expect(
      report.issues
        .filter((i) => i.code === 'shut-line')
        .map((i) => [i.severity, i.detail.id, i.detail.failures]),
    ).toEqual([
      ['error', 'D', ['gap', 'visual-gap']],
      ['error', 'X', ['unmeasured']],
    ]);
  });

  it('A4: a 2 mm lip in the last 4 mm before the edge fails flush', () => {
    // Panel r: main body from 5.75 mm, a 4 mm lip strip to its edge at 1.75 mm whose edge
    // vertex at y0 stands 2 mm proud.
    const y0 = 0.0275;
    const m = model();
    const g = 0.00175;
    const xl = g + 0.004;
    m.polygon({
      points: [
        [-0.3, -0.2, 0],
        [-g, -0.2, 0],
        [-g, 0.2, 0],
        [-0.3, 0.2, 0],
      ],
      tag: 'l',
      label: 'l',
    });
    m.shell(sel.tag('l'), { thickness: 0.003, label: 'l-wall' });
    m.polygon({
      points: [
        [xl, -0.2, 0],
        [0.3, -0.2, 0],
        [0.3, 0.2, 0],
        [xl, 0.2, 0],
      ],
      tag: 'r',
      label: 'r',
    });
    const edge = ys(y0 - 0.005, y0, y0 + 0.005).map(
      (y): Tuple3 => [g, y, Math.abs(y - y0) < 1e-9 ? 0.002 : 0],
    );
    m.polygon({
      points: [[xl, -0.2, 0], [xl, 0.2, 0], ...[...edge].reverse()],
      tag: 'r',
      label: 'r-lip',
    });
    m.weld({ distance: 1e-6 });
    m.shell(sel.tag('r'), { thickness: 0.003, label: 'r-wall' });
    expect(m.poisoned).toBeUndefined();
    const r = unwrap(measureShutLines(m.editMesh, { table: [row({ parts: ['l', 'r'] })] })).rows[0];
    expect(r?.failures).toContain('flush');
    expect(r?.flush).toBeGreaterThan(0.0015);
  });

  it('A7: a 3 mm chamfer leaves the gap at 3.5 mm but fails the visual gap', () => {
    const chamfered = pair();
    for (const t of ['a', 'b'])
      chamfered.bevel(sel.createdBy(t).boundary(), {
        width: 0.003,
        segments: 1,
        label: `${t}-chamfer`,
      });
    const r = unwrap(measureShutLines(chamfered.editMesh, { table: [row()] })).rows[0];
    expect(r?.gap?.mean).toBeCloseTo(0.0035, 5);
    expect(r?.visualGap?.max).toBeGreaterThan(0.009);
    expect(r?.failures).toEqual(['visual-gap']);
    expect(DTS_ZONES.A.visualGap).toBeCloseTo(0.00375 + 2 * 0.0012, 9);
    // R2's 1 mm round passes.
    const rounded = unwrap(
      measureShutLines(pair({ round: [0.001, 0.001] }).editMesh, { table: [row()] }),
    ).rows[0];
    expect(rounded?.failures).toEqual([]);
  });

  it('A6: tightened limits are accepted and used', () => {
    const r = unwrap(
      measureShutLines(pair({ gap: () => 0.0037 }).editMesh, {
        table: [row({ limits: { gap: [0.0034, 0.0036], visualGap: 0.005 } })],
      }),
    ).rows[0];
    expect(r?.limits.gap).toEqual([0.0034, 0.0036]);
    expect(r?.limits.flush).toBe(DTS_ZONES.A.flush);
    expect(r?.failures).toEqual(['gap']);
  });

  it('A14: a 1 mm wide pinch to 1 mm reads 1 mm', () => {
    for (const w of [0.002, 0.0005]) {
      const y0 = 0.0275;
      // Panel a's edge vertex at y0 reaches 2.5 mm toward b: the gap there is 1 mm.
      const m = pair({
        ys: ys(y0 - w, y0, y0 + w),
        gap: (y) => (Math.abs(y - y0) < 1e-9 ? 0.001 : 0.0035),
      });
      const r = unwrap(measureShutLines(m.editMesh, { table: [row()] })).rows[0];
      expect(r?.gap?.min).toBeCloseTo(0.001, 5);
      expect(r?.gap?.max).toBeCloseTo(0.0035, 5);
    }
  });
});

describe('shut-line exceptions', () => {
  const turning = {
    limits: { flush: 0.001 },
    reason: 'turning disc',
    date: '2026-10-25',
  } as const;

  it('a 0.8 mm step fails zone A flush, and is excepted by a 1 mm flush exception', () => {
    const m = pair({ step: 0.0008 });
    const plain = unwrap(m.shutLines({ table: [row()] }));
    expect(plain.rows[0]?.status).toBe('fail');
    expect(plain.rows[0]?.failures).toEqual(['flush']);
    expect(plain.counts).toEqual({ pass: 0, fail: 1, excepted: 0, unmeasured: 0 });
    const report = unwrap(m.shutLines({ table: [row({ exception: turning })] }));
    const r = report.rows[0];
    expect(r?.status).toBe('excepted');
    expect(r?.excepted).toEqual(['flush']);
    expect(r?.failures).toEqual([]);
    expect(r?.flush).toBeCloseTo(0.0008, 4);
    expect(report.pass).toBe(true);
    expect(report.counts).toEqual({ pass: 0, fail: 0, excepted: 1, unmeasured: 0 });
    const v = m.validate({ shutLines: { table: [row({ exception: turning })] } });
    expect(v.pass).toBe(true);
    const issues = v.issues.filter((i) => i.code === 'shut-line');
    expect(issues.map((i) => [i.severity, i.detail.check, i.detail.id, i.detail.excepted])).toEqual(
      [['warn', 'excepted', 'D', ['flush']]],
    );
    expect(issues[0]?.detail.exception).toEqual(turning);
    expect(issues[0]?.detail.flush).toBeCloseTo(0.0008, 4);
  });

  it('a 2 mm step beyond the exception bound is a plain failure', () => {
    const report = unwrap(
      pair({ step: 0.002 }).shutLines({ table: [row({ exception: turning })] }),
    );
    expect(report.rows[0]?.status).toBe('fail');
    expect(report.rows[0]?.failures).toContain('flush');
    expect(report.rows[0]?.excepted).toEqual([]);
    expect(report.pass).toBe(false);
  });

  it('an exception naming a passing check is stale (exception-unused)', () => {
    const exception = { limits: { parallelism: 0.001 }, reason: 'taper', date: '2026-10-25' };
    const m = pair();
    const r = unwrap(m.shutLines({ table: [row({ exception })] })).rows[0];
    expect(r?.status).toBe('pass');
    expect(r?.excepted).toEqual([]);
    const v = m.validate({ shutLines: { table: [row({ exception })] } });
    expect(v.pass).toBe(true);
    expect(
      v.issues
        .filter((i) => i.code === 'shut-line')
        .map((i) => [i.severity, i.detail.check, i.detail.id, i.detail.unused]),
    ).toEqual([['warn', 'exception-unused', 'D', ['parallelism']]]);
  });

  it('rejects invalid exceptions; row limits still only tighten (A6)', () => {
    const m = pair({ step: 0.0008 });
    const ex = (limits: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      row({ exception: { limits, reason: 'r', date: '2026-10-25', ...extra } as never });
    for (const table of [
      [ex({ coverage: 0.5 })],
      [ex({ unmeasured: 1 })],
      [ex({ break: 1 })],
      [ex({ flush: DTS_ZONES.A.flush })],
      [ex({ flush: 0.0001 })],
      [ex({ gap: [0.003, 0.0036] })],
      [ex({ gap: [0.004, 0.003] })],
      [ex({ flush: Number.NaN })],
      [ex({ flush: Number.POSITIVE_INFINITY })],
      [ex({})],
      [ex({ flush: 0.001 }, { reason: '' })],
      [ex({ flush: 0.001 }, { date: '25.10.2026' })],
      [ex({ flush: 0.001 }, { date: '2026-02-30' })],
      // Looser than the zone but not than the row's tightened limit is fine; equal to it is not.
      [row({ limits: { flush: 0.0002 }, exception: { ...turning, limits: { flush: 0.0002 } } })],
      [row({ limits: { flush: 0.001 } })],
    ]) {
      const r = m.shutLines({ table });
      expect(r.ok ? '' : r.error.code, JSON.stringify(table)).toBe('model-invalid-argument');
    }
    const loose = unwrap(
      m.shutLines({
        table: [
          row({ limits: { flush: 0.0002 }, exception: { ...turning, limits: { flush: 0.00025 } } }),
        ],
      }),
    ).rows[0];
    expect(loose?.status).toBe('fail');
    expect(loose?.limits.flush).toBe(0.0002);
  });
});

describe('shut-line part membership', () => {
  it('two rows whose tags overlap on the same faces both measure', () => {
    const m = pair();
    m.tag(sel.tag('a'), 'a-band');
    m.tag(sel.tag('b'), 'b-band');
    expect(m.poisoned).toBeUndefined();
    const report = unwrap(
      m.shutLines({
        table: [row({ id: 'D1' }), row({ id: 'D2', parts: ['a-band', 'b-band'] })],
      }),
    );
    expect(report.rows.map((r) => r.status)).toEqual(['pass', 'pass']);
    expect(report.rows[1]?.gap?.mean).toBeCloseTo(report.rows[0]?.gap?.mean as number, 9);
    expect(report.rows[1]?.samples).toBe(report.rows[0]?.samples);
    // A row whose two parts share a face is an argument error.
    const r = m.shutLines({ table: [row({ parts: ['a', 'a-band'] })] });
    expect(r.ok ? '' : r.error.code).toBe('model-invalid-argument');
  });
});

describe('edge treatment without labels (B15 audit A17, A18)', () => {
  /** The pair with `m.bevel` rounds (or chamfers) on the listed panels, labeled or not. */
  const bevelled = (
    width: number,
    panels: readonly ('a' | 'b')[],
    labeled: boolean,
    segments = 6,
  ): Model => {
    const m = pair();
    for (const t of panels)
      m.bevel(sel.createdBy(t).boundary(), {
        width,
        segments,
        ...(labeled ? { label: `${t}-round` } : {}),
      });
    expect(m.poisoned).toBeUndefined();
    return m;
  };
  const measure = (m: Model) => unwrap(measureShutLines(m.editMesh, { table: [row()] })).rows[0];

  it('A17: an unlabeled round on one panel reads the gap and no flush step', () => {
    for (const width of [0.0012, 0.003]) {
      const r = measure(bevelled(width, ['b'], false));
      expect(Math.abs((r?.gap?.min as number) - 0.0035), `${width} gap`).toBeLessThan(5e-5);
      expect(Math.abs((r?.gap?.max as number) - 0.0035), `${width} gap`).toBeLessThan(5e-5);
      expect(r?.flush, `${width} flush`).toBeLessThan(0.0003);
      expect(r?.coverage).toBe(1);
    }
  });

  it('A17: unlabeled rounds on both panels read their true visual gap, as labeled ones do', () => {
    // (Rounds wider than the 3 mm wall are clamped by it.)
    for (const width of [0.002, 0.003]) {
      const plain = measure(bevelled(width, ['a', 'b'], false));
      const labeled = measure(bevelled(width, ['a', 'b'], true));
      expect(Math.abs((plain?.gap?.median as number) - 0.0035)).toBeLessThan(5e-5);
      // Each round leaves its skin line (0.1 mm drop) sqrt(2 r 0.1 mm) after its start.
      const leave = width - Math.sqrt(2 * width * 0.0001);
      expect(plain?.visualGap?.median as number).toBeGreaterThan(0.0035 + 2 * leave - 0.0005);
      expect(plain?.visualGap?.median).toBeCloseTo(labeled?.visualGap?.median as number, 9);
      expect(plain?.flush).toBeCloseTo(labeled?.flush as number, 9);
      expect(plain?.failures).toEqual(labeled?.failures);
      expect(plain?.failures).toContain('visual-gap');
    }
  });

  it('short skins: 5 and 8 mm rounds on both panels are measured (p4b-short)', () => {
    for (const width of [0.005, 0.008]) {
      const r = measure(bevelled(width, ['a', 'b'], false));
      expect(r?.status, `${width}`).not.toBe('unmeasured');
      expect(r?.coverage, `${width}`).toBe(1);
      expect(Math.abs((r?.gap?.median as number) - 0.0035), `${width}`).toBeLessThan(5e-5);
    }
  });

  it('A18: labeled and unlabeled rounds and chamfers read no lip where the panels are flush', () => {
    for (const labeled of [true, false])
      for (const [width, segments] of [
        [0.001, 6],
        [0.003, 6],
        [0.003, 1],
      ] as const) {
        const r = measure(bevelled(width, ['a', 'b'], labeled, segments));
        expect(r?.flush, `${labeled} ${width} x${segments}`).toBeLessThan(1e-5);
        const one = measure(bevelled(width, ['b'], labeled, segments));
        expect(one?.flush, `${labeled} ${width} x${segments} one`).toBeLessThan(1e-5);
      }
  });
});

describe('open-sided panels (B15 audit A19)', () => {
  /**
   * Flat panels in z = 0 facing +z, 30 mm deep, with an edge wall (role rim, 3 mm) along
   * the seam only: their other sides are open skin edges. Panel `a` spans `a` in y with its
   * edge at x = -1.75 mm; each span of `b` is a separate panel tagged `b` with its edge at
   * x = +1.75 mm.
   */
  const open = (a: readonly [number, number], b: readonly (readonly [number, number])[]) => {
    const mesh = new EditMesh();
    const rim = mesh.nameIndex(mesh.roleNames, 'rim');
    const g = 0.00175;
    const face = (loop: number[], role: number, tag: number) => {
      const f = mesh.addFace(loop);
      if (!f.ok) throw f.error;
      mesh.fRole[f.value] = role;
      mesh.addTag(f.value, tag);
    };
    const panel = (side: -1 | 1, [y0, y1]: readonly [number, number], tag: number) => {
      const [n0, n1] = [y0, y1].map((y) => mesh.addVertex(side * g, y, 0)) as [number, number];
      const [f0, f1] = [y0, y1].map((y) => mesh.addVertex(side * 0.03175, y, 0)) as [
        number,
        number,
      ];
      const [l0, l1] = [y0, y1].map((y) => mesh.addVertex(side * g, y, -0.003)) as [number, number];
      if (side === -1) {
        face([f0, n0, n1, f1], 0, tag);
        face([n1, n0, l0, l1], rim, tag);
      } else {
        face([n0, f0, f1, n1], 0, tag);
        face([n0, n1, l1, l0], rim, tag);
      }
    };
    panel(-1, a, mesh.tagIndex('a', true));
    for (const span of b) panel(1, span, mesh.tagIndex('b', true));
    return unwrap(measureShutLines(mesh, { table: [row()] })).rows[0];
  };

  it('corner stations of open sides read no false gaps', () => {
    const r = open([-0.1, 0.1], [[-0.1, 0.1]]);
    expect(r?.failures).toEqual([]);
    expect(r?.gap?.min).toBeCloseTo(0.0035, 6);
    expect(r?.gap?.max).toBeCloseTo(0.0035, 6);
    expect(r?.coverage).toBe(1);
    // Panel b 30 mm shorter at one end: a's open-side stations past b's corner are dropped.
    const short = open([-0.1, 0.1], [[-0.1, 0.07]]);
    expect(short?.gap?.min).toBeCloseTo(0.0035, 6);
    expect(short?.gap?.max).toBeCloseTo(0.0035, 6);
  });

  it('dropped corner stations count as skipped: tabs measured on a few stations fail coverage', () => {
    // Panel b is six 4 mm tabs 30 mm apart along a's 200 mm edge, all within reach: the
    // stations squarely across a tab read 3.5 mm, the rest face only tab corners.
    const tabs = [-0.075, -0.045, -0.015, 0.015, 0.045, 0.075].map((y): [number, number] => [
      y - 0.002,
      y + 0.002,
    ]);
    const r = open([-0.1, 0.1], tabs);
    expect(r?.gap?.min).toBeCloseTo(0.0035, 6);
    expect(r?.gap?.max).toBeCloseTo(0.0035, 6);
    expect(r?.skipped).toBeGreaterThanOrEqual(10);
    expect(r?.coverage).toBeLessThan(0.5);
    expect(r?.failures).toEqual(['coverage']);
  });
});
