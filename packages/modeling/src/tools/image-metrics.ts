/**
 * Image metrics for bake verification: structural similarity, CIEDE2000, a
 * sub-pixel-offset shimmer proxy and heatmaps. FLIP lives in `flip.ts`; silhouette IoU of
 * ID / alpha passes is the kernel `maskIoU`. Images are sRGB-encoded RGB in [0, 1], rows
 * top to bottom.
 */
import { parseImage } from '@forgeax/engine-image/parse-image';
import { encodePng } from '@forgeax/engine-image/png';

export interface ColorImage {
  readonly width: number;
  readonly height: number;
  /** Interleaved sRGB-encoded RGB in [0, 1]. */
  readonly rgb: Float32Array;
}

/** A per-pixel selection (1 = in), rows top to bottom. */
export type PixelMask = Uint8Array;

/** RGBA8 pixels (a render readback, a PNG) to a ColorImage; alpha is dropped. */
export function colorImage(width: number, height: number, rgba: Uint8Array): ColorImage {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0))
    throw new RangeError(`colorImage needs positive integer dimensions, got ${width}x${height}`);
  if (rgba.length < width * height * 4)
    throw new RangeError(`colorImage needs ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = (rgba[i * 4 + c] as number) / 255;
  return { width, height, rgb };
}

/** Decode a PNG (Engine image decoder) to a ColorImage and its alpha. */
export function readPng(bytes: Uint8Array): { image: ColorImage; alpha: Uint8Array } {
  const decoded = parseImage(bytes, 'image/png', { maxDimension: 16384 });
  if (!decoded.ok) throw new TypeError(`readPng: ${decoded.error.code}`);
  const { width, height, bytes: rgba } = decoded.value;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = rgba[i * 4 + 3] as number;
  return { image: colorImage(width, height, rgba), alpha };
}

function sameSize(a: { width: number; height: number }, b: { width: number; height: number }) {
  if (a.width !== b.width || a.height !== b.height)
    throw new RangeError(`image sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
}

/** A metric measures real pixels: a whole, finite buffer of a positive size. @internal */
export function checkImage(image: ColorImage, name = 'image'): void {
  const { width, height, rgb } = image;
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0))
    throw new RangeError(`${name} needs positive integer dimensions, got ${width}x${height}`);
  if (rgb.length !== width * height * 3)
    throw new RangeError(`${name} holds ${rgb.length} values, ${width * height * 3} expected`);
  for (let i = 0; i < rgb.length; i++)
    if (!Number.isFinite(rgb[i])) throw new RangeError(`${name} holds a non-finite value at ${i}`);
}

/** A mask selects at least one pixel of an image with `n` pixels, or the mean would be empty. */
function checkMask(mask: PixelMask | undefined, n: number): void {
  if (mask === undefined) return;
  if (mask.length !== n) throw new RangeError(`mask holds ${mask.length} pixels, ${n} expected`);
  if (!mask.some((v) => v !== 0)) throw new RangeError('mask selects no pixel');
}

/** Both images, equally sized and finite, and the mask over them. @internal */
export function checkPair(
  reference: ColorImage,
  test: ColorImage,
  mask: PixelMask | undefined,
): void {
  checkImage(reference, 'reference');
  checkImage(test, 'test');
  sameSize(reference, test);
  checkMask(mask, reference.width * reference.height);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Rec. 709 luma of the sRGB-encoded values (the SSIM and shimmer channel). */
export function luma(image: ColorImage): Float64Array {
  const out = new Float64Array(image.width * image.height);
  for (let i = 0; i < out.length; i++)
    out[i] =
      0.2126 * (image.rgb[i * 3] as number) +
      0.7152 * (image.rgb[i * 3 + 1] as number) +
      0.0722 * (image.rgb[i * 3 + 2] as number);
  return out;
}

/** Separable Gaussian blur with clamp-to-edge borders. */
function gaussianBlur(
  src: Float64Array,
  w: number,
  h: number,
  sigma: number,
  radius: number,
): Float64Array {
  const k = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = (k[i] as number) / sum;
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -radius; i <= radius; i++)
        a +=
          (k[i + radius] as number) * (src[y * w + Math.min(w - 1, Math.max(0, x + i))] as number);
      tmp[y * w + x] = a;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -radius; i <= radius; i++)
        a +=
          (k[i + radius] as number) * (tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] as number);
      out[y * w + x] = a;
    }
  return out;
}

function maskedMean(map: ArrayLike<number>, mask: PixelMask | undefined): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < map.length; i++) {
    if (mask !== undefined && mask[i] === 0) continue;
    sum += map[i] as number;
    n++;
  }
  return sum / n;
}

/**
 * SSIM on luma: Gaussian window sigma 1.5
 * (11 taps), K1 = 0.01, K2 = 0.03, dynamic range 1. Mean over the image or `mask`.
 */
