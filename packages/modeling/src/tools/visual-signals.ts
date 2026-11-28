/**
 * Image-similarity signals of `model.compare`, each over two subjects aligned on a common grid
 * (`alignToGrid`). Every signal returns its measured `value`, a `score` in [0, 1] and whether it
 * `pass`es its threshold; weights and thresholds live in one table (`SIGNALS`) so a later
 * calibration is an edit there. The shapes follow img2threejs's Divine Eye ensemble; the numbers
 * are its published defaults and provisional here.
 */
import { type ColorImage, deltaE2000, luma, srgbToLab, ssim } from './image-metrics';
import { type Aligned, dilate, sobel } from './visual-mask';

export interface Signal {
  readonly value: number;
  readonly score: number;
  readonly pass: boolean;
}

export interface SignalSpec {
  readonly weight: number;
  /** Pass bound on `value`: `min` means value >= bound, `max` means value <= bound. */
  readonly bound: { readonly kind: 'min' | 'max'; readonly at: number };
  /** For `max` bounds: the value at which the score reaches 0. */
  readonly zeroAt?: number;
}

/** Weights and pass bounds (provisional: img2threejs defaults, not calibrated on this kernel). */
export const SIGNALS = {
  proportion: { weight: 1.0, bound: { kind: 'max', at: 0.1 }, zeroAt: 0.3 },
  symmetry: { weight: 0.5, bound: { kind: 'max', at: 0.1 }, zeroAt: 0.3 },
  phash: { weight: 1.0, bound: { kind: 'min', at: 0.75 } },
  ssim: { weight: 1.5, bound: { kind: 'min', at: 0.55 } },
  edges: { weight: 1.0, bound: { kind: 'min', at: 0.5 } },
  blowout: { weight: 0.8, bound: { kind: 'max', at: 0.1 }, zeroAt: 0.4 },
  flat: { weight: 0.8, bound: { kind: 'max', at: 0.15 }, zeroAt: 0.5 },
  tonal: { weight: 1.0, bound: { kind: 'min', at: 0.7 } },
  objectness: { weight: 1.5, bound: { kind: 'min', at: 0.6 } },
} as const satisfies Record<string, SignalSpec>;

export type SignalName = keyof typeof SIGNALS;

function signal(name: SignalName, value: number): Signal {
  const spec = SIGNALS[name] as SignalSpec;
  const { kind, at } = spec.bound;
  const pass = kind === 'min' ? value >= at : value <= at;
  const score =
    kind === 'min'
      ? Math.max(0, Math.min(1, value))
      : Math.max(0, Math.min(1, 1 - value / (spec.zeroAt as number)));
  return { value, score, pass };
}

function maskedLuma(a: Aligned): number[] {
  const l = luma(a.image);
  const out: number[] = [];
  for (let i = 0; i < l.length; i++) if (a.mask[i] !== 0) out.push(l[i] as number);
  return out;
}

/** Relative difference of subject bbox aspect (w / h). */
export function proportion(ref: Aligned, test: Aligned): Signal {
  const r = (ref.box.x1 - ref.box.x0) / (ref.box.y1 - ref.box.y0);
  const t = (test.box.x1 - test.box.x0) / (test.box.y1 - test.box.y0);
  return signal('proportion', Math.abs(r - t) / Math.max(r, t));
}

function mirrorIoU(a: Aligned, size: number): number {
  const { x0, x1 } = a.box;
  const mid = (x0 + x1) / 2;
  let both = 0;
  let either = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(2 * mid - x - 1);
      const p = a.mask[y * size + x] !== 0;
      const q = mx >= 0 && mx < size && a.mask[y * size + mx] !== 0;
      if (p && q) both++;
      if (p || q) either++;
    }
  return either === 0 ? 1 : both / either;
}

/** Difference of left-right silhouette symmetry: a symmetric reference must not be rendered lopsided, nor the reverse. */
export function symmetry(
  ref: Aligned,
  test: Aligned,
  size: number,
): Signal & {
  readonly reference: number;
  readonly test: number;
} {
  const r = mirrorIoU(ref, size);
  const t = mirrorIoU(test, size);
  return { ...signal('symmetry', Math.abs(r - t)), reference: r, test: t };
}

