import { type DesignedContact, type FaceSelector, type Model, model, SurfaceQuery, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { centerOf, headRings } from './body.ts';
import { buildDressed, type GarmentStyle } from './garments.ts';
import { buildHair } from './hair.ts';

/**
 * Case C-200 stage G5 (attached structures, structure-first): every attachment is seated on
 * the part it hangs from. On the dressed figure, the tail grows from a patch of the skirt's
 * back (a real seam) through a hanging path to its two fluke lobes, then the bowtie and
 * brooch sit on the collar and the back bow with its ties on the skirt and tail. On the hair,
 * the headdress band rides the cap from ear to ear carrying its frill teeth; the fins and the
 * ribbon bows sit at the band's ends.
 */

const add = (a: Tuple3, b: Tuple3, k = 1): Tuple3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Tuple3, b: Tuple3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Tuple3): Tuple3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** `a` with its component along unit `n` removed, normalized. */
const across = (a: Tuple3, n: Tuple3): Tuple3 => unit(add(a, n, -dot(a, n)));

type Query = { project(from: Tuple3, dir: Tuple3, max: number): { point: Tuple3; normal: Tuple3 } | undefined };

function surface(m: Model, faces: FaceSelector): Query {
  const q = SurfaceQuery.of(m.editMesh, faces.evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  return q.value as unknown as Query;
}

function hit(q: Query, from: Tuple3, dir: Tuple3, what: string): { point: Tuple3; normal: Tuple3 } {
  const h = q.project(from, dir, 1);
  if (h === undefined) throw new Error(`${what}: no surface from ${from.join(',')}`);
  return h;
}

/** A local frame on a surface: origin, outward normal `n`, and in-plane axes `u` and `v`. */
interface Frame {
  readonly o: Tuple3;
  readonly n: Tuple3;
  readonly u: Tuple3;
  readonly v: Tuple3;
}

const at = (f: Frame, u: number, v: number, w = 0): Tuple3 => add(add(add(f.o, f.u, u), f.v, v), f.n, w);

/**
 * A flat part: the planar outline `[u, v]` (either winding) in frame `f`, lofted from `w0` to
 * `w1` along the frame's normal into a capped prism.
 */
function plate(m: Model, f: Frame, outline: readonly (readonly [number, number])[], w0: number, w1: number, name: { label: string; tag: string; material: string }): void {
  m.loft({ profiles: [outline.map(([u, v]) => at(f, u, v, w0)), outline.map(([u, v]) => at(f, u, v, w1))], match: 'index', ...name });
  ownTag(m, name);
}

/** The part's own tag besides its group tag: designed contacts name parts by tag. */
function ownTag(m: Model, name: { label: string; tag: string }): void {
  if (name.label !== name.tag) m.tag(sel.createdBy(name.label), name.label);
}

/**
 * Seating (F1 criterion 13: no floating part): a part's base meets its seat `depth` inside it;
 * parts that hang from it (a bow's loops and tails from its knot) stay `clear` above the seat.
 * Its base faces (centroids within 0.5 mm of the frame plane `w0`) are projected onto the seat
 * along the frame normal, so a base over a curved seat conforms to it.
 */
export const SEAT = { depth: 0.0003, clear: 0.0008 } as const;

function seatBase(m: Model, part: FaceSelector, f: Frame, w0: number, onto: FaceSelector, reach?: number): void {
  const base = part.and(sel.side(at(f, 0, 0, w0 + 0.0005), [-f.n[0], -f.n[1], -f.n[2]], { by: 'centroid' }));
  // Already on the seat, nothing moves (the kernel reports that as no effect).
  m.try((t) => t.shrinkwrap(base, { onto, mode: 'project', direction: [-f.n[0], -f.n[1], -f.n[2]], offset: -SEAT.depth, ...(reach === undefined ? {} : { maxDistance: reach }) }));
}

/**
 * How far along the frame normal the seat reaches under a part's footprint (the extents of `us`
 * and `vs`): the part's plane goes there, `SEAT.depth` in, so it touches the seat's highest point
 * and nothing of it starts inside the seat.
 */
function reachUnder(q: Query, f: Frame, us: readonly number[], vs: readonly number[], margin = 0.008): number {
  // A 25 x 13 grid over the sampled extents, so thin raised edges (straps, frills) count too.
  // A margin past the extents catches seat bumps just outside the outline.
  const [u0, u1, v0, v1] = [Math.min(...us) - margin, Math.max(...us) + margin, Math.min(...vs) - margin, Math.max(...vs) + margin];
  let reach = -Infinity;
  for (let i = 0; i <= 24; i++) {
    for (let j = 0; j <= 12; j++) {
      const p = q.project(at(f, u0 + ((u1 - u0) * i) / 24, v0 + ((v1 - v0) * j) / 12, 0.2), [-f.n[0], -f.n[1], -f.n[2]], 0.4)?.point;
      if (p !== undefined) reach = Math.max(reach, dot(sub(p, f.o), f.n));
    }
  }
  return reach - SEAT.depth;
}

/** A faceted section across a ribbon in the frame's (v, w) plane: `h` tall, `d` deep from `w0`. */
const puffSection = (f: Frame, u: number, h: number, d: number, w0: number): Tuple3[] =>
  ([[-h, 0], [h, 0], [h, 0.6], [h * 0.45, 1], [-h * 0.45, 1], [-h, 0.6]] as const).map(([v, k]) => at(f, u, v, w0 + k * d));

/**
 * Headdress (sheet: a thick white band over the hair from ear to ear carrying its frill of
 * chunky near-cubic blocks close together, big and small alternating, about 3 cm over the
 * crown): the band's plane leans back from `zTop` over the crown to `zEnd` at the ears.
 * Stations every `step` degrees from the crown to `span` either side; within `frill` a block on
 * every `block` spans, `gap` apart, alternating `teeth` heights, sewn into the band's top; the
 * band presses into the hair up to `pressed`.
 */
export const HEADDRESS = { zTop: -0.036, zEnd: 0.0025, span: 74, step: 2, width: 0.032, flare: 0.07, thickness: 0.012, frill: 68, block: 6, gap: 0.003, teeth: [0.026, 0.016], sewn: 0.0025, pressed: 0.003 } as const;

function headdress(m: Model, center: Tuple3, q: Query): void {
  const H = HEADDRESS;
  // Narrow over the crown (behind the ahoge), flaring toward the ears.
  const wideAt = (a: number): number => H.width + (H.flare - H.width) * (1 - Math.cos((a * Math.PI) / 180));
  const sections: Tuple3[][] = [];
  const tops: { readonly c: Tuple3; readonly n: Tuple3 }[] = [];
  const angles: number[] = [];
  for (let a = -H.span; a <= H.span + 1e-9; a += H.step) angles.push(a);
  const stations = angles.map((a) => {
    const r = (a * Math.PI) / 180;
    const z = H.zTop + (H.zEnd - H.zTop) * (1 - Math.cos(r));
    const dir: Tuple3 = [Math.sin(r), Math.cos(r), 0];
    const b = unit(cross([Math.cos(r), -Math.sin(r), 0], dir));
    const o: Tuple3 = [center[0], center[1], center[2] + z];
    // Its underside lies on the hair: five points across it, each just inside the outermost hair
    // around it (half a station along, an eighth of the width across), so it bridges facet
    // ridges and layer steps instead of cutting them; into the valleys between the crown's clumps.
    const along = unit(cross(b, dir));
    const reachAt = (u: number, v: number) => dot(sub(hit(q, add(add(add(o, b, u), along, v), dir, 0.4), [-dir[0], -dir[1], -dir[2]], `headdress ${a}`).point, o), dir);
    const around = (H.step * Math.PI) / 360;
    const wide = wideAt(a);
    const under = [-0.5, -0.25, 0, 0.25, 0.5].map((k) => k * wide).map((k) => {
      const r = Math.max(...[-1, 0, 1].flatMap((i) => [-1, 0, 1].map((j) => reachAt(k + (i * wide) / 8, j * around * reachAt(k, 0)))));
      return add(add(o, b, k), dir, r - SEAT.depth);
    });
    return { o, dir, b, wide, under, reach: Math.max(...under.map((p) => dot(sub(p, o), dir))) };
  });
  // Its top is level across and constant along each frill block: `thickness` over the highest
  // hair under the block, so each block stands on an even arc.
  for (const [i, st] of stations.entries()) {
    // A station on a block's boundary belongs to both blocks.
    const b0 = Math.floor(i / H.block) * H.block;
    const block = stations.slice(Math.max(0, i % H.block === 0 ? b0 - H.block : b0), b0 + H.block + 1);
    const top = add(st.o, st.dir, Math.max(...block.map((x) => x.reach)) + H.thickness);
    sections.push([...st.under, add(top, st.b, st.wide / 2), add(top, st.b, -st.wide / 2)]);
    tops.push({ c: top, n: st.dir });
  }
  m.loft({ profiles: sections, match: 'index', label: 'headdress-band', tag: 'headdress', material: 'white' });
  m.tag(sel.createdBy('headdress-band'), 'headdress-band');
  // The frill: blocks sewn onto the band's top (`sewn` deep at most), each over `block` spans.
  let k = 0;
  for (let i = 0; i + H.block < angles.length; i += H.block) {
    const mid = ((angles[i] as number) + (angles[i + H.block] as number)) / 2;
    if (Math.abs(mid) > H.frill) continue;
    const [t0, t1] = [tops[i] as { c: Tuple3; n: Tuple3 }, tops[i + H.block] as { c: Tuple3; n: Tuple3 }];
    const t = unit(sub(t1.c, t0.c));
    const c = add(t0.c, sub(t1.c, t0.c), 0.5);
    const n = unit(add(t0.n, t1.n));
    const side = unit(cross(t, n));
    const half = Math.hypot(...sub(t1.c, t0.c)) / 2 - H.gap / 2;
    const h = H.teeth[k % 2] as number;
    const ring = (lift: number, shrink: number): Tuple3[] => {
      const [w, l] = [(wideAt(mid) / 2) * shrink, half * shrink];
      return [add(add(add(c, t, -l), side, -w), n, lift), add(add(add(c, t, l), side, -w), n, lift), add(add(add(c, t, l), side, w), n, lift), add(add(add(c, t, -l), side, w), n, lift)];
    };
    const label = `headdress-tooth-${k}`;
    m.loft({ profiles: [ring(-SEAT.depth, 1), ring(h * 0.7, 0.96), ring(h, 0.82)], match: 'index', label, tag: 'headdress', material: 'white' });
    m.tag(sel.createdBy(label), 'headdress-teeth');
    k++;
  }
}

/**
 * Whale fin (sheet: a navy faceted wedge rising outward and back from behind the band's end to a
 * point, a white five-step trim along its lower edge): diamond sections from the root (height
 * `root`, `thickness` thick) to the tip `tip` along the fin direction (outward `out`, back `back`);
 * its root slides out onto the hair, its corners within `reach` of the band's end meet it; trim `steps` deep `trim`.
 */
export const FIN = { y: 0.762, z: -0.042, reach: 0.02, root: [-0.055, 0.055], tip: [0.115, 0.06], out: 0.13, back: 0.07, thickness: 0.024, steps: 5, trim: 0.026 } as const;

function fin(m: Model, side: 'l' | 'r', q: Query, band: FaceSelector, facets = false): void {
  const s = side === 'l' ? 1 : -1;
  const F = FIN;
  const u = unit([s * F.out, 0, -F.back]);
  const v: Tuple3 = [0, 1, 0];
  const n = unit(cross(u, v));
  const [lo, hi] = F.root;
  const [tu, tv] = F.tip;
  const t = F.thickness / 2;
  const anchor = hit(q, [s * 0.5, F.y, F.z], [-s, 0, 0], `fin-${side}`).point;
  const f: Frame = { o: anchor, n, u, v };
  // Its root slides out along the fin's direction to the outermost point of the hair across the
  // root section (and the trim's), just inside it.
  const reach: number[] = [];
  // G6: the plate's own rows only. The trim row below it lies over the side lock, which the
  // faceted cap's coarser dome leaves proud there: sampling it set the right root up to 1 cm off
  // the hair (fin-r-plate | hair apart).
  for (const h of facets ? [lo, (lo + hi) / 2, hi] : [lo - F.trim, lo, (lo + hi) / 2, hi]) {
    for (const w of [-t, 0, t]) {
      const p = q.project(at(f, 0.1, h, w), [-u[0], -u[1], -u[2]], 0.3)?.point;
      if (p !== undefined) reach.push(dot(sub(p, anchor), u));
    }
  }
  if (reach.length === 0) throw new Error(`fin-${side} found no hair`);
  const u0 = Math.max(...reach) - SEAT.depth;
  // Faceted sections: a sharp bottom edge rising to the tip, a level top with some thickness
  // (where it meets the band), thickest in the middle.
  const section = (k: number): Tuple3[] => {
    const uu = u0 + tu * k;
    const vb = lo + (tv - lo) * k;
    const vt = hi + (tv - hi) * k;
    const vm = (vb + vt) / 2;
    const tt = t * (1 - k) + 0.001 * k;
    return [at(f, uu, vb, 0), at(f, uu, vm, tt), at(f, uu, vt, tt * 0.6), at(f, uu, vt, -tt * 0.6), at(f, uu, vm, -tt)];
  };
  const name = { label: `fin-${side}-plate`, tag: `fin-${side}`, material: 'navy' };
  m.loft({ profiles: [section(0), section(0.45), section(0.97)], match: 'index', ...name });
  ownTag(m, name);
  // Its root's corners within `reach` of the band's end it stands behind meet it.
  seatBase(m, sel.createdBy(name.label), { o: at(f, u0, 0, 0), n: u, u: v, v: n }, 0, band, F.reach);
  // Trim: the lower edge from the root to the tip, then back in steps below it.
  const edge = (k: number): [number, number] => [u0 + tu * (k / F.steps) * 0.97, lo + (tv - lo) * (k / F.steps) * 0.97];
  const stair: [number, number][] = [edge(0), edge(F.steps)];
  for (let k = F.steps; k >= 1; k--) {
    const [a, b] = [edge(k), edge(k - 1)];
    stair.push([a[0], a[1] - F.trim], [b[0], a[1] - F.trim]);
  }
  plate(m, f, stair, -t * 0.5, t * 0.5, { label: `fin-${side}-trim`, tag: `fin-${side}`, material: 'white' });
}

/**
 * A bow on a surface frame: the knot (a square `knot` wide, `deep` thick), two loops puffing out
 * to `loop` = [reach, half height] (`loopDeep` at their fullest) and two tails hanging to
 * `tail` = [spread, drop, width]: the knot from `knotBase` along the frame normal, the loops and
 * tails from `w0` (clear of the seat by default).
 */
interface Bow {
  readonly knot: number;
  readonly deep: number;
  readonly loop: readonly [number, number];
  readonly loopDeep: number;
  readonly tail: readonly [number, number, number];
  readonly tailDeep: number;
}

function bow(m: Model, f: Frame, b: Bow, name: string, tag: string, material: string, knotBase: number, tails = true, w0 = knotBase + SEAT.clear): void {
  const k = b.knot / 2;
  for (const s of [1, -1]) {
    // A folded loop: pinched at (just inside) the knot, full in the middle, flaring at its end.
    const loop = { label: `${name}-loop-${s > 0 ? 'a' : 'b'}`, tag, material };
    m.loft({ profiles: [puffSection(f, s * (k - SEAT.depth), k * 0.8, b.loopDeep * 0.6, w0), puffSection(f, s * (k + (b.loop[0] - k) * 0.55), b.loop[1] * 0.85, b.loopDeep, w0), puffSection(f, s * b.loop[0], b.loop[1], b.loopDeep * 0.55, w0)], match: 'index', ...loop });
    ownTag(m, loop);
    if (!tails) continue;
    const [spread, drop, width] = b.tail;
    const tail: [number, number][] = [
      [s * k * 0.1, -k + SEAT.depth],
      [s * (k * 0.1 + width * 0.7), -k + SEAT.depth],
      [s * (spread + width / 2), -drop + width * 0.4],
      [s * spread, -drop + width * 0.15],
      [s * (spread - width / 2), -drop],
    ];
    plate(m, f, tail, w0, w0 + b.tailDeep, { label: `${name}-tail-${s > 0 ? 'a' : 'b'}`, tag, material });
  }
  plate(m, f, [[-k, -k], [k, -k], [k, k], [-k, k]], knotBase, w0 + b.deep, { label: `${name}-knot`, tag, material });
}

/** Ribbon bows (sheet: light blue, about 7 x 7 cm, on the band's end in front of the fins, turned to the front). */
export const RIBBON: Bow & { readonly y: number; readonly z: number; readonly turn: number } = { y: 0.812, z: -0.012, turn: 45, knot: 0.012, deep: 0.014, loop: [0.032, 0.02], loopDeep: 0.012, tail: [0.012, 0.036, 0.008], tailDeep: 0.006 };

function ribbon(m: Model, side: 'l' | 'r', q: Query): void {
  const R = RIBBON;
  const s = side === 'l' ? 1 : -1;
  const h = hit(q, [s * 0.5, R.y, R.z], [-s, 0, 0], `ribbon-${side}`);
  // Turned from the side toward the front.
  const r = (R.turn * Math.PI) / 180;
  const n = unit([s * Math.cos(r), 0, Math.sin(r)]);
  const f: Frame = { o: h.point, n, u: unit(cross([0, 1, 0], n)), v: [0, 1, 0] };
  // Tied on: its knot on the highest point under it, the loops and tails clear of the hair.
  const knot = reachUnder(q, f, [-R.knot / 2, R.knot / 2], [-R.knot / 2, R.knot / 2], 0);
  const w0 = Math.max(knot, reachUnder(q, f, [-R.loop[0], R.loop[0]], [-R.tail[1], R.loop[1]])) + SEAT.clear;
  bow(m, f, R, `ribbon-${side}`, `ribbon-${side}`, 'ribbon', knot, true, w0);
}

/**
 * Bowtie and brooch (sheet: a navy bow 13 cm across at the collar's base with full, folded loops,
 * tails to 0.50, a prominent oval blue gem about 2 cm in a gold rim on its knot, set into it up to
 * `set`).
 */
export const BOWTIE: Bow & { readonly y: number } = { y: 0.555, knot: 0.022, deep: 0.018, loop: [0.064, 0.026], loopDeep: 0.022, tail: [0.03, 0.06, 0.018], tailDeep: 0.006 };
export const BROOCH = { rim: [0.012, 0.0145, 0.004], gem: [0.0085, 0.0105, 0.006], set: 0.002 } as const;

function bowtie(m: Model, q: Query): void {
  const h = hit(q, [0, BOWTIE.y, 0.5], [0, 0, -1], 'bowtie');
  const n = unit(h.normal);
  const f: Frame = { o: h.point, n, u: [1, 0, 0], v: across([0, 1, 0], n) };
  // Tied on: its knot flat on the highest point of the collar and bib under it (a facet ridge
  // never cuts it), the loops and tails clear of them.
  const k = BOWTIE.knot / 2;
  const knot = reachUnder(q, f, [-k, k], [-k, k], 0);
  const w0 = Math.max(knot, reachUnder(q, f, [-BOWTIE.loop[0], -BOWTIE.knot, 0, BOWTIE.knot, BOWTIE.loop[0]], [-BOWTIE.tail[1], -BOWTIE.loop[1], 0, BOWTIE.loop[1]])) + SEAT.clear;
  bow(m, f, BOWTIE, 'bowtie', 'bowtie', 'navy', knot, true, w0);
  // Brooch on the knot's front: an oval gold rim, and an oval faceted gem standing proud of it.
  const front = w0 + BOWTIE.deep - SEAT.depth;
  const tilt = 90 - (Math.atan2(n[1], n[2]) * 180) / Math.PI;
  const [rw, rh, rd] = BROOCH.rim;
  const [gw, gh, gd] = BROOCH.gem;
  m.cylinder({ radiusBottom: 1, radiusTop: 0.92, height: rd, radialSegments: 10, center: [0, rd / 2, 0], label: 'brooch', tag: 'brooch', material: 'gold' });
  m.scale(sel.createdBy('brooch'), [rw, 1, rh]);
  m.sphere({ radius: 1, widthSegments: 8, heightSegments: 4, center: [0, 0, 0], label: 'brooch-gem', tag: 'brooch-gem', material: 'gem' });
  m.scale(sel.createdBy('brooch-gem'), [gw, gd, gh]);
  // The gem stands in the rim's setting, its bottom on the knot.
  m.translate(sel.createdBy('brooch-gem'), [0, gd, 0]);
  for (const label of ['brooch', 'brooch-gem']) {
    m.rotate(sel.createdBy(label), 'x', tilt);
    m.translate(sel.createdBy(label), at(f, 0, 0, front));
  }
}

/**
 * Back bow (sheet: a large white bow tied at the back of the waistband, loops about 14 cm across,
 * its ties falling to `bottom` (tie a, on the figure's right, to the skirt beside the tail's root;
 * tie b ends above the tail, which sweeps out under it to the left): the knot at `y` on the waistband,
 * the loops clear of the ties that pass under it; each tie, `stations` rows long, spreads from
 * the knot's middle to `tail[0]` and lies on the tie seat (TIE_SEAT: the skirt, hem, waistband
 * and tail), every point of its underside `sink` into it; its own seat is this one part, so one
 * designed contact covers it.
 */
export const BACK_BOW: Bow & { readonly y: number; readonly bottom: readonly [number, number]; readonly sink: number; readonly gap: number; readonly stations: number } = {
  y: 0.44,
  bottom: [0.272, 0.31],
  sink: 0.001,
  knot: 0.03,
  deep: 0.03,
  loop: [0.072, 0.03],
  loopDeep: 0.034,
  tail: [0.07, 0.17, 0.03],
  tailDeep: 0.006,
  gap: 0.003,
  stations: 28,
};

/** What the back bow's ties lie on: one part, so their seat is one designed contact. */
export const TIE_SEAT = 'tie-seat';

function backBow(m: Model, onto: FaceSelector, seat: FaceSelector, facets?: boolean): void {
  const B = BACK_BOW;
  m.tag(seat, TIE_SEAT);
  const q = surface(m, seat.or(onto));
  const h = hit(q, [0, B.y, -0.6], [0, 0, 1], 'back-bow');
  // Facing straight back (the sheet's back view shows it full on).
  const f: Frame = { o: h.point, n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] };
  const w0 = reachUnder(q, f, [-B.loop[0], -B.loop[0] / 2, 0, B.loop[0] / 2, B.loop[0]], [-B.loop[1], 0, B.loop[1]]);
  // The loops clear the ties that pass under them from the knot.
  bow(m, f, B, 'back-bow', 'back-bow', 'white', w0, false, w0 + B.tailDeep + B.gap + SEAT.clear);
  // Tied on the waistband. G6: its band is faceted, whose crests a draped knot would cut between
  // its vertices: the knot keeps its plane, which touches the band's backmost point under it.
  if (facets !== true) seatBase(m, sel.createdBy('back-bow-knot'), f, w0, onto);
  else {
    const k = B.knot / 2;
    const wk = reachUnder(surface(m, onto), f, [-k, 0, k], [-k, 0, k], 0);
    if (wk < w0) m.translate(sel.createdBy('back-bow-knot'), [f.n[0] * (wk - w0), f.n[1] * (wk - w0), f.n[2] * (wk - w0)]);
  }
  const [spread, , width] = B.tail;
  const top = h.point[1] - B.knot / 2 + B.gap;
  // The underside carries a point every quarter of the tie's half width, so it follows the seat.
  const under = Array.from({ length: 9 }, (_, j) => -1 + j / 4);
  for (const s of [1, -1]) {
    const sections: Tuple3[][] = [];
    for (let i = 0; i <= B.stations; i++) {
      const t = i / B.stations;
      // Each tie starts clear of the other at the knot's middle and spreads out.
      const u0 = (width * 0.7) / 2 + 0.001;
      const u = s * (u0 + (spread - u0) * t);
      const y = top - (top - B.bottom[s > 0 ? 0 : 1]) * t;
      const w = (width * (0.7 + 0.3 * t)) / 2;
      // Each point over the outermost seat around it (half the spacing to its neighbours across and
      // along), so the seat's ridges (pleats, facets) between the points stay under the tie.
      const dy = (top - B.bottom[s > 0 ? 0 : 1]) / B.stations / 2;
      const base = under.map((k): Tuple3 => {
        const x = -u + k * w;
        const z = Math.min(...[-1, 0, 1].flatMap((a) => [-1, 0, 1].map((b) => hit(q, [x + (a * w) / 8, y + b * dy, -0.6], [0, 0, 1], 'back-bow tie').point[2])));
        return [x, y, z + B.sink];
      });
      sections.push([...base, ...base.map((p) => add(p, [0, 0, -1], B.tailDeep)).reverse()]);
    }
    const label = `back-bow-tie-${s > 0 ? 'a' : 'b'}`;
    m.loft({ profiles: sections, match: 'index', label, tag: 'apron-ties', material: 'white' });
    m.tag(sel.createdBy(label), label);
  }
}

