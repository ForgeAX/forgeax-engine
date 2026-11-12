import {
  type DecalLayer,
  type DecalTextureOptions,
  decalTexture,
  type FaceSelector,
  type Model,
  type ModelingError,
  type Rgba,
  type StandardMaterialOptions,
  sel,
  type TextureSink,
} from '@forgeax/engine-modeling';
import type { Result, TextureAsset } from '@forgeax/engine-types';
import { FACE_SHEET } from './head-plan.ts';
import { paletteEntry, srgbToLinear } from './materials.ts';
import { REF } from './reference.ts';

/**
 * Case C-200 stage G7: the drawn face (eyes, brows, mouth, blush) and the apron's whale emblem
 * as decal sheets on uv1. Every face gets uv1 = its front (z) projection in meters; each decal
 * slot's material maps its sheet rectangle onto that domain with the texture transform
 * (scale 1/size, offset -origin/size), so one projection serves every sheet.
 *
 * Shapes are traced from the sheet's front view in sheet pixels (pixel-edge coordinates: column
 * c spans [c, c + 1), rows grow downward) and converted to meters; the face uses the measured
 * midline (FACE_SHEET is face-local), the emblem the body axis. The eye is the sheet's
 * screen-right eye (character left, x > 0), mirrored for the other side.
 */
type P2 = readonly [number, number];
export type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

const FRONT = REF.views.front.image;
const PPM = REF.scale.pxPerMeter;
/** Sheet u of the face midline (midpoint of the iris centres; G7 face measure). */
export const FACE_MIDLINE_U = -0.0152;

/** Sheet pixel (front view) to face-local meters. */
export const facePx = (c: number, r: number): P2 => [(c - FRONT.axisX) / PPM - FACE_MIDLINE_U, (FRONT.groundY - r) / PPM];
/** Sheet pixel (front view) to model meters about the body axis. */
export const bodyPx = (c: number, r: number): P2 => [(c - FRONT.axisX) / PPM, (FRONT.groundY - r) / PPM];

const hexLinear = (hex: string, alpha = 1): Rgba => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [srgbToLinear((v >> 16) & 255), srgbToLinear((v >> 8) & 255), srgbToLinear(v & 255), alpha];
};
const paletteRgba = (name: Parameters<typeof paletteEntry>[0]): Rgba => [...paletteEntry(name).linear, 1] as unknown as Rgba;

/** Eye shading measured on the sheet beyond FACE_SHEET's two iris colours. */
export const EYE_COLOURS = {
  irisMid: '#20499a',
  pupil: '#082a62',
  irisLight: '#4078c8',
  irisPale: '#70a2e4',
  scleraShade: '#a39897',
  lowerLid: '#b4b6c4',
  highlight: '#dcdff4',
  subHighlight: '#a5bdee',
  crease: '#a37251',
} as const;

/** Brow stroke colour: the reference hair's dark navy. */
const BROW_NAVY = '#1c2a5e';

// ---- shape helpers (sheet pixels) -------------------------------------------------------

function ellipse(cx: number, cy: number, rx: number, ry: number, n = 32): P2[] {
  return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)] as P2);
}

/** Rectangle [c0, c1] x [r0, r1] (rows down) with its bottom corners rounded by `rb`. */
function roundedBottom(c0: number, r0: number, c1: number, r1: number, rb: number, n = 6): P2[] {
  const out: P2[] = [
    [c0, r0],
    [c1, r0],
  ];
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI / 2) * (i / n);
    out.push([c1 - rb + rb * Math.cos(a), r1 - rb + rb * Math.sin(a)]);
  }
  for (let i = 0; i <= n; i++) {
    const a = Math.PI / 2 + (Math.PI / 2) * (i / n);
    out.push([c0 + rb + rb * Math.cos(a), r1 - rb + rb * Math.sin(a)]);
  }
  return out;
}

