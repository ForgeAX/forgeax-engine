import type { CodecErrorCode } from '@forgeax/engine-codec';
import { codecError, parseKtx2 } from '@forgeax/engine-codec';
import { describe, expect, it } from 'vitest';

/**
 * KTX2 scheme=1 pass-through + transcode-failed error unit tests (w10).
 *
 * (a) A byte-level scheme=1 (BasisLZ) KTX2 header parses successfully -- parseKtx2
 *     no longer rejects scheme=1 with ktx2-unsupported-scheme (F-1 single-point
 *     gate at ktx2.ts:308 opened for the Basis arm).
 * (b) A scheme=3 (ZLIB) header still rejects with ktx2-unsupported-scheme (the
 *     old rejection is preserved -- contract seam AC-11(c): extend, do not
 *     rewrite the container parser).
 * (c) The transcode-failed CodecError object carries .code / .detail (with the
 *     sourceFormat/targetFormat discriminant) / a non-empty actionable .hint
 *     (AC-10 add-only-minor union member).
 *
 * Does NOT execute real transcode (M5 integration test's job); this only builds
 * byte-level headers and inspects error object shape.
 */

const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function writeU32(out: Uint8Array, offset: number, value: number): void {
  new DataView(out.buffer, out.byteOffset + offset, 4).setUint32(0, value, true);
}

function writeU64(out: Uint8Array, offset: number, value: number): void {
  const lo = value >>> 0;
  const hi = (value - lo) / 0x100000000;
  new DataView(out.buffer, out.byteOffset + offset, 8).setUint32(0, lo, true);
  new DataView(out.buffer, out.byteOffset + offset + 4, 4).setUint32(0, hi, true);
}

/**
 * Build a minimal KTX2 header with the given supercompression scheme. The level
 * payload is a small opaque blob (not real Basis data -- parseKtx2 does not
 * interpret it). One level, no DFD / KV / SGD, so the parser exercises only the
 * header + level index + scheme gate.
 */
function buildHeaderFixture(scheme: number): Uint8Array {
  const W = 8;
  const H = 8;
  const payload = new Uint8Array(64);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + 3) & 0xff;

  // header(80) + level index (1 entry = 24) = 104; payload at 104
  const levelPayloadOffset = 104;
  const totalSize = levelPayloadOffset + payload.length;
  const buf = new Uint8Array(totalSize);

  buf.set(KTX2_IDENTIFIER, 0);
  writeU32(buf, 12, 0); // vkFormat = VK_FORMAT_UNDEFINED (Basis payload)
  writeU32(buf, 16, 1); // typeSize
  writeU32(buf, 20, W);
  writeU32(buf, 24, H);
  writeU32(buf, 28, 0);
  writeU32(buf, 32, 0);
  writeU32(buf, 36, 1);
  writeU32(buf, 40, 1); // levelCount
  writeU32(buf, 44, scheme); // supercompressionScheme

  // index: no DFD / KV / SGD
  writeU32(buf, 48, 0); // dfdByteOffset
  writeU32(buf, 52, 0); // dfdByteLength
  writeU32(buf, 56, 0); // kvdByteOffset
  writeU32(buf, 60, 0); // kvdByteLength
  writeU64(buf, 64, 0); // sgdByteOffset
  writeU64(buf, 72, 0); // sgdByteLength

  // level index (smallest-first; only 1 level)
  writeU64(buf, 80, levelPayloadOffset);
  writeU64(buf, 88, payload.length);
  writeU64(buf, 96, payload.length); // uncompressedByteLength

  buf.set(payload, levelPayloadOffset);
  return buf;
}

describe('parseKtx2 — scheme=1 (BasisLZ) pass-through (w10)', () => {
  it('scheme=1 parses successfully (no ktx2-unsupported-scheme)', async () => {
    const result = await parseKtx2(buildHeaderFixture(1));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
    expect(result.value.header.supercompressionScheme).toBe(1);
    expect(result.value.header.pixelWidth).toBe(8);
    expect(result.value.levelIndex.length).toBe(1);
  });

  it('scheme=0 still parses (regression guard)', async () => {
    const result = await parseKtx2(buildHeaderFixture(0));
    expect(result.ok).toBe(true);
  });

  it('scheme=2 still parses (regression guard)', async () => {
    const result = await parseKtx2(buildHeaderFixture(2));
    expect(result.ok).toBe(true);
  });
});

describe('parseKtx2 — scheme=3 (ZLIB) still rejected (w10)', () => {
  it('scheme=3 returns ktx2-unsupported-scheme echoing the scheme value', async () => {
    const result = await parseKtx2(buildHeaderFixture(3));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error.code).toBe('ktx2-unsupported-scheme');
    expect(result.error.detail).toEqual({ scheme: 3 });
  });

  it('scheme=4 (arbitrary future scheme) also rejected', async () => {
    const result = await parseKtx2(buildHeaderFixture(4));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error.code).toBe('ktx2-unsupported-scheme');
  });
});

describe('transcode-failed error object shape (AC-10, w10)', () => {
  it('code / detail (sourceFormat + targetFormat) / hint all present', () => {
    const err = codecError('transcode-failed', {
      sourceFormat: 'uastc-ldr',
      targetFormat: 'bc7-rgba-unorm',
    });
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('transcode-failed');
    expect(err.error.detail).toEqual({
      sourceFormat: 'uastc-ldr',
      targetFormat: 'bc7-rgba-unorm',
    });
    expect(typeof err.error.hint).toBe('string');
    expect(err.error.hint.length).toBeGreaterThan(0);
    expect(typeof err.error.expected).toBe('string');
    expect(err.error.expected.length).toBeGreaterThan(0);
  });

  it('transcode-failed is a member of the CodecErrorCode union', () => {
    const code: CodecErrorCode = 'transcode-failed';
    expect(code).toBe('transcode-failed');
  });

  it('pre-existing codes remain intact (add-only-minor, not a rewrite)', () => {
    const stillThere: CodecErrorCode[] = [
      'decompression-failed',
      'codec-init-failed',
      'ktx2-parse-failed',
      'ktx2-unsupported-scheme',
    ];
    for (const c of stillThere) {
      const e = codecError(c, dummyDetailFor(c));
      expect(e.error.code).toBe(c);
      expect(e.error.hint.length).toBeGreaterThan(0);
    }
  });
});

/** Build a minimal valid detail payload for each pre-existing code. */
function dummyDetailFor(code: CodecErrorCode): never {
  switch (code) {
    case 'decompression-failed':
      return { reason: 'test' } as never;
    case 'codec-init-failed':
      return { stage: 'test' } as never;
    case 'ktx2-parse-failed':
      return { reason: 'test' } as never;
    case 'ktx2-unsupported-scheme':
      return { scheme: 3 } as never;
    case 'transcode-failed':
      return { sourceFormat: 'uastc-ldr', targetFormat: 'bc7-rgba-unorm' } as never;
    case 'ktx2-encode-failed':
      return { mode: 'uastc-ldr', reason: 'test' } as never;
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
