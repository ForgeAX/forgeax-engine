import type { TextureFormatBlock } from '@forgeax/engine-types';

/** Buffer layout for one admitted texture slice copied by a command encoder. */
export function textureReadbackLayout(width: number, height: number, block: TextureFormatBlock) {
  const rowBytes = Math.ceil(width / block.blockWidth) * block.bytesPerBlock;
  const rowsPerImage = Math.ceil(height / block.blockHeight);
  const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
  return { rowBytes, rowsPerImage, bytesPerRow, byteLength: bytesPerRow * rowsPerImage };
}

/** Normalize the WebGPU sequence/dictionary origin union at a copy boundary. */
export function textureCopyOrigin(origin: GPUOrigin2D | GPUOrigin3D | undefined): {
  x: number;
  y: number;
  z: number;
} {
  if (origin === undefined) return { x: 0, y: 0, z: 0 };
  if (Symbol.iterator in Object(origin)) {
    const [x = 0, y = 0, z = 0] = origin as Iterable<number>;
    return { x, y, z };
  }
  const dict = origin as GPUOrigin3DDict;
  return { x: dict.x ?? 0, y: dict.y ?? 0, z: dict.z ?? 0 };
}