/** A band of half-width `half(t)` (t 0..1 along the line) around an open polyline. */
function band(line: readonly P2[], half: (t: number) => number): P2[] {
  const left: P2[] = [];
  const right: P2[] = [];
  line.forEach((p, i) => {
    const a = line[Math.max(0, i - 1)] as P2;
    const b = line[Math.min(line.length - 1, i + 1)] as P2;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const [nx, ny] = [-(b[1] - a[1]) / d, (b[0] - a[0]) / d];
    const h = half(i / (line.length - 1));
    left.push([p[0] + nx * h, p[1] + ny * h]);
    right.push([p[0] - nx * h, p[1] - ny * h]);
  });
  return [...left, ...right.reverse()];
}

/** Catmull-Rom samples through control points (open, end points kept). */
function spline(points: readonly P2[], per = 8): P2[] {
  const out: P2[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[Math.max(0, i - 1)] as P2;
    const p1 = points[i] as P2;
    const p2 = points[i + 1] as P2;
    const p3 = points[Math.min(points.length - 1, i + 2)] as P2;
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        [0, 1].map(
          (j) => 0.5 * (2 * p1[j]! + (-p0[j]! + p2[j]!) * t + (2 * p0[j]! - 5 * p1[j]! + 4 * p2[j]! - p3[j]!) * t2 + (-p0[j]! + 3 * p1[j]! - 3 * p2[j]! + p3[j]!) * t3),
        ) as unknown as P2,
      );
    }
  }
  out.push(points[points.length - 1] as P2);
  return out;
}

// ---- face ---------------------------------------------------------------------------------

/**
 * The face sheet's rectangle (face-local meters = model x, y): it holds the face plane
 * (x +-0.127, y 0.614..0.762 on the G6+head model) and the forehead skin up to the hairline
 * (its faces reach x +-0.133), at 4000 px/m.
 */
export const FACE_RECT: Rect = [-0.136, 0.608, 0.136, 0.8];
export const FACE_SHEET_SIZE = [1088, 768] as const;

/** One named region of the face sheet in face-local meters (character left; `mirror` adds the right). */
export interface NamedLayer {
  readonly name: string;
  readonly points: readonly P2[];
  readonly color: Rgba;
  readonly mirror: boolean;
}

/**
 * The iris gradient as IRIS_BANDS stacked bands (decal layers have flat fills): each band from
 * its top to the iris bottom, its colour interpolated in linear RGB over the sheet's stops
 * (dark at the lash, mid, light, pale at the bottom; sheet pixel rows).
 */
const IRIS_BANDS = 10;
const IRIS_STOPS: readonly (readonly [row: number, hex: string])[] = [
  [205.5, FACE_SHEET.colours.irisDark],
  [210.5, EYE_COLOURS.irisMid],
  [218, EYE_COLOURS.irisLight],
  [223.5, EYE_COLOURS.irisPale],
];

function irisBands(): { name: string; px: P2[]; color: Rgba }[] {
  const [first, last] = [IRIS_STOPS[0] as readonly [number, string], IRIS_STOPS[IRIS_STOPS.length - 1] as readonly [number, string]];
  const colourAt = (row: number): Rgba => {
    for (let i = 1; i < IRIS_STOPS.length; i++) {
      const [r0, h0] = IRIS_STOPS[i - 1] as readonly [number, string];
      const [r1, h1] = IRIS_STOPS[i] as readonly [number, string];
      if (row <= r1) {
        const [a, b] = [hexLinear(h0), hexLinear(h1)];
        const t = (row - r0) / (r1 - r0);
        return [0, 1, 2, 3].map((k) => (a[k] as number) + ((b[k] as number) - (a[k] as number)) * t) as unknown as Rgba;
      }
    }
    return hexLinear(last[1]);
  };
  return Array.from({ length: IRIS_BANDS }, (_, k) => {
    const row = first[0] + ((last[0] - first[0]) * (k + 1)) / IRIS_BANDS;
    return { name: `iris-band-${k}`, color: colourAt(row), px: roundedBottom(245.6, row, 266, 227.4, 2.6) };
  });
}

/** Iris centre column of the traced eye and the sideways glance, in sheet pixels (image-left = her right). */
const IRIS_CX = 255.8;
const GLANCE = 3.2;

