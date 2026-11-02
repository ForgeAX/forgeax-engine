import { type Drawing, type DrawingItem, type Tuple3, toView } from '@forgeax/engine-modeling';
import { headRings } from './body.ts';

/**
 * Case C-200 G7 head and face topology plan, drawn
 * first and built from the same data. The head is an all-quad cage (headCage) from the neck
 * ring to the crown: rings of MERIDIANS points, one per neck seam point, closed by a crown grid.
 * head.ts remeshes it into even flat facets (low-poly, HEAD_FACET) whose edges keep the cage's
 * structure-zone borders. Its front face rows between the face borders are the face plane; the jaw
 * loop is face ring 0 (chin, jaw corners, gonions, nape), the cheek-widest loop face ring 4,
 * the hairline the last; the borders and ear-front lines are meridians. Measured values are
 * sheet data (FACE_SHEET), never the image.
 */

type P3 = Tuple3;
type P2 = readonly [number, number];

/**
 * The face measured on the sheet (G7 face measure, 2026-10-25; front x from the face midline,
 * side z = -u). The front `face` part bounds of reference.json reach the screen-right ear, so
 * the visible half-width is about 0.1, not half of `faceWidth` (0.134).
 */
export const FACE_SHEET = {
  /** Lowest lit skin; the chin is flat, 16-21 mm wide. */
  chin: { y: 0.6165, z: 0.09, flatHalf: 0.009 },
  /** The jaw is a straight V rising about 23 deg to this turn into the cheek (front view). */
  jawCorner: [0.085, 0.65] as P2,
  /** Visible skin half-width by height: a true edge up to the jaw corner, bordered by hair above. */
  visibleHalf: [
    [0.62, 0.026],
    [0.63, 0.057],
    [0.64, 0.076],
    [0.65, 0.085],
    [0.66, 0.088],
    [0.68, 0.094],
    [0.7, 0.099],
    [0.715, 0.105],
  ] as readonly P2[],
  /** Side profile: face front z by height (the nose point at 0.664-0.676 is listed apart). */
  profile: [
    [0.6165, 0.09],
    [0.62, 0.1],
    [0.63, 0.105],
    [0.64, 0.111],
    [0.65, 0.116],
    [0.66, 0.121],
    [0.68, 0.117],
    [0.69, 0.112],
    [0.7, 0.112],
    [0.72, 0.108],
    [0.76, 0.106],
    [0.79, 0.104],
  ] as readonly P2[],
  /** A pointed bump in the side profile only (the front view draws no nose): apex z, height span. */
  nose: { y: 0.67, z: 0.1255, span: [0.656, 0.686] as P2 },
  /** The jaw crease in the side view ([z, y]): the jaw line seen from the side. */
  jawCrease: [
    [0.076, 0.617],
    [0.047, 0.639],
  ] as readonly P2[],
  /** The ear behind the side lock (side view): z and y spans; the line in front of it at z -0.02. */
  ear: { z: [-0.046, -0.02] as P2, y: [0.66, 0.713] as P2 },
  /** Decals, character left (x > 0; mirrored): boxes [x0, y0, x1, y1]. */
  eye: { box: [0.034, 0.673, 0.105, 0.732], iris: { center: [0.058, 0.695] as P2, size: [0.035, 0.039] as P2 }, lashTop: 0.732, lashOuter: 0.722 },
  brow: { box: [0.04, 0.764, 0.109, 0.771] },
  /** The mouth (0.0035 left of the midline on the sheet, a slight head turn): centred here. */
  mouth: { center: [0, 0.6441] as P2, width: 0.0246, height: 0.008 },
  blush: {
    box: [0.058, 0.64, 0.096, 0.668],
    /** The drawn ovals (decals.ts faceLayers): lifted, squashed and narrowed to stay above the jaw, which the tapered jaw turns away past x 0.09. */
    draw: { lift: 0.006, squash: 0.85, inward: 0.005, narrow: 0.85 },
  },
  colours: {
    skin: '#fbdbc1',
    irisDark: '#102754',
    irisLight: '#5d86c7',
    lash: '#190d0b',
    sclera: '#f2f0f2',
    brow: '#26304b',
    mouth: '#a77e65',
    blush: '#f1b49a',
  },
} as const;

/** Decal boxes of the plan ([x0, y0, x1, y1], both sides). */
export function decalBoxes(): Readonly<Record<string, readonly [number, number, number, number]>> {
  const mirror = (b: readonly number[]) => [-(b[2] as number), b[1] as number, -(b[0] as number), b[3] as number] as const;
  const { eye, brow, blush, mouth } = FACE_SHEET;
  // The area is the ovals' extent, not the measured box: the box's lower corner lies past the jaw line, under the decal.
  const [bx0, by0, bx1, by1] = blush.box;
  const { lift, squash, inward, narrow } = blush.draw;
  const [bcx, bcy] = [(bx0 + bx1) / 2 - inward, (by0 + by1) / 2 + lift];
  const [brx, bry] = [((bx1 - bx0) / 2) * narrow, ((by1 - by0) / 2) * squash];
  const blushDrawn = [bcx - brx, bcy - bry, bcx + brx, bcy + bry] as const;
  const m = [mouth.center[0] - mouth.width / 2, mouth.center[1] - mouth.height, mouth.center[0] + mouth.width / 2, mouth.center[1] + mouth.height] as const;
  return {
    'eye-l': eye.box as unknown as readonly [number, number, number, number],
    'eye-r': mirror(eye.box),
    'brow-l': brow.box as unknown as readonly [number, number, number, number],
    'brow-r': mirror(brow.box),
    'blush-l': blushDrawn,
    'blush-r': mirror(blushDrawn),
    mouth: m,
  };
}

