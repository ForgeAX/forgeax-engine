import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { SEATS, seatGap } from '../attach-metrics.ts';
import { buildAttached, flukeAxes } from '../attachments.ts';
import { limbAxes } from '../body.ts';
import { decalPoles, decalFaces, decalFolds, facePlaneFolds, minCornerAngle, neckFolds } from '../face.ts';
import { HEAD_FACETS } from '../head.ts';
import { frillCurves, ruffleToothAxes } from '../garments.ts';
import { facetRegions } from '../facet-metrics.ts';
import { buildFaceted, facetedContacts, triangles } from '../faceting.ts';
import { surfaceArea } from '../lowpoly.ts';
import { PLAN_UNITS, planDensities, planTiling, planUnitFlow } from '../plan-units.ts';
import PLAN from '../facet-plan.json' with { type: 'json' };

/**
 * C-200 G6 (low-poly faceting), checkpoint B: the whole G5 assembly faceted under the mesh-quality gate
 * (facet-plan.json), and the remodel's (A) per-unit density (plan-units.ts).
 */
describe('C-200 G6 faceting', () => {
  const m = buildFaceted();
  // One validation (crossings and designed contacts) for the tests that read it.
  const v = m.validate({ contacts: facetedContacts() });

  it('is closed, all triangles, exports flat, and crosses nothing beyond its designed contacts', () => {
    expect(m.poisoned).toBeUndefined();
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.code === 'self-intersection' && i.severity === 'warn')).toEqual([]);
    expect(m.count(sel.all())).toBe(triangles(m, sel.all()));
    expect(m.toMesh().ok).toBe(true);
  });

  it('keeps every designed contact and seat of the attachments on the facets', () => {
    const fits = (v.issues.find((i) => i.code === 'designed-contact') as { detail: { fits: { parts: string[]; status: string }[] } } | undefined)?.detail.fits ?? [];
    expect(fits.length).toBe(facetedContacts().length);
    expect(fits.filter((f) => f.status !== 'within').map((f) => `${f.parts.join('|')}: ${f.status}`)).toEqual([]);
    for (const [tag, seat] of SEATS) expect(seatGap(m, sel.tag(tag), seat), tag).toBeLessThanOrEqual(0.0005);
  });

  // mesh-quality on every triangle (kernel meshQuality, MESH_QUALITY_LIMITS) but the plan's spikes.
  const spikes = sel.tag(PLAN.tipTags[0] as string);
  const quality = Object.entries(facetRegions(m)).map(([name, faces]) => {
    const q = m.meshQuality(faces.minus(spikes));
    if (!q.ok) throw q.error;
    return { name, ...q.value };
  });

  it('meets the mesh-quality tiling gate in every region: aspect, smallest angle, valence, size ratio', () => {
    for (const q of quality) expect(q.failed, q.name).toEqual([]);
  });

  it('keeps the spikes to the hair tips the plan names: each under 7 cm, under 5 % of the hair', () => {
    const hair = m.meshQuality(sel.tag('hair'));
    const spiked = m.meshQuality(spikes);
    if (!hair.ok || !spiked.ok) throw new Error('hair and spikes are measured');
    expect(spiked.value.area / hair.value.area).toBeLessThan(0.05);
    expect(spikes.minus(sel.tag('hair')).evaluate(m.editMesh)).toEqual([]);
    for (const label of m.inspect().labels.map((l) => l.label).filter((l) => l.startsWith('hair-tip-'))) {
      const b = m.bounds(sel.createdBy(label).and(spikes));
      if (b.ok) expect(b.value.max[1] - b.value.min[1], label).toBeLessThan(0.07);
    }
  });

  // The plan is a conjunction: shape AND density AND spikes. Density per facet-plan.json
  // `densityRule`, unit by unit (plan-units.ts): each unit within 0.8-1.6 of the equilateral
  // density of its plan edge, each unit built as facets with every label inside facetsPerUnit, a
  // pending unit matching nothing; and the back hair, the sheet's coarsest surface, coarser than skin.
  // A unit the plan records with a `densityGap` (a measured miss, with its numbers and reason) is
  // open until it is rebuilt: it stays outside its band until then, and its gap leaves the plan
  // when it lands (a rebuilt unit inside its band fails this test until its gap is removed).
  it('keeps every plan unit within its densityRule band, each recorded gap open until its unit is rebuilt, and the back hair coarser than skin', () => {
    const densities = planDensities(m);
    const unitName = (d: (typeof densities)[number]) => `${d.unit.part}/${d.unit.name}`;
    const open = (d: (typeof densities)[number]) => `open until ${unitName(d)} rebuilt`;
    const actual = densities.filter((d) => !d.ok).map((d) => (d.unit.densityGap !== undefined ? open(d) : `${unitName(d)}: ${Math.round(d.perM2)} per m2, ${d.triangles} triangles, outside ${d.band.map((x) => Math.round(x)).join('-')}${d.perLabel === undefined ? '' : `, per label ${Object.values(d.perLabel).join(',')}`}`));
    expect(actual).toEqual(densities.filter((d) => d.unit.densityGap !== undefined).map(open));
    const of = (name: string) => quality.find((q) => q.name === name)?.density as number;
    expect(of('back-hair')).toBeLessThan(of('skin'));
  });

  // mesh quality per plan unit (plan-units.ts), the plan's spikes excluded: the units the plan records with
  // `tilingOpen` ("open until <unit> rebuilt") are the only ones failing.
  it('meets the mesh-quality tiling gate in every plan unit but the recorded open ones', () => {
    const tiling = planTiling(m, spikes);
    const failing = tiling.filter((t) => t.failed.length > 0).map((t) => `${t.unit.part}/${t.unit.name}`);
    const open = tiling.filter((t) => t.unit.tilingOpen !== undefined).map((t) => `${t.unit.part}/${t.unit.name}`);
    expect(failing).toEqual(open);
  });

  // Flow on built units (facet-plan.json gate flowP75): every built unit whose flow is measurable
  // (plan-units.ts planUnitFlow, builder path curves by plan label) has p75 <= 20 and skipped
  // <= 0.4 but the ones the plan records with `flowOpen`; remeshed units wait for a direction-field remesh.
  it('lays the built units along their plan flow but the recorded open ones', () => {
    const curves = { 'apron-ruffle-*': ruffleToothAxes, 'frill curves': frillCurves, 'limb axes': limbAxes, 'fluke-*': flukeAxes };
    const built = PLAN_UNITS.filter((u) => u.facetsPerUnit !== undefined);
    const measured = built.map((u) => planUnitFlow(m, u, curves, spikes)).filter((f) => f !== undefined);
    expect(measured.map((f) => f.unit.name)).toEqual(expect.arrayContaining(['pleats', 'frills', 'ruffle', 'flukes']));
    const failing = measured.filter((f) => f.failed.length > 0).map((f) => `${f.unit.part}/${f.unit.name}`);
    const open = measured.filter((f) => f.unit.flowOpen !== undefined).map((f) => `${f.unit.part}/${f.unit.name}`);
    expect(failing).toEqual(open);
  });

  it('ends each tip in at most 4 facets, each at most 3 times longer along the tip than across', () => {
    const mesh = m.editMesh;
    const tips = m.inspect().labels.map((l) => l.label).filter((l) => /^hair-((tip|back-lobe|back-inner)-\d+|lock-[lr]\d)$/.test(l));
    expect(tips.length).toBeGreaterThan(0);
    for (const label of tips) {
      const faces = sel.createdBy(label).and(spikes).evaluate(mesh);
      expect(faces.length, label).toBeLessThanOrEqual(4);
      for (const f of faces) {
        const p = mesh.faceVertices(f).map((v) => mesh.position(v));
        const ys = p.map((q) => q[1]);
        const along = Math.max(...ys) - Math.min(...ys);
        // Across: the extent perpendicular to the (vertical) flow.
        let across = 0;
        for (const [i, u] of p.entries()) for (const w of p.slice(i + 1)) across = Math.max(across, Math.hypot(u[0] - w[0], u[2] - w[2]));
        expect(along / Math.max(across, 1e-9), label).toBeLessThanOrEqual(3);
      }
    }
  });

  it('falsifier: the gate fails the d287ca9 recipe (QEM only, no taper, no remesh)', () => {
    const old = buildAttached((x) => {
      for (const faces of Object.values(facetRegions(x))) {
        const target = Math.max(1, Math.round(surfaceArea(x, faces) / ((Math.sqrt(3) / 4) * 0.04 * 0.04)));
        if (triangles(x, faces) > target) x.simplify(faces, { targetFaces: target, maxError: 0.003, clearance: 0.0005, preserve: { labels: true, materials: true } });
      }
    });
    old.try((t) => t.triangulate(sel.all()));
    const failed = Object.entries(facetRegions(old)).filter(([, faces]) => {
      const q = old.meshQuality(faces);
      return q.ok && q.value.failed.length > 0;
    });
    expect(failed.map(([name]) => name)).toEqual(expect.arrayContaining(['back-hair', 'dress']));
  }, 300000);

  // facet-plan.json `face` (user decision 2026-10-26: F2 stays low-poly, face included): the head
  // shades flat like every facet, and no pole or fan (valence 3 or at least 9) sits under the
  // eye, mouth and blush decal areas (face.ts).
  it('facets the face plane flat and keeps poles out of the decal areas', () => {
    const plane = sel.tag('face-plane');
    expect(plane.evaluate(m.editMesh).length).toBeGreaterThan(50);
    expect(HEAD_FACETS.toEdges('contained').minus(sel.edges.sharp()).evaluate(m.editMesh)).toEqual([]);
    for (const [area, n] of Object.entries(decalFaces(m, plane))) expect(n, area).toBeGreaterThan(0);
    expect(decalPoles(m, plane)).toEqual([]);
  });

  // G7-1: the face plane does not fold; adjacent facets bend at most 20 deg
  // (57 deg at 3de2db4, from the plan's cheek fold and the skull blend).
  it('keeps the face plane fold-free', () => {
    const folds = facePlaneFolds(m);
    expect(folds.interior).toBeGreaterThan(100);
    expect(folds.maxDeg, `worst at ${folds.worst.map((x) => x.toFixed(3)).join(',')}`).toBeLessThanOrEqual(20);
  });

  // a 28 deg crease on the face/skin border ran through both blush decals while
  // the plane-only check passed; every edge with its midpoint in a decal area counts, whatever its tag.
  it('keeps every decal area free of creases, whatever the tags of the faces', () => {
    const folds = decalFolds(m);
    expect(folds.edges).toBeGreaterThan(50);
    expect(folds.maxDeg, `worst at ${folds.worst.map((x) => x.toFixed(3)).join(',')}`).toBeLessThanOrEqual(20);
  });

  // the neck ran 78 deg at the seam strip, 43.8 deg after the flare (#379); the
  // funnel from the trunk's top ring to the throat is now spread over several rows and stays under 30.
  it('keeps the neck (seam strip, neck ring, throat and its turn under the jaw) within 30 deg', () => {
    const folds = neckFolds(m, 0.64);
    expect(folds.edges).toBeGreaterThan(400);
    expect(folds.maxDeg, `worst at ${folds.worst.map((x) => x.toFixed(3)).join(',')}`).toBeLessThanOrEqual(30);
  });

  it('keeps the head skin and seam free of slivers (15 deg)', () => {
    const skin = minCornerAngle(m, sel.createdBy('head-skin').or(sel.createdBy('head-seam')));
    expect(skin.minDeg, `at ${skin.at.map((x) => x.toFixed(3)).join(',')}`).toBeGreaterThanOrEqual(15);
  });

  // The left half is tiled and mirrored (head.ts), so the two sides are one tiling welded on x = 0.
  it('mirrors the head: every vertex has a counterpart at -x', () => {
    const mesh = m.editMesh;
    const head = new Set(sel.tag('head').evaluate(mesh).flatMap((f) => mesh.faceVertices(f)));
    const key = (p: readonly number[]) => `${Math.round(Math.abs(p[0] as number) * 1e4)},${Math.round((p[1] as number) * 1e4)},${Math.round((p[2] as number) * 1e4)}`;
    const [pos, neg] = [new Map<string, number>(), new Map<string, number>()];
    for (const v of head) {
      const p = mesh.position(v);
      if (Math.abs(p[0] as number) < 1e-4) continue;
      const side = (p[0] as number) > 0 ? pos : neg;
      side.set(key(p), (side.get(key(p)) ?? 0) + 1);
    }
    expect(pos.size).toBeGreaterThan(200);
    const miss = [...pos.keys()].filter((k) => !neg.has(k)).length + [...neg.keys()].filter((k) => !pos.has(k)).length;
    expect(miss / (pos.size + neg.size)).toBeLessThan(0.02);
  });

  it('keeps the seams: every part and the tail one piece with the skirt', () => {
    for (const t of ['hair', 'head', 'bodice', 'skirt', 'skirt-hem', 'cuff-l', 'tail', 'fluke', 'headdress-band', 'fin-l', 'ribbon-l', 'bowtie', 'brooch-gem', 'back-bow']) expect(sel.tag(t).evaluate(m.editMesh).length, t).toBeGreaterThan(0);
    const skirt = sel.createdBy('skirt').evaluate(m.editMesh);
    const connected = new Set(sel.tag('tail').connected('any').evaluate(m.editMesh));
    expect(skirt.some((f) => connected.has(f))).toBe(true);
  });
});
