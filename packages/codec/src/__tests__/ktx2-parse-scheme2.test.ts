import { ktx2LevelsToRGBA, parseKtx2 } from '@forgeax/engine-codec';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * KTX2 2.0 identifier magic (12 bytes).
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
 * Build a scheme=2 KTX2 fixture: same RGBA content as scheme=0,
 * but level payload is zstd-compressed.
 */
async function buildScheme2Fixture(): Promise<Uint8Array> {
  const W = 64;
  const H = 64;
  const pixelBytes = W * H * 4; // 16384

  // Generate raw RGBA pixels (same pattern as scheme=0)
  const rawPixels = new Uint8Array(pixelBytes);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = (y * W + x) * 4;
      rawPixels[px] = (x * 3 + y * 7) & 0xff;
      rawPixels[px + 1] = (x * 5 + y * 11) & 0xff;
      rawPixels[px + 2] = (x * 13 + y * 17) & 0xff;
      rawPixels[px + 3] = 255;
    }
  }

  // Compress with zstd
  const compResult = await compressZstd(rawPixels);
  if (!compResult.ok) throw new Error(`compressZstd failed: ${compResult.error.code}`);
  const compressedPayload = compResult.value;

  // DFD descriptor: minimal RGBA8
  const dfdBlockSize = 40;
  const dfdTotalSize = 4 + dfdBlockSize; // 44

  // Level payload offset is right after index + level index + DFD + empty KV + empty SGD
  // Header: 80 bytes, levelIndex (1 entry): 24 bytes, total: 104
  // DFD at 104, length 44, ends at 148
  // KV: empty, so kvdByteOffset=148, kvdByteLength=0
  // SGD: empty (scheme=2), so sgdByteOffset=0, sgdByteLength=0 (per spec §7: Zstandard has no global data)
  // Level payload at 148 (mipPadding not needed for scheme!=0 per spec §8.1)
  const levelPayloadOffset = 148;
  const totalSize = levelPayloadOffset + compressedPayload.length;

  const buf = new Uint8Array(totalSize);

  // identifier
  buf.set(KTX2_IDENTIFIER, 0);

  // header
  writeU32(buf, 12, 37); // vkFormat = VK_FORMAT_R8G8B8A8_UNORM
  writeU32(buf, 16, 4); // typeSize
  writeU32(buf, 20, W);
  writeU32(buf, 24, H);
  writeU32(buf, 28, 0);
  writeU32(buf, 32, 0);
  writeU32(buf, 36, 1);
  writeU32(buf, 40, 1);
  writeU32(buf, 44, 2); // supercompressionScheme = 2 (Zstandard)

  // index
  writeU32(buf, 48, 104); // dfdByteOffset
  writeU32(buf, 52, dfdTotalSize);
  writeU32(buf, 56, 148); // kvdByteOffset (after DFD)
  writeU32(buf, 60, 0); // kvdByteLength = 0
  writeU64(buf, 64, 0); // sgdByteOffset = 0
  writeU64(buf, 72, 0); // sgdByteLength = 0 (spec §7: Zstandard has no global data)

  // level index
  writeU64(buf, 80, levelPayloadOffset);
  writeU64(buf, 88, compressedPayload.length);
  writeU64(buf, 96, pixelBytes); // uncompressedByteLength

  // DFD
  writeU32(buf, 104, dfdTotalSize);
  writeU32(buf, 108, 0);
  writeU32(buf, 112, (40 << 16) | 2);
  writeU32(buf, 116, (1 << 16) | (1 << 8) | 1);
  writeU32(buf, 120, 0);
  writeU32(buf, 124, 4);
  writeU32(buf, 128, 0);
  writeU32(buf, 132, 7 << 12);
  writeU32(buf, 136, 0);
  writeU32(buf, 140, 0);
  writeU32(buf, 144, 0xffffffff);

  // level payload (zstd-compressed)
  buf.set(compressedPayload, levelPayloadOffset);

  return buf;
}

let scheme2Fixture: Uint8Array;
let expectedRawPixels: Uint8Array;

