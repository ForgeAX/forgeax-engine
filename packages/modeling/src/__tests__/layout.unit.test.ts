import { describe, expect, it } from 'vitest';
import { resolveBlends } from '../blend';
import type { Tuple3 } from '../geom';
import {
  buildLayout,
  checkLayout,
  type LayoutPatch,
  layoutPatches,
  type PatchLayoutSpec,
  resolveLayout,
} from '../layout';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';
import { isoparm, measureEdge } from '../surface-quality';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

/** A single-span quintic patch over [x0, x1] x [y0, y1] through z = f(x, y). */
function patch(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  f: (x: number, y: number) => number,
): NurbsSurface {
  const rows = Array.from({ length: 12 }, (_, i) =>
    Array.from({ length: 12 }, (_, j): Tuple3 => {
      const x = x0 + ((x1 - x0) * i) / 11;
      const y = y0 + ((y1 - y0) * j) / 11;
      return [x, y, f(x, y)];
    }),
  );
  return unwrap(nurbs.fitSurface(rows, { degree: [5, 5], net: [6, 6] })).surface;
}

const roof = (x: number, y: number) => 0.1 * Math.sin(1.2 * x) + 0.05 * y * y;
const side = (x: number, y: number) => 0.13 + 0.06 * Math.cos(1.5 * x) - 0.02 * y;

/** Left half of a body plan, entered as a plan (u along the car, v down the section). */
const TABLE_A: PatchLayoutSpec = {
  name: 'mech-gt-body',
  featureLines: [
    'T-face',
    'T-crown',
    'T-knee',
    'T-waist',
    'T-sill',
    'T-shoulder',
    'T-tail',
    'T-flare',
    'roof-rear',
  ],
  patches: [
    {
      id: 'P01',
      role: 'primary',
      panel: 'hood',
      degree: [5, 5],
      net: [6, 6],
      sides: {
        u0: { feature: 'T-face' },
        v1: { feature: 'T-crown' },
        u1: { free: true },
        v0: { mirror: 'z' },
      },
    },
    {
      id: 'P02',
      role: 'primary',
      panel: 'front-fender',
      degree: [6, 5],
      net: [7, 6],
      sides: {
        v0: { feature: 'T-crown' },
        v1: { feature: 'T-knee' },
        u0: { feature: 'T-face' },
        u1: { to: ['P04:u0', 'P10:u0', 'S02:u0'], continuity: 'G2' },
      },
    },
    {
      id: 'P04',
      role: 'primary',
      panel: 'door',
      degree: [6, 3],
      net: [7, 4],
      sides: { v0: { feature: 'T-waist' }, v1: { feature: 'T-knee' }, u1: { feature: 'T-flare' } },
    },
    {
      id: 'P10',
      role: 'primary',
      panel: 'door',
      degree: [6, 3],
      net: [7, 4],
      sides: { v1: { feature: 'T-knee' }, v0: { free: true }, u1: { free: true } },
    },
    {
      id: 'P05',
      role: 'primary',
      panel: 'rear-fender',
      degree: [6, 5],
      net: [7, 6],
      sides: {
        u0: { feature: 'T-flare' },
        v0: { feature: 'T-knee' },
        u1: { feature: 'T-tail' },
        v1: { free: true },
      },
    },
    {
      id: 'P11',
      role: 'primary',
      panel: 'rear-fender',
      degree: [6, 3],
      net: [7, 4],
      sides: {
        v0: { feature: 'T-knee' },
        v1: { feature: 'T-shoulder' },
        u0: { feature: 'T-flare' },
        u1: { free: true },
      },
    },
    {
      id: 'P06',
      role: 'primary',
      panel: 'roof',
      degree: [5, 5],
      net: [6, 6],
      sides: {
        v0: { mirror: 'z' },
        u1: { feature: 'roof-rear' },
        u0: { free: true },
        v1: { free: true },
      },
    },
    {
      id: 'P07',
      role: 'primary',
      panel: 'engine-cover',
      degree: [5, 5],
      net: [6, 6],
      sides: {
        v0: { mirror: 'z' },
        u0: { feature: 'roof-rear' },
        v1: { feature: 'T-shoulder' },
        u1: { free: true },
      },
    },
    {
      id: 'P08',
      role: 'primary',
      panel: 'front-bumper',
      degree: [4, 4],
      net: [5, 5],
      sides: { u1: { feature: 'T-face' } },
    },
    {
      id: 'P09',
      role: 'primary',
      panel: 'rear-diffuser',
      degree: [4, 4],
      net: [5, 5],
      sides: { u0: { feature: 'T-tail' } },
    },
    {
      id: 'S01',
      role: 'secondary',
      panel: 'door',
      degree: [5, 2],
      net: [6, 3],
      sides: { v0: { feature: 'T-sill' }, v1: { free: true } },
    },
    {
      id: 'S02',
      role: 'secondary',
      panel: 'door',
      degree: [5, 3],
      net: [6, 4],
      sides: { v0: { feature: 'T-waist' }, v1: { feature: 'T-sill' } },
      inflections: { v: 1 },
    },
    {
      id: 'S03',
      role: 'secondary',
      panel: 'roof',
      degree: [4, 3],
      net: [5, 4],
      sides: { u0: { to: 'P06:v1', continuity: 'G2' }, v1: { to: 'P10:v0', continuity: 'G2' } },
    },
    { id: 'S04', role: 'secondary', panel: 'side-intake', degree: [3, 3], net: [4, 4] },
    ...(['T-crown', 'T-knee', 'T-waist', 'T-sill', 'T-shoulder', 'T-face', 'T-tail'] as const).map(
      (t): LayoutPatch => ({ id: `${t}-blend`, role: 'transition', degree: [5, 5], net: [8, 6] }),
    ),
    { id: 'C1', role: 'corner' },
    { id: 'C2', role: 'corner' },
    { id: 'C3', role: 'corner' },
    { id: 'G01', role: 'glass', panel: 'windshield', degree: [4, 4], net: [5, 5] },
    { id: 'G02', role: 'glass', panel: 'door', degree: [4, 3], net: [5, 4] },
  ],
};

