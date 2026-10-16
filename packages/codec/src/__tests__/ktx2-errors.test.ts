import type { CodecErrorCode } from '@forgeax/engine-codec';
import { parseKtx2 } from '@forgeax/engine-codec';
import { describe, expect, it } from 'vitest';

/**
 * KTX2 2.0 identifier magic.
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
 * Build a minimal valid KTX2 header (no pixel data).
 * Used as base for constructing error fixtures.
 */
function buildMinimalHeader(supercompressionScheme: number, levelPayloadSize?: number): Uint8Array {
  const dfdBlockSize = 40;
  const dfdTotalSize = 4 + dfdBlockSize;
  const headerSize = 12 + 9 * 4 + 4 * 4 + 2 * 8 + 1 * 24; // 104

  const levelPayloadOffset = headerSize + dfdTotalSize + 0; // after DFD + empty KV
  const lpSize = levelPayloadSize ?? 16384;
  const totalSize = levelPayloadOffset + lpSize;

  const buf = new Uint8Array(totalSize);
  buf.set(KTX2_IDENTIFIER, 0);

  writeU32(buf, 12, 37); // vkFormat
  writeU32(buf, 16, 4);
  writeU32(buf, 20, 64);
  writeU32(buf, 24, 64);
  writeU32(buf, 28, 0);
  writeU32(buf, 32, 0);
  writeU32(buf, 36, 1);
  writeU32(buf, 40, 1);
  writeU32(buf, 44, supercompressionScheme);

  writeU32(buf, 48, headerSize); // dfdByteOffset
  writeU32(buf, 52, dfdTotalSize);
  writeU32(buf, 56, headerSize + dfdTotalSize); // kvdByteOffset
  writeU32(buf, 60, 0); // kvdByteLength = 0
  writeU64(buf, 64, 0); // sgdByteOffset
  writeU64(buf, 72, 0); // sgdByteLength

  writeU64(buf, 80, levelPayloadOffset);
  writeU64(buf, 88, lpSize);
  writeU64(buf, 96, lpSize); // uncompressedByteLength

  // DFD
  writeU32(buf, headerSize, dfdTotalSize);
  writeU32(buf, headerSize + 4, 0);
  writeU32(buf, headerSize + 8, (40 << 16) | 2);
  writeU32(buf, headerSize + 12, (1 << 16) | (1 << 8) | 1);
  writeU32(buf, headerSize + 16, 0);
  writeU32(buf, headerSize + 20, 4);
  writeU32(buf, headerSize + 24, 0);
  writeU32(buf, headerSize + 28, 7 << 12);
  writeU32(buf, headerSize + 32, 0);
  writeU32(buf, headerSize + 36, 0);
  writeU32(buf, headerSize + 40, 0xffffffff);

  return buf;
}

