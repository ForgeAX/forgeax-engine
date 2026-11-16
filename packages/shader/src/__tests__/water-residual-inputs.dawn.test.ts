import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('preserves Terrain depth and Body flow for residual fields while full shallow fields replace both', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Residual Water input acceptance requires a native GPU');
  const device = await adapter.requestDevice();
  const surface = readFileSync(new URL('../water-surface.wgsl', import.meta.url), 'utf8');
  const start = surface.indexOf('  let advancedUv = shallowUv(input.positionWS.xz);');
  const end = surface.indexOf('\n#endif', start);
  if (start < 0 || end < 0) throw new Error('Missing production shallow depth/flow consumer');
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const compiled = (
    await compiler.compileShader(
      `
#import forgeax_material::water_advanced_sampling::{shallowUv, shallowInside, shallowGrid, shallowDepthFlowAvailable, shallowCompositionWeight, shallowRotate}
#import forgeax_material::parameters::{waterShallowMappingTexture}
struct Input { positionWS:vec3<f32> }
@group(0) @binding(0) var<storage, read_write> output:array<vec4<f32>>;
@compute @workgroup_size(1) fn main(){
  let input=Input(vec3<f32>(0.0));var depthM=7.0;var flowMPerSec=vec2<f32>(2.0,-3.0);
${surface.slice(start, end)}
  output[0]=vec4<f32>(depthM,flowMPerSec,1.0);
}`,
      {
        imports: {
          'forgeax_material::water_advanced_sampling': readFileSync(
            new URL('../water-advanced-sampling.wgsl', import.meta.url),
            'utf8',
          ),
          'forgeax_material::parameters': `#define_import_path forgeax_material::parameters
@group(1) @binding(0) var waterShallowGridTexture:texture_2d<f32>;
@group(1) @binding(1) var waterShallowNormalTexture:texture_2d<f32>;
@group(1) @binding(2) var waterShallowFoamTexture:texture_2d<f32>;
@group(1) @binding(3) var waterShallowMappingTexture:texture_2d<f32>;`,
        },
        defines: {
          WATER_SHALLOW_SIMULATION: true,
          WATER_SHALLOW_ADDITIVE: true,
          WATER_OCEAN_PATCH: false,
        },
      },
    )
  ).unwrap();
  const grid = device.createTexture({
    size: [8, 16],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const mapping = device.createTexture({
    size: [2, 2],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const values = new Float32Array(8 * 16 * 4);
    for (let index = 0; index < values.length; index += 4) values.set([1.7, 123, 44, 55], index);
    device.queue.writeTexture({ texture: grid }, values, { bytesPerRow: 8 * 16 }, [8, 16]);
    const module = device.createShaderModule({ code: compiled.wgsl });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group0 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const group1 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: grid.createView() },
        { binding: 3, resource: mapping.createView() },
      ],
    });
    for (const residualOnly of [false, true]) {
      device.queue.writeTexture(
        { texture: mapping },
        new Float32Array([
          0,
          0,
          8,
          8,
          0,
          1,
          Number(residualOnly),
          0,
          0,
          0,
          8,
          8,
          0,
          1,
          Number(residualOnly),
          0,
        ]),
        { bytesPerRow: 32 },
        [2, 2],
      );
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = Array.from(new Float32Array(readback.getMappedRange()));
      readback.unmap();
      expect(actual).toEqual(residualOnly ? [7, 2, -3, 1] : [123, 44, 55, 1]);
    }
  } finally {
    grid.destroy();
    mapping.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
