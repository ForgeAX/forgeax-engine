/**
 * KTX2 2.0 container parser (per spec 2026-07-07-ktx2-container-binary-spec.md).
 *
 * Parses header + index + level index + DFD + KV metadata + SGD.
 * Does NOT interpret block-compressed payload content (OOS-6, Loop 2).
 *
 * scheme=2 (Zstandard) level decode reuses decompressZstd (AC-04 single implementation).
 */

import type { CodecResult } from './errors.js';
import { codecError } from './errors.js';
import { decompressZstd } from './zstd.js';

/**
 * KTX2 2.0 identifier magic (12 bytes per spec section 1).
 * «KTX 20»\r\n\x1A\n
 */
export const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Ktx2Header {
  readonly vkFormat: number;
  readonly typeSize: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly pixelDepth: number;
  readonly layerCount: number;
  readonly faceCount: number;
  readonly levelCount: number;
  readonly supercompressionScheme: number;
}

export interface Ktx2Index {
  readonly dfdByteOffset: number;
  readonly dfdByteLength: number;
  readonly kvdByteOffset: number;
  readonly kvdByteLength: number;
  readonly sgdByteOffset: number;
  readonly sgdByteLength: number;
}

export interface Ktx2LevelEntry {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly uncompressedByteLength: number;
}

export interface Ktx2DfdSample {
  readonly bitOffset: number;
  readonly bitLength: number;
  readonly channelType: number;
  readonly qualifiers: number;
  readonly samplePosition: readonly [number, number, number, number];
  readonly sampleLower: number;
  readonly sampleUpper: number;
}

export interface Ktx2Dfd {
  readonly totalSize: number;
  readonly vendorId: number;
  readonly descriptorType: number;
  readonly versionNumber: number;
  readonly descriptorBlockSize: number;
  readonly colorModel: number;
  readonly colorPrimaries: number;
  readonly transferFunction: number;
  readonly flags: number;
  readonly texelBlockDimension: readonly [number, number, number, number];
  readonly bytesPlane: readonly number[];
  readonly samples: readonly Ktx2DfdSample[];
}

export interface Ktx2KvEntry {
  readonly key: string;
  readonly value: Uint8Array;
}

/** Fully parsed KTX2 container structure (five parts per AC-03). */
export interface Ktx2Parsed {
  readonly header: Ktx2Header;
  readonly index: Ktx2Index;
  /** Level index entries, stored smallest-first per KTX2 spec section 8. */
  readonly levelIndex: readonly Ktx2LevelEntry[];
  readonly dfd: Ktx2Dfd | null;
  readonly kvEntries: readonly Ktx2KvEntry[];
  readonly sgd: Uint8Array | null;
  /**
   * Reference to the raw source bytes. Carried so ktx2LevelsToRGBA can
   * extract level payloads without requiring a second argument.
   */
  readonly rawBytes: Uint8Array;
}

/**
 * Project the KTX2 DFD transfer function into the engine texture color
 * contract. The DFD is the container's single color authority: callers must
 * not maintain a second descriptor-side color field.
 */
