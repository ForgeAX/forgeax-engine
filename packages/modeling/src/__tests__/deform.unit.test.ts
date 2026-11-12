import { describe, expect, it } from 'vitest';
import { path } from '../curve';
import { meanValueWeights } from '../deform';
import { meshVolume, type Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';
import { bounds, expectContract } from './contract';

function strip(): Model {
  const m = model();
  m.plane({ width: 1, height: 0.1, widthSegments: 32, center: [0.5, 0, 0] });
  return m;
}

function bar(): Model {
  const m = model();
  m.box({ size: [0.2, 1, 0.2], center: [0, 0.5, 0], segments: [1, 8, 1] });
  return m;
}

function detail(r: OpReport): Record<string, unknown> {
  return r.diagnostics?.find((d) => d.severity === 'info')?.detail ?? {};
}

function warned(r: OpReport, text: string): boolean {
  return (r.diagnostics ?? []).some((d) => d.severity === 'warn' && d.message.includes(text));
}

function at(m: Model, x: number, y: number): Tuple3 {
  const mesh = m.editMesh;
  const found = mesh.vertices().find((v) => {
    const p = mesh.position(v);
    return Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9;
  });
  if (found === undefined) throw new Error(`no vertex at ${x}, ${y}`);
  return mesh.position(found);
}

function positions(m: Model): Tuple3[] {
  return m.editMesh.vertices().map((v) => m.editMesh.position(v));
}

describe('bend', () => {
  it('bends a strip into a quarter circle of radius length / angle', () => {
    const m = strip();
    const tip = at(m, 1, 0.05);
    expect(tip).toEqual([1, 0.05, 0]);
    const r = m.bend(sel.all(), { axis: 'x', toward: '+z', angle: 90 });
    expect(r.status).toBe('ok');
    const radius = 2 / Math.PI;
    expect(detail(r).radius).toBeCloseTo(radius, 12);
    const mesh = m.editMesh;
    for (const v of mesh.vertices()) {
      const p = mesh.position(v);
      expect(Math.hypot(p[0], p[2] - radius)).toBeCloseTo(radius, 9);
    }
    const end = bounds(mesh);
    expect(end[3]).toBeCloseTo(radius, 9);
    expect(end[5]).toBeCloseTo(radius, 9);
    expect(detail(r).maxDisplacement).toBeGreaterThan(0.5);
    expectContract(m);
  });

  it('continues straight beyond the range and leaves the start untouched', () => {
    const m = strip();
    m.bend(sel.all(), { axis: 'x', toward: '-z', angle: 90, range: [0, 0.5] });
    const radius = 0.5 / (Math.PI / 2);
    const tip = m.editMesh
      .vertices()
      .map((v) => m.editMesh.position(v))
      .reduce((a, b) => (b[2] < a[2] ? b : a));
    expect(tip[0]).toBeCloseTo(radius, 9);
    expect(tip[2]).toBeCloseTo(-radius - 0.5, 9);
    expect(bounds(m.editMesh)[0]).toBe(0);
  });

  it('falsifies the effect assertion: a range beyond the mesh moves nothing', () => {
    const m = strip();
    const r = m.bend(sel.all(), { axis: 'x', toward: '+z', angle: 45, range: [2, 3] });
    expect(r.error?.code).toBe('model-op-no-effect');
    expect(r.error?.detail?.maxDisplacement).toBe(0);
  });

  it('flags faces turned inside out by a bend tighter than the part', () => {
    const m = model();
    m.box({ size: [1, 0.2, 0.6], center: [0.5, 0, 0], segments: [16, 1, 1] });
    const r = m.bend(sel.all(), { axis: 'x', toward: '+z', angle: 300, origin: [0.5, 0, -0.3] });
    expect(r.status).toBe('ok');
    expect(warned(r, 'inverted')).toBe(true);
  });

  it('rejects zero angles and a direction along the axis', () => {
    expect(strip().bend(sel.all(), { axis: 'x', toward: '+z', angle: 0 }).error?.code).toBe(
      'model-invalid-argument',
    );
    expect(strip().bend(sel.all(), { axis: 'x', toward: '+x', angle: 30 }).error?.code).toBe(
      'model-invalid-argument',
    );
  });
});

describe('twist and taper', () => {
  it('twists the top of a bar by the full angle about its axis', () => {
    const m = bar();
    const r = m.twist(sel.all(), { axis: 'y', angle: 90 });
    expect(r.status).toBe('ok');
    const top = positions(m).filter((p) => Math.abs(p[1] - 1) < 1e-9);
    for (const p of top) {
      // A right-handed quarter turn about +Y maps (x, z) to (z, -x); corners stay corners.
      expect(Math.abs(Math.abs(p[0]) - 0.1)).toBeLessThan(1e-12);
      expect(Math.abs(Math.abs(p[2]) - 0.1)).toBeLessThan(1e-12);
    }
    const bottom = positions(m).filter((p) => Math.abs(p[1]) < 1e-9);
    expect(bottom.length).toBe(4);
    const mid = positions(m).filter((p) => Math.abs(p[1] - 0.5) < 1e-9);
    for (const p of mid) expect(Math.hypot(p[0], p[2])).toBeCloseTo(Math.hypot(0.1, 0.1), 12);
    expect(Math.abs(meshVolume(m.editMesh) - 0.04)).toBeLessThan(0.001);
  });

  it('tapers cross sections linearly and only on the requested axes', () => {
    const m = bar();
    m.taper(sel.all(), { axis: 'y', factor: 0.5 });
    const b = bounds(m.editMesh);
    expect(b[3]).toBeCloseTo(0.1, 12);
    const top = positions(m).filter((p) => Math.abs(p[1] - 1) < 1e-9);
    for (const p of top) {
      expect(Math.abs(p[0])).toBeCloseTo(0.05, 12);
      expect(Math.abs(p[2])).toBeCloseTo(0.05, 12);
    }
    const flat = bar();
    flat.taper(sel.all(), { axis: 'y', factor: 2, axes: ['x'] });
    const fb = bounds(flat.editMesh);
    expect(fb[3]).toBeCloseTo(0.2, 12);
    expect(fb[5]).toBeCloseTo(0.1, 12);
    expect(bar().taper(sel.all(), { axis: 'y', factor: 1 }).error?.code).toBe(
      'model-invalid-argument',
    );
    expect(bar().taper(sel.all(), { axis: 'y', factor: 2, axes: ['y'] }).error?.code).toBe(
      'model-invalid-argument',
    );
  });

  it('deforms only a vertex selection when given one', () => {
    const m = bar();
    const r = m.twist(sel.all().toVerts('touching'), { axis: 'y', angle: 45, range: [0.5, 1] });
    expect(r.status).toBe('ok');
    const low = positions(m).filter((p) => p[1] < 0.5 - 1e-9);
    for (const p of low) expect(Math.abs(p[0])).toBeCloseTo(0.1, 12);
  });
});

describe('lattice', () => {
  it('moves vertices trilinearly with a 2 x 2 x 2 lattice', () => {
    const m = bar();
    const up: Tuple3 = [0, 0.2, 0];
    const r = m.lattice(sel.all(), {
      resolution: [2, 2, 2],
      offsets: [
        { index: [0, 1, 0], offset: up },
        { index: [1, 1, 0], offset: up },
        { index: [0, 1, 1], offset: up },
        { index: [1, 1, 1], offset: up },
      ],
    });
    expect(r.status).toBe('ok');
    const b = bounds(m.editMesh);
    expect(b[1]).toBe(0);
    expect(b[4]).toBeCloseTo(1.2, 12);
    const mid = positions(m).filter((p) => Math.abs(p[1] - 0.6) < 1e-9);
    expect(mid.length).toBe(4);
  });

  it('bulges with a higher-degree lattice and keeps outside vertices', () => {
    const m = bar();
    const r = m.lattice(sel.all(), {
      resolution: [3, 3, 3],
      bounds: { min: [-0.2, 0.2, -0.2], max: [0.2, 0.8, 0.2] },
      offsets: [{ index: [2, 1, 1], offset: [0.1, 0, 0] }],
    });
    expect(r.status).toBe('ok');
    expect(detail(r).outside).toBe(16);
    expect(bounds(m.editMesh)[3]).toBeGreaterThan(0.1);
  });

  it('stays continuous at the lattice box: boundary vertices are not reported inverted', () => {
    const m = model();
    m.box({ size: [0.7, 0.1, 0.9], segments: [6, 1, 4] });
    const r = m.lattice(sel.all(), {
      resolution: [3, 2, 3],
      offsets: [
        { index: [1, 0, 1], offset: [0, 0.07, 0] },
        { index: [1, 1, 1], offset: [0, 0.07, 0] },
      ],
    });
    expect(r.status).toBe('ok');
    expect(warned(r, 'inverted')).toBe(false);
    expect(bounds(m.editMesh)[4]).toBeCloseTo(0.05 + 0.07 / 4, 12);
  });

  it('falsifies the inversion assertion: a lattice pushed through itself reports inverted faces', () => {
    const r = bar().lattice(sel.all(), {
      resolution: [2, 2, 2],
      offsets: [0, 1].flatMap((i) =>
        [0, 1].map((k) => ({
          index: [i, 1, k] as [number, number, number],
          offset: [0, -2, 0] as Tuple3,
        })),
      ),
    });
    expect(r.status).toBe('ok');
    expect(warned(r, 'inverted')).toBe(true);
  });

  it('rejects bad resolutions and indices; zero offsets have no effect', () => {
    const bad = (options: Parameters<Model['lattice']>[1]) =>
      bar().lattice(sel.all(), options).error?.code;
    expect(bad({ resolution: [1, 2, 2], offsets: [{ index: [0, 0, 0], offset: [0, 1, 0] }] })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ resolution: [2, 2, 2], offsets: [{ index: [2, 0, 0], offset: [0, 1, 0] }] })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ resolution: [2, 2, 2], offsets: [] })).toBe('model-invalid-argument');
    expect(bad({ resolution: [2, 2, 2], offsets: [{ index: [0, 0, 0], offset: [0, 0, 0] }] })).toBe(
      'model-op-no-effect',
    );
  });
});

