/** Deterministically downscale tight-packed RGBA pixels with bilinear sampling. */
export function downscaleRgba(
  bytes: Uint8Array,
  width: number,
  height: number,
  maxDimension: number,
): { readonly bytes: Uint8Array; readonly width: number; readonly height: number } {
  if (width <= maxDimension && height <= maxDimension) {
    return { bytes, width, height };
  }

  const scale = maxDimension / Math.max(width, height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8Array(targetWidth * targetHeight * 4);
  const source = (x: number, y: number, channel: number): number =>
    bytes[(y * width + x) * 4 + channel] ?? 0;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = ((y + 0.5) * height) / targetHeight - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(height - 1, y0 + 1);
    const yWeight = Math.max(0, Math.min(1, sourceY - y0));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = ((x + 0.5) * width) / targetWidth - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(width - 1, x0 + 1);
      const xWeight = Math.max(0, Math.min(1, sourceX - x0));
      const outputOffset = (y * targetWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = source(x0, y0, channel) * (1 - xWeight) + source(x1, y0, channel) * xWeight;
        const bottom = source(x0, y1, channel) * (1 - xWeight) + source(x1, y1, channel) * xWeight;
        output[outputOffset + channel] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }

  return { bytes: output, width: targetWidth, height: targetHeight };
}
