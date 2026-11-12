import { type Model, model, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { BOARD, LANDMARK, outlineDrawing, part } from './reference.ts';

/**
 * Case C-200 stage G2 (blockout): the primary form of every part from the G1
 * measurements. Parts whose outline the sheet shows unoccluded in two views (hair:
 * back + side, shoes, tail) are three-view intersections of their measured contours;
 * the dress is a loft of superellipse sections whose widths and depths are measured
 * spans of the front, back and side silhouettes; arms are lofted rings through the
 * measured shoulder, elbow and cuff; head, legs and socks are sized from the measured
 * part extents. Each part is its own session, appended with its part tag.
 */

const lm = (name: string): number => LANDMARK[name] as number;

/** Horizontal superellipse section (exponent `e`) at height y: half-width a (x), half-depth b (z). */
export function hSection(y: number, cx: number, cz: number, a: number, b: number, n = 20, e = 2.6): Tuple3[] {
  const out: Tuple3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([cx + a * Math.sign(c) * Math.abs(c) ** (2 / e), y, cz - b * Math.sign(s) * Math.abs(s) ** (2 / e)]);
  }
  return out;
}

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Tuple3): Tuple3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Circle of `radius` around `center`, perpendicular to `axis`, wound about the axis. */
export function ring(center: Tuple3, axis: Tuple3, radius: number, n = 12): Tuple3[] {
  const w = norm(axis);
  const u = norm(cross(Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], w));
  const v = cross(w, u);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    return [0, 1, 2].map((k) => (center[k] as number) + radius * (Math.cos(t) * (u[k] as number) + Math.sin(t) * (v[k] as number))) as Tuple3;
  });
}

/**
 * Dress sections bottom to top: [y, half-width, half-depth]. Skirt widths are the
 * left (unoccluded) edge of the front silhouette and the back silhouette, depths the
 * side silhouette; above the hips the arms and the long hair hide the sides, so the
 * torso keeps the visible front depth and the shoulder width of the sleeve tops.
 */
export const DRESS_SECTIONS: readonly (readonly [number, number, number])[] = [
  [0.165, 0.212, 0.162],
  [0.2, 0.229, 0.168],
  [0.26, 0.216, 0.168],
  [0.3, 0.188, 0.165],
  [0.34, 0.158, 0.145],
  [0.38, 0.128, 0.124],
  [0.42, 0.104, 0.104],
  [0.46, 0.098, 0.096],
  [0.52, 0.104, 0.096],
  [0.565, 0.104, 0.08],
  [0.6, 0.058, 0.05],
];
const DRESS_CENTER_X = 0.005;

export function buildHair(): Model {
  const m = model();
  // The back view sees the whole hair width (the front shows the face notch).
  m.threeView(outlineDrawing({ back: 'hair', right: 'hair' }), ['back', 'right'], { label: 'hair', material: 'hair' });
  return m;
}

export function buildHead(): Model {
  const m = model();
  const face = part('front', 'face');
  const front = -part('right', 'face').bounds[0];
  const radii: Tuple3 = [face.size[0] / 2, (lm('crown') - lm('chin')) / 2 - 0.004, 0.13];
  m.sphere({ radius: 1, widthSegments: 16, heightSegments: 12, tag: 'head', material: 'skin' });
  m.scale(sel.tag('head'), radii);
  m.translate(sel.tag('head'), [face.center[0], lm('chin') + radii[1] + 0.002, front - radii[2]]);
  return m;
}

export function buildDress(): Model {
  const m = model();
  m.loft({ profiles: DRESS_SECTIONS.map(([y, a, b]) => hSection(y, DRESS_CENTER_X, 0, a, b)), tag: 'dress', material: 'navy' });
  return m;
}

/**
 * Sleeve stations: [where, radius] with `where` in 0..2 (0 shoulder, 1 elbow, 2 cuff
 * top, linear between), plus the cuff ring scale of the measured cuff width.
 */
export interface SleeveProfile {
  readonly stations: readonly (readonly [number, number])[];
  readonly segments: number;
  readonly cuff: number;
}
export const G2_SLEEVE: SleeveProfile = {
  stations: [
    [0, 0.04],
    [0.5, 0.05],
    [1, 0.046],
    [2, 0.04],
  ],
  segments: 12,
  cuff: 0.45,
};