/** Perceptual hash: 32x32 mean-fill luma, 8x8 low DCT, bits against the median; value = 1 - hamming / 64. */
export function phash(
  ref: Aligned,
  test: Aligned,
  size: number,
): Signal & {
  readonly hamming: number;
} {
  const bits = (a: Aligned) => {
    const l = luma(a.image);
    const inside = maskedLuma(a);
    const fill = inside.length === 0 ? 0 : inside.reduce((s, v) => s + v, 0) / inside.length;
    const n = 32;
    const small = new Float64Array(n * n);
    const k = size / n;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let dy = 0; dy < k; dy++)
          for (let dx = 0; dx < k; dx++) {
            const i = (Math.floor(y * k) + dy) * size + Math.floor(x * k) + dx;
            sum += a.mask[i] !== 0 ? (l[i] as number) : fill;
          }
        small[y * n + x] = sum / (k * k);
      }
    const dct: number[] = [];
    for (let v = 0; v < 8; v++)
      for (let u = 0; u < 8; u++) {
        let s = 0;
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++)
            s +=
              (small[y * n + x] as number) *
              Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n)) *
              Math.cos(((2 * y + 1) * v * Math.PI) / (2 * n));
        dct.push(s);
      }
    const ac = dct.slice(1).sort((p, q) => p - q);
    const med = ac[Math.floor(ac.length / 2)] as number;
    return dct.map((c, i) => (i > 0 && c > med ? 1 : 0));
  };
  const a = bits(ref);
  const b = bits(test);
  let hamming = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) hamming++;
  return { ...signal('phash', 1 - hamming / 64), hamming };
}

/** Luma SSIM over the union of both silhouettes of the aligned pair. */
export function structural(ref: Aligned, test: Aligned): Signal {
  const union = new Uint8Array(ref.mask.length);
  for (let i = 0; i < union.length; i++) union[i] = ref.mask[i] !== 0 || test.mask[i] !== 0 ? 1 : 0;
  return signal('ssim', ssim(ref.image, test.image, union).mean);
}

export function edgeBits(
  a: Aligned,
  size: number,
): { bits: Uint8Array; magnitude: Float64Array; angle: Float64Array } {
  const l = luma(a.image);
  const { magnitude, angle } = sobel(l, size, size);
  const inside: number[] = [];
  for (let i = 0; i < magnitude.length; i++)
    if (a.mask[i] !== 0) inside.push(magnitude[i] as number);
  inside.sort((p, q) => p - q);
  const cut = Math.max(0.02, (inside[Math.floor(0.8 * (inside.length - 1))] ?? 0) * 0.5);
  const bits = new Uint8Array(size * size);
  for (let i = 0; i < bits.length; i++) bits[i] = (magnitude[i] as number) > cut ? 1 : 0;
  return { bits, magnitude, angle };
}

/** Edge overlap: mean of recall (reference edges the test reproduces) and precision (test edges the reference has), 2 px tolerance. */
export function edges(
  ref: Aligned,
  test: Aligned,
  size: number,
): Signal & { readonly bits: { readonly reference: Uint8Array; readonly test: Uint8Array } } {
  const a = edgeBits(ref, size).bits;
  const b = edgeBits(test, size).bits;
  const da = dilate(a, size, size, 2);
  const db = dilate(b, size, size, 2);
  let ca = 0;
  let cb = 0;
  let hitA = 0;
  let hitB = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== 0) {
      ca++;
      if (db[i] !== 0) hitA++;
    }
    if (b[i] !== 0) {
      cb++;
      if (da[i] !== 0) hitB++;
    }
  }
  const recall = ca === 0 ? 1 : hitA / ca;
  const precision = cb === 0 ? (ca === 0 ? 1 : 0) : hitB / cb;
  return { ...signal('edges', (recall + precision) / 2), bits: { reference: a, test: b } };
}

