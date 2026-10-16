import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeTape, buildFrameModel, openReplay, halfToFloat } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';

const path = resolve(process.argv[2]);
const bytes = new Uint8Array(readFileSync(path));
const tape = decodeTape(bytes).unwrap();
const model = buildFrameModel(tape);
const compose = model.works.find(w => w.pipeline.shaders.some(s => s.entryPoint === 'fs_ssr_compose'));
assert.ok(compose);
const temporal = model.works.find(w => w.pipeline.shaders.some(s => s.entryPoint === 'ssr_temporal'));
assert.ok(temporal);
const reducer = model.works.find(w => w.pipeline.shaders.some(s => s.entryPoint === 'ssr_reflection_mip'));
assert.ok(reducer);
const slot = compose.pipeline.shaders.some(s => s.entryPoint === 'vs_ssr_compose') ? 0 : 20;
const binding = compose.bindings.find(b => b.groupIndex === 0 && b.binding === slot);
assert.ok(binding);
const view = model.resources.find(r => r.resourceId === binding.resourceId);
assert.equal(view.kind, 'texture-view');
const texture = model.resources.find(r => r.resourceId === view.descriptor.sourceHandleId);
assert.equal(texture.kind, 'texture');
const levels = texture.descriptor.desc.mipLevelCount;
assert.ok(levels > 1, 'A rough reflection requires a real mip chain');
assert.equal(view.descriptor.desc.baseMipLevel ?? 0, 0);
assert.equal(view.descriptor.desc.mipLevelCount ?? levels, levels);
assert.equal(model.works.filter(w => w.pipeline.shaders.some(s => s.entryPoint === 'ssr_reflection_mip')).length, levels - 1);
const backend = await bootstrapDawn('SSR reflection mip audit', tape);
const replay = (await openReplay(tape, { device: backend.freshDevice, createShaderModule: backend.rhiWebgpu.createShaderModule })).unwrap();
try {
  let previous;
  const results = [];
  let mip0AtTemporal;
  for (let level = 0; level < levels; level++) {
    const read = (await replay.readResourceAtWork(texture.resourceId, compose.workIndex, { mipLevel: level, arrayLayer: 0 })).unwrap();
    assert.equal(read.format, 'rgba16float');
    const data = new DataView(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
    const values = Float32Array.from({ length: read.bytes.length / 2 }, (_, i) => halfToFloat(data.getUint16(i * 2, true)));
    let maximumError = 0, failures = 0, covered = 0, negative = 0, invalid = 0;
    for (let y = 0; y < read.height; y++) for (let x = 0; x < read.width; x++) {
      const i = (y * read.width + x) * 4;
      assert.ok(values.slice(i, i + 4).every(Number.isFinite));
      covered += Number(values[i + 3] > 0);
      invalid += Number(!values.slice(i, i + 3).every(Number.isFinite) || !Number.isFinite(values[i + 3]));
      negative += Number(values[i] < -0.002 || values[i + 1] < -0.002 || values[i + 2] < -0.002);
      assert.ok(values[i + 3] >= -0.002 && values[i + 3] <= 1.002, `mip ${level} confidence escaped [0,1]`);
      if (previous === undefined) continue;
      const firstX = Math.floor(x * previous.width / read.width), endX = Math.floor((x + 1) * previous.width / read.width);
      const firstY = Math.floor(y * previous.height / read.height), endY = Math.floor((y + 1) * previous.height / read.height);
      assert.ok(endX > firstX && endY > firstY, `mip ${level} has an empty source footprint at ${x},${y}`);
      const sum = [0, 0, 0, 0];
      for (let py = firstY; py < endY; py++) for (let px = firstX; px < endX; px++) {
        const p = (py * previous.width + px) * 4, a = previous.values[p + 3];
        // The production presentation pyramid stores premultiplied radiance
        // (RGB = confidence * radiance). Reducer WGSL averages that mass
        // directly and averages coverage independently; multiplying RGB by
        // alpha again would square confidence and fabricate dark seams.
        for (let c = 0; c < 3; c++) sum[c] += previous.values[p + c];
        sum[3] += a;
      }
      const texelCount = (endX - firstX) * (endY - firstY);
      const expected = [...sum.slice(0, 3).map(v => v / texelCount), sum[3] / texelCount];
      for (let c = 0; c < 4; c++) {
        const error = Math.abs(values[i + c] - expected[c]);
        maximumError = Math.max(maximumError, error);
        failures += Number(error > 0.002 * (1 + Math.abs(expected[c])));
      }
    }
    assert.equal(invalid, 0, `Mip ${level} contains non-finite values`);
    assert.equal(negative, 0, `Mip ${level} contains negative HDR radiance`);
    if (level === 0) mip0AtTemporal = values;
    results.push({ level, width: read.width, height: read.height, coveredPixels: covered, maximumReductionError: maximumError, failures, negativeRadiancePixels: negative });
    assert.equal(failures, 0, `Mip ${level} differs from premultiplied parent reduction`);
    previous = { width: read.width, height: read.height, values };
  }
  assert.ok(mip0AtTemporal, 'temporal mip0 readback was not captured');
  const temporalMip0 = (await replay.readResourceAtWork(texture.resourceId, temporal.workIndex, { mipLevel: 0, arrayLayer: 0 })).unwrap();
  const temporalData = new DataView(temporalMip0.bytes.buffer, temporalMip0.bytes.byteOffset, temporalMip0.bytes.byteLength);
  const temporalValues = Float32Array.from({ length: temporalMip0.bytes.length / 2 }, (_, i) => halfToFloat(temporalData.getUint16(i * 2, true)));
  assert.equal(temporalValues.length, mip0AtTemporal.length);
  let mip0MutationError = 0;
  for (let i = 0; i < temporalValues.length; i++) mip0MutationError = Math.max(mip0MutationError, Math.abs(temporalValues[i] - mip0AtTemporal[i]));
  assert.ok(mip0MutationError <= 0.002, `reflection reducer mutated mip0 by ${mip0MutationError}`);
  const result = { digest: createHash('sha256').update(bytes).digest('hex'), workIndex: compose.workIndex,
    mode: 'recorded-replay', textureId: texture.resourceId, compositionView: binding.resourceId,
    reducerWorkIndex: reducer.workIndex, mip0MutationError, levels: results };
  writeFileSync(resolve(dirname(path), 'ssr-mip-audit.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { replay.dispose(); }
process.exit(0);
