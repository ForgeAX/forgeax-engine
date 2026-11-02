import { type Model, model, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { buildArm, buildBlockout, DRESS_SECTIONS, G2_PARTS, type SleeveProfile } from './blockout.ts';
import { LANDMARK, outlineDrawing, part, REF, spans } from './reference.ts';

/**
 * Case C-200 stage G3 (secondary forms): the parts whose shape is more than their
 * blockout. Numbers are read off the G1 part outlines (column and row spans of the
 * front and side tail, hair and dress outlines, see measure.mjs and reference.json).
 */

/** Tail centerline: root under the back bow (hidden), then the side/front outline centers to the peduncle. */
export const TAIL_PATH: readonly Tuple3[] = [
  [0.03, 0.31, -0.1],
  [0.1, 0.255, -0.12],
  [0.17, 0.22, -0.15],
  [0.225, 0.195, -0.2],
  [0.26, 0.18, -0.25],
  [0.285, 0.175, -0.29],
];

/**
 * Fluke plane yaw: the lobe tips reach 0.10 m further in x (front outline, 0.27 -> 0.37)
 * and 0.11 m further back (side outline, 0.29 -> 0.40) than the peduncle.
 */
export const FLUKE_DIRECTION_DEG = (Math.atan2(0.11, 0.1) * 180) / Math.PI;

/** Elliptical ring section: `half` = [lateral, vertical] half axes, vertical kept vertical. */
function ellipse(center: Tuple3, tangent: Tuple3, half: readonly [number, number], n = 10): Tuple3[] {
  const t = norm(tangent);
  const lateral = norm(cross([0, 1, 0], t));
  const up = cross(t, lateral);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return add(center, add(scale(lateral, half[0] * Math.cos(a)), scale(up, half[1] * Math.sin(a))));
  });
}

/** The G2 two-view hull of the tail outlines: the exact silhouette envelope. */
function tailHull(): Model {
  const m = model();
  m.threeView(outlineDrawing({ front: 'tail', right: 'tail' }), ['front', 'right'], { material: 'navy' });
  return m;
}

/**
 * Tail: the body is a generous elliptical tube along the measured
 * centerline intersected with the G2 two-view hull of the tail outlines, so both views
 * keep the outline exactly while the cross sections stay round; the hidden root under
 * the skirt is the tube alone. The fluke is a two-lobed plate turned onto the fitted
 * yaw, thinning from 35 mm at the peduncle to 8 mm at the trailing edge, intersected
 * with the same hull, so its lobes follow the front and side outlines.
 */
export function buildTailG3(): Model {
  const m = model();
  const stations = TAIL_PATH.map((p, i) => {
    const tangent = sub(TAIL_PATH[Math.min(i + 1, TAIL_PATH.length - 1)] as Tuple3, TAIL_PATH[Math.max(i - 1, 0)] as Tuple3);
    // Larger than any measured section: the hull trims it to the outlines.
    const half: [number, number] = i < 2 ? [0.05, 0.065] : [0.055, 0.1];
    return ellipse(p, tangent, half);
  });
  const tube = model();
  tube.loft({ profiles: stations.slice(2), match: 'index', tag: 'tail', material: 'navy' });
  const body = tailHull();
  body.intersection(tube, { label: 'tail-body' });
  m.append(body);
  m.loft({ profiles: stations.slice(0, 3), match: 'index', tag: 'tail-root', material: 'navy' });
  const plate = model();
  plate.extrudePolygon({
    points: [
      [-0.02, 0.07],
      [0.16, 0.06],
      [0.16, 0.32],
      [-0.02, 0.29],
    ],
    depth: 0.035,
    tag: 'fluke',
    material: 'navy',
  });
  plate.translate(sel.tag('fluke'), [0, 0, -0.0175]);
  plate.taper(sel.tag('fluke'), { axis: 'x', range: [0, 0.16], factor: 0.23, axes: ['z'], origin: [0, 0.18, 0] });
  plate.rotate(sel.tag('fluke'), 'y', FLUKE_DIRECTION_DEG);
  const end = TAIL_PATH[TAIL_PATH.length - 1] as Tuple3;
  plate.translate(sel.tag('fluke'), [end[0] - 0.015, 0, end[2] + 0.012]);
  const fluke = tailHull();
  fluke.intersection(plate, { label: 'fluke' });
  m.append(fluke);
  m.markSharp(sel.edges.dihedral('>', 35));
  return m;
}

