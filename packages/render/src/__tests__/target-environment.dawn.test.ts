import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { setIblComposedShaders } from '../ibl/IblPipelineCache';
import { filterTargetEnvironment, resolveTargetEnvironment } from '../targets/environment';
import { createRenderTargetPhysical, destroyRenderTargetPhysical } from '../targets/physical';

it('filters a completed HDR cube on the GPU and publishes retained native lighting views', {
  timeout: 30000,
}, async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = (name: string) =>
    readFileSync(resolve(`packages/shader/src/${name}.wgsl`), 'utf8');
  const imports = {
    'forgeax_pbr::ibl_shared': source('ibl-shared'),
    'forgeax_pbr::pmrem': source('ibl-pmrem'),
    'forgeax_pbr::brdf': source('brdf'),
  };
  const shaders: Record<string, string> = {};
  for (const [name, file] of [
    ['equirectToCube', 'ibl-equirect-to-cube'],
    ['irradiance', 'ibl-irradiance'],
    ['prefilter', 'ibl-prefilter'],
    ['brdfLut', 'ibl-brdf-lut'],
  ]) {
    const compiled = await compiler.compileShader(source(file as string), {
      id: `forgeax::target-${file}`,
      imports,
    });
    if (!compiled.ok) throw compiled.error;
    shaders[name as string] = compiled.value.wgsl;
  }
  setIblComposedShaders(shaders as unknown as Parameters<typeof setIblComposedShaders>[0]);
  const recorder = attachRecorder(backend).unwrap();
  const device = (
    await (
      await recorder.backend.rhi.requestAdapter()
    )
      .unwrap()
      .requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  const physical = createRenderTargetPhysical(
    device,
    {
      shape: 'cube',
      width: 8,
      height: 8,
      format: 'rgba16float',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    },
    0,
  );
  if (!physical.ok) throw physical.error;
  const scope = DeviceScope.create(0, 'target-environment-dawn');
  const tape = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  try {
    const clear = device.createCommandEncoder().unwrap();
    for (const view of physical.value.layerViews) {
      const pass = clear.beginRenderPass({
        colorAttachments: [
          { view, clearValue: { r: 2, g: 0.5, b: 0.125, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.end();
    }
    device.queue.submit([clear.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const filtered = await filterTargetEnvironment({
      physical: physical.value,
      scope,
      factory: async (owner, descriptor) => {
        const create = recorder.backend.createShaderModuleImmediate;
        if (create === undefined) throw new Error('missing recorder shader factory');
        return create(owner, descriptor);
      },
      current: () => true,
    });
    if (!filtered.ok) throw new Error(JSON.stringify(filtered.error), { cause: filtered.error });
    const views = resolveTargetEnvironment(filtered.value.source, device);
    if (views === undefined) throw new Error('missing completed environment views');
    const createModule = recorder.backend.createShaderModuleImmediate;
    if (createModule === undefined) throw new Error('missing recorder shader factory');
    const module = createModule(device, {
      code: `
@group(0) @binding(0) var irradiance: texture_cube<f32>;
@group(0) @binding(1) var radianceSampler: sampler;
@group(0) @binding(2) var<storage, read_write> values: array<vec4<f32>>;
@compute @workgroup_size(1) fn main() { values[0] = textureSampleLevel(irradiance, radianceSampler, vec3<f32>(0.0, 0.0, 1.0), 0.0); }
`,
    }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: 'cube' } },
          { binding: 1, visibility: 4, sampler: { type: 'filtering' } },
          { binding: 2, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
    const pipeline = device
      .createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: 'main' } })
      .unwrap();
    const output = device.createBuffer({ size: 16, usage: 0x80 | 0x04 }).unwrap(),
      readback = device.createBuffer({ size: 16, usage: 0x08 | 0x01 }).unwrap();
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: views.irradiance } },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    [2, 0.5, 0.125].forEach((expected, index) => {
      expect(values[index]).toBeCloseTo(expected, 1);
    });
    filtered.value.release();
    expect(resolveTargetEnvironment(filtered.value.source, device)).toBeUndefined();
    device.destroyBuffer(output);
    device.destroyBuffer(readback);
    const directory = resolve(
      process.env.FORGEAX_PARITY_EVIDENCE_DIR ?? 'artifacts/three-target-environment',
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, 'irradiance.json'),
      JSON.stringify({
        values: Array.from(values),
        expected: [2, 0.5, 0.125],
        transport: 'gpu-to-gpu',
      }),
    );
  } finally {
    (await recorder.frameBoundary()).unwrap();
    const capture = await tape;
    const directory = resolve(
      process.env.FORGEAX_PARITY_EVIDENCE_DIR ?? 'artifacts/three-target-environment',
    );
    mkdirSync(directory, { recursive: true });
    if (capture.ok) writeFileSync(resolve(directory, 'filter.rhitape'), capture.value.bytes);
    scope.dispose();
    destroyRenderTargetPhysical(physical.value);
    await recorder.dispose();
  }
});
