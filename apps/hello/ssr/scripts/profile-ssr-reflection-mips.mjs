#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodeTape } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';

// Reducer-only ABBA diagnostic. It compares the production reflection-mip
// entry point before and after the even 2x2 explicit-load candidate. The
// trace, temporal resolve and full-resolution compose are deliberately absent
// so a timing difference cannot be attributed to another SSR stage. Both lanes
// use unfilterable texture loads; this keeps browser and Dawn readbacks on one
// deterministic arithmetic path.

const inputPath = resolve(process.argv[2] ?? '');
assert.ok(inputPath && existsSync(inputPath), `reducer input JSON is missing: ${inputPath}`);
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const tapePath = resolve(dirname(inputPath), 'frame.rhitape');
assert.ok(existsSync(tapePath), `reducer tape is missing beside input JSON: ${tapePath}`);
const decodedTape = decodeTape(new Uint8Array(readFileSync(tapePath)));
assert.ok(decodedTape.ok, `reducer tape failed strict decode: ${decodedTape.error?.code ?? 'unknown'}`);

const arg = (prefix, fallback) => {
  const value = process.argv.find((entry) => entry.startsWith(`${prefix}=`));
  return value === undefined ? fallback : value.slice(prefix.length + 1);
};
const outputPath = resolve(arg('--output', resolve(dirname(inputPath), 'ssr-reflection-mip-abba.json')));
const warmupBatches = Number(arg('--warmup', '4'));
const blocks = Number(arg('--blocks', '8'));
const chainRepeats = Number(arg('--chain-repeats', '32'));
assert.ok(Number.isInteger(warmupBatches) && warmupBatches >= 1 && warmupBatches <= 64);
assert.ok(Number.isInteger(blocks) && blocks >= 2 && blocks <= 32);
assert.ok(Number.isInteger(chainRepeats) && chainRepeats >= 1 && chainRepeats <= 256);

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shaderCompiler = (await import(
  /* @vite-ignore */ new URL('../../../../packages/shader-compiler/dist/index.mjs', import.meta.url).href
));
const candidateShaderPath = resolve(process.cwd(), 'packages/shader/src/ssr-temporal.wgsl');
const baselineShaderPath = resolve(
  process.env.SSR_REDUCER_BASELINE_ROOT ?? '/private/tmp/forgeax-ssr-verify-ce575',
  'packages/shader/src/ssr-temporal.wgsl',
);
assert.ok(existsSync(candidateShaderPath), `candidate shader is missing: ${candidateShaderPath}`);
assert.ok(existsSync(baselineShaderPath), `baseline shader is missing: ${baselineShaderPath}`);
const commonSource = readFileSync(resolve(process.cwd(), 'packages/shader/src/common.wgsl'), 'utf8');

async function compile(source, id) {
  const result = await shaderCompiler.compileShader(source, {
    id,
    imports: { 'forgeax_view::common': commonSource },
  });
  assert.ok(result.ok && result.value !== undefined, `shader compile failed for ${id}: ${JSON.stringify(result.error)}`);
  return result.value.wgsl;
}

const backend = await bootstrapDawn('SSR reflection mip ABBA', { ...decodedTape.value });
const adapter = (await backend.rhiWebgpu.rhi.requestAdapter()).unwrap();
assert.ok(adapter.features.has('timestamp-query'), 'Dawn adapter does not expose timestamp-query');
backend.freshDevice.destroy?.();
const device = (await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })).unwrap();
const periodNs = device.caps.timestampPeriodNanoseconds;
assert.ok(device.caps.timestampQuery === true && Number.isFinite(periodNs) && periodNs > 0,
  'reducer ABBA requires Dawn timestamp-query evidence');

const textureUsage = globalThis.GPUTextureUsage ?? {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
};
const bufferUsage = globalThis.GPUBufferUsage ?? {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  QUERY_RESOLVE: 512,
};
const shaderStage = globalThis.GPUShaderStage ?? { COMPUTE: 4 };
const mapMode = globalThis.GPUMapMode ?? { READ: 1 };

