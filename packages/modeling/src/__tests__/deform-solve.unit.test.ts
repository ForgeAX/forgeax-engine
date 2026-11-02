import { describe, expect, it } from 'vitest';
import { meanCurvatures } from '../deform-solve';
import { meshVolume, type Tuple3 } from '../geom';
import type { EditMesh } from '../mesh';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

const R = 2 / Math.PI;

function detail(r: OpReport): Record<string, unknown> {
  return r.diagnostics?.find((d) => d.severity === 'info')?.detail ?? {};
}

function warnings(r: OpReport): string[] {
  return (r.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.message);
}

function edgeLengths(mesh: EditMesh): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of mesh.edges()) {
    const [a, b] = mesh.edgeVertices(e);
    const p = mesh.position(a);
    const q = mesh.position(b);
    out.set(e, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  return out;
}

function strain(before: Map<number, number>, mesh: EditMesh): { max: number; mean: number } {
  let max = 0;
  let sum = 0;
  for (const [e, l1] of edgeLengths(mesh)) {
    const s = Math.abs(l1 - (before.get(e) as number)) / (before.get(e) as number);
    max = Math.max(max, s);
    sum += s;
  }
  return { max, mean: sum / before.size };
}

/** A thin bar along +y from 0 to 1, bent by moving its top end onto a quarter arc of radius 2/pi. */
function bentBar(iterations: number): { m: Model; r: OpReport; before: Map<number, number> } {
  const m = model();
  m.box({ size: [0.04, 1, 0.04], center: [0, 0.5, 0], segments: [1, 20, 1] });
  const before = edgeLengths(m.editMesh);
  const r = m.arap(sel.all(), {
    handles: [
      { selector: sel.extreme('+y'), rotate: { axis: [0, 0, -1], angle: 90 }, to: [R, R, 0] },
    ],
    pin: sel.extreme('-y'),
    iterations,
  });
  return { m, r, before };
}

function noisySphere(): Model {
  const m = model();
  m.sphere({ radius: 1, widthSegments: 24, heightSegments: 16 });
  const mesh = m.editMesh;
  let seed = 12345;
  for (const v of mesh.vertices()) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const k = 1 + 0.05 * (seed / 2147483648 - 0.5);
    const p = mesh.position(v);
    mesh.setPosition(v, p[0] * k, p[1] * k, p[2] * k);
  }
  return m;
}

function curvatureVariance(m: Model): number {
  const mesh = m.editMesh;
  const h = meanCurvatures(mesh, mesh.vertices());
  if (!h.ok) throw h.error;
  const mean = h.value.reduce((s, x) => s + x, 0) / h.value.length;
  return h.value.reduce((s, x) => s + (x - mean) ** 2, 0) / h.value.length;
}

