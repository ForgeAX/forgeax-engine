import { drawReadyFrame } from '../test/ready-render-frame.mjs';

/** Bottom-up RGBA8 from the exact completed scene submission, independent of canvas retirement. */
export async function captureDisplayFrame(renderer, request) {
  const receipt = await drawReadyFrame(renderer, request, ['final-display']);
  const result = await renderer.observe(receipt, { include: ['final-display'] });
  if (!result.ok) throw result.error;
  const display = result.value.observations?.find((item) => item.domain === 'final-display');
  if (display === undefined) throw new Error('Parity capture requires final-display observation');
  const { width, height, bytesPerRow, format } = display.metadata;
  if (!['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb'].includes(format))
    throw new Error(`Parity capture requires an RGBA8 or BGRA8 display, received ${format}`);
  const pixels = new Uint8Array(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * rowBytes;
    pixels.set(display.bytes.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), row);
    if (format.startsWith('bgra')) {
      for (let x = row; x < row + rowBytes; x += 4) {
        const red = pixels[x];
        pixels[x] = pixels[x + 2];
        pixels[x + 2] = red;
      }
    }
  }
  return pixels;
}