/**
 * Tail (sheet: a thick navy whale tail from the lower back under the bow, falling over the skirt
 * and hem, sweeping out to the figure's left near the floor and up into a two-lobed fluke; white
 * belly): `root` on the skirt's back, the skirt's faces within `radius` of it as its root patch,
 * the path through `path` with per-station `scale`.
 */
export const TAIL = {
  root: [0, 0.29] as const,
  radius: 0.02,
  // Off the skirt's back first (the sheet's centreline runs inside the skirt near the root: the
  // path is the sheet's curve pushed out by the tube's radius), then the sheet's curve.
  lift: 0.02,
  path: [
    [0.012, 0.262, -0.198],
    [0.065, 0.252, -0.214],
    [0.135, 0.238, -0.222],
    [0.2, 0.218, -0.226],
    [0.25, 0.198, -0.244],
    [0.284, 0.184, -0.27],
    [0.3, 0.2, -0.302],
  ] as readonly Tuple3[],
  scale: [1, 1.05, 1.1, 1.38, 1.93, 1.76, 1.6, 1.38, 0.88],
} as const;

/**
 * Fluke (sheet: two broad, flat, faceted lobes, together about 12 x 21 cm from the front, thick
 * at the root): each half of the tail's end extruded out to its tip in `tips`, its section
 * scaled by `scale` (broad before the point).
 */
