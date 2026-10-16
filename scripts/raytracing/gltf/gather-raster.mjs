import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import { writeReferencePng } from '../../../apps/shared/png-codec.mjs';
import { createRayDisplay } from '../../../packages/render/dist/internal.mjs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  halfToFloat,
  openReplay,
  readbackTexturePixels,
  tapeDigest,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { readBuffer } from '../scene/render.mjs';

// Offline stage carrier. Each output pixel is one explicitly sampled raster
// pixel; no interpolation, denoising, light-cache injection or primary PT.
const [raster, prepared, sourceDir, hitDir, out] = process.argv
  .slice(2)
  .map((path) => resolve(path));
await mkdir(out, { recursive: true });
const exposure = Number(process.argv[7] ?? 1);
assert(Number.isFinite(exposure) && exposure >= 0);
const json = async (root, name) => JSON.parse(await readFile(resolve(root, name), 'utf8'));
const bytes = async (root, name) => new Uint8Array(await readFile(resolve(root, name)));
const source = await json(sourceDir, 'rays.json'),
  hit = await json(hitDir, 'report.json');
assert.equal(source.sourceTape, hit.sourceTape);
assert.equal(
  hit.sourceRays,
  createHash('sha256')
    .update(await bytes(sourceDir, 'rays.json'))
    .digest('hex'),
);
assert.equal(source.sourceTape, tapeDigest(await bytes(raster, 'baseline.rhitape')));
const unresolved = new Set(hit.receiverValidation.mismatches.map((r) => r.sample));
assert.equal(hit.counts[0].nearOriginHits, hit.counts[0].nearOriginWitnesses?.length ?? 0);
const step = source.step ?? 16,
  resolution = source.width / step,
  size = resolution ** 2;
assert.equal(source.width, source.height);
const packed = new Uint32Array((await bytes(raster, 'baseline-albedo-metallic.bin')).buffer);
const depth = new Float32Array((await bytes(raster, 'baseline-depth.bin')).buffer);
const coverage = new Uint8Array(size * 4);
const hdr = new Uint16Array((await bytes(raster, 'baseline-direct-hdr.bin')).buffer);
const receiver = new Uint32Array(size * 4),
  direct = new Float32Array(size * 4);
for (let y = 0; y < resolution; y++)
  for (let x = 0; x < resolution; x++) {
    const p = (y * step + Math.floor(step / 2)) * source.width + x * step + Math.floor(step / 2);
    coverage.set(depth[p] > 0 ? [190, 30, 140, 255] : [0, 0, 0, 255], (y * resolution + x) * 4);
    for (let c = 0; c < 3; c++) direct[(y * resolution + x) * 4 + c] = halfToFloat(hdr[p * 4 + c]);
  }
for (const [sampleIndex, sample] of source.samples.entries()) {
  const i = Math.floor(sample.y / step) * resolution + Math.floor(sample.x / step);
  if (unresolved.has(sampleIndex)) {
    coverage.set([255, 210, 0, 255], i * 4);
    continue;
  }
  coverage.set([40, 190, 100, 255], i * 4);
  receiver.set([sample.first, sample.count, packed[sample.y * source.width + sample.x], 1], i * 4);
}
await writeFile(resolve(out, 'coverage.png'), writeReferencePng(coverage, resolution, resolution));
const input = await bytes(hitDir, 'baseline-accumulation.bin');
const darkInput = await bytes(hitDir, 'light-off-accumulation.bin');
const kernel = `
struct Accumulation { mean: vec3f, count: u32, m2: vec3f, error: u32, albedo: vec4f, normalDepth: vec4f, identity: vec4u }
struct Pixel { direct: vec4f, gather: vec4f, response: vec4f, beauty: vec4f, state: vec4u }
@group(0) @binding(0) var<storage,read> rays: array<Accumulation>;
@group(0) @binding(1) var<storage,read> receivers: array<vec4u>;
@group(0) @binding(2) var<storage,read> direct: array<vec4f>;
@group(0) @binding(3) var<storage,read_write> pixels: array<Pixel>;
@group(0) @binding(4) var<uniform> gain: vec4f;
@compute @workgroup_size(64) fn gather(@builtin(global_invocation_id) id: vec3u) {
 let i=id.x; if(i>=arrayLength(&pixels)){return;}
 let receiver=receivers[i]; var incoming=vec3f(0); var error=0u;
 if(receiver.w!=0u){
  for(var j=0u;j<receiver.y;j++){
   let ray=rays[receiver.x+j]; incoming+=ray.mean;
   if(ray.count!=1u||ray.error!=0u){error=1u;}
  }
  // All cosine directions, including null directions, remain in the denominator.
  incoming/=f32(receiver.y);
 }
 let p=unpack4x8unorm(receiver.z);
 // Standard opaque Lambert term: (1-metallic)*baseColor/pi. Cosine PDF cancels pi.
 let response=p.rgb*p.rgb*(1.0-p.a)*gain.y;
 let indirect=incoming*response*gain.x;
 pixels[i]=Pixel(direct[i],vec4f(incoming,0),vec4f(response*gain.x,0),vec4f(direct[i].rgb+indirect,1),vec4u(receiver.w,error,0,0));
}`;
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: create([]) }, configurable: true });
const recorder = attachRecorder(gpu).unwrap();
const device = (
  await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
).unwrap();
const raw = gpu._internal_getRawDevice(device._realDevice),
  errors = [];
raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const owned = [],
  displays = [],
  textures = [],
  results = [];
let tape;
try {
  const buffer = (label, data, usage = 140) => {
    const b = device.createBuffer({ label, size: data.byteLength, usage }).unwrap();
    owned.push(b);
    device.queue
      .writeBuffer(b, 0, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      .unwrap();
    return b;
  };
  const inputs = buffer('hybrid.incoming', input),
    receivers = buffer('hybrid.receivers', receiver);
  const directBuffer = buffer('hybrid.raster-direct', direct),
    output = buffer('hybrid.result', new Uint8Array(size * 80));
  const gain = buffer('hybrid.gain', new Float32Array([1, 1, 0, 0]), 72);
  const layout = device
    .createBindGroupLayout({
      entries: [0, 1, 2, 3, 4].map((binding) => ({
        binding,
        visibility: 4,
        buffer: {
          type: binding === 4 ? 'uniform' : binding === 3 ? 'storage' : 'read-only-storage',
        },
      })),
    })
    .unwrap();
  const shader = (
    await recorder.backend.createShaderModule(device, { code: kernel, label: 'hybrid.gather' })
  ).unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module: shader, entryPoint: 'gather' },
    })
    .unwrap();
  const bindings = device
    .createBindGroup({
      layout,
      entries: [inputs, receivers, directBuffer, output, gain].map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer', value: { buffer } },
      })),
    })
    .unwrap();
  const displayKernel = (await json(prepared, 'prepared.json')).displayKernel;
  for (const mode of ['direct', 'indirect', 'gi']) {
    displays.push(
      (
        await createRayDisplay(device, recorder.backend.createShaderModule, {
          kernel: displayKernel,
          buffer: output,
          resolution,
          mode,
          exposure,
        })
      ).unwrap(),
    );
    const texture = device
      .createTexture({
        label: `hybrid.${mode}`,
        size: { width: resolution, height: resolution },
        format: 'rgba8unorm',
        usage: 17,
      })
      .unwrap();
    textures.push({ texture, view: device.createTextureView(texture, {}).unwrap() });
  }
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  for (const [name, gi, material, dark] of [
    ['baseline', 1, 1, false],
    ['gi-off', 0, 1, false],
    ['black-receiver', 1, 0, false],
    ['hit-light-off', 1, 1, true],
    ['restored', 1, 1, false],
  ]) {
    device.queue.writeBuffer(gain, 0, new Float32Array([gi, material, 0, 0])).unwrap();
    device.queue.writeBuffer(inputs, 0, dark ? darkInput : input).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginComputePass({ label: `hybrid.gather.${name}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(Math.ceil(size / 64));
    pass.end();
    displays.forEach((display, i) => {
      display.record(encoder, textures[i].view).unwrap();
    });
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const data = await readBuffer(device, output, size * 80),
      images = [];
    for (const [i, mode] of ['direct', 'indirect', 'gi'].entries()) {
      const image = await readbackTexturePixels(
        device,
        textures[i].texture,
        resolution,
        resolution,
      );
      images.push(image);
      await writeFile(
        resolve(out, `${name}-${mode}.png`),
        writeReferencePng(image, resolution, resolution),
      );
    }
    const values = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4),
      words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    const radiance = new Float32Array((dark ? darkInput : input).buffer);
    let indirectEnergy = 0,
      changed = 0,
      maximumError = 0;
    for (let i = 0; i < size; i++) {
      assert.equal(words[i * 20 + 17], 0);
      let energy = 0;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = 0; j < receiver[i * 4 + 1]; j++)
          sum += radiance[(receiver[i * 4] + j) * 20 + c];
        const packedColor = receiver[i * 4 + 2],
          color = ((packedColor >>> (8 * c)) & 255) / 255,
          metallic = (packedColor >>> 24) / 255;
        const expected = receiver[i * 4 + 3]
          ? (sum / receiver[i * 4 + 1]) * color ** 2 * (1 - metallic) * gi * material
          : 0;
        const actual = values[i * 20 + 12 + c] - values[i * 20 + c];
        maximumError = Math.max(maximumError, Math.abs(actual - expected));
        assert(Math.abs(actual - expected) < 2e-6 * Math.max(1, expected));
        assert.equal(values[i * 20 + c], direct[i * 4 + c]);
        energy += expected;
      }
      if (energy > 0) changed++;
      indirectEnergy += energy;
    }
    results.push({ name, data, images, indirectEnergy, changed, maximumError });
    await writeFile(resolve(out, `${name}.bin`), data);
  }
  (await recorder.frameBoundary()).unwrap();
  tape = (await pending).unwrap();
} finally {
  for (const d of displays) d.dispose();
  for (const t of textures) device.destroyTexture(t.texture);
  for (const b of owned) device.destroyBuffer(b);
  (await recorder.dispose()).unwrap();
  raw.destroy();
}
assert(results[0].indirectEnergy > 0);
for (const r of results.slice(1, 4)) {
  assert.equal(r.indirectEnergy, 0);
  assert.deepEqual(r.images[2], r.images[0]);
}
assert.deepEqual(results[0].data, results[4].data);
assert.deepEqual(results[0].images, results[4].images);
await writeFile(resolve(out, 'gather.rhitape'), tape.bytes);
const decoded = decodeTape(tape.bytes).unwrap(),
  model = buildFrameModel(decoded);
const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
const replay = (
  await openReplay(decoded, { device: fresh, createShaderModule: gpu.createShaderModule })
).unwrap();
const checks = [];
try {
  const works = model.works.filter((w) =>
    w.pipeline.shaders.some((s) => s.entryPoint === 'gather'),
  );
  assert.equal(works.length, results.length);
  for (const [i, w] of works.entries()) {
    const id = w.bindings.find((b) => b.binding === 3).resourceId;
    assert.deepEqual(
      (await replay.readResourceAtWork(id, w.workIndex)).unwrap().bytes,
      results[i].data,
    );
    for (let j = 0; j < 3; j++)
      assert.deepEqual(
        (await replay.inspectWork(w.workIndex + 1 + j, ['pixels'])).unwrap().attachment.bytes,
        results[i].images[j],
      );
    checks.push({
      name: results[i].name,
      workIndex: w.workIndex,
      resourceId: id,
      rawAndDisplayByteEquality: true,
    });
  }
} finally {
  (await replay.dispose()).unwrap();
  gpu._internal_getRawDevice(fresh).destroy();
}
assert.deepEqual(errors, []);
const report = {
  scope:
    'Frozen raster + shared-material secondary rays + GPU diffuse gather; sampled pixels without spatial reconstruction; software GPU diagnostic',
  sourceTape: source.sourceTape,
  hitTape: hit.tape,
  tape: tape.digest,
  resolution,
  step,
  receivers: source.samples.length,
  exposure,
  background: coverage.filter((v, i) => i % 4 === 0 && v === 0).length,
  missingIndirect: coverage.filter((v, i) => i % 4 === 0 && (v === 190 || v === 255)).length,
  unresolvedReceivers: [...unresolved],
  results: results.map(({ data, images, ...r }) => r),
  checks,
  errors,
};
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
