import { type FaceSelector, type Model, model, SurfaceQuery, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { buildBody, centerOf } from './body.ts';
import { LANDMARK, part } from './reference.ts';

/**
 * How the walls end (G6): with `taper`, every shell and thick layer thins to a crease at its
 * free edges over that distance (no rim strip for the facets to fight), shortened to 0.8 of
 * a narrow part's reach (a cuff band). Without it, the G3 walls with their rims.
 */
export interface GarmentStyle {
  readonly taper?: number;
  /** G6 remodel (facet-plan.json): parts built as the plan's units at facet scale. */
  readonly facets?: boolean;
}

/**
 * Walls kept with their rims in the interim G6 (checkpoint B): tapering the apron bib's
 * corners, the shoe opening and the hair cap at the bang notches folds their nearly coincident
 * walls through each other; the G6 remodel (facet-plan.json) rebuilds those parts and tapers them. The
 * remodel's bib tapers: its outline is knifed with a snap, so no sliver at its corners folds.
 */
export const UNTAPERED: GarmentStyle = {};

/** Run a wall operation with the style's taper (shortened where the part is narrower). */
export function walled(m: Model, style: GarmentStyle, op: (target: Model, taper: { readonly taper?: number }) => void): void {
  if (style.taper === undefined) {
    op(m, {});
    return;
  }
  const taper = style.taper;
  const first = m.try((t) => op(t, { taper }));
  if (first.ok) return;
  const reach = (first.error.detail as { readonly maxTaper?: number } | undefined)?.maxTaper;
  // Any other failure re-runs untried, so the session carries it.
  op(m, reach === undefined ? { taper } : { taper: 0.8 * reach });
}

/**
 * Case C-200 stage G3 (clothing layers, structure-first): every garment is made over
 * the G2 body in the same session, which stays untouched. Close-fitting garments are
 * `layer`s of the body region they cover: a conforming offset copy thickened into a
 * shell whose open rims are the garment's openings, so the seams sit where the cloth
 * meets the body (neck, armholes, wrists, waist) instead of solids crossing it.
 */

const lm = (name: string): number => LANDMARK[name] as number;
const box = (lo: Tuple3, hi: Tuple3) => sel.inBox(lo, hi, { by: 'centroid' });

/**
 * The collar region's half-width: the sheet's funnel collar spans 143 mm, so the dress
 * top's neckline is cut out to here (it was 0.05, which left the wings only the 5 mm flare the top's edge
 * allowed) and the wing stations lie on the shoulder just outside it.
 */
export const COLLAR_REACH = 0.0575;

/**
 * Body regions. Limbs and head grow out of the trunk and inherit its `torso` tag, so
 * the trunk is the torso minus every grown region.
 */
export const REGION = {
  trunk: (): FaceSelector =>
    ['arm-l', 'arm-r', 'hand-l', 'hand-r', 'leg-l', 'leg-r', 'head'].reduce((s, t) => s.minus(sel.tag(t)), sel.tag('torso')),
  /** Collar: the shoulder band around the neck base, the neck column and the lowest head ring (to under the jaw). */
  collar: (): FaceSelector =>
    REGION.trunk()
      .and(box([-COLLAR_REACH, 0.57, -1], [COLLAR_REACH, 1, 1]))
      .or(sel.tag('head').and(box([-1, -1, -1], [1, lm('chin') - 0.008, 1]))),
};

/**
 * Collar: the white standing band around the neck (sheet top 0.619, under the chin),
 * a layer over the collar region, covering the ring ridge where the shoulder band
 * meets the neck. The white over the shoulders on the sheet is the apron bib's frill.
 */
function collar(m: Model, style: GarmentStyle): void {
  if (style.facets === true) {
    // G6: the collar as a facet band on the shoulder band (facetCollar).
    facetCollar(m);
    return;
  }
  // Sheet first (7 mm, outside the dress top's 6 mm), faired and remeshed over the
  // concave ridge, where the conforming sheet squeezes face rows together, then the wall
  // (B11 order: a thick layer folds there).
  m.layer(REGION.collar(), { offset: 0.007, conform: true, label: 'collar', tag: 'collar', material: 'white' });
  m.smooth.implicit(sel.createdBy('collar'), { lambda: 0.5, iterations: 2, pin: ['boundary'] });
  m.remesh(sel.createdBy('collar'), { targetEdgeLength: 0.006, iterations: 3 });
  walled(m, style, (t, taper) => t.shell(sel.createdBy('collar'), { thickness: 0.005, direction: 'out', clamp: true, label: 'collar-wall', ...taper }));
}

/**
 * Puff sleeve: the upper-sleeve band (y), the lattice resolution in the arm's frame
 * (across, along, depth), the outer layer's move (sized to the G1 left-arm outline,
 * outer |x| 0.19 at y 0.48-0.52 and 0.17 at 0.55) and its share at the front and back.
 */
const PUFF = { bottom: 0.455, top: 0.585, resolution: [5, 5, 3] as const, out: 0.09, round: 0.7 } as const;

/**
 * Dress top: bodice and both sleeves as one sheet over the trunk (up to the collar)
 * and the arms (above the cuffs), so the armhole seam is a line on one continuous
 * garment instead of two walls meeting in the concave armpit. Copies keep material
 * slots but not tags, so the arms' source faces carry a sleeve slot through the layer
 * and get their skin back after it. The sheet is faired through the armpits, the
 * upper sleeves are widened into the puffs (their borders are the gathers),
 * the armhole seam is marked, and the sheet (8 mm off the skin) is shelled inward to
 * a 4 mm wall: in the armpit wedge, outward walls would grow into each other.
 */
function dressTop(m: Model, style: GarmentStyle): void {
  const trunk = REGION.trunk().and(box([-1, lm('waist') - 0.04, -1], [1, 1, 1])).minus(REGION.collar());
  for (const side of ['l', 'r'] as const) m.assign(sel.tag(`arm-${side}`), `sleeve-${side}`);
  m.layer(trunk.or(sel.tag('arm-l')).or(sel.tag('arm-r')), { offset: 0.006, conform: true, label: 'top', tag: 'top' });
  m.assign(sel.tag('arm-l').or(sel.tag('arm-r')), 'skin');
  // The armpits are concave tighter than the offset, where the conforming sheet collapses:
  // faired there only (smoothing lifts a valley off the body; on the convex arms it would sink in).
  const armpit = box([0.07, 0.46, -0.03], [0.115, 0.55, 0.03]).or(box([-0.115, 0.46, -0.03], [-0.07, 0.55, 0.03]));
  m.smooth.implicit(sel.createdBy('top').and(armpit), { lambda: 0.5, iterations: 3, pin: ['boundary'] });
  for (const side of ['l', 'r'] as const) {
    const s = side === 'l' ? 1 : -1;
    const tag = `sleeve-${side}`;
    m.tag(sel.createdBy('top').and(sel.material(tag)), tag);
    // Puff: the upper sleeve band turned upright about the arm's midpoint, deformed by a
    // lattice in that frame whose only moved control points are the outer layer's middle
    // rows (so the armpit side and both ends, the gathers, keep their place), and turned
    // back. Depth stays (the side view already matches).
    const band = `puff-${side}`;
    m.tag(sel.tag(tag).and(box([-1, PUFF.bottom, -1], [1, PUFF.top, 1])), band);
    const shoulder = centerOf(m, sel.tag(band).and(box([-1, PUFF.top - 0.015, -1], [1, 1, 1])));
    const elbow = centerOf(m, sel.tag(band).and(box([-1, -1, -1], [1, PUFF.bottom + 0.015, 1])));
    const mid: Tuple3 = [(shoulder[0] + elbow[0]) / 2, (shoulder[1] + elbow[1]) / 2, (shoulder[2] + elbow[2]) / 2];
    const upright = 90 - (Math.atan2(shoulder[1] - elbow[1], shoulder[0] - elbow[0]) * 180) / Math.PI;
    const puff = sel.tag(band);
    m.rotate(puff, 'z', upright, mid);
    const [nx, ny, nz] = PUFF.resolution;
    const outer = s > 0 ? nx - 1 : 0;
    const offsets = [];
    for (let j = 1; j < ny - 1; j++) for (let k = 0; k < nz; k++) offsets.push({ index: [outer, j, k] as const, offset: [s * PUFF.out * (k === 0 || k === nz - 1 ? PUFF.round : 1), 0, 0] as Tuple3 });
    m.lattice(puff, { resolution: PUFF.resolution, offsets });
    m.rotate(puff, 'z', -upright, mid);
    // Gather lines at the armhole and above the elbow.
    m.markSharp(puff.boundary());
  }
  m.tag(sel.createdBy('top').minus(sel.tag('sleeve-l')).minus(sel.tag('sleeve-r')), 'bodice');
  m.markSeam(sel.tag('bodice').boundary().and(sel.tag('sleeve-l').or(sel.tag('sleeve-r')).toEdges('touching')));
  m.assign(sel.createdBy('top'), 'navy');
  walled(m, style, (t, taper) => t.shell(sel.createdBy('top'), { thickness: 0.003, direction: 'in', clamp: true, label: 'top-wall', ...taper }));
}

/**
 * Section of the faces' vertices lying `lo..hi` along the unit `axis` from `origin`,
 * in the plane frame (u, v) through `origin`.
 */
function section(m: Model, faces: FaceSelector, origin: Tuple3, axis: Tuple3, u: Tuple3, v: Tuple3, lo: number, hi: number): [number, number][] {
  const dot = (p: readonly number[], q: readonly number[]) => (p[0] as number) * (q[0] as number) + (p[1] as number) * (q[1] as number) + (p[2] as number) * (q[2] as number);
  const out: [number, number][] = [];
  for (const id of new Set(faces.evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f)))) {
    const p = m.editMesh.position(id);
    const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    const t = dot(d, axis);
    if (t >= lo && t <= hi) out.push([dot(d, u), dot(d, v)]);
  }
  return out;
}

/**
 * `n` points at even angles around the origin (from `phase` of a step) enclosing a section with a clearance:
 * each lies on the polygon of the section's support lines in 64 directions, pushed
 * out by `grow`, along its own ray (even angles keep neighbouring rings in step).
 */
function enclose(points: readonly (readonly [number, number])[], n: number, grow: number, phase = 0): [number, number][] {
  const dirs = Array.from({ length: 64 }, (_, j) => (j / 64) * 2 * Math.PI);
  const support = dirs.map((a) => Math.max(...points.map(([x, y]) => x * Math.cos(a) + y * Math.sin(a))));
  return Array.from({ length: n }, (_, i) => {
    const a = ((i + phase) / n) * 2 * Math.PI;
    const r = Math.min(...dirs.map((b, j) => (Math.cos(a - b) > 0.2 ? ((support[j] as number) + grow) / Math.cos(a - b) : Infinity)));
    return [r * Math.cos(a), r * Math.sin(a)];
  });
}

/** Samples per edge of a band's wrapped faces. */
const BAND_SAMPLES = 4;

