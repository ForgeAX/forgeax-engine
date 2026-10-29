/** Current-state epochs over the 24-bit entity-slot space, without a history queue. */
interface Branch {
  max: number;
  size: number;
  readonly children: Array<Node | undefined>;
}
interface Leaf {
  max: number;
  size: number;
  readonly epochs: Float64Array;
}
type Node = Branch | Leaf;
const ROOT_SHIFT = 18;
const WIDTH = 64;
const MASK = WIDTH - 1;

/** Emptied nodes parked for reuse; bounded so a mass removal releases memory. */
const SPARE_LIMIT = 64;
interface Spares {
  readonly leaves: Leaf[];
  readonly branches: Branch[];
}

function write(
  node: Node | undefined,
  key: number,
  epoch: number,
  shift: number,
  spares: Spares,
): Node {
  if (shift === 0) {
    const leaf = (node ??
      spares.leaves.pop() ?? { max: 0, size: 0, epochs: new Float64Array(WIDTH) }) as Leaf;
    const lane = key & MASK;
    if (leaf.epochs[lane] === 0) leaf.size++;
    leaf.epochs[lane] = epoch;
    if (epoch > leaf.max) leaf.max = epoch;
    return leaf;
  }
  const branch = (node ??
    spares.branches.pop() ?? {
      max: 0,
      size: 0,
      children: new Array<Node | undefined>(WIDTH),
    }) as Branch;
  const lane = (key >>> shift) & MASK;
  const previous = branch.children[lane];
  const previousSize = previous?.size ?? 0;
  const child = write(previous, key, epoch, shift - 6, spares);
  branch.children[lane] = child;
  branch.size += child.size - previousSize;
  if (epoch > branch.max) branch.max = epoch;
  return branch;
}

// `max` stays exact so reads prune every clean path. A node rescans its lanes
// only when the erased entry held its maximum; an emptied node is detached
// (and parked for reuse) rather than rescanned.
function erase(
  node: Node | undefined,
  key: number,
  shift: number,
  spares: Spares,
): Node | undefined {
  if (node === undefined) return undefined;
  const lane = (key >>> shift) & MASK;
  if (shift === 0) {
    const leaf = node as Leaf;
    const previous = leaf.epochs[lane] ?? 0;
    if (previous === 0) return leaf;
    leaf.size--;
    leaf.epochs[lane] = 0;
    if (leaf.size === 0) {
      leaf.max = 0;
      if (spares.leaves.length < SPARE_LIMIT) spares.leaves.push(leaf);
      return undefined;
    }
    if (previous === leaf.max) {
      let max = 0;
      for (let index = 0; index < WIDTH; index++) {
        const epoch = leaf.epochs[index] ?? 0;
        if (epoch > max) max = epoch;
      }
      leaf.max = max;
    }
    return leaf;
  }
  const branch = node as Branch;
  const previous = branch.children[lane];
  if (previous === undefined) return branch;
  const previousSize = previous.size;
  const previousMax = previous.max;
  const child = erase(previous, key, shift - 6, spares);
  branch.children[lane] = child;
  branch.size += (child?.size ?? 0) - previousSize;
  if (branch.size === 0) {
    branch.max = 0;
    if (spares.branches.length < SPARE_LIMIT) spares.branches.push(branch);
    return undefined;
  }
  if (previousMax === branch.max && (child?.max ?? 0) < previousMax) {
    let max = 0;
    for (let index = 0; index < WIDTH; index++) {
      const epoch = branch.children[index]?.max ?? 0;
      if (epoch > max) max = epoch;
    }
    branch.max = max;
  }
  return branch;
}

/**
 * Live component leaves are removed with membership; structural leaves coalesce
 * by recyclable World slot. Neither reads nor writes enumerate consumers.
 * Existing paths mutate in place, and emptied nodes are reused, so repeated
 * writes and membership churn allocate no node.
 */
export class ChangeIndex {
  private root: Node | undefined;
  private readonly spares: Spares = { leaves: [], branches: [] };
  private readEntries = 0;
  private readLeafKey = -1;
  private readLeaf: Float64Array | undefined;

  get size(): number {
    return this.root?.size ?? 0;
  }
  get checkedEntries(): number {
    return this.readEntries;
  }

  /** Current epoch for one known identity; no row copy or discovery walk. */
  get(key: number): number {
    const leafKey = key >>> 6;
    if (leafKey !== this.readLeafKey) {
      let node = this.root;
      for (let shift = ROOT_SHIFT; shift > 0 && node !== undefined; shift -= 6)
        node = (node as Branch).children[(key >>> shift) & MASK];
      this.readLeafKey = leafKey;
      this.readLeaf = node === undefined ? undefined : (node as Leaf).epochs;
    }
    return this.readLeaf?.[key & MASK] ?? 0;
  }

  set(key: number, epoch: number): void {
    this.readLeafKey = -1;
    this.readLeaf = undefined;
    this.root = write(this.root, key, epoch, ROOT_SHIFT, this.spares);
  }

  delete(key: number): void {
    this.readLeafKey = -1;
    this.readLeaf = undefined;
    this.root = erase(this.root, key, ROOT_SHIFT, this.spares);
  }

  /** Synchronous owner callback, in stable slot order; no borrowed values escape. */
  visitSince(since: number, upper: number, visit: (key: number) => void): void {
    this.readEntries = 0;
    if (this.root !== undefined) this.read(this.root, 0, ROOT_SHIFT, since, upper, visit);
  }

  private read(
    node: Node,
    base: number,
    shift: number,
    since: number,
    upper: number,
    visit: (key: number) => void,
  ): void {
    this.readEntries++;
    if (node.max <= since) return;
    if (shift === 0) {
      const leaf = node as Leaf;
      for (let lane = 0; lane < WIDTH; lane++) {
        this.readEntries++;
        const epoch = leaf.epochs[lane] ?? 0;
        if (epoch > 0 && epoch > since && epoch <= upper) visit(base + lane);
      }
      return;
    }
    const branch = node as Branch;
    for (let lane = 0; lane < WIDTH; lane++) {
      this.readEntries++;
      const child = branch.children[lane];
      if (child === undefined) continue;
      // Pruned children still count as one checked entry, as if entered.
      // Slot keys stay below 2^24: integer shifts keep `base` a small int
      // (a `2 ** shift` product would box a double per recursive call).
      if (child.max <= since) this.readEntries++;
      else this.read(child, base + (lane << shift), shift - 6, since, upper, visit);
    }
  }
}
