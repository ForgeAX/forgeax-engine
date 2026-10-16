import type { RenderBundle, Result } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import { makeRhiDevice } from '../device';
import { createShaderModule } from '../index';

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export async function runRenderBundleValidation() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const raw = await adapter.requestDevice();
  const device = makeRhiDevice(raw).device;
  const shader = value(
    await createShaderModule(device, {
      code: `
@vertex fn vs(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0., 1.); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1., 0., 0., 1.); }`,
    }),
  );
  const layout = value(device.createPipelineLayout({ bindGroupLayouts: [] }));
  const pipeline = value(
    device.createRenderPipeline({
      layout,
      vertex: {
        module: shader,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    }),
  );
  const vertex = value(device.createBuffer({ size: 24, usage: 0x28 }));
  value(device.queue.writeBuffer(vertex, 0, new Float32Array([-1, -1, 3, -1, -1, 3])));
  const encoder = value(device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] }));
  encoder.setPipeline(pipeline);
  encoder.setVertexBuffer(0, vertex, 0, 24);
  encoder.draw(3);
  const bundle = value(encoder.finish());
  expect(encoder.finish()).toMatchObject({
    ok: false,
    error: { code: 'command-encoder-finished' },
  });

  const submit = (
    bundles: readonly RenderBundle[],
    format: GPUTextureFormat = 'rgba8unorm',
    sampleCount = 1,
    trailingDraw = false,
  ) => {
    const target = value(device.createTexture({ size: [8, 8], format, sampleCount, usage: 0x10 }));
    const command = value(device.createCommandEncoder());
    const pass = command.beginRenderPass({
      colorAttachments: [
        { view: value(device.createTextureView(target, {})), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    if (trailingDraw) {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vertex);
    }
    value(pass.executeBundles(bundles));
    if (trailingDraw) pass.draw(3);
    pass.end();
    value(device.queue.submit([value(command.finish())]));
    return target;
  };
  const targets = [];
  try {
    raw.pushErrorScope('validation');
    targets.push(submit([bundle, bundle]));
    expect(await raw.popErrorScope()).toBeNull();
    for (const action of [
      () => submit([bundle], 'bgra8unorm'),
      () => submit([bundle], 'rgba8unorm', 4),
      () => submit([], 'rgba8unorm', 1, true),
      () => submit([bundle], 'rgba8unorm', 1, true),
    ]) {
      raw.pushErrorScope('validation');
      targets.push(action());
      expect(await raw.popErrorScope()).not.toBeNull();
    }
    value(device.destroyBuffer(vertex));
    raw.pushErrorScope('validation');
    targets.push(submit([bundle]));
    expect(await raw.popErrorScope()).not.toBeNull();
  } finally {
    for (const target of targets) value(device.destroyTexture(target));
    await raw.queue.onSubmittedWorkDone();
    raw.destroy();
  }
}
