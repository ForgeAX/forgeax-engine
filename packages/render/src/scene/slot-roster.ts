import { type Node, nodes, put, range, remove } from './frame-tree';

const PAGE_MAX = 128;
const PAGE_SPLIT = PAGE_MAX / 2;

/** Up to 128 ascending keys and their numeric values; a page is never written again. */
export interface RosterPage {
  readonly keys: Float64Array;
  readonly values: Float64Array;
}

/**
 * A persistent ascending `key -> value` roster: a treap of numeric pages keyed
 * by each page's first key, weighted by its entry count (`count` is the
 * roster size). One node and two typed arrays per page, never one node per
 * entry. Unchanged rosters keep their root identity.
 */
export type Roster = Node<RosterPage>;

function lowerBound(keys: Float64Array, key: number): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((keys[middle] as number) < key) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The page holding `key`'s position: the greatest first key <= key, else the first page. */
function pageNode(root: Roster, key: number): Roster {
  let node: Roster | undefined = root;
  let floor: Roster | undefined;
  let first: Roster = root;
  while (node !== undefined) {
    if (node.key <= key) {
      floor = node;
      node = node.right;
    } else {
      first = node;
      node = node.left;
    }
  }
  if (floor !== undefined) return floor;
  while (first.left !== undefined) first = first.left;
  return first;
}

function page(keys: Float64Array, values: Float64Array): RosterPage {
  return Object.freeze({ keys, values });
}

function place(root: Roster | undefined, value: RosterPage): Roster {
  return put(root, value, 0, value.keys[0] as number, value.keys.length);
}

export function rosterGet(root: Roster | undefined, key: number): number | undefined {
  if (root === undefined) return undefined;
  const { keys, values } = pageNode(root, key).value;
  const index = lowerBound(keys, key);
  return keys[index] === key ? (values[index] as number) : undefined;
}

export function rosterPut(root: Roster | undefined, key: number, value: number): Roster {
  if (root === undefined)
    return place(undefined, page(Float64Array.of(key), Float64Array.of(value)));
  const node = pageNode(root, key);
  const { keys, values } = node.value;
  const index = lowerBound(keys, key);
  if (keys[index] === key) {
    if (values[index] === value) return root;
    const nextValues = values.slice();
    nextValues[index] = value;
    return put(root, page(keys, nextValues), 0, node.key, keys.length);
  }
  const length = keys.length + 1;
  const nextKeys = new Float64Array(length);
  const nextValues = new Float64Array(length);
  nextKeys.set(keys.subarray(0, index));
  nextValues.set(values.subarray(0, index));
  nextKeys[index] = key;
  nextValues[index] = value;
  nextKeys.set(keys.subarray(index), index + 1);
  nextValues.set(values.subarray(index), index + 1);
  if (length > PAGE_MAX) {
    const rest = remove(root, 0, node.key);
    const left = page(nextKeys.slice(0, PAGE_SPLIT), nextValues.slice(0, PAGE_SPLIT));
    const right = page(nextKeys.slice(PAGE_SPLIT), nextValues.slice(PAGE_SPLIT));
    return place(place(rest, left), right);
  }
  const next = page(nextKeys, nextValues);
  // A smaller first key re-keys the first page.
  return index === 0 ? place(remove(root, 0, node.key), next) : place(root, next);
}

/** The roster's greatest key, or -Infinity when empty. */
export function rosterLastKey(root: Roster | undefined): number {
  let node = root;
  if (node === undefined) return Number.NEGATIVE_INFINITY;
  while (node.right !== undefined) node = node.right;
  const keys = node.value.keys;
  return keys[keys.length - 1] as number;
}

/**
 * Append interleaved `[key, value, ...]` entries whose keys ascend and exceed
 * every key in `root`: the last page is filled and full pages are placed,
 * instead of copying one page per entry.
 */
export function rosterAppend(
  root: Roster | undefined,
  entries: readonly number[],
): Roster | undefined {
  const count = entries.length / 2;
  if (count === 0) return root;
  let next = 0;
  let last: Roster | undefined = root;
  if (last !== undefined) while (last.right !== undefined) last = last.right;
  if (last !== undefined && last.value.keys.length < PAGE_MAX) {
    const { keys, values } = last.value;
    const length = Math.min(PAGE_MAX, keys.length + count);
    const nextKeys = new Float64Array(length);
    const nextValues = new Float64Array(length);
    nextKeys.set(keys);
    nextValues.set(values);
    for (let index = keys.length; index < length; index++, next++) {
      nextKeys[index] = entries[next * 2] as number;
      nextValues[index] = entries[next * 2 + 1] as number;
    }
    root = put(root, page(nextKeys, nextValues), 0, last.key, length);
  }
  while (next < count) {
    const length = Math.min(PAGE_MAX, count - next);
    const keys = new Float64Array(length);
    const values = new Float64Array(length);
    for (let index = 0; index < length; index++, next++) {
      keys[index] = entries[next * 2] as number;
      values[index] = entries[next * 2 + 1] as number;
    }
    root = place(root, page(keys, values));
  }
  return root;
}

