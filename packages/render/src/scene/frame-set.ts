import { changes, type Node, put, remove } from './frame-tree';

const PAGE_BITS = 1024;
const PAGE_WORDS = PAGE_BITS / 32;

const EMPTY_KEY_RESULT = Object.freeze({ value: undefined, done: true as const });
const EMPTY_KEYS: IterableIterator<number> = Object.freeze({
  next: () => EMPTY_KEY_RESULT,
  return: () => EMPTY_KEY_RESULT,
  [Symbol.iterator]: () => EMPTY_KEYS,
});

function popcount(word: number): number {
  word -= (word >>> 1) & 0x55555555;
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
  return (Math.imul((word + (word >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) as number;
}

function visitBits(page: number, word: number, bits: number, visit: (key: number) => void): void {
  while (bits !== 0) {
    const low = bits & -bits;
    visit(page * PAGE_BITS + word * 32 + (31 - Math.clz32(low)));
    bits ^= low;
  }
}

/**
 * Fixed numeric membership as a persistent tree of 1024-bit pages: one node and
 * one bitmap per occupied page, not per key. A known addition/removal copies
 * one bitmap and its page path; earlier frames keep their own pages.
 */
export class FrameSet implements ReadonlySet<number> {
  readonly [Symbol.toStringTag] = 'FrameSet';
  #root: Node<Uint32Array> | undefined;
  constructor() {
    Object.freeze(this);
  }
  /** Only this intrinsic fixed representation may bypass raw input observation. */
  static isFixed(value: unknown): value is FrameSet {
    return (
      typeof value === 'object' &&
      value !== null &&
      #root in value &&
      Object.getPrototypeOf(value) === FrameSet.prototype
    );
  }
  static #from(root: Node<Uint32Array> | undefined): FrameSet {
    const value = new FrameSet();
    value.#root = root;
    return value;
  }
  /** One fixed set over ascending or unordered keys, built page by page. */
  static from(keys: Iterable<number>): FrameSet {
    const pages = new Map<number, Uint32Array>();
    for (const key of keys) {
      if (!Number.isSafeInteger(key) || key < 0)
        throw new RangeError('FrameSet keys are non-negative safe integers');
      const page = Math.floor(key / PAGE_BITS);
      let bits = pages.get(page);
      if (bits === undefined) {
        bits = new Uint32Array(PAGE_WORDS);
        pages.set(page, bits);
      }
      const lane = key - page * PAGE_BITS;
      bits[lane >>> 5] = ((bits[lane >>> 5] as number) | (1 << (lane & 31))) >>> 0;
    }
    let root: Node<Uint32Array> | undefined;
    for (const [page, bits] of pages) {
      let weight = 0;
      for (let word = 0; word < PAGE_WORDS; word++) weight += popcount(bits[word] as number);
      root = put(root, bits, 0, page, weight);
    }
    return FrameSet.#from(root);
  }
  #page(page: number): Node<Uint32Array> | undefined {
    let node = this.#root;
    while (node !== undefined) {
      if (node.key === page) return node;
      node = page < node.key ? node.left : node.right;
    }
    return undefined;
  }
  get size(): number {
    return this.#root?.count ?? 0;
  }
  /** The key at its ascending rank, without materializing a dense key array. */
  at(index: number): number | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.size;
    if (index < 0 || index >= this.size) return undefined;
    let node = this.#root;
    while (node !== undefined) {
      const left = node.left?.count ?? 0;
      if (index < left) node = node.left;
      else if (index >= left + node.weight) {
        index -= left + node.weight;
        node = node.right;
      } else {
        index -= left;
        for (let word = 0; word < PAGE_WORDS; word++) {
          let bits = node.value[word] as number;
          const count = popcount(bits);
          if (index >= count) {
            index -= count;
            continue;
          }
          while (index-- > 0) bits &= bits - 1;
          return node.key * PAGE_BITS + word * 32 + 31 - Math.clz32(bits & -bits);
        }
        return undefined;
      }
    }
    return undefined;
  }
  has(key: number): boolean {
    if (!Number.isSafeInteger(key) || key < 0) return false;
    const page = Math.floor(key / PAGE_BITS);
    const bits = this.#page(page)?.value;
    if (bits === undefined) return false;
    const lane = key - page * PAGE_BITS;
    return (((bits[lane >>> 5] as number) >>> (lane & 31)) & 1) === 1;
  }
  #flip(key: number, present: boolean): FrameSet {
    const page = Math.floor(key / PAGE_BITS);
    const node = this.#page(page);
    const lane = key - page * PAGE_BITS;
    const bits = node === undefined ? new Uint32Array(PAGE_WORDS) : node.value.slice();
    const word = lane >>> 5;
    const mask = 1 << (lane & 31);
    bits[word] = (present ? (bits[word] as number) | mask : (bits[word] as number) & ~mask) >>> 0;
    const weight = (node?.weight ?? 0) + (present ? 1 : -1);
    return FrameSet.#from(
      weight === 0 ? remove(this.#root, 0, page) : put(this.#root, bits, 0, page, weight),
    );
  }
  with(key: number): FrameSet {
    if (!Number.isSafeInteger(key) || key < 0)
      throw new RangeError('FrameSet keys are non-negative safe integers');
    return this.has(key) ? this : this.#flip(key, true);
  }
  without(key: number): FrameSet {
    return this.has(key) ? this.#flip(key, false) : this;
  }
  /**
   * Apply many membership edits at once (last edit per key wins): each touched
   * bitmap page and its path are copied once, not once per key.
   */
  edit(edits: ReadonlyMap<number, boolean>): FrameSet {
    const pages = new Map<number, { bits: Uint32Array; weight: number }>();
    edits.forEach((present, key) => {
      if (!Number.isSafeInteger(key) || key < 0)
        throw new RangeError('FrameSet keys are non-negative safe integers');
      const page = Math.floor(key / PAGE_BITS);
      let edited = pages.get(page);
      if (edited === undefined) {
        const node = this.#page(page);
        edited = {
          bits: node === undefined ? new Uint32Array(PAGE_WORDS) : node.value.slice(),
          weight: node?.weight ?? 0,
        };
        pages.set(page, edited);
      }
      const lane = key - page * PAGE_BITS;
      const word = lane >>> 5;
      const mask = 1 << (lane & 31);
      const before = edited.bits[word] as number;
      const after = (present ? before | mask : before & ~mask) >>> 0;
      if (after === before >>> 0) return;
      edited.bits[word] = after;
      edited.weight += present ? 1 : -1;
    });
    let root = this.#root;
    pages.forEach(({ bits, weight }, page) => {
      const node = this.#page(page);
      if (node !== undefined && node.weight === weight) {
        let same = true;
        for (let word = 0; word < PAGE_WORDS && same; word++)
          same = node.value[word] === bits[word];
        if (same) return;
      }
      if (node === undefined && weight === 0) return;
      root = weight === 0 ? remove(root, 0, page) : put(root, bits, 0, page, weight);
    });
    return root === this.#root ? this : FrameSet.#from(root);
  }
  /** Visit each key present in exactly one of `before` and this set; shared pages are skipped. */
  changesSince(before: FrameSet, visit: (key: number) => void): void {
    changes(before.#root, this.#root, (left, right, page) => {
      for (let word = 0; word < PAGE_WORDS; word++) {
        const bits = ((left?.[word] ?? 0) ^ (right?.[word] ?? 0)) >>> 0;
        if (bits !== 0) visitBits(page, word, bits, visit);
      }
    });
  }
  /** Fixed ascending keys with one borrowed result per cursor; read it before advancing. */
  borrowKeys(): IterableIterator<number> {
    return this.#root === undefined ? EMPTY_KEYS : new FrameSetKeyCursor(this.#root);
  }
  *values(): SetIterator<number> {
    // Preserve ordinary Set iterator result lifetime at this public boundary.
    for (const key of this.borrowKeys()) yield key;
  }
  keys(): SetIterator<number> {
    return this.values();
  }
  [Symbol.iterator](): SetIterator<number> {
    return this.values();
  }
  *entries(): SetIterator<[number, number]> {
    for (const key of this) yield [key, key];
  }
  forEach(
    callback: (value: number, key: number, set: ReadonlySet<number>) => void,
    thisArg?: unknown,
  ): void {
    for (const key of this.borrowKeys()) callback.call(thisArg, key, key, this);
  }
}

