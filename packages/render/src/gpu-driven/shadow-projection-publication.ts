import type { SubmissionPlan } from './batch-topology';

/** Publish a uniquely owned map without exposing its mutation capability or copying entries. */
export function publishReadonlyMap<K, V>(owned: Map<K, V>): ReadonlyMap<K, V> {
  const publication: ReadonlyMap<K, V> = Object.freeze({
    get size() {
      return owned.size;
    },
    get: (key: K) => owned.get(key),
    has: (key: K) => owned.has(key),
    entries: () => owned.entries(),
    keys: () => owned.keys(),
    values: () => owned.values(),
    [Symbol.iterator]: () => owned[Symbol.iterator](),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      owned.forEach((value, key) => {
        callback.call(thisArg, value, key, publication);
      });
    },
  });
  return publication;
}

/** Plan revision and wrapper identity do not change an otherwise identical shadow draw layout. */
export function sameShadowProjectionLayout(left: SubmissionPlan, right: SubmissionPlan): boolean {
  if (left === right) return true;
  if (left.batches.length !== right.batches.length) return false;
  for (let index = 0; index < left.batches.length; index++) {
    const a = left.batches.at(index);
    const b = right.batches.at(index);
    if (a === b) continue;
    if (
      a === undefined ||
      b === undefined ||
      a.batchId !== b.batchId ||
      a.generation !== b.generation ||
      a.contentEpoch !== b.contentEpoch ||
      a.key !== b.key ||
      a.prepared !== b.prepared ||
      a.lod !== b.lod ||
      a.visibleBase !== b.visibleBase ||
      a.indirectOffset !== b.indirectOffset ||
      (a.visibleAllocationCapacity ?? a.visibleCapacity) !==
        (b.visibleAllocationCapacity ?? b.visibleCapacity)
    )
      return false;
    if (a.candidates === b.candidates) continue;
    if (a.candidates.length !== b.candidates.length) return false;
    for (let member = 0; member < a.candidates.length; member++) {
      const before = a.candidates.at(member);
      const after = b.candidates.at(member);
      if (before === after) continue;
      if (
        before === undefined ||
        after === undefined ||
        before.primitiveIndex !== after.primitiveIndex ||
        before.generation !== after.generation ||
        before.drawItemIndex !== after.drawItemIndex ||
        before.instanceOrdinal !== after.instanceOrdinal
      )
        return false;
    }
  }
  return true;
}
