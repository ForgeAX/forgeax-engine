#!/usr/bin/env node
// Compare a scene re-execution against the portable tape's selected-work output.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import UPNG from 'upng-js';

const [evidenceDirectory, nativeResultPath] = process.argv.slice(2);
if (!evidenceDirectory || !nativeResultPath)
  throw new Error(
    'usage: node scripts/raytracing/compare-native.mjs <evidence-directory> <native-result.json>',
  );
const bytes = await readFile(join(evidenceDirectory, 'portable-hits.bin'));
const native = JSON.parse(await readFile(nativeResultPath, 'utf8'));
const summary = JSON.parse(await readFile(join(evidenceDirectory, 'summary.json'), 'utf8'));
if (
  native.capabilities?.rayQuery !== true ||
  !Array.isArray(native.hits) ||
  native.hits.length !== summary.rayCount ||
  bytes.byteLength !== summary.rayCount * 32
)
  throw new Error('incomplete native result or portable evidence');
const expected = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const storage = new ArrayBuffer(4),
  bits = new DataView(storage);
const float = (word) => {
  bits.setUint32(0, word, true);
  return bits.getFloat32(0, true);
};
const failures = [];
let failedRays = 0;
for (let i = 0; i < native.hits.length; i++) {
  const actual = native.hits[i];
  if (
    !Array.isArray(actual) ||
    actual.length !== 8 ||
    actual.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffffffff)
  )
    throw new Error(`invalid native hit ${i}`);
  const mismatch = [];
  for (let j = 0; j < 4; j++)
    if (actual[j] !== expected.getUint32(i * 32 + j * 4, true)) mismatch.push(`identity[${j}]`);
  for (let j = 4; j < 8; j++) {
    const a = float(actual[j]),
      b = expected.getFloat32(i * 32 + j * 4, true);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      Math.abs(a - b) > (j === 7 ? 0 : 1e-4 * Math.max(1, Math.abs(b)))
    )
      mismatch.push(`metric[${j - 4}]`);
  }
  if (mismatch.length) {
    failedRays++;
    if (failures.length < 32)
      failures.push({
        ray: i,
        fields: mismatch,
        native: actual,
        portable: Array.from({ length: 8 }, (_, j) => expected.getUint32(i * 32 + j * 4, true)),
      });
  }
}
const report = {
  status: failedRays === 0 ? 'passed' : 'failed',
  comparison:
    'native scene re-execution vs portable RHI tape work 0; CPU oracle checked by Dawn fixture',
  nativeWgpu: native.wgpuVersion,
  capabilities: native.capabilities,
  rayCount: summary.rayCount,
  failedRays,
  tolerance: {
    identities: 'exact u32',
    metrics: '1e-4 * max(1, abs(reference))',
    frontFace: 'exact',
  },
  firstFailures: failures,
};
await writeFile(join(evidenceDirectory, 'native-comparison.json'), JSON.stringify(report, null, 2));
// A visualization of GPU query results, not a raster/material or GI screenshot.
const width = 96,
  height = 48,
  scale = 6;
const render = (nativeWords) => {
  const pixels = new Uint8Array(width * height * scale * scale * 4);
  for (let y = 0; y < height * scale; y++)
    for (let x = 0; x < width * scale; x++) {
      const ray = 8 + Math.floor(y / scale) * width + Math.floor(x / scale),
        o = (y * width * scale + x) * 4;
      const hit = nativeWords
        ? native.hits[ray][0] !== 0xffffffff
        : expected.getUint32(ray * 32, true) !== 0xffffffff;
      const u = nativeWords ? float(native.hits[ray][5]) : expected.getFloat32(ray * 32 + 20, true);
      const v = nativeWords ? float(native.hits[ray][6]) : expected.getFloat32(ray * 32 + 24, true);
      pixels.set(
        hit
          ? [Math.round(255 * (1 - u - v)), Math.round(255 * u), Math.round(255 * v), 255]
          : [12, 16, 24, 255],
        o,
      );
    }
  return UPNG.encode([pixels.buffer], width * scale, height * scale, 0);
};
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(join(evidenceDirectory, 'portable-query.png'), Buffer.from(render(false)));
await writeFile(join(evidenceDirectory, 'native-query.png'), Buffer.from(render(true)));
console.log(JSON.stringify({ status: report.status, rays: report.rayCount, failedRays }));
if (failedRays) process.exitCode = 1;
