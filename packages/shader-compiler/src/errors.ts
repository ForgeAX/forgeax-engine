// @forgeax/engine-shader-compiler/errors — one ShaderError surface for build-time callers.
//
// The ShaderError class and its runtime factories are owned by
// @forgeax/engine-shader; the build-time Naga factories (compileFailed /
// initFailed) by @forgeax/engine-naga; the closed code/detail unions by
// @forgeax/engine-types. This file only forwards them.

export {
  compileFailed,
  err,
  initFailed,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-naga';
export {
  manifestMalformed,
  ShaderError,
  type ShaderErrorCode,
  type ShaderErrorDetail,
  shaderNotFound,
} from '@forgeax/engine-shader';
