// @forgeax/engine-runtime - render package texture usage values.
//
// Keep the WebGPU bit values in one dependency-free owner because render
// package descriptor and graph builders also run against null and WebGL2-
// compatible RHI shims where the browser's GPUTextureUsage global is absent.

export const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;
export const GPU_TEXTURE_USAGE_COPY_DST = 0x02;
export const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
export const GPU_TEXTURE_USAGE_STORAGE_BINDING = 0x08;
export const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
export const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING =
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING;