describe('patch layout', () => {
  it('enters a left-half plan table directly and checks its plan', () => {
    const m = model();
    m.patchLayout(TABLE_A);
    expect(m.poisoned).toBeUndefined();
    const findings = m.validate({ layout: true }).issues.filter((i) => i.code === 'patch-layout');
    // The plan check finds what table A leaves inconsistent: P02's G2 side is quintic along
    // the edge while P04 / P10 / S02 are planned cubic there ("same degree" matching), S03
    // likewise against P06 and P10, and P10's 4 rows cannot hold a G2 side plus a fillet side.
    expect(findings.map((f) => `${f.detail.check}@${f.detail.subject}`)).toEqual([
      'layout-rows@P10',
      'layout-degree@P02:u1|P04:u0',
      'layout-degree@P02:u1|P10:u0',
      'layout-degree@P02:u1|S02:u0',
      'layout-degree@S03:u0|P06:v1',
      'layout-degree@S03:v1|P10:v0',
      'layout-unbuilt@mech-gt-body',
    ]);
    // Raising the cross-section of the matched patches to the master's degree clears them.
    const fixed: PatchLayoutSpec = {
      ...TABLE_A,
      name: 'fixed',
      patches: TABLE_A.patches.map((p) =>
        ['P04', 'P10', 'S02'].includes(p.id)
          ? { ...p, degree: [6, 5], net: [7, 6] }
          : p.id === 'S03'
            ? { ...p, degree: [6, 5], net: [7, 6] }
            : p,
      ),
    };
    const again = model();
    again.patchLayout(fixed);
    expect(
      again
        .validate({ layout: true })
        .issues.filter((i) => i.code === 'patch-layout')
        .map((i) => i.detail.check),
    ).toEqual(['layout-unbuilt']);
  });

  it('rejects structural errors: unknown refs, a side declared twice, an unlisted feature', () => {
    const base = {
      patches: [
        { id: 'a', role: 'primary' as const },
        { id: 'b', role: 'primary' as const },
      ],
    };
    const cases: PatchLayoutSpec[] = [
      {
        ...base,
        patches: [
          { ...base.patches[0], sides: { u1: { to: 'c:u0', continuity: 'G2' } } } as LayoutPatch,
          base.patches[1] as LayoutPatch,
        ],
      },
      {
        patches: [
          { id: 'a', role: 'primary', sides: { u1: { to: 'b:u0', continuity: 'G2' } } },
          { id: 'b', role: 'primary', sides: { u0: { to: 'a:u1', continuity: 'G2' } } },
        ],
      },
      { patches: [{ id: 'a', role: 'primary', sides: { u0: { feature: 'shoulder' } } }] },
      { patches: [{ id: 'a', role: 'hero' as never }] },
    ];
    for (const spec of cases) {
      const r = resolveLayout(spec);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
    }
  });

  it('builds patches in role order and matches every shared side to the surface-quality tolerances', () => {
    const m = model();
    m.patchLayout({
      patches: [
        // The secondary is declared first; the primary still builds first and is the master.
        {
          id: 'S',
          role: 'secondary',
          surface: patch(1.02, 2, 0, 1, side),
          sides: { u0: { to: 'P:u1', continuity: 'G2' } },
        },
        { id: 'P', role: 'primary', surface: patch(0, 1, 0, 1, roof) },
      ],
    });
    const p = patch(0, 1, 0, 1, roof);
    m.surface({ layout: 'layout', chord: 0.002 });
    expect(m.poisoned).toBeUndefined();
    const surfaces = m.diagnostics().surfaces;
    expect(surfaces.map((s) => s.name)).toEqual(['S', 'P']);
    expect((surfaces[1] as { surface: NurbsSurface }).surface.points).toEqual(p.points);
    const r = unwrap(
      measureEdge((surfaces[0] as { surface: NurbsSurface }).surface, 'u0', p, 'u1'),
    );
    expect(r.gap).toBeLessThanOrEqual(1e-5);
    expect(r.angle).toBeLessThanOrEqual(0.1);
    expect(r.curvatureRatio).toBeLessThanOrEqual(0.02);
    expect(m.validate({ layout: true }).issues.filter((i) => i.code === 'patch-layout')).toEqual(
      [],
    );
  });

  it('matches a side shared with several patches part by part, and holds a mirror side', () => {
    const m = model();
    m.patchLayout({
      patches: [
        {
          id: 'P',
          role: 'primary',
          surface: patch(0, 1, 0, 1, roof),
          sides: { u1: { to: ['A:u0', 'B:u0'], continuity: 'G2' } },
        },
        { id: 'A', role: 'secondary', surface: patch(1.01, 2, 0, 0.5, side) },
        { id: 'B', role: 'secondary', surface: patch(1.01, 2, 0.5, 1, side) },
        // On the mirror plane y = 0: tangent across it, curvature symmetric.
        {
          id: 'M',
          role: 'primary',
          surface: patch(0, 1, -0.0, 1, (x, y) => -0.3 - 0.04 * y + 0.1 * x * x),
          sides: { v0: { mirror: 'y', continuity: 'G2' } },
        },
      ],
    });
    m.surface({ layout: 'layout', chord: 0.002 });
    expect(m.poisoned).toBeUndefined();
    const findings = m.validate({ layout: true }).issues.filter((i) => i.code === 'patch-layout');
    expect(findings.map((f) => `${f.detail.check}@${f.detail.subject}`)).toEqual([]);
  });

  it('falsifier: declared G2 but matched only to G1 is reported', () => {
    const spec = (continuity: 'G1' | 'G2'): PatchLayoutSpec => ({
      patches: [
        { id: 'P', role: 'primary', surface: patch(0, 1, 0, 1, roof) },
        {
          id: 'S',
          role: 'secondary',
          surface: patch(1.02, 2, 0, 1, side),
          sides: { u0: { to: 'P:u1', continuity } },
        },
      ],
    });
    const m = model();
    m.patchLayout(spec('G1'));
    m.surface({ layout: 'layout', chord: 0.002 });
    expect(m.validate({ layout: true }).issues.filter((i) => i.code === 'patch-layout')).toEqual(
      [],
    );
    const built = new Map(m.diagnostics().surfaces.map((s) => [s.name, s.surface]));
    const issues = checkLayout(unwrap(resolveLayout(spec('G2'))), [], {}, { built });
    expect(issues.map((i) => [i.code, i.detail.required, i.detail.achieved])).toEqual([
      ['layout-continuity', 'G2', 'G1'],
    ]);
  });

  it('falsifier: a boundary running diagonally across a highlight band is reported', () => {
    // A cylinder of radius 0.3 about x; the patch's sides run at 45 degrees to its axis.
    const r = 0.3;
    const at = (s: number, t: number): Tuple3 => {
      const x = (s + t) / Math.SQRT2;
      const arc = (t - s) / Math.SQRT2;
      return [x, r * Math.sin(arc / r), r * Math.cos(arc / r)];
    };
    const diagonal = unwrap(
      nurbs.fitSurface(
        Array.from({ length: 12 }, (_, i) =>
          Array.from({ length: 12 }, (_, j) => at((0.4 * i) / 11, (0.4 * j) / 11)),
        ),
        { degree: [5, 5], net: [6, 6] },
      ),
    ).surface;
    const aligned = unwrap(
      nurbs.fitSurface(
        Array.from({ length: 12 }, (_, i) =>
          Array.from({ length: 12 }, (_, j): Tuple3 => {
            const a = (0.4 * j) / 11 / r;
            return [(0.4 * i) / 11, r * Math.sin(a), r * Math.cos(a)];
          }),
        ),
        { degree: [5, 5], net: [6, 6] },
      ),
    ).surface;
    // The patch's v0 side, shared with a neighbour (G2) or on a feature line.
    const layout = (s: NurbsSurface, side: 'feature' | 'shared'): PatchLayoutSpec => ({
      featureLines: ['crest'],
      patches: [
        {
          id: 'P',
          role: 'primary',
          surface: s,
          sides:
            side === 'feature'
              ? { v0: { feature: 'crest' } }
              : { v0: { to: 'Q:v1', continuity: 'G2' } },
        },
        { id: 'Q', role: 'primary', surface: s },
      ],
    });
    const check = (s: NurbsSurface, side: 'feature' | 'shared') =>
      checkLayout(
        unwrap(resolveLayout(layout(s, side))),
        [],
        {},
        {
          built: new Map([
            ['P', s],
            ['Q', s],
          ]),
        },
      ).map((i) => i.code);
    expect(check(diagonal, 'shared')).toContain('layout-highlight');
    expect(check(aligned, 'shared')).not.toContain('layout-highlight');
    // Feature lines define the bands: a feature side is never a highlight crossing.
    expect(check(diagonal, 'feature')).not.toContain('layout-highlight');
  });

  it('falsifier: a degenerate corner on a primary is reported, on a corner patch it is not checked', () => {
    const s = patch(0, 1, 0, 1, roof);
    // Collapse the u0 side into a point: its first row is one repeated point.
    const first = (s.points[0] as Tuple3[])[0] as Tuple3;
    const collapsed: NurbsSurface = {
      ...s,
      points: s.points.map((row, i) => (i === 0 ? row.map(() => first) : row)),
    };
    const issues = (role: 'primary' | 'corner') =>
      checkLayout(
        unwrap(resolveLayout({ patches: [{ id: 'P', role, surface: collapsed }] })),
        [],
        {},
        {
          built: new Map([['P', collapsed]]),
        },
      ).map((i) => i.code);
    expect(issues('primary')).toContain('layout-degenerate-corner');
    expect(issues('corner')).not.toContain('layout-degenerate-corner');
    expect(
      checkLayout(
        unwrap(resolveLayout({ patches: [{ id: 'P', role: 'primary', surface: s }] })),
        [],
        {},
        {
          built: new Map([['P', s]]),
        },
      ),
    ).toEqual([]);
  });

  it('falsifier: a feature line on no boundary, or off its declared side, is layout-feature-unplaced', () => {
    const s = patch(0, 1, 0, 1, roof);
    // The exact v1 isoparm: the side lies on it end to end.
    const crest = isoparm(s, 'u', 1);
    const off = unwrap(
      nurbs.approximate(
        Array.from({ length: 9 }, (_, k): Tuple3 => {
          const p = nurbs.surfacePoint(s, k / 8, 0.9);
          return [p[0], p[1], p[2]];
        }),
        { controlPoints: 6, degree: 5 },
      ),
    );
    const spec: PatchLayoutSpec = {
      featureLines: ['crest', 'waist'],
      patches: [{ id: 'P', role: 'primary', surface: s, sides: { v1: { feature: 'crest' } } }],
    };
    const lines = (curve: typeof crest) => [{ name: 'crest', curve }];
    const issues = (curve: typeof crest) =>
      checkLayout(
        unwrap(resolveLayout(spec)),
        lines(curve),
        {},
        { built: new Map([['P', s]]) },
      ).map((i) => `${i.code}@${i.detail.subject}:${i.detail.reason}`);
    expect(issues(crest)).toEqual(['layout-feature-unplaced@waist:no patch side lies on the line']);
    expect(issues(off)).toContain(
      'layout-feature-unplaced@crest:the declared side is off the line',
    );
  });

  it('reports a plan that lacks rows for its matched sides', () => {
    const spec: PatchLayoutSpec = {
      patches: [
        { id: 'P', role: 'primary', net: [4, 4] },
        { id: 'Q', role: 'primary', net: [4, 4] },
        // G2 on both u sides needs 6 rows across; 4 are planned.
        {
          id: 'S',
          role: 'secondary',
          net: [4, 6],
          sides: { u0: { to: 'P:u1', continuity: 'G2' }, u1: { to: 'Q:u0', continuity: 'G2' } },
        },
      ],
    };
    const issues = checkLayout(unwrap(resolveLayout(spec)), [], {});
    expect(issues.map((i) => [i.code, i.detail.subject, i.detail.required])).toEqual([
      ['layout-rows', 'S', 6],
      ['layout-unbuilt', 'layout', undefined],
    ]);
  });
});

