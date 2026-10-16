/// <reference types="@webgpu/types" />

export interface TextureReadbackDescriptor {
  readonly format: string;
  readonly dimension: string;
  readonly aspect?: GPUTextureAspect | undefined;
}

export type TextureReadbackPlan =
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

const BYTES_PER_TEXEL: Readonly<Record<string, number>> = {
  r8unorm: 1,
  rg8unorm: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  r16float: 2,
  rg16float: 4,
  rgba16float: 8,
  r32float: 4,
  r32uint: 4,
  rg32uint: 8,
  rg32float: 8,
  rgba32float: 16,
  rgba32uint: 16,
  rgb10a2unorm: 4,
  rg11b10ufloat: 4,
};

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
  if (DEPTH_FORMATS.has(descriptor.format)) {
    return {
      supported: true,
      format: descriptor.format,
      bytesPerTexel: 4,
      blockWidth: 1,
      blockHeight: 1,
    };
  }
  const bytesPerTexel = BYTES_PER_TEXEL[descriptor.format];
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
  return BYTES_PER_TEXEL[format] ?? (DEPTH_FORMATS.has(format) ? 4 : undefined);
}
