import { isReflectedTransform } from '../material-render-state';
import type { TransformSnapshot } from '../render-system-extract';

export type ScenePoseStorage = Float32Array | CapturedSceneTransform;

const POSE_FLOATS = 16;
const POSES_PER_PAGE = 64;

function copyPose(out: Float32Array, at: number, column: ArrayLike<number>, offset: number): void {
  for (let i = 0; i < POSE_FLOATS; i++) out[at + i] = column[offset + i] ?? 0;
}

/** Each producer owns its open page. Issued observations keep at most 4 KiB independently
 * of the scene, receiver and future captures. Published addresses are never overwritten. */
export class ScenePoseWriter {
  private readonly pageFloats: number;
  private column: Float32Array | undefined;
  private next = 0;

  constructor(expectedRows = POSES_PER_PAGE) {
    this.pageFloats = POSE_FLOATS * Math.max(1, Math.min(POSES_PER_PAGE, expectedRows));
  }

  capture(source: ArrayLike<number>, offset = 0): CapturedSceneTransform {
    if (this.column === undefined || this.next === this.pageFloats) {
      this.column = new Float32Array(this.pageFloats);
      this.next = 0;
    }
    const column = this.column;
    const start = this.next;
    this.next += POSE_FLOATS;
    copyPose(column, start, source, offset);
    return new CapturedSceneTransform(column, start);
  }

  clear(): void {
    this.column = undefined;
    this.next = 0;
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
      copyPose(out, at, storage.#column, storage.#offset);
    else copyPose(out, at, storage, 0);
  }

  static reflected(source: TransformSnapshot): boolean {
    return source instanceof CapturedSceneTransform
      ? isReflectedTransform(source.#column, source.#offset)
      : isReflectedTransform(source.world);
  }
}