/** A traced shape; `glance` shapes are placed per eye (translation `d` from the traced iris position), not mirrored. */
interface EyeShape {
  readonly name: string;
  readonly color: Rgba;
  readonly px: P2[] | ((d: number) => P2[]);
  readonly glance?: true;
}

const shifted = (pts: readonly P2[], d: number): P2[] => pts.map(([c, r]) => [c + d, r] as P2);

/** The screen-right eye of the sheet (character left), traced in sheet pixels. */
function eyeShapes(): EyeShape[] {
  const c = FACE_SHEET.colours;
  const e = EYE_COLOURS;
  const iris = (name: string, color: Rgba, px: readonly P2[]): EyeShape => ({ name, color, px: (d) => shifted(px, d), glance: true });
  // Upper lash: a tapered arch (thickest past the middle) from the inner tip over the lowered lid
  // into a short downward flick at the outer end.
  // Its lower edge stays on the iris top (row 202.6); it thickens upward to the measured lash top.
  const lashLine = spline([[237.2, 205.4], [240.6, 202], [246, 199.4], [256, 198.4], [265, 199.2], [272, 201.4], [277.4, 204.4], [281.4, 207.6], [284, 211.4]], 10);
  return [
    // Sclera: one opening under the iris (the glancing irises cover different parts of it), its
    // outer side a narrow wedge into the lower lid, shaded under the lash.
    { name: 'sclera', color: hexLinear(c.sclera), px: [[241.2, 211], [243, 205], [246, 202], [270, 202], [273.6, 203.6], [271, 207], [268.5, 214], [265.5, 222], [263, 228], [246, 228.2], [244, 228.2], [241.2, 222]] },
    { name: 'sclera-shade', color: hexLinear(e.scleraShade), px: [[243, 205], [246, 202], [270, 202], [273.6, 203.6], [271.4, 206.6], [243, 206.6]] },
    // Iris: dark top, mid band, two light steps to the bottom, the round pupil.
    iris('iris', hexLinear(c.irisDark), roundedBottom(245, 200.5, 266.6, 228, 3)),
    ...irisBands().map((b) => iris(b.name, b.color, b.px)),
    iris('pupil', hexLinear(e.pupil), ellipse(IRIS_CX, 213.6, 3, 4.9, 28)),
    { name: 'lower-lid', color: hexLinear(e.lowerLid), px: band(spline([[244.4, 227.6], [255.6, 228.5], [266.6, 227.6]]), () => 0.65) },
    // Light from the upper left on both eyes: a larger upper highlight, a smaller lower one.
    iris('sub-highlight', hexLinear(e.subHighlight, 0.85), ellipse(IRIS_CX + 4.4, 220.4, 1.3, 1.4)),
    iris('highlight', hexLinear(e.highlight), ellipse(IRIS_CX - 4.8, 207.8, 2.3, 2.1)),
    { name: 'lash', color: hexLinear(c.lash), px: band(lashLine, (t) => 0.35 + 3.9 * Math.sin(Math.PI * t ** 0.85) ** 0.8) },
    // The lid crease over the inner half, darkest at the inner end.
    { name: 'crease', color: hexLinear(e.crease, 0.6), px: band(spline([[236.6, 191.6], [240, 190.2], [247, 189.6], [257, 189.8]]), (t) => 0.75 * (1 - 0.7 * t)) },
  ];
}

/**
 * Brow: a slim stroke over the sheet's brow box (head-plan.ts FACE_SHEET.brow), in the hair's navy.
 * It rises from the inner end along the box to the outer end, tapering at both ends.
 */
const BROW_HALF = 0.0017;
function browPolygon(): P2[] {
  const [x0, y0, x1, y1] = FACE_SHEET.brow.box;
  const line = spline([0, 0.5, 1].map((t): P2 => [x0 + (x1 - x0) * t, y0 + BROW_HALF + (y1 - y0 - 2 * BROW_HALF) * t]), 6);
  return band(line, (t) => BROW_HALF * Math.min(1, 6 * t, 6 * (1 - t)) + 0.0002);
}

