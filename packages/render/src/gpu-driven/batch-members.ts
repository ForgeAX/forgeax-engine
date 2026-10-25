import { FrameListBase } from '../scene/frame-list';
import { changes, type Node, nodes, put, remove, treeKind } from '../scene/frame-tree';
import { captureMaterialOverrides } from '../scene/mesh-materials';
import { captureBatchGeometry, captureBatchLod } from './batch-execution';
import type {
  EligibleGpuDrivenDraw,
  GpuDrivenBatch,
  GpuDrivenBatchBinding,
  GpuDrivenBatchMember,
  GpuDrivenCandidate,
  MeshBatchSource,
} from './batch-topology';

/** Seal only newly created paths. Unchanged children are already sealed by this owner. */
function sealPath<T>(root: Node<T> | undefined): Node<T> | undefined {
  if (root === undefined || Object.isFrozen(root)) return root;
  sealPath(root.left);
  sealPath(root.right);
  return Object.freeze(root);
}
function numeric(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Batch membership facts are non-negative safe integers');
  return value;
}

/**
 * Member facts interleaved per member, in ascending slot order. A page is
 * never written after its owner places it; edits copy one page.
 */
export const MEMBER_PAGE = Object.freeze({
  stride: 5,
  slot: 0,
  generation: 1,
  entity: 2,
  drawItem: 3,
  count: 4,
});
const STRIDE = MEMBER_PAGE.stride;
const GENERATION = MEMBER_PAGE.generation;
const ENTITY = MEMBER_PAGE.entity;
const DRAW = MEMBER_PAGE.drawItem;
const COUNT = MEMBER_PAGE.count;
const PAGE_MAX = 64;
/** A page smaller than this merges into a neighbor when they fit one page. */
const PAGE_MERGE = PAGE_MAX / 4;
export type MemberPage = Float64Array;
/** Admission scratch: `#put` copies the facts it keeps. */
const ADMITTED = new Float64Array(STRIDE);

/** Pages key by their first slot and weigh their candidates; one node kind keeps keys unboxed. */
const MEMBER_KIND = treeKind();

function pageWeight(page: MemberPage): number {
  let weight = 0;
  for (let base = COUNT; base < page.length; base += STRIDE) weight += page[base] as number;
  return weight;
}

function place(
  root: Node<MemberPage> | undefined,
  page: MemberPage,
  weight: number,
): Node<MemberPage> {
  return put(root, page, 0, page[0] as number, weight, MEMBER_KIND);
}

/** Element copy; a short page loop allocates no subarray views. */
function copy(
  target: MemberPage,
  at: number,
  source: MemberPage,
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index++)
    target[at + index - start] = source[index] as number;
}

