import type { Buffer } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';

it('preserves exact physical bytes across authored LOD prefixes and zero-capacity padding', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const accepted = new Map<Buffer, Uint8Array>();
  const candidateBuffers = new Set<Buffer>();
  const originalCreate = device.createBuffer.bind(device);
  const creates = vi.spyOn(device, 'createBuffer').mockImplementation((descriptor) => {
    const result = originalCreate(descriptor);
    if (result.ok && descriptor.label === 'gpu-driven-view-candidates')
      candidateBuffers.add(result.value);
    return result;
  });
  const originalWrite = device.queue.writeBuffer.bind(device.queue);
  const writes = vi
    .spyOn(device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, data, dataOffset, size) => {
      if (!candidateBuffers.has(buffer))
        return originalWrite(buffer, offset, data, dataOffset, size);
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const previous = accepted.get(buffer);
      const contents = new Uint8Array(Math.max(previous?.length ?? 0, bytes.length));
      if (previous !== undefined) contents.set(previous);
      const begin = dataOffset ?? 0;
      contents.set(bytes.subarray(begin, begin + (size ?? bytes.length)), offset);
      // The full privately encoded input is the oracle. Every trimmed write
      // must reconstruct it bit for bit, including omitted padding words.
      expect(contents.subarray(0, bytes.length)).toEqual(bytes);
      accepted.set(buffer, contents);
      return originalWrite(buffer, offset, data, dataOffset, size);
    });
  try {
    f.update().unwrap();
    let revision = f.original.revision;
    for (const levels of [2, 8, 1, 4, 8, 2, 1]) {
      const plan: SubmissionPlan = {
        ...f.original,
        revision: ++revision,
        batches: f.original.batches.map((batch) => ({
          ...batch,
          lod: {
            coverages: Array.from({ length: levels }, (_, level) => 1 / (level + 1)),
            ranges: Array.from({ length: levels - 1 }, (_, level) => ({
              first: level + 1,
              count: level + 2,
              baseVertex: -level,
            })),
            crossfade: true,
            hysteresis: 0,
          },
        })),
      };
      f.update(plan).unwrap();
      // A new plan identity with identical encoded bytes must not upload any
      // part of the unchanged table, even when authored prefixes are long.
      f.update({ ...plan, revision: ++revision }).unwrap();
      expect(f.view.inspect().candidateUploadBytes).toBe(0);
      f.update(f.original).unwrap();
    }
    f.update(f.changed).unwrap();
    f.update(f.original).unwrap();
  } finally {
    writes.mockRestore();
    creates.mockRestore();
    f.close();
  }
});
