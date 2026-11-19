import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

it('keeps depth-only and masked pixels invalid through the full six-target Deferred writer', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('GBuffer v2 requires a GPU adapter');
  const device = await adapter.requestDevice({
    requiredLimits: { maxColorAttachmentBytesPerSample: 36 },
  });
  device.pushErrorScope('validation');
  const formats = ['rgba16float', 'rg32uint', 'r32uint', 'r32uint', 'r32uint', 'rg32uint'] as const;
  const textures = formats.map((format) =>
    device.createTexture({
      size: [8, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }),
  );
  const depth = device.createTexture({
    size: [8, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const output = device.createBuffer({
    size: 8 * 80,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const code = await composeShader(
      `
#import forgeax_pbr::gbuffer_output::{GBufferOutput, encodeStandardGBuffer}
#import forgeax_pbr::gbuffer::{standardGBufferValid, decodeStandardGBufferNormal, decodeStandardReflectance, decodeStandardGBufferReflectance, STANDARD_GBUFFER_V2_DIRECT_DFG_BIT}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0.5,1.0);
}
@fragment fn depthOnly() -> @builtin(frag_depth) f32 { return 0.75; }
@fragment fn fs_write_surface(@builtin(position) p: vec4f) -> GBufferOutput {
  let x = u32(p.x);
  // Predepth exists everywhere, including a clipped/Masked hole and a
  // Forward-only contributor with no material output in this lane.
  if (x < 3u) { discard; }
  let metallic = select(select(0.0, 0.99999, x == 4u), 1.0, x == 5u);
  return encodeStandardGBuffer(vec3f(0,0,1), vec3f(0,1,0), 0.25,
    vec3f(0.16,0.36,0.64), metallic, vec4f(0.01,0.04,0.16,0.35), 0.6,
    vec3f(2,3,4), 1.0, 2u, 17u, x != 7u, 0x80000001u, vec4f(0), x == 6u);
}
@group(0) @binding(0) var color: texture_2d<f32>;
@group(0) @binding(1) var normal: texture_2d<u32>;
@group(0) @binding(2) var dielectric: texture_2d<u32>;
@group(0) @binding(3) var albedo: texture_2d<u32>;
@group(0) @binding(4) var context: texture_2d<u32>;
@group(0) @binding(5) var receiver: texture_2d<u32>;
@group(0) @binding(6) var depth: texture_depth_2d;
struct Result { normal: vec4f, mixed: vec4f, dielectric: vec4f, facts: vec4f, raw: vec4u }
@group(0) @binding(7) var<storage, read_write> output: array<Result>;
@compute @workgroup_size(8) fn cs_read_surface(@builtin(global_invocation_id) id: vec3u) {
  let p = vec2i(i32(id.x),0); let n = textureLoad(normal,p,0).rg;
  let d = textureLoad(dielectric,p,0).r; let a = textureLoad(albedo,p,0).r;
  let c = textureLoad(context,p,0).r; let r = textureLoad(receiver,p,0).rg;
  let emission = textureLoad(color,p,0);
  let z = textureLoad(depth,p,0);
  if (!standardGBufferValid(n)) {
    output[id.x] = Result(vec4f(0),vec4f(0),vec4f(0),
      vec4f(emission.r+emission.g+emission.b+emission.a,z,0,0),vec4u(n.x|n.y,d|a,c,r.x|r.y));
    return;
  }
  let response = decodeStandardGBufferReflectance(decodeStandardReflectance(a),d,n);
  output[id.x] = Result(decodeStandardGBufferNormal(n),response.response,response.dielectricSpecular,
    vec4f(emission.r,z,1.0,select(0.0,1.0,(n.x & STANDARD_GBUFFER_V2_DIRECT_DFG_BIT)!=0u)),
    vec4u(c,r,n.y));
}`,
      {
        'forgeax_pbr::gbuffer': readFileSync(
          new URL('../standard-gbuffer.wgsl', import.meta.url),
          'utf8',
        ),
        'forgeax_pbr::gbuffer_output': readFileSync(
          new URL('../standard-gbuffer-output.wgsl', import.meta.url),
          'utf8',
        ),
      },
      {},
    );
    const module = device.createShaderModule({ code });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const base = {
      layout: 'auto' as const,
      vertex: { module, entryPoint: 'vs' },
      primitive: { topology: 'triangle-list' as const },
      depthStencil: {
        format: 'depth32float' as const,
        depthWriteEnabled: true,
        depthCompare: 'always' as const,
      },
    };
    const predepth = await device.createRenderPipelineAsync({
      ...base,
      fragment: { module, entryPoint: 'depthOnly', targets: [] },
    });
    const writer = await device.createRenderPipelineAsync({
      ...base,
      fragment: {
        module,
        entryPoint: 'fs_write_surface',
        targets: formats.map((format) => ({ format })),
      },
    });
    const reader = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'cs_read_surface' },
    });
    const group = device.createBindGroup({
      layout: reader.getBindGroupLayout(0),
      entries: [
        ...textures.map((texture, binding) => ({ binding, resource: texture.createView() })),
        { binding: 6, resource: depth.createView() },
        { binding: 7, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const first = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
    });
    first.setPipeline(predepth);
    first.draw(3);
    first.end();
    const pass = encoder.beginRenderPass({
      colorAttachments: textures.map((texture) => ({
        view: texture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: [0, 0, 0, 0],
      })),
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(writer);
    pass.draw(3);
    pass.end();
    const read = encoder.beginComputePass();
    read.setPipeline(reader);
    read.setBindGroup(0, group);
    read.dispatchWorkgroups(1);
    read.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange();
    const f = new Float32Array(bytes),
      u = new Uint32Array(bytes);
    for (let x = 0; x < 8; x++) {
      const at = x * 20;
      if (x < 3) {
        expect(Array.from(u.slice(at + 16, at + 20))).toEqual([0, 0, 0, 0]);
        expect(Array.from(f.slice(at + 12, at + 16))).toEqual([0, 0.75, 0, 0]);
        continue;
      }
      expect(f[at + 2]).toBeGreaterThan(0.999);
      expect(Math.abs((f[at + 3] ?? NaN) - 0.25)).toBeLessThan(1 / 510 + 1e-6);
      expect(Math.abs((f[at + 7] ?? NaN) - 0.6)).toBeLessThan(1 / 510 + 1e-6);
      expect(Math.abs((f[at + 11] ?? NaN) - 0.35)).toBeLessThan(1 / 510 + 1e-6);
      const metallic = x === 4 ? 0.99999 : x === 5 ? 1 : 0;
      for (const [axis, dielectric, albedo] of [
        [0, 0.01, 0.16],
        [1, 0.04, 0.36],
        [2, 0.16, 0.64],
      ] as const) {
        expect(Math.abs((f[at + 8 + axis] ?? NaN) - dielectric)).toBeLessThan(1 / 255 + 1e-6);
        expect(
          Math.abs((f[at + 4 + axis] ?? NaN) - (dielectric * (1 - metallic) + albedo * metallic)),
        ).toBeLessThan(1 / 255 + 1e-6);
      }
      expect(Array.from(f.slice(at + 12, at + 16))).toEqual([2, 0.5, 1, x === 6 ? 1 : 0]);
      expect(u[at + 16]).toBe(((2 << 24) | (x === 7 ? 1 << 23 : 0) | 17) >>> 0);
      expect(u[at + 18]).toBe(0x80000001);
    }
    readback.unmap();
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const texture of textures) texture.destroy();
    depth.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});

it('specializes one native module for Forward v1 and complete Deferred v2 GPU writers/readers', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('GBuffer v2 requires a GPU adapter');
  const device = await adapter.requestDevice();
  const count = 1024;
  const values = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(1 - z * z),
      angle = i * Math.PI * (3 - Math.sqrt(5));
    values.set(
      [
        radius * Math.cos(angle),
        radius * Math.sin(angle),
        z,
        (i % 256) / 255,
        ((i * 37) % 256) / 255,
        i % 2,
        0,
        0,
      ],
      i * 8,
    );
  }
  const input = device.createBuffer({
    size: values.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: count * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: count * 64,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const v1 = device.createTexture({
    size: [count, 1],
    format: 'r32uint',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
  const v2 = device.createTexture({
    size: [count, 1],
    format: 'rg32uint',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
  try {
    const code = await composeShader(
      `
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness, encodeStandardGBufferNormal, loadStandardNormalRoughness, loadStandardSceneSurfaceValid, standardGBufferOcclusion, STANDARD_GBUFFER_V2_DIRECT_DFG_BIT}
struct Input { normalRoughness: vec4f, options: vec4f }
struct Output { normalRoughness: vec4f, facts: vec4f }
@group(0) @binding(0) var<storage, read> inputs: array<Input>;
@group(0) @binding(1) var v1: texture_storage_2d<r32uint, write>;
@group(0) @binding(2) var v2: texture_storage_2d<rg32uint, write>;
@group(0) @binding(3) var normal: texture_2d<u32>;
@group(0) @binding(4) var<storage, read_write> output: array<Output>;
@compute @workgroup_size(64) fn produce(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&inputs) || id.x < 2u) { return; }
  let value = inputs[id.x]; let pixel = vec2i(i32(id.x), 0);
  textureStore(v1, pixel, vec4u(encodeStandardNormalRoughness(value.normalRoughness.xyz, value.normalRoughness.w)));
  let packed = encodeStandardGBufferNormal(value.normalRoughness.xyz, value.normalRoughness.w, value.options.x, value.options.y != 0.0);
  textureStore(v2, pixel, vec4u(packed, 0u, 0u));
}
@compute @workgroup_size(64) fn consume(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&output)) { return; }
  let pixel = vec2i(i32(id.x), 0); let packed = textureLoad(normal, pixel, 0).rg;
  output[id.x] = Output(loadStandardNormalRoughness(normal, pixel),
    vec4f(select(0.0,1.0,loadStandardSceneSurfaceValid(normal,pixel)), standardGBufferOcclusion(packed),
      select(0.0,1.0,(packed.x & STANDARD_GBUFFER_V2_DIRECT_DFG_BIT) != 0u), 0.0));
}`,
      {
        'forgeax_pbr::gbuffer': readFileSync(
          new URL('../standard-gbuffer.wgsl', import.meta.url),
          'utf8',
        ),
      },
      {},
    );
    const module = device.createShaderModule({ code });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const producer = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'produce' },
    });
    const producerBindings = device.createBindGroup({
      layout: producer.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: v1.createView() },
        { binding: 2, resource: v2.createView() },
      ],
    });
    device.queue.writeBuffer(input, 0, values);
    const encoder = device.createCommandEncoder();
    const producerPass = encoder.beginComputePass();
    producerPass.setPipeline(producer);
    producerPass.setBindGroup(0, producerBindings);
    producerPass.dispatchWorkgroups(count / 64);
    producerPass.end();
    for (const [layout, texture] of [
      [0, v1],
      [1, v2],
    ] as const) {
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'consume', constants: { '64003': layout } },
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 3, resource: texture.createView() },
          { binding: 4, resource: { buffer: output } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(count / 64);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, layout * output.size, output.size);
    }
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange());
    for (const layout of [0, 1]) {
      for (let i = 0; i < count; i++) {
        const base = (layout * count + i) * 8;
        expect(result[base + 4]).toBe(layout === 1 && i < 2 ? 0 : 1);
        if (i < 2) continue;
        let dot = 0,
          a2 = 0,
          b2 = 0;
        for (let axis = 0; axis < 3; axis++) {
          const a = values[i * 8 + axis] ?? NaN,
            b = result[base + axis] ?? NaN;
          dot += a * b;
          a2 += a * a;
          b2 += b * b;
        }
        const error =
          (Math.acos(Math.min(1, Math.max(-1, dot / Math.sqrt(a2 * b2)))) * 180) / Math.PI;
        expect(error).toBeLessThan(layout === 0 ? 0.07 : 0.1);
        expect(Math.abs((result[base + 3] ?? NaN) - (values[i * 8 + 3] ?? NaN))).toBeLessThan(
          1 / 510 + 1e-6,
        );
        if (layout === 1) {
          expect(Math.abs((result[base + 5] ?? NaN) - (values[i * 8 + 4] ?? NaN))).toBeLessThan(
            1 / 510 + 1e-6,
          );
          expect(result[base + 6]).toBe(values[i * 8 + 5]);
        }
      }
    }
    readback.unmap();
  } finally {
    input.destroy();
    output.destroy();
    readback.destroy();
    v1.destroy();
    v2.destroy();
    device.destroy();
  }
});
