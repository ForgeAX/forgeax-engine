import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { facetRegions } from '../facet-metrics.ts';
import { buildFaceted, facetedContacts } from '../faceting.ts';
import { backLobeLabels } from '../hair.ts';
import PLAN from '../facet-plan.json' with { type: 'json' };

/**
 * C-200 G6 remodel, the back hair (facet-plan.json part `back-hair`): the remeshed curtain and its
 * 13 lobes of explicit facets under the mesh-quality gate, each lobe's facet count inside the plan's
 * `facetsPerUnit`, one spike per lobe tip, and the whole figure free of crossings.
 */
describe('C-200 G6 remodel: back hair', () => {
  const m = buildFaceted();
  const mesh = m.editMesh;
  const spikes = sel.tag(PLAN.tipTags[0] as string);
  const units = (PLAN.parts.find((p) => p.name === 'back-hair')?.units ?? []) as readonly { readonly name: string; readonly faces: string; readonly facetsPerUnit?: readonly [number, number] }[];
  const lobes = backLobeLabels();

  it('meets the mesh-quality tiling gate on the curtain and its lobes (less their spikes)', () => {
    const q = m.meshQuality(facetRegions(m)['back-hair'].minus(spikes));
    if (!q.ok) throw q.error;
    expect(q.value.failed).toEqual([]);
  });

  it('builds the 13 lobes, each its facet count inside the plan facetsPerUnit', () => {
    const labels = new Set(m.inspect().labels.map((l) => l.label));
    expect(lobes.length).toBe(13);
    for (const unit of ['outer-lobes', 'inner-lobes']) {
      const u = units.find((x) => x.name === unit);
      expect(u?.facetsPerUnit, unit).toBeDefined();
      const [lo, hi] = u?.facetsPerUnit as readonly [number, number];
      const prefix = (u?.faces ?? '').replace('createdBy:', '').replace('*', '');
      const mine = lobes.filter((l) => l.startsWith(prefix));
      expect(mine.length, unit).toBeGreaterThan(0);
      for (const l of mine) {
        expect(labels.has(l), l).toBe(true);
        const n = sel.createdBy(l).evaluate(mesh).length;
        expect(n, l).toBeGreaterThanOrEqual(lo);
        expect(n, l).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('ends each lobe in one spike: 2-4 facets to one point, at most 3 times longer along the flow than across, under 7 cm', () => {
    for (const l of lobes) {
      const faces = sel.createdBy(l).and(spikes);
      const ids = faces.evaluate(mesh);
      expect(ids.length, l).toBeGreaterThanOrEqual(2);
      expect(ids.length, l).toBeLessThanOrEqual(4);
      // One component converging to one point: every spike facet holds the tip vertex.
      const shared = ids.map((f) => new Set(mesh.faceVertices(f))).reduce((a, b) => new Set([...a].filter((v) => b.has(v))));
      expect(shared.size, l).toBe(1);
      const b = m.bounds(faces);
      if (!b.ok) throw b.error;
      const along = b.value.max[1] - b.value.min[1];
      const across = Math.max(b.value.max[0] - b.value.min[0], b.value.max[2] - b.value.min[2]);
      expect(along, l).toBeLessThanOrEqual(0.07);
      expect(along / across, l).toBeLessThanOrEqual(3);
    }
    expect(spikes.minus(sel.tag('hair')).evaluate(mesh)).toEqual([]);
  });

  it('crosses nothing and keeps every designed contact within', () => {
    const v = m.validate({ contacts: facetedContacts() });
    expect(v.issues.filter((i) => i.code === 'self-intersection')).toEqual([]);
    const fits = (v.issues.find((i) => i.code === 'designed-contact') as { detail: { fits: { parts: string[]; status: string }[] } } | undefined)?.detail.fits ?? [];
    expect(fits.length).toBe(facetedContacts().length);
    expect(fits.filter((f) => f.status !== 'within').map((f) => `${f.parts.join('|')}: ${f.status}`)).toEqual([]);
  });
});
