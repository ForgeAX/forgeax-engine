import { type AssetChange, AssetClosure } from '@forgeax/engine-assets-runtime/internal';
import type { AssetReferenceOwner } from '@forgeax/engine-types';

/** Scene membership is maintained at binding changes, never expanded from asset edits. */
export class SceneAssetClosure {
  readonly assets = new AssetClosure();
  private readonly roots = new Map<number, readonly number[]>();
  private contentRevision = 0;

  constructor(private readonly owner: AssetReferenceOwner) {}

  get revision(): number {
    return this.contentRevision;
  }

  replace(entity: number, handles: readonly number[]): void {
    const previous = this.roots.get(entity) ?? [];
    if (
      previous.length === handles.length &&
      previous.every((handle, index) => handle === handles[index])
    )
      return;
    const transaction = this.assets.begin(this.owner);
    for (const handle of handles) transaction.acquire(handle);
    for (const handle of previous) transaction.release(handle);
    transaction.commit();
    if (handles.length === 0) this.roots.delete(entity);
    else this.roots.set(entity, handles);
  }

  pending(changes: readonly AssetChange[]): boolean {
    return changes.some((change) => this.assets.has(change.handle));
  }

  adopt(changes: readonly AssetChange[]): void {
    if (!this.pending(changes)) return;
    const transaction = this.assets.begin(this.owner);
    for (const change of changes) if (!change.removed) transaction.update(change.handle);
    transaction.commit();
    this.contentRevision++;
  }
}
