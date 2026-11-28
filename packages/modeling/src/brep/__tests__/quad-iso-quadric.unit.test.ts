import { describe, expect, it } from 'vitest';
import {
  holeBoundaryMetrics,
  quadShapeReport,
  valenceReport,
} from '../../../examples/qf-curved-baseline/metrics';
import {
  CURVED_CASES,
  coneBore,
  STRIP_LIMIT_CASES,
  sphereBore,
  torusBore,
} from '../../../examples/qf-curved-baseline/shapes';
import { faceLoops } from '../faces';
import { quadrangulate } from '../quad';

const SIZE = 0.25;

const axis = (tilt: number): [number, number, number] => [Math.sin(tilt), 0, Math.cos(tilt)];

function shapeOf(name: string) {
  const c = CURVED_CASES.find((x) => x.name === name);
  const built = c?.build();
  if (built === undefined || !built.ok) throw new Error(`${name} did not build`);
  return built.value;
}

describe('the summary numbers', () => {
  it('quadShapeReport reproduces the cylinder-pocket twist and aspect of the quality PR', () => {
    const r = quadrangulate(shapeOf('cylinder-pocket'), {
      size: SIZE,
      trimmed: 'blossom-row',
      isoQuadric: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = quadShapeReport(r.value);
    expect(q.twistMaxDeg).toBeGreaterThan(18);
    expect(q.twistMaxDeg).toBeLessThan(19);
    expect(q.aspectMax).toBeGreaterThan(3.5);
    expect(q.aspectMax).toBeLessThan(3.7);
  });

  it('every strip-limit input is refused with iso-strip-distorted', () => {
    for (const c of STRIP_LIMIT_CASES) {
      const built = c.build();
      if (!built.ok) throw new Error(`${c.name} did not build`);
      const r = quadrangulate(built.value, {
        size: SIZE,
        trimmed: 'blossom-row',
        isoQuadric: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r.error.detail as { reason?: string }).reason).toBe('iso-strip-distorted');
    }
  });
});

describe('isoQuadric layout of holed cylinder faces', () => {
  for (const name of ['cylinder-pocket', 'pipe-tee']) {
    describe(name, () => {
      const shape = shapeOf(name);
      const r = quadrangulate(shape, { size: SIZE, trimmed: 'quad-dominant', isoQuadric: true });

      it('is a conforming closed mesh with a usable scaled Jacobian', () => {
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.report.openEdges).toBe(0);
        expect(r.value.report.nonManifoldEdges).toBe(0);
        expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
        expect(r.value.faceQuality.reduce((n, q) => n + q.foldedPairs, 0)).toBe(0);
      });

      it('holds every hole-boundary face to an orthogonal quad row', () => {
        if (!r.ok) throw new Error('layout failed');
        const m = holeBoundaryMetrics(shape, r.value);
        expect(m.boundaryEdges).toBeGreaterThan(0);
        expect(m.coverage).toBe(1);
        expect(m.rowOnly).toBeGreaterThanOrEqual(0.9);
        expect(m.allBoundary).toBeGreaterThanOrEqual(0.9);
      });

      it('metric falsifier: pulling a boundary vertex off its row drops orthogonality', () => {
        if (!r.ok) throw new Error('layout failed');
        const before = holeBoundaryMetrics(shape, r.value);
        const mesh = r.value.mesh.clone();
        const holed = shape.faces
          .map((_, f) => f)
          .filter((f) => faceLoops(shape, f).holes.length > 0);
        const faceVerts = (f: number): Set<number> => {
          const [lo, hi] = r.value.faceRanges[f] as readonly [number, number];
          const out = new Set<number>();
          for (let m = lo; m < hi; m++) for (const v of mesh.faceVertices(m)) out.add(v);
          return out;
        };
        const holedFace = holed[0] as number;
        const shared = new Set<number>();
        shape.faces.forEach((_, f) => {
          if (f === holedFace) return;
          for (const v of faceVerts(f)) shared.add(v);
        });
        // Shear the interior vertices next to the hole rows; the hole loop itself stays put.
        const ring = [...faceVerts(holedFace)].filter((v) => shared.has(v));
        const [x, y, z] = mesh.position(ring[0] as number);
        for (const w of faceVerts(holedFace)) {
          if (shared.has(w)) continue;
          const [px, py, pz] = mesh.position(w);
          if ((px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z) < 0.49)
            mesh.setPosition(w, px, py + 0.08 * px, pz);
        }
        const sheared = { ...r.value, mesh };
        const after = holeBoundaryMetrics(shape, sheared);
        expect(after.rowOnly).toBeLessThan(before.rowOnly);
      });

      it('without the opt-in the default behaviour is unchanged (fails closed)', () => {
        const d = quadrangulate(shape, { size: SIZE, trimmed: 'quad-dominant' });
        expect(d.ok).toBe(false);
        if (d.ok) return;
        expect((d.error.detail as { reason?: string }).reason).toBe('trimmed-loop');
      });
    });
  }

  describe('torus-bore (metric-scaled layout)', () => {
    const shape = shapeOf('torus-bore');
    const r = quadrangulate(shape, { size: SIZE, trimmed: 'blossom-row', isoQuadric: true });

    it('is strictly all-quad and closed with a usable scaled Jacobian', () => {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.report.triangles).toBe(0);
      expect(r.value.report.openEdges).toBe(0);
      expect(r.value.report.nonManifoldEdges).toBe(0);
      expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.5);
    });

    it('rows both bores orthogonally and keeps only block-corner singularities', () => {
      if (!r.ok) throw new Error('layout failed');
      const m = holeBoundaryMetrics(shape, r.value);
      expect(m.coverage).toBe(1);
      expect(m.rowOnly).toBe(1);
      const v = valenceReport(r.value);
      expect(Object.keys(v.histogram).sort()).toEqual(['4', '5']);
      expect(v.singularities).toBe(8);
    });
  });

  describe('holes whose strip cannot reach the quality floor fail closed', () => {
    const reasonOf = (built: ReturnType<typeof torusBore>): string | undefined => {
      if (!built.ok) throw new Error('shape did not build');
      const r = quadrangulate(built.value, {
        size: SIZE,
        trimmed: 'blossom-row',
        isoQuadric: true,
      });
      expect(r.ok).toBe(false);
      return r.ok ? undefined : (r.error.detail as { reason?: string }).reason;
    };

    it('torus bore far off the tube crest (metric differs from R) names the distorted strip', () => {
      expect(reasonOf(torusBore(-0.5))).toBe('iso-strip-distorted');
    });

    it('cone bore close to the apex names the distorted strip', () => {
      expect(reasonOf(coneBore(0.3, 2))).toBe('iso-strip-distorted');
    });

    it('a torus bore half way to the crest still lays out all-quad', () => {
      const built = torusBore(-0.25);
      if (!built.ok) throw new Error('torus bore did not build');
      const r = quadrangulate(built.value, {
        size: SIZE,
        trimmed: 'blossom-row',
        isoQuadric: true,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.report.triangles).toBe(0);
      expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
      expect(holeBoundaryMetrics(built.value, r.value).rowOnly).toBe(1);
    });
  });

  describe.each([
    ['sphere-bore (bore on the equator)', 0],
    ['sphere-bore with the polar axis tilted 40 degrees', 0.7],
  ])('%s (latitude-longitude layout with pole triangles)', (_label, tilt) => {
    const built = sphereBore(tilt);
    if (!built.ok) throw new Error('sphere bore did not build');
    const shape = built.value;
    const r = quadrangulate(shape, { size: SIZE, trimmed: 'blossom-row', isoQuadric: true });

    it('is closed and every triangle is a pole triangle', () => {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { mesh, report } = r.value;
      expect(report.openEdges).toBe(0);
      expect(report.nonManifoldEdges).toBe(0);
      expect(report.triangles).toBeGreaterThan(0);
      expect(report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
      const pole = axis(tilt);
      let atPole = 0;
      for (let f = 0; f < mesh.faceCount; f++) {
        const vs = mesh.faceVertices(f);
        if (vs.length !== 3) continue;
        const hits = vs.filter((v) => {
          const p = mesh.position(v);
          return Math.abs(Math.abs(p[0] * pole[0] + p[2] * pole[2]) - 1) < 1e-9;
        });
        expect(hits.length).toBe(1);
        atPole++;
      }
      expect(atPole).toBe(report.triangles);
    });

    it('rows both bores orthogonally; the only irregular points are block corners and the two poles', () => {
      if (!r.ok) throw new Error('layout failed');
      const m = holeBoundaryMetrics(shape, r.value);
      expect(m.coverage).toBe(1);
      expect(m.rowOnly).toBe(1);
      const v = valenceReport(r.value);
      const fan = r.value.report.triangles / 2;
      expect(v.histogram[String(fan)]).toBe(2);
      expect(v.singularities).toBe(10);
      expect(Object.keys(v.histogram).sort()).toEqual(['4', '5', String(fan)].sort());
    });
  });

  describe('cone bore (log-chart annulus, apex fan)', () => {
    const built = coneBore();
    if (!built.ok) throw new Error('cone bore did not build');
    const shape = built.value;
    const r = quadrangulate(shape, { size: SIZE, trimmed: 'blossom-row', isoQuadric: true });

    it('is closed and every triangle is a fan triangle at the apex', () => {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { mesh, report } = r.value;
      expect(report.openEdges).toBe(0);
      expect(report.nonManifoldEdges).toBe(0);
      expect(report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
      expect(report.triangles).toBeGreaterThan(0);
      let atApex = 0;
      for (let f = 0; f < mesh.faceCount; f++) {
        const vs = mesh.faceVertices(f);
        if (vs.length !== 3) continue;
        const hits = vs.filter((v) => {
          const p = mesh.position(v);
          return Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9 && Math.abs(p[2] - 3) < 1e-9;
        });
        expect(hits.length).toBe(1);
        atApex++;
      }
      expect(atApex).toBe(report.triangles);
    });

    it('rows both bores orthogonally; the irregular points are block corners and the apex', () => {
      if (!r.ok) throw new Error('layout failed');
      const m = holeBoundaryMetrics(shape, r.value);
      expect(m.coverage).toBe(1);
      expect(m.rowOnly).toBe(1);
      const v = valenceReport(r.value);
      expect(v.histogram[String(r.value.report.triangles)]).toBe(1);
      expect(v.histogram['5']).toBe(8);
    });
  });

  describe('wide cone bore, where the radius changes across the hole', () => {
    const built = coneBore(0.5, 1);
    if (!built.ok) throw new Error('cone bore did not build');
    const r = quadrangulate(built.value, { size: SIZE, trimmed: 'blossom-row', isoQuadric: true });

    it('keeps the boundary rows orthogonal (needs the log chart; a plain scaled chart gives 0.59)', () => {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.report.openEdges).toBe(0);
      expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.4);
      const m = holeBoundaryMetrics(built.value, r.value);
      expect(m.coverage).toBe(1);
      expect(m.rowOnly).toBe(1);
    });
  });

  for (const name of ['cylinder-pocket', 'pipe-tee']) {
    describe(`${name} strict blossom-row`, () => {
      const shape = shapeOf(name);
      const r = quadrangulate(shape, { size: SIZE, trimmed: 'blossom-row', isoQuadric: true });

      it('is strictly all-quad and closed', () => {
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.report.triangles).toBe(0);
        expect(r.value.report.openEdges).toBe(0);
        expect(r.value.report.nonManifoldEdges).toBe(0);
        expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
      });

      it('has every hole-boundary face in an orthogonal row', () => {
        if (!r.ok) throw new Error('layout failed');
        const m = holeBoundaryMetrics(shape, r.value);
        expect(m.coverage).toBe(1);
        expect(m.rowOnly).toBe(1);
        expect(m.allBoundary).toBe(1);
      });

      it('keeps the singularities to the cap centres, hole patches and block corners', () => {
        if (!r.ok) throw new Error('layout failed');
        const v = valenceReport(r.value);
        expect(Object.keys(v.histogram).sort()).toEqual(['3', '4', '5']);
        expect(v.singularities).toBeLessThanOrEqual(16);
      });
    });
  }
});
