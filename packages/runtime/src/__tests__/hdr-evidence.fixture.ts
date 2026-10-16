import { crc32, deflateSync } from 'node:zlib';

export function offscreenCanvas(width: number, height = width) {
  let texture: GPUTexture | undefined;
  return {
    canvas: {
      width,
      height,
      getContext: () => ({
        configure: (options: GPUCanvasConfiguration) => {
          texture?.destroy();
          texture = options.device.createTexture({
            size: [width, height],
            format: options.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          });
        },
        unconfigure: () => {},
        getCurrentTexture: () => texture,
      }),
    },
    destroy: () => texture?.destroy(),
  };
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
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    rows.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Reinhard + sRGB preview of a linear luminance image; `scale` exposes it. */
export function luminancePng(luminance: Float32Array, size: number, scale = 4): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = (luminance[i] ?? 0) * scale;
    const mapped = v / (1 + v);
    const srgb = mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * mapped ** (1 / 2.4) - 0.055;
    const byte = Math.round(Math.min(1, Math.max(0, srgb)) * 255);
    rgba.set([byte, byte, byte, 255], i * 4);
  }
  return encodeRgbaPng(rgba, size);
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
