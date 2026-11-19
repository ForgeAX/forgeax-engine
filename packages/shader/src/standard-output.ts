/** Native Grade/Final uniforms; independent of the published 32-byte V1 tone ABI. */
export const STANDARD_OUTPUT_V2_PARAMS_LAYOUT = {
  byteSize: 160,
  exposureToneOffset: 0,
  whiteBalanceOffset: 16,
  fringeLutOffset: 64,
  bloomOffset: 80,
  vignetteOffset: 96,
  vignetteColorOffset: 112,
  finishOffset: 128,
  policyOffset: 144,
} as const;
