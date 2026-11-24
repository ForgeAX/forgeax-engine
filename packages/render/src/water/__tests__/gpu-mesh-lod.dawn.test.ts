import { expect, it } from 'vitest';
import {
  waterGpuCountWgsl,
  waterGpuMipWgsl,
  waterGpuPrefixWgsl,
  waterGpuScatterWgsl,
  waterGpuTraverseWgsl,
} from '../gpu-mesh-shaders';

it('scatters logical LOD and a common terminal lattice into the shared Water tile ABI', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  expect(adapter).not.toBeNull();
  const device = await requiredFixtureValue(adapter).requestDevice();
  device.pushErrorScope('validation');
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint32Array | Float32Array) => {
    const result = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(result, 0, data);
    owned.push(result);
    return result;
  };
  const params = new Uint32Array((7 + 6) * 4),
    floats = new Float32Array(params.buffer);
  const mipOffsets: number[] = [];
  let nodeCount = 0;
  for (let mip = 0; mip < 6; mip++) {
    const width = 32 >> mip;
    mipOffsets.push(nodeCount);
    params.set([nodeCount, width, width, 0], (7 + mip) * 4);
    nodeCount += width * width;
  }
  const cases = [
    { mip: 0, density: 1, logicalLod: 1, maxMorphLod: 3, heightMorph: 0.75 },
    { mip: 0, density: 0, logicalLod: 0, maxMorphLod: 3, heightMorph: 0 },
    { mip: 2, density: 1, logicalLod: 3, maxMorphLod: 3, heightMorph: 0 },
    { mip: 3, density: 0, logicalLod: 3, maxMorphLod: 3, heightMorph: 0 },
  ];
  params.set([32, 32, nodeCount, 2], 0);
  params.set([cases.length, 1, 2, cases.length], 4);
  floats.set([0, 0, 32, 32], 8);
  floats.set([-1, 1, 1, 0], 12);
  params[19] = 6;
  params.set([16, 4, 0, 0], 20);
  const views = new Float32Array(64);
  views.set([0, 2 + 2 ** 1.75 / 2, 0, 1]);
  views.set([1, 0.75, 0, 0], 60);
  const candidates = new Uint32Array(nodeCount * 8),
    candidateFloats = new Float32Array(candidates.buffer);
  cases.forEach((value, index) => {
    candidates.set(
      [requiredFixtureValue(mipOffsets[value.mip]), index, 1, value.density, 0, 1, 0, 1],
      index * 8,
    );
    candidateFloats[index * 8 + 4] = 0.75;
  });
  const tileWords = cases.length * 64 + cases.length * 24;
  const bodies = new Float32Array(24);
  bodies[23] = 15;
  const inputs = [
    buffer(params),
    buffer(bodies),
    buffer(new Uint32Array(nodeCount * 4)),
    buffer(views),
    buffer(candidates),
    buffer(new Uint32Array(cases.map((_, index) => index))),
    buffer(new Uint32Array(tileWords)),
    buffer(new Uint32Array(cases.length * 5 + 1)),
  ];
  const readback = device.createBuffer({
    size: tileWords * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: waterGpuScatterWgsl() }),
        entryPoint: 'scatter',
      },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: inputs.map((value, binding) => ({ binding, resource: { buffer: value } })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(Math.ceil(nodeCount / 64));
    pass.end();
    encoder.copyBufferToBuffer(requiredFixtureValue(inputs[6]), 0, readback, 0, tileWords * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const tiles = new Uint32Array(readback.getMappedRange());
    cases.forEach((value, index) => {
      const offset = cases.length * 64 + index * 24;
      expect(tiles[offset + 9], `raw mip ${value.mip}, density ${value.density}`).toBe(
        value.logicalLod,
      );
      expect(tiles[offset + 10]).toBe(value.logicalLod + 1);
      expect(tiles[offset + 22]).toBe(value.maxMorphLod);
      expect(tiles[offset + 23]).toBe(15);
      expect((requiredFixtureValue(tiles[offset + 14]) >>> 19) / 8191).toBeCloseTo(
        value.heightMorph,
        3,
      );
    });
    readback.unmap();
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const value of owned) value.destroy();
    readback.destroy();
    device.destroy();
  }
});

