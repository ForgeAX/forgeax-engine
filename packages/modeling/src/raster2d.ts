/**
 * Anti-aliased 2D rasterizer for the sheet SVG dialect. A sheet is drawn once as SVG (the
 * layout of record); this module reads that restricted dialect back and paints it into an
 * RGBA buffer. Strokes take coverage from the distance to the segment (real widths, round
 * caps), fills take even-odd coverage from sub-scanlines, and `max` coverage combines
 * overlapping primitives so overlaps do not darken.
 */
import { hypot2 } from './dmath';
import { type ModelingError, modelingError } from './errors';

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Alpha in [0, 1]. */
  readonly a: number;
}

/** A pixel-space polygon ring; fills are even-odd across all rings of one element. */
export type Ring = readonly (readonly [number, number])[];

/** Attributes of one SVG element after inheritance from its enclosing groups. */
export interface Style {
  readonly stroke: string | undefined;
  readonly strokeWidth: number;
  readonly dash: readonly number[] | undefined;
  readonly fill: string | undefined;
  readonly fontSize: number;
  readonly anchor: 'start' | 'middle' | 'end';
  readonly bold: boolean;
}

export type Primitive =
  | { readonly kind: 'polyline'; readonly points: Ring; readonly style: Style }
  | { readonly kind: 'polygon'; readonly points: Ring; readonly style: Style }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly style: Style;
    }
  | {
      readonly kind: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly style: Style;
    }
  | {
      readonly kind: 'text';
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly style: Style;
    };

export interface Canvas {
  readonly width: number;
  readonly height: number;
  /** Premultiplied-free RGBA, 8 bit per channel, rows top to bottom. */
  readonly rgba: Uint8ClampedArray;
}

export function invalidRaster(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

export function parseColor(text: string): Rgba | undefined {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(text);
  if (hex?.[1] !== undefined) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  if (text === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (text === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  return undefined;
}

/** Mutable coverage buffer; each paint call takes the per-pixel max of its own coverage. */
export function newCanvas(width: number, height: number, background: Rgba): Canvas {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = background.r;
    rgba[i * 4 + 1] = background.g;
    rgba[i * 4 + 2] = background.b;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Composite a color with coverage over the pixel (source-over, opaque destination). */
function blend(canvas: Canvas, x: number, y: number, c: Rgba, coverage: number): void {
  const alpha = coverage * c.a;
  if (alpha <= 0) return;
  const i = (y * canvas.width + x) * 4;
  const d = canvas.rgba;
  d[i] = (d[i] as number) * (1 - alpha) + c.r * alpha;
  d[i + 1] = (d[i + 1] as number) * (1 - alpha) + c.g * alpha;
  d[i + 2] = (d[i + 2] as number) * (1 - alpha) + c.b * alpha;
}

/** Distance from p to the segment a-b. */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ey = ay + dy * t - py;
  return hypot2(ex, ey);
}

/** Whether arc length `s` lies in an "on" run; `dash` alternates on/off lengths, cycling. */
function dashAt(s: number, dash: readonly number[]): boolean {
  const period = dash.reduce((a, b) => a + b, 0);
  if (period <= 0) return true;
  let u = s % period;
  for (let k = 0; k < dash.length; k++) {
    const len = dash[k] as number;
    if (u < len) return k % 2 === 0;
    u -= len;
  }
  return true;
}

/**
 * Stroke a polyline with round caps and joins. Coverage per pixel is the distance-field
 * coverage of the nearest segment, so a pixel on the edge of a thin line gets partial alpha.
 * Dashes are placed by arc length along the polyline.
 */
export function strokePolyline(
  canvas: Canvas,
  points: Ring,
  width: number,
  color: Rgba,
  dash: readonly number[] | undefined,
  closed: boolean,
): void {
  const pts =
    closed && points.length > 0 ? [...points, points[0] as readonly [number, number]] : points;
  if (pts.length === 0) return;
  const half = width / 2;
  // Bounding box of the stroke, padded by the half width and one pixel of AA.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const pad = half + 1;
  const bx0 = Math.max(0, Math.floor(x0 - pad));
  const by0 = Math.max(0, Math.floor(y0 - pad));
  const bx1 = Math.min(canvas.width - 1, Math.ceil(x1 + pad));
  const by1 = Math.min(canvas.height - 1, Math.ceil(y1 + pad));
  if (bx1 < bx0 || by1 < by0) return;
  // Arc length at each vertex, for dashes.
  const arc: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1] as readonly [number, number];
    const [bx, by] = pts[i] as readonly [number, number];
    arc.push((arc[i - 1] as number) + hypot2(bx - ax, by - ay));
  }
  for (let py = by0; py <= by1; py++) {
    for (let px = bx0; px <= bx1; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      let best = Infinity;
      let s = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i] as readonly [number, number];
        const [bx, by] = pts[i + 1] as readonly [number, number];
        const d = segmentDistance(cx, cy, ax, ay, bx, by);
        if (d < best) {
          best = d;
          const seg = hypot2(bx - ax, by - ay);
          const t =
            seg === 0
              ? 0
              : Math.max(
                  0,
                  Math.min(1, ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / (seg * seg)),
                );
          s = (arc[i] as number) + t * seg;
        }
      }
      if (best === Infinity) continue;
      if (dash !== undefined && !dashAt(s, dash)) continue;
      const coverage = Math.max(0, Math.min(1, half + 0.5 - best));
      if (coverage > 0) blend(canvas, px, py, color, coverage);
    }
  }
}

