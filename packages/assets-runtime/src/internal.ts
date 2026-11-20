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
  MeshPresentationInput,
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
export { completeSourceMaterialPayload, createMaterialLoader } from './material/loader.js';
export type { PrepareMaterialSourceProgram } from './material/runtime-shader.js';
export {
  createSceneContentPublicationTask,
  type SceneContentPublicationGuard,
  type SceneContentPublicationTask,
} from './registry/scene-content-publication.js';
