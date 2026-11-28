import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { WATER_CAUSTICS_REACTIVITY_OUTPUT as CAUSTICS_REACTIVITY_OUTPUT } from '../field.js';

const FRAMES = 240;
const WIDTH = 4;
const FRAME_BYTES = 768;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing GPU fixture value');
  return value;
}

function half(value: number): number {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >> 10) & 31;
  return (
    sign *
    (exponent === 0
      ? (value & 1023) * 2 ** -24
      : (1 + (value & 1023) / 1024) * 2 ** (exponent - 15))
  );
}

it('retains moving caustics while static geometry integrates jitter with bounded local response', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Caustics temporal regression requires Dawn');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const textures: GPUTexture[] = [];
  const texture = (format: GPUTextureFormat) => {
    const value = device.createTexture({
      size: [WIDTH, 1],
      format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    textures.push(value);
    return value;
  };
  const color = texture('rgba16float');
  const metadata = texture('rgba16float');
  const secondary = texture('rgba16float');
  const history = Array.from({ length: 2 }, () => [
    texture('rgba16float'),
    texture('rgba16float'),
    texture('r8unorm'),
    texture('rgba8unorm'),
  ]);
  const frame = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const params = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: FRAMES * FRAME_BYTES,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    // Exercise the optional receiver's actual response helper and MRT state.
    // Pixels 0/1 share animated light, pixel 2 is static noisy geometry,
    // and pixel 3 already carries stronger reactivity.
    const receiverSource = readFileSync(
      new URL('../shaders/receiver.wgsl', import.meta.url),
      'utf8',
    );
    const helperStart = receiverSource.indexOf('fn causticsReactivity(');
    const helperEnd = receiverSource.indexOf('fn receiveCaustics(', helperStart);
    const response = receiverSource.slice(helperStart, helperEnd);
    const producer = device.createShaderModule({
      code: `
${response}
struct Out { @location(0) color: vec4<f32>, @location(1) temporal: vec4<f32> };
@group(0) @binding(0) var<uniform> frame: vec4<u32>;
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p: vec4<f32>) -> Out {
  let x = u32(p.x);
  let light = select(0.25, 2.0, (frame.x / 32u) % 2u == 1u);
  let prior = select(0.25, 2.0, ((max(frame.x, 1u) - 1u) / 32u) % 2u == 1u);
  let staticSample = select(0.9, 1.1, frame.x % 2u == 1u);
  let value = select(select(staticSample, 2.0, x == 3u), light, x < 2u);
  let reactive = causticsReactivity(light - 0.25, prior - 0.25, true);
  return Out(vec4<f32>(vec3<f32>(value), 1.0), vec4<f32>(99.0, 98.0, 97.0, select(select(0.0, causticsReactivity(0.0, 0.0, true), x == 2u), reactive, x == 0u)));
}`,
    });
    const receive = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: producer, entryPoint: 'vs_main' },
      fragment: {
        module: producer,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }, CAUSTICS_REACTIVITY_OUTPUT],
      },
    });
    const producerBindings = device.createBindGroup({
      layout: receive.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: frame } }],
    });
    const source = readFileSync(
      new URL('../../../../shader/src/taa-resolve.wgsl', import.meta.url),
      'utf8',
    ).replace(/^#define_import_path.*$/m, '');
    const taaModule = device.createShaderModule({ code: source });
    const taa = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: taaModule, entryPoint: 'vs_main' },
      fragment: {
        module: taaModule,
        entryPoint: 'fs_main',
        targets: [
          { format: 'rgba16float' },
          { format: 'rgba16float' },
          { format: 'r8unorm' },
          { format: 'rgba8unorm' },
        ],
      },
    });
    const empty = device.createBindGroup({ layout: taa.getBindGroupLayout(0), entries: [] });
    const linear = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const nearest = device.createSampler();
    const groups = history.map((surfaces) =>
      device.createBindGroup({
        layout: taa.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: color.createView() },
          { binding: 2, resource: required(surfaces[0]).createView() },
          { binding: 3, resource: linear },
          { binding: 4, resource: required(surfaces[1]).createView() },
          { binding: 5, resource: nearest },
          { binding: 8, resource: { buffer: params } },
          { binding: 9, resource: required(surfaces[2]).createView() },
          { binding: 10, resource: secondary.createView() },
          { binding: 11, resource: metadata.createView() },
          { binding: 12, resource: secondary.createView() },
          { binding: 13, resource: required(surfaces[3]).createView() },
        ],
      }),
    );
    device.queue.writeTexture(
      { texture: secondary },
      new Uint16Array(WIDTH * 4),
      { bytesPerRow: WIDTH * 8 },
      [WIDTH, 1],
    );
    for (let tick = 0; tick < FRAMES; tick++) {
      const values = new Uint16Array(WIDTH * 4);
      for (let pixel = 0; pixel < WIDTH; pixel++)
        values.set([0, 0, 0x4000, pixel === 3 ? 0x3a00 : 0], pixel * 4);
      device.queue.writeTexture({ texture: metadata }, values, { bytesPerRow: WIDTH * 8 }, [
        WIDTH,
        1,
      ]);
      device.queue.writeBuffer(frame, 0, new Uint32Array([tick, 0, 0, 0]));
      device.queue.writeBuffer(
        params,
        0,
        new Uint32Array([0, 0, Number(tick > 0), tick, 0, 0, 0, 0, 0, 0, 0, 0]),
      );
      const encoder = device.createCommandEncoder();
      const receiver = encoder.beginRenderPass({
        colorAttachments: [
          { view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
          { view: metadata.createView(), loadOp: 'load', storeOp: 'store' },
        ],
      });
      receiver.setPipeline(receive);
      receiver.setBindGroup(0, producerBindings);
      receiver.draw(3);
      receiver.end();
      const outputs = required(history[(tick + 1) % 2]);
      const resolve = encoder.beginRenderPass({
        colorAttachments: outputs.map((t) => ({
          view: t.createView(),
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
          clearValue: [0, 0, 0, 0] as const,
        })),
      });
      resolve.setPipeline(taa);
      resolve.setBindGroup(0, empty);
      resolve.setBindGroup(1, required(groups[tick % 2]));
      resolve.draw(3);
      resolve.end();
      for (const [slot, t] of [required(outputs[0]), metadata, required(outputs[2])].entries())
        encoder.copyTextureToBuffer(
          { texture: t },
          { buffer: readback, offset: tick * FRAME_BYTES + slot * 256, bytesPerRow: 256 },
          [WIDTH, 1],
        );
      device.queue.submit([encoder.finish()]);
    }
    await readback.mapAsync(GPUMapMode.READ);
    expect((await device.popErrorScope())?.message).toBeUndefined();
    const bytes = readback.getMappedRange();
    let staticError = 0;
    let staticCount = 0;
    for (let tick = 128; tick < FRAMES; tick++) {
      const colorWords = new Uint16Array(bytes, tick * FRAME_BYTES, WIDTH * 4);
      const motionWords = new Uint16Array(bytes, tick * FRAME_BYTES + 256, WIDTH * 4);
      const stability = new Uint8Array(bytes, tick * FRAME_BYTES + 512, WIDTH);
      const bright = Math.floor(tick / 32) % 2 === 1;
      if (tick % 32 > 20) {
        if (bright) expect(half(required(colorWords[0]))).toBeGreaterThan(1.8);
        else expect(half(required(colorWords[0]))).toBeLessThan(1.0);
      }
      staticError += Math.abs(half(required(colorWords[8])) - 1);
      staticCount++;
      expect(Array.from(motionWords.slice(0, 3))).toEqual([0, 0, 0x4000]);
      expect(half(required(motionWords[3]))).toBeLessThanOrEqual(0.45);
      expect(Array.from(motionWords.slice(8, 12))).toEqual([0, 0, 0x4000, 0]);
      expect(motionWords[15]).toBe(0x3a00);
      expect(stability[2]).toBeGreaterThan(0);
    }
    // Static sampling noise must integrate even while a neighboring light animates.
    expect(staticError / staticCount).toBeLessThan(0.06);
    readback.unmap();
  } finally {
    for (const t of textures) t.destroy();
    frame.destroy();
    params.destroy();
    readback.destroy();
    device.destroy();
  }
});