describe('arap', () => {
  it('bends a bar onto a quarter arc and keeps its edge lengths', () => {
    const { m, r, before } = bentBar(100);
    expect(r.status).toBe('ok');
    expect(warnings(r)).toEqual([]);
    const s = strain(before, m.editMesh);
    // Fibers at the half thickness of a bar bent to radius R strain by 0.02 / R = 3.1%.
    expect(s.max).toBeLessThan(0.06);
    expect(s.mean).toBeLessThan(0.02);
    const mesh = m.editMesh;
    for (const v of mesh.vertices()) {
      const p = mesh.position(v);
      expect(Math.abs(Math.hypot(p[0] - R, p[1]) - R)).toBeLessThan(0.035);
    }
    const d = detail(r);
    const energies = d.energies as number[];
    expect(energies).toHaveLength(101);
    for (let i = 1; i < energies.length; i++) {
      expect(energies[i] as number).toBeLessThanOrEqual((energies[i - 1] as number) * (1 + 1e-9));
    }
    expect(d.maxDisplacement).toBeGreaterThan(0.7);
    expect(d.system).toEqual({ rows: 76, nnz: expect.any(Number), assembled: 1, solves: 300 });
    expect(d.maxEdgeStrain).toBeCloseTo(s.max, 9);
  });

  it('falsifier: one local/global iteration (Laplacian editing) stretches the bar', () => {
    const one = bentBar(1);
    const many = bentBar(100);
    const s1 = strain(one.before, one.m.editMesh);
    const s30 = strain(many.before, many.m.editMesh);
    expect(s1.max).toBeGreaterThan(3 * s30.max);
    expect(s1.mean).toBeGreaterThan(1.5 * s30.mean);
  });

  it('keeps pinned and unselected vertices and moves handles rigidly', () => {
    const m = model();
    m.box({ size: [0.04, 1, 0.04], center: [0, 0.5, 0], segments: [1, 20, 1] });
    const mesh = m.editMesh;
    const low = mesh.vertices().filter((v) => mesh.position(v)[1] < 0.2);
    const rest = new Map(mesh.vertices().map((v) => [v, mesh.position(v)] as const));
    const r = m.arap(sel.inBox([-1, 0.19, -1], [1, 2, 1]), {
      handles: [{ selector: sel.extreme('+y'), translate: [0.2, 0, 0] }],
      iterations: 5,
    });
    expect(r.status).toBe('ok');
    for (const v of low) expect(mesh.position(v)).toEqual(rest.get(v));
    const top = mesh.vertices().filter((v) => (rest.get(v) as Tuple3)[1] > 0.999);
    for (const v of top) {
      const p = rest.get(v) as Tuple3;
      const q = mesh.position(v);
      expect(q[0]).toBeCloseTo(p[0] + 0.2, 12);
      expect(q[1]).toBeCloseTo(p[1], 12);
    }
  });

  it('warns when a handle pushes faces inside out, and only then (falsifier)', () => {
    const { r } = bentBar(10);
    expect(warnings(r)).toEqual([]);
    const m = model();
    m.box({ size: [0.04, 1, 0.04], center: [0, 0.5, 0], segments: [1, 20, 1] });
    const crushed = m.arap(sel.all(), {
      handles: [{ selector: sel.extreme('+y'), to: [0, -0.6, 0] }],
      pin: sel.extreme('-y'),
      iterations: 10,
    });
    expect(crushed.status).toBe('ok');
    expect(warnings(crushed).some((w) => w.includes('inverted'))).toBe(true);
  });

  it('fails when nothing moves', () => {
    const m = model();
    m.box({ size: [0.04, 1, 0.04], center: [0, 0.5, 0], segments: [1, 4, 1] });
    const r = m.arap(sel.all(), {
      handles: [{ selector: sel.extreme('+y'), translate: [0, 0, 0] }],
      pin: sel.extreme('-y'),
    });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-op-no-effect');
    const turned = model();
    turned.box({ size: [0.04, 1, 0.04], center: [0, 0.5, 0], segments: [1, 4, 1] });
    const zero = turned.arap(sel.all(), {
      handles: [{ selector: sel.extreme('+y'), rotate: { axis: [1, 0, 0], angle: 0 } }],
    });
    expect(zero.error?.code).toBe('model-op-no-effect');
  });

  it('rejects degenerate handles and options with structured errors', () => {
    const top = sel.extreme('+y');
    const bottom = sel.extreme('-y');
    const cases: [Parameters<Model['arap']>[1], string, Parameters<Model['arap']>[0]?][] = [
      [{ handles: [] }, 'model-invalid-argument'],
      [
        { handles: [{ selector: sel.tag('missing'), translate: [0, 0.1, 0] }] },
        'model-selection-empty',
      ],
      [{ handles: [{ selector: top }] }, 'model-invalid-argument'],
      [
        { handles: [{ selector: top, translate: [0, 1, 0], to: [0, 0, 0] }] },
        'model-invalid-argument',
      ],
      [{ handles: [{ selector: top, translate: [0, Number.NaN, 0] }] }, 'model-invalid-argument'],
      [
        { handles: [{ selector: top, rotate: { axis: [0, 0, 0], angle: 30 } }] },
        'model-invalid-argument',
      ],
      [
        {
          handles: [
            { selector: top, rotate: { axis: [1, 0, 0], angle: Number.POSITIVE_INFINITY } },
          ],
        },
        'model-invalid-argument',
      ],
      [
        {
          handles: [
            { selector: top, translate: [0.1, 0, 0] },
            { selector: top.or(bottom), translate: [0, 0.1, 0] },
          ],
        },
        'model-invalid-argument',
      ],
      [
        { handles: [{ selector: top, translate: [0.1, 0, 0] }], pin: top },
        'model-invalid-argument',
      ],
      [{ handles: [{ selector: top, translate: [0.1, 0, 0] }] }, 'model-invalid-argument', bottom],
      [
        { handles: [{ selector: top, translate: [0.1, 0, 0] }], iterations: 0 },
        'model-invalid-argument',
      ],
      [
        { handles: [{ selector: top, translate: [0.1, 0, 0] }], iterations: 201 },
        'model-invalid-argument',
      ],
      [
        { handles: [{ selector: top, translate: [0.1, 0, 0] }], pin: 'everything' as never },
        'model-invalid-argument',
      ],
      [
        { handles: [{ selector: top, translate: [0.1, 0, 0] }], solver: { tolerance: 2 } },
        'model-invalid-argument',
      ],
      [
        { handles: [{ selector: top, translate: [0.1, 0, 0] }], pin: sel.all() },
        'model-invalid-argument',
      ],
      [{ handles: [{ selector: top, translate: [0.1, 0, 0] }] }, 'model-precondition', top],
    ];
    for (const [options, code, target] of cases) {
      const m = model();
      m.box({ size: [0.04, 1, 0.04], center: [0, 0.5, 0], segments: [1, 4, 1] });
      const positions = () => m.editMesh.vertices().map((v) => m.editMesh.position(v));
      const before = positions();
      const r = m.arap(target ?? sel.all(), options);
      expect(r.status, JSON.stringify(r.error)).toBe('failed');
      expect(r.error?.code, JSON.stringify(r.error?.detail)).toBe(code);
      expect(m.poisoned?.code).toBe(code);
      expect(positions()).toEqual(before);
    }
  });

  it('rejects a free part that touches no handle, pin or unselected vertex', () => {
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], tag: 'a' });
    m.box({ size: [0.1, 0.1, 0.1], center: [1, 0, 0], tag: 'b' });
    const r = m.arap(sel.all(), {
      handles: [{ selector: sel.tag('a').and(sel.extreme('+y')), translate: [0, 0.1, 0] }],
    });
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.expected).toContain('connected part');
  });

  it('reports solver failure and native unavailability from the solve.sparse job', () => {
    const m = model();
    m.box({ size: [0.04, 1, 0.04], center: [0, 0.5, 0], segments: [1, 20, 1] });
    const r = m.arap(sel.all(), {
      handles: [{ selector: sel.extreme('+y'), translate: [0.3, 0, 0] }],
      pin: sel.extreme('-y'),
      solver: { maxIterations: 1 },
    });
    expect(r.error?.code).toBe('model-solver-diverged');
    expect(r.error?.detail).toMatchObject({
      method: 'pcg-jacobi',
      iteration: 1,
      coordinate: 'x',
      backend: 'ts',
    });
    const native = model();
    native.box({ size: [0.04, 1, 0.04], center: [0, 0.5, 0], segments: [1, 4, 1] });
    const n = native.arap(sel.all(), {
      handles: [{ selector: sel.extreme('+y'), translate: [0.3, 0, 0] }],
      solver: { compute: 'native' },
    });
    expect(n.error?.code).toBe('model-capability-unavailable');
  });

  it('journals selectors by description', () => {
    const { m } = bentBar(2);
    const entry = m.journal.at(-1);
    expect(entry?.op).toBe('arap');
    expect(entry?.args).toMatchObject({
      selector: 'all()',
      handles: [{ selector: 'extreme(+y)', to: [R, R, 0] }],
      pin: 'extreme(-y)',
    });
    expect(JSON.parse(JSON.stringify(entry?.args))).toEqual(entry?.args);
  });

  it('is byte-deterministic', () => {
    expect(bentBar(8).m.snapshot()).toEqual(bentBar(8).m.snapshot());
  });
});

