import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';

it('keeps production directional receiver bias finite at signed and tiny positive cosines', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const source = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/lighting-directional.wgsl'),
    'utf8',
  );
  const start = source.indexOf('fn _directionalReceiverDepthBias(');
  const end = source.indexOf('\n}\n', start) + 3;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const module = createShaderModuleImmediate(device, {
    code: `
struct ProbeView { splitPlanes:array<vec4<f32>,4>, depthBias:f32, normalBias:f32 };
var<private> view:ProbeView;
struct Probe { shape:vec4<f32>, comparison:vec4<f32> };
@group(0) @binding(0) var<uniform> probe:Probe;
@group(0) @binding(1) var compareSampler:sampler_comparison;
@group(0) @binding(2) var depth:texture_depth_2d;
fn _cascadeLightViewProj(layer:u32)->mat4x4<f32> {
 return mat4x4<f32>(vec4<f32>(1,0,0,0),vec4<f32>(0,0,1,0),vec4<f32>(0,1,0,0),vec4<f32>(0,0,0,1));
}
${source.slice(start, end)}
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
 let p=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3))[i];
 return vec4<f32>(p,0.5,1);
}
@fragment fn fs()->@location(0) vec4<f32> {
 view.splitPlanes[0]=vec4<f32>(0,probe.shape.y,1,0);
 view.depthBias=probe.comparison.x; view.normalBias=probe.shape.w;
 let bias=_directionalReceiverDepthBias(0u,vec3<f32>(1,0,0),vec3<f32>(probe.shape.x,1,0),probe.shape.z);
 let lit=textureSampleCompareLevel(depth,compareSampler,vec2<f32>(0.5),probe.comparison.y+bias);
 return vec4<f32>(bias,lit,0,1);
}`,
  }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 2, sampler: { type: 'comparison' } },
        { binding: 2, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
      ],
    })
    .unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module, entryPoint: 'vs', buffers: [] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const uniform = device.createBuffer({ size: 32, usage: 0x40 | 0x08 }).unwrap();
  const depthTexture = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'depth32float', usage: 0x04 | 0x10 })
    .unwrap();
  const depthView = device.createTextureView(depthTexture, {}).unwrap();
  const sampler = device
    .createSampler({ compare: 'greater', magFilter: 'nearest', minFilter: 'nearest' })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } },
        { binding: 1, resource: { kind: 'sampler', value: sampler } },
        { binding: 2, resource: { kind: 'textureView', value: depthView } },
      ],
    })
    .unwrap();
  const target = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'rgba32float', usage: 0x01 | 0x10 })
    .unwrap();
  const viewHandle = device.createTextureView(target, {}).unwrap();
  const read = device.createBuffer({ size: 256, usage: 0x01 | 0x08 }).unwrap();
  const results: {
    cosine: number;
    normalBias: number;
    depthBias: number;
    receiverDepth: number;
    storedDepth: number;
    bias: number | undefined;
    lit: number | undefined;
  }[] = [];
  try {
    for (const [cosine, normalBias, depthBias, receiverDepth, storedDepth] of [
      [0.5, 0.005, 0.00001, 0.5, 0.5],
      [0.0099, 0.005, 0.00001, 0, 1],
      [0, 0.005, 0.00001, 0, 1],
      [-0.1, 0.005, 0.00001, 0, 1],
      [1e-40, 0.05, 0.00001, 0, 1],
      [1e-40, 0.0001, 0.00001, 0, 1],
      [0.0099, 0.005, 0, 0, 1],
      [0.0099, 0.005, -0.25, 0, 1],
    ] as const) {
      device.queue
        .writeBuffer(
          uniform,
          0,
          new Float32Array([cosine, 0.01, 2, normalBias, depthBias, receiverDepth, 0, 0]),
        )
        .unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const seed = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: storedDepth,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      seed.end();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: viewHandle, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: read, bytesPerRow: 256 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await read.mapAsync(0x01)).unwrap();
      const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
      const bias = values[0],
        lit = values[1];
      mapped.unmap();
      results.push({ cosine, normalBias, depthBias, receiverDepth, storedDepth, bias, lit });
    }
    mkdirSync(resolve(process.cwd(), 'artifacts'), { recursive: true });
    writeFileSync(
      resolve(process.cwd(), 'artifacts/terrain-receiver-bias-probe.json'),
      JSON.stringify(
        results.map((result) => ({
          ...result,
          finite: Number.isFinite(result.bias),
          observed: String(result.bias),
        })),
        null,
        2,
      ),
    );
    for (const {
      cosine,
      normalBias,
      depthBias,
      receiverDepth,
      storedDepth,
      bias,
      lit,
    } of results) {
      expect(Number.isFinite(bias), `cosine=${cosine}, normalBias=${normalBias}`).toBe(true);
      expect(bias).toBeGreaterThanOrEqual(depthBias - 1e-6);
      expect(bias).toBeLessThanOrEqual(1.00002);
      if (cosine >= 1e-30)
        expect(bias).toBeCloseTo(
          Math.min(1.0000001192092896, depthBias + Math.max(0, 0.02 - normalBias) / cosine),
          5,
        );
      if (cosine <= 0 || normalBias >= 0.02) expect(bias).toBeCloseTo(depthBias, 6);
      if (cosine >= 1e-30 || cosine <= 0 || normalBias >= 0.02) {
        const mathematicalBias =
          depthBias + (cosine > 0 ? Math.max(0, 0.02 - normalBias) / cosine : 0);
        expect(lit, `strict greater comparison: floor=${depthBias}`).toBe(
          receiverDepth + mathematicalBias > storedDepth ? 1 : 0,
        );
      }
    }
  } finally {
    device.destroyBuffer(read).unwrap();
    device.destroyBuffer(uniform).unwrap();
    device.destroyTexture(target).unwrap();
    device.destroyTexture(depthTexture).unwrap();
  }
});
