import { describe, expect, it } from 'vitest';
import { runComputeJob } from '../compute/job';
import { tsUvBackend } from '../compute/uv-backend';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

type Metrics = Record<string, number>;

function jobInfo(report: OpReport): { metrics: Metrics; islands?: Metrics[] } {
  const info = report.diagnostics?.find((d) => d.severity === 'info');
  if (info === undefined)
    throw new Error(`${report.op} has no job diagnostic: ${report.error?.message}`);
  return info.detail as { metrics: Metrics; islands?: Metrics[] };
}

function warnings(report: OpReport): string[] {
  return (report.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.message);
}

function corners(m: Model, faces = sel.all()): [number, number][] {
  const mesh = m.editMesh;
  return faces
    .evaluate(mesh)
    .flatMap((f) =>
      mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) ?? []) as [number, number]),
    );
}

function tube(): Model {
  const m = model();
  m.cylinder({
    radiusTop: 1,
    radiusBottom: 1,
    height: 2,
    radialSegments: 16,
    heightSegments: 3,
    openEnded: true,
  });
  return m;
}

/** The vertical edges at angle 0 (x = 0, z = +1): shared by the faces either side of x = 0 in front. */
const frontLine = () =>
  sel
    .inBox([0, -9, 0], [9, 9, 9], { by: 'centroid' })
    .boundary()
    .and(sel.inBox([-9, -9, 0], [0, 9, 9], { by: 'centroid' }).boundary());