const radianceEntry = input.textures?.find((entry) => entry.name === 'radiance');
assert.ok(radianceEntry?.levels?.length > 1, 'reducer input has no radiance mip chain');
const levels = radianceEntry.levels.map(({ width, height }) => ({ width, height }));
const sourceEntry = radianceEntry.levels[0];
const sourceLevel = levels[0];
assert.deepEqual(sourceLevel, { width: 960, height: 540 }, 'ABBA input must be the captured 960x540 mip0');
assert.ok(sourceEntry?.path, 'captured radiance mip0 path is missing');
const sourceBytes = new Uint8Array(readFileSync(sourceEntry.path));
assert.equal(sourceBytes.byteLength, sourceLevel.width * sourceLevel.height * 8);

const paddedRows = (bytes, width, height, bytesPerPixel) => {
  assert.equal(bytes.byteLength, width * height * bytesPerPixel);
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
  const padded = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    padded.set(
      bytes.subarray(y * width * bytesPerPixel, (y + 1) * width * bytesPerPixel),
      y * bytesPerRow,
    );
  }
  return { bytes: padded, bytesPerRow };
};

const halfToFloat = (bits) => {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};

const readTightRgba16f = (bytes, width, height) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Array(width * height * 4);
  for (let index = 0; index < values.length; index += 1) values[index] = halfToFloat(view.getUint16(index * 2, true));
  return values;
};

const sourcePixels = readTightRgba16f(sourceBytes, sourceLevel.width, sourceLevel.height);

function referenceReduce(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const target = new Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const firstX = Math.floor((x * sourceWidth) / targetWidth);
      const endX = Math.floor(((x + 1) * sourceWidth) / targetWidth);
      const firstY = Math.floor((y * sourceHeight) / targetHeight);
      const endY = Math.floor(((y + 1) * sourceHeight) / targetHeight);
      assert.ok(endX > firstX && endY > firstY, `empty reference footprint at ${x},${y}`);
      const sum = [0, 0, 0, 0];
      let count = 0;
      for (let sy = firstY; sy < endY; sy += 1) {
        for (let sx = firstX; sx < endX; sx += 1) {
          const offset = (sy * sourceWidth + sx) * 4;
          for (let channel = 0; channel < 4; channel += 1) sum[channel] += source[offset + channel];
          count += 1;
        }
      }
      const outputOffset = (y * targetWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) target[outputOffset + channel] = sum[channel] / count;
    }
  }
  return target;
}

const makeTexture = (label, size, usage) => device.createTexture({
  label,
  size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
  format: 'rgba16float',
  textureBindingViewDimension: '2d',
  usage,
}).unwrap();

const makeVariant = async ({ key, sourcePath, filtering }) => {
  const source = readFileSync(sourcePath, 'utf8');
  const compiled = await compile(source, `forgeax_ssr::temporal::${key}`);
  const module = (await backend.rhiWebgpu.createShaderModule(device, {
    code: compiled,
    label: `ssr-reflection-mip-${key}`,
  })).unwrap();
  const layoutEntries = [
    {
      binding: 0,
      visibility: shaderStage.COMPUTE,
      texture: { sampleType: filtering ? 'float' : 'unfilterable-float', viewDimension: '2d' },
    },
    {
      binding: 7,
      visibility: shaderStage.COMPUTE,
      storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
    },
    ...(filtering
      ? [{ binding: 12, visibility: shaderStage.COMPUTE, sampler: { type: 'filtering' } }]
      : []),
  ];
  const layout = device.createBindGroupLayout({ entries: layoutEntries }).unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const pipeline = device.createComputePipeline({
    label: `ssr-reflection-mip-${key}`,
    layout: pipelineLayout,
    compute: { module, entryPoint: 'ssr_reflection_mip' },
  }).unwrap();
  const sampler = filtering
    ? device.createSampler({
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'nearest',
      }).unwrap()
    : undefined;
  const textures = levels.map((size, level) => makeTexture(
    `ssr-reflection-mip-${key}-${level}`,
    size,
    level === 0
      ? textureUsage.COPY_DST | textureUsage.TEXTURE_BINDING
      : textureUsage.COPY_SRC | textureUsage.TEXTURE_BINDING | textureUsage.STORAGE_BINDING,
  ));
  const upload = paddedRows(sourceBytes, sourceLevel.width, sourceLevel.height, 8);
  device.queue.writeTexture(
    { texture: textures[0] },
    upload.bytes,
    { offset: 0, bytesPerRow: upload.bytesPerRow, rowsPerImage: sourceLevel.height },
    { width: sourceLevel.width, height: sourceLevel.height, depthOrArrayLayers: 1 },
  ).unwrap();
  const views = textures.map((texture) => device.createTextureView(texture, { dimension: '2d' }).unwrap());
  const bindGroups = levels.slice(1).map((_, index) => device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: views[index] } },
      { binding: 7, resource: { kind: 'textureView', value: views[index + 1] } },
      ...(filtering ? [{ binding: 12, resource: { kind: 'sampler', value: sampler } }] : []),
    ],
  }).unwrap());
  const querySet = device.createQuerySet({ type: 'timestamp', count: 4 }).unwrap();
  const resolve = device.createBuffer({
    label: `ssr-reflection-mip-${key}-resolve`,
    size: 256,
    usage: bufferUsage.QUERY_RESOLVE | bufferUsage.COPY_SRC,
  }).unwrap();
  const readback = device.createBuffer({
    label: `ssr-reflection-mip-${key}-readback`,
    size: 256,
    usage: bufferUsage.MAP_READ | bufferUsage.COPY_DST,
  }).unwrap();
  return { key, filtering, compiled, pipeline, bindGroups, textures, querySet, resolve, readback };
};

