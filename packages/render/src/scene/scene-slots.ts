import { worldEntityKey } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';
import { FrameListBase, type SparseRowKind } from './frame-list';
import { FrameSet } from './frame-set';
import { type Node, put, remove } from './frame-tree';
import { IdentityMap, IdentityMapEditor } from './identity-map';
import { hasRasterDemand } from './raster-demand';
import type { RenderSceneSlot } from './render-scene-types';
import { type RowChange, RowChangeLog } from './row-change-log';
import type { RowContent } from './row-contents';

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
/** Cold per-lane identity: worldId, entityKey and generation. Versions follow poses. */
const IDS = 3;
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
  count: number;
}

/**
 * Lazy row views belong to their immutable column page. Quiet reads do not
 * register each row again. Copying a changed page carries its already read
 * views; version checks retain untouched row identity and replace written lanes.
 * Retired pages release their table through the weak key, without a row sweep.
 */
export class RowViews {
  private pages = new WeakMap<Page, (RenderSceneSlot | undefined)[]>();

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
    const worldId = ids[at] as number;
    const entityKey = ids[at + 1] as number;
    const offset = poseOffset(lane);
    const poses = page.poses[poseChunk(lane)] as Float32Array;
    const world = poses.subarray(offset, offset + POSE);
    view = {
      slot,
      generation: ids[at + 2] as number,
      version,
      worldId,
      entityKey,
      snapshot: { ...content, worldId, entityKey, transform: { world } } as RenderableSnapshot,
    };
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
    const pose = this.pages.get(page)?.[slot & PAGE_MASK]?.snapshot.transform.world;
    return pose?.buffer === page.poses[poseChunk(slot & PAGE_MASK)]?.buffer;
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
  readonly length: number;
  private cachedPageIndex = -1;
  private cachedPage: Page | undefined;
  constructor(
    readonly root: Node<Page> | undefined,
    readonly capacity: number,
    readonly identities: IdentityMap = IdentityMap.EMPTY,
    private readonly views: RowViews = new RowViews(),
    private readonly log?: RowChangeLog,
    /** This frame's cursor in its owner's row-change log. */
    private readonly position = 0,
    private readonly sparse?: Readonly<Record<SparseRowKind, FrameSet>>,
  ) {
    super();
    this.length = root?.count ?? 0;
  }

  /** Sparse membership captured with this row root; ownerless frames may have no index proof. */
  indexedSlots(kind: SparseRowKind): FrameSet | undefined {
    return this.sparse?.[kind];
  }

  identitySlot(worldId: number, entity: number): number | undefined {
    return this.identities.get(worldId, entity);
  }