/**
 * The plan's structure, character left (x > 0, mirrored): the face border from the jaw corner
 * to the temple, the ear-front line (z -0.02 at the skull's half-width), the cheek-widest loop
 * height, the hairline height under the fringe and the neck seam inside the collar.
 */
export const HEAD_PLAN = {
  /**
   * Face-plane border, jaw corner to temple: [x, y, z]. The corner sits 3 mm forward of the sheet's jaw
   * turn: the arc rows would otherwise tilt the outer cheek past the face slot's facing limit, and
   * further forward the cheek-band poles reach the blush.
   */
  border: [
    [0.082, 0.648, 0.036],
    [0.108, 0.675, 0.051],
    [0.114, 0.705, 0.057],
    [0.116, 0.735, 0.058],
    [0.114, 0.765, 0.057],
    [0.1, 0.79, 0.055],
  ] as readonly P3[],
  earFront: { z: -0.02, gonion: [0.08, 0.65, -0.02] as P3, taper: { from: 0.655, to: 0.72, scale: 0.84 } },
  /** Height whose profile depth the jaw loop takes at the chin (see jaw). */
  chinTop: 0.615,
  /** The jaw's front-view exponent (see jaw): 2 an elliptic U, 1 a straight V; between, a small round chin under full cheeks. */
  chinRound: 1.7,
  /** Face-plane depth fairing (see fairFace). */
  fair: { iterations: 2, weight: 0.5 },
  cheekLoop: 0.705,
  hairline: 0.79,
  /** Face rows: 4 from the jaw to the cheek loop, 3 from it to the hairline; 5 columns a side. */
  rows: [4, 3] as const,
  /** Lower face rows from the jaw loop (0) to the cheek loop (1): row 1-2 frames the mouth, rows 3-5 the eyes. */
  lowerRows: [0, 0.2, 0.45, 0.7, 1],
  columns: 5,
  /**
   * Cheek band columns between the border and the ear-front line, back columns between the
   * ear-fronts: with the face columns, one meridian per point of the G2 neck's top ring (32).
   */
  band: 3,
  back: 16,
  /** The jaw loop's back (the nape under the occiput) and the back heights of the face rows. */
  backRows: [0.655, 0.67, 0.683, 0.694, 0.705, 0.735, 0.765, 0.79],
  /** Cranium rings over the hairline (all ring points), then the crown grid. */
  cranium: [0.83],
  /**
   * The neck ring, the cage's open boundary under the collar's lowest top (0.600 at the sides):
   * on the G2 neck's column (half-width 0.036, depth radius 0.0375 about z 0.0075). head.ts
   * joins it to the trunk's top ring at `seam` (the G2 neck goes with the head), so the visible
   * neck is the cage's, faceted with the head.
   */
  neck: { y: 0.596, flare: 1.0, seam: 0.586, center: [0, 0.6, 0.002] as P3, radius: [0.034, 0.032] as P2 },
  /**
   * The throat ring: level on the neck column, `above` the chin (the G6 collar's lip, garments.ts
   * facetCollar, reaches the chin's height on the neck), its radius `pinch` of the neck's (inside
   * the lip); the under-jaw ring `reach` out to the jaw loop and `tuck` under it (the sheet: the
   * under-jaw flat at 0.616-0.622 from z 0.09 back to 0.045; from the front it hides behind the jaw).
   * The throat ring sits at `y` in front on its own column (`center`, `radius`); behind the jaw
   * corner the under-jaw ring drops `drop` and its reach falls to `backReach`, so the head's
   * underside rounds into the neck (no shelf past the cranium in a three-quarter view). Behind,
   * the ring rises to `back` (inside the collar's higher back); higher, the turn rows into the
   * nape folded over 45 deg. The turn rows rise `lift` over the straight blend to the under-jaw.
   */
  throat: { y: 0.61, back: 0.616, center: [0, 0.6, 0.0075] as P3, radius: [0.036, 0.0375] as P2, above: 0.0015, pinch: 0.96, reach: 0.5, tuck: 0.004, backReach: 0.4, drop: 0.0075, lift: 0.004 },
} as const;

/** Meridians: centre, 5 face columns, 2 band, ear-front, 15 back, then the mirror side (32). */
export const MERIDIANS = 1 + 2 * HEAD_PLAN.columns + 2 * HEAD_PLAN.band + HEAD_PLAN.back - 1;
const BORDER_M = HEAD_PLAN.columns;
const EAR_M = HEAD_PLAN.columns + HEAD_PLAN.band;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: P3, b: P3, t: number): P3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Piecewise-linear table lookup (clamped). */
function table(rows: readonly P2[], x: number): number {
  const first = rows[0] as P2;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < rows.length; i++) {
    const [x1, y1] = rows[i] as P2;
    const [x0, y0] = rows[i - 1] as P2;
    if (x <= x1) return lerp(y0, y1, (x - x0) / (x1 - x0));
  }
  return (rows[rows.length - 1] as P2)[1];
}

