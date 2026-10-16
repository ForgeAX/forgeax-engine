import { ktx2LevelsToRGBA, parseKtx2 } from '@forgeax/engine-codec';
import { describe, expect, it } from 'vitest';

/**
 * KTX2 2.0 identifier magic (12 bytes).
 * spec section 1: «KTX 20»\r\n\x1A\n
 */
const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Write a u32 little-endian into `out` at `offset`.
 */
function writeU32(out: Uint8Array, offset: number, value: number): void {
  new DataView(out.buffer, out.byteOffset + offset, 4).setUint32(0, value, true);
}

/**
 * Write a u64 little-endian into `out` at `offset`.
 * Uses two u32 writes because bitwise ops truncate to 32 bits.
 */
function writeU64(out: Uint8Array, offset: number, value: number): void {
  const lo = value >>> 0;
  const hi = (value - lo) / 0x100000000;
  new DataView(out.buffer, out.byteOffset + offset, 8).setUint32(0, lo, true);
  new DataView(out.buffer, out.byteOffset + offset + 4, 4).setUint32(0, hi, true);
}

/**
 * Synthesize a minimal KTX2 file with scheme=0 (uncompressed RGBA8).
 *
 * Layout (per spec sections 1-7):
 *   [12] identifier
 *   [ 4] vkFormat        = VK_FORMAT_R8G8B8A8_UNORM (37)
 *   [ 4] typeSize        = 4 (4 bytes per pixel)
 *   [ 4] pixelWidth      = 64
 *   [ 4] pixelHeight     = 64
 *   [ 4] pixelDepth      = 0
 *   [ 4] layerCount      = 0
 *   [ 4] faceCount       = 1
 *   [ 4] levelCount      = 1
 *   [ 4] supercompressionScheme = 0
 *   [ 4] dfdByteOffset
 *   [ 4] dfdByteLength
 *   [ 4] kvdByteOffset
 *   [ 4] kvdByteLength
 *   [ 8] sgdByteOffset   = 0
 *   [ 8] sgdByteLength   = 0
 *   [24] levelIndex[0]   { byteOffset, byteLength, uncompressedByteLength }
 *   ... DFD block
 *   ... KV data (empty)
 *   ... level 0 RGBA pixels
 *
 * Returns the raw bytes of the KTX2 file.
 */
function buildScheme0Fixture(): Uint8Array {
  const W = 64;
  const H = 64;
  const pixelBytes = W * H * 4; // RGBA8 = 16384 bytes per level

  // DFD descriptor: minimal RGBA8 descriptor
  // descriptorBlockSize = 24 (header) + 16*1 (sample) = 40 bytes
  // total dfd = 4 (dfdTotalSize) + 40 (descriptor block) = 44
  const dfdBlockSize = 40; // 24 header + 16 sample
  const dfdTotalSize = 4 + dfdBlockSize; // 44

  // Offsets
  const headerEnd = 12 + 9 * 4 + 4 * 4 + 2 * 8; // 12 + 36 + 16 + 16 = 80
  const levelIndexEnd = headerEnd + 1 * 24; // 80 + 24 = 104
  const dfdByteOffset = levelIndexEnd; // 104
  const dfdByteLength = dfdTotalSize; // 44
  const kvdByteOffset = dfdByteOffset + dfdByteLength; // 148
  const kvdByteLength = 0; // no KV data
  const levelPayloadOffset = kvdByteOffset + kvdByteLength; // 148
  const levelPayloadSize = pixelBytes; // 16384
  const totalSize = levelPayloadOffset + levelPayloadSize; // 16532

  const buf = new Uint8Array(totalSize);

  // --- identifier (offset 0, 12 bytes) ---
  buf.set(KTX2_IDENTIFIER, 0);

  // --- header (offset 12) ---
  // vkFormat = VK_FORMAT_R8G8B8A8_UNORM = 37
  writeU32(buf, 12, 37);
  // typeSize = 4
  writeU32(buf, 16, 4);
  // pixelWidth = 64
  writeU32(buf, 20, W);
  // pixelHeight = 64
  writeU32(buf, 24, H);
  // pixelDepth = 0
  writeU32(buf, 28, 0);
  // layerCount = 0
  writeU32(buf, 32, 0);
  // faceCount = 1
  writeU32(buf, 36, 1);
  // levelCount = 1
  writeU32(buf, 40, 1);
  // supercompressionScheme = 0
  writeU32(buf, 44, 0);

  // --- index (offset 48) ---
  writeU32(buf, 48, dfdByteOffset);
  writeU32(buf, 52, dfdByteLength);
  writeU32(buf, 56, kvdByteOffset);
  writeU32(buf, 60, kvdByteLength);
  writeU64(buf, 64, 0); // sgdByteOffset = 0
  writeU64(buf, 72, 0); // sgdByteLength = 0

  // --- level index (offset 80) ---
  writeU64(buf, 80, levelPayloadOffset);
  writeU64(buf, 88, levelPayloadSize);
  writeU64(buf, 96, levelPayloadSize); // uncompressedByteLength == byteLength for scheme=0

  // --- DFD (offset 104) ---
  // dfdTotalSize (u32)
  writeU32(buf, 104, dfdTotalSize);
  // descriptor block word 0: vendorId(17)=0, descriptorType(15)=0
  writeU32(buf, 108, 0);
  // descriptor block word 1: versionNumber(16)=2, descriptorBlockSize(16)=40
  writeU32(buf, 112, (40 << 16) | 2);
  // descriptor block word 2: colorModel(8)=1 (RGBSDA), colorPrimaries(8)=1 (BT709/SRGB), transferFunction(8)=1 (LINEAR), flags(8)=0
  writeU32(buf, 116, (1 << 16) | (1 << 8) | 1);
  // descriptor block word 3: texelBlockDimension[0..3]=0 (uncompressed, block=1x1x1)
  writeU32(buf, 120, 0);
  // descriptor block words 4-5: bytesPlane[0..7] = 4 for plane 0 (RGBA8 = 4 bytes), rest 0
  writeU32(buf, 124, 4); // bytesPlane0=4
  writeU32(buf, 128, 0); // bytesPlane1..7 = 0
  // sample 0 (16 bytes): R8G8B8A8
  // word 0: bitOffset(8)=0, bitLength(12)=7 (actual 8 - 1), channelType(8)=0 (RED/RGB), qualifiers(4)=0
  writeU32(buf, 132, 7 << 12); // bitLength=7, channelType=0 (RED — means RGBA combined sample)
  // word 1: samplePosition[0..3] = 0
  writeU32(buf, 136, 0);
  // word 2: sampleLower = 0
  writeU32(buf, 140, 0);
  // word 3: sampleUpper = UINT32_MAX for UNORM
  writeU32(buf, 144, 0xffffffff);

  // --- KV data: empty (kvdByteLength=0) ---

  // --- level 0 pixel data (offset 148) ---
  // Fill with known pattern: pixel(x,y) = (r,g,b,a) based on position
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = levelPayloadOffset + (y * W + x) * 4;
      buf[px] = (x * 3 + y * 7) & 0xff; // R
      buf[px + 1] = (x * 5 + y * 11) & 0xff; // G
      buf[px + 2] = (x * 13 + y * 17) & 0xff; // B
      buf[px + 3] = 255; // A
    }
  }

  return buf;
}

