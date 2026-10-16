import type { Buffer } from '@forgeax/engine-rhi';
import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';
import { nativeDeviceFixture } from './native-device-fixture';

async function bytes(
  device: Awaited<ReturnType<typeof nativeDeviceFixture>>['device'],
  source: Buffer,
  length: number,
) {
  const readback = device.createBuffer({ size: length, usage: 1 | 8 }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(source, 0, readback, 0, length);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    try {
      return new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    } finally {
      mapped.unmap();
    }
  } finally {
    device.destroyBuffer(readback);
  }
}

it.each([
  2, 3,
])('restores actual native candidate bytes when update write %i fails after accepted topology mutation', async (failureAt) => {
  const { device, native } = await nativeDeviceFixture();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const originalWrite = device.queue.writeBuffer.bind(device.queue);
  let failing = false,
    attempt = 0;
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected update-stage failure',
    hint: 'Native partial upload restoration',
  });
  const writes = vi.spyOn(device.queue, 'writeBuffer').mockImplementation((...args) => {
    if (failing && ++attempt === failureAt) return err(failure);
    return originalWrite(...args);
  });
  native.pushErrorScope('validation');
  try {
    f.update().unwrap();
    const first = writes.mock.calls[0];
    if (first === undefined) throw Error('Missing candidate write');
    const buffer = first[0],
      length = first[2].byteLength;
    const before = await bytes(device, buffer, length);
    failing = true;
    const rejected = f.update(f.changed);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw Error('Expected failed update');
    expect(rejected.error).toBe(failure);
    expect(await bytes(device, buffer, length)).not.toEqual(before);
    failing = false;
    f.update(f.original).unwrap();
    expect(await bytes(device, buffer, length)).toEqual(before);
    expect(f.view.inspect().candidateUploadBytes).toBeGreaterThan(0);
    expect(f.view.inspect().batchUploadBytes).toBeGreaterThan(0);
    f.update(f.original).unwrap();
    expect(f.view.inspect().candidateUploadBytes).toBe(0);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    writes.mockRestore();
    f.close();
    native.destroy();
  }
}, 30_000);
