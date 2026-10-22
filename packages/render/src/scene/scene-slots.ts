import { FrameListBase } from './frame-list';
import { type Node, put, remove } from './frame-tree';
import type { RenderSceneSlot } from './render-scene-types';

const PAGE_SHIFT = 6;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;
const validSlot = (slot: number) =>
  Number.isSafeInteger(slot) && slot >= 0 && slot < Number.MAX_SAFE_INTEGER;
interface Page {
  readonly slots: readonly (RenderSceneSlot | undefined)[];
  readonly count: number;
}
interface WritablePage {
  slots: (RenderSceneSlot | undefined)[];
  count: number;
}

/** A fixed scene root. Rank is derived at consumption; physical slot addresses never move. */
export class SceneSlotFrame extends FrameListBase<RenderSceneSlot> {
  readonly length: number;
  constructor(
    readonly root: Node<Page> | undefined,
    readonly capacity: number,
    readonly identities: Node<number> | undefined,
  ) {
    super();
    this.length = root?.count ?? 0;
  }

  identitySlot(worldId: number, entity: number): number | undefined {
    let node = this.identities;
    while (node !== undefined) {
      if (worldId === node.queue && entity === node.key) return node.value;
      node =
        worldId < node.queue || (worldId === node.queue && entity < node.key)
          ? node.left
          : node.right;
    }
    return undefined;
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
    return this.pageAt(Math.floor(slot / PAGE_SIZE))?.slots[slot & PAGE_MASK];
  };

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
          const slot = node.value.slots[lane];
          if (slot !== undefined && index-- === 0) return slot;
        }
        return undefined;
      }
    }
    return undefined;
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
        if (node.value.slots[lane] === undefined) return undefined;
        rank += node.left?.count ?? 0;
        for (let index = 0; index < lane; index++)
          if (node.value.slots[index] !== undefined) rank++;
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
        const slot = current.value.slots[lane];
        if (slot !== undefined) yield slot;
      }
      node = current.right;
    }
  }
}

/** One mutable owner; known writes coalesce per page before a frame is captured. */
export class SceneSlots {
  private frame = new SceneSlotFrame(undefined, 0, undefined);
  private readonly pending = new Map<number, WritablePage>();
  private identities: Node<number> | undefined;
  private highWater = 0;
  private live = 0;
  private newPages = 0;
  private copiedPages = 0;
  private copiedBytes = 0;
  private terrainCount = 0;
  private glyphCount = 0;
  private tilemapCount = 0;

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
    let node = this.identities;
    while (node !== undefined) {
      if (worldId === node.queue && entity === node.key) return this.get(node.value);
      node =
        worldId < node.queue || (worldId === node.queue && entity < node.key)
          ? node.left
          : node.right;
    }
    return undefined;
  }

  get(slot: number): RenderSceneSlot | undefined {
    if (!validSlot(slot)) return undefined;
    const page = Math.floor(slot / PAGE_SIZE);
    const pending = this.pending.get(page);
    return pending === undefined ? this.frame.slotAt(slot) : pending.slots[slot & PAGE_MASK];
  }

  set(slot: number, value: RenderSceneSlot | undefined): void {
    if (!validSlot(slot) || (value !== undefined && value.slot !== slot))
      throw new RangeError('Scene write requires its exact non-negative slot address');
    const previous = this.get(slot);
    if (previous === value) return;
    this.terrainCount +=
      Number(value?.snapshot.terrain !== undefined) -
      Number(previous?.snapshot.terrain !== undefined);
    this.glyphCount +=
      Number(value?.snapshot.glyph !== undefined) - Number(previous?.snapshot.glyph !== undefined);
    this.tilemapCount +=
      Number(value?.snapshot.tilemap !== undefined) -
      Number(previous?.snapshot.tilemap !== undefined);
    if (previous?.worldId !== value?.worldId || previous?.entityKey !== value?.entityKey) {
      if (
        previous !== undefined &&
        this.lookup(previous.worldId, previous.entityKey)?.slot === slot
      )
        this.identities = remove(this.identities, previous.worldId, previous.entityKey);
      if (value !== undefined)
        this.identities = put(this.identities, slot, value.worldId, value.entityKey, 1);
    }
    const key = Math.floor(slot / PAGE_SIZE);
    let page = this.pending.get(key);
    if (page === undefined) {
      const before = this.frame.pageAt(key);
      page = {
        slots: before === undefined ? new Array(PAGE_SIZE) : before.slots.slice(),
        count: before?.count ?? 0,
      };
      this.pending.set(key, page);
      if (before === undefined) this.newPages++;
      else {
        this.copiedPages++;
        this.copiedBytes += PAGE_SIZE * 8;
      }
    }
    if (previous === undefined) {
      page.count++;
      this.live++;
    }
    if (value === undefined) {
      page.count--;
      this.live--;
    }
    page.slots[slot & PAGE_MASK] = value;
    this.highWater = Math.max(this.highWater, slot + 1);
  }

  capture(): SceneSlotFrame {
    if (this.pending.size === 0) return this.frame;
    let root = this.frame.root;
    for (const [key, page] of this.pending)
      root = page.count === 0 ? remove(root, 0, key) : put(root, page, 0, key, page.count);
    this.pending.clear();
    this.frame = new SceneSlotFrame(root, this.highWater, this.identities);
    return this.frame;
  }

  /** Cold recovery prepares new pages without mutating the accepted owner. */
  fork(): SceneSlots {
    const next = new SceneSlots();
    next.frame = this.capture();
    next.identities = this.identities;
    next.highWater = this.highWater;
    next.live = this.live;
    next.newPages = this.newPages;
    next.copiedPages = this.copiedPages;
    next.copiedBytes = this.copiedBytes;
    next.terrainCount = this.terrainCount;
    next.glyphCount = this.glyphCount;
    next.tilemapCount = this.tilemapCount;
    return next;
  }

  clear(): void {
    this.pending.clear();
    this.identities = undefined;
    this.frame = new SceneSlotFrame(undefined, 0, undefined);
    this.highWater = 0;
    this.live = 0;
    this.terrainCount = this.glyphCount = this.tilemapCount = 0;
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
