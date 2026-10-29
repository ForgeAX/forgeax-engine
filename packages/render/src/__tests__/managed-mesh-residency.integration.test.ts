import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createBoxGeometry, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, type MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { ShadowMeshReads } from '../device/mesh-changes';

async function fixture(indexFormat: 'uint16' | 'uint32' = 'uint32') {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const records = runtimeAssets(assets);
  const source = createBoxGeometry(2, 2, 2).unwrap();
  const handle = assets
    .create(
      indexFormat === 'uint16'
        ? { ...source, indices: new Uint16Array(source.indices ?? []) }
        : source,
    )
    .unwrap();
  const current = () => records.borrow<MeshAsset>(handle).unwrap();
  const first = store.ensureResident(handle, current()).unwrap();
  const observer = assets.observe().unwrap();
  const update = (values = Float32Array.of(5, 6, 7)) => {
    assets.writeRange(handle, { attribute: 'position', first: 1, values }).unwrap();
    const batch = observer.read().unwrap();
    const change = batch.changes.find((change) => change.handle === handle);
    assert(change);
    const adopted = store.adoptMeshChange(change, current());
    batch.accept();
    return adopted;
  };
  const dispose = () => {
    store.destroyAll();
    observer.dispose();
    assets.dispose();
  };
  return { device, store, assets, records, handle, current, first, update, dispose };
}

it('uploads one vertex range without allocating or uploading the complete mesh, even with queued work', async () => {
  const f = await fixture();
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.store.trackMeshSubmission(completed);
  const create = vi.spyOn(f.device, 'createBuffer');
  const write = vi.spyOn(f.device.queue, 'writeBuffer');
  const epoch = f.first.contentEpoch;
  try {
    f.update().unwrap();
    const next = f.store.ensureResident(f.handle, f.current()).unwrap();
    expect(next).toBe(f.first);
    expect(next.contentEpoch).toBeGreaterThan(epoch);
    expect(create).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0];
    assert(call);
    assert(ArrayBuffer.isView(call[2]));
    expect(call[1]).toBe(deriveVertexLayoutProjection(f.current().attributes).arrayStride);
    expect(call[2].byteLength).toBe(12);
    expect(new Float32Array(call[2].buffer, call[2].byteOffset, 3)).toEqual(
      Float32Array.of(5, 6, 7),
    );
  } finally {
    finish();
    await completed;
    f.dispose();
  }
});

it('keeps repeated managed range edits on the same physical allocation', async () => {
  const f = await fixture();
  const create = vi.spyOn(f.device, 'createBuffer');
  const write = vi.spyOn(f.device.queue, 'writeBuffer');
  try {
    let epoch = f.first.contentEpoch;
    for (let revision = 0; revision < 4; revision++) {
      f.update(Float32Array.of(5 + revision, 6, 7)).unwrap();
      const next = f.store.ensureResident(f.handle, f.current()).unwrap();
      expect(next).toBe(f.first);
      expect(next.contentEpoch).toBeGreaterThan(epoch);
      epoch = next.contentEpoch;
    }
    expect(create).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(4);
  } finally {
    f.dispose();
  }
});

it.each([
  'first-result',
  'second-result',
  'second-throw',
] as const)('retires partially changed managed storage after %s', async (failure) => {
  const f = await fixture();
  const unrelatedSource = createBoxGeometry(3, 3, 3).unwrap();
  assert(unrelatedSource.indices);
  const unrelatedHandle = f.assets
    .create({ ...unrelatedSource, indices: unrelatedSource.indices.slice().reverse() })
    .unwrap();
  const unrelated = f.store
    .ensureResident(unrelatedHandle, f.records.borrow<MeshAsset>(unrelatedHandle).unwrap())
    .unwrap();
  const observer = f.assets.observe().unwrap();
  const fault = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'managed range upload succeeds',
    hint: 'retry the accepted asset revision',
  });
  const write = f.device.queue.writeBuffer.bind(f.device.queue);
  let calls = 0;
  f.device.queue.writeBuffer = (...args) => {
    if (++calls === (failure === 'first-result' ? 1 : 2)) {
      if (failure === 'second-throw') throw fault;
      return err(fault);
    }
    return write(...args);
  };
  try {
    f.assets
      .writeRange(f.handle, { attribute: 'position', first: 1, values: Float32Array.of(9, 8, 7) })
      .unwrap();
    f.assets.writeRange(f.handle, { first: 0, indices: Uint32Array.of(2, 1, 0) }).unwrap();
    const batch = observer.read().unwrap();
    const change = batch.changes.find((item) => item.handle === f.handle);
    assert(change);
    const epoch = f.store.meshResidencyEpoch;
    const adopt = () => f.store.adoptMeshChange(change, f.current());
    if (failure === 'second-throw') expect(adopt).toThrow(fault);
    else expect(adopt().ok).toBe(false);
    expect(calls).toBe(failure === 'first-result' ? 1 : 2);
    expect(f.store.getMeshGpuHandles(f.handle)).toBeUndefined();
    expect(f.store.meshResidencyEpoch).toBeGreaterThan(epoch);
    expect(f.first.vertexBuffer.isDestroyed).toBe(true);
    expect(f.first.indexBuffer?.isDestroyed).toBe(true);
    expect(f.store.getMeshGpuHandles(unrelatedHandle)).toBe(unrelated);
    expect(unrelated.vertexBuffer.isDestroyed).toBe(false);
    expect(unrelated.indexBuffer?.isDestroyed).toBe(false);
    batch.accept();
    f.device.queue.writeBuffer = write;
    const next = f.store.ensureResident(f.handle, f.current()).unwrap();
    expect(next.vertexBuffer).not.toBe(f.first.vertexBuffer);
    expect(next.indexBuffer).not.toBe(f.first.indexBuffer);
  } finally {
    f.device.queue.writeBuffer = write;
    observer.dispose();
    f.dispose();
  }
});

