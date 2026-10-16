import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';
import {
  dfgTestReflectance,
  referenceBytes,
  referenceFit,
  referenceFitCompensation,
} from '../../../shader-compiler/src/__tests__/direct-dfg-reference';
import { directDfgLutBytes } from '../direct-dfg-lut-data';

function expectSourceSamples(values: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) {
    for (let channel = 0; channel < 2; channel++) {
      const actual = values[i * 4 + channel];
      const expected = values[i * 4 + channel + 2];
      if (actual === undefined || expected === undefined)
        throw new Error('Incomplete GPU readback');
      expect(Number.isFinite(actual), `sample ${i} channel ${channel}`).toBe(true);
      if (i < 256) expect(actual).toBe(expected);
      else expect(Math.abs(actual - expected)).toBeLessThan(0.000002);
    }
  }
}

it('opt-in DFG texture retains source texels and native linear filtering in compute and fragments', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn DFG regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const coordinates: number[] = [];
  // First retain all 256 exact texel centers. The following grid exercises
  // quarter-texel interpolation and both clamp edges with exact binary inputs.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) coordinates.push((x + 0.5) / 16, (y + 0.5) / 16);
  }
  for (let y = -1; y <= 65; y++) {
    for (let x = -1; x <= 65; x++) coordinates.push(x / 64, y / 64);
  }
  const count = coordinates.length / 2;
  const inputs = device.createBuffer({
    size: coordinates.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: count * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: count * 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const texture = device.createTexture({
    size: [16, 16],
    format: 'rg16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const productionTexture = device.createTexture({
    size: [16, 16],
    format: 'rg16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    expect(directDfgLutBytes()).toEqual(referenceBytes);
    device.queue.writeTexture(
      { texture: productionTexture },
      directDfgLutBytes(),
      { bytesPerRow: 64, rowsPerImage: 16 },
      [16, 16],
    );
    device.queue.writeBuffer(inputs, 0, new Float32Array(coordinates));
    device.queue.writeTexture(
      { texture },
      referenceBytes,
      { bytesPerRow: 64, rowsPerImage: 16 },
      [16, 16],
    );
    const source = readFileSync(new URL('../brdf.wgsl', import.meta.url), 'utf8');
    const code = await composeShader(
      `
        #import forgeax_pbr::brdf::{sampleDirectDfg}
        @group(0) @binding(4) var production: texture_2d<f32>;
        @group(0) @binding(0) var<storage, read> coordinates: array<vec2<f32>>;
        @group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
        @group(0) @binding(2) var reference: texture_2d<f32>;
        @group(0) @binding(3) var filtering: sampler;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          if (id.x >= arrayLength(&coordinates)) { return; }
          let uv = coordinates[id.x];
          let actual = sampleDirectDfg(uv.x, uv.y, true, production, filtering);
          let expected = textureSampleLevel(reference, filtering, uv, 0.0).xy;
          result[id.x] = vec4<f32>(actual, expected);
        }
        struct FullscreenVertex {
          @builtin(position) position: vec4<f32>,
        }
        @vertex fn fullscreen(@builtin(vertex_index) index: u32) -> FullscreenVertex {
          let x = f32((index << 1u) & 2u);
          let y = f32(index & 2u);
          return FullscreenVertex(vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0));
        }
        @fragment fn sampleFragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
          let index = u32(position.y) * 128u + u32(position.x);
          if (index >= arrayLength(&coordinates)) { discard; }
          let uv = coordinates[index];
          let actual = sampleDirectDfg(uv.x, uv.y, true, production, filtering);
          let expected = textureSampleLevel(reference, filtering, uv, 0.0).xy;
          return vec4<f32>(actual, expected);
        }
`,
      { 'forgeax_pbr::brdf': source },
      { DIRECT_DFG_LUT_AVAILABLE: true },
    );
    const module = device.createShaderModule({ code });
    expect(code).not.toMatch(/array\s*<\s*u32\s*,\s*256/);
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputs } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: texture.createView() },
        { binding: 4, resource: productionTexture.createView() },
        {
          binding: 3,
          resource: device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    expectSourceSamples(values, count);
    readback.unmap();

    // The production texture sampler must also survive the actual fragment path;
    // a compute-only oracle does not exercise native raster compilation.
    const width = 128;
    const height = Math.ceil(count / width);
    const color = device.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const fragmentReadback = device.createBuffer({
      size: width * height * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const raster = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'fullscreen' },
        fragment: { module, entryPoint: 'sampleFragment', targets: [{ format: 'rgba32float' }] },
      });
      const rasterGroup = device.createBindGroup({
        layout: raster.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputs } },
          { binding: 2, resource: texture.createView() },
          { binding: 4, resource: productionTexture.createView() },
          {
            binding: 3,
            resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
          },
        ],
      });
      const rasterEncoder = device.createCommandEncoder();
      const rasterPass = rasterEncoder.beginRenderPass({
        colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      rasterPass.setPipeline(raster);
      rasterPass.setBindGroup(0, rasterGroup);
      rasterPass.draw(3);
      rasterPass.end();
      rasterEncoder.copyTextureToBuffer(
        { texture: color },
        { buffer: fragmentReadback, bytesPerRow: width * 16 },
        [width, height],
      );
      device.queue.submit([rasterEncoder.finish()]);
      await fragmentReadback.mapAsync(GPUMapMode.READ);
      expectSourceSamples(new Float32Array(fragmentReadback.getMappedRange()), count);
      fragmentReadback.unmap();
    } finally {
      fragmentReadback.destroy();
      color.destroy();
    }
  } finally {
    inputs.destroy();
    output.destroy();
    readback.destroy();
    productionTexture.destroy();
    texture.destroy();
    device.destroy();
  }
});

