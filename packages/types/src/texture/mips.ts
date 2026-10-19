/** Full mip chain for an admitted extent; array layer counts never enter the calculation. */
export function numMipLevels(
  size: { readonly width: number; readonly height: number },
  depth = 1,
): number {
  return Math.floor(Math.log2(Math.max(1, size.width, size.height, depth))) + 1;
}

/** One mip axis, without signed 32-bit coercion or wrapped shift counts. */
export function mipDimension(size: number, level: number): number {
  return Math.max(1, Math.floor(size / 2 ** level));
}