type Point = readonly [number, number];
const outline = (view: 'back' | 'right' | 'front', name: string) =>
  (REF.views[view].outlines as unknown as Record<string, { points: readonly Point[] }>)[name]?.points ?? [];

/** Outer extent of an outline at height v, or undefined where it has none. */
function extent(points: readonly Point[], v: number): [number, number] | undefined {
  const s = spans(points, v);
  if (s.length === 0) return undefined;
  return [Math.min(...s.map((x) => x[0])), Math.max(...s.map((x) => x[1]))];
}

/** Lowest outline point within `half` of u: the strand tip height there. */
function bottomAt(points: readonly Point[], u: number, half = 0.012): number {
  let best = Infinity;
  for (const [pu, pv] of points) if (Math.abs(pu - u) <= half && pv < best) best = pv;
  return best;
}

const add = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Tuple3, k: number): Tuple3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: Tuple3): Tuple3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Faceted lens section (six corners) at `center`, perpendicular to `tangent`: `width`
 * across, `depth` along `outward` (the clump's thickness away from the head).
 */
export function lens(center: Tuple3, tangent: Tuple3, outward: Tuple3, width: number, depth: number): Tuple3[] {
  const t = norm(tangent);
  const o = norm(sub(outward, scale(t, outward[0] * t[0] + outward[1] * t[1] + outward[2] * t[2])));
  const w = cross(t, o);
  const corners: [number, number][] = [
    [0.5, 0],
    [0.28, 0.5],
    [-0.28, 0.5],
    [-0.5, 0],
    [-0.28, -0.42],
    [0.28, -0.42],
  ];
  return corners.map(([a, b]) => add(center, add(scale(w, a * width), scale(o, b * depth))));
}

/** One hair clump: lens sections along `points` with per-point width scale, pointed at the tip. */
export function clump(m: Model, points: readonly Tuple3[], widths: readonly number[], depth: number, outward: (p: Tuple3) => Tuple3, tag: string): void {
  const profiles = points.map((p, i) => {
    const prev = points[Math.max(i - 1, 0)] as Tuple3;
    const next = points[Math.min(i + 1, points.length - 1)] as Tuple3;
    const k = widths[i] as number;
    return lens(p, sub(next, prev), outward(p), Math.max(k, 0.004), Math.max(depth * Math.min(1, k / (widths[1] as number) + 0.2), 0.004));
  });
  m.loft({ profiles, tag, material: 'hair' });
}

/** Head center used as the hair's radial origin (G2 head ellipsoid center). */
const HEAD_CENTER: Tuple3 = [0.019, 0.762, -0.005];
const radial = (p: Tuple3): Tuple3 => [p[0] - HEAD_CENTER[0], 0.25 * (p[1] - HEAD_CENTER[1]), p[2] - HEAD_CENTER[2]];

/**
 * Hair: a cap over the head plus clumps. Back clumps sit on the measured hair ellipse
 * of each height (x extent from the back outline, back edge from the side outline) at
 * angles around the head and end at the strand tips of the back outline's lower edge
 * (under the back bow, which hides them, at the neighbouring tip height). Side locks
 * and bangs hang in front. The clumps are fused into one closed hair mass by a voxel
 * smooth union.
 */
export interface HairOptions {
  /** The middle back clumps end behind the G4 back bow, which hides them on the sheet. */
  readonly behindBow?: boolean;
}

/** Top of the long hair below the cap hull: the clumps take over from here. */
export const CAP_FLOOR = 0.6;

/**
 * The sheet's front and back are yawed the same way (matched-camera sweep: best yaw
 * -4 deg front, -12 deg back), which shifts far-back hair by +z sin(yaw) in the front
 * view and -z sin(yaw) in the back view. Hair built from the back outline carries that
 * bias; the true position is the front/back mean: +0.022 m at the back hair's depth.
 */
export const HAIR_YAW_SHIFT = 0.022;

/** The hair parts before fusing: cap hull, back clumps, side locks and bangs. */
function hairParts(options: HairOptions): Model {
  const m = model();
  const back = outline('back', 'hair');
  const side = outline('right', 'hair');
  // Cap: the two-view hull of the back and side hair outlines above the
  // long hair, so crown height, occiput depth and back width follow the sheet. The side
  // outline's face notch keeps the face open.
  m.threeView(outlineDrawing({ back: 'hair', right: 'hair' }), ['back', 'right'], { material: 'hair' });
  m.planeCut({ point: [0, CAP_FLOOR, 0], normal: [0, 1, 0], keep: 'positive', fillHoles: true, material: 'hair' });
  m.tag(sel.all(), 'hair-cap');
  const heights = [0.66, 0.56, 0.45, 0.39];
  const angles = [-104, -82, -60, -38, -16, 6, 28, 50, 72, 94];
  for (const [i, deg] of angles.entries()) {
    const phi = (deg * Math.PI) / 180;
    const at = (y: number, inset: number): Tuple3 => {
      const xr = extent(back, y) ?? [-0.16, 0.16];
      const zr = extent(side, y) ?? [-0.2, 0.15];
      const cx = -(xr[0] + xr[1]) / 2;
      const a = (xr[1] - xr[0]) / 2 - inset;
      const zb = -zr[1] + inset;
      const zc = HEAD_CENTER[2];
      return [cx + a * Math.sin(phi), y, zc - (zc - zb) * Math.cos(phi)];
    };
    const widths = [0.1, 0.13, 0.12, 0.09, 0.008];
    // Side clumps keep their outer face near the measured edge: inset by a quarter width.
    const path = heights.map((y, k) => at(y, 0.022 + 0.25 * (widths[k] as number) * Math.abs(Math.sin(phi))));
    const low = path[path.length - 1] as Tuple3;
    // Tip: the back outline's lowest point under the clump (back view u = -x), never above the bow-hidden 0.33.
    const tipY = Math.min(bottomAt(back, -low[0]), 0.34);
    if (options.behindBow === true && Math.abs(deg) <= 20) {
      path.pop();
      const behind = path[path.length - 1] as Tuple3;
      path.push([behind[0], 0.4, behind[2] + 0.02]);
    } else path.push([low[0] * 1.03, tipY, low[2] - 0.01]);
    clump(m, path, path.length === 4 ? [0.1, 0.13, 0.12, 0.01] : widths, 0.06, radial, `hair-back:${i}`);
  }
  // Side locks in front of the shoulders (front view: down to the light tips at about 0.36 m).
  for (const s of [-1, 1]) {
    const locks: readonly (readonly [number, number, number, number, number])[] = [
      [0.12, 0.19, 0.235, 0.33, 0.04],
      [0.1, 0.125, 0.135, 0.46, 0.095],
    ];
    for (const [k, [x0, x1, x2, tip, z]] of locks.entries()) {
      clump(m, [[s * x0, 0.76, z], [s * x1, 0.62, z - 0.01], [s * x2, 0.48, z - 0.02], [s * x2 * 1.02, tip, z - 0.025]], [0.06, 0.075, 0.065, 0.006], 0.04, radial, `hair-side:${s > 0 ? 'l' : 'r'}${k}`);
    }
  }
  // Bangs: pointed clumps from the cap front down to the brow line (eye top + 2 cm).
  const brow = (LANDMARK['eye-top'] as number) + 0.015;
  for (const [i, x] of [-0.105, -0.06, -0.015, 0.03, 0.075, 0.12].entries()) {
    clump(m, [[x * 0.6 + 0.01, 0.89, 0.05], [x * 0.95 + 0.012, 0.8, 0.135], [x + 0.012, brow + (i % 2) * 0.02, 0.145]], [0.05, 0.055, 0.006], 0.025, radial, `hair-bangs:${i}`);
  }
  return m;
}

/**
 * Voxel grid of the hair union. Earlier Surface Nets failed at 0.008 and these stages
 * fell through to 0.0085 (B11 D1, fixed); pinning it keeps G3-G5 byte-identical.
 */
export const HAIR_VOXEL_SIZES = [0.0085];

export function buildHairG3(options: HairOptions = {}): Model {
  let m = hairParts(options);
  for (const voxelSize of HAIR_VOXEL_SIZES) {
    m = hairParts(options);
    // A near-hard union: a 3 mm blend instead of 12 mm keeps the strand
    // edges; G5 remeshes the fused surface back to facets.
    m.voxel.union(sel.all(), { voxelSize, radius: 0.003 });
    if (m.poisoned === undefined) break;
  }
  m.translate(sel.all(), [HAIR_YAW_SHIFT, 0, 0]);
  return m;
}

/** Dress half-width and half-depth at height y, interpolated between the measured G2 sections. */
export function dressAt(y: number): [number, number] {
  const s = DRESS_SECTIONS;
  if (y <= (s[0] as readonly number[])[0]!) return [s[0]![1], s[0]![2]];
  for (let i = 1; i < s.length; i++) {
    const [y1, a1, b1] = s[i]!;
    const [y0, a0, b0] = s[i - 1]!;
    if (y <= y1) {
      const t = (y - y0) / (y1 - y0);
      return [a0 + (a1 - a0) * t, b0 + (b1 - b0) * t];
    }
  }
  return [s[s.length - 1]![1], s[s.length - 1]![2]];
}

const E = 2.6;
const CX = 0.005;
/** Front surface depth of the dress superellipse at x. */
function frontZ(y: number, x: number, grow = 0): number {
  const [a, b] = dressAt(y);
  const t = Math.min(1, Math.abs(x - CX) / (a + grow));
  return (b + grow) * (1 - t ** E) ** (1 / E);
}

/** Pleated superellipse section: `folds` soft pleats of relative amplitude `amp`. */
function pleated(y: number, grow: number, amp: number, folds = 14, n = 56): Tuple3[] {
  const [a, b] = dressAt(y);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const k = 1 + amp * Math.cos(folds * t);
    return [CX + (a + grow) * k * Math.sign(c) * Math.abs(c) ** (2 / E), y, -(b + grow) * k * Math.sign(sn) * Math.abs(sn) ** (2 / E)] as Tuple3;
  });
}

