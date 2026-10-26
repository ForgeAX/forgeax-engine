export { AssetClosure } from './internal/asset-closure';
export { assetDataBytes, copyAssetData } from './internal/asset-data';
export type {
  AssetChange,
  AssetRange,
  AssetRevisionGuard,
  AssetSnapshot,
  AssetVersion,
  AssetVersionDelta,
} from './internal/asset-records.js';
export {
  type AssetReader,
  readMaterialContent,
} from './internal/resolve-asset.js';
export {
  runtimeAssetReference,
  runtimeAssetRegistry,
  runtimeAssetSource,
  runtimeAssets,
} from './internal/runtime-assets.js';

export { shareVerifiedArtifactBytes } from './internal/shared-immutable.js';
export { createMaterialLoader } from './material/loader.js';
