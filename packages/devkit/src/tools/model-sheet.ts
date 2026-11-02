/**
 * Drawing-sheet layer of `model.render`: exact orthographic pixel mapping plus a
 * small RGBA rasterizer (lines, dimension arrows, 5x7 text) that annotates a
 * rendered view on the CPU. Underlay strokes (grid) only touch pixels the subject
 * left at the background color; overlay strokes draw on top.
 */

export type Rgba = readonly [number, number, number, number];
type Vec3 = readonly [number, number, number];

/** Orthographic view placement: world point `center` maps to the image center. */
export interface OrthoMapping {
  readonly width: number;
  readonly height: number;
  readonly pixelsPerMeter: number;
  readonly center: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Pixel position of a world point. */
export function worldToPixel(m: OrthoMapping, p: Vec3): [number, number] {
  const d: Vec3 = [p[0] - m.center[0], p[1] - m.center[1], p[2] - m.center[2]];
  return [
    m.width / 2 + dot(d, m.right) * m.pixelsPerMeter,
    m.height / 2 - dot(d, m.up) * m.pixelsPerMeter,
  ];
}

/** Pixel position of absolute view coordinates `(u, v)` (u = p . right, v = p . up). */
export function viewToPixel(m: OrthoMapping, u: number, v: number): [number, number] {
  return [
    m.width / 2 + (u - dot(m.center, m.right)) * m.pixelsPerMeter,
    m.height / 2 - (v - dot(m.center, m.up)) * m.pixelsPerMeter,
  ];
}

/** 1, 2 or 5 times a power of ten, the smallest such step at least `minimum`. */
export function niceStep(minimum: number): number {
  const power = 10 ** Math.floor(Math.log10(minimum));
  for (const k of [1, 2, 5, 10]) if (k * power >= minimum) return k * power;
  return 10 * power;
}

export function formatMeters(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1) return `${value.toFixed(3)} m`;
  if (abs >= 0.01) return `${(value * 1000).toFixed(1)} mm`;
  return `${(value * 1000).toFixed(2)} mm`;
}

// 5x7 glyphs, one 5-bit row per digit group; lowercase draws as uppercase.
const GLYPHS: Readonly<Record<string, string>> = {
  '0': '01110100011001110101110011000101110',
  '1': '00100011000010000100001000010001110',
  '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110',
  '4': '00010001100101010010111110001000010',
  '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110',
  '7': '11111000010001000100010000100001000',
  '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100',
  A: '01110100011000111111100011000110001',
  B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110',
  D: '11100100101000110001100011001011100',
  E: '11111100001000011110100001000011111',
  F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111',
  H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001',
  L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001',
  N: '10001100011100110101100111000110001',
  O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101',
  R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110',
  T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011010101010',
  X: '10001100010101000100010101000110001',
  Y: '10001100011000101010001000010000100',
  Z: '11111000010001000100010001000011111',
  '.': '00000000000000000000000000110001100',
  ',': '00000000000000000000011000010001000',
  '-': '00000000000000011111000000000000000',
  '+': '00000001000010011111001000010000000',
  ':': '00000011000110000000011000110000000',
  '/': '00000000010001000100010001000000000',
  '(': '00010001000100001000010000010000010',
  ')': '01000001000001000010000100010001000',
  '=': '00000000001111100000111110000000000',
  '%': '11000110010001000100010001001100011',
  _: '00000000000000000000000000000011111',
  "'": '01100001000100000000000000000000000',
  '#': '01010010101111101010111110101001010',
  '[': '01110010000100001000010000100001110',
  ']': '01110000100001000010000100001001110',
  ' ': '00000000000000000000000000000000000',
  '?': '01110100010000100010001000000000100',
};

