#!/usr/bin/env node

/**
 * Real Dawn quality carrier for the production multiscale Bloom shaders.
 *
 * This is a measurement fixture, not a second renderer: it binds the cooked
 * bloom-downsample, bloom-upsample, and bloom-composite modules exactly as
 * the Renderer does, then reads the rgba16float attachments back as
 * binary16.  The existing smoke-dawn script covers graph ownership and
 * lifecycle; this carrier supplies the controlled HDR input needed for
 * radial, DC, intensity, alpha, extent, and analytic-motion evidence.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { teardownDawnInstance } from '../../../../scripts/lib/dawn-teardown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const evidenceDir = resolve(appRoot, 'evidence');
const manifestPath = resolve(appRoot, 'dist', 'shaders', 'manifest.json');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const sourcePath = fileURLToPath(import.meta.url);

const COPY_SRC = 0x01;
const COPY_DST = 0x02;
const BUFFER_COPY_DST = 0x08;
const TEXTURE_BINDING = 0x04;
const MAP_READ = 0x01;
const RENDER_ATTACHMENT = 0x10;
const HDR_CEILING = 65504;
const HALF_SUBNORMAL_STEP = 2 ** -24;
const HALF_RELATIVE_FLOOR = HALF_SUBNORMAL_STEP / 0.01;
const REC709 = [0.2126, 0.7152, 0.0722];
const DOWN_PARAMS_STRIDE = 256;
const DOWN_PARAMS_BYTES = 5 * DOWN_PARAMS_STRIDE;
const UPSAMPLE_PARAMS_STRIDE = 256;
const UPSAMPLE_PARAMS_BYTES = 4 * UPSAMPLE_PARAMS_STRIDE;
const COMPOSITE_PARAMS_BYTES = 16;
const MOTION_FRAMES = 60;

const manifest = await readShaderManifestPublication(JSON.parse(readFileSync(manifestPath, 'utf8')));
const downEntry = manifest.entries.find((entry) => entry.wgsl.includes('BloomDownsampleParams'));
const upEntry = manifest.entries.find((entry) => entry.wgsl.includes('BloomUpsampleParams'));
const compositeEntry = manifest.entries.find((entry) => entry.wgsl.includes('BloomCompositeParams'));
if (downEntry === undefined || upEntry === undefined || compositeEntry === undefined) {
  throw new Error('cooked Bloom shader entries are incomplete');
}

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
let gpu = create([]);
const adapter = await gpu.requestAdapter();
if (adapter === null) throw new Error('Dawn adapter is unavailable');
const device = await adapter.requestDevice();

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function floatToHalf(value) {
  const scratch = new ArrayBuffer(4);
  const float = new Float32Array(scratch);
  const bits = new Uint32Array(scratch);
  float[0] = Number.isFinite(value) ? Math.max(0, Math.min(HDR_CEILING, value)) : 0;
  const raw = bits[0] ?? 0;
  const exponent = (raw >>> 23) & 0xff;
  let mantissa = raw & 0x7fffff;
  if (exponent === 0xff) return 0x7c00;
  if (exponent === 0) return 0;
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return 0x7bff;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return 0;
    const shift = 14 - halfExponent;
    const significand = mantissa | 0x800000;
    let fraction = significand >> shift;
    const remainder = significand & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (fraction & 1) !== 0)) fraction += 1;
    return fraction >= 0x0400 ? 0x0400 : fraction;
  }
  const fraction = (mantissa >> 13) + ((mantissa & 0x1fff) > 0x1000 || ((mantissa & 0x1fff) === 0x1000 && (mantissa >> 13) % 2 === 1) ? 1 : 0);
  if (fraction > 0x3ff) return (halfExponent + 1) >= 0x1f ? 0x7bff : ((halfExponent + 1) << 10);
  return (halfExponent << 10) | fraction;
}

function halfToFloat(bits) {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) return sign * (mantissa / 1024) * 2 ** -14;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function color(value) {
  if (Array.isArray(value)) return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1];
  return [value ?? 0, 0, 0, 1];
}

function sourceBytes(values, width, height) {
  const bytesPerRow = align(width * 8, 256);
  const bytes = new Uint8Array(bytesPerRow * height);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    const pixel = color(value);
    const offset = Math.floor(index / width) * bytesPerRow + (index % width) * 8;
    view.setUint16(offset, floatToHalf(pixel[0]), true);
    view.setUint16(offset + 2, floatToHalf(pixel[1]), true);
    view.setUint16(offset + 4, floatToHalf(pixel[2]), true);
    view.setUint16(offset + 6, floatToHalf(pixel[3]), true);
  });
  return { bytes, bytesPerRow };
}

function decodedSource(values) {
  return values.map((value) => {
    const pixel = color(value);
    return pixel.map((channel) => halfToFloat(floatToHalf(channel)));
  });
}

function deriveLevels(width, height) {
  const levels = [];
  let nextWidth = Math.max(1, Math.ceil(width / 2));
  let nextHeight = Math.max(1, Math.ceil(height / 2));
  for (let level = 0; level < 5; level += 1) {
    levels.push({ width: nextWidth, height: nextHeight });
    if (nextWidth === 1 && nextHeight === 1) break;
    nextWidth = Math.max(1, Math.ceil(nextWidth / 2));
    nextHeight = Math.max(1, Math.ceil(nextHeight / 2));
  }
  return levels;
}

function textureBytes(width, height) {
  return width * height * 8;
}

function targetBudget(width, height) {
  const levels = deriveLevels(width, height);
  const levelBytes = levels.reduce((sum, level) => sum + textureBytes(level.width, level.height), 0);
  const upsampleBytes = levels.slice(0, -1).reduce((sum, level) => sum + textureBytes(level.width, level.height), 0);
  return {
    levels,
    bytes: textureBytes(width, height) + levelBytes + upsampleBytes,
    targetCount: 1 + levels.length + Math.max(0, levels.length - 1),
    passCount: levels.length + Math.max(0, levels.length - 1) + 1,
  };
}

function makePipeline(code, fragmentFormat = 'rgba16float') {
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: fragmentFormat }] },
    primitive: { topology: 'triangle-list' },
  });
}

const downPipeline = makePipeline(downEntry.wgsl);
const upPipeline = makePipeline(upEntry.wgsl);
const compositePipeline = makePipeline(compositeEntry.wgsl);
const sampler = device.createSampler({
  minFilter: 'linear',
  magFilter: 'linear',
  mipmapFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
});

async function readTexture(texture, width, height) {
  const bytesPerRow = align(width * 8, 256);
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: MAP_READ | 0x08,
  });
  const encoder = device.createCommandEncoder({ label: 'hello-bloom-quality-readback' });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buffer.mapAsync(MAP_READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const view = new DataView(bytes.buffer);
  return Array.from({ length: width * height }, (_, index) => {
    const offset = Math.floor(index / width) * bytesPerRow + (index % width) * 8;
    return {
      r: halfToFloat(view.getUint16(offset, true)),
      g: halfToFloat(view.getUint16(offset + 2, true)),
      b: halfToFloat(view.getUint16(offset + 4, true)),
      a: halfToFloat(view.getUint16(offset + 6, true)),
    };
  });
}

function createTexture(width, height, label) {
  return device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'rgba16float',
    usage: COPY_SRC | COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
}

function pass(encoder, target, pipeline, bindGroup, label) {
  const render = encoder.beginRenderPass({
    label,
    colorAttachments: [{
      view: target.createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    }],
  });
  render.setPipeline(pipeline);
  render.setBindGroup(0, bindGroup);
  render.draw(3);
  render.end();
}

function bind(pipeline, entries) {
  return device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
}

function writeDownParams(buffer, offset, width, height, level, threshold, softKnee) {
  device.queue.writeBuffer(buffer, offset, new Float32Array([
    threshold,
    softKnee,
    width,
    height,
    level,
    0,
    0,
    0,
  ]));
}

function writeUpsampleParams(buffer, offset, scatter) {
  device.queue.writeBuffer(buffer, offset, new Float32Array([scatter, 0, 0, 0]));
}

function writeCompositeParams(buffer, intensity) {
  device.queue.writeBuffer(buffer, 0, new Float32Array([intensity, 0, 0, 0]));
}

function displayChannel(value) {
  const mapped = 1 - Math.exp(-Math.max(0, value) * 0.65);
  return Math.round(255 * (mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * mapped ** (1 / 2.4) - 0.055));
}

function writeDisplayPng(path, pixels, width, height) {
  const png = new PNG({ width, height });
  pixels.forEach((pixel, index) => {
    const offset = index * 4;
    png.data[offset] = Math.max(0, Math.min(255, displayChannel(pixel.r)));
    png.data[offset + 1] = Math.max(0, Math.min(255, displayChannel(pixel.g)));
    png.data[offset + 2] = Math.max(0, Math.min(255, displayChannel(pixel.b)));
    png.data[offset + 3] = Math.max(0, Math.min(255, Math.round((pixel.a ?? 1) * 255)));
  });
  writeFileSync(path, PNG.sync.write(png));
}

function pointValues(width, height, x, y, rgb = [8, 6, 4], alpha = 1) {
  const values = Array.from({ length: width * height }, () => [0, 0, 0, 0]);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  for (const dy of [0, 1]) {
    for (const dx of [0, 1]) {
      const px = Math.max(0, Math.min(width - 1, x0 + dx));
      const py = Math.max(0, Math.min(height - 1, y0 + dy));
      const weight = (dx === 0 ? 1 - tx : tx) * (dy === 0 ? 1 - ty : ty);
      const pixel = values[py * width + px];
      pixel[0] += rgb[0] * weight;
      pixel[1] += rgb[1] * weight;
      pixel[2] += rgb[2] * weight;
      pixel[3] = Math.max(pixel[3], alpha * weight);
    }
  }
  return values;
}

function analyticHighlightValues(width, height, x, y, rgb = [128, 96, 64], sigma = 3, alpha = 1) {
  const weights = new Float32Array(width * height);
  let total = 0;
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const dx = (px + 0.5) - x;
      const dy = (py + 0.5) - y;
      const weight = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      weights[py * width + px] = weight;
      total += weight;
    }
  }
  return Array.from(weights, (weight) => {
    const normalized = weight / total;
    return [rgb[0] * normalized, rgb[1] * normalized, rgb[2] * normalized, alpha];
  });
}

function constantValues(width, height, rgb, alpha = 1) {
  return Array.from({ length: width * height }, () => [rgb[0], rgb[1], rgb[2], alpha]);
}

function crossValues(width, height) {
  const values = Array.from({ length: width * height }, () => [0, 0, 0, 0]);
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  for (let y = cy - 10; y <= cy + 10; y += 1) {
    for (let x = cx - 1; x <= cx + 1; x += 1) values[y * width + x] = [8, 7, 5, 1];
  }
  for (let x = cx - 10; x <= cx + 10; x += 1) {
    for (let y = cy - 1; y <= cy + 1; y += 1) values[y * width + x] = [8, 7, 5, 1];
  }
  return values;
}

function luma(pixel) {
  return REC709[0] * Math.max(pixel.r, 0) + REC709[1] * Math.max(pixel.g, 0) + REC709[2] * Math.max(pixel.b, 0);
}

function sumLuma(pixels, bounds = undefined) {
  let sum = 0;
  const width = bounds?.width ?? 0;
  for (let index = 0; index < pixels.length; index += 1) {
    const x = width > 0 ? index % width : 0;
    const y = width > 0 ? Math.floor(index / width) : 0;
    if (bounds !== undefined && (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom)) continue;
    sum += luma(pixels[index]);
  }
  return sum;
}

function finitePixels(pixels) {
  return pixels.every((pixel) => [pixel.r, pixel.g, pixel.b, pixel.a].every((value) => Number.isFinite(value) && value >= 0));
}

function edgeStats(pixels, width, height) {
  let nonZeroCount = 0;
  let maxLuma = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
      const edgeLuma = luma(pixels[y * width + x]);
      if (edgeLuma > 0) nonZeroCount += 1;
      maxLuma = Math.max(maxLuma, edgeLuma);
    }
  }
  return { pixelCount: width * 2 + Math.max(0, height - 2) * 2, nonZeroCount, maxLuma };
}

function maxRelative(actual, expected) {
  let maximum = 0;
  actual.forEach((pixel, index) => {
    const reference = expected[index];
    for (const channel of ['r', 'g', 'b']) {
      const value = pixel[channel];
      const target = reference[channel];
      maximum = Math.max(maximum, Math.abs(value - target) / Math.max(Math.abs(target), HALF_RELATIVE_FLOOR));
    }
  });
  return maximum;
}

function sampleBilinear(pixels, width, height, outputWidth, outputHeight, index) {
  const x = index % outputWidth;
  const y = Math.floor(index / outputWidth);
  const sourceX = Math.max(0, Math.min(width - 1, ((x + 0.5) / outputWidth) * width - 0.5));
  const sourceY = Math.max(0, Math.min(height - 1, ((y + 0.5) / outputHeight) * height - 0.5));
  const x0 = Math.floor(sourceX);
  const y0 = Math.floor(sourceY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const a = pixels[y0 * width + x0];
  const b = pixels[y0 * width + x1];
  const c = pixels[y1 * width + x0];
  const d = pixels[y1 * width + x1];
  const mix = (top, bottom) => top + (bottom - top) * ty;
  return {
    r: mix(a.r + (b.r - a.r) * tx, c.r + (d.r - c.r) * tx),
    g: mix(a.g + (b.g - a.g) * tx, c.g + (d.g - c.g) * tx),
    b: mix(a.b + (b.b - a.b) * tx, c.b + (d.b - c.b) * tx),
  };
}

function radialMetric(pixels, width, height, centerX, centerY, scale = 1, options = {}) {
  const pixelScaleX = options.pixelScaleX ?? 1;
  const pixelScaleY = options.pixelScaleY ?? pixelScaleX;
  const bounds = options.bounds ?? { left: 0, top: 0, right: width, bottom: height };
  const samples = [];
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      samples.push({
        radius: Math.hypot((x - centerX) * pixelScaleX, (y - centerY) * pixelScaleY),
        energy: luma(pixels[y * width + x]) * scale,
      });
    }
  }
  samples.sort((left, right) => left.radius - right.radius);
  const total = samples.reduce((sum, sample) => sum + sample.energy, 0);
  let cumulative = 0;
  let r90 = 0;
  for (const sample of samples) {
    cumulative += sample.energy;
    if (total > 0 && cumulative >= total * 0.9) {
      r90 = sample.radius;
      break;
    }
  }
  const maxRadius = Math.ceil(Math.max(
    Math.hypot((bounds.left - centerX) * pixelScaleX, (bounds.top - centerY) * pixelScaleY),
    Math.hypot((bounds.right - 1 - centerX) * pixelScaleX, (bounds.top - centerY) * pixelScaleY),
    Math.hypot((bounds.left - centerX) * pixelScaleX, (bounds.bottom - 1 - centerY) * pixelScaleY),
    Math.hypot((bounds.right - 1 - centerX) * pixelScaleX, (bounds.bottom - 1 - centerY) * pixelScaleY),
  ));
  const curve = [];
  for (let radius = 0; radius <= maxRadius; radius += 2) {
    curve.push({ radius, cumulative: total > 0 ? samples.filter((sample) => sample.radius <= radius).reduce((sum, sample) => sum + sample.energy, 0) / total : 0 });
  }
  return { total, r90, curve, coordinateSpace: 'output pixels', pixelScale: { x: pixelScaleX, y: pixelScaleY }, bounds };
}

function maxAbsAlphaError(actual, expectedAlpha) {
  return Math.max(...actual.map((pixel) => Math.abs(pixel.a - expectedAlpha)));
}

function check(name, passValue, detail, checks) {
  const result = { name, pass: passValue, detail };
  checks.push(result);
  console.log(`[bloom-quality] ${passValue ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
  return result;
}

async function createRunner(width, height) {
  const source = createTexture(width, height, `bloom-quality-source-${width}x${height}`);
  const budget = targetBudget(width, height);
  const levels = budget.levels.map((size, level) => ({ ...size, texture: createTexture(size.width, size.height, `bloom-quality-d${level}`) }));
  const upsample = levels.slice(0, -1).map((size, level) => ({
    width: size.width,
    height: size.height,
    texture: createTexture(size.width, size.height, `bloom-quality-u${level}`),
  }));
  const composite = createTexture(width, height, 'bloom-quality-composited');
  const downParams = device.createBuffer({ size: DOWN_PARAMS_BYTES, usage: 0x40 | BUFFER_COPY_DST });
  const upParams = device.createBuffer({ size: UPSAMPLE_PARAMS_BYTES, usage: 0x40 | BUFFER_COPY_DST });
  const compositeParams = device.createBuffer({ size: COMPOSITE_PARAMS_BYTES, usage: 0x40 | BUFFER_COPY_DST });

  async function run(values, options = {}) {
    const threshold = options.threshold ?? 1;
    const softKnee = options.softKnee ?? 0.5;
    const scatter = options.scatter ?? 0.7;
    const intensity = options.intensity ?? 1;
    const upload = sourceBytes(values, width, height);
    device.queue.writeTexture(
      { texture: source },
      upload.bytes,
      { bytesPerRow: upload.bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    for (const [level, destination] of levels.entries()) {
      writeDownParams(downParams, level * DOWN_PARAMS_STRIDE, destination.width, destination.height, level, threshold, softKnee);
    }
    for (let level = 0; level < upsample.length; level += 1) writeUpsampleParams(upParams, level * UPSAMPLE_PARAMS_STRIDE, scatter);
    writeCompositeParams(compositeParams, intensity);

    const encoder = device.createCommandEncoder({ label: 'bloom-quality-frame' });
    let input = source;
    for (const [level, destination] of levels.entries()) {
      const group = bind(downPipeline, [
        { binding: 0, resource: input.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: downParams, offset: level * DOWN_PARAMS_STRIDE, size: 32 } },
      ]);
      pass(encoder, destination.texture, downPipeline, group, `bloom-downsample-${level}`);
      input = destination.texture;
    }
    let reconstructed = levels.at(-1).texture;
    if (options.reconstruction !== 'single-scale') {
      for (let level = levels.length - 2; level >= 0; level -= 1) {
        const destination = upsample[level];
        const group = bind(upPipeline, [
          { binding: 0, resource: levels[level].texture.createView() },
          { binding: 1, resource: reconstructed.createView() },
          { binding: 2, resource: sampler },
          { binding: 3, resource: { buffer: upParams, offset: level * UPSAMPLE_PARAMS_STRIDE, size: 16 } },
        ]);
        pass(encoder, destination.texture, upPipeline, group, `bloom-upsample-${level}`);
        reconstructed = destination.texture;
      }
    } else {
      reconstructed = levels[0].texture;
    }
    const compositeGroup = bind(compositePipeline, [
      { binding: 0, resource: source.createView() },
      { binding: 1, resource: reconstructed.createView() },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: compositeParams, size: 16 } },
    ]);
    pass(encoder, composite, compositePipeline, compositeGroup, 'bloom-composite');
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const [composited, bloom] = await Promise.all([
      options.captureComposite === false ? undefined : readTexture(composite, width, height),
      readTexture(reconstructed, levels[0].width, levels[0].height),
    ]);
    return {
      width,
      height,
      levels: budget.levels,
      budget,
      composited,
      bloom,
    };
  }

  return {
    width,
    height,
    budget,
    run,
    destroy() {
      source.destroy();
      levels.forEach((level) => level.texture.destroy());
      upsample.forEach((level) => level.texture.destroy());
      composite.destroy();
      downParams.destroy();
      upParams.destroy();
      compositeParams.destroy();
    },
  };
}

const checks = [];
const evidence = {
  schemaVersion: 'hello-bloom-quality-dawn/2',
  sourceRevision,
  source: {
    path: 'apps/hello/bloom/scripts/bloom-quality-dawn.mjs',
    sha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
  },
  shaderManifest: {
    path: 'apps/hello/bloom/dist/shaders/manifest.json',
    sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
  },
  backend: 'dawn-node',
  format: {
    intermediate: 'rgba16float',
    decoded: 'IEEE-754 binary16',
    halfSubnormalStep: HALF_SUBNORMAL_STEP,
    nearZeroRelativeFloor: HALF_RELATIVE_FLOOR,
    nearZeroRule: 'reference >= step/0.01 uses <=1% normalized error; smaller positive references use <= one positive binary16 subnormal step absolute decoded error',
  },
  input: {
    threshold: 1,
    softKnee: 0.5,
    scatter: 0.7,
    sceneDomain: 'pre-exposure scene-linear HDR',
  },
  checks,
  visual: {
    displayTransform: 'diagnostic only: 1-exp(-0.65*x), then sRGB OETF; PNG is not used for HDR numeric gates',
    files: [],
  },
  verdict: 'fail',
};

check('binary16-codec-subnormal', floatToHalf(2 ** -15) === 0x0200 && floatToHalf(2 ** -24) === 0x0001 && halfToFloat(0x0200) === 2 ** -15 && halfToFloat(0x8001) === -(2 ** -24) && halfToFloat(0xbc00) === -1, {
  encodedTwoToMinus15: floatToHalf(2 ** -15),
  encodedTwoToMinus24: floatToHalf(2 ** -24),
  decodedTwoToMinus15: halfToFloat(0x0200),
  decodedNegativeSubnormal: halfToFloat(0x8001),
  decodedNegativeOne: halfToFloat(0xbc00),
}, checks);

mkdirSync(evidenceDir, { recursive: true });
let runners = [];
try {
  // The production filter has a finite but deliberately wide multiscale
  // footprint.  Keep the bright point well inside a larger even input so the
  // complete D0 response is measured before any image-edge clamp can enter.
  const radialRunner = await createRunner(512, 512);
  runners.push(radialRunner);
  const radialD0 = radialRunner.budget.levels[0];
  const radialCenter = { x: radialD0.width / 2, y: radialD0.height / 2 };
  const radialMetricOptions = {
    pixelScaleX: radialRunner.width / radialD0.width,
    pixelScaleY: radialRunner.height / radialD0.height,
    bounds: { left: 0, top: 0, right: radialD0.width, bottom: radialD0.height },
  };
  const radialInputs = pointValues(radialRunner.width, radialRunner.height, radialRunner.width / 2, radialRunner.height / 2, [8, 8, 8]);
  const scatterValues = [0.3, 0.7, 0.9];
  const radial = [];
  for (const scatter of scatterValues) {
    const result = await radialRunner.run(radialInputs, { scatter });
    radial.push({
      scatter,
      ...radialMetric(result.bloom, radialD0.width, radialD0.height, radialCenter.x, radialCenter.y, 1, radialMetricOptions),
      boundary: edgeStats(result.bloom, radialD0.width, radialD0.height),
    });
    if (scatter === 0.3) {
      const path = resolve(evidenceDir, 'quality-white-scatter-0.3.png');
      writeDisplayPng(path, result.composited, result.width, result.height);
      evidence.visual.files.push('apps/hello/bloom/evidence/quality-white-scatter-0.3.png');
    }
    if (scatter === 0.9) {
      const path = resolve(evidenceDir, 'quality-white-scatter-0.9.png');
      writeDisplayPng(path, result.composited, result.width, result.height);
      evidence.visual.files.push('apps/hello/bloom/evidence/quality-white-scatter-0.9.png');
    }
  }
  const matchedContribution = Math.min(...radial.map((entry) => entry.total));
  for (const entry of radial) {
    entry.matchedContribution = matchedContribution;
    entry.matchScale = entry.total > 0 ? matchedContribution / entry.total : 0;
    const matched = await radialRunner.run(radialInputs, { scatter: entry.scatter });
    entry.matchedCurve = radialMetric(
      matched.bloom,
      radialD0.width,
      radialD0.height,
      radialCenter.x,
      radialCenter.y,
      entry.matchScale,
      radialMetricOptions,
    ).curve;
  }
  const r90 = radial.map((entry) => entry.r90);
  check('matched-contribution-r90-monotonic', r90.every((value, index) => index === 0 || value > r90[index - 1]) && radial.every((entry) => entry.boundary.nonZeroCount === 0), { radial, r90, boundaryRule: 'full D0 edge must decode to exact zero before the fixed radial domain is accepted' }, checks);
  evidence.visual.radial = radial;

  const singleScale = [];
  for (const scatter of scatterValues) {
    const result = await radialRunner.run(radialInputs, { scatter, reconstruction: 'single-scale' });
    singleScale.push({ scatter, ...radialMetric(result.bloom, radialD0.width, radialD0.height, radialCenter.x, radialCenter.y, 1, radialMetricOptions) });
  }
  const singleScaleWouldPass = singleScale.every((entry, index) => index === 0 || entry.r90 > singleScale[index - 1].r90);
  check('single-scale-falsifier', !singleScaleWouldPass, { singleScale, rejected: !singleScaleWouldPass }, checks);
  evidence.falsifiers = { singleScale, singleScaleWouldPass };

  const dcRunner = await createRunner(33, 25);
  runners.push(dcRunner);
  const dcInput = constantValues(dcRunner.width, dcRunner.height, [2, 1, 0.5]);
  const dcResult = await dcRunner.run(dcInput, { threshold: 0, softKnee: 0, scatter: 0.7 });
  const dcExpected = dcResult.bloom.map(() => ({ r: 2, g: 1, b: 0.5, a: 1 }));
  const dcError = maxRelative(dcResult.bloom, dcExpected);
  check('constant-field-dc', dcError <= 0.01, { maxRelativeError: dcError, expected: [2, 1, 0.5] }, checks);
  evidence.dc = { maxRelativeError: dcError, width: dcRunner.width, height: dcRunner.height };

  const intensityRunner = await createRunner(65, 49);
  runners.push(intensityRunner);
  const intensityInput = constantValues(intensityRunner.width, intensityRunner.height, [128, 64, 32]);
  const intensitySource = decodedSource(intensityInput);
  const intensityResults = [];
  for (const intensity of [0.25, 0.5, 1]) {
    const result = await intensityRunner.run(intensityInput, { intensity, scatter: 0.7 });
    intensityResults.push({ intensity, result });
  }
  const intensityErrors = intensityResults.map((entry) => {
    const reference = intensityResults.at(-1).result;
    let sampleCount = 0;
    let skippedNearZero = 0;
    let invalidSamples = 0;
    let maxError = 0;
    let worstSample = null;
    for (let index = 0; index < entry.result.composited.length; index += 1) {
      const bloom = sampleBilinear(
        reference.bloom,
        reference.budget.levels[0].width,
        reference.budget.levels[0].height,
        reference.width,
        reference.height,
        index,
      );
      const scene = intensitySource[index];
      const composite = entry.result.composited[index];
      for (const [channel, sourceIndex] of [['r', 0], ['g', 1], ['b', 2]]) {
        const expected = entry.intensity * bloom[channel];
        const actual = composite[channel] - scene[sourceIndex];
        if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected < 0 || actual < 0) {
          invalidSamples += 1;
          continue;
        }
        if (Math.abs(expected) < 1e-6) {
          skippedNearZero += 1;
          continue;
        }
        const relativeError = Math.abs(actual / expected - 1);
        sampleCount += 1;
        if (relativeError > maxError) {
          maxError = relativeError;
          worstSample = { index, channel, expected, actual, scene: scene[sourceIndex], composite: composite[channel] };
        }
      }
    }
    return { intensity: entry.intensity, sampleCount, skippedNearZero, invalidSamples, maxRelativeError: maxError, worstSample };
  });
  check('tone-free-intensity-proportionality', intensityErrors.every((entry) => entry.invalidSamples === 0 && entry.sampleCount > 0 && entry.maxRelativeError <= 0.01), { samples: intensityErrors }, checks);
  evidence.intensity = { inputRgb: [128, 64, 32], samples: intensityErrors, domain: 'per-RGB sample: decoded rgba16float composite minus decoded same-frame scene versus bilinear decoded U0, before tone mapping; references below 1e-6 are not effective samples' };

  const alphaRunner = await createRunner(17, 17);
  runners.push(alphaRunner);
  const alphaInput = constantValues(alphaRunner.width, alphaRunner.height, [1.5, 0.75, 0.25], 0.37);
  const alphaResult = await alphaRunner.run(alphaInput, { threshold: 0, softKnee: 0, scatter: 0.7 });
  const expectedAlpha = halfToFloat(floatToHalf(0.37));
  const alphaError = maxAbsAlphaError(alphaResult.composited, expectedAlpha);
  check('scene-alpha-preserved', alphaError <= HALF_SUBNORMAL_STEP, { expectedAlpha, maxAbsoluteError: alphaError }, checks);
  evidence.alpha = { expected: expectedAlpha, maxAbsoluteError: alphaError };

  const extentCases = [];
  for (const [width, height] of [[1, 1], [1, 17], [17, 1], [127, 71]]) {
    const runner = await createRunner(width, height);
    runners.push(runner);
    const input = pointValues(width, height, (width - 1) / 2, (height - 1) / 2, [3, 2, 1]);
    const result = await runner.run(input, { threshold: 1, softKnee: 0.5, scatter: 0.7 });
    const expected = targetBudget(width, height);
    const uniqueTerminal = expected.levels.length === 1 || expected.levels.at(-1).width !== expected.levels.at(-2)?.width || expected.levels.at(-1).height !== expected.levels.at(-2)?.height;
    extentCases.push({ width, height, levels: expected.levels, targetCount: expected.targetCount, passCount: expected.passCount, finite: finitePixels(result.composited) && finitePixels(result.bloom), uniqueTerminal });
  }
  const descriptorExtents = [
    [1279, 719],
    [1920, 1080],
    [3840, 2160],
  ].map(([width, height]) => ({ width, height, ...targetBudget(width, height) }));
  check('small-and-odd-extents', extentCases.every((entry) => entry.finite && entry.uniqueTerminal), { actual: extentCases }, checks);
  evidence.extents = { actualPixelCases: extentCases, descriptorCases: descriptorExtents };

  const visualRunner = await createRunner(129, 97);
  runners.push(visualRunner);
  const rgbResult = await visualRunner.run(pointValues(129, 97, 64, 48, [8, 1.5, 0.35]), { scatter: 0.7 });
  const rgbPath = resolve(evidenceDir, 'quality-rgb-point.png');
  writeDisplayPng(rgbPath, rgbResult.composited, 129, 97);
  evidence.visual.files.push('apps/hello/bloom/evidence/quality-rgb-point.png');
  const crossResult = await visualRunner.run(crossValues(129, 97), { scatter: 0.7 });
  const crossPath = resolve(evidenceDir, 'quality-cross.png');
  writeDisplayPng(crossPath, crossResult.composited, 129, 97);
  evidence.visual.files.push('apps/hello/bloom/evidence/quality-cross.png');

  const motionRunner = await createRunner(512, 512);
  runners.push(motionRunner);
  const motionEnergies = [];
  const motionSourceRoi = { left: 128, top: 128, right: 384, bottom: 384, width: motionRunner.width };
  const motionD0 = motionRunner.budget.levels[0];
  const motionBounds = {
    left: 0,
    top: 0,
    right: motionD0.width,
    bottom: motionD0.height,
    width: motionD0.width,
    coverage: 'entire D0 footprint; source center has 128 output-pixel edge margin; edge must decode to exact zero',
  };
  const motionEdge = { maxNonZeroCount: 0, maxLuma: 0 };
  const motionVisualFrames = new Set([0, Math.floor(MOTION_FRAMES / 2), MOTION_FRAMES - 1]);
  const motionVisualFiles = [];
  const motionStart = performance.now();
  const trajectory = { xStart: 200, xEnd: 222, y: 256, energyModel: 'normalized analytic Gaussian sample with constant discrete RGB integral' };
  for (let frame = 0; frame < MOTION_FRAMES; frame += 1) {
    // Keep adjacent samples subpixel after shortening the observation window.
    const x = trajectory.xStart + (trajectory.xEnd - trajectory.xStart) * (frame / (MOTION_FRAMES - 1));
    const result = await motionRunner.run(analyticHighlightValues(motionRunner.width, motionRunner.height, x, trajectory.y), { scatter: 0.7, captureComposite: motionVisualFrames.has(frame) });
    motionEnergies.push(sumLuma(result.bloom, motionBounds));
    const boundary = edgeStats(result.bloom, motionD0.width, motionD0.height);
    motionEdge.maxNonZeroCount = Math.max(motionEdge.maxNonZeroCount, boundary.nonZeroCount);
    motionEdge.maxLuma = Math.max(motionEdge.maxLuma, boundary.maxLuma);
    if (motionVisualFrames.has(frame)) {
      const name = `quality-motion-${frame.toString().padStart(3, '0')}.png`;
      writeDisplayPng(resolve(evidenceDir, name), result.composited, motionRunner.width, motionRunner.height);
      const relative = `apps/hello/bloom/evidence/${name}`;
      evidence.visual.files.push(relative);
      motionVisualFiles.push(relative);
    }
  }
  const motionMean = motionEnergies.reduce((sum, value) => sum + value, 0) / motionEnergies.length;
  const motionDeviation = Math.max(...motionEnergies.map((value) => Math.abs(value - motionMean))) / Math.max(motionMean, HALF_RELATIVE_FLOOR);
  const motionMin = Math.min(...motionEnergies);
  const motionMax = Math.max(...motionEnergies);
  motionBounds.edgeNonZeroCount = motionEdge.maxNonZeroCount;
  motionBounds.edgeMaxLuma = motionEdge.maxLuma;
  check('analytic-subpixel-motion-60', motionEnergies.length === MOTION_FRAMES && motionEnergies.every(Number.isFinite) && motionMean > HALF_RELATIVE_FLOOR && motionDeviation <= 0.05 && motionEdge.maxNonZeroCount === 0, { frames: MOTION_FRAMES, sourceRoi: motionSourceRoi, bloomRoi: motionBounds, min: motionMin, max: motionMax, mean: motionMean, maxRelativeDeviation: motionDeviation }, checks);
  evidence.motion = {
    frames: MOTION_FRAMES,
    trajectory,
    sourceRoi: motionSourceRoi,
    bloomRoi: motionBounds,
    energies: motionEnergies,
    min: motionMin,
    max: motionMax,
    mean: motionMean,
    maxRelativeDeviation: motionDeviation,
    visualFiles: motionVisualFiles,
    wallClockMs: performance.now() - motionStart,
    wallClockRole: 'diagnostic only; not GPU timing',
  };

  const cost = {
    descriptorCases: descriptorExtents,
    parameterBytes: DOWN_PARAMS_BYTES + UPSAMPLE_PARAMS_BYTES + COMPOSITE_PARAMS_BYTES,
    parameterBreakdown: {
      downsample: DOWN_PARAMS_BYTES,
      upsample: UPSAMPLE_PARAMS_BYTES,
      composite: COMPOSITE_PARAMS_BYTES,
    },
    fixedRunnerResourcePolicy: 'one source + one target set + one parameter-buffer set per runner; run() only uploads and submits',
  };
  evidence.cost = cost;
  check('rounded-texture-budget', descriptorExtents.every((entry) => entry.passCount <= 10 && entry.bytes > 0), cost, checks);

  evidence.verdict = checks.every((entry) => entry.pass) ? 'pass' : 'fail';
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  console.error(`[bloom-quality] FAIL ${evidence.failure}`);
} finally {
  for (const runner of runners.reverse()) runner.destroy();
  const destroyed = device.lost;
  await teardownDawnInstance([device], async () => {
    const loss = await destroyed;
    if (loss.reason !== 'destroyed') {
      throw new Error(`unexpected Dawn device loss: ${loss.reason}: ${loss.message}`);
    }
    gpu = undefined;
  });
}

const evidencePath = resolve(evidenceDir, 'quality-dawn-result.json');
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[bloom-quality] evidence=${evidencePath} status=${evidence.verdict}`);
if (evidence.verdict !== 'pass') process.exit(1);
