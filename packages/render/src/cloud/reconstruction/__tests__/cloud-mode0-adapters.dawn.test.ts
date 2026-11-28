import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { createCloudMode0BlueNoisePixels } from '../../tracing/blue-noise';

it('compiles the actual Mode 0 adapters and loads FP32 meter textures without float32 filtering', async () => {
  const engine = await loadEngineShaderEntries();
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1')
    expect(adapter.info.isFallbackAdapter).toBe(false);
  const device = await adapter.requestDevice();
  const compiled: string[] = [];
  try {
    for (const stage of ['reconstruct', 'compose']) {
      const shader =
        stage === 'reconstruct' ? engine.cloudMode0Reconstruct : engine.cloudMode0Compose;
      const result = await compileShader(shader.source, {
        id: shader.id,
        imports: engine.imports,
        ...(shader.defines === undefined ? {} : { defines: shader.defines }),
      });
      if (!result.ok) throw result.error;
      const module = device.createShaderModule({ code: result.value.wgsl });
      expect(
        (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
      ).toEqual([]);
      await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets:
            stage === 'reconstruct'
              ? [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba32float' }]
              : [{ format: 'rgba16float' }],
        },
      });
      await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_ue_mode',
          targets:
            stage === 'reconstruct'
              ? [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba16float' }]
              : [{ format: 'rgba16float' }],
        },
      });
      compiled.push(shader.reservedIdentifier ?? shader.id);
    }
    const source =
      '@group(0) @binding(0) var meters:texture_2d<f32>; @group(0) @binding(1) var<storage,read_write> output:array<vec4f>; @compute @workgroup_size(1) fn main(){output[0]=textureLoad(meters,vec2i(0),0);}';
    const module = device.createShaderModule({ code: source });
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' },
    });
    const texture = device.createTexture({
      size: [1, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const output = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      device.queue.writeTexture(
        { texture },
        new Float32Array([5000.125, 10000.25, 5.125, 350000.5]),
        { bytesPerRow: 16 },
        [1, 1],
      );
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: { buffer: output } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = Array.from(new Float32Array(readback.getMappedRange()));
      readback.unmap();
      expect(actual).toEqual([5000.125, 10000.25, 5.125, 350000.5]);
      const path = process.env.FORGEAX_CLOUD_MODE0_EVIDENCE;
      if (path !== undefined)
        await writeFile(
          path,
          JSON.stringify(
            {
              compiled,
              adapter: {
                vendor: adapter.info.vendor,
                architecture: adapter.info.architecture,
                device: adapter.info.device,
                isFallbackAdapter: adapter.info.isFallbackAdapter,
              },
              float32FilterableEnabled: device.features.has('float32-filterable'),
              actual,
            },
            null,
            2,
          ),
        );
    } finally {
      texture.destroy();
      output.destroy();
      readback.destroy();
    }
  } finally {
    device.destroy();
  }
});

it('writes UE kilometer channels and bounds the eight R8 phases at low ray budgets', async () => {
  const { imports } = await loadEngineShaderEntries();
  const kernel = await compileShader(
    `
#import forgeax_cloud::depth_minmax::{cloud_mode0_pack_depth_km, cloud_mode0_noise}
@group(0) @binding(0) var blue: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;
@compute @workgroup_size(1) fn measure() {
  let depth = cloud_mode0_pack_depth_km(3000.0, vec2f(2000.0, 8000.0));
  result[0] = depth.x;
  result[1] = depth.y;
  result[2] = depth.z;
  result[3] = depth.w;
  result[40u] = cloud_mode0_noise(blue, vec2f(32.5, 32.5), -1.0, 96.0);
  for (var phase = 0u; phase < 9u; phase += 1u) {
    let frame = f32(phase + 1u);
    result[4u + phase] = cloud_mode0_noise(blue, vec2f(32.5, 32.5), frame, 96.0);
    result[13u + phase] = cloud_mode0_noise(blue, vec2f(32.5, 32.5), frame, 48.0);
    result[22u + phase] = cloud_mode0_noise(blue, vec2f(32.5, 32.5), frame, 24.0);
    result[31u + phase] = cloud_mode0_noise(blue, vec2f(32.5, 32.5), frame, 192.0);
  }
}
`,
    { id: 'cloud-mode0-ue-contract-witness.wgsl', imports },
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  try {
    const size = { width: 128, height: 8192 };
    const atlas = device.createTexture({
      size,
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const pixels = createCloudMode0BlueNoisePixels();
    device.queue.writeTexture({ texture: atlas }, pixels, { bytesPerRow: 128 }, size);
    const bytes = 41 * 4;
    const output = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: kernel.unwrap().wgsl }),
        entryPoint: 'measure',
      },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: atlas.createView() },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const sampled = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    for (const [index, expected] of [3, 8, 2, 8].entries())
      expect(sampled[index]).toBeCloseTo(expected, 5);
    const phases = Array.from(
      { length: 9 },
      (_, phase) => pixels[(phase & 7) * 128 * 128 + 2 * 128 + 2],
    );
    expect(new Set(phases.slice(0, 8)).size).toBeGreaterThan(4);
    const full = sampled.slice(4, 13);
    expect(full.map((value) => Math.round(value * 255))).toEqual(phases);
    expect(sampled.slice(31, 40)).toEqual(full);
    expect(sampled[40]).toBe(0.5);
    for (const [index, noise] of full.entries()) {
      expect(sampled[index + 13]).toBeCloseTo(0.5 + (noise - 0.5) * 0.125, 7);
      expect(sampled[index + 22]).toBeCloseTo(0.5 + (noise - 0.5) * 0.015625, 7);
    }
  } finally {
    device.destroy();
  }
});
