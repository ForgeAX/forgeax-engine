import { describe, expect, it } from 'vitest';
import { hausdorff } from '../compute/mesh-query';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import type { DtsRow } from '../shut-lines';
import type { BoundaryChain } from '../watertight';

/** A planar patch o + s U + t V (s, t in [0, 1]), its normal U x V. */
function patch(o: Tuple3, u: Tuple3, v: Tuple3): NurbsSurface {
  const at = (s: number, t: number): Tuple3 => [
    o[0] + s * u[0] + t * v[0],
    o[1] + s * u[1] + t * v[1],
    o[2] + s * u[2] + t * v[2],
  ];
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [at(0, 0), at(0, 1)],
      [at(1, 0), at(1, 1)],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

/** A closed box of six patches with outward normals; its top patch raised by `lift`. */
function patchBox(size: number, lift: number): Model {
  const x: Tuple3 = [size, 0, 0];
  const y: Tuple3 = [0, size, 0];
  const z: Tuple3 = [0, 0, size];
  const m = model();
  const report = m.surface({
    patches: [
      { surface: patch([0, 0, 0], y, x) },
      { surface: patch([0, 0, size + lift], x, y) },
      { surface: patch([0, 0, 0], x, z) },
      { surface: patch([0, size, 0], z, x) },
      { surface: patch([0, 0, 0], z, y) },
      { surface: patch([size, 0, 0], y, z) },
    ],
    label: 'box',
    snap: 1e-6,
    weld: 1e-6,
  });
  expect(report.status).toBe('ok');
  return m;
}

/** A gently domed 0.2 m plate in XY, tessellated into many cells. */
function dome(): NurbsSurface {
  const t = Array.from({ length: 7 }, (_, i) => i / 6);
  const s = nurbs.grid(
    t.map((a) => t.map((b): Tuple3 => [0.2 * a, 0.2 * b, 0.02 * a * (1 - a) * b * (1 - b) * 16])),
  );
  if (!s.ok) throw s.error;
  return s.value;
}

const undesigned = (chains: readonly BoundaryChain[]) =>
  chains.filter((c) => c.designed === undefined);

const rim = (lo: Tuple3, hi: Tuple3) => sel.inBox(lo, hi, { by: 'any' }).toEdges('touching');

describe('validate({ watertight })', () => {
  it('reports a patch moved 50 um off its neighbours as an undesigned seam with that gap', () => {
    const welded = patchBox(0.2, 0).validate({ watertight: true });
    expect(welded.closed).toBe(true);
    expect(welded.watertight?.chains).toEqual([]);
    expect(welded.pass).toBe(true);

    const report = patchBox(0.2, 50e-6).validate({ watertight: true });
    expect(report.pass).toBe(false);
    const chains = undesigned(report.watertight?.chains ?? []);
    expect(chains.length).toBe(2);
    for (const c of chains) {
      expect(c.gap).toBeGreaterThan(45e-6);
      expect(c.gap).toBeLessThan(55e-6);
      expect(c.partner?.chain).toBe(chains.find((o) => o !== c)?.id);
      expect(c.length).toBeCloseTo(0.8, 6);
    }
    const errors = report.issues.filter((i) => i.code === 'mesh-open' && i.severity === 'error');
    expect(errors.map((i) => [i.detail.check, i.detail.repair])).toEqual([
      ['free-chain', 'sew'],
      ['free-chain', 'sew'],
      ['cross-part', undefined],
    ]);
    const parts = report.watertight?.parts ?? [];
    expect(parts.map((p) => p.part).sort()).toEqual(['component:0', 'component:1']);
    expect(chains.every((c) => c.kind === 'free')).toBe(true);
    const widest = parts.map((p) => report.watertight?.chains[p.free.widest ?? -1]?.gap);
    expect(widest.every((g) => g !== undefined && g !== null && g < 55e-6)).toBe(true);
  });

  /** Two 0.1 m panels `gap` apart along x, tagged `part:` and `skin:`, optionally shelled 3 mm. */
  function panels(gap: number, shelled: boolean): Model {
    const m = model();
    for (const [name, sign] of [
      ['a', -1],
      ['b', 1],
    ] as const) {
      m.plane({
        width: 0.1,
        height: 0.1,
        widthSegments: 10,
        heightSegments: 10,
        center: [sign * (0.05 + gap / 2), 0, 0],
        tag: `part:${name}`,
      });
      m.tag(sel.tag(`part:${name}`), `skin:${name}`);
      if (shelled) {
        const op = m.shell(sel.tag(`part:${name}`), { thickness: 0.003, label: `wall-${name}` });
        expect(op.status).toBe('ok');
      }
    }
    return m;
  }
  const far = sel
    .inBox([-1, -1, -1], [-0.09, 1, 1], { by: 'all' })
    .or(sel.inBox([0.09, -1, -1], [1, 1, 1], { by: 'all' }))
    .toEdges('contained')
    .and(sel.edges.parallel('y'));
  const open = sel.edges.parallel('x').or(far);
  const table: DtsRow[] = [{ id: 'D01', parts: ['skin:a', 'skin:b'] }];

  it.each([
    [0.0035, false],
    [0.0035, true],
    [50e-6, true],
    [0.005, true],
  ])('the facing edges of two panels %f m apart (shelled: %s) are a shut line only with its DTS row', (gap, shelled) => {
    const m = panels(gap, shelled);
    const kind = shelled ? 'rim' : 'free';
    const declared = m.validate({ watertight: { open, table } });
    expect(declared.pass).toBe(true);
    const chains = declared.watertight?.chains ?? [];
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.every((c) => c.kind === kind)).toBe(true);
    const shut = chains.filter((c) => c.designed === 'shut-line');
    expect(shut.map((c) => c.part).sort()).toEqual(['part:a', 'part:b']);
    for (const c of shut) expect(Math.abs((c.gap as number) - gap)).toBeLessThan(gap * 0.1);
    expect(undesigned(chains)).toEqual([]);

    const viaShutLines = m.validate({ watertight: { open }, shutLines: { table } });
    expect(viaShutLines.watertight?.chains).toEqual(declared.watertight?.chains);

    const bare = m.validate({ watertight: { open } });
    expect(bare.pass).toBe(false);
    const cracks = undesigned(bare.watertight?.chains ?? []);
    expect(cracks.map((c) => c.part).sort()).toEqual(['part:a', 'part:b']);
    for (const c of cracks) {
      expect(Math.abs((c.gap as number) - gap)).toBeLessThan(gap * 0.1);
      expect(c.partner?.part).toBe(c.part === 'part:a' ? 'part:b' : 'part:a');
    }
    const errors = bare.issues.filter((i) => i.code === 'mesh-open' && i.severity === 'error');
    expect(errors.map((i) => [i.detail.check, i.detail.repair])).toEqual([
      [`${kind}-chain`, 'sew'],
      [`${kind}-chain`, 'sew'],
      ['cross-part', undefined],
    ]);
    const counts = bare.watertight?.parts.map((p) => p[kind].undesigned);
    expect(counts).toEqual([1, 1]);
    for (const e of errors.slice(0, 2))
      expect(e.detail.pair).toEqual({ parts: ['part:a', 'part:b'] });

    const seam = (r: typeof bare) => r.watertight?.crossPart ?? [];
    expect(seam(bare).map((x) => [x.parts, x.designed])).toEqual([
      [['part:a', 'part:b'], undefined],
    ]);
    const across = seam(bare)[0];
    expect(Math.abs((across?.gap.max as number) - gap)).toBeLessThan(gap * 0.1);
    expect(Math.abs((across?.gap.median as number) - gap)).toBeLessThan(gap * 0.1);
    for (const l of across?.lengths ?? []) expect(l).toBeCloseTo(0.1, 2);
    const crossError = bare.issues.find((i) => i.detail.check === 'cross-part');
    expect(crossError?.severity).toBe('error');
    expect(seam(declared)[0]?.designed).toBe('shut-line');
    expect(declared.issues.find((i) => i.detail.check === 'cross-part')?.severity).toBe('info');
  });

  it('checks a designed separation as a DTS clearance row, not an exemption', () => {
    const m = panels(0.03, false);
    const row = (min: number): DtsRow[] => [
      { id: 'C1', parts: ['skin:a', 'skin:b'], clearance: { min } },
    ];
    const clear = m.validate({ watertight: { open, table: row(0.02) } });
    expect(clear.pass).toBe(true);
    expect(clear.watertight?.crossPart.map((x) => x.designed)).toEqual(['clearance']);
    expect(undesigned(clear.watertight?.chains ?? [])).toEqual([]);
    const gauge = m.shutLines({ table: row(0.02) });
    expect(gauge.ok && gauge.value.rows[0]?.status).toBe('pass');
    expect(gauge.ok && gauge.value.rows[0]?.clearance?.distance).toBeCloseTo(0.03, 6);

    const tight = m.validate({ watertight: { open }, shutLines: { table: row(0.04) } });
    expect(tight.pass).toBe(false);
    const cross = tight.issues.find((i) => i.detail.check === 'cross-part');
    expect([cross?.severity, cross?.detail.designed, cross?.detail.min]).toEqual([
      'error',
      'clearance',
      0.04,
    ]);
    const failed = tight.issues.find((i) => i.code === 'shut-line');
    expect(failed?.detail.failures).toEqual(['clearance']);

    const bare = m.validate({ watertight: { open } });
    expect(bare.watertight?.crossPart.map((x) => x.designed)).toEqual([undefined]);
    expect(bare.pass).toBe(false);
    const bad = m.shutLines({ table: [{ ...row(0.02)[0], limits: { flush: 0.0001 } } as DtsRow] });
    expect(bad.ok).toBe(false);
  });

  it('reports a facing edge just beyond the radius as info, and finds it with a larger radius', () => {
    const m = panels(0.045, false);
    const near = m.validate({ watertight: { open } });
    expect(near.watertight?.radius).toBe(0.04);
    expect(near.watertight?.crossPart).toEqual([]);
    const holes = undesigned(near.watertight?.chains ?? []);
    expect(holes.map((c) => c.partner)).toEqual([null, null]);
    const beyond = near.issues.filter((i) => i.detail.check === 'beyond-radius');
    expect(beyond.map((i) => i.severity)).toEqual(['info', 'info']);
    for (const i of beyond) expect(i.detail.distance).toBeCloseTo(0.045, 6);

    const wide = m.validate({ watertight: { open, radius: 0.05 } });
    expect(undesigned(wide.watertight?.chains ?? []).map((c) => c.gap)).toEqual([
      expect.closeTo(0.045, 6),
      expect.closeTo(0.045, 6),
    ]);
    const bad = m.validate({ watertight: { radius: 0 } });
    expect(bad.issues.find((i) => i.detail.check === 'options')?.severity).toBe('error');
  });

  it('leaves the stretch of a panel edge past its DTS partner undesigned', () => {
    const m = model();
    m.plane({
      width: 0.1,
      height: 0.3,
      widthSegments: 10,
      heightSegments: 30,
      center: [-0.05175, 0, 0],
      tag: 'part:a',
    });
    m.plane({
      width: 0.1,
      height: 0.24,
      widthSegments: 10,
      heightSegments: 24,
      center: [0.05175, 0, 0],
      tag: 'part:b',
    });
    m.tag(sel.tag('part:a'), 'skin:a');
    m.tag(sel.tag('part:b'), 'skin:b');
    const report = m.validate({ watertight: { open, table } });
    expect(report.pass).toBe(false);
    const rest = undesigned(report.watertight?.chains ?? []);
    expect(rest.map((c) => c.part)).toEqual(['part:a', 'part:a']);
    for (const c of rest) {
      expect(c.length).toBeGreaterThan(0.015);
      expect(c.length).toBeLessThan(0.03);
    }
  });

  it('designs trim loops and open edges, shelled or not; a rim alone is not designed', () => {
    const circle: Point2[] = Array.from({ length: 64 }, (_, k) => {
      const a = (2 * Math.PI * k) / 64;
      return [0.5 + 0.25 * Math.cos(a), 0.5 + 0.25 * Math.sin(a)];
    });
    const trimmed = (shelled: boolean) => {
      const m = model();
      const report = m.surface({
        patches: [{ surface: dome(), trims: [{ uv: circle }] }],
        chord: 0.0002,
        tag: 'p',
      });
      expect(report.status).toBe('ok');
      if (shelled)
        expect(m.shell(sel.tag('p'), { thickness: 0.002, label: 'wall' }).status).toBe('ok');
      return m;
    };
    for (const [shelled, kind] of [
      [false, 'free'],
      [true, 'rim'],
    ] as const) {
      const square = sel.edges.parallel('x').or(sel.edges.parallel('y'));
      const declared = trimmed(shelled).validate({ watertight: { open: square } });
      expect(declared.pass, kind).toBe(true);
      const chains = declared.watertight?.chains ?? [];
      expect(chains.map((c) => [c.kind, c.designed]).sort()).toEqual([
        [kind, 'open'],
        [kind, 'trim'],
      ]);
      expect(declared.watertight?.parts[0]?.[kind].designed).toEqual({
        trim: 1,
        'shut-line': 0,
        clearance: 0,
        open: 1,
      });

      const bare = trimmed(shelled).validate({ watertight: true });
      expect(bare.pass, kind).toBe(false);
      const outer = undesigned(bare.watertight?.chains ?? []);
      expect(outer.map((c) => c.kind)).toEqual([kind]);
      expect(outer[0]?.length).toBeCloseTo(0.8, 6);
      expect(outer[0]?.partner).toBeNull();
      expect(outer[0]?.gap).toBeNull();
      const error = bare.issues.find((i) => i.code === 'mesh-open' && i.severity === 'error');
      expect(error?.detail.repair).toBe('fill');
    }
  });

  it('attributes each T-junction to its part', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 1, 0],
        [0, 1, 0],
      ],
      tag: 'part:base',
    });
    m.polygon({
      points: [
        [0, 1, 0],
        [1, 1, 0],
        [2, 1, 0],
        [2, 2, 0],
        [0, 2, 0],
      ],
      tag: 'part:top',
    });
    const report = m.validate({ watertight: { open: sel.edges.meshBoundary() } });
    const t = report.issues.filter((i) => i.code === 't-junction');
    expect(t.map((i) => [i.detail.part, i.detail.count, i.severity])).toEqual([
      ['part:top', 1, 'error'],
    ]);
    expect(report.watertight?.parts.find((p) => p.part === 'part:top')?.tJunctions).toBe(1);
    expect(m.validate().issues.filter((i) => i.code === 't-junction')[0]?.detail).toEqual({
      count: 1,
      vertices: t[0]?.detail.vertices,
    });
  });
});

