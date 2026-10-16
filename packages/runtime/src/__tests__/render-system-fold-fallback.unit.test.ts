// feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / w9 — fold-bucket
// uniform-cap fallback functional unit tests.
//
// AC-05 (b) runtime behaviour: when caps.storageBuffer===false and a fold
// bucket carries more than 128 instances, the engine fires a structured
// `RhiError(code='instancing-exceeds-uniform-cap')` AND falls the bucket
// back to per-entity drawIndexed (no identity-buffer collapse — see
// research F-4 / R-4 + plan-decisions D-9).
//
// Boundary matrix (plan-strategy 4 R-4):
//   storageBuffer=false, count=129 (just over cap)         -> error + fallback
//   storageBuffer=false, count=128 (at cap)                -> no error, fold
//   storageBuffer=false, count=129 scope='tilemap-chunk'   -> error + fallback
//   storageBuffer=true,  count=10000                       -> no error, fold
//   storageBuffer=false, singleton bucket (count=1)        -> no error path
//
// The fallback path is exposed as the pure helper
// `evaluateFoldBucketUniformCap(bucket, caps, scope)` co-located with
// `foldDispatchBuckets` in record/mesh-ssbo.ts: keeping it next to the
// bucket type definition lets the record-stage dispatch site (w11) call
// one branch instead of inlining the cap arithmetic, and lets this unit
// test drive the decision without booting recordFrame (D-9: shared
// fallback exit with the mode-gate bypass means the helper output is
// the SSOT for "should this bucket fold or fall back?").

import { RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  evaluateFoldBucketUniformCap,
  type FoldBucket,
} from '../../../render/src/record/mesh-ssbo';
import type { DispatchEntry } from '../../../render/src/render-system-extract';

const FOLD_UNIFORM_CAP = 128;

function mockBucket(count: number, materialHandle = 7, layer = 0): FoldBucket {
  const transforms = new Float32Array(count * 16);
  // Each instance: identity mat4 (only matters for runtime stride; assertion
  // is on bucket count, not transform values).
  for (let i = 0; i < count; i++) {
    transforms[i * 16 + 0] = 1;
    transforms[i * 16 + 5] = 1;
    transforms[i * 16 + 10] = 1;
    transforms[i * 16 + 15] = 1;
  }
  const entries: DispatchEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      entityIndex: i,
      materialHandle,
      renderableIndex: i,
      passIndex: 0,
      queue: 3000,
      layer,
      tags: {},
      renderState: undefined,
      defines: undefined,
      vertexEntry: undefined,
      fragmentEntry: undefined,
      materialShaderId: undefined,
      paramSnapshot: undefined,
    });
  }
  return {
    entries,
    bucketSize: count,
    transforms,
    materialHandle,
    layer,
    sortKey: 0,
  };
}

describe('M2 / w9 — fold-bucket uniform-cap fallback decision', () => {
  it('storageBuffer=false + count > 128 -> fallback=true with RhiError carrying detail', () => {
    const bucket = mockBucket(200);
    const decision = evaluateFoldBucketUniformCap(bucket, { storageBuffer: false }, 'sprite');
    expect(decision.fallback).toBe(true);
    expect(decision.error).toBeInstanceOf(RhiError);
    expect(decision.error?.code).toBe('instancing-exceeds-uniform-cap');
    if (decision.error?.code === 'instancing-exceeds-uniform-cap') {
      const d = decision.error.detail as
        | { requested: number; limit: 128; scope: 'sprite' | 'tilemap-chunk' }
        | undefined;
      expect(d?.requested).toBe(200);
      expect(d?.limit).toBe(FOLD_UNIFORM_CAP);
      expect(d?.scope).toBe('sprite');
    }
    expect(decision.error?.expected.length).toBeGreaterThan(0);
    expect(decision.error?.hint.length).toBeGreaterThan(0);
  });

  it('storageBuffer=false + count = 128 -> no fallback, no error (cap inclusive)', () => {
    const bucket = mockBucket(128);
    const decision = evaluateFoldBucketUniformCap(bucket, { storageBuffer: false }, 'sprite');
    expect(decision.fallback).toBe(false);
    expect(decision.error).toBeUndefined();
  });

  it('storageBuffer=false + count = 129 -> fallback fires (boundary just above cap)', () => {
    const bucket = mockBucket(129);
    const decision = evaluateFoldBucketUniformCap(
      bucket,
      { storageBuffer: false },
      'tilemap-chunk',
    );
    expect(decision.fallback).toBe(true);
    expect(decision.error?.code).toBe('instancing-exceeds-uniform-cap');
    if (decision.error?.code === 'instancing-exceeds-uniform-cap') {
      const d = decision.error.detail as
        | { requested: number; limit: 128; scope: 'sprite' | 'tilemap-chunk' }
        | undefined;
      expect(d?.scope).toBe('tilemap-chunk');
      expect(d?.requested).toBe(129);
    }
  });

  it('storageBuffer=true + count = 10_000 -> no fallback (WebGPU has no UBO cap)', () => {
    const bucket = mockBucket(10000);
    const decision = evaluateFoldBucketUniformCap(bucket, { storageBuffer: true }, 'sprite');
    expect(decision.fallback).toBe(false);
    expect(decision.error).toBeUndefined();
  });

  it('singleton bucket (bucketSize=1) -> no fallback regardless of caps', () => {
    const bucket = mockBucket(1);
    const decisionFalse = evaluateFoldBucketUniformCap(bucket, { storageBuffer: false }, 'sprite');
    const decisionTrue = evaluateFoldBucketUniformCap(bucket, { storageBuffer: true }, 'sprite');
    expect(decisionFalse.fallback).toBe(false);
    expect(decisionFalse.error).toBeUndefined();
    expect(decisionTrue.fallback).toBe(false);
    expect(decisionTrue.error).toBeUndefined();
  });

  it('scope is reflected verbatim in detail (no remapping)', () => {
    const bucketSprite = mockBucket(200);
    const bucketTilemap = mockBucket(200);
    const dSprite = evaluateFoldBucketUniformCap(bucketSprite, { storageBuffer: false }, 'sprite');
    const dTilemap = evaluateFoldBucketUniformCap(
      bucketTilemap,
      { storageBuffer: false },
      'tilemap-chunk',
    );
    if (dSprite.error?.code === 'instancing-exceeds-uniform-cap') {
      expect((dSprite.error.detail as { scope: string }).scope).toBe('sprite');
    }
    if (dTilemap.error?.code === 'instancing-exceeds-uniform-cap') {
      expect((dTilemap.error.detail as { scope: string }).scope).toBe('tilemap-chunk');
    }
  });
});