/** As `section`, over given points: those within [lo, hi] along the axis, in (u, v). */
function bandSection(points: readonly Tuple3[], origin: Tuple3, axis: Tuple3, u: Tuple3, v: Tuple3, lo: number, hi: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const d: Tuple3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    const t = dot3(d, axis);
    if (t >= lo && t <= hi) out.push([dot3(d, u), dot3(d, v)]);
  }
  return out;
}

/**
 * G6 trim bands (facet-plan.json trims), each columns around and rows along, its end margins and
 * chord sag allowance (facetBand). The cuff ends `short` above the sleeve's end, its bottom ring
 * measuring the sleeve end and the thumb 12 mm past it (at the sleeve's end the left thumb meets
 * the crease). The sock runs from `bottom`, above the instep (a tube cannot wrap the ankle's bend),
 * inside the shoe. The collar is its own construction (facetCollar).
 */
export const TRIM_BANDS = { cuff: { columns: 10, rows: 3, margin: [0.025, 0.012] as const, short: 0.008, sag: 1.5 }, sock: { columns: 10, rows: 3, bottom: 0.075, margin: [0.008, 0.015] as const, sag: 1.5 } } as const;

/** A G6 trim band (facetBand): rows along its axis, columns around, wall and clearance. */
export interface BandSpec {
  /** What the band wraps (its section, measured per row, encloses this). */
  readonly wraps: FaceSelector;
  /** The axis origin and unit direction; the band runs from `from` to `to` along it. */
  readonly origin: Tuple3;
  readonly axis: Tuple3;
  readonly from: number;
  readonly to: number;
  readonly columns: number;
  readonly rows: number;
  /** Inner wall's clearance off the wrapped section, and the wall's thickness. */
  readonly gap: number;
  readonly thickness: number;
  readonly label: string;
  readonly tag: string;
  readonly material: string;
  /** How far past its two ends (from, to) the end rings measure what they wrap (default none). */
  readonly margin?: readonly [number, number];
  /** The chord sag allowance in sags of a circle of the section's radius (default 1). */
  readonly sag?: number;
}

/** G6 trim bands (facet-plan.json trims `bands`): every one carries this tag (no remesh group). */
export const TRIM_BAND = 'trim-band';

/**
 * A trim band built as facets (facet-plan.json trims: bands of 8-12 columns around, tapered
 * free edges), never remeshed. At each of `rows + 1` stations along the axis, the section of what
 * it wraps over the station's half-rows is enclosed by `columns` points at even angles about the
 * section's centre (enclose, as the G3 rows), `gap` plus the chord's sag outside it: the inner
 * ring. The outer ring stands `thickness` out from it, radially, but at the two end stations,
 * where the walls meet in a crease (the tapered free edges). Alternate rings stagger by half a
 * column, so each row is a strip of near-equilateral triangles; the band is one closed label.
 */
export function facetBand(m: Model, b: BandSpec): void {
  const w = b.axis;
  const u0 = (Math.abs(w[1]) < 0.9 ? [w[1], -w[0], 0] : [0, w[2], -w[1]]) as Tuple3;
  const ul = Math.hypot(...u0);
  const a: Tuple3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
  const c: Tuple3 = [w[1] * a[2] - w[2] * a[1], w[2] * a[0] - w[0] * a[2], w[0] * a[1] - w[1] * a[0]];
  const step = (b.to - b.from) / b.rows;
  const at = (o: Tuple3, s: number, x: number, y: number): Tuple3 => [0, 1, 2].map((k) => (o[k] as number) + s * (w[k] as number) + x * (a[k] as number) + y * (c[k] as number)) as Tuple3;
  // What it wraps, sampled along every edge of its faces (large faces cross a slab with no
  // vertex inside it).
  const mesh = m.editMesh;
  const points: Tuple3[] = [];
  for (const f of b.wraps.evaluate(mesh)) {
    const ps = mesh.faceVertices(f).map((x) => mesh.position(x));
    for (const [i, p] of ps.entries()) {
      const q = ps[(i + 1) % ps.length] as number[];
      for (let t = 0; t < BAND_SAMPLES; t++) points.push([0, 1, 2].map((k) => (p[k] as number) + ((q[k] as number) - (p[k] as number)) * (t / BAND_SAMPLES)) as Tuple3);
    }
  }
  const rings: { inner: Tuple3[]; outer: Tuple3[] }[] = [];
  for (let k = 0; k <= b.rows; k++) {
    const s = b.from + step * k;
    // A full row each way, and `margin` past the band's ends: faces with no vertex in a slab, and
    // the wrapped surface just past an end (a widening sleeve), still count.
    const lo = Math.max(-step, b.from - s - (b.margin?.[0] ?? 0));
    const hi = Math.min(step, b.to - s + (b.margin?.[1] ?? 0));
    const local = bandSection(points, at(b.origin, s, 0, 0), w, a, c, lo, hi);
    if (local.length < 3) throw new Error(`${b.label} station ${k} found no section`);
    const [cx, cy] = [local.reduce((t, p) => t + p[0], 0) / local.length, local.reduce((t, p) => t + p[1], 0) / local.length];
    const centred = local.map(([x, y]) => [x - cx, y - cy] as [number, number]);
    const radius = Math.max(...centred.map(([x, y]) => Math.hypot(x, y)));
    const sag = (b.sag ?? 1) * radius * (1 - Math.cos(Math.PI / b.columns));
    // Alternate rings stagger by half a column: near-equilateral triangles of valence 6.
    const ring = enclose(centred, b.columns, b.gap + sag, k / 2);
    const share = k === 0 || k === b.rows ? 0 : 1;
    rings.push({
      inner: ring.map(([x, y]) => at(b.origin, s, x + cx, y + cy)),
      outer: ring.map(([x, y]) => {
        const l = Math.hypot(x, y) || 1;
        const t = b.thickness * share;
        return at(b.origin, s, x + cx + (x / l) * t, y + cy + (y / l) * t);
      }),
    });
  }
  bandMesh(m, rings, b.label, b.tag, b.material);
}

/**
 * A band's closed facet surface from its rings (row by row, each ring `columns` points, ring k + 1
 * half a column ahead of ring k): its outer and inner walls, joined where the rings coincide (the
 * creased free edges); one label, the band's tag and TRIM_BAND.
 */
function bandMesh(m: Model, rings: readonly { readonly inner: readonly Tuple3[]; readonly outer: readonly Tuple3[] }[], label: string, tag: string, material: string): void {
  const columns = (rings[0] as { inner: readonly Tuple3[] }).inner.length;
  const tris: [Tuple3, Tuple3, Tuple3][] = [];
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let j = 0; j < columns; j++) {
      const j1 = (j + 1) % columns;
      for (const wall of ['outer', 'inner'] as const) {
        const [p, q] = [rings[k]?.[wall] as Tuple3[], rings[k + 1]?.[wall] as Tuple3[]];
        // Ring k + 1 sits half a column ahead: q[j] lies between p[j] and p[j + 1].
        const pair: [Tuple3, Tuple3, Tuple3][] = [
          [p[j] as Tuple3, p[j1] as Tuple3, q[j] as Tuple3],
          [p[j1] as Tuple3, q[j1] as Tuple3, q[j] as Tuple3],
        ];
        // The inner wall faces the other way.
        for (const [A, B, C] of pair) tris.push(wall === 'outer' ? [A, B, C] : [B, A, C]);
      }
    }
  }
  const volume = tris.reduce((sum, [p, q, r]) => sum + dot3(p, cross3(q, r)), 0);
  const strip = model();
  for (const [p, q, r] of tris) strip.polygon({ points: volume > 0 ? [p, q, r] : [p, r, q], label, material });
  strip.weld({ distance: 1e-6 });
  m.append(strip, { tag });
  m.tag(sel.createdBy(label), TRIM_BAND);
}

/**
 * G6 collar (facet-plan.json trims collar: the sheet's white collar on the shoulder band, the G3
 * collar's form) as facets. The G3 collar's sheet (a layer `offset` off the collar region) is laid
 * on a scratch copy as the reference; each meridian (a radial plane about the neck axis under the
 * chin, one per column, the middle row's circumference over the plan `edge` rounded up) meets
 * it between its lowest and highest ray hits (rays from the axis at elevations `from` to `to`
 * degrees), and the `rows + 1` stations split that span evenly in elevation: the inner ring. The
 * outer ring stands `thickness` out along the meridian's normal, creased at both free edges.
 */
export const COLLAR_G6 = { offset: 0.007, edge: 0.03, rows: 2, thickness: 0.005, from: -80, to: 20, scan: 100, wing: 0.0255, wingRise: 0.5, wingPower: 4 } as const;

function facetCollar(m: Model): void {
  const C = COLLAR_G6;
  const ref = model();
  ref.append(m.snapshot());
  ref.layer(REGION.collar(), { offset: C.offset, conform: true, label: 'collar-ref', tag: 'collar-ref', material: 'white' });
  const q = SurfaceQuery.of(ref.editMesh, sel.createdBy('collar-ref').evaluate(ref.editMesh));
  if (!q.ok) throw q.error;
  const nb = m.bounds(sel.createdBy('neck'));
  if (!nb.ok) throw nb.error;
  const axis: Tuple3 = [0, lm('chin') - 0.012, (nb.value.min[2] + nb.value.max[2]) / 2];
  const ray = (theta: number, phi: number): Tuple3 => {
    const [t, p] = [theta, (phi * Math.PI) / 180];
    return [Math.sin(t) * Math.cos(p), Math.sin(p), Math.cos(t) * Math.cos(p)];
  };
  const hitAt = (theta: number, phi: number, on = q.value) => {
    const d = ray(theta, phi);
    return on.project(add3(axis, d, 0.3), [-d[0], -d[1], -d[2]], 0.3)?.point;
  };
  // The meridian's span: the lowest and highest elevations whose rays meet the reference.
  const span = (theta: number): [number, number] => {
    const hits = Array.from({ length: C.scan + 1 }, (_, i) => C.from + ((C.to - C.from) * i) / C.scan).filter((phi) => hitAt(theta, phi) !== undefined);
    if (hits.length < 2) throw new Error(`collar meridian ${theta} missed the reference`);
    return [hits[0] as number, hits.at(-1) as number];
  };
  // Wings (the costume sheet): the lower stations at the sides move out along their meridian by up to
  // `wing` (the sheet's 143 mm funnel) and rise by `wingRise` of that, over the shoulder just beyond the
  // neckline cut to COLLAR_REACH. The move fades with the station's height and falls off as sin^wingPower of
  // the meridian's angle, so the front corners (where a wider reach folded the sheet over itself) stay put.
  const point = (theta: number, t: number, wings = true): Tuple3 => {
    const [lo, hi] = span(theta);
    const p = hitAt(theta, lo + (hi - lo) * t);
    if (p === undefined) throw new Error(`collar station ${theta}, ${t} missed the reference`);
    const out = C.wing * Math.abs(Math.sin(theta)) ** C.wingPower * (1 - t);
    return wings ? [p[0] + Math.sin(theta) * out, p[1] + C.wingRise * out, p[2] + Math.cos(theta) * out] : p;
  };
  const probe = Array.from({ length: 24 }, (_, j) => point((j / 24) * 2 * Math.PI, 0.5, false));
  const circumference = probe.reduce((t, p, j) => t + Math.hypot(...sub3(p, probe[(j + 1) % probe.length] as Tuple3)), 0);
  // Columns at most the plan edge apart (9 at the rounded count left the front corners crossing
  // the dress top's edge and aspect p50 2.3).
  const columns = Math.ceil(circumference / C.edge);
  const rings: { inner: Tuple3[]; outer: Tuple3[] }[] = [];
  for (let k = 0; k <= C.rows; k++) {
    const t = k / C.rows;
    const share = k === 0 || k === C.rows ? 0 : 1;
    const inner: Tuple3[] = [];
    const outer: Tuple3[] = [];
    for (let j = 0; j < columns; j++) {
      const theta = ((j + k / 2) / columns) * 2 * Math.PI;
      const p = point(theta, t);
      // The meridian's outward normal: perpendicular to its chord in the radial plane.
      const [a, b] = [point(theta, Math.max(0, t - 0.1)), point(theta, Math.min(1, t + 0.1))];
      const along = unit3(sub3(b, a));
      const radial: Tuple3 = [Math.sin(theta), 0, Math.cos(theta)];
      const n = unit3(add3(radial, along, -dot3(radial, along)));
      inner.push(p);
      outer.push(add3(p, n, C.thickness * share));
    }
    rings.push({ inner, outer });
  }
  bandMesh(m, rings, 'collar', 'collar', 'white');
}

