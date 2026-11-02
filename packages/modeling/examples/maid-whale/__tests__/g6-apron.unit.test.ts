import { type FaceSelector, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { APRON_UNITS, buildFaceted } from '../faceting.ts';
import { FRILL_UNITS, ruffleTeethCount } from '../garments.ts';
import PLAN from '../facet-plan.json' with { type: 'json' };

/**
 * C-200 G6 remodel, the apron (facet-plan.json part `apron`): the mesh-quality tiling gate on each unit,
 * each unit's density band from its plan edge or, for units built as facets, each label's
 * triangle count inside `facetsPerUnit` (densityRule), and the ruffle teeth and frill units as
 * closed islands, one label each.
 */
describe('C-200 G6 remodel: apron', () => {
  const m = buildFaceted();
  const mesh = m.editMesh;
  const spikes = sel.tag(PLAN.tipTags[0] as string);
  const anyTag = (tags: readonly string[]): FaceSelector => tags.reduce((s, t) => s.or(sel.tag(t)), sel.tag('__none__'));
  const plan = (PLAN.parts.find((p) => p.name === 'apron')?.units ?? []) as readonly { readonly name: string; readonly edge?: number; readonly count?: number; readonly facetsPerUnit?: readonly [number, number] }[];
  const edgeOf = (name: string) => plan.find((u) => u.name === name)?.edge as number;
  const units: Record<string, FaceSelector> = {
    panel: anyTag(APRON_UNITS.panel),
    bib: anyTag(APRON_UNITS.bib),
    ruffle: sel.tag('apron-ruffle'),
    frills: anyTag(['apron-frill-l', 'apron-frill-r']),
  };
  const quality = (faces: FaceSelector) => {
    const q = m.meshQuality(faces.minus(spikes));
    if (!q.ok) throw q.error;
    return q.value;
  };

  it('meets the mesh-quality tiling gate on the apron and on each of its units', () => {
    expect(quality(anyTag(Object.values(APRON_UNITS).flat())).failed).toEqual([]);
    for (const [name, faces] of Object.entries(units)) expect(quality(faces).failed, name).toEqual([]);
  });

  it('keeps each unit within the density band of its plan edge (0.8-1.6 of 4 / (sqrt 3 e^2))', () => {
    for (const [name, faces] of Object.entries(units)) {
      if (plan.find((u) => u.name === name)?.facetsPerUnit !== undefined) continue;
      const e = edgeOf(name);
      expect(e, name).toBeGreaterThan(0);
      const equilateral = 4 / (Math.sqrt(3) * e * e);
      const density = quality(faces).density;
      expect(density, name).toBeGreaterThanOrEqual(0.8 * equilateral);
      expect(density, name).toBeLessThanOrEqual(1.6 * equilateral);
    }
  });

  it('builds every tooth and frill unit as facets: its triangle count inside the plan facetsPerUnit', () => {
    for (const [name, prefix] of [['ruffle', 'apron-ruffle-'], ['frills', 'apron-frill-']] as const) {
      const range = plan.find((u) => u.name === name)?.facetsPerUnit;
      expect(range, name).toBeDefined();
      const [lo, hi] = range as readonly [number, number];
      const labels = m.inspect().labels.map((l) => l.label).filter((l) => l.startsWith(prefix));
      expect(labels.length, name).toBeGreaterThan(0);
      for (const l of labels) {
        const n = sel.createdBy(l).evaluate(mesh).length;
        expect(n, l).toBeGreaterThanOrEqual(lo);
        expect(n, l).toBeLessThanOrEqual(hi);
      }
    }
  });

  const teethCount = ruffleTeethCount();

  it(`builds ${teethCount} ruffle teeth and ${2 * FRILL_UNITS.count} frill units as closed islands, one label each`, () => {
    const labels = new Set(m.inspect().labels.map((l) => l.label));
    const teeth = Array.from({ length: teethCount }, (_, k) => `apron-ruffle-${k}`);
    const frills = Array.from({ length: 2 * FRILL_UNITS.count }, (_, k) => `apron-frill-${k}`);
    expect(plan.find((u) => u.name === 'ruffle')?.count).toBe(teethCount);
    expect(labels.has(`apron-ruffle-${teethCount}`)).toBe(false);
    expect(plan.find((u) => u.name === 'frills')?.count).toBe(2 * FRILL_UNITS.count);
    for (const l of [...teeth, ...frills]) {
      expect(labels.has(l), l).toBe(true);
      expect(sel.createdBy(l).evaluate(mesh).length, l).toBeGreaterThan(0);
    }
    // Each unit's outline is its own facet edges: no edge it shares with another face.
    for (const l of [...teeth, ...frills]) expect(m.count(sel.createdBy(l).boundary()), l).toBe(0);
    // The teeth go around the U: as many up each side, at least a third of them along the bottom
    // (front view, the corners at y 0.262).
    const centers = teeth.map((l) => {
      const b = m.bounds(sel.createdBy(l));
      if (!b.ok) throw b.error;
      return [(b.value.min[0] + b.value.max[0]) / 2, (b.value.min[1] + b.value.max[1]) / 2] as const;
    });
    const sides = [centers.filter(([x, y]) => x < 0 && y > 0.262).length, centers.filter(([x, y]) => x > 0 && y > 0.262).length];
    expect(sides[0]).toBe(sides[1]);
    expect(sides[0]).toBeGreaterThanOrEqual(3);
    expect(teethCount - sides[0]! - sides[1]!).toBeGreaterThanOrEqual(teethCount / 3);
  });
});
