import {
  type MetricSize,
  type Model,
  model,
  type OpReport,
  type Point2,
  path,
  recipes,
  region2d,
  sel,
  textRegion,
  type Tuple3,
} from '@forgeax/engine-modeling';

/**
 * Hard-surface kit of case C-410 (sci-fi mech, high-to-low bake). Every part is described
 * once and built at two levels: `low` is the form layer (chamfered silhouette slabs,
 * thick stacked plates, frame blocks, hubs, pistons and hoses at game resolution), `high`
 * adds the detail source stage by stage (edge bevels, layered panels and seams, vents and
 * perforated grilles, rivet rows, bolts and gears, braided hoses and cable runs, stencils,
 * hazard chevrons and emissive slits). Nothing is random: greebles use a seeded hash.
 */
export type Stage = 'form' | 'bevel' | 'panels' | 'vents' | 'fasteners' | 'hydraulics' | 'markings';
export const STAGES: readonly Stage[] = ['form', 'bevel', 'panels', 'vents', 'fasteners', 'hydraulics', 'markings'];

/** Which high stages a build includes; the low level is `form` alone at game resolution. */
export interface Level {
  readonly high: boolean;
  readonly stages: ReadonlySet<Stage>;
}
export const LOW: Level = { high: false, stages: new Set(['form']) };
export const highUpTo = (last: Stage): Level => ({ high: true, stages: new Set(STAGES.slice(0, STAGES.indexOf(last) + 1)) });
export const HIGH: Level = highUpTo('markings');
export const has = (l: Level, s: Stage) => l.high && l.stages.has(s);

/** Material slots of the detail source; recipe slots are folded into these (pipeline.ts). */
export type Slot = 'armor' | 'accent' | 'frame' | 'steel' | 'rubber' | 'glow' | 'hazard' | 'dark';

/** Journals of every session a build opened (all kernel calls, reported per stage). */
export const OPS = new Map<string, number>();
const opened: Model[] = [];
/** A kernel session whose operations are counted into OPS by `collectOps`. */
export function session(): Model {
  const m = model();
  opened.push(m);
  return m;
}
export function collectOps(): number {
  let n = 0;
  for (const m of opened.splice(0)) for (const j of m.journal) { OPS.set(j.op, (OPS.get(j.op) ?? 0) + 1); n++; }
  return n;
}

/** Feature counts of the last build (reported in metrics.json). */
export const COUNTS: Record<string, number> = {};
export function resetCounts(): void {
  for (const k of Object.keys(COUNTS)) delete COUNTS[k];
}
const count = (k: string, n = 1) => {
  COUNTS[k] = (COUNTS[k] ?? 0) + n;
};

export function check(m: Model, r: OpReport, what = ''): OpReport {
  if (r.status === 'failed') {
    const e = r.error;
    throw new Error(`${what || r.op} failed: ${e?.code} ${e?.expected ?? ''} ${JSON.stringify(e?.detail ?? {}).slice(0, 400)} ${e?.hint ?? ''}`);
  }
  void m;
  return r;
}

