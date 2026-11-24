import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldFrame } from '../../raytracing/irradiance-field';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { rayShaderTestImports } from './ray-shader-imports.fixture';

it('filters noisy reflections along the surface without borrowing a different depth', async () => {
  const entryPoint = 'filterFieldReflections';
  const source = readFileSync(
    new URL('../../../../shader/src/ray-irradiance-field.wgsl', import.meta.url),
    'utf8',
  );
  const shader = (
    await compileShader(source, {
      id: entryPoint,
      computeEntry: entryPoint,
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Reflection filter needs a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (error) => errors.push(error.error.message));

  const [width, height] = [4, 1];
  const frameData = packIrradianceFieldFrame({
    worldSource: { traversal: 'unused' },
    probeBudget: 0,
    raysPerProbe: 0,
    frameIndex: 0,
    tileOffset: 0,
    tileBudget: 0,
    tileCount: 0,
    lightCount: 0,
    cardResolution: 1,
    atlasWidth: 1,
    radiosity: false,
    environment: [0, 0, 0],
    hysteresis: 0,
    maxDistance: 10,
    surfaceBias: 0,
    depthClamp: 8,
    cardMargin: 0,
    gather: [width, height, width, height],
    query: new Uint8Array(8),
    reflections: [0.5, 0.1],
  });
  // Each production history row is radiance/age, normal/roughness, and position/valid.
  const history = new Float32Array([
    1, 1, 1, 2, 0, 0, 1, 0.3, 0, 0, -3, 1, 3, 3, 3, 2, 0, 0, 1, 0.3, 1, 0, -3, 1, 101, 101, 101, 2,
    0, 0, 1, 0.3, 2, 0, -8, 1, 101, 101, 101, 2, 0, 0, 1, 0.3, 3, 0, -3, 0,
  ]);
  const uploaded = (data: Uint8Array, usage: number) => {
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const frame = uploaded(frameData, GPUBufferUsage.UNIFORM);
  const view = uploaded(new Uint8Array(VIEW_UNIFORM_BYTES), GPUBufferUsage.UNIFORM);
  const input = uploaded(new Uint8Array(history.buffer), GPUBufferUsage.STORAGE);
  const byteLength = width * 16;
  const output = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: shader.wgsl }), entryPoint },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: frame } },
        { binding: 8, resource: { buffer: view } },
        { binding: 18, resource: { buffer: input } },
        { binding: 19, resource: { buffer: output } },
      ],
    });
    const filter = async () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, byteLength);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return [...pixels];
    };
    const isolated = await filter();
    expect(isolated[0]).toBeCloseTo((9 + 6 * 3) / 15, 5);
    expect(isolated[4]).toBeCloseTo((6 + 9 * 3) / 15, 5);
    expect(isolated.slice(8, 12)).toEqual([101, 101, 101, 1]);
    expect(isolated.slice(12)).toEqual([0, 0, 0, 0]);
    // Change only the bright pixel's depth. The wider young-history filter
    // must now pick it up, falsifying an unwired filter or a dead neighbor.
    history[34] = -3;
    device.queue.writeBuffer(input, 0, new Uint8Array(history.buffer));
    const sameSurface = await filter();
    expect(sameSurface[0]).toBeCloseTo((9 + 6 * 3 + 3 * 101) / 18, 5);
    expect(errors).toEqual([]);
  } finally {
    for (const buffer of [frame, view, input, output, readback]) buffer.destroy();
    device.destroy();
  }
});
