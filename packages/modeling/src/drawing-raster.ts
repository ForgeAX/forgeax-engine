/**
 * Bitmap rendering of a drawing sheet. The layout of record is `drawingSvg`: this module
 * paints the SVG it writes, so the two backends cannot disagree about where anything sits.
 * Each character is drawn from its font outline when a font covers it (CJK included), else from a
 * raster stroke glyph. A character neither covers is an error that names its code point.
 */
import { encodePng } from '@forgeax/engine-image/png';
import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from './arrays';
import type { ResolvedDrawing } from './drawing';
import { drawingSvg, type SheetOptions } from './drawing-export';
import { STROKE_ADVANCE, strokeGlyph } from './drawing-raster-glyphs';
import { type ModelingError, modelingError } from './errors';
import type { TrueTypeFont } from './font';
import {
  attributes,
  type Canvas,
  fillDisk,
  fillRings,
  invalidRaster,
  newCanvas,
  type Primitive,
  parseColor,
  parseDash,
  parsePoints,
  type Rgba,
  type Ring,
  type Style,
  strokePolyline,
  strokeRing,
  unescapeXml,
} from './raster2d';

export interface RasterOptions extends SheetOptions {
  /** Output pixels per sheet millimeter. Exclusive with `width`. */
  readonly pixelsPerMm?: number;
  /** Output width in pixels; the height follows the sheet aspect. Exclusive with `pixelsPerMm`. */
  readonly width?: number;
  /** Background color: `#rrggbb`, `white` or `black`. Default white. */
  readonly background?: string;
  /** Enlarge one view: the output shows only that view's cell, scaled to fill `width`. */
  readonly view?: string;
  /** Supersampling factor per axis, an integer from 1 to 4 (default 2). Output is box-averaged. */
  readonly supersample?: number;
  /** Font for text outlines, from `parseTrueTypeFont`. Without it, ASCII stroke text is drawn. */
  readonly font?: TrueTypeFont;
  /** Smallest text height in output pixels (em size). Smaller text is reported, never rescaled. Default 9. */
  readonly minTextPx?: number;
}

/** A text item drawn below `minTextPx`; the raster keeps its size so the sheet stays faithful. */
export interface SmallText {
  readonly text: string;
  /** Em size in output pixels at the output scale. */
  readonly px: number;
}

export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bit per channel, rows top to bottom, opaque. */
  readonly rgba: Uint8Array;
  readonly report: { readonly smallText: readonly SmallText[] };
}

/** Default smallest legible text height, in output pixels. */
export const DEFAULT_MIN_TEXT_PX = 9;

/** Supersampled pixel budget of one raster (width * height * supersample^2). */
export const RASTER_PIXEL_LIMIT = 25_000_000;
const DEFAULT_WIDTH = 2400;

/** A rectangle of sheet millimeters (y down). */
interface Frame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Parsed {
  readonly prims: Primitive[];
  readonly frame: Frame;
  /** The sheet cell frame of each `data-view` group, keyed by view id. */
  readonly cells: ReadonlyMap<string, Frame>;
}

const BASE_STYLE: Style = {
  strokeWidth: 1,
  fontSize: 3,
  anchor: 'start',
  bold: false,
  dash: undefined,
  stroke: undefined,
  fill: 'black',
};

function inherit(parent: Style, a: Record<string, string>): Style {
  const stroke =
    a.stroke === undefined ? parent.stroke : a.stroke === 'none' ? undefined : a.stroke;
  const fill = a.fill === undefined ? parent.fill : a.fill === 'none' ? undefined : a.fill;
  const strokeWidth =
    a['stroke-width'] === undefined ? parent.strokeWidth : Number(a['stroke-width']);
  const dash = a['stroke-dasharray'] === undefined ? parent.dash : parseDash(a['stroke-dasharray']);
  const fontSize = a['font-size'] === undefined ? parent.fontSize : Number(a['font-size']);
  const anchor =
    a['text-anchor'] === undefined
      ? parent.anchor
      : a['text-anchor'] === 'middle'
        ? 'middle'
        : a['text-anchor'] === 'end'
          ? 'end'
          : 'start';
  const bold = a['font-weight'] === 'bold' ? true : parent.bold;
  return { stroke, fill, strokeWidth, dash, fontSize, anchor, bold };
}