interface LabelBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function overlap(a: LabelBox, b: LabelBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export class SheetCanvas {
  /** Boxes already taken by text; later labels are placed around them. */
  readonly labels: LabelBox[] = [];
  /** Labels that had to move off their preferred spot, or still overlap one. */
  displaced = 0;
  /** Labels that still overlap another after every candidate spot. */
  readonly overlapping: string[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly rgba: Uint8Array,
    /** Pixels the subject left at the background color (underlay strokes only touch these). */
    readonly free?: Uint8Array,
  ) {}

  plot(x: number, y: number, color: Rgba, under = false): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return;
    const p = iy * this.width + ix;
    if (under && this.free !== undefined && this.free[p] === 0) return;
    const a = color[3];
    for (let k = 0; k < 3; k++) {
      const i = p * 4 + k;
      this.rgba[i] = Math.round(
        (this.rgba[i] as number) * (1 - a) + (color[k] as number) * 255 * a,
      );
    }
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: Rgba,
    options: { readonly width?: number; readonly dash?: number; readonly under?: boolean } = {},
  ): void {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(length * 2));
    const width = options.width ?? 1;
    const nx = length === 0 ? 0 : -(y1 - y0) / length;
    const ny = length === 0 ? 0 : (x1 - x0) / length;
    const seen = new Set<number>();
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (options.dash !== undefined && Math.floor((t * length) / options.dash) % 2 === 1) continue;
      for (let w = 0; w < width; w++) {
        const o = w - (width - 1) / 2;
        const x = Math.round(x0 + (x1 - x0) * t + nx * o);
        const y = Math.round(y0 + (y1 - y0) * t + ny * o);
        const key = y * this.width + x;
        if (seen.has(key)) continue;
        seen.add(key);
        this.plot(x, y, color, options.under === true);
      }
    }
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgba): void {
    for (let j = Math.floor(y); j < y + h; j++)
      for (let i = Math.floor(x); i < x + w; i++) this.plot(i, j, color);
  }

  textWidth(text: string, scale: number): number {
    return text.length * 6 * scale - scale;
  }

  /** The backed box `text()` fills for this label (top-left at x, y). */
  labelBox(text: string, x: number, y: number, scale: number): LabelBox {
    return {
      x: x - 2 * scale,
      y: y - 2 * scale,
      w: this.textWidth(text, scale) + 4 * scale,
      h: 11 * scale,
    };
  }

  /**
   * Top-left of a label centered at `center`: the first free spot among positions
   * slid along `along` and stepped along `normal`, else the least-overlapping one.
   * Spots must stay inside the canvas.
   */
  placeLabel(
    text: string,
    center: readonly [number, number],
    along: readonly [number, number],
    normal: readonly [number, number],
    span: number,
    scale: number,
  ): [number, number] {
    const w = this.textWidth(text, scale);
    const h = 7 * scale;
    const step = 12 * scale;
    let best: { x: number; y: number; cost: number; index: number } | undefined;
    let index = 0;
    const tryAt = (cx: number, cy: number): boolean => {
      const x = Math.round(cx - w / 2);
      const y = Math.round(cy - h / 2);
      const box = this.labelBox(text, x, y, scale);
      const outside =
        box.x < 0 || box.y < 0 || box.x + box.w > this.width || box.y + box.h > this.height;
      const cost =
        this.labels.reduce((sum, other) => sum + overlap(box, other), 0) + (outside ? 1e6 : 0);
      if (best === undefined || cost < best.cost) best = { x, y, cost, index };
      index++;
      return cost === 0;
    };
    // Prefer spots along the dimension line and its normal, then widen to rings in
    // screen space around the line center (crowded short spans).
    search: {
      for (const n of [0, 1, -1, 2, -2, 3, -3])
        for (const t of [0, -0.25, 0.25, -0.45, 0.45])
          if (
            tryAt(
              center[0] + along[0] * t * span + normal[0] * n * step,
              center[1] + along[1] * t * span + normal[1] * n * step,
            )
          )
            break search;
      for (let r = 1; r <= 12; r++)
        for (let iy = -r; iy <= r; iy++)
          for (let ix = -r; ix <= r; ix++)
            if (Math.max(Math.abs(ix), Math.abs(iy)) === r)
              if (tryAt(center[0] + ix * (w / 2 + 4 * scale), center[1] + iy * step)) break search;
    }
    const chosen = best as { x: number; y: number; cost: number; index: number };
    if (chosen.index > 0) this.displaced++;
    if (chosen.cost > 0) this.overlapping.push(text);
    return [chosen.x, chosen.y];
  }

  /** Text whose top-left corner is (x, y), on an optional backing box. */
  text(text: string, x: number, y: number, color: Rgba, scale = 1, backing?: Rgba): void {
    this.labels.push(this.labelBox(text, x, y, scale));
    if (backing !== undefined)
      this.fillRect(
        x - 2 * scale,
        y - 2 * scale,
        this.textWidth(text, scale) + 4 * scale,
        11 * scale,
        backing,
      );
    for (const [i, raw] of [...text.toUpperCase()].entries()) {
      const glyph = GLYPHS[raw] ?? (GLYPHS['?'] as string);
      for (let row = 0; row < 7; row++)
        for (let column = 0; column < 5; column++)
          if (glyph[row * 5 + column] === '1')
            for (let sy = 0; sy < scale; sy++)
              for (let sx = 0; sx < scale; sx++)
                this.plot(x + (i * 6 + column) * scale + sx, y + row * scale + sy, color);
    }
  }

  arrowHead(x: number, y: number, dx: number, dy: number, color: Rgba, size: number): void {
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    for (const side of [-1, 1]) {
      this.line(
        x,
        y,
        x - ux * size + -uy * side * size * 0.4,
        y - uy * size + ux * side * size * 0.4,
        color,
      );
    }
  }

  /** Dimension line between two pixels with arrows and a centered label, offset along its normal. */
  dimension(
    a: readonly [number, number],
    b: readonly [number, number],
    label: string,
    color: Rgba,
    offset: number,
    scale: number,
  ): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (l < 2) return;
    const nx = (-dy / l) * offset;
    const ny = (dx / l) * offset;
    const p: [number, number] = [a[0] + nx, a[1] + ny];
    const q: [number, number] = [b[0] + nx, b[1] + ny];
    const extend = Math.sign(offset) * 4;
    const ex = (-dy / l) * extend;
    const ey = (dx / l) * extend;
    this.line(a[0], a[1], p[0] + ex, p[1] + ey, color, { dash: 3 });
    this.line(b[0], b[1], q[0] + ex, q[1] + ey, color, { dash: 3 });
    this.line(p[0], p[1], q[0], q[1], color);
    const head = Math.min(8, l / 3);
    this.arrowHead(p[0], p[1], -dx, -dy, color, head);
    this.arrowHead(q[0], q[1], dx, dy, color, head);
    const [x, y] = this.placeLabel(
      label,
      [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
      [dx / l, dy / l],
      [Math.sign(offset || 1) * (-dy / l), Math.sign(offset || 1) * (dx / l)],
      l,
      scale,
    );
    // A label moved away from its line keeps a dashed leader to the line midpoint.
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const box = this.labelBox(label, x, y, scale);
    const lx = Math.max(box.x, Math.min(mx, box.x + box.w));
    const ly = Math.max(box.y, Math.min(my, box.y + box.h));
    if (Math.hypot(lx - mx, ly - my) > 3 * scale) this.line(mx, my, lx, ly, color, { dash: 2 });
    this.text(label, x, y, color, scale, [0.08, 0.09, 0.11, 0.85]);
  }
}