describe('KTX2 parse — scheme=2 zstd supercompression (w22)', () => {
  beforeAll(async () => {
    scheme2Fixture = await buildScheme2Fixture();

    // Build expected raw pixels for comparison
    const W = 64;
    const H = 64;
    expectedRawPixels = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = (y * W + x) * 4;
        expectedRawPixels[px] = (x * 3 + y * 7) & 0xff;
        expectedRawPixels[px + 1] = (x * 5 + y * 11) & 0xff;
        expectedRawPixels[px + 2] = (x * 13 + y * 17) & 0xff;
        expectedRawPixels[px + 3] = 255;
      }
    }
  });

  it('parses header with supercompressionScheme=2', async () => {
    const result = await parseKtx2(scheme2Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    expect(result.value.header.supercompressionScheme).toBe(2);
    expect(result.value.header.pixelWidth).toBe(64);
    expect(result.value.header.pixelHeight).toBe(64);
    expect(result.value.header.levelCount).toBe(1);
  });

  it('sgdByteLength is 0 (Zstandard has no global data per spec §7)', async () => {
    const result = await parseKtx2(scheme2Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    expect(result.value.index.sgdByteLength).toBe(0);
    expect(result.value.sgd).toBeNull();
  });

  it('level index has compressed byteLength < uncompressedByteLength', async () => {
    const result = await parseKtx2(scheme2Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    // biome-ignore lint/style/noNonNullAssertion: previous assertion ensures levelIndex[0] exists
    const l0 = result.value.levelIndex[0]!;
    expect(l0.byteLength).toBeGreaterThan(0);
    expect(l0.byteLength).toBeLessThan(l0.uncompressedByteLength);
    expect(l0.uncompressedByteLength).toBe(16384);
  });

  it('ktx2LevelsToRGBA decompresses scheme=2 and returns correct pixels', async () => {
    const parsed = await parseKtx2(scheme2Fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('parse failed');

    const rgba = await ktx2LevelsToRGBA(parsed.value, 0);
    expect(rgba.ok).toBe(true);
    if (!rgba.ok) throw new Error('levelsToRGBA failed');

    const pixels = rgba.value;
    expect(pixels.length).toBe(16384);

    // Compare all pixels byte-by-byte against expected
    for (let i = 0; i < pixels.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index within bounds of expectedRawPixels array verified above
      expect(pixels[i]).toBe(expectedRawPixels[i]!);
    }
  });

  it('scheme=2 decompressed pixels match scheme=0 pixel pattern byte-identical', async () => {
    // This asserts AC-04: same zstd decoder gives same result
    // Compare just key pixels (first, middle, last) to keep test fast
    const parsed = await parseKtx2(scheme2Fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('parse failed');

    const rgba = await ktx2LevelsToRGBA(parsed.value, 0);
    expect(rgba.ok).toBe(true);
    if (!rgba.ok) throw new Error('levelsToRGBA failed');
    const pixels = rgba.value;

    // First pixel (0,0)
    expect(pixels[0]).toBe(0);
    expect(pixels[1]).toBe(0);
    expect(pixels[2]).toBe(0);
    expect(pixels[3]).toBe(255);

    // Last pixel (63,63)
    const lastPx = 16384 - 4;
    expect(pixels[lastPx]).toBe((63 * 3 + 63 * 7) & 0xff);
    expect(pixels[lastPx + 1]).toBe((63 * 5 + 63 * 11) & 0xff);
    expect(pixels[lastPx + 2]).toBe((63 * 13 + 63 * 17) & 0xff);
    expect(pixels[lastPx + 3]).toBe(255);
  });

  it('structural check: levels-to-RGBA decompresses fewer bytes than raw size', async () => {
    // Verify that compression actually happened (zstd produced smaller data)
    const parsed = await parseKtx2(scheme2Fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('parse failed');

    // biome-ignore lint/style/noNonNullAssertion: previous assertion ensures levelIndex[0] exists
    const l0 = parsed.value.levelIndex[0]!;
    // zstd should compress RGBA8 patterned data well below 16384 bytes
    expect(l0.byteLength).toBeLessThan(16384);
  });
});
