import { describe, expect, it } from 'vitest';
import { path } from '../curve';
import type { Tuple3 } from '../geom';
import { EDGE_SEAM } from '../mesh';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import { bounds, expectContract, sharpEdges } from './contract';

const SQUARE: Point2[] = [
  [-0.1, -0.1],
  [0.1, -0.1],
  [0.1, 0.1],
  [-0.1, 0.1],
];

function circle(radius: number, n: number): Point2[] {
  return Array.from({ length: n }, (_, k) => {
    const a = (2 * Math.PI * k) / n;
    return [radius * Math.cos(a), radius * Math.sin(a)] as Point2;
  });
}

function polygonArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point2;
    const b = points[(i + 1) % points.length] as Point2;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function edgesWith(m: Model, flag: number): number {
  const mesh = m.editMesh;
  return mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & flag) !== 0).length;
}

function positions(m: Model, selector = sel.all()): Tuple3[] {
  const mesh = m.editMesh;
  const ids = new Set<number>();
  for (const f of selector.evaluate(mesh)) for (const v of mesh.faceVertices(f)) ids.add(v);
  return [...ids].map((v) => mesh.position(v));
}

function has(points: readonly Tuple3[], p: Tuple3, digits = 9): boolean {
  return points.some((q) => q.every((c, k) => Math.abs(c - (p[k] as number)) < 10 ** -digits));
}

function uvRange(m: Model): { u: number; v: number } {
  const mesh = m.editMesh;
  let u = 0;
  let v = 0;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const c = mesh.corner('uv0', h);
      if (c === undefined) throw new Error('missing uv');
      u = Math.max(u, c[0] as number);
      v = Math.max(v, c[1] as number);
    }
  }
  return { u, v };
}

