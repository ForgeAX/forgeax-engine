/** Immutable membership for the common single-material lane; no hash table is needed. */
export class SingleMaterialHandleSet implements ReadonlySet<number> {
  readonly onlyHandle: number;

  constructor(handle: number) {
    this.onlyHandle = handle === 0 ? 0 : handle;
    Object.freeze(this);
  }

  get size(): number {
    return 1;
  }
  get [Symbol.toStringTag](): string {
    return 'Set';
  }
  has(handle: number): boolean {
    return handle === this.onlyHandle || Object.is(handle, this.onlyHandle);
  }
  *values(): SetIterator<number> {
    yield this.onlyHandle;
    return undefined;
  }
  keys(): SetIterator<number> {
    return this.values();
  }
  [Symbol.iterator](): SetIterator<number> {
    return this.values();
  }
  *entries(): SetIterator<[number, number]> {
    yield [this.onlyHandle, this.onlyHandle];
    return undefined;
  }
  forEach(
    callback: (value: number, key: number, set: ReadonlySet<number>) => void,
    thisArg?: unknown,
  ): void {
    callback.call(thisArg, this.onlyHandle, this.onlyHandle, this);
  }
}
