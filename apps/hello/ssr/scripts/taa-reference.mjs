import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { halfToFloat } from '@forgeax/engine-rhi-debug';
import { sampleLinearColor } from './audit-tile-reflection.mjs';

export function readCapturedTaaPose(prefix, phase) {
  const inputs = JSON.parse(readFileSync(`${prefix}-${phase}/taa-feedback-inputs.json`));
  assert.equal(createHash('sha256').update(readFileSync(`${prefix}-${phase}/frame.rhitape`)).digest('hex'), inputs.digest);
  if (inputs.view || inputs.meshes) {
    assert.ok(inputs.view && inputs.meshes, 'Scene pose requires both bound GPU buffers');
    const buffers = {};
    for (const name of ['view', 'meshes']) {
      buffers[name] = readFileSync(`${prefix}-${phase}/taa-feedback-${name}.bin`);
      assert.equal(createHash('sha256').update(buffers[name]).digest('hex'), inputs[name].digest);
    }
    // Ordinary Mesh windows use 256-byte alignment, beginning with the
    // current worldFromLocal mat4. Compare every slot, not a guessed entity.
    assert.equal(buffers.meshes.byteLength % 256, 0);
    const matrices = createHash('sha256');
    for (let offset = 0; offset < buffers.meshes.byteLength; offset += 256) {
      matrices.update(buffers.meshes.subarray(offset, offset + 64));
    }
    return {
      position: [96, 100, 104].map(offset => buffers.view.readFloatLE(offset)),
      projection: Array.from({ length: 16 }, (_, i) => buffers.view.readFloatLE(784 + i * 4)),
      meshWorldDigest: matrices.digest('hex'),
    };
  }
  const manifest = JSON.parse(readFileSync(`${prefix}-${phase}/ssr-trace-inputs.json`));
  assert.equal(manifest.artifactDigest, inputs.digest);
  const camera = readFileSync(manifest.camera.path);
  assert.equal(createHash('sha256').update(camera).digest('hex'), manifest.camera.digest);
  return { position: [96, 100, 104].map(offset => camera.readFloatLE(offset)),
    projection: Array.from({ length: 16 }, (_, i) => camera.readFloatLE(784 + i * 4)) };
}

// An independent target for the requested HDR accumulation: reconstruct each
// source phase at the unjittered pixel, compress by linear luminance, average
// equal samples, then invert. No TAA history, clipping, or shader output enters.
// This is a cycle-integration oracle, not geometric supersampling ground truth.
export function accumulateTaaReference(frames) {
  assert.ok(frames.length > 0);
  const { width, height } = frames[0].image;
  const sum = new Float64Array(width * height * 3);
  for (const { image, jitterPixels } of frames) {
    assert.equal(image.width, width);
    assert.equal(image.height, height);
    assert.ok(jitterPixels.length === 2 && jitterPixels.every(Number.isFinite));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const color = sampleLinearColor(image, [(x + 0.5 + jitterPixels[0]) / width,
        (y + 0.5 + jitterPixels[1]) / height]);
      assert.ok(color.every(Number.isFinite));
      const divisor = 1 + Math.max(0, color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722);
      for (let c = 0; c < 3; c++) sum[(y * width + x) * 3 + c] += color[c] / divisor / frames.length;
    }
  }
  const values = new Float32Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const p = pixel * 3;
    const divisor = 1 - (sum[p] * 0.2126 + sum[p + 1] * 0.7152 + sum[p + 2] * 0.0722);
    assert.ok(divisor > 0 && Number.isFinite(divisor));
    for (let c = 0; c < 3; c++) values[pixel * 4 + c] = sum[p + c] / divisor;
    values[pixel * 4 + 3] = 1;
  }
  return { width, height, values };
}

export function readCapturedTaaReference(prefix) {
  const frames = [];
  const inputDigests = [];
  const phases = new Set();
  for (let phase = 0; phase < 8; phase++) {
    const manifest = JSON.parse(readFileSync(`${prefix}-${phase}/taa-feedback-inputs.json`));
    const tape = readFileSync(`${prefix}-${phase}/frame.rhitape`);
    assert.equal(createHash('sha256').update(tape).digest('hex'), manifest.digest);
    inputDigests.push(manifest.digest);
    const inputs = {};
    for (const key of ['color', 'params']) {
      const bytes = readFileSync(`${prefix}-${phase}/taa-feedback-${key}.bin`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest[key].digest);
      inputs[key] = bytes;
    }
    assert.equal(manifest.color.format, 'rgba16float');
    assert.equal(inputs.params.readUInt32LE(12), manifest.frameIndex);
    phases.add(manifest.frameIndex % 8);
    const { width, height } = manifest.color;
    assert.equal(inputs.color.byteLength, width * height * 8);
    frames.push({ image: { width, height, values: Float32Array.from({ length: width * height * 4 },
      (_, i) => halfToFloat(inputs.color.readUInt16LE(i * 2))) },
    jitterPixels: [inputs.params.readFloatLE(0) * width, inputs.params.readFloatLE(4) * height] });
  }
  assert.equal(phases.size, 8, 'Reference must cover one complete jitter cycle');
  return { ...accumulateTaaReference(frames), inputDigests };
}

// Shared by in-memory GPU feedback and offline exported-frame audits. A
// stable but biased history must not pass merely because frame deltas shrink.
export function measureTaaReferenceRegions(values, reference) {
  assert.equal(values.length, reference.width * reference.height * 4);
  assert.equal(values.length, reference.values.length);
  assert.ok(values.every(Number.isFinite));
  assert.ok(reference.values.every(Number.isFinite));
  const regions = {};
  for (const [name, top, bottom] of [['wall', 0.2, 0.5], ['contact', 0.47, 0.56], ['reflection', 0.52, 0.78]]) {
    const errors = [];
    let bias = 0;
    for (let y = Math.floor(reference.height * top); y < reference.height * bottom; y++) {
      for (let x = Math.floor(reference.width * 0.15); x < reference.width * 0.85; x++) {
        const pixel = (y * reference.width + x) * 4;
        const delta = [0, 1, 2].map(channel => values[pixel + channel] - reference.values[pixel + channel]);
        errors.push(Math.max(...delta.map(Math.abs)));
        bias += delta.reduce((sum, value) => sum + value, 0);
      }
    }
    assert.ok(errors.length > 0, 'Reference region must contain pixels');
    errors.sort((a, b) => a - b);
    regions[name] = { mean: errors.reduce((sum, value) => sum + value, 0) / errors.length,
      signedMeanRgb: bias / (errors.length * 3), p99: errors[Math.floor(errors.length * 0.99)], maximum: errors.at(-1) };
  }
  return regions;
}
