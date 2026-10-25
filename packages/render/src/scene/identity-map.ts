/**
 * A persistent `(worldId, entity) -> slot` map as a hash trie whose leaves are
 * open-addressed numeric tables: one leaf object and one Float64Array per up
 * to a few hundred identities, never one tree node per identity. Earlier roots
 * stay valid after edits; a root's edits copy only one leaf and its branch
 * path, and nodes created by the current editor are mutated in place until it
 * seals.
 */

const BITS = 4;
const FANOUT = 1 << BITS;
const MASK = FANOUT - 1;
/** Hash levels before a leaf stops splitting (8 x 4 = 32 hash bits). */
const MAX_DEPTH = 8;
/** Live entries before a leaf splits into a branch. */
const LEAF_SPLIT = 384;
const LEAF_MIN_CAPACITY = 4;
const STRIDE = 3;
/** Lane 0 (worldId) markers; real worldIds are finite. */
const EMPTY = Number.NaN;
const TOMBSTONE = Number.POSITIVE_INFINITY;

interface Leaf {
  readonly leaf: true;
  owner: object | undefined;
  /** Open-addressed `[worldId, entity, value]` lanes; capacity is a power of two. */
  table: Float64Array;
  count: number;
  /** Live plus tombstoned lanes. */
  used: number;
}

interface Branch {
  readonly leaf: false;
  owner: object | undefined;
  readonly children: (Node | undefined)[];
  size: number;
}

type Node = Leaf | Branch;

