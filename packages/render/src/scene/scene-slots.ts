import { type FrameList, FrameListBase, type SparseRowKind } from './frame-list';
import { FrameSet, popcount } from './frame-set';
import { type Node, nodes, put, remove } from './frame-tree';
import { IdentityMap, IdentityMapEditor } from './identity-map';
import { SceneDrawSlot, SceneMeshDrawShapes } from './mesh-draw';
import type { MeshFrame } from './mesh-frame';
import { hasRasterDemand } from './raster-demand';
import type { RenderSceneSlot } from './render-scene-types';
import { type RowChange, RowChangeLog } from './row-change-log';
import type { RowContent } from './row-contents';

const emptySourceCounts = () => ({ terrain: 0, glyph: 0, tilemap: 0, waterMeshSource: 0 });
export type SceneGeneratedSource = keyof ReturnType<typeof emptySourceCounts>;

const PAGE_SHIFT = 6;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;
const POSE = 16;
/** A row view can retain this many poses, independently of its 64-row identity page. */
const POSE_SHIFT = 3;
const POSE_ROWS = 1 << POSE_SHIFT;
const POSE_CHUNKS = PAGE_SIZE / POSE_ROWS;
const poseChunk = (lane: number) => lane >>> POSE_SHIFT;
const poseOffset = (lane: number) => (lane & (POSE_ROWS - 1)) * POSE;
/** Cold per-lane identity: entityKey and generation. Versions follow poses. */
const IDS = 2;
const validSlot = (slot: number) =>
  Number.isSafeInteger(slot) && slot >= 0 && slot < Number.MAX_SAFE_INTEGER;

export function reflectedPose(pose: ArrayLike<number>, offset: number): boolean {
  const a = pose[offset] ?? 0,
    b = pose[offset + 1] ?? 0,
    c = pose[offset + 2] ?? 0;
  const d = pose[offset + 4] ?? 0,
    e = pose[offset + 5] ?? 0,
    f = pose[offset + 6] ?? 0;
  const g = pose[offset + 8] ?? 0,
    h = pose[offset + 9] ?? 0,
    i = pose[offset + 10] ?? 0;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) < 0;
}

/**
 * 64 rows as numeric columns plus one shared-content reference per lane: no
 * object per row. Poses use eight-row chunks so a public matrix window does
 * not retain a complete old page. A captured page is never written again.
 */
interface Page {
  readonly contents: readonly (RowContent | undefined)[];
  readonly ids: Float64Array;
  readonly versions: Float64Array;
  readonly poses: readonly Float32Array[];
  readonly lowMask: number;
  readonly highMask: number;
  readonly count: number;
}
interface WritablePage {
  contents: (RowContent | undefined)[];
  ids: Float64Array;
  versions: Float64Array;
  /** Cold columns are copied only before this pending page actually changes them. */
  ownsContent: boolean;
  poses: Float32Array[];
  /** Pending chunks copied or created by this page; captured chunks are immutable. */
  ownsPoses: number;
  lowMask: number;
  highMask: number;
  count: number;
}

function laneAtRank(page: Page, rank: number): number {
  if (page.count === PAGE_SIZE) return rank;
  const lowCount = popcount(page.lowMask);
  let word = page.lowMask;
  let base = 0;
  if (rank >= lowCount) {
    rank -= lowCount;
    base = 32;
    word = page.highMask;
  }
  while (rank-- > 0) word &= word - 1;
  return base + 31 - Math.clz32(word & -word);
}

/**
 * Lazy row views belong to their immutable column page. Quiet reads do not
 * register each row again. Copying a changed page carries its already read
 * views; version checks retain untouched row identity and replace written lanes.
 * Retired pages release their table through the weak key, without a row sweep.
 */
export class RowViews {
  readonly shapes = new SceneMeshDrawShapes();
  private pages = new WeakMap<Page, (SceneDrawSlot | undefined)[]>();

  copy(before: Page, after: Page): void {
    const views = this.pages.get(before);
    if (views !== undefined) this.pages.set(after, views.slice());
  }

  read(page: Page, slot: number): RenderSceneSlot | undefined {
    const lane = slot & PAGE_MASK;
    const content = page.contents[lane];
    if (content === undefined) return undefined;
    const ids = page.ids;
    const at = lane * IDS;
    const version = page.versions[lane] as number;
    let views = this.pages.get(page);
    if (views === undefined) {
      views = new Array(PAGE_SIZE);
      this.pages.set(page, views);
    }
    let view = views[lane];
    if (view?.version === version) return view;
    const entityKey = ids[at] as number;
    const offset = poseOffset(lane);
    const poses = page.poses[poseChunk(lane)] as Float32Array;
    view = new SceneDrawSlot(
      slot,
      ids[at + 1] as number,
      version,
      entityKey,
      content,
      poses,
      offset,
      this.shapes,
    );
    views[lane] = view;
    return view;
  }