/** Difference of the share of near-white pixels inside the silhouette (specular or exposure blowout). */
export function blowout(ref: Aligned, test: Aligned): Signal {
  const share = (a: Aligned) => {
    const l = maskedLuma(a);
    return l.length === 0 ? 0 : l.filter((v) => v > 0.95).length / l.length;
  };
  return signal('blowout', Math.abs(share(ref) - share(test)));
}

/** Difference of the share of flat (gradient-free) silhouette pixels: texture detail the render lacks or invents. */
export function flat(ref: Aligned, test: Aligned, size: number): Signal {
  const share = (a: Aligned) => {
    const { magnitude } = sobel(luma(a.image), size, size);
    let inside = 0;
    let low = 0;
    for (let i = 0; i < magnitude.length; i++) {
      if (a.mask[i] === 0) continue;
      inside++;
      if ((magnitude[i] as number) < 0.01) low++;
    }
    return inside === 0 ? 0 : low / inside;
  };
  return signal('flat', Math.abs(share(ref) - share(test)));
}

/** Histogram intersection of the silhouette luma distributions (16 bins). */
export function tonal(ref: Aligned, test: Aligned): Signal {
  const hist = (a: Aligned) => {
    const h = new Array<number>(16).fill(0);
    const l = maskedLuma(a);
    for (const v of l)
      h[Math.min(15, Math.floor(v * 16))] = (h[Math.min(15, Math.floor(v * 16))] as number) + 1;
    return h.map((c) => (l.length === 0 ? 0 : c / l.length));
  };
  const a = hist(ref);
  const b = hist(test);
  return signal(
    'tonal',
    a.reduce((s, v, i) => s + Math.min(v, b[i] as number), 0),
  );
}

/** HOG-lite: 8 unsigned orientation bins on an 8x8 cell grid, cosine similarity per cell, mean over cells either image occupies. */
export function objectness(ref: Aligned, test: Aligned, size: number): Signal {
  const cells = 8;
  const cs = size / cells;
  const hog = (a: Aligned) => {
    const { magnitude, angle } = sobel(luma(a.image), size, size);
    const out = new Float64Array(cells * cells * 8);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (a.mask[i] === 0) continue;
        const bin = Math.min(7, Math.floor(((angle[i] as number) / Math.PI) * 8));
        const c = Math.floor(y / cs) * cells + Math.floor(x / cs);
        out[c * 8 + bin] = (out[c * 8 + bin] as number) + (magnitude[i] as number);
      }
    return out;
  };
  const a = hog(ref);
  const b = hog(test);
  let sum = 0;
  let used = 0;
  for (let c = 0; c < cells * cells; c++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < 8; k++) {
      const p = a[c * 8 + k] as number;
      const q = b[c * 8 + k] as number;
      dot += p * q;
      na += p * p;
      nb += q * q;
    }
    if (na < 1e-9 && nb < 1e-9) continue;
    used++;
    sum += na < 1e-9 || nb < 1e-9 ? 0 : dot / Math.sqrt(na * nb);
  }
  return signal('objectness', used === 0 ? 1 : sum / used);
}

const HUE_ZONES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const;

export interface HueZone {
  readonly zone: (typeof HUE_ZONES)[number];
  readonly referencePixels: number;
  readonly testPixels: number;
  /**
   * CIEDE2000 between the zone's mean colors; absent when a side holds under 1% of its silhouette
   * (`pass` is then false when only one side has the zone, and absent when neither does).
   */
  readonly deltaE?: number;
  readonly pass?: boolean;
}

/** Hue-zone parity bound: per-zone CIEDE2000 of mean colors. */
export const HUE_ZONE_DELTA_E = 2.3;

/** A hue zone present on both subjects fails `model.compare` above this CIEDE2000 (lighting differences stay below it). */
export const HUE_ZONE_GATE_DELTA_E = 15;

/** A hue zone holding this share of one silhouette and under 1% of the other is a hard failure (a whole hue is missing). */
export const HUE_ZONE_MISSING_SHARE = 0.05;

