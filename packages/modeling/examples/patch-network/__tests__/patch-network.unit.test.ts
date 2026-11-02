import { type Issue, measureEdge, type NurbsSurface, type ValidationCode } from '@forgeax/engine-modeling';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildGrid, buildLayout, layout, patches } from '../body';

/**
 * Case C-115 gate: the door side, C-pillar and rear deck side built from a patch
 * layout (lines first, fit, exact splits, G2 matches, G0 creases on their lines, blends)
 * pass the layout and surface-quality checks with watertight seams; the same region
 * traced and interpolated with nurbs.grid fails them.
 */
const findings = (issues: readonly Issue<ValidationCode>[]) =>
  issues
    .filter((i) => ['patch-layout', 'surface-quality', 't-junction'].includes(i.code))
    .map((i) => `${i.code}:${i.detail.check ?? ''}@${i.detail.subject ?? ''}`);

describe('C-115 patch network, layout vs grid', () => {
  it('layout: 0 layout and surface-quality findings, no T-junctions', { timeout: 120_000 }, () => {
    const m = buildLayout();
    expect(m.poisoned).toBeUndefined();
    expect(findings(m.validate({ layout: true, surfaceQuality: true }).issues)).toEqual([]);
    // Nets of the layout: 7 x 6 everywhere, single span per direction.
    for (const p of layout().patches) expect([p.surface?.points.length, p.surface?.points[0]?.length]).toEqual([7, 6]);
  });

  it('the tessellated C-pillar stays G2 to both neighbours after the knee blends', { timeout: 120_000 }, () => {
    // The blends refit the patches beside the knee; the layout matches the seams again.
    const s = patches(buildLayout());
    for (const [side, other, otherSide] of [
      ['u0', 'P10', 'u1'],
      ['u1', 'P11', 'u0'],
    ] as const) {
      const r = measureEdge(s.get('S03') as NurbsSurface, side, s.get(other) as NurbsSurface, otherSide);
      if (!r.ok) throw r.error;
      expect(r.value.gap).toBeLessThanOrEqual(1e-5);
      expect(r.value.angle).toBeLessThanOrEqual(0.1);
      expect(r.value.curvatureRatio).toBeLessThanOrEqual(0.02);
    }
    expect([...s.keys()]).toEqual(['P04', 'P04c', 'P05', 'P10', 'P11', 'S03', 'knee-door', 'knee-pillar', 'knee-deck']);
  });

  it('grid (the old way): one dense traced patch fails density and fairness', { timeout: 120_000 }, () => {
    const m = buildGrid();
    expect(m.poisoned).toBeUndefined();
    const checks = findings(m.validate({ surfaceQuality: true }).issues);
    expect(checks).toContain('surface-quality:surface-density@side');
    expect(checks.some((c) => c.startsWith('surface-quality:surface-fairness@side'))).toBe(true);
  });

  it('the Dawn case maps both sessions to their source lines', { timeout: 120_000 }, () => {
    const recording = recordingSessions();
    buildLayout(recording.session);
    buildGrid(recording.session);
    const steps = attachSourceLines(recording.steps, fileURLToPath(new URL('../body.ts', import.meta.url)));
    expect(new Set(steps.map((s) => s.session))).toEqual(new Set(['layout', 'grid']));
  });
});
