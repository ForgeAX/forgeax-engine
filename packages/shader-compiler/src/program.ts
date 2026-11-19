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
export { materialVertexInputs } from './material/cook.js';

export { prepareShaderProgramCompiler } from './program-template.js';