describe('layouts with blends', () => {
  /** A lower band and an upper band meeting at a crease (y = 0.5), each split at x = 0.5. */
  function creased() {
    const crease = unwrap(
      nurbs.approximate(
        Array.from({ length: 9 }, (_, k): Tuple3 => [k / 8, 0.5, 0.2 + 0.05 * (k / 8) ** 2]),
        { controlPoints: 5, degree: 4, parameters: Array.from({ length: 9 }, (_, k) => k / 8) },
      ),
    );
    const fit = (f: (x: number, y: number) => Tuple3, y0: number, y1: number, boundaries: object) =>
      unwrap(
        nurbs.fitSurface(
          Array.from({ length: 12 }, (_, i) =>
            Array.from({ length: 8 }, (_, j) => f(i / 11, y0 + ((y1 - y0) * j) / 7)),
          ),
          { degree: [5, 4], net: [6, 5], boundaries },
        ),
      ).surface;
    const lower = fit((x, y) => [x, y, 0.2 + 0.05 * x * x + 0.1 * (0.5 - y) ** 2], 0, 0.5, {
      v1: crease,
    });
    const upper = fit((x, y) => [x, y, 0.2 + 0.05 * x * x - 0.3 * (y - 0.5)], 0.5, 1, {
      v0: crease,
    });
    const [l1, l2] = unwrap(nurbs.surface.split(lower, 'u', 0.5));
    const [u1, u2] = unwrap(nurbs.surface.split(upper, 'u', 0.5));
    // Nudge the second upper piece so its seam really needs a match.
    const u2b: NurbsSurface = {
      ...u2,
      points: u2.points.map((row, i) =>
        i === 3 ? row.map((p): Tuple3 => [p[0], p[1], p[2] + 0.002]) : row,
      ),
    };
    const spec: PatchLayoutSpec = {
      featureLines: ['crease'],
      patches: [
        { id: 'L1', role: 'primary', surface: l1 },
        {
          id: 'L2',
          role: 'primary',
          surface: l2,
          sides: { u0: { to: 'L1:u1', continuity: 'G2' } },
        },
        {
          id: 'U1',
          role: 'primary',
          surface: u1,
          sides: { v0: { to: 'L1:v1', continuity: 'G0', feature: 'crease' } },
        },
        {
          id: 'U2',
          role: 'secondary',
          surface: u2b,
          sides: {
            u0: { to: 'U1:u1', continuity: 'G2' },
            v0: { to: 'L2:v1', continuity: 'G0', feature: 'crease' },
          },
        },
      ],
      blends: [
        { between: ['L1', 'U1'], radius: 0.01, continuity: 'G2', name: 'b1' },
        { between: ['L2', 'U2'], radius: 0.01, continuity: 'G2', name: 'b2' },
      ],
    };
    return { crease, spec };
  }

  it('keeps the smooth seams G2 as built: blends trim the patches beside the crease', {
    timeout: 60_000,
  }, () => {
    const { crease, spec } = creased();
    const m = model();
    m.featureLine({ name: 'crease', curve: crease, continuity: 'G0' });
    m.patchLayout(spec);
    m.surface({ layout: 'layout', chord: 0.001, weld: 5e-5 });
    expect(m.poisoned).toBeUndefined();
    const issues = m
      .validate({ layout: true })
      .issues.filter((i) => ['patch-layout', 't-junction'].includes(i.code));
    expect(issues).toEqual([]);
    const s = new Map(m.diagnostics().surfaces.map((x) => [x.name, x.surface]));
    const r = unwrap(
      measureEdge(s.get('U2') as NurbsSurface, 'u0', s.get('U1') as NurbsSurface, 'u1'),
    );
    expect(r.curvatureRatio).toBeLessThanOrEqual(0.02);
    // The tessellated patches are the built ones, each trimmed by its blend.
    const built = unwrap(buildLayout(unwrap(resolveLayout(spec)))).surfaces;
    for (const id of ['L1', 'L2', 'U1', 'U2']) {
      expect(JSON.stringify(s.get(id))).toBe(JSON.stringify(built.get(id)));
      expect(m.diagnostics().surfaces.find((x) => x.name === id)?.trims?.length).toBe(1);
    }
  });

  it('validates a layout whose blends run out and cover part of the crease', {
    timeout: 60_000,
  }, () => {
    const { crease, spec } = creased();
    const m = model();
    m.featureLine({ name: 'crease', curve: crease, continuity: 'G0' });
    m.patchLayout({
      ...spec,
      blends: [
        {
          between: ['L1', 'U1'],
          radius: [
            [0, 0],
            [0.5, 0.01],
            [1, 0.01],
          ],
          continuity: 'G2',
          name: 'b1',
        },
        {
          between: ['L2', 'U2'],
          radius: [
            [0, 0.01],
            [0.5, 0.01],
            [1, 0],
          ],
          continuity: 'G2',
          name: 'b2',
        },
      ],
    });
    m.surface({ layout: 'layout', chord: 0.001, weld: 5e-5 });
    expect(m.poisoned).toBeUndefined();
    const report = m.validate({ layout: true, surfaceQuality: true });
    // The patches keep their built nets and the blends' along-edge nets are exempt from the
    // [8, 6] limit, so the run-out costs no density finding. The across (v) fairness on
    // U1/U2 is the layout's own, the same with constant-radius blends. The G2 blends hold G2
    // up to their run-out tips (audit A6: six knot spans per run-out read G1 just past them).
    const findings = report.issues
      .filter((i) => i.severity !== 'info')
      .map((i) => {
        const d = i.detail as Record<string, unknown>;
        return `${d.check}@${d.subject}${d.along === undefined ? '' : `:${d.along}`}`;
      });
    expect(findings).toEqual(['surface-fairness@U1:v', 'surface-fairness@U2:v']);
    expect(report.vertices - report.edges + report.faces).toBe(1);
  });

  it('measures the smooth seams as built, and a seam that leaves G2 is reported', () => {
    const { spec } = creased();
    const resolved = unwrap(resolveLayout(spec));
    const built = unwrap(buildLayout(resolved)).surfaces;
    const blended = unwrap(resolveBlends(layoutPatches(resolved, built), spec.blends ?? []));
    // Blends leave the patches as built.
    for (const p of blended.patches.filter((x) => x.transition === undefined))
      expect(p.surface).toBe(built.get(p.name as string));
    const report = (surfaces: ReadonlyMap<string, NurbsSurface>) =>
      checkLayout(resolved, [], {}, { built: surfaces }).map(
        (i) => `${i.code}@${i.detail.subject}`,
      );
    expect(report(built)).toEqual([]);
    // Falsifier: a seam row lifted off the match is reported.
    const u2 = built.get('U2') as NurbsSurface;
    const lifted = new Map(built).set('U2', {
      ...u2,
      points: u2.points.map((row, i) =>
        i === 1 ? row.map((p): Tuple3 => [p[0], p[1], p[2] + 0.002]) : row,
      ),
    });
    expect(report(lifted)).toContain('layout-continuity@U2:u0|U1:u1');
  });
});

describe('nurbs.split (curves)', () => {
  it('splits a curve into two exact pieces on the original parameters', () => {
    const c = unwrap(
      nurbs.interpolate(Array.from({ length: 9 }, (_, k): Tuple3 => [k, Math.sin(k), 0.1 * k * k])),
    );
    const [a, b] = unwrap(nurbs.split(c, 0.37));
    expect(nurbs.domain(a)).toEqual([0, 0.37]);
    expect(nurbs.domain(b)).toEqual([0.37, 1]);
    for (let k = 0; k <= 100; k++) {
      const t = k / 100;
      const piece = t <= 0.37 ? a : b;
      const p = nurbs.point(piece, t);
      const q = nurbs.point(c, t);
      expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(1e-12);
    }
    for (const t of [0, 1, -1, Number.NaN]) {
      const r = nurbs.split(c, t);
      expect(r.ok ? '' : r.error.code).toBe('model-invalid-argument');
    }
  });
});
