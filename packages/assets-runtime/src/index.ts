// @forgeax/engine-assets-runtime -- public API barrel.
//
// Tier 2.1 package extracted from @forgeax/engine-runtime
// (feat-20260705-runtime-tier2-decomposition M1). The asset registry, loader
// registry, GUID resolution, default-loader wiring, builtin handles, and the
// dynamic-texture / mipmap helpers live here; the runtime package injects the
// post-spawn hook + extra loaders (audio / video) at the createRenderer
// assembly point.
//
// w14 public surface: exports exactly the asset-cluster symbols that the
// runtime package (src + __tests__) consumes plus what the pre-w14 runtime
// barrel re-exported to external consumers. Downstream apps repoint to this
// package in w15 (the runtime barrel no longer re-exports any asset symbol).

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
  CatalogReconcileError,
  CatalogReconcileResult,
  MeshAsset,
} from './asset-registry.js';
export { AssetRegistry } from './asset-registry.js';
// ─── Process-static builtin payload registry + vertex-layout SSOT ───────────
export {
  BUILTIN_BASE,
  BUILTIN_CUBE,
  BUILTIN_CYLINDER,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
  BuiltinAssetRegistry,
} from './builtin-asset-registry.js';
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
// ─── Builtin mesh handles (re-exported by asset-registry from ./handles) ─────
export {
  builtinMeshGuid,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './handles.js';
// The five-action runtime registry is distinct from the legacy authoring
// AssetRegistry class above. Keep its resolver on the public package boundary
// so render/VFX hosts never reach through `/internal` to inspect loaded assets.
export {
  type AssetRegistry as RuntimeAssetRegistry,
  type AssetRegistryResolver,
  createAssetRegistry,
  getAssetRegistryResolver,
} from './internal/load-asset.js';
// ─── Loader-injection surface ───────────────────────────────────────────────
export { LoaderRegistry } from './loader-registry.js';
// ─── Default loader tables + individual loaders (pre-w14 consumer face) ──────
export {
  animationClipLoader,
  animationGraphLoader,
  audioLoader,
  INLINE_PACK_LOADERS,
  materialLoader,
  meshLoader,
  particleEffectLoader,
  renderPipelineLoader,
  sceneLoader,
  skeletonLoader,
  skinLoader,
  tilesetLoader,
} from './loaders/inline-pack.js';
export {
  equirectLoader,
  fontLoader,
  PACK_ARTIFACT_LOADERS,
  renderPipelineLoader as renderPipelineArtifactLoader,
  textureLoader,
  tilesetLoader as tilesetArtifactLoader,
} from './loaders/pack-artifact.js';
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
  getOrCreateMipmapPipeline,
  type MipmapEncoderWork,
  type MipmapShaderModuleFactory,
  mipmapCacheSize,
  prepareMipmaps,
} from './mipmap-generator.js';
// ─── Register-time payload validation ───────────────────────────────────────
export { type TilesetValidateOptions, validateTilesetPayload } from './payload-validate.js';
export { assetLoaderPlugin, assetsPlugin, packLoaderPlugin } from './plugin.js';
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
export { loadMaterialReadyByGuid, type MeshGeometrySource } from './registry/load-by-guid.js';
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
// ─── Handle-to-payload resolution ───────────────────────────────────────────
export {
  type AssetReader,
  type AssetReadSource,
  resolveAssetHandle,
  walkMaterialPassesOverSharedRefs,
} from './resolve-asset-handle.js';
export {
  type ResolvedTilesetRuntime,
  resolveTilesetRuntime,
  type TilesetAtlasLookup,
  type TilesetRuntimeError,
  type TilesetRuntimeErrorCode,
} from './resolve-tileset-runtime.js';
export { retainAssetPublications } from './retain-publication.js';
export {
  RuntimeMaterialValue,
  RuntimeMeshVertices,
  runtimeContentRevision,
} from './runtime-content';
// Public scene-pack boundary: editor/play hosts reuse the engine's canonical
// structural SceneAsset reconstruction; component references bind at instantiate.
export { parseScenePayload } from './scene-payload.js';
export { validateAssetPublication } from './validate-publication.js';
export { createDefaultLoaderRegistry, wireDefaultLoaders } from './wire-default-loaders.js';
