/**
 * KTX2 2.0 container parser (per spec 2026-07-07-ktx2-container-binary-spec.md).
 *
 * Parses header + index + level index + DFD + KV metadata + SGD.
 * Does NOT interpret block-compressed payload content (OOS-6, Loop 2).
 *
 * scheme=2 (Zstandard) level decode reuses decompressZstd (AC-04 single implementation).
 */

import type { TranscodedMip, TranscodedTexture } from './basis-transcoder.js';
import type { CodecError, CodecResult, Ktx2NativeRejection } from './errors.js';
import { codecError } from './errors.js';
import type { TranscodeChannels } from './transcode.js';
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
  /** Level index entries, base level first; payload bytes are stored smallest-first. */
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

const DFD_MODEL_ETC1S = 163;
const DFD_MODEL_UASTC = 166;

/**
 * Project the DFD sample channel ids into the transcode channel arm and the RGBA
 * decode lanes that carry each channel (KTX 2.0 section 3.10.2). Basis reads the
 * two BC5 / EAC RG11 channels from R and A, so a two-channel UASTC source is
 * `RRRG` (luminance-alpha) and an ETC1S one `RRR` + `GGG` (color and alpha
 * slices). UASTC `RG` keeps its second channel in G, where BC5 cannot reach it, so
 * it stays a color source. Every other descriptor is a color source.
 */
export function ktx2ChannelLanes(parsed: Ktx2Parsed): {
  readonly channels: TranscodeChannels;
  readonly lanes: readonly number[];
} {
  const ids = parsed.dfd?.samples.map((sample) => sample.channelType) ?? [];
  const uastc = parsed.dfd?.colorModel === DFD_MODEL_UASTC && ids.length === 1;
  const etc1s = parsed.dfd?.colorModel === DFD_MODEL_ETC1S;
  if ((uastc && ids[0] === 5) || (etc1s && ids.length === 2 && ids[0] === 3 && ids[1] === 4))
    return { channels: 'rg', lanes: [0, 3] };
  if ((uastc && ids[0] === 4) || (etc1s && ids.length === 1 && ids[0] === 3))
    return { channels: 'r', lanes: [0] };
  return { channels: 'rgba', lanes: [0, 1, 2, 3] };
}

// ---------------------------------------------------------------------------
// Internal helpers — little-endian reads
// ---------------------------------------------------------------------------

let textDecoder: TextDecoder | undefined;

function readU32(bytes: Uint8Array, byteOffset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(byteOffset, true);
}

