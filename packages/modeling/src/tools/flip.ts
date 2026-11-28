/**
 * LDR FLIP (Andersson, Nilsson, Akenine-Moeller, Oskarsson, Astroem and Fairchild,
 * "FLIP: A Difference Evaluator for Alternating Images", HPG 2020), implemented from
 * the paper: a color pipeline (contrast-sensitivity filtering in YCxCz, Hunt-adjusted
 * HyAB distance, compressed to [0, 1]) and a feature pipeline (edge and point
 * detectors on the achromatic channel) combined per pixel as color^(1 - feature).
 * The images are sRGB-encoded values in [0, 1].
 */
import { maxOf } from '../arrays';
import { type ColorImage, checkPair } from './image-metrics';

export interface FlipOptions {
  /** Pixels per degree of visual angle (default 67.02: a 0.7 m wide 3840 px display at 0.7 m). */
  readonly ppd?: number;
}

export interface FlipResult {
  /** Mean of the per-pixel error over the image (or the mask). */
  readonly mean: number;
  readonly p95: number;
  /** Per-pixel FLIP error in [0, 1], rows top to bottom. */
  readonly map: Float32Array;
}

/** 0.7 m * (3840 px / 0.7 m) * pi / 180. */
export const FLIP_DEFAULT_PPD = (0.7 * (3840 / 0.7) * Math.PI) / 180;

/** Bounds the CSF kernel radius (about 0.7 ppd taps each side). */
const FLIP_MAX_PPD = 10000;

const QC = 0.7;
const QF = 0.5;
const PC = 0.4;
const PT = 0.95;
const FEATURE_WIDTH = 0.082;

/** Contrast sensitivity: a1 sqrt(pi / b1) exp(-pi^2 r^2 / b1) + a2 sqrt(pi / b2) exp(-pi^2 r^2 / b2). */
const CSF = [
  [
    [1, 0.0047],
    [0, 1e-5],
  ],
  [
    [1, 0.0053],
    [0, 1e-5],
  ],
  [
    [34.1, 0.04],
    [13.5, 0.025],
  ],
] as const;

const RGB_TO_XYZ = [
  0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041,
] as const;
const XYZ_TO_RGB = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259,
  1.0572252,
] as const;
const WHITE = [0, 1, 2].map(
  (r) =>
    (RGB_TO_XYZ[r * 3] as number) +
    (RGB_TO_XYZ[r * 3 + 1] as number) +
    (RGB_TO_XYZ[r * 3 + 2] as number),
) as [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function mul3(m: readonly number[], x: number, y: number, z: number): [number, number, number] {
  const r = (k: number) =>
    (m[k * 3] as number) * x + (m[k * 3 + 1] as number) * y + (m[k * 3 + 2] as number) * z;
  return [r(0), r(1), r(2)];
}

const DELTA = 6 / 29;
const labF = (t: number) => (t > DELTA ** 3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29);

/** Linear RGB to Hunt-adjusted CIELAB (a and b scaled by 0.01 L). */
function huntLab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = mul3(RGB_TO_XYZ, r, g, b);
  const fx = labF(x / WHITE[0]);
  const fy = labF(y / WHITE[1]);
  const fz = labF(z / WHITE[2]);
  const L = 116 * fy - 16;
  return [L, 0.01 * L * 500 * (fx - fy), 0.01 * L * 200 * (fy - fz)];
}

function huntLabInto(out: Float64Array, at: number, r: number, g: number, b: number): void {
  const x = RGB_TO_XYZ[0] * r + RGB_TO_XYZ[1] * g + RGB_TO_XYZ[2] * b;
  const y = RGB_TO_XYZ[3] * r + RGB_TO_XYZ[4] * g + RGB_TO_XYZ[5] * b;
  const z = RGB_TO_XYZ[6] * r + RGB_TO_XYZ[7] * g + RGB_TO_XYZ[8] * b;
  const fx = labF(x / WHITE[0]);
  const fy = labF(y / WHITE[1]);
  const fz = labF(z / WHITE[2]);
  const L = 116 * fy - 16;
  out[at] = L;
  out[at + 1] = 0.01 * L * 500 * (fx - fy);
  out[at + 2] = 0.01 * L * 200 * (fy - fz);
}

const hyab = (p: ArrayLike<number>, q: ArrayLike<number>) =>
  Math.abs((p[0] as number) - (q[0] as number)) +
  Math.hypot((p[1] as number) - (q[1] as number), (p[2] as number) - (q[2] as number));

