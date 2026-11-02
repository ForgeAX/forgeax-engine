import { type Model, model, SurfaceQuery, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { HEAD_PLAN, headCage, TURNS } from './head-plan.ts';

/**
 * C-200 G7 head rebuilt from an all-quad cage (head-plan.ts headCage) on the figure before it is
 * faceted, before the fringe is laid over the forehead: the faceted head skin above the neck seam
 * is cut away and the cage takes its place. The face, cheek band, jaw and under-jaw keep the
 * plan's points; points the hair covers (behind the ear-front line, the forehead under the fringe,
 * the crown) sit on the G2 skull they replace, so the hair layered on it keeps its clearance. The
 * head is low-poly like the rest of the figure (facet-plan.json `face`): the cage is remeshed into
 * even flat facets whose edges keep its structure-zone borders and wrapped onto the cage's limit
 * surface (HEAD_FACET). The cage runs down the neck under the collar, its meridians one per point
 * of the trunk's top ring, and a strip (under the collar, seamStrip) joins its neck ring to that
 * ring. Labels `head-face` (tagged `face-plane`, the decals' chart), `head-skin` and `head-seam`;
 * tag `head`, slot `skin`.
 */

/**
 * Points on the G2 skull: behind the ear-front line by `behind`, or over HEAD_BLEND.to (above the
 * eyes, under the fringe and the side masses: the fringe and the cap were built on that surface).
 */
const HIDDEN = { behind: 0.005, low: 0.665, high: 0.72 } as const;
/**
 * In front, the plan blends onto the skull from `from` (under the jaw corner) and lies on it over
 * `to` (no kink under the fringe), with a smoothstep. The skull sits 10-20 mm in front of the
 * plan's upper face, so a short ramp creases the face plane (G7-1): this one keeps it within
 * 20 deg. `to` sits under the fringe's roots: a higher one moved the temple skin back from the
 * fringe built on the skull, and its locks slivered at the notch. Face-plane points move along z,
 * keeping the plan's columns.
 */
export const HEAD_BLEND = { from: 0.62, to: 0.79 } as const;
/** Resampled points sit this far inside the skull they replace (the hair cap's clearance only grows). */
const INSET = 0.0005;

type P3 = Tuple3;

/**
 * The head's facets (facet-plan.json `face`): its remesh edge, and the limit surface the facets
 * lie on (the cage subdivided this many levels, so they keep its form, not its control polygon)
 * and the tiling cleanup's distance from it.
 */
export const HEAD_FACET = { edge: 0.034, face: 0.0268, neck: 0.018, throat: 0.012, iterations: 8, limitLevels: 3, maxError: 0.002 } as const;
/** Cage rows of the turn from the throat into the under-jaw plane (head-plan.ts zone `throat-<row>`). */
const THROAT_ROWS = TURNS;
/** Tag prefix of the cage's structure zones (head-plan.ts CageQuad.zone); their borders stay facet edges. */
const ZONE = 'head-zone-';

/** The head's facets above the seam strip: the face plane and the rest of the head skin. */
export const HEAD_FACETS = sel.createdBy('head-face').or(sel.createdBy('head-skin'));

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: P3): P3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Open-boundary vertices of a mesh that pass `keep`, ordered by azimuth about the neck axis (front first, toward +x). */
function boundaryRing(m: Model, keep: (p: readonly number[]) => boolean): P3[] {
  const mesh = m.editMesh;
  const directed = new Set<string>();
  const pairs: [number, number][] = [];
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    for (let i = 0; i < vs.length; i++) {
      const [a, b] = [vs[i] as number, vs[(i + 1) % vs.length] as number];
      directed.add(`${a}>${b}`);
      pairs.push([a, b]);
    }
  }
  const ring = new Set<number>();
  for (const [a, b] of pairs) if (!directed.has(`${b}>${a}`) && keep(mesh.position(a)) && keep(mesh.position(b))) ring.add(a).add(b);
  return [...ring].map((v) => mesh.position(v) as P3).sort((p, q) => azimuth(p) - azimuth(q));
}

function azimuth(p: readonly number[]): number {
  const { center } = HEAD_PLAN.neck;
  const a = Math.atan2((p[0] as number) - center[0], (p[2] as number) - center[2]);
  return a < -1e-9 ? a + 2 * Math.PI : a;
}

/**
 * The cage's neck ring moves toward the trunk's top ring (one point per meridian): that ring is
 * 0.045-0.05 wide at the sides and back but the neck column only 0.033, and the radius jump folded
 * the strip into the neck by up to 78 deg. At the sides (`side`, by |sin azimuth|^`power`) it moves
 * all the way; in front, where the collar's lip hugs the neck, only over `front.z` and by `front.by`.
 * Moving the back as well pushed the nape through the collar. The throat rings above follow at the
 * sides by the fractions in `rings`, so the neck widens into the head over a few rows, not one.
 */
