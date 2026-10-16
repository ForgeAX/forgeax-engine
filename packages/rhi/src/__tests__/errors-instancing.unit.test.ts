// feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / w8 — RhiErrorCode
// 21st member ('instancing-exceeds-uniform-cap') + .detail shape unit tests.
//
// Plan-strategy 2 D-2: closed RhiErrorCode add-only minor evolution; AC-05 (a)
// surface — RhiInstancingExceedsUniformCapDetail tagged union member with
// fields { requested: number, limit: 128, scope: 'sprite' | 'tilemap-chunk' }.
//
// AI-user contract (charter proposition 4 explicit failure + plan-strategy
// 8.3 actionable hint): consumers narrow .detail through property access
// (err.detail.requested / err.detail.limit / err.detail.scope) instead of
// parsing err.message string. The 128-instance cap originates from the
// uniform-fallback path's WebGL2 minimum 16384B UBO size — research N-1
// observed value (128 * 64B = 8192B leaves headroom for the per-frame
// material UBO slice). research F-4 + plan-decisions D-3 lock the limit.
//
// The runtime-shape assertions (sections 1 + 2) double as compile-time
// guarantees: if the union member or detail shape regress, tsc + vitest
// both flip red. Section 3 protects pre-existing 'limit-exceeded' detail
// from incidental drift (LimitExceededDetail must keep
// { maxStorageBufferBindingSize, requestedBytes } per
// feat-20260513-instanced-mesh M5 reshape).

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type LimitExceededDetail,
  RhiError,
  type RhiErrorCode,
  type RhiErrorDetail,
  type RhiInstancingExceedsUniformCapDetail,
} from '../errors';

describe('M2 / w8 — RhiErrorCode 21st member instancing-exceeds-uniform-cap', () => {
  it('contains instancing-exceeds-uniform-cap in the closed RhiErrorCode union', () => {
    expectTypeOf<'instancing-exceeds-uniform-cap'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('exhaustive switch over all 21 members compiles without default fallback', () => {
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
      // No default — tsc strict guards: union drift here triggers compile-time red.
    }
    expect(describeCode('instancing-exceeds-uniform-cap')).toBe('instancing-cap');
  });
});

describe('M2 / w8 — RhiInstancingExceedsUniformCapDetail shape', () => {
  it('detail equals { requested: number, limit: 128, scope: sprite|tilemap-chunk }', () => {
    expectTypeOf<RhiInstancingExceedsUniformCapDetail>().toEqualTypeOf<{
      readonly requested: number;
      readonly limit: 128;
      readonly scope: 'sprite' | 'tilemap-chunk';
    }>();
  });

  it('detail is a member of the RhiErrorDetail discriminated union', () => {
    const detail: RhiInstancingExceedsUniformCapDetail = {
      requested: 200,
      limit: 128,
      scope: 'sprite',
    };
    const widened: RhiErrorDetail = detail;
    expectTypeOf(widened).toMatchTypeOf<RhiErrorDetail>();
  });

  it('limit field is the literal 128, not a generic number', () => {
    // tsc will reject `limit: 256` etc. — locked to the literal 128.
    const detail: RhiInstancingExceedsUniformCapDetail = {
      requested: 1024,
      limit: 128,
      scope: 'tilemap-chunk',
    };
    expect(detail.limit).toBe(128);
    expectTypeOf<RhiInstancingExceedsUniformCapDetail['limit']>().toEqualTypeOf<128>();
  });

  it('scope field is the closed sprite | tilemap-chunk literal union', () => {
    expectTypeOf<RhiInstancingExceedsUniformCapDetail['scope']>().toEqualTypeOf<
      'sprite' | 'tilemap-chunk'
    >();
  });

  it('AI-user property-access consumption path: read .requested / .limit / .scope', () => {
    const err = new RhiError({
      code: 'instancing-exceeds-uniform-cap',
      expected: 'bucket instance count <= 128 (uniform fallback cap)',
      hint: 'reduce bucket size, switch to a WebGPU-capable backend, or accept per-cell fallback',
      detail: { requested: 256, limit: 128, scope: 'tilemap-chunk' },
    });
    expect(err.code).toBe('instancing-exceeds-uniform-cap');
    if (err.code === 'instancing-exceeds-uniform-cap') {
      // After narrowing on .code, .detail is reachable via property access
      // — no string parsing of err.message.
      const d = err.detail as RhiInstancingExceedsUniformCapDetail;
      expect(d.requested).toBe(256);
      expect(d.limit).toBe(128);
      expect(d.scope).toBe('tilemap-chunk');
    }
    expect(err.expected.length).toBeGreaterThan(0);
    expect(err.hint.length).toBeGreaterThan(0);
  });
});

describe('M2 / w8 — pre-existing limit-exceeded detail unchanged', () => {
  it('LimitExceededDetail keeps { maxStorageBufferBindingSize, requestedBytes }', () => {
    expectTypeOf<LimitExceededDetail>().toEqualTypeOf<{
      readonly maxStorageBufferBindingSize: number;
      readonly requestedBytes: number;
    }>();
  });

  it("'limit-exceeded' member remains in the closed union (no rename / reorder)", () => {
    expectTypeOf<'limit-exceeded'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('limit-exceeded and instancing-exceeds-uniform-cap are distinct members', () => {
    type Le = Extract<RhiErrorCode, 'limit-exceeded'>;
    type Ic = Extract<RhiErrorCode, 'instancing-exceeds-uniform-cap'>;
    expectTypeOf<Le>().not.toEqualTypeOf<Ic>();
  });
});
