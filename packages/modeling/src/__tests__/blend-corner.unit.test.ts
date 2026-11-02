import { describe, expect, it } from 'vitest';
import { resolveBlends, type SurfaceBlend, type SurfaceCorner } from '../blend';
import type { Tuple3 } from '../geom';
import { checkLayout } from '../layout';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';
import type { SurfacePatch } from '../surface';
import { checkSurfaceQuality, measureEdge } from '../surface-quality';

/** A bilinear patch through four corners: [u0v0, u0v1], [u1v0, u1v1]. */
function quad(a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [a, b],
      [c, d],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

// Box corner at the origin, solid in the positive octant, normals outward (consistently
// oriented, so every shared edge runs both ways once).
const L = 0.1;
const O: Tuple3 = [0, 0, 0];
const faces: SurfacePatch[] = [
  { name: 'x0', surface: quad(O, [0, L, 0], [0, 0, L], [0, L, L]) },
  { name: 'y0', surface: quad(O, [0, 0, L], [L, 0, 0], [L, 0, L]) },
  { name: 'z0', surface: quad(O, [L, 0, 0], [0, L, 0], [L, L, 0]) },
];
const r = 0.01;
const blends = (continuity: 'G1' | 'G2'): SurfaceBlend[] => [
  { between: ['x0', 'y0'], radius: r, continuity, name: 'knee' },
  { between: ['y0', 'z0'], radius: r, continuity, name: 'edge' },
  { between: ['z0', 'x0'], radius: r, continuity, name: 'tail' },
];
const corner = (continuity: 'G1' | 'G2', setback = 0.005): SurfaceCorner => ({
  blends: ['knee', 'edge', 'tail'],
  setback,
  continuity,
  name: 'tip',
});

const quadsOf = (patches: readonly SurfacePatch[]) =>
  patches.filter((p) => p.transition?.kind === 'corner').map((p) => p.surface);

describe('setback corner', () => {
  for (const continuity of ['G1', 'G2'] as const)
    it(`fills a box corner of three equal ${continuity} blends watertight`, {
      timeout: 60_000,
    }, () => {
      const resolved = resolveBlends(faces, blends(continuity), [corner(continuity)]);
      if (!resolved.ok) throw resolved.error;
      const report = resolved.value.reports[0] as {
        kink: number;
        residual: {
          sideAngle: number;
          spokeAngle: number;
          gap: number;
          normalSpread: number;
          sideCurvatureRatio: number;
        };
      };
      expect(report.residual.sideAngle).toBeLessThanOrEqual(0.1);
      // Relative to the blend curvature 1 / r: a G1 fill bends against the flat face strips,
      // a G2 fill does not (per sample, relative to the larger side, both read 1).
      if (continuity === 'G2') expect(report.residual.sideCurvatureRatio).toBeLessThan(0.01);
      else expect(report.residual.sideCurvatureRatio).toBeGreaterThan(0.1);
      expect(report.residual.spokeAngle).toBeLessThanOrEqual(0.1);
      expect(report.residual.normalSpread).toBeLessThan(90);
      // The quads share one normal at the center O (their (0, 0) corner).
      const centre = quadsOf(resolved.value.patches).map((q) => {
        const d = nurbs.surfaceDerivatives(q, 0, 0, 1);
        const a = (d[1] as Tuple3[])[0] as Tuple3;
        const b = (d[0] as Tuple3[])[1] as Tuple3;
        const n: Tuple3 = [
          a[1] * b[2] - a[2] * b[1],
          a[2] * b[0] - a[0] * b[2],
          a[0] * b[1] - a[1] * b[0],
        ];
        const l = Math.hypot(...n);
        return n.map((x) => x / l) as Tuple3;
      });
      for (const a of centre)
        for (const b of centre)
          expect(
            (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI,
          ).toBeLessThanOrEqual(0.1);
      expect(report.residual.gap).toBeLessThan(1e-6);
      expect(report.kink).toBeLessThan(0.01);
      expect(resolved.value.patches.map((p) => p.name)).toEqual([
        'x0',
        'y0',
        'z0',
        'knee',
        'edge',
        'tail',
        'tip-0',
        'tip-1',
        'tip-2',
      ]);
      // The faces stay whole: each trims its corner square and its two contact strips.
      for (const [k, face] of faces.entries()) {
        const out = resolved.value.patches[k] as SurfacePatch;
        expect(out.surface).toBe(face.surface);
        expect(out.trims).toHaveLength(3);
      }
      const m = model();
      const built = m.surface({
        patches: faces,
        blends: blends(continuity),
        corners: [corner(continuity)],
        chord: 0.0005,
      });
      expect(built.status).toBe('ok');
      const check = m.validate();
      for (const i of check.issues)
        if (i.code === 't-junction')
          console.log(
            'TJ',
            JSON.stringify(
              ((i.detail as { vertices?: number[] }).vertices ?? []).map((v: number) =>
                m.editMesh.position(v),
              ),
            ),
          );
      expect(check.issues.filter((i) => i.severity !== 'info').map((i) => i.code)).toEqual([]);
      expect(check.vertices - check.edges + check.faces).toBe(1);
      // Validated at G2: the spokes are held to G1 and pass; the corner's outer sides and the
      // blends are held to the continuity they declare, and reach it.
      const quality = m.validate({ surfaceQuality: { continuity: 'G2' } });
      const failed = quality.issues
        .filter(
          (i) =>
            i.code === 'surface-quality' &&
            (i.detail as { check?: string } | undefined)?.check === 'surface-continuity',
        )
        .map((i) => (i.detail as { subject: string }).subject);
      const spokes = failed.filter((s) => s.split('|').every((half) => half.startsWith('tip-')));
      const outer = failed.filter(
        (s) => s.split('|').filter((half) => half.startsWith('tip-')).length === 1,
      );
      expect(spokes).toEqual([]);
      expect(outer).toEqual([]);
      expect(failed).toEqual([]);
      expect(m.finish({ key: 'corner' }).ok).toBe(true);
      // Falsifier: without its corner square a face overlaps the fill quads.
      const open = resolved.value.patches.map((p, k) =>
        k === 0 ? { ...p, trims: (p.trims ?? []).slice(1) } : p,
      );
      const overlap = model();
      overlap.surface({ patches: open, chord: 0.0005 });
      const broken =
        overlap.poisoned !== undefined ||
        overlap.validate().issues.some((i) => i.severity !== 'info');
      expect(broken).toBe(true);
    });

  it('requires G1, not G2, on the spokes, and still fails a broken spoke', () => {
    const resolved = resolveBlends(faces, blends('G2'), [corner('G2')]);
    if (!resolved.ok) throw resolved.error;
    const named = resolved.value.patches.map((p) => ({
      name: p.name ?? 'surface',
      surface: p.surface,
      ...(p.transition === undefined ? {} : { transition: p.transition }),
    }));
    const quads = named.filter((p) => p.transition?.kind === 'corner');
    const clean = checkSurfaceQuality({ surfaces: quads }, { continuity: 'G2' });
    if (!clean.ok) throw clean.error;
    const spokes = clean.value.edges;
    expect(spokes.length).toBe(3);
    expect(spokes.every((e) => e.required === 'G1' && e.pass)).toBe(true);
    // Without the corner role the same spokes are held to what their transition declares.
    const plain = checkSurfaceQuality(
      {
        surfaces: quads.map(({ name, surface }) => ({
          name,
          surface,
          transition: { kind: 'blend' as const, continuity: 'G2' as const },
        })),
      },
      { continuity: 'G1' },
    );
    if (!plain.ok) throw plain.error;
    expect(plain.value.edges.every((e) => e.required === 'G2')).toBe(true);
    // Lift the control row beside spoke 0 (u0 of quad 0): a real G1 break still fails.
    const first = quads[0] as {
      name: string;
      surface: NurbsSurface;
      transition: { kind: 'corner'; continuity: 'G1' | 'G2' };
    };
    const lifted: NurbsSurface = {
      ...first.surface,
      points: first.surface.points.map((row, i) =>
        i === 1
          ? row.map((p, j): Tuple3 => (j === 0 ? p : [p[0] + 0.002, p[1] + 0.002, p[2] + 0.002]))
          : row,
      ),
    };
    const broken = checkSurfaceQuality(
      { surfaces: [{ ...first, surface: lifted }, ...quads.slice(1)] },
      { continuity: 'G2' },
    );
    if (!broken.ok) throw broken.error;
    const failed = broken.value.issues.filter((i) => i.code === 'surface-continuity');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((i) => (i.detail as { required: string }).required === 'G1')).toBe(true);
    const spoke = measureEdge(
      lifted,
      'u0',
      quadsOf(resolved.value.patches)[1] as NurbsSurface,
      'v0',
    );
    if (!spoke.ok) throw spoke.error;
    expect(spoke.value.angle).toBeGreaterThan(1);
  });

  it('holds the face isoparms orthogonal to the blended edges within 1 degree', {
    timeout: 60_000,
  }, () => {
    // Skew the frame: each face keeps its corner at O, but one isoparm per edge tilts by
    // `deg` off the edge's normal plane (the blend end then kinks by about twice that).
    const skewed = (deg: number): SurfacePatch[] => {
      const a = (deg * Math.PI) / 180;
      const ex: Tuple3 = [L, 0, 0];
      const ey: Tuple3 = [L * Math.sin(a), L * Math.cos(a), 0];
      const ez: Tuple3 = [0, L * Math.sin(a), L * Math.cos(a)];
      const plus = (p: Tuple3, q: Tuple3): Tuple3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
      const face = (u: Tuple3, v: Tuple3) => quad(O, u, v, plus(u, v));
      return [
        { name: 'x0', surface: face(ey, ez) },
        { name: 'y0', surface: face(ez, ex) },
        { name: 'z0', surface: face(ex, ey) },
      ];
    };
    const near = resolveBlends(skewed(0.5), blends('G1'), [corner('G1')]);
    if (!near.ok) throw near.error;
    const report = near.value.reports[0] as { kink: number; residual: { sideAngle: number } };
    expect(report.kink).toBeGreaterThan(0.5);
    expect(report.residual.sideAngle).toBeLessThanOrEqual(0.1);
    const off = resolveBlends(skewed(1.5), blends('G1'), [corner('G1')]);
    expect(off.ok).toBe(false);
    if (!off.ok) {
      expect(off.error.code).toBe('model-precondition');
      expect(off.error.detail?.tilt as number).toBeCloseTo(1.5, 1);
    }
  });

  it('rejects a zero setback and a corner that does not fit the faces', () => {
    const zero = resolveBlends(faces, blends('G1'), [corner('G1', 0)]);
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.error.code).toBe('model-invalid-argument');
      expect(zero.error.hint).toContain('setback > 0');
    }
    const huge = resolveBlends(faces, blends('G1'), [corner('G1', 0.095)]);
    expect(huge.ok).toBe(false);
    if (!huge.ok) {
      expect(huge.error.code).toBe('model-precondition');
      expect(huge.error.detail).toMatchObject({ face: 'x0', radius: r, setback: 0.095, width: L });
    }
    const apart = resolveBlends(faces, blends('G1'), [
      { blends: ['knee', 'edge'], setback: 0.005 },
    ]);
    expect(!apart.ok && apart.error.code).toBe('model-invalid-argument');
    const away = resolveBlends(
      [...faces, { name: 'w', surface: quad([1, 0, 0], [1, 1, 0], [2, 0, 0], [2, 1, 0]) }],
      [...blends('G1').slice(0, 2), { between: ['z0', 'w'], radius: r, name: 'tail' }],
      [corner('G1')],
    );
    expect(!away.ok && away.error.code).toBe('model-precondition');
  });

  it('checks the corner spokes of a patch layout at G1', { timeout: 60_000 }, () => {
    const m = model();
    m.patchLayout({
      name: 'box',
      patches: faces.map((f) => ({ id: f.name as string, role: 'primary', surface: f.surface })),
      blends: blends('G2'),
      corners: [corner('G2')],
    });
    expect(m.surface({ layout: 'box', patches: [], chord: 0.0005 }).status).toBe('ok');
    const layout = m.validate({ layout: true });
    expect(layout.issues.filter((i) => i.code === 'patch-layout')).toEqual([]);
    // Falsifier: a lifted row beside spoke 0 fails the layout's G1 spoke check.
    const resolved = resolveBlends(faces, blends('G2'), [corner('G2')]);
    if (!resolved.ok) throw resolved.error;
    const quads = quadsOf(resolved.value.patches);
    const q0 = quads[0] as NurbsSurface;
    const lifted: NurbsSurface = {
      ...q0,
      points: q0.points.map((row, i) =>
        i === 1
          ? row.map((p, j): Tuple3 => (j === 0 ? p : [p[0] + 0.002, p[1] + 0.002, p[2] + 0.002]))
          : row,
      ),
    };
    const state = (list: readonly NurbsSurface[]) => ({
      built: new Map<string, NurbsSurface>(),
      corners: new Map([['tip', list]]),
    });
    const box = { name: 'box', spec: { patches: [] }, edges: [] };
    expect(checkLayout(box, [], {}, state(quads))).toEqual([]);
    const bad = checkLayout(box, [], {}, state([lifted, ...quads.slice(1)]));
    expect(bad.map((i) => (i.detail as { required: string }).required)).toContain('G1');
  });
});
