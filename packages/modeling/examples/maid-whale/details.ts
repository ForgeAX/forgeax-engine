import { type Model, model, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { buildHairG3, lens } from './forms.ts';
import { LANDMARK, part, REF, silhouette, viewDrawing } from './reference.ts';

/**
 * Case C-200 stage G4 (local parts): the details of the spec list, each its own
 * session appended with its part tag. Placement and size come from the G1 part extents
 * (front, side and back bounds); shapes follow the sheet's blocky low-poly style.
 */

let serial = 0;
/** A box turned `deg` about the axis `axis` through its center, then placed at `center`. */
function block(m: Model, size: Tuple3, center: Tuple3, material: string, turns: readonly (readonly ['x' | 'y' | 'z', number])[] = []): void {
  const tag = `b${serial++}`;
  m.box({ size, tag, material });
  for (const [axis, deg] of turns) m.rotate(sel.tag(tag), axis, deg);
  m.translate(sel.tag(tag), center);
}

type Point = readonly [number, number];

/** Distance from `c` along direction `a` (radians) to the far boundary of a closed outline. */
export function rayReach(points: readonly Point[], c: Point, a: number): number {
  const d: Point = [Math.cos(a), Math.sin(a)];
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Point;
    const q = points[(i + 1) % points.length] as Point;
    const e: Point = [q[0] - p[0], q[1] - p[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const w: Point = [p[0] - c[0], p[1] - c[1]];
    const t = (w[0] * e[1] - w[1] * e[0]) / den;
    const u = (w[0] * d[1] - w[1] * d[0]) / den;
    if (t > 0 && u >= 0 && u <= 1 && t > best) best = t;
  }
  return best;
}

/**
 * Headdress: a white band over the hair from ear to ear carrying stepped frill teeth.
 * Around one center the band follows the hair (rays to the back hair outline, the
 * back view sees no frill in front of it) and every tooth reaches the measured front
 * silhouette along its own ray, big and small teeth alternating, so the frill
 * outline is the sheet's rather than a circle's.
 */
export function buildHeaddress(): Model {
  const m = model();
  const front = part('front', 'headdress');
  const side = part('right', 'headdress');
  const sil = silhouette('front');
  const hair = (REF.views.back.outlines as unknown as Record<string, { points: readonly Point[] }>).hair?.points ?? [];
  const hairFront = hair.map(([u, v]): Point => [-u, v]);
  const cx = (front.bounds[0] + front.bounds[2]) / 2;
  const c: Point = [cx, 0.72];
  const z = -(side.bounds[0] + side.bounds[2]) / 2;
  const a0 = Math.atan2(front.bounds[1] + 0.02 - c[1], front.bounds[2] - 0.02 - cx);
  const a1 = Math.PI - Math.atan2(front.bounds[1] + 0.02 - c[1], cx - front.bounds[0] - 0.02);
  const teeth = 15;
  const band: Tuple3[] = [];
  for (let i = 0; i <= teeth; i++) {
    const a = a0 + ((a1 - a0) * i) / teeth;
    const r = rayReach(hairFront, c, a) + 0.004;
    band.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), z]);
  }
  m.sweep({
    profile: [
      [-0.04, -0.006],
      [0.04, -0.006],
      [0.04, 0.006],
      [-0.04, 0.006],
    ],
    path: band,
    frame: 'up',
    up: [0, 0, 1],
    tag: 'band',
    material: 'white',
  });
  for (let i = 0; i < teeth; i++) {
    const a = a0 + ((a1 - a0) * (i + 0.5)) / teeth;
    const inner = rayReach(hairFront, c, a);
    // The silhouette ray can reach the ahoge above the frill: cap at the frill's own top.
    const reach = Math.min(rayReach(sil, c, a), (front.bounds[3] - c[1]) / Math.max(Math.sin(a), 1e-6));
    const outer = Math.max(inner + 0.012, reach - (i % 2 === 0 ? 0.004 : 0.014));
    const h = outer - inner;
    const r = (inner + outer) / 2;
    const width = (((a1 - a0) / teeth) * inner) * (i % 2 === 0 ? 1.05 : 0.8);
    block(m, [width, h, i % 2 === 0 ? 0.075 : 0.06], [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), z + (i % 2 === 0 ? 0 : -0.01)], 'white', [['z', (a * 180) / Math.PI - 90]]);
  }
  return m;
}

/**
 * Whale-fin ornaments on both ends of the headdress: a navy triangular fin pointing
 * outward and back (front bounds x 0.145-0.266, side z -0.148..-0.038) with a white
 * stepped trim along its lower edge.
 */