  /** A removed lane must not keep its old content and matrix through the new page. */
  remove(page: Page, slot: number): void {
    const views = this.pages.get(page);
    if (views !== undefined) views[slot & PAGE_MASK] = undefined;
  }

  /** An escaped matrix may still read this pending page's current pose backing. */
  sharesPose(page: Page, slot: number): boolean {
    const view = this.pages.get(page)?.[slot & PAGE_MASK];
    return view !== undefined && view.poseColumn === page.poses[poseChunk(slot & PAGE_MASK)];
  }

  clear(): void {
    this.pages = new WeakMap();
  }
}

function pageVersion(page: Page | undefined, slot: number): number {
  if (page === undefined) return 0;
  const lane = slot & PAGE_MASK;
  return page.contents[lane] === undefined ? 0 : (page.versions[lane] as number);
}

/** A fixed scene root. Rank is derived at consumption; physical slot addresses never move. */
export class SceneSlotFrame extends FrameListBase<RenderSceneSlot> {
  readonly #nativeLength: number;
  readonly length: number;
  private cachedPageIndex = -1;
  private cachedPage: Page | undefined;
  /** Current numeric page for rank and physical-slot readers on this immutable frame. */
  private rankNode: Node<Page> | undefined;
  private rankStart = 0;
  constructor(
    readonly root: Node<Page> | undefined,
    readonly capacity: number,
    readonly identities: IdentityMap = IdentityMap.EMPTY,
    private readonly views: RowViews = new RowViews(),
    private readonly log?: RowChangeLog,
    /** This frame's cursor in its owner's row-change log. */
    private readonly position = 0,
    private readonly sparse?: Readonly<Record<SparseRowKind, FrameSet>>,
    /**
     * Identity of every row's shared content and entity identity. Frames of one
     * owner keep the token across pose-only writes; ownerless frames have none.
     */
    readonly contentEpoch?: object,
    /** Whether this exact row root can contribute authored or generated Water draws. */
    readonly mayHaveWaterSources = true,
    /** Captured from live membership; ownerless frames have no default-layer proof. */
    readonly allDefaultRenderLayers = false,
  ) {
    super();
    this.length = root?.count ?? 0;
    this.#nativeLength = this.length;
  }

  /** Sparse membership captured with this row root; ownerless frames may have no index proof. */
  indexedSlots(kind: SparseRowKind): FrameSet | undefined {
    return this.sparse?.[kind];
  }

  identitySlot(entity: number): number | undefined {
    return this.identities.get(entity);
  }

  readonly lookup = (entity: number): RenderSceneSlot | undefined => {
    const slot = this.identitySlot(entity);
    return slot === undefined ? undefined : this.slotAt(slot);
  };

  pageAt(page: number): Page | undefined {
    // Both hits and misses belong to this captured, immutable root.
    if (page === this.cachedPageIndex) return this.cachedPage;
    let node = this.root;
    while (node !== undefined) {
      if (page === node.key) break;
      node = page < node.key ? node.left : node.right;
    }
    this.cachedPageIndex = page;
    this.cachedPage = node?.value;
    return this.cachedPage;
  }

  readonly slotAt = (slot: number): RenderSceneSlot | undefined => {
    if (!validSlot(slot)) return undefined;
    const page = this.pageAt(Math.floor(slot / PAGE_SIZE));
    return page === undefined ? undefined : this.views.read(page, slot);
  };

  /** The row's version in this frame (0 when absent), without materializing it. */
  versionAt(slot: number): number {
    return validSlot(slot) ? pageVersion(this.pageAt(Math.floor(slot / PAGE_SIZE)), slot) : 0;
  }

