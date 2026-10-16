#!/usr/bin/env node
// Minimal dependency-free PNG encoder/decoder for hello-* dawn-node smoke scripts.
//
// Used by: hello-tonemap, hello-sprite, hello-sprite-atlas.
// charter F1: extracted at consumer #3+ per the plan-strategy png-codec SSOT rule;
// each smoke script imports this module instead of inlining verbatim copies.
//
// Limitations: encodes RGBA only (bit depth 8, color type 6); decodes RGBA only;
// assumes filter=0 on every row (no adaptive filtering).

import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Encode an RGBA pixel buffer to a minimal PNG Buffer.
 *
 * @param {Uint8Array} pixels - Raw RGBA bytes, left-to-right, top-to-bottom.
 * @param {number} width - Image width in pixels.
 * @param {number} height - Image height in pixels.
 * @returns {Buffer} PNG file bytes.
 */
export function writeReferencePng(pixels, width, height) {
  const sigBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const u32 = (n) => {
    const b = new Uint8Array(4);
    b[0] = (n >>> 24) & 0xff;
    b[1] = (n >>> 16) & 0xff;
    b[2] = (n >>> 8) & 0xff;
    b[3] = n & 0xff;
    return b;
  };
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = (crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = new TextEncoder().encode(type);
    const out = new Uint8Array(8 + data.length + 4);
    out.set(u32(data.length), 0);
    out.set(typeBuf, 4);
    out.set(data, 8);
    const crcInput = new Uint8Array(typeBuf.length + data.length);
    crcInput.set(typeBuf, 0);
    crcInput.set(data, typeBuf.length);
    out.set(u32(crc32(crcInput)), 8 + data.length);
    return out;
  };
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const filtered = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (width * 4 + 1)] = 0;
    filtered.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const compressed = deflateSync(filtered);
  return Buffer.concat([
    Buffer.from(sigBytes),
    Buffer.from(chunk('IHDR', ihdr)),
    Buffer.from(chunk('IDAT', compressed)),
    Buffer.from(chunk('IEND', new Uint8Array(0))),
  ]);
}

/**
 * Decode a PNG file to an RGBA pixel buffer.
 *
 * @param {string} path - Absolute or relative path to the PNG file.
 * @returns {{ width: number, height: number, pixels: Uint8Array }}
 */
export function readReferencePng(path) {
  const buf = readFileSync(path);
  let off = 8;
  let width = 0;
  let height = 0;
  const idatChunks = [];
  while (off < buf.length) {
    const len =
      ((buf[off] ?? 0) << 24) |
      ((buf[off + 1] ?? 0) << 16) |
      ((buf[off + 2] ?? 0) << 8) |
      (buf[off + 3] ?? 0);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width =
        ((data[0] ?? 0) << 24) |
        ((data[1] ?? 0) << 16) |
        ((data[2] ?? 0) << 8) |
        (data[3] ?? 0);
      height =
        ((data[4] ?? 0) << 24) |
        ((data[5] ?? 0) << 16) |
        ((data[6] ?? 0) << 8) |
        (data[7] ?? 0);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 8 + len + 4;
  }
  const compressed = Buffer.concat(idatChunks);
  const filtered = inflateSync(compressed);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    pixels.set(
      filtered.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)),
      y * width * 4,
    );
  }
  return { width, height, pixels };
}
