import { describe, expect, it } from 'vitest';
import { measureUv } from '../compute/uv-ts';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

type Metrics = Record<string, number>;

function metrics(report: OpReport): Metrics {
  const info = report.diagnostics?.filter((d) => d.severity === 'info').at(-1);
  if (info === undefined) throw new Error(`${report.op}: ${report.error?.message}`);
  return (info.detail as { metrics: Metrics }).metrics;
}

const warnings = (report: OpReport) =>
  (report.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.message);

function corners(m: Model, faces = sel.all()): [number, number][] {
  const mesh = m.editMesh;
  return faces
    .evaluate(mesh)
    .flatMap((f) =>
      mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) ?? []) as [number, number]),
    );
}

/** Flat washers (ring islands, planar-projected) and small squares, all in the plane y = 0. */
function ringsAndChips(): Model {
  const m = model();
  for (let i = 0; i < 4; i++) {
    m.revolve({
      points: [
        [0.5, 0],
        [0.3, 0],
      ],
      segments: 32,
      label: `w${i}`,
    });
    m.translate(sel.createdBy(`w${i}`), [i * 2, 0, 0]);
  }
  for (let i = 0; i < 24; i++) {
    const [x, z] = [i * 0.3, 3];
    m.polygon({
      points: [
        [x, 0, z],
        [x, 0, z + 0.15],
        [x + 0.15, 0, z + 0.15],
        [x + 0.15, 0, z],
      ],
    });
  }
  m.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
  return m;
}

