// Dual-mode DynamicTexture upload source contract:
// - Browser: HTMLCanvasElement | OffscreenCanvas | ImageBitmap | VideoFrame | Uint8Array
// - Node/native: Uint8Array pixel payload (RGBA8/format-matched)

export type BrowserDynamicImageSource =
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap
  | VideoFrame;

export type DynamicTextureUploadSource = Uint8Array | BrowserDynamicImageSource;

export function isByteDynamicSource(source: DynamicTextureUploadSource): source is Uint8Array {
  return source instanceof Uint8Array;
}

export interface DynamicTextureDesc {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormatCode;
  readonly mipmapped?: boolean;
  readonly label?: string;
}

export interface DynamicTextureStats {
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly viewGeneration: number;
  readonly inPlaceUpdates: number;
  readonly reallocations: number;
}

export const TEXTURE_FORMAT_RGBA8_UNORM = 1;
export const TEXTURE_FORMAT_RGBA8_UNORM_SRGB = 2;
export const TEXTURE_FORMAT_BGRA8_UNORM = 3;
export const TEXTURE_FORMAT_BGRA8_UNORM_SRGB = 4;
export const TEXTURE_FORMAT_RGBA16_FLOAT = 5;
export const TEXTURE_FORMAT_DEPTH32_FLOAT = 6;
export const TEXTURE_FORMAT_RG11B10_UFLOAT = 7;
export const TEXTURE_FORMAT_R8_UNORM = 8;
export const TEXTURE_FORMAT_RG8_UNORM = 9;
export const TEXTURE_FORMAT_R16_FLOAT = 10;
export const TEXTURE_FORMAT_RG16_FLOAT = 11;
export const TEXTURE_FORMAT_R32_FLOAT = 12;
export const TEXTURE_FORMAT_RGBA32_FLOAT = 13;
export const TEXTURE_FORMAT_DEPTH24_PLUS = 14;
export const TEXTURE_FORMAT_DEPTH24_PLUS_STENCIL8 = 15;
export const TEXTURE_FORMAT_RGB10A2_UNORM = 16;
export const TEXTURE_FORMAT_RG32_FLOAT = 17;

export type TextureFormatCode =
  | typeof TEXTURE_FORMAT_RGBA8_UNORM
  | typeof TEXTURE_FORMAT_RGBA8_UNORM_SRGB
  | typeof TEXTURE_FORMAT_BGRA8_UNORM
  | typeof TEXTURE_FORMAT_BGRA8_UNORM_SRGB
  | typeof TEXTURE_FORMAT_RGBA16_FLOAT
  | typeof TEXTURE_FORMAT_DEPTH32_FLOAT
  | typeof TEXTURE_FORMAT_RG11B10_UFLOAT
  | typeof TEXTURE_FORMAT_R8_UNORM
  | typeof TEXTURE_FORMAT_RG8_UNORM
  | typeof TEXTURE_FORMAT_R16_FLOAT
  | typeof TEXTURE_FORMAT_RG16_FLOAT
  | typeof TEXTURE_FORMAT_R32_FLOAT
  | typeof TEXTURE_FORMAT_RGBA32_FLOAT
  | typeof TEXTURE_FORMAT_DEPTH24_PLUS
  | typeof TEXTURE_FORMAT_DEPTH24_PLUS_STENCIL8
  | typeof TEXTURE_FORMAT_RGB10A2_UNORM
  | typeof TEXTURE_FORMAT_RG32_FLOAT;