  at(index: number): RenderSceneSlot | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    let node = this.root;
    while (node !== undefined) {
      const left = node.left?.count ?? 0;
      if (index < left) node = node.left;
      else if (index >= left + node.weight) {
        index -= left + node.weight;
        node = node.right;
      } else {
        return this.views.read(
          node.value,
          node.key * PAGE_SIZE + laneAtRank(node.value, index - left),
        );
      }
    }
    return undefined;
  }

  /** A native captured root with no overridden indexed reader; never invokes an at getter. */
  static hasNativeAt(frame: FrameList<RenderSceneSlot>): frame is SceneSlotFrame {
    return (
      #nativeLength in frame &&
      Object.getPrototypeOf(frame) === SceneSlotFrame.prototype &&
      Object.getOwnPropertyDescriptor(frame, 'at') === undefined &&
      Object.getOwnPropertyDescriptor(frame, 'length')?.value === frame.#nativeLength &&
      Object.getOwnPropertyDescriptor(SceneSlotFrame.prototype, 'at')?.value === sceneSlotFrameAt
    );
  }

  /** Find the first consumer result in the immutable page and occupied-lane order.
   * Returning a result stops before the next row or Mesh is observed. */
  findContent<T>(
    visit: (content: RowContent, entity: number, slot: number) => T | undefined,
  ): T | undefined {
    for (const node of nodes(this.root)) {
      const page = node.value;
      const first = node.key * PAGE_SIZE;
      for (let half = 0; half < PAGE_SIZE; half += 32) {
        let word = half === 0 ? page.lowMask : page.highMask;
        while (word !== 0) {
          const lane = half + 31 - Math.clz32(word & -word);
          word &= word - 1;
          const result = visit(
            page.contents[lane] as RowContent,
            page.ids[lane * IDS] as number,
            first + lane,
          );
          if (result !== undefined) return result;
        }
      }
    }
    return undefined;
  }

  /** Resolve the exact same Mesh and appended water materials as the public draw row. */
  drawContent(content: RowContent, meshes: MeshFrame): RowContent {
    return this.views.shapes.resolve(content, meshes);
  }

  static hasNativeIteration(frame: SceneSlotFrame): boolean {
    return (
      Object.getPrototypeOf(frame) === SceneSlotFrame.prototype &&
      Object.getOwnPropertyDescriptor(frame, Symbol.iterator) === undefined &&
      Object.getOwnPropertyDescriptor(SceneSlotFrame.prototype, Symbol.iterator)?.value ===
        sceneSlotIterator
    );
  }

  /** Read cold columns by physical slot without deriving its frame rank or full row. */
  readContentSlot<T>(
    slot: number,
    read: (content: RowContent, entityKey: number, slot: number) => T,
  ): T | undefined {
    if (!validSlot(slot)) return undefined;
    const page = this.pageAt(Math.floor(slot / PAGE_SIZE));
    const lane = slot & PAGE_MASK;
    const content = page?.contents[lane];
    return content === undefined || page === undefined
      ? undefined
      : read(content, page.ids[lane * IDS] as number, slot);
  }

  /** Read cold columns at a frame rank without creating a pose window or full row. */
  readContentAt<T>(
    index: number,
    read: (content: RowContent, entityKey: number, slot: number) => T,
  ): T | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    // The current page and its base rank belong to this immutable frame.
    let node = this.rankNode;
    let start = this.rankStart;
    let target: number;
    if (node !== undefined && index >= start && index < start + node.weight) {
      target = index - start;
    } else {
      node = this.root;
      let rest = index;
      let left = 0;
      while (node !== undefined) {
        left = node.left?.count ?? 0;
        if (rest < left) node = node.left;
        else if (rest >= left + node.weight) {
          rest -= left + node.weight;
          node = node.right;
        } else break;
      }
      if (node === undefined) return undefined;
      target = rest - left;
      start = index - target;
    }
    this.rankNode = node;
    this.rankStart = start;
    const lane = laneAtRank(node.value, target);
    return read(
      node.value.contents[lane] as RowContent,
      node.value.ids[lane * IDS] as number,
      node.key * PAGE_SIZE + lane,
    );
  }

  /**
   * Visit the row changes logged between `previous` and this frame of the
   * same owner, in O(changes). `false` (nothing visited) when the frames have
   * different owners or the log no longer holds `previous`'s cursor.
   */
  /** The owner's row journal; `undefined` for an ownerless frame. */
  get journal(): RowChangeLog | undefined {
    return this.log;
  }

  changesSince(
    previous: SceneSlotFrame,
    visit: (slot: number, kind: RowChange, generation: number) => void,
  ): boolean {
    if (this.log === undefined || previous.log !== this.log) return false;
    return this.log.visit(previous.position, this.position, visit);
  }

  /** Resolve only one known slot when assembling its actual dispatch entry. */
  indexOfSlot(slot: number): number | undefined {
    if (!validSlot(slot)) return undefined;
    // Capacity is the exclusive physical high-water address. A full domain has rank equal to slot.
    if (this.#nativeLength === this.capacity) return slot < this.capacity ? slot : undefined;
    const page = Math.floor(slot / PAGE_SIZE);
    let node = this.rankNode;
    if (node === undefined || node.key !== page) {
      node = this.root;
      let start = 0;
      while (node !== undefined && node.key !== page) {
        if (page < node.key) node = node.left;
        else {
          start += (node.left?.count ?? 0) + node.weight;
          node = node.right;
        }
      }
      if (node === undefined) return undefined;
      this.rankNode = node;
      this.rankStart = start + (node.left?.count ?? 0);
    }
    const lane = slot & PAGE_MASK;
    if (node.weight === PAGE_SIZE) return this.rankStart + lane;
    const mask = lane < 32 ? node.value.lowMask : node.value.highMask;
    const bit = 1 << (lane & 31);
    if ((mask & bit) === 0) return undefined;
    return (
      this.rankStart + (lane < 32 ? 0 : popcount(node.value.lowMask)) + popcount(mask & (bit - 1))
    );
  }

  [Symbol.iterator](): IterableIterator<RenderSceneSlot> {
    return new SceneSlotIterator(this.root, this.views);
  }
}

/** Each walk pins its own immutable pages and has one result cell. Only occupied lanes visit RowViews. */
class SceneSlotIterator implements IterableIterator<RenderSceneSlot> {
  private pages: IterableIterator<Node<Page>> | undefined;
  private page: Page | undefined;
  private base = 0;
  private word = 0;
  private high = 0;
  private readonly result: { value: RenderSceneSlot | undefined; done: boolean } = {
    value: undefined,
    done: false,
  };