/** Mean color per hue zone on both subjects (chromatic pixels only: saturation > 0.15, value > 0.1); report-only. */
export function hueZones(ref: Aligned, test: Aligned): readonly HueZone[] {
  const zones = (a: Aligned) => {
    const sums = HUE_ZONES.map(() => ({ n: 0, rgb: [0, 0, 0] }));
    let inside = 0;
    for (let i = 0; i < a.mask.length; i++) {
      if (a.mask[i] === 0) continue;
      inside++;
      const r = a.image.rgb[i * 3] as number;
      const g = a.image.rgb[i * 3 + 1] as number;
      const b = a.image.rgb[i * 3 + 2] as number;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < 0.1 || (max - min) / max < 0.15) continue;
      const d = max - min;
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      if (h < 0) h += 6;
      const z = Math.floor((h + 0.5) % 6) % 6;
      const s = sums[z] as { n: number; rgb: number[] };
      s.n++;
      s.rgb[0] = (s.rgb[0] as number) + r;
      s.rgb[1] = (s.rgb[1] as number) + g;
      s.rgb[2] = (s.rgb[2] as number) + b;
    }
    return { sums, inside };
  };
  const a = zones(ref);
  const b = zones(test);
  return HUE_ZONES.map((zone, z) => {
    const p = a.sums[z] as { n: number; rgb: number[] };
    const q = b.sums[z] as { n: number; rgb: number[] };
    const base = { zone, referencePixels: p.n, testPixels: q.n };
    if (p.n < 0.01 * a.inside && q.n < 0.01 * b.inside) return base;
    if (p.n < 0.01 * a.inside || q.n < 0.01 * b.inside) return { ...base, pass: false };
    const lab = (s: { n: number; rgb: number[] }) =>
      srgbToLab((s.rgb[0] as number) / s.n, (s.rgb[1] as number) / s.n, (s.rgb[2] as number) / s.n);
    const deltaE = deltaE2000(lab(p), lab(q));
    return { ...base, deltaE, pass: deltaE <= HUE_ZONE_DELTA_E };
  });
}

/** Largest CIEDE2000 between the mean colors of the two silhouettes (a hard gate of `model.compare`). */
export const PALETTE_DELTA_E = 15;

/** CIEDE2000 between the mean silhouette colors: a wrongly colored render fails here whatever its structure. */
export function palette(ref: Aligned, test: Aligned): number {
  const mean = (a: Aligned) => {
    const sum = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < a.mask.length; i++) {
      if (a.mask[i] === 0) continue;
      n++;
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + (a.image.rgb[i * 3 + c] as number);
    }
    return srgbToLab((sum[0] as number) / n, (sum[1] as number) / n, (sum[2] as number) / n);
  };
  return deltaE2000(mean(ref), mean(test));
}

export interface InteriorDifference {
  /** Mean absolute luma difference over the cells both silhouettes cover. */
  readonly meanLumaDifference: number;
  readonly cellsCompared: number;
  readonly cellsInSilhouette: number;
}

/** Interior difference on the aligned grid, optionally limited to a fractional height band of the subject. */
export function interiorDifference(
  ref: Aligned,
  test: Aligned,
  size: number,
  band?: readonly [number, number],
): InteriorDifference {
  const a = luma(ref.image);
  const b = luma(test.image);
  const top = ref.box.y0 + (band === undefined ? 0 : band[0]) * (ref.box.y1 - ref.box.y0);
  const bottom = ref.box.y0 + (band === undefined ? 1 : band[1]) * (ref.box.y1 - ref.box.y0);
  let sum = 0;
  let compared = 0;
  let inSilhouette = 0;
  for (let y = 0; y < size; y++) {
    if (y + 0.5 < top || y + 0.5 >= bottom) continue;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (ref.mask[i] !== 0 || test.mask[i] !== 0) inSilhouette++;
      if (ref.mask[i] === 0 || test.mask[i] === 0) continue;
      compared++;
      sum += Math.abs((a[i] as number) - (b[i] as number));
    }
  }
  return {
    meanLumaDifference: compared === 0 ? 0 : sum / compared,
    cellsCompared: compared,
    cellsInSilhouette: inSilhouette,
  };
}

export type { ColorImage };
