import { describe, expect, it } from 'vitest';
import { LATTICE_PATTERNS, type LatticePattern, latticePattern } from '../recipes/lattice';

const SEED = 7;

function build(pattern: LatticePattern) {
  return latticePattern({ pattern, seed: SEED });
}

describe('latticePattern', () => {
  it.each(
    LATTICE_PATTERNS,
  )('%s defaults build a closed panel with no blocking issues', (pattern) => {
    const r = build(pattern);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.model.validate();
    expect(report.closed).toBe(true);
    expect(report.pass).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it.each(
    LATTICE_PATTERNS,
  )('%s open area matches the kernel volume of the pierced panel', (pattern) => {
    const r = build(pattern);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dims = r.value.dimensions;
    const width = dims.width ?? NaN;
    const height = dims.height ?? NaN;
    const thickness = dims.thickness ?? NaN;
    const openArea = dims.openArea ?? NaN;
    const openRatio = dims.openRatio ?? NaN;
    const solid = r.value.model.validate().volume;
    const kernelOpen = (width * height * thickness - solid) / thickness;
    expect(Math.abs(kernelOpen - openArea)).toBeLessThan(1e-9 * width * height);
    expect(openRatio).toBeCloseTo(openArea / (width * height), 12);
    expect(openRatio).toBeGreaterThan(0);
    expect(openRatio).toBeLessThan(1);
  });

  it('bubujin cells are congruent: 25 openings on the default panel, minimum bar equals bar', () => {
    const r = build('bubujin');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.dimensions as Record<string, number>;
    expect(d.openings).toBe(25);
    expect(d.minBar).toBeCloseTo(d.bar as number, 12);
  });

  it('the minimum bar never drops below the requested bar on any pattern', () => {
    for (const pattern of LATTICE_PATTERNS) {
      const r = build(pattern);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.dimensions as Record<string, number>;
      expect(d.minBar).toBeGreaterThanOrEqual((d.bar as number) - 1e-12);
    }
  });

  it('the same options reproduce the same mesh and dimensions', () => {
    const a = build('binglie');
    const b = build('binglie');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.value.dimensions)).toBe(JSON.stringify(b.value.dimensions));
    const vertices = (m: typeof a.value.model) =>
      m.editMesh.vertices().map((v) => m.editMesh.position(v).join(','));
    expect(vertices(a.value.model)).toEqual(vertices(b.value.model));
  });

  it('a different seed changes the seeded layout', () => {
    const a = latticePattern({ pattern: 'binglie', seed: 1 });
    const b = latticePattern({ pattern: 'binglie', seed: 2 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect((a.value.dimensions as Record<string, number>).openArea).not.toBeCloseTo(
      (b.value.dimensions as Record<string, number>).openArea as number,
      9,
    );
  });

  it('refuses a bar that leaves no positive opening', () => {
    const r = latticePattern({ pattern: 'bubujin', cell: 0.1, bar: 0.06 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });

  it('refuses an unknown pattern name', () => {
    const r = latticePattern({ pattern: 'nope' as LatticePattern });
    expect(r.ok).toBe(false);
  });

  it('falsifier: binglie without a seed is refused rather than silently fixed', () => {
    const r = latticePattern({ pattern: 'binglie' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });
});