/** Cuff roll: section thickness, clearance off the skin and remesh edge (the clearance/edge pair is a stable neighbourhood: +-0.4 / +-0.5 mm stay clean). */
export const CUFF_SECTION = 0.009;
const CUFF_CLEARANCE = 0.002;
const CUFF_EDGE = 0.005;

/** Cuff roll length along the forearm from the sleeve end's furthest point (the end ring is slanted; the shortest side then matches the sheet's ~0.05) and its overhang past the sleeve end, over the top of the fist. */
const CUFF_LENGTH = 0.06;
const CUFF_OVERHANG = 0.004;

/**
 * Cuff: a thick white roll around the wrist, as on the sheet: the sleeve (which runs to
 * the wrist, so no skin shows) is cut by a knife ring CUFF_LENGTH above its end, giving
 * the roll a clean top rim; the sleeve below the ring is layered CUFF_CLEARANCE off,
 * remeshed and shelled outward CUFF_SECTION thick, and the roll's bottom rim is extruded
 * CUFF_OVERHANG past the sleeve end over the top of the fist, so the sleeve's own rim
 * stays hidden inside.
 */
function cuff(m: Model, side: 'l' | 'r', style: GarmentStyle): void {
  const tag = `cuff-${side}`;
  // The sleeve's outer wall only (the shell's inner wall carries the sleeve tag too).
  const sleeve = sel.tag(`sleeve-${side}`).minus(sel.createdBy('top-wall'));
  // The forearm axis, pointing to the hand, and the sleeve end along it.
  const fore = sel.createdBy(`arm-${side}-fore`);
  const fb = m.bounds(fore);
  if (!fb.ok) throw fb.error;
  const mid = (fb.value.min[1] + fb.value.max[1]) / 2;
  const upper = centerOf(m, fore.and(box([-1, mid, -1], [1, 1, 1])));
  const lower = centerOf(m, fore.and(box([-1, -1, -1], [1, mid, 1])));
  const len = Math.hypot(lower[0] - upper[0], lower[1] - upper[1], lower[2] - upper[2]);
  const w: Tuple3 = [(lower[0] - upper[0]) / len, (lower[1] - upper[1]) / len, (lower[2] - upper[2]) / len];
  const pts = [...new Set(sleeve.evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f)))].map((v) => m.editMesh.position(v));
  const along = (p: readonly number[]) => ((p[0] as number) - lower[0]) * w[0] + ((p[1] as number) - lower[1]) * w[1] + ((p[2] as number) - lower[2]) * w[2];
  const end = Math.max(...pts.map(along));
  const c: Tuple3 = [lower[0] + w[0] * (end - CUFF_LENGTH), lower[1] + w[1] * (end - CUFF_LENGTH), lower[2] + w[2] * (end - CUFF_LENGTH)];
  if (style.facets === true) {
    // G6: the cuff as a facet band (TRIM_BANDS.cuff) around the sleeve's end and the wrist.
    const B = TRIM_BANDS.cuff;
    facetBand(m, { wraps: sleeve.or(fore).or(sel.tag(`hand-${side}`)), origin: lower, axis: w, from: end - CUFF_LENGTH, to: end - B.short, columns: B.columns, rows: B.rows, gap: CUFF_CLEARANCE, thickness: CUFF_SECTION, label: tag, tag, material: "white", margin: B.margin, sag: B.sag });
    return;
  }
  // The knife ring: 16 points just outside the sleeve's section there, snapped onto it.
  const u = (Math.abs(w[1]) < 0.9 ? [w[1], -w[0], 0] : [0, w[2], -w[1]]) as Tuple3;
  const ul = Math.hypot(...u);
  const a: Tuple3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const b: Tuple3 = [w[1] * a[2] - w[2] * a[1], w[2] * a[0] - w[0] * a[2], w[0] * a[1] - w[1] * a[0]];
  const local = section(m, sleeve, c, w, a, b, -0.012, 0.012);
  const [cx, cy] = [local.reduce((t, p) => t + p[0], 0) / local.length, local.reduce((t, p) => t + p[1], 0) / local.length];
  const ring = enclose(local.map(([x, y]) => [x - cx, y - cy] as [number, number]), 16, 0.002).map(([x, y]) => [0, 1, 2].map((k) => (c[k] as number) + (x + cx) * (a[k] as number) + (y + cy) * (b[k] as number)) as Tuple3);
  m.knife({ points: ring, closed: true, faces: sleeve, label: `${tag}-rim` });
  const wrist = sleeve.and(sel.side(c, w, { by: 'centroid' }));
  m.layer(wrist, { offset: CUFF_CLEARANCE, conform: true, label: tag, tag, material: 'white' });
  m.remesh(sel.createdBy(tag), { targetEdgeLength: CUFF_EDGE, iterations: 3 });
  walled(m, style, (t, taper) => t.shell(sel.createdBy(tag), { thickness: CUFF_SECTION, direction: 'out', clamp: true, label: `${tag}-wall`, ...taper }));
  // The rolled lip hangs from the wall's wrist rim; a tapered cuff ends in a crease instead.
  if (style.taper !== undefined) return;
  const bottom = sel.createdBy(`${tag}-wall`, 'rim').and(sel.side([lower[0] + w[0] * (end - 0.01), lower[1] + w[1] * (end - 0.01), lower[2] + w[2] * (end - 0.01)], w, { by: 'centroid' }));
  m.extrude(bottom, { distance: CUFF_OVERHANG, region: 'merged', label: `${tag}-overhang` });
}

/** White hem band top, scanned beside the apron on the sheet (front u +-0.14..0.17 m). */
const HEM_BAND_TOP = 0.22;
/**
 * G6 remodel hem band top: the turnaround drawing measures the band's top at 0.264 front and
 * 0.255 back (0.233 at the side; facet-plan.json skirt), so the remodel's level band takes
 * their middle. The skirt is cut there first, so the band's border is one line.
 */
export const HEM_BAND_TOP_G6 = 0.26;
/**
 * G6 remodel hem band offset off the skirt sheet: past the skirt's 4 mm wall (the shell grows
 * under the band; at 1.5 mm it clamped the wall to 1.4 mm) with a 2.5 mm gap, so facet chords
 * on the wall and the band stay clear of each other (FACET_CLEARANCE) at the plan's facet sizes.
 */
export const HEM_OFFSET_G6 = 0.0065;

/**
 * Skirt bell rows below the hands: [y, half-width x, half-depth z, pleat amplitude] at
 * the sheet's skirt extents (front 0.227, side 0.178 at the hem), with the pleats
 * deepening toward the hem.
 */
const BELL: readonly (readonly [number, number, number, number])[] = [
  // Under the hands (inner edge x 0.166 at y 0.305) the bell stays inside them, as on the sheet.
  [0.3, 0.15, 0.14, 0.02],
  [0.25, 0.2, 0.158, 0.026],
  // A row at the hem band top, so the band's border follows one row of faces.
  [HEM_BAND_TOP, 0.208, 0.162, 0.028],
  [0.19, 0.214, 0.165, 0.03],
  [0.155, 0.22, 0.169, 0.03],
];
const PLEATS = 14;
const SKIRT_POINTS = 56;

/**
 * Skirt: one sheet hanging from the waist (under the waistband) to the hem. Its top rows
 * are the body's own sections at the waist, the dress top's hem and the hips, enclosed
 * with clearance; below them the bell rows flare to the sheet's extents and carry the
 * box pleats. The white hem band is a layer outside the skirt's lower part; then the
 * skirt sheet is shelled outward to its wall, so the waist stays close over the bodice.
 */
function skirt(m: Model, style: GarmentStyle): void {
  const body = REGION.trunk().or(sel.tag('leg-l')).or(sel.tag('leg-r')).or(sel.tag('bodice'));
  const cz = trunkZ(m, lm('waist'));
  const bodyRow = (y: number, grow: number): Tuple3[] =>
    enclose(section(m, body, [0, y, cz], [0, 1, 0], [1, 0, 0], [0, 0, -1], -0.012, 0.012), SKIRT_POINTS, grow).map(([x, z]) => [x, y, cz - z]);
  const bellRow = ([y, a, b, amp]: readonly [number, number, number, number]): Tuple3[] =>
    Array.from({ length: SKIRT_POINTS }, (_, i) => {
      const t = (i / SKIRT_POINTS) * 2 * Math.PI;
      const [c, sn] = [Math.cos(t), Math.sin(t)];
      // G6 remodel: a plain bell; its 8 gores (cutSkirtGores) are the structure instead of the pleats.
      const k = style.facets === true ? 1 : 1 + amp * Math.cos(PLEATS * t);
      return [a * k * Math.sign(c) * Math.abs(c) ** (2 / 2.6), y, cz - b * k * Math.sign(sn) * Math.abs(sn) ** (2 / 2.6)] as Tuple3;
    });
  m.loft({ profiles: [bodyRow(lm('waist'), 0.0015), bodyRow(0.4, 0.004), bodyRow(0.35, 0.02), ...BELL.map(bellRow)], match: 'index', segments: 2, caps: false, label: 'skirt', tag: 'skirt', material: 'navy' });
  const hemTop = style.facets === true ? HEM_BAND_TOP_G6 : HEM_BAND_TOP;
  if (style.facets === true) {
    // A level cut through the sheet at the band's top (a horizontal curtain from the front).
    m.knife({ faces: sel.createdBy('skirt'), points: [[-0.6, hemTop, 0.6], [0.6, hemTop, 0.6]], direction: [0, 0, -1], through: true });
  }
  walled(m, style, (t, taper) => t.layer(sel.createdBy('skirt').and(box([-1, -1, -1], [1, hemTop, 1])), { offset: style.facets === true ? HEM_OFFSET_G6 : 0.0015, thickness: 0.003, conform: true, clamp: true, label: 'skirt-hem', tag: 'skirt-hem', material: 'white', ...taper }));
  walled(m, style, (t, taper) => t.shell(sel.createdBy('skirt'), { thickness: 0.004, direction: 'out', clamp: true, label: 'skirt-wall', ...taper }));
}

