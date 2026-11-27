import { rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
} from '../gpu-usage';
import { ensureProbeBlendRecordBuffer } from '../record/probe-blend-buffer';
import type { ProbeBlendBufferProjection } from '../scene/probe-blend';
import {
  PROBE_BLEND_RECORD_BYTE_SIZE,
  PROBE_BLEND_RECORD_STRIDE,
} from '../scene/probe-blend-record';

it('keeps sparse revisions ordered in the same GPU allocation across consecutive submissions', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = device.createBuffer.bind(device);
  // Enable native readback of the normal renderer-owned destination.
  const observe = vi
    .spyOn(device, 'createBuffer')
    .mockImplementation((desc) =>
      create(
        desc.label === 'probe-blend-records'
          ? { ...desc, usage: desc.usage | GPU_BUFFER_USAGE_COPY_SRC }
          : desc,
      ),
    );
  const state: Parameters<typeof ensureProbeBlendRecordBuffer>[1] = {
    probeBlendBuffers: new Map(),
    probeBlendRecordBufferCapacity: 0,
  };
  const row = (objectKey: number, generation: number) => ({
    cacheKey: objectKey,
    record: {
      objectKey,
      generation,
      bytes: new Uint8Array(PROBE_BLEND_RECORD_BYTE_SIZE).fill(generation),
      byteLength: PROBE_BLEND_RECORD_BYTE_SIZE,
      shPreblend: [],
      localBlendFraction: 1,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
    },
  });
  const middle = row(32, 1);
  const initial = [row(0, 1), middle, row(127, 1)];
  const first: ProbeBlendBufferProjection = {
    sourceIdentity: {},
    revision: 1,
    baseRevision: 0,
    records: initial,
    dirtyRecords: initial,
    removedCacheKeys: [],
    capacity: 129,
  };
  const size = first.capacity * PROBE_BLEND_RECORD_STRIDE;
  const readback = create({
    size: size * 2,
    usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
  }).unwrap();
  try {
    const live = ensureProbeBlendRecordBuffer(device, state, first);
    for (let revision = 2; revision <= 3; revision++) {
      const changed = [row(127, revision), row(0, revision)];
      expect(
        ensureProbeBlendRecordBuffer(device, state, {
          ...first,
          revision,
          baseRevision: revision - 1,
          records: [middle, ...changed],
          dirtyRecords: changed,
        }),
      ).toBe(live);
      const encoder = device.createCommandEncoder().unwrap();
      encoder.copyBufferToBuffer(live, 0, readback, (revision - 2) * size, size);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    }
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    for (const revision of [2, 3]) {
      for (const slot of [0, 1, 33, 128]) {
        const start = (revision - 2) * size + slot * PROBE_BLEND_RECORD_STRIDE;
        const value = slot === 0 ? 0 : slot === 33 ? 1 : revision;
        expect(
          bytes.subarray(start, start + PROBE_BLEND_RECORD_BYTE_SIZE).every((b) => b === value),
        ).toBe(true);
        expect(bytes[start + PROBE_BLEND_RECORD_BYTE_SIZE]).toBe(0);
      }
    }
  } finally {
    observe.mockRestore();
    device.destroyBuffer(readback).unwrap();
    state.probeBlendRecordTransfer?.buffer.destroy().unwrap();
    state.probeBlendRecordBuffer?.destroy().unwrap();
  }
});