const variants = {
  A: await makeVariant({ key: 'baseline', sourcePath: baselineShaderPath, filtering: false }),
  B: await makeVariant({ key: 'candidate', sourcePath: candidateShaderPath, filtering: false }),
};

async function runBatch(variant, timed) {
  const encoder = device.createCommandEncoder({ label: `ssr-reflection-mip-${variant.key}-${timed ? 'measure' : 'warmup'}` }).unwrap();
  for (let repeat = 0; repeat < chainRepeats; repeat += 1) {
    for (let level = 1; level < levels.length; level += 1) {
      const size = levels[level];
      const firstPass = repeat === 0 && level === 1;
      const lastPass = repeat === chainRepeats - 1 && level === levels.length - 1;
      const pass = encoder.beginComputePass(
        timed && (firstPass || lastPass)
          ? {
              timestampWrites: {
                querySet: variant.querySet,
                ...(firstPass ? { beginningOfPassWriteIndex: 0 } : {}),
                ...(lastPass ? { endOfPassWriteIndex: 1 } : {}),
              },
            }
          : undefined,
      );
      pass.setPipeline(variant.pipeline);
      pass.setBindGroup(0, variant.bindGroups[level - 1]);
      pass.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8), 1);
      pass.end();
    }
  }
  if (timed) {
    encoder.resolveQuerySet(variant.querySet, 0, 2, variant.resolve, 0).unwrap();
    encoder.copyBufferToBuffer(variant.resolve, 0, variant.readback, 0, 16);
  }
  const startWall = performance.now();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const wallMs = performance.now() - startWall;
  if (!timed) return { wallMs };
  const mapped = (await variant.readback.mapAsync(mapMode.READ)).unwrap();
  const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
  mapped.unmap();
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const ticks = [0, 1].map((index) => view.getBigUint64(index * 8, true));
  assert.ok(ticks[1] >= ticks[0], `${variant.key} timestamp order is invalid: ${ticks.map((tick) => tick.toString(10)).join(',')}`);
  return {
    wallMs,
    gpuBatchMs: Number(ticks[1] - ticks[0]) * periodNs / 1e6,
  };
}

for (const variant of Object.values(variants)) {
  for (let index = 0; index < warmupBatches; index += 1) await runBatch(variant, false);
}
const samples = { A: [], B: [] };
const order = [];
for (let block = 0; block < blocks; block += 1) {
  for (const key of ['A', 'B', 'B', 'A']) {
    const result = await runBatch(variants[key], true);
    samples[key].push(result);
    order.push({ block, key, ...result });
  }
}

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    sampleCount: values.length,
  };
};

async function readLevel(texture, size) {
  const { bytesPerRow } = paddedRows(new Uint8Array(size.width * size.height * 8), size.width, size.height, 8);
  const readback = device.createBuffer({
    label: `ssr-reflection-mip-correctness-${size.width}x${size.height}`,
    size: bytesPerRow * size.height,
    usage: bufferUsage.MAP_READ | bufferUsage.COPY_DST,
  }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'ssr-reflection-mip-correctness-copy' }).unwrap();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow, rowsPerImage: size.height },
    { width: size.width, height: size.height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readback.mapAsync(mapMode.READ)).unwrap();
  const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
  mapped.unmap();
  const tight = new Uint8Array(size.width * size.height * 8);
  for (let y = 0; y < size.height; y += 1) {
    tight.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + size.width * 8), y * size.width * 8);
  }
  return readTightRgba16f(tight, size.width, size.height);
}

