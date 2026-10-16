// @forgeax/engine-pack/build
// Node-only catalog, source scanning, package finalization, and build evidence.

export type {
  AnimationClip,
  AnimationGraph,
  Asset,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  MaterialAsset,
  MeshAsset,
  PackV2,
  PackV2Error,
  ParticleEffectAsset,
  RenderPipelineAsset,
  SamplerAsset,
  SceneAsset,
  SkeletonAsset,
  SkinAsset,
  TextureAsset,
  TilesetAsset,
  VideoAsset,
} from '@forgeax/engine-types';
export type { ArtifactPathContext } from './artifact-path.js';
export { validateArtifactPath } from './artifact-path.js';
export {
  type AuthorPackClosure,
  type AuthorPackFile,
  assertAuthorPackUnchanged,
  authorFileDigest,
  collectAuthorPackClosure,
} from './author-closure.js';
export {
  buildCatalogProjection,
  type CatalogAuthority,
  type CatalogBuildError,
  type CatalogBuildErrorCode,
  type CatalogBuildProjectionOptions,
  type CatalogBuildResult,
  type CatalogImporterPolicy,
  type CatalogProducerVisibility,
  catalogSourcePathFor,
  metaPathForGuid,
} from './catalog-builder.js';
export { calculateCatalogDelta } from './catalog-delta.js';
export {
  type CatalogOutputDeclaration,
  type CatalogProducerMeta,
  type CookedPackageProjection,
  catalogProjectionFor,
  currentProjectionFor,
  findReservedAssetKindConflict,
  type PackageCatalogInput,
  projectCookedPackageEntry,
  projectExternalCatalogEntries,
  projectPackageCatalog,
  projectRuntimeCatalogRow,
  type RuntimeCatalogRowInput,
} from './catalog-projection.js';
export {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  type MaterialCookArtifact,
  type MaterialCookIdentityExpectation,
  type MaterialCookProgram,
  type MaterialCookProgramContext,
  type MaterialCookRasterContext,
  type MaterialCookRayContext,
  type MaterialCookReceipt,
  type MaterialCookRecordError,
  type MaterialCookRefs,
  projectCookedMaterialRecord,
  serializeCookedMaterialRecord,
  serializeMaterialCookReceipt,
  validateCookedMaterialRecord,
  validateMaterialCookReceipt,
} from './evidence/material-cook.js';
export { buildOfflineAssetEvidence, packageVerification } from './evidence/offline-evidence.js';
export {
  AssetGuid,
  isValidAssetGuidString,
  isValidPackSourceKey,
  PACK_SOURCE_KEY_RE,
  PackageId,
} from './guid.js';
export { projectAssetRefs, projectSceneEntityRefs } from './inventory/binding.js';
export {
  type AuthorInventory,
  type AuthorInventoryRow,
  type InventoryError,
  type InventoryErrorCode,
  validateAuthorInventory,
} from './inventory/declaration.js';
export { inventoryDigest, syncAuthorInventory } from './inventory/sync.js';
export {
  decodeMeshBinHeader,
  decodeMeshBinMorphs,
  MESH_BIN_DIGEST_BYTES,
  MESH_BIN_HEADER_BYTES,
  MESH_BIN_MORPH_CHANNELS,
  MESH_BIN_PROJECTION_VERSION,
  MESH_BIN_VERSION,
  type MeshBinContractError,
  type MeshBinHeader,
  type MeshBinHeaderResult,
  writeMeshBinHeader,
} from './mesh-bin-contract.js';
export * from './pack-authoring.js';
export {
  createFileSystemPackAuthoringGateway,
  createFileSystemPackAuthoringPort,
  type FileSystemPackAuthoringOptions,
  type PackAuthoringMaterializedAsset,
} from './pack-authoring-node.js';
export { listPackSources, type PackSourceIndexRow } from './pack-source-index.js';
export {
  type FinalizedPackageProduct,
  finalizePackageProduct,
  finalizePackageTransportSource,
  type PackageArtifactBody,
  type PackageFinalizePolicy,
  type PackageFinalizeResult,
  type PackageFinalizerError,
  type PackageProduct,
  type PackageProductAsset,
  packageTransportRevision,
} from './package-finalizer.js';
export { validateProducerContract, validateProducerOutputs } from './producer-contract.js';
export { resolveAssetSource } from './resolve-asset-source.js';
export { parsePackV2, validateMeta, validatePack, validatePackV2 } from './runtime.js';
export {
  bindRuntimePackScope,
  createRuntimePackPublication,
  type RuntimePackAssetInput,
  type RuntimePackEnvelope,
  type RuntimePackInput,
  type RuntimePackPublication,
  type RuntimePackPublicationInput,
  stripRuntimePackLifecycle,
} from './runtime-publication.js';
export {
  type InventoryDeclaration,
  type LegacyPackInventoryDocument,
  type PackInventoryAsset,
  type PackInventoryDocument,
  type ScanInventory,
  type ScanOptions,
  type ScanSourceDeclaration,
  type ScriptablePackInventoryDeclaration,
  type ScriptablePackScanOptions,
  STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
  scanInventory,
} from './scanner.js';
export {
  type AssetReader,
  isScriptablePackAssetKind,
  projectScriptablePackSceneComponents,
  SCRIPTABLE_PACK_ASSET_KINDS,
  type ScriptablePackAssetKind,
  type ScriptablePackReadError,
  type ScriptablePackSourceClosureEntry,
} from './scriptable-pack.js';
export { calculateTopologyDiff, diffTopology } from './topology.js';
