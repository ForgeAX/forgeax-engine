/** Numeric mode IDs consumed by the built-in tonemap WGSL module. */
export const TONEMAP_SHADER_MODE = {
  none: 0,
  reinhardExtended: 1,
  linear: 2,
  cineon: 3,
  acesFilmic: 4,
  agx: 5,
  neutral: 6,
  reinhard: 7,
} as const;

export type TonemapShaderMode = (typeof TONEMAP_SHADER_MODE)[keyof typeof TONEMAP_SHADER_MODE];

/**
 * Byte layout of the built-in `TonemapParams` uniform (tonemap.wgsl). The
 * extract provider packs exposure/whitePoint/mode, the Output Transform pass
 * writes dither and its graph-resolved destination extent, and the renderer
 * writes the output gamut at record time.
 */
export const TONEMAP_PARAMS_LAYOUT = {
  byteSize: 32,
  exposureOffset: 0,
  whitePointOffset: 4,
  modeOffset: 8,
  ditherOffset: 12,
  outputGamutOffset: 16,
  outputWidthOffset: 24,
  outputHeightOffset: 28,
} as const;
