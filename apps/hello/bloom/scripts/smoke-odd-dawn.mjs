#!/usr/bin/env node

// Real Dawn regression for the HDR D0 coverage rule.  This deliberately uses
// the cooked production shader and a native WebGPU device; the CPU calculation
// below is only an independent oracle for the readback, never a replacement
// for the GPU pass.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { teardownDawnInstance } from '../../../../scripts/lib/dawn-teardown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const manifest = await readShaderManifestPublication(
  JSON.parse(readFileSync(resolve(appRoot, 'dist/shaders/manifest.json'), 'utf8')),
);
const entry = manifest.entries.find((candidate) => candidate.wgsl.includes('BloomDownsampleParams'));
if (entry === undefined) throw new Error('cooked bloom-downsample shader is missing from the manifest');

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
let gpu = create([]);
const adapter = await gpu.requestAdapter();
if (adapter === null) throw new Error('Dawn adapter is unavailable');
const device = await adapter.requestDevice();

const sourceUsage = 0x02 | 0x04;
const targetUsage = 0x01 | 0x10;
const mapRead = 0x01;
const copyDst = 0x08;
const HDR_CEILING = 65504;
const HALF_SUBNORMAL_STEP = 2 ** -24;
// A binary16 subnormal has a fixed absolute quantum. Below this derived
// floor, a relative error is not a meaningful contract for an rgba16float
// attachment; the oracle still requires the decoded value to be within one
// storage quantum. This is a measurement boundary, not a runtime clamp.
const HALF_RELATIVE_FLOOR = HALF_SUBNORMAL_STEP / 0.01;
const REC709_LUMA = [0.2126, 0.7152, 0.0722];

function floatToHalf(value) {
  const scratch = new ArrayBuffer(4);
  const float = new Float32Array(scratch);
  const bits = new Uint32Array(scratch);
  float[0] = value;
  const sign = (bits[0] >>> 31) & 1;
  const exponent = (bits[0] >>> 23) & 0xff;
  let mantissa = bits[0] & 0x7fffff;
  if (exponent === 0xff) return (sign << 15) | 0x7c00 | (mantissa === 0 ? 0 : 0x200);
  if (exponent === 0) return sign << 15;
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return (sign << 15) | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign << 15;
    mantissa = (mantissa | 0x800000) >> (1 - halfExponent);
    return (sign << 15) | (mantissa >> 13);
  }
  return (sign << 15) | (halfExponent << 10) | (mantissa >> 13);
}

function halfToFloat(bits) {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * (mantissa / 1024) * 2 ** -14;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function asColor(value) {
  return Array.isArray(value) ? value : [value, 0, 0];
}

function sourceBytes(values, width, height) {
  const bytesPerRow = 256;
  const bytes = new Uint8Array(bytesPerRow * height);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const offset = y * bytesPerRow + x * 8;
    const color = asColor(value);
    view.setUint16(offset, floatToHalf(color[0] ?? 0), true);
    view.setUint16(offset + 2, floatToHalf(color[1] ?? 0), true);
    view.setUint16(offset + 4, floatToHalf(color[2] ?? 0), true);
    view.setUint16(offset + 6, floatToHalf(1), true);
  });
  return { bytes, bytesPerRow };
}

function extractBloom(color, threshold, softKnee) {
  const c = color.map((channel) => Math.max(channel, 0));
  const luma = Math.min(
    Math.max(
      c[0] * REC709_LUMA[0] + c[1] * REC709_LUMA[1] + c[2] * REC709_LUMA[2],
      0,
    ),
    HDR_CEILING,
  );
  if (threshold === 0) return c;
  const knee = threshold * softKnee;
  if (knee === 0) {
    const response = Math.max(luma - threshold, 0);
    return c.map((channel) => (channel * response) / Math.max(luma, 1e-6));
  }
  const q = Math.min(Math.max(luma + (knee - threshold), 0), 2 * knee);
  const soft = (q * q) / (4 * knee);
  const response = Math.max(luma - threshold, soft);
  return c.map((channel) => (channel * response) / Math.max(luma, 1e-6));
}

