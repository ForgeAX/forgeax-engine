import {
  selectTranscodeTarget,
  type TranscodeCaps,
  type TranscodeSource,
} from '@forgeax/engine-codec';
import { describe, expect, it } from 'vitest';

/**
 * selectTranscodeTarget priority-chain unit tests (w8).
 *
 * AC-04 application point: node imports the pure function directly and asserts
 * the returned GPUTextureFormat for each caps combination. No DOM / node:path
 * dependency is imported here -- that absence is the necessary evidence that the
 * function is browser+node dual-safe (the isolation gate proves the source side).
 *
 * The priority chains (plan-strategy §2 D-4 + requirements §range table):
 *   RGBA : ASTC-4x4 -> BC7 -> ETC2 -> RGBA8   (D-4: bc present => BC7 first)
 *   RG   : BC5 -> EAC-RG11 -> RG8             (D-4: bc present => BC5 first)
 *   R    : BC4 -> EAC-R11 -> R8               (D-4: bc present => BC4 first)
 *   HDR  : BC6H -> rgba16float
 *
 * srgb/linear only varies the RGBA color arm (data channels R/RG and HDR carry
 * no sRGB variant in WebGPU). The srgb flag is derived upstream from the DFD
 * transfer function; this function receives it as an explicit boolean.
 */

const BC_ONLY: TranscodeCaps = { bc: true, etc2: false, astc: false };
const ETC2_ONLY: TranscodeCaps = { bc: false, etc2: true, astc: false };
const ASTC_ONLY: TranscodeCaps = { bc: false, etc2: false, astc: true };
const NO_CAP: TranscodeCaps = { bc: false, etc2: false, astc: false };
const BC_AND_ETC2: TranscodeCaps = { bc: true, etc2: true, astc: false };
const BC_AND_ASTC: TranscodeCaps = { bc: true, etc2: false, astc: true };
const ASTC_AND_ETC2: TranscodeCaps = { bc: false, etc2: true, astc: true };

function ldrRgba(srgb: boolean): TranscodeSource {
  return { model: 'uastc-ldr', srgb, channels: 'rgba' };
}

describe('selectTranscodeTarget — LDR RGBA arm (w8)', () => {
  it('bc-only + srgb => bc7-rgba-unorm-srgb', () => {
    expect(selectTranscodeTarget(ldrRgba(true), BC_ONLY)).toBe('bc7-rgba-unorm-srgb');
  });

  it('bc-only + linear => bc7-rgba-unorm', () => {
    expect(selectTranscodeTarget(ldrRgba(false), BC_ONLY)).toBe('bc7-rgba-unorm');
  });

  it('etc2-only + srgb => etc2-rgba8unorm-srgb', () => {
    expect(selectTranscodeTarget(ldrRgba(true), ETC2_ONLY)).toBe('etc2-rgba8unorm-srgb');
  });

  it('etc2-only + linear => etc2-rgba8unorm', () => {
    expect(selectTranscodeTarget(ldrRgba(false), ETC2_ONLY)).toBe('etc2-rgba8unorm');
  });

  it('astc-only + srgb => astc-4x4-unorm-srgb', () => {
    expect(selectTranscodeTarget(ldrRgba(true), ASTC_ONLY)).toBe('astc-4x4-unorm-srgb');
  });

  it('astc-only + linear => astc-4x4-unorm', () => {
    expect(selectTranscodeTarget(ldrRgba(false), ASTC_ONLY)).toBe('astc-4x4-unorm');
  });

  it('no cap + srgb => rgba8unorm-srgb (fallback is a format, not an error)', () => {
    expect(selectTranscodeTarget(ldrRgba(true), NO_CAP)).toBe('rgba8unorm-srgb');
  });

  it('no cap + linear => rgba8unorm', () => {
    expect(selectTranscodeTarget(ldrRgba(false), NO_CAP)).toBe('rgba8unorm');
  });
});

describe('selectTranscodeTarget — D-4 Mesa guard: BC present => prefer BC (w8)', () => {
  it('bc+etc2 (Mesa software-decode trap) => bc7, NOT etc2', () => {
    const target = selectTranscodeTarget(ldrRgba(true), BC_AND_ETC2);
    expect(target).toBe('bc7-rgba-unorm-srgb');
    expect(target).not.toBe('etc2-rgba8unorm-srgb');
  });

  it('bc+astc (Apple Silicon dual hardware) => bc7, NOT astc', () => {
    const target = selectTranscodeTarget(ldrRgba(false), BC_AND_ASTC);
    expect(target).toBe('bc7-rgba-unorm');
    expect(target).not.toBe('astc-4x4-unorm');
  });

  it('astc+etc2 (no bc) follows table order ASTC before ETC2', () => {
    expect(selectTranscodeTarget(ldrRgba(true), ASTC_AND_ETC2)).toBe('astc-4x4-unorm-srgb');
  });
});

