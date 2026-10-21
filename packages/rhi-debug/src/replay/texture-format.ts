/// <reference types="@webgpu/types" />

import { textureFormatBlock } from '@forgeax/engine-types';

const READBACK_COLOR_FORMATS = new Set<string>([
  'r8unorm',
  'rg8unorm',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'bgra8unorm',
  'bgra8unorm-srgb',
  'r16float',
  'rg16float',
  'rgba16float',
  'r32float',
  'r32uint',
  'rg32uint',
  'rg32float',
  'rgba32float',
  'rgba32uint',
  'rgb10a2unorm',
  'rg11b10ufloat',
] satisfies GPUTextureFormat[]);

const DEPTH_FORMATS = new Set([
  'depth16unorm',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float',
  'depth32float-stencil8',
]);

export function isDepthTextureFormat(format: string): boolean {
  return DEPTH_FORMATS.has(format);
}

export function isDepthStencilTextureFormat(format: string): boolean {
  return format.endsWith('-stencil8');
}

export function textureBytesPerTexel(format: string): number | undefined {
  // Replay converts every depth/stencil plane to a four-byte sample.
  if (DEPTH_FORMATS.has(format)) return 4;
  return READBACK_COLOR_FORMATS.has(format)
    ? textureFormatBlock(format as GPUTextureFormat).bytesPerBlock
    : undefined;
}
