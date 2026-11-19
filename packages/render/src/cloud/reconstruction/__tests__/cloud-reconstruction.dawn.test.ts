import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('executes Mode 0 depth rejection, exposure transport and unique composition on the actual GPU', async () => {
  const root = new URL('../../../../../shader/src/cloud/', import.meta.url);
  const modules = await Promise.all(
    ['reconstruct.wgsl', 'compose.wgsl'].map(async (name) =>
      (await readFile(new URL(name, root), 'utf8'))
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n'),
    ),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1')
    expect(adapter.info.isFallbackAdapter).toBe(false);
  const device = await adapter.requestDevice();
  const output = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({
      code: `${modules.join('\n')}
@group(0) @binding(0) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn main() {
  let current = CloudReconstructionSample(vec4f(1.0,2.0,3.0,0.8), vec4f(0.2,0.3,0.4,0.9),vec4f(5000.0,10000.0,10000.0,10000.0));
  let history = CloudReconstructionSample(vec4f(4.0,6.0,8.0,0.7), vec4f(1.0,1.0,1.0,0.9), current.depthMeters);
  result[0] = cloud_reconstruct_sample(current,history,vec2u(1u,0u),vec2u(0u),vec2f(0.5),true,2.0,1.0,1000.0,100000.0).far;
  let occluded = CloudReconstructionSample(history.far,history.near,vec4f(5000.0,13000.0,10000.0,10000.0));
  result[1] = cloud_reconstruct_sample(current,occluded,vec2u(1u,0u),vec2u(0u),vec2f(0.5),true,2.0,1.0,1000.0,100000.0).far;
  result[2] = vec4f(cloud_compose_transport(vec3f(2.0,4.0,6.0),vec4f(1.5,2.0,2.5,0.5)),1.0);
  let identity = mat4x4f(vec4f(1.0,0.0,0.0,0.0),vec4f(0.0,1.0,0.0,0.0),vec4f(0.0,0.0,1.0,0.0),vec4f(0.0,0.0,0.0,1.0));
  result[3] = vec4f(cloud_history_uv(vec3f(0.5,0.5,0.0),identity),0.0,1.0);
  let crossing = CloudReconstructionSample(vec4f(1.0,1.0,1.0,0.5),vec4f(0.25,0.25,0.25,0.9),vec4f(80.0,100.0,50.0,100.0));
  let four = array<CloudReconstructionSample,4>(crossing,crossing,crossing,crossing);
  result[4] = cloud_bilateral_upsample(four,50.0,vec4f(0.25),5000.0);
  result[5] = cloud_bilateral_upsample(four,10.0,vec4f(0.25),5000.0);
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 96);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = Array.from(new Float32Array(readback.getMappedRange()));
    const expected = [
      8, 12, 16, 0.7, 1, 2, 3, 0.8, 2.5, 4, 5.5, 1, 0.75, 0.25, 0, 1, 0.25, 0.25, 0.25, 0.9, 0, 0,
      0, 1,
    ];
    for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i] ?? 0, 5);
    readback.unmap();
    const evidence = process.env.FORGEAX_CLOUD_RECONSTRUCTION_EVIDENCE;
    if (evidence !== undefined) {
      await writeFile(
        evidence,
        JSON.stringify(
          {
            adapter: {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              device: adapter.info.device,
              description: adapter.info.description,
              isFallbackAdapter: adapter.info.isFallbackAdapter,
            },
            actual,
            expected,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
