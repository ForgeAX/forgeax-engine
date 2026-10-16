import type { AssetPublicationTuple } from './asset.js';

/** Canonical UUID text at serialized boundaries; AssetGuid remains a byte token. */
export type GuidString = string;

export type PluginConfigValue =
  | null
  | boolean
  | number
  | string
  | readonly PluginConfigValue[]
  | { readonly [key: string]: PluginConfigValue };

export interface PluginAsset {
  readonly kind: 'plugin';
  readonly program: string;
  readonly config?: PluginConfigValue;
}

export type PluginBuildTarget = 'host' | 'engine' | 'build' | 'frontend';

/** Captured with the payload, never reconstructed from a later Catalog read. */
export interface PluginAssetDefinition {
  readonly guid: GuidString;
  readonly asset: PluginAsset;
  readonly evidence:
    | { readonly kind: 'publication'; readonly publication: AssetPublicationTuple }
    | { readonly kind: 'source'; readonly revision: string; readonly digest: string };
}