export function ktx2ColorSpace(parsed: Ktx2Parsed): 'srgb' | 'linear' | undefined {
  switch (parsed.dfd?.transferFunction) {
    case 1:
      return 'linear';
    case 2:
      return 'srgb';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — little-endian reads
// ---------------------------------------------------------------------------

const TD = new TextDecoder();

function readU32(bytes: Uint8Array, byteOffset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + byteOffset, 4).getUint32(0, true);
}

/** Read u64 LE as Number (safe for values < 2^53; all KTX2 offsets fit). */
function readU64(bytes: Uint8Array, byteOffset: number): number {
  return Number(new DataView(bytes.buffer, bytes.byteOffset + byteOffset, 8).getBigUint64(0, true));
}

/** Check that offset + length is within the byte array; throw if not. */
function assertBounds(bytes: Uint8Array, offset: number, length: number, context: string): void {
  if (offset + length > bytes.length) {
    throw new Error(
      `KTX2 parse ${context}: OOB (offset=${offset}, length=${length}, fileSize=${bytes.length})`,
    );
  }
}

// ---------------------------------------------------------------------------
// DFD parser (spec sections 5.1-5.3)
// ---------------------------------------------------------------------------

function parseDfd(bytes: Uint8Array, offset: number, _dfdByteLength: number): Ktx2Dfd {
  assertBounds(bytes, offset, 4, 'DFD-totalSize');
  const totalSize = readU32(bytes, offset);
  assertBounds(bytes, offset, totalSize, 'DFD-block');

  // Descriptor block starts at offset+4 (after dfdTotalSize)
  const dbOff = offset + 4;

  const word0 = readU32(bytes, dbOff);
  const vendorId = word0 & 0x1ffff;
  const descriptorType = (word0 >>> 17) & 0x7fff;

  const word1 = readU32(bytes, dbOff + 4);
  const versionNumber = word1 & 0xffff;
  const descriptorBlockSize = (word1 >>> 16) & 0xffff;

  const word2 = readU32(bytes, dbOff + 8);
  const colorModel = word2 & 0xff;
  const colorPrimaries = (word2 >>> 8) & 0xff;
  const transferFunction = (word2 >>> 16) & 0xff;
  const flags = (word2 >>> 24) & 0xff;

  const word3 = readU32(bytes, dbOff + 12);
  const texelBlockDim0 = word3 & 0xff;
  const texelBlockDim1 = (word3 >>> 8) & 0xff;
  const texelBlockDim2 = (word3 >>> 16) & 0xff;
  const texelBlockDim3 = (word3 >>> 24) & 0xff;

  const word4 = readU32(bytes, dbOff + 16);
  const word5 = readU32(bytes, dbOff + 20);
  const bytesPlane: readonly number[] = [
    word4 & 0xff,
    (word4 >>> 8) & 0xff,
    (word4 >>> 16) & 0xff,
    (word4 >>> 24) & 0xff,
    word5 & 0xff,
    (word5 >>> 8) & 0xff,
    (word5 >>> 16) & 0xff,
    (word5 >>> 24) & 0xff,
  ];

  // Samples: each 16 bytes = 4 u32 words, after 24-byte descriptor header
  const sampleBase = dbOff + 24;
  const numSamples = (descriptorBlockSize - 24) / 16;
  const samples: Ktx2DfdSample[] = [];
  for (let i = 0; i < numSamples; i++) {
    const so = sampleBase + i * 16;
    const sw0 = readU32(bytes, so);
    const sw1 = readU32(bytes, so + 4);
    const sw2 = readU32(bytes, so + 8);
    const sw3 = readU32(bytes, so + 12);

    samples.push({
      qualifiers: sw0 & 0xf,
      channelType: (sw0 >>> 4) & 0xff,
      bitLength: ((sw0 >>> 12) & 0xfff) + 1, // stored as actual-1 per spec
      bitOffset: (sw0 >>> 24) & 0xff,
      samplePosition: [
        sw1 & 0xff,
        (sw1 >>> 8) & 0xff,
        (sw1 >>> 16) & 0xff,
        (sw1 >>> 24) & 0xff,
      ] as const,
      sampleLower: sw2,
      sampleUpper: sw3,
    });
  }

  return {
    totalSize,
    vendorId,
    descriptorType,
    versionNumber,
    descriptorBlockSize,
    colorModel,
    colorPrimaries,
    transferFunction,
    flags,
    texelBlockDimension: [texelBlockDim0, texelBlockDim1, texelBlockDim2, texelBlockDim3] as const,
    bytesPlane,
    samples,
  };
}

// ---------------------------------------------------------------------------
// KV metadata parser (spec section 6)
// ---------------------------------------------------------------------------

function parseKv(bytes: Uint8Array, offset: number, kvdByteLength: number): Ktx2KvEntry[] {
  if (kvdByteLength === 0) return [];

  const entries: Ktx2KvEntry[] = [];
  let pos = offset;
  const end = offset + kvdByteLength;

  while (pos < end) {
    assertBounds(bytes, pos, 4, 'KV-keyAndValueByteLength');
    const keyAndValueByteLength = readU32(bytes, pos);
    pos += 4;

    assertBounds(bytes, pos, keyAndValueByteLength, 'KV-payload');

    const raw = bytes.slice(pos, pos + keyAndValueByteLength);
    // Key is NUL-terminated UTF-8
    let nulIdx = raw.indexOf(0);
    if (nulIdx === -1) nulIdx = raw.length;
    const key = TD.decode(raw.slice(0, nulIdx));
    const value = raw.slice(nulIdx + 1);

    entries.push({ key, value });

    pos += keyAndValueByteLength;

    // align(4) padding per spec section 6
    const remainder = pos & 3;
    if (remainder !== 0) {
      pos += 4 - remainder;
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main parser (spec section 12, steps 1-6)
// ---------------------------------------------------------------------------

/**
 * Parse a KTX2 2.0 binary container into its five structural parts:
 * header, index, level index, DFD, KV metadata, and SGD.
 *
 * Does NOT interpret block-compressed payload content (OOS-6).
 *
 * Rejects unsupported supercompression schemes (BasisLZ=1, ZLIB=3, etc.)
 * with `ktx2-unsupported-scheme` that echoes the scheme value.
 */
export async function parseKtx2(bytes: Uint8Array): Promise<CodecResult<Ktx2Parsed>> {
  try {
    // 1. Validate identifier (12 bytes, spec section 1)
    if (bytes.length < 12) {
      return codecError('ktx2-parse-failed', {
        reason: 'truncated-identifier: file shorter than 12-byte KTX2 magic',
      });
    }
    for (let i = 0; i < 12; i++) {
      const expectedByte = KTX2_IDENTIFIER[i];
      if (expectedByte === undefined || bytes[i] !== expectedByte) {
        return codecError('ktx2-parse-failed', {
          reason: 'invalid-identifier: not a KTX2 2.0 file',
        });
      }
    }

    // 2. Header + index: identifier(12) + 9*u32(36) + 4*u32(16) + 2*u64(16) = 80
    if (bytes.length < 80) {
      return codecError('ktx2-parse-failed', {
        reason: 'truncated-header: file too short for KTX2 header + index (min 80 bytes)',
      });
    }

    const header: Ktx2Header = {
      vkFormat: readU32(bytes, 12),
      typeSize: readU32(bytes, 16),
      pixelWidth: readU32(bytes, 20),
      pixelHeight: readU32(bytes, 24),
      pixelDepth: readU32(bytes, 28),
      layerCount: readU32(bytes, 32),
      faceCount: readU32(bytes, 36),
      levelCount: readU32(bytes, 40),
      supercompressionScheme: readU32(bytes, 44),
    };

    const index: Ktx2Index = {
      dfdByteOffset: readU32(bytes, 48),
      dfdByteLength: readU32(bytes, 52),
      kvdByteOffset: readU32(bytes, 56),
      kvdByteLength: readU32(bytes, 60),
      sgdByteOffset: readU64(bytes, 64),
      sgdByteLength: readU64(bytes, 72),
    };

    // 3. Reject unsupported supercompression schemes (spec section 2.9).
    // scheme 0 = none, 1 = BasisLZ (Basis ETC1S payload, Loop 2 transcode arm),
    // 2 = Zstandard. scheme 3 (ZLIB) and any future scheme are still rejected;
    // scheme=1 is opened here (F-1 single-point gate) so the Basis payload passes
    // through to the transcode layer -- parseKtx2 itself does not interpret it.
    const scheme = header.supercompressionScheme;
    if (scheme !== 0 && scheme !== 1 && scheme !== 2) {
      return codecError('ktx2-unsupported-scheme', { scheme });
    }

    // 4. Level index: N = max(1, levelCount) per spec section 4
    const numLevels = Math.max(1, header.levelCount);
    const levelIndexStart = 80;
    assertBounds(bytes, levelIndexStart, numLevels * 24, 'level-index');

    const levelIndex: Ktx2LevelEntry[] = [];
    for (let i = 0; i < numLevels; i++) {
      const off = levelIndexStart + i * 24;
      const byteOffset = readU64(bytes, off);
      const byteLength = readU64(bytes, off + 8);
      const uncompressedByteLength = readU64(bytes, off + 16);

      // Validate level data OOB
      if (byteOffset + byteLength > bytes.length) {
        return codecError('ktx2-parse-failed', {
          reason: `level-index-OOB: level ${i} byteOffset=${byteOffset} byteLength=${byteLength} exceeds file size=${bytes.length}`,
        });
      }

      levelIndex.push({ byteOffset, byteLength, uncompressedByteLength });
    }

    // 5. DFD (spec section 5)
    let dfd: Ktx2Dfd | null = null;
    if (index.dfdByteLength > 0) {
      assertBounds(bytes, index.dfdByteOffset, index.dfdByteLength, 'DFD');
      dfd = parseDfd(bytes, index.dfdByteOffset, index.dfdByteLength);
    }

    // 6. KV metadata (spec section 6)
    let kvEntries: Ktx2KvEntry[] = [];
    if (index.kvdByteLength > 0) {
      assertBounds(bytes, index.kvdByteOffset, index.kvdByteLength, 'KVD');
      kvEntries = parseKv(bytes, index.kvdByteOffset, index.kvdByteLength);
    }

    // 7. Supercompression Global Data (spec section 7)
    let sgd: Uint8Array | null = null;
    if (index.sgdByteLength > 0) {
      assertBounds(bytes, index.sgdByteOffset, index.sgdByteLength, 'SGD');
      sgd = bytes.slice(index.sgdByteOffset, index.sgdByteOffset + index.sgdByteLength);
    }

    return {
      ok: true,
      value: {
        header,
        index,
        levelIndex,
        dfd,
        kvEntries,
        sgd,
        rawBytes: bytes,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return codecError('ktx2-parse-failed', { reason: `internal: ${message}` });
  }
}

// ---------------------------------------------------------------------------
// Levels → RGBA extraction (spec section 12, step 7)
// ---------------------------------------------------------------------------

/**
 * Map a mip level number to the levelIndex entry.
 *
 * KTX2 stores mip levels smallest-first in both the level index and payload
 * section (spec section 8): levelIndex[0] = smallest (level N-1),
 * levelIndex[N-1] = base (level 0).
 *
 * So mip level 0 (base/largest) maps to levelIndex[N-1],
 * mip level 1 maps to levelIndex[N-2], etc.
 */
function levelIndexForMip(totalLevels: number, mipLevel: number): number {
  const entryIdx = totalLevels - 1 - mipLevel;
  if (entryIdx < 0 || entryIdx >= totalLevels) return -1;
  return entryIdx;
}

/**
 * Extract RGBA pixel bytes from a parsed KTX2 container at a given mip level.
 *
 * - scheme=0 (uncompressed): returns raw level payload directly.
 *   mipPadding between levels is handled by using levelIndex byteOffsets.
 * - scheme=2 (Zstandard supercompression): decompresses with `decompressZstd`,
 *   the same function used by the asset-layer fetchBinary gate (AC-04).
 * - Other schemes: not reached (parseKtx2 rejects them), but defensively
 *   returns `ktx2-unsupported-scheme`.
 *
 * @param parsed  Result from `parseKtx2`.
 * @param level   Mip level number (0 = base/largest, default 0).
 */
export async function ktx2LevelsToRGBA(
  parsed: Ktx2Parsed,
  level: number = 0,
): Promise<CodecResult<Uint8Array>> {
  const totalLevels = parsed.levelIndex.length;
  const entryIdx = levelIndexForMip(totalLevels, level);
  if (entryIdx < 0) {
    return codecError('ktx2-parse-failed', { reason: `mip level ${level} does not exist` });
  }
  const entry = parsed.levelIndex[entryIdx];
  if (!entry) {
    return codecError('ktx2-parse-failed', {
      reason: `mip level ${level} has no level index entry`,
    });
  }

  if (parsed.header.supercompressionScheme === 0) {
    // Uncompressed — extract raw byte slice from source
    const slice = parsed.rawBytes.slice(entry.byteOffset, entry.byteOffset + entry.byteLength);
    return { ok: true, value: new Uint8Array(slice) };
  }

  if (parsed.header.supercompressionScheme === 2) {
    // Zstandard — decompress with same function as asset-layer (AC-04)
    const compressedSlice = parsed.rawBytes.slice(
      entry.byteOffset,
      entry.byteOffset + entry.byteLength,
    );
    const result = await decompressZstd(new Uint8Array(compressedSlice));
    if (!result.ok) {
      return codecError('ktx2-parse-failed', {
        reason: `zstd decompression failed for level ${level}: ${result.error.detail}`,
      });
    }
    return result;
  }

  // Defensive: unsupported schemes should have been rejected by parseKtx2
  return codecError('ktx2-unsupported-scheme', {
    scheme: parsed.header.supercompressionScheme,
  });
}
