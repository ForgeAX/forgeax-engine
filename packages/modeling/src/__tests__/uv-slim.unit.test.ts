import { describe, expect, it } from 'vitest';
import { WorkMeter } from '../compute/job';
import {
  acceptRefinement,
  lineSearch,
  overlapPairs,
  restOf,
  type SlimIsland,
  slim,
  slimEnergy,
} from '../compute/uv-slim';
import { measureUv } from '../compute/uv-ts';
import type { Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { trianglesOverlap2d } from '../predicates';
import { sel } from '../selectors';

/** An n x n vertex grid on the surface z = height(x, y); CCW triangles, one boundary loop. */
function grid(n: number, height: (x: number, y: number) => number = () => 0): SlimIsland {
  const points: Tuple3[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) points.push([i, j, height(i, j)]);
  }
  const at = (i: number, j: number) => j * n + i;
  const triangles: number[] = [];
  for (let j = 0; j + 1 < n; j++) {
    for (let i = 0; i + 1 < n; i++) {
      triangles.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      triangles.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  const disk: number[] = [];
  for (let i = 0; i < n - 1; i++) disk.push(at(i, 0));
  for (let j = 0; j < n - 1; j++) disk.push(at(n - 1, j));
  for (let i = n - 1; i > 0; i--) disk.push(at(i, n - 1));
  for (let j = n - 1; j > 0; j--) disk.push(at(0, j));
  return { points, triangles, disk };
}

/** The planar layout of `grid(n)`: already isometric. */
function planar(island: SlimIsland): Float64Array {
  const out = new Float64Array(2 * island.points.length);
  for (const [k, p] of island.points.entries()) {
    out[2 * k] = p[0];
    out[2 * k + 1] = p[1];
  }
  return out;
}

/** Deterministic pseudo-random in [-1, 1) (no Math.random: tests are replayable). */
function noise(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

function flips(island: SlimIsland, uv: Float64Array): number {
  let n = 0;
  for (let t = 0; t < island.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => island.triangles[t + j] as number) as [
      number,
      number,
      number,
    ];
    const area =
      ((uv[2 * b] as number) - (uv[2 * a] as number)) *
        ((uv[2 * c + 1] as number) - (uv[2 * a + 1] as number)) -
      ((uv[2 * c] as number) - (uv[2 * a] as number)) *
        ((uv[2 * b + 1] as number) - (uv[2 * a + 1] as number));
    if (!(area > 0)) n++;
  }
  return n;
}

const meter = () => new WorkMeter(Infinity);

function run(island: SlimIsland, start: Float64Array) {
  const r = slim(island, start, meter());
  if (!r.ok) throw r.error;
  if (r.value === undefined) throw new Error('slim declined');
  return r.value;
}

describe('slim (symmetric Dirichlet, flip-free)', () => {
  it('an isometric layout is a fixed point: energy 4, no iteration changes its shape', () => {
    const island = grid(5);
    const start = planar(island);
    expect(slimEnergy(island, start)).toBeCloseTo(4, 12);
    const out = run(island, start);
    expect(out.energy).toBeCloseTo(4, 9);
    expect(flips(island, out.uv)).toBe(0);
    expect(out.tutte).toBe(false);
    // Same shape up to a rigid motion: every grid edge keeps its length.
    const d = (uv: Float64Array, a: number, b: number) =>
      Math.hypot(
        (uv[2 * a] as number) - (uv[2 * b] as number),
        (uv[2 * a + 1] as number) - (uv[2 * b + 1] as number),
      );
    for (const [a, b] of [
      [0, 1],
      [0, 5],
      [6, 12],
      [3, 24],
    ] as const)
      expect(d(out.uv, a, b)).toBeCloseTo(d(start, a, b), 9);
  });

  it('a sheared, scaled start of a plane converges to isometry (energy 4) and never flips', () => {
    const island = grid(6);
    const rnd = noise(7);
    const start = planar(island);
    for (let k = 0; k < start.length; k += 2) {
      const x = start[k] as number;
      const y = start[k + 1] as number;
      start[k] = 3 * x + 0.5 * y + 0.02 * rnd();
      start[k + 1] = 0.4 * y + 0.02 * rnd();
    }
    expect(flips(island, start)).toBe(0);
    const before = slimEnergy(island, start);
    expect(before).toBeGreaterThan(10);
    const out = run(island, start);
    expect(out.energy).toBeLessThan(before);
    expect(out.energy).toBeLessThan(4.02);
    expect(flips(island, out.uv)).toBe(0);
    expect(out.iterations).toBeGreaterThan(0);
  });

  it('energy never increases over the iteration budget: more iterations are never worse', () => {
    const island = grid(7, (x, y) => 1.6 * Math.sin(x * 0.9) * Math.cos(y * 0.8));
    const start = planar(island);
    const energies: number[] = [slimEnergy(island, start)];
    let uv = start;
    for (let k = 0; k < 3; k++) {
      const out = run(island, uv);
      energies.push(out.energy);
      uv = out.uv;
    }
    for (let k = 1; k < energies.length; k++) {
      expect(energies[k]).toBeLessThanOrEqual((energies[k - 1] as number) + 1e-9);
    }
    expect(energies.at(-1)).toBeLessThan((energies[0] as number) - 0.01);
    expect(flips(island, uv)).toBe(0);
  });

  it('a curved patch keeps every triangle positive and lowers its energy from a planar projection', () => {
    const island = grid(9, (x, y) => 0.15 * ((x - 4) ** 2 + (y - 4) ** 2));
    const start = planar(island);
    const before = slimEnergy(island, start);
    const out = run(island, start);
    expect(Number.isFinite(before)).toBe(true);
    expect(out.energy).toBeLessThan(before);
    expect(flips(island, out.uv)).toBe(0);
    // The reported energy is the measured one.
    expect(slimEnergy(island, out.uv)).toBeCloseTo(out.energy, 9);
  });

  it('a folded start of a disk restarts from its Tutte embedding and ends flip-free', () => {
    const island = grid(6);
    const start = planar(island);
    // Fold one corner vertex across its neighbors.
    start[0] = 3;
    start[1] = 3;
    expect(flips(island, start)).toBeGreaterThan(0);
    expect(slimEnergy(island, start)).toBe(Infinity);
    const out = run(island, start);
    expect(out.tutte).toBe(true);
    expect(flips(island, out.uv)).toBe(0);
    expect(out.energy).toBeLessThan(4.1);
  });

  it('a folded start of a non-disk island is not refined (undefined, never a flipped result)', () => {
    const island = grid(6);
    const start = planar(island);
    start[0] = 3;
    start[1] = 3;
    const r = slim({ ...island, disk: undefined }, start, meter());
    expect(r.ok && r.value).toBe(undefined);
  });

  it('a degenerate 3D triangle is not refined', () => {
    const island = grid(4);
    const points = island.points.map((p, k) => (k === 5 ? (island.points[4] as Tuple3) : p));
    const r = slim({ ...island, points }, planar(island), meter());
    expect(r.ok && r.value).toBe(undefined);
  });

  it('is deterministic bit for bit', () => {
    const island = grid(8, (x, y) => 0.2 * x * y * 0.1 + Math.sin(x) * 0.3);
    const a = run(island, planar(island));
    const b = run(island, planar(island));
    expect(Array.from(a.uv)).toEqual(Array.from(b.uv));
    expect(a.iterations).toBe(b.iterations);
    expect(a.energy).toBe(b.energy);
  });

  it('stops with model-work-budget when the work budget is too small', () => {
    const island = grid(8, (x, y) => 0.3 * Math.sin(x * y * 0.2));
    const r = slim(island, planar(island), new WorkMeter(10));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-work-budget');
  });
});

describe('lineSearch (one SLIM step)', () => {
  // The unit right triangle (rest area 1/2): a layout's Jacobian is its two edge vectors.
  const island: SlimIsland = {
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: [0, 1, 2],
    disk: undefined,
  };
  const rest = restOf(island);
  if (rest === undefined) throw new Error('degenerate fixture');
  /** Unnormalized symmetric Dirichlet energy, the quantity lineSearch compares. */
  const energy = (uv: Float64Array) => {
    const [a, c, b, d] = [uv[2], uv[3], uv[4], uv[5]] as [number, number, number, number];
    const f = a * a + b * b + c * c + d * d;
    const det = a * d - b * c;
    return 0.5 * (f + f / (det * det));
  };
  const along = (x: Float64Array, dir: Float64Array, t: number) =>
    x.map((v, i) => v + t * (dir[i] as number));

  it('never steps through a fold, even when the far side has lower energy', () => {
    // J = diag(2 - 3t, 0.5 - 1.5t): the triangle folds on (1/3, 2/3) and comes back at
    // t = 1 as its 180-degree rotation, isometric and far below the start's energy.
    const x = new Float64Array([0, 0, 2, 0, 0, 0.5]);
    const dir = new Float64Array([0, 0, -3, 0, 0, -1.5]);
    expect(energy(along(x, dir, 1))).toBeCloseTo(2, 12);
    expect(energy(along(x, dir, 1))).toBeLessThan(energy(x));
    // Every energy-lowering step lies beyond the fold, so none is taken.
    expect(lineSearch(rest, island.triangles, x, dir, energy(x))).toBe(undefined);
  });

  it('takes a step only when it lowers the energy', () => {
    // From the isometric layout a uniform scale-up only raises the energy.
    const x = new Float64Array([0, 0, 1, 0, 0, 1]);
    expect(energy(along(x, x, 1))).toBeGreaterThan(energy(x));
    expect(lineSearch(rest, island.triangles, x, x, energy(x))).toBe(undefined);
    // A scale-down of an enlarged layout lowers it, and reports the energy it reached.
    const big = x.map((v) => 3 * v);
    const shrink = x.map((v) => -2 * v);
    const down = lineSearch(rest, island.triangles, big, shrink, energy(big));
    expect(down).toBeDefined();
    if (down === undefined) return;
    expect(down.energy).toBeLessThan(energy(big));
    expect(down.energy).toBeCloseTo(energy(down.x), 12);
  });
});

describe('overlapPairs', () => {
  it('counts none for a flip-free grid and every crossing pair for a folded one', () => {
    const island = grid(4);
    const uv = planar(island);
    expect(overlapPairs(island.triangles, uv)).toBe(0);
    const folded = uv.slice();
    folded[0] = 2.2;
    folded[1] = 2.2;
    expect(overlapPairs(island.triangles, folded)).toBeGreaterThan(0);
  });

  it('agrees with the exact predicate on triangles that only share a vertex or an edge', () => {
    const a = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    const edge = [
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const vertex = [
      [1, 0],
      [2, 0],
      [1, 1],
    ];
    const over = [
      [0.2, 0.2],
      [1.2, 0.2],
      [0.2, 1.2],
    ];
    expect(trianglesOverlap2d(a, edge)).toBe(false);
    expect(trianglesOverlap2d(a, vertex)).toBe(false);
    expect(trianglesOverlap2d(a, over)).toBe(true);
    const uv = new Float64Array([0, 0, 1, 0, 0, 1, 0.2, 0.2, 1.2, 0.2, 0.2, 1.2]);
    expect(overlapPairs([0, 1, 2, 3, 4, 5], uv)).toBe(1);
  });
});

describe('acceptRefinement (the gate)', () => {
  const good = { energy: 5, flipped: 0, overlaps: 0, areaDistortion: 2 };
  it('takes a refinement that lowers energy without flips, new overlaps or worse density', () => {
    expect(acceptRefinement({ ...good, energy: 8 }, good)).toBe('accepted');
    expect(acceptRefinement({ ...good, energy: 8 }, { ...good, areaDistortion: 1.5 })).toBe(
      'accepted',
    );
  });
  it('rejects a result that does not lower the energy', () => {
    expect(acceptRefinement(good, good)).toBe('no-gain');
    expect(acceptRefinement(good, { ...good, energy: 6 })).toBe('no-gain');
  });
  it('rejects any flipped or zero-area result when the start had none', () => {
    expect(acceptRefinement({ ...good, energy: 8 }, { ...good, flipped: 1 })).toBe('flipped');
  });
  it('rejects a result that overlaps itself more than the start did', () => {
    expect(acceptRefinement({ ...good, energy: 8 }, { ...good, overlaps: 1 })).toBe('overlap');
    expect(acceptRefinement({ ...good, energy: 8, overlaps: 2 }, { ...good, overlaps: 2 })).toBe(
      'accepted',
    );
  });
  it('rejects a result whose texel density spread grows (the density gate)', () => {
    expect(acceptRefinement({ ...good, energy: 8 }, { ...good, areaDistortion: 2.5 })).toBe(
      'density',
    );
  });
  it('repairs a folded start: any flip-free result beats it, density permitting', () => {
    const folded = { energy: Infinity, flipped: 3, overlaps: 4, areaDistortion: 100 };
    expect(acceptRefinement(folded, { ...good, areaDistortion: 6 })).toBe('accepted');
    expect(acceptRefinement(folded, { ...good, flipped: 1 })).toBe('flipped');
  });
});

type Metrics = Record<string, number>;

function infoOf(report: OpReport): { metrics: Metrics; islands: Metrics[] } {
  const info = report.diagnostics?.filter((d) => d.severity === 'info').at(-1);
  if (report.status !== 'ok' || info === undefined) {
    throw new Error(`${report.op}: ${report.error?.message}`);
  }
  return info.detail as unknown as { metrics: Metrics; islands: Metrics[] };
}

/** A bumpy open sheet: a disk island LSCM flattens with real stretch. */
const CAP = sel.inBox([-2, -0.2, -2], [2, 2, 2], { by: 'all' });
function bump(): Model {
  const m = model();
  m.sphere({ radius: 1, widthSegments: 16, heightSegments: 12 });
  return m;
}

function uvOf(m: Model): number[] {
  const out: number[] = [];
  for (const f of m.editMesh.faces()) {
    for (const h of m.editMesh.faceHalves(f)) {
      out.push(...Array.from(m.editMesh.corner('uv0', h) ?? []));
    }
  }
  return out;
}

describe("uv.unwrap { refine: 'slim' }", () => {
  it('lowers the stretch of a curved island, flip-free, with the refinement reported', () => {
    const plain = bump();
    const base = infoOf(plain.uv.unwrap({ method: 'lscm', faces: CAP }));
    const refined = bump();
    const report = refined.uv.unwrap({ method: 'lscm', faces: CAP, refine: 'slim' });
    const out = infoOf(report);
    expect(out.metrics.flipped).toBe(0);
    expect(out.metrics.refined).toBe(1);
    expect(out.metrics.refineRejected).toBe(0);
    expect(out.metrics.energyAfter).toBeLessThan(out.metrics.energyBefore as number);
    expect(out.metrics.stretchL2).toBeLessThan(base.metrics.stretchL2 as number);
    expect(out.metrics.overlaps).toBe(0);
    expect((out.islands[0] as Metrics).refineIterations).toBeGreaterThan(0);
    expect(out.metrics.iterations).toBe(base.metrics.iterations);
    expect(uvOf(refined)).not.toEqual(uvOf(plain));
  });

  it('without the option the output is the existing unwrap, byte for byte, and reports no refinement', () => {
    const a = bump();
    const b = bump();
    const x = infoOf(a.uv.unwrap({ method: 'lscm', faces: CAP }));
    b.uv.unwrap({ method: 'lscm', faces: CAP });
    expect(uvOf(a)).toEqual(uvOf(b));
    expect(x.metrics.refined).toBeUndefined();
    expect(x.metrics.overlaps).toBeUndefined();
  });

  it('is deterministic', () => {
    const a = bump();
    const b = bump();
    a.uv.unwrap({ method: 'lscm', faces: CAP, refine: 'slim' });
    b.uv.unwrap({ method: 'lscm', faces: CAP, refine: 'slim' });
    expect(uvOf(a)).toEqual(uvOf(b));
  });

  it('respects seams: islands stay separate, none merge or split, and a seam never joins UV values', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [3, 3, 3] });
    m.markSharp(sel.edges.dihedral('>', 40));
    const before = model();
    before.box({ size: [1, 1, 1], segments: [3, 3, 3] });
    before.markSharp(sel.edges.dihedral('>', 40));
    const a = infoOf(before.uv.unwrap({ seams: 'sharp' }));
    const b = infoOf(m.uv.unwrap({ seams: 'sharp', refine: 'slim' }));
    const ma = measureUv(before.editMesh);
    const mb = measureUv(m.editMesh);
    if (!ma.ok || !mb.ok) throw new Error('measure');
    expect(mb.value.islands.length).toBe(6);
    expect(mb.value.islands.length).toBe(ma.value.islands.length);
    expect(Array.from(mb.value.faceIsland)).toEqual(Array.from(ma.value.faceIsland));
    expect(b.metrics.islands).toBe(a.metrics.islands);
    expect(b.metrics.flipped).toBe(0);
  });

  it('rejects an unknown refine value as model-invalid-argument', () => {
    const m = bump();
    const report = m.uv.unwrap({ faces: CAP, refine: 'arap' as 'slim' });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('model-invalid-argument');
  });

  it('a rectified quad grid is not refined (its rows and columns stay straight)', () => {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 4, heightSegments: 2 });
    const info = infoOf(m.uv.unwrap({ method: 'rectify', refine: 'slim' }));
    expect(info.metrics.rectified).toBe(1);
    expect(info.metrics.refined).toBe(0);
    expect(info.metrics.refineRejected).toBe(0);
    expect((info.islands[0] as { refineStatus?: unknown }).refineStatus).toBeDefined();
  });
});

