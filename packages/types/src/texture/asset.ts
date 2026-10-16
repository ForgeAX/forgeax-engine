/** Public sampled texture contract shared by producers and GPU consumers. */

export type TextureShape =
  | {
      readonly viewDimension: '2d';
      readonly extent: { readonly width: number; readonly height: number };
    }
  | {
      readonly viewDimension: '2d-array';
      readonly extent: { readonly width: number; readonly height: number; readonly layers: number };
    }
  | {
      readonly viewDimension: '3d';
      readonly extent: { readonly width: number; readonly height: number; readonly depth: number };
    };

export type TextureMipPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'generate' }
  | { readonly kind: 'packed'; readonly levelCount: number };

/** One logical texture identity; shape and mips are the only dimension facts. */
export interface TextureAsset {
  readonly kind: 'texture';
  readonly shape: TextureShape;
  readonly format: GPUTextureFormat;
  readonly data: Uint8Array;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mips: TextureMipPolicy;
}