/** The border between two heights, by height. */
function borderAt(y: number): P3 {
  const b = HEAD_PLAN.border;
  for (let i = 1; i < b.length; i++) {
    const [p, q] = [b[i - 1] as P3, b[i] as P3];
    if (y <= q[1] || i === b.length - 1) return lerp3(p, q, (y - p[1]) / (q[1] - p[1]));
  }
  return b[b.length - 1] as P3;
}

/**
 * The nose (the side view is the truth): a soft ridge from the brow
 * down to the measured apex, spread over NOSE.columns either side and faired, in the face's smooth group.
 */
export const NOSE = { apex: FACE_SHEET.nose.z, y: FACE_SHEET.nose.y, below: 0.012, ridge: { from: 0.76, rise: 0.002 }, columns: 3 } as const;

/** Height of the nose over the profile at y: the ridge rising toward the apex, then a short drop below it. */
export function noseAt(y: number): number {
  const top = NOSE.apex - table(SMOOTH_PROFILE, NOSE.y);
  if (y < NOSE.y) return Math.max(0, top * (1 - (NOSE.y - y) / NOSE.below));
  if (y > NOSE.ridge.from) return 0;
  return lerp(top, NOSE.ridge.rise, (y - NOSE.y) / (NOSE.ridge.from - NOSE.y));
}

/** The centre profile under the nose (faceRowLeft raises the centre meridian by noseAt). */
const centre = (y: number): P3 => [0, y, table(SMOOTH_PROFILE, y)];

/** The side profile without its points inside the nose span (noseAt adds the nose on top). */
const SMOOTH_PROFILE = FACE_SHEET.profile.filter(([y]) => y < FACE_SHEET.nose.span[0] || y > FACE_SHEET.nose.span[1]);

/**
 * The jaw line, chin (u 0) to the jaw corner (u 1): in the front view a superellipse quarter
 * (exponent chinRound), level at the chin and rising steeply into the cheek: a small round chin
 * under full cheeks, no V point.
 */
function jaw(u: number): P3 {
  const [xc, yc] = FACE_SHEET.jawCorner;
  const { y } = FACE_SHEET.chin;
  // The chin tip's 3 mm underside turn (profile z 0.09 -> 0.1 by y 0.62) belongs to the jaw
  // border, not the face plane: the loop takes the profile depth just above the tip.
  const z = table(FACE_SHEET.profile, HEAD_PLAN.chinTop);
  const n = HEAD_PLAN.chinRound;
  const rise = 1 - (1 - u ** n) ** (1 / n);
  const corner = HEAD_PLAN.border[0] as P3;
  return [u * xc, lerp(y, yc, rise), z - (z - corner[2]) * arcDrop(u, xc, z - corner[2])];
}

/** A horizontal face row at height y across to the border: a circular arc, level at the centre. */
function faceRow(y: number, u: number): P3 {
  const b = borderAt(y);
  const c = centre(y);
  return [u * b[0], y, c[2] - (c[2] - b[2]) * arcDrop(u, b[0], c[2] - b[2])];
}

/**
 * Share of a cross-section's depth drop reached at u: a circular arc level at the centre, so the
 * turn is spread evenly over the columns (a parabola puts the largest fold at the centre meridian).
 */
function arcDrop(u: number, half: number, drop: number): number {
  const r = (half * half + drop * drop) / (2 * drop);
  return (r - Math.sqrt(r * r - (u * half) ** 2)) / drop;
}

/** Coons patch between two rows (v 0, v 1), the centre profile (u 0) and the border (u 1). */
function coons(bottom: (u: number) => P3, top: (u: number) => P3, u: number, v: number): P3 {
  const [b0, b1, t0, t1] = [bottom(0), bottom(1), top(0), top(1)];
  const left = (vv: number) => centre(lerp(b0[1], t0[1], vv));
  const right = (vv: number) => borderAt(lerp(b1[1], t1[1], vv));
  const [B, T, L, R] = [bottom(u), top(u), left(v), right(v)];
  // Quadratic side blend: level at the centre meridian, so the mirrored halves meet without a crease.
  const w = u * u;
  return [0, 1, 2].map(
    (k) =>
      (1 - v) * B[k]! + v * T[k]! + (1 - w) * L[k]! + w * R[k]! - ((1 - w) * (1 - v) * b0[k]! + w * (1 - v) * b1[k]! + (1 - w) * v * t0[k]! + w * v * t1[k]!),
  ) as P3;
}

/** G2 skull ring at height y (the hair cap was layered on this surface): half-width and back z. */
function skull(y: number): { half: number; back: number } {
  const rings = headRings();
  const half = table(
    rings.map((r) => [r[0], r[1]] as P2),
    y,
  );
  const back = table(
    rings.map((r) => [r[0], r[3]] as P2),
    y,
  );
  return { half, back };
}

