/**
 * Shared image helpers of the visual feedback operators (`model.compare`, `model.microscope`,
 * `model.turntable`): foreground segmentation with an explicit reliability verdict, subject
 * bounding boxes, bbox-aligned resampling onto a common grid and enclosed-hole detection.
 */
import type { ColorImage, PixelMask } from './image-metrics';

export interface Bbox {
  readonly x0: number;
  readonly y0: number;
  /** Exclusive. */
  readonly x1: number;
  /** Exclusive. */
  readonly y1: number;
}

export type MaskSource = 'alpha' | 'color-key';

export interface Foreground {
  readonly mask: PixelMask;
  readonly source: MaskSource;
  /** Foreground pixels over image pixels. */
  readonly coverage: number;
  /** False when the subject is not isolated; every score derived from the mask is then void. */
  readonly reliable: boolean;
  readonly reason?: 'empty' | 'fills-frame' | 'background-not-uniform';
  readonly bbox?: Bbox;
}

const MIN_COVERAGE = 0.002;
const MAX_COVERAGE = 0.9;
const BORDER_UNIFORM = 0.9;

export function bboxOf(mask: PixelMask, width: number, height: number): Bbox | undefined {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return x1 < 0 ? undefined : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** The largest 4-connected component of `mask`; ties keep the first found. */
export function largestComponent(mask: PixelMask, width: number, height: number): PixelMask {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let best: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    const members: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      members.push(i);
      const x = i % width;
      const y = (i - x) / width;
      const next = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ];
      for (const j of next) {
        if (j < 0 || mask[j] === 0 || seen[j] === 1) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (members.length > best.length) best = members;
  }
  const out = new Uint8Array(mask.length);
  for (const i of best) out[i] = 1;
  return out;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/**
 * Segment the subject: alpha when the image carries any transparency, otherwise a key against the
 * median border color (threshold = max(0.06, 3 x the border's own deviation)). The result is the
 * largest component and is flagged unreliable when it is empty, fills the frame or the border is
 * not a uniform background, so callers fail closed instead of scoring a wrong mask.
 */
export function foregroundMask(image: ColorImage, alpha?: Uint8Array): Foreground {
  const { width: w, height: h, rgb } = image;
  const n = w * h;
  let raw: PixelMask = new Uint8Array(n);
  let source: MaskSource = 'color-key';
  let borderOk = true;
  if (alpha?.some((a) => a < 255)) {
    source = 'alpha';
    for (let i = 0; i < n; i++) raw[i] = (alpha[i] as number) >= 128 ? 1 : 0;
  } else {
    const border: number[] = [];
    for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
    const bg = [0, 1, 2].map((c) => median(border.map((i) => rgb[i * 3 + c] as number)));
    const dist = (i: number) =>
      Math.hypot(
        (rgb[i * 3] as number) - (bg[0] as number),
        (rgb[i * 3 + 1] as number) - (bg[1] as number),
        (rgb[i * 3 + 2] as number) - (bg[2] as number),
      );
    const spread = median(border.map((i) => Math.abs(dist(i))));
    const threshold = Math.max(0.06, 3 * spread);
    for (let i = 0; i < n; i++) raw[i] = dist(i) > threshold ? 1 : 0;
    borderOk = border.filter((i) => raw[i] === 0).length / border.length >= BORDER_UNIFORM;
  }
  raw = largestComponent(raw, w, h);
  let count = 0;
  for (let i = 0; i < n; i++) count += raw[i] as number;
  const coverage = count / n;
  const bbox = bboxOf(raw, w, h);
  const reason =
    count === 0 || coverage < MIN_COVERAGE
      ? 'empty'
      : coverage > MAX_COVERAGE
        ? 'fills-frame'
        : borderOk
          ? undefined
          : 'background-not-uniform';
  return {
    mask: raw,
    source,
    coverage,
    reliable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    ...(bbox === undefined ? {} : { bbox }),
  } as Foreground;
}

/**
 * Background pixels the 4-connected fill from the frame border never reaches: through-holes and
 * enclosed gaps of the silhouette. `holes` counts them, `components` their 4-connected regions.
 */
export function enclosedHoles(
  mask: PixelMask,
  width: number,
  height: number,
): { readonly holes: number; readonly components: number } {
  const reached = new Uint8Array(mask.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (mask[i] !== 0 || reached[i] === 1) return;
    reached[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  const flood = () => {
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % width;
      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (i >= width) push(i - width);
      if (i < mask.length - width) push(i + width);
    }
  };
  flood();
  let holes = 0;
  let components = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0 || reached[i] === 1) continue;
    components++;
    reached[i] = 1;
    stack.push(i);
    while (stack.length > 0) {
      const j = stack.pop() as number;
      holes++;
      const x = j % width;
      if (x > 0) push(j - 1);
      if (x < width - 1) push(j + 1);
      if (j >= width) push(j - width);
      if (j < mask.length - width) push(j + width);
    }
  }
  return { holes, components };
}