const DEG = Math.PI / 180;
export function ring(radius: number, n: number, phase = 0, center: Point2 = [0, 0]): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)] as Point2;
  });
}
/** Rectangle with 45 degree corner cuts `c` (counter-clockwise). */
export function chamferRect(x0: number, y0: number, x1: number, y1: number, c: number): Point2[] {
  return [[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]];
}
/** Deterministic hash in [0, 1). */
export function hash(i: number, seed = 0): number {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A placement: the local frame turned so local +Z points along `n` and local +Y toward `up`
 * (default world +Y, or +Z when `n` is vertical), then moved so the local origin sits at `at`.
 */
export interface Place {
  readonly n?: Tuple3;
  readonly up?: Tuple3;
  readonly at: Tuple3;
}
const norm3 = (a: Tuple3): Tuple3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross3 = (a: Tuple3, b: Tuple3): Tuple3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Euler angles (degrees) with R = Ry(a) Rx(b) Rz(c) mapping local Z to n and local Y toward up. */
export function eulerFor(n0: Tuple3, up0?: Tuple3): readonly [number, number, number] {
  const z = norm3(n0);
  let up = up0 ?? [0, 1, 0];
  if (Math.abs(z[0] * up[0] + z[1] * up[1] + z[2] * up[2]) / Math.hypot(...up) > 0.98) up = [0, 0, 1];
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  const R = (r: number, c: number) => [x, y, z][c]![r]!;
  const b = Math.asin(Math.max(-1, Math.min(1, -R(1, 2))));
  const a = Math.atan2(R(0, 2), R(2, 2));
  const c = Math.atan2(R(1, 0), R(1, 1));
  return [a / DEG, b / DEG, c / DEG];
}
export function place(m: Model, p: Place): void {
  if (p.n) {
    const [a, b, c] = eulerFor(p.n, p.up);
    if (Math.abs(c) > 1e-9) check(m, m.rotate(sel.all(), 'z', c), 'place.rz');
    if (Math.abs(b) > 1e-9) check(m, m.rotate(sel.all(), 'x', b), 'place.rx');
    if (Math.abs(a) > 1e-9) check(m, m.rotate(sel.all(), 'y', a), 'place.ry');
  }
  if (p.at.some((v) => v !== 0)) check(m, m.translate(sel.all(), p.at), 'place.translate');
}

type Rect = readonly [number, number, number, number];
export interface Vent { readonly rect: Rect; readonly slats?: number; readonly depth?: number }
export interface Grille { readonly rect: Rect; readonly cols: number; readonly rows: number }
export interface Stencil { readonly text: string; readonly at: Point2; readonly height: number }
export interface Chevrons { readonly rect: Rect; readonly stripes: number }
/** A plate stacked on the slab's outer face (thick >= 3 cm: form at both levels; thinner: detail). */
export interface Layer {
  readonly outline: readonly Point2[];
  readonly thick: number;
  readonly material?: Slot;
  readonly vents?: readonly Vent[];
  readonly grilles?: readonly Grille[];
  readonly glow?: readonly Rect[];
  readonly stencils?: readonly Stencil[];
  readonly chevrons?: readonly Chevrons[];
  readonly bolts?: readonly Point2[];
}

/**
 * An armor plate: an outline in its local XY plane extruded to `thick` along +Z (outer face
 * at z = thick), its outer rim chamfered (both levels), detailed in that frame, then placed.
 * Feature coordinates are local XY. Rivet rows run along the rim automatically (`rivets: false`
 * turns them off); seams default to one cut across the longer side.
 */
export interface PlateSpec extends Layer {
  readonly chamfer?: number;
  readonly raised?: { readonly inset: number; readonly height: number; readonly material?: Slot };
  readonly seams?: readonly (readonly ['x' | 'y', number])[];
  readonly layers?: readonly Layer[];
  readonly boltSize?: MetricSize;
  readonly rivets?: boolean;
  /** Uniform scale of the local XY layout (outline and features), not of the thickness. */
  readonly scale?: number;
  readonly place: Place;
}

function scaleLayer<T extends Layer>(l: T, k: number): T {
  const P = (q: Point2): Point2 => [q[0] * k, q[1] * k];
  const R = (r: Rect): Rect => [r[0] * k, r[1] * k, r[2] * k, r[3] * k];
  return {
    ...l,
    outline: l.outline.map(P),
    ...(l.vents ? { vents: l.vents.map((v) => ({ ...v, rect: R(v.rect) })) } : {}),
    ...(l.grilles ? { grilles: l.grilles.map((g) => ({ ...g, rect: R(g.rect) })) } : {}),
    ...(l.glow ? { glow: l.glow.map(R) } : {}),
    ...(l.stencils ? { stencils: l.stencils.map((st) => ({ ...st, at: P(st.at), height: st.height * k })) } : {}),
    ...(l.chevrons ? { chevrons: l.chevrons.map((c) => ({ ...c, rect: R(c.rect) })) } : {}),
    ...(l.bolts ? { bolts: l.bolts.map(P) } : {}),
  };
}

const snapCache = new Map<string, Uint8Array>();
/** A hex bolt head standing on z = 0 along +Z (recipe `hexBolt`, shank sunk into the plate). */
export function boltSnapshot(size: MetricSize): Uint8Array {
  const hit = snapCache.get(size);
  if (hit) return hit;
  const d = Number(size.slice(1)) / 1000;
  const r = recipes.hexBolt({ size, length: 2 * d, segments: 24, name: 'bolt' });
  if (!r.ok) throw new Error(`hexBolt ${size}: ${r.error.code}`);
  const b = r.value.model;
  check(b, b.rotate(sel.all(), 'x', 90));
  const snap = b.snapshot();
  snapCache.set(size, snap);
  return snap;
}
/** A domed rivet head on z = 0 (sunk 2 mm). */
function rivetSnapshot(): Uint8Array {
  const hit = snapCache.get('rivet');
  if (hit) return hit;
  const r = session();
  check(r, r.sphere({ radius: 0.0065, widthSegments: 16, heightSegments: 8, center: [0, 0, -0.0025], material: 'steel', tag: 'rivet' }));
  const snap = r.snapshot();
  snapCache.set('rivet', snap);
  return snap;
}

const rectRing = ([x0, y0, x1, y1]: Rect): Point2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const ccw = (poly: readonly Point2[]): Point2[] => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a >= 0 ? [...poly] : [...poly].reverse();
};
const contains = (poly: readonly Point2[], q: Point2) => region2d.contains({ outer: ccw(poly) }, q);
const inside = (poly: readonly Point2[], [x0, y0, x1, y1]: Rect) => ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Point2[]).every((q) => contains(poly, q));
function insetOrNone(poly: readonly Point2[], d: number): Point2[] | undefined {
  const off = region2d.offset({ outer: ccw(poly) }, -d, { join: 'miter' });
  if (!off.ok || off.value.region.length !== 1) return undefined;
  return [...off.value.region[0]!.outer];
}
function inset(poly: readonly Point2[], d: number): Point2[] {
  const r = insetOrNone(poly, d);
  if (r === undefined) throw new Error(`outline inset ${d}`);
  return r;
}
const near = (r: Rect, q: Point2, pad: number) => q[0] > r[0] - pad && q[0] < r[2] + pad && q[1] > r[1] - pad && q[1] < r[3] + pad;
/** Points along a closed polyline every `step` meters (corner-anchored per edge). */
function along(poly: readonly Point2[], step: number): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n]);
  }
  return out;
}

