/** Latest structural change per 24-bit entity slot, including retired slots. */
interface Branch {
  max: number;
  readonly children: Array<Node | undefined>;
}
interface Leaf {
  max: number;
  readonly epochs: Float64Array;
}
type Node = Branch | Leaf;
const ROOT_SHIFT = 18;
const WIDTH = 64;
const MASK = WIDTH - 1;

function write(node: Node | undefined, key: number, epoch: number, shift: number): Node {
  if (shift === 0) {
    const leaf = (node ?? { max: 0, epochs: new Float64Array(WIDTH) }) as Leaf;
    const lane = key & MASK;
    leaf.epochs[lane] = epoch;
    if (epoch > leaf.max) leaf.max = epoch;
    return leaf;
  }
  const branch = (node ?? {
    max: 0,
    children: new Array<Node | undefined>(WIDTH),
  }) as Branch;
  const lane = (key >>> shift) & MASK;
  branch.children[lane] = write(branch.children[lane], key, epoch, shift - 6);
  if (epoch > branch.max) branch.max = epoch;
  return branch;
}

export class ChangeIndex {
  private root: Node | undefined;
  private readEntries = 0;
  // Writes arrive in slot runs; the last written leaf skips the descent.
  private writeLeafKey = -1;
  private writeLeaf: Leaf | undefined;

  get checkedEntries(): number {
    return this.readEntries;
  }

  set(key: number, epoch: number): void {
    if (!this.overwrite(key, epoch)) this.root = write(this.root, key, epoch, ROOT_SHIFT);
  }

  /** Overwrite an occupied lane along its existing path. */
  private overwrite(key: number, epoch: number): boolean {
    if (epoch === 0) return false;
    const leafKey = key >>> 6;
    let leaf = leafKey === this.writeLeafKey ? this.writeLeaf : undefined;
    if (leaf === undefined) {
      let found = this.root;
      for (let shift = ROOT_SHIFT; shift > 0 && found !== undefined; shift -= 6)
        found = (found as Branch).children[(key >>> shift) & MASK];
      if (found === undefined) return false;
      leaf = found as Leaf;
      this.writeLeafKey = leafKey;
      this.writeLeaf = leaf;
    }
    const epochs = leaf.epochs;
    if (epochs[key & MASK] === 0) return false;
    epochs[key & MASK] = epoch;
    // Every ancestor's max already covers its leaf's max.
    if (epoch <= leaf.max) return true;
    let node = this.root;
    for (let shift = ROOT_SHIFT; node !== undefined; shift -= 6) {
      if (epoch > node.max) node.max = epoch;
      if (shift === 0) break;
      node = (node as Branch).children[(key >>> shift) & MASK];
    }
    return true;
  }

  /** Synchronous owner callback, in stable slot order; no borrowed values escape. */
  visitSince(since: number, upper: number, visit: (key: number) => void): void {
    this.readEntries =
      this.root === undefined ? 0 : read(this.root, 0, ROOT_SHIFT, since, upper, visit);
  }
}

// Returns the checked-entry count; a local tally keeps the lane loop free of
// owner writes.
function read(
  node: Node,
  base: number,
  shift: number,
  since: number,
  upper: number,
  visit: (key: number) => void,
): number {
  if (node.max <= since) return 1;
  let checked = 1;
  if (shift === 0) {
    const epochs = (node as Leaf).epochs;
    checked += WIDTH;
    for (let lane = 0; lane < WIDTH; lane++) {
      const epoch = epochs[lane] as number;
      if (epoch > since && epoch <= upper && epoch > 0) visit(base + lane);
    }
    return checked;
  }
  const children = (node as Branch).children;
  for (let lane = 0; lane < WIDTH; lane++) {
    checked++;
    const child = children[lane];
    if (child === undefined) continue;
    // Pruned children still count as one checked entry, as if entered.
    // Slot keys stay below 2^24: integer shifts keep `base` a small int
    // (a `2 ** shift` product would box a double per recursive call).
    if (child.max <= since) checked++;
    else checked += read(child, base + (lane << shift), shift - 6, since, upper, visit);
  }
  return checked;
}
