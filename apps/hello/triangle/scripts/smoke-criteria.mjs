// smoke-criteria - hello-triangle three-part criteria pure-function module
// (feat-20260510-smoke-architecture-redesign w5 / plan-strategy section 2
// D-P4 + section 4.1).
//
// Shape: pure-function module with no top-level side effects - smoke-dawn.mjs
// (CLI harness) and the vitest unit tests (smoke-counterexamples.test.ts)
// share the same criteria SSOT (charter proposition 5 consistent abstraction
// + architecture principle #1 SSOT).
//
// Three-part criteria (SSOT, aligned with plan-strategy K-5 baseline + AC-03;
// pixelSamples shape convergence per D-P4 mirrors hello-cube smoke):
//   (a) `[hello-triangle] backend=webgpu` console hit (K-7 chrome stable +
//       Vulkan flag combo)
//   (b) raf frame count >= SMOKE_MIN_FRAMES (default 60, ENV-overridable)
//   (c) GPUBuffer copyTextureToBuffer pixel readback at two sample sites:
//       - NDC-center (canvas center) RGB distance to clearColor
//         [0.06, 0.06, 0.08] > SMOKE_PIXEL_THRESHOLD (default 0.05 - D-P4
//         maintains epsilon=0.05 unchanged so K-12 baseline anchor survives;
//         ENV-overridable; 8-frame average D-RS5 baseline that smooths
//         driver-timing jitter)
//       - corner: value recorded only (not part of the pass/fail decision;
//         kept for the verify report)
//
// Counter-examples (each MUST FAIL in the TDD red phase; plan-strategy
// section 4.1):
//   (i)   backend forced to non-webgpu value -> (a) FAIL
//   (ii)  clear-only, no draw -> (c) NDC-center sample = clearColor -> FAIL
//   (iii) fix-f8 silent return reproduction -> (c) NDC-center sample =
//         clearColor -> FAIL (same observable signature)
//   (iv)  pixelSamples.ndcCenter equals clearColor (D-P4 shape convergence
//         coverage; mirrors hello-cube smoke criterion (c))
//
// References: requirements AC-03 (a)(b)(c) + AC-04 (d) fix-f8 reproduction
//             + AC-11 SMOKE_DURATION_MS=5000; plan-strategy section 2 D-P4
//             (pixelSamples shape convergence to ndcCenter/corner;
//             epsilon=0.05 unchanged) + section K-5 pixel readback baseline
//             + section 6 M1.2 / M1.3 milestone gating; research section
//             F-S5 hello-cube smoke shape SSOT precedent + section 1
//             Finding 4.2 GPUBuffer copy path + section 6.4 spec normative
//             reinforcement of charter proposition 4 explicit failure.

/**
 * @typedef {Object} PixelSamples
 * @property {readonly [number, number, number]} ndcCenter - canvas / NDC-center RGB (0-1); D-P4 shape mirrors hello-cube smoke
 * @property {readonly [number, number, number]} corner - canvas-corner RGB (0-1); recorded only, not part of pass/fail
 */

/**
 * @typedef {Object} SmokeCriteriaInput
 * @property {'webgpu' | 'webgl2' | null} backendLine - console-matched backend
 * @property {number} framesObserved - raf frame count
 * @property {PixelSamples} pixelSamples - RGB triplets at three sample sites
 */

/**
 * @typedef {Object} SmokeCriteriaResult
 * @property {boolean} pass
 * @property {string} reason
 */

/** clearColor SSOT: byte-identical to webgpu-backend.ts:142 + main.ts default
 *  (architecture principle #1). */
export const CLEAR_COLOR_RGB = /** @type {readonly [number, number, number]} */ ([
  0.06, 0.06, 0.08,
]);

/** Default ENV values: byte-identical to smoke.mjs's main entry (preventing
 *  SSOT drift). */
export const DEFAULTS = Object.freeze({
  SMOKE_DURATION_MS: 5000, // AC-11 reduced to 5s
  SMOKE_MIN_FRAMES: 60,
  SMOKE_PIXEL_THRESHOLD: 0.05, // K-5 baseline
  SMOKE_FRAME_AVG: 8, // K-5 multi-frame average
});

/**
 * Euclidean distance between two RGB triplets (0-1 space, not normalized to √3).
 *
 * @param {readonly [number, number, number]} a
 * @param {readonly [number, number, number]} b
 * @returns {number}
 */
export function rgbDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Evaluate the three-part smoke criteria; return a structured { pass, reason }
 * result (charter proposition 4 explicit failure).
 *
 * @param {SmokeCriteriaInput} input
 * @param {Object} [opts]
 * @param {number} [opts.minFrames] - default DEFAULTS.SMOKE_MIN_FRAMES
 * @param {number} [opts.pixelThreshold] - default DEFAULTS.SMOKE_PIXEL_THRESHOLD
 * @returns {SmokeCriteriaResult}
 */
export function evaluateSmokeCriteria(input, opts = {}) {
  const minFrames = opts.minFrames ?? DEFAULTS.SMOKE_MIN_FRAMES;
  const pixelThreshold = opts.pixelThreshold ?? DEFAULTS.SMOKE_PIXEL_THRESHOLD;

  // Criterion (a): backend === 'webgpu' (AC-03 (a) strict criterion; charter
  // proposition 4 — no fallback acceptance)
  if (input.backendLine !== 'webgpu') {
    return {
      pass: false,
      reason: `backend=${input.backendLine ?? 'null'} (expected: webgpu) — see plan-strategy K-7`,
    };
  }

  // Criterion (b): framesObserved >= minFrames
  if (input.framesObserved < minFrames) {
    return {
      pass: false,
      reason: `frames=${input.framesObserved} < SMOKE_MIN_FRAMES=${minFrames} — page may have stalled`,
    };
  }

  // Criterion (c): NDC-center pixel distance to clearColor > threshold
  // (D-P4 shape convergence: pixelSamples.ndcCenter mirrors hello-cube smoke).
  const dist = rgbDistance(input.pixelSamples.ndcCenter, CLEAR_COLOR_RGB);
  if (dist <= pixelThreshold) {
    return {
      pass: false,
      reason: `NDC-center pixel ${JSON.stringify(input.pixelSamples.ndcCenter)} approx clearColor (distance ${dist.toFixed(4)} <= ${pixelThreshold}) - triangle not drawn (counter-example ii / iii / iv)`,
    };
  }

  return { pass: true, reason: 'all 3 criteria passed (backend=webgpu, frames OK, pixel OK)' };
}

/**
 * Decode an ArrayBuffer obtained from mapAsync (BGRA8 unorm, bytesPerRow
 * aligned to 256) into an RGB triplet (0-1 space). Only used on the
 * smoke.mjs page.evaluate injection path; the pure unit-test side uses
 * fixtures and does not need to call this.
 *
 * @param {Uint8Array} bgraBytes - copyTextureToBuffer + mapAsync(READ) + getMappedRange result
 * @param {number} pixelOffset - starting byte offset (= y*bytesPerRow + x*4)
 * @returns {readonly [number, number, number]}
 */
export function readBgra8Pixel(bgraBytes, pixelOffset) {
  const b = (bgraBytes[pixelOffset + 0] ?? 0) / 255;
  const g = (bgraBytes[pixelOffset + 1] ?? 0) / 255;
  const r = (bgraBytes[pixelOffset + 2] ?? 0) / 255;
  return [r, g, b];
}
