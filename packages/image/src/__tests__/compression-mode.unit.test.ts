import { describe, expect, it } from 'vitest';
import { basisEncodeParamsFor, resolveEncodeMode } from '../ktx2-encode.js';

/**
 * compressionMode sidecar + 'auto' derivation unit tests (M3 w16).
 *
 * Tests the pure image-side derivation the offline encode arm relies on
 * (D-12), independent of the WASM encoder (round-trip bytes are w15's job;
 * import-texture wiring is w20's job; no browser DOM):
 *
 *   - the four sidecar values ('auto' / 'etc1s' / 'uastc' / 'none') each
 *     resolve to a delivery encoding;
 *   - 'auto' derives deterministically from existing sidecar signals (D-12):
 *     colorSpace 'srgb' -> ETC1S (albedo / UI), colorSpace 'linear' -> UASTC
 *     (normals / ORM / data), HDR source -> UASTC-HDR;
 *   - the 'none' path resolves to 'none' and yields NO encoder params (the
 *     importer keeps the existing .bin path -- the encoder is not called);
 *   - the encoder param mapping (basis tex format / srgb transfer flag / mip
 *     gen) is correct per resolved mode.
 *
 * Note (M3 sequencing constraint): 'auto' derivation is implemented + tested
 * here but is NOT the default value. The sidecar default stays 'none' until
 * M5 (w38) flips it -- this milestone must not make existing textures encode
 * to basis ahead of loader support (plan R-9).
 */

describe('resolveEncodeMode -- four sidecar values (M3 w16)', () => {
  it("explicit 'etc1s' resolves to etc1s", () => {
    expect(resolveEncodeMode('etc1s', { colorSpace: 'srgb', isHdr: false })).toBe('etc1s');
    expect(resolveEncodeMode('etc1s', { colorSpace: 'linear', isHdr: false })).toBe('etc1s');
  });

  it("explicit 'uastc' resolves to uastc (LDR) or uastc-hdr for an HDR source", () => {
    expect(resolveEncodeMode('uastc', { colorSpace: 'linear', isHdr: false })).toBe('uastc');
    expect(resolveEncodeMode('uastc', { colorSpace: 'srgb', isHdr: false })).toBe('uastc');
    expect(resolveEncodeMode('uastc', { colorSpace: 'linear', isHdr: true })).toBe('uastc-hdr');
  });

  it("explicit 'none' resolves to none", () => {
    expect(resolveEncodeMode('none', { colorSpace: 'srgb', isHdr: false })).toBe('none');
    expect(resolveEncodeMode('none', { colorSpace: 'linear', isHdr: true })).toBe('none');
  });
});

describe("resolveEncodeMode -- 'auto' derivation (D-12, M3 w16)", () => {
  it('srgb color source -> etc1s', () => {
    expect(resolveEncodeMode('auto', { colorSpace: 'srgb', isHdr: false })).toBe('etc1s');
  });

  it('linear (data) source -> uastc', () => {
    expect(resolveEncodeMode('auto', { colorSpace: 'linear', isHdr: false })).toBe('uastc');
  });

  it('HDR source -> uastc-hdr (regardless of colorSpace)', () => {
    expect(resolveEncodeMode('auto', { colorSpace: 'linear', isHdr: true })).toBe('uastc-hdr');
    expect(resolveEncodeMode('auto', { colorSpace: 'srgb', isHdr: true })).toBe('uastc-hdr');
  });
});

describe('basisEncodeParamsFor -- mode -> encoder params (M3 w16)', () => {
  it("'none' yields no encoder params (encoder is not called)", () => {
    expect(
      basisEncodeParamsFor('none', { colorSpace: 'srgb', isHdr: false, mipmap: false }),
    ).toBeNull();
  });

  it('etc1s maps to the ETC1S tex format with perceptual metrics for srgb color', () => {
    const p = basisEncodeParamsFor('etc1s', { colorSpace: 'srgb', isHdr: false, mipmap: false });
    expect(p).not.toBeNull();
    if (p === null) return;
    expect(p.mode).toBe('etc1s');
    expect(p.srgb).toBe(true);
    expect(p.perceptual).toBe(true);
    expect(p.uastcSupercompression).toBe(false);
    expect(p.mipGen).toBe(false);
  });

  it('etc1s on a linear source drops the srgb transfer + perceptual flags', () => {
    const p = basisEncodeParamsFor('etc1s', { colorSpace: 'linear', isHdr: false, mipmap: false });
    expect(p).not.toBeNull();
    if (p === null) return;
    expect(p.mode).toBe('etc1s');
    expect(p.srgb).toBe(false);
    expect(p.perceptual).toBe(false);
  });

  it('uastc maps to the UASTC-LDR tex format with zstd supercompression', () => {
    const p = basisEncodeParamsFor('uastc', { colorSpace: 'linear', isHdr: false, mipmap: false });
    expect(p).not.toBeNull();
    if (p === null) return;
    expect(p.mode).toBe('uastc-ldr');
    expect(p.srgb).toBe(false);
    expect(p.uastcSupercompression).toBe(true);
  });

  it("'uastc' on an HDR source maps to the UASTC-HDR tex format with no srgb transfer", () => {
    // 'uastc-hdr' is a derived delivery encoding, not a sidecar value; it is
    // reached via the 'uastc' (or 'auto') sidecar mode on an HDR source.
    const p = basisEncodeParamsFor('uastc', { colorSpace: 'linear', isHdr: true, mipmap: false });
    expect(p).not.toBeNull();
    if (p === null) return;
    expect(p.mode).toBe('uastc-hdr');
    expect(p.srgb).toBe(false);
    expect(p.uastcSupercompression).toBe(false);
  });

  it('a mipmapped source asks the encoder for the offline chain in every mode', () => {
    for (const mode of ['etc1s', 'uastc'] as const) {
      for (const isHdr of [false, true]) {
        const p = basisEncodeParamsFor(mode, { colorSpace: 'linear', isHdr, mipmap: true });
        expect(p?.mipGen).toBe(true);
      }
    }
  });
});
