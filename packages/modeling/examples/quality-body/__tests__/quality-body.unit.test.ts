import { curveFairness, isoparm, model, type NurbsSurface, nurbs, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { BODY, buildRight, buildWrong, fittedPanels, fittedSingle, trace } from '../body';
import { buildFromLayout } from '../layout';
import { fileURLToPath } from 'node:url';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { foldTest, roughness } from '../views';

/**
 * Case C-114 gate: the body built from a fair feature-line network with blended creases
 * passes the surface-quality and edge-flow checks; the same shape traced and densely
 * interpolated fails them, and its curvature ripples.
 */
describe('C-114 surface quality, right way vs wrong way', () => {
  const options = { surfaceQuality: true, edgeFlow: { tolerance: BODY.shoulderBlend } } as const;

  it('right: fair lines, sparse nets, G2 blends, isoparm quads on the feature lines', { timeout: 30_000 }, () => {
    const m = buildRight();
    expect(m.poisoned).toBeUndefined();
    const v = m.validate(options);
    const findings = v.issues.filter((i) => i.severity !== 'info' && i.code !== 'mesh-open');
    expect(findings).toEqual([]);
    expect(v.issues.some((i) => i.code === 'edge-flow')).toBe(false);
    expect(m.diagnostics().surfaces.map((s) => s.name)).toEqual([
      'hood',
      'fender',
      'door',
      'shoulder-blend',
      'waist-blend',
    ]);
  });

  it('right with openings: view trims survive the blends and tag the cut faces', { timeout: 30_000 }, () => {
    const m = buildRight(undefined, { openings: true });
    expect(m.poisoned).toBeUndefined();
    expect(m.count(sel.tag('trim'))).toBeGreaterThan(0);
    const errors = m.validate().issues.filter((i) => i.severity === 'error' || i.code === 't-junction');
    expect(errors).toEqual([]);
    // A 1.5 mm flange folds every cut vertex inward without flipping a face; without
    // the ring, Delaunay cut triangles leave vertices 0.17 mm above slanted edges.
    expect(foldTest(m, 0.0015).fails).toBe(0);
    const bare = foldTest(buildRight(undefined, { openings: true, trimRing: 0 }), 0.0015);
    expect(bare.fails).toBeGreaterThan(0);
    expect(bare.narrowest).toBeLessThan(0.0015);
  });

  it('a sparse body with a 1.5 mm zig-zag hood line fails surface fairness', { timeout: 30_000 }, () => {
    const m = buildRight(undefined, { ripple: 0.0015 });
    expect(m.poisoned).toBeUndefined();
    const checks = m
      .validate(options)
      .issues.filter((i) => i.code === 'surface-quality')
      .map((i) => `${i.detail.check}@${i.detail.subject}`);
    expect(checks).toContain('surface-fairness@hood');
    expect(roughness(m)).toBeGreaterThan(roughness(buildRight()) * 5);
  });

  it('wrong: a dense traced patch fails density and edge flow and ripples', { timeout: 30_000 }, () => {
    const wrong = buildWrong();
    expect(wrong.poisoned).toBeUndefined();
    const checks = wrong
      .validate(options)
      .issues.filter((i) => i.code === 'surface-quality' || i.code === 'edge-flow')
      .map((i) => i.detail.check);
    expect(checks).toContain('surface-density');
    expect(checks).toContain('feature-loop');
    expect(checks).toContain('aspect');
    expect(checks).toContain('triangles');
    const right = roughness(buildRight());
    const rippled = roughness(wrong);
    expect(rippled).toBeGreaterThan(right * 5);
  });

  it('fitted: panels fit to the noisy trace between the lines pass like the right body', { timeout: 60_000 }, () => {
    const fitted = buildRight(undefined, { fitted: true });
    expect(fitted.poisoned).toBeUndefined();
    const v = fitted.validate(options);
    expect(v.issues.filter((i) => i.severity !== 'info' && i.code !== 'mesh-open')).toEqual([]);
    const fit = fittedPanels();
    for (const s of [fit.hood, fit.fender, fit.door]) expect([s.points.length, s.points[0]?.length]).toEqual([4, 5]);
    // The fit still follows the trace (noise amplitude 0.4 mm).
    for (const e of fit.errors) expect(e).toBeLessThan(0.001);
    // Hood-middle roughness (the C-114 measure) within 2x of the right body.
    const right = roughness(buildRight());
    expect(roughness(fitted)).toBeLessThanOrEqual(2 * right);
    // One 8 x 6 patch over the whole trace smears both creases: the layout, not the fit, fails.
    const single = model();
    single.surface({ patches: [{ name: 'body', surface: fittedSingle(), flip: true }], chord: 0.0005 });
    expect(roughness(single)).toBeGreaterThan(100 * right);
  });

  it('from a layout: the same body declared as a patch layout has 0 findings', { timeout: 60_000 }, () => {
    const m = buildFromLayout();
    expect(m.poisoned).toBeUndefined();
    const v = m.validate({ ...options, layout: true });
    expect(v.issues.filter((i) => i.severity !== 'info' && i.code !== 'mesh-open')).toEqual([]);
    expect(m.diagnostics().surfaces.map((s) => s.name)).toEqual(['hood', 'fender', 'door', 'shoulder-blend', 'waist-blend']);
  });

  it('falsifier: the same trace interpolated through fitSurface (net = grid, no fairing) still fails', () => {
    const [nx, ns] = BODY.grid;
    const interp = nurbs.fitSurface(trace(), { degree: [3, 3], net: [nx, ns] });
    if (!interp.ok) throw interp.error;
    expect(interp.value.max).toBeLessThan(1e-9);
    expect(rateRatio(interp.value.surface)).toBeGreaterThan(15);
    const m = buildWrong();
    const checks = m
      .validate(options)
      .issues.filter((i) => i.code === 'surface-quality')
      .map((i) => i.detail.check);
    expect(checks).toContain('surface-density');
    expect(checks).toContain('surface-fairness');
  });
});

describe('C-114 case recording', () => {
  // The Dawn case maps every journal step to its source line through `const x = session('name')`.
  it('maps the right and wrong sessions to their source lines', { timeout: 30_000 }, () => {
    const recording = recordingSessions();
    buildRight(recording.session);
    buildWrong(recording.session);
    const steps = attachSourceLines(recording.steps, fileURLToPath(new URL('../body.ts', import.meta.url)));
    expect(new Set(steps.map((s) => s.session))).toEqual(new Set(['right', 'wrong']));
  });
});

/** Worst isoparm rate ratio over 5 interior isoparms per direction (surface fairness). */
function rateRatio(surface: NurbsSurface): number {
  return Math.max(
    ...(['u', 'v'] as const).flatMap((along) =>
      [1, 2, 3, 4, 5].map((k) => {
        const f = curveFairness({ name: 'iso', curve: isoparm(surface, along, k / 6) });
        if (!f.ok) throw f.error;
        return f.value.rateRatio;
      }),
    ),
  );
}
