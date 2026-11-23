import type { RenderableSnapshot } from '../render-system-extract';
import { FrameListBase, ProjectionIterator } from './frame-list';
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

  static indexed(rows: Iterable<RenderableSnapshot>, at: unknown): rows is SelectedSceneDrawRows {
    return rows instanceof SelectedSceneDrawRows && at === selectedAt;
  }

  get fixedMaterialReads(): boolean {
    return this.columns.fixedMaterialReads;
  }

  get source(): SceneSlotFrame {
    return this.columns.source;
  }

  surfaceWalk(visit: SurfaceColumnReader<void>) {
    return this.columns.surfaceWalk(visit, this.members);
  }

  /** Further display filters keep the fixed slot addresses and source rank order. */
  selectDisplay(
    admits: (row: RowContent, rank: number) => boolean,
  ): SelectedSceneDrawRows | readonly [] {
    let rank = 0;
    const select = (row: RowContent): boolean => admits(row, rank++);
    const selected = this.members.filter(
      (slot) => this.columns.source.readContentSlot(slot, select) === true,
    );
    if (selected.size === this.members.size) return this;
    return selected.size === 0 ? [] : new SelectedSceneDrawRows(this.columns, selected);
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