describe('sweep', () => {
  it('sweeps a square along a straight path into an exact capped prism', () => {
    const m = model();
    const op = m.sweep({
      profile: SQUARE,
      path: [
        [0, 0, 0],
        [2, 0, 0],
      ],
      label: 'bar',
      tag: 'bar',
    });
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ side: 4, start: 1, end: 1 });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(0.04 * 2, 12);
    expect(bounds(m.editMesh).map((c) => Math.round(c * 1e9) / 1e9)).toEqual([
      0, -0.1, -0.1, 2, 0.1, 0.1,
    ]);
    expect(sharpEdges(m.editMesh)).toBe(4 + 8);
    expect(edgesWith(m, EDGE_SEAM)).toBe(1);
    const range = uvRange(m);
    expect(range.u).toBeCloseTo(0.8, 6);
    expect(range.v).toBeCloseTo(2, 6);
    expect(m.count(sel.createdBy('bar', 'start').and(sel.facing('-x', 1)).one())).toBe(1);
    expect(m.count(sel.createdBy('bar', 'end').and(sel.facing('+x', 1)).one())).toBe(1);
    expect(m.count(sel.tag('bar'))).toBe(6);
    const clockwise = model();
    clockwise.sweep({
      profile: [...SQUARE].reverse(),
      path: [
        [0, 0, 0],
        [2, 0, 0],
      ],
    });
    expect(clockwise.validate().volume).toBeCloseTo(0.08, 12);
    expectContract(m);
  });

  it('places the section with x across and y up, and keeps the wall width across a mitered joint', () => {
    const m = model();
    const profile: Point2[] = [
      [-0.1, -0.05],
      [0.1, -0.05],
      [0.1, 0.05],
      [-0.1, 0.05],
    ];
    m.sweep({
      profile,
      path: [
        [0, 0, 0],
        [0, 0, 1],
        [1, 0, 1],
      ],
    });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(0.02 * 2, 12);
    const [x0, y0, , x1, y1, z1] = bounds(m.editMesh);
    expect(y0).toBeCloseTo(-0.05, 12);
    expect(y1).toBeCloseTo(0.05, 12);
    expect(x0).toBeCloseTo(-0.1, 12);
    expect(x1).toBeCloseTo(1, 12);
    expect(z1).toBeCloseTo(1.1, 12);
    expect(sharpEdges(m.editMesh)).toBe(4 * 2 + 4 + 8);
    expectContract(m);
  });

  it('rounds polyline corners with exact circular bends', () => {
    const m = model();
    m.sweep({
      profile: circle(0.02, 12),
      path: path.polyline(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, 1],
        ],
        { radius: 0.2, segments: 8 },
      ),
      label: 'tube',
    });
    expect(m.poisoned).toBeUndefined();
    const ring = positions(m, sel.createdBy('tube', 'side'));
    expect(ring.length).toBe(12 * (2 + 9));
    const center: Tuple3 = [0.8, 0, 0.2];
    const onBend = ring.filter((p) => p[0] > 0.8 + 1e-9 && p[2] < 0.2 - 1e-9);
    for (const p of onBend) {
      const r = Math.hypot(p[0] - center[0], p[2] - center[2]);
      expect(r).toBeGreaterThan(0.2 - 0.0201);
      expect(r).toBeLessThan(0.2 + 0.0201);
    }
    expect(m.journal.at(-1)?.diagnostics?.some((d) => d.severity === 'warn') ?? false).toBe(false);
    expectContract(m);
    const tight = model();
    tight.sweep({
      profile: circle(0.02, 8),
      path: path.polyline(
        [
          [0, 0, 0],
          [0.1, 0, 0],
          [0.1, 0, 0.1],
        ],
        { radius: 0.2, segments: 4 },
      ),
    });
    expect(tight.poisoned?.code).toBe('model-invalid-argument');
  });

  it('keeps rotation-minimizing frames free of roll on a planar arc and closes a ring', () => {
    const m = model();
    m.sweep({
      profile: SQUARE,
      path: path.arc({ radius: 1, angle: 90, segments: 12 }),
      caps: false,
    });
    for (const p of positions(m)) expect(Math.abs(Math.abs(p[1]) - 0.1)).toBeLessThan(1e-12);
    const ring = model();
    const op = ring.sweep({
      profile: circle(0.1, 10),
      path: path.arc({ radius: 1, angle: 360, segments: 24 }),
      closed: true,
      label: 'ring',
    });
    expect(op.roles).toEqual({ side: 240 });
    const report = ring.validate();
    expect(report.closed).toBe(true);
    const exact = polygonArea(circle(0.1, 10)) * 48 * Math.sin(Math.PI / 24);
    expect(Math.abs(report.volume - exact) / exact).toBeLessThan(1e-9);
    expect(edgesWith(ring, EDGE_SEAM)).toBe(24 + 10);
    expect(uvRange(ring).v).toBeCloseTo(48 * Math.sin(Math.PI / 24), 5);
    expectContract(ring);
  });

  it('spreads the frame mismatch of a closed non-planar path evenly', () => {
    const m = model();
    const knot = path.catmullRom(
      [
        [1, 0, 0],
        [0, 0.5, 1],
        [-1, 0, 0],
        [0, -0.5, -1],
      ],
      8,
    );
    m.sweep({ profile: circle(0.08, 8), path: knot, closed: true });
    expect(m.poisoned).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeGreaterThan(0);
    const longest = Math.max(
      ...m.editMesh.faces().map((f) => {
        const p = m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v));
        return Math.hypot(
          ...[0, 1, 2].map(
            (k) => ((p[1] as Tuple3)[k] as number) - ((p[2] as Tuple3)[k] as number),
          ),
        );
      }),
    );
    expect(longest).toBeLessThan(0.25);
  });

  it('applies twist and scale ramps by arc length', () => {
    const m = model();
    const op = m.sweep({
      profile: SQUARE,
      path: [
        [0, 0, 0],
        [0, 0, 1],
      ],
      twist: 45,
      scale: [1, 0.5],
      segments: 4,
      label: 'twist',
    });
    expect(op.status).toBe('ok');
    const end = positions(m, sel.createdBy('twist', 'end'));
    expect(end).toHaveLength(4);
    for (const p of end) {
      expect(p[2]).toBeCloseTo(1, 12);
      expect(Math.min(Math.abs(p[0]), Math.abs(p[1]))).toBeCloseTo(0, 12);
      expect(Math.max(Math.abs(p[0]), Math.abs(p[1]))).toBeCloseTo(0.05 * Math.SQRT2, 12);
    }
    const start = positions(m, sel.createdBy('twist', 'start'));
    expect(has(start, [0.1, -0.1, 0])).toBe(true);
    const plain = model();
    plain.sweep({
      profile: SQUARE,
      path: [
        [0, 0, 0],
        [0, 0, 1],
      ],
      scale: [1, 0.5],
      label: 'twist',
    });
    expect(has(positions(plain, sel.createdBy('twist', 'end')), [0.05, -0.05, 1])).toBe(true);
    expect(has(positions(m, sel.createdBy('twist', 'end')), [0.05, -0.05, 1])).toBe(false);
    expect(
      op.diagnostics?.some((d) => d.severity === 'info' && d.message.includes('non-planar')),
    ).toBe(true);
    expectContract(m);
  });

  it('morphs between sections with different vertex counts and keeps every corner', () => {
    const m = model();
    const op = m.sweep({
      profile: [SQUARE, circle(0.1, 8)],
      path: [
        [0, 0, 0],
        [0, 0, 1],
      ],
      segments: 2,
      label: 'morph',
    });
    expect(op.status).toBe('ok');
    const start = positions(m, sel.createdBy('morph', 'start'));
    const end = positions(m, sel.createdBy('morph', 'end'));
    expect(start.length).toBe(end.length);
    for (const corner of SQUARE) expect(has(start, [corner[0], corner[1], 0])).toBe(true);
    for (const p of circle(0.1, 8)) expect(has(end, [p[0], p[1], 1])).toBe(true);
    expectContract(m);
  });

  it('builds a spring from a helix path and fails when coils overlap', () => {
    const spring = path.helix({ radius: 0.05, pitch: 0.03, turns: 5, segments: 16 });
    const m = model();
    const op = m.sweep({ profile: circle(0.006, 8), path: spring, label: 'coil' });
    expect(op.status).toBe('ok');
    expect(op.diagnostics?.filter((d) => d.severity === 'warn') ?? []).toEqual([]);
    const [, y0, , , y1] = bounds(m.editMesh) as number[];
    expect((y1 as number) - (y0 as number)).toBeGreaterThan(0.15);
    expect((y1 as number) - (y0 as number)).toBeLessThan(0.15 + 0.013);
    const report = m.validate();
    expect(report.closed).toBe(true);
    const length = 5 * Math.hypot(2 * Math.PI * 0.05, 0.03);
    const exact = polygonArea(circle(0.006, 8)) * length;
    expect(Math.abs(report.volume - exact) / exact).toBeLessThan(0.02);
    const tight = model();
    const overlapping = tight.sweep({
      profile: circle(0.02, 8),
      path: path.helix({ radius: 0.05, pitch: 0.03, turns: 3, segments: 16 }),
    });
    expect(overlapping.status).toBe('failed');
    expect(overlapping.error?.code).toBe('model-precondition');
    expect(overlapping.error?.expected).toMatch(/do not cross each other/);
    expect((overlapping.error?.detail as { at: unknown[] }).at.length).toBeGreaterThan(0);
    expect(tight.editMesh.faceCount).toBe(0);
    const left = path.helix({ radius: 1, pitch: 1, turns: 0.25, segments: 4, handedness: 'left' });
    const right = path.helix({ radius: 1, pitch: 1, turns: 0.25, segments: 4 });
    const a = model();
    a.sweep({ profile: circle(0.1, 6), path: left, caps: false, label: 'h' });
    const b = model();
    b.sweep({ profile: circle(0.1, 6), path: right, caps: false, label: 'h' });
    expect(a.bounds(sel.all()).ok && b.bounds(sel.all()).ok).toBe(true);
    const ax = a.bounds(sel.all());
    const bx = b.bounds(sel.all());
    if (!ax.ok || !bx.ok) throw new Error('bounds');
    expect(ax.value.min[0]).toBeLessThan(-0.5);
    expect(bx.value.max[0]).toBeGreaterThan(0.5);
  });

  it('rejects a section that folds over itself at a tight joint', () => {
    const m = model();
    m.sweep({
      profile: SQUARE,
      path: [
        [0, 0, 0],
        [1, 0, 0],
        [0.95, 0, 0.05],
      ],
    });
    expect(m.poisoned?.code).toBe('model-precondition');
    expect(m.poisoned?.detail).toMatchObject({ span: 1 });
    const wide = model();
    wide.sweep({
      profile: SQUARE,
      path: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
      ],
    });
    expect(wide.poisoned).toBeUndefined();
  });

  it('keeps the section toward up in frame mode up, and reports vertical paths', () => {
    const m = model();
    m.sweep({
      profile: SQUARE,
      path: path.catmullRom(
        [
          [0, 0, 0],
          [1, 0.5, 0],
          [2, 0, 1],
        ],
        6,
      ),
      frame: 'up',
    });
    expect(m.poisoned).toBeUndefined();
    const vertical = model();
    vertical.sweep({
      profile: SQUARE,
      path: [
        [0, 0, 0],
        [0, 1, 0],
      ],
      frame: 'up',
    });
    expect(vertical.poisoned?.code).toBe('model-degenerate');
    const rmf = model();
    rmf.sweep({
      profile: SQUARE,
      path: [
        [0, 0, 0],
        [0, 1, 0],
      ],
    });
    expect(rmf.poisoned).toBeUndefined();
  });

  it('reports degenerate and invalid inputs with structured errors', () => {
    const cases: [string, Parameters<Model['sweep']>[0]][] = [
      [
        'model-degenerate',
        {
          profile: SQUARE,
          path: [
            [0, 0, 0],
            [0, 0, 0],
          ],
        },
      ],
      ['model-invalid-argument', { profile: SQUARE, path: [[0, 0, 0]] }],
      [
        'model-degenerate',
        {
          profile: [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
          path: [
            [0, 0, 0],
            [0, 0, 1],
          ],
        },
      ],
      [
        'model-invalid-argument',
        {
          profile: [
            [0, 0],
            [2, 2],
            [2, 0],
            [0, 1],
          ],
          path: [
            [0, 0, 0],
            [0, 0, 1],
          ],
        },
      ],
      [
        'model-invalid-argument',
        {
          profile: SQUARE,
          path: [
            [0, 0, 0],
            [0, 0, 1],
          ],
          segments: 0,
        },
      ],
      [
        'model-invalid-argument',
        {
          profile: SQUARE,
          path: [
            [0, 0, 0],
            [0, 0, 1],
          ],
          scale: 0,
        },
      ],
      [
        'model-invalid-argument',
        {
          profile: SQUARE,
          path: path.arc({ radius: 1, angle: 360, segments: 8 }),
          closed: true,
          twist: 45,
        },
      ],
      [
        'model-invalid-argument',
        {
          profile: SQUARE,
          path: path.arc({ radius: 1, angle: 360, segments: 8 }),
          closed: true,
          caps: true,
        },
      ],
      [
        'model-invalid-argument',
        {
          profile: SQUARE,
          path: path.helix({ radius: 1, pitch: 0.1, turns: 1, segments: 8 }),
          closed: true,
        },
      ],
      [
        'model-degenerate',
        {
          profile: SQUARE,
          path: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 0, 0],
          ],
        },
      ],
      [
        'model-invalid-argument',
        {
          profile: SQUARE,
          path: [
            [0, 0, 0],
            [0, 0, Number.NaN],
          ],
        },
      ],
    ];
    for (const [code, options] of cases) {
      const m = model();
      m.sweep(options);
      expect(m.poisoned?.code, JSON.stringify(options)).toBe(code);
    }
  });

  it('is deterministic', () => {
    const build = () => {
      const m = model();
      m.sweep({
        profile: [SQUARE, circle(0.08, 7)],
        path: path.catmullRom(
          [
            [0, 0, 0],
            [1, 1, 0],
            [2, 0, 1],
            [3, 1, 1],
          ],
          5,
        ),
        twist: [10, 200],
        scale: [1, 0.6],
        label: 'a',
      });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });
});

