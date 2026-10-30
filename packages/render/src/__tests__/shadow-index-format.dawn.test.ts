import type { Buffer, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import {
  type GpuDrivenShadowSubmission,
  recordGpuDrivenShadowIndirect,
} from '../record/shadow-pass';
import { nativeDeviceFixture } from './native-device-fixture';

it('matches explicit index-format bindings for one shared buffer on the actual GPU', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const buffers: Buffer[] = [];
  const texture = device
    .createTexture({
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x11,
    })
    .unwrap();
  try {
    const shader = createShaderModuleImmediate(device, {
      code: `
@vertex fn vertex(@builtin(vertex_index) index:u32, @builtin(instance_index) instance:u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>,3>(vec2<f32>(-.9,-.8),vec2<f32>(-.1,-.8),vec2<f32>(-.5,.8));
  return vec4<f32>(p[index] + vec2<f32>(f32(instance),0),0,1);
}
@fragment fn fragment() -> @location(0) vec4<f32> { return vec4<f32>(0,1,0,1); }
`,
    }).unwrap();
    const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const group = device.createBindGroup({ layout, entries: [] }).unwrap();
    const dynamicLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 1,
            buffer: { type: 'uniform', hasDynamicOffset: true },
          },
        ],
      })
      .unwrap();
    const uniform = device.createBuffer({ size: 256, usage: 0x40 }).unwrap();
    buffers.push(uniform);
    const dynamicGroup = device
      .createBindGroup({
        layout: dynamicLayout,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: uniform, size: 16 } },
          },
        ],
      })
      .unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device
          .createPipelineLayout({
            bindGroupLayouts: [layout, dynamicLayout, dynamicLayout, layout],
          })
          .unwrap(),
        vertex: { module: shader, entryPoint: 'vertex', buffers: [] },
        fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      })
      .unwrap();
    const buffer = (size: number, usage: number) => {
      const value = device.createBuffer({ size, usage }).unwrap();
      buffers.push(value);
      return value;
    };
    const index = buffer(12, 0x18);
    const indirect = buffer(60, 0x108);
    const vertex = buffer(4, 0x28);
    const readback = buffer(256 * 16, 0x9);
    device.queue.writeBuffer(index, 0, new Uint32Array([0, 1, 2])).unwrap();
    // uint16 interprets this same buffer as [0,0,1], a degenerate triangle.
    // Only the middle uint32 draw fills the left half. The final uint16 draw
    // must remain degenerate on the right half.
    device.queue
      .writeBuffer(indirect, 0, new Uint32Array([3, 1, 0, 0, 0, 3, 1, 0, 0, 0, 3, 1, 0, 0, 1]))
      .unwrap();
    const submission = {
      view: { indirectBuffer: indirect },
      batches: (['uint16', 'uint32', 'uint16'] as const).map((indexFormat, ordinal) => ({
        pipeline,
        indexBuffer: index,
        indexFormat,
        vertexBuffer: vertex,
        materialGroup: dynamicGroup,
        meshBindGroup: dynamicGroup,
        visibleBindGroups: [group],
        deformation: 'rigid' as const,
        indirectOffset: ordinal * 20,
      })),
    } as unknown as GpuDrivenShadowSubmission;
    async function render(optimized: boolean) {
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: device.createTextureView(texture, {}).unwrap(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setBindGroup(0, group);
      if (optimized) recordGpuDrivenShadowIndirect(pass, submission);
      else explicit(pass, submission);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: readback, bytesPerRow: 256 },
        { width: 16, height: 16, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      return bytes;
    }
    const expected = await render(false);
    const actual = await render(true);
    expect(equalBytes(actual, expected)).toBe(true);
    let left = 0,
      right = 0;
    for (let y = 0; y < 16; y += 1)
      for (let x = 0; x < 16; x += 1) {
        if (actual[y * 256 + x * 4 + 1] === 255) x < 8 ? left++ : right++;
      }
    expect(left).toBeGreaterThan(0);
    expect(right).toBe(0);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    device.destroyTexture(texture).unwrap();
    native.destroy();
  }
});

function explicit(pass: RhiRenderPassEncoder, submission: GpuDrivenShadowSubmission) {
  for (const row of submission.batches) {
    pass.setPipeline(row.pipeline);
    pass.setVertexBuffer(0, row.vertexBuffer);
    pass.setIndexBuffer(defined(row.indexBuffer), defined(row.indexFormat));
    pass.setBindGroup(1, row.materialGroup, [0]);
    pass.setBindGroup(2, row.meshBindGroup, [0]);
    pass.setBindGroup(3, defined(row.visibleBindGroups[0]));
    pass.drawIndexedIndirect(defined(submission.view.indirectBuffer), row.indirectOffset);
  }
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing explicit index-format oracle resource');
  return value;
}
