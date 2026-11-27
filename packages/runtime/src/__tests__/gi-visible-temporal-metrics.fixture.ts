import type { SceneImage } from './gi-scenes.fixture';

/** A missing completed receipt must never silently skip a potentially bad frame. */
export function requireConsecutiveVisibleFrame(
  previous: number | undefined,
  current: number,
): void {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    (previous !== undefined && current !== previous + 1)
  )
    throw new Error('Visible temporal receipts must be consecutive completed frames');
}

function value(x: number | undefined): number {
  if (x === undefined || !Number.isFinite(x)) throw new Error('Nonfinite visible temporal sample');
  return x;
}

function percentile(values: number[]): number {
  values.sort((a, b) => a - b);
  return value(values[Math.floor((values.length - 1) * 0.95)]);
}

/** The original spatial gates are applied separately to every completed frame. */
export function visibleFrameMetrics(
  image: SceneImage,
  reference: ArrayLike<number>,
  pixels: readonly number[],
  thresholds: { mean: number; p95: number },
) {
  if (pixels.length === 0 || image.rgb.length !== reference.length)
    throw new Error('Invalid visible temporal ROI');
  const expected = [0, 1, 2].map(
    (c) => pixels.reduce((sum, p) => sum + value(reference[p * 3 + c]), 0) / pixels.length,
  );
  const relative = expected.map((target, c) => {
    const observed =
      pixels.reduce((sum, p) => sum + value(image.rgb[p * 3 + c]), 0) / pixels.length;
    return Math.abs(observed - target) / target;
  });
  const pixelP95 = expected.map((target, c) =>
    percentile(
      pixels.map(
        (p) =>
          Math.abs(value(image.rgb[p * 3 + c]) - value(reference[p * 3 + c])) /
          Math.max(target, 0.005),
      ),
    ),
  );
  if (!image.covered || !image.support) throw new Error('Missing same-frame support evidence');
  let visible = 0;
  let missing = 0;
  for (let p = 0; p < image.covered.length; p++) {
    if (!image.covered[p]) continue;
    visible++;
    if (!(value(image.support[p]) > 0.99)) missing++;
  }
  if (visible === 0) throw new Error('Empty visible temporal evidence');
  const passed =
    relative.every((x) => x < thresholds.mean) &&
    pixelP95.every((x) => x < thresholds.p95) &&
    missing === 0;
  return { expected, relative, pixelP95, visible, missing, passed };
}

/** Match averageFrames' ordered f32 store after each sample, without another draw. */
export function regroupVisibleFrames(frames: readonly SceneImage[]): SceneImage {
  const first = frames[0];
  if (!first || frames.length !== 8) throw new Error('Exactly eight constituent frames required');
  const rgb = new Float32Array(first.rgb.length);
  const covered = new Uint8Array(first.width * first.height);
  const support = new Float32Array(covered.length).fill(Number.POSITIVE_INFINITY);
  for (const frame of frames) {
    if (frame.rgb.length !== rgb.length || !frame.covered || !frame.support)
      throw new Error('Incomplete window constituent');
    for (let i = 0; i < rgb.length; i++)
      rgb[i] = value(rgb[i]) + value(frame.rgb[i]) / frames.length;
    for (let p = 0; p < covered.length; p++) {
      covered[p] = (covered[p] ?? 0) | (frame.covered[p] ?? 0);
      support[p] = Math.min(
        value(support[p] === Number.POSITIVE_INFINITY ? frame.support[p] : support[p]),
        value(frame.support[p]),
      );
    }
  }
  return { rgb, covered, support, width: first.width, height: first.height };
}

/** Diagnostic only: no invented flicker tolerance or spatial averaging before differences. */
export function visibleAdjacentChanges(frames: readonly SceneImage[], pixels: readonly number[]) {
  return frames.slice(1).map((frame, index) => {
    const previous = frames[index];
    if (!previous) throw new Error('Missing preceding completed frame');
    let squares = 0;
    let maximum = 0;
    for (const p of pixels)
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs(value(frame.rgb[p * 3 + c]) - value(previous.rgb[p * 3 + c]));
        maximum = Math.max(maximum, delta);
        squares += delta * delta;
      }
    return { from: index, to: index + 1, maximum, rms: Math.sqrt(squares / (pixels.length * 3)) };
  });
}