  constructor(
    root: Node<Page> | undefined,
    private readonly views: RowViews,
  ) {
    this.pages = nodes(root);
  }

  next(): IteratorResult<RenderSceneSlot> {
    while (this.word === 0) {
      if (this.high !== 0) {
        this.base += 32;
        this.word = this.high;
        this.high = 0;
      } else {
        const next = this.pages?.next();
        if (next === undefined || next.done) return this.return();
        this.page = next.value.value;
        this.base = next.value.key * PAGE_SIZE;
        this.word = this.page.lowMask;
        this.high = this.page.highMask;
      }
    }
    const lane = 31 - Math.clz32(this.word & -this.word);
    this.word &= this.word - 1;
    this.result.value = this.views.read(this.page as Page, this.base + lane);
    return this.result as IteratorResult<RenderSceneSlot>;
  }

  return(): IteratorResult<RenderSceneSlot> {
    this.pages = undefined;
    this.page = undefined;
    this.word = this.high = 0;
    this.result.value = undefined;
    this.result.done = true;
    return this.result as IteratorResult<RenderSceneSlot>;
  }

  [Symbol.iterator](): IterableIterator<RenderSceneSlot> {
    return this;
  }
}

type MeshLodState = 'absent' | 'lods' | 'plain';

interface LodBucket {
  instances: number;
  withSourceLods: number;
  mesh: MeshLodState;
}

/**
 * Candidate count of rows whose draw projection carries LOD levels: a row drawn
 * through its shared Mesh reads that Mesh's levels, every other row its own.
 * Maintained from slot writes and Mesh changes, so a frame reads it in O(1).
 */
const sceneSlotFrameAt = SceneSlotFrame.prototype.at;
const sceneSlotIterator = SceneSlotFrame.prototype[Symbol.iterator];

class LodCandidates {
  total = 0;
  private readonly buckets = new Map<number, LodBucket>();
  private static contribution(bucket: LodBucket): number {
    return bucket.mesh === 'absent'
      ? bucket.withSourceLods
      : bucket.mesh === 'lods'
        ? bucket.instances
        : 0;
  }

  slot(snapshot: RowContent, sign: 1 | -1): void {
    const hasLods = (snapshot.lods?.length ?? 0) > 0 ? 1 : 0;
    if (
      snapshot.terrain !== undefined ||
      snapshot.materialOverrides === undefined ||
      snapshot.assetHandle === undefined
    ) {
      this.total += sign * hasLods;
      return;
    }
    const key = snapshot.assetHandle;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { instances: 0, withSourceLods: 0, mesh: 'absent' };
      this.buckets.set(key, bucket);
    }
    const before = LodCandidates.contribution(bucket);
    bucket.instances += sign;
    bucket.withSourceLods += sign * hasLods;
    this.total += LodCandidates.contribution(bucket) - before;
    if (bucket.instances === 0 && bucket.mesh === 'absent') this.buckets.delete(key);
  }

  mesh(handle: number, lods: boolean | undefined): void {
    const key = handle;
    const state: MeshLodState = lods === undefined ? 'absent' : lods ? 'lods' : 'plain';
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (state === 'absent') return;
      bucket = { instances: 0, withSourceLods: 0, mesh: 'absent' };
      this.buckets.set(key, bucket);
    }
    const before = LodCandidates.contribution(bucket);
    bucket.mesh = state;
    this.total += LodCandidates.contribution(bucket) - before;
    if (bucket.instances === 0 && state === 'absent') this.buckets.delete(key);
  }

  clearMeshes(): void {
    for (const [key, bucket] of this.buckets) {
      this.total -= LodCandidates.contribution(bucket);
      bucket.mesh = 'absent';
      this.total += LodCandidates.contribution(bucket);
      if (bucket.instances === 0) this.buckets.delete(key);
    }
  }
}

/** Fixed sparse membership; known row edits copy only touched numeric bitmap pages. */
class SlotIndex {
  private members = new FrameSet();
  private readonly pending = new Map<number, boolean>();

  set(slot: number, member: boolean): void {
    if (member === (this.pending.get(slot) ?? this.members.has(slot))) return;
    this.pending.set(slot, member);
  }

  slots(): FrameSet {
    if (this.pending.size > 0) {
      this.members = this.members.edit(this.pending);
      this.pending.clear();
    }
    return this.members;
  }
}

/** One row write: identity, shared content and a pose read from `pose` at `offset`. */
export interface SceneRowWrite {
  readonly entityKey: number;
  readonly generation: number;
  readonly content: RowContent;
  readonly pose: ArrayLike<number>;
  readonly poseOffset?: number;
}

/** An unpublished address from this owner; neither rows nor captured frames include it. */
export interface SceneSlotReservation {
  readonly slot: number;
  readonly generation: number;
  isCurrent(): boolean;
  publish(row: SceneRowWrite): RenderSceneSlot;
  release(): void;
}

