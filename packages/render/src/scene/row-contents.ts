import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';

/**
 * The drawable facts of one row without its identity and pose. Rows whose
 * facts are equal field by field (arrays element by element) share one value.
 */
export type RowContent = Omit<RenderableSnapshot, 'worldId' | 'entityKey' | 'transform'>;

const EXCLUDED = new Set(['worldId', 'entityKey', 'transform', 'temporal']);
const RECENT_LIMIT = 64;

function token(value: unknown): string {
  switch (typeof value) {
    case 'undefined':
      return 'u';
    case 'number':
      return Object.is(value, -0) ? 'n-0' : `n${value}`;
    case 'boolean':
      return value ? 't' : 'f';
    case 'string':
      return `s${value.length}:${value}`;
    case 'object':
      return value === null ? 'z' : `o${getOpaqueResourceIdentity(value)}`;
    default:
      return `x${String(value)}`;
  }
}

/** Do two owned sources carry the same drawable field references? */
function sameFields(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  let count = 0;
  for (const field in a) {
    if (EXCLUDED.has(field)) continue;
    const value = a[field];
    if (value === undefined) continue;
    if (b[field] !== value) return false;
    count++;
  }
  for (const field in b) if (!EXCLUDED.has(field) && b[field] !== undefined) count--;
  return count === 0;
}

interface Interned<T> {
  readonly value: T;
  readonly key: string;
  holders: number;
}

function arrayKey(field: string, value: readonly unknown[]): string {
  let key = `${field}:${value.length}`;
  for (const element of value) key += `,${token(element)}`;
  return key;
}

/**
 * Reference-counted shared row contents. Arrays are interned per field by their
 * elements first, so rows (and distinct contents) carrying equal lists hold one
 * list and list identity still means list equality within that field.
 */
export class RowContents {
  private readonly contents = new Map<string, Interned<RowContent>>();
  private readonly byContent = new WeakMap<RowContent, Interned<RowContent>>();
  private readonly arrays = new Map<string, Interned<readonly unknown[]>>();
  private readonly byArray = new WeakMap<readonly unknown[], Interned<readonly unknown[]>>();
  /** Recent sources by their `materials` list identity; bounded, never a row index. */
  private readonly recent = new Map<
    unknown,
    { readonly source: Record<string, unknown>; readonly entry: Interned<RowContent> }
  >();

  get size(): number {
    return this.contents.size;
  }

  private shareArray(field: string, value: readonly unknown[]): Interned<readonly unknown[]> {
    const known = this.byArray.get(value);
    if (
      known !== undefined &&
      this.arrays.get(known.key) === known &&
      known.key.startsWith(`${field}:`)
    )
      return known;
    const key = arrayKey(field, value);
    let entry = this.arrays.get(key);
    if (entry === undefined) {
      entry = { value, key, holders: 0 };
      this.arrays.set(key, entry);
      this.byArray.set(value, entry);
    }
    return entry;
  }

  /**
   * The shared content of `snapshot`'s drawable facts; release it with {@link release}.
   * Bulk admission stages many rows from one template: rows whose field values
   * are the same references as a recent row's reuse its content after one
   * shallow comparison, without rebuilding the key.
   */
  acquire(snapshot: RenderableSnapshot | RowContent): RowContent {
    const source = snapshot as unknown as Record<string, unknown>;
    const probe = source.materials;
    const recent = probe === undefined ? undefined : this.recent.get(probe);
    if (
      recent !== undefined &&
      this.contents.get(recent.entry.key) === recent.entry &&
      sameFields(source, recent.source)
    ) {
      recent.entry.holders++;
      return recent.entry.value;
    }
    const entry = this.acquireKeyed(source);
    if (probe !== undefined) {
      if (this.recent.size >= RECENT_LIMIT) this.recent.clear();
      this.recent.set(probe, { source, entry });
    }
    return entry.value;
  }

  private acquireKeyed(source: Record<string, unknown>): Interned<RowContent> {
    let key = '';
    let shared: Record<string, Interned<readonly unknown[]>> | undefined;
    for (const field in source) {
      if (EXCLUDED.has(field)) continue;
      const value = source[field];
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        const entry = this.shareArray(field, value);
        shared ??= {};
        shared[field] = entry;
        key += `${field}=${token(entry.value)};`;
      } else key += `${field}=${token(value)};`;
    }
    let entry = this.contents.get(key);
    if (entry === undefined) {
      const content: Record<string, unknown> = {};
      for (const field in source) {
        if (EXCLUDED.has(field)) continue;
        const value = source[field];
        if (value === undefined) continue;
        const array = shared?.[field];
        if (array !== undefined) array.holders++;
        content[field] = array === undefined ? value : array.value;
      }
      const value = Object.freeze(content) as unknown as RowContent;
      entry = { value, key, holders: 0 };
      this.contents.set(key, entry);
      this.byContent.set(value, entry);
    }
    entry.holders++;
    return entry;
  }

  release(content: RowContent): void {
    const entry = this.byContent.get(content);
    if (entry === undefined || this.contents.get(entry.key) !== entry) return;
    if (--entry.holders !== 0) return;
    this.contents.delete(entry.key);
    const source = content as unknown as Record<string, unknown>;
    for (const field in source) {
      const value = source[field];
      if (!Array.isArray(value)) continue;
      const key = arrayKey(field, value);
      const array = this.arrays.get(key);
      if (array?.value === value && --array.holders === 0) this.arrays.delete(key);
    }
  }

  clear(): void {
    this.recent.clear();
    this.contents.clear();
    this.arrays.clear();
  }
}