/** Thin raised (floating 0.4 mm) region outlines on top of z = `z`: stencil paint, chevrons. */
function decalShapes(m: Model, shapes: readonly { outer: readonly Point2[]; holes?: readonly (readonly Point2[])[] }[], z: number, material: Slot, tag: string) {
  if (shapes.length === 0) return;
  const d = session();
  // Tagged `floater` too: the bake keeps them out of height and AO (S1a floaters).
  for (const s of shapes) check(d, d.extrudePolygon({ points: s.outer, ...(s.holes && s.holes.length > 0 ? { holes: s.holes } : {}), depth: 0.0006, material, tag: 'floater' }), 'decal');
  check(d, d.translate(sel.all(), [0, 0, z + 0.0004]));
  check(m, m.append(d, { tag }));
}

/** A hex-perforated sheet over [x0, y0, x1, y1] at z (pitch ~ min cell). */
function perforated(m: Model, r: Rect, cols: number, rows: number, z: number) {
  const [x0, y0, x1, y1] = r;
  const pw = (x1 - x0) / (cols + 0.5), ph = (y1 - y0) / rows;
  const rad = Math.min(pw, ph * 1.15) * 0.36;
  const holes: Point2[][] = [];
  for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < cols; xx++) holes.push(ring(rad, 6, Math.PI / 6, [x0 + (xx + 0.5 + (yy % 2) * 0.5) * pw, y0 + (yy + 0.5) * ph]));
  const gp = session();
  check(gp, gp.extrudePolygon({ points: rectRing(r), holes, depth: 0.003, material: 'frame', tag: 'grille' }), 'perforated');
  check(gp, gp.translate(sel.all(), [0, 0, z]));
  check(m, m.append(gp, { tag: 'grille' }));
  count('perforationHoles', holes.length);
}

