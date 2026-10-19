/// <reference types="@webgpu/types" />

import { textureFormatBlock } from '@forgeax/engine-types';

interface TextureReadbackDescriptor {
  readonly format: string;
  readonly dimension: string;
  readonly aspect?: GPUTextureAspect | undefined;
}

type TextureReadbackPlan =
  | {
      readonly supported: true;
      readonly format: string;
      readonly bytesPerTexel: number;
      readonly blockWidth: 1;
      readonly blockHeight: 1;
    }
  | {
      readonly supported: false;
      readonly format: string;
      readonly reason: string;
    };

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

export function getTextureReadbackPlan(descriptor: TextureReadbackDescriptor): TextureReadbackPlan {
  if (/^(bc|etc2|eac|astc)-/.test(descriptor.format)) {
    return {
      supported: false,
      format: descriptor.format,
      reason: 'compressed texture readback has no core decoder',
    };
  }
  const bytesPerTexel = textureBytesPerTexel(descriptor.format);
  if (bytesPerTexel === undefined) {
    return {
      supported: false,
      format: descriptor.format,
      reason: 'texture format is not in the v7 readback matrix',
    };
  }
  return {
    supported: true,
    format: descriptor.format,
    bytesPerTexel,
    blockWidth: 1,
    blockHeight: 1,
  };
}

export function textureBytesPerTexel(format: string): number | undefined {
  // Replay converts every depth/stencil plane to a four-byte sample.
  if (DEPTH_FORMATS.has(format)) return 4;
  return READBACK_COLOR_FORMATS.has(format)
    ? textureFormatBlock(format as GPUTextureFormat).bytesPerBlock
    : undefined;
}
