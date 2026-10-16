// Pure image metrics and encoders shared by the smoke and the reference tool.
// Every image is a tightly packed linear RGB Float32Array, row 0 at the top.

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export const luminance = (rgb, p) =>
  0.2126 * rgb[p * 3] + 0.7152 * rgb[p * 3 + 1] + 0.0722 * rgb[p * 3 + 2];

const meanOf = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/** Pixels raster leaves (almost) unlit: luminance below 5% of the lit median. */
export function unlitMask(direct, width, height) {
  const lum = Array.from({ length: width * height }, (_, p) => luminance(direct, p));
  const lit = lum.filter((v) => v > 1e-4).sort((a, b) => a - b);
  const threshold = 0.05 * (lit[lit.length >> 1] ?? 0);
  return Uint8Array.from(lum, (v) => (v < threshold ? 1 : 0));
}

/** 1 inside the normalized rectangle, else 0. */
export function regionMask(region, width, height) {
  const mask = new Uint8Array(width * height);
  for (let y = Math.floor(region.y0 * height); y < Math.ceil(region.y1 * height); y++)
    for (let x = Math.floor(region.x0 * width); x < Math.ceil(region.x1 * width); x++)
      mask[y * width + x] = 1;
  return mask;
}

/**
 * Luminance statistics of a test indirect image against the reference
 * indirect image, optionally restricted to a mask.
 */
export function indirectMetrics(test, reference, mask) {
  const pixels = test.length / 3;
  const a = [];
  const b = [];
  for (let p = 0; p < pixels; p++) {
    if (mask !== undefined && !mask[p]) continue;
    a.push(luminance(test, p));
    b.push(luminance(reference, p));
  }
  const mean = meanOf(a);
  const referenceMean = meanOf(b);
  const rmse = Math.sqrt(meanOf(a.map((v, i) => (v - b[i]) ** 2)));
  return {
    pixels: a.length,
    mean,
    referenceMean,
    ratio: referenceMean > 0 ? mean / referenceMean : Number.NaN,
    meanRelativeError:
      referenceMean > 0 ? Math.abs(mean - referenceMean) / referenceMean : Number.NaN,
    rmse,
    relativeRmse: referenceMean > 0 ? rmse / referenceMean : Number.NaN,
  };
}

export const subtract = (a, b) => a.map((v, i) => v - b[i]);

/** Portable float map: binary little-endian RGB, rows bottom-to-top. */
export function writePfm(path, rgb, width, height) {
  const header = Buffer.from(`PF\n${width} ${height}\n-1.0\n`, 'ascii');
  const body = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    body.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), (height - 1 - y) * width * 3);
  writeFileSync(path, Buffer.concat([header, Buffer.from(body.buffer)]));
}

/** Inverse of writePfm: rows top-to-bottom, tightly packed linear RGB. */
export function readPfm(path) {
  const bytes = readFileSync(path);
  let offset = 0;
  const line = () => {
    const end = bytes.indexOf(10, offset);
    const text = bytes.subarray(offset, end).toString('ascii');
    offset = end + 1;
    return text;
  };
  if (line() !== 'PF') throw new Error(`${path}: not an RGB PFM`);
  const [width, height] = line().split(' ').map(Number);
  if (Number(line()) >= 0) throw new Error(`${path}: big-endian PFM is unsupported`);
  const body = new Float32Array(bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + width * height * 12));
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    rgb.set(body.subarray((height - 1 - y) * width * 3, (height - y) * width * 3), y * width * 3);
  return { width, height, rgb };
}

const srgb = (v) => {
  const c = Math.max(0, v);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};

/** Display encoding: exposure, Reinhard, sRGB transfer, to RGBA8. */
export function toDisplay(rgb, width, height, exposure = 1) {
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) {
      const v = rgb[p * 3 + c] * exposure;
      out[p * 4 + c] = Math.round(255 * Math.min(1, srgb(v / (1 + v))));
    }
    out[p * 4 + 3] = 255;
  }
  return out;
}

/** Signed error heatmap: blue = under, red = over, saturated at `scale`. */
export function toHeatmap(test, reference, width, height, scale) {
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const d = Math.max(-1, Math.min(1, (luminance(test, p) - luminance(reference, p)) / scale));
    out[p * 4] = Math.round(255 * Math.max(0, d));
    out[p * 4 + 1] = Math.round(255 * (1 - Math.abs(d)) * 0.15);
    out[p * 4 + 2] = Math.round(255 * Math.max(0, -d));
    out[p * 4 + 3] = 255;
  }
  return out;
}

export function writePng(path, rgba, width, height) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

// 3x5 glyphs for contact-sheet labels: enough for scene/lane names and numbers.
const GLYPHS = {
  A: '010101111101101',
  B: '110101110101110',
  C: '011100100100011',
  D: '110101101101110',
  E: '111100110100111',
  F: '111100110100100',
  G: '011100101101011',
  H: '101101111101101',
  I: '111010010010111',
  J: '001001001101010',
  K: '101101110101101',
  L: '100100100100111',
  M: '101111111101101',
  N: '110101101101101',
  O: '010101101101010',
  P: '110101110100100',
  Q: '010101101110011',
  R: '110101110101101',
  S: '011100010001110',
  T: '111010010010010',
  U: '101101101101111',
  V: '101101101101010',
  W: '101101111111101',
  X: '101101010101101',
  Y: '101101010010010',
  Z: '111001010100111',
  0: '111101101101111',
  1: '010110010010111',
  2: '110001010100111',
  3: '110001010001110',
  4: '101101111001001',
  5: '111100110001110',
  6: '011100111101111',
  7: '111001010010010',
  8: '111101111101111',
  9: '111101111001110',
  '.': '000000000000010',
  '-': '000000111000000',
  '=': '000111000111000',
  '%': '101001010100101',
  '/': '001001010100100',
  ':': '000010000010000',
  ' ': '000000000000000',
};

function drawText(sheet, sheetWidth, text, x0, y0, scale) {
  let x = x0;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '];
    for (let gy = 0; gy < 5; gy++)
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy * 3 + gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const o = ((y0 + gy * scale + sy) * sheetWidth + x + gx * scale + sx) * 4;
            sheet[o] = sheet[o + 1] = sheet[o + 2] = 235;
            sheet[o + 3] = 255;
          }
      }
    x += 4 * scale;
  }
}

/**
 * Grid of RGBA8 tiles with a text row above each tile. `rows` is an array of
 * arrays of `{ label, rgba }`; every tile has the same size.
 */
export function contactSheet(rows, tileWidth, tileHeight) {
  const gap = 6;
  const scale = Math.max(1, Math.floor(tileWidth / 128));
  const labelHeight = 5 * scale + 6;
  const columns = Math.max(...rows.map((row) => row.length));
  const width = columns * (tileWidth + gap) + gap;
  const height = rows.length * (tileHeight + labelHeight + gap) + gap;
  const sheet = new Uint8Array(width * height * 4);
  for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;
  rows.forEach((row, r) => {
    row.forEach((tile, c) => {
      const x0 = gap + c * (tileWidth + gap);
      const y0 = gap + r * (tileHeight + labelHeight + gap);
      drawText(sheet, width, tile.label, x0, y0, scale);
      for (let y = 0; y < tileHeight; y++)
        sheet.set(
          tile.rgba.subarray(y * tileWidth * 4, (y + 1) * tileWidth * 4),
          ((y0 + labelHeight + y) * width + x0) * 4,
        );
    });
  });
  return { rgba: sheet, width, height };
}
