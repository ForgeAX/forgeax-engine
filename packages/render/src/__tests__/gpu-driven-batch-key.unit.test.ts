import { describe, expect, it } from 'vitest';
import { capturedGpuDrivenBatchKey, captureMeshBatch } from '../gpu-driven/batch-key';
import type { GpuDrivenBatch, GpuDrivenBatchKey } from '../gpu-driven/batch-topology';

function key(): GpuDrivenBatchKey {
  return {
    assetHandle: 1,
    drawKind: 'indexed',
    first: 0,
    count: 3,
    baseVertex: 0,
    materialSlot: 0,
    topology: 'triangle-list',
    pipelineClass: 'material',
    materialResourceClass: 'resource',
  };
}

function batch(key: GpuDrivenBatchKey): GpuDrivenBatch {
  return {
    batchId: 0,
    generation: 0,
    key,
    candidates: [],
    visibleBase: 0,
    visibleCapacity: 0,
    indirectOffset: 0,
    contentEpoch: 0,
  };
}

describe('Mesh execution key capture', () => {
  it('retains a complete signature for producer-owned primitive data', () => {
    const owned = captureMeshBatch(batch(Object.freeze(key())));
    expect(Object.isFrozen(owned)).toBe(true);
    expect(capturedGpuDrivenBatchKey(owned)).toBe(JSON.stringify(owned.key));
    expect(capturedGpuDrivenBatchKey(Object.freeze({ ...owned }))).toBeUndefined();
  });

  it('leaves frozen accessors on the live serialization path without reading them', () => {
    let value = 'first',
      reads = 0;
    const ownedKey = Object.freeze({
      ...key(),
      get pipelineClass() {
        reads++;
        return value;
      },
    });
    const owned = captureMeshBatch(batch(ownedKey));
    expect(reads).toBe(0);
    expect(capturedGpuDrivenBatchKey(owned)).toBeUndefined();
    const first = JSON.stringify(owned.key);
    value = 'second';
    expect(JSON.stringify(owned.key)).not.toBe(first);
  });

  it('leaves nested mutable observations on the live serialization path', () => {
    const input = { ...key(), extra: { value: 1 } };
    const owned = captureMeshBatch(batch(Object.freeze(input)));
    expect(capturedGpuDrivenBatchKey(owned)).toBeUndefined();
    const first = JSON.stringify(owned.key);
    input.extra.value = 2;
    expect(JSON.stringify(owned.key)).not.toBe(first);
  });

  it('preserves custom serializers without running them during capture', () => {
    let value = 'first',
      calls = 0;
    const input = {
      ...key(),
      toJSON() {
        calls++;
        return value;
      },
    };
    const owned = captureMeshBatch(batch(Object.freeze(input)));
    expect(calls).toBe(0);
    expect(capturedGpuDrivenBatchKey(owned)).toBeUndefined();
    const first = JSON.stringify(owned.key);
    value = 'second';
    expect(JSON.stringify(owned.key)).not.toBe(first);
  });
  it('leaves inherited serializers on their live prototype path', () => {
    let value = 'first',
      calls = 0;
    const input = key();
    Object.setPrototypeOf(input, {
      toJSON() {
        calls++;
        return value;
      },
    });
    const owned = captureMeshBatch(batch(Object.freeze(input)));
    expect(calls).toBe(0);
    expect(capturedGpuDrivenBatchKey(owned)).toBeUndefined();
    const first = JSON.stringify(owned.key);
    value = 'second';
    expect(JSON.stringify(owned.key)).not.toBe(first);
  });
  it('does not freeze or capture a borrowed mutable key', () => {
    const input = { ...key() };
    const owned = captureMeshBatch(batch(input));
    expect(Object.isFrozen(input)).toBe(false);
    expect(capturedGpuDrivenBatchKey(owned)).toBeUndefined();
    const first = JSON.stringify(input);
    input.pipelineClass = 'changed';
    expect(JSON.stringify(input)).not.toBe(first);
  });

  it('does not read a batch accessor during capture', () => {
    let reads = 0;
    const input = batch(Object.freeze(key()));
    Object.defineProperty(input, 'key', {
      get() {
        reads++;
        return key();
      },
    });
    const owned = captureMeshBatch(input);
    expect(reads).toBe(0);
    expect(capturedGpuDrivenBatchKey(owned)).toBeUndefined();
  });
});