/**
 * The SVG dialect `drawingSvg` writes, closed: each element lists the attributes it may carry.
 * Anything else is a structured error naming the element and attribute, never a silent skip.
 */
const DIALECT: Readonly<Record<string, readonly string[]>> = {
  svg: ['xmlns', 'width', 'height', 'viewBox', 'font-family', 'font-size'],
  rect: ['width', 'height', 'x', 'y', 'fill', 'stroke-dasharray'],
  g: [
    'data-view',
    'data-grid-lines',
    'data-id',
    'data-layer',
    'data-role',
    'data-sheet',
    'id',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'fill',
    'data-detail-mark',
  ],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke-width', 'data-border', 'data-bar-m', 'data-grid'],
  polyline: ['points', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'data-id'],
  polygon: ['points', 'fill', 'data-id'],
  circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'data-id'],
  text: [
    'x',
    'y',
    'fill',
    'stroke',
    'font-size',
    'font-weight',
    'text-anchor',
    'data-grid-label',
    'data-zone',
  ],
};

/** A closed element set (`dialect` of the SVG writer); unknown elements are an error. */
export function dialectError(element: string, attribute: string | undefined): ModelingError {
  return invalidRaster('the sheet SVG uses only the elements and attributes drawingSvg writes', {
    element,
    ...(attribute === undefined ? {} : { attribute }),
  });
}

