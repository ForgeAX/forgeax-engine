// @forgeax/engine-runtime - render package shader-stage visibility values.
//
// Keep the WebGPU bit values in one dependency-free owner because render
// package layout builders also run against the null and WebGL2-compatible RHI
// shims where the browser's GPUShaderStage global is unavailable.

export const GPU_SHADER_STAGE_VERTEX = 0x1;
export const GPU_SHADER_STAGE_FRAGMENT = 0x2;
export const GPU_SHADER_STAGE_COMPUTE = 0x4;