/** Separable convolution of a single channel with clamp-to-edge borders. */
function convolve(
  src: Float64Array,
  width: number,
  height: number,
  kx: Float64Array,
  ky: Float64Array,
): Float64Array {
  const rx = (kx.length - 1) / 2;
  const ry = (ky.length - 1) / 2;
  const tmp = new Float64Array(width * height);
  const inner0 = Math.min(rx, width);
  const inner1 = Math.max(inner0, width - rx);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      if (x >= inner0 && x < inner1) {
        const base = row + x - rx;
        for (let i = 0; i < kx.length; i++) acc += (kx[i] as number) * (src[base + i] as number);
      } else {
        for (let i = -rx; i <= rx; i++) {
          const xx = x + i < 0 ? 0 : x + i >= width ? width - 1 : x + i;
          acc += (kx[i + rx] as number) * (src[row + xx] as number);
        }
      }
      tmp[row + x] = acc;
    }
  }
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const dst = y * width;
    for (let i = -ry; i <= ry; i++) {
      const yy = y + i < 0 ? 0 : y + i >= height ? height - 1 : y + i;
      const k = ky[i + ry] as number;
      const from = yy * width;
      for (let x = 0; x < width; x++)
        out[dst + x] = (out[dst + x] as number) + k * (tmp[from + x] as number);
    }
  }
  return out;
}

/** The YCxCz planes of an sRGB image (Y' = 116 Y / Yn - 16, Cx, Cz). */
function ycxcz(image: ColorImage): [Float64Array, Float64Array, Float64Array] {
  const n = image.width * image.height;
  const planes: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(n),
    new Float64Array(n),
    new Float64Array(n),
  ];
  for (let i = 0; i < n; i++) {
    const [x, y, z] = mul3(
      RGB_TO_XYZ,
      toLinear(image.rgb[i * 3] as number),
      toLinear(image.rgb[i * 3 + 1] as number),
      toLinear(image.rgb[i * 3 + 2] as number),
    );
    const xn = x / WHITE[0];
    const yn = y / WHITE[1];
    const zn = z / WHITE[2];
    planes[0][i] = 116 * yn - 16;
    planes[1][i] = 500 * (xn - yn);
    planes[2][i] = 200 * (yn - zn);
  }
  return planes;
}

/** Each channel's CSF filter as weighted separable Gaussian terms, normalized in 2D. */
function csfTerms(ppd: number): { kernel: Float64Array; weight: number }[][] {
  const maxB = maxOf(CSF.flat().map(([, b]) => b));
  const radius = Math.ceil(3 * Math.sqrt(maxB / (2 * Math.PI * Math.PI)) * ppd);
  const dx = 1 / ppd;
  return CSF.map((terms) => {
    const parts = terms
      .filter(([a]) => a > 0)
      .map(([a, b]) => {
        const kernel = new Float64Array(2 * radius + 1);
        for (let i = -radius; i <= radius; i++)
          kernel[i + radius] = Math.exp((-Math.PI * Math.PI * (i * dx) ** 2) / b);
        return { kernel, weight: a * Math.sqrt(Math.PI / b) };
      });
    let total = 0;
    for (const { kernel, weight } of parts) {
      const s = kernel.reduce((p, q) => p + q, 0);
      total += weight * s * s;
    }
    return parts.map((p) => ({ kernel: p.kernel, weight: p.weight / total }));
  });
}

/** Edge (first derivative) or point (second derivative) kernels along x, plus the y Gaussian. */
function featureKernels(ppd: number): {
  edge: Float64Array;
  point: Float64Array;
  gauss: Float64Array;
} {
  const sd = 0.5 * FEATURE_WIDTH * ppd;
  const radius = Math.ceil(3 * sd);
  const g = (i: number) => Math.exp(-(i * i) / (2 * sd * sd));
  const gauss = new Float64Array(2 * radius + 1);
  for (let i = -radius; i <= radius; i++) gauss[i + radius] = g(i);
  const gs = gauss.reduce((p, q) => p + q, 0);
  for (let i = 0; i < gauss.length; i++) gauss[i] = (gauss[i] as number) / gs;
  // The 2D kernel f(x) g(y) has the sign of f(x): positive and negative weights are
  // normalized to +1 and -1 separately, which factors into f(x) / (its signed sum).
  const signed = (f: (i: number) => number) => {
    const k = new Float64Array(2 * radius + 1);
    let pos = 0;
    let neg = 0;
    for (let i = -radius; i <= radius; i++) {
      const v = f(i);
      k[i + radius] = v;
      if (v > 0) pos += v;
      else neg -= v;
    }
    for (let i = 0; i < k.length; i++) k[i] = (k[i] as number) / ((k[i] as number) > 0 ? pos : neg);
    return k;
  };
  return {
    edge: signed((i) => -i * g(i)),
    point: signed((i) => ((i * i) / (sd * sd) - 1) * g(i)),
    gauss,
  };
}

