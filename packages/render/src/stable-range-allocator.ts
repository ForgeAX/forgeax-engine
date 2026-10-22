interface StableRange {
  readonly start: number;
  readonly count: number;
}

interface FreeRange {
  start: number;
  count: number;
  height: number;
  maximum: number;
  left: FreeRange | undefined;
  right: FreeRange | undefined;
}
const height = (node: FreeRange | undefined) => node?.height ?? 0;
function refresh(node: FreeRange): FreeRange {
  node.height = Math.max(height(node.left), height(node.right)) + 1;
  node.maximum = Math.max(node.count, node.left?.maximum ?? 0, node.right?.maximum ?? 0);
  return node;
}
function left(node: FreeRange): FreeRange {
  const next = node.right;
  if (next === undefined) throw new Error('missing right free-range rotation');
  node.right = next.left;
  next.left = refresh(node);
  return refresh(next);
}
function right(node: FreeRange): FreeRange {
  const next = node.left;
  if (next === undefined) throw new Error('missing left free-range rotation');
  node.left = next.right;
  next.right = refresh(node);
  return refresh(next);
}
function balance(node: FreeRange): FreeRange {
  refresh(node);
  if (height(node.left) - height(node.right) > 1) {
    const child = node.left;
    if (child !== undefined && height(child.right) > height(child.left)) node.left = left(child);
    return right(node);
  }
  if (height(node.right) - height(node.left) > 1) {
    const child = node.right;
    if (child !== undefined && height(child.left) > height(child.right)) node.right = right(child);
    return left(node);
  }
  return node;
}
function insert(root: FreeRange | undefined, start: number, count: number): FreeRange {
  if (root === undefined)
    return { start, count, height: 1, maximum: count, left: undefined, right: undefined };
  if (start < root.start) root.left = insert(root.left, start, count);
  else if (start > root.start) root.right = insert(root.right, start, count);
  else root.count = count;
  return balance(root);
}
function remove(root: FreeRange | undefined, start: number): FreeRange | undefined {
  if (root === undefined) return undefined;
  if (start < root.start) root.left = remove(root.left, start);
  else if (start > root.start) root.right = remove(root.right, start);
  else {
    if (root.left === undefined) return root.right;
    if (root.right === undefined) return root.left;
    let next = root.right;
    while (next.left !== undefined) next = next.left;
    root.start = next.start;
    root.count = next.count;
    root.right = remove(root.right, next.start);
  }
  return balance(root);
}
function firstFit(
  root: FreeRange | undefined,
  count: number,
  alignment: number,
): FreeRange | undefined {
  if (root === undefined || root.maximum < count) return undefined;
  const before = firstFit(root.left, count, alignment);
  if (before !== undefined) return before;
  if (Math.ceil(root.start / alignment) * alignment + count <= root.start + root.count) return root;
  return firstFit(root.right, count, alignment);
}

const SPARE_RANGE = 256;
const descending = (a: number, b: number) => b - a;

/** Reusable physical ranges; changing one allocation never compacts another. */
export class StableRangeAllocator {
  private next = 0;
  private free: FreeRange | undefined;
  /** Released small ranges by exact count, outside the tree until reused or flushed.
   * Reuse takes the lowest start, like first fit, so dirty uploads stay compact. */
  private readonly spare = new Map<number, number[]>();
  private readonly unsorted = new Set<number>();
  private spareCount = 0;

  /**
   * `spareLimit` keeps up to that many released units of small ranges for
   * exact-size reuse. Churn of a few recurring sizes then skips the tree;
   * any allocation the tree cannot fit flushes them back before growing.
   */
  constructor(private readonly spareLimit = 0) {}

  allocate(count: number, alignment = 1): number {
    if (count <= 0) return 0;
    if (!Number.isSafeInteger(alignment) || alignment < 1)
      throw new RangeError('range alignment must be a positive integer');
    const spare = this.spare.get(count);
    if (spare !== undefined && this.unsorted.delete(count)) spare.sort(descending);
    const reused = spare?.at(-1);
    if (reused !== undefined && reused % alignment === 0) {
      spare?.pop();
      this.spareCount -= count;
      return reused;
    }
    let range = firstFit(this.free, count, alignment);
    if (range === undefined && this.spareCount > 0) {
      this.flushSpare();
      range = firstFit(this.free, count, alignment);
    }
    if (range === undefined) {
      let tail = this.free;
      while (tail?.right !== undefined) tail = tail.right;
      if (tail !== undefined && tail.start + tail.count === this.next) range = tail;
    }
    if (range !== undefined) {
      const previousStart = range.start;
      const previousEnd = range.start + range.count;
      const start = Math.ceil(previousStart / alignment) * alignment;
      const end = start + count;
      this.free = remove(this.free, previousStart);
      this.next = Math.max(this.next, end);
      if (start > previousStart) this.insertFree(previousStart, start - previousStart);
      if (end < previousEnd) this.insertFree(end, previousEnd - end);
      return start;
    }
    const start = Math.ceil(this.next / alignment) * alignment;
    if (start > this.next) this.insertFree(this.next, start - this.next);
    this.next = start + count;
    return start;
  }

  /** Retain spare capacity while the owner remains live; grow only its range. */
  resize(previous: StableRange | undefined, count: number): StableRange {
    if (previous !== undefined && previous.count >= count) return previous;
    if (previous !== undefined) this.release(previous.start, previous.count);
    return { start: this.allocate(count), count };
  }

  release(start: number, count: number): void {
    if (count <= 0) return;
    if (count <= SPARE_RANGE && this.spareCount + count <= this.spareLimit) {
      let spare = this.spare.get(count);
      if (spare === undefined) {
        spare = [];
        this.spare.set(count, spare);
      }
      spare.push(start);
      this.unsorted.add(count);
      this.spareCount += count;
      return;
    }
    this.insertFree(start, count);
  }

  private flushSpare(): void {
    for (const [count, starts] of this.spare)
      for (const start of starts) this.insertFree(start, count);
    this.spare.clear();
    this.unsorted.clear();
    this.spareCount = 0;
  }

  private insertFree(start: number, count: number): void {
    let before: FreeRange | undefined;
    let after: FreeRange | undefined;
    let node = this.free;
    while (node !== undefined) {
      if (node.start < start) {
        before = node;
        node = node.right;
      } else {
        after = node;
        node = node.left;
      }
    }
    const afterStart = after?.start;
    const afterCount = after?.count ?? 0;
    if (before !== undefined && before.start + before.count === start) {
      start = before.start;
      count += before.count;
      this.free = remove(this.free, before.start);
    }
    if (afterStart !== undefined && start + count === afterStart) {
      count += afterCount;
      this.free = remove(this.free, afterStart);
    }
    this.free = insert(this.free, start, count);
  }

  requiredCapacity(): number {
    return this.next;
  }
  reset(start = 0): void {
    this.next = start;
    this.free = undefined;
    this.spare.clear();
    this.unsorted.clear();
    this.spareCount = 0;
  }
}
