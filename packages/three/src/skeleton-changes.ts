import { Matrix4, type Skeleton } from 'three/src/Three.Core.js';
import { watchCollection, watchTargetMatrix } from './source-collections';
import { subscribe } from './source-fields';

type Stop = () => void;
export interface SkinCursor {
  readonly owner: SkeletonChanges;
  readonly dirty: Set<number>;
  readonly work: { jointReads: number };
}

/** One subscription per source joint. Each skinned mesh consumes its own dirty indices. */
export class SkeletonChanges {
  readonly users = new Set<SkinCursor>();
  private stops: Stop[] = [];
  private stale = true;
  poseLayout: object | undefined;
  binding: { affine: boolean } | undefined;
  revision = 0;

  constructor(readonly source: Skeleton) {}
  private readonly invalidate = () => {
    this.stale = true;
  };
  private keep(stop: Stop | undefined): boolean {
    if (!stop) return false;
    this.stops.push(stop);
    return true;
  }

  refresh(): void {
    if (!this.stale) return;
    this.dispose();
    this.stale = false;
    this.revision++;
    for (const user of this.users) user.dirty.clear();
    const { bones, boneInverses } = this.source;
    let poses =
      this.keep(subscribe(this.source, 'bones', this.invalidate)) &&
      this.keep(watchCollection(bones, this.invalidate));
    if (poses)
      for (const [index, bone] of bones.entries()) {
        if (
          !bone ||
          !(bone.matrixWorld instanceof Matrix4) ||
          !this.keep(subscribe(bone, 'matrixWorld', this.invalidate)) ||
          !this.keep(subscribe(bone.matrixWorld, 'elements', this.invalidate)) ||
          !this.keep(
            watchTargetMatrix(bone.matrixWorld.elements, () => {
              this.revision++;
              for (const user of this.users) user.dirty.add(index);
            }),
          )
        ) {
          poses = false;
          break;
        }
      }
    this.poseLayout = poses ? {} : undefined;
    let bindings =
      poses &&
      this.keep(subscribe(this.source, 'boneInverses', this.invalidate)) &&
      this.keep(watchCollection(boneInverses, this.invalidate));
    if (bindings)
      for (const matrix of boneInverses) {
        if (
          !(matrix instanceof Matrix4) ||
          !this.keep(subscribe(matrix, 'elements', this.invalidate)) ||
          !this.keep(watchCollection(matrix.elements, this.invalidate))
        ) {
          bindings = false;
          break;
        }
      }
    this.binding = bindings
      ? {
          affine: boneInverses.every((m) => {
            const e = m.elements;
            return e[3] === 0 && e[7] === 0 && e[11] === 0 && e[15] === 1;
          }),
        }
      : undefined;
  }

  dispose(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
  }
}