describe('loft', () => {
  const square = (y: number, h = 0.5): Tuple3[] => [
    [-h, y, -h],
    [-h, y, h],
    [h, y, h],
    [h, y, -h],
  ];
  const octagon = (y: number, r: number, start = 0): Tuple3[] =>
    Array.from({ length: 8 }, (_, k) => {
      const a = (2 * Math.PI * (k + start)) / 8;
      return [r * Math.cos(a), y, -r * Math.sin(a)] as Tuple3;
    });

  it('lofts sections with different vertex counts and keeps every corner', () => {
    const m = model();
    const op = m.loft({ profiles: [square(0), octagon(1, 0.5), square(2, 0.3)], label: 'loft' });
    expect(op.status).toBe('ok');
    expect(m.count(sel.createdBy('loft', 'start'))).toBe(1);
    expect(m.count(sel.createdBy('loft', 'end'))).toBe(1);
    const all = positions(m);
    for (const p of [...square(0), ...octagon(1, 0.5), ...square(2, 0.3)])
      expect(has(all, p)).toBe(true);
    for (const p of all) expect([0, 1, 2].some((y) => Math.abs(p[1] - y) < 1e-12)).toBe(true);
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeGreaterThan(0);
    expect(sharpEdges(m.editMesh)).toBeGreaterThanOrEqual(4 * 2 + 2 * (all.length / 3));
    expectContract(m);
  });

  it('winds sections consistently and picks the start that follows the previous section', () => {
    const base = model();
    base.loft({ profiles: [octagon(0, 0.5), octagon(1, 0.4)] });
    const flipped = model();
    flipped.loft({ profiles: [octagon(0, 0.5), [...octagon(1, 0.4)].reverse()] });
    const shifted = model();
    shifted.loft({ profiles: [octagon(0, 0.5), octagon(1, 0.4, 3)] });
    const volume = base.validate().volume;
    expect(volume).toBeGreaterThan(0);
    expect(flipped.validate().volume).toBeCloseTo(volume, 12);
    expect(shifted.validate().volume).toBeCloseTo(volume, 12);
    const indexed = model();
    indexed.loft({ profiles: [octagon(0, 0.5), octagon(1, 0.4, 3)], match: 'index' });
    expect(indexed.validate().volume).toBeLessThan(volume - 1e-3);
  });

  it('aligns sections at a continuous arc-length offset, so lofts do not twist', () => {
    const m = model();
    m.loft({ profiles: [octagon(0, 0.5), octagon(1, 0.4, 0.5)] });
    const mesh = m.editMesh;
    let rails = 0;
    for (const e of mesh.edges()) {
      const [a, b] = mesh.edgeVertices(e).map((v) => mesh.position(v)) as [Tuple3, Tuple3];
      if (a[1] === b[1]) continue;
      if (Math.abs(a[0] * b[2] - a[2] * b[0]) < 1e-12 && a[0] * b[0] + a[2] * b[2] > 0) rails++;
    }
    expect(rails).toBe(16);
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('interpolates smooth rows and closes rings of sections', () => {
    const m = model();
    m.loft({ profiles: [square(0), square(1, 0.2), square(2)], segments: 3, label: 'vase' });
    expect(m.count(sel.createdBy('vase', 'side'))).toBeGreaterThanOrEqual(4 * 6);
    const rows = new Set(positions(m).map((p) => p[1].toFixed(9)));
    expect(rows.size).toBe(7);
    const mid = positions(m).filter((p) => Math.abs(p[1] - 1 / 3) < 1e-9);
    expect(Math.abs(mid[0]?.[0] ?? 0)).not.toBeCloseTo(0.5 - 0.3 / 3, 6);
    const ring = model();
    const sections = [0, 1, 2, 3].map((k) => {
      const a = (k * Math.PI) / 2;
      const c: Tuple3 = [Math.cos(a), 0, Math.sin(a)];
      const t: Tuple3 = [-Math.sin(a), 0, Math.cos(a)];
      const r: Tuple3 = [Math.cos(a), 0, Math.sin(a)];
      return circle(0.2, 6)
        .map(([x, y]) => [c[0] + r[0] * x, y, c[2] + r[2] * x] as Tuple3)
        .map((p) => [p[0] + t[0] * 0, p[1], p[2]] as Tuple3);
    });
    const op = ring.loft({ profiles: sections, closed: true, label: 'ring' });
    expect(op.status).toBe('ok');
    expect(op.roles.start).toBeUndefined();
    expect(ring.validate().closed).toBe(true);
    expect(ring.validate().volume).toBeGreaterThan(0);
  });

  it('reports invalid, degenerate and non-planar sections', () => {
    const cases: [string, Parameters<Model['loft']>[0]][] = [
      ['model-invalid-argument', { profiles: [square(0)] }],
      ['model-invalid-argument', { profiles: [square(0), square(1)], closed: true }],
      ['model-invalid-argument', { profiles: [square(0), octagon(1, 0.4)], match: 'index' }],
      [
        'model-degenerate',
        {
          profiles: [
            square(0),
            [
              [0, 1, 0],
              [1, 1, 0],
              [2, 1, 0],
            ],
          ],
        },
      ],
      [
        'model-precondition',
        {
          profiles: [
            square(0),
            [
              [-1, 1, -1],
              [-1, 1.2, 1],
              [1, 1, 1],
              [1, 1, -1],
            ],
          ],
        },
      ],
      ['model-degenerate', { profiles: [square(0), square(0, 0.2)] }],
      [
        'model-degenerate',
        {
          profiles: [
            square(0),
            [
              [0, 1, -1],
              [0, 1, 1],
              [0, 2, 1],
              [0, 2, -1],
            ],
          ],
        },
      ],
      [
        'model-invalid-argument',
        {
          profiles: [
            square(0),
            [
              [0, 1, 0],
              [2, 1, 2],
              [2, 1, 0],
              [0, 1, 1],
            ],
          ],
        },
      ],
    ];
    for (const [code, options] of cases) {
      const m = model();
      m.loft(options);
      expect(m.poisoned?.code, JSON.stringify(options)).toBe(code);
    }
  });
});

describe('array', () => {
  function bolt(): Model {
    const m = model();
    m.cylinder({
      radiusTop: 0.01,
      radiusBottom: 0.01,
      height: 0.05,
      radialSegments: 6,
      label: 'bolt',
      tag: 'bolt',
    });
    return m;
  }

  it('repeats a selection linearly with per-copy tags and preserved origins', () => {
    const m = bolt();
    const op = m.array(sel.tag('bolt'), { linear: { count: 3, offset: [0.1, 0, 0] } });
    expect(op.roles).toEqual({ copy: 16 });
    expect(m.count(sel.tag('copy:0'))).toBe(8);
    expect(m.count(sel.tag('copy:2'))).toBe(8);
    expect(m.count(sel.createdBy('bolt', 'side'))).toBe(18);
    const original = m.bounds(sel.tag('copy:0'));
    const b = m.bounds(sel.tag('copy:2'));
    if (!b.ok || !original.ok) throw new Error('bounds');
    expect(b.value.min[0]).toBeCloseTo(original.value.min[0] + 0.2, 12);
    const labeled = bolt();
    labeled.array(sel.all(), { linear: { count: 2, offset: [0, 0, 0.1] }, label: 'row' });
    expect(labeled.count(sel.createdBy('row', 'copy'))).toBe(8);
    expect(labeled.count(sel.tag('row:1'))).toBe(8);
    expect(labeled.count(sel.createdBy('bolt'))).toBe(8);
    expectContract(m);
  });

  it('places copies radially, evenly around a full turn or up to an angle', () => {
    const m = bolt();
    m.translate(sel.all(), [0.2, 0, 0]);
    const before = m.bounds(sel.all());
    m.array(sel.all(), { radial: { count: 4, axis: 'y' } });
    const b = m.bounds(sel.all());
    if (!b.ok || !before.ok) throw new Error('bounds');
    expect(b.value.min[0]).toBeCloseTo(-before.value.max[0], 9);
    expect(b.value.max[2]).toBeCloseTo(before.value.max[0], 9);
    const fan = bolt();
    fan.translate(sel.all(), [0.2, 0, 0]);
    fan.array(sel.all(), { radial: { count: 3, axis: [0, 1, 0], angle: 90, center: [0, 0, 0] } });
    const last = fan.bounds(sel.tag('copy:2'));
    if (!last.ok) throw last.error;
    expect((last.value.min[2] + last.value.max[2]) / 2).toBeCloseTo(-0.2, 9);
    expectContract(m);
  });

  it('moves copies along a curve, aligned to its frames or only translated', () => {
    const m = model();
    m.box({ size: [0.02, 0.02, 0.06], tag: 'link' });
    const op = m.array(sel.tag('link'), {
      onCurve: { count: 5, path: path.arc({ radius: 1, angle: 180, segments: 32 }) },
    });
    expect(op.roles).toEqual({ moved: 6, copy: 24 });
    for (let i = 0; i < 5; i++) {
      const b = m.bounds(sel.tag(`copy:${i}`));
      if (!b.ok) throw b.error;
      const c = [0, 1, 2].map((k) => ((b.value.min[k] as number) + (b.value.max[k] as number)) / 2);
      expect(Math.hypot(c[0] as number, c[2] as number)).toBeCloseTo(1, 2);
    }
    const first = m.bounds(sel.tag('copy:0'));
    if (!first.ok) throw first.error;
    expect(first.value.max[0] - first.value.min[0]).toBeCloseTo(0.06, 2);
    expect(first.value.max[2] - first.value.min[2]).toBeCloseTo(0.02, 2);
    const plain = model();
    plain.box({ size: [0.02, 0.02, 0.06], tag: 'link' });
    plain.array(sel.all(), {
      onCurve: { count: 5, path: path.arc({ radius: 1, angle: 180, segments: 32 }), align: false },
    });
    const straight = plain.bounds(sel.tag('copy:0'));
    if (!straight.ok) throw straight.error;
    expect(straight.value.max[2] - straight.value.min[2]).toBeCloseTo(0.06, 6);
    const ring = model();
    ring.box({ size: [0.02, 0.02, 0.06] });
    ring.array(sel.all(), {
      onCurve: { count: 8, path: path.arc({ radius: 1, angle: 360, segments: 64 }), closed: true },
    });
    expect(ring.poisoned).toBeUndefined();
    expect(ring.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const attached = model();
    attached.box({ size: [1, 1, 1] });
    attached.array(sel.facing('+y'), {
      onCurve: {
        count: 2,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
      },
    });
    expect(attached.poisoned?.code).toBe('model-precondition');
    expectContract(m);
  });

  it('copies another session into the mesh', () => {
    const part = bolt();
    const m = model();
    m.box({ size: [0.5, 0.02, 0.5], tag: 'plate' });
    const op = m.array(part, { radial: { count: 5, axis: 'y' }, label: 'studs' });
    expect(op.roles).toEqual({ copy: 40 });
    expect(m.count(sel.tag('bolt'))).toBe(40);
    expect(m.count(sel.tag('studs:4'))).toBe(8);
    expect(m.count(sel.createdBy('studs', 'copy'))).toBe(40);
    const snapshot = model();
    snapshot.array(part.snapshot(), { linear: { count: 2, offset: [1, 0, 0] } });
    expect(snapshot.count(sel.createdBy('bolt'))).toBe(16);
  });

  it('rejects counts below the minimum, missing or mixed modes and zero offsets', () => {
    const cases: Parameters<Model['array']>[1][] = [
      { linear: { count: 1, offset: [1, 0, 0] } },
      { linear: { count: 0, offset: [1, 0, 0] } },
      { radial: { count: 1, axis: 'y' } },
      {
        onCurve: {
          count: 0,
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
      },
      { linear: { count: 2, offset: [0, 0, 0] } },
      { radial: { count: 2, axis: [0, 0, 0] } },
      { linear: { count: 2, offset: [1, 0, 0] }, radial: { count: 2, axis: 'y' } } as never,
      {} as never,
    ];
    for (const options of cases) {
      const m = bolt();
      m.array(sel.all(), options);
      expect(m.poisoned?.code, JSON.stringify(options)).toBe('model-invalid-argument');
    }
  });

  it("match 'index' keeps the correspondence of sections that run back along the path (F2 cuff band)", () => {
    // A closed rectangular-section band: outer rings at y 0 and 0.03, inner rings back at
    // 0.03 - e and e. Reversing the inner rings one by one joined mirrored indices.
    const ring = (r: number, y: number): Tuple3[] =>
      Array.from({ length: 16 }, (_, k) => {
        const a = (2 * Math.PI * k) / 16;
        return [r * Math.cos(a), y, r * Math.sin(a)];
      });
    for (const order of ['forward', 'backward'] as const) {
      const rings = [ring(0.05, 0), ring(0.05, 0.03), ring(0.046, 0.029), ring(0.046, 0.001)];
      const m = model();
      const r = m.loft({
        profiles: order === 'forward' ? rings : [...rings].reverse(),
        closed: true,
        match: 'index',
      });
      expect(r.status, order).toBe('ok');
      const report = m.validate();
      expect(
        report.issues.filter((i) => i.severity !== 'info'),
        order,
      ).toEqual([]);
      expect(report.closed).toBe(true);
      // Volume of the rectangular-section ring band (16-gon areas).
      const area = (rr: number) => 8 * rr * rr * Math.sin((2 * Math.PI) / 16);
      expect(report.volume).toBeGreaterThan(0);
      expect(Math.abs(report.volume - (area(0.05) - area(0.046)) * 0.03)).toBeLessThan(
        (area(0.05) - area(0.046)) * 0.03 * 0.1,
      );
      expect(m.toMesh().ok).toBe(true);
    }
  });
});

describe('sweep: distant overlap fails at any length (review W-3)', () => {
  const coil = (pitch: number, segments: number, turns = 3) =>
    path.helix({ radius: 0.05, pitch, turns, segments });

  it('fails a tube whose coils cross beyond 2048 spans, before writing', () => {
    const m = model();
    m.box({ size: [0.01, 0.01, 0.01], center: [1, 0, 0] });
    const before = m.snapshot();
    const op = m.sweep({ profile: circle(0.02, 8), path: coil(0.03, 1024) });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-precondition');
    expect(op.diagnostics?.some((d) => d.message.includes('scan runs up to')) ?? false).toBe(false);
    expect(m.snapshot()).toEqual(before);
  });

  it('keeps coils that only come near (gap below the diameter, walls apart)', () => {
    const m = model();
    // Octagon of circumradius 0.02 between coils 0.041 apart: closer than the
    // circumscribed diameter only at the rounded tips, never crossing.
    const op = m.sweep({ profile: circle(0.02, 8), path: coil(0.041, 1024) });
    expect(op.status).toBe('ok');
    expect(m.validate().issues.some((i) => i.code === 'self-intersection')).toBe(false);
  });
});
