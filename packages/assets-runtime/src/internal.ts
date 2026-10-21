export { AssetClosure } from './internal/asset-closure';
export type {
  AssetChange,
  AssetRange,
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

export { createMaterialLoader } from './material/loader.js';