/** One mutable owner; known writes coalesce per page before a frame is captured. */
export class SceneSlots {
  private readonly views = new RowViews();
  private readonly log = new RowChangeLog();
  /** The one row journal of this owner, shared by row and GPU content consumers. */
  get journal(): RowChangeLog {
    return this.log;
  }
  private contentEpoch: object | undefined = Object.freeze({});
  private frame = new SceneSlotFrame(
    undefined,
    0,
    IdentityMap.EMPTY,
    this.views,
    this.log,
    0,
    undefined,
    this.contentEpoch,
    false,
  );
  private readonly pending = new Map<number, WritablePage>();
  private identities = new IdentityMapEditor();
  private highWater = 0;
  private live = 0;
  private versions = 0;
  private newPages = 0;
  private copiedPages = 0;
  private copiedBytes = 0;
  private sourceCounts = emptySourceCounts();
  private authoredWaterOwners = 0;
  private nonDefaultRenderLayers = 0;
  private lods = new LodCandidates();
  private terrainSlots = new SlotIndex();
  private viewSourceSlots = new SlotIndex();
  private capsuleSlots = new SlotIndex();
  private pointsLinesSlots = new SlotIndex();
  private skinSlots = new SlotIndex();
  private rasterSlots = new SlotIndex();
  /** Released addresses, reused last-in first-out; generations survive reuse. */
  private readonly freeSlots: number[] = [];
  private generations = new Uint32Array(64);
  private nextAddress = 0;
  private readonly reservations = new Map<number, SceneSlotReservation>();

  /**
   * The GPU row address for a new row: the most recently released slot with
   * its next generation, or a fresh address past the high-water mark.
   */
  allocate(): { readonly slot: number; readonly generation: number } {
    const reused = this.freeSlots.pop();
    if (reused === undefined) return { slot: this.nextAddress++, generation: 0 };
    const generation = (this.generations[reused] as number) + 1;
    this.generations[reused] = generation;
    return { slot: reused, generation };
  }

  reserve(): SceneSlotReservation {
    const { slot, generation } = this.allocate();
    let owner: SceneSlots | undefined = this;
    const current = () => owner?.reservations.get(slot) === api;
    const api: SceneSlotReservation = Object.freeze({
      slot,
      generation,
      isCurrent: current,
      publish: (row: SceneRowWrite) => {
        const target = owner;
        if (target === undefined || !current() || row.generation !== generation)
          throw new Error('Scene slot reservation is not current');
        const record = target.writeRow(slot, row);
        target.reservations.delete(slot);
        owner = undefined;
        return record;
      },
      release: () => {
        const target = owner;
        if (target !== undefined && current()) {
          if (target.content(slot) !== undefined)
            throw new Error('A partially published Scene slot retains its cleanup responsibility');
          target.reservations.delete(slot);
          target.ensureGeneration(slot);
          target.generations[slot] = generation;
          target.freeSlots.push(slot);
        }
        owner = undefined;
      },
    });
    this.reservations.set(slot, api);
    return api;
  }

  get freeCount(): number {
    return this.freeSlots.length;
  }

  /** Ascending addresses of rows carrying Terrain, a requested capsule shadow, a Skin Binding, or Points/Lines. */
  indexedSlots(kind: SparseRowKind): FrameSet {
    switch (kind) {
      case 'terrain':
        return this.terrainSlots.slots();
      case 'viewSource':
        return this.viewSourceSlots.slots();
      case 'capsule':
        return this.capsuleSlots.slots();
      case 'skin':
        return this.skinSlots.slots();
      case 'raster':
        return this.rasterSlots.slots();
      case 'pointsLines':
        return this.pointsLinesSlots.slots();
    }
  }

  /** Rows whose draw projection has LOD levels, given the Meshes reported by `setMeshLods`. */
  get lodCandidateCount(): number {
    return this.lods.total;
  }

  /** `undefined` reports the shared Mesh as not resident in the draw frame. */
  setMeshLods(handle: number, lods: boolean | undefined): void {
    this.lods.mesh(handle, lods);
  }

  clearMeshLods(): void {
    this.lods.clearMeshes();
  }

  hasSource(kind: SceneGeneratedSource): boolean {
    return this.sourceCounts[kind] > 0;
  }

  get capacity(): number {
    return this.highWater;
  }
  get size(): number {
    return this.live;
  }

  lookup(entity: number): RenderSceneSlot | undefined {
    const slot = this.identities.get(entity);
    return slot === undefined ? undefined : this.get(slot);
  }

  slotOf(entity: number): number | undefined {
    return this.identities.get(entity);
  }

  private page(slot: number): Page | undefined {
    const key = Math.floor(slot / PAGE_SIZE);
    return this.pending.get(key) ?? this.frame.pageAt(key);
  }

