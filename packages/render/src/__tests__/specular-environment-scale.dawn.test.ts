import { expect, it } from 'vitest';
import { deferredShaderImports } from '../../../shader/src/__tests__/deferred-shader.fixture';
import { compileShader } from '../../../shader-compiler/src/compile';

it('samples one selected PMREM with fallback tint or local capture intensity', async () => {
  const shader = await compileShader(
    `
#import forgeax_pbr::standard_lighting::{SkylightUniforms, sampleStandardReflectionRadiance}
@group(0) @binding(101) var<storage, read> cases: array<vec4<f32>, 8>;
@group(0) @binding(102) var<storage, read_write> output: array<vec4<f32>, 4>;
@group(0) @binding(103) var prefilter: texture_2d<f32>;
@group(0) @binding(104) var linearSampler: sampler;
@compute @workgroup_size(4) fn probe_scale(@builtin(global_invocation_id) id: vec3<u32>) {
  let input = cases[id.x * 2u];
  let sky = SkylightUniforms(input.w, input.x, input.y, input.z,
    vec4<f32>(0.0, 0.0, 0.0, 1.0), vec4<f32>(0.0), vec4<f32>(0.0),
    vec4<f32>(0.0), vec4<f32>(0.0));
  let radiance = sampleStandardReflectionRadiance(sky, vec3<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0),
    0.4, prefilter, linearSampler);
  output[id.x] = vec4<f32>(radiance, radiance.x * cases[id.x * 2u + 1u].x);
}
`,
    { id: 'forgeax::specular-environment-scale-test', imports: deferredShaderImports },
  );
  if (!shader.ok) throw new Error(JSON.stringify(shader.error));
  const viewBytes = shader.value.reflection.boundGlobals.find(
    ({ group, binding }) => group === 0 && binding === 0,
  )?.span;
  if (viewBytes === undefined) throw new Error('Missing Standard View uniform');
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Reflection radiance test requires a GPU adapter');
  const device = await adapter.requestDevice();
  try {
    const view = device.createBuffer({ size: viewBytes, usage: GPUBufferUsage.UNIFORM });
    const cases = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const output = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const prefilter = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: prefilter },
      Uint8Array.of(255, 255, 255, 255),
      { bytesPerRow: 4 },
      [1, 1],
    );
    device.queue.writeBuffer(
      cases,
      0,
      new Float32Array([
        0.25, 0.5, 0.75, 1.5, 0.35, 0, 0, 0, 0.2, 0.4, 0.8, 0.25, 0.8, 0, 0, 0, 3, -2, 7, -1.4, 0.6,
        0, 0, 0, 8, 9, 10, -1, 0.25, 0, 0, 0,
      ]),
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: shader.value.wgsl }),
        entryPoint: 'probe_scale',
      },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: view } },
        { binding: 101, resource: { buffer: cases } },
        { binding: 102, resource: { buffer: output } },
        { binding: 103, resource: prefilter.createView() },
        {
          binding: 104,
          resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
        },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 64);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    const expected = [
      0.375, 0.75, 1.125, 0.13125, 0.05, 0.1, 0.2, 0.04, 0.4, 0.4, 0.4, 0.24, 0, 0, 0, 0,
    ];
    for (const [index, value] of expected.entries()) {
      expect(values[index], `specular radiance lane ${index}`).toBeCloseTo(value, 5);
    }
    readback.unmap();
  } finally {
    device.destroy();
  }
});
