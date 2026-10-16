// @forgeax/engine-import — build-time asset import runner + ImporterRegistry.
//
// The build-time half of the engine's import/load split (the runtime half is
// the LoaderRegistry in @forgeax/engine-runtime). An Importer turns an external
// source (.gltf / .png / .ttf) plus its *.meta.json GUID declarations into
// in-memory ImportedAsset[] PODs; the import runner enforces the GUID
// import-stable iron law and writes the DDC (.pack.json / .bin).
//
// This Node entry includes filesystem/DDC producers. Browser exports select
// browser.ts, which exposes the shared data kernel and opt-in runtime Pack
// production without filesystem, DDC or source compilers.
//
// The import contract (Importer / ImportContext / ImportedAsset / ImportError /
// ImportErrorCode / ImportTransport) lives in @forgeax/engine-types (the
// math-free SSOT) and is re-exported here so build tooling has a single
// import surface.

export type {
  AnimationClip,
  AnimationGraph,
  Asset,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  IesProfileAsset,
  MaterialAsset,
  MeshAsset,
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
export {
  type CookProduct,
  IMPORT_ERROR_HINTS,
  type ImportContext,
  ImportError,
  type ImportErrorCode,
  type ImportErrorDetail,
  type ImportedAsset,
  type Importer,
  type ImportSubAsset,
  type ImportTransport,
} from '@forgeax/engine-types';
export {
  type BuildProductionFailure,
  type BuildProductionFile,
  type BuildProductionOptions,
  type BuildProductionSink,
  produceBuildAssets,
} from './build-production.js';
export {
  type CatalogImporterDisposition,
  type CatalogImporterPolicy,
  catalogImporterPolicy,
  DEFAULT_CATALOG_IMPORTER_KEYS,
} from './catalog-importer-policy.js';
export { buildCatalogResult } from './catalog-inventory.js';
export {
  createMeshDistanceFieldCooker,
  type DistanceFieldCookInput,
  type DistanceFieldCookPayload,
} from './distance-field-cooker.js';
export {
  iesImporter,
  validateIesProfilePayload,
} from './ies/ies-importer.js';
export {
  type Lm63ParseError,
  type Lm63TypeC,
  parseLm63TypeC,
} from './ies/parse-lm63.js';
export { readFloat16LE, resampleTypeC } from './ies/resample-type-c.js';
export {
  createImportProduct,
  finalizeImportProducts,
  type ImportAssetProduct,
  type ImportProductContractError,
  type TerminalImportProduct,
} from './import-product.js';
export {
  type DdcPack,
  type ImportRunnerFs,
  normaliseForPack,
  type RunImportMeta,
  type RunImportOk,
  type RunImportProductResult,
  type RunImportResult,
  runImport,
  SHADER_RESERVED_IMPORTER_KEY,
} from './import-runner.js';
export { ImporterRegistry } from './importer-registry.js';
export {
  type LightmapUvError,
  type LightmapUvErrorCode,
  type LightmapUvErrorDetailByCode,
  type LightmapUvSet,
  type LightmapUvStorage,
  validateLightmapUvs,
} from './lightmap-uv.js';
export { projectMaterialPackTransport } from './material-pack-transport.js';
export {
  type MeshBinEncodeError,
  packMeshBin,
} from './mesh-bin.js';
export {
  createMeshCardCooker,
  type MeshCardCookInput,
  type MeshCardCookPayload,
} from './mesh-card-cooker';
export { cookMeshCollision } from './mesh-collision';
export {
  cookMeshDistanceFieldProduct,
  encodeMeshDistanceFieldProduct,
  type MeshDistanceFieldProduct,
} from './mesh-distance-field-product';
export {
  deriveDefaultLodScreenCoverages,
  type MeshLodBounds,
  type MeshLodContractError,
  type MeshLodContractInput,
  type MeshLodMaterialSlot,
  type MeshLodMetaEntry,
  type MeshLodRelation,
  type ReconciledMeshLodMeta,
  reconcileMeshLodMeta,
  validateMeshLodContract,
} from './mesh-lod.js';
export { projectImportProductForBuild } from './pack-projection.js';
export { pluginAssetOutputProducer, resolvePluginProgram } from './plugin-asset-producer.js';
export * from './runtime-pack.js';
export type { RuntimePackPinnedAsset, RuntimePackRecipe } from './runtime-pack-snapshot.js';
export {
  type AssetOutputInput,
  type AssetOutputPayload,
  type AssetOutputProducer,
  AssetOutputProducerRegistry,
  type AssetOutputProduct,
  type PackBuildProduct,
  type ScriptablePackAssetSnapshot,
  type ScriptablePackAssetSnapshotSource,
  type ScriptablePackDomainError,
  type ScriptablePackExternalEvidence,
  type ScriptablePackExternalUsage,
  type ScriptablePackSourceClosureEntry,
  type ScriptablePackStagedOutput,
} from './scriptable-pack.js';
export {
  buildScriptablePack,
  buildScriptablePackWorklist,
  type ScriptablePackBuildOptions,
  type ScriptablePackBuildProduct,
  type ScriptablePackBuildProductCache,
  type ScriptablePackBuildResult,
  type ScriptablePackBuildWorkItem,
  type ScriptablePackBuildWorklistOptions,
  type ScriptablePackBuildWorklistProduct,
} from './scriptable-pack-build.js';
export {
  createScriptablePackFileAssetSnapshotSource,
  type ScriptablePackFileAssetSnapshotError,
  type ScriptablePackFileAssetSnapshotSourceOptions,
} from './scriptable-pack-file-snapshot.js';
export {
  canonicalScriptableSourcePath,
  createDeclaredPackAssetSnapshotSource,
  createScriptablePackProduction,
  type DirectPackTransport,
  type DirectPackTransportInput,
  declaredPackExternalOutputs,
  type LegacyPackTransport,
  materializePreparedScriptablePack,
  type PreparedScriptablePack,
  prepareDirectPackTransport,
  prepareLegacyPackTransport,
  produceScriptablePackProducts,
  readCookedAuthoredPack,
  type ScriptablePackExternalImportOptions,
  type ScriptablePackInput,
  type ScriptablePackProductionOptions,
  type ScriptablePackPublicationFacts,
  type ScriptablePackTransportPaths,
  type ScriptablePackTransportSink,
} from './scriptable-pack-host.js';
export {
  createAssetOutputProducerRegistry,
  createPreExternalizedSceneAssetOutputProducer,
  createSceneAssetOutputProducer,
  materialAssetOutputProducer,
  meshAssetOutputProducer,
  textureAssetOutputProducer,
} from './scriptable-pack-output-producers.js';
export { createScriptablePackProductCache } from './scriptable-pack-product-cache.js';
export {
  createScriptablePackStagedAssetSnapshotSource,
  type ScriptablePackSnapshotError,
  type ScriptablePackStagedOwner,
  type ScriptablePackStagedSnapshotOptions,
} from './scriptable-pack-staged-snapshot.js';
export {
  finalizeSourcePackage,
  type ProducerReadiness,
  type ProducerReadinessError,
  type ProducerReadinessResult,
  parseProducerReadiness,
  produceSourcePackage,
  type SourcePackageClosureDetail,
  type SourcePackageClosureError,
  type SourcePackageProducerInput,
  type SourcePackageProducerResult,
  type SourcePackageProduct,
  sourcePackageAssetsByGuid,
} from './source-package.js';
export {
  containsSourcePackageError,
  normalizeSourcePackageError,
  type SourcePackageError,
  type SourcePackageErrorCode,
  type SourcePackageErrorContext,
  type SourcePackageErrorDetail,
  type SourcePackageErrorStage,
  sourcePackageError,
} from './source-package-errors.js';
export {
  commitImportPublication,
  discardImportPublication,
  type ImportPublicationArtifact,
  type ImportPublicationError,
  type ImportPublicationInput,
  type ImportPublicationResult,
  publishImportPublication,
  restoreImportPublication,
  type StagedImportPublication,
  type StagedImportPublicationResult,
  stageImportPublication,
} from './source-package-publication.js';
export {
  type CatalogSourceDeclaration,
  sourceDeclarationForCatalogPath,
} from './source-path.js';
export { createStandardAssetOutputProducerRegistry } from './standard-output-producers.js';
