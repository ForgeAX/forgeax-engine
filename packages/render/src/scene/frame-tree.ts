/** Path copying retains earlier frames without copying a group's bindings on asset adoption. */
export interface Node<T> {
  readonly queue: number;
  readonly key: number;
  readonly priority: number;
  readonly value: T;
  readonly weight: number;
  readonly count: number;
  readonly size: number;
  readonly left: Node<T> | undefined;
  readonly right: Node<T> | undefined;
}

function node<T>(
  value: T,
  queue: number,
  key: number,
  weight: number,
  left?: Node<T>,
  right?: Node<T>,
): Node<T> {
  let hash =
    (key | 0) ^ Math.imul(Math.floor(key / 4294967296), 0x9e3779b9) ^ Math.imul(queue, 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return {
    value,
    queue,
    key,
    weight,
    priority: (hash ^ (hash >>> 16)) >>> 0,
    count: weight + (left?.count ?? 0) + (right?.count ?? 0),
    size: 1 + (left?.size ?? 0) + (right?.size ?? 0),
    left,
    right,
  };
}

function rebuild<T>(root: Node<T>, left: Node<T> | undefined, right: Node<T> | undefined): Node<T> {
  return node(root.value, root.queue, root.key, root.weight, left, right);
}

function before(queue: number, key: number, root: Node<unknown>): boolean {
  return queue < root.queue || (queue === root.queue && key < root.key);
}

export function put<T>(
  root: Node<T> | undefined,
  value: T,
  queue: number,
  key: number,
  weight: number,
): Node<T> {
  if (root === undefined) return node(value, queue, key, weight);
  if (queue === root.queue && key === root.key)
    return root.value === value && root.weight === weight
      ? root
      : node(value, queue, key, weight, root.left, root.right);
  if (before(queue, key, root)) {
    const left = put(root.left, value, queue, key, weight);
    if (left === root.left) return root;
    return left.priority < root.priority
      ? rebuild(left, left.left, rebuild(root, left.right, root.right))
      : rebuild(root, left, root.right);
  }
  const right = put(root.right, value, queue, key, weight);
  if (right === root.right) return root;
  return right.priority < root.priority
    ? rebuild(right, rebuild(root, root.left, right.left), right.right)
    : rebuild(root, root.left, right);
}

function merge<T>(left: Node<T> | undefined, right: Node<T> | undefined): Node<T> | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left.priority < right.priority
    ? rebuild(left, left.left, merge(left.right, right))
    : rebuild(right, merge(left, right.left), right.right);
}

export function remove<T>(
  root: Node<T> | undefined,
  queue: number,
  key: number,
): Node<T> | undefined {
  if (root === undefined) return undefined;
  if (queue === root.queue && key === root.key) return merge(root.left, root.right);
  if (before(queue, key, root)) {
    const left = remove(root.left, queue, key);
    return left === root.left ? root : rebuild(root, left, root.right);
  }
  const right = remove(root.right, queue, key);
  return right === root.right ? root : rebuild(root, root.left, right);
}

/**
 * In-order traversal. Each step reuses one result object (consumers read the
 * value before the next step), so walking a root allocates per walk, not per node.
 */
class NodeIterator<T> implements IterableIterator<Node<T>> {
  readonly #pending: Node<T>[] = [];
  #root: Node<T> | undefined;
  readonly #result: { value: Node<T> | undefined; done: boolean } = {
    value: undefined,
    done: false,
  };
  constructor(root: Node<T> | undefined) {
    this.#root = root;
  }
  next(): IteratorResult<Node<T>> {
    let root = this.#root;
    const pending = this.#pending;
    while (root !== undefined) {
      pending.push(root);
      root = root.left;
    }
    const current = pending.pop();
    const result = this.#result;
    if (current === undefined) {
      this.#root = undefined;
      result.value = undefined;
      result.done = true;
    } else {
      this.#root = current.right;
      result.value = current;
    }
    return result as IteratorResult<Node<T>>;
  }
  [Symbol.iterator](): IterableIterator<Node<T>> {
    return this;
  }
}

export function nodes<T>(root: Node<T> | undefined): IterableIterator<Node<T>> {
  return new NodeIterator(root);
}
export function prefix<T>(
  root: Node<T> | undefined,
  queue: number,
  key: number,
): Node<T> | undefined {
  if (root === undefined) return undefined;
  if (root.queue > queue || (root.queue === queue && root.key >= key))
    return prefix(root.left, queue, key);
  const right = prefix(root.right, queue, key);
  return right === root.right ? root : rebuild(root, root.left, right);
}

/** Visit only the requested weighted interval, skipping unrelated subtrees. */
export function* range<T>(
  root: Node<T> | undefined,
  start: number,
  end: number,
): Generator<{ value: T; start: number; end: number }> {
  if (root === undefined || start >= end || end <= 0 || start >= root.count) return;
  const left = root.left?.count ?? 0;
  yield* range(root.left, start, end);
  if (start < left + root.weight && end > left)
    yield {
      value: root.value,
      start: Math.max(0, start - left),
      end: Math.min(root.weight, end - left),
    };
  yield* range(root.right, start - left - root.weight, end - left - root.weight);
}

export function at<T>(
  root: Node<T> | undefined,
  index: number,
): { node: Node<T>; offset: number } | undefined {
  while (root !== undefined) {
    const left = root.left?.count ?? 0;
    if (index < left) root = root.left;
    else if (index < left + root.weight) return { node: root, offset: index - left };
    else {
      index -= left + root.weight;
      root = root.right;
    }
  }
  return undefined;
}

function split<T>(
  root: Node<T> | undefined,
  queue: number,
  key: number,
): readonly [Node<T> | undefined, T | undefined, Node<T> | undefined] {
  if (root === undefined) return [undefined, undefined, undefined];
  if (root.queue === queue && root.key === key) return [root.left, root.value, root.right];
  if (before(queue, key, root)) {
    const [left, found, right] = split(root.left, queue, key);
    return [left, found, rebuild(root, right, root.right)];
  }
  const [left, found, right] = split(root.right, queue, key);
  return [rebuild(root, root.left, left), found, right];
}

export function changes<T>(
  before: Node<T> | undefined,
  after: Node<T> | undefined,
  visit: (before: T | undefined, after: T | undefined, key: number) => void,
): void {
  if (before === after) return;
  if (before === undefined) {
    for (const item of nodes(after)) visit(undefined, item.value, item.key);
  } else if (after === undefined) {
    for (const item of nodes(before)) visit(item.value, undefined, item.key);
  } else if (before.queue === after.queue && before.key === after.key) {
    changes(before.left, after.left, visit);
    if (before.value !== after.value) visit(before.value, after.value, after.key);
    changes(before.right, after.right, visit);
  } else if (before.priority < after.priority) {
    const [left, found, right] = split(after, before.queue, before.key);
    changes(before.left, left, visit);
    if (before.value !== found) visit(before.value, found, before.key);
    changes(before.right, right, visit);
  } else {
    const [left, found, right] = split(before, after.queue, after.key);
    changes(left, after.left, visit);
    if (found !== after.value) visit(found, after.value, after.key);
    changes(right, after.right, visit);
  }
}