/** Slab + features of one plate or layer in its local frame (outer face at z0 + thick). */
function slab(m: Model, s: PlateSpec | Layer, l: Level, z0: number, chamfer: number, rivets: boolean, boltSize: MetricSize): void {
  const p = session();
  const t = s.thick;
  const openings: { rect: Rect; depth: number; kind: 'vent' | 'grille' | 'glow'; i: number }[] = [];
  if (has(l, 'vents')) {
    for (const [i, v] of (s.vents ?? []).entries()) openings.push({ rect: v.rect, depth: v.depth ?? 0.035, kind: 'vent', i });
    for (const [i, g] of (s.grilles ?? []).entries()) openings.push({ rect: g.rect, depth: 0.024, kind: 'grille', i });
  }
  if (has(l, 'markings')) for (const [i, g] of (s.glow ?? []).entries()) openings.push({ rect: g, depth: 0.006, kind: 'glow', i });
  const raised = 'raised' in s && has(l, 'panels') ? s.raised : undefined;
  const raisedInner = raised ? inset(s.outline, raised.inset) : undefined;
  const plateOpenings = openings.filter((o) => !raisedInner || !inside(raisedInner, o.rect));
  check(p, p.extrudePolygon({ points: s.outline, ...(plateOpenings.length > 0 ? { holes: plateOpenings.map((o) => rectRing(o.rect)) } : {}), depth: t, material: s.material ?? 'armor', tag: 'plate', label: 'slab' }), 'plate');
  if (chamfer > 0) check(p, p.bevel(sel.tag('plate').and(sel.facing('+z', 3)).boundary().and(sel.edges.dihedral('>', 25)), { width: chamfer, segments: 1 }), 'plate.chamfer');
  if (has(l, 'bevel')) check(p, p.bevel(sel.edges.dihedral('>', 20), { width: Math.min(0.004, t * 0.12), segments: 2 }), 'plate.bevel');
  if (plateOpenings.length > 0) check(p, p.assign(sel.createdBy('slab', 'hole'), 'dark'));
  const zTop = (q: Point2) => z0 + t + (raisedInner && contains(raisedInner, q) ? (raised?.height ?? 0) : 0);
  if (raised && raisedInner) {
    const rh = openings.filter((o) => inside(raisedInner, o.rect));
    const r = session();
    check(r, r.extrudePolygon({ points: raisedInner, ...(rh.length > 0 ? { holes: rh.map((o) => rectRing(o.rect)) } : {}), depth: raised.height, material: raised.material ?? s.material ?? 'armor', tag: 'raised', label: 'rp' }), 'raised');
    check(r, r.bevel(sel.tag('raised').and(sel.facing('+z', 3)).boundary(), { width: raised.height * 0.75, segments: 1 }), 'raised.chamfer');
    if (rh.length > 0) check(r, r.assign(sel.createdBy('rp', 'hole'), 'dark'));
    check(r, r.translate(sel.all(), [0, 0, t]));
    check(p, p.append(r, { tag: 'raised' }));
  }
  if (has(l, 'panels') && 'place' in s) {
    let seams = s.seams;
    if (seams === undefined) {
      const xs = s.outline.map((q) => q[0]), ys = s.outline.map((q) => q[1]);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      const axis: 'x' | 'y' = w > h ? 'x' : 'y';
      const lo = axis === 'x' ? Math.min(...xs) : Math.min(...ys), span = axis === 'x' ? w : h;
      const free = [0.38, 0.62, 0.3, 0.7].map((f) => lo + f * span).find((c) => openings.every((o) => (axis === 'x' ? o.rect[0] - 0.02 > c || o.rect[2] + 0.02 < c : o.rect[1] - 0.02 > c || o.rect[3] + 0.02 < c)));
      seams = Math.max(w, h) > 0.2 && Math.min(w, h) > 0.12 && free !== undefined ? [[axis, free]] : [];
    }
    for (const [axis, c] of seams) {
      const normal: Tuple3 = axis === 'x' ? [1, 0, 0] : [0, 1, 0];
      const point: Tuple3 = axis === 'x' ? [c, 0, 0] : [0, c, 0];
      // A seam that would fold a face (it grazes a chamfer or a stacked rim) is skipped, not forced.
      const r = p.try((q) => q.panelLine({ faces: sel.tag('plate').or(sel.tag('raised')).and(sel.facing('+z', 20)), point, normal }, { width: 0.007, depth: 0.004, profile: 'v', material: 'dark' }));
      count(r.ok ? 'seams' : 'seamsSkipped');
    }
  }
  for (const o of openings) {
    const [x0, y0, x1, y1] = o.rect;
    const zt = zTop([(x0 + x1) / 2, (y0 + y1) / 2]) - z0;
    const floor = zt - o.depth;
    check(p, p.box({ size: [x1 - x0 + 0.002, y1 - y0 + 0.002, 0.004], center: [(x0 + x1) / 2, (y0 + y1) / 2, floor - 0.002], material: o.kind === 'glow' ? 'glow' : 'dark', tag: 'floor' }), 'floor');
    if (o.kind === 'vent') {
      count('vents');
      const v = (s.vents ?? [])[o.i]!;
      const slats = v.slats ?? Math.max(3, Math.floor((y1 - y0 - 0.01) / 0.024));
      const pitch = (y1 - y0) / slats;
      const sd = Math.min(0.028, o.depth * 0.7);
      const cz = zt - o.depth * 0.42;
      const sl = session();
      check(sl, sl.box({ size: [x1 - x0 - 0.004, 0.0045, sd], center: [(x0 + x1) / 2, y0 + pitch / 2, cz], tag: 'slat', material: 'frame' }));
      check(sl, sl.bevel(sel.edges.dihedral('>', 60), { width: 0.0012, segments: 1 }), 'slat.bevel');
      check(sl, sl.rotate(sel.all(), 'x', -40, [(x0 + x1) / 2, y0 + pitch / 2, cz]));
      if (slats > 1) check(sl, sl.array(sel.tag('slat'), { linear: { count: slats, offset: [0, pitch, 0] } }), 'slats');
      check(p, p.append(sl, { tag: 'slat' }));
      count('louvres', slats);
      perforated(p, [x0 + 0.001, y0 + 0.001, x1 - 0.001, y1 - 0.001], Math.max(4, Math.round((x1 - x0) / 0.012)), Math.max(3, Math.round((y1 - y0) / 0.011)), floor + 0.002);
    } else if (o.kind === 'grille') {
      count('grilles');
      const g = (s.grilles ?? [])[o.i]!;
      perforated(p, [x0 + 0.001, y0 + 0.001, x1 - 0.001, y1 - 0.001], g.cols, g.rows, zt - 0.011);
    } else count('glowSlits');
  }
  if (has(l, 'fasteners')) {
    const bolts = s.bolts ?? [];
    if (bolts.length > 0) {
      const b = session();
      for (const q of bolts) check(b, b.append(boltSnapshot(boltSize), { translate: [q[0], q[1], zTop(q) - z0], tag: 'bolt' }), 'bolt');
      check(p, p.append(b, { tag: 'bolt' }));
      count('bolts', bolts.length);
    }
    if (rivets) {
      // Rivet row along the rim: on the raised panel when there is one, else on the slab face.
      const lane = raisedInner ? insetOrNone(raisedInner, raised!.height * 0.75 + 0.014) : insetOrNone(s.outline, chamfer + 0.016);
      const blocked: Rect[] = [...openings.map((o) => o.rect), ...(s.stencils ?? []).map((st) => [st.at[0], st.at[1], st.at[0] + st.text.length * st.height * 0.9, st.at[1] + st.height] as Rect), ...(s.chevrons ?? []).map((c) => c.rect)];
      const pts = (lane ? along(lane, 0.036) : []).filter((q) => blocked.every((r) => !near(r, q, 0.016)) && bolts.every((b) => Math.hypot(b[0] - q[0], b[1] - q[1]) > 0.03));
      if (pts.length > 0) {
        const rv = session();
        for (const q of pts) check(rv, rv.append(rivetSnapshot(), { translate: [q[0], q[1], zTop(q) - z0], tag: 'rivet' }), 'rivet');
        check(p, p.append(rv, { tag: 'rivet' }));
        count('rivets', pts.length);
      }
    }
  }
  if (has(l, 'markings')) {
    for (const st of s.stencils ?? []) {
      const r = textRegion(st.text, { height: st.height, weight: 0.15 });
      if (!r.ok) throw new Error(`text ${st.text}: ${r.error.code}`);
      const shapes = r.value.region.map((sh) => ({ outer: sh.outer.map(([x, y]) => [x + st.at[0], y + st.at[1]] as Point2), holes: (sh.holes ?? []).map((h) => h.map(([x, y]) => [x + st.at[0], y + st.at[1]] as Point2)) }));
      decalShapes(p, shapes, zTop(st.at) - z0, 'dark', 'stencil');
      count('stencils');
    }
    for (const c of s.chevrons ?? []) {
      const [x0, y0, x1, y1] = c.rect;
      const w = (x1 - x0) / (2 * c.stripes), h = y1 - y0;
      const shapes = [];
      for (let k = 0; k < c.stripes; k++) {
        const a = x0 + 2 * k * w;
        if (a + w + h * 0.6 > x1) break;
        shapes.push({ outer: [[a, y0], [a + w, y0], [a + w + h * 0.6, y1], [a + h * 0.6, y1]] as Point2[] });
      }
      decalShapes(p, shapes, zTop([x0, y0]) - z0, 'hazard', 'hazard');
      count('chevrons');
    }
  }
  if (z0 !== 0) check(p, p.translate(sel.all(), [0, 0, z0]));
  check(m, m.append(p, { tag: 'armor' }), 'slab.append');
  count('plates');
}