export const NECK_FLARE = { side: 1, power: 4, front: { by: 1, z: [0.02, 0.033] }, rings: [0.4, 0.15, 0.05] } as const;

function flareNeck(points: P3[], seam: readonly P3[], meridians: number): void {
  const { side, power, front, rings } = NECK_FLARE;
  const toward = (i: number, w: number, m = i) => {
    const [p, s] = [points[i] as P3, seam[m] as P3];
    points[i] = [p[0] + (s[0] - p[0]) * w, p[1], p[2] + (s[2] - p[2]) * w];
  };
  for (let i = 0; i < meridians; i++) {
    const t = Math.min(1, Math.max(0, ((points[i] as P3)[2] - front.z[0]) / (front.z[1] - front.z[0])));
    toward(i, front.by * t * t * (3 - 2 * t));
  }
  for (let i = 0; i < meridians; i++) toward(i, side * Math.abs(Math.sin(azimuth(seam[i] as P3))) ** power);
  rings.forEach((w, k) => {
    for (let i = 0; i < meridians; i++) toward((k + 1) * meridians + i, w * Math.abs(Math.sin(azimuth(seam[i] as P3))) ** power, i);
  });
}

/** The open boundary left at the neck (the trunk's top ring, under the collar). */
function seamLoop(m: Model): P3[] {
  const { seam, center } = HEAD_PLAN.neck;
  return boundaryRing(m, (p) => Math.abs((p[1] as number) - seam) < 0.005 && Math.hypot((p[0] as number) - center[0], (p[2] as number) - center[2]) < 0.06);
}

/**
 * The strip from the head's neck ring (pinned through the faceting: one point per meridian) to
 * the trunk's top ring under the collar: `rows` triangle rows whose rings blend from the neck
 * ring to the seam, in plan by a smoothstep (`ease`) and in height evenly, so the funnel eases
 * into both ends instead of folding at them. Triangles only.
 */
const SEAM_STRIP = { rows: 3, ease: 0.9 } as const;

