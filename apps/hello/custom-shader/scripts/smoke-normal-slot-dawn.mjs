#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { create, globals } from '@forgeax/engine-dawn-node';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = resolve(APP_ROOT, 'assets', 'pulse-material.pack.json');
const variant = process.env.FORGEAX_MATERIAL_DAWN_VARIANT === 'normal-slot-swap'
  ? 'normal-slot-swap'
  : 'normal';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const authoredMaterial = fixture.assets.find(
  (entry) => entry.guid?.toLowerCase() === '01935b00-7d8c-7c4e-9f12-345678abcd02',
);
const authoredNormalTextureGuid = authoredMaterial?.payload?.values?.normalTexture?.texture;
assert(typeof authoredNormalTextureGuid === 'string', 'authored normalTexture slot is absent');
const cookedByGuid = new Map(
  fixture.assets.map((entry) => [entry.guid.toLowerCase(), entry.payload?.cooked]),
);
const loader = createMaterialLoader({
  loadPublication: async (guid) => {
    const record = cookedByGuid.get(guid.toLowerCase());
    if (record === undefined) return undefined;
    return {
      guid,
      record,
      artifacts: Object.fromEntries(
        record.programs.map(({ artifact }) => [
          artifact.path,
          { bytes: new Uint8Array(artifact.bytes), digest: artifact.digest },
        ]),
      ),
    };
  },
  loadReference: async () => true,
});
const rootRecord = cookedByGuid.get('01935b00-7d8c-7c4e-9f12-345678abcd02');
assert(rootRecord !== undefined, 'cooked root material record is absent');
const material = await loader.load({
  guid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
  specializationKey: rootRecord.specializationKey,
});
assert(material.status === 'Ready', 'authored material record is not runtime-ready');

Object.assign(globalThis, globals);
const gpu = create([]);
const adapter = await gpu.requestAdapter();
assert(adapter !== null, 'Dawn did not provide a WebGPU adapter');
const device = await adapter.requestDevice();
const format = 'rgba8unorm';
const target = device.createTexture({
  size: { width: 4, height: 4 },
  format,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
const readback = device.createBuffer({
  size: 1024,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
const baseColorTexture = device.createTexture({
  size: { width: 1, height: 1 },
  format,
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
const normalTexture = device.createTexture({
  size: { width: 1, height: 1 },
  format,
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
device.queue.writeTexture(
  { texture: baseColorTexture },
  new Uint8Array([64, 64, 64, 255]),
  { bytesPerRow: 4 },
  { width: 1, height: 1 },
);
device.queue.writeTexture(
  { texture: normalTexture },
  new Uint8Array([32, 224, 32, 255]),
  { bytesPerRow: 4 },
  { width: 1, height: 1 },
);
const shader = device.createShaderModule({
  code: `
@group(0) @binding(0) var baseColorTexture : texture_2d<f32>;
@group(0) @binding(1) var normalTexture : texture_2d<f32>;
@group(0) @binding(2) var textureSampler : sampler;

struct VsOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index : u32) -> VsOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out : VsOut;
  out.position = vec4<f32>(positions[index], 0.0, 1.0);
  out.uv = positions[index] * 0.5 + vec2<f32>(0.5);
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let base = textureSample(baseColorTexture, textureSampler, in.uv);
  let normal = textureSample(normalTexture, textureSampler, in.uv);
  return vec4<f32>(base.rgb * (0.5 + normal.g * 0.5), 1.0);
}
`,
});
const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: shader, entryPoint: 'vs_main' },
  fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format }] },
  primitive: { topology: 'triangle-list' },
});
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: baseColorTexture.createView() },
    { binding: 1, resource: (variant === 'normal-slot-swap' ? baseColorTexture : normalTexture).createView() },
    { binding: 2, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
  ],
});
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: target.createView(),
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  }],
});
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.draw(3);
pass.end();
encoder.copyTextureToBuffer(
  { texture: target },
  { buffer: readback, bytesPerRow: 256 },
  { width: 4, height: 4 },
);
device.queue.submit([encoder.finish()]);
await device.queue.onSubmittedWorkDone();
await readback.mapAsync(GPUMapMode.READ);
const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
readback.unmap();
assert(pixel[0] > 0 && pixel[1] > 0 && pixel[2] > 0 && pixel[3] === 255, `Dawn normal-slot output was empty: ${pixel.join(',')}`);
readback.destroy();
target.destroy();
baseColorTexture.destroy();
normalTexture.destroy();
device.destroy();
console.log(JSON.stringify({
  status: 'pass',
  backend: 'dawn-webgpu',
  variant,
  pixel,
  rootArtifactDigest: material.record.artifactDigest,
  normalTextureSlot: authoredNormalTextureGuid,
}));