export function plate(target: Model, s0: PlateSpec, l: Level): void {
  const k = s0.scale ?? 1;
  const s: PlateSpec = k === 1 ? s0 : { ...scaleLayer(s0, k), ...(s0.layers ? { layers: s0.layers.map((x) => scaleLayer(x, k)) } : {}), ...(s0.seams ? { seams: s0.seams.map(([a, c]) => [a, c * k] as const) } : {}), ...(s0.raised ? { raised: { ...s0.raised, inset: s0.raised.inset * k } } : {}) };
  const m = session();
  const chamfer = s.chamfer ?? Math.min(0.03, s.thick * 0.45);
  slab(m, s, l, 0, chamfer, s.rivets !== false, s.boltSize ?? 'M12');
  let z = s.thick;
  for (const layer of s.layers ?? []) {
    if (layer.thick < 0.03 && !has(l, 'panels')) continue;
    slab(m, layer, l, z, Math.min(0.012, layer.thick * 0.4), s.rivets !== false, 'M10');
    z += layer.thick;
  }
  place(m, s.place);
  check(target, target.append(m, { tag: 'armor' }), 'plate.append');
}

/** A round hub (joint housing) along `axis` at `at`: radius, width; high adds a gear ring and bolt circle. */
export function hub(target: Model, o: { radius: number; width: number; axis: 'x' | 'y' | 'z'; at: Tuple3; material?: Slot; gear?: boolean }, l: Level): void {
  const m = session();
  check(m, m.cylinder({ radiusTop: o.radius, radiusBottom: o.radius, height: o.width, radialSegments: l.high ? 64 : 12, tag: 'hub', material: o.material ?? 'frame' }));
  check(m, m.bevel(sel.edges.dihedral('>', 60), { width: Math.min(0.02, o.width * 0.12), segments: l.high ? 3 : 1 }), 'hub.chamfer');
  if (has(l, 'panels')) {
    for (const f of [-0.25, 0.25]) check(m, m.panelLine({ faces: sel.tag('hub'), point: [0, f * o.width, 0], normal: [0, 1, 0] }, { width: 0.008, depth: 0.004, profile: 'u' }), 'hub.groove');
  }
  if (has(l, 'fasteners') && o.gear !== false) {
    const teeth = Math.max(16, Math.round((o.radius * 0.62 * 2) / 0.008));
    const g = recipes.gear({ module: (o.radius * 0.62 * 2) / teeth, teeth, width: 0.018, webHoles: o.radius >= 0.12 ? 5 : 0, name: 'gear' });
    if (!g.ok) throw new Error(`gear: ${g.error.code} ${JSON.stringify(g.error.detail)}`);
    const gm = g.value.model;
    check(gm, gm.rotate(sel.all(), 'x', -90));
    check(gm, gm.translate(sel.all(), [0, o.width / 2 + 0.009 - 0.002, 0]));
    check(m, m.append(gm, { tag: 'gear' }));
    count('gears');
  }
  if (has(l, 'fasteners')) {
    const bs = session();
    const n = Math.max(6, Math.round((o.radius * 0.84 * 2 * Math.PI) / 0.05));
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * (i + 0.5)) / n;
        check(bs, bs.append(boltSnapshot('M10'), { translate: [o.radius * 0.84 * Math.cos(a), o.radius * 0.84 * Math.sin(a), side > 0 ? 0 : 0], tag: `bolt${side}` }));
      }
    }
    check(bs, bs.rotate(sel.tag('bolt-1'), 'x', 180));
    check(bs, bs.rotate(sel.all(), 'x', -90));
    check(bs, bs.translate(sel.tag('bolt1'), [0, o.width / 2, 0]));
    check(bs, bs.translate(sel.tag('bolt-1'), [0, -o.width / 2, 0]));
    check(m, m.append(bs, { tag: 'bolt' }));
    count('bolts', 2 * n);
  }
  if (o.axis === 'x') check(m, m.rotate(sel.all(), 'z', -90));
  else if (o.axis === 'z') check(m, m.rotate(sel.all(), 'x', 90));
  check(m, m.translate(sel.all(), o.at));
  check(target, target.append(m, { tag: 'hub' }), 'hub.append');
  count('hubs');
}

