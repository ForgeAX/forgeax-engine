import { type FaceSelector, type Model, sel } from '@forgeax/engine-modeling';
import { REF } from './reference.ts';

/**
 * Case C-200 stage G7 (materials): the sheet palette (reference.json `palette`, measured by
 * calibrate/calibrate.mjs) mapped onto the model's material slots, the hair ombre as one
 * colour per face (no gradient inside a face), and the tail's own slots. Colours are
 * linear RGB; renderers take `slotColours()`.
 */
export type Rgb = readonly [number, number, number];
export type PaletteName =
  | 'hair-root'
  | 'hair-tip'
  | 'navy-cloth'
  | 'white-cloth'
  | 'skin'
  | 'ribbon'
  | 'gem'
  | 'gold'
  | 'shoe'
  | 'tail'
  | 'tail-underside'
  | G7PaletteName;

/** Entries of the G7 palette supplement (`G7_PALETTE`). */
export type G7PaletteName = 'leg-skin' | 'hand-skin' | 'gem-part' | 'shoe-part' | 'tail-part';

/**
 * G7 palette supplement, measured on the sheet by g7-measure.ts `sheetPartColour` (the
 * criterion-6 part windows of `COLOUR_PARTS`: the part's colour-class pixels whose 4 neighbours
 * share a class): the mean CIE L*a*b* (D65) of those pixels, stored as L*a*b* and converted
 * exactly to linear RGB. reference.json `palette` holds one class median per colour; these
 * parts differ from it: the legs sit in the skirt's shade (L* 65.5 against the face's 87), the
 * hands are a shade darker than the face, and the gem, shoe and tail entries are the part
 * means rather than the shared class medians.
 */
export const G7_PALETTE: Readonly<Record<G7PaletteName, { readonly lab: Rgb; readonly window: string }>> = {
  'leg-skin': { lab: [65.54, 11.79, 20.73], window: 'front, sheet px [150,522,226,575] + [232,522,312,575], class skin, n 2731' },
  'hand-skin': { lab: [82.27, 9.61, 19.19], window: 'front, sheet px [90,418,136,462] + [322,428,372,468], class skin, n 1271' },
  'gem-part': { lab: [62.16, -20.15, -24.81], window: 'front, sheet px [208,278,238,304], class gem, n 25' },
  'shoe-part': { lab: [16.2, 5.17, -19.19], window: 'front, sheet px [130,576,228,642] + [232,576,330,642], classes navy/dark, n 4451' },
  'tail-part': { lab: [19.57, 9.14, -28.28], window: 'side, sheet px [700,470,860,600], classes navy/hair, n 10229' },
};

const PALETTE = new Map(REF.palette.map((p) => [p.name, p]));

export function paletteEntry(name: PaletteName): { readonly srgb: Rgb; readonly linear: Rgb } {
  const g7 = (G7_PALETTE as Readonly<Record<string, { readonly lab: Rgb }>>)[name];
  if (g7 !== undefined) {
    const linear = labToLinear(g7.lab);
    return { srgb: linear.map(linearToSrgb8) as unknown as Rgb, linear };
  }
  const p = PALETTE.get(name);
  if (p === undefined) throw new Error(`reference.json has no palette entry '${name}'`);
  return { srgb: p.srgb as unknown as Rgb, linear: p.linear as unknown as Rgb };
}

/**
 * Model slot -> palette entry. The G6 assembly uses white, navy, hair, skin, ribbon, shoe, gold
 * and gem; `tail`/`tail-underside` come from `tailSlots`, `leg-skin`/`hand-skin` from
 * `skinSlots`, `hair-<i>` from `hairOmbre`. Gem, shoe and tail take the G7 part means.
 */
export const SLOT_PALETTE: Readonly<Record<string, PaletteName>> = {
  skin: 'skin',
  'leg-skin': 'leg-skin',
  'hand-skin': 'hand-skin',
  navy: 'navy-cloth',
  white: 'white-cloth',
  hair: 'hair-root',
  ribbon: 'ribbon',
  gem: 'gem-part',
  gold: 'gold',
  shoe: 'shoe-part',
  tail: 'tail-part',
  'tail-underside': 'tail-underside',
};

/**
 * Measured ombre of the sheet (rows of 12 px over the back hair, side view and front side
 * locks): each hair-classified pixel projected onto the hair-root -> hair-tip segment in
 * linear RGB, `t` = the share of light pixels (projection > 0.5) over its 0.8 plateau, side
 * and back averaged, by height in model meters (ground 0, total 1). Light facets first appear
 * at 0.60, half the hair is light at 0.505, all of it below 0.48 (the lower rows darken
 * only by shading). The per-face buckets cut this ramp at even `t` steps.
 */
export const OMBRE_STOPS: readonly (readonly [y: number, t: number])[] = [
  [0.6, 0],
  [0.585, 0.1],
  [0.555, 0.22],
  [0.525, 0.4],
  [0.505, 0.65],
  [0.49, 0.95],
  [0.48, 1],
];

