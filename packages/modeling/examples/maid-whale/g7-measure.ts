import { decodeSnapshot, type ExportOptions, exportMesh, type Model } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { type ColorClass, classify, hsv } from './calibrate/segment.mjs';
import { APRON_RECT, emblemOutline, FACE_RECT, faceLayers } from './decals.ts';
import { deltaE00Lab, linearToLab, type PaletteName, paletteEntry, type Rgb, srgbToLinear } from './materials.ts';
import { REF } from './reference.ts';

/**
 * Case C-200 stage G7 acceptance measure (criterion 6):
 *   1. per-part mean colour (L*a*b*) of the matched render against the sheet, CIEDE2000 <= 5;
 *   2. no gradient inside a face: one slot per face and no per-corner colour change in a face;
 *   3. decals do not cross seams: the `face` and `apron-front` uv1 charts have no split
 *      vertex, fold or overlap, and every decal layer's footprint lies on its slot's faces.
 * Pure functions over exported meshes and RGBA images; renders come from the Dawn driver
 * (g7-evidence.mjs documents the run).
 */

type P2 = readonly [number, number];
type Rect = readonly [number, number, number, number];

/** Exported mesh plus its render-triangle -> source-face map (`Model.toMesh`). */
export interface Exported {
  readonly mesh: MeshAsset;
  readonly triangleFace: Int32Array;
}

/** Export with face provenance (an FXEM round trip: history-independent, so the same mesh as `toMesh`). */
export function exportWithFaces(m: Model, options: ExportOptions = {}): Exported {
  const edit = decodeSnapshot(m.snapshot());
  if (!edit.ok) throw edit.error;
  const out = exportMesh(edit.value.compact().mesh, options);
  if (!out.ok) throw out.error;
  return { mesh: out.value.mesh, triangleFace: out.value.triangleFace };
}

interface Tri {
  readonly slot: string;
  readonly t: number;
  readonly v: readonly [number, number, number];
}

function triangles(mesh: MeshAsset): Tri[] {
  const out: Tri[] = [];
  const idx = mesh.indices;
  for (const s of mesh.submeshes) {
    if (s.topology !== 'triangle-list') continue;
    const slot = mesh.materialSlots[s.materialSlot]?.slotName ?? 'Default';
    for (let i = s.indexOffset; i + 2 < s.indexOffset + s.indexCount; i += 3) {
      const at = (k: number) => (idx === undefined ? k : (idx[k] as number));
      out.push({ slot, t: i / 3, v: [at(i), at(i + 1), at(i + 2)] });
    }
  }
  return out;
}

const attr = (mesh: MeshAsset, name: string): Float32Array | undefined => {
  const a = (mesh.attributes as unknown as Record<string, unknown>)[name];
  return a instanceof Float32Array ? a : undefined;
};

// ---- 2. one colour per face -----------------------------------------------------------------

export interface FaceColourReport {
  readonly faces: number;
  readonly slots: Readonly<Record<string, number>>;
  /** Source faces whose triangles sit in more than one slot. */
  readonly mixedSlotFaces: readonly number[];
  /** Source faces whose corners carry different vertex colours (none without a colour attribute). */
  readonly colourVaryingFaces: readonly number[];
  readonly vertexColour: boolean;
  readonly pass: boolean;
}

/** Every source face renders in exactly one slot and with one vertex colour (no gradient in a face). */
export function faceColourCheck({ mesh, triangleFace }: Exported, tolerance = 1e-6): FaceColourReport {
  const color = attr(mesh, 'color');
  const slotOf = new Map<number, string>();
  const colourOf = new Map<number, number[]>();
  const mixed = new Set<number>();
  const varying = new Set<number>();
  for (const tri of triangles(mesh)) {
    const f = triangleFace[tri.t] as number;
    const prev = slotOf.get(f);
    if (prev === undefined) slotOf.set(f, tri.slot);
    else if (prev !== tri.slot) mixed.add(f);
    if (color === undefined) continue;
    for (const v of tri.v) {
      const c = Array.from(color.subarray(v * 4, v * 4 + 4));
      const first = colourOf.get(f);
      if (first === undefined) colourOf.set(f, c);
      else if (c.some((x, k) => Math.abs(x - (first[k] as number)) > tolerance)) varying.add(f);
    }
  }
  const slots: Record<string, number> = {};
  for (const s of slotOf.values()) slots[s] = (slots[s] ?? 0) + 1;
  return {
    faces: slotOf.size,
    slots,
    mixedSlotFaces: [...mixed],
    colourVaryingFaces: [...varying],
    vertexColour: color !== undefined,
    pass: mixed.size === 0 && varying.size === 0,
  };
}

// ---- 3. decal charts ------------------------------------------------------------------------

/** A decal layer footprint in uv1 meters: rings with even-odd fill (outer plus holes). */
export interface Footprint {
  readonly name: string;
  readonly rings: readonly (readonly P2[])[];
}

