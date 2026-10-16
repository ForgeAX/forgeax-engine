// Synthetic image fixtures generated algorithmically so the engine repo
// carries zero committed image binaries (and zero inlined asset byte blobs,
// which would just be a relabelled asset). The PNG path hand-builds the
// chunk structure (IHDR + IDAT + IEND) and deflates the raw scanlines with
// node's zlib; the JPEG path uses jpeg-js, already a runtime dep of
// @forgeax/engine-image. Both produce standard-conformant streams that the
// production decoder (upng-js / jpeg-js in parse-image.ts) reads back.
import { deflateSync } from 'node:zlib';
import * as jpeg from 'jpeg-js';

const jpegEncode = ((jpeg as unknown as { encode?: typeof jpeg.encode }).encode ??
  (jpeg as unknown as { default: { encode: typeof jpeg.encode } }).default
    .encode) as typeof jpeg.encode;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// CRC-32 (PNG polynomial) over a chunk's type+data.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type: string, data: Uint8Array): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const body = new Uint8Array([...typeBytes, ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/** Solid-colour 8-bit RGBA PNG, standard zlib/deflate encoding. */
export function makePng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Uint8Array {
  // IHDR: width, height, bit-depth=8, colour-type=6 (RGBA), no interlace.
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  // Raw image: each scanline prefixed with a filter-type byte (0 = none).
  const raw = new Uint8Array(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = rgba[0];
      raw[o++] = rgba[1];
      raw[o++] = rgba[2];
      raw[o++] = rgba[3];
    }
  }
  const idat = new Uint8Array(deflateSync(raw));
  return new Uint8Array([
    ...PNG_MAGIC,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', idat),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Solid-colour RGBA JPEG of the given dimensions. */
export function makeJpg(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 0] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const encoded = jpegEncode({ data: Buffer.from(data), width, height }, 90);
  return new Uint8Array(encoded.data);
}

/**
 * A valid PNG header + IHDR followed by an IDAT whose deflate stream is
 * garbage, so a real PNG decoder fails (image-decode-failed). Built from the
 * same chunk machinery as makePng, with a corrupted IDAT body — replaces the
 * former committed corrupt.png fixture.
 */
export function makeCorruptPng(): Uint8Array {
  const ihdr = new Uint8Array([...u32(1), ...u32(1), 8, 6, 0, 0, 0]);
  const garbageIdat = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  return new Uint8Array([
    ...PNG_MAGIC,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', garbageIdat),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
}
