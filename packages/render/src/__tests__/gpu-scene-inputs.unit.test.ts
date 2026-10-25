import type { Buffer } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuSceneInputs } from '../gpu-scene-inputs';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';

it('path-copies resource mappings, preserves descriptor zero and reclaims empty pages', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const bytes = new Map<Buffer, Uint32Array>();
  const write = device.queue.writeBuffer.bind(device.queue);
  vi.spyOn(device.queue, 'writeBuffer').mockImplementation(
    (buffer, offset, data, start = 0, size) => {
      const result = write(buffer, offset, data, start, size);
      if (!result.ok) return result;
      const source =
        data instanceof ArrayBuffer
          ? new Uint8Array(data, start, size ?? data.byteLength - start)
          : new Uint8Array(data.buffer, data.byteOffset + start, size ?? data.byteLength - start);
      const previous = bytes.get(buffer);
      const next = new Uint32Array(
        Math.max(previous?.length ?? 0, (offset + source.byteLength) / 4),
      );
      if (previous !== undefined) next.set(previous);
      new Uint8Array(next.buffer).set(source, offset);
      bytes.set(buffer, next);
      return result;
    },
  );
  const slots = Array.from({ length: 257 }, (_, index) => inputs.allocateResource(index));
  const held = inputs.capture();
  try {
    expect(held.resource(slots[0] as number)).toBe(0);
    expect(held.resource(slots[256] as number)).toBe(256);
    expect(held.resource(0)).toBeUndefined();
    const old = held.buffer().unwrap();
    held.seal().unwrap();
    const before = inputs.resourcePagesWritten;
    inputs.updateResource(slots[256] as number, 10000);
    expect(inputs.resourcePagesWritten - before).toBe(4);
    const current = inputs.capture();
    expect(current.resource(slots[256] as number)).toBe(10000);
    const next = current.buffer().unwrap();
    current.seal().unwrap();
    const lookup = (buffer: Buffer, root: number, slot: number) => {
      const words = bytes.get(buffer) as Uint32Array;
      let page = root;
      for (let shift = 24; shift >= 0; shift -= 8)
        page = words[page + ((slot >>> shift) & 255)] as number;
      return page;
    };
    expect(lookup(old.buffer, old.resourceRoot, slots[256] as number)).toBe(256);
    expect(lookup(next.buffer, next.resourceRoot, slots[256] as number)).toBe(10000);
    // A sealed frame may outlive current publication and current slot reuse.
    for (const slot of slots) inputs.releaseResource(slot);
    const empty = inputs.capture();
    expect(empty.buffer().unwrap().resourceRoot).toBe(0xffffffff);
    empty.release();
    current.release();
    held.release();
    expect(inputs.resourcePagesReleased).toBe(inputs.resourcePagesWritten);
  } finally {
    held.release();
    inputs.dispose();
  }
});

it('rejects an unsealed read domain changed before its first resource demand', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const slot = inputs.allocateResource(0);
  const frame = inputs.capture();
  try {
    // The physical descriptor can stay numerically equal while its payload changes.
    inputs.updateResource(slot, 0);
    expect(frame.resource(slot)).toBeUndefined();
    expect(frame.seal().ok).toBe(false);
    frame.release();
    frame.release();
    const replacement = inputs.capture();
    expect(replacement.resource(slot)).toBe(0);
    replacement.seal().unwrap();
    replacement.release();
  } finally {
    frame.release();
    inputs.dispose();
  }
});

it('bounds unflushed mapping history by live paths rather than edit count', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const slot = inputs.allocateResource(0);
  for (let edit = 1; edit <= 1000; edit++) inputs.updateResource(slot, edit);
  expect(inputs.resourcePagesWritten - inputs.resourcePagesReleased).toBe(4);
  const frame = inputs.capture();
  try {
    expect(frame.resource(slot)).toBe(1000);
    const buffer = frame.buffer().unwrap();
    frame.seal().unwrap();
    expect(buffer.byteLength).toBeLessThanOrEqual(64 * 1024);
    frame.release();
    inputs.releaseResource(slot);
    expect(inputs.resourcePagesWritten).toBe(inputs.resourcePagesReleased);
  } finally {
    frame.release();
    inputs.dispose();
  }
});

it.each([
  1, 65, 10001,
])('encodes one canonical member for %i instances without reading candidate rows', async (count) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const source = receiptRow().source;
  const scene = new RenderScene();
  scene.reset([
    {
      ...source,
      instances: {
        instanceCount: count,
        transforms: new Float32Array(count * 16),
        cacheKey: 1,
        archVersion: 1,
      },
    },
  ]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const publication = topology.sourcePlan();
  if (publication.sourceGroups === undefined) throw new Error('Missing native source root');
  const batch = publication.batches.at(0);
  if (batch === undefined) throw new Error('Missing source member');
  const iterator = vi.spyOn(MemberCandidates.prototype, Symbol.iterator).mockImplementation(() => {
    throw new Error('Canonical encoding must not expand instances');
  });
  const inputs = new GpuSceneInputs(device, (slot) => slot + 10);
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  let frame: ReturnType<typeof inputs.capture> | undefined;
  try {
    inputs.adoptSources(publication.sourceGroups);
    frame = inputs.capture();
    const address = frame.members(batch.candidates);
    const buffer = frame.buffer().unwrap();
    frame.seal().unwrap();
    // One member node and its one-record page.
    expect(inputs.memberNodesWritten).toBe(2);
    expect(buffer.byteLength).toBe(1024);
    const uploaded = writes.mock.calls.find(([target]) => target === buffer.buffer)?.[2];
    if (!(uploaded instanceof Uint32Array)) throw new Error('Missing actual shared input words');
    expect(uploaded[address + 3]).toBe(count);
    expect(uploaded[(uploaded[address + 4] as number) + 1]).toBe(10);
    expect(iterator).not.toHaveBeenCalled();
  } finally {
    iterator.mockRestore();
    writes.mockRestore();
    frame?.release();
    inputs.dispose();
  }
});

it('keeps descriptor patches on the owned dirty range through release and reuse', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const inputs = new GpuSceneInputs(device, (slot) => slot);
  const first = inputs.arena.allocateDescriptor(256);
  const frame = inputs.capture();
  frame.buffer().unwrap();
  frame.seal().unwrap();
  frame.release();
  const write = vi.spyOn(device.queue, 'writeBuffer');
  try {
    for (let index = 0; index < 256; index++)
      inputs.arena.writeDescriptorWord(first, 256, index, index + 1);
    expect(() => inputs.arena.writeDescriptorWord(first, 256, 256, 1)).toThrow();
    inputs.arena.releaseDescriptor(first, 256);
    const reused = inputs.arena.allocateDescriptor(1);
    expect(reused).toBe(first);
    const next = inputs.capture();
    next.buffer().unwrap();
    next.seal().unwrap();
    next.release();
    // No abandoned interior patch is uploaded into a released/reused range.
    expect(
      write.mock.calls.map(([, offset, data, , size]) => [offset, size ?? data.byteLength]),
    ).toEqual([[reused * 4, 4]]);
    inputs.arena.releaseDescriptor(reused, 1);
  } finally {
    write.mockRestore();
    inputs.dispose();
  }
});
