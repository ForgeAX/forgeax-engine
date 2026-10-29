import { worldEntityKey } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';
import { FrameListBase } from './frame-list';
import { type Node, put, remove } from './frame-tree';
import { IdentityMap, IdentityMapEditor } from './identity-map';
import type { RenderSceneSlot } from './render-scene-types';
import { type RowChange, RowChangeLog } from './row-change-log';
import type { RowContent } from './row-contents';

const PAGE_SHIFT = 6;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;
const POSE = 16;
/** Per-lane numeric identity: worldId, entityKey, generation, version. */
const IDS = 4;
const validSlot = (slot: number) =>
  Number.isSafeInteger(slot) && slot >= 0 && slot < Number.MAX_SAFE_INTEGER;

/**
 * 64 rows as numeric columns plus one shared-content reference per lane: no
 * object per row. A captured page is never written again.
 */
interface Page {
  readonly contents: readonly (RowContent | undefined)[];
  readonly ids: Float64Array;
  readonly poses: Float32Array;
  readonly count: number;
}
interface WritablePage {
  contents: (RowContent | undefined)[];
  ids: Float64Array;
  poses: Float32Array;
  count: number;
}

/**
 * Materialized row reads keyed by row version. A read view stays the same
 * object while some frame keeps reading it; views no frame read since the
 * previous rotation are dropped, so retained views are O(rows read), not O(N).
 */
export class RowViews {
  private current = new Map<number, RenderSceneSlot>();
  private previous = new Map<number, RenderSceneSlot>();

  /** Start a read generation; views the last generation read stay shared. */
  rotate(): void {
    this.previous = this.current;
    this.current = new Map();
  }

  read(page: Page, slot: number): RenderSceneSlot | undefined {
    const lane = slot & PAGE_MASK;
    const content = page.contents[lane];
    if (content === undefined) return undefined;
    const ids = page.ids;
    const at = lane * IDS;
    const version = ids[at + 3] as number;
    let view = this.current.get(version);
    if (view !== undefined) return view;
    view = this.previous.get(version);
    if (view === undefined) {
      const worldId = ids[at] as number;
      const entityKey = ids[at + 1] as number;
      const world = page.poses.subarray(lane * POSE, lane * POSE + POSE);
      view = {
        slot,
        generation: ids[at + 2] as number,
        version,
        worldId,
        entityKey,
        snapshot: { ...content, worldId, entityKey, transform: { world } } as RenderableSnapshot,
      };
    }
    this.current.set(version, view);
    return view;
  }

  clear(): void {
    this.current = new Map();
    this.previous = new Map();
  }
}

function pageVersion(page: Page | undefined, slot: number): number {
  if (page === undefined) return 0;
  const lane = slot & PAGE_MASK;
  return page.contents[lane] === undefined ? 0 : (page.ids[lane * IDS + 3] as number);
}

/** A fixed scene root. Rank is derived at consumption; physical slot addresses never move. */
export class SceneSlotFrame extends FrameListBase<RenderSceneSlot> {
  readonly length: number;
  constructor(
    readonly root: Node<Page> | undefined,
    readonly capacity: number,
    readonly identities: IdentityMap = IdentityMap.EMPTY,
    private readonly views: RowViews = new RowViews(),
    private readonly log?: RowChangeLog,
    /** This frame's cursor in its owner's row-change log. */
    private readonly position = 0,
  ) {
    super();
    this.length = root?.count ?? 0;
  }

  identitySlot(worldId: number, entity: number): number | undefined {
    return this.identities.get(worldId, entity);
  }

  readonly lookup = (worldId: number, entity: number): RenderSceneSlot | undefined => {
    const slot = this.identitySlot(worldId, entity);
    return slot === undefined ? undefined : this.slotAt(slot);
  };

