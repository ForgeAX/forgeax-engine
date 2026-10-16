#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import UPNG from 'upng-js';

const planeNames = ['albedoRoughness', 'normals', 'emissionMetallic', 'f0Validity', 'depth'];
const panelNames = [
  'albedo',
  'roughness',
  'shading-normal',
  'geometric-normal',
  'emission',
  'metallic',
  'f0',
  'validity',
  'depth',
];
const statusColors = [
  [12, 16, 24],
  [40, 190, 70],
  [240, 160, 40],
  [190, 0, 170],
];
const byte = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255);
const srgb = (value) =>
  byte(value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
function half(view, offset) {
  const bits = view.getUint16(offset, true),
    exponent = (bits >> 10) & 31,
    mantissa = bits & 1023;
  return (
    (bits & 32768 ? -1 : 1) *
    (exponent === 0
      ? mantissa * 2 ** -24
      : exponent === 31
        ? mantissa
          ? NaN
          : Infinity
        : (1 + mantissa / 1024) * 2 ** (exponent - 15))
  );
}
function normal(x, y) {
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) [x, y] = [(1 - Math.abs(y)) * (x < 0 ? -1 : 1), (1 - Math.abs(x)) * (y < 0 ? -1 : 1)];
  const length = Math.hypot(x, y, z);
  return [x, y, z].map((value) => byte((value / length) * 0.5 + 0.5));
}

/** Decode the existing fs_card attachments; this is an offline display, not a coverage oracle. */
export function visualizeCardAtlas(planes, width, height, scale = 1) {
  assert(
    [width, height, scale].every((n) => Number.isSafeInteger(n) && n > 0),
    'positive integer extent and scale required',
  );
  const imageWidth = width * scale * 3 + 16,
    imageHeight = height * scale * 3 + 16;
  assert(
    Number.isSafeInteger(imageWidth * imageHeight) && imageWidth * imageHeight <= 64 * 1024 * 1024,
    'diagnostic image exceeds 64M pixels; reduce scale',
  );
  const views = {},
    sources = {};
  for (const name of planeNames) {
    const data = planes[name];
    assert(
      data instanceof Uint8Array && data.byteLength === width * height * (name === 'depth' ? 4 : 8),
      `${name}: expected tightly packed ${name === 'depth' ? 'depth32float' : 'rgba16float'}`,
    );
    views[name] = new DataView(data.buffer, data.byteOffset, data.byteLength);
    sources[name] = {
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      min: Infinity,
      max: -Infinity,
    };
  }
  const rgba = new Uint8Array(imageWidth * imageHeight * 4);
  const counts = { empty: 0, admitted: 0, unsupported: 0, coverageRejected: 0 };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x,
        values = {};
      for (const name of planeNames) {
        const lanes =
          name === 'depth'
            ? [views[name].getFloat32(pixel * 4, true)]
            : [0, 1, 2, 3].map((lane) => half(views[name], pixel * 8 + lane * 2));
        assert(lanes.every(Number.isFinite), `${name}: nonfinite value at texel ${pixel}`);
        for (const value of lanes) {
          sources[name].min = Math.min(sources[name].min, value);
          sources[name].max = Math.max(sources[name].max, value);
        }
        values[name] = lanes;
      }
      const a = values.albedoRoughness,
        n = values.normals,
        e = values.emissionMetallic,
        f = values.f0Validity,
        z = values.depth[0],
        status = f[3];
      assert(
        Number.isInteger(status) && status >= 0 && status <= 3,
        `unknown material validity ${status} at texel ${pixel}`,
      );
      counts[['empty', 'admitted', 'unsupported', 'coverageRejected'][status]]++;
      const gray = (value) => [byte(value), byte(value), byte(value)];
      const panels = [
        a.slice(0, 3).map(srgb),
        gray(a[3]),
        normal(n[0], n[1]),
        normal(n[2], n[3]),
        e.slice(0, 3).map((value) => srgb(Math.max(0, value) / (1 + Math.max(0, value)))),
        gray(e[3]),
        f.slice(0, 3).map(byte),
        statusColors[status],
        gray(z),
      ];
      for (let panel = 0; panel < 9; panel++) {
        // Empty/unsupported channels must not look like a valid +Z normal or black material.
        const color = status === 1 || panel === 7 ? panels[panel] : statusColors[status];
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const px = (panel % 3) * (width * scale + 8) + x * scale + sx;
            const py = Math.floor(panel / 3) * (height * scale + 8) + y * scale + sy;
            rgba.set([...color, 255], (py * imageWidth + px) * 4);
          }
      }
    }
  return {
    rgba,
    width: imageWidth,
    height: imageHeight,
    report: {
      kind: 'material-card-atlas-display',
      extent: { width, height },
      scale,
      panels: panelNames,
      counts,
      sources,
      encoding: {
        albedo: 'linear to sRGB, clipped for display',
        normals: 'oct XY shading / ZW geometric to unit XYZ mapped to RGB',
        emission: 'per-channel Reinhard then sRGB',
        scalarAndF0: 'linear 0..1 grayscale/RGB',
        validity:
          '0 empty dark / 1 admitted green / 2 unsupported orange / 3 coverage rejected magenta',
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [prefix, widthArg, heightArg, scaleArg] = process.argv.slice(2);
  assert(
    prefix,
    'usage: node scripts/raytracing/visualize-card-atlas.mjs <prefix> <width> <height> [scale=1]',
  );
  const planes = Object.fromEntries(
    await Promise.all(
      planeNames.map(async (name) => [
        name,
        new Uint8Array(await readFile(`${prefix}.${name}.bin`)),
      ]),
    ),
  );
  const result = visualizeCardAtlas(
    planes,
    Number(widthArg),
    Number(heightArg),
    scaleArg === undefined ? 1 : Number(scaleArg),
  );
  await writeFile(
    `${prefix}.atlas.png`,
    new Uint8Array(UPNG.encode([result.rgba.buffer], result.width, result.height, 0)),
  );
  await writeFile(`${prefix}.atlas.json`, `${JSON.stringify(result.report, null, 2)}\n`);
  console.log(JSON.stringify({ image: `${prefix}.atlas.png`, counts: result.report.counts }));
}
