import type { AssetKind } from '@forgeax/engine-types';

/** Create the type witness shared by one custom decoder lease and its loads. */
export function defineAssetKind<P, K extends string = string>(kind: K): AssetKind<P, K> {
  return Object.freeze({ kind }) as AssetKind<P, K>;
}