it('default DFG fit is finite, nonnegative and agrees with the independent analytic oracle', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn fit regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const points: number[] = [];
  const expected: number[] = [];
  for (let y = -1; y <= 65; y++) {
    for (let x = -1; x <= 65; x++) {
      const index = points.length / 4;
      const r = x / 64;
      const nv = y / 64;
      const nl = (index % 33) / 32;
      const material = index % dfgTestReflectance.length;
      const f0 = dfgTestReflectance[material];
      if (!f0) throw new Error('Missing test reflectance');
      points.push(r, nv, nl, material);
      const ab = referenceFit(r, nv);
      const ms = referenceFitCompensation(r, nv, nl, f0);
      expected.push(...ab, ms[0] ?? NaN, ms[2] ?? NaN);
    }
  }
  const count = points.length / 4;
  const inputs = device.createBuffer({
    size: points.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: points.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: points.length * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const width = 128;
  const height = Math.ceil(count / width);
  const color = device.createTexture({
    size: [width, height],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const pixels = device.createBuffer({
    size: width * height * 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const assertSamples = (actual: Float32Array): void => {
    for (let index = 0; index < expected.length; index++) {
      const value = actual[index] ?? NaN;
      expect(Number.isFinite(value), `fit sample ${index}`).toBe(true);
      expect(value, `fit sample ${index} nonnegative`).toBeGreaterThanOrEqual(0);
      expect(Math.abs(value - (expected[index] ?? NaN)), `fit sample ${index}`).toBeLessThan(2e-6);
      const sample = Math.floor(index / 4);
      if (sample % dfgTestReflectance.length === 0 && index % 4 >= 2) expect(value).toBe(0);
    }
  };
  try {
    const code = await composeShader(
      `
#import forgeax_pbr::brdf::{sampleDirectDfg, directMultiScatter}
@group(0) @binding(0) var<storage, read> points: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4<f32>>;
const reflectance = array<vec3<f32>, ${dfgTestReflectance.length}>(
  ${dfgTestReflectance.map((value) => `vec3<f32>(${value.join(',')})`).join(',')}
);
fn evaluate(index: u32) -> vec4<f32> {
  let p = points[index];
  let ab = sampleDirectDfg(p.x, p.y, false);
  let ms = directMultiScatter(p.x, p.y, p.z, reflectance[u32(p.w)], false);
  return vec4<f32>(ab, ms.r, ms.b);
}
@compute @workgroup_size(64) fn compute(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&points)) { output[id.x] = evaluate(id.x); }
}
@vertex fn vertex(@builtin(vertex_index) i:u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(f32((i << 1u)&2u)*2.0-1.0, 1.0-f32(i&2u)*2.0, 0.0, 1.0);
}
@fragment fn fragment(@builtin(position) pos:vec4<f32>) -> @location(0) vec4<f32> {
  let index = u32(pos.y)*128u + u32(pos.x);
  if (index >= arrayLength(&points)) { discard; }
  return evaluate(index);
}
`,
      { 'forgeax_pbr::brdf': readFileSync(new URL('../brdf.wgsl', import.meta.url), 'utf8') },
      {},
    );
    expect(code).not.toMatch(/texture_2d|sampler|array\s*<\s*u32\s*,\s*256/);
    const module = device.createShaderModule({ code });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    device.queue.writeBuffer(inputs, 0, new Float32Array(points));
    const compute = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'compute' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(compute);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: compute.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputs } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, points.length * 4);
    const raster = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] },
    });
    const fragment = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    fragment.setPipeline(raster);
    fragment.setBindGroup(
      0,
      device.createBindGroup({
        layout: raster.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: inputs } }],
      }),
    );
    fragment.draw(3);
    fragment.end();
    encoder.copyTextureToBuffer({ texture: color }, { buffer: pixels, bytesPerRow: width * 16 }, [
      width,
      height,
    ]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    assertSamples(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    await pixels.mapAsync(GPUMapMode.READ);
    assertSamples(new Float32Array(pixels.getMappedRange()));
    pixels.unmap();
  } finally {
    inputs.destroy();
    output.destroy();
    readback.destroy();
    pixels.destroy();
    color.destroy();
    device.destroy();
  }
});
