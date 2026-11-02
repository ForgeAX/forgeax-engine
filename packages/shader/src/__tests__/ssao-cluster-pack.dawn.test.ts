import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('packs both UNORM8 float decode forms into the same exact Cluster words', async () => {
  const source = readFileSync(new URL('../hdrp-ssao.wgsl', import.meta.url), 'utf8');
  const start = source.indexOf('@fragment\nfn fs_ssao_cluster_pack(');
  if (start < 0) throw new Error('Missing production AO Cluster pack entry');
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('AO packing regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const input = device.createTexture({
    size: [256, 2],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const output = device.createTexture({
    size: [64, 2],
    format: 'rgba32uint',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const uniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: 2048,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    // Both representations occur when a normalized texture is decoded to f32.
    // R32F preserves them independently of this device's own UNORM decoder.
    const values = new Float32Array(512);
    const expected = new Uint32Array(512);
    for (let byte = 0; byte < 256; byte++) {
      values[byte] = byte / 255;
      values[256 + byte] = Math.fround(byte * Math.fround(1 / 255));
      expected[byte] = expected[256 + byte] =
        byte === 255 ? 0xffffffff : Math.round((byte / 255) * 4294967040);
    }
    device.queue.writeTexture({ texture: input }, values, { bytesPerRow: 1024 }, [256, 2]);
    device.queue.writeBuffer(uniform, 0, new Uint32Array([0, 0, 64, 64]));
    const module = device.createShaderModule({
      code: `
struct PackUniform { clusterPack: vec4<u32> }
@group(0) @binding(0) var<uniform> ssao_uniform: PackUniform;
@group(0) @binding(1) var ssaoRaw: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4(f32((i << 1u) & 2u)*2.0-1.0, 1.0-f32(i & 2u)*2.0, 0.0, 1.0);
}
${source.slice(start)}`,
    });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    });
    const pipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs_ssao_cluster_pack', targets: [{ format: 'rgba32uint' }] },
    });
    const bindings = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: input.createView() },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: output },
      { buffer: readback, bytesPerRow: 1024 },
      [64, 2],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect(await device.popErrorScope()).toBeNull();
    expect(actual).toEqual(expected);
  } finally {
    input.destroy();
    output.destroy();
    uniform.destroy();
    readback.destroy();
    device.destroy();
  }
});