/** One bitmap walk; row consumers need no generator result for each key. */
class FrameSetKeyCursor implements IterableIterator<number> {
  #root: Node<Uint32Array> | undefined;
  readonly #pending: Node<Uint32Array>[] = [];
  #page: Uint32Array | undefined;
  #word = PAGE_WORDS;
  #bits = 0;
  #base = 0;
  readonly #result: { value: number | undefined; done: boolean } = {
    value: undefined,
    done: false,
  };
  constructor(root: Node<Uint32Array> | undefined) {
    this.#root = root;
  }
  next(): IteratorResult<number> {
    if (this.#result.done) return this.#result as IteratorResult<number>;
    while (this.#bits === 0) {
      if (this.#word === PAGE_WORDS) {
        const page = this.nextPage();
        if (page === undefined) return this.return();
        this.#page = page.value;
        this.#base = page.key * PAGE_BITS;
        this.#word = 0;
      }
      const page = this.#page;
      if (page === undefined) throw new Error('A live key cursor must hold its bitmap page');
      this.#bits = page[this.#word++] as number;
    }
    const low = this.#bits & -this.#bits;
    this.#bits ^= low;
    this.#result.value = this.#base + (this.#word - 1) * 32 + 31 - Math.clz32(low);
    return this.#result as IteratorResult<number>;
  }
  private nextPage(): Node<Uint32Array> | undefined {
    let node = this.#root;
    while (node !== undefined) {
      this.#pending.push(node);
      node = node.left;
    }
    const page = this.#pending.pop();
    this.#root = page?.right;
    return page;
  }
  return(): IteratorResult<number> {
    this.#root = undefined;
    this.#pending.length = 0;
    this.#page = undefined;
    this.#bits = 0;
    this.#result.value = undefined;
    this.#result.done = true;
    return this.#result as IteratorResult<number>;
  }
  [Symbol.iterator](): IterableIterator<number> {
    return this;
  }
}

/** Fixed intersection derived from two membership roots; only their changed keys are reconsidered. */
export class FrameIntersection {
  private before:
    | { readonly left: FrameSet; readonly right: FrameSet; readonly value: FrameSet }
    | undefined;

  sync(left: FrameSet, right: FrameSet): FrameSet {
    const before = this.before;
    if (before?.left === left && before.right === right) return before.value;
    let value: FrameSet;
    if (before === undefined) {
      const smaller = left.size <= right.size ? left : right;
      const other = smaller === left ? right : left;
      value = FrameSet.from(
        (function* () {
          for (const key of smaller.borrowKeys()) if (other.has(key)) yield key;
        })(),
      );
    } else {
      const edits = new Map<number, boolean>();
      const changed = (key: number) => edits.set(key, left.has(key) && right.has(key));
      left.changesSince(before.left, changed);
      right.changesSince(before.right, changed);
      value = before.value.edit(edits);
    }
    this.before = { left, right, value };
    return value;
  }
}
