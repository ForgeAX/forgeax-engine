/** A binary min-heap on a numeric key. */
export class MinHeap<T> {
  private readonly items: { key: number; value: T }[] = [];

  get size(): number {
    return this.items.length;
  }

  /** The smallest key, or `Infinity` when empty. */
  get minKey(): number {
    return this.items.length === 0 ? Infinity : (this.items[0] as { key: number }).key;
  }

  push(key: number, value: T): void {
    const a = this.items;
    a.push({ key, value });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((a[p] as { key: number }).key <= (a[i] as { key: number }).key) break;
      [a[p], a[i]] = [a[i] as (typeof a)[number], a[p] as (typeof a)[number]];
      i = p;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0] as { value: T };
    const last = a.pop() as (typeof a)[number];
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && (a[l] as { key: number }).key < (a[m] as { key: number }).key) m = l;
        if (r < a.length && (a[r] as { key: number }).key < (a[m] as { key: number }).key) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i] as (typeof a)[number], a[m] as (typeof a)[number]];
        i = m;
      }
    }
    return top.value;
  }
}
