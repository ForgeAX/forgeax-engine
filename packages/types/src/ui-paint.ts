/** Owned, immutable-after-publication UI raster preparation; no native handles. */
export interface UiGpuDataTexture {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface UiGpuImage extends UiGpuDataTexture {
  /** Identifies immutable decoded pixels while the source image is live. */
  readonly id: number;
}

export type UiGpuPass =
  | {
      readonly kind: 'strip';
      readonly target: number;
      readonly child: number | null;
      readonly image: number | null;
      readonly instances: Uint8Array;
    }
  | { readonly kind: 'clear'; readonly target: number; readonly instances: Uint8Array }
  | {
      readonly kind: 'blend';
      readonly even: number;
      readonly odd: number;
      readonly instances: Uint8Array;
    }
  | {
      readonly kind: 'copy' | 'filter';
      readonly target: number;
      readonly source: number;
      readonly instances: Uint8Array;
    };

/** Versioned sparse-strip scene, prepared without a GPU device or submission. */
export interface UiGpuFrame {
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  readonly layerWidth: number;
  readonly layerHeight: number;
  readonly layerPages: readonly [number, number];
  readonly scratch: boolean;
  readonly alphas: UiGpuDataTexture;
  readonly paints: UiGpuDataTexture;
  readonly gradients: UiGpuDataTexture;
  readonly filterData: UiGpuDataTexture;
  readonly images: readonly UiGpuImage[];
  readonly passes: readonly UiGpuPass[];
}

export type UiGpuShaders = Readonly<Record<UiGpuPass['kind'], string>>;

/** Paint transfers owned bytes; unchanged frames retain the last accepted image. */
export type UiPaintSource =
  | {
      readonly kind: 'rgba';
      readonly paint: (timeMs: number, width: number, height: number) => Uint8Array | null;
    }
  | {
      readonly kind: 'sparse-strips';
      readonly shaders: UiGpuShaders;
      readonly paint: (timeMs: number, width: number, height: number) => UiGpuFrame | null;
    };
