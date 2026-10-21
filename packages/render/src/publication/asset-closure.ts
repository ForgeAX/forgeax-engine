import {
  type AssetChange,
  AssetClosure,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import type { Asset, AssetReferenceOwner } from '@forgeax/engine-types';
import { type PublishedAssetPatch, publishAssetPatch } from './asset-patch';

/** Publication encoding over the same dependency closure used by local rendering. */
export class PublishedAssetClosure {
  private readonly closure = new AssetClosure();

  get size(): number {
    return this.closure.size;
  }

  begin(owner: AssetReferenceOwner) {
    const records = runtimeAssets(owner);
    const transaction = this.closure.begin(owner);
    const patches = new Map<number, PublishedAssetPatch>();
    return {
      acquire: transaction.acquire,
      release: transaction.release,
      update: (handle: number, change?: AssetChange): void => {
        if (!transaction.update(handle)) return;
        const base = this.closure.version(handle);
        const patch =
          change === undefined || base === undefined
            ? undefined
            : publishAssetPatch(records.borrow<Asset>(handle).unwrap(), change, base);
        if (patch !== undefined) patches.set(handle, patch);
      },
      rows: (): readonly (readonly [number, Asset, number])[] =>
        [...transaction.changed]
          .filter((handle) => transaction.has(handle) && !patches.has(handle))
          .map((handle) => [
            handle,
            records.borrow<Asset>(handle).unwrap(),
            transaction.version(handle) ?? 0,
          ]),
      patches: (): readonly PublishedAssetPatch[] =>
        [...patches.values()].filter(({ handle }) => transaction.has(handle)),
      retired: transaction.retired,
      commit: transaction.commit,
    };
  }

  clear(): void {
    this.closure.clear();
  }
}
