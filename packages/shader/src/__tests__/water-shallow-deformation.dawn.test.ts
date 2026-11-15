import { readFileSync } from 'node:fs';
import { WATER_DEFORMATION_INPUTS } from '@forgeax/engine-types';
import { expect, it } from 'vitest';

it.each([
  false,
  true,
])('samples actual current/previous displaced vertices with residual-only=%s', async (residualOnly) => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Shallow deformation requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const textures: GPUTexture[] = [];
  const buffers: GPUBuffer[] = [];
  try {
    const compiler = await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    );
    const imports = Object.fromEntries(
      ['water-waves', 'water-deformation-default', 'water-advanced-sampling'].map((name) => {
        const source = readFileSync(new URL(`../${name}.wgsl`, import.meta.url), 'utf8');
        const path = /^#define_import_path\s+(\S+)/m.exec(source)?.[1];
        if (path === undefined) throw new Error(`Missing production module identity: ${name}`);
        return [path, source];
      }),
    );
    imports['forgeax_material::water_deformation_v1'] = `
#define_import_path forgeax_material::water_deformation_v1
struct WaterDeformationInput { ${WATER_DEFORMATION_INPUTS.map((field) => `${field.name}: ${field.type},`).join('\n')} }
struct WaterDeformationOutput {
  currentPositionM:vec3<f32>, previousPositionM:vec3<f32>, currentNormalYUp:vec3<f32>,
  previousNormalYUp:vec3<f32>, waterMask:f32, bodyRenderIndex:u32,
}`;
    imports['forgeax_material::parameters'] = `
#define_import_path forgeax_material::parameters
@group(1) @binding(0) var waterShallowGridTexture:texture_2d<f32>;
@group(1) @binding(1) var waterShallowNormalTexture:texture_2d<f32>;
@group(1) @binding(2) var waterShallowMappingTexture:texture_2d<f32>;
@group(1) @binding(3) var waterShallowFoamTexture:texture_2d<f32>;`;
    const compiled = (
      await compiler.compileShader(
        `
#import forgeax_material::water_deformation_v1::{WaterDeformationInput}
#import forgeax_material::water_deformation_default::{deform_water_vertex}
#import forgeax_material::water_waves::{evaluateWaterWavesForward}
#import forgeax_material::water_advanced_sampling::{shallowUv,shallowPreviousUv,shallowGrid,shallowPreviousGrid,shallowComposeNormal}
@group(0) @binding(0) var<storage,read_write> output:array<vec4<f32>>;
@compute @workgroup_size(1) fn main(){
  var input:WaterDeformationInput;
  input.positionM=vec3<f32>(1.0,3.0,0.0);
  input.previousPositionM=vec3<f32>(0.5,3.0,0.0);
  input.normalYUp=vec3<f32>(0.0,1.0,0.0);
  input.waveRelativeXZ=input.positionM.xz;
  input.timeSeconds=0.3;input.prevTimeSeconds=0.1;
  let deformation=deform_water_vertex(input);
  let currentWave=evaluateWaterWavesForward(0u,input.positionM.xz,88.0,input.timeSeconds);
  let previousWave=evaluateWaterWavesForward(0u,input.previousPositionM.xz,88.0,input.prevTimeSeconds);
  let currentPoint=input.positionM+currentWave.displacement;
  let previousPoint=input.previousPositionM+previousWave.displacement;
  let currentUv=shallowUv(currentPoint.xz);
  let previousUv=shallowPreviousUv(previousPoint.xz);
  let currentResidual=shallowGrid(currentUv).x-${residualOnly ? 10 : 3}.0;
  let previousResidual=shallowPreviousGrid(previousUv).x-${residualOnly ? 20 : 3}.0;
  output[0]=vec4<f32>(deformation.currentPositionM,1.0);
  output[1]=vec4<f32>(deformation.previousPositionM,1.0);
  output[2]=vec4<f32>(currentPoint+vec3<f32>(0.0,currentResidual,0.0),1.0);
  output[3]=vec4<f32>(previousPoint+vec3<f32>(0.0,previousResidual,0.0),1.0);
  output[4]=vec4<f32>(deformation.currentNormalYUp,1.0);
  output[5]=vec4<f32>(deformation.previousNormalYUp,1.0);
  output[6]=vec4<f32>(shallowComposeNormal(currentUv,0,currentResidual,currentWave.normal),1.0);
  output[7]=vec4<f32>(shallowComposeNormal(previousUv,1,previousResidual,previousWave.normal),1.0);
}`,
        {
          imports,
          defines: {
            WATER_SHALLOW_SIMULATION: true,
            WATER_SHALLOW_ADDITIVE: true,
            WATER_ENABLE_WAVES: true,
            WATER_TRANSITION_AVAILABLE: false,
            WATER_HEIGHT_MAPPING_AVAILABLE: false,
            WATER_OCEAN_PATCH: false,
            WATER_USE_FIXED_DEPTH: true,
            WATER_USE_INFO: false,
            WATER_USE_BAKED_SIMULATION: false,
            WATER_DYNAMIC_BOUNDS_CLIP: false,
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
    const makeTexture = (width: number, height: number, values: Float32Array) => {
      const texture = device.createTexture({
        size: [width, height],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      textures.push(texture);
      device.queue.writeTexture({ texture }, values, { bytesPerRow: width * 16 }, [width, height]);
      return texture.createView();
    };
    const grid = new Float32Array(16 * 32 * 4);
    const normal = new Float32Array(grid.length);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 16; x++) {
        const current = y < 16;
        const worldX = x + 0.5 - 8 + (current ? 0 : 0.25);
        const slope = current ? 0.2 : -0.1;
        grid[(y * 16 + x) * 4] =
          (residualOnly ? (current ? 10 : 20) : 3) + slope * worldX + (current ? 0.1 : -0.2);
        const nx = -slope + x * 0.01;
        normal.set([nx, 0, Math.sqrt(1 - nx * nx), 0], (y * 16 + x) * 4);
      }
    const textureResources = [
      makeTexture(16, 32, grid),
      makeTexture(16, 32, normal),
      makeTexture(
        2,
        2,
        new Float32Array([
          0,
          0,
          16,
          16,
          0,
          1,
          Number(residualOnly),
          10,
          0.25,
          0,
          16,
          16,
          0,
          1,
          Number(residualOnly),
          20,
        ]),
      ),
    ];
    const buffer = (data: ArrayBufferView) => {
      const value = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      buffers.push(value);
      device.queue.writeBuffer(value, 0, data.buffer, data.byteOffset, data.byteLength);
      return value;
    };
    const body = new Uint8Array(128);
    new Uint32Array(body.buffer, 0, 4).set([0, 1, 0, 0]);
    new Float32Array(body.buffer, 64, 4).set([1000, 4, 3, 0]);
    new Float32Array(body.buffer, 80, 4).set([3, 88, 0, 0]);
    const bodyBuffer = buffer(body);
    const waves = buffer(new Float32Array([1, 0, 1, 20, 0.4, 0.5, 1, 0.8, 0, 0, 0, 0]));
    const output = device.createBuffer({
      size: 8 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: output.size,
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
        entries: textureResources.map((resource, binding) => ({ binding, resource })),
      }),
    );
    pass.setBindGroup(
      2,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [
          { binding: 16, resource: { buffer: bodyBuffer } },
          { binding: 17, resource: { buffer: waves } },
        ],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    expect(Math.abs(Number(values[0]) - 1)).toBeGreaterThan(0.1);
    for (let row = 0; row < 2; row++)
      for (let axis = 0; axis < 3; axis++)
        expect(values[row * 4 + axis]).toBeCloseTo(Number(values[(row + 2) * 4 + axis]), 5);
    for (let row = 0; row < 2; row++)
      for (let axis = 0; axis < 3; axis++)
        expect(values[(row + 4) * 4 + axis]).toBeCloseTo(Number(values[(row + 6) * 4 + axis]), 5);
    readback.unmap();
  } finally {
    for (const texture of textures) texture.destroy();
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
});
