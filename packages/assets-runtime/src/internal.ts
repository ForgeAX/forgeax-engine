export { AssetClosure } from './internal/asset-closure';
export { assetDataBytes, copyAssetData } from './internal/asset-data';
export type {
  AssetAdoption,
  AssetAdoptionReader,
  AssetAdoptionStatus,
  AssetChange,
  AssetContentCapture,
  AssetContentCaptureStatus,
  AssetContentLease,
  AssetObserver,
  AssetRange,
  AssetRetirement,
  AssetRetirementStatus,
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
  type RetainedBytes,
  RetentionBudget,
  realmRetention,
  stepRetainedBytes,
  trimRetainedBytes,
} from './internal/retention-budget.js';
export {
  runtimeAssetReference,
  runtimeAssetRegistry,
  runtimeAssetSource,
  runtimeAssets,
} from './internal/runtime-assets.js';
export { createMaterialLoader } from './material/loader.js';
export {
  createSceneContentPublicationTask,
  type SceneContentPublicationGuard,
  type SceneContentPublicationTask,
} from './registry/scene-content-publication.js';
