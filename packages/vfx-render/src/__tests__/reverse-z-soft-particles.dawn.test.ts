import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

for (const name of ['billboard', 'billboard-inputs']) {
  it(`${name} uses Reverse-Z occlusion, contact fading and empty depth`, async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('Dawn adapter unavailable');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    try {
      // Probe the soft-particle kernel alone; the fog imports compose elsewhere.
      const shader = readFileSync(`packages/vfx-render/src/shaders/${name}.wgsl`, 'utf8');
      const kernel = shader.slice(
        shader.indexOf('fn softParticle'),
        shader.indexOf('\n}\n', shader.indexOf('fn softParticle(')) + 3,
      );
      const module = device.createShaderModule({
        code: `@group(0) @binding(0) var scene_depth: texture_depth_2d;
${kernel}
@group(1) @binding(0) var<storage, read_write> result: vec4<f32>;
@compute @workgroup_size(1) fn probe() {
  result = vec4<f32>(
    softParticle(vec4<f32>(0.5, 0.5, 0.75, 1.0), 1.0, 0.0),
    softParticle(vec4<f32>(0.5, 0.5, 0.25, 1.0), 1.0, 0.0),
    softParticle(vec4<f32>(0.5, 0.5, 0.625, 1.0), 1.0, 0.5),
    softParticle(vec4<f32>(0.5, 0.5, 0.0000001, 1.0), 1.0, 0.5));
}`,
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'probe' },
      });
      const depth = device.createTexture({ size: [1, 1], format: 'depth32float', usage: 0x14 });
      const output = device.createBuffer({ size: 16, usage: 0x84 });
      const readback = device.createBuffer({ size: 48, usage: 0x9 });
      const groups = [
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: depth.createView() }],
        }),
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(1),
          entries: [{ binding: 0, resource: { buffer: output } }],
        }),
      ];
      const encoder = device.createCommandEncoder();
      [0, 0.5, 0.9].forEach((clear, row) => {
        encoder
          .beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: depth.createView(),
              depthClearValue: clear,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
          })
          .end();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        groups.forEach((group, index) => {
          pass.setBindGroup(index, group);
        });
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, row * 16, 16);
      });
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const actual = [...new Float32Array(readback.getMappedRange().slice(0))];
      readback.unmap();
      expect(actual).toEqual([1, 1, 1, 1, 1, 0, 0.25, 0, 0, 0, 0, 0]);
      expect(await device.popErrorScope()).toBeNull();
    } finally {
      device.destroy();
    }
  });
}
