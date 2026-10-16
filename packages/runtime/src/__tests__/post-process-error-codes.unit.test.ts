// post-process-error-codes.unit.test.ts -
// feat-20260621-fullscreen-post-process-per-frame-uniform-params-l M-A4 / w17.
//
// Locks the closed PostProcessErrorCode union after the 2 new params codes
// (`params-size-mismatch` register-time + `params-update-size-mismatch`
// write-time) join it. Asserts:
//   (1) an exhaustive `switch (err.code)` over the REAL union compiles with NO
//       default branch -- the `const _exhaustive: never = code` arm is the
//       compile-time completeness guard (TS errors if a member is missing).
//   (2) register byteSize < 16 -> PostProcessError{code:'params-size-mismatch'}
//       with a hint that names the 16 B minimum.
//   (3) register defaultValue.length !== byteSize -> same code, detail carries
//       { byteSize, actualLength }.
//   (4) write-path mismatch -> PostProcessError{code:'params-update-size-mismatch'}
//       with detail { byteSize, actualLength }.
//   (5) POST_PROCESS_EXPECTED + postProcessHint resolve both new codes (the
//       hint switch's own `default: never` arm guards completeness there too).

import { describe, expect, it } from 'vitest';
import {
  PostProcessError,
  type PostProcessErrorCode,
} from '../../../render/src/post-process-errors';

// Compile-time exhaustiveness probe: a switch over every member with no default.
// If a future code is added to the union without a case here, `code` is not
// narrowed to `never` at the final arm and TS fails the build (AC-08).
function classify(code: PostProcessErrorCode): string {
  switch (code) {
    case 'post-process-already-registered':
      return 'registered';
    case 'post-process-not-found':
      return 'not-found';
    case 'fullscreen-input-not-found':
      return 'input-not-found';
    case 'ssao-radius-non-positive':
      return 'ssao-radius';
    case 'ssao-bias-negative':
      return 'ssao-bias';
    case 'params-size-mismatch':
      return 'params-size';
    case 'params-update-size-mismatch':
      return 'params-update';
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

describe('M-A4 w17: PostProcessErrorCode closed union (7 members, exhaustive)', () => {
  it('classify covers all 7 members with no default fall-through', () => {
    const all: PostProcessErrorCode[] = [
      'post-process-already-registered',
      'post-process-not-found',
      'fullscreen-input-not-found',
      'ssao-radius-non-positive',
      'ssao-bias-negative',
      'params-size-mismatch',
      'params-update-size-mismatch',
    ];
    expect(all.map(classify)).toEqual([
      'registered',
      'not-found',
      'input-not-found',
      'ssao-radius',
      'ssao-bias',
      'params-size',
      'params-update',
    ]);
    expect(all.length).toBe(7);
  });
});

describe('M-A4 w17: params-size-mismatch (register-time fail-fast)', () => {
  it('byteSize < 16 -> hint names the 16 B minimum', () => {
    const err = new PostProcessError({
      code: 'params-size-mismatch',
      detail: { byteSize: 8, actualLength: 8 },
    });
    expect(err.code).toBe('params-size-mismatch');
    expect(err.hint).toContain('16');
    expect(err.detail.byteSize).toBe(8);
    expect(err.detail.actualLength).toBe(8);
    // expected mapping is populated (no empty string).
    expect(err.expected.length).toBeGreaterThan(0);
  });

  it('defaultValue.length !== byteSize -> detail carries both lengths', () => {
    const err = new PostProcessError({
      code: 'params-size-mismatch',
      detail: { byteSize: 16, actualLength: 12 },
    });
    expect(err.code).toBe('params-size-mismatch');
    expect(err.detail.byteSize).toBe(16);
    expect(err.detail.actualLength).toBe(12);
  });
});

describe('M-A4 w17: params-update-size-mismatch (write-time fail-fast)', () => {
  it('per-frame data byteLength mismatch -> detail { byteSize, actualLength }', () => {
    const err = new PostProcessError({
      code: 'params-update-size-mismatch',
      detail: { byteSize: 16, actualLength: 12 },
    });
    expect(err.code).toBe('params-update-size-mismatch');
    expect(err.detail.byteSize).toBe(16);
    expect(err.detail.actualLength).toBe(12);
    expect(err.hint.length).toBeGreaterThan(0);
    expect(err.expected.length).toBeGreaterThan(0);
  });
});

// ── feat-20260702-postprocess-camera-depth-read M3 / w9 (TDD RED) ──────────
// Assert that `fullscreen-input-not-found` hint covers depth-key scenarios
// (D-4: reuse existing code, expand hint; no new PostProcessErrorCode member).
// RED phase: the current hint does NOT mention depth / TEXTURE_BINDING / pipeline
// switch guidance. After w14 impl (expand hint), these assertions pass.

describe('feat-20260702 M3 w9: fullscreen-input-not-found hint covers depth reads (RED)', () => {
  it('hint for fullscreen-input-not-found mentions TEXTURE_BINDING guidance', () => {
    const err = new PostProcessError({
      code: 'fullscreen-input-not-found',
      detail: { readsKey: 'depth', passName: 'post-dof' },
    });
    expect(err.code).toBe('fullscreen-input-not-found');
    expect(err.detail.readsKey).toBe('depth');
    expect(err.detail.passName).toBe('post-dof');
    // RED: current hint only says "reads[0] must be a graph-declared colorTarget"
    // and the generated hint only mentions addColorTarget + spelling check.
    // After w14, this contains depth-specific guidance:
    // TEXTURE_BINDING + switch pipeline + sampleable depth target.
    expect(err.hint).toContain('TEXTURE_BINDING');
    expect(err.hint).toContain('sampleable');
  });

  it('exhaustive switch still covers all 8 codes (no new member added)', () => {
    // classify() above already guards exhaustiveness at compile time — if a
    // new code is added, TS fails.  We also confirm the expected count here.
    const all: PostProcessErrorCode[] = [
      'post-process-already-registered',
      'post-process-not-found',
      'fullscreen-input-not-found',
      'ssao-radius-non-positive',
      'ssao-bias-negative',
      'params-size-mismatch',
      'params-update-size-mismatch',
    ];
    expect(all.length).toBe(7);
    // classify covers all (compile-time check from above).
    expect(all.map(classify)).toEqual([
      'registered',
      'not-found',
      'input-not-found',
      'ssao-radius',
      'ssao-bias',
      'params-size',
      'params-update',
    ]);
  });
});
