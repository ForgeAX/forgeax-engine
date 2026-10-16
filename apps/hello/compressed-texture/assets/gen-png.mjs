#!/usr/bin/env node
// gen-png.mjs -- feat-20260707-texture-block-compression-web-transcode-ktx2-basis (F-2 fixup).
//
// Programmatically synthesises the demo source PNGs so the engine main repo
// carries ZERO committed binaries (plan-strategy §5.6 zero-new-binary
// invariant; scripts/grep/check-no-binary-assets.mjs enforces it). The two
// generated PNGs are byte-identical checkerboards; they differ only by their
// committed .meta.json sidecars:
//   - checker-rgba.png       -> compressionMode:'etc1s' (Basis KTX2 arm)
//   - checker-rgba-nobc.png  -> compressionMode:'none'  (raw RGBA8 baseline)
//
// The generated *.png files are git-ignored (.gitignore `*.png` global block);
// they are regenerated on demand by the demo's dev / build / smoke hooks
// (see package.json `predev` / `prebuild` / `presmoke*`). The PNG chunk
// machinery mirrors packages/image/src/__tests__/make-fixture.ts (the
// established in-repo synthesis pattern).
//
// Run: `node assets/gen-png.mjs` from the demo root (idempotent overwrite).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Texture geometry deliberately crosses BC7's 4x4 block boundary. This keeps
// the browser smoke on the full-subresource tail-copy path.
const TEX_W = 257;
const TEX_H = 259;
const CHECK_SIZE = 32;

// CRC-32 (PNG polynomial) over a chunk's type+data.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type, data) {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const body = new Uint8Array([...typeBytes, ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

// 8-bit RGBA PNG (colour-type 6), standard zlib/deflate, filter-type 0 rows.
function makeCheckerPng(width, height, cell) {
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  const raw = new Uint8Array(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter-type: none
    for (let x = 0; x < width; x++) {
      const cx = Math.floor(x / cell) % 2;
      const cy = Math.floor(y / cell) % 2;
      const white = cx === cy;
      raw[o++] = white ? 255 : 64;
      raw[o++] = white ? 200 : 32;
      raw[o++] = white ? 128 : 255;
      raw[o++] = 255;
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

const here = dirname(fileURLToPath(import.meta.url));
const png = makeCheckerPng(TEX_W, TEX_H, CHECK_SIZE);

for (const name of ['checker-rgba.png', 'checker-rgba-nobc.png']) {
  const dest = resolve(here, name);
  writeFileSync(dest, png);
  console.log(`[gen-png] wrote ${name} (${png.byteLength}B, ${TEX_W}x${TEX_H} checkerboard)`);
}
