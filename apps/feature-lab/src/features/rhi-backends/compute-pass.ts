import { CheckList, defineFeature } from '../../lab/feature';
import { readBack, shader, webgpuDevice } from './support/gpu';

const CODE = `
@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(4)
fn cs_main(@builtin(global_invocation_id) id: vec3<u32>) {
  values[id.x] = id.x * id.x + 1u;
}`;

export default defineFeature({
  title: 'Compute pass',
  catalog: 'Compute pass',
  kind: 'probe',
  summary:
    'A compute pipeline with a storage-buffer bind group is dispatched through the RHI and its output is read back from the GPU.',
  expect:
    'All checks pass: caps.compute is true on the lab renderer, and dispatching 2 workgroups of 4 writes i*i+1 for i in 0..7, confirmed by GPU readback.',
  setup({ app }) {
    return {
      async checks() {
        const checks = new CheckList();
        checks.equal(
          'lab renderer caps.compute',
          app.renderer.inspect().capabilities.compute,
          true,
        );
        const gpu = await webgpuDevice(checks);
        if (gpu === undefined) return checks.items;
        const { device } = gpu;
        const module = await shader(checks, device, CODE);
        if (module === undefined) return checks.items;
        const layout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          ],
        });
        if (!layout.ok)
          return checks.ok('createBindGroupLayout ok', false, layout.error.code).items;
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
        if (!pipelineLayout.ok)
          return checks.ok('createPipelineLayout ok', false, pipelineLayout.error.code).items;
        const pipeline = device.createComputePipeline({
          layout: pipelineLayout.value,
          compute: { module, entryPoint: 'cs_main' },
        });
        checks.ok('createComputePipeline ok', pipeline.ok);
        if (!pipeline.ok) return checks.items;
        const values = device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const readback = device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        if (!values.ok || !readback.ok) return checks.ok('buffers created', false).items;
        const bindings = device.createBindGroup({
          layout: layout.value,
          entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: values.value } } }],
        });
        if (!bindings.ok) return checks.ok('createBindGroup ok', false, bindings.error.code).items;
        const encoder = device.createCommandEncoder({ label: 'lab-compute' });
        if (!encoder.ok) return checks.ok('createCommandEncoder ok', false).items;
        const pass = encoder.value.beginComputePass({ label: 'lab-compute-pass' });
        pass.setPipeline(pipeline.value);
        pass.setBindGroup(0, bindings.value);
        pass.dispatchWorkgroups(2);
        pass.end();
        encoder.value.copyBufferToBuffer(values.value, 0, readback.value, 0, 32);
        const finished = encoder.value.finish();
        if (!finished.ok) return checks.ok('finish ok', false, finished.error.code).items;
        checks.ok('queue.submit ok', device.queue.submit([finished.value]).ok);
        const bytes = await readBack(device, readback.value, 32);
        checks.equal(
          'dispatch output',
          typeof bytes === 'string' ? bytes : Array.from(new Uint32Array(bytes)),
          [1, 2, 5, 10, 17, 26, 37, 50],
        );
        return checks.items;
      },
    };
  },
});