  readonly lookup = (worldId: number, entity: number): RenderSceneSlot | undefined => {
    const slot = this.identitySlot(worldId, entity);
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
        index -= left;
        for (let lane = 0; lane < PAGE_SIZE; lane++) {
          if (node.value.contents[lane] !== undefined && index-- === 0)
            return this.views.read(node.value, node.key * PAGE_SIZE + lane);
        }
        return undefined;
      }
    }
    return undefined;
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
    const page = Math.floor(slot / PAGE_SIZE);
    let node = this.root;
    let rank = 0;
    while (node !== undefined) {
      if (page < node.key) node = node.left;
      else if (page > node.key) {
        rank += (node.left?.count ?? 0) + node.weight;
        node = node.right;
      } else {
        const lane = slot & PAGE_MASK;
        if (node.value.contents[lane] === undefined) return undefined;
        rank += node.left?.count ?? 0;
        for (let index = 0; index < lane; index++)
          if (node.value.contents[index] !== undefined) rank++;
        return rank;
      }
    }
    return undefined;
  }

  *[Symbol.iterator](): Generator<RenderSceneSlot> {
    const pending: Node<Page>[] = [];
    let node = this.root;
    while (node !== undefined || pending.length > 0) {
      while (node !== undefined) {
        pending.push(node);
        node = node.left;
      }
      const current = pending.pop();
      if (current === undefined) return;
      for (let lane = 0; lane < PAGE_SIZE; lane++) {
        const slot = this.views.read(current.value, current.key * PAGE_SIZE + lane);
        if (slot !== undefined) yield slot;
      }
      node = current.right;
    }
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
class LodCandidates {
  total = 0;
  private readonly buckets = new Map<string, LodBucket>();

  private static key(worldId: number, handle: number): string {
    return `${worldId}:${handle}`;
  }

  private static contribution(bucket: LodBucket): number {
    return bucket.mesh === 'absent'
      ? bucket.withSourceLods
      : bucket.mesh === 'lods'
        ? bucket.instances
        : 0;
  }

  slot(worldId: number, snapshot: RowContent, sign: 1 | -1): void {
    const hasLods = (snapshot.lods?.length ?? 0) > 0 ? 1 : 0;
    if (
      snapshot.terrain !== undefined ||
      snapshot.materialOverrides === undefined ||
      snapshot.assetHandle === undefined
    ) {
      this.total += sign * hasLods;
      return;
    }
    const key = LodCandidates.key(worldId, snapshot.assetHandle);
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

  mesh(worldId: number, handle: number, lods: boolean | undefined): void {
    const key = LodCandidates.key(worldId, handle);
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
  readonly worldId: number;
  readonly entityKey: number;
  readonly generation: number;
  readonly content: RowContent;
  readonly pose: ArrayLike<number>;
  readonly poseOffset?: number;
}

/** One mutable owner; known writes coalesce per page before a frame is captured. */
export class SceneSlots {
  private readonly views = new RowViews();
  private readonly log = new RowChangeLog();
  /** The one row journal of this owner, shared by row and GPU content consumers. */
  get journal(): RowChangeLog {
    return this.log;
  }
  private frame = new SceneSlotFrame(undefined, 0, IdentityMap.EMPTY, this.views, this.log);
  private readonly pending = new Map<number, WritablePage>();
  private identities = new IdentityMapEditor();
  private highWater = 0;
  private live = 0;
  private versions = 0;
  private newPages = 0;
  private copiedPages = 0;
  private copiedBytes = 0;
  private terrainCount = 0;
  private glyphCount = 0;
  private tilemapCount = 0;
  private lods = new LodCandidates();
  private terrainSlots = new SlotIndex();
  private capsuleSlots = new SlotIndex();
  private pointsLinesSlots = new SlotIndex();
  private skinSlots = new SlotIndex();
  private rasterSlots = new SlotIndex();
  /** Released addresses, reused last-in first-out; generations survive reuse. */
  private readonly freeSlots: number[] = [];
  private generations = new Uint32Array(64);

  /**
   * The GPU row address for a new row: the most recently released slot with
   * its next generation, or a fresh address past the high-water mark.
   */
  allocate(): { readonly slot: number; readonly generation: number } {
    const reused = this.freeSlots.pop();
    if (reused === undefined) return { slot: this.highWater, generation: 0 };
    const generation = (this.generations[reused] as number) + 1;
    this.generations[reused] = generation;
    return { slot: reused, generation };
  }

  get freeCount(): number {
    return this.freeSlots.length;
  }

  /** Ascending addresses of rows carrying Terrain, a requested capsule shadow, a Skin Binding, or Points/Lines. */
  indexedSlots(kind: SparseRowKind): FrameSet {
    switch (kind) {
      case 'terrain':
        return this.terrainSlots.slots();
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
  setMeshLods(worldId: number, handle: number, lods: boolean | undefined): void {
    this.lods.mesh(worldId, handle, lods);
  }

  clearMeshLods(): void {
    this.lods.clearMeshes();
  }

  hasSource(kind: 'terrain' | 'glyph' | 'tilemap'): boolean {
    return (
      (kind === 'terrain'
        ? this.terrainCount
        : kind === 'glyph'
          ? this.glyphCount
          : this.tilemapCount) > 0
    );
  }

  get capacity(): number {
    return this.highWater;
  }
  get size(): number {
    return this.live;
  }

  lookup(worldId: number, entity: number): RenderSceneSlot | undefined {
    const slot = this.identities.get(worldId, entity);
    return slot === undefined ? undefined : this.get(slot);
  }

  slotOf(worldId: number, entity: number): number | undefined {
    return this.identities.get(worldId, entity);
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

  private account(
    slot: number,
    worldId: number,
    content: RowContent | undefined,
    sign: 1 | -1,
  ): void {
    if (content === undefined) return;
    if (content.terrain !== undefined) this.terrainCount += sign;
    if (content.glyph !== undefined) this.glyphCount += sign;
    if (content.tilemap !== undefined) this.tilemapCount += sign;
    this.lods.slot(worldId, content, sign);
    if (sign === 1) {
      this.terrainSlots.set(slot, content.terrain !== undefined);
      this.capsuleSlots.set(slot, content.capsuleShadowRequested === true);
      this.pointsLinesSlots.set(slot, content.pointsLines !== undefined);
      this.skinSlots.set(slot, content.skinBinding !== undefined);
      this.rasterSlots.set(slot, hasRasterDemand(content));
    }
  }

  /** Write one complete row; returns its new read view. */
  write(slot: number, row: SceneRowWrite): RenderSceneSlot {
    if (!validSlot(slot)) throw new RangeError('Scene write requires a non-negative slot address');
    const page = this.writablePose(slot, true);
    const lane = slot & PAGE_MASK;
    const at = lane * IDS;
    const previous = page.contents[lane];
    const ids = page.ids;
    let change: RowChange = 'enter';
    if (previous !== undefined) {
      const worldId = ids[at] as number;
      const entityKey = ids[at + 1] as number;
      this.account(slot, worldId, previous, -1);
      if (worldId !== row.worldId || entityKey !== row.entityKey) {
        if (this.identities.get(worldId, entityKey) === slot)
          this.identities.delete(worldId, entityKey);
        this.identities.set(row.worldId, row.entityKey, slot);
        this.logChange(slot, 'leave', ids[at + 2] as number);
      } else change = 'update';
    } else {
      page.count++;
      this.live++;
      this.identities.set(row.worldId, row.entityKey, slot);
    }
    this.logChange(slot, change, row.generation);
    page.contents[lane] = row.content;
    ids[at] = row.worldId;
    ids[at + 1] = row.entityKey;
    ids[at + 2] = row.generation;
    page.versions[lane] = this.nextVersion();
    const offset = row.poseOffset ?? 0;
    const poses = page.poses[poseChunk(lane)] as Float32Array;
    const base = poseOffset(lane);
    for (let index = 0; index < POSE; index++) poses[base + index] = row.pose[offset + index] ?? 0;
    this.account(slot, row.worldId, row.content, 1);
    this.highWater = Math.max(this.highWater, slot + 1);
    if (slot >= this.generations.length) {
      let capacity = this.generations.length;
      while (capacity <= slot) capacity *= 2;
      const grown = new Uint32Array(capacity);
      grown.set(this.generations);
      this.generations = grown;
    }
    this.generations[slot] = row.generation;
    return this.views.read(page, slot) as RenderSceneSlot;
  }

  /** Replace only the live row's pose; returns its new read view. */
  writePose(slot: number, pose: ArrayLike<number>, offset = 0): RenderSceneSlot {
    const page = this.writablePose(slot, false);
    const lane = slot & PAGE_MASK;
    if (page.contents[lane] === undefined)
      throw new RangeError('A pose write requires a live Scene row');
    page.versions[lane] = this.nextVersion();
    this.logChange(slot, 'update', page.ids[lane * IDS + 2] as number);
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
    const worldId = page.ids[at] as number;
    const entityKey = page.ids[at + 1] as number;
    this.account(slot, worldId, page.contents[lane], -1);
    this.terrainSlots.set(slot, false);
    this.capsuleSlots.set(slot, false);
    this.pointsLinesSlots.set(slot, false);
    this.skinSlots.set(slot, false);
    this.rasterSlots.set(slot, false);
    if (this.identities.get(worldId, entityKey) === slot)
      this.identities.delete(worldId, entityKey);
    this.logChange(slot, 'leave', page.ids[at + 2] as number);
    page.contents[lane] = undefined;
    this.views.remove(page, slot);
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
    this.frame = new SceneSlotFrame(
      root,
      this.highWater,
      identities,
      this.views,
      this.log,
      this.log.position,
      {
        terrain: this.indexedSlots('terrain'),
        capsule: this.indexedSlots('capsule'),
        skin: this.indexedSlots('skin'),
        raster: this.indexedSlots('raster'),
        pointsLines: this.indexedSlots('pointsLines'),
      },
    );
    return this.frame;
  }

  clear(): void {
    this.pending.clear();
    this.identities.clear();
    this.views.clear();
    this.log.reset();
    this.frame = new SceneSlotFrame(
      undefined,
      0,
      IdentityMap.EMPTY,
      this.views,
      this.log,
      this.log.position,
    );
    this.highWater = 0;
    this.live = 0;
    this.freeSlots.length = 0;
    this.generations = new Uint32Array(64);
    this.terrainCount = this.glyphCount = this.tilemapCount = 0;
    this.lods = new LodCandidates();
    this.terrainSlots = new SlotIndex();
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

/**
 * The stable entity keys of one identity roster, read from its fixed root
 * without materializing any row. `worldKeys[worldId]` routes a World; a
 * worldId past the list keys as itself.
 */
export class SlotIdentityKeys implements ReadonlySet<number> {
  private readonly worldIds = new Map<number, number>();
  private readonly identities: IdentityMap;
  constructor(
    private readonly roster: SceneSlotFrame,
    private readonly worldKeys: readonly number[],
  ) {
    this.identities = roster.identities;
    for (const [worldId, key] of worldKeys.entries())
      if (!this.worldIds.has(key)) this.worldIds.set(key, worldId);
  }
  get size(): number {
    return this.identities.size;
  }
  private keyOf(worldId: number): number {
    return this.worldKeys[worldId] ?? worldId;
  }
  /**
   * Visit the slot of every identity that entered or left since `previous`,
   * read from the roster's row-change log in O(changes). `false` (nothing
   * visited) when the World routing differs or the log cannot answer, so
   * every key may have changed.
   */
  changesSince(previous: SlotIdentityKeys, visit: (slot: number) => void): boolean {
    if (
      previous.worldKeys.length !== this.worldKeys.length ||
      previous.worldKeys.some((key, index) => key !== this.worldKeys[index])
    )
      return false;
    return this.roster.changesSince(previous.roster, (slot, kind) => {
      if (kind !== 'update') visit(slot);
    });
  }
  /** One identity-root descent; no key index is built. */
  has(key: number): boolean {
    const worldKey = Math.floor(key / 4294967296);
    const entity = key - worldKey * 4294967296;
    const routed = this.worldIds.get(worldKey);
    if (routed !== undefined && this.identities.has(routed, entity)) return true;
    return worldKey >= this.worldKeys.length && this.identities.has(worldKey, entity);
  }
  *values(): SetIterator<number> {
    for (const [worldId, entity] of this.identities.entries())
      yield worldEntityKey(this.keyOf(worldId), entity);
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