/** Footprints of every drawn decal layer per slot (face layers mirrored like the sheet draws them). */
export function decalFootprints(): Record<'face' | 'apron-front', Footprint[]> {
  const face: Footprint[] = [];
  for (const l of faceLayers()) {
    face.push({ name: l.name, rings: [l.points] });
    if (l.mirror) face.push({ name: `${l.name}-mirror`, rings: [l.points.map(([x, y]) => [-x, y] as P2)] });
  }
  const { outer, holes } = emblemOutline();
  return { face, 'apron-front': [{ name: 'emblem', rings: [outer, ...holes] }] };
}

/** Sheet rect of each decal slot (uv1 meters). */
export const DECAL_RECTS: Readonly<Record<'face' | 'apron-front', Rect>> = { face: FACE_RECT, 'apron-front': APRON_RECT };

export interface LayerCoverage {
  readonly name: string;
  readonly samples: number;
  readonly uncovered: number;
  /** One uncovered sample point (uv1 meters), if any. */
  readonly at?: P2;
}

export interface DecalChartReport {
  readonly slot: string;
  readonly triangles: number;
  /** Edge-connected triangle groups of the slot (a split chart reports more than one). */
  readonly components: number;
  /** Positions inside the slot carrying two different uv1 values (a seam). */
  readonly seamVertices: number;
  /** Slot triangles whose uv1 winding is reversed or degenerate (a fold of the planar chart). */
  readonly folds: number;
  /** Grid cells of the sheet rect covered by two or more slot triangles (a doubled print). */
  readonly overlapCells: number;
  readonly step: number;
  readonly layers: readonly LayerCoverage[];
  readonly pass: boolean;
}

function inRings(rings: readonly (readonly P2[])[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as P2;
      const [xj, yj] = ring[j] as P2;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * The uv1 chart of `slot`: seams (same position, different uv1), folds (reversed winding in
 * the chart), overlaps (cells covered twice) and the coverage of each footprint by the slot's
 * triangles, on a `step`-meter grid over the slot's sheet rect.
 */
export function decalChartCheck(ex: Exported, slot: string, rect: Rect, footprints: readonly Footprint[], step = 2.5e-4): DecalChartReport {
  const { mesh } = ex;
  const pos = attr(mesh, 'position') as Float32Array;
  const uv = attr(mesh, 'uv1');
  if (uv === undefined) throw new Error('decalChartCheck: the mesh has no uv1');
  const tris = triangles(mesh).filter((t) => t.slot === slot);
  const key = (v: number) => `${Math.round((pos[v * 3] as number) * 1e6)},${Math.round((pos[v * 3 + 1] as number) * 1e6)},${Math.round((pos[v * 3 + 2] as number) * 1e6)}`;
  // Seams and connectivity by position.
  const uvAt = new Map<string, P2[]>();
  const parent = tris.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] as number] as number;
    return i;
  };
  const owner = new Map<string, number>();
  tris.forEach((tri, i) => {
    for (const v of tri.v) {
      const k = key(v);
      const u: P2 = [uv[v * 2] as number, uv[v * 2 + 1] as number];
      const list = uvAt.get(k) ?? [];
      if (!list.some((w) => Math.abs(w[0] - u[0]) < 1e-6 && Math.abs(w[1] - u[1]) < 1e-6)) list.push(u);
      uvAt.set(k, list);
    }
    for (let e = 0; e < 3; e++) {
      const a = key(tri.v[e] as number);
      const b = key(tri.v[(e + 1) % 3] as number);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      const o = owner.get(edge);
      if (o === undefined) owner.set(edge, i);
      else parent[find(o)] = find(i);
    }
  });
  const seamVertices = [...uvAt.values()].filter((l) => l.length > 1).length;
  const components = new Set(tris.map((_, i) => find(i))).size;
  // Folds and coverage on the grid.
  const [x0, y0, x1, y1] = rect;
  const nx = Math.ceil((x1 - x0) / step);
  const ny = Math.ceil((y1 - y0) / step);
  const cover = new Uint8Array(nx * ny);
  let folds = 0;
  for (const tri of tris) {
    const p = tri.v.map((v) => [uv[v * 2] as number, uv[v * 2 + 1] as number] as P2) as [P2, P2, P2];
    const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
    if (!(area > 0)) {
      folds++;
      if (area === 0) continue;
    }
    const s = Math.sign(area);
    const ix0 = Math.max(0, Math.floor((Math.min(p[0][0], p[1][0], p[2][0]) - x0) / step));
    const ix1 = Math.min(nx - 1, Math.floor((Math.max(p[0][0], p[1][0], p[2][0]) - x0) / step));
    const iy0 = Math.max(0, Math.floor((Math.min(p[0][1], p[1][1], p[2][1]) - y0) / step));
    const iy1 = Math.min(ny - 1, Math.floor((Math.max(p[0][1], p[1][1], p[2][1]) - y0) / step));
    for (let iy = iy0; iy <= iy1; iy++) {
      const y = y0 + (iy + 0.5) * step;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = x0 + (ix + 0.5) * step;
        let inside = true;
        for (let e = 0; e < 3 && inside; e++) {
          const a = p[e] as P2;
          const b = p[(e + 1) % 3] as P2;
          // Half-open edge rule so a shared edge counts once.
          const c = s * ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]));
          if (c < 0 || (c === 0 && !(b[1] > a[1] || (b[1] === a[1] && b[0] < a[0])))) inside = false;
        }
        if (inside) cover[iy * nx + ix] = Math.min(255, (cover[iy * nx + ix] as number) + 1);
      }
    }
  }
  let overlapCells = 0;
  for (const c of cover) if (c > 1) overlapCells++;
  const layers = footprints.map((fp): LayerCoverage => {
    let samples = 0;
    let uncovered = 0;
    let at: P2 | undefined;
    const all = fp.rings.flat();
    const span = (k: 0 | 1, lo: number, n: number) => [Math.max(0, Math.floor((Math.min(...all.map((p) => p[k])) - lo) / step)), Math.min(n - 1, Math.floor((Math.max(...all.map((p) => p[k])) - lo) / step))];
    const [jx0, jx1] = span(0, x0, nx) as [number, number];
    const [jy0, jy1] = span(1, y0, ny) as [number, number];
    for (let iy = jy0; iy <= jy1; iy++) {
      for (let ix = jx0; ix <= jx1; ix++) {
        const x = x0 + (ix + 0.5) * step;
        const y = y0 + (iy + 0.5) * step;
        if (!inRings(fp.rings, x, y)) continue;
        samples++;
        if (cover[iy * nx + ix] === 0) {
          uncovered++;
          at ??= [Number(x.toFixed(5)), Number(y.toFixed(5))];
        }
      }
    }
    return { name: fp.name, samples, uncovered, ...(at === undefined ? {} : { at }) };
  });
  const pass = seamVertices === 0 && folds === 0 && overlapCells === 0 && layers.every((l) => l.samples > 0 && l.uncovered === 0);
  return { slot, triangles: tris.length, components, seamVertices, folds, overlapCells, step, layers, pass };
}