describe("uv.auto { refine: 'slim' }", () => {
  const ATLAS = { resolution: 1024, padding: 4 } as const;
  function sphere(): Model {
    const m = model();
    m.sphere({ radius: 1, widthSegments: 32, heightSegments: 16 });
    return m;
  }

  it('is wired: unwrap metrics carry the refinement, no flips, energy not above the unrefined run', () => {
    const plain = sphere();
    const refined = sphere();
    const p = infoOf(plain.uv.auto(ATLAS)).metrics;
    const r = refined.uv.auto({ ...ATLAS, refine: 'slim' });
    const info = r.diagnostics?.filter((d) => d.severity === 'info').at(-1);
    const detail = info?.detail as unknown as { unwrap: Metrics; metrics: Metrics };
    expect(r.status).toBe('ok');
    expect(detail.unwrap.refined).toBeGreaterThan(0);
    expect(detail.unwrap.flipped).toBe(0);
    expect(detail.unwrap.overlaps).toBe(0);
    expect(detail.unwrap.energyAfter).toBeLessThanOrEqual(detail.unwrap.energyBefore as number);
    expect(detail.metrics.charts).toBe(p.charts);
    const l = measureUv(refined.editMesh);
    if (!l.ok) throw l.error;
    expect(l.value.flipped).toBe(0);
    expect(refined.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain(
      'uv-overlap',
    );
  });

  it('leaves the default untouched: no option, no refinement metrics, same bytes as before', () => {
    const a = sphere();
    const b = sphere();
    a.uv.auto(ATLAS);
    b.uv.auto(ATLAS);
    expect(uvOf(a)).toEqual(uvOf(b));
    const info = a.uv
      .auto(ATLAS)
      .diagnostics?.filter((d) => d.severity === 'info')
      .at(-1);
    const detail = info?.detail as unknown as { unwrap: Metrics };
    expect(detail.unwrap.refined).toBeUndefined();
  });
});
