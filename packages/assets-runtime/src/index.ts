export type { TextureRegion } from './runtime-texture';
// Runtime assets: one owner for identity, content, revisions and lifetime.

// ─── Mesh binary container decode ───────────────────────────────────────────
export {
  MeshBinAssetError,
  type UnpackedMeshBin,
  unpackMeshBin,
} from '@forgeax/engine-geometry';
export type {
  AnimationClip,
  AnimationGraph,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  MaterialAsset,
  PackageFetcher,
  PackageResponse,
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
export { defineAssetKind } from './asset-kind.js';
// ─── AssetRegistry + Asset / MeshAsset type aliases ─────────────────────────
export type {
  Asset,
  AssetRegistryOptions,
  AssetReloadOptions,
  CatalogReconcileError,
  CatalogReconcileResult,
  MeshAsset,
  RuntimeAssetError,
} from './asset-registry.js';
export { AssetRegistry } from './asset-registry.js';
export { captureAssetPublication } from './capture-publication.js';
export {
  type CatalogHotChannel,
  type CatalogListener,
  type CatalogSource,
  createCatalogHotSubscription,
  createCatalogSource,
} from './catalog-source.js';
// ─── Runtime image byte decoder (tweak-20260714 M1) ──────────────────────────
export { decodeImageBytes } from './decode-image-bytes.js';
// ─── Dynamic per-frame texture store ────────────────────────────────────────
export {
  adaptDynamicTextureDevice,
  type DynamicTextureDevice,
  DynamicTextureStore,
} from './dynamic-texture-store.js';
// ─── Asset cluster error model (closed union + classes) ─────────────────────
export type {
  AssetRuntimeError,
  AssetRuntimeErrorCode,
  MaterialResolvedEmptyPassesDetail,
  SceneCollectAssetGuidUnresolvedDetail,
  SceneCollectEntityRefOutOfClosureDetail,
} from './errors/asset.js';
export {
  MaterialResolvedEmptyPassesError,
  MeshSsboCapacityExceededError,
  MeshSsboCeilingReachedError,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from './errors/asset.js';
export type { AssetLimits } from './internal/asset-records.js';
// ─── Loader-injection surface ───────────────────────────────────────────────
export { iesProfileContribution } from './loaders/ies-profile';
export { terrainContribution } from './loaders/terrain';
export { MaterialGenerationCache } from './material/generation-cache.js';
export {
  inspectMaterialRuntime,
  type MaterialRuntimeFailureInfo,
  type MaterialRuntimeInfo,
  type MaterialRuntimeInput,
  type MaterialRuntimeInspection,
  type MaterialRuntimeLastKnownGoodInfo,
  type MaterialRuntimeLastKnownGoodInput,
  type MaterialRuntimePendingInfo,
  type MaterialRuntimePendingInput,
  type MaterialRuntimeStandardInfo,
} from './material/inspection.js';
export {
  createMaterialLoader,
  type MaterialLoadError,
  type MaterialLoadErrorCode,
  type MaterialLoadErrorDetail,
  type MaterialLoaderOptions,
  type MaterialLoadRequest,
  type MaterialPublication,
  type MaterialReady,
} from './material/loader.js';
export {
  assertMaterialStaticSelection,
  findMaterialPassProgram,
  installMaterialReadyShaders,
  type MaterialRenderPassProjection,
  type MaterialRenderProjection,
  materialParametersToParamSchema,
  projectMaterialRecord,
  runtimeMaterialShaderId,
  sameMaterialContext,
  selectMaterialPassProgram,
} from './material/runtime-shader.js';
// ─── Mipmap generation helpers ──────────────────────────────────────────────
export {
  blitMipmapsSync,
  encodeMipmapLevel,
  encodeMipmaps,
  getOrCreateMipmapPipeline,
  type MipmapEncoderWork,
  type MipmapShaderModuleFactory,
  type MipmapTextureDescriptor,
  mipmapCacheSize,
  prepareMipmaps,
} from './mipmap-generator.js';
// ─── Register-time payload validation ───────────────────────────────────────
export { type TilesetValidateOptions, validateTilesetPayload } from './payload-validate.js';
export { assetDecoderPlugin, assetsPlugin } from './plugin.js';
export {
  createRuntimeAssetEvidenceAdapter,
  type RuntimeEvidenceSource,
} from './registry/asset-evidence.js';
export { CatalogReplica, type CatalogReplicaSnapshot } from './registry/catalog-state.js';
// ─── Scene instantiate collaboration contract types (D-1 injected hook) ─────
export {
  buildSceneChildContext,
  type PostSpawnHook,
  type SceneInstantiateError,
  type SkinJointResolver,
  scenePublicationFenceFromRegistry,
} from './registry/instantiate.js';
export {
  compareScenePublicationFences,
  createScenePublicationFence,
  observeScenePublication,
  parseScenePublicationFence,
  SCENE_PUBLICATION_FENCE_SCHEMA,
  SCENE_PUBLICATION_RECOVERY_ACTIONS,
  type ScenePublicationFence,
  type ScenePublicationFenceError,
  type ScenePublicationFencePhase,
  type ScenePublicationObservation,
  scenePublicationFenceFromCatalog,
} from './registry/scene-publication-fence.js';
export { retainAssetPublications } from './retain-publication.js';
export type { MeshRange } from './runtime-mesh';
export type { TerrainHeightRange } from './runtime-terrain';
// Public scene-pack boundary: editor/play hosts reuse the engine's canonical
// structural SceneAsset reconstruction; component references bind at instantiate.
export { parseScenePayload } from './scene-payload.js';
export { validateAssetPublication } from './validate-publication.js';