/** A frame member: a chamfered box (high: edge bevels, lightening grooves along its long axis). */
export function strut(target: Model, o: { size: Tuple3; place: Place; material?: Slot; ribs?: number }, l: Level): void {
  const m = session();
  check(m, m.box({ size: o.size, tag: 'strut', material: o.material ?? 'frame' }));
  check(m, m.bevel(sel.edges.all(), { width: Math.min(...o.size) * 0.14, segments: 1 }), 'strut.chamfer');
  if (has(l, 'bevel')) check(m, m.bevel(sel.edges.dihedral('>', 20), { width: Math.min(0.003, Math.min(...o.size) * 0.04), segments: 2 }), 'strut.bevel');
  if (has(l, 'panels') && o.ribs) {
    const long = o.size.indexOf(Math.max(...o.size));
    const n: Tuple3 = [0, 0, 0];
    n[long] = 1;
    for (let i = 1; i <= o.ribs; i++) {
      const p: Tuple3 = [0, 0, 0];
      p[long] = -o.size[long]! / 2 + (o.size[long]! * i) / (o.ribs + 1);
      check(m, m.panelLine({ faces: sel.tag('strut').and(sel.facing('+x', 10).or(sel.facing('-x', 10)).or(sel.facing('+z', 10)).or(sel.facing('-z', 10)).or(sel.facing('+y', 10)).or(sel.facing('-y', 10))), point: p, normal: n }, { width: 0.008, depth: 0.004, profile: 'square' }), 'strut.rib');
    }
  }
  place(m, o.place);
  check(target, target.append(m, { tag: 'frame' }), 'strut.append');
  count('struts');
}