// ---- 1. matched colour --------------------------------------------------------------------

export type SheetView = 'front' | 'right' | 'back';
export const SHEET_PPM = REF.scale.pxPerMeter;
const YAW: Readonly<Record<SheetView, number>> = { front: 0, right: 90, back: 180 };

/** Camera axes of a sheet view: `toward` points from the subject to the camera; right is level. */
export function viewAxes(view: SheetView, pitchDeg: number): { toward: number[]; right: number[]; up: number[] } {
  const y = (YAW[view] * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const toward = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const up = [toward[1]! * right[2]! - toward[2]! * right[1]!, toward[2]! * right[0]! - toward[0]! * right[2]!, toward[0]! * right[1]! - toward[1]! * right[0]!];
  return { toward, right, up };
}

/**
 * A render frame registered to the sheet: render pixel (x, y) shows sheet pixel
 * (c0 + (x + 0.5) / k, r0 + (y + 0.5) / k) of `view`, with sheet u = (c - axisX) / ppm and
 * v = (groundY - r) / ppm. The model's v is its height along the camera's up axis above its own
 * lowest point (the sheet's ground is its lowest sole pixel).
 */
export interface MatchedFrame {
  readonly name: string;
  readonly view: SheetView;
  readonly pitchDeg: number;
  readonly c0: number;
  readonly r0: number;
  /** Render pixels per sheet pixel. */
  readonly k: number;
  readonly width: number;
  readonly height: number;
}

const sheetImage = (view: SheetView) => REF.views[view].image as { axisX: number; groundY: number };

/** Frame whose top-left is at view meters (u0, v1). */
export function frameAt(name: string, view: SheetView, pitchDeg: number, u0: number, v1: number, k: number, width: number, height: number): MatchedFrame {
  const im = sheetImage(view);
  return { name, view, pitchDeg, c0: im.axisX + u0 * SHEET_PPM, r0: im.groundY - v1 * SHEET_PPM, k, width, height };
}

/** Sheet pixel (fractional) under render pixel centre (x, y). */
export const sheetPixel = (f: MatchedFrame, x: number, y: number): P2 => [f.c0 + (x + 0.5) / f.k, f.r0 + (y + 0.5) / f.k];
/** View meters under render pixel centre (x, y). */
export function viewMeters(f: MatchedFrame, x: number, y: number): P2 {
  const im = sheetImage(f.view);
  const [c, r] = sheetPixel(f, x, y);
  return [(c - im.axisX) / SHEET_PPM, (im.groundY - r) / SHEET_PPM];
}

/** The model's lowest point along a frame's up axis (its ground). */
export function groundOf(positions: Float32Array, f: Pick<MatchedFrame, 'view' | 'pitchDeg'>): number {
  const { up } = viewAxes(f.view, f.pitchDeg);
  let g = Infinity;
  for (let i = 0; i < positions.length; i += 3) g = Math.min(g, positions[i]! * up[0]! + positions[i + 1]! * up[1]! + positions[i + 2]! * up[2]!);
  return g;
}

/** Orthographic camera of a frame: eye, target and bounds (view meters about the eye). */
export function frameCamera(f: MatchedFrame, ground: number, distance = 5) {
  const { toward, up } = viewAxes(f.view, f.pitchDeg);
  const eye = [0, 1, 2].map((k) => ground * up[k]! + distance * toward[k]!) as [number, number, number];
  const target = [0, 1, 2].map((k) => eye[k]! - toward[k]!) as [number, number, number];
  const [left, top] = viewMeters(f, -0.5, -0.5);
  const ppm = SHEET_PPM * f.k;
  return { eye, target, ortho: { left, right: left + f.width / ppm, top, bottom: top - f.height / ppm } };
}

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** Distinct sRGB8 identity colours (3 levels per channel, greys excluded). */
export const ID_COLOURS: readonly Rgb[] = (() => {
  const levels = [30, 140, 250];
  const out: Rgb[] = [];
  for (const r of levels) for (const g of levels) for (const b of levels) if (!(r === g && g === b)) out.push([r, g, b]);
  return out;
})();

/** Slot -> identity colour (sRGB8) in slot order; throws past the 24 available. */
export function idPalette(slots: readonly string[]): Map<string, Rgb> {
  if (slots.length > ID_COLOURS.length) throw new Error(`idPalette: ${slots.length} slots, ${ID_COLOURS.length} colours`);
  return new Map(slots.map((s, i) => [s, ID_COLOURS[i] as Rgb]));
}

/**
 * Flat-coloured triangles of an exported mesh, one identity colour per slot (linear RGBA per
 * vertex, for an unlit vertex-colour material such as `coloredMesh`).
 */
export function idTriangles(mesh: MeshAsset, palette: ReadonlyMap<string, Rgb>): { positions: Float32Array; colors: Float32Array } {
  const pos = attr(mesh, 'position') as Float32Array;
  const tris = triangles(mesh);
  const positions = new Float32Array(tris.length * 9);
  const colors = new Float32Array(tris.length * 12);
  tris.forEach((tri, i) => {
    const c = palette.get(tri.slot) ?? [0, 0, 0];
    tri.v.forEach((v, j) => {
      positions.set(pos.subarray(v * 3, v * 3 + 3), i * 9 + j * 3);
      colors.set([srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), 1], i * 12 + j * 4);
    });
  });
  return { positions, colors };
}