/** Read u64 LE as Number (safe for values < 2^53; all KTX2 offsets fit). */
function readU64(bytes: Uint8Array, byteOffset: number): number {
  return Number(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(byteOffset, true),
  );
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

function parseDfd(bytes: Uint8Array): Ktx2Dfd {
  const totalSize = readU32(bytes, 0);
  assertBounds(bytes, 0, totalSize, 'DFD-block');
  if (totalSize < 28) throw new Error('DFD requires a complete descriptor header');
  const descriptorBlockSize = readU32(bytes, 8) >>> 16;
  if (descriptorBlockSize < 24 || (descriptorBlockSize - 24) % 16 !== 0)
    throw new Error('DFD descriptor requires a header and complete samples');
  assertBounds(bytes.subarray(0, totalSize), 4, descriptorBlockSize, 'DFD-descriptor');
  bytes = bytes.subarray(4, 4 + descriptorBlockSize);
  const dbOff = 0;

  const word0 = readU32(bytes, dbOff);
  const vendorId = word0 & 0x1ffff;
  const descriptorType = (word0 >>> 17) & 0x7fff;

  const word1 = readU32(bytes, dbOff + 4);
  const versionNumber = word1 & 0xffff;

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

    // Khronos Data Format 1.3 section 5.17: bitOffset 0-15, bitLength - 1 16-23,
    // channelType 24-27, qualifiers 28-31.
    samples.push({
      bitOffset: sw0 & 0xffff,
      bitLength: ((sw0 >>> 16) & 0xff) + 1,
      channelType: (sw0 >>> 24) & 0xf,
      qualifiers: (sw0 >>> 28) & 0xf,
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

function parseKv(bytes: Uint8Array): Ktx2KvEntry[] {
  const entries: Ktx2KvEntry[] = [];
  let pos = 0;

  while (pos < bytes.length) {
    assertBounds(bytes, pos, 4, 'KV-keyAndValueByteLength');
    const keyAndValueByteLength = readU32(bytes, pos);
    pos += 4;

    assertBounds(bytes, pos, keyAndValueByteLength, 'KV-payload');

    const raw = bytes.slice(pos, pos + keyAndValueByteLength);
    // Key is NUL-terminated UTF-8
    let nulIdx = raw.indexOf(0);
    if (nulIdx === -1) nulIdx = raw.length;
    textDecoder ??= new TextDecoder();
    const key = textDecoder.decode(raw.slice(0, nulIdx));
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
export function parseKtx2(bytes: Uint8Array): CodecResult<Ktx2Parsed> {
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
      dfd = parseDfd(
        bytes.subarray(index.dfdByteOffset, index.dfdByteOffset + index.dfdByteLength),
      );
    }

    // 6. KV metadata (spec section 6)
    let kvEntries: Ktx2KvEntry[] = [];
    if (index.kvdByteLength > 0) {
      assertBounds(bytes, index.kvdByteOffset, index.kvdByteLength, 'KVD');
      kvEntries = parseKv(
        bytes.subarray(index.kvdByteOffset, index.kvdByteOffset + index.kvdByteLength),
      );
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
 * Map a mip level number to its levelIndex entry. The level index is ordered
 * base level first (KTX 2.0 section 3.9: `levels[0]` describes mip 0); only
 * the level payloads themselves are laid out smallest-first in the file.
 */
function levelIndexForMip(totalLevels: number, mipLevel: number): number {
  return mipLevel >= 0 && mipLevel < totalLevels ? mipLevel : -1;
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

// ---------------------------------------------------------------------------
// Non-Basis two-channel payloads (RG8 / BC5 tangent-space normal maps)
// ---------------------------------------------------------------------------

/** GPU format of an admitted non-Basis KTX2 payload, keyed by its vkFormat. */
export type Ktx2NativeFormat = 'rg8unorm' | 'bc5-rg-unorm';

const NATIVE_FORMATS: Readonly<Record<number, Ktx2NativeFormat>> = {
  16: 'rg8unorm',
  141: 'bc5-rg-unorm',
};

/** Shape facts of an admitted non-Basis KTX2 payload. */
export interface Ktx2NativeInspection {
  readonly format: Ktx2NativeFormat;
  readonly width: number;
  readonly height: number;
  readonly levelCount: number;
}

const NATIVE_EXPECTED: Readonly<Record<Ktx2NativeRejection, string>> = {
  format: 'vkFormat 16 (R8G8_UNORM) or 141 (BC5_UNORM_BLOCK); vkFormat 0 is Basis',
  'srgb-transfer': 'a linear DFD transfer function; two-channel normal data has no sRGB form',
  'transfer-function': 'a DFD declaring the linear transfer function',
  shape: 'a 2D, single-layer, single-face texture with at most a complete mip chain',
  scheme: 'supercompression scheme 0 (none) or 2 (Zstandard)',
  'level-length': 'every level to hold exactly its texel or block bytes',
};

function nativeError(vkFormat: number, reason: Ktx2NativeRejection): CodecError {
  const failure = codecError('ktx2-native-unsupported', { vkFormat, reason });
  return { ...failure, error: { ...failure.error, expected: NATIVE_EXPECTED[reason] } };
}

const VK_FORMAT_ASTC_4X4_SFLOAT = 1000066000;

/** True for a payload that is not Basis: Basis is vkFormat 0, or ASTC 4x4 SFLOAT for UASTC HDR. */
export function ktx2IsNative(parsed: Ktx2Parsed): boolean {
  const { vkFormat } = parsed.header;
  return vkFormat !== 0 && vkFormat !== VK_FORMAT_ASTC_4X4_SFLOAT;
}

/** The non-Basis format of `parsed`, or `undefined` for Basis (vkFormat 0) and others. */
export function ktx2NativeFormat(parsed: Ktx2Parsed): Ktx2NativeFormat | undefined {
  return NATIVE_FORMATS[parsed.header.vkFormat];
}

function nativeLevelBytes(format: Ktx2NativeFormat, width: number, height: number): number {
  return format === 'rg8unorm'
    ? width * height * 2
    : Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}

/**
 * Validate a non-Basis RG8 / BC5 KTX2 without touching level payloads beyond
 * their declared lengths. Pure and synchronous: importers and runtime source
 * admission share this one contract.
 */
export function inspectKtx2Native(parsed: Ktx2Parsed): CodecResult<Ktx2NativeInspection> {
  const { header, levelIndex } = parsed;
  const format = ktx2NativeFormat(parsed);
  if (format === undefined) return nativeError(header.vkFormat, 'format');
  const color = ktx2ColorSpace(parsed);
  if (color === 'srgb') return nativeError(header.vkFormat, 'srgb-transfer');
  if (color === undefined) return nativeError(header.vkFormat, 'transfer-function');
  const width = header.pixelWidth;
  const height = header.pixelHeight;
  const levelCount = levelIndex.length;
  if (
    width === 0 ||
    height === 0 ||
    header.pixelDepth !== 0 ||
    header.layerCount > 1 ||
    header.faceCount !== 1 ||
    levelCount > Math.floor(Math.log2(Math.max(width, height))) + 1
  )
    return nativeError(header.vkFormat, 'shape');
  const scheme = header.supercompressionScheme;
  if (scheme !== 0 && scheme !== 2) return nativeError(header.vkFormat, 'scheme');
  for (let level = 0; level < levelCount; level++) {
    const entry = levelIndex[levelIndexForMip(levelCount, level)];
    const expected = nativeLevelBytes(
      format,
      Math.max(1, width >> level),
      Math.max(1, height >> level),
    );
    if (
      entry === undefined ||
      (scheme === 0 ? entry.byteLength : entry.uncompressedByteLength) !== expected
    )
      return nativeError(header.vkFormat, 'level-length');
  }
  return { ok: true, value: { format, width, height, levelCount } };
}

/**
 * Admit encoded KTX2 bytes declared as a BC5 TextureAsset source: the container
 * must be a valid linear BC5 payload whose shape and complete mip count equal
 * the declared metadata. Returns the failed expectation, or `undefined` when
 * admitted. Runtime source admission and Pack output production share this.
 */
export function ktx2Bc5SourceMismatch(
  bytes: Uint8Array,
  declared: { readonly width: number; readonly height: number; readonly levelCount: number },
): string | undefined {
  const parsed = parseKtx2(bytes);
  if (!parsed.ok) return parsed.error.expected;
  const native = inspectKtx2Native(parsed.value);
  if (!native.ok) return native.error.expected;
  const { format, width, height, levelCount } = native.value;
  return format === 'bc5-rg-unorm' &&
    width === declared.width &&
    height === declared.height &&
    levelCount === declared.levelCount
    ? undefined
    : 'a BC5 KTX2 source whose shape and complete mip count match its metadata';
}

function bc4Channel(block: Uint8Array, offset: number, out: Uint8Array, lane: number): void {
  const r0 = block[offset] ?? 0;
  const r1 = block[offset + 1] ?? 0;
  const palette = [r0, r1, 0, 0, 0, 0, 0, 0];
  for (let i = 2; i < 8; i++) {
    palette[i] =
      r0 > r1
        ? Math.round(((8 - i) * r0 + (i - 1) * r1) / 7)
        : i < 6
          ? Math.round(((6 - i) * r0 + (i - 1) * r1) / 5)
          : i === 6
            ? 0
            : 255;
  }
  let bits = 0;
  let count = 0;
  let cursor = offset + 2;
  for (let texel = 0; texel < 16; texel++) {
    if (count < 3) {
      bits |= (block[cursor++] ?? 0) << count;
      count += 8;
    }
    out[texel * 2 + lane] = palette[bits & 7] ?? 0;
    bits >>>= 3;
    count -= 3;
  }
}

/** Decode one BC5 level into tight RG8 texels (two BC4 channel blocks per 4x4 block). */
export function decodeBc5ToRg8(blocks: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2);
  const tile = new Uint8Array(32);
  const columns = Math.ceil(width / 4);
  for (let by = 0; by < Math.ceil(height / 4); by++) {
    for (let bx = 0; bx < columns; bx++) {
      const offset = (by * columns + bx) * 16;
      bc4Channel(blocks, offset, tile, 0);
      bc4Channel(blocks, offset + 8, tile, 1);
      for (let y = 0; y < 4 && by * 4 + y < height; y++) {
        for (let x = 0; x < 4 && bx * 4 + x < width; x++) {
          const source = (y * 4 + x) * 2;
          const target = ((by * 4 + y) * width + bx * 4 + x) * 2;
          out[target] = tile[source] ?? 0;
          out[target + 1] = tile[source + 1] ?? 0;
        }
      }
    }
  }
  return out;
}

/**
 * Unwrap every level of an admitted RG8 / BC5 KTX2 (base level first), Zstd
 * levels included. `target` defaults to the payload format; a BC5 payload can
 * also produce RG8 for devices without BC, and either payload can produce
 * RGBA8 `(r, g, 0, 255)` for CPU image consumers.
 */
export async function ktx2NativeTexture(
  parsed: Ktx2Parsed,
  target?: GPUTextureFormat,
): Promise<CodecResult<TranscodedTexture>> {
  const inspected = inspectKtx2Native(parsed);
  if (!inspected.ok) return inspected;
  const { format, width, height, levelCount } = inspected.value;
  const output = target ?? format;
  if (output !== format && output !== 'rg8unorm' && output !== 'rgba8unorm')
    return codecError('transcode-failed', { sourceFormat: format, targetFormat: output });
  const mips: TranscodedMip[] = [];
  for (let level = 0; level < levelCount; level++) {
    const bytes = await ktx2LevelsToRGBA(parsed, level);
    if (!bytes.ok) return bytes;
    const w = Math.max(1, width >> level);
    const h = Math.max(1, height >> level);
    if (bytes.value.byteLength !== nativeLevelBytes(format, w, h))
      return nativeError(parsed.header.vkFormat, 'level-length');
    let data = bytes.value;
    if (output !== format && format === 'bc5-rg-unorm') data = decodeBc5ToRg8(data, w, h);
    if (output === 'rgba8unorm') {
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = data[i * 2] ?? 0;
        rgba[i * 4 + 1] = data[i * 2 + 1] ?? 0;
        rgba[i * 4 + 3] = 255;
      }
      data = rgba;
    }
    mips.push({ level, width: w, height: h, data });
  }
  return { ok: true, value: { format: output, width, height, mips } };
}