describe('uv.pack raster', () => {
  it('fills ring holes: raster beats skyline on ring islands (falsifier) and is byte-deterministic', () => {
    const build = ringsAndChips;
    const sky = build();
    const skyline = metrics(sky.uv.pack({ resolution: 128, padding: 2 }));
    const ras = build();
    const raster = metrics(ras.uv.pack({ resolution: 128, padding: 2, method: 'raster' }));
    expect(raster.raster).toBe(1);
    expect(raster.coverage).toBeGreaterThan((skyline.coverage as number) * 1.15);
    // Nested islands overlap in their rectangles: utilization is their union (
    // 1.12 when the overlapping areas were summed), which still encloses every island.
    expect(raster.rectUtilization).toBeLessThanOrEqual(1);
    expect(raster.rectUtilization).toBeGreaterThanOrEqual(raster.coverage as number);
    expect(ras.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
    const again = build();
    again.uv.pack({ resolution: 128, padding: 2, method: 'raster' });
    expect(corners(again)).toEqual(corners(ras));
    // The cost is deterministic work units, not time: the same job spends the same work.
    expect(metrics(build().uv.pack({ resolution: 128, padding: 2, method: 'raster' })).work).toBe(
      raster.work,
    );
  }, 120_000);

  it('uv.auto passes the pack options through: raster beats skyline on ring charts', () => {
    const auto = (pack?: { readonly method: 'raster' }) => {
      const m = ringsAndChips();
      const r = m.uv.auto({ resolution: 128, padding: 2, ...(pack === undefined ? {} : { pack }) });
      const info = r.diagnostics?.find((d) => d.severity === 'info' && /uv.auto/.test(d.message));
      return { m, pack: (info?.detail as { pack: Metrics }).pack };
    };
    const skyline = auto();
    const raster = auto({ method: 'raster' });
    expect(skyline.pack.raster ?? 0).toBe(0);
    expect(raster.pack.raster).toBe(1);
    expect(raster.pack.coverage).toBeGreaterThan((skyline.pack.coverage as number) * 1.15);
    expect(raster.m.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain(
      'uv-overlap',
    );
    expect(corners(auto({ method: 'raster' }).m)).toEqual(corners(raster.m));
  }, 120_000);

  it('packs bevelled panels (a proxy) at >= 0.70 coverage; skyline stays near 0.50 (falsifier)', () => {
    const panels = () => {
      const m = model();
      for (let i = 0; i < 6; i++)
        m.box({ size: [0.6 + 0.1 * i, 0.4, 0.08], center: [i * 1.2, 0, 0] });
      m.bevel(sel.edges.dihedral('>', 30), { width: 0.012, segments: 3 });
      m.markSharp(sel.edges.dihedral('>', 25));
      expect(m.uv.auto({ resolution: 1024, padding: 4 }).status).toBe('ok');
      return m;
    };
    const sky = metrics(panels().uv.pack({ resolution: 1024, padding: 4 }));
    const m = panels();
    const raster = metrics(
      m.uv.pack({ resolution: 1024, padding: 4, method: 'raster', rotate: { step: 90 } }),
    );
    expect(sky.coverage).toBeLessThan(0.55);
    expect(raster.coverage).toBeGreaterThanOrEqual(0.7);
    expect(m.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
  }, 120_000);

  it('stacks congruent islands on one placement with identical UVs', () => {
    const m = model();
    m.box({ size: [0.2, 0.1, 0.05], label: 'part' });
    m.array(sel.createdBy('part'), { linear: { count: 5, offset: [0.5, 0, 0] }, label: 'copy' });
    m.markSharp(sel.edges.dihedral('>', 30));
    m.uv.unwrap({ seams: 'sharp' });
    const r = m.uv.pack({ resolution: 128, padding: 2, stack: true });
    const k = metrics(r);
    expect(k.islands).toBe(30);
    expect(k.stacked).toBe(24);
    const first = corners(m, sel.createdBy('part'));
    const copy = corners(m, sel.tag('copy:3'));
    expect(copy).toEqual(first);
  });

  it('packs several sessions into one atlas (with) and honors a density target', () => {
    const a = model();
    a.box({ size: [1, 1, 1] });
    a.markSharp(sel.edges.dihedral('>', 30));
    a.uv.unwrap({ seams: 'sharp' });
    const b = model();
    b.box({ size: [0.5, 2, 0.5] });
    b.markSharp(sel.edges.dihedral('>', 30));
    b.uv.unwrap({ seams: 'sharp' });
    const both = [a, b];
    for (const m of both)
      expect(m.uv.pack({ resolution: 256, padding: 4, with: both }).status).toBe('ok');
    const rects = (m: Model) => {
      const out: number[][] = [];
      const measured = measureUv(m.editMesh);
      if (!measured.ok) throw measured.error;
      const uv = corners(m);
      out.push([Math.min(...uv.map((p) => p[0])), Math.max(...uv.map((p) => p[0]))]);
      return { out, islands: measured.value.islands.length };
    };
    // One layout: the sessions' UV extents do not overlap and both islands sets are present.
    const ua = corners(a);
    const ub = corners(b);
    expect(rects(a).islands + rects(b).islands).toBe(12);
    const area = (uv: [number, number][]) => uv.length;
    expect(area(ua)).toBe(24);
    const merged = model();
    merged.append(a);
    merged.append(b);
    expect(merged.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain(
      'uv-overlap',
    );
    expect(ub.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1)).toBe(true);
    const d = model();
    d.box({ size: [1, 1, 1] });
    d.markSharp(sel.edges.dihedral('>', 30));
    d.uv.unwrap({ seams: 'sharp' });
    const target = metrics(d.uv.pack({ resolution: 512, padding: 4, density: { target: 100 } }));
    expect(target.texelsPerMeter).toBeCloseTo(100, 6);
    const big = model();
    big.box({ size: [1, 1, 1] });
    big.markSharp(sel.edges.dihedral('>', 30));
    big.uv.unwrap({ seams: 'sharp' });
    big.uv.pack({ resolution: 512, padding: 4, density: { target: 300, tolerance: 0.1 } });
    expect(big.poisoned?.code).toBe('model-precondition');
  });
});

describe('uv.unwrap rectify', () => {
  it('straightens a curved bevel ribbon into a rectangle; non-grids fall back to LSCM', () => {
    const m = model();
    // A quarter-annulus ribbon (a bevel strip bending around a corner) of 16 x 2 quads.
    const pts: [number, number, number][][] = [];
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * (Math.PI / 2);
      pts.push(
        [0, 1, 2].map((j) => [
          (1 + 0.02 * j) * Math.cos(a),
          (1 + 0.02 * j) * Math.sin(a),
          0,
        ]) as never,
      );
    }
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 2; j++) {
        const p = pts[i] as [number, number, number][];
        const q = pts[i + 1] as [number, number, number][];
        m.polygon({ points: [p[j] as never, q[j] as never, q[j + 1] as never, p[j + 1] as never] });
      }
    }
    m.weld({ distance: 1e-6 });
    const r = m.uv.unwrap({ method: 'rectify' });
    expect(r.status).toBe('ok');
    expect(warnings(r)).toEqual([]);
    const k = metrics(r);
    expect(k.rectified).toBe(1);
    const uv = corners(m);
    const us = uv.map((p) => p[0]);
    const vs = uv.map((p) => p[1]);
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    const island = measured.value.islands[0] as { areaUv: number };
    const rectangularity =
      island.areaUv / ((Math.max(...us) - Math.min(...us)) * (Math.max(...vs) - Math.min(...vs)));
    expect(rectangularity).toBeGreaterThan(0.999);
    const lscm = model();
    lscm.append(m);
    const curved = lscm.uv.unwrap({ method: 'lscm' });
    expect(curved.status).toBe('ok');
    const cu = corners(lscm);
    const cs = measureUv(lscm.editMesh);
    if (!cs.ok) throw cs.error;
    const fill =
      (cs.value.islands[0] as { areaUv: number }).areaUv /
      ((Math.max(...cu.map((p) => p[0])) - Math.min(...cu.map((p) => p[0]))) *
        (Math.max(...cu.map((p) => p[1])) - Math.min(...cu.map((p) => p[1]))));
    expect(fill).toBeLessThan(0.5);
    const hexagon = model();
    hexagon.polygon({
      points: Array.from(
        { length: 6 },
        (_, k) =>
          [Math.cos((k * Math.PI) / 3), Math.sin((k * Math.PI) / 3), 0] as [number, number, number],
      ),
    });
    const fallback = metrics(hexagon.uv.unwrap({ method: 'rectify' }));
    expect(fallback.rectifyFallbacks).toBe(1);
    expect(fallback.stretchL2).toBeCloseTo(1, 6);
  });

  it('uv.auto rectifies the quad-grid charts and falls back to LSCM elsewhere', () => {
    const m = model();
    m.cylinder({
      radiusTop: 0.3,
      radiusBottom: 0.3,
      height: 1,
      radialSegments: 24,
      heightSegments: 4,
    });
    m.markSharp(sel.edges.dihedral('>', 40));
    const r = m.uv.auto({ resolution: 256, padding: 2, method: 'rectify' });
    expect(r.status).toBe('ok');
    const info = r.diagnostics?.find((d) => d.severity === 'info' && /uv.auto/.test(d.message));
    const unwrap = (info?.detail as { unwrap: Metrics }).unwrap;
    expect(unwrap.rectified).toBeGreaterThan(0);
    expect(unwrap.rectifyFallbacks).toBeGreaterThan(0);
    expect(m.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
  });

  it('warns when a grid does not develop (falsifier: a domed patch)', () => {
    const m = model();
    m.plane({ width: 2, height: 2, widthSegments: 8, heightSegments: 8 });
    const mesh = m.editMesh;
    for (const v of mesh.vertices()) {
      const [x, y] = mesh.position(v) as [number, number, number];
      mesh.setPosition(v, x, y, 2 * Math.max(0, 1 - (x * x + y * y) / 2));
    }
    const r = m.uv.unwrap({ method: 'rectify' });
    expect(r.status).toBe('ok');
    expect(warnings(r).join()).toMatch(/do not develop as straight grids/);
  });
});

describe('validate texelDensity', () => {
  it('reports a 205-536 px/m spread and finds nothing on one density (falsifier)', () => {
    const m = model();
    m.plane({ width: 1, height: 1, center: [0, 0, 0] });
    m.plane({ width: 1, height: 1, center: [3, 0, 0] });
    m.uv.project({
      faces: sel.inBox([-1, -1, -1], [1, 1, 1], { by: 'centroid' }),
      mode: 'planar',
      axis: 'z',
      scale: 1024 / 205,
    });
    m.uv.project({
      faces: sel.inBox([2, -1, -1], [4, 1, 1], { by: 'centroid' }),
      mode: 'planar',
      axis: 'z',
      scale: 1024 / 536,
    });
    const report = m.validate({ texelDensity: { resolution: 1024, target: 320 } });
    const issue = report.issues.find((i) => i.code === 'texel-density');
    expect(issue?.detail.min).toBeCloseTo(205, 6);
    expect(issue?.detail.max).toBeCloseTo(536, 6);
    expect(issue?.detail.outside).toBe(2);
    const even = model();
    even.plane({ width: 1, height: 1 });
    even.uv.project({ mode: 'planar', axis: 'z', scale: 1024 / 320 });
    expect(
      even.validate({ texelDensity: { resolution: 1024, target: 320 } }).issues.map((i) => i.code),
    ).not.toContain('texel-density');
    const bare = model();
    bare.plane({ width: 1, height: 1 });
    expect(
      bare
        .validate({ texelDensity: { resolution: 1024, target: 320 } })
        .issues.find((i) => i.code === 'texel-density')?.detail.check,
    ).toBe('missing-channel');
  });
});