export const FLUKE = {
  tips: [[0.355, 0.296, -0.388], [0.368, 0.084, -0.404]] as readonly Tuple3[],
  scale: [1, 1, 1.75, 1.5, 0.12],
} as const;

function tail(m: Model, facets = false): void {
  const q = surface(m, sel.createdBy('skirt'));
  const r = hit(q, [TAIL.root[0], TAIL.root[1], -0.5], [0, 0, 1], 'tail root');
  const n = unit(r.normal);
  const R = TAIL.radius;
  const patch = sel.createdBy('skirt').and(sel.inBox([r.point[0] - R, r.point[1] - R, r.point[2] - R], [r.point[0] + R, r.point[1] + R, r.point[2] + R], { by: 'centroid' }));
  const path: Tuple3[] = [r.point, add(r.point, n, TAIL.lift), ...TAIL.path];
  m.extrude(patch, { path, scale: [...TAIL.scale], label: 'tail' });
  m.tag(sel.createdBy('tail'), 'tail');
  m.assign(sel.createdBy('tail'), 'navy');
  // White belly: the tail's underside.
  m.assign(sel.tag('tail').and(sel.facing('-y', 50)), 'white');
  // The fluke: each half of the tail's end grows along a path out to its lobe's tip, broad
  // before its point (one piece with the tail).
  const end = centerOf(m, sel.createdBy('tail', 'top'));
  const d = unit(sub(TAIL.path.at(-1) as Tuple3, TAIL.path.at(-2) as Tuple3));
  for (const [i, tip] of FLUKE.tips.entries()) {
    const label = `fluke-${i === 0 ? 'upper' : 'lower'}`;
    const half = sel.createdBy('tail', 'top').and(sel.side(end, across(sub(tip, end), d), { by: 'centroid' }));
    const path: Tuple3[] = [end, add(end, d, 0.02), add(end, sub(tip, end), 0.35), add(end, sub(tip, end), 0.68), tip];
    m.extrude(half, { path, scale: [...FLUKE.scale], label });
    m.tag(sel.createdBy(label), label);
  }
  m.tag(sel.createdBy('fluke-upper').or(sel.createdBy('fluke-lower')), 'fluke');
  m.assign(sel.tag('fluke'), 'navy');
  if (facets) facetFlukes(m, end);
}

