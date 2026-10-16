#!/usr/bin/env node
// Compare the same four cooked Surface cells at the final presented pixels.
// Both source PNGs are emitted by smoke-surface-standard-four-cell.mjs; the
// WebGPU image comes from the swapchain copy, not a headless compositor shot.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const [webgl2Dir, webgpuDir, outputDir] = process.argv.slice(2);
if (!webgl2Dir || !webgpuDir || !outputDir) {
  throw new Error('usage: compare-surface-standard-backends.mjs <webgl2-dir> <webgpu-dir> <output-dir>');
}
const webgl2 = JSON.parse(readFileSync(resolve(webgl2Dir, 'surface-standard-four-cell.json'), 'utf8'));
const webgpu = JSON.parse(readFileSync(resolve(webgpuDir, 'surface-standard-four-cell.json'), 'utf8'));
if (webgl2.sourceSha !== webgpu.sourceSha) throw new Error('surface source SHA mismatch');
if (webgl2.evidence?.status !== 'pass' || webgl2.evidence.completedFrames !== 60 || webgl2.evidence.cells?.length !== 4) {
  throw new Error('WebGL2 four-cell material evidence did not pass');
}
if (webgpu.evidence?.status !== 'pass' || webgpu.evidence.completedFrames !== 60 || webgpu.evidence.cells?.length !== 4) {
  throw new Error('WebGPU four-cell material evidence did not pass');
}
for (const [backend, report] of [['WebGL2', webgl2], ['WebGPU', webgpu]]) {
  if (report.pageErrors?.length !== 0 || report.consoleErrors?.length !== 0) {
    throw new Error(`${backend} preview emitted page or console errors`);
  }
}
if (webgl2.pixelEvidence?.signalPixels <= 0) throw new Error('WebGL2 presented image has no signal');
for (let index = 0; index < 4; index += 1) {
  const webgl2Cell = webgl2.evidence.cells[index];
  const webgpuCell = webgpu.evidence.cells[index];
  if (
    webgl2Cell.id !== webgpuCell.id ||
    webgl2Cell.record.materialGuid !== webgpuCell.materialGuid ||
    webgl2Cell.record.publicationDigest !== webgpuCell.publicationDigest
  ) throw new Error(`surface publication mismatch at cell ${index}`);
}
if (webgpu.pixelEvidence?.readbackMatch !== true) {
  throw new Error('WebGPU final-display and swapchain did not match');
}
const left = PNG.sync.read(readFileSync(resolve(webgl2Dir, 'surface-standard-final-webgl2.png')));
const right = PNG.sync.read(readFileSync(resolve(webgpuDir, 'surface-standard-final-webgpu-swapchain.png')));
if (left.width !== right.width || left.height !== right.height || left.width % 4 !== 0) {
  throw new Error('surface image extents do not match four equal cells');
}
const epsilon = 0.05;
const cells = webgl2.evidence.cells.map((cell) => ({
  id: cell.id,
  materialGuid: cell.record.materialGuid,
  publicationDigest: cell.record.publicationDigest,
  channels: 0,
  channelDifferenceSum: 0,
  maxDifference: 0,
  overEpsilonChannels: 0,
  webgl2SignalPixels: 0,
  webgpuSignalPixels: 0,
}));
const diff = new PNG({ width: left.width, height: left.height });
for (let y = 0; y < left.height; y += 1) {
  for (let x = 0; x < left.width; x += 1) {
    const pixel = (y * left.width + x) * 4;
    const cell = cells[Math.floor(x / (left.width / 4))];
    if (left.data[pixel] + left.data[pixel + 1] + left.data[pixel + 2] > 0) cell.webgl2SignalPixels += 1;
    if (right.data[pixel] + right.data[pixel + 1] + right.data[pixel + 2] > 0) cell.webgpuSignalPixels += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(left.data[pixel + channel] - right.data[pixel + channel]);
      cell.channels += 1;
      cell.channelDifferenceSum += difference;
      cell.maxDifference = Math.max(cell.maxDifference, difference);
      if (difference / 255 > epsilon) cell.overEpsilonChannels += 1;
      diff.data[pixel + channel] = Math.min(255, difference * 32);
    }
    diff.data[pixel + 3] = 255;
  }
}
const records = cells.map(({ channels, channelDifferenceSum, maxDifference, overEpsilonChannels, ...cell }) => ({
  ...cell,
  maxDifference8: maxDifference,
  maxDifferenceNormalized: maxDifference / 255,
  meanDifference8: channelDifferenceSum / channels,
  meanDifferenceNormalized: channelDifferenceSum / channels / 255,
  overEpsilonChannels,
}));
const result = {
  status: records.every((cell) =>
    cell.webgl2SignalPixels > 0 &&
    cell.webgpuSignalPixels > 0 &&
    cell.overEpsilonChannels === 0
  ) ? 'pass' : 'fail',
  sourceSha: webgl2.sourceSha,
  width: left.width,
  height: left.height,
  epsilon,
  webgl2Image: resolve(webgl2Dir, 'surface-standard-final-webgl2.png'),
  webgpuImage: resolve(webgpuDir, 'surface-standard-final-webgpu-swapchain.png'),
  cells: records,
};
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'surface-standard-parity.json'), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(resolve(outputDir, 'surface-standard-difference-x32.png'), PNG.sync.write(diff));
if (result.status !== 'pass') throw new Error(`Surface parity failed: ${JSON.stringify(result)}`);
console.log(`[surface-standard-parity] PASS maxNormalized=${Math.max(...records.map((cell) => cell.maxDifferenceNormalized))} cells=${records.length}`);
