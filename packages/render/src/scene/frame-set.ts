import { type Node, put, remove } from './frame-tree';

/** Fixed numeric membership; known additions/removals copy only their tree path. */
export class FrameSet implements ReadonlySet<number> {
  readonly [Symbol.toStringTag] = 'FrameSet';
  #root: Node<number> | undefined;
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
  static #from(root: Node<number> | undefined): FrameSet {
    const value = new FrameSet();
    value.#root = root;
    return value;
  }
  get size(): number {
    return this.#root?.count ?? 0;
  }
  has(key: number): boolean {
    let node = this.#root;
    while (node !== undefined) {
      if (node.key === key) return true;
      node = key < node.key ? node.left : node.right;
    }
    return false;
  }
  with(key: number): FrameSet {
    if (!Number.isSafeInteger(key) || key < 0)
      throw new RangeError('FrameSet keys are non-negative safe integers');
    return this.has(key) ? this : FrameSet.#from(put(this.#root, key, 0, key, 1));
  }
  without(key: number): FrameSet {
    return this.has(key) ? FrameSet.#from(remove(this.#root, 0, key)) : this;
  }
  *values(): SetIterator<number> {
    const pending: Node<number>[] = [];
    let node = this.#root;
    while (node !== undefined || pending.length > 0) {
      while (node !== undefined) {
        pending.push(node);
        node = node.left;
      }
      const current = pending.pop();
      if (current === undefined) return;
      yield current.value;
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
