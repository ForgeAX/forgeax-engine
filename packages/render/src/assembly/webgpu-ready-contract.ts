import { VIEW_UNIFORM_BUFFER_SIZE } from '../record/view-ubo';

/** Generation-scoped buffer and attachment constants used by the ready builder. */
export const VIEW_UBO_BYTES = VIEW_UNIFORM_BUFFER_SIZE;
export const MIPMAP_PREWARM_FORMATS: readonly GPUTextureFormat[] = [
  'rgba8unorm-srgb',
  'rgba8unorm',
  'rgba16float',
];
// WebGPU requires every dynamic uniform-buffer binding offset to satisfy the
// device's minimum uniform-buffer offset alignment.  Keep one shared buffer
// per pass family, with the small POD payload at the start of each 256-byte
// slice so every level remains a single production path.
export const BLOOM_UNIFORM_PARAMS_STRIDE_BYTES = 256;
export const BLOOM_DOWNSAMPLE_PARAMS_BYTES = 5 * BLOOM_UNIFORM_PARAMS_STRIDE_BYTES;
export const BLOOM_UPSAMPLE_PARAMS_BYTES = 4 * BLOOM_UNIFORM_PARAMS_STRIDE_BYTES;
export const BLOOM_COMPOSITE_PARAMS_BYTES = 16;
export const HDR_COLOR_ATTACHMENT_FORMAT: GPUTextureFormat = 'rgba16float';
export const DEPTH_TEXTURE_FORMAT: GPUTextureFormat = 'depth32float-stencil8';
