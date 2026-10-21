export function gradientValue(position: number, stops: number): number;

export function createDarkGradientTexture(): import('@forgeax/engine-types').TextureAsset;

export function darkGradientQuad(): {
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
};
