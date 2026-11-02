import { type FaceSelector, type Model, model, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { BOARD, LANDMARK, part } from './reference.ts';

/**
 * Case C-200 stage G2 (base body, structure-first): the chibi anatomy as one connected
 * quad cage, box-modeled, then Catmull-Clark subdivided. Every connection is a shared
 * ring, never two solids crossing: the trunk grows from a pelvis block by
 * extrude-and-scale rings, the arms grow out of the shoulder band's side faces (the
 * armhole) and bend down through elbow and wrist into mitten fists, the legs grow
 * straight down from the pelvis underside to heel-and-instep feet, and the neck grows
 * up into the head cage (chin, jaw, cheek, eye, temple, cranium and crown rings).
 * Exposed parts take the G1 measurements (leg width and spacing, hand size, face
 * front, chin); hidden parts follow chibi proportions inside the garment envelope.
 * Cage sizes are set larger than the targets by the subdivision shrink (`CC`).
 */

const lm = (name: string): number => LANDMARK[name] as number;

/** Cage-to-surface share after 2 Catmull-Clark levels: measured 1 for these long columns (body-metrics). */
export const CC = 1;

/**
 * Trunk rings bottom to top: [y, half-width x, front z, back z] of the finished body.
 * The chest comes forward into a flat plane under the bib; the back curves (shoulder
 * blades behind the chest ring, the small of the back at the waist).
 */
export const TRUNK: readonly (readonly [number, number, number, number])[] = [
  [0.24, 0.088, 0.06, -0.068],
  [0.32, 0.086, 0.058, -0.064],
  [0.44, 0.068, 0.054, -0.048],
  [0.52, 0.078, 0.068, -0.052],
  [0.575, 0.094, 0.052, -0.058],
  [0.585, 0.034, 0.03, -0.03],
];

/** Leg columns (G1 front view, y 0.10-0.17): width 0.089, spacing 0.154. */
export const LEG = { halfWidth: 0.0445, x: 0.077, ankle: 0.07, sockTop: 0.136, kneeY: 0.2 } as const;

/**
 * Head rings bottom to top: [y, half-width, front z, back z] of the finished head. One
 * round chibi mass: the widest ring is the cheek just under the eyes, the face front
 * stays flat at the measured 0.125 m from the cheek to the brow, the jaw runs
 * diagonally from under the ear to a small chin in front (z 0.09), and the cranium
 * rounds off without a back-top bulge.
 */
export function headRings(): readonly (readonly [number, number, number, number])[] {
  const face = part('front', 'face');
  const front = -part('right', 'face').bounds[0];
  const chin = lm('chin');
  const crown = lm('crown') - 0.022;
  const half = face.size[0] / 2;
  return [
    // Neck to jaw: the column meets the jaw's underside behind the chin.
    [chin - 0.01, 0.036, 0.045, -0.03],
    [chin, 0.035, 0.083, 0.0],
    // Jaw: front widths 0.10 / 0.14 / 0.17 m at y 0.63 / 0.64 / 0.65 (sheet face).
    [chin + 0.015, 0.045, 0.1, -0.03],
    [chin + 0.03, 0.085, 0.12, -0.06],
    [chin + 0.065, half * 0.99, front - 0.004, -0.095],
    [lm('eye-line'), half, front - 0.004, -0.118],
    [lm('eye-line') + 0.08, half * 0.97, front - 0.008, -0.13],
    [crown - 0.03, half * 0.8, front - 0.04, -0.118],
    [crown, half * 0.36, 0.035, -0.06],
  ];
}

/** Center of the bounds of `s`. */
export const centerOf = (m: Model, s: FaceSelector): Tuple3 => {
  const b = m.bounds(s);
  if (!b.ok) throw b.error;
  return [0, 1, 2].map((k) => ((b.value.min[k] as number) + (b.value.max[k] as number)) / 2) as Tuple3;
};

/** Extrude a face region and return its new top. */
function grow(m: Model, faces: FaceSelector, label: string, distance: number): FaceSelector {
  m.extrude(faces, { distance, region: 'merged', label });
  return sel.createdBy(label, 'top');
}

type Trunk = readonly [number, number, number, number];

function trunk(m: Model): void {
  const [y0, a0, f0, k0] = TRUNK[0] as Trunk;
  const [y1, , f1, k1] = TRUNK[1] as Trunk;
  m.box({ size: [(2 * a0) / CC, y1 - y0, (f0 - k0) / CC], center: [0, (y0 + y1) / 2, (f0 + k0) / 2], segments: [2, 1, 2], tag: 'torso', material: 'skin' });
  // The box spans the pelvis ring; move its top onto the next ring's depth center.
  m.translate(sel.tag('torso').and(sel.facing('+y', 10)), [0, 0, (f1 + k1) / 2 - (f0 + k0) / 2]);
  let top = sel.tag('torso').and(sel.facing('+y', 10));
  for (let i = 2; i < TRUNK.length; i++) {
    const [y, a, f, k] = TRUNK[i] as Trunk;
    const [yp, ap, fp, kp] = TRUNK[i - 1] as Trunk;
    top = grow(m, top, `trunk-${i}`, y - yp);
    m.translate(top, [0, 0, (f + k) / 2 - (fp + kp) / 2]);
    m.scale(top, [a / ap, 1, (f - k) / (fp - kp)], [0, y, (f + k) / 2]);
  }
}

/**
 * Grow a ring to a target point: extrude a short step, turn the new top about z by
 * `deg` (the segment's direction in the front plane) around its center, then move
 * its center onto `target` and scale it uniformly by `k`.
 */
function growTo(m: Model, top: FaceSelector, label: string, target: Tuple3, deg: number, k: number): FaceSelector {
  const next = grow(m, top, label, 0.01);
  const c = centerOf(m, next);
  m.rotate(next, 'z', deg, c);
  m.translate(next, [target[0] - c[0], target[1] - c[1], target[2] - c[2]]);
  m.scale(next, [k, k, k], target);
  return next;
}

/** Arm from the shoulder band's side face: elbow and wrist targets, then a mitten fist. */
function arm(m: Model, side: 'l' | 'r'): void {
  const s = side === 'l' ? 1 : -1;
  const cuff = part('front', `cuff-${side}`);
  const hand = part('front', `hand-${side}`);
  const z = -part('right', 'cuff-l').center[0];
  const armhole = sel.createdBy('trunk-4', 'side').and(sel.facing(s > 0 ? '+x' : '-x', 30));
  let top = grow(m, armhole, `armhole-${side}`, 0.012);
  m.scale(top, [1, 0.8, 0.75], centerOf(m, top));
  const shoulder = centerOf(m, top);
  // Wrist target: the fist then ends at the sheet's hand bottom (0.304 l / 0.314 r) under
  // the measured hand center; the offsets are the fist's own length and lean.
  const wrist: Tuple3 = [cuff.center[0] + s * 0.02, cuff.bounds[1] + 0.032, z];
  const elbow: Tuple3 = [shoulder[0] + (wrist[0] - shoulder[0]) * 0.5, shoulder[1] + (wrist[1] - shoulder[1]) * 0.5, z * 0.5];
  // Direction angles in the front plane (from +x for the left arm): each ring faces along its segment.
  const angle = (a: Tuple3, b: Tuple3) => (Math.atan2(b[1] - a[1], (b[0] - a[0]) * s) * 180) / Math.PI;
  top = growTo(m, top, `arm-${side}-upper`, elbow, s * angle(shoulder, elbow), 0.92);
  top = growTo(m, top, `arm-${side}-fore`, wrist, s * (angle(elbow, wrist) - angle(shoulder, elbow)), 1);
  // Wrist ring: wider across the front (the forearm read thin) and flatter front to back.
  m.scale(top, [1.1, 1, 0.72], centerOf(m, top));
  // Mitten fist along the forearm: palm widened to the measured hand, fist, notched underside, thumb.
  top = grow(m, top, `hand-${side}-palm`, 0.008);
  const b = m.bounds(top);
  if (!b.ok) throw b.error;
  const width = Math.max(b.value.max[0] - b.value.min[0], b.value.max[1] - b.value.min[1]);
  const depth = b.value.max[2] - b.value.min[2];
  // width 0.06-0.07, depth 0.066 including the thumb (measured on the finished hand).
  const target = (0.82 * hand.size[0]) / CC;
  m.scale(top, [target / width, target / width, 0.066 / CC / depth], centerOf(m, top));
  const palm = centerOf(m, top);
  top = grow(m, top, `hand-${side}-fist`, (hand.size[1] * 0.7) / CC);
  fistBottom(m, side, top, palm, target);
  // Thumb on the inner side (toward the body), so its notch reads in the front view.
  m.extrude(sel.createdBy(`hand-${side}-fist`, 'side').and(sel.facing(s > 0 ? '-x' : '+x', 50)), { distance: 0.005, region: 'merged', label: `hand-${side}-thumb` });
}

/**
 * The fist's underside as the sheet draws it: a finger roll on the outer
 * side and a thumb tip on the inner side, split by a notch. Two knife lines across the
 * underside (projected along the hand axis) cut it into thumb, notch and finger strips;
 * the finger roll and the thumb tip grow out of their strips and the notch strip sinks
 * into the fist.
 */
function fistBottom(m: Model, side: 'l' | 'r', bottom: FaceSelector, palm: Tuple3, width: number): void {
  const s = side === 'l' ? 1 : -1;
  const c = centerOf(m, bottom);
  const l = Math.hypot(c[0] - palm[0], c[1] - palm[1], c[2] - palm[2]);
  const axis: Tuple3 = [(c[0] - palm[0]) / l, (c[1] - palm[1]) / l, (c[2] - palm[2]) / l];
  // Across the hand in the front plane, pointing away from the body (toward the fingers' outer side).
  const h = Math.hypot(axis[0], axis[1]);
  const flip = -axis[1] * s < 0 ? -1 : 1;
  const u: Tuple3 = [(flip * -axis[1]) / h, (flip * axis[0]) / h, 0];
  const at = (d: number): Tuple3 => [c[0] + u[0] * d, c[1] + u[1] * d, c[2]];
  const cuts = [-0.14 * width, -0.03 * width];
  for (const d of cuts) {
    const p = at(d);
    m.knife({ points: [[p[0], p[1], p[2] - 0.06], [p[0], p[1], p[2] + 0.06]], direction: [-axis[0], -axis[1], -axis[2]], through: true, faces: bottom });
  }
  const outside = (d: number) => sel.side(at(d), u, { by: 'centroid' });
  const inside = (d: number) => sel.side(at(d), [-u[0], -u[1], -u[2]], { by: 'centroid' });
  const fingers = bottom.and(outside(cuts[1] as number));
  const thumb = bottom.and(inside(cuts[0] as number));
  const notch = bottom.minus(outside(cuts[1] as number)).minus(inside(cuts[0] as number));
  m.translate(notch, [axis[0] * -0.006, axis[1] * -0.006, axis[2] * -0.006]);
  const roll = grow(m, fingers, `hand-${side}-fingers`, 0.014);
  m.scale(roll, [0.9, 0.9, 0.85], centerOf(m, roll));
  const tip = grow(m, thumb, `hand-${side}-thumb-tip`, 0.006);
  m.scale(tip, [0.85, 0.85, 0.8], centerOf(m, tip));
}

/** Straight leg columns at the G1 width and spacing, sock and ankle stations, foot block. */
function leg(m: Model, side: 'l' | 'r'): void {
  const s = side === 'l' ? 1 : -1;
  // The pelvis underside only: extruded faces inherit the trunk tag (fingertips face -y too).
  const pelvisBottom = (TRUNK[0] as Trunk)[0] + 0.005;
  let top = sel.tag('torso').and(sel.facing('-y', 10)).and(sel.side([0, 0, 0], [s, 0, 0])).and(sel.inBox([-1, -1, -1], [1, pelvisBottom, 1], { by: 'centroid' }));
  const hip = centerOf(m, top);
  const hb = m.bounds(top);
  if (!hb.ok) throw hb.error;
  const hipHalf = (hb.value.max[0] - hb.value.min[0]) / 2;
  top = grow(m, top, `leg-${side}-thigh`, hip[1] - LEG.kneeY);
  m.translate(top, [s * LEG.x - hip[0], 0, -hip[2]]);
  const cage = LEG.halfWidth / CC;
  m.scale(top, [cage / hipHalf, 1, cage / hipHalf], [s * LEG.x, LEG.kneeY, 0]);
  top = grow(m, top, `leg-${side}-shin`, LEG.kneeY - LEG.sockTop);
  top = grow(m, top, `leg-${side}-sock`, LEG.sockTop - LEG.ankle - 0.02);
  m.scale(top, [0.88, 1, 0.88], [s * LEG.x, LEG.ankle + 0.02, 0]);
  // Ankle narrowing, then the foot: heel down to the insole, a flat-topped instep forward
  // and a lower toe block (toe <= 0.10, inside the shoe).
  top = grow(m, top, `leg-${side}-ankle`, 0.02);
  m.scale(top, [0.82, 1, 0.82], [s * LEG.x, LEG.ankle, 0]);
  top = grow(m, top, `foot-${side}`, LEG.ankle - 0.022);
  m.scale(top, [1 / 0.82, 1, 1 / 0.82], [s * LEG.x, 0.022, 0]);
  let toe = grow(m, sel.createdBy(`foot-${side}`, 'side').and(sel.facing('+z', 30)), `foot-${side}-instep`, 0.025);
  m.scale(toe, [1, 0.92, 1], [s * LEG.x, 0.022, 0]);
  toe = grow(m, toe, `foot-${side}-toe`, 0.016);
  m.scale(toe, [0.94, 0.9, 1], [s * LEG.x, 0.022, 0]);
}

/** Neck up into the head cage: chin, jaw, cheek, eye, temple, cranium and crown rings. */
function neckAndHead(m: Model): void {
  let top = sel.createdBy(`trunk-${TRUNK.length - 1}`, 'top');
  const rings = headRings();
  const last = TRUNK[TRUNK.length - 1] as Trunk;
  const firstY = (rings[0] as readonly number[])[0] as number;
  // Neck column, about 0.07 x 0.06 m.
  const neckTop = firstY - 0.006;
  top = grow(m, top, 'neck', neckTop - last[0]);
  m.scale(top, [0.035 / last[1], 1, 0.03 / ((last[2] - last[3]) / 2)], [0, neckTop, (last[2] + last[3]) / 2]);
  // Cage half extents of the current top (width, depth, z center), tracked to scale each ring absolutely.
  let prev = { y: neckTop, a: 0.035 / CC, d: 0.03 / CC, z: (last[2] + last[3]) / 2 };
  for (const [i, [y, a, zf, zb]] of rings.entries()) {
    const d = (zf - zb) / 2;
    const z = (zf + zb) / 2;
    top = grow(m, top, `head-${i}`, y - prev.y);
    m.translate(top, [0, 0, z - prev.z]);
    m.scale(top, [a / CC / prev.a, 1, d / CC / prev.d], [0, y, z]);
    prev = { y, a: a / CC, d: d / CC, z };
  }
}

export function buildBody(): Model {
  const m = model();
  m.drawing(BOARD);
  trunk(m);
  m.checkpoint('trunk');
  for (const side of ['l', 'r'] as const) arm(m, side);
  m.checkpoint('arms');
  for (const side of ['l', 'r'] as const) leg(m, side);
  m.checkpoint('legs');
  neckAndHead(m);
  m.checkpoint('head');
  // Region tags for later stages (garments select the body by region).
  const labels = (...names: string[]) => names.map((n) => sel.createdBy(n)).reduce((a, b) => a.or(b));
  for (const side of ['l', 'r'] as const) {
    m.tag(labels(`armhole-${side}`, `arm-${side}-upper`, `arm-${side}-fore`), `arm-${side}`);
    m.tag(labels(`hand-${side}-palm`, `hand-${side}-fist`, `hand-${side}-fingers`, `hand-${side}-thumb`, `hand-${side}-thumb-tip`), `hand-${side}`);
    m.tag(labels(`leg-${side}-thigh`, `leg-${side}-shin`, `leg-${side}-sock`, `leg-${side}-ankle`, `foot-${side}`, `foot-${side}-instep`, `foot-${side}-toe`), `leg-${side}`);
  }
  m.tag(labels('neck', ...headRings().map((_, i) => `head-${i}`)), 'head');
  // An edge loop through the eye band of the head cage (for the G7 face; the mouth sits on the cheek ring).
  for (const ring of ['head-5']) {
    m.loopCut(sel.createdBy(ring, 'side').toEdges('touching').and(sel.edges.parallel('y', 30)).ring(), { cuts: 1 });
  }
  m.markSharp(sel.edges.all(), false);
  // The fist and the foot stay blocks: their folds (finger step, thumb notch, instep
  // top, toe block) are creases.
  const blocks = sel.tag('hand-l').or(sel.tag('hand-r')).or(sel.createdBy('foot-l-instep')).or(sel.createdBy('foot-l-toe')).or(sel.createdBy('foot-r-instep')).or(sel.createdBy('foot-r-toe'));
  m.markSharp(blocks.toEdges('contained').and(sel.edges.dihedral('>', 25)));
  m.subdivide(sel.all(), { levels: 2 });
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

/**
 * The limb axes (facet-plan.json skin-limbs, flow `path` "limb axes"): per side, the arm through
 * its segments' centres (armhole, upper and fore arm, palm, fist, fingers) and the leg (thigh,
 * shin, sock, ankle, foot, instep, toe), each guiding its limb's faces.
 */
export function limbAxes(m: Model): { readonly faces: FaceSelector; readonly curve: readonly Tuple3[] }[] {
  const chain = (labels: readonly string[]) => labels.filter((l) => sel.createdBy(l).evaluate(m.editMesh).length > 0).map((l) => centerOf(m, sel.createdBy(l)));
  return (['l', 'r'] as const).flatMap((s) => [
    { faces: sel.tag(`arm-${s}`).or(sel.tag(`hand-${s}`)), curve: chain([`armhole-${s}`, `arm-${s}-upper`, `arm-${s}-fore`, `hand-${s}-palm`, `hand-${s}-fist`, `hand-${s}-fingers`]) },
    { faces: sel.tag(`leg-${s}`), curve: chain([`leg-${s}-thigh`, `leg-${s}-shin`, `leg-${s}-sock`, `leg-${s}-ankle`, `foot-${s}`, `foot-${s}-instep`, `foot-${s}-toe`]) },
  ]);
}