/**
 * Insert interleaved `[key, value, ...]` entries in any order (a later entry
 * wins a repeated key). Entries above the roster's last key append whole
 * pages; a batch comparable to the roster rebuilds it in one ordered merge;
 * a small batch takes ordinary insertions.
 */
export function rosterMerge(
  root: Roster | undefined,
  entries: readonly number[],
): Roster | undefined {
  const count = entries.length / 2;
  if (count === 0) return root;
  let sorted = true;
  for (let index = 1; index < count && sorted; index++)
    sorted = (entries[index * 2] as number) > (entries[index * 2 - 2] as number);
  let ordered = entries;
  if (!sorted) {
    const order = Array.from({ length: count }, (_, index) => index);
    order.sort((a, b) => (entries[a * 2] as number) - (entries[b * 2] as number) || a - b);
    const next: number[] = [];
    for (let index = 0; index < count; index++) {
      const at = order[index] as number;
      const key = entries[at * 2] as number;
      // Stable order: the later duplicate replaces the earlier one.
      if (next.length > 0 && next[next.length - 2] === key)
        next[next.length - 1] = entries[at * 2 + 1] as number;
      else next.push(key, entries[at * 2 + 1] as number);
    }
    ordered = next;
  }
  if ((ordered[0] as number) > rosterLastKey(root)) return rosterAppend(root, ordered);
  const existing = root?.count ?? 0;
  if (ordered.length / 2 < existing / 4) {
    for (let index = 0; index < ordered.length; index += 2)
      root = rosterPut(root, ordered[index] as number, ordered[index + 1] as number);
    return root;
  }
  const merged: number[] = [];
  const cursor = new RosterCursor(root);
  let more = cursor.next();
  let at = 0;
  while (more || at < ordered.length) {
    const next = at < ordered.length ? (ordered[at] as number) : Number.POSITIVE_INFINITY;
    if (more && cursor.key < next) {
      merged.push(cursor.key, cursor.value);
      more = cursor.next();
      continue;
    }
    if (more && cursor.key === next) more = cursor.next();
    merged.push(next, ordered[at + 1] as number);
    at += 2;
  }
  return rosterAppend(undefined, merged);
}

export function rosterRemove(root: Roster | undefined, key: number): Roster | undefined {
  if (root === undefined) return undefined;
  const node = pageNode(root, key);
  const { keys, values } = node.value;
  const index = lowerBound(keys, key);
  if (keys[index] !== key) return root;
  const rest = remove(root, 0, node.key);
  if (keys.length === 1) return rest;
  const nextKeys = new Float64Array(keys.length - 1);
  const nextValues = new Float64Array(keys.length - 1);
  nextKeys.set(keys.subarray(0, index));
  nextValues.set(values.subarray(0, index));
  nextKeys.set(keys.subarray(index + 1), index);
  nextValues.set(values.subarray(index + 1), index);
  return place(rest, page(nextKeys, nextValues));
}

/** Values of the entries ranked `[start, end)`, visiting only the pages they occupy. */
export function* rosterValues(
  root: Roster | undefined,
  start = 0,
  end = Number.POSITIVE_INFINITY,
): Generator<number> {
  for (const run of range(root, start, Math.min(end, root?.count ?? 0))) {
    const values = run.value.values;
    for (let index = run.start; index < run.end; index++) yield values[index] as number;
  }
}

/**
 * Ascending entries; each step reuses one result object (consumers read the
 * entry before the next step), so a walk allocates per walk, not per entry.
 */
export class RosterCursor {
  key = 0;
  value = 0;
  private readonly pages: IterableIterator<Node<RosterPage>>;
  private current: RosterPage | undefined;
  private index = 0;
  constructor(root: Roster | undefined) {
    this.pages = nodes(root);
  }
  /** Advance to the next entry; false after the last one. */
  next(): boolean {
    for (;;) {
      const current = this.current;
      if (current !== undefined && this.index < current.keys.length) {
        this.key = current.keys[this.index] as number;
        this.value = current.values[this.index] as number;
        this.index++;
        return true;
      }
      const next = this.pages.next();
      if (next.done === true) return false;
      this.current = next.value.value;
      this.index = 0;
    }
  }
}