/** Sheet column of the face midline, to mirror a traced column onto the other eye. */
const MIDLINE_COL = FRONT.axisX + FACE_MIDLINE_U * PPM;

const { lift: BLUSH_LIFT, squash: BLUSH_SQUASH, inward: BLUSH_IN, narrow: BLUSH_NARROW } = FACE_SHEET.blush.draw;

/** Every region of the face sheet in drawing order (blush under the eyes, lash over the iris). */
export function faceLayers(): NamedLayer[] {
  const c = FACE_SHEET.colours;
  const out: NamedLayer[] = [];
  // Blush: nested ellipses at 20 % each over the measured extent, a stepped feather (decal
  // layers have no soft edge); the core reaches about 80 % of the blush colour.
  const [bx0, by0, bx1, by1] = FACE_SHEET.blush.box;
  // Kept above the jaw line (the measured extent's lower corner, y 0.642, lies past the jaw at
  // x 0.08): centre `BLUSH_LIFT` up, the vertical radius `BLUSH_SQUASH` of the extent's.
  const [bcx, bcy, brx, bry] = [(bx0 + bx1) / 2 - BLUSH_IN, (by0 + by1) / 2 + BLUSH_LIFT, ((bx1 - bx0) / 2) * BLUSH_NARROW, ((by1 - by0) / 2) * BLUSH_SQUASH];
  for (let i = 0; i < 7; i++) {
    const k = 1 - i * 0.12;
    out.push({ name: `blush-${i}`, points: ellipse(bcx, bcy, brx * k, bry * k, 40), color: hexLinear(c.blush, 0.2), mirror: true });
  }
  const toFace = (px: readonly P2[]): P2[] => px.map(([x, y]) => facePx(x, y));
  for (const s of eyeShapes()) {
    if (typeof s.px !== 'function') {
      out.push({ name: s.name, points: toFace(s.px), color: s.color, mirror: true });
      continue;
    }
    // Both eyes look the same way: the traced eye's iris moves toward the nose, the other outward.
    out.push({ name: `${s.name}-a`, points: toFace(s.px(-GLANCE)), color: s.color, mirror: false });
    out.push({ name: `${s.name}-b`, points: toFace(s.px(2 * (MIDLINE_COL - IRIS_CX) - GLANCE)), color: s.color, mirror: false });
  }
  out.push({ name: 'brow', points: browPolygon(), color: hexLinear(BROW_NAVY), mirror: true });
  // Mouth: a thin smile, the middle 2.4 mm under the corners, the corners curling up a little.
  const { center, width } = FACE_SHEET.mouth;
  const half = width / 2;
  const mouthLine = spline(
    [
      [-half, 0.0016],
      [-half * 0.8, 0.0011],
      [-half * 0.4, -0.0006],
      [0, -0.0012],
      [half * 0.4, -0.0006],
      [half * 0.8, 0.0011],
      [half, 0.0016],
    ].map(([x, y]) => [center[0] + (x as number), center[1] + (y as number)] as P2),
  );
  out.push({ name: 'mouth', points: band(mouthLine, (t) => 0.00045 + 0.0005 * Math.sin(Math.PI * t)), color: hexLinear('#956d54'), mirror: false });
  return out;
}

const mirrorX = (points: readonly P2[]): P2[] => points.map(([x, y]) => [-x, y] as P2);

function sheetLayers(layers: readonly NamedLayer[]): DecalLayer[] {
  const out: DecalLayer[] = [];
  // Mirrored partners drawn at the same depth, so the two sides stack identically.
  for (const l of layers) {
    out.push({ region: l.points as P2[], color: l.color });
    if (l.mirror) out.push({ region: mirrorX(l.points), color: l.color });
  }
  return out;
}

/** The face decal sheet over the skin colour (sRGB, `FACE_RECT`). */
export function faceDecalSheet(options: { readonly scale?: number; readonly mips?: boolean } = {}): DecalTextureOptions {
  const k = options.scale ?? 1;
  return {
    width: Math.round(FACE_SHEET_SIZE[0] * k),
    height: Math.round(FACE_SHEET_SIZE[1] * k),
    background: paletteRgba('skin'),
    layers: sheetLayers(faceLayers()),
    rect: FACE_RECT,
    supersample: 4,
    ...(options.mips === undefined ? {} : { mips: options.mips }),
  };
}

