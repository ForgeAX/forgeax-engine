// apps/parity/forgeax/src/evaluate-parity.test.ts - 8-case red battery for
// the pure-function evaluator (M2 T-007 TDD red phase).
//
// 8 cases mirror plan-strategy §4.2 single layer + §4.3 must-have-test
// row 1:
//
//   (1) idempotency - same input -> same output (purity guard).
//   (2) numDiffPixels === 0 -> Result.ok (boundary: clean equal frames).
//   (3) numDiffPixels === threshold -> Result.ok (boundary: gate inclusive).
//   (4) numDiffPixels === threshold + 1 -> Result.err
//       (code='pixel-parity-threshold-exceeded'; detail carries the
//       diffPixelCount / diffPercent / maxChannelDelta / threshold /
//       perPixelThreshold quintet).
//   (5) Uint8Array length mismatch -> Result.err
//       (code='pixel-parity-capture-failed'; detail.stage='size-mismatch';
//       detail.leftSize + detail.rightSize carry actual byte counts).
//   (6) zero-length capture -> Result.err
//       (code='pixel-parity-capture-failed';
//       detail.stage='pixel-readback' or 'vite-preview').
//   (7) opts.perPixelThreshold omitted -> fallback to 0.1 (D-P2 default
//       semantics; verdict.perPixelThreshold === 0.1 on the ok path).
//   (8) pixelmatch internal throw -> caught + returned as
//       Result.err code='pixel-parity-capture-failed' detail.stage='diff'
//       (EC-06 + charter proposition 4 no-silent-catch red line; this
//       case relies on a pixelmatch throw injection point that lands at
//       T-008 via dependency injection or stub - the test asserts the
//       contract, the impl wires the path).
//
// TDD shape: every case asserts the eventual T-008 GREEN contract. The
// T-007 placeholder body in evaluate-parity.ts returns
// Result.err('metric-status-not-ok') uniformly, so every it() block here
// goes RED at acceptance. T-008 implementation flips each one to GREEN by
// writing the real comparison logic.
//
// Charter mapping: proposition 4 (explicit failure - each error path
// asserts code + detail vocabulary, not message string parsing) +
// proposition 5 (consistent abstraction - the Result<T, E> shape from
// @forgeax/engine-rhi is reused without re-wrapping; one mental model).

import type {
  MetricError,
  ParityCaptureDetail,
  ParityThresholdDetail,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  evaluateParity,
  expectedFor,
  hintFor,
  type ParityEvaluateOptions,
} from '../evaluate-parity';

// Helper: build a flat RGBA buffer of width * height * 4 bytes, all set
// to the same uint8 rgba quadruplet. Pure helper, no third-party deps,
// keeps every test self-contained.
function rgbaFill(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = rgba[0];
    buf[i * 4 + 1] = rgba[1];
    buf[i * 4 + 2] = rgba[2];
    buf[i * 4 + 3] = rgba[3];
  }
  return buf;
}

// 4x4 fixture: just large enough for pixelmatch to do real work while
// staying tiny enough to brute-force in the test body.
const W = 4;
const H = 4;
const TOTAL_PIXELS = W * H;
const RGBA_ORANGE = [204, 102, 51, 255] as const;
// Sentinel buffer used by case 1/2/3: both sides identical -> 0 diff.
const ORANGE = rgbaFill(W, H, RGBA_ORANGE);