describe('validate({ watertight: { reference } })', () => {
  /** A fine-chord model of `surfaces`: the reference form the kernel takes. */
  function referenceOf(...surfaces: NurbsSurface[]): Model {
    const m = model();
    expect(
      m.surface({ patches: surfaces.map((surface) => ({ surface })), chord: 0.0002 }).status,
    ).toBe('ok');
    return m;
  }
  const reference = referenceOf(patch([-0.1, -0.05, 0], [0.2, 0, 0], [0, 0.1, 0]));
  /** Synthetic fixtures: the reference is the designed skin itself (no measured deviation). */
  const TOL = 0.003;
  /**
   * Two 0.1 m panels `gap` apart in x at height `lift`, faces tagged `part:` and `skin:`;
   * `drop` deletes the cells of a 40 x 20 mm box.
   */
  function split(gap: number, drop?: Tuple3, lift = 0): Model {
    const m = model();
    for (const [name, sign] of [
      ['a', -1],
      ['b', 1],
    ] as const) {
      m.plane({
        width: 0.1 - gap / 2,
        height: 0.1,
        widthSegments: 10,
        heightSegments: 10,
        center: [sign * (0.05 + gap / 4), 0, lift],
        tag: `part:${name}`,
      });
      m.tag(sel.tag(`part:${name}`), `skin:${name}`);
    }
    if (drop !== undefined)
      expect(m.delete(sel.inBox(drop, [drop[0] + 0.04, drop[1] + 0.02, 1])).status).toBe('ok');
    return m;
  }
  const table: DtsRow[] = [{ id: 'D01', parts: ['skin:a', 'skin:b'] }];
  // The outer rim of the two panels only: never the shut line or a hole cut inside them.
  const outer = sel.edges
    .parallel('y')
    .and(rim([-1, -1, -1], [-0.099, 1, 1]).or(rim([0.099, -1, -1], [1, 1, 1])))
    .or(
      sel.edges
        .parallel('x')
        .and(rim([-1, -1, -1], [1, -0.049, 1]).or(rim([-1, 0.049, -1], [1, 1, 1]))),
    );
  const uncovered = (r: ReturnType<Model['validate']>) =>
    r.issues.filter((i) => i.code === 'mesh-open' && i.detail.check === 'uncovered');
  const errors = (r: ReturnType<Model['validate']>) =>
    uncovered(r).filter((i) => i.severity === 'error');

  it('measures the reference area and passes a covering skin', () => {
    const report = split(0.0035).validate({
      watertight: { open: outer, table, reference: { surface: reference, tolerance: TOL } },
    });
    const c = report.watertight?.coverage;
    expect(c?.area).toBeCloseTo(0.02, 9);
    expect(c?.tolerance).toBe(TOL);
    expect(c?.interior.max).toBeLessThan(1e-9);
    expect(c?.covered.max).toBeLessThan(1e-9);
    expect(c?.covered.parts.map((p) => p.part)).toEqual(['part:a', 'part:b']);
    expect(c?.uncovered).toBe(0);
    expect(report.pass).toBe(true);
  });

  it('reads the reference from FXEM bytes as from the model', () => {
    const skin = split(0.0035, [-0.07, -0.01, -1]);
    const bytes = reference.snapshot();
    const a = skin.validate({
      watertight: { open: outer, table, reference: { surface: reference, tolerance: TOL } },
    });
    const b = skin.validate({
      watertight: { open: outer, table, reference: { surface: bytes, tolerance: TOL } },
    });
    expect(b.watertight?.coverage).toEqual(a.watertight?.coverage);
  });

  it('reports a deleted 40 x 20 mm patch as uncovered with its area and part', () => {
    const report = split(0.0035, [-0.07, -0.01, -1]).validate({
      watertight: { open: outer, table, reference: { surface: reference, tolerance: TOL } },
    });
    expect(report.pass).toBe(false);
    const [hole, ...rest] = errors(report);
    expect(rest).toEqual([]);
    const d = hole?.detail as { area: number; part: string; at: Tuple3 };
    expect(d.area).toBeGreaterThan(0.0002);
    expect(d.area).toBeLessThan(0.0005);
    expect(d.part).toBe('part:a');
    expect(d.at[0]).toBeCloseTo(-0.045, 2);
    expect(report.watertight?.coverage?.uncovered).toBeGreaterThan(0.0002);
  });

  it('(a) reports a panel deleted from a complete skin as one region of its area', () => {
    const m = split(0.0035);
    expect(m.delete(sel.tag('part:b')).status).toBe('ok');
    const report = m.validate({
      watertight: { open: outer, table, reference: { surface: reference, tolerance: TOL } },
    });
    const found = errors(report);
    expect(found).toHaveLength(1);
    const panel = (0.1 - 0.0035 / 2) * 0.1;
    expect((found[0]?.detail as { area: number }).area).toBeGreaterThan(panel * 0.95);
    expect((found[0]?.detail as { area: number }).area).toBeLessThan(panel * 1.15);
  });

  it('(b) excuses a DTS gap within its widest gap + edge round, not twice that', () => {
    const widened: DtsRow[] = [
      { id: 'D02', parts: ['skin:a', 'skin:b'], limits: { gap: [0.002, 0.007] } },
    ];
    const declared = split(0.006).validate({
      watertight: {
        open: outer,
        table: widened,
        reference: { surface: reference, tolerance: TOL },
      },
    });
    expect(errors(declared)).toEqual([]);
    expect(uncovered(declared).map((i) => i.severity)).toContain('info');
    const band = declared.watertight?.coverage?.excluded.find((e) => e.reason === 'shut-line');
    expect(band?.row).toBe('D02');
    expect(band?.area).toBeGreaterThan(0.006 * 0.1 * 0.9);
    // Twice the row's widest gap (no edge round here): the gap's middle is uncovered.
    const wide = split(0.014).validate({
      watertight: {
        open: outer,
        table: widened,
        reference: { surface: reference, tolerance: TOL },
      },
    });
    expect(errors(wide).length).toBeGreaterThan(0);
    // The band is the row's: an 8 mm gap (4 mm from either edge) is excused under D02's
    // 7 mm top but not under the default zone A band (3.75 mm).
    for (const [rows, severity] of [
      [widened, 'info'],
      [table, 'error'],
    ] as const) {
      const r = split(0.008).validate({
        watertight: { open: outer, table: rows, reference: { surface: reference, tolerance: TOL } },
      });
      expect(uncovered(r).map((i) => i.severity)).toEqual([severity]);
    }
  });

  const circle: Point2[] = Array.from({ length: 64 }, (_, k) => {
    const a = (2 * Math.PI * k) / 64;
    return [0.5 + 0.25 * Math.cos(a), 0.5 + 0.25 * Math.sin(a)];
  });
  const square = sel.edges.meshBoundary().and(
    rim([-1, -1, -1], [0.001, 1, 1])
      .or(rim([0.199, -1, -1], [1, 1, 1]))
      .or(rim([-1, -1, -1], [1, 0.001, 1]))
      .or(rim([-1, 0.199, -1], [1, 1, 1])),
  );
  function trimmedDome(): Model {
    const m = model();
    expect(
      m.surface({ patches: [{ surface: dome(), trims: [{ uv: circle }] }], chord: 0.0002 }).status,
    ).toBe('ok');
    return m;
  }

  it('excuses the area across a trim opening', () => {
    const report = trimmedDome().validate({
      watertight: { open: square, reference: { surface: referenceOf(dome()), tolerance: TOL } },
    });
    expect(errors(report)).toEqual([]);
    const trim = report.watertight?.coverage?.excluded.find((e) => e.reason === 'trim');
    expect(trim?.share).toBeGreaterThan(0.1);
  });

  it('(c) does not excuse an undesigned hole the size and shape of a trim opening', () => {
    const m = referenceOf(dome());
    // The faces inside a 32-gon around the trim circle: the same opening, no trim chain.
    let inside: ReturnType<typeof sel.side> | undefined;
    for (let k = 0; k < 32; k++) {
      const a = (2 * Math.PI * k) / 32;
      const n: Tuple3 = [Math.cos(a), Math.sin(a), 0];
      const out = sel.side([0.1 + 0.05 * n[0], 0.1 + 0.05 * n[1], 0], n, { by: 'centroid' }).not();
      inside = inside === undefined ? out : inside.and(out);
    }
    expect(m.delete(inside as NonNullable<typeof inside>).status).toBe('ok');
    const report = m.validate({
      watertight: { open: square, reference: { surface: referenceOf(dome()), tolerance: TOL } },
    });
    const found = errors(report);
    expect(found).toHaveLength(1);
    expect((found[0]?.detail as { area: number }).area).toBeGreaterThan(0.005);
    expect((found[0]?.detail as { excluded: unknown[] }).excluded).toEqual([]);
    expect(report.watertight?.coverage?.excluded.find((e) => e.reason === 'trim')).toBeUndefined();
  });

  it('(d) reports an open-selected hole as info', () => {
    const drop: Tuple3 = [-0.07, -0.01, -1];
    const hole = sel.edges.meshBoundary().and(rim([-0.0701, -0.0101, -1], [-0.0299, 0.0101, 1]));
    const report = split(0.0035, drop).validate({
      watertight: {
        open: outer.or(hole),
        table,
        reference: { surface: reference, tolerance: TOL },
      },
    });
    expect(errors(report)).toEqual([]);
    expect(uncovered(report).map((i) => i.severity)).toContain('info');
    const open = report.watertight?.coverage?.excluded.find((e) => e.reason === 'open');
    expect(open?.area).toBeGreaterThan(0.0002);
  });

  it('(e) reports a skin offset 4 mm everywhere with no excusals', () => {
    const report = split(0.0035, undefined, 0.004).validate({
      watertight: { open: outer, table, reference: { surface: reference, tolerance: TOL } },
    });
    const found = errors(report);
    expect(found.length).toBeGreaterThan(0);
    for (const i of found) expect((i.detail as { excluded: unknown[] }).excluded).toEqual([]);
    expect(report.watertight?.coverage?.excluded).toEqual([]);
    expect(report.watertight?.coverage?.interior.p50).toBeCloseTo(0.004, 6);
  });

  it('rejects a non-positive or NaN tolerance as an invalid argument', () => {
    for (const tolerance of [0, -0.001, Number.NaN]) {
      const m = split(0.0035);
      const report = m.validate({ watertight: { reference: { surface: reference, tolerance } } });
      expect(report.pass).toBe(false);
      const issue = report.issues.find(
        (i) => i.code === 'mesh-open' && i.detail.check === 'options',
      );
      expect(issue?.detail).toMatchObject({
        check: 'options',
        error: { code: 'model-invalid-argument', detail: { tolerance } },
      });
    }
  });

  describe('resolution at the c7 setting (tolerance 8 mm, reference 6.7 mm off the skin)', () => {
    /** A 0.2 x 0.1 m skin 6.7 mm over the reference in 2.5 mm cells, less a `size` square hole. */
    function lifted(size: number): Model {
      const m = model();
      m.plane({
        width: 0.2,
        height: 0.1,
        widthSegments: 80,
        heightSegments: 40,
        center: [0, 0, 0.0067],
      });
      const h = size / 2 + 1e-6;
      expect(m.delete(sel.inBox([-h, -h, -1], [h, h, 1], { by: 'all' })).status).toBe('ok');
      return m;
    }
    const check = (size: number) =>
      lifted(size).validate({
        watertight: { reference: { surface: reference, tolerance: 0.008, spacing: 0.002 } },
      });

    it('reports a 15 mm undesigned hole', () => {
      const report = check(0.015);
      const found = errors(report);
      expect(found).toHaveLength(1);
      const d = found[0]?.detail as { maxDistance: number; at: Tuple3 };
      // Hole center: sqrt(7.5^2 + 6.7^2) mm from the rim.
      expect(d.maxDistance).toBeGreaterThan(0.0095);
      expect(Math.hypot(d.at[0], d.at[1])).toBeLessThan(0.002);
      expect(report.watertight?.coverage?.covered.max).toBeLessThanOrEqual(0.008);
    });

    it('misses a 5 mm hole: below 2 sqrt(8^2 - 6.7^2) = 8.7 mm, every sample is within 8 mm', () => {
      const report = check(0.005);
      expect(errors(report)).toEqual([]);
      const c = report.watertight?.coverage;
      expect(c?.interior.max).toBeGreaterThan(0.0067);
      expect(c?.interior.max).toBeLessThan(0.008);
    });
  });
});

describe('hausdorff', () => {
  it('(f) keeps the values from before the sampleDistances refactor', () => {
    const soup = (n: number, f: (u: number, v: number) => Tuple3) => {
      const p: number[] = [];
      const c: number[] = [];
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) p.push(...f(i / n, j / n));
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const a = i * (n + 1) + j;
          c.push(a, a + n + 1, a + n + 2, a, a + n + 2, a + 1);
        }
      return { points: Float64Array.from(p), corners: Int32Array.from(c) };
    };
    const a = soup(7, (u, v) => [u, v, 0.1 * u * u - 0.05 * v]);
    const b = soup(11, (u, v) => [1.1 * u - 0.05, v * 0.9, 0.02 * u * v + 0.01]);
    // Recorded with the pre-refactor mesh-query (forgeax-modeling 9af0578).
    expect(hausdorff(a, b)).toEqual({ max: 0.11737453279380405, mean: 0.0300590419992991 });
    expect(hausdorff(b, a)).toEqual({ max: 0.11737453279380405, mean: 0.030059041999299044 });
    expect(hausdorff(a, a)).toEqual({ max: 1.576213700060856e-16, mean: 1.7632143420252236e-17 });
  });
});