// ---- apron emblem -----------------------------------------------------------------------

/** The emblem sheet's rectangle (model x, y): the whole apron front (x +-0.0999, y 0.246..0.423). */
export const APRON_RECT: Rect = [-0.1, 0.24, 0.1, 0.44];
export const APRON_SHEET_SIZE = [512, 512] as const;

/**
 * The whale emblem (reference.json front part `apron-emblem`), traced in sheet pixels: round
 * head on the left with the eye as a hole, the spout fin on top, the tail raised at the right,
 * a flipper under the belly and the small fin at the lower right.
 */
export function emblemOutline(): { outer: P2[]; holes: P2[][] } {
  const outer: P2[] = [
    [236, 430],
    [241, 430],
    [241, 435],
    [244.6, 435],
    [245.2, 438.4],
    [247, 439.2],
    [248.2, 441],
    [249.2, 443],
    [250.4, 444],
    [252.6, 443.4],
    [253.2, 441],
    [253.6, 439],
    [255.4, 438.8],
    [256.6, 440],
    [256.9, 443],
    [257.4, 444.4],
    [256.8, 446],
    [256, 447.6],
    [254.8, 449],
    [252.2, 449.6],
    [252, 457],
    [253.2, 457.6],
    [254, 459.6],
    [248, 460],
    [241, 460],
    [240.6, 462.6],
    [238.6, 462.6],
    [237, 460],
    [230, 459.6],
    [227, 457.6],
    [226, 455.6],
    [224.6, 453.6],
    [224, 450.6],
    [223, 448],
    [223, 444],
    [224, 441],
    [225, 439.6],
    [227, 437.6],
    [228, 436],
    [230, 435],
    [235.6, 435],
    [235.6, 433],
  ];
  const holes = [ellipse(231.7, 450.4, 3.6, 4, 24), ellipse(238.7, 449.9, 0.8, 0.8, 12)];
  const m = (ring: readonly P2[]) => ring.map(([c, r]) => bodyPx(c, r));
  return { outer: m(outer), holes: holes.map(m) };
}

/** The emblem sheet: the navy whale over the apron's white (sRGB, `APRON_RECT`). */
export function emblemSheet(options: { readonly scale?: number; readonly mips?: boolean } = {}): DecalTextureOptions {
  const k = options.scale ?? 1;
  const { outer, holes } = emblemOutline();
  return {
    width: Math.round(APRON_SHEET_SIZE[0] * k),
    height: Math.round(APRON_SHEET_SIZE[1] * k),
    background: paletteRgba('white-cloth'),
    layers: [{ region: [{ outer, holes }], color: paletteRgba('navy-cloth') }],
    rect: APRON_RECT,
    supersample: 4,
    ...(options.mips === undefined ? {} : { mips: options.mips }),
  };
}

// ---- model side ---------------------------------------------------------------------------

type TextureValue = NonNullable<StandardMaterialOptions['baseColorTexture']>;

/** A sheet's material: white base colour times the sheet, mapped from `rect` on uv1 (meters). */
export function decalMaterial(key: string, rect: Rect, sheet: () => Result<TextureAsset, ModelingError>, roughness = 0.5): (texture: TextureSink) => StandardMaterialOptions {
  const [x0, y0, x1, y1] = rect;
  const [w, h] = [x1 - x0, y1 - y0];
  return (texture) => {
    const image = sheet();
    if (!image.ok) throw image.error;
    return {
      baseColor: [1, 1, 1, 1],
      metallic: 0,
      roughness,
      baseColorTexture: { texture: texture(key, image.value), coordinates: { set: 1, transform: { scale: [1 / w, 1 / h], offset: [-x0 / w, -y0 / h] } } } as unknown as TextureValue,
    };
  };
}

