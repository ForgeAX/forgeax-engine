import { encodePng } from '@forgeax/engine-image/png';
import { linearChannelToSrgb } from '@forgeax/engine-types';

export function offscreenCanvas(width: number, height = width) {
  let texture: GPUTexture | undefined;
  let configuration: GPUCanvasConfiguration | undefined;
  const currentTexture = () => {
    if (
      configuration !== undefined &&
      (texture === undefined || texture.width !== canvas.width || texture.height !== canvas.height)
    ) {
      texture?.destroy();
      texture = configuration.device.createTexture({
        size: [canvas.width, canvas.height],
        format: configuration.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: [
          configuration.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb',
        ],
      });
    }
    return texture;
  };
  const canvas = {
    width,
    height,
    getContext: () => ({
      configure: (options: GPUCanvasConfiguration) => {
        texture?.destroy();
        texture = undefined;
        configuration = options;
        currentTexture();
      },
      unconfigure: () => {},
      getConfiguration: () => configuration ?? null,
      getCurrentTexture: currentTexture,
    }),
  };
  return { canvas, destroy: () => texture?.destroy() };
}

/** Nearest-neighbor `zoom` keeps the 128 px evidence legible in review. */
export function encodeRgbaPng(source: Uint8Array, sourceSize: number, zoom = 4): Buffer {
  const size = sourceSize * zoom;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const from = (Math.floor(y / zoom) * sourceSize + Math.floor(x / zoom)) * 4;
      rgba.set(source.subarray(from, from + 4), (y * size + x) * 4);
    }
  return Buffer.from(encodePng(size, size, rgba));
}

/** Reinhard + sRGB preview of a linear luminance image; `scale` exposes it. */
export function luminancePng(
  luminance: Float32Array,
  width: number,
  scale = 4,
  height = width,
): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = (luminance[i] ?? 0) * scale;
    const mapped = v / (1 + v);
    const srgb = linearChannelToSrgb(mapped);
    const byte = Math.round(Math.min(1, Math.max(0, srgb)) * 255);
    rgba.set([byte, byte, byte, 255], i * 4);
  }
  return width === height
    ? encodeRgbaPng(rgba, width)
    : Buffer.from(encodePng(width, height, rgba));
}

/** Red = darkened by the feature, blue = brightened (must stay empty). */
export function deltaPng(off: Float32Array, on: Float32Array, size: number): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const delta = (off[i] ?? 0) - (on[i] ?? 0);
    const base = Math.round(Math.min(1, (on[i] ?? 0) * 2) * 90);
    const heat = Math.round(Math.min(1, Math.abs(delta) * 8) * 255);
    rgba.set(
      delta > 0 ? [Math.max(base, heat), base, base, 255] : [base, base, Math.max(base, heat), 255],
      i * 4,
    );
  }
  return encodeRgbaPng(rgba, size);
}
