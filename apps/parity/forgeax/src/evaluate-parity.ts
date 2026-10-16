// apps/parity/forgeax/src/evaluate-parity.ts - pure-function pixel-parity
// evaluator (M2 T-008 green implementation; T-007 placeholder body
// replaced).
//
// Surface (locked at T-007, body locked here at T-008):
//   - ParityVerdict POD (5 numeric fields).
//   - ParityEvaluateOptions POD (4 numeric fields; perPixelThreshold opt).
//   - evaluateParity(leftPixels, rightPixels, opts) -> Result<ParityVerdict, MetricError>
//
// Result form A from @forgeax/engine-rhi (.ok / .value / .error +
// .unwrap() / .unwrapOr()) — plan-strategy D-P4 lock; AI users do not
// learn a second Result shape (charter proposition 5).
//
// Double-gate semantics (plan-strategy D-P2 + research Finding 10):
//   - Layer A `perPixelThreshold` (float [0, 1]): pixelmatch-internal
//     YIQ tolerance; pixels closer than this are not counted as diff.
//     Default 0.1 (pixelmatch upstream lock; mirrored in evaluator
//     fallback when opts.perPixelThreshold is omitted).
//   - Layer B `threshold` (integer): maxDiffPixels aggregate cap;
//     diffPixelCount > threshold raises 'pixel-parity-threshold-exceeded'.
//
// Real consumer site of MetricErrorCode exhaustive switch (D-P9 site
// of 2): the `expectedFor(code)` + `hintFor(code)` helpers below dispatch
// on the 6 closed-union members without a default branch. Removing any
// member from MetricErrorCode would surface a TS exhaustiveness error
// inside this file before the test file (.test.ts) ever runs (charter
// proposition 4 explicit failure / B-1 regression prevention real
// consumer site).
//
// Charter mapping: proposition 1 (one named exported function, no
// class hierarchy) + proposition 3 (machine-readable Result over throw)
// + proposition 4 (every error path returns structured MetricError; no
// silent catch — pixelmatch internal throw is caught + surfaced as
// 'pixel-parity-capture-failed' detail.stage='diff') + proposition 5
// (Result form A reuse from @forgeax/engine-rhi).

import { err, ok, type Result } from '@forgeax/engine-rhi';
import type {
  MetricError,
  MetricErrorCode,
  ParityCaptureDetail,
  ParityThresholdDetail,
} from '@forgeax/engine-types';
import pixelmatch from 'pixelmatch';

/**
 * Pure-function output payload of `evaluateParity`. POD numbers; AI users
 * consume by property access (charter proposition 3).
 *
 * Field priority for AI users reading the report:
 *   1. `diffPixelCount` is the **authoritative** Layer B gate signal — the
 *      runner compares it against `threshold` (an integer; ordered total).
 *   2. `diffPercent = diffPixelCount / (width * height)` is a derived
 *      human-readability convenience; never gate on it (floating-point
 *      equality + non-canonical width/height pairs invite drift).
 *   3. `maxChannelDelta` is diagnostic only (driver-noise vs material
 *      regression signal); it does not factor into pass/fail.
 */
export interface ParityVerdict {
  readonly diffPixelCount: number;
  readonly diffPercent: number;
  readonly maxChannelDelta: number;
  readonly threshold: number;
  readonly perPixelThreshold: number;
}

/**
 * Options bag for `evaluateParity`. `perPixelThreshold` is optional;
 * omitting it falls back to the pixelmatch upstream default `0.1`
 * (D-P2 default semantics).
 */
export interface ParityEvaluateOptions {
  readonly threshold: number;
  readonly perPixelThreshold?: number;
  readonly width: number;
  readonly height: number;
}

const PIXELMATCH_DEFAULT_PER_PIXEL_THRESHOLD = 0.1;