describe('smooth.implicit', () => {
  it('reduces the curvature variance of a noisy sphere', () => {
    const m = noisySphere();
    const varianceBefore = curvatureVariance(m);
    const r = m.smooth.implicit(undefined, { lambda: 0.3, iterations: 2, preserveVolume: true });
    expect(r.status).toBe('ok');
    expect(warnings(r)).toEqual([]);
    const varianceAfter = curvatureVariance(m);
    expect(varianceAfter).toBeLessThan(varianceBefore * 0.05);
    const d = detail(r);
    expect(d.curvatureVarianceBefore).toBeCloseTo(varianceBefore, 9);
    expect(d.curvatureVarianceAfter).toBeCloseTo(varianceAfter, 9);
    expect(d.solves).toBe(6);
    expect(d.maxDisplacement).toBeGreaterThan(0.01);
  });

  it('preserves the volume when asked, and shrinks without it (falsifier)', () => {
    const kept = noisySphere();
    const volume = meshVolume(kept.editMesh);
    kept.smooth.implicit(undefined, { lambda: 2, iterations: 3, preserveVolume: true });
    expect(meshVolume(kept.editMesh) / volume).toBeCloseTo(1, 10);
    const shrunk = noisySphere();
    shrunk.smooth.implicit(undefined, { lambda: 2, iterations: 3 });
    expect(meshVolume(shrunk.editMesh) / volume).toBeLessThan(0.97);
  });

  it('keeps boundary and sharp vertices by default, and pins selections', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
    const mesh = m.editMesh;
    let seed = 7;
    for (const v of mesh.vertices()) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const p = mesh.position(v);
      mesh.setPosition(v, p[0], p[1] + 0.02 * (seed / 2147483648 - 0.5), p[2]);
    }
    const rest = new Map(mesh.vertices().map((v) => [v, mesh.position(v)] as const));
    const boundary = new Set(
      mesh
        .edges()
        .filter((e) => mesh.isBoundaryEdge(e))
        .flatMap((e) => mesh.edgeVertices(e)),
    );
    const r = m.smooth.implicit(sel.all(), { lambda: 0.5 });
    expect(r.status).toBe('ok');
    for (const v of boundary) expect(mesh.position(v)).toEqual(rest.get(v));
    const interior = mesh.vertices().filter((v) => !boundary.has(v));
    expect(interior.some((v) => mesh.position(v)[1] !== (rest.get(v) as Tuple3)[1])).toBe(true);
    const free = model();
    free.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    free.editMesh.setPosition(0, 0.5, 0.2, 0.5);
    const moved = free.editMesh.position(0);
    const unpinned = free.smooth.implicit(undefined, { lambda: 1, pin: [] });
    expect(unpinned.status).toBe('ok');
    expect(free.editMesh.position(0)).not.toEqual(moved);
    const pinned = noisySphere();
    const top = sel.inBox([-2, 0.5, -2], [2, 2, 2]);
    const held = new Set(
      top.evaluate(pinned.editMesh).flatMap((f) => pinned.editMesh.faceVertices(f)),
    );
    const kept = new Map([...held].map((v) => [v, pinned.editMesh.position(v)] as const));
    expect(pinned.smooth.implicit(undefined, { lambda: 0.3, pin: top }).status).toBe('ok');
    for (const [v, p] of kept) expect(pinned.editMesh.position(v)).toEqual(p);
  });

  it('falsifier: a flat grid with pinned boundary does not move (model-op-no-effect)', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 6, heightSegments: 6 });
    const r = m.smooth.implicit(sel.all(), { lambda: 1 });
    expect(r.error?.code).toBe('model-op-no-effect');
  });

  it('only moves the selected vertices', () => {
    const m = noisySphere();
    const mesh = m.editMesh;
    const rest = new Map(mesh.vertices().map((v) => [v, mesh.position(v)] as const));
    const selected = sel.inBox([-2, 0.3, -2], [2, 2, 2]);
    const inside = new Set(selected.evaluate(mesh).flatMap((f) => mesh.faceVertices(f)));
    const r = m.smooth.implicit(selected, { lambda: 1, pin: [] });
    expect(r.status).toBe('ok');
    for (const v of mesh.vertices())
      if (!inside.has(v)) expect(mesh.position(v)).toEqual(rest.get(v));
  });

  it('rejects invalid options and reports solver failure', () => {
    const cases: [Parameters<Model['smooth']['implicit']>[1], string][] = [
      [{ lambda: 0 }, 'model-invalid-argument'],
      [{ lambda: Number.NaN }, 'model-invalid-argument'],
      [{ lambda: 1, iterations: 0 }, 'model-invalid-argument'],
      [{ lambda: 1, iterations: 101 }, 'model-invalid-argument'],
      [{ lambda: 1, pin: 42 as never }, 'model-invalid-argument'],
      [{ lambda: 1, pin: sel.tag('missing') }, 'model-selection-empty'],
      [{ lambda: 1, pin: sel.all() }, 'model-precondition'],
      [{ lambda: 1, solver: { maxIterations: 1 } }, 'model-solver-diverged'],
      [{ lambda: 1, solver: { compute: 'native' } }, 'model-capability-unavailable'],
    ];
    for (const [options, code] of cases) {
      const r = noisySphere().smooth.implicit(undefined, options);
      expect(r.error?.code, JSON.stringify(options)).toBe(code);
    }
    const open = model();
    open.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    const r = open.smooth.implicit(undefined, { lambda: 1, preserveVolume: true });
    expect(r.error?.code).toBe('model-precondition');
    const diverged = noisySphere().smooth.implicit(undefined, {
      lambda: 1,
      solver: { maxIterations: 1 },
    });
    expect(diverged.error?.detail).toMatchObject({
      step: 1,
      coordinate: 'x',
      method: 'pcg-jacobi',
    });
  });

  it('keeps Taubin smoothing callable beside it', () => {
    const m = noisySphere();
    expect(m.smooth(sel.all(), { iterations: 2 }).status).toBe('ok');
    expect(m.journal.at(-1)?.op).toBe('smooth');
  });

  it('is byte-deterministic', () => {
    const run = () => {
      const m = noisySphere();
      m.smooth.implicit(undefined, { lambda: 1, iterations: 2, preserveVolume: true });
      return m.snapshot();
    };
    expect(run()).toEqual(run());
  });
});
