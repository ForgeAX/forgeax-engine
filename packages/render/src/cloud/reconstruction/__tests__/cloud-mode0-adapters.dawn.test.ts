import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';

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