it('updates an odd uint16 index range without overwriting its adjacent index or vertex allocation', async () => {
  const f = await fixture('uint16');
  const write = vi.spyOn(f.device.queue, 'writeBuffer');
  const observer = f.assets.observe().unwrap();
  try {
    const firstIndex = f.current().indices?.[0];
    f.assets.writeRange(f.handle, { first: 1, indices: Uint16Array.of(23) }).unwrap();
    const change = observer.read().unwrap().changes[0];
    assert(change);
    f.store.adoptMeshChange(change, f.current()).unwrap();
    const next = f.store.ensureResident(f.handle, f.current()).unwrap();
    expect(next).toBe(f.first);
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0];
    assert(call);
    assert(ArrayBuffer.isView(call[2]));
    expect(call[0]).toBe(next.indexBuffer?.handle);
    expect(call[1]).toBe(0);
    expect(new Uint16Array(call[2].buffer, call[2].byteOffset, 2)).toEqual(
      Uint16Array.of(firstIndex as number, 23),
    );
  } finally {
    observer.dispose();
    f.dispose();
  }
});

it('forks a shared physical vertex buffer while preserving the other logical asset', async () => {
  const f = await fixture();
  const other = f.assets.copy(f.handle).unwrap();
  const source = f.records.borrow<MeshAsset>(other).unwrap();
  const shared = f.store.ensureResident(other, source).unwrap();
  expect(shared.vertexBuffer).toBe(f.first.vertexBuffer);
  try {
    f.update().unwrap();
    const next = f.store.ensureResident(f.handle, f.current()).unwrap();
    expect(next.vertexBuffer).not.toBe(shared.vertexBuffer);
    expect(next.indexBuffer).toBe(shared.indexBuffer);
    expect(shared.vertexBuffer.isDestroyed).toBe(false);
    expect(f.store.ensureResident(other, source).unwrap()).toBe(shared);
    expect(source.vertices).not.toEqual(f.current().vertices);
  } finally {
    f.dispose();
  }
});

it('preserves unsubmitted candidate storage and retires it only after lease and submission', async () => {
  const f = await fixture();
  const lease = f.store.retainMeshResidency(f.handle);
  assert(lease);
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    f.update().unwrap();
    const next = f.store.ensureResident(f.handle, f.current()).unwrap();
    expect(next.vertexBuffer).not.toBe(f.first.vertexBuffer);
    expect(f.first.vertexBuffer.isDestroyed).toBe(false);
    lease.track(completed);
    const released = lease.release(false);
    expect(f.first.vertexBuffer.isDestroyed).toBe(false);
    finish();
    await released;
    expect(f.first.vertexBuffer.isDestroyed).toBe(true);
    expect(next.vertexBuffer.isDestroyed).toBe(false);
  } finally {
    finish();
    await completed;
    f.dispose();
  }
});