/** Fill one or more rings with the even-odd rule at 4 sub-scanlines per pixel row. */
export function fillRings(canvas: Canvas, rings: readonly Ring[], color: Rgba): void {
  const samples = 4;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const ring of rings) {
    for (const [, y] of ring) {
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(y0)) return;
  const py0 = Math.max(0, Math.floor(y0));
  const py1 = Math.min(canvas.height - 1, Math.ceil(y1));
  for (let py = py0; py <= py1; py++) {
    // Coverage accumulates per x over sub-scanlines: an array of hit counts per pixel column.
    const hits = new Float64Array(canvas.width);
    for (let sub = 0; sub < samples; sub++) {
      const sy = py + (sub + 0.5) / samples;
      const xs: number[] = [];
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i] as readonly [number, number];
          const [bx, by] = ring[(i + 1) % ring.length] as readonly [number, number];
          if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
            xs.push(ax + ((sy - ay) * (bx - ax)) / (by - ay));
          }
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = xs[k] as number;
        const xb = xs[k + 1] as number;
        const ia = Math.max(0, Math.floor(xa));
        const ib = Math.min(canvas.width - 1, Math.floor(xb));
        for (let px = ia; px <= ib; px++) {
          const left = Math.max(xa, px);
          const right = Math.min(xb, px + 1);
          if (right > left) hits[px] = (hits[px] as number) + (right - left) / samples;
        }
      }
    }
    for (let px = 0; px < canvas.width; px++) {
      const c = hits[px] as number;
      if (c > 0) blend(canvas, px, py, color, Math.min(1, c));
    }
  }
}

/** Fill a disk with anti-aliased edges. */
export function fillDisk(canvas: Canvas, cx: number, cy: number, r: number, color: Rgba): void {
  const bx0 = Math.max(0, Math.floor(cx - r - 1));
  const by0 = Math.max(0, Math.floor(cy - r - 1));
  const bx1 = Math.min(canvas.width - 1, Math.ceil(cx + r + 1));
  const by1 = Math.min(canvas.height - 1, Math.ceil(cy + r + 1));
  for (let py = by0; py <= by1; py++) {
    for (let px = bx0; px <= bx1; px++) {
      const d = hypot2(px + 0.5 - cx, py + 0.5 - cy);
      const coverage = Math.max(0, Math.min(1, r + 0.5 - d));
      if (coverage > 0) blend(canvas, px, py, color, coverage);
    }
  }
}

/** Stroke a circle outline of `width` with anti-aliased edges; exact at any radius. */
export function strokeRing(
  canvas: Canvas,
  cx: number,
  cy: number,
  r: number,
  width: number,
  color: Rgba,
): void {
  const half = width / 2;
  const reach = r + half + 1;
  const bx0 = Math.max(0, Math.floor(cx - reach));
  const by0 = Math.max(0, Math.floor(cy - reach));
  const bx1 = Math.min(canvas.width - 1, Math.ceil(cx + reach));
  const by1 = Math.min(canvas.height - 1, Math.ceil(cy + reach));
  for (let py = by0; py <= by1; py++) {
    for (let px = bx0; px <= bx1; px++) {
      const d = Math.abs(hypot2(px + 0.5 - cx, py + 0.5 - cy) - r);
      const coverage = Math.max(0, Math.min(1, half + 0.5 - d));
      if (coverage > 0) blend(canvas, px, py, color, coverage);
    }
  }
}

/** Parse the attribute list of one SVG start tag into a record. */
export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:]*)="([^"]*)"/g)) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** Parse a `points` list "x,y x,y ..." into a ring. */
export function parsePoints(text: string): Ring {
  const out: [number, number][] = [];
  for (const pair of text.trim().split(/\s+/)) {
    if (pair === '') continue;
    const [x, y] = pair.split(',');
    out.push([Number(x), Number(y)]);
  }
  return out;
}

/** Decode the five entities the sheet writer produces. */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Dash lengths in millimeters, e.g. "2 1" -> [2, 1]; a missing attribute is solid. */
export function parseDash(text: string | undefined): readonly number[] | undefined {
  if (text === undefined) return undefined;
  const values = text
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return values.every((v) => Number.isFinite(v) && v >= 0) ? values : undefined;
}