function areaAverage(values, sourceWidth, sourceHeight, targetWidth, targetHeight, x, y) {
  const minX = (x * sourceWidth) / targetWidth;
  const maxX = ((x + 1) * sourceWidth) / targetWidth;
  const minY = (y * sourceHeight) / targetHeight;
  const maxY = ((y + 1) * sourceHeight) / targetHeight;
  let sum = 0;
  let coverage = 0;
  for (let sourceY = Math.floor(minY); sourceY < Math.ceil(maxY); sourceY += 1) {
    for (let sourceX = Math.floor(minX); sourceX < Math.ceil(maxX); sourceX += 1) {
      const weight =
        Math.max(0, Math.min(maxX, sourceX + 1) - Math.max(minX, sourceX)) *
        Math.max(0, Math.min(maxY, sourceY + 1) - Math.max(minY, sourceY));
      sum += (values[sourceY * sourceWidth + sourceX] ?? 0) * weight;
      coverage += weight;
    }
  }
  return sum / coverage;
}

async function readTarget(texture, width, height) {
  const bytesPerRow = 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: mapRead | copyDst,
  });
  const encoder = device.createCommandEncoder({ label: 'hello-bloom-odd-readback' });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buffer.mapAsync(mapRead);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const view = new DataView(bytes.buffer);
  return Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const offset = y * bytesPerRow + x * 8;
    return {
      red: halfToFloat(view.getUint16(offset, true)),
      green: halfToFloat(view.getUint16(offset + 2, true)),
      blue: halfToFloat(view.getUint16(offset + 4, true)),
      alpha: halfToFloat(view.getUint16(offset + 6, true)),
    };
  });
}

const shaderModule = device.createShaderModule({ code: entry.wgsl, label: 'bloom-downsample-odd-regression' });
const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: shaderModule, entryPoint: 'vs_main' },
  fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
  primitive: { topology: 'triangle-list' },
});
const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
const params = device.createBuffer({ size: 256, usage: 0x40 | copyDst });

async function runCase(testCase) {
  const source = device.createTexture({
    size: { width: testCase.sourceWidth, height: testCase.sourceHeight, depthOrArrayLayers: 1 },
    format: 'rgba16float',
    usage: sourceUsage,
  });
  const target = device.createTexture({
    size: { width: testCase.targetWidth, height: testCase.targetHeight, depthOrArrayLayers: 1 },
    format: 'rgba16float',
    usage: targetUsage,
  });
  const sourceUpload = sourceBytes(testCase.values, testCase.sourceWidth, testCase.sourceHeight);
  device.queue.writeTexture(
    { texture: source },
    sourceUpload.bytes,
    { bytesPerRow: sourceUpload.bytesPerRow, rowsPerImage: testCase.sourceHeight },
    { width: testCase.sourceWidth, height: testCase.sourceHeight, depthOrArrayLayers: 1 },
  );
  device.queue.writeBuffer(params, 0, new Float32Array([
    testCase.threshold ?? 0,
    testCase.softKnee ?? 0,
    testCase.targetWidth,
    testCase.targetHeight,
    0,
    0,
    0,
    0,
  ]));
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: source.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: params, size: 32 } },
    ],
  });
  const encoder = device.createCommandEncoder({ label: `${testCase.label}-encode` });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  const actual = await readTarget(target, testCase.targetWidth, testCase.targetHeight);
  const threshold = testCase.threshold ?? 0;
  const softKnee = testCase.softKnee ?? 0;
  const extracted = testCase.values.map((value) => {
    const sourceColor = asColor(value).map((channel) => halfToFloat(floatToHalf(channel ?? 0)));
    return extractBloom(sourceColor, threshold, softKnee);
  });
  const expected = actual.map((_, index) => {
    const x = index % testCase.targetWidth;
    const y = Math.floor(index / testCase.targetWidth);
    return [0, 1, 2].map((channel) =>
      areaAverage(
        extracted.map((color) => color[channel] ?? 0),
        testCase.sourceWidth,
        testCase.sourceHeight,
        testCase.targetWidth,
        testCase.targetHeight,
        x,
        y,
      ),
    );
  });
  source.destroy();
  target.destroy();
  const errors = actual.flatMap((pixel, index) => {
    const expectedColor = expected[index] ?? [0, 0, 0];
    const actualColor = [pixel.red, pixel.green, pixel.blue];
    return actualColor
      .flatMap((value, channel) => {
        const reference = expectedColor[channel] ?? 0;
        const absoluteError = Math.abs(value - reference);
        const normalizedError = Number.isFinite(value)
          ? absoluteError / Math.max(Math.abs(reference), HALF_RELATIVE_FLOOR)
          : Infinity;
        const exactZeroViolation = reference === 0 && value !== 0;
        const invalidOutput = !Number.isFinite(value) || value < 0;
        return normalizedError > 0.01 || invalidOutput || exactZeroViolation
          ? [{
              index,
              channel,
              reference,
              actual: value,
              absoluteError,
              normalizedError,
              reason: exactZeroViolation ? 'zero-must-be-exact' : invalidOutput ? 'finite-nonnegative-required' : 'normalized-error',
            }]
          : [];
      })
      .concat(
        pixel.alpha < 0.99 || !Number.isFinite(pixel.alpha)
          ? [{ index, channel: 'alpha', reference: 1, actual: pixel.alpha }]
          : [],
      );
  });
  const maxNormalizedError = Math.max(
    0,
    ...actual.flatMap((pixel, index) =>
      [pixel.red, pixel.green, pixel.blue].map((value, channel) => {
        const reference = expected[index]?.[channel] ?? 0;
        return Number.isFinite(value)
          ? Math.abs(value - reference) / Math.max(Math.abs(reference), HALF_RELATIVE_FLOOR)
          : Infinity;
      }),
    ),
  );
  return { label: testCase.label, threshold, softKnee, expected, actual, maxNormalizedError, errors };
}

