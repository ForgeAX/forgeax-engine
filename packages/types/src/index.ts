// Public @forgeax/engine-types barrel. Contract definitions live in focused
// owners; this file only wires the stable package surface.

/// <reference types="@webgpu/types" />

export type { AudioStreamManifest } from './asset.js';
export * from './core-contracts.js';
export * from './material-program-abi.js';
export type { NavigationBakeSettings, NavigationMeshAsset } from './navigation.js';
export type { PackageFetcher, PackageRequest, PackageResponse } from './package-fetch.js';
export * from './plugin-asset.js';
export * from './runtime-contracts.js';
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
