import { describe, expect, it, vi } from 'vitest';
import {
  type EncodeSourceInfo,
  encodeTextureToKtx2,
  MAX_ENCODE_SOURCE_PIXELS,
} from '../ktx2-encode.js';

/**
 * Encoder source-pixel fail-fast gate (CI-red fix, human decision).
 *
 * The wasm32 Basis encoder ceiling is 4096x4096 = 16.78 Mpx (MAX_ENCODE_SOURCE_PIXELS);
 * above it the raw encoder returns 0 bytes silently. `encodeTextureToKtx2` pre-checks
 * width*height and, when it exceeds the ceiling, returns a structured
 * `ktx2-encode-source-too-large` error WITHOUT calling the encoder -- so the failure is
 * actionable ("reduce resolution or set compressionMode:'none'") instead of an opaque
 * 0-byte encode failure. This test asserts both the boundary behavior and that the
 * encoder is never reached for an over-limit source.
 *
 * The over-limit path is exercised with a tiny buffer + explicit dimensions: the
 * pre-check only reads width*height, never the pixel bytes, so no real megapixel
 * allocation is needed and no WASM is loaded.
 */

// Spy on the codec encode binding: an over-limit source must never reach it.
const basisEncodeSpy = vi.fn();
vi.mock('@forgeax/engine-codec/encode', () => ({
  basisEncode: (...args: unknown[]) => basisEncodeSpy(...args),
}));

const SRGB: EncodeSourceInfo = { colorSpace: 'srgb', isHdr: false, mipmap: false };

describe('encodeTextureToKtx2 -- source-pixel ceiling fail-fast', () => {
  it('MAX_ENCODE_SOURCE_PIXELS is 4096x4096 (16.78 Mpx)', () => {
    expect(MAX_ENCODE_SOURCE_PIXELS).toBe(4096 * 4096);
    expect(MAX_ENCODE_SOURCE_PIXELS).toBe(16_777_216);
  });

  it('rejects a >4096^2 source with ktx2-encode-source-too-large, without calling the encoder', async () => {
    basisEncodeSpy.mockClear();
    // 8192x8192 = 67 Mpx, well over the ceiling. A 4-byte stub buffer suffices:
    // the pre-check reads only the dimensions.
    const r = await encodeTextureToKtx2(new Uint8Array(4), 8192, 8192, 'etc1s', SRGB);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('ktx2-encode-source-too-large');
    expect(r.error.mode).toBe('etc1s');
    expect(r.error.reason).toContain('8192x8192');
    expect(r.error.reason).toContain('4096x4096');
    expect(basisEncodeSpy).not.toHaveBeenCalled();
  });

  it('rejects the first over-limit size just past the ceiling (4097x4096)', async () => {
    basisEncodeSpy.mockClear();
    const r = await encodeTextureToKtx2(new Uint8Array(4), 4097, 4096, 'etc1s', SRGB);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('ktx2-encode-source-too-large');
    expect(basisEncodeSpy).not.toHaveBeenCalled();
  });

  it('an exactly-4096^2 source passes the ceiling and reaches the encoder', async () => {
    basisEncodeSpy.mockClear();
    basisEncodeSpy.mockResolvedValue({ ok: true, value: new Uint8Array([1, 2, 3]) });
    const r = await encodeTextureToKtx2(new Uint8Array(4), 4096, 4096, 'etc1s', SRGB);
    expect(basisEncodeSpy).toHaveBeenCalledTimes(1);
    // The stub bytes are not a KTX2, so the header read-back rejects them; the
    // ceiling itself did not.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'ktx2-encode-failed', mode: 'etc1s' });
  });

  it("the 'none' path still short-circuits before the ceiling check", async () => {
    basisEncodeSpy.mockClear();
    // Over-limit dimensions but mode 'none' -> resolves to null params first.
    const r = await encodeTextureToKtx2(new Uint8Array(4), 8192, 8192, 'none', SRGB);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('ktx2-encode-failed');
    expect(r.error.mode).toBe('none');
    expect(basisEncodeSpy).not.toHaveBeenCalled();
  });
});
