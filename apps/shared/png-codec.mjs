#!/usr/bin/env node
// Minimal dependency-free PNG decoder for hello-* dawn-node smoke scripts.
//
// Used by: hello-tonemap, hello-sprite, hello-sprite-atlas.
// charter F1: extracted at consumer #3+ per the plan-strategy png-codec SSOT rule;
// each smoke script imports this module instead of inlining verbatim copies.
//
// Limitations: decodes RGBA only (bit depth 8, color type 6);
// assumes filter=0 on every row (no adaptive filtering).

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

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
