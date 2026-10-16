import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';

it('keeps actual receiver planes independent of shading at microscopic scale and bounds oct quantization', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const source = (file: string) =>
    readFileSync(resolve(process.cwd(), 'packages/shader/src', file), 'utf8').replace(
      /^#.*\n/gm,
      '',
    );
  const module = createShaderModuleImmediate(device, {
    code:
      source('surface_v1.wgsl') +
      source('standard-gbuffer.wgsl') +
      `
@group(0) @binding(0) var<uniform> scale:vec4<f32>;
struct Vertex { @builtin(position) position:vec4<f32>, @location(0) world:vec3<f32> };
@vertex fn vs(@builtin(vertex_index) i:u32)->Vertex {
 let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0))[i];
 return Vertex(vec4<f32>(p,0.5,1.0),vec3<f32>(p.x,p.x,-p.y)*scale.x);
}
fn receiver(in:Vertex)->vec3<f32> {
 return surfaceGeometryNormal(dpdx(in.world),dpdy(in.world),vec3<f32>(1.0,0.0,0.0));
}
@fragment fn exact(in:Vertex)->@location(0) vec4<f32> { return vec4<f32>(receiver(in),1.0); }
@fragment fn valid(in:Vertex)->@location(0) vec4<f32> {
 let raw=surfaceGeometryNormal(dpdx(in.world),dpdy(in.world),vec3<f32>(0.0));
 return vec4<f32>(select(0.0,1.0,dot(raw,raw)>0.0),0.0,0.0,1.0);
}
@fragment fn packed(in:Vertex)->@location(0) vec4<f32> {
 return vec4<f32>(decodeStandardNormalRoughness(encodeStandardNormalRoughness(receiver(in),0.0)).xyz,1.0);
}
`,
  }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const pipelines = ['exact', 'packed', 'valid'].map((entryPoint) =>
    device
      .createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint, targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap(),
  );
  const uniform = device.createBuffer({ size: 16, usage: 0x40 | 0x08 }).unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } }],
    })
    .unwrap();
  const target = device
    .createTexture({ size: { width: 4, height: 4 }, format: 'rgba32float', usage: 0x01 | 0x10 })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const read = device.createBuffer({ size: 1024, usage: 0x01 | 0x08 }).unwrap();

  try {
    for (const scale of [1, 1e-8, 1e8, 0]) {
      device.queue.writeBuffer(uniform, 0, new Float32Array([scale, 0, 0, 0])).unwrap();
      for (const [variant, pipeline] of pipelines.entries()) {
        const encoder = device.createCommandEncoder().unwrap();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: target },
          { buffer: read, bytesPerRow: 256 },
          { width: 4, height: 4, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        const mapped = (await read.mapAsync(0x01)).unwrap();
        const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
        mapped.unmap();
        for (let y = 0; y < 4; y++)
          for (let x = 0; x < 4; x++) {
            const offset = y * 64 + x * 4;
            if (variant === 2) {
              expect(values[offset]).toBe(scale === 0 ? 0 : 1);
              continue;
            }
            const expected = scale === 0 ? [1, 0, 0] : [-Math.SQRT1_2, Math.SQRT1_2, 0];
            const normal = Array.from(values.subarray(offset, offset + 3));
            expect(values[offset + 3]).toBe(1);
            expect(normal.every(Number.isFinite)).toBe(true);
            if (variant === 0)
              normal.forEach((v, axis) => {
                expect(Math.abs(v - (expected[axis] ?? 0))).toBeLessThan(1e-6);
              });
            const length = Math.hypot(...normal);
            const dot =
              normal.reduce((sum, value, axis) => sum + value * (expected[axis] ?? 0), 0) / length;
            expect(Math.acos(Math.min(1, Math.max(-1, dot)))).toBeLessThanOrEqual(0.002);
          }
      }
    }
  } finally {
    device.destroyBuffer(read).unwrap();
    device.destroyBuffer(uniform).unwrap();
    device.destroyTexture(target).unwrap();
  }
});