  get(slot: number): RenderSceneSlot | undefined {
    if (!validSlot(slot)) return undefined;
    const page = this.page(slot);
    return page === undefined ? undefined : this.views.read(page, slot);
  }

  /** The current row's version (0 when absent): a write always changes it. */
  version(slot: number): number {
    return validSlot(slot) ? pageVersion(this.page(slot), slot) : 0;
  }

  /** Compare a synchronous source window without creating a row, snapshot or matrix view. */
  comparePose(
    slot: number,
    source: ArrayLike<number>,
    offset = 0,
  ): 'absent' | 'unchanged' | 'pose' | 'parity' {
    const page = validSlot(slot) ? this.page(slot) : undefined;
    if (page?.contents[slot & PAGE_MASK] === undefined) return 'absent';
    const lane = slot & PAGE_MASK;
    const poses = page.poses[poseChunk(lane)] as Float32Array;
    const base = poseOffset(lane);
    for (let index = 0; index < POSE; index++) {
      if (poses[base + index] === (source[offset + index] ?? 0)) continue;
      return reflectedPose(poses, base) !== reflectedPose(source, offset) ? 'parity' : 'pose';
    }
    return 'unchanged';
  }

  /** The current row's shared content, without materializing a read view. */
  content(slot: number): RowContent | undefined {
    return validSlot(slot) ? this.page(slot)?.contents[slot & PAGE_MASK] : undefined;
  }

  private writable(slot: number, content: boolean): WritablePage {
    const key = Math.floor(slot / PAGE_SIZE);
    let page = this.pending.get(key);
    if (page === undefined) {
      const before = this.frame.pageAt(key);
      page =
        before === undefined
          ? {
              contents: new Array(PAGE_SIZE),
              ids: new Float64Array(PAGE_SIZE * IDS),
              versions: new Float64Array(PAGE_SIZE),
              ownsContent: true,
              poses: Array.from({ length: POSE_CHUNKS }, () => new Float32Array(POSE_ROWS * POSE)),
              ownsPoses: (1 << POSE_CHUNKS) - 1,
              lowMask: 0,
              highMask: 0,
              count: 0,
            }
          : {
              // These columns remain immutable until an actual content write.
              contents: before.contents as (RowContent | undefined)[],
              ids: before.ids,
              versions: before.versions.slice(),
              ownsContent: false,
              poses: before.poses.slice(),
              ownsPoses: 0,
              lowMask: before.lowMask,
              highMask: before.highMask,
              count: before.count,
            };
      if (before !== undefined) this.views.copy(before, page);
      this.pending.set(key, page);
      if (before === undefined) this.newPages++;
      else {
        this.copiedPages++;
        this.copiedBytes += PAGE_SIZE * 8 + POSE_CHUNKS * 8;
      }
    }
    if (content && !page.ownsContent) {
      page.contents = page.contents.slice();
      page.ids = page.ids.slice();
      page.ownsContent = true;
      this.copiedBytes += PAGE_SIZE * (8 + IDS * 8);
    }
    return page;
  }

  /** Protect row/matrix observations returned before this pending page was captured. */
  private writablePose(slot: number, content: boolean): WritablePage {
    const page = this.writable(slot, content);
    const chunk = poseChunk(slot & PAGE_MASK);
    const mask = 1 << chunk;
    if ((page.ownsPoses & mask) === 0 || this.views.sharesPose(page, slot)) {
      const poses = page.poses[chunk] as Float32Array;
      page.poses[chunk] = poses.slice();
      page.ownsPoses |= mask;
      this.copiedBytes += poses.byteLength;
    }
    return page;
  }

  /**
   * History covers about two full-scene rewrites before old cursors lapse;
   * GPU content entries (up to three per changed row) share the ring.
   */
  private logChange(slot: number, kind: RowChange, generation: number): void {
    this.log.append(slot, kind, generation, 8 * this.live);
  }

  private nextVersion(): number {
    this.versions++;
    return this.versions;
  }

  private account(slot: number, content: RowContent | undefined, sign: 1 | -1): void {
    if (content === undefined) return;
    if (content.terrain !== undefined) this.sourceCounts.terrain += sign;
    if (content.glyph !== undefined) this.sourceCounts.glyph += sign;
    if (content.tilemap !== undefined) this.sourceCounts.tilemap += sign;
    if (content.waterMeshSource !== undefined) this.sourceCounts.waterMeshSource += sign;
    if (content.waterOwner !== undefined) this.authoredWaterOwners += sign;
    if ((content.renderLayers ?? 1) !== 1) this.nonDefaultRenderLayers += sign;
    this.lods.slot(content, sign);
    if (sign === 1) {
      this.terrainSlots.set(slot, content.terrain !== undefined);
      this.viewSourceSlots.set(
        slot,
        content.glyph !== undefined ||
          content.tilemap !== undefined ||
          content.terrain !== undefined ||
          content.terrainSection !== undefined ||
          content.generatedMesh !== undefined,
      );
      this.capsuleSlots.set(slot, content.capsuleShadowRequested === true);
      this.pointsLinesSlots.set(slot, content.pointsLines !== undefined);
      this.skinSlots.set(slot, content.skinBinding !== undefined);
      this.rasterSlots.set(slot, hasRasterDemand(content));
    }
  }