it('evicts a failed range upload so a later use cannot accept partially written content', async () => {
  const f = await fixture();
  const write = vi.spyOn(f.device.queue, 'writeBuffer').mockReturnValueOnce(
    err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'range upload succeeds',
        hint: 'retry after recovery',
      }),
    ),
  );
  try {
    expect(f.update().ok).toBe(false);
    expect(f.store.getMeshGpuHandles(f.handle)).toBeUndefined();
    write.mockRestore();
    expect(f.store.ensureResident(f.handle, f.current()).unwrap().vertexBuffer).not.toBe(
      f.first.vertexBuffer,
    );
  } finally {
    write.mockRestore();
    f.dispose();
  }
});

it('prepares concurrent revisions without changing current residency and cannot roll back an accepted revision', async () => {
  const f = await fixture();
  try {
    const before = f.store.getMeshGpuHandles(f.handle);
    const initialRevision = f.records.version(f.handle).unwrap();
    const earlier = f.store.prepareMeshResidency(f.handle, f.current(), initialRevision).unwrap();
    const shared = f.store.prepareMeshResidency(f.handle, f.current(), initialRevision).unwrap();
    expect(shared.entry).toBe(earlier.entry);
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(before);
    earlier.lease.release(true);
    expect(shared.current()).toBe(true);
    f.assets
      .writeRange(f.handle, { attribute: 'position', first: 1, values: Float32Array.of(8, 9, 10) })
      .unwrap();
    const currentRevision = f.records.version(f.handle).unwrap();
    const future = f.store.prepareMeshResidency(f.handle, f.current(), currentRevision).unwrap();
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(before);
    expect(future.entry.vertexBuffer).not.toBe(shared.entry.vertexBuffer);
    expect(future.commit()).toBe(true);
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(future.entry);
    expect(shared.current()).toBe(false);
    expect(shared.commit()).toBe(false);
    shared.lease.release(false);
    future.lease.release(false);
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(future.entry);
    f.store.destroyAll();
    expect(future.current()).toBe(false);
  } finally {
    f.dispose();
  }
});

it('publishes actual range edits without making metadata readers physical COW owners', async () => {
  const f = await fixture();
  const reads = new ShadowMeshReads(f.store.meshChanges);
  reads.add(f.first.changeToken);
  const accepted = f.store.meshChanges.epoch;
  const create = vi.spyOn(f.device, 'createBuffer');
  try {
    expect(reads.fixed).toBe(true);
    f.update().unwrap();
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(f.first);
    expect(create).not.toHaveBeenCalled();
    expect(f.store.meshChanges.query(accepted, reads.generation, reads.tokens)).toBe('content');
  } finally {
    reads.release();
    f.dispose();
  }
});

it('separates same-handle generations in distinct residency scopes while sharing bytes', async () => {
  const f = await fixture();
  const other = f.store.ensureResident(f.handle, f.current(), 1).unwrap();
  const a = new ShadowMeshReads(f.store.meshChanges),
    b = new ShadowMeshReads(f.store.meshChanges);
  a.add(f.first.changeToken);
  b.add(other.changeToken);
  const accepted = f.store.meshChanges.epoch;
  try {
    expect(f.first.changeToken).not.toBe(other.changeToken);
    expect(f.first.vertexBuffer).toBe(other.vertexBuffer);
    f.store.invalidateMesh(f.handle, 0);
    expect(f.store.getMeshGpuHandles(f.handle, 0)).toBeUndefined();
    expect(f.store.getMeshGpuHandles(f.handle, 1)).toBe(other);
    expect(f.store.meshChanges.query(accepted, a.generation, a.tokens)).toBe('invalidated');
    expect(f.store.meshChanges.query(accepted, b.generation, b.tokens)).toBe('quiet');
    expect(other.vertexBuffer.isDestroyed).toBe(false);
  } finally {
    a.release();
    b.release();
    f.dispose();
  }
});

it('stamps the old physical generation after a prepared commit already replaced its key', async () => {
  const f = await fixture();
  const reads = new ShadowMeshReads(f.store.meshChanges);
  reads.add(f.first.changeToken);
  const before = f.store.meshChanges.epoch;
  const next = createBoxGeometry(3, 4, 5).unwrap();
  const prepared = f.store.prepareMeshResidency(f.handle, next, 99).unwrap();
  try {
    expect(prepared.entry).not.toBe(f.first);
    expect(f.store.meshChanges.query(before, reads.generation, reads.tokens)).toBe('quiet');
    expect(prepared.commit()).toBe(true);
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(prepared.entry);
    expect(f.store.meshChanges.query(before, reads.generation, reads.tokens)).toBe('invalidated');
    expect(f.first.changeToken?.retired).toBe(true);
  } finally {
    prepared.lease.release(false);
    reads.release();
    f.dispose();
  }
});