describe('cage (mean value coordinates)', () => {
  const CUBE: Tuple3[] = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const FACES = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
  ];
  const sphere = () => {
    const m = model();
    m.sphere({ radius: 0.5, widthSegments: 12, heightSegments: 8, center: [0.1, 0.2, -0.1] });
    return m;
  };

  it('reproduces linear maps exactly (linear precision)', () => {
    const m = sphere();
    const before = positions(m);
    const r = m.cage(sel.all(), {
      cage: { points: CUBE, faces: FACES },
      deformed: CUBE.map(([x, y, z]) => [2 * x + 0.3, y - z, z + 0.5] as Tuple3),
    });
    expect(r.status).toBe('ok');
    expect(detail(r).maxReproductionError).toBeLessThan(1e-9);
    const after = positions(m);
    for (const [i, [x, y, z]] of before.entries()) {
      const q = after[i] as Tuple3;
      expect(q[0]).toBeCloseTo(2 * x + 0.3, 9);
      expect(q[1]).toBeCloseTo(y - z, 9);
      expect(q[2]).toBeCloseTo(z + 0.5, 9);
    }
  });

  it('deforms smoothly when one cage corner moves', () => {
    const m = sphere();
    const deformed = CUBE.map((p) => [...p] as Tuple3);
    deformed[6] = [1.6, 1.6, 1.6];
    const r = m.cage(sel.all(), { cage: { points: CUBE, faces: FACES }, deformed });
    expect(r.status).toBe('ok');
    expect(bounds(m.editMesh)[3]).toBeGreaterThan(0.6);
    expect(warned(r, 'inverted')).toBe(false);
    const w = meanValueWeights([0, 0, 0], CUBE, [[0, 1, 2]], 1e-12);
    expect(w).toBeDefined();
  });

  it('falsifies the effect assertion: an unmoved cage changes nothing', () => {
    const r = sphere().cage(sel.all(), { cage: { points: CUBE, faces: FACES }, deformed: CUBE });
    expect(r.error?.code).toBe('model-op-no-effect');
  });

  it('rejects open, inside-out and mismatched cages', () => {
    const run = (faces: number[][], deformed = CUBE) =>
      sphere().cage(sel.all(), { cage: { points: CUBE, faces }, deformed }).error?.code;
    expect(run(FACES.slice(1))).toBe('model-precondition');
    expect(run(FACES.map((f) => [...f].reverse()))).toBe('model-precondition');
    expect(run(FACES, CUBE.slice(1))).toBe('model-invalid-argument');
  });
});