async function correctness(variant) {
  let source = sourcePixels;
  let sourceWidth = sourceLevel.width;
  let sourceHeight = sourceLevel.height;
  const levelReceipts = [];
  for (let level = 1; level < levels.length; level += 1) {
    const size = levels[level];
    const actual = await readLevel(variant.textures[level], size);
    const expected = referenceReduce(source, sourceWidth, sourceHeight, size.width, size.height);
    let maxAbsError = 0;
    let nonFinite = 0;
    let alphaOutOfRange = 0;
    for (let index = 0; index < actual.length; index += 1) {
      const value = actual[index];
      if (!Number.isFinite(value)) nonFinite += 1;
      maxAbsError = Math.max(maxAbsError, Math.abs(value - expected[index]));
      if (index % 4 === 3 && (value < -0.01 || value > 1.01)) alphaOutOfRange += 1;
    }
    levelReceipts.push({ level, width: size.width, height: size.height, maxAbsError, nonFinite, alphaOutOfRange });
    source = actual;
    sourceWidth = size.width;
    sourceHeight = size.height;
  }
  return {
    levels: levelReceipts,
    maxAbsError: Math.max(...levelReceipts.map((entry) => entry.maxAbsError)),
    nonFinite: levelReceipts.reduce((sum, entry) => sum + entry.nonFinite, 0),
    alphaOutOfRange: levelReceipts.reduce((sum, entry) => sum + entry.alphaOutOfRange, 0),
    pass: levelReceipts.every((entry) => entry.nonFinite === 0 && entry.alphaOutOfRange === 0 && entry.maxAbsError <= 0.02),
  };
}

const correctnessReports = {
  A: await correctness(variants.A),
  B: await correctness(variants.B),
};
const gpuSamples = Object.fromEntries(Object.entries(samples).map(([key, entries]) => [key, entries.map((entry) => entry.gpuBatchMs / chainRepeats)]));
const wallSamples = Object.fromEntries(Object.entries(samples).map(([key, entries]) => [key, entries.map((entry) => entry.wallMs / chainRepeats)]));
const report = {
  schemaVersion: 'hello-ssr-reflection-mip-abba/1',
  input: {
    path: inputPath,
    tapePath,
    tapeDigest: digest(new Uint8Array(readFileSync(tapePath))),
    sourceDigest: digest(sourceBytes),
    levels,
  },
  identity: {
    baselineHead: execFileSync('git', ['-C', dirname(baselineShaderPath), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    baselineTree: execFileSync('git', ['-C', dirname(baselineShaderPath), 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(),
    candidateTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: process.cwd(), encoding: 'utf8' }).trim(),
    baselineShaderDigest: digest(Buffer.from(readFileSync(baselineShaderPath))),
    candidateShaderDigest: digest(Buffer.from(readFileSync(candidateShaderPath))),
    baselineCompiledDigest: digest(Buffer.from(variants.A.compiled)),
    candidateCompiledDigest: digest(Buffer.from(variants.B.compiled)),
  },
  device: {
    backend: device.caps.backendKind,
    adapter: device.caps.adapter,
    timestampQuery: device.caps.timestampQuery,
    timestampPeriodNanoseconds: periodNs,
  },
  protocol: { order: 'ABBA', blocks, warmupBatches, chainRepeats, measuredWork: 'nine reflection mip dispatches per chain' },
  timing: {
    A: { gpuPerChainMs: stats(gpuSamples.A), wallPerChainMs: stats(wallSamples.A) },
    B: { gpuPerChainMs: stats(gpuSamples.B), wallPerChainMs: stats(wallSamples.B) },
    rawGpuPerChainMs: gpuSamples,
    rawWallPerChainMs: wallSamples,
    order,
  },
  correctness: correctnessReports,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  outputPath,
  timing: {
    A: report.timing.A.gpuPerChainMs,
    B: report.timing.B.gpuPerChainMs,
  },
  correctness: {
    A: correctnessReports.A.pass,
    B: correctnessReports.B.pass,
  },
}, null, 2));
device.destroy?.();
process.exit(0);