describe('uv.unwrap', () => {
  it('a planar region unwraps isometrically: stretch 1, area kept, no distortion', () => {
    const m = model();
    m.plane({ width: 4, height: 3, widthSegments: 4, heightSegments: 3 });
    const r = m.uv.unwrap();
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({ unwrapped: 12 });
    const { metrics, islands } = jobInfo(r);
    expect(metrics.islands).toBe(1);
    expect(metrics.stretchL2).toBeCloseTo(1, 9);
    expect(metrics.stretchLinf).toBeCloseTo(1, 9);
    expect(metrics.areaDistortion).toBeCloseTo(1, 9);
    expect(islands?.[0]?.areaUv).toBeCloseTo(12, 6);
    // Oriented to its minimal rectangle (wider than tall) at the origin, in meters.
    const uv = corners(m);
    const us = uv.map((p) => p[0]);
    const vs = uv.map((p) => p[1]);
    expect(Math.min(...us)).toBeCloseTo(0, 6);
    expect(Math.max(...us)).toBeCloseTo(4, 5);
    expect(Math.max(...vs)).toBeCloseTo(3, 5);
    expect(warnings(r)).toEqual([]);
  });

  it('a tube cut along one seam develops exactly; without the seam it folds (falsifier)', () => {
    const cut = tube();
    expect(cut.markSeam(frontLine()).roles).toEqual({ edges: 3 });
    const r = cut.uv.unwrap();
    const { metrics } = jobInfo(r);
    expect(metrics.islands).toBe(1);
    expect(metrics.stretchL2).toBeCloseTo(1, 6);
    expect(metrics.stretchLinf).toBeCloseTo(1, 6);
    expect(metrics.flipped).toBe(0);
    // The developed tube is the polygon perimeter wide and the height tall.
    const uv = corners(cut);
    const perimeter = 16 * 2 * Math.sin(Math.PI / 16);
    expect(Math.max(...uv.map((p) => p[0]))).toBeCloseTo(perimeter, 4);
    expect(Math.max(...uv.map((p) => p[1]))).toBeCloseTo(2, 4);
    // Seam corners differ on either side, so export splits exactly there.
    expect(cut.validate({ uniqueUv: true }).issues.filter((i) => i.code === 'uv-overlap')).toEqual(
      [],
    );
    const annulus = tube();
    const folded = annulus.uv.unwrap();
    expect(folded.status).toBe('ok');
    expect(jobInfo(folded).metrics.stretchL2).toBeGreaterThan(2);
    expect(warnings(folded).join()).toMatch(/inverted/);
  });

  it('an edge selector cuts like marked seams (same UVs)', () => {
    const marked = tube();
    marked.markSeam(frontLine());
    marked.uv.unwrap();
    const selected = tube();
    expect(selected.uv.unwrap({ seams: frontLine() }).status).toBe('ok');
    expect(corners(selected)).toEqual(corners(marked));
    expect(selected.count(sel.edges.seam())).toBe(0);
  });

  it('a cube with sharp seams gives 6 square islands; a 7-edge cut gives one cross net', () => {
    const cube = model();
    cube.box({ size: [1, 1, 1] });
    cube.markSharp(sel.edges.dihedral('>', 30));
    const six = cube.uv.unwrap({ seams: 'sharp' });
    expect(jobInfo(six).metrics.islands).toBe(6);
    expect(jobInfo(six).metrics.stretchL2).toBeCloseTo(1, 9);
    expect(cube.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
    const marked = model();
    marked.box({ size: [1, 1, 1] });
    marked.markSharp(sel.edges.dihedral('>', 30));
    expect(marked.uv.unwrap().status).toBe('failed');
    expect(marked.poisoned?.code).toBe('model-precondition');

    const net = model();
    net.box({ size: [1, 1, 1] });
    const top = sel.facing('+y').boundary();
    const front = sel.facing('+z').boundary();
    net.markSeam(sel.edges.parallel('y').or(top.minus(top.and(front))));
    expect(net.count(sel.edges.seam())).toBe(7);
    const one = net.uv.unwrap();
    const { metrics, islands } = jobInfo(one);
    expect(metrics.islands).toBe(1);
    expect(metrics.stretchLinf).toBeCloseTo(1, 9);
    expect(islands?.[0]?.areaUv).toBeCloseTo(6, 6);
    // A cross net spans 4 x 3 squares (oriented wider than tall).
    const uv = corners(net);
    expect(Math.max(...uv.map((p) => p[0]))).toBeCloseTo(4, 5);
    expect(Math.max(...uv.map((p) => p[1]))).toBeCloseTo(3, 5);
    expect(net.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
  });

  it('ExpMap flattens a small cap nearly isometrically and folds a whole sphere (warn falsifier)', () => {
    const cap = model();
    cap.sphere({ radius: 1, widthSegments: 32, heightSegments: 16 });
    const faces = sel.inBox([-2, 0.85, -2], [2, 2, 2], { by: 'all' });
    const e = cap.uv.unwrap({ method: 'expmap', faces });
    expect(e.status).toBe('ok');
    expect(jobInfo(e).metrics.stretchL2).toBeLessThan(1.001);
    expect(jobInfo(e).metrics.flipped).toBe(0);
    expect(warnings(e)).toEqual([]);
    const lscm = cap.uv.unwrap({ method: 'lscm', faces });
    expect(jobInfo(lscm).metrics.areaDistortion).toBeLessThan(1.05);
    const plane = model();
    plane.plane({ width: 2, height: 1, widthSegments: 4, heightSegments: 2 });
    expect(jobInfo(plane.uv.unwrap({ method: 'expmap' })).metrics.stretchLinf).toBeCloseTo(1, 9);
    const whole = model();
    whole.sphere({ radius: 1, widthSegments: 16, heightSegments: 8 });
    const folded = whole.uv.unwrap({ method: 'expmap' });
    expect(folded.status).toBe('ok');
    expect(jobInfo(folded).metrics.flipped).toBeGreaterThan(0);
    expect(warnings(folded).join()).toMatch(/inverted/);
  });

  it('closed islands, collapsed islands and bad options fail with structured errors', () => {
    const sphere = model();
    sphere.sphere({ radius: 1, widthSegments: 12, heightSegments: 6 });
    sphere.uv.unwrap();
    expect(sphere.poisoned?.code).toBe('model-precondition');
    expect(sphere.poisoned?.hint).toMatch(/markSeam/);

    const flat = model();
    flat.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 1 });
    for (const v of flat.editMesh.vertices()) {
      const p = flat.editMesh.position(v);
      flat.editMesh.setPosition(v, 0, p[1], 0);
    }
    flat.uv.unwrap();
    expect(flat.poisoned?.code).toBe('model-degenerate');

    for (const options of [
      { method: 'abf' as never },
      { pins: 'corner' as never },
      { seams: 'all' as never },
      { seams: sel.all() as never },
      { tolerance: 2 },
      { maxIterations: 0 },
    ]) {
      const m = model();
      m.plane({ width: 1, height: 1 });
      m.uv.unwrap(options);
      expect(m.poisoned?.code).toBe('model-invalid-argument');
    }
    const native = model({ compute: 'native' });
    native.plane({ width: 1, height: 1 });
    native.uv.unwrap();
    expect(native.poisoned?.code).toBe('model-capability-unavailable');
    const budget = tube();
    budget.markSeam(frontLine());
    budget.uv.unwrap({ budget: 1000 });
    expect(budget.poisoned?.code).toBe('model-work-budget');
    // The direct solve needs no iterations, so an iteration cap only binds the CGLS
    // fallback (an envelope beyond the limit or a singular normal matrix).
    const cap = tube();
    cap.markSeam(frontLine());
    const capped = cap.uv.unwrap({ maxIterations: 2 });
    expect(capped.status).toBe('ok');
    expect(jobInfo(capped).metrics.iterations).toBe(0);
  });

  it('unwraps only the selected faces and leaves other UVs alone', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.uv.project({ mode: 'box', scale: 1 });
    const before = corners(m, sel.facing('-y'));
    const r = m.uv.unwrap({ faces: sel.facing('+y').or(sel.facing('+x')) });
    expect(r.roles).toEqual({ unwrapped: 2 });
    expect(jobInfo(r).metrics.islands).toBe(1);
    expect(corners(m, sel.facing('-y'))).toEqual(before);
  });

  it('is deterministic: same source, same bytes and cache key', () => {
    const build = () => {
      const m = tube();
      m.markSeam(frontLine());
      const r = m.uv.unwrap();
      m.uv.pack({ resolution: 512, padding: 4 });
      return {
        snapshot: m.snapshot(),
        key: (jobInfo(r) as unknown as { cacheKey: string }).cacheKey,
      };
    };
    const a = build();
    const b = build();
    expect(a.snapshot).toEqual(b.snapshot);
    expect(a.key).toBe(b.key);
  });
});

