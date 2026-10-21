// @forgeax/engine-shader-compiler — package entrypoint.

// === re-exports =====================================================================

export type { ParamSchemaEntry } from '@forgeax/engine-types';
export { type ResolvedMaterial, resolveMaterialAsset } from '@forgeax/engine-types';
export { checkBindGroupOverflow, compareMaterialBindings } from './compare-param-schema.js';
export {
  type CompileOptions,
  type CompileResult,
  compileShader,
} from './compile.js';
export { getShaderCompilerFingerprint } from './compiler-fingerprint.js';
export { projectShaderConditionals } from './conditionals.js';
export {
  compileFailed,
  err,
  initFailed,
  manifestMalformed,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
  ShaderError,
  type ShaderErrorCode,
  type ShaderErrorDetail,
  shaderNotFound,
} from './errors.js';
export {
  type ComposedMaterial,
  composeSurfaceSource,
  digestMaterialSourceClosure,
  type MaterialComposeCompiler,
  type MaterialComposedSource,
  type MaterialComposeRequest,
  type PreparedStandardSource,
  prepareStandardSource,
  type StandardSourcePreparationRequest,
  type SurfaceComposition,
  type SurfaceCompositionRequest,
  type SurfaceCompositionStage,
} from './material/compose.js';
export { composeMaterial } from './material/compose-material.js';
export {
  cookMaterialAsset,
  type GeneratedMaterialParameterProjection,
  generateParameterModule,
  type MaterialCookError,
  type MaterialCookedAsset,
  type MaterialCookedPass,
  type MaterialCookRequest,
  materialVertexInputs,
} from './material/cook.js';
export {
  generateMaterialDynamicInputAccessor,
  materialDynamicInputModuleId,
} from './material/dynamic-input.js';
export {
  type LoweredStandardContract,
  lowerStandardContract,
  lowerStandardPhysicalBindings,
  standardMaterialDefines,
} from './material/lower-standard-contract.js';
export {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  createMaterialNativeCooker,
  type MaterialCookArtifact,
  type MaterialCookCatalogEntry,
  type MaterialCookPublication,
  type MaterialCookReceipt,
  type MaterialCookRefs,
  type MaterialNativeCookerOptions,
  materialCookPublication,
} from './material/native-cooker.js';
export {
  collectMaterialSources,
  createMaterialPackCooker,
  listMaterialSourcePaths,
} from './material/pack-cooker.js';
export { parseMaterialParticleInputs } from './material/particle-inputs.js';
export {
  characterizeMaterialWgslProfile,
  MATERIAL_WGSL_PROFILE,
  MATERIAL_WGSL_PROFILE_CAPABILITIES,
  type MaterialProfileError,
  type MaterialWgslProfileCapability,
  type MaterialWgslProfileFeature,
  validateMaterialWgslSource,
} from './material/profile.js';
export {
  type MaterialProjection,
  type MaterialProjectionContext,
  type MaterialStaticSelection,
  projectMaterial,
} from './material/project.js';
export {
  type CookedRayMaterial,
  cookRayMaterial,
  type RayMaterialCookRequest,
} from './material/ray-material.js';
export { validateMaterialProgramBindings } from './material/resource-contract.js';
export { lowerSceneMaterialAddresses } from './material/scene-material-address.js';
export {
  buildMaterialSourceCatalog,
  MaterialSourceCatalog,
  type MaterialSourceCatalogInput,
  type MaterialSourceInput,
  type MaterialSourceRecord,
} from './material/source-catalog.js';
export {
  createMaterialSpecializationKey,
  type MaterialDefineValue,
  type MaterialSpecializationKey,
  type MaterialSpecializationKeyInput,
  type MaterialSpecializationPassInput,
} from './material/specialization-key.js';
export {
  SINGLE_LAYER_MEDIUM_SURFACE_ABI,
  SINGLE_LAYER_MEDIUM_SURFACE_MODULE,
  SURFACE_ABI,
  SURFACE_EXPORT,
  SURFACE_SLOT,
  type SurfaceContract,
  type SurfaceContractRequest,
  validateSingleLayerMediumSurfaceSource,
  validateSurfaceSource,
} from './material/surface-contract.js';
export { terrainProgramSource } from './material/terrain-program.js';
export {
  createMaterialVariantContext,
  lowerMaterialVariantContext,
  type MaterialBackend,
  type MaterialCapability,
  type MaterialGeometry,
  type MaterialInstrumentation,
  type MaterialPass,
  type MaterialPipeline,
  type MaterialVariantContext,
  type MaterialVariantContextError,
  type MaterialVariantContextInput,
} from './material/variant-context.js';
export { createShaderProgramCompiler } from './program-compiler.js';
export {
  compareDerivedMaterialInterface,
  type ParsedReflection,
  parseReflection,
} from './reflection.js';