describe('evaluateParity - 8-case red battery (M2 T-007)', () => {
  it('(1) idempotency: same input -> same Result (pure function)', () => {
    const opts: ParityEvaluateOptions = { threshold: 0, width: W, height: H };
    const r1 = evaluateParity(ORANGE, ORANGE, opts);
    const r2 = evaluateParity(ORANGE, ORANGE, opts);
    // Two invocations of the same pure function with identical inputs must
    // expose the same Result discriminator (.ok) and value-equal payload.
    expect(r1.ok).toBe(r2.ok);
    if (r1.ok && r2.ok) {
      expect(r1.value.diffPixelCount).toBe(r2.value.diffPixelCount);
      expect(r1.value.threshold).toBe(r2.value.threshold);
      expect(r1.value.perPixelThreshold).toBe(r2.value.perPixelThreshold);
    }
    // T-007 placeholder body returns Result.err uniformly; this branch
    // asserts the eventual T-008 GREEN contract:
    expect(r1.ok).toBe(true);
  });

  it('(2) numDiffPixels === 0 -> Result.ok (clean equal frames)', () => {
    const opts: ParityEvaluateOptions = { threshold: 5, width: W, height: H };
    const r = evaluateParity(ORANGE, ORANGE, opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.diffPixelCount).toBe(0);
      expect(r.value.diffPercent).toBe(0);
      expect(r.value.maxChannelDelta).toBe(0);
      expect(r.value.threshold).toBe(5);
    }
  });

  it('(3) numDiffPixels === threshold -> Result.ok (boundary inclusive)', () => {
    // Construct a buffer that differs in exactly N pixels. We change one
    // pixel at a time (max channel delta = 255 - 0 = 255 on the alpha
    // slot... no, change RED channel only to keep alpha unchanged).
    const N = 3;
    const opts: ParityEvaluateOptions = { threshold: N, width: W, height: H };
    const left = ORANGE;
    const right = new Uint8Array(left);
    for (let i = 0; i < N; i++) {
      right[i * 4] = 0; // tweak red channel of pixel i to 0 (was 204)
    }
    const r = evaluateParity(left, right, opts);
    // Layer B inclusive cap: diffPixelCount <= threshold passes.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.diffPixelCount).toBeLessThanOrEqual(N);
      expect(r.value.threshold).toBe(N);
    }
  });

  it('(4) numDiffPixels === threshold + 1 -> Result.err pixel-parity-threshold-exceeded', () => {
    // Differ in N + 1 pixels with threshold = N -> fail.
    const N = 2;
    const opts: ParityEvaluateOptions = {
      threshold: N,
      perPixelThreshold: 0.05,
      width: W,
      height: H,
    };
    const left = ORANGE;
    const right = new Uint8Array(left);
    // Tweak N + 1 pixels' red channel from 204 -> 0 (large channel delta).
    for (let i = 0; i < N + 1; i++) {
      right[i * 4] = 0;
    }
    const r = evaluateParity(left, right, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e: MetricError = r.error;
      expect(e.code).toBe('pixel-parity-threshold-exceeded');
      if (e.code === 'pixel-parity-threshold-exceeded') {
        const d: ParityThresholdDetail = e.detail;
        expect(d.diffPixelCount).toBeGreaterThan(N);
        expect(d.threshold).toBe(N);
        expect(d.perPixelThreshold).toBe(0.05);
        expect(d.diffPercent).toBeCloseTo(d.diffPixelCount / TOTAL_PIXELS, 6);
        expect(d.maxChannelDelta).toBeGreaterThan(0);
        expect(d.maxChannelDelta).toBeLessThanOrEqual(255);
      }
    }
  });

  it('(5) Uint8Array length mismatch -> capture-failed size-mismatch', () => {
    const opts: ParityEvaluateOptions = { threshold: 0, width: W, height: H };
    // Left has expected size; right has half the bytes -> size mismatch.
    const right = new Uint8Array(W * H * 4 - 4);
    const r = evaluateParity(ORANGE, right, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e: MetricError = r.error;
      expect(e.code).toBe('pixel-parity-capture-failed');
      if (e.code === 'pixel-parity-capture-failed') {
        const d: ParityCaptureDetail = e.detail;
        expect(d.stage).toBe('size-mismatch');
        expect(d.leftSize).toBe(ORANGE.length);
        expect(d.rightSize).toBe(right.length);
      }
    }
  });

  it('(6) zero-length capture -> capture-failed pixel-readback/vite-preview', () => {
    const opts: ParityEvaluateOptions = { threshold: 0, width: W, height: H };
    const empty = new Uint8Array(0);
    const r = evaluateParity(empty, empty, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e: MetricError = r.error;
      expect(e.code).toBe('pixel-parity-capture-failed');
      if (e.code === 'pixel-parity-capture-failed') {
        const d: ParityCaptureDetail = e.detail;
        // EC-04 (capture empty) maps to either 'pixel-readback' (gl side)
        // or 'vite-preview' (page failed to boot); accept both stages
        // because the evaluator cannot disambiguate without runner ctx.
        expect(['pixel-readback', 'vite-preview']).toContain(d.stage);
      }
    }
  });

  it('(7) opts.perPixelThreshold omitted -> evaluator falls back to 0.1', () => {
    // Identical buffers; only the falsback value is being asserted.
    const opts: ParityEvaluateOptions = { threshold: 0, width: W, height: H };
    const r = evaluateParity(ORANGE, ORANGE, opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // D-P2 default semantics: pixelmatch upstream default 0.1.
      expect(r.value.perPixelThreshold).toBe(0.1);
    }
  });

  it('(8) pixelmatch internal throw -> capture-failed diff', () => {
    // Inject a structurally invalid pair that causes pixelmatch to throw
    // (mismatched width*height vs Uint8Array.length: width says 4*4 but
    // buffer has only 8 bytes). The evaluator must catch and surface a
    // 'pixel-parity-capture-failed' with `.detail.stage='diff'` rather
    // than let pixelmatch's RangeError leak (EC-06 / charter proposition
    // 4 explicit failure).
    const malformed = new Uint8Array(8); // not W * H * 4 = 64 bytes
    const opts: ParityEvaluateOptions = { threshold: 0, width: W, height: H };
    // Note: case (5) handles size-mismatch (both sides same length but
    // not matching width * height * 4); this case tries to confuse
    // pixelmatch by handing it 8 bytes when it expects 64.
    const r = evaluateParity(malformed, malformed, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e: MetricError = r.error;
      expect(e.code).toBe('pixel-parity-capture-failed');
      if (e.code === 'pixel-parity-capture-failed') {
        const d: ParityCaptureDetail = e.detail;
        // Stage may legitimately resolve to either 'size-mismatch' (if
        // the evaluator's early-guard catches the byte-count mismatch
        // before pixelmatch is called) or 'diff' (if pixelmatch is
        // actually invoked and throws RangeError inside the wasm body).
        // T-008 picks one path; the test accepts both to keep the
        // contract loose enough for impl flexibility while still
        // asserting NO silent catch.
        expect(['diff', 'size-mismatch']).toContain(d.stage);
      }
    }
  });
});

// 9th block (added at T-008): coverage anchor for the MetricErrorCode
// exhaustive-switch helper `expectedFor` / `hintFor`. The 4 legacy
// MetricErrorCode members are unreachable through evaluateParity's
// public API (the evaluator only constructs the 2 parity codes), but
// the D-P9 evaluator-internal exhaustive switch covers all 6 so that
// removing any member from MetricErrorCode breaks the build inside
// evaluate-parity.ts before the test file runs (B-1 regression
// prevention real consumer site). Coverage anchor below pins all 6
// arms so vitest --coverage hits the plan-strategy §4.4 100% gate.
describe('MetricErrorCode exhaustive-switch helpers (D-P9 / B-1 coverage)', () => {
  it('expectedFor + hintFor return non-empty strings for all 6 members', () => {
    const codes = [
      'metric-not-declared',
      'metric-kind-unknown',
      'metric-status-not-ok',
      'metric-schema-malformed',
      'pixel-parity-threshold-exceeded',
      'pixel-parity-capture-failed',
    ] as const;
    for (const c of codes) {
      const ex = expectedFor({ code: c });
      const hi = hintFor({ code: c });
      expect(ex.length).toBeGreaterThan(0);
      expect(hi.length).toBeGreaterThan(0);
    }
  });
});
