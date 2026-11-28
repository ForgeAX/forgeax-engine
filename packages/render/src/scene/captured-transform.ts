import { isReflectedTransform } from '../material-render-state';
import type { TransformSnapshot } from '../render-system-extract';

export type ScenePoseStorage = Float32Array | ScenePose;

const POSE_FLOATS = 16;
const POSES_PER_PAGE = 64;
export const COMPACT_SCENE_POSE_ROWS = 8;

export function copyScenePose(
  out: Float32Array,
  at: number,
  column: ArrayLike<number>,
  offset: number,
): void {
  for (let i = 0; i < POSE_FLOATS; i++) out[at + i] = column[offset + i] ?? 0;
}

/** Each producer owns its open page. Issued observations keep at most 4 KiB independently
 * of the scene, receiver and future captures. Published addresses are never overwritten. */
export class ScenePoseWriter {
  private readonly pageFloats: number;
  private allocated = 0;
  private allocatedBytes = 0;
  private cursor: { column: Float32Array; offset: number } | undefined;

  constructor(expectedRows = POSES_PER_PAGE) {
    this.pageFloats = POSE_FLOATS * Math.max(1, Math.min(POSES_PER_PAGE, expectedRows));
  }

  /** Reserve an unpublished matrix. Take both coordinates before reading a caller-owned source.
   * The cursor is borrowed until the next reservation; the numeric window is permanently issued. */
  reserve(groupRows?: number): { readonly column: Float32Array; readonly offset: number } {
    let cursor = this.cursor;
    if (cursor === undefined) {
      cursor = { column: this.newPage(groupRows), offset: 0 };
      this.cursor = cursor;
    } else if (cursor.offset + POSE_FLOATS === cursor.column.length) {
      cursor.column = this.newPage(groupRows);
      cursor.offset = 0;
    } else cursor.offset += POSE_FLOATS;
    return cursor;
  }

  private newPage(groupRows?: number): Float32Array {
    const floats =
      groupRows === undefined
        ? this.pageFloats
        : Math.max(this.pageFloats, Math.min(POSES_PER_PAGE, groupRows) * POSE_FLOATS);
    const page = new Float32Array(floats);
    this.allocated++;
    this.allocatedBytes += page.byteLength;
    return page;
  }

  get pageAllocations(): number {
    return this.allocated;
  }

  get pageAllocatedBytes(): number {
    return this.allocatedBytes;
  }

  capture(source: ArrayLike<number>, offset = 0): CapturedSceneTransform {
    const { column, offset: start } = this.reserve();
    copyScenePose(column, start, source, offset);
    return new CapturedSceneTransform(column, start);
  }

  clear(): void {
    this.cursor = undefined;
  }
}

/** An immutable address of a matrix inside an accepted Scene publication. */
export class ScenePose {
  #column: Float32Array;
  #offset: number;

  protected constructor(column: Float32Array, offset: number) {
    this.#column = column;
    this.#offset = offset;
  }

  protected setAddress(column: Float32Array, offset: number): void {
    this.#column = column;
    this.#offset = offset;
  }

  get poseColumn(): Float32Array {
    return this.#column;
  }

  get poseOffset(): number {
    return this.#offset;
  }
}

const EMPTY_POSE_COLUMN = new Float32Array(0);

/** Caller-owned scratch, filled by one captured Scene read and consumed synchronously. */
export class RecordingScenePose extends ScenePose {
  uploadOwner = 0;
  version = 0;

  constructor() {
    super(EMPTY_POSE_COLUMN, 0);
  }

  borrow(column: Float32Array, offset: number, owner: number, version: number): void {
    this.setAddress(column, offset);
    this.uploadOwner = owner;
    this.version = version;
  }

  clear(): void {
    this.borrow(EMPTY_POSE_COLUMN, 0, 0, 0);
  }
}

/** An explicit observer keeps a detached sixteen-float matrix on first read. */
export class CapturedSceneTransform extends ScenePose implements TransformSnapshot {
  declare readonly world: Float32Array;
  #window: Float32Array | undefined;
  static readonly #ownedWorld = {
    configurable: true,
    enumerable: true,
    get(this: CapturedSceneTransform): Float32Array {
      const offset = this.poseOffset;
      this.#window ??= this.poseColumn.slice(offset, offset + POSE_FLOATS);
      return this.#window;
    },
  };

  constructor(column: Float32Array, offset: number) {
    super(column, offset);
    Object.defineProperty(this, 'world', CapturedSceneTransform.#ownedWorld);
  }

  /** Another observer of the same immutable pose owns a separate explicit matrix read. */
  retain(): CapturedSceneTransform {
    return new CapturedSceneTransform(this.poseColumn, this.poseOffset);
  }

  /** The identity stored by sort and visibility is the issued pose, even within a shared column. */
  static storage(source: TransformSnapshot): Float32Array | CapturedSceneTransform {
    return source instanceof CapturedSceneTransform ? source : source.world;
  }

  static column(storage: ScenePoseStorage): Float32Array;
  static column(storage: ArrayLike<number> | ScenePose): ArrayLike<number>;
  static column(storage: ArrayLike<number> | ScenePose): ArrayLike<number> {
    return storage instanceof ScenePose ? storage.poseColumn : storage;
  }

  static offset(storage: ArrayLike<number> | ScenePose): number {
    return storage instanceof ScenePose ? storage.poseOffset : 0;
  }

  static lane(storage: ScenePoseStorage, lane: number): number | undefined {
    return storage instanceof ScenePose
      ? storage.poseColumn[storage.poseOffset + lane]
      : storage[lane];
  }

  /** Compare the accepted numerical lanes without opening either raw matrix view. */
  static differs(
    current: TransformSnapshot,
    previous: TransformSnapshot,
    epsilon: number,
  ): boolean {
    const currentStorage = CapturedSceneTransform.storage(current);
    const previousStorage = CapturedSceneTransform.storage(previous);
    const column = CapturedSceneTransform.column(currentStorage);
    const before = CapturedSceneTransform.column(previousStorage);
    const offset = CapturedSceneTransform.offset(currentStorage);
    const previousOffset = CapturedSceneTransform.offset(previousStorage);
    const length = Math.min(
      currentStorage instanceof CapturedSceneTransform ? POSE_FLOATS : column.length,
      previousStorage instanceof CapturedSceneTransform ? POSE_FLOATS : before.length,
    );
    for (let i = 0; i < length; i++) {
      const value = column[offset + i] as number;
      const prior = before[previousOffset + i] ?? value;
      if (Math.abs(value - prior) > epsilon) return true;
    }
    return false;
  }

  /** One F32 copy with no matrix descriptor per drawn instance. */
  static write(out: Float32Array, at: number, source: TransformSnapshot): void {
    CapturedSceneTransform.writeStorage(out, at, CapturedSceneTransform.storage(source));
  }

  static writeStorage(out: Float32Array, at: number, storage: ArrayLike<number> | ScenePose): void {
    if (storage instanceof ScenePose)
      copyScenePose(out, at, storage.poseColumn, storage.poseOffset);
    else copyScenePose(out, at, storage, 0);
  }

  static reflected(source: TransformSnapshot): boolean {
    return CapturedSceneTransform.reflectedStorage(CapturedSceneTransform.storage(source));
  }

  static reflectedStorage(storage: ScenePoseStorage): boolean {
    return storage instanceof ScenePose
      ? isReflectedTransform(storage.poseColumn, storage.poseOffset)
      : isReflectedTransform(storage);
  }
}