describe('uv.pack', () => {
  function cubeIslands(): Model {
    const m = model();
    m.box({ size: [1, 2, 0.5] });
    m.markSharp(sel.edges.dihedral('>', 30));
    m.uv.unwrap({ seams: 'sharp' });
    return m;
  }

  /** Texel bounding boxes of the six face islands. */
  function boxes(m: Model, resolution: number) {
    const mesh = m.editMesh;
    return mesh.faces().map((f) => {
      const uv = mesh.faceHalves(f).map((h) => mesh.corner('uv0', h) as Float32Array);
      const us = uv.map((p) => (p[0] as number) * resolution);
      const vs = uv.map((p) => (p[1] as number) * resolution);
      return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)] as const;
    });
  }

  function minGap(m: Model, resolution: number): number {
    const b = boxes(m, resolution);
    let gap = Infinity;
    for (let i = 0; i < b.length; i++) {
      for (let j = i + 1; j < b.length; j++) {
        const [a0, a1, a2, a3] = b[i] as readonly number[];
        const [b0, b1, b2, b3] = b[j] as readonly number[];
        const dx = Math.max((b0 as number) - (a2 as number), (a0 as number) - (b2 as number));
        const dy = Math.max((b1 as number) - (a3 as number), (a1 as number) - (b3 as number));
        gap = Math.min(gap, Math.max(dx, dy));
      }
    }
    return gap;
  }

  it('fits every island into [0, 1] without overlap, padding kept, one texel density', () => {
    const m = cubeIslands();
    const r = m.uv.pack({ resolution: 256, padding: 6 });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({ packed: 6 });
    const { metrics } = jobInfo(r);
    expect(metrics.islands).toBe(6);
    expect(metrics.texelDensityDispersion).toBeLessThan(1e-6);
    expect(metrics.coverage).toBeGreaterThan(0.4);
    for (const [u, v] of corners(m)) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(m.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
    expect(minGap(m, 256)).toBeGreaterThanOrEqual(6 - 1e-3);
    const tight = cubeIslands();
    const dense = tight.uv.pack({ resolution: 256, padding: 0 });
    expect(jobInfo(dense).metrics.texelsPerUnit).toBeGreaterThan(metrics.texelsPerUnit as number);
    expect(minGap(tight, 256)).toBeLessThan(6);
  });

  it('box projection overlaps; packing its islands removes the overlap (falsifier)', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.uv.project({ mode: 'box', scale: 1 });
    expect(m.validate({ uniqueUv: true }).issues.map((i) => i.code)).toContain('uv-overlap');
    m.uv.pack({ resolution: 128, padding: 2 });
    expect(m.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
  });

  it('normalize gives one texel density; normalize: false keeps the relative scale (falsifier)', () => {
    const dispersion = (normalize: boolean) => {
      const m = model();
      m.plane({ width: 1, height: 1, tag: 'a' });
      m.plane({ width: 1, height: 1, center: [3, 0, 0], tag: 'b' });
      m.uv.project({ mode: 'planar', axis: 'z', scale: 1, faces: sel.tag('a') });
      m.uv.project({ mode: 'planar', axis: 'z', scale: 0.25, faces: sel.tag('b') });
      return jobInfo(m.uv.pack({ resolution: 128, padding: 2, normalize })).metrics
        .texelDensityDispersion as number;
    };
    expect(dispersion(true)).toBeLessThan(1e-6);
    expect(dispersion(false)).toBeGreaterThan(0.3);
  });

  it('turns tall islands when rotate is on and keeps them upright when off', () => {
    const strip = () => {
      const m = model();
      m.plane({ width: 0.2, height: 2, widthSegments: 1, heightSegments: 4 });
      m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
      return m;
    };
    const turned = strip();
    turned.uv.pack({ resolution: 128, padding: 2 });
    const upright = strip();
    upright.uv.pack({ resolution: 128, padding: 2, rotate: false });
    const width = (m: Model) =>
      Math.max(...corners(m).map((p) => p[0])) - Math.min(...corners(m).map((p) => p[0]));
    expect(width(turned)).toBeGreaterThan(0.9);
    expect(width(upright)).toBeLessThan(0.2);
  });

  it('missing UVs, bad magnitudes and an impossible atlas fail with structured errors', () => {
    const bare = model();
    bare.box({ size: [1, 1, 1] });
    bare.uv.pack({ resolution: 64, padding: 2 });
    expect(bare.poisoned?.code).toBe('model-precondition');
    expect(bare.poisoned?.hint).toMatch(/uv\.unwrap/);
    for (const options of [
      { resolution: 64.5, padding: 2 },
      { resolution: 8, padding: 1 },
      { resolution: 64, padding: -1 },
      { resolution: 64, padding: Number.NaN },
    ]) {
      const m = cubeIslands();
      m.uv.pack(options);
      expect(m.poisoned?.code).toBe('model-invalid-argument');
    }
    const crowded = model();
    for (let i = 0; i < 40; i++) crowded.plane({ width: 1, height: 1, center: [i * 2, 0, 0] });
    crowded.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    crowded.uv.pack({ resolution: 32, padding: 7 });
    expect(crowded.poisoned?.code).toBe('model-precondition');
  });

  it('runs as a compute job with placements and a native policy gate', () => {
    const m = cubeIslands();
    const request = {
      kind: 'uv.pack' as const,
      inputs: [m.snapshot()],
      params: { resolution: 128, padding: 2, rotate: true, normalize: true },
    };
    const r = runComputeJob(request, tsUvBackend);
    if (!r.ok) throw r.error;
    expect(r.value.provenance.placements.length).toBe(6);
    expect(r.value.provenance.faceIsland.length).toBe(6);
    expect(runComputeJob(request, tsUvBackend, { policy: 'native' }).ok).toBe(false);
  });
});
