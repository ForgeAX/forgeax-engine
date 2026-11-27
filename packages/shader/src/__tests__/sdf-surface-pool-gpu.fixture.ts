import type { SurfacePoolCase } from './sdf-surface-pool.fixture';

function buffer(device: GPUDevice, data: Uint32Array, usage: number) {
  const result = device.createBuffer({
    size: Math.max(4, data.byteLength),
    usage: usage | GPUBufferUsage.COPY_DST,
  });
  if (data.length) device.queue.writeBuffer(result, 0, data);
  return result;
}
function texture(device: GPUDevice, row: SurfacePoolCase, first: number) {
  const width = 16,
    height = Math.ceil((first + row.fields.length) / (width * 4)),
    words = new Uint32Array(width * height * 4).fill(0xdeadbeef);
  words.set(row.instances);
  words.set(row.fields, first);
  const result = device.createTexture({
    format: 'rgba32uint',
    size: [width, height],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: result },
    words,
    { bytesPerRow: width * 16, rowsPerImage: height },
    [width, height],
  );
  return result;
}
async function executeCase(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  kind: 'storage' | 'texture',
  row: SurfacePoolCase,
) {
  const owned: GPUBuffer[] = [];
  let sourceTexture: GPUTexture | undefined;
  const make = (data: Uint32Array, usage: number) => {
    const b = buffer(device, data, usage);
    owned.push(b);
    return b;
  };
  try {
    const output = make(new Uint32Array(24), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      read = make(new Uint32Array(24), GPUBufferUsage.MAP_READ),
      first = Math.ceil(row.instances.length / 4) * 4,
      settings = make(
        new Uint32Array([row.fieldCount, row.row, row.instances.length, first]),
        GPUBufferUsage.UNIFORM,
      );
    const entries: GPUBindGroupEntry[] = [
      { binding: 2, resource: { buffer: output } },
      { binding: 3, resource: { buffer: settings } },
    ];
    if (kind === 'storage') {
      entries.push(
        {
          binding: 0,
          resource: {
            buffer: make(row.fields.subarray(0, row.fieldCount), GPUBufferUsage.STORAGE),
          },
        },
        { binding: 1, resource: { buffer: make(row.instances, GPUBufferUsage.STORAGE) } },
      );
    } else {
      sourceTexture = texture(device, row, first);
      entries.push({ binding: 0, resource: sourceTexture.createView() });
    }
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
      encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, 96);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(read.getMappedRange()).slice();
    read.unmap();
    return result;
  } finally {
    sourceTexture?.destroy();
    for (const b of owned) b.destroy();
  }
}
export async function runSurfacePoolCases(
  device: GPUDevice,
  code: string,
  kind: 'storage' | 'texture',
  cases: readonly SurfacePoolCase[],
) {
  const module = device.createShaderModule({ code }),
    pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    }),
    result = new Uint32Array(cases.length * 24);
  for (const [index, row] of cases.entries())
    result.set(await executeCase(device, pipeline, kind, row), index * 24);
  return result;
}
export function assessSurfacePoolCases(cases: readonly SurfacePoolCase[], raw: Uint32Array) {
  if (raw.length !== cases.length * 24) throw Error('Pool decoder readback record count differs');
  return cases.flatMap((row, index) => {
    const actual = Array.from(raw.subarray(index * 24, index * 24 + 24)),
      differences = actual.flatMap((word, at) => (word === row.expected[at] ? [] : [at]));
    return differences.length
      ? [{ name: row.name, differences, actual, expected: row.expected }]
      : [];
  });
}