  pageAt(page: number): Page | undefined {
    let node = this.root;
    while (node !== undefined) {
      if (page === node.key) return node.value;
      node = page < node.key ? node.left : node.right;
    }
    return undefined;
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

/** Ascending slot addresses of rows with one sparse source fact; rebuilt only after membership changes. */
class SlotIndex {
  private readonly members = new Set<number>();
  private sorted: readonly number[] | undefined;

  set(slot: number, member: boolean): void {
    if (member === this.members.has(slot)) return;
    if (member) this.members.add(slot);
    else this.members.delete(slot);
    this.sorted = undefined;
  }

  slots(): readonly number[] {
    this.sorted ??= [...this.members].sort((a, b) => a - b);
    return this.sorted;
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

  /** Ascending addresses of rows carrying Terrain, or a requested capsule shadow. */
  indexedSlots(kind: 'terrain' | 'capsule'): readonly number[] {
    return (kind === 'terrain' ? this.terrainSlots : this.capsuleSlots).slots();
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

  /** Start a new read generation for materialized row views. */
  rotateViews(): void {
    this.views.rotate();
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

  /** The current row's shared content, without materializing a read view. */
  content(slot: number): RowContent | undefined {
    return validSlot(slot) ? this.page(slot)?.contents[slot & PAGE_MASK] : undefined;
  }

  private writable(slot: number): WritablePage {
    const key = Math.floor(slot / PAGE_SIZE);
    let page = this.pending.get(key);
    if (page !== undefined) return page;
    const before = this.frame.pageAt(key);
    page =
      before === undefined
        ? {
            contents: new Array(PAGE_SIZE),
            ids: new Float64Array(PAGE_SIZE * IDS),
            poses: new Float32Array(PAGE_SIZE * POSE),
            count: 0,
          }
        : {
            contents: before.contents.slice(),
            ids: before.ids.slice(),
            poses: before.poses.slice(),
            count: before.count,
          };
    this.pending.set(key, page);
    if (before === undefined) this.newPages++;
    else {
      this.copiedPages++;
      this.copiedBytes += PAGE_SIZE * (8 + IDS * 8 + POSE * 4);
    }
    return page;
  }

  /** History covers about two full-scene rewrites before old cursors lapse. */
  private logChange(slot: number, kind: RowChange, generation: number): void {
    this.log.append(slot, kind, generation, 2 * this.live);
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
    }
  }

  /** Write one complete row; returns its new read view. */
  write(slot: number, row: SceneRowWrite): RenderSceneSlot {
    if (!validSlot(slot)) throw new RangeError('Scene write requires a non-negative slot address');
    const page = this.writable(slot);
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
    ids[at + 3] = this.nextVersion();
    const offset = row.poseOffset ?? 0;
    const poses = page.poses;
    const base = lane * POSE;
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
    const page = this.writable(slot);
    const lane = slot & PAGE_MASK;
    if (page.contents[lane] === undefined)
      throw new RangeError('A pose write requires a live Scene row');
    page.ids[lane * IDS + 3] = this.nextVersion();
    this.logChange(slot, 'update', page.ids[lane * IDS + 2] as number);
    const poses = page.poses;
    const base = lane * POSE;
    for (let index = 0; index < POSE; index++) poses[base + index] = pose[offset + index] ?? 0;
    return this.views.read(page, slot) as RenderSceneSlot;
  }

  /** Remove the live row and release its address for reuse. */
  remove(slot: number): void {
    if (!validSlot(slot))
      throw new RangeError('Scene removal requires a non-negative slot address');
    if (this.content(slot) === undefined) return;
    this.freeSlots.push(slot);
    const page = this.writable(slot);
    const lane = slot & PAGE_MASK;
    const at = lane * IDS;
    const worldId = page.ids[at] as number;
    const entityKey = page.ids[at + 1] as number;
    this.account(slot, worldId, page.contents[lane], -1);
    this.terrainSlots.set(slot, false);
    this.capsuleSlots.set(slot, false);
    if (this.identities.get(worldId, entityKey) === slot)
      this.identities.delete(worldId, entityKey);
    this.logChange(slot, 'leave', page.ids[at + 2] as number);
    page.contents[lane] = undefined;
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
