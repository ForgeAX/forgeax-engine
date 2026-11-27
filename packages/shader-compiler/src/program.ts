/** Portable program compiler. Filesystem discovery and Pack production are separate tool APIs. */
export {
  type CompileOptions,
  type CompileResult,
  type PreparedShaderCompiler,
  prepareShaderCompiler,
} from './compile.js';

export {
  type EngineShaderSource,
  engineMaterialArtifactReceipt,
  engineMaterialParamSchema,
  engineShaderDefines,
  engineShaderSourceImports,
  type PreparedEngineShaderSource,
  prepareEngineShaderSource,
} from './engine-program.js';
export {
  compileMaterialSelection,
  type MaterialCookError,
  type MaterialCookedAsset,
  type MaterialCookRequest,
  materialVertexInputs,
  rebuildMaterialRasterProgram,
} from './material/cook.js';
export {
  type CookedRayMaterial,
  compileRayMaterialSelection,
  type RayMaterialCookRequest,
} from './material/ray-material.js';
export {
  MATERIAL_RASTER_SOURCES_PATH,
  type MaterialRasterSourcePublication,
  type MaterialRasterSourceSelection,
  type MaterialSourceProgramRequest,
  type MaterialSourcePublication,
  publishMaterialSourceModules,
  readMaterialSourceModules,
  rebuildMaterialSourcePrograms,
  selectMaterialRasterSources,
} from './material/source-publication.js';

export { prepareShaderProgramCompiler } from './program-template.js';