function hash(worldId: number, entity: number): number {
  let h = Math.imul((entity | 0) ^ ((entity / 4294967296) | 0), 0x85ebca6b);
  h ^= Math.imul(worldId | 0, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * In-leaf probe start from a separate mix of the identity. Deriving it from
 * {@link hash} would correlate it with the trie digits every key of a deep
 * leaf shares, restricting starts to a fraction of the table and clustering
 * probes as the map grows.
 */
function probe(worldId: number, entity: number, capacity: number): number {
  let h =
    (entity | 0) ^
    Math.imul((entity / 4294967296) | 0, 0x27d4eb2d) ^
    Math.imul(worldId | 0, 0x165667b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h & (capacity - 1);
}

function sizeOf(node: Node | undefined): number {
  return node === undefined ? 0 : node.leaf ? node.count : node.size;
}

function capacityOf(leaf: Leaf): number {
  return leaf.table.length / STRIDE;
}

function emptyTable(capacity: number): Float64Array {
  const table = new Float64Array(capacity * STRIDE);
  for (let at = 0; at < table.length; at += STRIDE) table[at] = EMPTY;
  return table;
}

/** Lane index of an identity, or -1. */
function find(leaf: Leaf, worldId: number, entity: number): number {
  return findIn(leaf.table, worldId, entity);
}

function findIn(table: Float64Array, worldId: number, entity: number): number {
  const capacity = table.length / STRIDE;
  let lane = probe(worldId, entity, capacity);
  for (let step = 0; step < capacity; step++) {
    const at = lane * STRIDE;
    const world = table[at] as number;
    if (Number.isNaN(world)) return -1;
    if (world === worldId && table[at + 1] === entity) return lane;
    lane = (lane + 1) & (capacity - 1);
  }
  return -1;
}

function place(table: Float64Array, worldId: number, entity: number, value: number): void {
  const capacity = table.length / STRIDE;
  let lane = probe(worldId, entity, capacity);
  for (;;) {
    const at = lane * STRIDE;
    const world = table[at] as number;
    if (Number.isNaN(world) || world === TOMBSTONE) {
      table[at] = worldId;
      table[at + 1] = entity;
      table[at + 2] = value;
      return;
    }
    lane = (lane + 1) & (capacity - 1);
  }
}

function visitLeaf(leaf: Leaf, visit: (worldId: number, entity: number, value: number) => void) {
  const table = leaf.table;
  for (let at = 0; at < table.length; at += STRIDE) {
    const world = table[at] as number;
    if (Number.isNaN(world) || world === TOMBSTONE) continue;
    visit(world, table[at + 1] as number, table[at + 2] as number);
  }
}

/** A leaf table of `capacity` lanes holding this leaf's live entries. */
function rehashed(leaf: Leaf, owner: object, capacity: number): Leaf {
  const table = emptyTable(capacity);
  visitLeaf(leaf, (worldId, entity, value) => place(table, worldId, entity, value));
  if (leaf.owner === owner) {
    leaf.table = table;
    leaf.used = leaf.count;
    return leaf;
  }
  return { leaf: true, owner, table, count: leaf.count, used: leaf.count };
}

/**
 * An owned leaf able to take `extra` more lanes without exceeding 1/2 load:
 * linear-probe misses (every admission of a new identity) stay short.
 */
function editableLeaf(leaf: Leaf, owner: object, extra: number): Leaf {
  const capacity = capacityOf(leaf);
  if ((leaf.used + extra) * 2 <= capacity) {
    if (leaf.owner === owner) return leaf;
    return { leaf: true, owner, table: leaf.table.slice(), count: leaf.count, used: leaf.used };
  }
  let next = LEAF_MIN_CAPACITY;
  while ((leaf.count + extra) * 2 > next) next *= 2;
  return rehashed(leaf, owner, next);
}

function editableBranch(branch: Branch, owner: object): Branch {
  return branch.owner === owner
    ? branch
    : { leaf: false, owner, children: branch.children.slice(), size: branch.size };
}

function* entriesOf(node: Node | undefined): Generator<readonly [number, number, number]> {
  if (node === undefined) return;
  if (node.leaf) {
    const table = node.table;
    for (let at = 0; at < table.length; at += STRIDE) {
      const world = table[at] as number;
      if (Number.isNaN(world) || world === TOMBSTONE) continue;
      yield [world, table[at + 1] as number, table[at + 2] as number];
    }
    return;
  }
  for (const child of node.children) yield* entriesOf(child);
}

function visitEntries(
  node: Node | undefined,
  visit: (worldId: number, entity: number, value: number) => void,
): void {
  if (node === undefined) return;
  if (node.leaf) {
    visitLeaf(node, visit);
    return;
  }
  for (const child of node.children) visitEntries(child, visit);
}

function lookupIn(
  node: Node | undefined,
  worldId: number,
  entity: number,
  depth = 0,
): number | undefined {
  let h = hash(worldId, entity) >>> (depth * BITS);
  while (node !== undefined) {
    if (node.leaf) {
      const lane = find(node, worldId, entity);
      return lane < 0 ? undefined : (node.table[lane * STRIDE + 2] as number);
    }
    node = node.children[h & MASK];
    h >>>= BITS;
  }
  return undefined;
}

function singleton(owner: object, worldId: number, entity: number, value: number): Leaf {
  const table = emptyTable(LEAF_MIN_CAPACITY);
  place(table, worldId, entity, value);
  return { leaf: true, owner, table, count: 1, used: 1 };
}

function insert(
  node: Node | undefined,
  owner: object,
  worldId: number,
  entity: number,
  value: number,
  h: number,
  depth: number,
): Node {
  if (node === undefined) return singleton(owner, worldId, entity, value);
  if (node.leaf) {
    const lane = find(node, worldId, entity);
    if (lane >= 0) {
      if (node.table[lane * STRIDE + 2] === value) return node;
      const edited = editableLeaf(node, owner, 0);
      edited.table[find(edited, worldId, entity) * STRIDE + 2] = value;
      return edited;
    }
    if (node.count < LEAF_SPLIT || depth >= MAX_DEPTH) {
      const edited = editableLeaf(node, owner, 1);
      place(edited.table, worldId, entity, value);
      edited.count++;
      edited.used++;
      return edited;
    }
    // Split one full leaf into a branch keyed by the next hash digit.
    let branch: Node = { leaf: false, owner, children: new Array(FANOUT), size: 0 };
    visitLeaf(node, (w, e, v) => {
      branch = insert(branch, owner, w, e, v, hash(w, e) >>> (depth * BITS), depth);
    });
    return insert(branch, owner, worldId, entity, value, h, depth);
  }
  const index = h & MASK;
  const before = node.children[index];
  const beforeSize = sizeOf(before);
  const child = insert(before, owner, worldId, entity, value, h >>> BITS, depth + 1);
  // An owned child may have grown in place.
  const delta = sizeOf(child) - beforeSize;
  if (child === before && delta === 0) return node;
  const edited = editableBranch(node, owner);
  edited.children[index] = child;
  edited.size += delta;
  return edited;
}

function erase(
  node: Node | undefined,
  owner: object,
  worldId: number,
  entity: number,
  h: number,
): Node | undefined {
  if (node === undefined) return undefined;
  if (node.leaf) {
    if (find(node, worldId, entity) < 0) return node;
    if (node.count === 1) return undefined;
    const edited = editableLeaf(node, owner, 0);
    edited.table[find(edited, worldId, entity) * STRIDE] = TOMBSTONE;
    edited.count--;
    return edited;
  }
  const index = h & MASK;
  const before = node.children[index];
  const beforeSize = sizeOf(before);
  const child = erase(before, owner, worldId, entity, h >>> BITS);
  const delta = sizeOf(child) - beforeSize;
  if (child === before && delta === 0) return node;
  if (node.size + delta === 0) return undefined;
  const edited = editableBranch(node, owner);
  edited.children[index] = child;
  edited.size += delta;
  return edited;
}

function seal(node: Node | undefined, owner: object): void {
  if (node === undefined || node.owner !== owner) return;
  node.owner = undefined;
  if (!node.leaf) for (const child of node.children) seal(child, owner);
}

/** One immutable root. */
export class IdentityMap {
  static readonly EMPTY = new IdentityMap(undefined);
  private constructor(private readonly root: Node | undefined) {
    Object.freeze(this);
  }
  /** @internal Sealed roots only; editors construct through {@link IdentityMapEditor}. */
  static _fromRoot(root: Node | undefined): IdentityMap {
    return root === undefined ? IdentityMap.EMPTY : new IdentityMap(root);
  }
  /** @internal */
  get node(): Node | undefined {
    return this.root;
  }
  get size(): number {
    return sizeOf(this.root);
  }
  get(worldId: number, entity: number): number | undefined {
    return lookupIn(this.root, worldId, entity);
  }
  has(worldId: number, entity: number): boolean {
    return lookupIn(this.root, worldId, entity) !== undefined;
  }
  forEach(visit: (worldId: number, entity: number, value: number) => void): void {
    visitEntries(this.root, visit);
  }
  entries(): Generator<readonly [number, number, number]> {
    return entriesOf(this.root);
  }
}

/** The one mutable writer; `capture` seals in-place edits into an immutable root. */
export class IdentityMapEditor {
  private root: Node | undefined;
  private owner: object = {};
  private sealed: IdentityMap = IdentityMap.EMPTY;
  constructor(from: IdentityMap = IdentityMap.EMPTY) {
    this.root = from.node;
    this.sealed = from;
  }
  get size(): number {
    return sizeOf(this.root);
  }
  get(worldId: number, entity: number): number | undefined {
    return lookupIn(this.root, worldId, entity);
  }
  set(worldId: number, entity: number, value: number): void {
    this.root = insert(this.root, this.owner, worldId, entity, value, hash(worldId, entity), 0);
  }
  delete(worldId: number, entity: number): void {
    this.root = erase(this.root, this.owner, worldId, entity, hash(worldId, entity));
  }
  capture(): IdentityMap {
    if (this.root === this.sealed.node) return this.sealed;
    seal(this.root, this.owner);
    this.owner = {};
    this.sealed = IdentityMap._fromRoot(this.root);
    return this.sealed;
  }
  clear(): void {
    this.root = undefined;
    this.owner = {};
    this.sealed = IdentityMap.EMPTY;
  }
}
