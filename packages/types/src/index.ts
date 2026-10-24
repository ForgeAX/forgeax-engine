// Public @forgeax/engine-types barrel. Contract definitions live in focused
// owners; this file only wires the stable package surface.

/// <reference types="@webgpu/types" />

export type { AudioStreamManifest } from './asset.js';
export type { AssetHandle, AssetReferenceOwner } from './asset-handle.js';
export {
  type AssetPublicationInput,
  assetPublicationGeneration,
  assetPublicationOutputSetDigest,
  createAssetPublication,
} from './asset-publication.js';
export { encodeBase64 } from './base64.js';
export { canonicalJson } from './canonical-json.js';
export * from './core-contracts.js';
export { fnv1a32, fnv1aUtf16 } from './fnv1a.js';
export { internJson, isDeepFrozenJson } from './frozen-json.js';
export {
  addLoadPhases,
  addLoadWork,
  beginLoadSession,
  beginLoadWork,
  bindLoadProgressScope,
  DEFAULT_LOAD_PROGRESS_LABELS,
  describeLoadProgress,
  ENGINE_STARTUP_PHASES,
  endLoadSession,
  LOAD_PROGRESS_INTERVAL_MS,
  type LoadPhaseDefinition,
  type LoadPhaseProgress,
  type LoadPhaseState,
  type LoadProgressLabelInput,
  type LoadProgressLabels,
  type LoadProgressSnapshot,
  type LoadProgressView,
  type LoadWork,
  loadProgressScope,
  readLoadProgress,
  resolveLoadProgressLabels,
  subscribeLoadProgress,
} from './load-progress.js';
export {
  beginLoadTimeline,
  collectLoadTimeline,
  LOAD_TIMELINE_CAPACITY,
  type LoadTimelineDetailValue,
  type LoadTimelineInspection,
  type LoadTimelineKind,
  type LoadTimelineRealmSnapshot,
  type LoadTimelineRecord,
  type LoadTimelineSnapshot,
  loadTimelineNow,
  markLoadTimeline,
  recordLoadTimeline,
  snapshotLoadTimeline,
} from './load-timeline.js';
export * from './material-program-abi.js';
export { createMeshMaterialSlotTable, type MeshMaterialSlotSource } from './mesh-material-slots.js';
export type { NavigationBakeSettings, NavigationMeshAsset } from './navigation.js';
export type { PackageFetcher, PackageRequest, PackageResponse } from './package-fetch.js';
export * from './plugin-asset.js';
export * from './runtime-contracts.js';
export { sha256 } from './sha256.js';
export type {
  TerrainAsset,
  TerrainError,
  TerrainErrorCode,
  TerrainLayer,
  TerrainMaterialEncoding,
  TerrainSection,
  TerrainSource,
} from './terrain.js';
export type {
  UiGpuDataTexture,
  UiGpuFrame,
  UiGpuImage,
  UiGpuPass,
  UiGpuShaders,
  UiPaintSource,
} from './ui-paint.js';
export { WGSL_NUMERIC_LAYOUT } from './wgsl-numeric-layout.js';
