import { expect, it } from 'vitest';
import { createShadowCasterCascadeBuffer } from '../assembly/webgpu-ready-resources';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
} from '../gpu-usage';
import {
  SHADOW_CASTER_BUFFER_SIZE,
  writeShadowCasterMatrices,
} from '../record/shadow-caster-uniforms';
import type { ViewLights } from '../world/render-lights';
import { nativeDeviceFixture } from './native-device-fixture';

it('reads fixed caster headers and current spot matrices back from real GPU buffers', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const buffer = createShadowCasterCascadeBuffer((descriptor) => {
    if (descriptor.usage === undefined) throw Error('Caster buffer must declare its usage');
    return device.createBuffer({
      ...descriptor,
      usage: descriptor.usage | GPU_BUFFER_USAGE_COPY_SRC,
    });
  }, device.queue);
  const readback = device
    .createBuffer({
      size: SHADOW_CASTER_BUFFER_SIZE,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const matrix = Float32Array.from({ length: 16 }, (_, index) => index + 1);
  const lights = { spot: [{ shadowAtlasTile: 2, lightViewProj: matrix }] } as unknown as ViewLights;
  const read = async () => {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(buffer, 0, readback, 0, SHADOW_CASTER_BUFFER_SIZE);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = mapped.getMappedRange().unwrap().slice(0);
    mapped.unmap();
    return bytes;
  };
  try {
    const initial = new Uint32Array(await read());
    for (let slot = 0; slot < 8; slot++)
      expect(Array.from(initial.subarray(slot * 64, slot * 64 + 4))).toEqual(
        slot < 4 ? [slot, 0, 0, 0] : [0, 1, 0, 0],
      );
    for (const value of [7, 19]) {
      matrix[0] = value;
      writeShadowCasterMatrices(device.queue, buffer, lights);
      const bytes = await read();
      const words = new Uint32Array(bytes);
      for (let slot = 0; slot < 8; slot++)
        expect(Array.from(words.subarray(slot * 64, slot * 64 + 4))).toEqual(
          Array.from(initial.subarray(slot * 64, slot * 64 + 4)),
        );
      expect(Array.from(new Float32Array(bytes, 1552, 16))).toEqual(Array.from(matrix));
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(buffer);
    device.destroyBuffer(readback);
    native.destroy();
  }
});
