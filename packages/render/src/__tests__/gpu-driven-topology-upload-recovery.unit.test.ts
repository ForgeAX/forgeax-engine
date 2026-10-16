import type { Buffer } from '@forgeax/engine-rhi';
import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';

it.each([
  { at: 2, thrown: false },
  { at: 3, thrown: false },
  { at: 2, thrown: true },
])('restores the exact previous plan after write $at fails (thrown=$thrown)', async ({
  at: failureAt,
  thrown,
}) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const accepted = new Map<Buffer, Uint8Array>();
  const originalWrite = device.queue.writeBuffer.bind(device.queue);
  let attempt = 0,
    failing = false;
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected write failure',
    hint: 'test partial topology mutation',
  });
  const writes = vi
    .spyOn(device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, data, dataOffset, size) => {
      if (failing && ++attempt === failureAt) {
        if (thrown) throw failure;
        return err(failure);
      }
      const result = originalWrite(buffer, offset, data, dataOffset, size);
      if (result.ok) {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        const begin = dataOffset ?? 0;
        const patch = bytes.subarray(begin, begin + (size ?? bytes.byteLength));
        const previous = accepted.get(buffer);
        const contents = new Uint8Array(Math.max(previous?.byteLength ?? 0, offset + patch.length));
        if (previous !== undefined) contents.set(previous);
        contents.set(patch, offset);
        accepted.set(buffer, contents);
      }
      return result;
    });
  try {
    f.update().unwrap();
    const candidateBuffer = writes.mock.calls[0]?.[0];
    if (candidateBuffer === undefined) throw Error('Missing candidate buffer');
    const baseline = accepted.get(candidateBuffer)?.slice();
    failing = true;
    if (thrown) {
      let caught: unknown;
      try {
        f.update(f.changed);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    } else {
      const rejected = f.update(f.changed);
      expect(rejected.ok).toBe(false);
      if (rejected.ok) throw Error('Expected failed update');
      expect(rejected.error).toBe(failure);
    }
    expect(accepted.get(candidateBuffer)).not.toEqual(baseline);
    failing = false;
    writes.mockClear();
    f.update(f.original).unwrap();
    expect(accepted.get(candidateBuffer)).toEqual(baseline);
    expect(f.view.inspect().candidateUploadBytes).toBeGreaterThan(0);
    expect(f.view.inspect().batchUploadBytes).toBeGreaterThan(0);
    f.update(f.original).unwrap();
    expect(f.view.inspect().candidateUploadBytes).toBe(0);
  } finally {
    writes.mockRestore();
    f.close();
  }
});

it('uploads one changed candidate word and retains identical batch bytes', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  try {
    f.update().unwrap();
    const full = f.view.inspect().candidateUploadBytes;
    expect(full).toBeGreaterThan(4);
    const candidateOnly = {
      ...f.changed,
      batches: f.changed.batches.map((batch, index) => ({
        ...batch,
        key: f.original.batches[index]?.key ?? batch.key,
      })),
    };
    f.update(candidateOnly).unwrap();
    expect(f.view.inspect().candidateUploadBytes).toBe(4);
    expect(f.view.inspect().batchUploadBytes).toBe(0);
    f.update(f.original).unwrap();
    expect(f.view.inspect().candidateUploadBytes).toBe(4);
    f.update({ ...f.original, revision: f.original.revision + 2 }).unwrap();
    expect(f.view.inspect().candidateUploadBytes).toBe(0);
    expect(f.view.inspect().batchUploadBytes).toBe(0);
  } finally {
    f.close();
  }
});
