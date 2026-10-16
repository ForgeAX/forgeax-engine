export function gradientValue(position: number, stops: number): number;

export function createDarkGradientTexture(): {
  readonly kind: 'texture';
  readonly width: number;
  readonly height: number;
  readonly format: 'rgba8unorm';
  readonly data: Uint8Array;
  readonly colorSpace: 'linear';
  readonly mipmap: false;
};

export function darkGradientQuad(): {
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
};