export function buildFin(side: 'l' | 'r'): Model {
  const m = model();
  const s = side === 'l' ? 1 : -1;
  const f = part('front', `fin-${side}`);
  const sd = part('right', 'fin-l');
  const inner = s > 0 ? f.bounds[0] : -f.bounds[2];
  const outer = s > 0 ? f.bounds[2] : -f.bounds[0];
  const [y0, y1] = [f.bounds[1], f.bounds[3]];
  const z0 = -sd.bounds[2];
  const z1 = -sd.bounds[0];
  // Fin blade: the front triangle (base on the head side, tip out and up) intersected
  // with the side triangle (base forward, tip back and up).
  m.threeView(
    viewDrawing('fin blade', {
      front: { kind: 'polyline', points: [
            [s * inner, y0 + 0.02],
            [s * outer - s * 0.03, y0 + 0.055],
            [s * outer, y1],
            [s * inner, y1 - 0.01],
          ] },
      right: { kind: 'polyline', points: [
            [-z1, y0],
            [-z1, y1 - 0.025],
            [-z0, y1],
            [-z0 - 0.035, y0 + 0.035],
          ] },
    }),
    ['front', 'right'],
    { label: 'blade', material: 'navy' },
  );
  // Stepped trim: three white steps under the blade's lower edge.
  for (let k = 0; k < 4; k++) {
    const x = inner + 0.012 + k * ((outer - inner - 0.035) / 4);
    block(m, [0.028, 0.014, z1 - z0 - 0.03], [s * (x + 0.014), y0 + 0.012 + k * 0.011, (z0 + z1) / 2], 'white');
  }
  return m;
}

/** A bow: knot, two flattened loops and two tails, facing `normal` at `center`, `width` across. */
function bow(m: Model, center: Tuple3, width: number, height: number, tails: number, material: string, yaw: number): void {
  const t = `bow${serial++}`;
  const loop = (sx: number) => {
    m.extrudePolygon({
      points: [
        [0.01 * sx, -0.012],
        [(width / 2) * sx, -height / 2],
        [(width / 2) * sx * 0.92, height / 2],
        [0.01 * sx, 0.012],
      ].map(([x, y]) => [x as number, y as number]),
      depth: height * 0.45,
      tag: t,
      material,
    });
  };
  loop(1);
  loop(-1);
  m.box({ size: [width * 0.22, height * 0.5, height * 0.6], center: [0, 0, height * 0.22], tag: t, material });
  for (const sx of [-1, 1]) {
    m.extrudePolygon({
      points: [
        [0.004 * sx, -0.01],
        [width * 0.16 * sx, -tails],
        [width * 0.3 * sx, -tails * 0.92],
        [width * 0.1 * sx, -0.01],
      ].map(([x, y]) => [x as number, y as number]),
      depth: height * 0.2,
      tag: t,
      material,
    });
  }
  m.rotate(sel.tag(t), 'y', yaw);
  m.translate(sel.tag(t), center);
}

/** Light-blue ribbons at the headdress ends, in front of the fins (front/side ribbon bounds). */
export function buildRibbon(side: 'l' | 'r'): Model {
  const m = model();
  const r = part('front', `ribbon-${side === 'l' ? 'l' : 'l'}`);
  const sd = part('right', 'ribbon-l');
  const s = side === 'l' ? 1 : -1;
  const x = s * Math.abs(r.center[0]);
  bow(m, [x, r.center[1], -sd.center[0] + 0.01], r.size[0], r.size[1] * 0.55, r.size[1] * 0.45, 'ribbon', s * 50);
  return m;
}

/** Frilled white collar: a ring of stepped blocks around the neck (front collar bounds). */
export function buildCollar(): Model {
  const m = model();
  const c = part('front', 'collar');
  const y = (c.bounds[1] + c.bounds[3]) / 2;
  const radius = c.size[0] / 2 - 0.012;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 2 * Math.PI;
    block(m, [0.03, c.size[1] * (i % 2 === 0 ? 0.75 : 0.55), 0.016], [0.005 + radius * Math.sin(a), y, -0.012 + radius * 0.8 * Math.cos(a)], 'white', [['y', (a * 180) / Math.PI]]);
  }
  return m;
}

/** Navy bowtie under the collar (front bowtie bounds): knot, wings and two tails. */
export function buildBowtie(): Model {
  const m = model();
  const b = part('front', 'bowtie');
  const top = b.bounds[3] - 0.02;
  bow(m, [b.center[0] + 0.005, top - 0.012, 0.085], b.size[0], 0.04, b.bounds[3] - b.bounds[1] - 0.03, 'navy', 0);
  return m;
}

