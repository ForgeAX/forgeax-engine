// MVP-1.7 (type-level) — closed RhiErrorCode union completeness + exhaustive switch
// without default fallback. Round 1 baseline: 6 members; extended to 10 members in
// feat-20260508-rhi-surface-completion w7 (D-S3); extended to 14 members in
// feat-20260509-ecs-render-bridge-mvp w6 (D-S7); extended to 17 members in
// feat-20260511-rhi-spec-realign-aggressive w1 (red) -> w6 (green) per
// plan-strategy D-P4 + requirements AC-04. Three new members map W3C WebGPU
// 22.2 spec subtypes (device-lost / oom / internal-error) to the forgeax union.
// Extended to 20 members in feat-20260619-wasm-fault-isolation M3 w7:
// 'rhi-descriptor-invalid' for wgpu-wasm descriptor parse failures.
//
// 20 members:
//   1) 'adapter-unavailable'              (Round 1 baseline)
//   2) 'feature-not-enabled'              (Round 1 baseline)
//   3) 'limit-exceeded'                   (Round 1 baseline)
//   4) 'shader-compile-failed'            (Round 1 baseline)
//   5) 'rhi-not-available'                (Round 1 baseline; @reserved + placeholder)
//   6) 'webgpu-runtime-error'             (verify-gpu-smoke-gate K-9 sixth member)
//   7) 'command-encoder-finished'         (rhi-surface-completion D-S3)
//   8) 'render-pass-not-ended'            (rhi-surface-completion D-S3)
//   9) 'queue-submit-failed'              (rhi-surface-completion D-S3)
//  10) 'queue-write-buffer-out-of-bounds' (rhi-surface-completion D-S3)
//  11) 'render-system-no-camera'          (ecs-render-bridge-mvp D-S7)
//  12) 'render-system-multi-camera'       (ecs-render-bridge-mvp D-S7)
//  13) 'render-system-multi-light'        (ecs-render-bridge-mvp D-S7)
//  14) 'asset-not-registered'             (ecs-render-bridge-mvp D-S7)
//  15) 'device-lost'                      (rhi-spec-realign-aggressive D-P4 / R-02 §2.1)
//  16) 'oom'                              (rhi-spec-realign-aggressive D-P4 / R-02 §2.1)
//  17) 'internal-error'                   (rhi-spec-realign-aggressive D-P4 / R-02 §2.1)
//  18) 'hierarchy-broken'                 (asset-system-v1 w4 / D-P2 + requirements §9 row 8)
//  19) 'destroy-after-destroy'            (feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle M1 / D-6 + D-7)
//  20) 'rhi-descriptor-invalid'           (feat-20260619-wasm-fault-isolation M3 w7 / D-1 + D-2 + D-8)
//
// charter mapping: proposition 4 (explicit failure via closed union) +
// proposition 3 (machine-readable union > prose) — switch (err.code) without
// default fallback; tsc strict mode rejects union drift at compile time.
//
// Related: requirements AC-04 (18-member union) + AC MVP-1.7 + AC-10 + AC-RSC-07;
// plan-strategy D-P4 (.expected / .hint templates) + D-P2 (hierarchy-broken) +
// S-6 (types/rhi single source) + 7.2 naming convention; research R-02 §2.1
// (W3C spec 22.2 subtypes).

import { describe, expectTypeOf, it } from 'vitest';
import type { RhiError, RhiErrorCode } from '../errors';