/** LDR FLIP between a reference and a test image of the same size. */
export function flip(
  reference: ColorImage,
  test: ColorImage,
  options: FlipOptions = {},
): FlipResult {
  checkPair(reference, test, undefined);
  const { width, height } = reference;
  const ppd = options.ppd ?? FLIP_DEFAULT_PPD;
  if (!(Number.isFinite(ppd) && ppd > 0 && ppd <= FLIP_MAX_PPD))
    throw new RangeError(`flip needs ppd in (0, ${FLIP_MAX_PPD}], got ${ppd}`);
  const n = width * height;
  const terms = csfTerms(ppd);
  const filtered = [reference, test].map((image) => {
    const planes = ycxcz(image);
    const out = planes.map((plane, c) => {
      const acc = new Float64Array(n);
      for (const { kernel, weight } of terms[c] ?? []) {
        const f = convolve(plane, width, height, kernel, kernel);
        for (let i = 0; i < n; i++) acc[i] = (acc[i] as number) + weight * (f[i] as number);
      }
      return acc;
    });
    const lab = new Float64Array(n * 3);
    const o0 = out[0] as Float64Array;
    const o1 = out[1] as Float64Array;
    const o2 = out[2] as Float64Array;
    for (let i = 0; i < n; i++) {
      const yn = ((o0[i] as number) + 16) / 116;
      const xn = (o1[i] as number) / 500 + yn;
      const zn = yn - (o2[i] as number) / 200;
      const x = xn * WHITE[0];
      const y = yn * WHITE[1];
      const z = zn * WHITE[2];
      const r = Math.min(1, Math.max(0, XYZ_TO_RGB[0] * x + XYZ_TO_RGB[1] * y + XYZ_TO_RGB[2] * z));
      const g = Math.min(1, Math.max(0, XYZ_TO_RGB[3] * x + XYZ_TO_RGB[4] * y + XYZ_TO_RGB[5] * z));
      const b = Math.min(1, Math.max(0, XYZ_TO_RGB[6] * x + XYZ_TO_RGB[7] * y + XYZ_TO_RGB[8] * z));
      huntLabInto(lab, i * 3, r, g, b);
    }
    return { lab, luma: planes[0].map((v) => (v + 16) / 116) };
  });
  const cmax = hyab(huntLab(0, 1, 0), huntLab(0, 0, 1)) ** QC;
  const { edge, point, gauss } = featureKernels(ppd);
  const features = filtered.map(({ luma }) => {
    const ex = convolve(luma, width, height, edge, gauss);
    const ey = convolve(luma, width, height, gauss, edge);
    const px = convolve(luma, width, height, point, gauss);
    const py = convolve(luma, width, height, gauss, point);
    const edges = new Float64Array(n);
    const points = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      edges[i] = Math.sqrt((ex[i] as number) ** 2 + (ey[i] as number) ** 2);
      points[i] = Math.sqrt((px[i] as number) ** 2 + (py[i] as number) ** 2);
    }
    return { edges, points };
  });
  const [ref, tst] = filtered as [(typeof filtered)[0], (typeof filtered)[0]];
  const [fr, ft] = features as [(typeof features)[0], (typeof features)[0]];
  const map = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const dc =
      (Math.abs((ref.lab[j] as number) - (tst.lab[j] as number)) +
        Math.hypot(
          (ref.lab[j + 1] as number) - (tst.lab[j + 1] as number),
          (ref.lab[j + 2] as number) - (tst.lab[j + 2] as number),
        )) **
      QC;
    const color =
      dc < PC * cmax
        ? (PT / (PC * cmax)) * dc
        : PT + ((dc - PC * cmax) / (cmax - PC * cmax)) * (1 - PT);
    const df = Math.max(
      Math.abs((fr.edges[i] as number) - (ft.edges[i] as number)),
      Math.abs((fr.points[i] as number) - (ft.points[i] as number)),
    );
    const feature = (df / Math.SQRT2) ** QF;
    const value = color ** (1 - feature);
    map[i] = value;
    sum += value;
  }
  const sorted = Float32Array.from(map).sort();
  return { mean: sum / n, p95: sorted[Math.floor(0.95 * (n - 1))] as number, map };
}
