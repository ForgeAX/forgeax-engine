/** Radiance RGBE with new-style RLE scanlines; every pixel is `rgbe`. */
export function encodeHdr(
  width: number,
  height: number,
  rgbe: readonly [number, number, number, number],
): Uint8Array {
  const header = Array.from(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
    (ch) => ch.charCodeAt(0),
  );
  const body: number[] = [];
  for (let y = 0; y < height; y++) {
    body.push(2, 2, width >>> 8, width & 0xff);
    for (const channel of rgbe) body.push(128 + width, channel);
  }
  return new Uint8Array([...header, ...body]);
}
