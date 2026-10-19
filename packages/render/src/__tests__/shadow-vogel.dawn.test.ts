import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('matches Three Vogel footprints at interior and clamped texture edges with receiver correction', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Native GPU adapter is required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const depth = device.createTexture({
    size: [32, 32, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const output = device.createBuffer({
    size: 64 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 64 * 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const seed = device.createShaderModule({
      code: `
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
        let p = array<vec2<f32>,3>(vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
        return vec4(p[i],0.0,1.0);
      }
      @fragment fn fs(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
        return select(0.25,0.75,(u32(p.x) + u32(p.y)) % 3u == 0u);
      }`,
    });
    const seedPipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: seed, entryPoint: 'vs' },
      fragment: { module: seed, entryPoint: 'fs', targets: [] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    const shared = readFileSync(
      new URL('../../../shader/src/shadow-pcf.wgsl', import.meta.url),
      'utf8',
    ).replace(/^#.*$/gm, '');
    const module = device.createShaderModule({
      code: `${shared}
      @group(0) @binding(0) var depths: texture_depth_2d_array;
      @group(0) @binding(1) var comparison: sampler_comparison;
      @group(0) @binding(2) var<storage,read_write> result: array<vec4<f32>>;
      @compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let pixel = vec2<f32>(f32(id.x)*2.0+0.5, f32(id.x%7u)+0.5);
        let positions = array<f32, 8>(0.1, 0.4, 0.9, 1.2, 15.37, 30.8, 31.6, 31.9);
        let uv = vec2<f32>(positions[id.x%8u], positions[id.x/8u])/32.0;
        let texel = vec2<f32>(1.0/32.0);
        let gradient = select(vec2<f32>(0.0), vec2<f32>(0.01,-0.02), id.x%2u == 0u);
        let actual = sample_shadow_2d_vogel(depths, comparison, uv, 0, texel, 0.5, gradient, pixel);
        let phi = fract(52.9829189*fract(dot(pixel,vec2(0.06711056,0.00583715))))*6.28318530718;
        var reference = 0.0;
        var inward = 0.0;
        for (var i=0u; i<5u; i++) {
          let radius = sqrt((f32(i)+0.5)/5.0);
          let theta = f32(i)*2.399963229728653+phi;
          let sampleUv = uv+vec2(cos(theta),sin(theta))*radius/32.0;
          reference += textureSampleCompareLevel(depths,comparison,sampleUv,0,
            0.5+dot(gradient,(clamp(sampleUv,texel*0.5,vec2(1.0)-texel*0.5)-uv)/texel));
          let inwardUv = clamp(sampleUv, texel, vec2(1.0)-texel);
          inward += textureSampleCompareLevel(depths,comparison,inwardUv,0,
            0.5+dot(gradient,(inwardUv-uv)/texel));
        }
        result[id.x] = vec4(actual, reference*0.2, inward*0.2, 0.0);
      }`,
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depth.createView({ dimension: '2d-array' }) },
        {
          binding: 1,
          resource: device.createSampler({
            compare: 'greater',
            minFilter: 'linear',
            magFilter: 'linear',
          }),
        },
        { binding: 2, resource: { buffer: output } },
      ],
    });
    for (let frame = 0; frame < 60; frame++) {
      const encoder = device.createCommandEncoder();
      const writer = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView({ dimension: '2d', arrayLayerCount: 1 }),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      writer.setPipeline(seedPipeline);
      writer.draw(3);
      writer.end();
      const receiver = encoder.beginComputePass();
      receiver.setPipeline(pipeline);
      receiver.setBindGroup(0, bindings);
      receiver.dispatchWorkgroups(8);
      receiver.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 64 * 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      for (let i = 0; i < 64; i++)
        expect(
          Math.abs((values[i * 4] ?? Number.NaN) - (values[i * 4 + 1] ?? Number.NaN)),
        ).toBeLessThan(1e-5);
      // The old inward clamp must differ, so all-zero or insensitive fixtures fail.
      let changedEdges = 0;
      for (let i = 0; i < 64; i++) {
        if (Math.abs((values[i * 4] ?? 0) - (values[i * 4 + 2] ?? 0)) > 0.01) changedEdges++;
      }
      expect(changedEdges).toBeGreaterThan(8);
    }
    expect(errors).toEqual([]);
  } finally {
    depth.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
