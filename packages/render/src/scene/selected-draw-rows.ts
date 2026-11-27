import type { RenderableSnapshot } from '../render-system-extract';
import {
  EMPTY_FRAME_ROWS,
  FrameListBase,
  ProjectionIterator,
  type SparseRowKind,
} from './frame-list';
import type { FrameSet } from './frame-set';
import type { SurfaceColumnReader, sceneDrawContentOf } from './render-scene-view';
import type { RowContent } from './row-contents';
import type { SceneSlotFrame } from './scene-slots';

type DisplayColumns = NonNullable<ReturnType<typeof sceneDrawContentOf>>;

/** A view subset owns only its fixed physical membership. Geometry and
 * material receipts read the captured columns. An explicit public row read
 * projects exactly that slot using the originating view's temporal history. */
export class SelectedSceneDrawRows extends FrameListBase<RenderableSnapshot> {
  constructor(
    private readonly columns: DisplayColumns,
    private readonly members: FrameSet,
    readonly dispatchDomain: symbol = Symbol(),
  ) {
    super();
  }

  static native(
    rows: Iterable<Pick<RenderableSnapshot, 'entityKey'>>,
  ): rows is SelectedSceneDrawRows {
    return (
      rows instanceof SelectedSceneDrawRows &&
      rows[Symbol.iterator] === SelectedSceneDrawRows.prototype[Symbol.iterator]
    );
  }

  static indexed(rows: Iterable<unknown>, at: unknown): rows is SelectedSceneDrawRows {
    return rows instanceof SelectedSceneDrawRows && at === selectedAt;
  }

  get fixedMaterialReads(): boolean {
    return this.columns.fixedMaterialReads;
  }

  get source(): SceneSlotFrame {
    return this.columns.source;
  }

  visitLodCandidates(visit?: (row: RenderableSnapshot) => void): number {
    return this.columns.visitLodCandidates(visit, this.members);
  }

  lookupMember(entity: number) {
    const slot = this.source.identitySlot(entity);
    return slot !== undefined && this.members.has(slot) ? this.source.slotAt(slot) : undefined;
  }

  /** OIT skin membership in a verified view interval, without observing rigid poses. */
  countSkins(draws: { rankAt(index: number): number }, start: number, end: number): number {
    const skins = this.columns.permitsSlotCull(undefined)
      ? this.source.indexedSlots('skin')
      : undefined;
    if (skins?.size === 0) return 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const rank = draws.rankAt(i);
      if (skins === undefined) {
        if (this.at(rank)?.skinBinding !== undefined) count++;
      } else {
        const slot = this.members.at(rank);
        if (slot !== undefined && skins.has(slot)) count++;
      }
    }
    return count;
  }

  surfaceWalk(visit: SurfaceColumnReader<void>) {
    return this.columns.surfaceWalk(visit, this.members);
  }

  /** Further display filters keep the fixed slot addresses and source rank order. */
  selectDisplay(
    admits: (row: RowContent, rank: number) => boolean,
    indexed?: FrameSet,
  ): SelectedSceneDrawRows | readonly [] {
    const selected = this.source.selectContent(admits, this.members, indexed);
    if (selected.size === this.members.size) return this;
    return selected.size === 0 ? [] : new SelectedSceneDrawRows(this.columns, selected);
  }

  /** Both sets address the same captured slots. Walk the smaller one in source
   * order and project only actual members of the view carrying this fact. */
  override sparseRows(kind: SparseRowKind): Iterable<RenderableSnapshot> {
    if (
      Object.getPrototypeOf(this) !== SelectedSceneDrawRows.prototype ||
      Object.hasOwn(this, Symbol.iterator) ||
      Object.getOwnPropertyDescriptor(SelectedSceneDrawRows.prototype, Symbol.iterator)?.value !==
        selectedIterator
    )
      return this;
    const indexed = this.source.indexedSlots(kind);
    if (indexed === undefined) return this;
    if (indexed.size === 0 || this.members.size === 0) return EMPTY_FRAME_ROWS;
    const smaller = indexed.size < this.members.size ? indexed : this.members;
    const other = smaller === indexed ? this.members : indexed;
    const project = this.project;
    return {
      *[Symbol.iterator]() {
        for (const slot of smaller.borrowKeys()) if (other.has(slot)) yield project(slot);
      },
    };
  }

  get length(): number {
    return this.members.size;
  }

  private readonly project = (slot: number): RenderableSnapshot => {
    const row = this.columns.source.slotAt(slot);
    if (row === undefined)
      throw new Error('Display membership must refer to a captured Scene slot');
    return this.columns.project(row);
  };

  submittedSlots(roster: SceneSlotFrame): FrameSet | undefined {
    return this.columns.source === roster ? this.members : undefined;
  }

  at(index: number): RenderableSnapshot | undefined {
    const slot = this.members.at(index);
    return slot === undefined ? undefined : this.project(slot);
  }

  [Symbol.iterator](): IterableIterator<RenderableSnapshot> {
    return new ProjectionIterator(this.members.borrowKeys(), this.project);
  }

  findDrawContent<T>(
    requireMaterials: boolean,
    read: (entity: number, content: RowContent) => T | undefined,
  ): T | undefined {
    return this.columns.findDrawContent(requireMaterials, read, this.members);
  }
}

const selectedAt = SelectedSceneDrawRows.prototype.at;

const selectedIterator = SelectedSceneDrawRows.prototype[Symbol.iterator];