describe('MVP-1.7 — RhiErrorCode closed union 20 members', () => {
  it('contains adapter-unavailable', () => {
    expectTypeOf<'adapter-unavailable'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains feature-not-enabled', () => {
    expectTypeOf<'feature-not-enabled'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains limit-exceeded', () => {
    expectTypeOf<'limit-exceeded'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains shader-compile-failed', () => {
    expectTypeOf<'shader-compile-failed'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains rhi-not-available (@reserved + placeholder methods)', () => {
    expectTypeOf<'rhi-not-available'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains webgpu-runtime-error (verify-gpu-smoke-gate K-9 sixth member)', () => {
    expectTypeOf<'webgpu-runtime-error'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains command-encoder-finished (D-S3 new member)', () => {
    expectTypeOf<'command-encoder-finished'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains render-pass-not-ended (D-S3 new member)', () => {
    expectTypeOf<'render-pass-not-ended'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains queue-submit-failed (D-S3 new member)', () => {
    expectTypeOf<'queue-submit-failed'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains queue-write-buffer-out-of-bounds (D-S3 new member)', () => {
    expectTypeOf<'queue-write-buffer-out-of-bounds'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains render-system-no-camera (D-S7 new member)', () => {
    expectTypeOf<'render-system-no-camera'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains render-system-multi-camera (D-S7 new member)', () => {
    expectTypeOf<'render-system-multi-camera'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains render-system-multi-light (D-S7 new member)', () => {
    expectTypeOf<'render-system-multi-light'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains asset-not-registered (D-S7 new member)', () => {
    expectTypeOf<'asset-not-registered'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains device-lost (D-P4 new member; spec 22.1 device lost)', () => {
    expectTypeOf<'device-lost'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains oom (D-P4 new member; spec 22.2 GPUOutOfMemoryError subtype)', () => {
    expectTypeOf<'oom'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains internal-error (D-P4 new member; spec 22.2 GPUInternalError subtype)', () => {
    expectTypeOf<'internal-error'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains hierarchy-broken (w4 asset-system-v1 D-P2 new member; propagateTransforms stale ChildOf ref)', () => {
    expectTypeOf<'hierarchy-broken'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains destroy-after-destroy (feat-20260612 M1 / D-6 + D-7; double destroy fail-fast)', () => {
    expectTypeOf<'destroy-after-destroy'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('contains rhi-descriptor-invalid (feat-20260619 M3 w7; wgpu-wasm descriptor parse failure)', () => {
    expectTypeOf<'rhi-descriptor-invalid'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('union remains closed: rejects non-member literal', () => {
    // @ts-expect-error MVP-1.7: union is closed — 'not-a-real-code' is not a member.
    const _bogus: RhiErrorCode = 'not-a-real-code';
    void _bogus;
  });

  it('exhaustive switch with no default fallback for all members (charter proposition 4)', () => {
    function describeCode(code: RhiErrorCode): string {
      switch (code) {
        case 'adapter-unavailable':
          return 'adapter';
        case 'feature-not-enabled':
          return 'feature';
        case 'limit-exceeded':
          return 'limit';
        case 'shader-compile-failed':
          return 'shader';
        case 'rhi-not-available':
          return 'reserved';
        case 'webgpu-runtime-error':
          return 'webgpu-runtime';
        case 'command-encoder-finished':
          return 'encoder-finished';
        case 'render-pass-not-ended':
          return 'pass-not-ended';
        case 'queue-submit-failed':
          return 'queue-submit';
        case 'queue-write-buffer-out-of-bounds':
          return 'queue-bounds';
        case 'render-system-no-camera':
          return 'no-camera';
        case 'render-system-multi-camera':
          return 'multi-camera';
        case 'render-system-multi-light':
          return 'multi-light';
        case 'asset-not-registered':
          return 'asset-miss';
        case 'device-lost':
          return 'device-lost';
        case 'oom':
          return 'oom';
        case 'internal-error':
          return 'internal-error';
        case 'hierarchy-broken':
          return 'hierarchy-broken';
        case 'destroy-after-destroy':
          return 'destroy-after-destroy';
        case 'rhi-descriptor-invalid':
          return 'descriptor-invalid';
        case 'instancing-exceeds-uniform-cap':
          return 'instancing-cap';
        case 'render-system-empty-worlds':
          return 'empty-worlds';
        case 'render-system-owner-out-of-range':
          return 'owner-oob';
        case 'rhi-texture-format-capability-unavailable':
          return 'texture-format-unavailable';
      }
      // No default — TS guards: union drift here triggers compile-time red.
    }
    expectTypeOf(describeCode).returns.toEqualTypeOf<string>();
  });

  it('RhiError.code literal type is exactly RhiErrorCode union', () => {
    expectTypeOf<RhiError['code']>().toEqualTypeOf<RhiErrorCode>();
  });

  it('RhiError has readonly code / expected / hint fields', () => {
    type ErrShape = {
      readonly code: RhiErrorCode;
      readonly expected: string;
      readonly hint: string;
    };
    expectTypeOf<RhiError>().toMatchTypeOf<ErrShape>();
  });
});
