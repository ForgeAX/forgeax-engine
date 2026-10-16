import type { Asset } from './index.js';
import type { SceneEntityAddress } from './scene-contracts.js';

/** Structured edge metadata carried in an asset envelope refs list. */
interface LegacyAssetRef {
  readonly guid: string;
  readonly sourceField?: {
    readonly componentName?: string;
    readonly fieldName: string;
    readonly arrayIndex?: number;
  };
  /** Stable keyed SceneAsset entity context for diagnostics and loading. */
  readonly sceneEntityKey?: string;
}

export type AssetRef<K extends string = never> = [K] extends [never]
  ? LegacyAssetRef
  : LegacyAssetRef & {
      readonly kind: K;
      readonly sourceKey: string;
    };

export interface SceneEntityRef {
  readonly sceneSourceKey: string;
  readonly address: SceneEntityAddress;
}

/** Self-contained asset envelope used from import through catalog loading. */
export interface AssetEnvelope<P = Asset> {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: P;
  readonly refs: readonly AssetRef[];
}