/**
 * G6 flukes (facet-plan.json tail `flukes`): each G5 lobe rebuilt as facets, never remeshed (a
 * coarser field or QEM toward the plan's count collapses the extruded lobes' end caps). The lobe
 * runs along its axis (the tail's end to its tip) from `root` inside the tail's capped end to
 * `end` of its length; `columns` lines along it, each at even perimeter around the G5 lobe's
 * section there (its support polygon in the plane of the two lobes, as the trim bands), alternate
 * lines half a segment apart, so each strip between two lines is a run of triangles whose long
 * edges follow the lobe (facetUnit's staggered phases): `segments` and a half along. Past `lean`
 * of its length the sections' centres lean onto the axis, so the last facets close evenly on the
 * tip, a fan of `columns` facets to its point; the root ring, `rootScale` of the lobe's first
 * section, closes in a fan `rootTip` past its centre (flat: a deeper point leaves slivers) inside
 * the tail, seated in it as a designed contact (faceting.ts flukeContacts).
 */
export const FLUKE_FACETS = { columns: 6, segments: 4, root: 0.016, end: 0.88, lean: 0.6, rootScale: 0.85, rootTip: 0 } as const;

function facetFlukes(m: Model, end: Tuple3): void {
  const F = FLUKE_FACETS;
  const mesh = m.editMesh;
  const [A, B] = FLUKE.tips as [Tuple3, Tuple3];
  const n = unit(cross(sub(A, end), sub(B, end)));
  const lobes: { label: string; tris: [Tuple3, Tuple3, Tuple3][] }[] = [];
  for (const [i, tip] of [A, B].entries()) {
    const label = `fluke-${i === 0 ? 'upper' : 'lower'}`;
    const a = unit(sub(tip, end));
    const L = Math.hypot(...sub(tip, end));
    const w = cross(n, a);
    const faces = sel.createdBy(label).evaluate(mesh).map((f) => mesh.faceVertices(f).map((v) => mesh.position(v) as unknown as Tuple3));
    // The G5 lobe's section at s along its axis, in (w, n).
    const section = (s: number): [number, number][] => {
      const out: [number, number][] = [];
      for (const ps of faces)
        for (const [k, p] of ps.entries()) {
          const q = ps[(k + 1) % ps.length] as Tuple3;
          const [sp, sq] = [dot(sub(p, end), a), dot(sub(q, end), a)];
          if ((sp - s) * (sq - s) >= 0) continue;
          const x = add(p, sub(q, p), (s - sp) / (sq - sp));
          out.push([dot(sub(x, end), w), dot(sub(x, end), n)]);
        }
      if (out.length < 3) throw new Error(`${label}: no section at ${s.toFixed(3)}`);
      return out;
    };
    const at = (s: number, x: number, y: number): Tuple3 => add(add(add(end, a, s), w, x), n, y);
    // The ring of column points at s: the root ring (inside the tail) from the lobe's first section, shrunk.
    const ring = (s: number): Tuple3[] => {
      const pts = section(Math.max(s, 0.01 * L));
      const c: [number, number] = [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
      const toAxis = s > F.lean * L ? (L - s) / (L - F.lean * L) : 1;
      const scale = s < 0 ? F.rootScale : 1;
      return perimeterRing(supportPolygon(pts.map(([x, y]) => [x - c[0], y - c[1]]), 64), F.columns, 0).map(([x, y]) => at(s, c[0] * toAxis + x * scale, c[1] * toAxis + y * scale));
    };
    const C = F.columns;
    const [s0, s1] = [-F.root, F.end * L];
    const seg = (s1 - s0) / (F.segments + 0.5);
    const phase = (j: number) => (j % 2) / 2;
    const rings = new Map<number, Tuple3[]>();
    const P = (j: number, k: number): Tuple3 => {
      const s = s0 + (k + phase(j)) * seg;
      const key = Math.round(s * 1e6);
      const r = rings.get(key) ?? ring(s);
      rings.set(key, r);
      return r[j] as Tuple3;
    };
    const tris: [Tuple3, Tuple3, Tuple3][] = [];
    for (let j = 0; j < C; j++) {
      const j1 = (j + 1) % C;
      for (let k = 0; k < F.segments; k++) {
        if (phase(j1) >= phase(j)) tris.push([P(j, k), P(j, k + 1), P(j1, k)], [P(j, k + 1), P(j1, k + 1), P(j1, k)]);
        else tris.push([P(j, k), P(j, k + 1), P(j1, k + 1)], [P(j, k), P(j1, k + 1), P(j1, k)]);
      }
    }
    const first = Array.from({ length: C }, (_, j) => P(j, 0));
    const centre: Tuple3 = [0, 1, 2].map((k) => first.reduce((t, p) => t + (p[k] as number), 0) / C) as Tuple3;
    const root = add(centre, a, -F.rootTip);
    for (let j = 0; j < C; j++) {
      const j1 = (j + 1) % C;
      tris.push([P(j1, F.segments), P(j, F.segments), tip], [P(j, 0), P(j1, 0), root]);
    }
    lobes.push({ label, tris });
  }
  // The G5 lobes out, the tail's end capped, the faceted lobes in.
  m.delete(sel.tag('fluke'));
  m.fillHoles(sel.edges.meshBoundary(), { label: 'tail', tag: 'tail', material: 'navy' });
  m.tag(sel.createdBy('tail'), FLUKE_SEAT);
  for (const { label, tris } of lobes) {
    const volume = tris.reduce((t, [p, q, r]) => t + dot(p, cross(q, r)), 0);
    const lobe = model();
    for (const [p, q, r] of tris) lobe.polygon({ points: volume > 0 ? [p, q, r] : [p, r, q], label, material: 'navy' });
    lobe.weld({ distance: 1e-6 });
    m.append(lobe, { tag: label });
    m.tag(sel.createdBy(label), 'fluke');
    m.tag(sel.createdBy(label), 'tail');
  }
}

/** Each fluke lobe's axis (the tail's end to its tip): the plan's `fluke-*` path flow. */
export function flukeAxes(_m: Model): { readonly faces: FaceSelector; readonly curve: readonly Tuple3[] }[] {
  const end = TAIL.path.at(-1) as Tuple3;
  return FLUKE.tips.map((tip, i) => ({ faces: sel.createdBy(`fluke-${i === 0 ? 'upper' : 'lower'}`), curve: [end, tip] }));
}

/** The tail body the faceted lobes are seated in (its faces carry this tag; the lobes keep `tail`). */
const FLUKE_SEAT = 'tail-body';

/** G6's fluke seats: each faceted lobe's root in the tail's end, and the two roots in each other. */
export function flukeContacts(): DesignedContact[] {
  const tolerance = FLUKE_FACETS.root + FLUKE_FACETS.rootTip + 0.005;
  return [
    { parts: ['fluke-upper', FLUKE_SEAT], tolerance },
    { parts: ['fluke-lower', FLUKE_SEAT], tolerance },
    { parts: ['fluke-upper', 'fluke-lower'], tolerance },
  ];
}

/** A section's support polygon: its support lines in `dirs` directions, intersected along even rays. */
function supportPolygon(points: readonly (readonly [number, number])[], dirs: number): [number, number][] {
  const angles = Array.from({ length: dirs }, (_, j) => (j / dirs) * 2 * Math.PI);
  const support = angles.map((t) => Math.max(...points.map(([x, y]) => x * Math.cos(t) + y * Math.sin(t))));
  return angles.map((t) => {
    const r = Math.min(...angles.map((b, j) => (Math.cos(t - b) > 0.2 ? (support[j] as number) / Math.cos(t - b) : Infinity)));
    return [r * Math.cos(t), r * Math.sin(t)];
  });
}

/** `n` points even in perimeter around a closed polygon, from `phase` of a step. */
function perimeterRing(poly: readonly (readonly [number, number])[], n: number, phase: number): [number, number][] {
  const acc = [0];
  for (const [i, p] of poly.entries()) {
    const q = poly[(i + 1) % poly.length] as readonly [number, number];
    acc.push((acc[i] as number) + Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  const total = acc.at(-1) as number;
  return Array.from({ length: n }, (_, k) => {
    const t = ((((k + phase) / n) * total) % total + total) % total;
    let i = 0;
    while ((acc[i + 1] as number) < t) i++;
    const f = (t - (acc[i] as number)) / ((acc[i + 1] as number) - (acc[i] as number));
    const [p, q] = [poly[i] as readonly [number, number], poly[(i + 1) % poly.length] as readonly [number, number]];
    return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])];
  });
}

