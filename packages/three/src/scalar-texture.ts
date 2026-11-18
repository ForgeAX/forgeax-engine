import { deriveTextureLayout, type TextureAsset, textureFormatBlock } from '@forgeax/engine-types';

const formats = {
  r8unorm: 'rgba8unorm',
  r16float: 'rgba16float',
  r32float: 'rgba32float',
} as const;

/** r187 scalar TextureNodes splat before vector use. Keep raw scalar slots compact. */
export function expandScalarTexture(asset: TextureAsset, color: boolean): TextureAsset {
  const format = formats[asset.format as keyof typeof formats];
  if (format === undefined) return asset; // An already admitted pending-upload variant.
  const source = deriveTextureLayout(asset).unwrap();
  const target = deriveTextureLayout({ ...asset, format }).unwrap();
  const data = new Uint8Array(target.byteLength);
  const width = textureFormatBlock(asset.format).bytesPerBlock;
  const one = new Uint8Array(width);
  if (width === 1) one[0] = 255;
  else if (width === 2) new DataView(one.buffer).setUint16(0, 0x3c00, true);
  else new DataView(one.buffer).setFloat32(0, 1, true);
  const levels = asset.mips.kind === 'packed' ? asset.mips.levelCount : 1;
  for (let index = 0; index < levels; index++) {
    const from = source.levels[index],
      to = target.levels[index];
    if (from === undefined || to === undefined) throw new Error('Missing admitted scalar mip');
    for (let pixel = 0; pixel < from.byteLength / width; pixel++) {
      const offset = to.byteOffset + pixel * 4 * width;
      const input = from.byteOffset + pixel * width;
      for (let byte = 0; byte < width; byte++) {
        const value = asset.data[input + byte] ?? 0;
        data[offset + byte] = value;
        data[offset + width + byte] = value;
        data[offset + 2 * width + byte] = value;
        data[offset + 3 * width + byte] = color ? (one[byte] ?? 0) : value;
      }
    }
  }
  return { ...asset, format, data };
}