export function ssim(
  reference: ColorImage,
  test: ColorImage,
  mask?: PixelMask,
): { readonly mean: number; readonly map: Float32Array } {
  checkPair(reference, test, mask);
  const { width: w, height: h } = reference;
  const a = luma(reference);
  const b = luma(test);
  const blur = (x: Float64Array) => gaussianBlur(x, w, h, 1.5, 5);
  const product = (p: Float64Array, q: Float64Array) => p.map((v, i) => v * (q[i] as number));
  const ma = blur(a);
  const mb = blur(b);
  const saa = blur(product(a, a));
  const sbb = blur(product(b, b));
  const sab = blur(product(a, b));
  const c1 = 0.01 * 0.01;
  const c2 = 0.03 * 0.03;
  const map = new Float32Array(w * h);
  for (let i = 0; i < map.length; i++) {
    const mx = ma[i] as number;
    const my = mb[i] as number;
    const vx = (saa[i] as number) - mx * mx;
    const vy = (sbb[i] as number) - my * my;
    const cov = (sab[i] as number) - mx * my;
    map[i] = ((2 * mx * my + c1) * (2 * cov + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2));
  }
  return { mean: maskedMean(map, mask), map };
}

export type Lab = readonly [number, number, number];

/** sRGB-encoded RGB in [0, 1] to CIELAB (D65 white, the sRGB primaries). */
export function srgbToLab(r: number, g: number, b: number): Lab {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 color difference (kL = kC = kH = 1). */
export function deltaE2000(p: Lab, q: Lab): number {
  const rad = Math.PI / 180;
  const [l1, a1, b1] = p;
  const [l2, a2, b2] = q;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => {
    if (b === 0 && a === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dl = l2 - l1;
  const dc = c2p - c1p;
  let dh = 0;
  if (c1p * c2p !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh / 2) * rad);
  const lBar = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBar = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hBar += hBar < 360 ? 360 : -360;
    hBar /= 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * rad) +
    0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) -
    0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}

/** Per-pixel CIEDE2000 between two images: mean and p95 over the image or `mask`, and the map. */
export function imageDeltaE(
  reference: ColorImage,
  test: ColorImage,
  mask?: PixelMask,
): { readonly mean: number; readonly p95: number; readonly map: Float32Array } {
  checkPair(reference, test, mask);
  const n = reference.width * reference.height;
  const map = new Float32Array(n);
  const selected: number[] = [];
  const at = (img: ColorImage, i: number) =>
    srgbToLab(img.rgb[i * 3] as number, img.rgb[i * 3 + 1] as number, img.rgb[i * 3 + 2] as number);
  for (let i = 0; i < n; i++) {
    map[i] = deltaE2000(at(reference, i), at(test, i));
    if (mask === undefined || mask[i] !== 0) selected.push(map[i] as number);
  }
  selected.sort((p, q) => p - q);
  return {
    mean: maskedMean(map, mask),
    p95: selected[Math.floor(0.95 * (selected.length - 1))] as number,
    map,
  };
}

/**
 * Temporal shimmer proxy (BK-V6): frames rendered at sub-pixel camera offsets of a still
 * view; the per-pixel standard deviation of luma (0..1) across them, averaged over `mask`.
 * Aliasing in specular and missing mip / roughness filtering raise it.
 */
export function shimmer(
  frames: readonly ColorImage[],
  mask?: PixelMask,
): { readonly meanTemporalStd: number; readonly map: Float32Array } {
  const first = frames[0];
  if (first === undefined || frames.length < 2)
    throw new RangeError('shimmer needs two or more frames');
  for (const f of frames) {
    checkImage(f, 'frame');
    sameSize(first, f);
  }
  checkMask(mask, first.width * first.height);
  const lumas = frames.map(luma);
  const map = new Float32Array(first.width * first.height);
  for (let i = 0; i < map.length; i++) {
    let mean = 0;
    for (const l of lumas) mean += l[i] as number;
    mean /= lumas.length;
    let v = 0;
    for (const l of lumas) v += ((l[i] as number) - mean) ** 2;
    map[i] = Math.sqrt(v / lumas.length);
  }
  return { meanTemporalStd: maskedMean(map, mask), map };
}

const TURBO: readonly (readonly [number, number, number])[] = [
  [48, 18, 59],
  [70, 134, 251],
  [27, 229, 181],
  [164, 252, 60],
  [251, 185, 56],
  [228, 70, 10],
  [122, 4, 3],
];

/** A per-pixel error map as an RGBA8 PNG heatmap: 0 dark blue to `max` dark red; masked-out pixels gray. */
export function heatmapPng(
  map: ArrayLike<number>,
  width: number,
  height: number,
  max: number,
  mask?: PixelMask,
): Uint8Array {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0))
    throw new RangeError(`heatmapPng needs positive integer dimensions, got ${width}x${height}`);
  if (!(Number.isFinite(max) && max > 0))
    throw new RangeError(`heatmapPng needs a positive finite max, got ${max}`);
  if (map.length < width * height)
    throw new RangeError(`heatmapPng map holds ${map.length} values, ${width * height} expected`);
  if (mask !== undefined && mask.length !== width * height)
    throw new RangeError(`mask holds ${mask.length} pixels, ${width * height} expected`);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (mask !== undefined && mask[i] === 0) {
      rgba.set([24, 24, 28, 255], i * 4);
      continue;
    }
    if (!Number.isFinite(map[i]))
      throw new RangeError(`heatmapPng map holds a non-finite value at ${i}`);
    const t = Math.max(0, Math.min(1, (map[i] as number) / max)) * (TURBO.length - 1);
    const k = Math.min(TURBO.length - 2, Math.floor(t));
    const f = t - k;
    const lo = TURBO[k] as readonly number[];
    const hi = TURBO[k + 1] as readonly number[];
    for (let c = 0; c < 3; c++)
      rgba[i * 4 + c] = Math.round((lo[c] as number) + ((hi[c] as number) - (lo[c] as number)) * f);
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(width, height, rgba);
}