/** G6 remodel: the skirt's gores (facet-plan.json skirt), `skirt-gore-<k>` from azimuth 45 k to 45 (k + 1). */
export const SKIRT_GORES = 8;

/**
 * G6 remodel: cuts the gore seams into the skirt and hem (both walls and the tapered ends, not
 * the tail grown from them) where the vertical half-planes about the skirt's axis (x 0, z of
 * the trunk's waist center, as `skirt` builds it) at azimuth 0, 45, ..., 315 cross them, then
 * tags each face with the gore its centroid lies in. The cut leaves the surface where it is;
 * the tag borders are the structure lines the faceting keeps as edges. Azimuth runs from +z
 * toward +x.
 */
export function cutSkirtGores(m: Model): void {
  const skirtFaces = sel.tag('skirt').or(sel.tag('skirt-hem')).minus(sel.tag('tail'));
  const cz = trunkZ(m, lm('waist'));
  const o: Tuple3 = [0, 0, cz];
  const step = 360 / SKIRT_GORES;
  const dir = (deg: number): Tuple3 => [Math.sin((deg * Math.PI) / 180), 0, Math.cos((deg * Math.PI) / 180)];
  // Each seam's plane holds the opposite seam too: one cut through every layer from outside the skirt.
  for (let k = 0; k < SKIRT_GORES / 2; k++) {
    const d = dir(k * step);
    const out = (y: number): Tuple3 => [0.6 * d[0], y, cz + 0.6 * d[2]];
    m.knife({ faces: skirtFaces, points: [out(0.6), out(0)], direction: [-d[0], 0, -d[2]], through: true });
  }
  // The normal of the seam half-plane at azimuth `deg`, toward increasing azimuth (s = 1) or back.
  const ahead = (deg: number, s: number): Tuple3 => {
    const [x, , z] = dir(deg);
    return [s * z, 0, -s * x];
  };
  for (let k = 0; k < SKIRT_GORES; k++) {
    // A wedge narrower than a half turn: past the gore's first seam and short of its second.
    const wedge = sel.side(o, ahead(k * step, 1), { by: 'centroid' }).and(sel.side(o, ahead((k + 1) * step, -1), { by: 'centroid' }));
    m.tag(skirtFaces.and(wedge), `skirt-gore-${k}`);
  }
}

/** Depth center of the trunk at height `y`. */
function trunkZ(m: Model, y: number): number {
  const b = m.bounds(REGION.trunk().and(box([-1, y - 0.01, -1], [1, y + 0.01, 1])));
  if (!b.ok) throw b.error;
  return (b.value.min[2] + b.value.max[2]) / 2;
}

/** Sock bottom, inside the shoe below its opening. */
const SOCK_BOTTOM = 0.045;

/** Sock: the leg from inside the shoe to the sock top (sheet 0.136), 3 mm thick. */
function sock(m: Model, side: 'l' | 'r', style: GarmentStyle): void {
  const tag = `sock-${side}`;
  if (style.facets === true) {
    // G6: the sock as a facet band (TRIM_BANDS.sock) from inside the shoe to the sock top.
    const B = TRIM_BANDS.sock;
    const leg = sel.tag(`leg-${side}`);
    const lb = m.bounds(leg.and(box([-1, B.bottom, -1], [1, lm('sock-top'), 1])));
    if (!lb.ok) throw lb.error;
    const o: Tuple3 = [(lb.value.min[0] + lb.value.max[0]) / 2, 0, (lb.value.min[2] + lb.value.max[2]) / 2];
    facetBand(m, { wraps: leg, origin: o, axis: [0, 1, 0], from: B.bottom, to: lm('sock-top'), columns: B.columns, rows: B.rows, gap: 0.002, thickness: 0.003, label: tag, tag, material: 'white', margin: B.margin, sag: B.sag });
    return;
  }
  // Sheet, remeshed over the concave instep corner, then the wall (as the collar and cuffs).
  m.layer(sel.tag(`leg-${side}`).and(box([-1, SOCK_BOTTOM, -1], [1, lm('sock-top'), 1])), { offset: 0.002, conform: true, label: tag, tag, material: 'white' });
  m.remesh(sel.createdBy(tag), { targetEdgeLength: 0.005, iterations: 3 });
  walled(m, style, (t, taper) => t.shell(sel.createdBy(tag), { thickness: 0.003, direction: 'out', clamp: true, label: `${tag}-wall`, ...taper }));
}

/** Shoe inner clearance around the foot (outside the 6 mm sock); with the 4 mm wall the outside reaches the sheet's half-width (0.056 over the foot's 0.045). */
const SHOE_GROW = 0.007;

/**
 * Mary Jane shoe parts: sole top (the upper's flat bottom), heel block and forefoot sole
 * lengths from the heel and the toe, the toe box's extra clearance, and the opening's
 * margin around the leg and reach forward over the instep, and the wall thickness.
 */
/**
 * G6 remodel: the shoe opening's back edge lies this far in front of the G3 one. The G3 opening
 * reached within 2 mm of the shoe top's back edge, and a tapered wall folded through itself in
 * that strip (8 face pairs at y 0.094, z -0.064, at every taper length); 4 mm in front, the rim
 * tapers to a crease with no crossing and the sock still clears it.
 */
const SHOE_OPENING_BACK_G6 = 0.004;
const SHOE = { sole: 0.02, heel: 0.03, forefoot: 0.05, toeBox: 0.006, margin: 0.007, instep: 0.022, wall: 0.004 } as const;

/**
 * Shoe: an upper of rings along the foot (heel to toe) enclosing the foot and the sock
 * below the strap line (sheet sole-top 0.087) with the clearance, flat-bottomed at the
 * sole top, the toe box fuller at the front; the upper's underside under the heel and
 * under the forefoot is extruded to the ground into the block heel and the sole, with
 * the arch between; the opening around the leg and forward over the instep is
 * knife-projected from above and left open by an outward 4 mm shell.
 */
function shoe(m: Model, side: 'l' | 'r', style: GarmentStyle = {}): void {
  const tag = `shoe-${side}`;
  const top = lm('sole-top');
  const foot = sel.tag(`leg-${side}`).and(box([-1, -1, -1], [1, top, 1]));
  const fb = m.bounds(foot);
  if (!fb.ok) throw fb.error;
  const [x0, y0] = [(fb.value.min[0] + fb.value.max[0]) / 2, (fb.value.min[1] + top) / 2];
  const [z0, z1] = [fb.value.min[2], fb.value.max[2]];
  // Heel and toe at the sheet's side extents (right view u = -z), inside the wall.
  const sd = part('right', 'shoes');
  const [heel, toe] = [-sd.bounds[2] + 0.004, -sd.bounds[0] - 0.004];
  const stations = 6;
  const rings: Tuple3[][] = [];
  for (let i = 0; i <= stations; i++) {
    const z = z0 + ((z1 - z0) * i) / stations;
    // Each ring encloses its slab of the foot and sock; the end rings stand at the heel and the toe.
    const slab = section(m, sel.tag(`leg-${side}`).or(sel.tag(`sock-${side}`)), [x0, y0, z], [0, 0, 1], [1, 0, 0], [0, 1, 0], -(z1 - z0) / stations, (z1 - z0) / stations).filter(([, v]) => v <= top - y0);
    const zr = i === 0 ? Math.min(z0 - SHOE_GROW, heel) : i === stations ? Math.max(z1 + SHOE_GROW, toe) : z;
    const grow = SHOE_GROW + (i >= stations - 1 ? SHOE.toeBox : 0);
    rings.push(enclose(slab, 16, grow).map(([u, v]) => [x0 + u, Math.max(SHOE.sole, y0 + v), zr]));
  }
  m.loft({ profiles: rings, match: 'index', label: tag, tag, material: 'shoe' });
  const under = (za: number, zb: number) => sel.createdBy(tag).and(sel.facing('-y', 20)).and(box([-1, -1, za], [1, SHOE.sole + 0.001, zb]));
  // To the ground under the 4 mm outward wall.
  m.extrude(under(-1, heel + SHOE.heel), { distance: SHOE.sole - SHOE.wall, region: 'merged', label: `${tag}-heel` });
  m.extrude(under(toe - SHOE.forefoot, 1), { distance: SHOE.sole - SHOE.wall, region: 'merged', label: `${tag}-sole` });
  // The opening: an outline around the leg (and the sock on it), reaching forward over the instep.
  const leg = m.bounds(sel.tag(`sock-${side}`).and(box([-1, top, -1], [1, top + 0.01, 1])));
  if (!leg.ok) throw leg.error;
  const [cx, cz] = [(leg.value.min[0] + leg.value.max[0]) / 2, (leg.value.min[2] + leg.value.max[2]) / 2];
  const [rx, rz] = [(leg.value.max[0] - leg.value.min[0]) / 2 + SHOE.margin, (leg.value.max[2] - leg.value.min[2]) / 2 + SHOE.margin];
  const outline: Tuple3[] = Array.from({ length: 20 }, (_, i) => {
    const a = (i / 20) * 2 * Math.PI;
    const forward = Math.cos(a) > 0 ? Math.cos(a) * SHOE.instep : 0;
    // G6: the opening's back stops SHOE_OPENING_BACK_G6 short of the top's back edge.
    const back = style.facets === true && Math.cos(a) < 0 ? -SHOE_OPENING_BACK_G6 * Math.cos(a) : 0;
    return [cx + rx * Math.sin(a), 0.5, cz + (rz + forward + back) * Math.cos(a)];
  });
  m.knife({ points: outline, direction: [0, -1, 0], closed: true, faces: sel.createdBy(tag).and(sel.facing('+y', 80)), label: `${tag}-opening` });
  // G6: the opening's rim tapers to a crease like the other walls (UNTAPERED keeps G3's rim).
  walled(m, style.facets === true ? style : UNTAPERED, (t, taper) => t.shell(sel.createdBy(tag).or(sel.createdBy(`${tag}-heel`)).or(sel.createdBy(`${tag}-sole`)).or(sel.createdBy(`${tag}-opening`)), { thickness: SHOE.wall, direction: 'out', open: sel.createdBy(`${tag}-opening`, 'inside'), label: `${tag}-wall`, ...taper }));
}

/**
 * Apron outlines in the front view (x, y), centred: the panel's U with rounded lower
 * corners from under the waistband, and the ruffle's outer edge along its sides and
 * bottom down to the sheet's apron bottom (0.21).
 */