/** Curved plate over the dress front between x0 and x1 at height y, `lift` off the surface, `thick` thick. */
function frontPlate(y: number, x0: number, x1: number, lift: number, thick: number, pleat = 0, n = 14): Tuple3[] {
  const outer: Tuple3[] = [];
  const inner: Tuple3[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const p = pleat * (i % 2 === 0 ? 1 : -1);
    outer.push([x, y, frontZ(y, x) + lift + thick + p]);
    inner.push([x, y, frontZ(y, x) + lift + p]);
  }
  return [...outer, ...inner.reverse()];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Dress: bodice, pleated skirt and white hem band as open-bottom shells (the legs
 * reach up inside), waistband, and the apron (skirt panel, bib, ruffled hem) as curved
 * plates over the dress front. Apron extents are the G1 front apron/waistband bounds.
 */
export function buildDressG3(): Model {
  const m = model();
  const hemTop = LANDMARK['hem-band-top'] as number;
  const skirtYs = [hemTop - 0.004, 0.3, 0.34, 0.38, 0.42, 0.46];
  m.loft({ match: 'index', profiles: skirtYs.map((y) => pleated(y, 0, 0.035 * Math.max(0, (0.44 - y) / (0.44 - hemTop)))), label: 'skirt', tag: 'skirt', material: 'navy' });
  m.shell(sel.createdBy('skirt'), { thickness: 0.007, open: sel.createdBy('skirt', 'start') });
  const hemYs = [0.165, 0.2, 0.235, hemTop + 0.004];
  m.loft({ match: 'index', profiles: hemYs.map((y) => pleated(y, 0, 0.02)), label: 'skirt-hem', tag: 'skirt-hem', material: 'white' });
  m.shell(sel.createdBy('skirt-hem'), { thickness: 0.004, clamp: true, open: sel.createdBy('skirt-hem', 'start').or(sel.createdBy('skirt-hem', 'end')) });
  const bodiceYs = [0.455, 0.5, 0.54, 0.575, 0.6];
  m.loft({ match: 'index', profiles: bodiceYs.map((y) => pleated(y, -0.002, 0, 14, 40)), tag: 'bodice', material: 'navy' });
  // Waistband: a white ring over the waist line (G1 waistband height).
  const band = part('front', 'waistband');
  m.loft({ match: 'index', profiles: [band.bounds[1], band.bounds[3]].map((y) => pleated(y, 0.006, 0, 14, 40)), tag: 'waistband', material: 'white' });
  // Apron skirt: from the waistband down to the ruffle, widening as the front apron outline does.
  const apron = part('front', 'apron');
  const ruffleTop = (LANDMARK['apron-bottom'] as number) + 0.036;
  const apronYs = [band.bounds[1] + 0.004, 0.36, 0.3, ruffleTop];
  const width = (y: number) => {
    const t = Math.min(1, Math.max(0, (band.bounds[1] - y) / (band.bounds[1] - ruffleTop)));
    return [lerp(band.bounds[0] - 0.004, apron.bounds[0] + 0.01, Math.sqrt(t)), lerp(band.bounds[2] + 0.004, apron.bounds[2] - 0.01, Math.sqrt(t))];
  };
  m.loft({ match: 'index', profiles: [...apronYs].reverse().map((y) => frontPlate(y, width(y)[0] as number, width(y)[1] as number, 0.006, 0.005)), tag: 'apron', material: 'white' });
  // Ruffled hem: pleated plate below the apron skirt, slightly wider.
  const bottom = LANDMARK['apron-bottom'] as number;
  m.loft({ match: 'index', profiles: [bottom + 0.003, ruffleTop - 0.002].map((y) => frontPlate(y, apron.bounds[0] - 0.004, apron.bounds[2] + 0.004, 0.009, 0.005, 0.006, 20)), tag: 'apron-ruffle', material: 'white' });
  // Bib: on the bodice front from the waistband to the collar.
  const bibYs = [band.bounds[3] - 0.004, 0.52, 0.575];
  m.loft({ match: 'index', profiles: bibYs.map((y) => frontPlate(y, -0.072, 0.052, 0.004, 0.005)), tag: 'apron-bib', material: 'white' });
  return m;
}

/**
 * Puffed sleeve: a full puff over the upper arm, a narrow elbow and a
 * gathered end that tucks into a wider cuff, on 16-sided rings.
 */
export const G3_SLEEVE: SleeveProfile = {
  stations: [
    [0, 0.038],
    [0.2, 0.054],
    [0.5, 0.058],
    [0.8, 0.048],
    [1, 0.042],
    [1.6, 0.04],
    [2, 0.034],
  ],
  segments: 16,
  cuff: 0.47,
};

const G3_REPLACED = new Set(['tail', 'tail-root', 'hair', 'dress', 'arm-l', 'arm-r']);
export const G3_PARTS: readonly (readonly [string, () => Model])[] = [
  ['hair', buildHairG3],
  ...G2_PARTS.filter(([name]) => !G3_REPLACED.has(name)),
  ['dress', buildDressG3],
  ['arm-l', () => buildArm('l', G3_SLEEVE)],
  ['arm-r', () => buildArm('r', G3_SLEEVE)],
  ['tail', buildTailG3],
];

export function buildForms(): Model {
  return buildBlockout(G3_PARTS);
}
