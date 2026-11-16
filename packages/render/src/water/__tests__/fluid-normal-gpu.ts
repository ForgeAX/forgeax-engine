import { type WaterFluidStage, waterFluidShader } from '../fluid-shaders';

async function rasterProbe(
  stage: WaterFluidStage,
  size: number,
  fields: readonly Float32Array[],
  values: Float32Array,
  pixels: readonly (readonly [number, number])[],
  repeat: boolean,
  forceInputs = new Float32Array(4),
): Promise<readonly (readonly number[])[]> {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('WebGPU adapter unavailable for Water fluid probe');
  const device = await adapter.requestDevice();
  const sources = fields.map((field) => ({
    field,
    texture: device.createTexture({
      size: [size, size],
      format: stage === 'forces' ? 'rgba8unorm' : 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }),
  }));
  const target = device.createTexture({
    size: [size, size],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const parameters = device.createBuffer({
    size: 320,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const forces = device.createBuffer({
    size: Math.max(16, forceInputs.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: pixels.length * 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    device.pushErrorScope('validation');
    sources.forEach(({ texture, field }) => {
      const data =
        stage === 'forces' ? Uint8Array.from(field, (value) => Math.round(value * 255)) : field;
      device.queue.writeTexture(
        { texture },
        data,
        { bytesPerRow: size * (stage === 'forces' ? 4 : 16) },
        [size, size],
      );
    });
    device.queue.writeBuffer(parameters, 0, values);
    device.queue.writeBuffer(forces, 0, forceInputs);
    const module = device.createShaderModule({
      code: waterFluidShader(
        stage,
        sources.length,
        sources.map(() => true),
        false,
        sources.map(() => repeat),
      ),
    });
    const bindings = device.createBindGroupLayout({
      entries: [
        ...sources.map((_, binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: stage === 'forces' ? ('float' as const) : ('unfilterable-float' as const),
          },
        })),
        {
          binding: sources.length,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: sources.length + 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        ...(stage === 'forces'
          ? [
              {
                binding: sources.length + 2,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' as const },
              },
            ]
          : []),
      ],
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindings] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
      primitive: { topology: 'triangle-list' },
    });
    const group = device.createBindGroup({
      layout: bindings,
      entries: [
        ...sources.map(({ texture }, binding) => ({ binding, resource: texture.createView() })),
        { binding: sources.length, resource: { buffer: parameters } },
        { binding: sources.length + 1, resource: { buffer: forces } },
        ...(stage === 'forces'
          ? [
              {
                binding: sources.length + 2,
                resource: device.createSampler({
                  magFilter: 'linear',
                  minFilter: 'linear',
                  mipmapFilter: 'linear',
                  addressModeU: 'repeat',
                  addressModeV: 'repeat',
                }),
              },
            ]
          : []),
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    pixels.forEach((pixel, index) => {
      encoder.copyTextureToBuffer(
        { texture: target, origin: pixel },
        { buffer: readback, offset: index * 256, bytesPerRow: 256 },
        [1, 1],
      );
    });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = readback.getMappedRange();
    const result = pixels.map((_, index) =>
      Array.from(new Float32Array(mapped.slice(index * 256, index * 256 + 16))),
    );
    readback.unmap();
    const error = await device.popErrorScope();
    if (error !== null) throw error;
    return result;
  } finally {
    for (const { texture } of sources) texture.destroy();
    target.destroy();
    parameters.destroy();
    forces.destroy();
    readback.destroy();
    device.destroy();
  }
}

/** Exercises the selected Ripple material kernel with independently varied R/G fields. */
export async function runFluidRippleNormalProbe(): Promise<readonly number[]> {
  const size = 32;
  const heights = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      heights.set([x * 0.01 + y * 0.02, x * 40, 0, 1], (y * size + x) * 4);
  const values = new Float32Array(80);
  values.set([size, size, 1 / 60, 0]);
  values.set([0, 0, 24, 24], 4);
  values[22] = 1;
  values.set([0, 0.01, 16, 0.2], 72);
  const [pixel] = await rasterProbe('normal-height', size, [heights], values, [[16, 16]], true);
  if (pixel === undefined) throw new Error('Expected the requested fluid normal readback pixel');
  return pixel;
}

export async function runFluidAddressProbe(
  stage: 'ripple' | 'advect-height' | 'normal-height',
  repeat: boolean,
): Promise<readonly (readonly number[])[]> {
  const size = 4;
  const heights = new Float32Array(size * size * 4);
  const previous = new Float32Array(size * size * 4);
  const neutral = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      heights.set([x + 1, 0, 0, 1], at);
      previous.set([(x + 1) * 10, 0, 0, 1], at);
      neutral.set([0, 0, 0, 1], at);
    }
  const values = new Float32Array(80);
  values.set([size, size, 1 / 60, 0]);
  values.set([0, 0, 4, 4], 4);
  values.set([-1, 0, 0, 0], 8);
  values.set([-2, 0, 0, 0], 12);
  values[16] = 1;
  values[23] = 0.5;
  const fields =
    stage === 'normal-height'
      ? [heights]
      : stage === 'ripple'
        ? [heights, previous, neutral]
        : [heights, neutral, neutral];
  return rasterProbe(
    stage,
    size,
    fields,
    values,
    [
      [0, 1],
      [3, 1],
    ],
    repeat,
  );
}

/** Overlapping impulses distinguish per-brush shaping from shaping their summed strength. */
export async function runFluidImpulseProbe(
  control:
    | 'overlap'
    | 'zero-noise'
    | 'subthreshold-overlap'
    | 'threshold'
    | 'mask-boundary' = 'overlap',
): Promise<readonly (readonly number[])[]> {
  const size = 8;
  const noise = new Float32Array(size * size * 4).fill(control === 'zero-noise' ? 0 : 64 / 255);
  const values = new Float32Array(80);
  values.set([
    size,
    size,
    1 / 60,
    control === 'overlap' || control === 'subthreshold-overlap' ? 2 : 1,
  ]);
  values.set([0, 0, 8, 8], 4);
  values.set([0, 0, 0, 1], 48);
  const impulses =
    control === 'subthreshold-overlap'
      ? new Float32Array([
          0.5, 0.5, 2, 0.002, 1, 0, 1, 0, 0, 0, 0, 0, 0.5, 0.5, 2, 0.002, 1, 0, 2, 0, 0, 0, 0, 0,
        ])
      : new Float32Array([
          0.5,
          0.5,
          control === 'mask-boundary' ? 4 : 2,
          control === 'threshold' ? 0.0025 : -1,
          1,
          0,
          1,
          0,
          0,
          0,
          0,
          0,
          1.5,
          0.5,
          1,
          0.5,
          1,
          0,
          2,
          0,
          0,
          0,
          0,
          0,
        ]);
  return rasterProbe(
    'forces',
    size,
    [noise],
    values,
    [
      [4, 4],
      [5, 4],
      [3, 4],
    ],
    true,
    impulses,
  );
}