/** uv1 on every face: the front (z) projection in meters, the domain every decal rect is in. */
export function projectDecalUv(m: Model): void {
  m.uv.project({ mode: 'planar', axis: 'z', scale: 1, channel: 'uv1' });
}

/**
 * Faces of the face slot: the face plane plus the head skin around it (the cheek band the outer
 * lash flick reaches, the forehead under the fringe with the brows), facing the front projection
 * within 65 degrees (the face plane within 72: its outer cheek turns to the jaw without folding,
 * so its uv1 stays one fold-free chart), and the cheek band at blush height (y 0.645-0.70) within
 * 84 (the blush ovals reach where the cheek rolls to the jaw; 78 left them uncovered). The chin and
 * jaw underside curl back: a steeper quad's triangles fold or overlap in uv1 (70 degrees), a
 * stricter limit leaves the outer eye and blush uncovered (62).
 */
/** The cheek band starts this far forward: behind it the tapered jaw turns sideways and its triangles project over the cheek's. */
const CHEEK_FRONT = 0.02;

export function faceSlotFaces(): FaceSelector {
  const around = sel
    .createdBy('head-skin')
    .and(sel.material('skin'))
    .and(sel.inBox([FACE_RECT[0], 0.635, 0], [FACE_RECT[2], FACE_RECT[3], 1], { by: 'centroid' }));
  // Only faces wholly inside the sheet rect (the decal texture's domain): the CC head's hairline row reaches past it.
  const inRect = sel.inBox([FACE_RECT[0], FACE_RECT[1], 0], [FACE_RECT[2], FACE_RECT[3], 1], { by: 'all' });
  const cheek = sel.inBox([FACE_RECT[0], 0.645, CHEEK_FRONT], [FACE_RECT[2], 0.7, 1], { by: 'centroid' }).and(sel.facing('+z', 84));
  return sel.tag('face-plane').and(sel.facing('+z', 72).or(cheek)).or(around.and(sel.facing('+z', 65).or(cheek))).and(inRect);
}

export interface DecalApplied {
  readonly slot: string;
  readonly faces: number;
  readonly material: (texture: TextureSink) => StandardMaterialOptions;
}

function boundsInside(m: Model, faces: FaceSelector, rect: Rect, what: string): void {
  const b = m.bounds(faces);
  if (!b.ok) throw b.error;
  const { min, max } = b.value;
  if ((min[0] as number) < rect[0] || (min[1] as number) < rect[1] || (max[0] as number) > rect[2] || (max[1] as number) > rect[3]) {
    throw new Error(`${what} faces [${min.slice(0, 2).join(', ')}]..[${max.slice(0, 2).join(', ')}] leave the sheet rect [${rect.join(', ')}]`);
  }
}

/** Face plane (and forehead) into slot `face`, uv1 on every face; the slot's material is skin times the face sheet. */
export function applyFaceDecal(m: Model, options: { readonly mips?: boolean } = {}): DecalApplied {
  const faces = faceSlotFaces();
  boundsInside(m, faces, FACE_RECT, 'face');
  const n = m.count(faces);
  m.assign(faces, 'face');
  projectDecalUv(m);
  return { slot: 'face', faces: n, material: decalMaterial('maid-whale-face', FACE_RECT, () => decalTexture(faceDecalSheet(options))) };
}

/** The apron's front faces (the white apron; `apron-panel` is the navy skirt panel behind it). */
export function apronFrontFaces(): FaceSelector {
  return sel.createdBy('apron').and(sel.material('white')).and(sel.facing('+z', 68));
}

/** Apron front into slot `apron-front`, uv1 on every face; the slot's material is the emblem sheet. */
export function applyEmblem(m: Model, options: { readonly mips?: boolean } = {}): DecalApplied {
  const faces = apronFrontFaces();
  boundsInside(m, faces, APRON_RECT, 'apron front');
  const n = m.count(faces);
  m.assign(faces, 'apron-front');
  projectDecalUv(m);
  return { slot: 'apron-front', faces: n, material: decalMaterial('maid-whale-apron-emblem', APRON_RECT, () => decalTexture(emblemSheet(options))) };
}
