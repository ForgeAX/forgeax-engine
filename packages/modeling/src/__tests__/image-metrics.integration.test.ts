import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flip } from '../tools/flip';
import {
  type ColorImage,
  deltaE2000,
  heatmapPng,
  imageDeltaE,
  readPng,
  shimmer,
  srgbToLab,
  ssim,
} from '../tools/image-metrics';

/**
 * Verification metrics against published reference values (implemented from the
 * papers, validated against their data): CIEDE2000 on the 34 published pairs and
 * FLIP on a published reference pair when it is available.
 */

/** Published CIEDE2000 pairs: L1 a1 b1 L2 a2 b2 and the published Delta E00. */
const SHARMA_2005: readonly (readonly number[])[] = [
  [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
  [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
  [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
  [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
  [50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
  [50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
  [50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
  [50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
  [50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
  [50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

function image(
  w: number,
  h: number,
  f: (x: number, y: number) => [number, number, number],
): ColorImage {
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set(f(x, y), (y * w + x) * 3);
  return { width: w, height: h, rgb };
}

/** Deterministic pseudo-random values in [0, 1). */
function noise(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const gradient = image(64, 64, (x, y) => [x / 63, y / 63, 0.5]);
const noisy = (amount: number, seed = 1) => {
  const r = noise(seed);
  return image(
    64,
    64,
    (x, y) =>
      [x / 63, y / 63, 0.5].map((v) => Math.min(1, Math.max(0, v + (r() - 0.5) * amount))) as [
        number,
        number,
        number,
      ],
  );
};

describe('CIEDE2000', () => {
  it('reproduces all 34 published test pairs to 1e-4', () => {
    let worst = 0;
    for (const r of SHARMA_2005) {
      const d = deltaE2000(
        [r[0], r[1], r[2]] as [number, number, number],
        [r[3], r[4], r[5]] as [number, number, number],
      );
      worst = Math.max(worst, Math.abs(d - (r[6] as number)));
    }
    expect(SHARMA_2005).toHaveLength(34);
    expect(worst).toBeLessThan(1e-4);
  });

  it('maps sRGB white and black to L 100 and 0, and is zero on identical images', () => {
    const white = srgbToLab(1, 1, 1);
    expect(white[0]).toBeCloseTo(100, 3);
    expect(Math.hypot(white[1], white[2])).toBeLessThan(1e-2);
    expect(srgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 6);
    expect(imageDeltaE(gradient, gradient).mean).toBe(0);
    expect(imageDeltaE(gradient, noisy(0.2)).mean).toBeGreaterThan(
      imageDeltaE(gradient, noisy(0.05)).mean,
    );
  });
});

describe('SSIM', () => {
  it('is 1 on identical images, symmetric, and falls monotonically with noise', () => {
    expect(ssim(gradient, gradient).mean).toBeCloseTo(1, 12);
    const a = ssim(gradient, noisy(0.1)).mean;
    const b = ssim(noisy(0.1), gradient).mean;
    expect(a).toBeCloseTo(b, 12);
    const levels = [0.02, 0.08, 0.3].map((n) => ssim(gradient, noisy(n)).mean);
    expect(levels[0]).toBeGreaterThan(levels[1] as number);
    expect(levels[1]).toBeGreaterThan(levels[2] as number);
  });

  it('averages over a mask only', () => {
    const half = new Uint8Array(64 * 64).map((_, i) => (i % 64 < 32 ? 1 : 0));
    const test = image(64, 64, (x, y) => (x < 32 ? [x / 63, y / 63, 0.5] : [1 - x / 63, 0, 0]));
    expect(ssim(gradient, test, half).mean).toBeGreaterThan(ssim(gradient, test).mean);
  });
});

describe('LDR FLIP', () => {
  it('is 0 on identical images and grows with the difference', () => {
    expect(flip(gradient, gradient).mean).toBe(0);
    const means = [0.02, 0.1, 0.4].map((n) => flip(gradient, noisy(n)).mean);
    expect(means[0]).toBeLessThan(means[1] as number);
    expect(means[1]).toBeLessThan(means[2] as number);
  });

  it('maps the green-blue distance (its normalizer) to 1 and stays in [0, 1]', () => {
    const green = image(32, 32, () => [0, 1, 0]);
    const blue = image(32, 32, () => [0, 0, 1]);
    const result = flip(green, blue);
    expect(result.mean).toBeCloseTo(1, 6);
    expect(Math.max(...result.map)).toBeLessThanOrEqual(1);
    expect(Math.min(...flip(gradient, noisy(0.3)).map)).toBeGreaterThanOrEqual(0);
  });

  // NVlabs/flip images/reference.png and test.png (not committed); the repository's
  // test expects an LDR mean of 0.159693 at the default 67.02 pixels per degree.
  const dir = process.env.FORGEAX_FLIP_REFERENCE_DIR ?? '/tmp/b20s3-flip';
  const available = existsSync(join(dir, 'reference.png')) && existsSync(join(dir, 'test.png'));
  it.skipIf(!available)(
    'matches the published mean of the reference pair to 1e-5',
    () => {
      const read = (name: string) => readPng(new Uint8Array(readFileSync(join(dir, name)))).image;
      const reference = read('reference.png');
      const test = read('test.png');
      expect(Math.abs(flip(reference, test).mean - 0.159693)).toBeLessThan(1e-5);
      // Falsifier: the comparison is sensitive; another viewing distance misses it.
      expect(Math.abs(flip(reference, test, { ppd: 40 }).mean - 0.159693)).toBeGreaterThan(1e-3);
    },
    60_000,
  );
});

describe('shimmer and heatmaps', () => {
  it('is 0 on still frames and rises when a checker aliases under sub-pixel offsets', () => {
    expect(shimmer([gradient, gradient, gradient]).meanTemporalStd).toBeLessThan(1e-12);
    const checker = (dx: number) =>
      image(32, 32, (x) => ((Math.floor(x + dx) & 1) === 0 ? [1, 1, 1] : [0, 0, 0]));
    const aliased = shimmer([0, 0.5, 1, 1.5].map(checker)).meanTemporalStd;
    expect(aliased).toBeGreaterThan(0.4);
  });

  it('writes a heatmap PNG that the Engine decoder reads back', () => {
    const map = new Float32Array(16 * 8).map((_, i) => i / 128);
    const png = heatmapPng(map, 16, 8, 1);
    const back = readPng(png);
    expect([back.image.width, back.image.height]).toEqual([16, 8]);
    expect(back.image.rgb[0]).not.toBe(back.image.rgb[back.image.rgb.length - 3]);
  });
});