/**
 * Identity map of an ID render: the index of the nearest identity colour (within `tolerance`
 * per channel) whose 8 neighbours share it, else -1 (edges and background).
 */
export function decodeIds(image: RgbaImage, palette: readonly Rgb[], tolerance = 24): Int16Array {
  const { width: w, height: h, rgba } = image;
  const raw = new Int16Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < palette.length; k++) {
      const c = palette[k] as Rgb;
      if (Math.abs(rgba[i * 4]! - c[0]) <= tolerance && Math.abs(rgba[i * 4 + 1]! - c[1]) <= tolerance && Math.abs(rgba[i * 4 + 2]! - c[2]) <= tolerance) {
        raw[i] = k;
        break;
      }
    }
  }
  const out = new Int16Array(w * h).fill(-1);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const id = raw[y * w + x] as number;
      if (id < 0) continue;
      let same = true;
      for (let dy = -1; dy <= 1 && same; dy++) for (let dx = -1; dx <= 1 && same; dx++) if (raw[(y + dy) * w + x + dx] !== id) same = false;
      if (same) out[y * w + x] = id;
    }
  }
  return out;
}

/** One measured part: sheet windows (sheet pixels) and colour classes, the model's identity slots. */
export interface ColourPart {
  readonly name: string;
  readonly palette: PaletteName;
  readonly view: SheetView;
  readonly windows: readonly Rect[];
  readonly classes: readonly ColorClass[];
  readonly ids: readonly string[];
  /** Decal slots: keep only model pixels of the same colour classes (drop the drawn ink). */
  readonly filterModel?: boolean;
}

const HAIR: ColorClass[] = ['hair', 'light'];

/**
 * The palette parts. Windows follow calibrate (palette, windows.mjs); hair zones take every
 * hair pixel (lit and shaded facets), not only the palette's light-class median.
 */