/** The ear-front point at a height: the skull's half-width at z -0.02 (the gonion on the jaw loop). */
function earFront(y: number, jawLoop: boolean): P3 {
  if (jawLoop) return HEAD_PLAN.earFront.gonion;
  // Under the ear the head narrows into the jaw (a skull-wide jaw reads as a shelf over the neck).
  const { from, to, scale } = HEAD_PLAN.earFront.taper;
  const t = Math.min(1, Math.max(0, (y - from) / (to - from)));
  return [skull(y).half * 0.97 * (scale + (1 - scale) * t * t * (3 - 2 * t)), y, HEAD_PLAN.earFront.z];
}

/** Band points between the border and the ear-front point, turning about the vertical axis at z 0. */
function band(b: P3, e: P3, t: number): P3 {
  const [ab, ae] = [Math.atan2(b[0], b[2]), Math.atan2(e[0], e[2])];
  const [rb, re] = [Math.hypot(b[0], b[2]), Math.hypot(e[0], e[2])];
  const a = lerp(ab, ae, t);
  const r = lerp(rb, re, t) * (1 + 0.03 * Math.sin(Math.PI * t));
  return [r * Math.sin(a), lerp(b[1], e[1], t), r * Math.cos(a)];
}

/** Back points from the left ear-front around the back (k = 1..back-1 of back). */
function backPoint(e: P3, y: number, k: number): P3 {
  const { back } = skull(y);
  const c = e[2] - back;
  const phi = (Math.PI * k) / HEAD_PLAN.back;
  return [e[0] * Math.cos(phi), y, e[2] - c * Math.sin(phi)];
}

/** One full ring from its left-half front points (centre first, through the ear-front), the back and the mirror. */
function ring(left: readonly P3[], y: number): P3[] {
  const e = left[left.length - 1] as P3;
  const backs = Array.from({ length: HEAD_PLAN.back - 1 }, (_, i) => backPoint(e, y, i + 1));
  const mirror = left.slice(1).reverse().map((p): P3 => [-p[0], p[1], p[2]]);
  return [...left, ...backs, ...mirror];
}

/** The left half of face row i (0 jaw .. 6 hairline): centre to border. */
function faceRowLeft(i: number): P3[] {
  const cols = HEAD_PLAN.columns;
  const us = Array.from({ length: cols + 1 }, (_, j) => j / cols);
  if (i === 0) return us.map(jaw);
  return faceRowBase(i, us).map((p, j): P3 => [p[0], p[1], p[2] + noseAt(p[1]) * noseSpread(j)]);
}

/** The nose's share at face column j: a parabola over NOSE.columns either side, so no column edge folds. */
function noseSpread(j: number): number {
  return Math.max(0, 1 - (j / NOSE.columns) ** 2);
}

/**
 * Fairs the face plane's depth: interior points move toward their four neighbours' mean (the centre
 * column mirrors column 1), with the jaw loop, the hairline row and the border fixed. Spreads the
 * nose and the chin turn over neighbouring quads so no interior edge folds.
 */
function fairFace(rows: P3[][]): P3[][] {
  const { iterations, weight } = HEAD_PLAN.fair;
  let z = rows.map((r) => r.map((p) => p[2]));
  for (let it = 0; it < iterations; it++)
    z = z.map((r, i) =>
      r.map((v, j) => {
        if (i === 0 || i === rows.length - 1 || j === r.length - 1) return v;
        const mean = ((z[i - 1]?.[j] as number) + (z[i + 1]?.[j] as number) + (r[j === 0 ? 1 : j - 1] as number) + (r[j + 1] as number)) / 4;
        return lerp(v, mean, weight);
      }),
    );
  return rows.map((r, i) => r.map((p, j): P3 => [p[0], p[1], z[i]?.[j] as number]));
}

function faceRowBase(i: number, us: readonly number[]): P3[] {
  const [lower, upper] = HEAD_PLAN.rows;
  const k = HEAD_PLAN.cheekLoop;
  if (i <= lower) return us.map((u) => coons(jaw, (uu) => faceRow(k, uu), u, HEAD_PLAN.lowerRows[i] as number));
  return us.map((u) => coons((uu) => faceRow(k, uu), (uu) => faceRow(HEAD_PLAN.hairline, uu), u, (i - lower) / upper));
}

/** Rows of the turn from the throat to the under-jaw plane (a quarter ellipse: each row's slope steps by 90 / (TURNS + 1) deg). */
export const TURNS = 4;
/** Index of the jaw loop (face ring 0) in headGrid's rings: the neck, the throat, the turn rings and the under-jaw ring come first. */
export const JAW_RING = TURNS + 3;

/**
 * Every ring of the cage, bottom to top: the neck (the open boundary), the throat, the
 * under-jaw, the face rows (from JAW_RING, 0 the jaw loop) and the cranium.
 */