/** The page holding `slot`'s position: the greatest first slot <= slot, else the first page. */
function pageNode(root: Node<MemberPage>, slot: number): Node<MemberPage> {
  let node: Node<MemberPage> | undefined = root;
  let floor: Node<MemberPage> | undefined;
  let first = root;
  while (node !== undefined) {
    if (node.key <= slot) {
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

function successor(root: Node<MemberPage> | undefined, key: number): Node<MemberPage> | undefined {
  let found: Node<MemberPage> | undefined;
  while (root !== undefined) {
    if (root.key > key) {
      found = root;
      root = root.left;
    } else root = root.right;
  }
  return found;
}

function predecessor(
  root: Node<MemberPage> | undefined,
  key: number,
): Node<MemberPage> | undefined {
  let found: Node<MemberPage> | undefined;
  while (root !== undefined) {
    if (root.key < key) {
      found = root;
      root = root.right;
    } else root = root.left;
  }
  return found;
}

/** First index in `[start, end)` whose slot is >= `slot` (or > it when `after`). */
function slotBound(
  slots: readonly number[],
  slot: number,
  start: number,
  end: number,
  after: boolean,
): number {
  while (start < end) {
    const middle = (start + end) >>> 1;
    const value = slots[middle] as number;
    if (value < slot || (after && value === slot)) start = middle + 1;
    else end = middle;
  }
  return start;
}

/** Ascending `slots[start, end)` held by pages under `node`, appended to `out`. */
function heldSlotsIn(
  node: Node<MemberPage> | undefined,
  slots: readonly number[],
  start: number,
  end: number,
  out: number[],
): void {
  while (node !== undefined && start < end) {
    const low = slotBound(slots, node.key, start, end, false);
    heldSlotsIn(node.left, slots, start, low, out);
    const page = node.value;
    const high = slotBound(slots, page[page.length - STRIDE] as number, low, end, true);
    let base = 0;
    for (let index = low; index < high; index++) {
      const slot = slots[index] as number;
      while (base < page.length && (page[base] as number) < slot) base += STRIDE;
      if (base < page.length && page[base] === slot) out.push(slot);
    }
    start = high;
    node = node.right;
  }
}

/** Base offset of the first member whose slot is >= `slot`. */
function lowerBound(page: MemberPage, slot: number): number {
  let low = 0;
  let high = page.length / STRIDE;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((page[middle * STRIDE] as number) < slot) low = middle + 1;
    else high = middle;
  }
  return low * STRIDE;
}

function memberOf(page: MemberPage, base: number): GpuDrivenBatchMember {
  return {
    primitiveIndex: page[base] as number,
    generation: page[base + GENERATION] as number,
    entityKey: page[base + ENTITY] as number,
    drawItemIndex: page[base + DRAW] as number,
    instanceCount: page[base + COUNT] as number,
  };
}

/** Candidates are read views of their member's facts, never stored. */
function candidateOf(page: MemberPage, base: number, instanceOrdinal: number): GpuDrivenCandidate {
  return {
    primitiveIndex: page[base] as number,
    generation: page[base + GENERATION] as number,
    drawItemIndex: page[base + DRAW] as number,
    instanceOrdinal,
  };
}

function sameFacts(left: MemberPage, a: number, right: MemberPage, b: number): boolean {
  for (let column = 0; column < STRIDE; column++)
    if (left[a + column] !== right[b + column]) return false;
  return true;
}

/** Pages a changed root path holds, ascending by first slot. */
function changedPages(pages: MemberPage[]): MemberPage[] {
  return pages.sort((left, right) => (left[0] as number) - (right[0] as number));
}

/**
 * The canonical batch membership: a persistent treap of numeric member pages.
 * One node and one page per up to 64 members; candidate order is member slot
 * order, then instance ordinal. Reading never retains a per-member object.
 */
export class MemberCandidates extends FrameListBase<GpuDrivenCandidate> {
  #root: Node<MemberPage> | undefined;
  #members = 0;
  #frame: MemberFrame | undefined;
  constructor() {
    super();
    // biome-ignore lint/complexity/noArguments: reject JS root injection without allocating a rest array.
    if (arguments.length !== 0)
      throw new TypeError('MemberCandidates owns its root; admit numeric members');
    Object.freeze(this);
  }
  get root(): Node<MemberPage> | undefined {
    return this.#root;
  }
  get length(): number {
    return this.#root?.count ?? 0;
  }
  get memberCount(): number {
    return this.#members;
  }
  static #from(root: Node<MemberPage> | undefined, members: number): MemberCandidates {
    const value = new MemberCandidates();
    value.#root = sealPath(root);
    value.#members = members;
    return value;
  }
  static is(value: unknown): value is MemberCandidates {
    return (
      typeof value === 'object' &&
      value !== null &&
      #root in value &&
      Object.getPrototypeOf(value) === MemberCandidates.prototype
    );
  }
  /** The page and base offset of `slot`'s member, or undefined. */
  #find(slot: number): { page: MemberPage; base: number } | undefined {
    if (this.#root === undefined) return undefined;
    const page = pageNode(this.#root, slot).value;
    const base = lowerBound(page, slot);
    return base < page.length && page[base] === slot ? { page, base } : undefined;
  }
  /** Whether `slot` holds a weighted member, without materializing it. */
  drawsSlot(slot: number): boolean {
    if (this.#root === undefined) return false;
    const page = pageNode(this.#root, slot).value;
    const base = lowerBound(page, slot);
    return base < page.length && page[base] === slot && (page[base + COUNT] as number) > 0;
  }
  /** Add every weighted member's slot to `out`, read from the page columns. */
  addDrawnSlots(out: Set<number>): void {
    for (const node of nodes(this.#root)) {
      const page = node.value;
      for (let base = 0; base < page.length; base += STRIDE)
        if ((page[base + COUNT] as number) > 0) out.add(page[base] as number);
    }
  }
  get(slot: number): GpuDrivenBatchMember | undefined {
    const found = this.#find(slot);
    return found === undefined ? undefined : memberOf(found.page, found.base);
  }
  with(member: GpuDrivenBatchMember): MemberCandidates {
    const facts = ADMITTED;
    facts[0] = numeric(member.primitiveIndex);
    facts[GENERATION] = numeric(member.generation);
    facts[ENTITY] = numeric(member.entityKey);
    facts[DRAW] = numeric(member.drawItemIndex);
    facts[COUNT] = numeric(member.instanceCount);
    return this.#put(facts, 0);
  }
  /** Admit the member at `source[base]`; an equal member keeps this owner. */
  #put(source: MemberPage, base: number): MemberCandidates {
    const slot = source[base] as number;
    const count = source[base + COUNT] as number;
    const root = this.#root;
    if (root === undefined) {
      const page = new Float64Array(STRIDE);
      copy(page, 0, source, base, base + STRIDE);
      return MemberCandidates.#from(place(undefined, page, count), 1);
    }
    const node = pageNode(root, slot);
    const page = node.value;
    const at = lowerBound(page, slot);
    if (at < page.length && page[at] === slot) {
      if (sameFacts(page, at, source, base)) return this;
      const next = page.slice();
      copy(next, at, source, base, base + STRIDE);
      const weight = node.weight - (page[at + COUNT] as number) + count;
      return MemberCandidates.#from(
        put(root, next, 0, node.key, weight, MEMBER_KIND),
        this.#members,
      );
    }
    const members = this.#members + 1;
    const full = page.length === PAGE_MAX * STRIDE;
    if (full && at === page.length && successor(root, node.key) === undefined) {
      // Appending past the last full page starts a page: ascending admission fills pages.
      const tail = new Float64Array(STRIDE);
      copy(tail, 0, source, base, base + STRIDE);
      return MemberCandidates.#from(place(root, tail, count), members);
    }
    if (full) {
      // Split around the insertion: each half is one new page.
      const next = new Float64Array(page.length + STRIDE);
      copy(next, 0, page, 0, at);
      copy(next, at, source, base, base + STRIDE);
      copy(next, at + STRIDE, page, at, page.length);
      const half = (PAGE_MAX / 2) * STRIDE;
      const left = next.slice(0, half);
      const right = next.slice(half);
      const rest = remove(root, 0, node.key);
      return MemberCandidates.#from(
        place(place(rest, left, pageWeight(left)), right, pageWeight(right)),
        members,
      );
    }
    const next = new Float64Array(page.length + STRIDE);
    copy(next, 0, page, 0, at);
    copy(next, at, source, base, base + STRIDE);
    copy(next, at + STRIDE, page, at, page.length);
    const weight = node.weight + count;
    // A smaller first slot re-keys the first page.
    return MemberCandidates.#from(
      at === 0
        ? place(remove(root, 0, node.key), next, weight)
        : put(root, next, 0, node.key, weight, MEMBER_KIND),
      members,
    );
  }
  without(slot: number): MemberCandidates {
    const root = this.#root;
    if (root === undefined) return this;
    const node = pageNode(root, slot);
    const page = node.value;
    const at = lowerBound(page, slot);
    if (at >= page.length || page[at] !== slot) return this;
    const members = this.#members - 1;
    if (page.length === STRIDE) return MemberCandidates.#from(remove(root, 0, node.key), members);
    const weight = node.weight - (page[at + COUNT] as number);
    const length = page.length - STRIDE;
    if (length < PAGE_MERGE * STRIDE) {
      // An underfull page merges with a neighbor that still fits one page.
      const fits = (other: Node<MemberPage> | undefined) =>
        other !== undefined && length + other.value.length <= PAGE_MAX * STRIDE ? other : undefined;
      const following = fits(successor(root, node.key));
      const preceding = following === undefined ? fits(predecessor(root, node.key)) : undefined;
      const neighbor = following ?? preceding;
      if (neighbor !== undefined) {
        const merged = new Float64Array(length + neighbor.value.length);
        const offset = preceding === undefined ? 0 : neighbor.value.length;
        copy(
          merged,
          preceding === undefined ? length : 0,
          neighbor.value,
          0,
          neighbor.value.length,
        );
        copy(merged, offset, page, 0, at);
        copy(merged, offset + at, page, at + STRIDE, page.length);
        const rest = remove(remove(root, 0, neighbor.key), 0, node.key);
        return MemberCandidates.#from(place(rest, merged, weight + neighbor.weight), members);
      }
    }
    const next = new Float64Array(length);
    copy(next, 0, page, 0, at);
    copy(next, at, page, at + STRIDE, page.length);
    return MemberCandidates.#from(
      at === 0
        ? place(remove(root, 0, node.key), next, weight)
        : put(root, next, 0, node.key, weight, MEMBER_KIND),
      members,
    );
  }
  /** The members `selected` admits, in fresh full pages; all admitted returns `this`. */
  selectMembers(selected: (slot: number) => boolean): MemberCandidates {
    let root: Node<MemberPage> | undefined;
    let members = 0;
    const pending = new Float64Array(PAGE_MAX * STRIDE);
    let filled = 0;
    let weight = 0;
    for (const node of nodes(this.#root)) {
      const page = node.value;
      for (let base = 0; base < page.length; base += STRIDE) {
        if (!selected(page[base] as number)) continue;
        copy(pending, filled, page, base, base + STRIDE);
        filled += STRIDE;
        weight += page[base + COUNT] as number;
        members++;
        if (filled === pending.length) {
          root = place(root, pending.slice(), weight);
          filled = 0;
          weight = 0;
        }
      }
    }
    if (members === this.#members) return this;
    if (filled > 0) root = place(root, pending.slice(0, filled), weight);
    return MemberCandidates.#from(root, members);
  }
  /**
   * Re-judge `slots` of a subset previously selected from this owner's
   * ancestry. Every other subset member must already equal this owner's member.
   */
  patchSelection(
    subset: MemberCandidates,
    slots: Iterable<number>,
    selected: (slot: number) => boolean,
  ): MemberCandidates {
    let result = subset;
    for (const slot of slots) {
      const found = this.#find(slot);
      result =
        found !== undefined && selected(slot)
          ? result.#put(found.page, found.base)
          : result.without(slot);
    }
    return result.#members === this.#members ? this : result;
  }
  /**
   * Append to `out` each of the ascending `slots` this owner holds a member
   * for, in ascending order. Pages outside the remaining slot range are
   * skipped, so a small owner or a short slot list costs only its own size.
   */
  heldSlots(slots: readonly number[], out: number[]): void {
    heldSlotsIn(this.#root, slots, 0, slots.length, out);
  }
  /** Visit each slot whose member differs from `before`, with both members. */
  changesSince(
    before: MemberCandidates,
    visit: (
      slot: number,
      before: GpuDrivenBatchMember | undefined,
      after: GpuDrivenBatchMember | undefined,
    ) => void,
  ): void {
    if (before.#root === this.#root) return;
    const removed: MemberPage[] = [];
    const added: MemberPage[] = [];
    changes(before.#root, this.#root, (left, right) => {
      if (left !== undefined) removed.push(left);
      if (right !== undefined) added.push(right);
    });
    // A split or merge moves members between pages: compare the union by slot.
    const lefts = changedPages(removed);
    const rights = changedPages(added);
    let leftPage = 0,
      leftBase = 0,
      rightPage = 0,
      rightBase = 0;
    for (;;) {
      const left = lefts[leftPage];
      const right = rights[rightPage];
      if (left === undefined && right === undefined) return;
      const leftSlot = left === undefined ? Number.POSITIVE_INFINITY : (left[leftBase] as number);
      const rightSlot =
        right === undefined ? Number.POSITIVE_INFINITY : (right[rightBase] as number);
      if (leftSlot < rightSlot) visit(leftSlot, memberOf(left as MemberPage, leftBase), undefined);
      else if (rightSlot < leftSlot)
        visit(rightSlot, undefined, memberOf(right as MemberPage, rightBase));
      else if (!sameFacts(left as MemberPage, leftBase, right as MemberPage, rightBase))
        visit(
          leftSlot,
          memberOf(left as MemberPage, leftBase),
          memberOf(right as MemberPage, rightBase),
        );
      if (leftSlot <= rightSlot && left !== undefined) {
        leftBase += STRIDE;
        if (leftBase === left.length) {
          leftPage++;
          leftBase = 0;
        }
      }
      if (rightSlot <= leftSlot && right !== undefined) {
        rightBase += STRIDE;
        if (rightBase === right.length) {
          rightPage++;
          rightBase = 0;
        }
      }
    }
  }
  /** The ordered lanes one member draws in this batch. */
  slotCandidates(slot: number): readonly GpuDrivenCandidate[] {
    const found = this.#find(slot);
    if (found === undefined) return [];
    const count = found.page[found.base + COUNT] as number;
    return Array.from({ length: count }, (_, lane) => candidateOf(found.page, found.base, lane));
  }
  membersFrame(): MemberFrame {
    this.#frame ??= new MemberFrame(this);
    return this.#frame;
  }
  /** Native member identity lookup, independent of its instance cardinality. */
  containsSlot(slot: number, generation: number): boolean {
    const found = this.#find(slot);
    return (
      found !== undefined &&
      (found.page[found.base + COUNT] as number) > 0 &&
      found.page[found.base + GENERATION] === generation
    );
  }
  at(index: number): GpuDrivenCandidate | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let node = this.#root;
    while (node !== undefined) {
      const before = node.left?.count ?? 0;
      if (index < before) node = node.left;
      else if (index < before + node.weight) {
        const page = node.value;
        let lane = index - before;
        for (let base = 0; base < page.length; base += STRIDE) {
          const count = page[base + COUNT] as number;
          if (lane < count) return candidateOf(page, base, lane);
          lane -= count;
        }
        return undefined;
      } else {
        index -= before + node.weight;
        node = node.right;
      }
    }
    return undefined;
  }
  [Symbol.iterator](): IterableIterator<GpuDrivenCandidate> {
    return new PageIterator(this.#root, true) as IterableIterator<GpuDrivenCandidate>;
  }
}

/** Members of one canonical owner, in slot order, read from its pages. */
class MemberFrame extends FrameListBase<GpuDrivenBatchMember> {
  readonly #owner: MemberCandidates;
  constructor(owner: MemberCandidates) {
    super();
    this.#owner = owner;
    Object.freeze(this);
  }
  get length(): number {
    return this.#owner.memberCount;
  }
  at(index: number): GpuDrivenBatchMember | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    for (const node of nodes(this.#owner.root)) {
      const page = node.value;
      const members = page.length / STRIDE;
      if (index < members) return memberOf(page, index * STRIDE);
      index -= members;
    }
    return undefined;
  }
  [Symbol.iterator](): IterableIterator<GpuDrivenBatchMember> {
    return new PageIterator(this.#owner.root, false) as IterableIterator<GpuDrivenBatchMember>;
  }
}

/**
 * Walks pages, then members (and each member's lanes for candidates), reusing
 * one result object; each step reads a fresh value from the page columns.
 */
class PageIterator implements IterableIterator<GpuDrivenCandidate | GpuDrivenBatchMember> {
  readonly #pages: IterableIterator<Node<MemberPage>>;
  #page: MemberPage | undefined;
  #base = 0;
  #lane = 0;
  readonly #result: {
    value: GpuDrivenCandidate | GpuDrivenBatchMember | undefined;
    done: boolean;
  } = { value: undefined, done: false };
  constructor(
    root: Node<MemberPage> | undefined,
    readonly lanes: boolean,
  ) {
    this.#pages = nodes(root);
  }
  next(): IteratorResult<GpuDrivenCandidate | GpuDrivenBatchMember> {
    const result = this.#result;
    for (;;) {
      const page = this.#page;
      if (page !== undefined) {
        while (this.#base < page.length) {
          const base = this.#base;
          if (!this.lanes) {
            this.#base += STRIDE;
            result.value = memberOf(page, base);
            return result as IteratorResult<GpuDrivenBatchMember>;
          }
          if (this.#lane < (page[base + COUNT] as number)) {
            result.value = candidateOf(page, base, this.#lane++);
            return result as IteratorResult<GpuDrivenCandidate>;
          }
          this.#base += STRIDE;
          this.#lane = 0;
        }
        this.#page = undefined;
      }
      const next = this.#pages.next();
      if (next.done === true) {
        result.value = undefined;
        result.done = true;
        return result as IteratorResult<GpuDrivenCandidate>;
      }
      this.#page = next.value.value;
      this.#base = 0;
      this.#lane = 0;
    }
  }
  [Symbol.iterator](): IterableIterator<GpuDrivenCandidate | GpuDrivenBatchMember> {
    return this;
  }
}

/** The existing published source roster; its numeric candidate facts are sealed at admission. */
export class BatchSources extends FrameListBase<GpuDrivenBatch> {
  #root: Node<GpuDrivenBatch> | undefined;
  constructor() {
    super();
    // biome-ignore lint/complexity/noArguments: reject JS root injection without allocating a rest array.
    if (arguments.length !== 0) throw new TypeError('BatchSources owns its publication root');
    Object.freeze(this);
  }
  get root(): Node<GpuDrivenBatch> | undefined {
    return this.#root;
  }
  get length(): number {
    return this.#root?.size ?? 0;
  }
  get weight(): number {
    return this.#root?.count ?? 0;
  }
  static isFixed(value: unknown): value is BatchSources {
    return (
      typeof value === 'object' &&
      value !== null &&
      #root in value &&
      Object.getPrototypeOf(value) === BatchSources.prototype
    );
  }
  static #from(root: Node<GpuDrivenBatch> | undefined): BatchSources {
    const value = new BatchSources();
    value.#root = sealPath(root);
    return value;
  }
  get(batchId: number): GpuDrivenBatch | undefined {
    let node = this.#root;
    while (node !== undefined) {
      if (node.key === batchId) return node.value;
      node = batchId < node.key ? node.left : node.right;
    }
    return undefined;
  }
  /** Membership edits retain this owner's already captured shared source facts. */
  withMembers(batchId: number, candidates: MemberCandidates, contentEpoch: number): BatchSources {
    const previous = this.get(batchId);
    if (previous === undefined || !MemberCandidates.is(candidates))
      throw new TypeError(
        'Membership update requires an admitted source and owned numeric members',
      );
    const captured = Object.freeze({
      ...previous,
      candidates,
      members: candidates.membersFrame(),
      visibleCapacity: candidates.length,
      contentEpoch: numeric(contentEpoch),
    });
    return BatchSources.#from(put(this.#root, captured, 0, batchId, candidates.length));
  }
  with(batch: GpuDrivenBatch): BatchSources {
    const admitted = { ...batch };
    const candidates = admitted.candidates;
    if (!MemberCandidates.is(candidates))
      throw new TypeError('Source publication requires owned numeric members');
    const lod = captureBatchLod(admitted);
    const captured = Object.freeze({
      ...admitted,
      candidates,
      key: Object.freeze({ ...admitted.key }),
      ...(admitted.binding === undefined ? {} : { binding: captureBinding(admitted.binding) }),
      ...(lod === undefined ? {} : { lod }),
      members: candidates.membersFrame(),
    });
    return BatchSources.#from(
      put(this.#root, captured, 0, numeric(captured.batchId), candidates.length),
    );
  }
  without(batchId: number): BatchSources {
    return BatchSources.#from(remove(this.#root, 0, batchId));
  }
  changesSince(
    before: BatchSources,
    visit: (before: GpuDrivenBatch | undefined, after: GpuDrivenBatch | undefined) => void,
  ): void {
    changes(before.#root, this.#root, visit);
  }
  at(index: number): GpuDrivenBatch | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let node = this.#root;
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
  /** The published roster is iterated by several stages per frame; flatten it once. */
  #values: readonly GpuDrivenBatch[] | undefined;
  [Symbol.iterator](): IterableIterator<GpuDrivenBatch> {
    this.#values ??= Array.from(nodes(this.#root), (node) => node.value);
    return this.#values[Symbol.iterator]();
  }
}

/** Capture only execution inputs; MaterialResource and asset identities remain borrowed identities. */
function captureBinding(raw: GpuDrivenBatchBinding): GpuDrivenBatchBinding {
  const binding = { ...raw };
  const source = binding.source === undefined ? undefined : { ...binding.source };
  const capturedSource: MeshBatchSource | undefined =
    source === undefined
      ? undefined
      : Object.freeze({
          draws: Object.freeze(
            source.draws.map((raw): EligibleGpuDrivenDraw => {
              const draw = { ...raw };
              const lod = draw.lod === undefined ? undefined : captureBatchLod({ lod: draw.lod });
              return Object.freeze({
                sourceDrawIndex: draw.sourceDrawIndex,
                key: Object.freeze({ ...draw.key }),
                // Authored draw descriptors do not carry another source group.
                binding: captureLeafBinding(draw.binding),
                ...(lod === undefined ? {} : { lod }),
              });
            }),
          ),
          material: source.material,
          materials: Object.freeze([...source.materials]),
          materialBindingSources: Object.freeze([...source.materialBindingSources]),
          ...(source.materialOverrides === undefined
            ? {}
            : {
                materialOverrides: captureMaterialOverrides(source.materialOverrides),
              }),
        });
  return Object.freeze({
    ...captureLeafBinding(binding),
    ...(capturedSource === undefined ? {} : { source: capturedSource }),
  });
}
function captureLeafBinding(raw: GpuDrivenBatchBinding): GpuDrivenBatchBinding {
  const binding = { ...raw };
  return Object.freeze({
    worldId: binding.worldId,
    assetHandle: binding.assetHandle,
    drawItemIndex: binding.drawItemIndex,
    material: binding.material,
    geometry: captureBatchGeometry(binding.geometry),
    ...(binding.lods === undefined ? {} : { lods: Object.freeze([...binding.lods]) }),
    ...(binding.morph === undefined ? {} : { morph: binding.morph }),
  });
}