export const COLOUR_PARTS: readonly ColourPart[] = [
  { name: 'hair root', palette: 'hair-root', view: 'front', windows: [[170, 90, 300, 150]], classes: HAIR, ids: ['hair-0'] },
  { name: 'hair tip', palette: 'hair-tip', view: 'back', windows: [[920, 360, 1200, 440]], classes: HAIR, ids: ['hair-5'] },
  { name: 'navy cloth', palette: 'navy-cloth', view: 'front', windows: [[92, 440, 372, 520]], classes: ['navy', 'hair'], ids: ['navy'] },
  { name: 'white cloth (apron)', palette: 'white-cloth', view: 'front', windows: [[150, 380, 280, 480]], classes: ['white'], ids: ['apron-front', 'white'], filterModel: true },
  { name: 'skin face', palette: 'skin', view: 'front', windows: [[170, 230, 300, 255]], classes: ['skin'], ids: ['face'], filterModel: true },
  { name: 'skin hands', palette: 'hand-skin', view: 'front', windows: [[90, 418, 136, 462], [322, 428, 372, 468]], classes: ['skin'], ids: ['hand-skin'] },
  { name: 'skin legs', palette: 'leg-skin', view: 'front', windows: [[150, 522, 226, 575], [232, 522, 312, 575]], classes: ['skin'], ids: ['leg-skin'] },
  { name: 'ribbon', palette: 'ribbon', view: 'front', windows: [[308, 125, 362, 192], [108, 125, 142, 175]], classes: ['light'], ids: ['ribbon'] },
  { name: 'gem', palette: 'gem-part', view: 'front', windows: [[208, 278, 238, 304]], classes: ['gem'], ids: ['gem'] },
  { name: 'shoe', palette: 'shoe-part', view: 'front', windows: [[130, 576, 228, 642], [232, 576, 330, 642]], classes: ['navy', 'dark'], ids: ['shoe'] },
  { name: 'tail', palette: 'tail-part', view: 'right', windows: [[700, 470, 860, 600]], classes: ['navy', 'hair'], ids: ['tail'] },
  { name: 'tail underside', palette: 'tail-underside', view: 'right', windows: [[640, 540, 800, 600]], classes: ['white', 'other'], ids: ['tail-underside'] },
];

// ---- measure lightings -----------------------------------------------------------------------

/** One key light of a measure lighting (DirectionalLight: travel direction, linear colour, intensity). */
export interface KeyLight {
  readonly direction: Rgb;
  readonly color: Rgb;
  readonly intensity: number;
}

/**
 * A lighting of the measure renders; the Dawn driver spawns exactly this (one Skylight, the
 * keys, Camera tonemap none, exposure 1). `ambientIrradiance` is the Skylight's additive
 * diffuse irradiance (Standard: + albedo * irradiance / pi, no specular, no Fresnel);
 * `environment` adds the studioEnvironment() IBL at Skylight intensity 1 (else intensity 0).
 */
export interface MeasureLighting {
  readonly name: 'albedo' | 'sheet-soft' | 'studio' | 'sheet-soft-world';
  readonly ambientIrradiance: Rgb;
  readonly keys: readonly KeyLight[];
  readonly environment: boolean;
}

/**
 * Criterion 6 line 1: the authored albedo. Ambient irradiance pi and nothing else, so every
 * Standard pixel shows exactly its base colour (decal slots: the texel under the pixel).
 */
export const ALBEDO_LIGHTING: MeasureLighting = { name: 'albedo', ambientIrradiance: [Math.PI, Math.PI, Math.PI], keys: [], environment: false };

/** The case harness default (info only): studio IBL plus a warm key and a cool fill. */
export const STUDIO_LIGHTING: MeasureLighting = {
  name: 'studio',
  ambientIrradiance: [0, 0, 0],
  keys: [
    { direction: [-0.45, -0.75, -0.5], color: [1, 0.98, 0.95], intensity: 2.6 },
    { direction: [0.6, -0.3, 0.55], color: [0.75, 0.82, 1], intensity: 0.9 },
  ],
  environment: true,
};

/**
 * Criterion 6 line 2 lighting `sheet-soft`: high ambient plus
 * one soft white key from the upper front left of the figure (+x is the figure's left, the
 * sheet's right), no image-based light and no shadows. The shape is fixed here: on a surface
 * facing the key, ambient carries 3/4 and the key 1/4 of the light (both in albedo units,
 * irradiance pi * share). One scalar `SHEET_SOFT_SCALE` was calibrated once, on the white apron
 * only (the 'white cloth (apron)' row's lit mean L* equal to the sheet's 93.40, secant on the
 * front matched render, .isolation-g7m driver G7M_CALIBRATE=1), then frozen; no part is tuned.
 *
 * Per-panel rule (all panels and parts): `keyDirection`
 * is fixed in each panel's camera frame (front-camera coordinates turned by the panel yaw), since
 * every back/right part takes its palette from its own panel and so already carries that panel's
 * shading. Sound only while that holds: a part sampled on the front but measured on another panel
 * needs this re-checked. The world-fixed key stays as info (`sheet-soft-world`).
 */
export const SHEET_SOFT_SHAPE = { ambient: 0.75, key: 0.25, keyDirection: [-0.35, -0.55, -0.76] as Rgb } as const;
/** Calibrated 2026-10-25: secant samples (scale, apron L*) 0.8 83.39, 1 91.05, 1.0613 93.19, 1.0672 93.40. */
export const SHEET_SOFT_SCALE = 1.0672;

/**
 * `sheet-soft` for one sheet panel. The sheet lights every panel alike (same-material median L*
 * within 0-5 of the front's), so the key is fixed in the panel's camera frame: `keyDirection`
 * is front-camera coordinates (x right, z toward the camera) turned by the panel's yaw. The
 * front panel's key equals the world one.
 */