it.each([false, true])('cleans a failed final Mesh admission (shared=%s)', async (shared) => {
  const f = await fixture();
  const box = createBoxGeometry(3, 4, 5).unwrap();
  assert(box.indices);
  // Distinct bytes in both streams; the shared arm retains both old buffers.
  const next = shared ? f.current() : { ...box, indices: box.indices.slice().reverse() };
  const handle = f.assets.create(next).unwrap();
  const buffers = vi.spyOn(f.device, 'createBuffer');
  const destroy = vi.spyOn(f.device, 'destroyBuffer');
  const fault = new Error('Mesh token admission failure');
  const admission = vi.spyOn(f.store.meshChanges, 'create').mockImplementationOnce(() => {
    throw fault;
  });
  try {
    expect(() => f.store.ensureResident(handle, next)).toThrow(fault);
    expect(f.store.getMeshGpuHandles(handle)).toBeUndefined();
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(f.first);
    expect(f.first.vertexBuffer.isDestroyed).toBe(false);
    expect(f.first.indexBuffer?.isDestroyed).toBe(false);
    expect(buffers).toHaveBeenCalledTimes(shared ? 0 : 2);
    expect(destroy).toHaveBeenCalledTimes(shared ? 0 : 2);
    for (const result of buffers.mock.results) {
      assert(result.type === 'return' && result.value.ok);
      expect(destroy).toHaveBeenCalledWith(result.value.value);
    }
    admission.mockRestore();
    const recovered = f.store.ensureResident(handle, next).unwrap();
    if (shared) {
      expect(recovered.vertexBuffer).toBe(f.first.vertexBuffer);
      expect(recovered.indexBuffer).toBe(f.first.indexBuffer);
    }
  } finally {
    admission.mockRestore();
    f.dispose();
  }
});

it('rejects owner retirement reentry before deleting a live source', async () => {
  const f = await fixture();
  const reads = new ShadowMeshReads(f.store.meshChanges);
  reads.add(f.first.changeToken);
  const accepted = f.store.meshChanges.epoch;
  f.update().unwrap();
  const has = vi.spyOn(reads.tokens, 'has').mockImplementationOnce(() => {
    expect(() => f.store.invalidateMesh(f.handle)).toThrow('reenter');
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(f.first);
    expect(f.first.vertexBuffer.isDestroyed).toBe(false);
    expect(f.first.changeToken?.retired).toBe(false);
    return true;
  });
  try {
    expect(f.store.meshChanges.query(accepted, reads.generation, reads.tokens)).toBe('content');
  } finally {
    has.mockRestore();
    reads.release();
    f.dispose();
  }
});

it('counts copy-on-write for a leased allocation, then in-place writes, and retires layout edits', async () => {
  const f = await fixture();
  const lease = f.store.retainMeshResidency(f.handle);
  assert(lease);
  const counters = f.store.meshChangeCounters;
  try {
    f.update().unwrap();
    expect(counters).toEqual({ inPlace: 0, copyOnWrite: 1, retired: 0 });
    // The fork is already the key's generation; no complete re-preparation follows.
    const create = vi.spyOn(f.device, 'createBuffer');
    const forked = f.store.getMeshGpuHandles(f.handle);
    assert(forked);
    expect(forked.vertexBuffer).not.toBe(f.first.vertexBuffer);
    expect(f.store.ensureResident(f.handle, f.current()).unwrap()).toBe(forked);
    expect(f.first.vertexBuffer.isDestroyed).toBe(false);
    f.update(Float32Array.of(1, 2, 3)).unwrap();
    expect(counters).toEqual({ inPlace: 1, copyOnWrite: 1, retired: 0 });
    expect(f.store.getMeshGpuHandles(f.handle)).toBe(forked);
    expect(create).not.toHaveBeenCalled();
    await lease.release(false);
    expect(f.first.vertexBuffer.isDestroyed).toBe(true);
    expect(forked.vertexBuffer.isDestroyed).toBe(false);
    // A complete replacement changes geometry fields and falls back to re-preparation.
    const observer = f.assets.observe().unwrap();
    f.assets.replace(f.handle, createBoxGeometry(3, 3, 3).unwrap()).unwrap();
    const batch = observer.read().unwrap();
    const change = batch.changes.find((item) => item.handle === f.handle);
    assert(change);
    f.store.adoptMeshChange(change, f.current()).unwrap();
    batch.accept();
    observer.dispose();
    expect(counters.retired).toBe(1);
    expect(f.store.getMeshGpuHandles(f.handle)).toBeUndefined();
  } finally {
    f.dispose();
  }
});
