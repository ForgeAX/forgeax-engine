import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { nativeDeviceFixture } from '../../__tests__/native-device-fixture';
import { cpuPhysicalRangesFixture } from './cpu-physical-ranges-fixture';
import { CPU_SETUP_SHADER } from './main-pass-cpu-setup-fixture';

it.each([
  'forward',
  'deferred',
  'temporal',
  'shadow',
] as const)('preserves distinct shared-buffer triangles and nonzero lower ranges through 60 native %s frames', async (kind) => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const shader = (await createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuPhysicalRangesFixture(device, shader);
  const shadow = kind === 'shadow';
  const target = device
    .createTexture({
      size: { width: 64, height: 32 },
      format: shadow ? 'depth32float' : 'rgba8unorm',
      usage: 16 | 1,
    })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const readback = device.createBuffer({ size: 256 * 32, usage: 1 | 8 }).unwrap();
  const render = async (record: (pass: RhiRenderPassEncoder) => void) => {
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass(
      shadow
        ? {
            colorAttachments: [],
            depthStencilAttachment: {
              view,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              depthClearValue: 1,
            },
          }
        : {
            colorAttachments: [
              { view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
            ],
          },
    );
    pass.setBindGroup(0, f.viewGroup);
    record(pass);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target, ...(shadow ? { aspect: 'depth-only' as const } : {}) },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 32 },
      { width: 64, height: 32, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const error = await native.popErrorScope();
    native.pushErrorScope('validation');
    expect(error, error?.message).toBeNull();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const pixels = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    return pixels;
  };
  try {
    const expected = [];
    for (const level of [0, 1] as const) {
      const pixels = await render((pass) => f.oracle(pass, kind, level));
      for (const fault of ['first', 'base', 'omit'] as const)
        expect(await render((pass) => f.oracle(pass, kind, level, fault))).not.toEqual(pixels);
      expected.push(pixels);
    }
    expect(expected[1]).not.toEqual(expected[0]);
    for (let frame = 0; frame < 60; frame++) {
      const level = (frame % 2) as 0 | 1;
      expect(await render((pass) => f.recordRange(pass, kind, level, frame % 3 === 0))).toEqual(
        expected[level],
      );
      expect(f.secondMesh.submeshes).toBe(f.sourceSubmeshes);
      expect(f.second.source.gpuDrivenDraws).toEqual(f.sourceDraws);
    }
    expect(f.errors).toEqual([]);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    f.dispose();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(target).unwrap();
    native.destroy();
  }
});
