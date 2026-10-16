// @forgeax/engine-runtime - render package GPU buffer usage values.
//
// Keep the WebGPU bit values in one dependency-free owner because the render
// package also runs against the null and WebGL2-compatible RHI shims where the
// browser's GPUBufferUsage global is unavailable.

export const GPU_BUFFER_USAGE_VERTEX = 0x20;
export const GPU_BUFFER_USAGE_INDEX = 0x10;
export const GPU_BUFFER_USAGE_COPY_DST = 0x08;
export const GPU_BUFFER_USAGE_COPY_SRC = 0x04;
export const GPU_BUFFER_USAGE_UNIFORM = 0x40;
export const GPU_BUFFER_USAGE_STORAGE = 0x80;
export const GPU_BUFFER_USAGE_INDIRECT = 0x100;
export const GPU_BUFFER_USAGE_MAP_READ = 0x01;
export const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200;