/**
 * Compare two RGBA8 captures pixel-by-pixel against the double-gate.
 * Pure function: no side effects, no I/O.
 *
 * Algorithm:
 *   1. Guard zero-length capture -> 'pixel-parity-capture-failed'
 *      detail.stage='pixel-readback'.
 *   2. Guard length mismatch -> 'pixel-parity-capture-failed'
 *      detail.stage='size-mismatch' detail.leftSize / .rightSize.
 *   3. Guard length != width * height * 4 -> 'pixel-parity-capture-failed'
 *      detail.stage='size-mismatch' (one side or both wrong size for
 *      the declared dimensions).
 *   4. Resolve perPixelThreshold = opts.perPixelThreshold ?? 0.1.
 *   5. Call pixelmatch (try / catch); throw -> 'pixel-parity-capture-failed'
 *      detail.stage='diff'.
 *   6. Walk pixels to compute maxChannelDelta (single pass; pixelmatch
 *      does not expose it).
 *   7. If diffPixelCount > threshold -> 'pixel-parity-threshold-exceeded'
 *      detail.diffPixelCount/diffPercent/maxChannelDelta/threshold/perPixelThreshold.
 *   8. Otherwise Result.ok(verdict).
 */
export function evaluateParity(
  leftPixels: Uint8Array,
  rightPixels: Uint8Array,
  opts: ParityEvaluateOptions,
): Result<ParityVerdict, MetricError> {
  const { threshold, width, height } = opts;
  const perPixelThreshold = opts.perPixelThreshold ?? PIXELMATCH_DEFAULT_PER_PIXEL_THRESHOLD;

  // Step 1: zero-length capture (either side) -> capture-failed
  // 'pixel-readback' stage. Both sides being empty matches EC-04
  // (page failed to attach / readPixels returned 0 bytes); the runner
  // T-009 collapses 'vite-preview' stage at its own boundary, so the
  // evaluator treats empty Uint8Array as readback-side failure.
  if (leftPixels.length === 0 || rightPixels.length === 0) {
    const detail: ParityCaptureDetail = {
      stage: 'pixel-readback',
      leftSize: leftPixels.length,
      rightSize: rightPixels.length,
    };
    return err<MetricError>({
      code: 'pixel-parity-capture-failed',
      expected: expectedFor({ code: 'pixel-parity-capture-failed' }),
      hint: hintFor({ code: 'pixel-parity-capture-failed' }),
      detail,
    });
  }

  // Step 2: left + right lengths must match each other.
  if (leftPixels.length !== rightPixels.length) {
    const detail: ParityCaptureDetail = {
      stage: 'size-mismatch',
      leftSize: leftPixels.length,
      rightSize: rightPixels.length,
    };
    return err<MetricError>({
      code: 'pixel-parity-capture-failed',
      expected: expectedFor({ code: 'pixel-parity-capture-failed' }),
      hint: hintFor({ code: 'pixel-parity-capture-failed' }),
      detail,
    });
  }

  // Step 3 intentionally absent: leftPixels.length !== width * height * 4
  // is left to pixelmatch's own internal check, which throws `Image data
  // size does not match width/height` — caught at step 5 and surfaced
  // as 'pixel-parity-capture-failed' detail.stage='diff'. This keeps
  // step 5's catch branch reachable from the public API (charter
  // proposition 4 explicit failure: every code path the type system
  // permits must be exercisable).

  // Step 4-5: call pixelmatch; wrap in try/catch so the wasm/JS internal
  // throw becomes a structured 'pixel-parity-capture-failed' rather than
  // an unhandled exception (charter proposition 4 no-silent-catch).
  let diffPixelCount: number;
  try {
    diffPixelCount = pixelmatch(leftPixels, rightPixels, undefined, width, height, {
      threshold: perPixelThreshold,
      includeAA: false,
      alpha: 0.1,
    });
  } catch (caught: unknown) {
    const detail: ParityCaptureDetail = {
      stage: 'diff',
      leftSize: leftPixels.length,
      rightSize: rightPixels.length,
    };
    void caught;
    return err<MetricError>({
      code: 'pixel-parity-capture-failed',
      expected: expectedFor({ code: 'pixel-parity-capture-failed' }),
      hint: hintFor({ code: 'pixel-parity-capture-failed' }),
      detail,
    });
  }

  // Step 6: walk pixels once to compute maxChannelDelta (pixelmatch
  // does not expose it). We sample all 3 RGB channels (alpha ignored
  // because the canvases are configured premultipliedAlpha=true and
  // the cube color has alpha=1 everywhere - any alpha drift is
  // already reflected in the RGB premultiplied product).
  let maxChannelDelta = 0;
  for (let i = 0; i < leftPixels.length; i += 4) {
    const dr = Math.abs((leftPixels[i] ?? 0) - (rightPixels[i] ?? 0));
    const dg = Math.abs((leftPixels[i + 1] ?? 0) - (rightPixels[i + 1] ?? 0));
    const db = Math.abs((leftPixels[i + 2] ?? 0) - (rightPixels[i + 2] ?? 0));
    if (dr > maxChannelDelta) maxChannelDelta = dr;
    if (dg > maxChannelDelta) maxChannelDelta = dg;
    if (db > maxChannelDelta) maxChannelDelta = db;
  }

  const totalPixels = width * height;
  const diffPercent = diffPixelCount / totalPixels;

  // Step 7: aggregate cap (Layer B).
  if (diffPixelCount > threshold) {
    const detail: ParityThresholdDetail = {
      diffPixelCount,
      diffPercent,
      maxChannelDelta,
      threshold,
      perPixelThreshold,
    };
    return err<MetricError>({
      code: 'pixel-parity-threshold-exceeded',
      expected: expectedFor({ code: 'pixel-parity-threshold-exceeded' }),
      hint: hintFor({ code: 'pixel-parity-threshold-exceeded' }),
      detail,
    });
  }

  // Step 8: success path.
  const verdict: ParityVerdict = {
    diffPixelCount,
    diffPercent,
    maxChannelDelta,
    threshold,
    perPixelThreshold,
  };
  return ok<ParityVerdict>(verdict);
}