  /** Write one complete row; returns its new read view. */
  write(slot: number, row: SceneRowWrite): RenderSceneSlot {
    if (this.reservations.has(slot))
      throw new Error('An unpublished Scene slot belongs to its reservation');
    return this.writeRow(slot, row);
  }

  private writeRow(slot: number, row: SceneRowWrite): RenderSceneSlot {
    if (!validSlot(slot)) throw new RangeError('Scene write requires a non-negative slot address');
    const page = this.writablePose(slot, true);
    const lane = slot & PAGE_MASK;
    const at = lane * IDS;
    const previous = page.contents[lane];
    const ids = page.ids;
    let change: RowChange = 'enter';
    if (previous !== undefined) {
      const entityKey = ids[at] as number;
      this.account(slot, previous, -1);
      if (entityKey !== row.entityKey) {
        if (this.identities.get(entityKey) === slot) this.identities.delete(entityKey);
        this.identities.set(row.entityKey, slot);
        this.logChange(slot, 'leave', ids[at + 1] as number);
      } else change = 'update';
    } else {
      if (lane < 32) page.lowMask |= 1 << lane;
      else page.highMask |= 1 << (lane - 32);
      page.count++;
      this.live++;
      this.identities.set(row.entityKey, slot);
    }
    this.logChange(slot, change, row.generation);
    if (change !== 'update' || previous !== row.content || ids[at + 1] !== row.generation)
      this.contentEpoch = undefined;
    page.contents[lane] = row.content;
    ids[at] = row.entityKey;
    ids[at + 1] = row.generation;
    page.versions[lane] = this.nextVersion();
    const offset = row.poseOffset ?? 0;
    const poses = page.poses[poseChunk(lane)] as Float32Array;
    const base = poseOffset(lane);
    for (let index = 0; index < POSE; index++) poses[base + index] = row.pose[offset + index] ?? 0;
    this.account(slot, row.content, 1);
    this.highWater = Math.max(this.highWater, slot + 1);
    this.nextAddress = Math.max(this.nextAddress, slot + 1);
    this.ensureGeneration(slot);
    this.generations[slot] = row.generation;
    return this.views.read(page, slot) as RenderSceneSlot;
  }

  private ensureGeneration(slot: number): void {
    if (slot >= this.generations.length) {
      let capacity = this.generations.length;
      while (capacity <= slot) capacity *= 2;
      const grown = new Uint32Array(capacity);
      grown.set(this.generations);
      this.generations = grown;
    }
  }

  /** Replace only the live row's pose; returns its new read view. */
  writePose(slot: number, pose: ArrayLike<number>, offset = 0): RenderSceneSlot {
    const page = this.writablePose(slot, false);
    const lane = slot & PAGE_MASK;
    if (page.contents[lane] === undefined)
      throw new RangeError('A pose write requires a live Scene row');
    page.versions[lane] = this.nextVersion();
    this.logChange(slot, 'update', page.ids[lane * IDS + 1] as number);
    const poses = page.poses[poseChunk(lane)] as Float32Array;
    const base = poseOffset(lane);
    for (let index = 0; index < POSE; index++) poses[base + index] = pose[offset + index] ?? 0;
    return this.views.read(page, slot) as RenderSceneSlot;
  }

  /** Remove the live row and release its address for reuse. */
  remove(slot: number): void {
    if (!validSlot(slot))
      throw new RangeError('Scene removal requires a non-negative slot address');
    if (this.content(slot) === undefined) return;
    this.freeSlots.push(slot);
    const page = this.writable(slot, true);
    const lane = slot & PAGE_MASK;
    const at = lane * IDS;
    const entityKey = page.ids[at] as number;
    this.account(slot, page.contents[lane], -1);
    this.terrainSlots.set(slot, false);
    this.viewSourceSlots.set(slot, false);
    this.capsuleSlots.set(slot, false);
    this.pointsLinesSlots.set(slot, false);
    this.skinSlots.set(slot, false);
    this.rasterSlots.set(slot, false);
    if (this.identities.get(entityKey) === slot) this.identities.delete(entityKey);
    this.logChange(slot, 'leave', page.ids[at + 1] as number);
    this.contentEpoch = undefined;
    page.contents[lane] = undefined;
    this.views.remove(page, slot);
    if (lane < 32) page.lowMask &= ~(1 << lane);
    else page.highMask &= ~(1 << (lane - 32));
    page.count--;
    this.live--;
  }