export function sheetSoft(scale: number = SHEET_SOFT_SCALE, view: SheetView = 'front'): MeasureLighting {
  const a = Math.PI * SHEET_SOFT_SHAPE.ambient * scale;
  const { right, up, toward } = viewAxes(view, 0);
  const [dx, dy, dz] = SHEET_SOFT_SHAPE.keyDirection;
  const direction = [0, 1, 2].map((k) => dx * right[k]! + dy * up[k]! + dz * toward[k]!) as unknown as Rgb;
  return {
    name: 'sheet-soft',
    ambientIrradiance: [a, a, a],
    keys: [{ direction, color: [1, 1, 1], intensity: Math.PI * SHEET_SOFT_SHAPE.key * scale }],
    environment: false,
  };
}

/** Line 2 before the per-panel rule (key fixed in the world for every panel), info only. */
export const SHEET_SOFT_WORLD_LIGHTING: MeasureLighting = { ...sheetSoft(), name: 'sheet-soft-world' };

/** The lightings of one measure run: line 1, line 2, and as info the harness default and world-fixed line 2. */
export const MEASURE_LIGHTINGS: readonly MeasureLighting[] = [ALBEDO_LIGHTING, sheetSoft(), STUDIO_LIGHTING, SHEET_SOFT_WORLD_LIGHTING];

/** A measure lighting as rendered for one sheet panel (only sheet-soft depends on the panel). */
export const panelLighting = (lighting: MeasureLighting, view: SheetView): MeasureLighting =>
  lighting.name === 'sheet-soft' ? sheetSoft(SHEET_SOFT_SCALE, view) : lighting;

export interface MeanColour {
  readonly lab: Rgb;
  /** sRGB8 of the mean linear colour (display only). */
  readonly srgb: Rgb;
  readonly n: number;
}

const toSrgb8 = (l: number) => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));

function mean(pixels: Iterable<Rgb>): MeanColour | undefined {
  let n = 0;
  const lab = [0, 0, 0];
  const lin = [0, 0, 0];
  for (const p of pixels) {
    const l: Rgb = [srgbToLinear(p[0]), srgbToLinear(p[1]), srgbToLinear(p[2])];
    const c = linearToLab(l);
    for (let k = 0; k < 3; k++) {
      lab[k]! += c[k]!;
      lin[k]! += l[k]!;
    }
    n++;
  }
  if (n === 0) return undefined;
  return { lab: lab.map((v) => v / n) as unknown as Rgb, srgb: lin.map((v) => toSrgb8(v / n)) as unknown as Rgb, n };
}

const px = (im: RgbaImage, i: number): Rgb => [im.rgba[i * 4]!, im.rgba[i * 4 + 1]!, im.rgba[i * 4 + 2]!];

/** Mean colour of a part on the sheet: window pixels of its classes whose 4 neighbours share a class of it. */
export function sheetPartColour(sheet: RgbaImage, part: ColourPart): MeanColour | undefined {
  const ok = (x: number, y: number) => part.classes.includes(classify(...px(sheet, y * sheet.width + x)));
  function* pixels() {
    for (const [c0, r0, c1, r1] of part.windows) {
      for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) if (ok(x, y) && ok(x - 1, y) && ok(x + 1, y) && ok(x, y - 1) && ok(x, y + 1)) yield px(sheet, y * sheet.width + x);
    }
  }
  return mean(pixels());
}

/**
 * Mean colour of a part on a matched render: pixels inside its windows (grown by `margin` sheet
 * pixels for registration slack) whose identity is one of the part's slots; decal slots keep
 * only pixels of the part's colour classes. `kept` is that share of the identity pixels.
 */
export function modelPartColour(render: RgbaImage, ids: Int16Array, idIndex: ReadonlyMap<string, number>, f: MatchedFrame, part: ColourPart, margin = 16): (MeanColour & { kept: number }) | undefined {
  const want = new Set(part.ids.map((s) => idIndex.get(s)).filter((i): i is number => i !== undefined));
  let total = 0;
  const kept: Rgb[] = [];
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const i = y * f.width + x;
      if (!want.has(ids[i] as number)) continue;
      const [c, r] = sheetPixel(f, x, y);
      if (!part.windows.some(([c0, r0, c1, r1]) => c >= c0 - margin && c <= c1 + margin && r >= r0 - margin && r <= r1 + margin)) continue;
      total++;
      const p = px(render, i);
      if (part.filterModel === true && !part.classes.includes(classify(...p))) continue;
      kept.push(p);
    }
  }
  const m = mean(kept);
  return m === undefined ? undefined : { ...m, kept: kept.length / total };
}

export interface ColourRow {
  readonly part: string;
  readonly palette: PaletteName;
  readonly view: SheetView;
  readonly sheet?: MeanColour;
  readonly model?: MeanColour & { kept: number };
  /** CIEDE2000 model mean vs sheet mean (the criterion, <= 5). */
  readonly dE?: number;
  /** CIEDE2000 palette entry vs sheet mean (palette pick vs part mean). */
  readonly dEPalette?: number;
  /** CIEDE2000 with the model's lightness set to the sheet's (hue and chroma only: the lighting share). */
  readonly dEChroma?: number;
  readonly pass: boolean;
}