/** Brooch: a faceted blue gem in a gold rim at the measured gem center. */
export function buildBrooch(): Model {
  const m = model();
  const g = part('front', 'brooch');
  const z = 0.112;
  m.cylinder({ radiusTop: g.size[0] * 0.75, radiusBottom: g.size[0] * 0.75, height: 0.006, radialSegments: 8, tag: 'rim', material: 'gold' });
  m.rotate(sel.tag('rim'), 'x', 90);
  m.translate(sel.tag('rim'), [g.center[0], g.center[1], z]);
  m.sphere({ radius: g.size[0] * 0.5, widthSegments: 6, heightSegments: 4, tag: 'gem', material: 'gem' });
  m.scale(sel.tag('gem'), [1, 1, 0.6]);
  m.translate(sel.tag('gem'), [g.center[0], g.center[1], z + 0.006]);
  return m;
}

/** Mary-Jane strap over the instep with a gold buckle on the outer side. */
export function buildStrap(side: 'l' | 'r'): Model {
  const m = model();
  const shoe = part('front', `shoe-${side}`);
  const s = side === 'l' ? 1 : -1;
  const y = LANDMARK['sole-top'] as number;
  block(m, [shoe.size[0] + 0.006, 0.014, 0.022], [shoe.center[0], y - 0.004, 0.035], 'shoe', [['x', -25]]);
  block(m, [0.008, 0.016, 0.016], [s > 0 ? shoe.bounds[2] + 0.002 : shoe.bounds[0] - 0.002, y - 0.006, 0.03], 'gold');
  return m;
}

/**
 * The large white bow at the back waist (back bow bounds: 0.19 m wide, 0.22-0.40 m
 * high) with the apron ties running from the waistband sides to its knot.
 */
export function buildBackBow(): Model {
  const m = model();
  const b = part('back', 'back-bow');
  const x = -(b.bounds[0] + b.bounds[2]) / 2;
  // Behind the skirt back and in front of the middle hair ends it hides (see buildHairG3);
  // the side view only shows its ties (side back-bow bounds).
  const zBow = -0.175;
  bow(m, [x, b.bounds[3] - 0.05, zBow], b.size[0], 0.085, b.bounds[3] - b.bounds[1] - 0.06, 'white', 180);
  const band = part('front', 'waistband');
  for (const s of [-1, 1]) {
    m.loft({
      profiles: [
        [s * 0.085, (band.bounds[1] + band.bounds[3]) / 2, -0.06],
        [s * 0.04, b.bounds[3] - 0.05, zBow + 0.015],
      ].map((p) => lens(p as Tuple3, [-s, 0, -0.6], [0, 0, -1], 0.03, 0.008)),
      tag: `tie${s}`,
      material: 'white',
    });
  }
  return m;
}

/** Ahoge: the curled antenna strand rising from the crown (front/side ahoge bounds). */
export function buildAhoge(): Model {
  const m = model();
  const f = part('front', 'ahoge');
  const sd = part('right', 'ahoge');
  const x = f.center[0];
  const zF = -sd.bounds[0];
  const zB = -sd.bounds[2];
  const pts: Tuple3[] = [
    [x, sd.bounds[1] + 0.005, zF - 0.02],
    [x, (sd.bounds[1] + sd.bounds[3]) / 2, zF - 0.012],
    [x + 0.01, sd.bounds[3] - 0.012, (zF + zB) / 2 + 0.02],
    [x + 0.02, sd.bounds[3] - 0.006, zB + 0.02],
    [x + 0.025, sd.bounds[3] - 0.03, zB],
  ];
  const widths = [0.035, 0.034, 0.03, 0.02, 0.004];
  m.loft({
    profiles: pts.map((p, i) => lens(p, pts[Math.min(i + 1, pts.length - 1)]!.map((c, k) => c - pts[Math.max(i - 1, 0)]![k]!) as unknown as Tuple3, [1, 0, 0], widths[i]!, 0.018)),
    tag: 'ahoge',
    material: 'hair',
  });
  return m;
}

export const G4_PARTS: readonly (readonly [string, () => Model])[] = [
  // The back bow hides the middle back clumps: they end behind it (G4 override of G3).
  ['hair', () => buildHairG3({ behindBow: true })],
  ['headdress', buildHeaddress],
  ['fin-l', () => buildFin('l')],
  ['fin-r', () => buildFin('r')],
  ['ribbon-l', () => buildRibbon('l')],
  ['ribbon-r', () => buildRibbon('r')],
  ['ahoge', buildAhoge],
  ['collar', buildCollar],
  ['bowtie', buildBowtie],
  ['brooch', buildBrooch],
  ['strap-l', () => buildStrap('l')],
  ['strap-r', () => buildStrap('r')],
  ['back-bow', buildBackBow],
];