describe('KTX2 error paths (w23)', () => {
  describe('E5 — truncated header (falsification)', () => {
    it('11-byte truncated identifier returns ktx2-parse-failed', async () => {
      const truncated = new Uint8Array(11); // not even full 12B magic
      // Fill with garbage
      for (let i = 0; i < 11; i++) truncated[i] = 0xab;

      const result = await parseKtx2(truncated);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');

      expect(result.error.code).toBe('ktx2-parse-failed');
      expect((result.error.detail as { reason: string }).reason).toContain('truncated');
      expect(result.error.hint.length).toBeGreaterThan(0);
    });

    it('header cut short at 20 bytes (before supercompressionScheme) returns ktx2-parse-failed', async () => {
      // Copy first 20 bytes of a valid file (identifier + 2 u32s)
      const valid = buildMinimalHeader(0);
      const truncated = valid.slice(0, 20);

      const result = await parseKtx2(truncated);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('ktx2-parse-failed');
    });
  });

  describe('E5 — level index OOB', () => {
    it('level index byteOffset pointing beyond file end returns ktx2-parse-failed', async () => {
      // Build a valid file, then corrupt level index byteOffset to be huge
      const valid = buildMinimalHeader(0);
      // levelIndex[0].byteOffset is at offset 80, write a value > file.length
      writeU64(valid, 80, valid.length + 10000);

      const result = await parseKtx2(valid);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('ktx2-parse-failed');
      expect((result.error.detail as { reason: string }).reason).toContain('OOB');
    });

    it('level index byteLength exceeding file boundary returns ktx2-parse-failed', async () => {
      const valid = buildMinimalHeader(0);
      // level payload starts at offset 148 with 16384 bytes
      // Set byteLength to exceed remaining file
      writeU64(valid, 88, valid.length - 148 + 10000); // byteLength far beyond

      const result = await parseKtx2(valid);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('ktx2-parse-failed');
    });
  });

  describe('E5 — DFD truncated', () => {
    it('dfdByteLength exceeding file boundary returns ktx2-parse-failed', async () => {
      const valid = buildMinimalHeader(0);
      // dfdByteLength is at offset 52, set to exceed file size
      writeU32(valid, 52, valid.length + 1000);

      const result = await parseKtx2(valid);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('ktx2-parse-failed');
    });

    it('dfdByteOffset beyond EOF returns ktx2-parse-failed', async () => {
      const valid = buildMinimalHeader(0);
      writeU32(valid, 48, valid.length + 1000); // dfdByteOffset way past end

      const result = await parseKtx2(valid);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('ktx2-parse-failed');
    });
  });

  describe('E6 — unsupported supercompression scheme', () => {
    it('scheme=1 (BasisLZ) now parses (Loop 2 Basis transcode arm, F-1 gate opened)', async () => {
      // Loop 2 (w13) opened the single-point scheme gate for BasisLZ so the
      // Basis payload passes through to the transcode layer. scheme=1 is no
      // longer rejected; parseKtx2 does not interpret the payload itself.
      const valid = buildMinimalHeader(1);

      const result = await parseKtx2(valid);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
      expect(result.value.header.supercompressionScheme).toBe(1);
    });

    it('scheme=3 (ZLIB) returns ktx2-unsupported-scheme with scheme value', async () => {
      const valid = buildMinimalHeader(3);

      const result = await parseKtx2(valid);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('ktx2-unsupported-scheme');
      expect((result.error.detail as { scheme: number }).scheme).toBe(3);
    });

    it('scheme=999 (unknown) returns ktx2-unsupported-scheme', async () => {
      const valid = buildMinimalHeader(999);

      const result = await parseKtx2(valid);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('ktx2-unsupported-scheme');
      expect((result.error.detail as { scheme: number }).scheme).toBe(999);
    });
  });

  describe('E5 — invalid magic identifier', () => {
    it('wrong magic bytes returns ktx2-parse-failed', async () => {
      const valid = buildMinimalHeader(0);
      // Corrupt first byte of magic
      valid[0] = 0x00;

      const result = await parseKtx2(valid);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('ktx2-parse-failed');
    });
  });

  describe('Error code closed-union exhaustiveness', () => {
    it('all 6 CodecErrorCode members are reachable', () => {
      // Type-level check: verify the CodecErrorCode union has exactly 6 members.
      // This is validated by TS compilation — if a member is missing,
      // the following code fails to typecheck.
      const codes: CodecErrorCode[] = [
        'decompression-failed',
        'codec-init-failed',
        'ktx2-parse-failed',
        'ktx2-unsupported-scheme',
        'transcode-failed',
        'ktx2-encode-failed',
      ];
      expect(codes.length).toBe(6);

      // Verify exhaustive switch compiles (no default branch)
      for (const code of codes) {
        // TS ensures all cases are covered
        const _checked: string = (() => {
          switch (code) {
            case 'decompression-failed':
              return 'decompression-failed';
            case 'codec-init-failed':
              return 'codec-init-failed';
            case 'ktx2-parse-failed':
              return 'ktx2-parse-failed';
            case 'ktx2-unsupported-scheme':
              return 'ktx2-unsupported-scheme';
            case 'transcode-failed':
              return 'transcode-failed';
            case 'ktx2-encode-failed':
              return 'ktx2-encode-failed';
          }
        })();
        expect(typeof _checked).toBe('string');
      }
    });
  });
});