export function colourRow(part: ColourPart, sheet: MeanColour | undefined, model: (MeanColour & { kept: number }) | undefined, limit = 5): ColourRow {
  const palette = linearToLab(paletteEntry(part.palette).linear);
  const dE = sheet && model ? Number(deltaE00Lab(model.lab, sheet.lab).toFixed(2)) : undefined;
  const dEPalette = sheet ? Number(deltaE00Lab(palette, sheet.lab).toFixed(2)) : undefined;
  const dEChroma = sheet && model ? Number(deltaE00Lab([sheet.lab[0], model.lab[1], model.lab[2]], sheet.lab).toFixed(2)) : undefined;
  return {
    part: part.name,
    palette: part.palette,
    view: part.view,
    ...(sheet ? { sheet } : {}),
    ...(model ? { model } : {}),
    ...(dE === undefined ? {} : { dE }),
    ...(dEPalette === undefined ? {} : { dEPalette }),
    ...(dEChroma === undefined ? {} : { dEChroma }),
    pass: dE !== undefined && dE <= limit,
  };
}

// ---- face close-up features ------------------------------------------------------------------

/** Pixel classification helpers shared by sheet and render (no image data retained). */
/** Skin under any shading (looser than the sheet's palette class, same on both images). */
const isSkin = (p: Rgb) => {
  const [h, s, v] = hsv(...p);
  return h >= 5 && h <= 55 && s > 0.08 && s < 0.65 && v > 0.4;
};
/** Lash ink: dark and not the blue of shaded hair. */
const isLash = (p: Rgb) => {
  const [h, s, v] = hsv(...p);
  return v < 0.3 && !(h >= 190 && h <= 260 && s > 0.3);
};
const isBlue = (p: Rgb) => {
  const [h, s, v] = hsv(...p);
  return h >= 195 && h <= 245 && s > 0.4 && v > 0.3;
};

export interface FaceFeatures {
  /** Eye centre (blue iris centroid under the lash), lash top, lash u extent, brow, per side. */
  readonly eyes: readonly { side: number; iris?: P2; lashTop?: number; lashU?: P2; brow?: number; browColumns: number }[];
  readonly mouth?: number;
  /** Skin rows/columns: bottom at the midline, top (bang line) beside it, width at eye level. */
  readonly skinBottom?: number;
  readonly skinTop?: number;
  readonly skinWidth?: number;
  /** Side view: the face's front-most skin u at eye level. */
  readonly skinFront?: number;
  /** Skin area (m^2) in the frame between v 0.60 and 0.80: a face hidden by hair shows here. */
  readonly skinArea: number;
}

/**
 * Face landmarks of a matched close-up (view meters), measured identically on the sheet crop
 * and on the render. `sides` lists the eye u-ranges searched ([+1] for the character's left in
 * front, the visible eye's range in side views).
 */