/** A subject resampled onto a square grid: uniform scale to its bbox, centered, background 0. */
export interface Aligned {
  readonly image: ColorImage;
  readonly mask: PixelMask;
  /** Grid pixels per source pixel. */
  readonly scale: number;
  /** Where the subject bbox lands on the grid. */
  readonly box: Bbox;
}

/** Translate an aligned grid by whole grid pixels; uncovered pixels become background. */
export function shiftAligned(a: Aligned, dx: number, dy: number, size: number): Aligned {
  if (dx === 0 && dy === 0) return a;
  const rgb = new Float32Array(size * size * 3);
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= size) continue;
    for (let x = 0; x < size; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= size) continue;
      const i = y * size + x;
      const j = sy * size + sx;
      mask[i] = a.mask[j] as number;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = a.image.rgb[j * 3 + c] as number;
    }
  }
  return {
    ...a,
    image: { width: size, height: size, rgb },
    mask,
    box: { x0: a.box.x0 + dx, y0: a.box.y0 + dy, x1: a.box.x1 + dx, y1: a.box.y1 + dy },
  };
}

const MARGIN = 0.04;

/** Resample `image` and its foreground onto a `size` x `size` grid aligned on the subject bbox. */
export function alignToGrid(image: ColorImage, mask: PixelMask, bbox: Bbox, size: number): Aligned {
  const bw = bbox.x1 - bbox.x0;
  const bh = bbox.y1 - bbox.y0;
  const scale = (size * (1 - 2 * MARGIN)) / Math.max(bw, bh);
  const ox = (size - bw * scale) / 2;
  const oy = (size - bh * scale) / 2;
  const rgb = new Float32Array(size * size * 3);
  const out = new Uint8Array(size * size);
  const sample = (px: number, py: number, c: number) => {
    const fx = Math.min(image.width - 1, Math.max(0, px - 0.5));
    const fy = Math.min(image.height - 1, Math.max(0, py - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (x: number, y: number) => image.rgb[(y * image.width + x) * 3 + c] as number;
    return (
      (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) +
      (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty
    );
  };
  const taps = [0.25, 0.75];
  for (let ty = 0; ty < size; ty++)
    for (let tx = 0; tx < size; tx++) {
      let inside = 0;
      const sum = [0, 0, 0];
      for (const ay of taps)
        for (const ax of taps) {
          const sx = bbox.x0 + (tx + ax - ox) / scale;
          const sy = bbox.y0 + (ty + ay - oy) / scale;
          const ix = Math.floor(sx);
          const iy = Math.floor(sy);
          if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) continue;
          inside += mask[iy * image.width + ix] as number;
          for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + sample(sx, sy, c);
        }
      const i = ty * size + tx;
      if (inside >= 2) {
        out[i] = 1;
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = (sum[c] as number) / 4;
      }
    }
  return {
    image: { width: size, height: size, rgb },
    mask: out,
    scale,
    box: { x0: ox, y0: oy, x1: ox + bw * scale, y1: oy + bh * scale },
  };
}

/** Sobel gradient magnitude and unsigned orientation (0..pi) of a luma plane; borders are zero. */
export function sobel(
  luma: Float64Array,
  width: number,
  height: number,
): { readonly magnitude: Float64Array; readonly angle: Float64Array } {
  const magnitude = new Float64Array(width * height);
  const angle = new Float64Array(width * height);
  const at = (x: number, y: number) => luma[y * width + x] as number;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const i = y * width + x;
      magnitude[i] = Math.hypot(gx, gy) / 4;
      const a = Math.atan2(gy, gx);
      angle[i] = a < 0 ? a + Math.PI : a >= Math.PI ? a - Math.PI : a;
    }
  return { magnitude, angle };
}

/** Binary Chebyshev dilation by `radius` pixels. */
export function dilate(
  bits: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const rows = new Uint8Array(bits.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let d = -radius; d <= radius && v === 0; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < width && bits[y * width + xx] !== 0) v = 1;
      }
      rows[y * width + x] = v;
    }
  const out = new Uint8Array(bits.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let d = -radius; d <= radius && v === 0; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < height && rows[yy * width + x] !== 0) v = 1;
      }
      out[y * width + x] = v;
    }
  return out;
}