/** Parse the sheet SVG back into primitives. Strict: unsupported SVG is an error. */
function parseSvg(svg: string): Result<Parsed, ModelingError> {
  const root = /<svg[^>]*>/.exec(svg);
  if (root === null) return err(invalidRaster('the sheet SVG has a root element', {}));
  const rootAttrs = attributes(root[0]);
  const vb = (rootAttrs.viewBox ?? '').trim().split(/\s+/).map(Number);
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v))) {
    return err(
      invalidRaster('the sheet SVG has a numeric viewBox', { viewBox: rootAttrs.viewBox }),
    );
  }
  const frame: Frame = { x: 0, y: 0, w: vb[2] as number, h: vb[3] as number };
  const prims: Primitive[] = [];
  // Per-view bounds of the coordinates drawn inside its `data-view` group: the cell itself.
  const bounds = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  const stack: { style: Style; view: string | undefined }[] = [];
  let style: Style = BASE_STYLE;
  let view: string | undefined;
  let text: { x: number; y: number; style: Style; chunks: string[] } | undefined;
  const tagRe = /<(\/?)([a-zA-Z]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  for (const m of svg.matchAll(tagRe)) {
    if (m[5] !== undefined) {
      if (text !== undefined) text.chunks.push(unescapeXml(m[5]));
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2] as string;
    const selfClose = m[4] === '/';
    if (closing) {
      if (name === 'svg') continue;
      if (name === 'text' && text !== undefined) {
        prims.push({
          kind: 'text',
          x: text.x,
          y: text.y,
          text: text.chunks.join(''),
          style: text.style,
        });
        text = undefined;
      } else if (name === 'g') {
        const top = stack.pop();
        style = top?.style ?? BASE_STYLE;
        view = top?.view;
      }
      continue;
    }
    // The root is validated above and carries no paint; its closing tag is ignored.
    if (name === 'svg') continue;
    const allowed = DIALECT[name];
    if (allowed === undefined) return err(dialectError(name, undefined));
    const a = attributes(m[3] ?? '');
    for (const key of Object.keys(a)) {
      if (!allowed.includes(key)) return err(dialectError(name, key));
    }
    if (name === 'g') {
      if (!selfClose) stack.push({ style, view });
      style = inherit(style, a);
      if (a['data-view'] !== undefined) view = a['data-view'];
      continue;
    }
    const own = inherit(style, a);
    if (view !== undefined) {
      const pts: (readonly [number, number])[] = [];
      if (name === 'line') pts.push([Number(a.x1), Number(a.y1)], [Number(a.x2), Number(a.y2)]);
      else if (name === 'polyline' || name === 'polygon') pushAll(pts, parsePoints(a.points ?? ''));
      else if (name === 'rect' && !(a.width ?? '').endsWith('%')) {
        pts.push(
          [Number(a.x), Number(a.y)],
          [Number(a.x) + Number(a.width), Number(a.y) + Number(a.height)],
        );
      } else if (name === 'circle')
        pts.push(
          [Number(a.cx) - Number(a.r), Number(a.cy) - Number(a.r)],
          [Number(a.cx) + Number(a.r), Number(a.cy) + Number(a.r)],
        );
      else if (name === 'text') pts.push([Number(a.x), Number(a.y)]);
      if (pts.length > 0) {
        const b = bounds.get(view) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        for (const [x, y] of pts) {
          b.x0 = Math.min(b.x0, x);
          b.y0 = Math.min(b.y0, y);
          b.x1 = Math.max(b.x1, x);
          b.y1 = Math.max(b.y1, y);
        }
        bounds.set(view, b);
      }
    }
    if (name === 'line') {
      prims.push({
        kind: 'polyline',
        points: [
          [Number(a.x1), Number(a.y1)],
          [Number(a.x2), Number(a.y2)],
        ],
        style: own,
      });
    } else if (name === 'polyline' || name === 'polygon') {
      prims.push({ kind: name, points: parsePoints(a.points ?? ''), style: own });
    } else if (name === 'rect') {
      // The full-sheet background is the one percent-sized rect; the canvas already holds it.
      if ((a.width ?? '').endsWith('%')) continue;
      const rect = { x: Number(a.x), y: Number(a.y), w: Number(a.width), h: Number(a.height) };
      prims.push({ kind: 'rect', ...rect, style: own });
    } else if (name === 'circle') {
      prims.push({
        kind: 'circle',
        cx: Number(a.cx),
        cy: Number(a.cy),
        r: Number(a.r),
        style: own,
      });
    } else if (name === 'text') {
      if (selfClose) continue;
      text = { x: Number(a.x), y: Number(a.y), style: own, chunks: [] };
    }
  }
  const cells = new Map<string, Frame>();
  for (const [id, b] of bounds) cells.set(id, { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
  return ok({ prims, frame, cells });
}

/** Text geometry in sheet millimeters (y down): filled outlines and stroke centerlines. */
interface TextGeometry {
  readonly rings: Ring[];
  readonly lines: Ring[];
}

/** Cap height of the stroke glyphs as a fraction of the SVG font size; the stroke weight is 0.12 of it. */
const CAP_RATIO = 0.72;
const STROKE_WEIGHT = 0.12;

/**
 * Lay out one text primitive glyph by glyph. Each character takes the first source that draws
 * it: its font outline, then the raster stroke glyph. A character neither draws is an error
 * naming its code point; nothing is skipped.
 */
function textGeometry(
  p: Extract<Primitive, { kind: 'text' }>,
  font: TrueTypeFont | undefined,
): Result<TextGeometry, ModelingError> {
  const size = p.style.fontSize;
  const cap = size * CAP_RATIO;
  const unit = cap / 6;
  const tolerance = size * 1e-3;
  type Placed = { readonly rings: Ring[]; readonly lines: Ring[]; readonly advance: number };
  const placed: Placed[] = [];
  for (const ch of p.text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (font !== undefined) {
      const gid = font.glyphId(cp);
      if (!gid.ok) return gid;
      if (gid.value !== 0) {
        const info = font.glyphInfo(gid.value);
        if (!info.ok) return info;
        const scale = size / font.unitsPerEm;
        const rings = font.glyphRings(gid.value, tolerance / scale);
        if (!rings.ok) return rings;
        placed.push({
          rings: rings.value.map((ring) =>
            ring.map(([x, y]): [number, number] => [x * scale, y * scale]),
          ),
          lines: [],
          advance: info.value.advance * scale,
        });
        continue;
      }
    }
    const glyph = strokeGlyph(ch);
    if (glyph === null) {
      return err(
        modelingError(
          'model-invalid-argument',
          'every character of a drawing text has a font outline or a raster stroke glyph',
          { codePoint: cp, character: ch, text: p.text },
        ),
      );
    }
    placed.push({
      rings: [],
      lines: glyph.map((line) => line.map(([x, y]): [number, number] => [x * unit, y * unit])),
      advance: STROKE_ADVANCE * unit,
    });
  }
  const pen = placed.reduce((sum, g) => sum + g.advance, 0);
  const shift = p.style.anchor === 'middle' ? -pen / 2 : 0;
  const rings: Ring[] = [];
  const lines: Ring[] = [];
  let x0 = shift;
  for (const g of placed) {
    const dx = p.x + x0;
    for (const ring of g.rings)
      rings.push(ring.map(([x, y]): [number, number] => [dx + x, p.y - y]));
    for (const line of g.lines)
      lines.push(line.map(([x, y]): [number, number] => [dx + x, p.y - y]));
    x0 += g.advance;
  }
  return ok({ rings, lines });
}

function scaledDash(
  dash: readonly number[] | undefined,
  scale: number,
): readonly number[] | undefined {
  return dash?.map((v) => v * scale);
}

/** Paint parsed primitives into a canvas, mapping sheet millimeters through `frame` and `scale`. */
function paint(
  canvas: Canvas,
  prims: readonly Primitive[],
  frame: Frame,
  scale: number,
  font: TrueTypeFont | undefined,
): Result<void, ModelingError> {
  const px = (x: number) => (x - frame.x) * scale;
  const py = (y: number) => (y - frame.y) * scale;
  const mapRing = (ring: Ring): Ring => ring.map(([x, y]): [number, number] => [px(x), py(y)]);
  const colorOf = (c: string | undefined): Rgba | undefined =>
    c === undefined ? undefined : parseColor(c);
  for (const p of prims) {
    if (p.kind === 'text') {
      const color = colorOf(p.style.fill);
      if (color === undefined) continue;
      const geometry = textGeometry(p, font);
      if (!geometry.ok) return geometry;
      if (geometry.value.rings.length > 0)
        fillRings(canvas, geometry.value.rings.map(mapRing), color);
      // Stroke-font weight: STROKE_WEIGHT of the cap height, with round caps.
      const width = STROKE_WEIGHT * p.style.fontSize * CAP_RATIO * scale;
      for (const line of geometry.value.lines) {
        strokePolyline(canvas, mapRing(line), width, color, undefined, false);
      }
      continue;
    }
    if (p.kind === 'circle') {
      const fill = colorOf(p.style.fill);
      if (fill !== undefined) fillDisk(canvas, px(p.cx), py(p.cy), p.r * scale, fill);
      const stroke = colorOf(p.style.stroke);
      if (stroke !== undefined && p.style.strokeWidth > 0) {
        strokeRing(canvas, px(p.cx), py(p.cy), p.r * scale, p.style.strokeWidth * scale, stroke);
      }
      continue;
    }
    if (p.kind === 'rect') {
      const fillColor = colorOf(p.style.fill);
      if (fillColor !== undefined) {
        const corners: Ring = [
          [p.x, p.y],
          [p.x + p.w, p.y],
          [p.x + p.w, p.y + p.h],
          [p.x, p.y + p.h],
        ];
        fillRings(canvas, [mapRing(corners)], fillColor);
      }
      const strokeColor = colorOf(p.style.stroke);
      if (strokeColor !== undefined) {
        const corners: Ring = [
          [p.x, p.y],
          [p.x + p.w, p.y],
          [p.x + p.w, p.y + p.h],
          [p.x, p.y + p.h],
        ];
        strokePolyline(
          canvas,
          mapRing(corners),
          p.style.strokeWidth * scale,
          strokeColor,
          scaledDash(p.style.dash, scale),
          true,
        );
      }
      continue;
    }
    if (p.kind === 'polygon') {
      const fillColor = colorOf(p.style.fill);
      if (fillColor !== undefined) fillRings(canvas, [mapRing(p.points)], fillColor);
    }
    const strokeColor = colorOf(p.style.stroke);
    if (strokeColor !== undefined) {
      strokePolyline(
        canvas,
        mapRing(p.points),
        p.style.strokeWidth * scale,
        strokeColor,
        scaledDash(p.style.dash, scale),
        p.kind === 'polygon',
      );
    }
  }
  return ok(undefined);
}

/** Box-average the supersampled canvas down to the output size. */
function downsample(canvas: Canvas, width: number, height: number, factor: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * canvas.width + (x * factor + sx)) * 4;
          r += canvas.rgba[i] as number;
          g += canvas.rgba[i + 1] as number;
          b += canvas.rgba[i + 2] as number;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / area);
      out[o + 1] = Math.round(g / area);
      out[o + 2] = Math.round(b / area);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Render a resolved drawing to an RGBA image with the layout of `drawingSvg`: the SVG is the
 * layout of record, and this paints it. Options are the SVG options plus output size,
 * background, one enlarged view and supersampling.
 */
export function drawingRaster(
  d: ResolvedDrawing,
  options: RasterOptions = {},
): Result<RasterImage, ModelingError> {
  if (options.pixelsPerMm !== undefined && options.width !== undefined) {
    return err(invalidRaster('give pixelsPerMm or width, not both', {}));
  }
  const supersample = options.supersample ?? 2;
  if (!Number.isInteger(supersample) || supersample < 1 || supersample > 4) {
    return err(invalidRaster('supersample is an integer from 1 to 4', { supersample }));
  }
  const background = parseColor(options.background ?? 'white');
  if (background === undefined) {
    return err(
      invalidRaster('background is #rrggbb, white or black', { background: options.background }),
    );
  }
  const minTextPx = options.minTextPx ?? DEFAULT_MIN_TEXT_PX;
  if (!Number.isFinite(minTextPx) || minTextPx < 0) {
    return err(invalidRaster('minTextPx is a finite size of at least 0', { minTextPx }));
  }

  const svg = drawingSvg(d, options);
  if (!svg.ok) return svg;
  const parsed = parseSvg(svg.value);
  if (!parsed.ok) return parsed;

  let frame = parsed.value.frame;
  if (options.view !== undefined) {
    const cell = parsed.value.cells.get(options.view);
    if (cell === undefined) {
      return err(invalidRaster('view names a view placed on the sheet', { view: options.view }));
    }
    frame = cell;
  }

  const perMm =
    options.pixelsPerMm ??
    (options.width !== undefined ? options.width / frame.w : DEFAULT_WIDTH / parsed.value.frame.w);
  if (!Number.isFinite(perMm) || perMm <= 0) {
    return err(invalidRaster('the output scale is a positive finite size', { pixelsPerMm: perMm }));
  }
  const width = Math.max(1, Math.round(frame.w * perMm));
  const height = Math.max(1, Math.round(frame.h * perMm));
  const needed = width * height * supersample * supersample;
  if (needed > RASTER_PIXEL_LIMIT) {
    return err(
      modelingError(
        'model-work-budget',
        `the raster stays within ${RASTER_PIXEL_LIMIT} supersampled pixels`,
        {
          limit: RASTER_PIXEL_LIMIT,
          needed,
          allowed: RASTER_PIXEL_LIMIT,
          width,
          height,
          supersample,
        },
      ),
    );
  }

  const smallText: SmallText[] = [];
  for (const p of parsed.value.prims) {
    if (p.kind !== 'text') continue;
    const inside =
      p.x >= frame.x && p.x <= frame.x + frame.w && p.y >= frame.y && p.y <= frame.y + frame.h;
    const px = p.style.fontSize * perMm;
    if (inside && px < minTextPx) smallText.push({ text: p.text, px });
  }
  const canvas = newCanvas(width * supersample, height * supersample, background);
  const painted = paint(canvas, parsed.value.prims, frame, perMm * supersample, options.font);
  if (!painted.ok) return painted;
  return ok({
    width,
    height,
    rgba: downsample(canvas, width, height, supersample),
    report: { smallText },
  });
}

/** The raster as a deterministic PNG file (`drawingRaster` encoded). */
export function drawingPng(
  d: ResolvedDrawing,
  options: RasterOptions = {},
): Result<Uint8Array, ModelingError> {
  const image = drawingRaster(d, options);
  if (!image.ok) return image;
  return ok(encodePng(image.value.width, image.value.height, image.value.rgba));
}

/** @internal Parser entry for the dialect acceptance test. */
export const parseSvgForTest = parseSvg;

/** @internal Glyph layout entry for the coverage tests. */
export const textGeometryForTest = textGeometry;