const oddCases = [
  { label: '3x1-to-2x1', sourceWidth: 3, sourceHeight: 1, targetWidth: 2, targetHeight: 1, values: [0, 6, 0] },
  { label: '5x3-to-3x2', sourceWidth: 5, sourceHeight: 3, targetWidth: 3, targetHeight: 2, values: Array.from({ length: 15 }, (_, index) => index) },
];
const extractionCases = [];
for (const threshold of [0, 1, HDR_CEILING]) {
  for (const softKnee of [0, 0.5, 1]) {
    for (const rgb of [
      [0, 0, 0],
      [0.5, 0.5, 0.5],
      [1, 1, 1],
      [1.5, 1.5, 1.5],
      [2, 2, 2],
      [8, 0, 0],
      [0, 8, 0],
      [0, 0, 32],
      [HDR_CEILING, HDR_CEILING, HDR_CEILING],
      [HDR_CEILING, 0, 0],
    ]) {
      extractionCases.push({
        label: `extraction-${threshold}-${softKnee}-${rgb.join('-')}`,
        sourceWidth: 2,
        sourceHeight: 2,
        targetWidth: 1,
        targetHeight: 1,
        threshold,
        softKnee,
        values: [rgb, rgb, rgb, rgb],
      });
    }
  }
}
for (const value of [0.51, 0.53, 0.55, 0.57, 0.59, 0.61, 0.63, 0.65, 0.67]) {
  extractionCases.push({
    label: `subnormal-knee-${value}`,
    sourceWidth: 2,
    sourceHeight: 2,
    targetWidth: 1,
    targetHeight: 1,
    threshold: HDR_CEILING,
    softKnee: 1,
    values: Array.from({ length: 4 }, () => [value, value, value]),
  });
}
extractionCases.push({
  label: 'per-texel-extraction-before-averaging',
  sourceWidth: 2,
  sourceHeight: 2,
  targetWidth: 1,
  targetHeight: 1,
  threshold: 1,
  softKnee: 0,
  values: [[4, 4, 4], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
});
const cases = [...oddCases, ...extractionCases];
const results = [];
for (const testCase of cases) results.push(await runCase(testCase));

// Exercise the continuous threshold transition with the same real cooked
// shader.  A legacy whole-RGB `if (luma > threshold)` switch produces a
// unit-sized jump at the threshold; the authored formula remains monotonic
// and its adjacent decoded steps stay close to the independent oracle.
const continuityCases = [
  {
    label: 'threshold-continuity-hard-knee',
    threshold: 1,
    softKnee: 0,
    inputs: [0.999, 1, 1.001, 1.01],
  },
  {
    label: 'threshold-continuity-soft-knee',
    threshold: 1,
    softKnee: 0.5,
    inputs: [0.999, 1, 1.001, 1.01],
  },
  {
    label: 'threshold-continuity-soft-knee-start',
    threshold: 1,
    softKnee: 0.5,
    inputs: [0.499, 0.5, 0.501, 0.51],
  },
];
const continuityResults = [];
for (const testCase of continuityCases) {
  const samples = [];
  for (const [index, input] of testCase.inputs.entries()) {
    const result = await runCase({
      label: `${testCase.label}-${index}`,
      threshold: testCase.threshold,
      softKnee: testCase.softKnee,
      sourceWidth: 2,
      sourceHeight: 2,
      targetWidth: 1,
      targetHeight: 1,
      values: Array.from({ length: 4 }, () => [input, input, input]),
    });
    samples.push({ input, expected: result.expected[0]?.[0] ?? 0, actual: result.actual[0]?.red ?? Number.NaN, errors: result.errors });
  }
  const actual = samples.map((sample) => sample.actual);
  const expected = samples.map((sample) => sample.expected);
  const errors = samples.flatMap((sample) => sample.errors);
  const finite = actual.every(Number.isFinite) && expected.every(Number.isFinite);
  const maxExpectedAdjacentJump = finite ? Math.max(0, ...expected.slice(1).map((value, index) => Math.abs(value - expected[index]))) : Infinity;
  const maxObservedAdjacentJump = finite ? Math.max(0, ...actual.slice(1).map((value, index) => Math.abs(value - actual[index]))) : Infinity;
  const maxAllowedAdjacentJump = Math.max(maxExpectedAdjacentJump * 4, HALF_SUBNORMAL_STEP * 4);
  continuityResults.push({
    label: testCase.label,
    threshold: testCase.threshold,
    softKnee: testCase.softKnee,
    inputs: testCase.inputs,
    expected,
    actual,
    finite,
    monotonic: finite && actual.every((value, index) => index === 0 || value >= actual[index - 1]),
    maxExpectedAdjacentJump,
    maxObservedAdjacentJump,
    maxAllowedAdjacentJump,
    errors,
  });
}
const continuityFailures = continuityResults.filter(
  (result) =>
    result.errors.length > 0 ||
    !result.monotonic ||
    result.maxObservedAdjacentJump > result.maxAllowedAdjacentJump,
);
const failures = results.filter((result) => result.errors.length > 0);
// Keep the native instance alive until destruction and completion callbacks
// have settled, as in the standalone Custom Shader and Vitest Dawn owners.
const destroyed = device.lost;
await teardownDawnInstance([device], async () => {
  const loss = await destroyed;
  if (loss.reason !== 'destroyed') {
    throw new Error(`unexpected Dawn device loss: ${loss.reason}: ${loss.message}`);
  }
  gpu = undefined;
});
const repoRoot = resolve(here, '..', '..', '..', '..');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const evidence = {
  schemaVersion: 'hello-bloom-extraction-dawn/1',
  sourceRevision,
  backend: 'dawn-node',
  caseCount: cases.length,
  extractionCaseCount: extractionCases.length,
  continuityCaseCount: continuityCases.length,
  halfFloatMeasurement: {
    format: 'rgba16float',
    subnormalStep: HALF_SUBNORMAL_STEP,
    relativeFloor: HALF_RELATIVE_FLOOR,
    rule: 'absolute decoded error is bounded by one binary16 storage quantum below the derived relative floor',
  },
  cases: results,
  continuity: {
    rule: 'decoded threshold-adjacent output remains monotonic and its adjacent jump stays within four times the independent continuous-oracle jump, with a four-quantum floor',
    cases: continuityResults,
    failed: continuityFailures,
  },
  failed: failures,
  verdict: failures.length === 0 && continuityFailures.length === 0 ? 'pass' : 'fail',
};
const evidenceDir = resolve(here, '..', 'evidence');
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(resolve(evidenceDir, 'extraction-dawn-result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
const failed = failures.length > 0 || continuityFailures.length > 0;
if (failed) process.exit(1);