const CODE_TO_GPU_FORMAT: Readonly<Record<number, GPUTextureFormat>> = {
  [TEXTURE_FORMAT_RGBA8_UNORM]: 'rgba8unorm',
  [TEXTURE_FORMAT_RGBA8_UNORM_SRGB]: 'rgba8unorm-srgb',
  [TEXTURE_FORMAT_BGRA8_UNORM]: 'bgra8unorm',
  [TEXTURE_FORMAT_BGRA8_UNORM_SRGB]: 'bgra8unorm-srgb',
  [TEXTURE_FORMAT_RGBA16_FLOAT]: 'rgba16float',
  [TEXTURE_FORMAT_DEPTH32_FLOAT]: 'depth32float',
  [TEXTURE_FORMAT_RG11B10_UFLOAT]: 'rg11b10ufloat',
  [TEXTURE_FORMAT_R8_UNORM]: 'r8unorm',
  [TEXTURE_FORMAT_RG8_UNORM]: 'rg8unorm',
  [TEXTURE_FORMAT_R16_FLOAT]: 'r16float',
  [TEXTURE_FORMAT_RG16_FLOAT]: 'rg16float',
  [TEXTURE_FORMAT_R32_FLOAT]: 'r32float',
  [TEXTURE_FORMAT_RGBA32_FLOAT]: 'rgba32float',
  [TEXTURE_FORMAT_DEPTH24_PLUS]: 'depth24plus',
  [TEXTURE_FORMAT_DEPTH24_PLUS_STENCIL8]: 'depth24plus-stencil8',
  [TEXTURE_FORMAT_RGB10A2_UNORM]: 'rgb10a2unorm',
  [TEXTURE_FORMAT_RG32_FLOAT]: 'rg32float',
};

const GPU_FORMAT_TO_CODE: Readonly<Partial<Record<GPUTextureFormat, TextureFormatCode>>> = {
  rgba8unorm: TEXTURE_FORMAT_RGBA8_UNORM,
  'rgba8unorm-srgb': TEXTURE_FORMAT_RGBA8_UNORM_SRGB,
  bgra8unorm: TEXTURE_FORMAT_BGRA8_UNORM,
  'bgra8unorm-srgb': TEXTURE_FORMAT_BGRA8_UNORM_SRGB,
  rgba16float: TEXTURE_FORMAT_RGBA16_FLOAT,
  depth32float: TEXTURE_FORMAT_DEPTH32_FLOAT,
  rg11b10ufloat: TEXTURE_FORMAT_RG11B10_UFLOAT,
  r8unorm: TEXTURE_FORMAT_R8_UNORM,
  rg8unorm: TEXTURE_FORMAT_RG8_UNORM,
  r16float: TEXTURE_FORMAT_R16_FLOAT,
  rg16float: TEXTURE_FORMAT_RG16_FLOAT,
  r32float: TEXTURE_FORMAT_R32_FLOAT,
  rgba32float: TEXTURE_FORMAT_RGBA32_FLOAT,
  depth24plus: TEXTURE_FORMAT_DEPTH24_PLUS,
  'depth24plus-stencil8': TEXTURE_FORMAT_DEPTH24_PLUS_STENCIL8,
  rgb10a2unorm: TEXTURE_FORMAT_RGB10A2_UNORM,
  rg32float: TEXTURE_FORMAT_RG32_FLOAT,
};

const FORMAT_BYTES_PER_PIXEL: Readonly<Partial<Record<GPUTextureFormat, number>>> = {
  r8unorm: 1,
  rg8unorm: 2,
  r16float: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rg11b10ufloat: 4,
  rgb10a2unorm: 4,
  rg16float: 4,
  r32float: 4,
  depth32float: 4,
  depth24plus: 4,
  'depth24plus-stencil8': 4,
  rgba16float: 8,
  rg32float: 8,
  rgba32float: 16,
};

export function textureFormatCodeToGPUTextureFormat(code: number): GPUTextureFormat {
  return CODE_TO_GPU_FORMAT[code] ?? 'rgba8unorm';
}

export function gpuTextureFormatToCode(format: GPUTextureFormat): TextureFormatCode {
  return GPU_FORMAT_TO_CODE[format] ?? TEXTURE_FORMAT_RGBA8_UNORM;
}

export function textureFormatBytesPerPixel(format: GPUTextureFormat): number {
  return FORMAT_BYTES_PER_PIXEL[format] ?? 4;
}

export function isDepthTextureFormat(format: GPUTextureFormat): boolean {
  return (
    format === 'depth32float' ||
    format === 'depth24plus' ||
    format === 'depth24plus-stencil8' ||
    format === 'depth16unorm' ||
    format === 'depth32float-stencil8'
  );
}