const APRON_PANEL: readonly (readonly [number, number])[] = [
  [-0.075, 0.42], [-0.092, 0.36], [-0.096, 0.3], [-0.09, 0.262], [-0.072, 0.247], [0, 0.244],
  [0.072, 0.247], [0.09, 0.262], [0.096, 0.3], [0.092, 0.36], [0.075, 0.42],
];
/**
 * G6 remodel: the panel outline drops its two side corners at this height. The cut's corner there
 * met the skirt's rows within 1-3 mm, and the tapered layer's crease kept those short sharp edges
 * through the faceting (6 slivers of aspect 10-24 at the top corners, 4.5 % of the panel); the
 * side runs straight from the waistband to 0.30 instead (at most 6.5 mm inside the G3 outline).
 * The ruffle keeps the G3 outline (panelEdge), under the panel's edge.
 */
const APRON_PANEL_G6_DROP = 0.36;
/** Ruffle: from `top` (below it the bell's upper flank turns too sharply for a flat strip) down the panel's sides and along its bottom; strip width out from the panel edge (raised panels reach `tooth` further), tuck under it, thickness, gap off the skirt, box-pleat panel length, step between panels and pleat lift. */
export const RUFFLE = { top: 0.29, width: 0.026, tooth: 0.007, tuck: 0.002, thickness: 0.0025, gap: 0.0015, panel: 0.012, step: 0.0008, pleat: 0.0025 } as const;
/** Panel offset off the skirt's outer surface (over the ruffle's tucked half: gap + thickness + pleat). */
const APRON_PANEL_OFFSET = 0.012;
/**
 * G6 remodel: the panel's taper, shorter than FACET_TAPER. Near the crease its two walls are
 * closer than the faceting's clearance, where the remesh cannot move them (a band of
 * clearance x taper / thickness: 6.7 mm at 0.04 left slivers along the rim, 3.3 mm here).
 */
const APRON_PANEL_TAPER = 0.02;

/**
 * The panel edge below `top`, from the left side's top around the bottom to the right side's
 * top (front view x, y): its length and the point at a distance along it.
 */
function panelEdge(top: number): { readonly total: number; readonly pointAt: (d: number) => readonly [number, number] } {
  const below = (i: number) => (APRON_PANEL[i] as readonly [number, number])[1] <= top;
  const cross = (i: number, j: number): readonly [number, number] => {
    const [a, b] = [APRON_PANEL[i] as readonly [number, number], APRON_PANEL[j] as readonly [number, number]];
    const t = (top - a[1]) / (b[1] - a[1]);
    return [a[0] + (b[0] - a[0]) * t, top];
  };
  const first = APRON_PANEL.findIndex((_, i) => below(i));
  const last = APRON_PANEL.length - 1 - [...APRON_PANEL].reverse().findIndex((_, i) => below(APRON_PANEL.length - 1 - i));
  const edge = [cross(first - 1, first), ...APRON_PANEL.slice(first, last + 1), cross(last, last + 1)];
  const lengths = edge.slice(1).map((p, i) => Math.hypot(p[0] - (edge[i] as readonly [number, number])[0], p[1] - (edge[i] as readonly [number, number])[1]));
  const total = lengths.reduce((t, l) => t + l, 0);
  const pointAt = (d: number): readonly [number, number] => {
    for (let i = 0; i < lengths.length; i++) {
      const l = lengths[i] as number;
      if (d <= l || i === lengths.length - 1) {
        const [p, q] = [edge[i] as readonly [number, number], edge[i + 1] as readonly [number, number]];
        const t = Math.min(1, d / l);
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      }
      d -= l;
    }
    return edge.at(-1) as readonly [number, number];
  };
  return { total, pointAt };
}

/**
 * Apron skirt: the panel outline is knife-projected from the front onto the skirt (snapped
 * to nearby vertices: slivers fold the offset) and the faces inside the U are layered
 * APRON_PANEL_OFFSET off it. The ruffle is a flat frill
 * on the skirt: a strip along the panel's edge (its sides from RUFFLE.top and its
 * bottom), tucked RUFFLE.tuck under the panel's edge: a loft of sections at
 * stations along the edge. Each station is the skirt
 * surface point under the edge lifted RUFFLE.gap along its normal; the strip runs in box-
 * pleat panels, every other one lifted RUFFLE.pleat and reaching RUFFLE.tooth further, with
 * short steps between, so the bottom edge reads as stepped teeth. Each section spans the
 * chord to the surface point it reaches, so the strip lies on the cloth to its ends.
 */
