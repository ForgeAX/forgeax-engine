import { expect, it } from 'vitest';
import { advancedShallowShader } from '../water/advanced-shallow-shader';

const SIZE = 8;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing shallow-history fixture resource');
  return value;
}

async function shallowKernel(size = SIZE, rigid = false, waterInfo = false) {
  const SIZE = size;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Shallow history requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({
    code: advancedShallowShader('rgba32float', waterInfo, rigid),
  });
  expect(
    (await module.getCompilationInfo()).messages.filter((row) => row.type === 'error'),
  ).toEqual([]);
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'stage' },
  });
  const textures = Array.from({ length: 8 }, () =>
    device.createTexture({
      size: [SIZE, SIZE],
      format: 'rgba32float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    }),
  );
  const infoTexture = waterInfo
    ? device.createTexture({
        size: [SIZE, SIZE, 1],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
    : undefined;
  const buffer = (size: number) =>
    device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const params = buffer(25 * 16);
  const buffers = [params, buffer(16), buffer((SIZE + 1) ** 2 * 80), buffer(SIZE ** 2 * 24)];
  const rigidBuffers = rigid ? [buffer(160), buffer(144), buffer(16)] : [];
  const primitive = new Float32Array(40);
  for (const offset of [0, 16]) for (const axis of [0, 5, 10, 15]) primitive[offset + axis] = 1;
  primitive.set([2, 2, 1.2, 2], 32);
  if (rigid) device.queue.writeBuffer(required(rigidBuffers[0]), 0, primitive);
  const entries = textures
    .slice(0, 6)
    .map((texture, binding) => ({ binding, resource: texture.createView() }));
  const bindings = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      ...entries,
      ...buffers.map((resource, index) => ({ binding: index + 6, resource: { buffer: resource } })),
      { binding: 11, resource: required(textures[6]).createView() },
      { binding: 15, resource: required(textures[7]).createView() },
      ...(infoTexture === undefined
        ? []
        : [{ binding: 10, resource: infoTexture.createView({ dimension: '2d-array' }) }]),
      ...rigidBuffers.map((resource, index) => ({
        binding: index + 17,
        resource: { buffer: resource },
      })),
    ],
  });
  const parameters = new Float32Array(100);
  parameters.set([4, SIZE, SIZE, 0], 0);
  parameters.set([1, 0, SIZE, SIZE], 4);
  parameters.set([0, 0, 4, 0.000001], 8);
  parameters.set([0, 0, 0, 0], 12);
  parameters.set([0, 0, 9.81, 0.012], 24);
  parameters.set([0, 1, 1, 1], 28);
  parameters.set([2, 1, 1, 0.3], 32);
  parameters.set([0.02, 20, 0.02, 0.005], 36);
  parameters.set([0, 0, 2, 15], 40);
  parameters.set([1, 200, 0, 0], 44);
  const seed = (grid: Float32Array, foam: Float32Array, suppliedField?: Float32Array) => {
    const field = new Float32Array(SIZE ** 2 * 4);
    for (let index = 0; index < SIZE ** 2; index++)
      field[index * 4] = required(parameters[9]) - required(parameters[10]);
    for (const [texture, data] of [
      [required(textures[0]), grid],
      [required(textures[1]), suppliedField ?? field],
      [required(textures[2]), foam],
    ] as const)
      device.queue.writeTexture({ texture }, data, { bytesPerRow: SIZE * 16 }, [SIZE, SIZE]);
  };
  const submit = (copy: boolean) => {
    device.queue.writeBuffer(params, 0, parameters);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(Math.ceil(SIZE / 8), Math.ceil(SIZE / 8));
    pass.end();
    if (copy) {
      for (let index = 0; index < 3; index++)
        encoder.copyTextureToTexture(
          { texture: required(textures[index + 3]) },
          { texture: required(textures[index]) },
          [SIZE, SIZE],
        );
      encoder.copyTextureToTexture(
        { texture: required(textures[6]) },
        { texture: required(textures[7]) },
        [SIZE, SIZE],
      );
    }
    device.queue.submit([encoder.finish()]);
  };
  const read = async (channel = 5) => {
    const encoder = device.createCommandEncoder();
    const bytesPerRow = Math.ceil((SIZE * 16) / 256) * 256;
    const readback = device.createBuffer({
      size: bytesPerRow * SIZE,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      { texture: required(textures[channel]) },
      { buffer: readback, bytesPerRow },
      [SIZE, SIZE],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = new Float32Array(readback.getMappedRange());
    const output = new Float32Array(SIZE ** 2 * 4);
    for (let y = 0; y < SIZE; y++)
      output.set(
        mapped.subarray((y * bytesPerRow) / 4, (y * bytesPerRow) / 4 + SIZE * 4),
        y * SIZE * 4,
      );
    readback.unmap();
    readback.destroy();
    return output;
  };
  return {
    parameters,
    seed,
    seedWaterInfo: (data: Float32Array) =>
      device.queue.writeTexture(
        { texture: required(infoTexture) },
        data,
        { bytesPerRow: SIZE * 16 },
        [SIZE, SIZE],
      ),
    read,
    submit,
    primitive,
    uploadPrimitive: () => device.queue.writeBuffer(required(rigidBuffers[0]), 0, primitive),
    dispatch: async () => {
      submit(false);
      return read();
    },
    dispose: () => {
      for (const texture of textures) texture.destroy();
      infoTexture?.destroy();
      for (const buffer of [...buffers, ...rigidBuffers]) buffer.destroy();
      device.destroy();
    },
  };
}

it.each([
  0.5, 1,
])('preserves wet height and velocity across a %s-cell slope remap with terrain suppression disabled', async (shift) => {
  const kernel = await shallowKernel(SIZE, false, true);
  try {
    const grid = new Float32Array(SIZE ** 2 * 4);
    const previousField = new Float32Array(grid.length);
    const info = new Float32Array(grid.length);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const offset = (y * SIZE + x) * 4;
        const height = 1 + x * 0.1 + y * 0.05;
        const oldBottom = -6 + x * 0.2;
        const currentBottom = y === 6 ? 4 : -3 + x * 0.2;
        grid.set([height, height - oldBottom, 2 + x * 0.2, -1 + y * 0.1], offset);
        previousField[offset] = oldBottom;
        info.set([0.5, 0.5, 0.125, (currentBottom + 8) / 16], offset);
      }
    kernel.parameters.set([shift, 0, SIZE, SIZE], 4);
    kernel.parameters.set([shift, 0, SIZE, SIZE], 16);
    kernel.parameters.set([0, 8, -8, 0], 20);
    kernel.seedWaterInfo(info);
    kernel.seed(grid, new Float32Array(grid.length), previousField);
    kernel.submit(false);
    const output = await kernel.read(3);
    for (let y = 1; y < SIZE - 1; y++)
      for (let x = 1; x < SIZE - 1; x++) {
        const offset = (y * SIZE + x) * 4;
        const height = 1 + (x + shift) * 0.1 + y * 0.05;
        const bottom = y === 6 ? 4 : -3 + x * 0.2;
        expect(output[offset]).toBeCloseTo(height, 5);
        expect(output[offset + 1]).toBeCloseTo(Math.max(0, height - bottom), 5);
        expect(output[offset + 2]).toBeCloseTo(2 + (x + shift) * 0.2, 5);
        expect(output[offset + 3]).toBeCloseTo(-1 + y * 0.1, 5);
      }
    const field = await kernel.read(4);
    expect(field[(3 * SIZE + 3) * 4]).toBeCloseTo(-2.4, 5);
    expect(field[1]).toBe(1);
    if (shift === 1) {
      const exposed = (3 * SIZE + SIZE - 1) * 4;
      expect(output[exposed]).toBeCloseTo(1, 5);
      expect(output[exposed + 1]).toBeCloseTo(2.6, 5);
      expect(output[exposed + 2]).toBe(0);
      expect(output[exposed + 3]).toBe(0);
      expect(output[(6 * SIZE + SIZE - 1) * 4 + 1]).toBe(0);
    }
  } finally {
    kernel.dispose();
  }
});

it.each([
  0, 3,
])('uses the absolute %s m/s solid velocity as the collision target', async (solidSpeed) => {
  const kernel = await shallowKernel(SIZE, true);
  try {
    const grid = new Float32Array(SIZE ** 2 * 4);
    for (let index = 0; index < SIZE ** 2; index++) {
      grid[index * 4 + 1] = 4;
      grid[index * 4 + 2] = 3;
      grid[index * 4 + 3] = -2;
    }
    const dt = 1 / 30;
    kernel.parameters.set([0, 0, SIZE, SIZE], 4);
    kernel.parameters.set([1, 0, 0, 0], 92);
    kernel.parameters.set([0, dt, 0, 0], 96);
    kernel.parameters.set([dt, 1, 1, -0.01], 52);
    kernel.primitive[28] = -solidSpeed * dt;
    kernel.uploadPrimitive();
    kernel.seed(grid, new Float32Array(grid.length));
    kernel.parameters[0] = 4;
    kernel.submit(true);
    const field = await kernel.read(1);
    expect(field[(3 * SIZE + 3) * 4 + 1]).toBe(1);
    expect(field[(3 * SIZE + 3) * 4 + 2]).toBeCloseTo(solidSpeed, 5);
    expect(field[(3 * SIZE + 3) * 4 + 3]).toBeCloseTo(0, 5);
    kernel.parameters[0] = 10;
    kernel.submit(false);
    const output = await kernel.read(3);
    expect(output[(3 * SIZE + 3) * 4 + 2]).toBeCloseTo(solidSpeed, 2);
    expect(output[(3 * SIZE + 3) * 4 + 3]).toBeCloseTo(0, 5);
  } finally {
    kernel.dispose();
  }
});

it('keeps a wet hull bounded through rest, travel, turns, stop and reset', async () => {
  const size = 128;
  const kernel = await shallowKernel(size, true);
  const dt = 1 / 30;
  try {
    const grid = new Float32Array(size ** 2 * 4);
    for (let index = 0; index < size ** 2; index++) grid[index * 4 + 1] = 12;
    kernel.parameters[3] = dt;
    kernel.parameters.set([0, 0, 64, 64], 4);
    kernel.parameters[10] = 12;
    kernel.parameters[34] = 2;
    kernel.parameters[47] = 1;
    kernel.parameters.set([dt, 1, 1, -0.01], 52);
    kernel.parameters.set([1, 1, 0, 0.3], 92);
    kernel.parameters.set([0, dt, 0, 0], 96);
    kernel.primitive.set([2, 8, 1.2, 2], 32);
    kernel.seed(grid, new Float32Array(grid.length));
    let yaw = 0;
    let previousYaw = 0;
    let centerX = 0;
    let centerZ = 0;
    const observations: { phase: number; height: number; volume: number; velocity: number }[] = [];
    for (let frame = 0; frame < 300; frame++) {
      const phase = Math.floor(frame / 60);
      const speed = phase === 1 || phase === 2 ? 6 : 0;
      previousYaw = yaw;
      if (phase === 2) yaw += dt * 0.15;
      const c = Math.cos(yaw),
        s = Math.sin(yaw);
      const pc = Math.cos(previousYaw),
        ps = Math.sin(previousYaw);
      kernel.parameters.set([centerX, centerZ, 0, 0], 12);
      centerX += speed * dt * c;
      centerZ -= speed * dt * s;
      kernel.parameters.set([centerX, centerZ, 64, 64], 4);
      kernel.primitive.set([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, -0.2, 0, 1], 0);
      kernel.primitive.set(
        [pc, 0, -ps, 0, 0, 1, 0, 0, ps, 0, pc, 0, -speed * dt * c, 0.2, speed * dt * s, 1],
        16,
      );
      kernel.uploadPrimitive();
      if (frame === 240) kernel.seed(grid, new Float32Array(grid.length));
      for (const stage of [4, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16]) {
        kernel.parameters[0] = stage;
        kernel.submit(true);
      }
      if (frame % 60 !== 59) continue;
      const output = await kernel.read(0);
      let height = 0;
      let volume = 0;
      let velocity = 0;
      for (let index = 0; index < size ** 2; index++) {
        const h = required(output[index * 4]);
        expect(Number.isFinite(h)).toBe(true);
        height = Math.max(height, Math.abs(h));
        volume += required(output[index * 4 + 1]) * 0.25;
        velocity = Math.max(
          velocity,
          Math.hypot(required(output[index * 4 + 2]), required(output[index * 4 + 3])),
        );
      }
      observations.push({ phase, height, volume, velocity });
    }
    // biome-ignore lint/suspicious/noConsole: Preserve numeric hardware evidence for every phase.
    console.info('wet hull cycle', JSON.stringify(observations));
    for (const row of observations) {
      expect(row.height, JSON.stringify(observations)).toBeLessThan(2.5);
      expect(Math.abs(row.volume - 64 * 64 * 12), JSON.stringify(observations)).toBeLessThan(
        64 * 64,
      );
    }
  } finally {
    kernel.dispose();
  }
});

it.each([
  0, 0.5, 1,
])('reprojects persistent foam with a %s-cell moving shallow grid', async (shift) => {
  const kernel = await shallowKernel();
  try {
    const grid = new Float32Array(SIZE ** 2 * 4);
    const foam = new Float32Array(grid.length);
    for (let index = 0; index < SIZE ** 2; index++) grid[index * 4 + 1] = 4;
    foam[(3 * SIZE + 3) * 4] = 1;
    kernel.parameters[4] = shift;
    kernel.seed(grid, foam);
    const output = await kernel.dispatch();
    expect(output[(3 * SIZE + 3) * 4]).toBeCloseTo(1 - shift, 6);
    if (shift > 0) expect(output[(3 * SIZE + 2) * 4]).toBeCloseTo(shift, 6);
  } finally {
    kernel.dispose();
  }
});

it('keeps a full coast-sized deep-water perturbation stable at its maximum solver delta', async () => {
  const size = 128;
  const kernel = await shallowKernel(size);
  try {
    const grid = new Float32Array(size ** 2 * 4);
    for (let index = 0; index < size ** 2; index++) grid[index * 4 + 1] = 88;
    grid[(64 * size + 64) * 4] = 0.1;
    grid[(64 * size + 64) * 4 + 1] = 88.1;
    kernel.parameters[3] = 1 / 30;
    kernel.parameters.set([0, 0, 64, 64], 4);
    kernel.parameters[10] = 88;
    kernel.parameters[34] = 6;
    kernel.parameters[47] = 1;
    kernel.seed(grid, new Float32Array(grid.length));
    for (let frame = 0; frame < 120; frame++) {
      for (const stage of [4, 6, 7, 8, 9, 10, 11]) {
        kernel.parameters[0] = stage;
        kernel.submit(true);
      }
    }
    const output = await kernel.read(0);
    for (let index = 0; index < size ** 2; index++) {
      expect(Number.isFinite(output[index * 4])).toBe(true);
      expect(Math.abs(required(output[index * 4]))).toBeLessThan(0.15);
    }
  } finally {
    kernel.dispose();
  }
});

it('produces persistent solver foam independently from the normal alpha height channel', async () => {
  const kernel = await shallowKernel();
  try {
    const grid = new Float32Array(SIZE ** 2 * 4);
    const foam = new Float32Array(grid.length);
    for (let index = 0; index < SIZE ** 2; index++) {
      grid[index * 4 + 1] = 4;
      grid[index * 4 + 2] = 1;
    }
    kernel.parameters[0] = 16;
    kernel.parameters[3] = 0.1;
    kernel.parameters[52] = 0.1;
    kernel.parameters.set([1, 0.3, 0, 0], 56);
    kernel.parameters.set([1, 0.08, 1, 0], 60);
    kernel.parameters.set([0.5, 2, 1, 0], 72);
    kernel.parameters.set([0, 0.1, 0, 0.2], 80);
    kernel.seed(grid, foam);
    const output = await kernel.dispatch();
    expect(output[(3 * SIZE + 3) * 4]).toBeGreaterThan(0.01);
    kernel.parameters[3] = 0;
    kernel.seed(grid, output);
    const held = await kernel.dispatch();
    expect(held[(3 * SIZE + 3) * 4]).toBe(output[(3 * SIZE + 3) * 4]);
  } finally {
    kernel.dispose();
  }
});

it('keeps the coast deep-water rest state stable at its maximum solver delta', async () => {
  const kernel = await shallowKernel();
  try {
    const grid = new Float32Array(SIZE ** 2 * 4);
    for (let index = 0; index < SIZE ** 2; index++) grid[index * 4 + 1] = 88;
    grid[(3 * SIZE + 3) * 4] = 0.1;
    grid[(3 * SIZE + 3) * 4 + 1] = 88.1;
    kernel.parameters[3] = 1 / 30;
    kernel.parameters.set([0, 0, 4, 4], 4);
    kernel.parameters[10] = 88;
    kernel.parameters[34] = 6;
    kernel.parameters[47] = 1;
    kernel.seed(grid, new Float32Array(grid.length));
    for (let frame = 0; frame < 120; frame++) {
      for (let substep = 0; substep < 2; substep++) {
        for (const stage of [4, 6, 7, 8, 9, 10, 11]) {
          kernel.parameters[0] = stage;
          kernel.submit(true);
        }
      }
    }
    const output = await kernel.read(0);
    for (let index = 0; index < SIZE ** 2; index++) {
      expect(Number.isFinite(output[index * 4])).toBe(true);
      expect(Math.abs(required(output[index * 4]))).toBeLessThan(0.15);
    }
  } finally {
    kernel.dispose();
  }
});