/** A hydraulic ram (recipe) between two points; high 48 segments, low 12 (silhouette kept). */
export function ram(target: Model, o: { from: Tuple3; to: Tuple3; bore: number }, l: Level): void {
  const len = Math.hypot(o.to[0] - o.from[0], o.to[1] - o.from[1], o.to[2] - o.from[2]);
  const probe = recipes.hydraulicCylinder({ bore: o.bore, rod: o.bore * 0.5, stroke: len * 0.45, extension: 0.5, segments: 16, name: 'ram' });
  if (!probe.ok) throw new Error(`ram: ${probe.error.code} ${JSON.stringify(probe.error.detail)}`);
  const pin = probe.value.dimensions.pinToPin as number;
  const stroke = (len * 0.45 * len) / pin;
  const r = recipes.hydraulicCylinder({ bore: o.bore, rod: o.bore * 0.5, stroke, extension: 0.5, segments: l.high ? 48 : 12, name: 'ram' });
  if (!r.ok) throw new Error(`ram: ${r.error.code}`);
  const m = r.value.model;
  const base = r.value.anchors.baseEye as Tuple3;
  check(m, m.translate(sel.all(), [-base[0], -base[1], -base[2]]));
  const d: Tuple3 = [(o.to[0] - o.from[0]) / len, (o.to[1] - o.from[1]) / len, (o.to[2] - o.from[2]) / len];
  const tilt = Math.acos(Math.max(-1, Math.min(1, d[1]))) / DEG;
  const yaw = Math.atan2(d[0], d[2]) / DEG;
  check(m, m.rotate(sel.all(), 'x', tilt));
  check(m, m.rotate(sel.all(), 'y', yaw));
  check(m, m.translate(sel.all(), o.from));
  check(target, target.append(m, { tag: 'ram' }), 'ram.append');
  count('pistons');
}

/**
 * A hose along a Catmull-Rom path. High: a braided sheath (a 12-lobe section twisted along
 * the run), clamp rings and end fittings; low: a 6-sided tube (kept for the silhouette).
 */