function apronSkirt(m: Model, style: GarmentStyle): void {
  const sheet = sel.createdBy('skirt', 'side').and(box([-1, -1, 0], [1, 1, 1]));
  // G6: the outline without its side corners at 0.36 (APRON_PANEL_G6_DROP).
  const outline = style.facets === true ? APRON_PANEL.filter(([, y]) => y !== APRON_PANEL_G6_DROP) : APRON_PANEL;
  m.knife({ points: outline.map(([x, y]) => [x, y, 0.5] as Tuple3), direction: [0, 0, -1], closed: true, through: true, snap: 0.004, faces: sheet, label: 'apron-panel' });
  const panel = sel.createdBy('apron-panel', 'inside');
  walled(m, style.facets === true ? { ...style, taper: APRON_PANEL_TAPER } : style, (t, taper) => t.layer(panel, { offset: APRON_PANEL_OFFSET, thickness: 0.003, conform: true, clamp: true, label: 'apron', tag: 'apron', material: 'white', ...taper }));
  // The outermost cloth under the ruffle: the skirt (some faces carry the cut's label) and the hem band.
  const skirtFront = sel.createdBy('skirt', 'side').or(sel.createdBy('apron-panel')).or(sel.createdBy('skirt-hem'));
  const q = SurfaceQuery.of(m.editMesh, skirtFront.evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  if (style.facets === true) {
    const over = SurfaceQuery.of(m.editMesh, sel.tag('apron').evaluate(m.editMesh));
    if (!over.ok) throw over.error;
    ruffleTeeth(m, q.value, over.value);
    return;
  }
  // The panel edge below RUFFLE.top, from the left side's top around the bottom to the right side's top.
  const { total, pointAt } = panelEdge(RUFFLE.top);
  // Box-pleat panels RUFFLE.panel long along the edge, each a pair of stations just inside
  // its ends, so the change between panels is a short step (the teeth).
  const panels = Math.max(1, Math.round(total / RUFFLE.panel));
  const stations: { readonly at: readonly [number, number]; readonly d: number; readonly raised: boolean }[] = [];
  for (let k = 0; k < panels; k++) {
    const [d0, d1] = [(total * k) / panels, (total * (k + 1)) / panels];
    for (const d of [d0 + RUFFLE.step / 2, d1 - RUFFLE.step / 2]) stations.push({ at: pointAt(d), d, raised: k % 2 === 1 });
  }
  const onCloth = ([x, y]: readonly [number, number]) => {
    const h = q.value.project([x, y, 0.5], [0, 0, -1], 1);
    if (h === undefined) throw new Error(`ruffle station (${x}, ${y}) missed the skirt`);
    return h;
  };
  const hits = stations.map(({ at }) => onCloth(at));
  // Tangents over +-6 mm of the edge, so stations on both sides of a corner turn smoothly.
  const tangents = stations.map(({ d }) => {
    const [p, n] = [onCloth(pointAt(Math.max(0, d - 0.006))).point, onCloth(pointAt(Math.min(total, d + 0.006))).point];
    return [n[0] - p[0], n[1] - p[1], n[2] - p[2]] as Tuple3;
  });
  // Explicit sections along the chord from the station to the surface point RUFFLE.width out
  // (across = tangent x normal, then onto the surface), so the strip lies on the cloth.
  const unit = (v: readonly number[]): Tuple3 => {
    const l = Math.hypot(v[0] as number, v[1] as number, v[2] as number);
    return [(v[0] as number) / l, (v[1] as number) / l, (v[2] as number) / l];
  };
  const cross3 = (a: Tuple3, b: Tuple3): Tuple3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sections = hits.map((h, i) => {
    const c = h.point as Tuple3;
    const t = unit(tangents[i] as Tuple3);
    const a0 = cross3(t, h.normal as Tuple3);
    const out = q.value.nearest([c[0] + a0[0] * RUFFLE.width, c[1] + a0[1] * RUFFLE.width, c[2] + a0[2] * RUFFLE.width])?.point ?? c;
    const a = unit([out[0] - c[0], out[1] - c[1], out[2] - c[2]]);
    const n = unit(cross3(a, t));
    const raised = (stations[i] as { readonly raised: boolean }).raised;
    // Lifted clear of the highest cloth under the strip (the hem band's step, the bell's flanks).
    const above = Math.max(
      0,
      ...[-RUFFLE.tuck, ...Array.from({ length: 13 }, (_, j) => j / 12)].map((f) => {
        const u = f <= 0 ? f : f * (RUFFLE.width + RUFFLE.tooth);
        // Cast in from outside: a nearest query from inside the hem band finds its inner wall.
        const s = q.value.project([c[0] + a[0] * u + n[0] * 0.05, c[1] + a[1] * u + n[1] * 0.05, c[2] + a[2] * u + n[2] * 0.05], [-n[0], -n[1], -n[2]], 0.05)?.point ?? c;
        return (s[0] - c[0]) * n[0] + (s[1] - c[1]) * n[1] + (s[2] - c[2]) * n[2];
      }),
    );
    const d = RUFFLE.gap + above + (raised ? RUFFLE.pleat : 0);
    // Narrower down the sides, where the bell turns toward the back under the strip.
    const reach = (RUFFLE.width + (raised ? RUFFLE.tooth : 0)) * (1 - 0.4 * Math.abs(t[1]));
    const at = (u: number, v: number): Tuple3 => [0, 1, 2].map((k) => (c[k] as number) + (a[k] as number) * u + (n[k] as number) * (d + v)) as Tuple3;
    // +u points away from the panel (tangent x normal along the edge's direction).
    return [at(-RUFFLE.tuck, 0), at(reach, 0), at(reach, RUFFLE.thickness), at(-RUFFLE.tuck, RUFFLE.thickness)];
  });
  m.loft({ profiles: sections, match: 'index', label: 'apron-ruffle', tag: 'apron-ruffle', material: 'white' });
}

const add3 = (p: readonly number[], v: readonly number[], k = 1): Tuple3 => [(p[0] as number) + (v[0] as number) * k, (p[1] as number) + (v[1] as number) * k, (p[2] as number) + (v[2] as number) * k];
const sub3 = (a: readonly number[], b: readonly number[]): Tuple3 => [(a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number), (a[2] as number) - (b[2] as number)];
const dot3 = (a: readonly number[], b: readonly number[]) => (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);
const cross3 = (a: readonly number[], b: readonly number[]): Tuple3 => {
  const [ax, ay, az, bx, by, bz] = [a[0], a[1], a[2], b[0], b[1], b[2]] as number[] as [number, number, number, number, number, number];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
};
const unit3 = (v: readonly number[]): Tuple3 => {
  const l = Math.hypot(v[0] as number, v[1] as number, v[2] as number) || 1;
  return [(v[0] as number) / l, (v[1] as number) / l, (v[2] as number) / l];
};

/** A facet-scale unit's line: across offset `u`, height `v` and phase along the unit (in segments). */
interface UnitLine {
  readonly u: number;
  readonly v: number;
  readonly phase: number;
}

/**
 * A closed unit (a ruffle tooth, a frill unit) tiled at facet scale, the few acute facets per
 * face, never remeshed. Its section is the triangle of lines B (outer edge, on the cloth), C
 * (ridge) and A (inner edge, on the cloth), with N between A and B on the back; each line has a
 * vertex every `seg` from its own phase, so each strip between two lines is a run of
 * parallelograms split along their short diagonals. The phases (B and N 0, A 1/3, C 1/2) make
 * every triangle acute or near it and every vertex of valence 4-6 (a prism split the plain way
 * leaves right triangles, aspect 2 and over, and valence-3 corners); staggered phases (A with B
 * at 0, N with C at 1/2) put each triangle's long edge along the unit (the flow), with the start
 * split along A-B so every end vertex keeps valence 4. The two ends, each two triangles, are the
 * unit's short sides. `at` maps (distance along, across, height) to the model.
 */
function facetUnit(target: Model, at: (s: number, u: number, v: number) => Tuple3, s0: number, seg: number, n: number, lines: Readonly<Record<'A' | 'B' | 'C' | 'N', UnitLine>>, label: string, material = 'white'): void {
  type Name = keyof typeof lines;
  const line = (l: Name) => lines[l];
  const p = (l: Name, k: number) => at(s0 + (lines[l].phase + k) * seg, lines[l].u, lines[l].v);
  const tris: [Tuple3, Tuple3, Tuple3][] = [];
  const strip = (x: Name, y: Name) => {
    for (let k = 0; k < n; k++) {
      if (lines[y].phase >= lines[x].phase) tris.push([p(x, k), p(x, k + 1), p(y, k)], [p(x, k + 1), p(y, k + 1), p(y, k)]);
      else tris.push([p(x, k), p(x, k + 1), p(y, k + 1)], [p(x, k), p(y, k + 1), p(y, k)]);
    }
  };
  strip('B', 'C');
  strip('C', 'A');
  strip('A', 'N');
  strip('N', 'B');
  // The start: staggered lines (A in step with B, N with C) split it along A-B, which keeps
  // every end vertex at valence 4 or more; the end along N-C.
  if (line('A').phase === line('B').phase) tris.push([p('A', 0), p('N', 0), p('B', 0)], [p('A', 0), p('B', 0), p('C', 0)]);
  else tris.push([p('A', 0), p('N', 0), p('C', 0)], [p('N', 0), p('B', 0), p('C', 0)]);
  tris.push([p('A', n), p('C', n), p('N', n)], [p('N', n), p('C', n), p('B', n)]);
  // Outward: the triangles' signed volume decides the winding.
  const volume = tris.reduce((sum, [a, b, c]) => sum + dot3(a, cross3(b, c)), 0);
  for (const [a, b, c] of tris) target.polygon({ points: volume > 0 ? [a, b, c] : [a, c, b], label, material });
}

/**
 * G6 ruffle (facet-plan.json apron `ruffle`: a repeated unit arrayed along the hem's U):
 * box teeth along the panel edge below `top`, `gap` apart, each a facet-scale unit (facetUnit)
 * of 12 triangles: the back on the cloth (`lift` off the highest cloth under it) from `tuck`
 * under the panel to `reach` out, a ridge `depth` high just `ridge` outside the panel's edge (so
 * it stands proud of the panel while its hidden slope stays under the panel's inner wall), the
 * flat front from the ridge to the hem and the two short sides. Alternate teeth reach further and
 * stand deeper (the sheet's stepped hem). The tooth width is the sheet's apron front width over
 * the `across` teeth drawn across it, the count the whole teeth that fit along the edge. Where
 * the edge turns, the field between neighbouring teeth turns on the mitre of their frames. Each
 * tooth is its own label (`apron-ruffle-<k>`).
 */
export const TEETH = { across: 9, top: 0.38, gap: 0.005, reach: [0.018, 0.028], depth: [0.008, 0.013], tuck: 0.016, ridge: [0.004, 0.006, 0.008, 0.01], lift: 0.0015, panelClearance: 0.0015 } as const;

/**
 * The sheet's apron front width: its front bounds are skewed (x -0.1511..0.1018, centred at
 * -0.032 while the skirt hem's centre is +0.0034: the left edge takes in other white pixels), so
 * the right half mirrored about the skirt hem's centre, 2 (0.1018 - 0.0034) = 0.197.
 */
export function apronFrontWidth(): number {
  return 2 * (part('front', 'apron').bounds[2] - part('front', 'skirt-hem').center[0]);
}

/** The ruffle's tooth count: the whole teeth of the sheet's width that fit along the edge below TEETH.top. */
export function ruffleTeethCount(): number {
  return Math.floor(panelEdge(TEETH.top).total / (apronFrontWidth() / TEETH.across));
}

/**
 * The ruffle teeth's borders on the cloth (`q`, the skirt front) and each tooth's frame: `n` off
 * the cloth, `a` away from the panel (t runs from the left side's top around the bottom).
 */
function toothFrames(q: SurfaceQuery) {
  const { total, pointAt } = panelEdge(TEETH.top);
  const count = ruffleTeethCount();
  const pitch = total / count;
  const onCloth = ([x, y]: readonly [number, number]) => {
    const h = q.project([x, y, 0.5], [0, 0, -1], 1);
    if (h === undefined) throw new Error(`ruffle tooth point (${x}, ${y}) missed the skirt`);
    return h;
  };
  const borders = Array.from({ length: count + 1 }, (_, k) => onCloth(pointAt(k * pitch)));
  const frames = Array.from({ length: count }, (_, k) => {
    const [h0, h1] = [borders[k] as { point: Tuple3; normal: Tuple3 }, borders[k + 1] as { point: Tuple3; normal: Tuple3 }];
    const t = unit3(sub3(h1.point, h0.point));
    const nAvg = add3(h0.normal, h1.normal);
    const n = unit3(add3(nAvg, t, -dot3(nAvg, t)));
    return { n, a: cross3(t, n) };
  });
  return { borders, frames };
}

/**
 * The ruffle teeth's axes (facet-plan.json apron ruffle, flow `path` "apron-ruffle-*"): each tooth
 * down its own middle, from TEETH.tuck under the panel's edge out to its longer reach.
 */
export function ruffleToothAxes(m: Model): { readonly faces: FaceSelector; readonly curve: readonly Tuple3[] }[] {
  const cloth = sel.createdBy('skirt', 'side').or(sel.createdBy('apron-panel')).or(sel.createdBy('skirt-hem')).or(sel.tag('skirt'));
  const q = SurfaceQuery.of(m.editMesh, cloth.evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  const { borders, frames } = toothFrames(q.value);
  return frames.map(({ a }, k) => {
    const mid = add3((borders[k] as { point: Tuple3 }).point, sub3((borders[k + 1] as { point: Tuple3 }).point, (borders[k] as { point: Tuple3 }).point), 0.5);
    return { faces: sel.createdBy(`apron-ruffle-${k}`), curve: [add3(mid, a, -TEETH.tuck), add3(mid, a, Math.max(...TEETH.reach))] };
  });
}

function ruffleTeeth(m: Model, q: SurfaceQuery, panel: SurfaceQuery): void {
  const { total } = panelEdge(TEETH.top);
  const count = ruffleTeethCount();
  const pitch = total / count;
  const width = pitch - TEETH.gap;
  const { borders, frames } = toothFrames(q);
  // Each border plane: the neighbours' mean normal and the mitre of their outward directions.
  const planes = borders.map(({ point }, k) => {
    const [f0, f1] = [frames[k - 1] ?? frames[k], frames[k] ?? frames[k - 1]] as [(typeof frames)[number], (typeof frames)[number]];
    const n = unit3(add3(f0.n, f1.n));
    const b = add3(f0.a, f1.a);
    const dir = unit3(add3(b, n, -dot3(b, n)));
    // Distances out from the panel edge are measured along the neighbours' mean outward direction.
    return { p: point, n, dir, scale: (dot3(dir, f0.a) + dot3(dir, f1.a)) / 2 };
  });
  // The field along the edge: `s` along it, `u` out from it, `v` up off the cloth (plus `base`).
  const field = (base: number) => (s: number, u: number, v: number): Tuple3 => {
    const j = Math.max(0, Math.min(count - 1, Math.floor(s / pitch)));
    const f = s / pitch - j;
    const [e0, e1] = [planes[j], planes[j + 1]] as [(typeof planes)[number], (typeof planes)[number]];
    const mix = (x: Tuple3, y: Tuple3) => add3(x, sub3(y, x), f);
    const [p, n, dir, scale] = [mix(e0.p, e1.p), unit3(mix(e0.n, e1.n)), unit3(mix(e0.dir, e1.dir)), e0.scale + (e1.scale - e0.scale) * f];
    return add3(add3(p, dir, u / scale), n, base + v);
  };
  const strip = model();
  for (const [k, { n }] of frames.entries()) {
    const raised = k % 2;
    const reach = TEETH.reach[raised] as number;
    const s0 = k * pitch + TEETH.gap / 2;
    // The footprint: the tooth's lines span 1.5 widths along the edge (their phases).
    const foot = (i: number, u: number) => field(0)(s0 + (1.5 * width * i) / 6, u, 0);
    // The back clears the highest cloth under the tooth (pleats, the hem band's step), and
    // the hidden slope stays under the panel's inner wall: rays along n over the footprint.
    const grid: { u: number; cloth: number; panel: number | undefined }[] = [];
    for (let i = 0; i <= 6; i++) {
      for (let j = 0; j <= 12; j++) {
        const u = -TEETH.tuck + ((TEETH.tuck + reach) * j) / 12;
        const at = foot(i, u);
        const c = q.project(add3(at, n, 0.05), [-n[0], -n[1], -n[2]], 0.08);
        const cloth = c === undefined ? 0 : dot3(sub3(c.point, at), n);
        const w = panel.project(add3(at, n, 0.0005), n, 0.05);
        const above = w === undefined ? undefined : dot3(sub3(w.point, at), n);
        grid.push({ u, cloth, panel: above === undefined || above < 0 ? undefined : above });
      }
    }
    const base = Math.max(0, ...grid.map((g) => g.cloth)) + TEETH.lift;
    const target = TEETH.depth[raised] as number;
    const height = (u: number, ridge: number) => (u <= ridge ? (u + TEETH.tuck) / (TEETH.tuck + ridge) : (reach - u) / (reach - ridge));
    const fit = (ridge: number) =>
      Math.min(target, ...grid.filter((g) => g.panel !== undefined && height(g.u, ridge) > 0).map((g) => ((g.panel as number) - TEETH.panelClearance - base) / height(g.u, ridge)));
    // Then every point of its two upper slopes keeps the clearance off the panel (its tapered
    // rim reaches past the outline by the knife's snap, between the rays).
    const clear = (ridge: number, depth: number) => {
      for (let i = 0; i <= 6; i++) {
        for (let j = 0; j <= 16; j++) {
          const u = -TEETH.tuck + ((TEETH.tuck + reach) * j) / 16;
          const near = panel.nearest(add3(foot(i, u), n, base + depth * height(u, ridge)));
          if (near !== undefined && near.distance < 2 * TEETH.panelClearance) return false;
        }
      }
      return true;
    };
    const fitted = (ridge: number) => {
      let depth = fit(ridge);
      while (depth > 0.5 * target && !clear(ridge, depth)) depth *= 0.92;
      return depth;
    };
    // The ridge as close to the panel's edge as lets the tooth stand its depth.
    const ridge = TEETH.ridge.find((r) => fitted(r) >= 0.9 * target) ?? TEETH.ridge.reduce((x, y) => (fitted(y) > fitted(x) ? y : x));
    const depth = fitted(ridge);
    const lines = {
      B: { u: reach, v: 0, phase: 0 },
      C: { u: ridge, v: depth, phase: 1 / 2 },
      A: { u: -TEETH.tuck, v: 0, phase: 1 / 3 },
      N: { u: (reach - TEETH.tuck) / 2, v: 0, phase: 0 },
    } as const;
    facetUnit(strip, field(base), s0, width, 1, lines, `apron-ruffle-${k}`);
  }
  strip.weld({ distance: 1e-6 });
  m.append(strip, { tag: 'apron-ruffle' });
}

/** Bib half-width: the panel between its frills. */
const BIB_HALF = 0.052;

/** Bib frill: centre |x| at the shoulder and inset inside the bodice below, height where it turns over the shoulder, width, thickness, gap off the dress, station step and pleat depth. */
const FRILL = { x: 0.075, inset: 0.016, turn: 0.54, width: 0.022, thickness: 0.003, gap: 0.007, step: 0.008, depth: 0.003 } as const;

/**
 * Bib and frills: the bib's rectangle is knife-projected onto the dress top and layered
 * over the chest from the waistband to below the collar. Beside each side a frill runs from the waistband up the chest, over the
 * shoulder and down the back, lying on the dress top beside the bib as the sheet draws
 * it: a flat
 * strip swept along the dress surface (projected from the front and the back, and by
 * rays from a centre inside the chest over the shoulder), whose rotation-minimizing
 * frames keep it on the cloth over the shoulder; every other station stands out into the box pleats.
 */
/** The frill's path on side `s` (stations every FRILL.step from the waistband up the chest and over the shoulder's crest, not down the back). */
function frillPath(m: Model, q: SurfaceQuery, s: 1 | -1): Tuple3[] {
  const w = part('front', 'waistband');
  const top = sel.createdBy('top').minus(sel.tag('sleeve-l')).minus(sel.tag('sleeve-r'));
  // The frills end on the waistband's top edge.
  const end = w.bounds[3] + 0.004;
  // Front and back: the frill's centre starts FRILL.inset inside the bodice's half-width at
  // the waist (narrower than the shoulders), hit along -z / +z.
  const across = (y: number) => {
    const b = m.bounds(top.and(box([-1, y - 0.012, -1], [1, y + 0.012, 1])).and(sel.side([0, 0, 0], [s, 0, 0], { by: 'centroid' })));
    if (!b.ok) throw b.error;
    return s * Math.min(FRILL.x, Math.max(s * b.value.max[0], s * b.value.min[0]) - FRILL.inset);
  };
  const along = (x: number, y: number, dz: number): Tuple3 => {
    const h = q.project([x, y, 0.5 * dz], [0, 0, -dz], 1);
    if (h === undefined) throw new Error(`frill station (${x}, ${y}) missed the dress top`);
    return h.point;
  };
  // Over the shoulder: rays in the plane x = +-FRILL.x from a centre inside the chest, to just past the shoulder's crest.
  const c: Tuple3 = [s * FRILL.x, 0.5, trunkZ(m, 0.5)];
  const over = (a: number): Tuple3 => {
    const [dy, dz] = [Math.sin(a), Math.cos(a)];
    const h = q.project([c[0], c[1] + 0.3 * dy, c[2] + 0.3 * dz], [0, -dy, -dz], 0.4);
    if (h === undefined) throw new Error(`frill ray at ${a} missed the dress top`);
    return h.point;
  };
  const turn = FRILL.turn;
  // x runs straight from the waist inset to the shoulder line, so the strip does not kink sideways.
  const xw = across(end);
  const xAt = (y: number) => xw + ((s * FRILL.x - xw) * (y - end)) / (turn - end);
  const ys = Array.from({ length: 13 }, (_, i) => end + ((turn - end) * i) / 12);
  const shoulder = Array.from({ length: 13 }, (_, i) => over(Math.PI / 4 + (Math.PI / 4 + 0.15) * (i / 12))).filter((p) => p[1] > turn);
  const surface = [...ys.map((y) => along(xAt(y), y, 1)), ...shoulder];
  // Resample by arc length every FRILL.step, keeping the ends at the waistband.
  const keep = surface;
  const path: Tuple3[] = [];
  let carry = 0;
  for (let i = 0; i + 1 < keep.length; i++) {
    const [a, b] = [keep[i] as Tuple3, keep[i + 1] as Tuple3];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    for (let t = carry; t < l; t += FRILL.step) path.push([0, 1, 2].map((k) => (a[k] as number) + ((b[k] as number) - (a[k] as number)) * (t / l)) as Tuple3);
    carry = (carry - l) % FRILL.step;
    if (carry < 0) carry += FRILL.step;
  }
  path.push(keep.at(-1) as Tuple3);
  return path;
}

/** The frill curves (facet-plan.json apron frills, flow `path` "frill curves"): each side's path and its units. */
export function frillCurves(m: Model): { readonly faces: FaceSelector; readonly curve: readonly Tuple3[] }[] {
  const top = sel.createdBy('top').minus(sel.tag('sleeve-l')).minus(sel.tag('sleeve-r'));
  const q = SurfaceQuery.of(m.editMesh, top.evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  return ([1, -1] as const).map((s) => ({ faces: sel.tag(`apron-frill-${s > 0 ? 'l' : 'r'}`), curve: frillPath(m, q.value, s) }));
}

/** The ruffle's curve (facet-plan.json apron ruffle, flow `path` "apron hem curve"): the panel edge below TEETH.top on the cloth. */
export function ruffleCurves(m: Model): { readonly faces: FaceSelector; readonly curve: readonly Tuple3[] }[] {
  const cloth = sel.createdBy('skirt', 'side').or(sel.createdBy('apron-panel')).or(sel.createdBy('skirt-hem')).or(sel.tag('skirt'));
  const q = SurfaceQuery.of(m.editMesh, cloth.evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  const { total, pointAt } = panelEdge(TEETH.top);
  const curve: Tuple3[] = [];
  for (let i = 0; i <= 80; i++) {
    const [x, y] = pointAt((total * i) / 80);
    const h = q.value.project([x, y, 0.5], [0, 0, -1], 1);
    if (h !== undefined) curve.push(h.point);
  }
  return [{ faces: sel.tag('apron-ruffle'), curve }];
}

function apronBib(m: Model, style: GarmentStyle): void {
  const w = part('front', 'waistband');
  const top = sel.createdBy('top').minus(sel.tag('sleeve-l')).minus(sel.tag('sleeve-r'));
  const bib: Tuple3[] = [[-BIB_HALF, w.bounds[3] - 0.005, 0.5], [BIB_HALF, w.bounds[3] - 0.005, 0.5], [BIB_HALF, 0.565, 0.5], [-BIB_HALF, 0.565, 0.5]];
  m.knife({ points: bib, direction: [0, 0, -1], closed: true, faces: top.and(box([-1, -1, 0], [1, 1, 1])), label: 'apron-bib-outline', ...(style.facets === true ? { snap: 0.004 } : {}) });
  walled(m, style.facets === true ? style : UNTAPERED, (t, taper) => t.layer(sel.createdBy('apron-bib-outline', 'inside'), { offset: 0.003, thickness: 0.003, conform: true, clamp: true, label: 'apron-bib', tag: 'apron-bib', material: 'white', ...taper }));
  const q = SurfaceQuery.of(m.editMesh, top.evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  for (const s of [1, -1] as const) {
    const path = frillPath(m, q.value, s);
    if (style.facets === true) {
      frillUnits(m, q.value, path, s);
      continue;
    }
    // Lift the stations off the dress along the surface normal there: the gap, and the pleat depth on every other one.
    const lifted = path.map((p, i) => {
      // The surface normal within the strip's vertical plane.
      const n = q.value.nearest(p)?.normal ?? [0, 0, 1];
      const l = Math.hypot(n[1], n[2]) || 1;
      const d = (FRILL.gap + (i % 2) * FRILL.depth) / l;
      return [p[0], p[1] + n[1] * d, p[2] + n[2] * d] as Tuple3;
    });
    const tag = `apron-frill-${s > 0 ? 'l' : 'r'}`;
    m.sweep({ profile: [[-FRILL.width / 2, 0], [FRILL.width / 2, 0], [FRILL.width / 2, FRILL.thickness], [-FRILL.width / 2, FRILL.thickness]], path: lifted, up: [0, 0, 1], label: tag, tag, material: 'white' });
  }
}

/**
 * G6 frills (facet-plan.json apron `frills`): each strip is `count` facet-scale units
 * (facetUnit) along its path, `gap` apart, two segments each (20 triangles), following the
 * shoulder: the back FRILL.gap off the highest dress under it, a ridge `ridge` in from the bib
 * side, and the outer slope down to the far edge. Alternate units stand deeper (the box
 * pleats). Each unit is its own label (`apron-frill-<i>`, the left strip 0-6, the right 7-13).
 */
// G6: 6 units a side, ridge 9 mm in from the bib side: with the units' lines staggered half a
// segment (A in step with B, the ridge C with the back N) their long edges run along the path
// (flow p75 4.4); 7 a side ran 24 (the segments shorter than the strips are wide), 8 ran over
// the 0.022 band (8597 per m2).
export const FRILL_UNITS = { count: 4, segments: 2, gap: 0.005, depth: [0.008, 0.012], ridge: 0.009 } as const;

function frillUnits(m: Model, q: SurfaceQuery, path: readonly Tuple3[], s: number): void {
  const along = [0];
  for (let i = 1; i < path.length; i++) along.push((along[i - 1] as number) + Math.hypot(...sub3(path[i] as Tuple3, path[i - 1] as Tuple3)));
  const total = along.at(-1) as number;
  const at = (d: number): Tuple3 => {
    const next = along.findIndex((x) => x > d);
    const i = next < 0 ? path.length - 2 : Math.max(0, next - 1);
    const [a, b] = [path[i] as Tuple3, path[i + 1] as Tuple3];
    const f = Math.min(1, Math.max(0, (d - (along[i] as number)) / Math.max(1e-9, (along[i + 1] as number) - (along[i] as number))));
    return add3(a, sub3(b, a), f);
  };
  // The field along the strip: `d` along the path, `u` across (+ away from the bib), `v` up off
  // the dress, over FRILL.gap above the highest dress across the strip.
  const field = (d: number, u: number, v: number): Tuple3 => {
    const p = at(d);
    const t = unit3(sub3(at(Math.min(total, d + 0.004)), at(Math.max(0, d - 0.004))));
    const raw = q.nearest(p)?.normal ?? [0, 0, 1];
    const n = unit3(add3(raw, t, -dot3(raw, t)));
    let a = cross3(t, n);
    if (a[0] * s < 0) a = [-a[0], -a[1], -a[2]];
    let lift = 0;
    for (let j = 0; j <= 6; j++) {
      const o = add3(p, a, FRILL.width * (j / 6 - 0.5));
      const hit = q.project(add3(o, n, 0.05), [-n[0], -n[1], -n[2]], 0.08);
      if (hit !== undefined) lift = Math.max(lift, dot3(sub3(hit.point, p), n));
    }
    return add3(add3(p, a, u), n, lift + FRILL.gap + v);
  };
  const { count, segments, gap } = FRILL_UNITS;
  // Each unit's half-phase lines (ridge and back) reach half a segment past its other lines, inside its span.
  const span = (total - (count - 1) * gap) / count;
  const first = s > 0 ? 0 : count;
  const strip = model();
  for (let k = 0; k < count; k++) {
    const lines = {
      B: { u: FRILL.width / 2, v: 0, phase: 0 },
      C: { u: -FRILL.width / 2 + FRILL_UNITS.ridge, v: FRILL_UNITS.depth[k % 2] as number, phase: 1 / 2 },
      A: { u: -FRILL.width / 2, v: 0, phase: 0 },
      N: { u: 0, v: 0, phase: 1 / 2 },
    } as const;
    facetUnit(strip, field, k * (span + gap), span / (segments + 1 / 2), segments, lines, `apron-frill-${first + k}`);
  }
  strip.weld({ distance: 1e-6 });
  m.append(strip, { tag: `apron-frill-${s > 0 ? 'l' : 'r'}` });
}

/**
 * G6 remodel pleats (facet-plan.json skirt `pleats`): the G3 skirt's 14 box pleats, rebuilt as
 * facet-scale units (facetUnit) on the plain bell, never remeshed. Pleat `j` stands where the G3
 * bell had its crest (loft parameter 2 pi j / 14) and spans `width` of the pleat period across;
 * its ridge (line C, a structure line between the unit's two slopes) rises over its back by the
 * G3 crest height (pleat amplitude x radius, nothing at the hip row 0.35) and its back lies
 * `lift` off the cloth. Each pleat is two units: the navy one on the skirt from `top` down to
 * the hem band, the white one on the band (`skirt-pleat-<j>` and `skirt-pleat-<j>-hem`, tag
 * `skirt-pleat`). Pleats whose crest lies within `apron` of the front centre (|x| at y 0.25)
 * sit under the apron panel and its ruffle, as in G3, and are not built; the two within `tail` of
 * the back centre, where the tail grows from the skirt, keep only their hem unit (a navy unit
 * there crosses the tail's root). The units' lines are staggered half a segment (A in step with
 * B, the ridge with the back), 2 and 3 segments long (navy, hem), at 0.32 of the period across:
 * their long edges run down the skirt (flow p75 16.5, skipped 0.37; at 0.5 of the period the strips were wider
 * than the segments are long, p75 66). The hem unit starts `hemGap` under the band's top, below
 * its taper (a slanted start there passed through the band).
 */
export const PLEAT_UNITS = { width: 0.32, lift: 0.0015, top: 0.315, gap: 0.008, hemGap: 0.024, segments: [2, 3] as const, apron: 0.16, tail: 0.08 } as const;

function skirtPleats(m: Model): void {
  const cz = trunkZ(m, lm('waist'));
  const skirtQ = SurfaceQuery.of(m.editMesh, sel.createdBy('skirt', 'side').or(sel.createdBy('apron-panel')).evaluate(m.editMesh));
  const hemQ = SurfaceQuery.of(m.editMesh, sel.createdBy('skirt-hem', 'layer').evaluate(m.editMesh));
  if (!skirtQ.ok) throw skirtQ.error;
  if (!hemQ.ok) throw hemQ.error;
  // The G3 bell's half-width, half-depth and pleat amplitude at height y (amplitude 0 at the hip row).
  const bell = (y: number): readonly [number, number, number] => {
    const rows = BELL;
    const first = rows[0] as (typeof BELL)[number];
    if (y >= first[0]) return [first[1], first[2], first[3] * Math.max(0, (0.35 - y) / (0.35 - first[0]))];
    for (let i = 1; i < rows.length; i++) {
      const [hi, lo] = [rows[i - 1] as (typeof BELL)[number], rows[i] as (typeof BELL)[number]];
      if (y >= lo[0]) {
        const f = (hi[0] - y) / (hi[0] - lo[0]);
        return [hi[1] + (lo[1] - hi[1]) * f, hi[2] + (lo[2] - hi[2]) * f, hi[3] + (lo[3] - hi[3]) * f];
      }
    }
    const last = rows.at(-1) as (typeof BELL)[number];
    return [last[1], last[2], last[3]];
  };
  // The cloth point at height y on the bell's loft parameter t (a horizontal ray from the axis), its outward normal and radius.
  const onCloth = (q: SurfaceQuery, y: number, t: number) => {
    const [a, b] = bell(y);
    const [c, sn] = [Math.cos(t), Math.sin(t)];
    const d = unit3([a * Math.sign(c) * Math.abs(c) ** (2 / 2.6), 0, -b * Math.sign(sn) * Math.abs(sn) ** (2 / 2.6)]);
    const o: Tuple3 = [0, y, cz];
    const hit = q.project(add3(o, d, 0.6), [-d[0], 0, -d[2]], 0.6);
    if (hit === undefined) return undefined;
    const n = dot3(hit.normal, d) < 0 ? ([-hit.normal[0], -hit.normal[1], -hit.normal[2]] as Tuple3) : hit.normal;
    return { p: hit.point, n, r: Math.hypot(hit.point[0], hit.point[2] - cz) };
  };
  const period = (2 * Math.PI) / PLEATS;
  const lines = {
    B: { u: 1, v: 0, phase: 0 },
    C: { u: 0, v: 1, phase: 1 / 2 },
    A: { u: -1, v: 0, phase: 0 },
    N: { u: 0, v: 0, phase: 1 / 2 },
  } as const;
  const strip = model();
  for (let j = 0; j < PLEATS; j++) {
    const t = j * period;
    const crest = onCloth(skirtQ.value, 0.25, t);
    if (crest === undefined) throw new Error(`skirt pleat ${j} missed the cloth`);
    if (crest.p[2] > cz && Math.abs(crest.p[0]) < PLEAT_UNITS.apron) continue;
    // Behind the tail's root the navy unit would cross the tail: those pleats keep their hem unit only.
    const atTail = crest.p[2] < cz && Math.abs(crest.p[0]) < PLEAT_UNITS.tail;
    const units: [SurfaceQuery, number, number, number, string, string][] = [
      ...(atTail ? [] : [[skirtQ.value, PLEAT_UNITS.top, HEM_BAND_TOP_G6 + PLEAT_UNITS.gap, PLEAT_UNITS.segments[0], `skirt-pleat-${j}`, 'navy'] as [SurfaceQuery, number, number, number, string, string]]),
      [hemQ.value, HEM_BAND_TOP_G6 - PLEAT_UNITS.hemGap, 0.155 + PLEAT_UNITS.gap, PLEAT_UNITS.segments[1], `skirt-pleat-${j}-hem`, 'white'],
    ];
    for (const [q, y0, y1, n, label, material] of units) {
      // s runs down from y0; the ridge's phase reaches half a segment past the others, to y1.
      const seg = (y0 - y1) / (n + 1 / 2);
      const across = (u: number) => t + (u * PLEAT_UNITS.width * period) / 2;
      const field = (s: number, u: number, v: number): Tuple3 => {
        const y = y0 - s;
        const [at, centre] = [onCloth(q, y, across(u)), onCloth(q, y, t)];
        if (at === undefined || centre === undefined) throw new Error(`skirt pleat ${label} at (${y}, ${u}) missed the cloth`);
        // Over the highest cloth half a step around (the back's facets span a step), so no bulge
        // between the lines reaches through the back.
        let over = 0;
        for (const ds of [-seg / 2, 0, seg / 2]) {
          for (const du of [-0.5, 0, 0.5]) {
            const near = onCloth(q, y - ds, across(u + du));
            if (near !== undefined) over = Math.max(over, dot3(sub3(near.p, at.p), at.n));
          }
        }
        return add3(at.p, at.n, over + PLEAT_UNITS.lift + v * bell(y)[2] * centre.r);
      };
      facetUnit(strip, field, 0, seg, n, lines, label, material);
    }
  }
  strip.weld({ distance: 1e-6 });
  m.append(strip, { tag: 'skirt-pleat' });
}

/**
 * Waistband: a white band at the sheet's waistband height (0.414-0.466) around the skirt
 * top, the bodice and the apron's top edges (panel, ruffle and bib), enclosing
 * their section (as the cuffs).
 */
function waistband(m: Model, style: GarmentStyle): void {
  const w = part('front', 'waistband');
  const cz = trunkZ(m, lm('waist'));
  const inside = sel.createdBy('skirt').or(sel.tag('bodice')).or(sel.createdBy('apron')).or(sel.tag('apron-ruffle')).or(sel.tag('apron-bib'));
  const pts = section(m, inside, [0, 0, cz], [0, 1, 0], [1, 0, 0], [0, 0, -1], w.bounds[1] - 0.015, w.bounds[3] + 0.004);
  const ring = (y: number): Tuple3[] => enclose(pts, SKIRT_POINTS, 0.0015).map(([x, z]) => [x, y, cz - z]);
  m.loft({ profiles: [ring(w.bounds[3]), ring(w.bounds[1])], match: 'index', label: 'waistband', tag: 'waistband', material: 'white' });
  walled(m, style, (t, taper) => t.shell(sel.createdBy('waistband'), { thickness: 0.003, direction: 'out', clamp: true, open: sel.createdBy('waistband').minus(sel.createdBy('waistband', 'side')), label: 'waistband-wall', ...taper }));
}

/** The G2 body dressed with the G3 garment layers (checkpoint per garment group). */
export function buildDressed(style: GarmentStyle = {}): Model {
  const m = buildBody();
  // A capture keeps 8 checkpoints: the body's 4, then top, skirt and feet; the apron is the final step.
  dressTop(m, style);
  collar(m, style);
  for (const side of ['l', 'r'] as const) cuff(m, side, style);
  m.checkpoint('top');
  skirt(m, style);
  m.checkpoint('skirt');
  for (const side of ['l', 'r'] as const) {
    sock(m, side, style);
    shoe(m, side, style);
  }
  m.checkpoint('feet');
  apronSkirt(m, style);
  apronBib(m, style);
  if (style.facets === true) skirtPleats(m);
  waistband(m, style);
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

export const G3_GARMENT_TAGS = ['bodice', 'collar', 'sleeve-l', 'sleeve-r', 'cuff-l', 'cuff-r', 'skirt', 'skirt-hem', 'sock-l', 'sock-r', 'shoe-l', 'shoe-r', 'apron', 'apron-ruffle', 'apron-bib', 'apron-frill-l', 'apron-frill-r', 'waistband'] as const;