export const SHEET_COLORS = {
  grid: [0.32, 0.35, 0.4, 1] as Rgba,
  gridMajor: [0.42, 0.46, 0.52, 1] as Rgba,
  dimension: [0.98, 0.86, 0.36, 1] as Rgba,
  reference: [1, 0.55, 0.2, 0.9] as Rgba,
  contour: [0.3, 0.9, 1, 0.95] as Rgba,
  measure: [0.6, 1, 0.55, 1] as Rgba,
  text: [0.92, 0.93, 0.95, 1] as Rgba,
};

/** Pixels that still show the background (|difference| <= 6 summed over RGB). */
export function freeMask(rgba: Uint8Array, background: Uint8Array): Uint8Array {
  const mask = new Uint8Array(rgba.length / 4);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    const d =
      Math.abs((rgba[i] as number) - (background[i] as number)) +
      Math.abs((rgba[i + 1] as number) - (background[i + 1] as number)) +
      Math.abs((rgba[i + 2] as number) - (background[i + 2] as number));
    mask[p] = d > 6 ? 0 : 1;
  }
  return mask;
}

/** Grid lines at `step` meters (every fifth stronger) under the subject. */
export function drawGrid(canvas: SheetCanvas, m: OrthoMapping, step: number): void {
  const cu = dot(m.center, m.right);
  const cv = dot(m.center, m.up);
  const halfU = m.width / 2 / m.pixelsPerMeter;
  const halfV = m.height / 2 / m.pixelsPerMeter;
  for (const axis of ['u', 'v'] as const) {
    const [lo, hi] = axis === 'u' ? [cu - halfU, cu + halfU] : [cv - halfV, cv + halfV];
    for (let k = Math.ceil(lo / step); k <= Math.floor(hi / step); k++) {
      const color = k % 5 === 0 ? SHEET_COLORS.gridMajor : SHEET_COLORS.grid;
      if (axis === 'u') {
        const [x] = viewToPixel(m, k * step, cv);
        canvas.line(x, 0, x, m.height - 1, color, { under: true });
      } else {
        const [, y] = viewToPixel(m, cu, k * step);
        canvas.line(0, y, m.width - 1, y, color, { under: true });
      }
    }
  }
}

/** Scale bar of `step` meters at the lower left. */
export function drawScaleBar(
  canvas: SheetCanvas,
  m: OrthoMapping,
  step: number,
  scale: number,
): void {
  const length = step * m.pixelsPerMeter;
  const x = 12 * scale;
  const y = m.height - 12 * scale;
  canvas.fillRect(
    x - 3 * scale,
    y - 13 * scale,
    length + 6 * scale + canvas.textWidth(formatMeters(step), scale) + 8 * scale,
    17 * scale,
    [0.08, 0.09, 0.11, 0.8],
  );
  canvas.line(x, y, x + length, y, SHEET_COLORS.text, { width: 2 });
  canvas.line(x, y - 4 * scale, x, y + 1, SHEET_COLORS.text, { width: 2 });
  canvas.line(x + length, y - 4 * scale, x + length, y + 1, SHEET_COLORS.text, { width: 2 });
  canvas.text(formatMeters(step), x + length + 6 * scale, y - 8 * scale, SHEET_COLORS.text, scale);
}

/** Polyline in absolute view coordinates. */
export function drawViewPolyline(
  canvas: SheetCanvas,
  m: OrthoMapping,
  points: readonly (readonly [number, number])[],
  closed: boolean,
  color: Rgba,
  options: { readonly width?: number; readonly dash?: number } = {},
): void {
  const n = points.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i] as readonly [number, number];
    const b = points[(i + 1) % n] as readonly [number, number];
    const [x0, y0] = viewToPixel(m, a[0], a[1]);
    const [x1, y1] = viewToPixel(m, b[0], b[1]);
    canvas.line(x0, y0, x1, y1, color, options);
  }
}
