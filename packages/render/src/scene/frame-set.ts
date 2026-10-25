import { changes, type Node, put, remove } from './frame-tree';

const PAGE_BITS = 1024;
const PAGE_WORDS = PAGE_BITS / 32;

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
  *values(): SetIterator<number> {
    const pending: Node<Uint32Array>[] = [];
    let node = this.#root;
    while (node !== undefined || pending.length > 0) {
      while (node !== undefined) {
        pending.push(node);
        node = node.left;
      }
      const current = pending.pop();
      if (current === undefined) return;
      const base = current.key * PAGE_BITS;
      for (let word = 0; word < PAGE_WORDS; word++) {
        let bits = current.value[word] as number;
        while (bits !== 0) {
          const low = bits & -bits;
          yield base + word * 32 + (31 - Math.clz32(low));
          bits ^= low;
        }
      }
      node = current.right;
    }
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
    for (const key of this) callback.call(thisArg, key, key, this);
  }
}