describe('curveDeform', () => {
  it('lays a bar along a straight path, keeping orientation', () => {
    const m = model();
    m.box({ size: [0.2, 0.1, 1], center: [0, 0, 0.5], segments: [1, 1, 4] });
    const volume = meshVolume(m.editMesh);
    const r = m.curveDeform(sel.all(), {
      path: [
        [0, 1, 0],
        [2, 1, 0],
      ],
      axis: 'z',
    });
    expect(r.status).toBe('ok');
    const b = bounds(m.editMesh);
    expect(b[0]).toBeCloseTo(0, 12);
    expect(b[3]).toBeCloseTo(1, 12);
    expect(b[1]).toBeCloseTo(0.95, 12);
    expect(b[4]).toBeCloseTo(1.05, 12);
    expect(meshVolume(m.editMesh)).toBeCloseTo(volume, 12);
    expectContract(m);
  });

  it('follows an arc, stretched to the whole path', () => {
    const m = model();
    m.box({ size: [0.1, 0.1, 1], center: [0, 0, 0.5], segments: [1, 1, 16] });
    const r = m.curveDeform(sel.all(), {
      path: path.arc({ radius: 1, angle: 180, segments: 64, axis: 'y' }),
      axis: 'z',
      stretch: true,
    });
    expect(r.status).toBe('ok');
    expect(detail(r).stretch).toBeGreaterThan(3);
    for (const p of positions(m)) {
      const radial = Math.hypot(p[0], p[2]);
      expect(radial).toBeGreaterThan(0.94);
      expect(radial).toBeLessThan(1.06);
    }
  });
});

