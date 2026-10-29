/** Weak content index; actual handles and active owners retain each record.
 * There is no additional device-lifetime strong reuse cache. Dead keys are
 * removed by finalization and opportunistically during snapshots/lookups. */
export class PipelineResourceIndex<T extends object> {
  private next = 0;
  private readonly rows = new Map<number, WeakRef<T>>();
  private readonly keys = new Map<string, { id: number; ref: WeakRef<T> }>();
  private owners = new WeakMap<object, T>();
  private readonly finalizer = new FinalizationRegistry<{ id: number; key: string }>(
    ({ id, key }) => {
      this.rows.delete(id);
      if (this.keys.get(key)?.id === id) this.keys.delete(key);
    },
  );

  get length(): number {
    return [...this.values()].length;
  }
  get size(): number {
    return this.length;
  }

  get(id: number): T | undefined {
    return this.rows.get(id)?.deref();
  }
  find(key: string): T | undefined {
    const item = this.keys.get(key);
    const value = item?.ref.deref();
    if (item !== undefined && value === undefined) {
      this.keys.delete(key);
      this.rows.delete(item.id);
    }
    return value;
  }
  add(key: string, value: T): number {
    const id = this.next++;
    const ref = new WeakRef(value);
    this.rows.set(id, ref);
    this.keys.set(key, { id, ref });
    this.finalizer.register(value, { id, key });
    return id;
  }
  own(handle: object, value: T): void {
    this.owners.set(handle, value);
  }
  *values(): IterableIterator<T> {
    for (const [id, ref] of this.rows) {
      const value = ref.deref();
      if (value === undefined) this.rows.delete(id);
      else yield value;
    }
    for (const [key, item] of this.keys) if (item.ref.deref() === undefined) this.keys.delete(key);
  }
  clear(): void {
    this.rows.clear();
    this.keys.clear();
    this.owners = new WeakMap();
  }
}

export function pipelineResource<T extends object>(rows: PipelineResourceIndex<T>, id: number): T {
  const value = rows.get(id);
  if (value === undefined) throw new Error('Pipeline dependency is no longer retained');
  return value;
}