export function headGrid(): { readonly rings: readonly (readonly P3[])[]; readonly neck: readonly P3[] } {
  const rows = HEAD_PLAN.rows[0] + HEAD_PLAN.rows[1];
  const faceLeft = fairFace(Array.from({ length: rows + 1 }, (_, i) => faceRowLeft(i)));
  const faceRings = Array.from({ length: rows + 1 }, (_, i) => {
    const f = faceLeft[i] as P3[];
    const b = f[f.length - 1] as P3;
    const y = HEAD_PLAN.backRows[i] as number;
    const e = earFront(i === 0 ? b[1] : b[1], i === 0);
    const bands = Array.from({ length: HEAD_PLAN.band - 1 }, (_, j) => band(b, e, (j + 1) / HEAD_PLAN.band));
    return ring([...f, ...bands, e], y);
  });
  // The throat ring under the jaw (the under-jaw plane runs almost level from the chin, then
  // turns down into the neck) and the neck ring under the collar.
  const { y: ny, center, radius } = HEAD_PLAN.neck;
  const onColumn = (c: readonly number[], r: readonly number[]) => (p: P3, y: number): P3 => {
    const a = Math.atan2((p[0] - (c[0] as number)) / (r[0] as number), (p[2] - (c[2] as number)) / (r[1] as number));
    return [(c[0] as number) + (r[0] as number) * Math.sin(a), y, (c[2] as number) + (r[1] as number) * Math.cos(a)];
  };
  const onNeck = onColumn(center, radius);
  const onThroat = onColumn(HEAD_PLAN.throat.center, HEAD_PLAN.throat.radius);
  const jawLoop = faceRings[0] as P3[];
  const { y: ty, above, pinch, reach, tuck } = HEAD_PLAN.throat;
  // Under the jaw: `reach` out from the neck column, `tuck` under the jaw loop (so it stays
  // inside the jaw's front silhouette), never under the throat.
  // Behind the jaw corner it drops `drop` and pulls in (`reach` falls to `backReach`): the head's
  // underside rounds into the neck instead of a level plate under the jaw loop.
  const under = jawLoop.map((p): P3 => {
    const t = Math.min(1, Math.max(0, (0.04 - p[2]) / 0.06));
    const s = t * t * (3 - 2 * t);
    const q = lerp3(onNeck(p, ny), p, reach + (HEAD_PLAN.throat.backReach - reach) * s);
    return [q[0], Math.max(FACE_SHEET.chin.y + above, p[1] - tuck - HEAD_PLAN.throat.drop * s), q[2]];
  });
  const throat = jawLoop.map((p) => {
    // Low in front (the turn from the under-jaw spreads over two rings), at the chin behind (inside the collar's higher back).
    const t = Math.min(1, Math.max(0, (p[2] - 0.0) / 0.04));
    const q = onThroat(p, HEAD_PLAN.throat.back + (ty - HEAD_PLAN.throat.back) * t * t * (3 - 2 * t));
    const c = HEAD_PLAN.throat.center;
    // Behind, the collar's lip reaches the column at 0.616 and the subdivided turn into the nape bulges out: pinch harder.
    const k = pinch - 0.1 * (1 - t);
    return [c[0] + (q[0] - c[0]) * k, q[1], c[2] + (q[2] - c[2]) * k] as P3;
  });
  // Flared toward the trunk's top ring (0.045 wide at the seam): the neck column then meets the seam strip at under 30 deg.
  const neck = throat.map((p) => {
    const q = onNeck(p, ny);
    const f = HEAD_PLAN.neck.flare;
    return [center[0] + (q[0] - center[0]) * f, q[1], center[2] + (q[2] - center[2]) * f] as P3;
  });
  // Cranium rings at the hairline ring's azimuths about the head axis, on the skull.
  const top = faceRings[rows] as P3[];
  const onSkull = (p: P3, y: number): P3 => {
    const { half, back } = skull(y);
    const front = table(
      headRings().map((r) => [r[0], r[2]] as P2),
      y,
    );
    const a = Math.atan2(p[0], p[2] - (front + back) / 2);
    return [half * Math.sin(a), y, (front + back) / 2 + ((front - back) / 2) * Math.cos(a)];
  };
  const cranium = HEAD_PLAN.cranium.map((y) => top.map((p) => onSkull(p, y)));
  // The turn from the vertical throat to the level under-jaw plane is a quarter ellipse over TURNS
  // rows (18 deg steps), so no dihedral there passes about 30 deg (one 45 deg row made 55 deg folds).
  const turn = (theta: number) =>
    throat.map((t, i): P3 => {
      const u = under[i] as P3;
      const [c, s] = [1 - Math.cos(theta), Math.sin(theta)];
      return [t[0] + (u[0] - t[0]) * c, t[1] + (u[1] - t[1]) * s + HEAD_PLAN.throat.lift * s, t[2] + (u[2] - t[2]) * c];
    });
  return { rings: [neck, throat, ...Array.from({ length: TURNS }, (_, k) => turn((Math.PI / 2) * (k + 1) / (TURNS + 1))), under, ...faceRings, ...cranium], neck };
}