const scheme0Fixture = buildScheme0Fixture();

describe('KTX2 parse — scheme=0 uncompressed (w21)', () => {
  it('parses header fields from scheme=0 fixture', async () => {
    const result = await parseKtx2(scheme0Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    const h = result.value.header;
    expect(h.vkFormat).toBe(37); // VK_FORMAT_R8G8B8A8_UNORM
    expect(h.typeSize).toBe(4);
    expect(h.pixelWidth).toBe(64);
    expect(h.pixelHeight).toBe(64);
    expect(h.pixelDepth).toBe(0);
    expect(h.layerCount).toBe(0);
    expect(h.faceCount).toBe(1);
    expect(h.levelCount).toBe(1);
    expect(h.supercompressionScheme).toBe(0);
  });

  it('parses index fields (DFD/KVD/SGD offsets)', async () => {
    const result = await parseKtx2(scheme0Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    const idx = result.value.index;
    // dfdByteOffset should be after header + level index = 104
    expect(idx.dfdByteOffset).toBe(104);
    expect(idx.dfdByteLength).toBe(44);
    expect(idx.kvdByteOffset).toBe(148);
    expect(idx.kvdByteLength).toBe(0);
    expect(idx.sgdByteOffset).toBe(0);
    expect(idx.sgdByteLength).toBe(0);
  });

  it('parses level index entries', async () => {
    const result = await parseKtx2(scheme0Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    expect(result.value.levelIndex.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: previous assertion ensures levelIndex[0] exists
    const l0 = result.value.levelIndex[0]!;
    expect(l0.byteOffset).toBe(148);
    expect(l0.byteLength).toBe(16384); // 64*64*4
    expect(l0.uncompressedByteLength).toBe(16384); // scheme=0: same as byteLength
  });

  it('parses DFD descriptor block', async () => {
    const result = await parseKtx2(scheme0Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    const dfd = result.value.dfd;
    expect(dfd).toBeDefined();
    expect(dfd?.totalSize).toBe(44);
    expect(dfd?.colorModel).toBe(1); // RGBSDA
    expect(dfd?.colorPrimaries).toBe(1); // BT709/SRGB
    expect(dfd?.transferFunction).toBe(1); // LINEAR
    expect(dfd?.samples.length).toBe(1);
  });

  it('ktx2LevelsToRGBA returns correct pixel bytes for scheme=0', async () => {
    const parsed = await parseKtx2(scheme0Fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('parse failed');

    const rgba = await ktx2LevelsToRGBA(parsed.value, 0);
    expect(rgba.ok).toBe(true);
    if (!rgba.ok) throw new Error('levelsToRGBA failed');

    const pixels = rgba.value;
    expect(pixels.length).toBe(16384);

    // Verify pixel at (0,0): R = (0*3 + 0*7) & 0xff = 0, G = 0, B = 0, A = 255
    expect(pixels[0]).toBe(0);
    expect(pixels[1]).toBe(0);
    expect(pixels[2]).toBe(0);
    expect(pixels[3]).toBe(255);

    // Verify pixel at (63,63): R = (63*3 + 63*7) & 0xff = (189+441) & 0xff = 630 & 0xff = 118
    const lastPx = 16384 - 4;
    expect(pixels[lastPx]).toBe((63 * 3 + 63 * 7) & 0xff); // 118
    expect(pixels[lastPx + 1]).toBe((63 * 5 + 63 * 11) & 0xff); // 252
    expect(pixels[lastPx + 2]).toBe((63 * 13 + 63 * 17) & 0xff); // 118
    expect(pixels[lastPx + 3]).toBe(255);
  });

  it('parses empty KV metadata', async () => {
    const result = await parseKtx2(scheme0Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    expect(result.value.kvEntries).toEqual([]);
  });

  it('SG descriptor is empty for scheme=0', async () => {
    const result = await parseKtx2(scheme0Fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('parse failed');

    expect(result.value.sgd).toBeNull();
    // sgdByteLength is 0 for scheme=0
    expect(result.value.index.sgdByteLength).toBe(0);
  });
});
