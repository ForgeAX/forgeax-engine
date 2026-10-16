import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';
import { VIEW_ABI } from '../engine-inputs/view-abi';

it('shadows only direct air scattering with geometry and cloud visibility on the compiled production kernel', async () => {
  const engine = await loadEngineShaderEntries();
  const compiled = (
    await compileShader(
      `
#import forgeax_view::common::{View}
#import forgeax_atmosphere::optics::{atmosphere_integrate}
@group(0) @binding(0) var<uniform> v:View;
@group(0) @binding(1) var trans:texture_2d<f32>;
@group(0) @binding(2) var multi:texture_2d<f32>;
@group(0) @binding(3) var filtering:sampler;
@group(0) @binding(4) var<storage,read_write> output:array<vec4<f32>>;
@compute @workgroup_size(1) fn main() {
  let ray=atmosphere_integrate(v.atmosphere,vec3<f32>(0.0,6360.001,0.0),vec3<f32>(0.0,0.0,-1.0),1.0,vec3<f32>(0.0,1.0,0.0),vec3<f32>(1.0),trans,multi,filtering,64u,1.0);
  output[0]=vec4<f32>(ray.luminance,1.0); output[1]=vec4<f32>(ray.transmittance,1.0);
}`,
      {
        id: 'atmosphere-visibility-test',
        imports: engine.imports,
        defines: { ATMOSPHERE_UTILITY_SHADOWS: true },
      },
    )
  ).unwrap();
  expect(compiled.wgsl).toContain('textureSampleCompareLevel');
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const buffer = (size: number, usage: number) => {
    const b = device.createBuffer({ size, usage });
    owned.push(b);
    return b;
  };
  const view = buffer(VIEW_ABI.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const result = buffer(32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = buffer(32, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const texture = () => {
    const t = device.createTexture({
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    owned.push(t);
    return t;
  };
  const trans = texture(),
    multi = texture(),
    cloud = texture();
  const fill = (t: GPUTexture, half: number) =>
    device.queue.writeTexture(
      { texture: t },
      new Uint16Array([half, half, half, 15360]),
      { bytesPerRow: 8 },
      [1, 1],
    );
  fill(trans, 15360);
  fill(multi, 0);
  fill(cloud, 15360);
  const depth = device.createTexture({
    size: [1, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  owned.push(depth);
  const filtering = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const comparison = device.createSampler({ compare: 'greater-equal' });
  const values = new Float32Array(320);
  values[42] = 0.5;
  values[43] = 1;
  values[124] = 1; // constant projected depth, one containing cascade
  values.set(
    [
      0, 0, 0, 6360, 0.005802, 0.013558, 0.0331, 8, 0.003996, 0.000444, 1.2, 0.8, 0.00065, 0.001881,
      0.000085, 25, 0.4, 0.4, 0.4, 15, 60, 1, 0, 1,
    ],
    292,
  );
  const module = device.createShaderModule({ code: compiled.wgsl });
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const group0 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: view } },
      { binding: 1, resource: trans.createView() },
      { binding: 2, resource: multi.createView() },
      { binding: 3, resource: filtering },
      { binding: 4, resource: { buffer: result } },
    ],
  });
  const group1 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: depth.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: comparison },
      { binding: 2, resource: cloud.createView() },
      { binding: 3, resource: filtering },
      { binding: 4, resource: { buffer: view } },
    ],
  });
  const run = async (shadowDepth: number) => {
    device.queue.writeBuffer(view, 0, values);
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: shadowDepth,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(result, 0, readback, 0, 32);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    return data;
  };
  device.pushErrorScope('validation');
  try {
    const lit = await run(0),
      blocked = await run(1);
    expect(lit[0]).toBeGreaterThan(0.0001);
    expect(blocked.slice(0, 3)).toEqual([0, 0, 0]);
    expect(blocked.slice(4, 7)).toEqual(lit.slice(4, 7));
    values[252] = 1000;
    values[253] = 1;
    fill(cloud, 13312); // 0.25
    const cloudy = await run(0);
    for (let c = 0; c < 3; c++) expect(cloudy[c]).toBeCloseTo((lit[c] ?? 0) * 0.25, 7);
    fill(multi, 11878); // approximately 0.1; multiple scattering is unshadowed
    const indirect = await run(1);
    expect(indirect[0]).toBeGreaterThan(0.0001);
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const resource of owned) resource.destroy();
    device.destroy();
  }
});
