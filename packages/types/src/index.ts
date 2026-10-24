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
export { isDeepFrozenJson } from './frozen-json.js';
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