/** One arm: puffed sleeve rings from the shoulder through the elbow to the cuff, then the cuff and hand. */
export function buildArm(side: 'l' | 'r', sleeve: SleeveProfile = G2_SLEEVE): Model {
  const m = model();
  const s = side === 'l' ? 1 : -1;
  const cuff = part('front', `cuff-${side}`);
  const hand = part('front', `hand-${side}`);
  const z = -part('right', 'cuff-l').center[0];
  const shoulder: Tuple3 = [s * 0.104, lm('shoulder') - 0.026, -0.01];
  const elbow: Tuple3 = [s * 0.15, 0.475, z * 0.6];
  const cuffTop: Tuple3 = [cuff.center[0] - s * 0.008, cuff.bounds[3] - 0.004, z];
  const cuffBottom: Tuple3 = [cuff.center[0] + s * 0.004, cuff.bounds[1] + 0.014, z];
  const upper = sub(elbow, shoulder);
  const lower = sub(cuffTop, elbow);
  const mid = (a: Tuple3, b: Tuple3, t: number): Tuple3 => [0, 1, 2].map((k) => (a[k] as number) + ((b[k] as number) - (a[k] as number)) * t) as Tuple3;
  const at = (w: number): [Tuple3, Tuple3] =>
    w <= 1
      ? [mid(shoulder, elbow, w), w === 1 ? [upper[0] + lower[0], upper[1] + lower[1], upper[2] + lower[2]] : upper]
      : [mid(elbow, cuffTop, w - 1), lower];
  m.loft({
    profiles: sleeve.stations.map(([w, r]) => {
      const [c, axis] = at(w);
      return ring(c, axis, r, sleeve.segments);
    }),
    tag: `sleeve-${side}`,
    material: 'navy',
  });
  const cuffRadius = cuff.size[0] * sleeve.cuff;
  m.loft({ profiles: [ring(cuffTop, sub(cuffBottom, cuffTop), cuffRadius, sleeve.segments), ring(cuffBottom, sub(cuffBottom, cuffTop), cuffRadius, sleeve.segments)], tag: `cuff-${side}`, material: 'white' });
  m.box({
    size: [hand.size[0], hand.bounds[3] - hand.bounds[1] + 0.012, 0.055],
    center: [(hand.bounds[0] + hand.bounds[2]) / 2, (hand.bounds[3] + 0.012 + hand.bounds[1]) / 2, -part('right', 'hand-l').center[0]],
    tag: `hand-${side}`,
    material: 'skin',
  });
  return m;
}

export function buildLeg(side: 'l' | 'r'): Model {
  const m = model();
  const leg = part('front', `leg-${side}`);
  const sock = part('front', `sock-${side}`);
  const x = leg.center[0];
  const top = lm('hem-band-top');
  m.cylinder({ radiusTop: leg.size[0] / 2 - 0.004, radiusBottom: leg.size[0] / 2 - 0.004, height: top - lm('sock-top'), radialSegments: 12, center: [x, (top + lm('sock-top')) / 2, 0], tag: `leg-${side}`, material: 'skin' });
  const sockBottom = lm('sole-top') - 0.01;
  m.cylinder({ radiusTop: sock.size[0] / 2 - 0.004, radiusBottom: sock.size[0] / 2 - 0.008, height: lm('sock-top') - sockBottom - 0.002, radialSegments: 12, center: [x, (lm('sock-top') - 0.002 + sockBottom) / 2, 0], tag: `sock-${side}`, material: 'white' });
  return m;
}

export function buildShoe(side: 'l' | 'r'): Model {
  const m = model();
  m.threeView(outlineDrawing({ front: `shoe-${side}`, right: 'shoes' }, 0.003), ['front', 'right'], { label: `shoe-${side}`, material: 'shoe' });
  return m;
}

export function buildTail(): Model {
  const m = model();
  m.threeView(outlineDrawing({ front: 'tail', right: 'tail' }), ['front', 'right'], { label: 'tail', material: 'navy' });
  return m;
}

/** The tail root under the back bow, hidden on the sheet: a lofted taper down to the visible tail. */
export function buildTailRoot(): Model {
  const m = model();
  const path: Tuple3[] = [
    [0.02, 0.36, -0.1],
    [0.08, 0.27, -0.17],
    [0.15, 0.19, -0.22],
    [0.21, 0.15, -0.26],
  ];
  const radii = [0.04, 0.045, 0.042, 0.036];
  m.loft({
    profiles: path.map((p, i) => ring(p, sub(path[Math.min(i + 1, path.length - 1)] as Tuple3, path[Math.max(i - 1, 0)] as Tuple3), radii[i] as number)),
    tag: 'tail-root',
    material: 'navy',
  });
  return m;
}

export const G2_PARTS: readonly (readonly [string, () => Model])[] = [
  ['hair', buildHair],
  ['head', buildHead],
  ['dress', buildDress],
  ['arm-l', () => buildArm('l')],
  ['arm-r', () => buildArm('r')],
  ['leg-l', () => buildLeg('l')],
  ['leg-r', () => buildLeg('r')],
  ['shoe-l', () => buildShoe('l')],
  ['shoe-r', () => buildShoe('r')],
  ['tail', buildTail],
  ['tail-root', buildTailRoot],
];

/** The G2 assembly: every part session appended with its part tag, checkpoint per group. */
/** Checkpoint taken after appending a part (a capture keeps the first eight). */
export const PART_CHECKPOINTS: Readonly<Record<string, string>> = {
  hair: 'hair-done',
  head: 'head',
  dress: 'body',
  'arm-r': 'arms',
  'shoe-r': 'legs',
  tail: 'tail',
  ahoge: 'head-details',
  brooch: 'chest-details',
};

export function buildBlockout(
  parts: readonly (readonly [string, () => Model])[] = G2_PARTS,
  checkpoints: Readonly<Record<string, string>> = PART_CHECKPOINTS,
): Model {
  const m = model();
  m.drawing(BOARD);
  for (const [name, build] of parts) {
    m.append(build(), { label: name, tag: name });
    const point = checkpoints[name];
    if (point !== undefined) m.checkpoint(point);
  }
  m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}
