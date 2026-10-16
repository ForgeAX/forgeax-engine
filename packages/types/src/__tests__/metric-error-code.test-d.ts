// Type-level — MetricErrorCode 6-member exhaustive switch + MetricErrorDetail
// per-code narrowing (M1 T-002 + D-P11).
//
// Assertions:
//   - `MetricErrorCode` resolves to exactly 6 string-literal members in the
//     order locked by AGENTS.md Error model table (4 legacy + 2 parity).
//   - A `switch (err.code)` block covering all 6 members without a `default:`
//     clause type-checks (tsc strict exhaustiveness guard) — proves charter
//     proposition 4 explicit-failure at the consumer site (research Finding 9
//     §6 g9 checklist item 4; B-1 regression-prevention as required by
//     requirements AC-05 + AC-11).
//   - `MetricError` is a discriminated union — narrowing on `.code` exposes
//     `.detail.diffPixelCount` autocomplete on the threshold-exceeded path
//     and `.detail.stage` on the capture-failed path (AI-user review F-1
//     IDE-autocomplete affordance; D-P11).
//
// Charter mapping: proposition 3 (machine-readable union > prose) +
// proposition 4 (explicit failure — exhaustive switch needs no default
// fallback) + proposition 5 (consistent abstraction — `.detail` discriminator
// mirrors `@forgeax/engine-rhi` `RhiErrorDetail` lines 165-189).

import { describe, expectTypeOf, it } from 'vitest';
import type {
  MetricError,
  MetricErrorCode,
  MetricErrorDetail,
  ParityCaptureDetail,
  ParityThresholdDetail,
} from '../index';

describe('MetricErrorCode — 6-member closed union (M1 T-002 / D-P3)', () => {
  it('contains the 4 legacy members verbatim', () => {
    expectTypeOf<'metric-not-declared'>().toExtend<MetricErrorCode>();
    expectTypeOf<'metric-kind-unknown'>().toExtend<MetricErrorCode>();
    expectTypeOf<'metric-status-not-ok'>().toExtend<MetricErrorCode>();
    expectTypeOf<'metric-schema-malformed'>().toExtend<MetricErrorCode>();
  });

  it('contains the 2 parity members appended at the bottom', () => {
    expectTypeOf<'pixel-parity-threshold-exceeded'>().toExtend<MetricErrorCode>();
    expectTypeOf<'pixel-parity-capture-failed'>().toExtend<MetricErrorCode>();
  });

  it('rejects unrelated strings outside the closed union (negative guard)', () => {
    // The string 'pixel-parity-diff-failed' was rejected at plan time
    // (D-P3 decision: pixelmatch-internal throw collapses into
    // 'pixel-parity-capture-failed' with `.detail.stage='diff'`, not a
    // third union member). Type-level guard ensures any future regression
    // re-introducing it would land here first.
    expectTypeOf<'pixel-parity-diff-failed'>().not.toExtend<MetricErrorCode>();
    expectTypeOf<'pixel-parity-rmse-over'>().not.toExtend<MetricErrorCode>();
  });
});

describe('MetricErrorCode — exhaustive switch with no default (B-1 regression-prevention)', () => {
  it('compiles a switch over all 6 members with no default branch', () => {
    // The dummy function below is the smallest possible "real consumer
    // site" the type-level test can encode. Removing any one case label
    // turns `never` assignment red (tsc strict + noFallthroughCasesInSwitch).
    function recover(code: MetricErrorCode): string {
      switch (code) {
        case 'metric-not-declared':
          return 'metric not declared';
        case 'metric-kind-unknown':
          return 'metric kind unknown';
        case 'metric-status-not-ok':
          return 'metric status not ok';
        case 'metric-schema-malformed':
          return 'metric schema malformed';
        case 'pixel-parity-threshold-exceeded':
          return 'pixel parity threshold exceeded';
        case 'pixel-parity-capture-failed':
          return 'pixel parity capture failed';
      }
      // Unreachable: every branch returns; tsc treats the bottom as `never`.
      // If we removed one case, the function would no longer return on
      // every path and tsc would surface the gap before this file ran.
    }
    expectTypeOf(recover).toBeFunction();
  });
});

describe('MetricError — per-code .detail narrowing (D-P11 / AI-user review F-1)', () => {
  it('narrows .detail to ParityThresholdDetail on the threshold-exceeded path', () => {
    function inspect(err: MetricError): number {
      if (err.code === 'pixel-parity-threshold-exceeded') {
        // err.detail must be ParityThresholdDetail here; AI-user reads
        // err.detail.diffPixelCount with full IDE autocomplete.
        expectTypeOf(err.detail).toEqualTypeOf<ParityThresholdDetail>();
        return err.detail.diffPixelCount;
      }
      return -1;
    }
    expectTypeOf(inspect).toBeFunction();
  });

  it('narrows .detail to ParityCaptureDetail on the capture-failed path', () => {
    function inspect(err: MetricError): string {
      if (err.code === 'pixel-parity-capture-failed') {
        expectTypeOf(err.detail).toEqualTypeOf<ParityCaptureDetail>();
        return err.detail.stage;
      }
      return '';
    }
    expectTypeOf(inspect).toBeFunction();
  });

  it('keeps .detail optional on the 4 legacy paths', () => {
    function inspect(err: MetricError): boolean {
      if (
        err.code === 'metric-not-declared' ||
        err.code === 'metric-kind-unknown' ||
        err.code === 'metric-status-not-ok' ||
        err.code === 'metric-schema-malformed'
      ) {
        // legacy paths: .detail is optional + carries `MetricLegacyDetail`
        // (effectively shape {} with optional .stage===undefined slot).
        return err.detail === undefined || err.detail.stage === undefined;
      }
      return false;
    }
    expectTypeOf(inspect).toBeFunction();
  });
});

describe('ParityThresholdDetail — verdict payload (D-P11 / plan-strategy §7.3)', () => {
  it('carries 5 numeric verdict fields', () => {
    expectTypeOf<ParityThresholdDetail['diffPixelCount']>().toEqualTypeOf<number>();
    expectTypeOf<ParityThresholdDetail['diffPercent']>().toEqualTypeOf<number>();
    expectTypeOf<ParityThresholdDetail['maxChannelDelta']>().toEqualTypeOf<number>();
    expectTypeOf<ParityThresholdDetail['threshold']>().toEqualTypeOf<number>();
    expectTypeOf<ParityThresholdDetail['perPixelThreshold']>().toEqualTypeOf<number>();
  });
});

describe('ParityCaptureDetail — staged capture failure (D-P11 / EC-06)', () => {
  it('carries a closed 5-member stage discriminator', () => {
    expectTypeOf<ParityCaptureDetail['stage']>().toEqualTypeOf<
      'chromium-launch' | 'vite-preview' | 'pixel-readback' | 'size-mismatch' | 'diff'
    >();
  });

  it('exposes optional leftSize / rightSize for the size-mismatch stage', () => {
    expectTypeOf<ParityCaptureDetail['leftSize']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ParityCaptureDetail['rightSize']>().toEqualTypeOf<number | undefined>();
  });
});

describe('MetricErrorDetail — discriminated-union family (D-P11)', () => {
  it('projects the complete non-optional detail family from MetricError', () => {
    expectTypeOf<MetricErrorDetail>().toEqualTypeOf<NonNullable<MetricError['detail']>>();
  });

  it('unifies legacy + threshold + capture variants', () => {
    expectTypeOf<ParityThresholdDetail>().toExtend<MetricErrorDetail>();
    expectTypeOf<ParityCaptureDetail>().toExtend<MetricErrorDetail>();
  });
});
