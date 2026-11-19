import {
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  FloatType,
  RGBA_PVRTC_4BPPV1_Format,
  RGBAFormat,
} from '@forgeax/engine/three';
import {
  EXRExporter,
  NO_COMPRESSION,
  PIZ_COMPRESSION,
  RLE_COMPRESSION,
  ZIP_COMPRESSION,
  ZIPS_COMPRESSION,
} from '@forgeax/engine/three/addons/exporters/EXRExporter.js';
import { EXRLoader } from '@forgeax/engine/three/addons/loaders/EXRLoader.js';
import { LUTImageLoader } from '@forgeax/engine/three/addons/loaders/LUTImageLoader.js';
import { MD2Loader } from '@forgeax/engine/three/addons/loaders/MD2Loader.js';
import { PVRLoader } from '@forgeax/engine/three/addons/loaders/PVRLoader.js';
import { TIFFLoader } from '@forgeax/engine/three/addons/loaders/TIFFLoader.js';
import {
  compressNormals,
  compressPositions,
  compressUvs,
} from '@forgeax/engine/three/addons/utils/GeometryCompressionUtils.js';
import { describe, expect, it, vi } from 'vitest';
import { md2Triangle, pvrTexture, tiffImage } from './portable-addons.fixture';

it('parses MD2 geometry, UVs, morph frames and animation clips in the original constructor family', () => {
  const geometry = new MD2Loader().parse(md2Triangle());
  expect(geometry).toBeInstanceOf(BufferGeometry);
  if (geometry === undefined) throw new Error('valid MD2 fixture was rejected');
  expect(Array.from(geometry.getAttribute('position').array)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  expect(Array.from(geometry.getAttribute('uv').array)).toEqual([0, 1, 1, 1, 0, 0]);
  expect(geometry.morphAttributes.position).toHaveLength(2);
  expect(geometry.morphAttributes.position?.[1]?.getY(0)).toBe(1);
  expect(geometry.animations[0]?.name).toBe('idle');
  geometry.dispose();
  const invalid = md2Triangle();
  new DataView(invalid).setInt32(0, 0, true);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(new MD2Loader().parse(invalid)).toBeUndefined();
  } finally {
    error.mockRestore();
  }
});

it('preserves PVRTC mip/face payloads and invalid-header behavior without claiming GPU PVRTC support', () => {
  for (const faces of [1, 6]) {
    const source = pvrTexture(faces),
      parsed = new PVRLoader().parse(source, true);
    if (parsed === undefined) throw new Error('valid PVR fixture was rejected');
    expect(parsed.format).toBe(RGBA_PVRTC_4BPPV1_Format);
    expect(parsed.isCubemap).toBe(faces === 6);
    expect(parsed.mipmaps).toHaveLength(faces * 2);
    expect(parsed.mipmaps[0]?.width).toBe(8);
    expect(parsed.mipmaps[1]?.width).toBe(4);
    expect(parsed.mipmaps[0]?.data.buffer).toBe(source);
  }
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(new PVRLoader().parse(new ArrayBuffer(52), true)).toBeUndefined();
  } finally {
    error.mockRestore();
  }
});

it('decodes a generated TIFF with exact RGBA pixels', () => {
  const parsed = new TIFFLoader().parse(tiffImage());
  expect([parsed.width, parsed.height, parsed.flipY]).toEqual([2, 1, true]);
  expect(Array.from(parsed.data ?? [])).toEqual([255, 0, 0, 255, 0, 128, 255, 255]);
});

it('creates an owned 3D LUT from explicit bytes and retains filter semantics', () => {
  const bytes = Uint8ClampedArray.from({ length: 32 }, (_, i) => i);
  const parsed = new LUTImageLoader().parse(bytes, 2);
  expect(parsed.size).toBe(2);
  expect(parsed.texture3D.image).toMatchObject({ width: 2, height: 2, depth: 2 });
  expect(Array.from(parsed.texture3D.image.data ?? [])).toEqual(Array.from(bytes));
  bytes[0] = 255;
  expect(parsed.texture3D.image.data?.[0]).toBe(0);
  expect(parsed.texture3D.generateMipmaps).toBe(false);
  parsed.texture3D.dispose();
});

describe('CPU DataTexture EXR round trips', () => {
  for (const compression of [
    NO_COMPRESSION,
    RLE_COMPRESSION,
    ZIPS_COMPRESSION,
    ZIP_COMPRESSION,
    PIZ_COMPRESSION,
  ]) {
    it(`retains HDR samples with compression ${compression}`, async () => {
      const values = Float32Array.from({ length: 16 * 16 * 4 }, (_, i) =>
        i % 4 === 3 ? 1 : (i % 32) / 4,
      );
      const texture = new DataTexture(values, 16, 16, RGBAFormat, FloatType);
      try {
        const result = await new EXRExporter().parse(texture, { compression });
        const bytes = Uint8Array.from(result).buffer;
        const parsed = new EXRLoader().setDataType(FloatType).parse(bytes);
        expect([parsed.width, parsed.height]).toEqual([16, 16]);
        expect(Array.from(parsed.data ?? [])).toEqual(Array.from(values));
      } finally {
        texture.dispose();
      }
    });
  }
});

it('compresses caller geometry only on explicit calls and leaves repeated packing stable', () => {
  const geometry = new BoxGeometry();
  try {
    compressNormals(geometry, 'OCT2Byte');
    expect(geometry.getAttribute('normal').itemSize).toBe(2);
    expect(geometry.getAttribute('normal').array).toBeInstanceOf(Int16Array);
    const packed = geometry.getAttribute('normal');
    compressNormals(geometry, 'OCT2Byte');
    expect(geometry.getAttribute('normal')).toBe(packed);
    compressPositions(geometry);
    expect(geometry.getAttribute('position').array).toBeInstanceOf(Uint16Array);
    compressUvs(geometry);
    expect(geometry.getAttribute('uv').array).toBeInstanceOf(Uint16Array);
  } finally {
    geometry.dispose();
  }
});