  capture(): SceneSlotFrame {
    const identities = this.identities.capture();
    if (this.pending.size === 0 && identities === this.frame.identities) return this.frame;
    let root = this.frame.root;
    for (const [key, page] of this.pending)
      root = page.count === 0 ? remove(root, 0, key) : put(root, page, 0, key, page.count);
    this.pending.clear();
    this.contentEpoch ??= Object.freeze({});
    this.frame = new SceneSlotFrame(
      root,
      this.highWater,
      identities,
      this.views,
      this.log,
      this.log.position,
      {
        terrain: this.indexedSlots('terrain'),
        viewSource: this.indexedSlots('viewSource'),
        capsule: this.indexedSlots('capsule'),
        skin: this.indexedSlots('skin'),
        raster: this.indexedSlots('raster'),
        pointsLines: this.indexedSlots('pointsLines'),
      },
      this.contentEpoch,
      this.authoredWaterOwners > 0 || this.hasSource('waterMeshSource'),
      this.nonDefaultRenderLayers === 0,
    );
    return this.frame;
  }

  clear(): void {
    this.pending.clear();
    this.identities.clear();
    this.views.clear();
    this.log.reset();
    this.contentEpoch = Object.freeze({});
    this.frame = new SceneSlotFrame(
      undefined,
      0,
      IdentityMap.EMPTY,
      this.views,
      this.log,
      this.log.position,
      undefined,
      this.contentEpoch,
      false,
    );
    this.highWater = 0;
    this.nextAddress = 0;
    this.reservations.clear();
    this.live = 0;
    this.freeSlots.length = 0;
    this.generations = new Uint32Array(64);
    this.sourceCounts = emptySourceCounts();
    this.authoredWaterOwners = 0;
    this.nonDefaultRenderLayers = 0;
    this.lods = new LodCandidates();
    this.terrainSlots = new SlotIndex();
    this.viewSourceSlots = new SlotIndex();
    this.capsuleSlots = new SlotIndex();
    this.pointsLinesSlots = new SlotIndex();
    this.skinSlots = new SlotIndex();
    this.rasterSlots = new SlotIndex();
  }

  inspect(): {
    newPages: number;
    copiedPages: number;
    estimatedCopiedPagePointerBytes: number;
    live: number;
    capacity: number;
  } {
    return {
      newPages: this.newPages,
      copiedPages: this.copiedPages,
      estimatedCopiedPagePointerBytes: this.copiedBytes,
      live: this.live,
      capacity: this.highWater,
    };
  }
}
function entityOf(_content: RowContent, entity: number): number {
  return entity;
}

/** The identities admitted by this view's fixed Scene rows. Physical membership,
 * source iteration order and entity lookup all refer to the same captured frame. */
export class SlotIdentityKeys implements ReadonlySet<number> {
  constructor(
    private readonly roster: SceneSlotFrame,
    private readonly members?: FrameSet,
    private readonly sourceOrder = false,
  ) {}
  get size(): number {
    return this.members?.size ?? this.roster.identities.size;
  }
  usesSlotsOf(frame: SceneSlotFrame): boolean {
    return this.roster.journal !== undefined && this.roster.journal === frame.journal;
  }
  /** Visit physical slots whose admitted identity may have changed. The journal
   * covers reuse at one address. The view bitmap covers motion across its frustum. */
  changesSince(previous: SlotIdentityKeys, visit: (slot: number) => void): boolean {
    if (!this.usesSlotsOf(previous.roster)) return false;
    const before = previous.members;
    const after = this.members;
    if (
      this.roster.identities !== previous.roster.identities &&
      !this.roster.changesSince(previous.roster, (slot, kind) => {
        if (kind !== 'update' && (before?.has(slot) !== false || after?.has(slot) !== false))
          visit(slot);
      })
    )
      return false;
    if (before === after) return true;
    if (before !== undefined && after !== undefined) {
      after.changesSince(before, visit);
    } else {
      // Only a full/subset transition needs to enumerate the full frame's addresses.
      const partial = after ?? before;
      const full = after === undefined ? this.roster : previous.roster;
      full.findContent((_content, _entity, slot) => {
        if (!partial?.has(slot)) visit(slot);
        return undefined;
      });
    }
    return true;
  }
  has(entity: number): boolean {
    const slot = this.roster.identitySlot(entity);
    return slot !== undefined && this.members?.has(slot) !== false;
  }
  *values(): SetIterator<number> {
    if (this.members !== undefined) {
      for (const slot of this.members.borrowKeys()) {
        const entity = this.roster.readContentSlot(slot, entityOf);
        if (entity !== undefined) yield entity;
      }
    } else if (this.sourceOrder) {
      for (let rank = 0; rank < this.roster.length; rank++) {
        const entity = this.roster.readContentAt(rank, entityOf);
        if (entity !== undefined) yield entity;
      }
    } else {
      for (const [entity] of this.roster.identities.entries()) yield entity;
    }
  }
  keys(): SetIterator<number> {
    return this.values();
  }
  *entries(): SetIterator<[number, number]> {
    for (const key of this.values()) yield [key, key];
  }
  [Symbol.iterator](): SetIterator<number> {
    return this.values();
  }
  forEach(visit: (value: number, key: number, set: ReadonlySet<number>) => void): void {
    for (const key of this.values()) visit(key, key, this);
  }
}