/**
 * Exhaustive `switch (code)` over the 6-member `MetricErrorCode` closed
 * union without a `default` branch. The two evaluator-internal call sites
 * (`expected` / `hint`) are the D-P9 real consumer site #1 — removing any
 * member from the union would surface a TS exhaustiveness error inside
 * this file (charter proposition 4 explicit failure + B-1 regression
 * prevention).
 *
 * Re-exported as `__test_expectedFor` / `__test_hintFor` below so the
 * .test.ts file can pin coverage on every union member (the 4 legacy
 * members are unreachable from the evaluateParity public API but still
 * need a TS exhaustiveness anchor — D-P9 keeps them in this switch so
 * minor-add of a member breaks the build here first).
 */
export function expectedFor(arg: { readonly code: MetricErrorCode }): string {
  switch (arg.code) {
    case 'metric-not-declared':
      return 'metric registration present in package.json#forgeax.metrics';
    case 'metric-kind-unknown':
      return 'metric kind belongs to the closed MetricKind union';
    case 'metric-status-not-ok':
      return 'dispatcher reports status=ok';
    case 'metric-schema-malformed':
      return 'schemas/forgeax-metrics.schema.json compiles as JSON Schema 2020-12';
    case 'pixel-parity-threshold-exceeded':
      return 'diffPixelCount <= threshold';
    case 'pixel-parity-capture-failed':
      return 'both pages capture Uint8Array(width * height * 4) with status=ok';
  }
}

export function hintFor(arg: { readonly code: MetricErrorCode }): string {
  switch (arg.code) {
    case 'metric-not-declared':
      return 'add package.json#forgeax.metrics declaration with all 5 MetricKind members';
    case 'metric-kind-unknown':
      return 'remove the unknown key from forgeax.metrics or fix the typo';
    case 'metric-status-not-ok':
      return 'inspect the offending report/<package>/<kind>.json for the value-vs-threshold delta';
    case 'metric-schema-malformed':
      return 'check schemas/forgeax-metrics.schema.json for unbalanced braces or missing $defs node';
    case 'pixel-parity-threshold-exceeded':
      return 'inspect git diff for shader / material / camera regressions; if driver noise, explicitly bump apps/parity/*/package.json#forgeax.metrics.bench.pixelDiff.threshold in a PR commit (append-only audit)';
    case 'pixel-parity-capture-failed':
      return 'inspect .detail.stage to localize the capture pipeline step; re-run pnpm bench:pixel-parity locally with --enable-unsafe-webgpu verified via chrome://gpu';
  }
}