it('traverses ten mip descriptors while retaining the finest leaf density limit at high altitude', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  expect(adapter).not.toBeNull();
  const device = await requiredFixtureValue(adapter).requestDevice();
  device.pushErrorScope('validation');
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint32Array | Float32Array) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(value, 0, data);
    owned.push(value);
    return value;
  };
  const params = new Uint32Array((7 + 10) * 4),
    floats = new Float32Array(params.buffer);
  let nodeCount = 0;
  const mipOffsets: number[] = [];
  for (let mip = 0; mip < 10; mip++) {
    const width = 512 >> mip;
    mipOffsets.push(nodeCount);
    params.set([nodeCount, width, width, 0], (7 + mip) * 4);
    nodeCount += width * width;
  }
  params.set([512, 512, nodeCount, 2]);
  const capacity = 128 * 128;
  const tileWords = 64 + capacity * 24;
  params.set([1, 1, 8, capacity], 4);
  floats.set([0, 0, 512, 512], 8);
  floats.set([-1, 1, 1, 0], 12);
  params.set([1, 1, 0xffffffff, 10], 16);
  params.set([8, 3, 0, 0], 20);
  floats.set([17.25, -31.5], 24);
  const nodes = new Uint32Array(nodeCount * 4),
    nodeFloats = new Float32Array(nodes.buffer);
  for (let leaf = 0; leaf < 512 * 512; leaf++) {
    nodes[leaf * 4] = 0xc0000001;
    nodeFloats[leaf * 4 + 1] = -0.25;
    nodeFloats[leaf * 4 + 2] = 0.25;
  }
  const view = new Float32Array(64);
  view.set([256, 2048, 256, 1]);
  const p = buffer(params),
    n = buffer(nodes),
    v = buffer(view),
    b = buffer(new Uint32Array(24));
  const c = buffer(new Uint32Array(nodeCount * 8)),
    counts = buffer(new Uint32Array(1)),
    offsets = buffer(new Uint32Array(1));
  const blocks = buffer(new Uint32Array(1)),
    tiles = buffer(new Uint32Array(tileWords)),
    args = buffer(new Uint32Array(6));
  const readback = device.createBuffer({
    size: 16 + 24 + tileWords * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    const dispatch = async (
      code: string,
      buffers: readonly (readonly [GPUBuffer, boolean])[],
      entryPoint: string,
      workgroups: readonly [number, number?],
    ) => {
      const layout = device.createBindGroupLayout({
        entries: buffers.map(([, read], binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: read ? 'read-only-storage' : 'storage' },
        })),
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: device.createShaderModule({ code }), entryPoint },
      });
      const bindings = device.createBindGroup({
        layout,
        entries: buffers.map(([value], binding) => ({ binding, resource: { buffer: value } })),
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(workgroups[0], workgroups[1] ?? 1);
      pass.end();
    };
    for (let mip = 1; mip < 10; mip++)
      await dispatch(
        waterGpuMipWgsl(mip),
        [
          [p, true],
          [n, false],
        ],
        'mip',
        [Math.ceil((512 >> mip) / 8), Math.ceil((512 >> mip) / 8)],
      );
    const traverse = [
      [p, true],
      [b, true],
      [n, true],
      [v, false],
      [c, false],
    ] as const;
    await dispatch(waterGpuTraverseWgsl(), traverse, 'viewLod', [1]);
    await dispatch(waterGpuTraverseWgsl(), traverse, 'traverse', [Math.ceil(nodeCount / 64)]);
    await dispatch(
      waterGpuCountWgsl(),
      [
        [p, true],
        [c, true],
        [counts, false],
      ],
      'count',
      [Math.ceil(nodeCount / 64)],
    );
    const prefix = [
      [p, true],
      [counts, true],
      [offsets, false],
      [blocks, false],
      [tiles, false],
      [args, false],
    ] as const;
    for (const entry of ['prefixLocal', 'prefixBlocks', 'prefixFinalize'])
      await dispatch(waterGpuPrefixWgsl(), prefix, entry, [1]);
    await dispatch(
      waterGpuScatterWgsl(),
      [
        [p, true],
        [b, true],
        [n, true],
        [v, true],
        [c, true],
        [offsets, true],
        [tiles, false],
        [args, false],
      ],
      'scatter',
      [Math.ceil(nodeCount / 64)],
    );
    encoder.copyBufferToBuffer(n, requiredFixtureValue(mipOffsets[9]) * 16, readback, 0, 16);
    encoder.copyBufferToBuffer(args, 0, readback, 16, 24);
    encoder.copyBufferToBuffer(tiles, 0, readback, 40, tileWords * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(readback.getMappedRange()),
      values = new Float32Array(words.buffer);
    expect(Array.from(words.subarray(0, 1))).toEqual([0xc0000001]);
    expect(Array.from(values.subarray(1, 4))).toEqual([-0.25, 0.25, 0]);
    expect(Array.from(words.subarray(4, 10))).toEqual([384, capacity, 0, 0, 0, 0]);
    const origins = new Set<string>();
    for (let index = 0; index < capacity; index++) {
      const tile = 10 + 64 + index * 24;
      origins.add(`${values[tile]},${values[tile + 1]}`);
      expect(Array.from(values.subarray(tile + 2, tile + 4))).toEqual([4, 4]);
      expect(words[tile + 9]).toBe(2);
      expect(words[tile + 22]).toBe(2);
    }
    expect(origins.size).toBe(capacity);
    expect(origins.has('17.25,-31.5')).toBe(true);
    expect(origins.has('525.25,476.5')).toBe(true);
    readback.unmap();
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const value of owned) value.destroy();
    readback.destroy();
    device.destroy();
  }
}, 30000);

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Required native fixture value is absent');
  return value;
}
