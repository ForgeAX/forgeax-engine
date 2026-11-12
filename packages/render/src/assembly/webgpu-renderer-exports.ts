export type { BundlerOptions } from './bundler-contract';
export type {
  LayoutKind,
  MaterialShaderBindingContract,
  MaterialShaderVertexInputContract,
} from './material-shader-policy';
export {
  allowsUnlitPreparedFallback,
  isSharedMaterialUserRegionCompatible,
  normalizeMaterialShaderVariantSet,
  requiresPreparedMaterialShader,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
  stripCloudShadowBindingsForLowLimit,
} from './material-shader-policy';
export {
  createMeshSsboGrowController,
  deriveStorageBufferCeiling,
  INITIAL_MESH_SSBO_SLOT_COUNT,
  requireMeshSsboBuffer,
} from './mesh-ssbo-grow';
export { exposeRenderer } from './renderer-facade';
export {
  selectGpuDrivenSceneIndexVariant,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectSkinPrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
} from './shader-prewarm-policy';
export { disposeObservationCaptureSet } from './webgpu-renderer-observation';
