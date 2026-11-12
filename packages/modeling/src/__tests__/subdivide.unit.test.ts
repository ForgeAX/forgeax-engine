import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { BackendOutput, ComputeBackend, ComputeJobKind } from '../compute/job';
import { subdividedFaceCount, tsSubdivideBackend } from '../compute/subdivide-ts';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import { meshVolume } from '../geom';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { bounds, expectContract, sharpEdges } from './contract';

/** Smooth quads of a curved limit surface are non-planar by nature; everything else must be clean. */
function expectCurvedContract(m: Model): void {
  const issues = m.validate().issues.filter((i) => i.severity !== 'info');
  expect(issues.filter((i) => i.code !== 'face-nonplanar')).toEqual([]);
  const decoded = decodeSnapshot(m.snapshot());
  if (!decoded.ok) throw decoded.error;
  expect(encodeSnapshot(decoded.value)).toEqual(m.snapshot());
  m.uv.project({ mode: 'box', scale: 1 });
  const out = m.toMesh({ normals: { mode: 'smooth' } });
  if (!out.ok) throw out.error;
  expect(out.value.report.triangles).toBe(m.editMesh.faceCount * 2);
}

function cube(sharp = false): Model {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'shell' });
  if (sharp) m.markSharp(sel.edges.all());
  return m;
}

