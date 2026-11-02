import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { facetRegions } from '../facet-metrics.ts';
import { buildFaceted } from '../faceting.ts';
import { SKIRT_GORES } from '../garments.ts';
import PLAN from '../facet-plan.json' with { type: 'json' };

/**
 * C-200 G6 remodel, the skirt (facet-plan.json part `skirt`): 8 gores whose seams are structure
 * lines, and the white hem band, each within the tiling gate and its derived density band.
 */
describe('C-200 G6 skirt', () => {
  const m = buildFaceted();
  const mesh = m.editMesh;
  const skirt = facetRegions(m).skirt.minus(sel.tag(PLAN.tipTags[0] as string));
  // The cloth (gores and hem band) and the pleat units built on it.
  const pleats = sel.tag('skirt-pleat');
  const cloth = skirt.minus(pleats);
  const units = (PLAN.parts.find((p) => p.name === 'skirt')?.units ?? []) as readonly { name: string; edge?: number; count?: number; hemOnly?: number; facetsPerUnit?: readonly [number, number] }[];
  // densityRule: an equilateral tiling of edge e has 4 / (sqrt(3) e^2) triangles per square meter; the band is 0.8-1.6 of it.
  const band = (name: string): [number, number] => {
    const e = units.find((u) => u.name === name)?.edge as number;
    const d = 4 / (Math.sqrt(3) * e * e);
    return [0.8 * d, 1.6 * d];
  };

  it('meets the mesh-quality tiling gate on every skirt, hem and pleat triangle', () => {
    const q = m.meshQuality(skirt);
    if (!q.ok) throw q.error;
    expect(q.value.failed).toEqual([]);
  });

  it.each([
    ['gores', cloth.minus(sel.tag('skirt-hem'))],
    ['hem', cloth.and(sel.tag('skirt-hem'))],
  ] as const)('keeps the %s within the density band of their edge', (name, faces) => {
    const q = m.meshQuality(faces);
    if (!q.ok) throw q.error;
    const [lo, hi] = band(name);
    expect(q.value.density, name).toBeGreaterThanOrEqual(lo);
    expect(q.value.density, name).toBeLessThanOrEqual(hi);
  });

  it('keeps the 8 gore seams as straight edges from the waist to the hem', () => {
    // Each skirt face's gore, then the edges between faces of neighbouring gores.
    const gore = new Map<number, number>();
    for (let k = 0; k < SKIRT_GORES; k++) {
      const faces = sel.tag(`skirt-gore-${k}`).and(cloth).evaluate(mesh);
      expect(faces.length, `skirt-gore-${k}`).toBeGreaterThan(0);
      for (const f of faces) gore.set(f, k);
    }
    expect(gore.size).toBe(cloth.evaluate(mesh).length);
    const sides = new Map<string, number[]>();
    for (const f of gore.keys()) {
      const vs = mesh.faceVertices(f);
      for (const [i, v] of vs.entries()) {
        const w = vs[(i + 1) % vs.length] as number;
        const key = v < w ? `${v},${w}` : `${w},${v}`;
        sides.set(key, [...(sides.get(key) ?? []), f]);
      }
    }
    const seams = new Map<number, Set<number>>();
    for (const [key, faces] of sides) {
      if (faces.length !== 2) continue;
      const [a, b] = faces.map((f) => gore.get(f) as number) as [number, number];
      if (a === b) continue;
      // Only neighbouring gores meet: the seam after gore `a`.
      expect((a + 1) % SKIRT_GORES === b || (b + 1) % SKIRT_GORES === a, `${a}|${b}`).toBe(true);
      const seam = (a + 1) % SKIRT_GORES === b ? b : a;
      const set = seams.get(seam) ?? new Set<number>();
      for (const v of key.split(',')) set.add(Number(v));
      seams.set(seam, set);
    }
    expect([...seams.keys()].sort()).toEqual(Array.from({ length: SKIRT_GORES }, (_, k) => k));
    for (const [seam, set] of seams) {
      const p = [...set].map((v) => mesh.position(v));
      // A vertical plane through the seam's vertices (least squares in x, z): within 1 mm of it.
      const [mx, mz] = [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[2], 0) / p.length];
      let [sxx, sxz, szz] = [0, 0, 0];
      for (const q of p) {
        sxx += (q[0] - mx) ** 2;
        sxz += (q[0] - mx) * (q[2] - mz);
        szz += (q[2] - mz) ** 2;
      }
      const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      const off = Math.max(...p.map((q) => Math.abs(-(q[0] - mx) * Math.sin(th) + (q[2] - mz) * Math.cos(th))));
      expect(off, `seam ${seam}`).toBeLessThanOrEqual(0.001);
      // From under the waistband to the hem.
      const ys = p.map((q) => q[1]);
      expect(Math.min(...ys), `seam ${seam}`).toBeLessThan(0.16);
      expect(Math.max(...ys), `seam ${seam}`).toBeGreaterThan(0.43);
    }
  });

  it('builds every pleat as facet units: two per pleat, each triangle count inside the plan facetsPerUnit', () => {
    const plan = units.find((u) => u.name === 'pleats');
    const [lo, hi] = plan?.facetsPerUnit ?? [1, 0];
    const labels = m.inspect().labels.map((l) => l.label).filter((l) => /^skirt-pleat-\d+(-hem)?$/.test(l));
    expect(labels.length).toBe(2 * (plan?.count ?? 0) - (plan?.hemOnly ?? 0));
    for (const l of labels) {
      const faces = sel.createdBy(l).evaluate(mesh);
      expect(faces.length, l).toBeGreaterThanOrEqual(lo);
      expect(faces.length, l).toBeLessThanOrEqual(hi);
      // Built, never remeshed: every face of the unit carries the pleat tag and no cloth tag.
      expect(sel.createdBy(l).minus(pleats).evaluate(mesh), l).toEqual([]);
    }
  });
});
