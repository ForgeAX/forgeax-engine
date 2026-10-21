/** A lookup's first key needs no separate hash table; further keys keep Map semantics. */
export class FirstEntryMap<K, V> {
  private occupied = false;
  private key: K | undefined;
  private value: V | undefined;
  private overflow: Map<K, V> | undefined;

  get(key: K): V | undefined {
    if (this.occupied && (key === this.key || Object.is(key, this.key))) return this.value;
    return this.overflow?.get(key);
  }

  has(key: K): boolean {
    return (
      (this.occupied && (key === this.key || Object.is(key, this.key))) ||
      (this.overflow?.has(key) ?? false)
    );
  }

  *values(): IterableIterator<V> {
    if (this.occupied) yield this.value as V;
    if (this.overflow !== undefined) yield* this.overflow.values();
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    if (this.occupied) yield [this.key as K, this.value as V];
    if (this.overflow !== undefined) yield* this.overflow;
  }

  forEach(callback: (value: V, key: K) => void): void {
    if (this.occupied) callback(this.value as V, this.key as K);
    this.overflow?.forEach(callback);
  }

  set(key: K, value: V): this {
    if (!this.occupied || key === this.key || Object.is(key, this.key)) {
      this.occupied = true;
      this.key = (typeof key === 'number' && key === 0 ? 0 : key) as K;
      this.value = value;
    } else {
      this.overflow ??= new Map();
      this.overflow.set(key, value);
    }
    return this;
  }
}
