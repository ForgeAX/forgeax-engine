import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { facetRegions } from '../facet-metrics.ts';
import { buildFaceted, facetedContacts } from '../faceting.ts';
import { bangLabels } from '../hair.ts';
import { fringeCapBorder } from '../hair-metrics.ts';
import PLAN from '../facet-plan.json' with { type: 'json' };

/**
 * C-200 G6 remodel, the bangs (facet-plan.json part `bangs`): the fringe of 7 clumps built as
 * explicit facets over the opened cap, each clump's facet count inside the plan's
 * `facetsPerUnit`, one spike per tip, and the clumps, the cap and the whole hair region under the
 * mesh-quality gate.
 */
describe('C-200 G6 remodel: bangs', () => {
  const m = buildFaceted();
  const mesh = m.editMesh;
  const spikes = sel.tag(PLAN.tipTags[0] as string);
  const unit = PLAN.parts.find((p) => p.name === 'bangs')?.units?.[0] as { readonly count: number; readonly facetsPerUnit?: readonly [number, number] };
  const clumps = bangLabels();
  const fringe = clumps.reduce((s, l) => s.or(sel.createdBy(l)), sel.tag('__none__'));
  const gate = (faces: typeof fringe) => {
    const q = m.meshQuality(faces.minus(spikes));
    if (!q.ok) throw q.error;
    return q.value.failed;
  };

  it('meets the mesh-quality tiling gate on the bangs, the cap and the whole hair region (less their spikes)', () => {
    expect(gate(fringe), 'bangs').toEqual([]);
    expect(gate(sel.createdBy('hair-cap').or(sel.createdBy('hair-cap-wall'))), 'cap').toEqual([]);
    expect(gate(facetRegions(m).hair), 'hair').toEqual([]);
  });

  it('builds the plan count of clumps, each its facet count inside the plan facetsPerUnit', () => {
    expect(clumps.length).toBe(unit.count);
    expect(unit.facetsPerUnit).toBeDefined();
    const [lo, hi] = unit.facetsPerUnit as readonly [number, number];
    for (const l of clumps) {
      const n = sel.createdBy(l).evaluate(mesh).length;
      expect(n, l).toBeGreaterThanOrEqual(lo);
      expect(n, l).toBeLessThanOrEqual(hi);
    }
  });

  it('ends each clump in one spike: 2-4 facets to one point, at most 3 times longer along the flow than across, under 7 cm', () => {
    for (const l of clumps) {
      const faces = sel.createdBy(l).and(spikes);
      const ids = faces.evaluate(mesh);
      expect(ids.length, l).toBeGreaterThanOrEqual(2);
      expect(ids.length, l).toBeLessThanOrEqual(4);
      const shared = ids.map((f) => new Set(mesh.faceVertices(f))).reduce((a, b) => new Set([...a].filter((v) => b.has(v))));
      expect(shared.size, l).toBe(1);
      const b = m.bounds(faces);
      if (!b.ok) throw b.error;
      const along = b.value.max[1] - b.value.min[1];
      const across = Math.max(b.value.max[0] - b.value.min[0], b.value.max[2] - b.value.min[2]);
      expect(along, l).toBeLessThanOrEqual(0.07);
      expect(along / across, l).toBeLessThanOrEqual(3);
    }
  });

  it('runs the cap border along the fringe root: no rim vertex over 0.5 mm proud of the fringe, none over 3 mm off its seams', () => {
    const rim = fringeCapBorder(m);
    expect(rim.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...rim.map((r) => r.proud ?? -Infinity))).toBeLessThanOrEqual(0.0005);
    expect(Math.max(...rim.map((r) => r.lateral))).toBeLessThanOrEqual(0.003);
  });

  it('crosses nothing and keeps every designed contact within', () => {
    const v = m.validate({ contacts: facetedContacts() });
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.code === 'self-intersection')).toEqual([]);
    const fits = (v.issues.find((i) => i.code === 'designed-contact') as { detail: { fits: { parts: string[]; status: string }[] } } | undefined)?.detail.fits ?? [];
    expect(fits.length).toBe(facetedContacts().length);
    expect(fits.filter((f) => f.status !== 'within').map((f) => `${f.parts.join('|')}: ${f.status}`)).toEqual([]);
  });
});