/** A quad of the cage (head.ts subdivides it), its corners counter-clockwise seen from outside. */
export interface CageQuad {
  readonly ids: readonly [number, number, number, number];
  readonly region: 'face-plane' | 'skin';
  /**
   * Its structure zone (head.ts tags it, so the faceting keeps the zone borders as facet edges):
   * the neck, one zone per throat row (`throat-<row>`), the under-jaw, the face plane (`face`), cheek band (`cheek`) and back (`back`)
   * below (`-lower`) and above (`-upper`) the cheek loop, the face plane split at the centre
   * profile (`-l`, `-r`, the nose ridge), the cranium band over the hairline and the crown grid.
   */
  readonly zone: string;
}

/** The structure zone of the ring quad from ring `r` up, meridian `m` on (CageQuad.zone). */
function zone(r: number, m: number): string {
  const faceRows = HEAD_PLAN.rows[0] + HEAD_PLAN.rows[1];
  if (r === 0) return 'neck';
  if (r <= TURNS) return `throat-${r}`;
  if (r < JAW_RING) return 'under-jaw';
  if (r >= JAW_RING + faceRows) return 'cranium';
  const height = r < JAW_RING + HEAD_PLAN.rows[0] ? 'lower' : 'upper';
  const left = m < MERIDIANS / 2;
  const k = left ? m : MERIDIANS - 1 - m;
  const part = k < BORDER_M ? 'face' : k < EAR_M ? 'cheek' : 'back';
  return part === 'back' ? `back-${height}` : `${part}-${height}-${left ? 'l' : 'r'}`;
}

/** Cap grid cells a side: the top ring's points close with a square quad patch (poles at its 4 corners). */
const CAP_CELLS = MERIDIANS / 4;
/** Laplacian passes over the crown grid's interior. */
const CAP_RELAX = 24;

/**
 * The all-quad head cage: the neck ring (the open boundary, `boundary` points), the throat, the
 * under-jaw ring, the face rows and the cranium, all on the MERIDIANS, closed by a square grid over the
 * crown. Cap points lie along the blended directions from `CAP_CENTRE` (head.ts projects them
 * onto the skull).
 */
export function headCage(): { readonly points: readonly P3[]; readonly quads: readonly CageQuad[]; readonly boundary: number } {
  const { rings } = headGrid();
  const points: P3[] = [];
  const index = rings.map((r) => r.map((p) => points.push(p) - 1));
  const quads: CageQuad[] = [];
  const faceRows = HEAD_PLAN.rows[0] + HEAD_PLAN.rows[1];
  for (let r = 0; r + 1 < index.length; r++) {
    const [a, b] = [index[r] as number[], index[r + 1] as number[]];
    for (let m = 0; m < MERIDIANS; m++) {
      const n = (m + 1) % MERIDIANS;
      const inFace = r >= JAW_RING && r < JAW_RING + faceRows && (m < BORDER_M || m >= MERIDIANS - BORDER_M);
      quads.push({ ids: [a[m] as number, a[n] as number, b[n] as number, b[m] as number], region: inFace ? 'face-plane' : 'skin', zone: zone(r, m) });
    }
  }
  // The crown grid: the top ring walks its perimeter (front side centred on meridian 0, toward +x).
  const top = index[index.length - 1] as number[];
  const K = CAP_CELLS;
  const h = K / 2;
  const at = (i: number, j: number): number | undefined => {
    const k = j === K ? i - h : i === K ? h + (K - j) : j === 0 ? h + K + (K - i) : i === 0 ? h + 2 * K + j : undefined;
    return k === undefined ? undefined : (top[(k + MERIDIANS) % MERIDIANS] as number);
  };
  const dir = (p: P3) => norm3([p[0] - CAP_CENTRE[0], p[1] - CAP_CENTRE[1], p[2] - CAP_CENTRE[2]]);
  const reach = top.reduce((s, i) => s + Math.hypot(...(sub3(points[i] as P3, CAP_CENTRE) as [number, number, number])), 0) / top.length;
  const grid: number[][] = [];
  for (let i = 0; i <= K; i++) {
    grid.push([]);
    for (let j = 0; j <= K; j++) {
      const edge = at(i, j);
      if (edge !== undefined) {
        grid[i]?.push(edge);
        continue;
      }
      const [u, v] = [i / K, j / K];
      const d = (ii: number, jj: number) => dir(points[at(ii, jj) as number] as P3);
      const mix = [0, 1, 2].map((c) => {
        const e = (ii: number, jj: number) => d(ii, jj)[c] as number;
        return (1 - u) * e(0, j) + u * e(K, j) + (1 - v) * e(i, 0) + v * e(i, K) - ((1 - u) * (1 - v) * e(0, 0) + u * (1 - v) * e(K, 0) + (1 - u) * v * e(0, K) + u * v * e(K, K));
      }) as unknown as P3;
      const w = norm3(mix);
      grid[i]?.push(points.push([CAP_CENTRE[0] + reach * w[0], CAP_CENTRE[1] + reach * w[1], CAP_CENTRE[2] + reach * w[2]]) - 1);
    }
  }
  // Relax the interior over the sphere: the transfinite fill crowds the corner cells (the corner
  // poles then crease the limit surface), the averaged grid spreads them.
  for (let pass = 0; pass < CAP_RELAX; pass++)
    for (let i = 1; i < K; i++)
      for (let j = 1; j < K; j++) {
        const id = grid[i]?.[j] as number;
        const ring = [grid[i - 1]?.[j], grid[i + 1]?.[j], grid[i]?.[j - 1], grid[i]?.[j + 1]].map((n) => sub3(points[n as number] as P3, CAP_CENTRE));
        const w = norm3([0, 1, 2].map((c) => ring.reduce((t, q) => t + (q[c] as number), 0)) as unknown as P3);
        points[id] = [CAP_CENTRE[0] + reach * w[0], CAP_CENTRE[1] + reach * w[1], CAP_CENTRE[2] + reach * w[2]];
      }
  for (let i = 0; i < K; i++)
    for (let j = 0; j < K; j++) {
      const c = [grid[i]?.[j], grid[i + 1]?.[j], grid[i + 1]?.[j + 1], grid[i]?.[j + 1]] as [number, number, number, number];
      // Seen from above (+y), +x right and +z down the page, this corner order runs clockwise: reverse it.
      quads.push({ ids: [c[0], c[3], c[2], c[1]], region: 'skin', zone: 'crown' });
    }
  return { points, quads, boundary: MERIDIANS };
}

