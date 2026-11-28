import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('marches furthest mip one and retires mirror and glossy SSR at different roughnesses', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('SSR trace requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const pyramid = device.createTexture({
    size: [8, 8],
    mipLevelCount: 4,
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const view = device.createBuffer({
    size: 1408,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const shader = (name: string) =>
    readFileSync(new URL(`../${name}.wgsl`, import.meta.url), 'utf8').replace(/^#.*$/gm, '');
  const common = shader('common');
  // The function and View layout are the production declarations. The
  // fixture uses distinct depth bounds in each mip to falsify a mip-0 walk.
  const viewType = common.slice(
    common.indexOf('struct AtmosphereMedium'),
    common.indexOf('// Direct Mesh draws'),
  );
  const module = device.createShaderModule({
    code: `${viewType}
${shader('depth-pyramid-sample')}
${shader('ssr-ray')}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var depth: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1) fn probe() {
  let hit = traceSsrRay(depth, view, vec2u(16u), vec3f(-0.55, 0.0, 1.5),
    vec3f(0.8, 0.0, 0.6), 0.0, 16u);
  output[0] = vec4f(hit.uv, hit.depth, f32(hit.found));
  output[1] = vec4f(
    screenSpaceReflectionRoughnessFade(0.15, 0.6, false),
    screenSpaceReflectionRoughnessFade(0.225, 0.6, false),
    screenSpaceReflectionRoughnessFade(0.30, 0.6, false),
    screenSpaceReflectionRoughnessFade(0.30, 0.6, true));
  let n = vec3f(0.0, 0.0, 1.0);
  output[2] = vec4f(ssrReflectionDirection(n, n, 0.45, vec2u(11u, 17u), 0u, 0u), ssrCrossingFraction(-0.3, -0.1));
  output[3] = vec4f(ssrReflectionDirection(n, n, 0.45, vec2u(11u, 17u), 1u, 0u), 0.0);
  output[4] = vec4f(ssrReflectionDirection(n, n, 0.45, vec2u(11u, 17u), 2u, 0u), 0.0);
}`,
  });
  try {
    expect(
      (await module.getCompilationInfo()).messages.filter(({ type }) => type === 'error'),
    ).toEqual([]);
    const near = 0.5;
    const far = 10;
    const viewData = new Float32Array(352);
    viewData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1 / (far - near), 0, 0, 0, far / (far - near), 1]);
    viewData.set([near, far, 1, 0, 0, 0, 0, 0, 4, 0.1, 0.6, 1], 228);
    device.queue.writeBuffer(view, 0, viewData);
    for (let level = 0; level < 4; level++) {
      const size = 8 >> level;
      const bound = new Float32Array(size * size).fill(level === 1 ? 2 : 4);
      device.queue.writeTexture(
        { texture: pyramid, mipLevel: level },
        bound,
        { bytesPerRow: size * 4, rowsPerImage: size },
        [size, size],
      );
    }
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'probe' },
    });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: view } },
        { binding: 1, resource: pyramid.createView() },
        { binding: 2, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 80);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = [...new Float32Array(readback.getMappedRange())];
    readback.unmap();
    expect(values[3]).toBe(1);
    expect(values[0]).toBeCloseTo((-0.55 + (2 - 1.5) * (0.8 / 0.6)) * 0.5 + 0.5, 5);
    expect(values[2]).toBeCloseTo((far - 2) / (far - near), 5);
    for (const [i, weight] of [1, 0.5, 0, 1].entries()) {
      expect(values[i + 4]).toBeCloseTo(weight, 5);
    }
    expect(values.slice(8, 12)).toEqual([0, 0, 1, 1]);
    expect(values.slice(12, 15)).not.toEqual(values.slice(16, 19));
    expect(Math.hypot(...values.slice(12, 15))).toBeCloseTo(1, 6);
    expect(Math.hypot(...values.slice(16, 19))).toBeCloseTo(1, 6);
  } finally {
    device.destroy();
  }
});