export function hose(target: Model, o: { points: readonly Tuple3[]; radius: number; rings?: number; material?: Slot }, l: Level): void {
  const m = session();
  const len = o.points.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - o.points[i]![0], p[1] - o.points[i]![1], p[2] - o.points[i]![2]), 0);
  if (has(l, 'hydraulics')) {
    const lobes = 12;
    const profile = Array.from({ length: lobes * 3 }, (_, i) => {
      const a = (2 * Math.PI * i) / (lobes * 3);
      const r = o.radius * (1 + 0.09 * Math.cos(lobes * a));
      return [r * Math.cos(a), r * Math.sin(a)] as Point2;
    });
    const turns = len / 0.05;
    check(m, m.sweep({ profile, path: path.catmullRom(o.points, 40), twist: (turns * 360) / lobes, segments: 2, sharpAngle: 89, material: o.material ?? 'rubber', tag: 'hose' }), 'hose.sweep');
    const fit = session();
    check(fit, fit.cylinder({ radiusTop: o.radius * 1.35, radiusBottom: o.radius * 1.35, height: o.radius * 2.2, radialSegments: 6, material: 'steel', tag: 'fitting' }));
    check(fit, fit.rotate(sel.all(), 'x', 90));
    check(m, m.array(fit, { onCurve: { count: 2 + (o.rings ?? 0), path: path.catmullRom(o.points, 10) } }), 'hose.fittings');
  } else {
    check(m, m.sweep({ profile: ring(o.radius, l.high ? 16 : 6), path: path.catmullRom(o.points, l.high ? 10 : 3), material: o.material ?? 'rubber', tag: 'hose' }), 'hose.sweep');
  }
  check(target, target.append(m, { tag: 'hose' }), 'hose.append');
  count('hoses');
}

/** A bundle of `n` thin cables lying on a surface (high only: baked into the maps). */
export function cables(target: Model, o: { points: readonly Tuple3[]; radius: number; n: number; spread: Tuple3 }, l: Level): void {
  if (!has(l, 'hydraulics')) return;
  for (let i = 0; i < o.n; i++) {
    const k = i - (o.n - 1) / 2;
    const pts = o.points.map((p) => [p[0] + o.spread[0] * k, p[1] + o.spread[1] * k, p[2] + o.spread[2] * k] as Tuple3);
    const m = session();
    check(m, m.sweep({ profile: ring(o.radius, 10), path: path.catmullRom(pts, 12), material: i % 3 === 1 ? 'accent' : 'rubber', tag: 'cable' }), 'cable.sweep');
    check(target, target.append(m, { tag: 'cable' }), 'cable.append');
  }
  count('cables', o.n);
}

/**
 * Greebles on a local XY rect at z (then placed): seeded boxes, caps and small hatches with
 * hinges and handles (high only, stage fasteners).
 */
export function greebles(target: Model, o: { rect: Rect; z: number; n: number; seed: number; place: Place }, l: Level): void {
  if (!has(l, 'fasteners')) return;
  const m = session();
  const [x0, y0, x1, y1] = o.rect;
  for (let i = 0; i < o.n; i++) {
    const u = hash(i, o.seed), v = hash(i + 101, o.seed), k = hash(i + 202, o.seed);
    const cx = x0 + 0.04 + u * (x1 - x0 - 0.08), cy = y0 + 0.04 + v * (y1 - y0 - 0.08);
    if (k < 0.45) {
      const w = 0.03 + 0.05 * hash(i + 303, o.seed), h = 0.02 + 0.04 * hash(i + 404, o.seed);
      check(m, m.box({ size: [w, h, 0.012 + 0.012 * k], center: [cx, cy, o.z + 0.006], material: k < 0.2 ? 'accent' : 'frame', tag: 'greeble' }));
    } else if (k < 0.75) {
      check(m, m.cylinder({ radiusTop: 0.012, radiusBottom: 0.014, height: 0.014, radialSegments: 16, center: [cx, cy, o.z + 0.007], material: 'steel', tag: `cap${i}` }));
      check(m, m.rotate(sel.tag(`cap${i}`), 'x', 90, [cx, cy, o.z + 0.007]));
    } else {
      const h = recipes.hinge({ length: 0.05, leafWidth: 0.014, thickness: 0.002, pin: 0.004, name: 'hatch' });
      if (!h.ok) throw new Error(`hinge ${h.error.code} ${JSON.stringify(h.error.detail)}`);
      const hatch = session();
      check(hatch, hatch.box({ size: [0.07, 0.05, 0.008], center: [0, -0.03, 0.004], material: 'accent', tag: 'hatch' }));
      check(hatch, hatch.bevel(sel.edges.dihedral('>', 60), { width: 0.002, segments: 1 }));
      const hm = h.value.model;
      check(hm, hm.rotate(sel.all(), 'z', 90));
      check(hm, hm.translate(sel.all(), [0, 0.002, 0.004]));
      check(hatch, hatch.append(hm, { tag: 'hinge' }));
      check(hatch, hatch.translate(sel.all(), [cx, cy, o.z]));
      check(m, m.append(hatch, { tag: 'hatch' }));
      count('hatches');
    }
    count('greebles');
  }
  place(m, o.place);
  check(target, target.append(m, { tag: 'greeble' }), 'greebles.append');
}