function seamStrip(head: Model, seam: readonly P3[], neck: readonly P3[]): void {
  if (neck.length !== seam.length) throw new Error(`maid-whale head: neck ring has ${neck.length} points for ${seam.length} meridians`);
  // The neck ring's original meridian points sit at the seam's azimuths: start the ring on the seam's first.
  const a0 = azimuth(seam[0] as P3);
  const gap = (p: P3) => Math.abs(((azimuth(p) - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  const start = neck.reduce((best, p, i) => (gap(p) < gap(neck[best] as P3) ? i : best), 0);
  const top = neck.map((_, i) => neck[(start + i) % neck.length] as P3);
  const { rows: count, ease } = SEAM_STRIP;
  const ring = (t: number): P3[] => {
    const w = t + ease * (t * t * (3 - 2 * t) - t);
    return top.map((a, i): P3 => {
      const b = seam[i] as P3;
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * w];
    });
  };
  const rows: P3[][] = [top, ...Array.from({ length: count - 1 }, (_, k) => ring((k + 1) / count)), [...seam]];
  const face = (pts: P3[]) => head.polygon({ points: pts, label: 'head-seam', material: 'skin' });
  for (let r = 0; r + 1 < rows.length; r++) {
    const [up, down] = [rows[r] as P3[], rows[r + 1] as P3[]];
    for (let k = 0; k < down.length; k++) {
      const [d0, d1] = [down[k] as P3, down[(k + 1) % down.length] as P3];
      const [u0, u1] = [up[k] as P3, up[(k + 1) % up.length] as P3];
      face([d0, d1, u1]);
      face([d0, u1, u0]);
    }
  }
}

/** Rebuilds the head and neck on the G5 figure before it is faceted, as facets (no group facets them again). */
export function rebuildHead(m: Model): void {
  const skin = sel.tag('head').minus(sel.tag('hair'));
  const q = SurfaceQuery.of(m.editMesh, skin.evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  // The G2 head and its neck column go; the trunk's top ring is the seam.
  m.delete(skin);
  const seam = seamLoop(m);
  if (seam.length < 6) throw new Error(`maid-whale head: neck seam has ${seam.length} vertices`);

  const cage = headCage();
  // The neck and throat rings (under HEAD_BLEND.from) keep the plan's column.
  const hidden = (p: P3) => (p[2] < HEAD_PLAN.earFront.z - HIDDEN.behind && p[1] > HEAD_BLEND.from) || p[1] > HEAD_BLEND.to;
  const facePoint = new Uint8Array(cage.points.length);
  for (const quad of cage.quads) if (quad.region === 'face-plane') for (const i of quad.ids) facePoint[i] = 1;
  const points = cage.points.map((p, i): P3 => {
    const t = Math.min(1, Math.max(0, (p[1] - HEAD_BLEND.from) / (HEAD_BLEND.to - HEAD_BLEND.from)));
    // Behind the ear-front, low points keep the plan's tapered jaw and nape, then meet the skull over HIDDEN.low-high.
    const b = Math.min(1, Math.max(0, (p[1] - HIDDEN.low) / (HIDDEN.high - HIDDEN.low)));
    const blend = hidden(p) ? (p[1] > HEAD_BLEND.to ? 1 : b * b * (3 - 2 * b)) : t * t * (3 - 2 * t);
    if (blend === 0) return p;
    const c: P3 = [facePoint[i] ? p[0] : 0, Math.min(0.8, Math.max(0.66, p[1])), -0.005];
    const d = norm(sub(p, c));
    const hit = q.value.project([c[0] + 0.3 * d[0], c[1] + 0.3 * d[1], c[2] + 0.3 * d[2]], [-d[0], -d[1], -d[2]], 0.3);
    if (hit === undefined) return p;
    const on: P3 = [hit.point[0] - INSET * d[0], hit.point[1] - INSET * d[1], hit.point[2] - INSET * d[2]];
    return [p[0] + (on[0] - p[0]) * blend, p[1] + (on[1] - p[1]) * blend, p[2] + (on[2] - p[2]) * blend];
  });
  flareNeck(points, seam, cage.boundary);

  const head = model();
  // Each quad tagged with its structure zone: the zone borders (jaw line, face border, centre
  // profile, cheek loop, ear front, hairline) stay facet edges through the remesh.
  for (const quad of cage.quads) {
    const label = quad.region === 'face-plane' ? 'head-face' : 'head-skin';
    head.polygon({ points: quad.ids.map((i) => points[i] as P3), label, material: 'skin', tag: `${ZONE}${quad.zone}` });
  }
  if (seam.length !== cage.boundary) throw new Error(`maid-whale head: neck seam has ${seam.length} vertices, the cage ${cage.boundary} meridians`);
  head.weld({ distance: 1e-7 });
  head.tag(sel.createdBy('head-face'), 'face-plane');
  // The form: the cage's limit surface. The facets are an even tiling of the cage (its neck ring
  // pinned for the seam strip) wrapped onto that surface, so they keep the planned form.
  const smooth = model();
  smooth.append(head);
  smooth.subdivide(sel.all(), { levels: HEAD_FACET.limitLevels });
  // The facets wrap onto the exact limit surface (closed-form limit points), not level 3's net.
  smooth.snapToLimit(sel.all());
  // Tile the character's left half and mirror it, so the two sides are one tiling welded on x = 0.
  head.delete(sel.inBox([-1, -1, -1], [0, 2, 1], { by: 'centroid' }));
  const preserve = { labels: true, boundaries: 'pin', materials: true } as const;
  // The throat rows (the turn into the under-jaw plane) are remeshed one row at a time at a fine edge, so each 18 deg step of the turn stays one facet row. The neck and under-jaw rows are bounded by the pinned neck ring (6-7 mm between points): a finer edge there grades into the cheek facets without slivers.
  const throatRows = Array.from({ length: THROAT_ROWS }, (_, k) => sel.tag(`${ZONE}throat-${k + 1}`));
  const throatZone = throatRows.reduce((all, row) => all.or(row));
  const neckZone = sel.tag(`${ZONE}neck`).or(sel.tag(`${ZONE}under-jaw`));
  for (const row of throatRows) head.remesh(row, { targetEdgeLength: HEAD_FACET.throat, iterations: HEAD_FACET.iterations, preserve });
  head.remesh(neckZone, { targetEdgeLength: HEAD_FACET.neck, iterations: HEAD_FACET.iterations, preserve });
  head.remesh(sel.createdBy('head-skin').minus(neckZone).minus(throatZone), { targetEdgeLength: HEAD_FACET.edge, iterations: HEAD_FACET.iterations, preserve });
  head.remesh(sel.createdBy('head-face'), { targetEdgeLength: HEAD_FACET.face, iterations: HEAD_FACET.iterations, preserve });
  head.shrinkwrap(sel.all(), { onto: smooth });
  const tidy = head.try((t) => t.cleanup.tiling(sel.all(), { maxError: HEAD_FACET.maxError, maxAspect: 3.5, iterations: 20, preserve }));
  if (!tidy.ok && tidy.error.code !== 'model-op-no-effect') throw tidy.error;
  head.mirror({ axis: 'x', weldDistance: 1.5e-3 });
  const mid = head.try((t) => t.cleanup.tiling(sel.all(), { maxError: HEAD_FACET.maxError, maxAspect: 3.5, iterations: 3, preserve }));
  if (!mid.ok && mid.error.code !== 'model-op-no-effect') throw mid.error;
  seamStrip(head, seam, boundaryRing(head, () => true));
  head.weld({ distance: 1e-7 });
  m.append(head, { tag: 'head' });
  m.weld({ distance: 1e-7 });
}
