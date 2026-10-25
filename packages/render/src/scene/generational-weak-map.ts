/**
 * Identity memo for keys that are replaced continuously, such as per-frame
 * snapshots and Scene slots.
 *
 * A long-lived `WeakMap` keeps an entry for every key it has seen until the
 * next full collection. When such a key has died but its value is an object
 * owned only by the entry, V8 cannot resolve the ephemeron: the entry is
 * revisited in every fixpoint iteration of the MajorGC atomic pause and in its
 * linear fallback. The pause then grows with the insert churn since the last
 * MajorGC instead of with the live heap.
 *
 * This map keeps two generations. A hit in the previous generation is carried
 * into the current one. Once the current generation has received as many fresh
 * keys as it carried (and at least `minimumFresh`), the previous generation is
 * dropped as a whole; an unreachable table costs the collector nothing. A key
 * that is used at least once per generation keeps its exact value, so identity
 * reuse is preserved. A key unused for a whole generation is forgotten and its
 * value is derived again on next use, which every caller must already accept
 * from a cache miss.
 *
 * `undefined` values are not supported: `get` returning `undefined` means miss.
 */
export class GenerationalWeakMap<K extends WeakKey, V> {
  #current = new WeakMap<K, V>();
  #previous = new WeakMap<K, V>();
  #fresh = 0;
  #carried = 0;
  readonly #minimumFresh: number;

  constructor(minimumFresh = 1024) {
    this.#minimumFresh = minimumFresh;
  }

  get(key: K): V | undefined {
    const value = this.#current.get(key);
    if (value !== undefined) return value;
    const previous = this.#previous.get(key);
    if (previous !== undefined) {
      this.#current.set(key, previous);
      this.#carried++;
    }
    return previous;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): this {
    if (!this.#current.has(key)) {
      if (this.#fresh >= Math.max(this.#minimumFresh, this.#carried)) this.#rotate();
      this.#fresh++;
    }
    this.#current.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    const current = this.#current.delete(key);
    const previous = this.#previous.delete(key);
    return current || previous;
  }

  #rotate(): void {
    this.#previous = this.#current;
    this.#current = new WeakMap();
    this.#fresh = 0;
    this.#carried = 0;
  }
}

const ordinals = new WeakMap<object, number>();
let nextOrdinal = 1;

/**
 * A small-integer identity for an object, so a memo entry can name the object
 * it was derived from without retaining it. Integer values never make an
 * ephemeron unresolvable.
 */
export function identityOrdinal(value: object): number {
  let ordinal = ordinals.get(value);
  if (ordinal === undefined) {
    ordinal = nextOrdinal++;
    ordinals.set(value, ordinal);
  }
  return ordinal;
}

/** Most versions one key keeps; a key alternating between more versions re-derives the oldest. */
const MAX_VERSIONS = 4;

/** Entry of `key` derived from `version` (an `identityOrdinal`), if still cached. */
export function versionedGet<K extends WeakKey, E extends { readonly version: number }>(
  map: GenerationalWeakMap<K, readonly E[]>,
  key: K,
  version: number,
): E | undefined {
  const entries = map.get(key);
  if (entries === undefined) return undefined;
  for (const entry of entries) if (entry.version === version) return entry;
  return undefined;
}

/** Cache `entry` for `key`, replacing an entry of the same version. */
export function versionedSet<K extends WeakKey, E extends { readonly version: number }>(
  map: GenerationalWeakMap<K, readonly E[]>,
  key: K,
  entry: E,
): void {
  const others = (map.get(key) ?? []).filter((other) => other.version !== entry.version);
  map.set(key, [entry, ...others.slice(0, MAX_VERSIONS - 1)]);
}