/** Height where the measured ramp reaches `t` (stops are monotone in both). */
export function ombreHeight(t: number): number {
  const s = OMBRE_STOPS;
  if (t <= 0) return s[0]?.[0] as number;
  for (let i = 1; i < s.length; i++) {
    const [y0, t0] = s[i - 1] as readonly [number, number];
    const [y1, t1] = s[i] as readonly [number, number];
    if (t <= t1) return y0 + ((t - t0) / (t1 - t0)) * (y1 - y0);
  }
  return s[s.length - 1]?.[0] as number;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((k) => (a[k] as number) + ((b[k] as number) - (a[k] as number)) * t) as unknown as Rgb;

/** Bucket colours from hair-root (0) to hair-tip (steps-1), evenly spaced in linear RGB. */
export function ombreColours(steps = 6): Rgb[] {
  const root = paletteEntry('hair-root').linear;
  const tip = paletteEntry('hair-tip').linear;
  return Array.from({ length: steps }, (_, i) => mix(root, tip, steps === 1 ? 0 : i / (steps - 1)));
}

/** Upper/lower centroid heights of each bucket: bucket i spans [bands[i][0], bands[i][1]). */
export function ombreBands(steps = 6): [number, number][] {
  const cuts = Array.from({ length: steps - 1 }, (_, i) => ombreHeight((i + 0.5) / (steps - 1)));
  return Array.from({ length: steps }, (_, i) => [i === steps - 1 ? -Infinity : (cuts[i] as number), i === 0 ? Infinity : (cuts[i - 1] as number)]);
}

/** Parts that hang on the hair but are not hair. */
const NOT_HAIR = ['headdress', 'ribbon-l', 'ribbon-r', 'fin-l', 'fin-r', 'back-bow'];

/** The hair faces (tag 'hair', minus the attachments seated on it). */
export function hairFaces(): FaceSelector {
  return NOT_HAIR.reduce<FaceSelector>((s, t) => s.minus(sel.tag(t)), sel.tag('hair'));
}

/**
 * Re-assign the hair faces into slots `hair-0` (root) .. `hair-{steps-1}` (tip) by face
 * centroid height against the measured ramp; one colour per face. Returns the face count of
 * each bucket (empty buckets are skipped, so the session never fails on them).
 */
export function hairOmbre(m: Model, steps = 6): number[] {
  const bands = ombreBands(steps);
  const big = 1e3;
  return bands.map(([lo, hi], i) => {
    const s = hairFaces().and(sel.inBox([-big, Math.max(lo, -big), -big], [big, Math.min(hi, big) - 1e-9, big], { by: 'centroid' }));
    const n = m.count(s);
    if (n > 0) m.assign(s, `hair-${i}`);
    return n;
  });
}

/**
 * The tail and fluke (G6: slot `navy`) into slot `tail`, their downward-facing faces (within
 * `degrees` of -y) into `tail-underside`, the sheet's light belly line.
 */
export function tailSlots(m: Model, degrees = 50): { tail: number; underside: number } {
  const tail = sel.tag('tail').or(sel.tag('fluke'));
  const under = tail.and(sel.facing('-y', degrees));
  const counts = { tail: m.count(tail), underside: m.count(under) };
  if (counts.tail > 0) m.assign(tail, 'tail');
  if (counts.underside > 0) m.assign(under, 'tail-underside');
  return counts;
}

/**
 * The skin of the legs (tags `leg-l`/`leg-r`) into slot `leg-skin` and of the hands (tags
 * `hand-l`/`hand-r`) into `hand-skin`: the sheet paints them darker than the face.
 */
export function skinSlots(m: Model): { leg: number; hand: number } {
  const skin = sel.material('skin');
  const leg = skin.and(sel.tag('leg-l').or(sel.tag('leg-r')));
  const hand = skin.and(sel.tag('hand-l').or(sel.tag('hand-r')));
  const counts = { leg: m.count(leg), hand: m.count(hand) };
  if (counts.leg > 0) m.assign(leg, 'leg-skin');
  if (counts.hand > 0) m.assign(hand, 'hand-skin');
  return counts;
}

/** Linear colour of every known slot (palette slots plus the ombre buckets). */
export function slotColours(steps = 6): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const [slot, name] of Object.entries(SLOT_PALETTE)) out[slot] = [...paletteEntry(name).linear] as [number, number, number];
  ombreColours(steps).forEach((c, i) => {
    out[`hair-${i}`] = [...c] as [number, number, number];
  });
  out.Default = out.skin as [number, number, number];
  return out;
}

// CIEDE2000 colour difference (D65, linear RGB in).
/** CIE L*a*b* (D65) of a linear RGB colour. */
export const linearToLab = (rgb: Rgb): [number, number, number] => {
  const [r, g, b] = rgb as [number, number, number];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (v: number) => (v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};

/** Linear RGB of a CIE L*a*b* (D65) colour: the inverse of `linearToLab`. */
export const labToLinear = ([L, a, b]: Rgb): Rgb => {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (f: number) => (f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) / (24389 / 27));
  const [x, y, z] = [inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883];
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
};

const linearToSrgb8 = (l: number): number => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));

export const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** CIEDE2000 between two linear RGB colours. */
export function deltaE00(a: Rgb, b: Rgb): number {
  return deltaE00Lab(linearToLab(a), linearToLab(b));
}

/** CIEDE2000 between two L*a*b* colours. */
export function deltaE00Lab([L1, a1, b1]: Rgb, [L2, a2, b2]: Rgb): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hue = (bb: number, ap: number) => (bb === 0 && ap === 0 ? 0 : (Math.atan2(bb, ap) / rad + 360) % 360);
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2;
  const Cpb = (Cp1 + Cp2) / 2;
  let hb = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hb /= 2;
    else hb = hp1 + hp2 < 360 ? (hb + 360) / 2 : (hb - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb;
  const Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}