function radii(m: Model): [number, number] {
  const mesh = m.editMesh;
  let lo = Infinity;
  let hi = 0;
  for (const v of mesh.vertices()) {
    const d = Math.hypot(...mesh.position(v));
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [lo, hi];
}

function info(report: ReturnType<Model['subdivide']>) {
  return report.diagnostics?.find((d) => d.severity === 'info')?.detail as {
    backend: string;
    quality: string;
    cacheKey: string;
    metrics: Record<string, number>;
  };
}

function warnings(report: ReturnType<Model['subdivide']>): string[] {
  return (report.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.message);
}

describe('subdivide (compute job, TS Catmull-Clark baseline)', () => {
  it('turns a cube into a rounded closed volume inside its cage', () => {
    const m = cube();
    const r = m.subdivide(undefined, { levels: 3 });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({ subdivided: 384 });
    expect(m.editMesh.faceCount).toBe(6 * 4 * 16);
    expect(m.editMesh.vertexCount).toBe(386);
    const [lo, hi] = radii(m);
    // Limit-surface sanity: well inside the cage corners (0.866) and above its inscribed sphere's half.
    expect(hi).toBeLessThan(0.45);
    expect(lo).toBeGreaterThan(0.4);
    for (const c of bounds(m.editMesh)) expect(Math.abs(c)).toBeLessThan(0.5);
    const volume = meshVolume(m.editMesh);
    expect(volume).toBeGreaterThan(0.3);
    expect(volume).toBeLessThan(0.36);
    const job = info(r);
    expect(job.backend).toBe('ts');
    expect(job.quality).toBe('baseline');
    expect(job.metrics.outputFaces).toBe(384);
    expect(warnings(r)).toEqual([]);
    expectCurvedContract(m);
  });

  it('keeps sharp edges as creases, splitting their intent into both halves', () => {
    const smooth = cube();
    smooth.subdivide(undefined, { levels: 2 });
    const creased = cube();
    creased.markSharp(sel.edges.parallel('y'));
    expect(sharpEdges(creased.editMesh)).toBe(4);
    creased.subdivide(undefined, { levels: 2 });
    expect(sharpEdges(creased.editMesh)).toBe(16);
    // The creased cage stays closer to its square cross-section, so it encloses more.
    expect(meshVolume(creased.editMesh)).toBeGreaterThan(meshVolume(smooth.editMesh) + 0.05);
    const [, hi] = radii(creased);
    expect(hi).toBeGreaterThan(radii(smooth)[1]);
    expectCurvedContract(creased);
  });

  it('falsifies the smoothing assertion: a fully creased cube equals a Simple subdivision', () => {
    const m = cube(true);
    const r = m.subdivide(undefined, { levels: 1 });
    expect(r.status).toBe('ok');
    expect(warnings(r).some((w) => w.includes('changed no volume'))).toBe(true);
    expect(meshVolume(m.editMesh)).toBeCloseTo(1, 12);
    const simple = cube();
    const s = simple.subdivide(undefined, { levels: 1, scheme: 'simple' });
    expect(warnings(s)).toEqual([]);
    expect(simple.snapshot()).toEqual(
      (() => {
        const copy = model();
        copy.append(m.snapshot());
        copy.markSharp(sel.edges.all(), false);
        return copy.snapshot();
      })(),
    );
  });

  it('propagates material, label, role and tags to child faces', () => {
    const m = cube();
    m.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged', label: 'pad' });
    m.assign(sel.createdBy('pad', 'inner'), 'glow');
    const r = m.subdivide(undefined, { levels: 2 });
    expect(r.status).toBe('ok');
    expect(m.count(sel.createdBy('pad', 'inner'))).toBe(16);
    expect(m.count(sel.createdBy('pad', 'rim'))).toBe(4 * 16);
    expect(m.count(sel.material('glow'))).toBe(16);
    expect(m.count(sel.tag('shell'))).toBe(m.editMesh.faceCount);
  });

  it('interpolates corner values linearly (a Simple split keeps a planar mapping exact)', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 1 });
    m.uv.project({ mode: 'box', scale: 1 });
    m.subdivide(undefined, { levels: 2, scheme: 'simple' });
    const mesh = m.editMesh;
    expect(mesh.faceCount).toBe(2 * 16);
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const p = mesh.position(mesh.hVert[h] as number);
        const uv = mesh.corner('uv0', h) as Float32Array;
        expect(uv[0]).toBeCloseTo(p[0], 6);
        expect(uv[1]).toBeCloseTo(p[1], 6);
      }
    }
    const cc = model();
    cc.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 2 });
    cc.uv.project({ mode: 'box', scale: 1 });
    cc.subdivide(undefined, { levels: 1 });
    const out = cc.toMesh();
    if (!out.ok) throw out.error;
    expect((out.value.mesh.attributes.uv as Float32Array).length).toBeGreaterThan(0);
  });

  it('applies the open-boundary rule: edgeAndCorner keeps single-face corners, edgeOnly rounds them', () => {
    const corner = (boundary: 'edgeOnly' | 'edgeAndCorner') => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 2 });
      m.subdivide(undefined, { levels: 1, boundary });
      const mesh = m.editMesh;
      const far = mesh
        .vertices()
        .map((v) => mesh.position(v))
        .reduce((a, b) => (b[0] + b[1] > a[0] + a[1] ? b : a));
      return [far[0], far[1]];
    };
    expect(corner('edgeAndCorner')).toEqual([0.5, 0.5]);
    const [x, y] = corner('edgeOnly') as [number, number];
    expect(x).toBeCloseTo(0.4375, 12);
    expect(y).toBeCloseTo(0.4375, 12);
  });

  it('subdivides a selection; pinned border vertices keep the neighbours planar', () => {
    const m = cube();
    const r = m.subdivide(sel.facing('+y'), { levels: 1 });
    expect(r.roles).toEqual({ subdivided: 4 });
    const mesh = m.editMesh;
    expect(mesh.faceCount).toBe(4 + 5);
    expect(m.count(sel.facing('-y'))).toBe(1);
    const sides = sel.facing('+x').or(sel.facing('-x')).or(sel.facing('+z')).or(sel.facing('-z'));
    expect(m.count(sides)).toBe(4);
    for (const f of sides.evaluate(mesh)) expect(mesh.fLen[f]).toBe(5);
    expect(meshVolume(mesh)).toBeCloseTo(1, 12);
    expectContract(m);
    // A selection with interior vertices smooths them while its border stays put.
    const grid = model();
    grid.box({ size: [1, 1, 1], segments: [3, 1, 3] });
    grid.subdivide(sel.facing('+y'), { levels: 1 });
    expect(bounds(grid.editMesh)[4]).toBeCloseTo(0.5, 12);
    const lowered = grid.editMesh
      .vertices()
      .filter((v) => {
        const p = grid.editMesh.position(v);
        return Math.abs(p[0]) < 0.1 && Math.abs(p[2]) < 0.1;
      })
      .map((v) => grid.editMesh.position(v)[1]);
    expect(Math.min(...lowered)).toBeCloseTo(0.5, 12);
    expectContract(grid);
  });

  it('rejects zero and fractional levels, budgets bound huge levels', () => {
    expect(cube().subdivide(undefined, { levels: 0 }).error?.code).toBe('model-invalid-argument');
    expect(cube().subdivide(undefined, { levels: 1.5 }).error?.code).toBe('model-invalid-argument');
    expect(cube().subdivide(undefined, { levels: 1, scheme: 'loop' as never }).error?.code).toBe(
      'model-invalid-argument',
    );
    const huge = cube().subdivide(undefined, { levels: 40 });
    expect(huge.error?.code).toBe('model-work-budget');
    const bounded = model({ budget: { faces: 100 } });
    bounded.box({ size: [1, 1, 1] });
    const r = bounded.subdivide(undefined, { levels: 3 });
    expect(r.error?.code).toBe('model-work-budget');
    expect(r.error?.detail?.predicted).toBeGreaterThan(100);
    const work = cube().subdivide(undefined, { levels: 4, budget: 1000 });
    expect(work.error?.code).toBe('model-work-budget');
    expect(work.error?.detail?.backend).toBe('ts');
    const semi = cube().subdivide(undefined, { levels: 1, creaseSharpness: 2 });
    expect(semi.status).toBe('ok');
    expect(warnings(semi).some((w) => w.includes('semi-sharp'))).toBe(false);
    expect(cube().subdivide(undefined, { levels: 1, creaseSharpness: -1 }).error?.code).toBe(
      'model-invalid-argument',
    );
    expect(subdividedFaceCount(6, 0, 3, Infinity)).toBe(96);
  });

  it("compute: 'native' without a native backend is model-capability-unavailable", () => {
    const r = cube().subdivide(undefined, { levels: 1, compute: 'native' });
    expect(r.error?.code).toBe('model-capability-unavailable');
    expect(cube().subdivide(undefined, { levels: 1, compute: 'ts' }).status).toBe('ok');
  });

  it('falsifies the contract assertion: a backend that does not refine is model-op-no-effect', () => {
    const lazy: ComputeBackend = {
      name: 'native',
      identity: 'fake-native@0',
      supports: (kind: ComputeJobKind) => kind === 'subdivide',
      quality: () => 'production',
      run: (request) =>
        ok({
          status: 'ok',
          outputs: [request.inputs[0] as Uint8Array],
          provenance: [{ face: Int32Array.from({ length: 6 }, (_, i) => i) }],
          metrics: {},
          locations: [],
        } as unknown as BackendOutput<never>),
    };
    const m = model({ native: lazy });
    m.box({ size: [1, 1, 1] });
    const r = m.subdivide(undefined, { levels: 1 });
    expect(r.error?.code).toBe('model-op-no-effect');
    expect(r.error?.detail?.backend).toBe('native');
  });

  it('falsifies the containment assertion: output outside the cage bounds warns', () => {
    const inflating: ComputeBackend = {
      name: 'native',
      identity: 'fake-native@0',
      supports: (kind: ComputeJobKind) => kind === 'subdivide',
      quality: () => 'production',
      run(request, work) {
        const out = tsSubdivideBackend.run(request, work);
        if (!out.ok) return out;
        const decoded = decodeSnapshot(out.value.outputs[0] as Uint8Array);
        if (!decoded.ok) return decoded;
        for (const v of decoded.value.vertices()) {
          const p = decoded.value.position(v);
          decoded.value.setPosition(v, p[0] * 3, p[1] * 3, p[2] * 3);
        }
        return ok({ ...out.value, outputs: [encodeSnapshot(decoded.value)] });
      },
    };
    const m = model({ native: inflating });
    m.box({ size: [1, 1, 1] });
    const r = m.subdivide(undefined, { levels: 1 });
    expect(r.status).toBe('ok');
    expect(warnings(r).some((w) => w.includes('leaves the bounds'))).toBe(true);
  });

  it('falsifies the fold assertion: a thin smooth rim against a crease folds and is reported', () => {
    const panel = (rim: number) => {
      const m = model();
      m.box({ size: [0.7, 0.08, 0.9], segments: [6, 1, 4], tag: 'plate' });
      m.inset(sel.facing('+y'), { thickness: rim, region: 'merged', label: 'panel' });
      m.extrude(sel.createdBy('panel', 'inner'), {
        distance: -0.01,
        region: 'merged',
        label: 'recess',
      });
      m.markSharp(sel.createdBy('recess').toEdges('touching'));
      return m;
    };
    const thin = panel(0.035);
    const r = thin.subdivide(undefined, { levels: 1 });
    expect(r.status).toBe('ok');
    expect(warnings(r).some((w) => w.includes('fold over themselves'))).toBe(true);
    thin.uv.project({ mode: 'box', scale: 1 });
    const out = thin.toMesh();
    expect(out.ok ? undefined : out.error.code).toBe('model-degenerate');
    const wide = panel(0.08);
    expect(warnings(wide.subdivide(undefined, { levels: 2 }))).toEqual([]);
    wide.uv.project({ mode: 'box', scale: 1 });
    expect(wide.toMesh().ok).toBe(true);
  });

  it('is deterministic: equal input gives equal bytes and cache keys', () => {
    const a = cube();
    const b = cube();
    const ra = a.subdivide(undefined, { levels: 2 });
    const rb = b.subdivide(undefined, { levels: 2 });
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(info(ra).cacheKey).toBe(info(rb).cacheKey);
    const c = cube();
    expect(info(c.subdivide(undefined, { levels: 1 })).cacheKey).not.toBe(info(ra).cacheKey);
  });

  it('subdivides n-gon caps of a cylinder into quads around a centre', () => {
    const m = model();
    m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 8 });
    const before = m.editMesh.faces().reduce((n, f) => n + (m.editMesh.fLen[f] as number), 0);
    m.subdivide(undefined, { levels: 1 });
    expect(m.editMesh.faceCount).toBe(before);
    expect(m.editMesh.faces().every((f) => m.editMesh.fLen[f] === 4)).toBe(true);
    expectContract(m);
  });
});
