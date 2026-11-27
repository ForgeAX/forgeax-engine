import { isReflectedTransform } from '../material-render-state';
import type { TransformSnapshot } from '../render-system-extract';

export type ScenePoseStorage = Float32Array | CapturedSceneTransform;

const POSE_FLOATS = 16;
const POSES_PER_PAGE = 64;

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
  private cursor: { column: Float32Array; offset: number } | undefined;

  constructor(expectedRows = POSES_PER_PAGE) {
    this.pageFloats = POSE_FLOATS * Math.max(1, Math.min(POSES_PER_PAGE, expectedRows));
  }

  /** Reserve an unpublished matrix. Take both coordinates before reading a caller-owned source.
   * The cursor is borrowed until the next reservation; the numeric window is permanently issued. */
  reserve(): { readonly column: Float32Array; readonly offset: number } {
    let cursor = this.cursor;
    if (cursor === undefined) {
      cursor = { column: new Float32Array(this.pageFloats), offset: 0 };
      this.cursor = cursor;
    } else if (cursor.offset + POSE_FLOATS === this.pageFloats) {
      cursor.column = new Float32Array(this.pageFloats);
      cursor.offset = 0;
    } else cursor.offset += POSE_FLOATS;
    return cursor;
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

/** A public pose holds only its numeric chunk. Its enumerable matrix is a fixed window
 * when read. Physical geometry and uploads can use the same pose without opening one. */
export class CapturedSceneTransform implements TransformSnapshot {
  declare readonly world: Float32Array;
  readonly #column: Float32Array;
  readonly #offset: number;
  #window: Float32Array | undefined;
  static readonly #world = {
    configurable: true,
    enumerable: true,
    get(this: CapturedSceneTransform): Float32Array {
      this.#window ??= this.#column.subarray(this.#offset, this.#offset + 16);
      return this.#window;
    },
  };
  constructor(column: Float32Array, offset: number) {
    this.#column = column;
    this.#offset = offset;
    Object.defineProperty(this, 'world', CapturedSceneTransform.#world);
  }

  /** The identity stored by sort and visibility is the issued pose, even within a shared column. */
  static storage(source: TransformSnapshot): ScenePoseStorage {
    return source instanceof CapturedSceneTransform ? source : source.world;
  }

  static column(storage: ScenePoseStorage): Float32Array {
    return storage instanceof CapturedSceneTransform ? storage.#column : storage;
  }

  static offset(storage: ScenePoseStorage): number {
    return storage instanceof CapturedSceneTransform ? storage.#offset : 0;
  }

  /** One F32 copy with no matrix descriptor per drawn instance. */
  static write(out: Float32Array, at: number, source: TransformSnapshot): void {
    CapturedSceneTransform.writeStorage(out, at, CapturedSceneTransform.storage(source));
  }

  static writeStorage(
    out: Float32Array,
    at: number,
    storage: ArrayLike<number> | CapturedSceneTransform,
  ): void {
    if (storage instanceof CapturedSceneTransform)
      copyScenePose(out, at, storage.#column, storage.#offset);
    else copyScenePose(out, at, storage, 0);
  }

  static reflected(source: TransformSnapshot): boolean {
    return source instanceof CapturedSceneTransform
      ? isReflectedTransform(source.#column, source.#offset)
      : isReflectedTransform(source.world);
  }
}