describe('smooth (Taubin)', () => {
  function noisy(): Model {
    const m = model();
    m.sphere({ radius: 1, widthSegments: 24, heightSegments: 16 });
    const mesh = m.editMesh;
    for (const v of mesh.vertices()) {
      const p = mesh.position(v);
      const k = 1 + 0.08 * (((v * 7919) % 13) / 13 - 0.5);
      mesh.setPosition(v, p[0] * k, p[1] * k, p[2] * k);
    }
    return m;
  }

  it('reduces roughness without shrinking the volume much', () => {
    const m = noisy();
    const volume = meshVolume(m.editMesh);
    const r = m.smooth(sel.all(), { iterations: 10 });
    expect(r.status).toBe('ok');
    const d = detail(r) as { roughnessBefore: number; roughnessAfter: number };
    expect(d.roughnessAfter).toBeLessThan(d.roughnessBefore);
    const spread = (x: Model) => {
      const r = positions(x).map((p) => Math.hypot(...p));
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      return Math.sqrt(r.reduce((a, b) => a + (b - mean) * (b - mean), 0) / r.length);
    };
    expect(spread(m)).toBeLessThan(spread(noisy()) * 0.5);
    expect(Math.abs(meshVolume(m.editMesh) / volume - 1)).toBeLessThan(0.05);
    const shrink = noisy();
    shrink.smooth(sel.all(), { iterations: 10, lambda: 0.5, mu: -0.500001 });
    expect(meshVolume(shrink.editMesh)).toBeLessThan(meshVolume(m.editMesh));
  });

  it('pins boundary and sharp vertices by default', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 6, heightSegments: 6 });
    const mesh = m.editMesh;
    for (const v of mesh.vertices()) {
      const p = mesh.position(v);
      mesh.setPosition(v, p[0], p[1], 0.02 * ((v * 31) % 5));
    }
    const rim = sel.edges.meshBoundary();
    const before = m.bounds(rim);
    m.smooth(sel.all(), { iterations: 5 });
    expect(m.bounds(rim)).toEqual(before);
    const free = model();
    free.plane({ width: 1, height: 1, widthSegments: 6, heightSegments: 6 });
    for (const v of free.editMesh.vertices()) {
      const p = free.editMesh.position(v);
      free.editMesh.setPosition(v, p[0], p[1], 0.02 * ((v * 31) % 5));
    }
    const rimBefore = free.bounds(rim);
    free.smooth(sel.all(), { iterations: 5, pin: { boundary: false } });
    expect(free.bounds(rim)).not.toEqual(rimBefore);
  });

  it('falsifies the effect assertion: a flat grid is already smooth', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    expect(m.smooth(sel.all(), { iterations: 3 }).error?.code).toBe('model-op-no-effect');
    const fresh = model();
    fresh.plane({ width: 1, height: 1 });
    expect(fresh.smooth(sel.all(), { iterations: 0 }).error?.code).toBe('model-invalid-argument');
    expect(model().smooth(sel.all(), { iterations: 1, mu: -0.1 }).error?.code).toBe(
      'model-selection-empty',
    );
  });

  it('is deterministic', () => {
    const a = noisy();
    const b = noisy();
    a.smooth(sel.all(), { iterations: 4 });
    b.smooth(sel.all(), { iterations: 4 });
    expect(a.snapshot()).toEqual(b.snapshot());
  });
});
