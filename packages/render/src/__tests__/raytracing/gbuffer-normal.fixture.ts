/** Fixture uploads use the complete Deferred layout; geometry identity stays oct-v1. */
export function gbufferNormalPixels(
  count: number,
  normal: readonly number[] = [0, 0, 1],
): Uint32Array {
  const length = Math.hypot(...normal);
  const xyz = normal.map((value) => Math.round(((value / length) * 0.5 + 0.5) * 1023));
  const packed = ((xyz[0] ?? 0) | ((xyz[1] ?? 0) << 10) | ((xyz[2] ?? 0) << 20) | 0x40000000) >>> 0;
  const pixels = new Uint32Array(count * 2);
  for (let i = 0; i < count; i++) pixels.set([packed, 255 << 8], i * 2);
  return pixels;
}