/** The cap's projection centre (head.ts projects hidden points along rays from about here). */
export const CAP_CENTRE: P3 = [0, 0.8, -0.005];
const sub3 = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm3 = (a: P3): P3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The structure lines as 3D polylines (character left; the jaw loop and the rings are whole). */
export function structureLines(): Readonly<Record<string, readonly P3[]>> {
  const g = headGrid();
  const rows = HEAD_PLAN.rows[0] + HEAD_PLAN.rows[1];
  const faceRings = g.rings.slice(JAW_RING, JAW_RING + rows + 1);
  const meridian = (m: number) => faceRings.map((r) => r[m] as P3);
  const span = (r: readonly P3[], from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => r[(from + i + MERIDIANS) % MERIDIANS] as P3);
  return {
    'jaw line': span(faceRings[0] as P3[], -EAR_M, EAR_M),
    'face border': meridian(BORDER_M),
    'centre profile': meridian(0),
    'cheek loop': span(faceRings[HEAD_PLAN.rows[0]] as P3[], -EAR_M, EAR_M),
    'ear-front line': meridian(EAR_M),
    hairline: span(faceRings[rows] as P3[], -BORDER_M, BORDER_M),
    'neck seam': [...g.neck, g.neck[0] as P3],
  };
}

// ---------------------------------------------------------------- drawing

const FRONT = 'head-front';
const SIDE = 'head-side';
const CHEEK = 'cheek-section';
type Item = DrawingItem;

const project = (view: 'front' | 'right', p: P3): P2 => {
  const [u, v] = toView(view, p);
  return [u, v];
};

const polyline = (id: string, view: string, role: Item['role'], points: readonly P2[], extra: Partial<Item> = {}): Item =>
  ({ id, view, role, kind: 'curve', curve: { kind: 'polyline', points }, basis: 'derived', ...extra }) as Item;

/** The cage's edges in a view (front: the quads toward the viewer; side: the left half). */
function gridEdges(view: 'front' | 'right'): Item[] {
  const { points, quads } = headCage();
  const seen = new Set<string>();
  const items: Item[] = [];
  const toward = view === 'front' ? ([0, 0, 1] as const) : ([1, 0, 0] as const);
  for (const q of quads) {
    const [a, b, c, d] = q.ids.map((i) => points[i] as P3) as [P3, P3, P3, P3];
    const [u, w] = [sub3(c, a), sub3(d, b)];
    const n: P3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2] <= 0) continue;
    for (let k = 0; k < 4; k++) {
      const [i, j] = [q.ids[k] as number, q.ids[(k + 1) % 4] as number];
      const key = [i, j].sort((x, y) => x - y).join('-');
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(polyline(`${view === 'front' ? 'f' : 's'} edge ${key}`, view === 'front' ? FRONT : SIDE, 'construction', [project(view, points[i] as P3), project(view, points[j] as P3)]));
    }
  }
  return items;
}

const box = (id: string, view: string, b: readonly number[], note: string): Item =>
  polyline(
    id,
    view,
    'guide',
    [
      [b[0] as number, b[1] as number],
      [b[2] as number, b[1] as number],
      [b[2] as number, b[3] as number],
      [b[0] as number, b[3] as number],
    ],
    { closed: true, basis: 'blueprint', note } as Partial<Item>,
  );

/** Poles of the cage: vertices of valence other than 4 above the open throat ring (the crown grid's corners). */
export function planPoles(): { readonly position: P3; readonly valence: number }[] {
  const { points, quads, boundary } = headCage();
  const val = new Map<number, number>();
  for (const q of quads) for (const i of q.ids) val.set(i, (val.get(i) ?? 0) + 1);
  return [...val.entries()].filter(([i, v]) => i >= boundary && v !== 4).map(([i, v]) => ({ position: points[i] as P3, valence: v }));
}