describe('selectTranscodeTarget — single/dual-channel arms (w8)', () => {
  const rg = (srgb: boolean): TranscodeSource => ({ model: 'uastc-ldr', srgb, channels: 'rg' });
  const r = (srgb: boolean): TranscodeSource => ({ model: 'uastc-ldr', srgb, channels: 'r' });

  it('RG bc-only => bc5-rg-unorm (no srgb variant even when srgb=true)', () => {
    expect(selectTranscodeTarget(rg(true), BC_ONLY)).toBe('bc5-rg-unorm');
    expect(selectTranscodeTarget(rg(false), BC_ONLY)).toBe('bc5-rg-unorm');
  });

  it('RG etc2-only => eac-rg11unorm', () => {
    expect(selectTranscodeTarget(rg(false), ETC2_ONLY)).toBe('eac-rg11unorm');
  });

  it('RG astc-only => rg8unorm (ASTC not in the RG chain)', () => {
    expect(selectTranscodeTarget(rg(false), ASTC_ONLY)).toBe('rg8unorm');
  });

  it('RG no cap => rg8unorm', () => {
    expect(selectTranscodeTarget(rg(false), NO_CAP)).toBe('rg8unorm');
  });

  it('RG bc+etc2 => bc5-rg-unorm (D-4 BC first)', () => {
    expect(selectTranscodeTarget(rg(false), BC_AND_ETC2)).toBe('bc5-rg-unorm');
  });

  it('R bc-only => bc4-r-unorm', () => {
    expect(selectTranscodeTarget(r(false), BC_ONLY)).toBe('bc4-r-unorm');
  });

  it('R etc2-only => eac-r11unorm', () => {
    expect(selectTranscodeTarget(r(false), ETC2_ONLY)).toBe('eac-r11unorm');
  });

  it('R astc-only => r8unorm (ASTC not in the R chain)', () => {
    expect(selectTranscodeTarget(r(false), ASTC_ONLY)).toBe('r8unorm');
  });

  it('R no cap => r8unorm', () => {
    expect(selectTranscodeTarget(r(false), NO_CAP)).toBe('r8unorm');
  });

  it('R bc+etc2 => bc4-r-unorm (D-4 BC first)', () => {
    expect(selectTranscodeTarget(r(false), BC_AND_ETC2)).toBe('bc4-r-unorm');
  });
});

describe('selectTranscodeTarget — HDR arm (w8)', () => {
  const hdr: TranscodeSource = { model: 'uastc-hdr', srgb: false, channels: 'rgba' };

  it('HDR bc-only => bc6h-rgb-ufloat', () => {
    expect(selectTranscodeTarget(hdr, BC_ONLY)).toBe('bc6h-rgb-ufloat');
  });

  it('HDR bc+etc2 => bc6h-rgb-ufloat (D-4 BC first)', () => {
    expect(selectTranscodeTarget(hdr, BC_AND_ETC2)).toBe('bc6h-rgb-ufloat');
  });

  it('HDR etc2-only => rgba16float (no bc; ASTC-HDR is OOS)', () => {
    expect(selectTranscodeTarget(hdr, ETC2_ONLY)).toBe('rgba16float');
  });

  it('HDR astc-only => rgba16float (no bc)', () => {
    expect(selectTranscodeTarget(hdr, ASTC_ONLY)).toBe('rgba16float');
  });

  it('HDR no cap => rgba16float', () => {
    expect(selectTranscodeTarget(hdr, NO_CAP)).toBe('rgba16float');
  });
});

describe('selectTranscodeTarget — ETC1S and UASTC-LDR share the LDR chain (w8)', () => {
  it('etc1s model routes through the same LDR RGBA arm as uastc-ldr', () => {
    const etc1s: TranscodeSource = { model: 'etc1s', srgb: true, channels: 'rgba' };
    expect(selectTranscodeTarget(etc1s, BC_ONLY)).toBe('bc7-rgba-unorm-srgb');
    expect(selectTranscodeTarget(etc1s, NO_CAP)).toBe('rgba8unorm-srgb');
  });
});