export function faceFeatures(image: RgbaImage, f: MatchedFrame, eyeRanges: readonly (readonly [side: number, u0: number, u1: number])[], v0 = 0.655, v1 = 0.76): FaceFeatures {
  const at = (x: number, y: number) => px(image, y * f.width + x);
  const m = (x: number, y: number) => viewMeters(f, x, y);
  const step = 1 / (SHEET_PPM * f.k);
  const eyes = eyeRanges.map(([side, u0, u1]) => {
    const lash: P2[] = [];
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        const [u, v] = m(x, y);
        if (u >= u0 && u <= u1 && v >= v0 && v <= v1 && isLash(at(x, y))) lash.push([u, v]);
      }
    }
    if (lash.length < 4) return { side, browColumns: 0 } as { side: number; browColumns: number; iris?: P2 };
    const us = lash.map((p) => p[0]).sort((a, b) => a - b);
    const vs = lash.map((p) => p[1]).sort((a, b) => a - b);
    const q = (a: number[], t: number) => a[Math.min(a.length - 1, Math.floor(t * a.length))] as number;
    const lashTop = q(vs, 0.98);
    const lashU: P2 = [q(us, 0.03), q(us, 0.97)];
    let su = 0;
    let sv = 0;
    let n = 0;
    const browV: number[] = [];
    const inner: P2 = [lashU[0] + 0.15 * (lashU[1] - lashU[0]), lashU[1] - 0.15 * (lashU[1] - lashU[0])];
    for (let x = 0; x < f.width; x++) {
      const u = m(x, 0)[0];
      if (u < lashU[0] || u > lashU[1]) continue;
      const central = u >= inner[0] && u <= inner[1];
      for (let y = 0; y < f.height; y++) {
        const v = m(x, y)[1];
        if (v < lashTop - 0.045 || v > lashTop - 0.004) continue;
        if (central && isBlue(at(x, y))) {
          su += u;
          sv += v;
          n++;
        }
      }
      // Brow: scanning up from the lash top, the first dark run after skin (sitting on skin).
      let seenSkin = false;
      let start: number | undefined;
      for (let y = f.height - 1; y >= 0; y--) {
        const v = m(x, y)[1];
        if (v < lashTop + 0.002) continue;
        if (v > lashTop + 0.05) break;
        const p = at(x, y);
        if (isSkin(p)) {
          if (start !== undefined) {
            browV.push((start + v - step) / 2);
            break;
          }
          seenSkin = true;
        } else if (seenSkin && start === undefined && hsv(...p)[2] < 0.5) start = v;
        else if (start !== undefined && v - start > 0.006) break;
      }
    }
    const brow = browV.length < 3 ? undefined : browV.sort((a, b) => a - b)[Math.floor(browV.length / 2)];
    return { side, ...(n > 0 ? { iris: [su / n, sv / n] as P2 } : {}), lashTop, lashU, ...(brow === undefined ? {} : { brow }), browColumns: browV.length };
  });
  // Mouth: darker-than-skin pixels at the midline below the eyes.
  const skinL: number[] = [];
  const mouth: number[] = [];
  let skinBottom: number | undefined;
  let skinTop: number | undefined;
  let lo = Infinity;
  let hi = -Infinity;
  let front: number | undefined;
  const irisV = eyes.find((e) => e.iris)?.iris?.[1];
  let skinPixels = 0;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const [u, v] = m(x, y);
      const p = at(x, y);
      const skin = isSkin(p);
      if (skin && v >= 0.6 && v <= 0.8) skinPixels++;
      if (skin && Math.abs(u) < 0.06 && v > 0.62 && v < 0.7) skinL.push(p[0] + p[1] + p[2]);
      if (skin && Math.abs(u) < 0.01 && v > 0.55) skinBottom = Math.min(skinBottom ?? Infinity, v);
      if (skin && Math.abs(u) > 0.03 && Math.abs(u) < 0.06 && v < 0.8) skinTop = Math.max(skinTop ?? -Infinity, v);
      if (skin && irisV !== undefined && Math.abs(v - irisV) < step) {
        lo = Math.min(lo, u);
        hi = Math.max(hi, u);
      }
    }
  }
  skinL.sort((a, b) => a - b);
  const skinMid = skinL[Math.floor(skinL.length / 2)];
  if (skinMid !== undefined) {
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        const [u, v] = m(x, y);
        if (Math.abs(u) > 0.012 || v < 0.62 || v > 0.67) continue;
        const p = at(x, y);
        const [h, s] = hsv(...p);
        if (p[0] + p[1] + p[2] < skinMid * 0.85 && (h < 50 || h > 330) && s > 0.12) mouth.push(v);
      }
    }
  }
  if (f.view !== 'front' && Number.isFinite(lo)) front = f.view === 'right' ? lo : hi;
  const avg = (a: number[]) => (a.length === 0 ? undefined : a.reduce((s, v) => s + v, 0) / a.length);
  const mo = avg(mouth);
  return {
    eyes,
    ...(mo === undefined ? {} : { mouth: mo }),
    ...(skinBottom === undefined ? {} : { skinBottom }),
    ...(skinTop === undefined ? {} : { skinTop }),
    ...(f.view === 'front' && Number.isFinite(lo) ? { skinWidth: hi - lo } : {}),
    ...(front === undefined ? {} : { skinFront: front }),
    skinArea: skinPixels * step * step,
  };
}

/** Sheet image resampled (nearest) onto a frame's render pixels: the matched sheet crop. */
export function sheetCrop(sheet: RgbaImage, f: MatchedFrame): RgbaImage {
  const rgba = new Uint8Array(f.width * f.height * 4);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const [c, r] = sheetPixel(f, x, y);
      const sx = Math.min(sheet.width - 1, Math.max(0, Math.floor(c)));
      const sy = Math.min(sheet.height - 1, Math.max(0, Math.floor(r)));
      rgba.set(sheet.rgba.subarray((sy * sheet.width + sx) * 4, (sy * sheet.width + sx) * 4 + 4), (y * f.width + x) * 4);
    }
  }
  return { width: f.width, height: f.height, rgba };
}

/** Images side by side (same height) with a 50 % blend of the first two appended. */
export function compareStrip(a: RgbaImage, b: RgbaImage, gap = 6): RgbaImage {
  const w = a.width * 3 + gap * 2;
  const h = a.height;
  const rgba = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < a.width; x++) {
      const s = (y * a.width + x) * 4;
      for (let k = 0; k < 4; k++) {
        const av = a.rgba[s + k] as number;
        const bv = b.rgba[s + k] as number;
        rgba[(y * w + x) * 4 + k] = av;
        rgba[(y * w + x + a.width + gap) * 4 + k] = bv;
        rgba[(y * w + x + 2 * (a.width + gap)) * 4 + k] = k === 3 ? 255 : Math.round((av + bv) / 2);
      }
    }
  }
  return { width: w, height: h, rgba };
}
