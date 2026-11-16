import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it.each([
  false,
  true,
])('samples shallow normals and foam continuously without crossing frame-atlas rows (additive=%s)', async (additive) => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Shallow sampling requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const textures: GPUTexture[] = [];
  const buffers: GPUBuffer[] = [];
  try {
    const compiler = await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    );
    const compiled = (
      await compiler.compileShader(
        `
#import forgeax_material::water_advanced_sampling::{shallowComposeNormal, shallowSurfaceNormal, shallowPreviousSurfaceNormal, shallowFoam}
@group(0) @binding(0) var<storage, read_write> output: array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>) {
  let uv=vec2<f32>(0.5+(f32(id.x)-0.5)*0.0002,0.5);
  output[id.x]=vec4<f32>(shallowComposeNormal(uv,0,0.0,vec3<f32>(0.0,1.0,0.0)),shallowFoam(uv));
  output[id.x+2u]=vec4<f32>(shallowPreviousSurfaceNormal(uv),1.0);
  output[id.x+4u]=vec4<f32>(shallowSurfaceNormal(vec2<f32>(uv.x,1.0)),1.0);
}`,
        {
          imports: {
            'forgeax_material::water_advanced_sampling': readFileSync(
              new URL('../water-advanced-sampling.wgsl', import.meta.url),
              'utf8',
            ),
            'forgeax_material::parameters': `
#define_import_path forgeax_material::parameters
@group(1) @binding(0) var waterShallowGridTexture: texture_2d<f32>;
@group(1) @binding(1) var waterShallowNormalTexture: texture_2d<f32>;
@group(1) @binding(2) var waterShallowFoamTexture: texture_2d<f32>;
@group(1) @binding(3) var waterShallowMappingTexture: texture_2d<f32>;`,
          },
          defines: {
            WATER_SHALLOW_SIMULATION: true,
            WATER_SHALLOW_ADDITIVE: additive,
            WATER_OCEAN_PATCH: false,
          },
        },
      )
    ).unwrap();
    const module = device.createShaderModule({ code: compiled.wgsl });
    expect(
      (await module.getCompilationInfo()).messages.filter((row) => row.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const texture = (height: number, values: number[]) => {
      const result = device.createTexture({
        size: [2, height],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      textures.push(result);
      device.queue.writeTexture(
        { texture: result },
        new Float32Array(values),
        { bytesPerRow: 32 },
        [2, height],
      );
      return result.createView();
    };
    const grid = texture(4, new Array<number>(32).fill(0));
    const normal = texture(
      4,
      [
        0, 0, 1, 0, 0.6, 0, 0.8, 0, 0, 0, 1, 0, 0.6, 0, 0.8, 0, 0, 0.6, 0.8, 0, 0, 0.6, 0.8, 0, 0,
        0.6, 0.8, 0, 0, 0.6, 0.8, 0,
      ],
    );
    const foam = texture(2, [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    const mapping = texture(2, [0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0]);
    const output = device.createBuffer({
      size: 6 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 6 * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    buffers.push(output, readback);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: output } }],
      }),
    );
    pass.setBindGroup(
      1,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: grid },
          { binding: 1, resource: normal },
          { binding: 2, resource: foam },
          { binding: 3, resource: mapping },
        ],
      }),
    );
    pass.dispatchWorkgroups(2);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 6 * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange());
    expect(
      Math.abs(requiredFixtureValue(result[0]) - requiredFixtureValue(result[4])),
    ).toBeLessThan(0.001);
    expect(result[3]).toBeCloseTo(0.5, 3);
    expect(result[7]).toBeCloseTo(0.5, 3);
    expect(result[8]).toBeCloseTo(0, 5);
    expect(result[9]).toBeCloseTo(0.8, 5);
    expect(result[10]).toBeCloseTo(0.6, 5);
    expect(result[18]).toBeCloseTo(0, 5);
    readback.unmap();
  } finally {
    for (const texture of textures) texture.destroy();
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
});

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Required native fixture value is absent');
  return value;
}
