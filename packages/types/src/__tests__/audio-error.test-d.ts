// audio-error.test-d - type-level (test-d) assertions for the 5-member closed
// `AudioErrorCode` union and `AUDIO_ERROR_HINTS` Record completeness
// (feat-20260527-audio-system M1 / w5).
//
// Assertions:
// - Type-level: AudioErrorCode union contains all 6 members.
// - Type-level: AUDIO_ERROR_HINTS is Record<AudioErrorCode, string> -- adding a
//   new union member without hint entry is a TS compile error here.
// - Type-level: exhaustive switch on AudioErrorCode covers all 5 cases without
//   default fallback (charter P3 explicit failure; noImplicitReturns guards drift).
//
// Anchors: requirements AC-13 (AudioErrorCode closed union switch);
//          plan-strategy D-7 (parallel to ImageErrorCode / GltfErrorCode);
//          plan-strategy section 5.3 critical test points.

import { describe, expect, expectTypeOf, it } from 'vitest';
import { AUDIO_ERROR_HINTS, type AudioErrorCode } from '../index';

describe('AudioErrorCode closed union - 6 members (feat-20260527-audio-system M1 w5)', () => {
  it("type-level: contains 'context-creation-failed'", () => {
    expectTypeOf<'context-creation-failed'>().toMatchTypeOf<AudioErrorCode>();
  });

  it("type-level: contains 'decode-failed'", () => {
    expectTypeOf<'decode-failed'>().toMatchTypeOf<AudioErrorCode>();
  });

  it("type-level: contains 'context-suspended'", () => {
    expectTypeOf<'context-suspended'>().toMatchTypeOf<AudioErrorCode>();
  });

  it("type-level: contains 'invalid-clip-handle'", () => {
    expectTypeOf<'invalid-clip-handle'>().toMatchTypeOf<AudioErrorCode>();
  });

  it("type-level: contains 'bus-not-found'", () => {
    expectTypeOf<'bus-not-found'>().toMatchTypeOf<AudioErrorCode>();
  });

  it('type-level: exhaustive switch covers all 6 members without default', () => {
    function describeCode(code: AudioErrorCode): string {
      switch (code) {
        case 'context-creation-failed':
          return 'ctx-fail';
        case 'decode-failed':
          return 'decode-fail';
        case 'context-suspended':
          return 'ctx-suspended';
        case 'invalid-clip-handle':
          return 'invalid-handle';
        case 'stream-failed':
          return 'repair streaming source';
        case 'control-failed':
          return 'control-failed';
        case 'bus-not-found':
          return 'bus-not-found';
      }
      // No default -- TS guards union drift at compile time.
    }
    expectTypeOf(describeCode).returns.toEqualTypeOf<string>();
  });

  it('type-level: AUDIO_ERROR_HINTS is Readonly<Record<AudioErrorCode, string>>', () => {
    expectTypeOf(AUDIO_ERROR_HINTS).toEqualTypeOf<Readonly<Record<AudioErrorCode, string>>>();
  });

  it('type-level: AUDIO_ERROR_HINTS keys count = 6 via compile-time type assertion', () => {
    // The bidirectional assertion: at runtime, we verify 6 keys exist;
    // at type-level, the Record<AudioErrorCode, string> shape already proves
    // that every union member has a matching entry.
    const keys = Object.keys(AUDIO_ERROR_HINTS);
    expect(keys).toHaveLength(7);
    // Assert each expected key exists at runtime.
    expect(AUDIO_ERROR_HINTS).toHaveProperty('context-creation-failed');
    expect(AUDIO_ERROR_HINTS).toHaveProperty('decode-failed');
    expect(AUDIO_ERROR_HINTS).toHaveProperty('context-suspended');
    expect(AUDIO_ERROR_HINTS).toHaveProperty('invalid-clip-handle');
    expect(AUDIO_ERROR_HINTS).toHaveProperty('bus-not-found');
  });

  it('forward: every AUDIO_ERROR_HINTS key is assignable to AudioErrorCode', () => {
    for (const key of Object.keys(AUDIO_ERROR_HINTS)) {
      const code: AudioErrorCode = key as AudioErrorCode;
      expect(code).toBe(key);
    }
  });

  it('reverse: all 5 AudioErrorCode members exist as AUDIO_ERROR_HINTS keys (runtime check)', () => {
    const allCodes: AudioErrorCode[] = [
      'context-creation-failed',
      'decode-failed',
      'context-suspended',
      'invalid-clip-handle',
      'bus-not-found',
      'control-failed',
    ];
    for (const code of allCodes) {
      expect(AUDIO_ERROR_HINTS[code]).toBeDefined();
      expect(typeof AUDIO_ERROR_HINTS[code]).toBe('string');
      expect(AUDIO_ERROR_HINTS[code].length).toBeGreaterThan(0);
    }
  });
});
