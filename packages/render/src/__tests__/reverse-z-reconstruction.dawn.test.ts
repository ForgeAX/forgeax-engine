import { readFileSync } from 'node:fs';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';

it('reconstructs distant positions through the production SSR shader', async () => {
  const { compileShader } = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const shader = (name: string) => readFileSync(`packages/shader/src/${name}.wgsl`, 'utf8');
  const distances = [10, 100000, 1000000];
  const near = 0.1,
    far = 1e8;
  const calls = distances
    .map((distance, i) => {
      const depth = (near / distance - near / far) / (1 - near / far);
      return `result[${i}] = vec4<f32>(reconstructWorldPosition(vec2<f32>(0.5), ${depth}), 1.0);`;
    })
    .join('\n');
  const compiled = await compileShader(
    `${shader('ssr-trace')}
@group(1) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe() { ${calls} }
`,
    {
      id: 'forgeax_ssr::reverse-z-reconstruction',
      imports: {
        'forgeax_view::common': shader('common'),
        'forgeax_pbr::gbuffer': shader('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': shader('depth-pyramid-sample'),
      },
    },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.value.wgsl }),
        entryPoint: 'probe',
      },
    });
    const view = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 0x48 });
    const inverse = mat4.invert(
      mat4.create(),
      mat4.perspectiveReverseZ(mat4.create(), Math.PI / 2, 1, near, far),
    );
    const data = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    data.set(inverse, 44);
    device.queue.writeBuffer(view, 0, data);
    const result = device.createBuffer({ size: distances.length * 16, usage: 0x84 });
    const readback = device.createBuffer({ size: distances.length * 16, usage: 0x9 });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 5, resource: { buffer: view } }],
      }),
    );
    pass.setBindGroup(
      1,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: result } }],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(result, 0, readback, 0, distances.length * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    distances.forEach((distance, i) => {
      expect(values[i * 4]).toBe(0);
      expect(values[i * 4 + 1]).toBe(0);
      expect(Math.abs((values[i * 4 + 2] ?? 0) + distance) / distance).toBeLessThan(1e-5);
    });
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    device.destroy();
  }
});
