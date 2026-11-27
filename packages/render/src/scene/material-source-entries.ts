import { materialSourceMatchesCurrent } from '../material-source';
import { PublishedAssetConsumers } from '../publication/dependencies';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshotCacheEntry } from '../render-system-extract';

/** Per geometry/material context. Only accepted source closures own reverse dependency edges. */
export class MaterialSourceEntries extends Map<number, MaterialSnapshotCacheEntry> {
  private consumers?: PublishedAssetConsumers;
  private review?: Set<number>;
  private retries?: Set<number>;
  private planar?: Set<number>;

  override set(handle: number, entry: MaterialSnapshotCacheEntry): this {
    const previous = this.get(handle);
    const source = entry.snapshot.sourceAssets;
    if (source !== previous?.snapshot.sourceAssets) {
      if (source === undefined) {
        this.consumers?.delete(handle);
        this.review?.delete(handle);
      } else {
        this.consumers ??= new PublishedAssetConsumers();
        this.consumers.set(
          handle,
          source.assets.map((row) => row.handle),
        );
        // A staged or received snapshot can predate this observer's cursor.
        this.review ??= new Set();
        this.review.add(handle);
      }
    }
    if (entry.retry !== undefined) {
      this.retries ??= new Set();
      this.retries.add(handle);
    } else this.retries?.delete(handle);
    if (entry.planarRouted !== undefined) {
      this.planar ??= new Set();
      this.planar.add(handle);
    } else this.planar?.delete(handle);
    return super.set(handle, entry);
  }

  override delete(handle: number): boolean {
    if (!super.delete(handle)) return false;
    this.consumers?.delete(handle);
    this.review?.delete(handle);
    this.retries?.delete(handle);
    this.planar?.delete(handle);
    return true;
  }

  override clear(): void {
    super.clear();
    this.consumers?.clear();
    this.review?.clear();
    this.retries?.clear();
    this.planar?.clear();
  }

  /** A different World cannot vouch for the previous observer's already-read versions. */
  resetSourceObserver(): void {
    if (this.review !== undefined)
      for (const [handle, entry] of this)
        if (entry.snapshot.sourceAssets !== undefined) this.review.add(handle);
  }

  collectSourceChanges(
    scope: RenderResourceScope,
    changes: readonly { readonly handle: number }[],
    into: Set<number>,
    retry: 'all' | 'source',
  ): void {
    const review = this.review;
    if (review !== undefined && this.consumers !== undefined) {
      for (const change of changes) this.consumers.collect(change.handle, review);
      for (const handle of review) {
        const source = this.get(handle)?.snapshot.sourceAssets;
        if (source !== undefined && !materialSourceMatchesCurrent(scope, source)) into.add(handle);
        else review.delete(handle);
      }
    }
    if (this.retries !== undefined)
      for (const handle of this.retries)
        if (retry === 'all' || this.get(handle)?.snapshot.sourceAssets !== undefined)
          into.add(handle);
  }

  /** A demand flip republishes shared receivers, including those already sampled by changed rows. */
  collectPlanarReceivers(into: Set<number>): void {
    if (this.planar !== undefined) for (const handle of this.planar) into.add(handle);
  }
}