/**
 * The G4 result (hair on the dressed figure) with its attachments, as a session of its own: the
 * tail from the skirt; the bowtie and brooch, the back bow and its ties; the headwear on the hair
 * (checkpoints tail, bows, headwear). Parts are found by their tags. `base` reshapes the
 * figure, hair and tail first, so the other attachments are seated on the result; `style`
 * builds the figure's and hair's walls (G6: tapered edges).
 */
export function buildAttached(base?: (m: Model) => void, style: GarmentStyle = {}): Model {
  const figure = buildDressed(style);
  const grown = buildHair(figure, style);
  // Both sessions keep their labels (the skirt's outer wall is its own label, apart from its
  // inner copy).
  const m = model();
  m.append(figure);
  m.append(grown);
  tail(m, style.facets === true);
  m.checkpoint('tail');
  // A later stage reshapes the base (the figure, hair and the tail grown from the skirt) before
  // the other attachments are seated on it (G6 faceting).
  base?.(m);
  const chest = sel.tag('collar').or(sel.tag('apron-bib')).or(sel.tag('bodice')).or(sel.tag('apron-frill-l')).or(sel.tag('apron-frill-r'));
  bowtie(m, surface(m, chest));
  // The back bow tied on the waistband, its ties down the skirt beside the tail's root.
  backBow(m, sel.tag('waistband'), sel.createdBy('skirt').or(sel.tag('skirt-hem')).or(sel.tag('tail')).or(sel.tag('waistband')), style.facets);
  m.checkpoint('bows');
  // The head's centre, as the hair's (the cap's centre height over the skull's middle). Depth from
  // the G2 skull rings the hair was built on, not the built face: face edits leave the band seated.
  const head = m.bounds(sel.tag('head').minus(sel.tag('hair')));
  if (!head.ok) throw head.error;
  const rings = headRings();
  const depth = (Math.max(...rings.map((r) => r[2])) + Math.min(...rings.map((r) => r[3]))) / 2;
  const c: Tuple3 = [(head.value.min[0] + head.value.max[0]) / 2, 0.775, depth];
  const hairQuery = surface(m, sel.tag('hair').minus(sel.createdBy('hair-ahoge')));
  headdress(m, c, hairQuery);
  const worn = sel.tag('hair').or(sel.tag('headdress'));
  const wornQuery = surface(m, worn);
  for (const side of ['l', 'r'] as const) fin(m, side, wornQuery, sel.tag('headdress-band'), style.facets === true);
  for (const side of ['l', 'r'] as const) ribbon(m, side, wornQuery);
  m.checkpoint('headwear');
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

/**
 * Designed contacts of the attachments (validate): each bow's knot with its loops and tails or
 * ties, the frill on its band, the fins' plates and trims, the fluke lobes on the tail's end, and
 * every part with what it is seated on. Each pair touches (validate reports it `within`).
 */
export function attachmentContacts(): DesignedContact[] {
  const pairs: [string, string, number?][] = [];
  for (const b of ['bowtie', 'ribbon-l', 'ribbon-r']) for (const p of ['loop-a', 'loop-b', 'tail-a', 'tail-b']) pairs.push([`${b}-knot`, `${b}-${p}`]);
  for (const p of ['loop-a', 'loop-b']) pairs.push(['back-bow-knot', `back-bow-${p}`]);
  // The ties pass under the back bow's knot.
  for (const p of ['tie-a', 'tie-b']) pairs.push(['back-bow-knot', `back-bow-${p}`, BACK_BOW.deep]);
  for (const seat of SEATED) pairs.push([seat[0], seat[1]]);
  // The ties' undersides lie in their seat (its facets' ridges between their points included).
  pairs.push(['apron-ties', TIE_SEAT, BACK_BOW.sink + 0.005]);
  // The gem is set into its rim (its lower part in the setting) and stands on the knot.
  pairs.push(['brooch', 'bowtie-knot', BROOCH.set], ['brooch-gem', 'brooch', BROOCH.gem[2] + SEAT.depth], ['brooch-gem', 'bowtie-knot', BROOCH.set]);
  pairs.push(['headdress-teeth', 'headdress-band', HEADDRESS.sewn], ['headdress-band', 'hair', HEADDRESS.pressed]);
  for (const s of ['l', 'r']) pairs.push([`fin-${s}-plate`, `fin-${s}-trim`]);
  return pairs.map(([a, b, tolerance]) => (tolerance === undefined ? { parts: [a, b] } : { parts: [a, b], tolerance }));
}

/** Each seated part (by tag) and the part it is seated on. */
export const SEATED: readonly (readonly [string, string])[] = [
  ['bowtie-knot', 'apron-bib'],
  ['back-bow-knot', 'waistband'],
  ['fin-l-plate', 'hair'],
  ['fin-r-plate', 'hair'],
  ['ribbon-l-knot', 'hair'],
  ['ribbon-r-knot', 'hair'],
];