function poleItems(): Item[] {
  return planPoles()
    .filter((p) => p.position[2] > -0.03 && p.position[1] < 0.8)
    .map((p, k): Item => ({ id: `pole ${k} v${p.valence}`, view: FRONT, role: 'construction', kind: 'point', at: project('front', p.position), basis: 'derived', note: `valence ${p.valence}` }));
}

/** Lines drawn for the character's left only; the front view shows their mirror too. */
const MIRRORED = ['face border', 'ear-front line'];

function structureItems(): Item[] {
  const lines = structureLines();
  const items: Item[] = [];
  for (const [name, pts] of Object.entries(lines)) {
    const link = name.replace(/ /g, '-');
    items.push(polyline(name, FRONT, 'structure', pts.map((p) => project('front', p)), { link, basis: 'estimate' }));
    if (MIRRORED.includes(name)) items.push(polyline(`${name} (mirror)`, FRONT, 'structure', pts.map((p) => project('front', [-p[0], p[1], p[2]])), { basis: 'estimate' }));
    const left = name === 'jaw line' || name === 'cheek loop' || name === 'hairline' || name === 'neck seam' ? pts.filter((p) => p[0] >= -1e-9) : pts;
    items.push(polyline(`${name} (side)`, SIDE, 'structure', left.map((p) => project('right', p)), { link, basis: 'estimate' }));
  }
  return items;
}

function sheetItems(): Item[] {
  const half = FACE_SHEET.visibleHalf;
  const outline = [...half.map(([y, x]): P2 => [x, y]), ...[...half].reverse().map(([y, x]): P2 => [-x, y])];
  const boxes = decalBoxes();
  const { ear, nose, jawCrease, profile } = FACE_SHEET;
  return [
    polyline('sheet visible face', FRONT, 'guide', outline, { basis: 'blueprint', note: 'visible skin; above the jaw corner the side locks bound it' }),
    ...Object.entries(boxes).map(([k, b]) => box(`decal ${k}`, FRONT, b, 'decal area: no pole inside')),
    polyline('sheet profile', SIDE, 'guide', profile.map(([y, z]): P2 => [-z, y]), { basis: 'blueprint' }),
    polyline('sheet jaw crease', SIDE, 'guide', jawCrease.map(([z, y]): P2 => [-z, y]), { basis: 'blueprint' }),
    polyline(
      'sheet nose point',
      SIDE,
      'guide',
      [
        [-table(profile, nose.span[0]), nose.span[0]],
        [-nose.z, nose.y],
        [-table(profile, nose.span[1]), nose.span[1]],
      ],
      { basis: 'blueprint', note: 'a soft ridge to this apex' },
    ),
    box('sheet ear', SIDE, [-ear.z[1], ear.y[0], -ear.z[0], ear.y[1]], 'ear behind the side lock'),
  ];
}

/** The cheek-widest loop as a section across y (reads like top: u = x, v = -z). */
function cheekSection(): Item[] {
  const g = headGrid();
  const r = g.rings[JAW_RING + HEAD_PLAN.rows[0]] as P3[];
  return [polyline('cheek ring', CHEEK, 'section', [...r, r[0] as P3].map((p): P2 => [p[0], -p[2]]), { basis: 'derived', note: 'the widest loop: face plane front, cheek band, ear-fronts, skull back' })];
}

function notes(): Item[] {
  const poles = planPoles();
  const lines = [
    `all-quad cage: ${MERIDIANS} meridians (one per neck seam point, so the neck rings run on into the head) x ${headGrid().rings.length} rings + an ${CAP_CELLS} x ${CAP_CELLS} crown grid; remeshed by head.ts into even flat facets that keep the zone borders, wrapped on its limit surface`,
    `face plane = face rows ${HEAD_PLAN.rows.join(' + ')} x ${2 * HEAD_PLAN.columns} columns between the borders: jaw loop into the round chin, cheek-widest (nasolabial) loop, brow row, hairline`,
    `cage poles: ${poles.length} at the crown grid's corners (under the hair); the facets keep poles and fans out of the decal areas`,
    'eyes, brows, mouth, blush are decals on one planar UV chart over the flat face-plane facets',
    'a soft nose ridge on the centre meridian (the side view is the truth)',
    'sheet face width: reference.json front face bounds include the ear; the visible half-width is 0.099 (cheek) to 0.105 (lash line), so the face border sits at x 0.085-0.101',
  ];
  return lines.map((text, k): Item => ({ id: `plan note ${k + 1}`, view: FRONT, role: 'construction', kind: 'note', refs: [], text }));
}

export const HEAD_DRAWING: Drawing = {
  name: 'C-200 G7 head and face topology plan (rings, structure lines, poles, decal areas)',
  sources: [{ title: 'maid-whale turnaround (derived data)', note: 'FACE_SHEET from the G7 face measure; skull back from body.ts headRings (the hair cap was layered on it)' }],
  views: [
    { id: FRONT, ortho: 'front' },
    { id: SIDE, ortho: 'right' },
    { id: CHEEK, section: { axis: 'y', at: HEAD_PLAN.cheekLoop } },
  ],
  items: [...gridEdges('front'), ...gridEdges('right'), ...structureItems(), ...sheetItems(), ...cheekSection(), ...poleItems(), ...notes()],
};
