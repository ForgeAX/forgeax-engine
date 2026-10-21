import { FrameListBase } from './frame-list';
import { changes, type Node, nodes, put, remove } from './frame-tree';

/** Value order and execution weight share the same immutable root. */
export class TreeFrame<T> extends FrameListBase<T> {
  constructor(readonly root: Node<T> | undefined = undefined) {
    super();
  }
  get length(): number {
    return this.root?.size ?? 0;
  }
  get weight(): number {
    return this.root?.count ?? 0;
  }
  get(queue: number, key: number): T | undefined {
    let node = this.root;
    while (node !== undefined) {
      if (node.queue === queue && node.key === key) return node.value;
      node =
        queue < node.queue || (queue === node.queue && key < node.key) ? node.left : node.right;
    }
    return undefined;
  }
  with(value: T, queue: number, key: number, weight = 1): TreeFrame<T> {
    return new TreeFrame(put(this.root, value, queue, key, weight));
  }
  without(queue: number, key: number): TreeFrame<T> {
    return new TreeFrame(remove(this.root, queue, key));
  }
  changesSince(
    previous: TreeFrame<T>,
    visit: (before: T | undefined, after: T | undefined) => void,
  ): void {
    changes(previous.root, this.root, visit);
  }
  at(index: number): T | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let node = this.root;
    while (node !== undefined) {
      const before = node.left?.size ?? 0;
      if (index < before) node = node.left;
      else if (index === before) return node.value;
      else {
        index -= before + 1;
        node = node.right;
      }
    }
    return undefined;
  }
  *[Symbol.iterator](): Generator<T> {
    for (const node of nodes(this.root)) yield node.value;
  }
}
