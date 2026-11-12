import { type DesignedContact, type FaceSelector, type MeshJob, type Model, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { attachmentContacts, buildAttached, flukeContacts } from './attachments.ts';
import { facetRegions } from './facet-metrics.ts';
import { rebuildHead } from './head.ts';
import { cutSkirtGores, TRIM_BAND } from './garments.ts';
import { ahogeContacts, bangFringe, fringeContacts, lobeContacts, lockContacts, raiseLobes } from './hair.ts';
import { surfaceArea } from './lowpoly.ts';

/**
 * Case C-200 stage G6 (low-poly faceting) of the G5 assembly, checkpoint B of the rework
 * (facet-plan.json; the remodel of the narrow features is A). The garment and hair walls taper
 * to a crease at their free edges (no rim strips). Each group is reduced by QEM toward its area
 * over the facet area of its edge (at most `FACET_MAX_ERROR` off the surface, label and material
 * borders kept), remeshed isotropically at that edge with a curvature-adaptive field (narrow
 * features get finer facets), then its remaining slivers flipped or collapsed
 * (`cleanup.tiling`); nothing brings two surfaces within `FACET_CLEARANCE`. The hair's tips are
 * tagged `hair-spike` (the plan's spikes). The attachments are then seated on the facets as in
 * G5, everything is triangulated, and every edge is marked sharp (flat facets).
 */
/** A part faceted at one size: its faces (the session decides tip labels), its remesh edge and curvature field. */
export interface FacetGroup {
  readonly name: string;
  readonly faces: (m: Model) => FaceSelector;
  readonly edge: number;
  /** The remesh's curvature field: chord error and shortest edge (narrow features get finer facets); none: one isotropic edge. */
  readonly adaptive?: { readonly error: number; readonly minEdge: number };
  /** Without the QEM pass (a part already near its facet count, whose collapses would leave slivers the remesh cannot move). */
  readonly simplify?: false;
  /** Checkpoint after this group (a capture snapshots only its first 8). */
  readonly checkpoint?: string;
}

const region = (name: keyof ReturnType<typeof facetRegions>) => (m: Model): FaceSelector => facetRegions(m)[name];
/** The back hair's lobes (facet-plan.json back-hair units). */
const lobeFaces = (m: Model): FaceSelector =>
  m
    .inspect()
    .labels.map((l) => l.label)
    .filter((l) => /^hair-back-(lobe|inner)-\d+$/.test(l))
    .reduce((s, l) => s.or(sel.createdBy(l)), sel.tag('__none__'));
/** The side locks (facet-plan.json side-locks), built as facets (hair.ts LOCK_FACETS): kept out of the hair group. */
const lockFaces = (m: Model): FaceSelector =>
  m
    .inspect()
    .labels.map((l) => l.label)
    .filter((l) => /^hair-lock-[lr]\d+$/.test(l))
    .reduce((s, l) => s.or(sel.createdBy(l)), sel.tag('__none__'));
const tagged = (...tags: string[]) => (): FaceSelector => tags.reduce((s, t) => s.or(sel.tag(t)), sel.tag('__none__'));
/** The apron's units (facet-plan.json apron): faceted apart from the dress, the ruffle and frills not at all. */
export const APRON_UNITS = {
  panel: ['apron'],
  bib: ['apron-bib'],
  ruffle: ['apron-ruffle', 'apron-frill-l', 'apron-frill-r'],
} as const;
const APRON_TAGS = Object.values(APRON_UNITS).flat();
/** The trims faceted by remesh (the others are facet bands). */
const TRIM_TAGS = ['waistband', 'shoe-l', 'shoe-r'];
/** The limbs (facet-plan.json skin-limbs), faceted apart from the face. */
const LIMB_TAGS = ['arm-l', 'arm-r', 'leg-l', 'leg-r', 'hand-l', 'hand-r'];

/** Curvature field for cloth and skin; the hair's units cap theirs at 0.8 of their edge. */
const COARSE = { error: 0.004, minEdge: 0.01 } as const;

/** Cap rings around the curtain's root faceted with the back hair (see FACETS back-hair). */
export const BACK_HAIR_CAP_RINGS = 3;

const sideMassFaces = (m: Model) => sel.createdBy('hair-side-l').or(sel.createdBy('hair-side-r')).and(region('hair')(m));

export const FACETS: readonly FacetGroup[] = [
  // Remesh target edges (curved and narrow parts keep finer triangles, so the result is finer):
  // the sheet's back hair is its coarsest surface (about 5 cm facets); bangs, locks and the cap finer.
  // Remodel: the back mass and its lobes at the plan's 0.05 edge; the field never refines below
  // 0.8 of it (the sheet's back hair is its coarsest surface).
  // The group takes `BACK_HAIR_CAP_RINGS` rings of the cap around the curtain's root too: a group's
  // border is pinned, and on the root the cap's 1 cm vertices left needles; the hair group then
  // remeshes those cap rows again with the rest of the cap.
  {
    name: 'back-hair',
    faces: (m) => {
      const back = region('back-hair')(m).minus(lobeFaces(m));
      return back.or(back.grow(BACK_HAIR_CAP_RINGS).and(region('hair')(m)).minus(lobeFaces(m)));
    },
    // Past the dome's plan edge 0.065 (906 per m2 there, over its 875 band): 801 per m2.
    edge: 0.07,
    adaptive: { error: 0.004, minEdge: 0.056 },
  },
  // The lobes and the side locks are explicit facets (hair.ts LOBES, LOCK_FACETS): no group, they
  // keep their facets. The rest of the hair (cap, side masses) at the cap's 0.05, never
  // refined below 0.8 of it; the masses stay with the cap, where the headdress band ends and the
  // ribbons are seated on them. The bangs are built as facets over the cap once the figure is
  // faceted (hair.ts bangFringe).
  // The ahoge is built as facets (hair.ts AHOGE_FACETS), like the locks: no group. Density per unit
  // (facet-plan.json densityRule, plan-units.ts): the limbs at 0.05 apart from the face (at the
  // skin's 0.036 and its curvature field they ran 7954), and the bodice and sleeves re-faceted
  // coarser after the dress group (below); each lands in its band.
  { name: 'hair-side', faces: (m) => sideMassFaces(m), edge: 0.035, adaptive: { error: 0.004, minEdge: 0.028 } },
  { name: 'hair', faces: (m) => region('hair')(m).minus(lockFaces(m)).minus(sel.createdBy('hair-ahoge')).minus(sideMassFaces(m)), edge: 0.05, adaptive: { error: 0.004, minEdge: 0.03 }, checkpoint: 'faceted-hair' },
  // Per-unit mesh quality (facet-plan.json skin-limbs, edge 0.03): at 0.05 over6 3.9 %; remeshed from the
  // body's rows at 0.039 (no QEM, field to 0.031) over6 1.6 % at 4040 per m2, in the band.
  // The head and neck are faceted as they are rebuilt (head.ts), so the limbs are the rest of the skin.
  { name: 'limbs', faces: tagged(...LIMB_TAGS), edge: 0.039, adaptive: { error: 0.004, minEdge: 0.031 }, simplify: false, checkpoint: 'faceted-skin' },
  // The skirt is coarser than the bodice. The tail grows from the skirt and keeps its tag; it is
  // its own part. Remodel (facet-plan.json skirt): the 8 gores (their seams kept as tag borders)
  // and the white hem band, each field capped at 0.8 of its edge, so the gores and band, not
  // curvature, set the facets. The remesh edges are past the plan's unit edges (gores 0.055, hem
  // 0.035): chord limits and the field leave the tiling about 1.5 times denser than its target,
  // which lands each unit inside the density band of its plan edge. The pleat units
  // (garments.ts skirtPleats) are built as facets: no group.
  { name: 'skirt', faces: (m) => region('skirt')(m).minus(sel.tag('skirt-hem')).minus(sel.tag('skirt-pleat')), edge: 0.07, adaptive: { error: 0.004, minEdge: 0.056 } },
  { name: 'skirt-hem', faces: (m) => region('skirt')(m).and(sel.tag('skirt-hem')).minus(sel.tag('skirt-pleat')), edge: 0.045, adaptive: { error: 0.004, minEdge: 0.036 } },
  // The trims (facet-plan.json trims): the waistband and shoes remeshed at the plan's 0.03 (no
  // curvature field: at 0.024 they ran 1.3x over their band); the collar, cuffs and socks are
  // built as facet bands (garments.ts facetBand), no group.
  { name: 'trims', faces: tagged(...TRIM_TAGS), edge: 0.03 },
  { name: 'dress', faces: (m) => region('dress')(m).minus(tagged(...APRON_TAGS)()).minus(sel.tag(TRIM_BAND)).minus(tagged(...TRIM_TAGS)()), edge: 0.042, adaptive: COARSE },
  // The apron (facet-plan.json apron): the flat panel and bib in few large facets, layers of
  // few dress faces remeshed directly (QEM's collapses at their tapered creases left slivers).
  // Its ruffle teeth and frill units are built as facets (garments.ts facetUnit): no group.
  // The panel at 0.05 lands at 1.35x its plan edge's (0.045) equilateral count.
  { name: 'apron', faces: tagged(...APRON_UNITS.panel), edge: 0.05, simplify: false },
  // The bib is 38-48 triangles: at 0.04 one sliver at its top corner (aspect 6.2) was 2.6 %; at
  // 0.036 none (2250 per m2, in its 0.04 band).
  { name: 'bib', faces: tagged(...APRON_UNITS.bib), edge: 0.036, simplify: false },
  // Per-unit mesh quality (bodice-sleeves): the bodice at 0.052 without QEM, its field down to 0.038 (at a
  // 0.04 floor the armhole and bib-outline borders fail min-angle p10; at 0.06 p10 19.8): 2217
  // per m2, in its band. The sleeves stay at 0.055 for their band: no remesh meets both (at
  // 0.032 the mesh-quality limits pass at 4770 per m2, band 1508-3016); their mesh quality is open (facet-plan.json).
  { name: 'bodice', faces: tagged('bodice'), edge: 0.052, adaptive: { error: 0.006, minEdge: 0.038 }, simplify: false },
  { name: 'sleeves', faces: tagged('sleeve-l', 'sleeve-r'), edge: 0.055, adaptive: { error: 0.004, minEdge: 0.044 } },
  // Faceted before the ties are seated on it.
  // The flukes are built as facets (attachments.ts facetFlukes): no group. The tail body at its
  // plan edge's band (facet-plan.json tail), its group edge past the plan's 0.04 as the gores'
  // (the field leaves the tiling denser than its target).
  { name: 'tail', faces: (m) => region('tail')(m).minus(sel.tag('fluke')), edge: 0.05, adaptive: { error: 0.004, minEdge: 0.04 }, checkpoint: 'faceted-dress' },
];
export const FACET_MAX_ERROR = 0.003;
/** No move brings a facet within this of a surface it does not touch (layered garments, shells). */
export const FACET_CLEARANCE = 0.0005;
/** Even-out passes of the isotropic remesh after QEM. */
export const FACET_REMESH_ITERATIONS = 5;

const facetArea = (e: number) => (Math.sqrt(3) / 4) * e * e;

/** Triangles of the faces of a selector (n-gons count as n - 2). */
export function triangles(m: Model, faces: FaceSelector): number {
  return faces.evaluate(m.editMesh).reduce((n, f) => n + m.editMesh.faceVertices(f).length - 2, 0);
}

/** The spikes (facet-plan.json `tipTags`): the last `SPIKE` of each back-hair tip (the lobes and the bangs tag theirs as they are built). */
export const SPIKE = 0.045;

function tagSpikes(m: Model): void {
  // The remodel's lobes tag their spike facets as they are built (hair.ts backLobe).
  for (const label of m.inspect().labels.map((l) => l.label).filter((l) => /^hair-tip-\d+$/.test(l))) {
    const b = m.bounds(sel.createdBy(label));
    if (!b.ok) continue;
    // Whole faces inside the tip's last SPIKE, so no spike reaches past it.
    m.tag(sel.createdBy(label).and(sel.inBox([-1, -1, -1], [1, b.value.min[1] + SPIKE, 1])), 'hair-spike');
  }
}

/** One group's faceting: QEM toward its facet count, the isotropic remesh, then the tiling cleanup. */
export function facetGroup(m: Model, g: FacetGroup): void {
  const faces = g.faces(m);
  const target = Math.round(surfaceArea(m, faces) / facetArea(g.edge));
  // The back mass's label borders (mass and cap) carry no facet edge and would pin needles if preserved.
  const backHair = g.name === 'back-hair';
  const preserve = { labels: !backHair, materials: true } as const;
  if (g.simplify !== false && triangles(m, faces) > target) m.simplify(faces, { targetFaces: target, maxError: FACET_MAX_ERROR, clearance: FACET_CLEARANCE, preserve });
  // QEM leaves slivers and fans on flat runs (pleats, bands, the back mass): an isotropic
  // remesh at the facet edge evens them, under the same clearance.
  m.remesh(faces, { targetEdgeLength: g.edge, iterations: FACET_REMESH_ITERATIONS, clearance: FACET_CLEARANCE, ...(g.adaptive === undefined ? {} : { adaptive: g.adaptive }), preserve });
  // Last, flips toward Delaunay and needle collapses; an already clean tiling is no effect.
  // Flat facets tolerate more deviation on the coarse hair.
  const tidyError = backHair || ['hair', 'ahoge'].includes(g.name) ? 2 * FACET_MAX_ERROR : FACET_MAX_ERROR;
  const tidy = m.try((t) => t.cleanup.tiling(faces, { maxError: tidyError, maxAspect: 3.5, iterations: 20, clearance: FACET_CLEARANCE, preserve }));
  if (!tidy.ok && tidy.error.code !== 'model-op-no-effect') throw tidy.error;
}

/**
 * Needles the remesh cannot move (a vertex nearly collinear on a group border, between its long
 * neighbours): each triangle of `faces` under `minAngle` degrees loses its shortest edge, one end
 * moved onto the other and the coincident pair welded.
 */
function collapseNeedles(m: Model, faces: FaceSelector, minAngle: number): void {
  for (let pass = 0; pass < 60; pass++) {
    const mesh = m.editMesh;
    let worst: { a: Tuple3; b: Tuple3; angle: number } | undefined;
    for (const f of faces.evaluate(mesh)) {
      const vs = mesh.faceVertices(f);
      if (vs.length !== 3) continue;
      const p = vs.map((v) => mesh.position(v) as Tuple3);
      const len = [0, 1, 2].map((i) => Math.hypot(...(p[i] as Tuple3).map((x, c) => x - ((p[(i + 1) % 3] as Tuple3)[c] as number))));
      const angle = Math.min(...[0, 1, 2].map((i) => (Math.acos(Math.max(-1, Math.min(1, ((len[i] as number) ** 2 + (len[(i + 1) % 3] as number) ** 2 - (len[(i + 2) % 3] as number) ** 2) / (2 * (len[i] as number) * (len[(i + 1) % 3] as number))))) * 180) / Math.PI));
      if (angle >= minAngle || (worst !== undefined && angle >= worst.angle)) continue;
      const short = len.indexOf(Math.min(...len));
      worst = { a: p[short] as Tuple3, b: p[(short + 1) % 3] as Tuple3, angle };
    }
    if (worst === undefined) return;
    const e = 1e-5;
    const at = sel.inBox([worst.a[0] - e, worst.a[1] - e, worst.a[2] - e], [worst.a[0] + e, worst.a[1] + e, worst.a[2] + e], { by: 'any' }).toVerts('contained');
    m.translate(at, [worst.b[0] - worst.a[0], worst.b[1] - worst.a[1], worst.b[2] - worst.a[2]]);
    m.weld({ distance: 1e-6 });
  }
}

/** Facets the figure, hair and tail (see FACETS); the attachments are then seated on the facets. */
function facetBase(m: Model): void {
  // The skirt's gore seams (structure lines) before anything is remeshed.
  cutSkirtGores(m);
  // The head to its topology plan (head-plan.ts), its seam strip built as facets.
  rebuildHead(m);
  for (const g of FACETS) {
    facetGroup(m, g);
    // The hair's spikes (the plan's tips) once the hair is faceted.
    if (g.name === 'hair') tagSpikes(m);
    if (g.checkpoint !== undefined) m.checkpoint(g.checkpoint);
  }
  collapseNeedles(m, sel.createdBy('hair-cap').or(sel.createdBy('hair-cap-wall')).or(sel.createdBy('hair-back-outer')).or(sel.createdBy('hair-side-l')).or(sel.createdBy('hair-side-r')), 15);
  // The lobes, built clear of the curtain while it was faceted, into its end.
  raiseLobes(m);
  // The bangs, as facets over the faceted cap and forehead.
  bangFringe(m);
}

/** G6 wall ends: every shell thins to a crease over this (or 0.8 of a narrower part's reach). */
export const FACET_TAPER = 0.04;

/** G6's designed contacts: G5's attachments, the faceted flukes in the tail's end, each back-hair lobe rooted in the curtain and the fringe seated in the cap. */
export function facetedContacts(): DesignedContact[] {
  return [...attachmentContacts(), ...flukeContacts(), ...lobeContacts(), ...fringeContacts(), ...lockContacts(), ...ahogeContacts()];
}

export function buildFaceted(): Model {
  const m = buildAttached(facetBase, { taper: FACET_TAPER, facets: true });
  m.triangulate(sel.all());
  // Every facet reads flat (the sheet's style), the head included: sharp intent on every edge, so
  // any export or view shades each triangle with its own normal.
  m.markSharp(sel.edges.all());
  return m;
}

/**
 * G6 as a `modeling-mesh-job` (design 10.4): the clearance-guarded faceting takes about 70 s,
 * beyond the 15 s Pack build budget, so `g6-faceted.pack.ts` emits only the job and the
 * cooker builds it (the DDC keeps the result); register `createMeshJobCooker([G6_JOB])` in
 * the build plugin. Every edge is sharp, so weighted normals shade each facet flat.
 */
export const G6_JOB: MeshJob<Record<string, never>> = {
  name: 'maid-whale.g6-faceted',
  build: () => buildFaceted(),
  export: { normals: { mode: 'weighted' } },
};
