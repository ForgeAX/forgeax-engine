import type { SceneTextureCase } from './sdf-scene-texture.fixture';

/** One real invocation per separately bound source snapshot. No CPU decoder. */
export async function runSceneTextureReader(
  device: GPUDevice,
  code: string,
  rows: readonly SceneTextureCase[],
) {
  const owned: (GPUBuffer | GPUTexture)[] = [];
  const makeBuffer = (size: number, usage: number) => {
    const value = device.createBuffer({ size, usage });
    owned.push(value);
    return value;
  };
  const bytes = rows.length * 96;
  const output = makeBuffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const staging = makeBuffer(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  try {
    const module = device.createShaderModule({ code });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (const [index, row] of rows.entries()) {
      const texture = device.createTexture({
        size: [row.width, row.height],
        format: 'rgba32uint',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      owned.push(texture);
      device.queue.writeTexture(
        { texture },
        row.words,
        { bytesPerRow: row.width * 16, rowsPerImage: row.height },
        [row.width, row.height],
      );
      const settings = makeBuffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const data = new Uint32Array(8);
      data.set(row.source);
      data.set([index, row.row], 4);
      device.queue.writeBuffer(settings, 0, data);
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: { buffer: settings } },
          { binding: 2, resource: { buffer: output } },
        ],
      });
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
    }
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(staging.getMappedRange()).slice();
    staging.unmap();
    return result;
  } finally {
    for (const resource of owned) resource.destroy();
  }
}
export function assessSceneTextureReader(
  rows: readonly SceneTextureCase[],
  raw: Uint32Array,
  expected: Uint32Array,
) {
  if (raw.length !== expected.length) throw Error('Exact reader output record count required');
  return rows.flatMap((row, index) => {
    const actual = Array.from(raw.subarray(index * 24, index * 24 + 24));
    const wanted = Array.from(expected.subarray(index * 24, index * 24 + 24));
    const differences = actual.flatMap((word, at) => (word === wanted[at] ? [] : [at]));
    return differences.length ? [{ name: row.name, differences, actual, expected: wanted }] : [];
  });
}
