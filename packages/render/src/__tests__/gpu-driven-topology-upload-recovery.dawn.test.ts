import type { Buffer } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_DRIVEN_BATCH_STRIDE, GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';
import { observeGpuInputBytes } from './helpers/gpu-input-bytes';
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
])('preserves held native member bytes and restores task headers after write %i fails', async (failureAt) => {
  const { device, native } = await nativeDeviceFixture();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const observed = observeGpuInputBytes(device);
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected update-stage failure',
    hint: 'Native partial task upload restoration',
  });
  native.pushErrorScope('validation');
  try {
    f.update().unwrap();
    const original = observed.buffers();
    const extent = observed.bytes.get(original.arena)?.byteLength;
    if (extent === undefined) throw Error('Missing actual arena upload');
    const before = await bytes(device, original.arena, extent);
    const tasks = await bytes(device, original.tasks, GPU_DRIVEN_BATCH_STRIDE);
    const words = new Uint32Array(before.buffer, before.byteOffset, before.byteLength / 4);
    const reachable = new Set<number>();
    const pending = [new DataView(tasks.buffer, tasks.byteOffset).getUint32(48, true)];
    while (pending.length > 0) {
      const address = pending.pop();
      if (address === undefined || address === 0) continue;
      if (reachable.has(address) || address + 8 > words.length || reachable.size >= 6)
        throw Error('Malformed held member tree');
      reachable.add(address);
      pending.push(words[address] as number, words[address + 1] as number);
    }
    expect(reachable.size).toBeGreaterThan(0);
    const members = observed.members();
    observed.injectFailure(failureAt, false, failure);
    const rejected = f.update(f.changed);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw Error('Expected failed update');
    expect(rejected.error).toBe(failure);
    // Free arena capacity may receive provisional nodes; held nodes must survive.
    const after = await bytes(device, original.arena, extent);
    for (const address of reachable)
      expect(after.subarray(address * 4, (address + 8) * 4)).toEqual(
        before.subarray(address * 4, (address + 8) * 4),
      );
    observed.clearFailure();
    f.update(f.original).unwrap();
    expect(await bytes(device, observed.buffers().tasks, GPU_DRIVEN_BATCH_STRIDE)).toEqual(tasks);
    expect(observed.members()).toEqual(members);
    f.update(f.original).unwrap();
    expect(f.view.inspect().sharedInputUploadBytes).toBe(0);
    const validation = await native.popErrorScope();
    expect(validation, validation?.message).toBeNull();
  } finally {
    observed.close();
    f.close();
    native.destroy();
  }
}, 30_000);
