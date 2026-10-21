import type { GpuDrivenBatch, GpuDrivenBatchKey } from './batch-topology';

const capturedBatchKeys = new WeakMap<GpuDrivenBatch, string>();

/** Finish the Mesh owner's batch without admitting borrowed or accessor keys. */
export function captureMeshBatch(batch: GpuDrivenBatch): GpuDrivenBatch {
  Object.freeze(batch);
  if (!Object.values(Object.getOwnPropertyDescriptors(batch)).every((field) => 'value' in field))
    return batch;
  const key: GpuDrivenBatchKey | undefined = Object.getOwnPropertyDescriptor(batch, 'key')?.value;
  if (key === undefined || !Object.isFrozen(key)) return batch;
  const prototype = Object.getPrototypeOf(key);
  if (prototype !== null && prototype !== Object.prototype) return batch;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(key));
  if (
    descriptors.every((field) => {
      const kind = typeof field.value;
      return (
        'value' in field &&
        (field.value === null ||
          kind === 'undefined' ||
          kind === 'boolean' ||
          kind === 'number' ||
          kind === 'string')
      );
    })
  ) {
    capturedBatchKeys.set(batch, JSON.stringify(key));
  }
  return batch;
}

/** A frozen caller copy does not inherit the producer's captured key. */
export function capturedGpuDrivenBatchKey(batch: GpuDrivenBatch): string | undefined {
  return capturedBatchKeys.get(batch);
}
