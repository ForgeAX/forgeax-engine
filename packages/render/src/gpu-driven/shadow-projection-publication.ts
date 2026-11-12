import type { GpuDrivenBatch, SubmissionPlan } from './batch-topology';

/** Publish a uniquely owned map without exposing its mutation capability or copying entries. */
export function publishReadonlyMap<K, V>(owned: Map<K, V>): ReadonlyMap<K, V> {
  return Object.freeze(new ReadonlyMapPublication(owned));
}

/** Shared methods follow Map receiver semantics; the mutable capability stays private. */
class ReadonlyMapPublication<K, V> implements ReadonlyMap<K, V> {
  readonly #owned: Map<K, V>;

  constructor(owned: Map<K, V>) {
    this.#owned = owned;
  }

  get size(): number {
    return this.#owned.size;
  }

  get(key: K): V | undefined {
    return this.#owned.get(key);
  }

  has(key: K): boolean {
    return this.#owned.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#owned.entries();
  }

  keys(): MapIterator<K> {
    return this.#owned.keys();
  }

  values(): MapIterator<V> {
    return this.#owned.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#owned[Symbol.iterator]();
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#owned.forEach((value, key) => {
      callback.call(thisArg, value, key, this);
    });
  }
}
Object.freeze(ReadonlyMapPublication.prototype);

/**
 * Plans are immutable, and every view of a frame that last drew the same plan
 * compares it with the same successor: the verdict is computed once per pair.
 */
export function memoizedPlanPair(
  verdicts: WeakMap<SubmissionPlan, WeakMap<SubmissionPlan, boolean>>,
  left: SubmissionPlan,
  right: SubmissionPlan,
  compare: (left: SubmissionPlan, right: SubmissionPlan) => boolean,
): boolean {
  let known = verdicts.get(left);
  const verdict = known?.get(right);
  if (verdict !== undefined) return verdict;
  if (known === undefined) {
    known = new WeakMap();
    verdicts.set(left, known);
  }
  const computed = compare(left, right);
  known.set(right, computed);
  return computed;
}

const layoutVerdicts = new WeakMap<SubmissionPlan, WeakMap<SubmissionPlan, boolean>>();

/** Plan revision and wrapper identity do not change an otherwise identical shadow draw layout. */
export function sameShadowProjectionLayout(left: SubmissionPlan, right: SubmissionPlan): boolean {
  return left === right || memoizedPlanPair(layoutVerdicts, left, right, comparePlanLayout);
}

function comparePlanLayout(left: SubmissionPlan, right: SubmissionPlan): boolean {
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
    if (!sameCandidates(a.candidates, b.candidates)) return false;
  }
  return true;
}

function sameCandidates(
  left: GpuDrivenBatch['candidates'],
  right: GpuDrivenBatch['candidates'],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let member = 0; member < left.length; member++) {
    const before = left.at(member);
    const after = right.at(member);
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
  return true;
}
