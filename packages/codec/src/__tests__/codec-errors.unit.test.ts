import type { CodecError, CodecErrorCode } from '@forgeax/engine-codec';
import { codecError, decompressZstd } from '@forgeax/engine-codec';
import { describe, expect, it } from 'vitest';

// ============================================================================
// Unit tests for codec error shapes (w4)
// ============================================================================

describe('codec error paths (w4)', () => {
  // --- decompression-failed (E2) ---

  it('decompression-failed error has correct shape (E2)', async () => {
    // Garbage bytes should trigger decompression-failed in the real impl.
    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const result = await decompressZstd(garbage);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected error result for garbage input');
    }
    expect(result.error.code).toBe('decompression-failed');
    expect(typeof result.error.hint).toBe('string');
    expect(result.error.hint.length).toBeGreaterThan(0);
    expect(result.error.detail).toBeDefined();
    // detail narrowed per code: reason field
    expect(typeof (result.error.detail as { reason: string }).reason).toBe('string');
  });

  // --- codec-init-failed (E3) ---

  it('codec-init-failed error shape via factory function', () => {
    // Verify the factory produces correct shape (used when dynamic import fails).
    // We test the factory directly since simulating dynamic import failure
    // is fragile across bundlers.
    const err = codecError('codec-init-failed', { stage: 'dynamic-import-fzstd' });
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('codec-init-failed');
    expect(typeof err.error.hint).toBe('string');
    expect(err.error.hint.length).toBeGreaterThan(0);
    expect(err.error.detail).toEqual({ stage: 'dynamic-import-fzstd' });
  });

  // --- closed union exhaustiveness (compile-time check) ---

  it('switch on CodecErrorCode is exhaustive (no default)', () => {
    // This test compiles only if all union members are covered.
    // If a member is added to CodecErrorCode and not handled here,
    // TypeScript will emit a type error — this IS the test.
    function handleCode(code: CodecErrorCode): string {
      switch (code) {
        case 'decompression-failed':
          return 'decompression';
        case 'codec-init-failed':
          return 'init';
        case 'ktx2-parse-failed':
          return 'ktx2-parse';
        case 'ktx2-unsupported-scheme':
          return 'ktx2-unsupported';
        case 'transcode-failed':
          return 'transcode';
        case 'ktx2-encode-failed':
          return 'ktx2-encode';
      }
    }
    // If we got here, exhaustive switch compiled without TS error.
    // Verify all 6 codes produce distinct strings (not a degenerate pass-through).
    const handled = [
      handleCode('decompression-failed'),
      handleCode('codec-init-failed'),
      handleCode('ktx2-parse-failed'),
      handleCode('ktx2-unsupported-scheme'),
      handleCode('transcode-failed'),
      handleCode('ktx2-encode-failed'),
    ];
    expect(handled.length).toBe(6);
    expect(new Set(handled).size).toBe(6); // all distinct
  });

  // --- ktx2-parse-failed shape via factory ---

  it('ktx2-parse-failed error shape via factory', () => {
    const err = codecError('ktx2-parse-failed', { reason: 'truncated-identifier' });
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('ktx2-parse-failed');
    expect(typeof err.error.hint).toBe('string');
    expect(err.error.hint.length).toBeGreaterThan(0);
    expect(err.error.detail).toEqual({ reason: 'truncated-identifier' });
  });

  // --- ktx2-unsupported-scheme shape via factory ---

  it('ktx2-unsupported-scheme error shape via factory', () => {
    const err = codecError('ktx2-unsupported-scheme', { scheme: 1 });
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('ktx2-unsupported-scheme');
    expect(typeof err.error.hint).toBe('string');
    expect(err.error.hint.length).toBeGreaterThan(0);
    expect(err.error.detail).toEqual({ scheme: 1 });
  });

  // --- Result shape consistency ---

  it('CodecError type is structurally consistent', () => {
    // Verify that the CodecError type compiles with all 6 codes and preserves
    // each code-specific payload at runtime.
    const errors: CodecError[] = [
      codecError('decompression-failed', { reason: 'test' }),
      codecError('codec-init-failed', { stage: 'test' }),
      codecError('ktx2-parse-failed', { reason: 'test' }),
      codecError('ktx2-unsupported-scheme', { scheme: 0 }),
      codecError('transcode-failed', {
        sourceFormat: 'uastc-ldr',
        targetFormat: 'bc7-rgba-unorm',
      }),
      codecError('ktx2-encode-failed', { mode: 'uastc-ldr', reason: 'test' }),
    ];
    expect(errors).toHaveLength(6);
    expect(errors.every((error) => error.error.expected.length > 0)).toBe(true);
    expect(errors.every((error) => error.error.hint.length > 0)).toBe(true);
    expect(errors.map((error) => error.error.detail)).toEqual([
      { reason: 'test' },
      { stage: 'test' },
      { reason: 'test' },
      { scheme: 0 },
      { sourceFormat: 'uastc-ldr', targetFormat: 'bc7-rgba-unorm' },
      { mode: 'uastc-ldr', reason: 'test' },
    ]);
  });
});
