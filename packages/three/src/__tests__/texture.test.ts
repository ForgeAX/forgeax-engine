import {
  CompressedTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  RedFormat,
  RGBA_S3TC_DXT5_Format,
  RGBAFormat,
  RGFormat,
  UnsignedByteType,
  Vector2,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import {
  projectSampler,
  projectTexture,
  projectTextureUpload,
  textureCoordinates,
  validateTexture,
} from '../texture';

it('preserves r184 UV matrices through native TRS without modifying image or version', () => {
  const texture = new DataTexture(new Uint8Array([20, 40, 80, 255]), 1, 1);
  const image = texture.image;
  for (const [sx, sy, angle] of [
    [2, 3, 0],
    [2, 2, 0.7],
    [-2, 2, 0.7],
    [2, 3, Math.PI / 2],
    [0, 3, 0],
    [2, 0, 0],
    [0, 0, 0.7],
  ] as const) {
    texture.offset.set(0.15, -0.2);
    texture.center.set(0.3, 0.7);
    texture.repeat.set(sx, sy);
    texture.rotation = angle;
    texture.matrixAutoUpdate = true;
    texture.channel = 2;
    const coordinates = textureCoordinates(texture).unwrap();
    expect(coordinates.set).toBe(2);
    const transform = coordinates.transform;
    const [x, y] = transform.offset,
      [scaleX, scaleY] = transform.scale;
    const cosine = Math.cos(transform.rotation),
      sine = Math.sin(transform.rotation);
    for (const [u, v] of [
      [0, 0],
      [1, 1],
      [-0.5, 0.8],
      [0.2, 0.3],
    ] as const) {
      const reference = new Vector2(u, v).applyMatrix3(texture.matrix);
      expect(x + cosine * scaleX * u - sine * scaleY * v).toBeCloseTo(reference.x, 10);
      expect(y + sine * scaleX * u + cosine * scaleY * v).toBeCloseTo(reference.y, 10);
    }
    texture.matrixAutoUpdate = false;
    texture.offset.set(99, 99);
    expect(textureCoordinates(texture).unwrap()).toEqual(coordinates);
    expect(texture.image).toBe(image);
    expect(texture.version).toBe(0);
  }
});

it('rejects unrepresentable UV shear, projective matrices and nonfinite values', () => {
  const texture = new DataTexture(new Uint8Array(4), 1, 1);
  texture.repeat.set(2, 3);
  texture.rotation = 0.4;
  expect(() => textureCoordinates(texture).unwrap()).toThrow('native affine support for shear');
  texture.matrixAutoUpdate = false;
  texture.matrix.set(1, 0.2, 0, 0, 1, 0, 0, 0, 1);
  expect(() => textureCoordinates(texture).unwrap()).toThrow('native affine support for shear');
  texture.matrix.set(1, 0, 0, 0, 1, 0, 0.1, 0, 1);
  expect(() => textureCoordinates(texture).unwrap()).toThrow('requires affine coordinates');
  texture.matrix.identity().elements[0] = NaN;
  expect(() => textureCoordinates(texture).unwrap()).toThrow('three-invalid-value');
});

it('preserves channel count, half-float bits and source byte offsets', () => {
  for (const [format, channels, prefix] of [
    [RedFormat, 1, 'r'],
    [RGFormat, 2, 'rg'],
    [RGBAFormat, 4, 'rgba'],
  ] as const) {
    for (const type of [UnsignedByteType, HalfFloatType]) {
      const storage = type === HalfFloatType ? new Uint16Array(20) : new Uint8Array(20);
      storage.fill(type === HalfFloatType ? 0x3800 : 128);
      const source = storage.subarray(2, 2 + channels * 2);
      const texture = new DataTexture(source, 2, 1, format, type);
      const asset = projectTexture(texture).unwrap();
      expect(asset.format).toBe(`${prefix}${type === HalfFloatType ? '16float' : '8unorm'}`);
      expect(asset.data).toEqual(
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
      );
      expect(asset.data.buffer).not.toBe(source.buffer);
    }
  }
});

it('uses WebGPU tight rows regardless of unpackAlignment and leaves source bytes intact', () => {
  const source = new Uint8Array([10, 20, 30, 99, 40, 50, 60]);
  const texture = new DataTexture(source, 3, 2, RedFormat);
  texture.unpackAlignment = 4;
  texture.flipY = true;
  expect([...projectTexture(texture).unwrap().data]).toEqual([99, 40, 50, 10, 20, 30]);
  expect([...source]).toEqual([10, 20, 30, 99, 40, 50, 60]);
  texture.image.data = source.subarray(0, 5);
  expect(() => projectTexture(texture).unwrap()).toThrow('DataTexture byte length');
});

it('packs authored mip levels from their own base extent and enables mip sampling', () => {
  const texture = new DataTexture();
  texture.mipmaps = [
    { width: 4, height: 2, data: new Uint8Array(32).fill(40) },
    { width: 2, height: 1, data: new Uint8Array(8).fill(80) },
    { width: 1, height: 1, data: new Uint8Array(4).fill(120) },
  ];
  texture.minFilter = NearestMipmapNearestFilter;
  const asset = projectTexture(texture).unwrap();
  expect(asset.shape).toEqual({ viewDimension: '2d', extent: { width: 4, height: 2 } });
  expect(asset.mips).toEqual({ kind: 'packed', levelCount: 3 });
  expect([...asset.data]).toEqual([
    ...new Array(32).fill(40),
    ...new Array(8).fill(80),
    ...new Array(4).fill(120),
  ]);
  expect(projectSampler(texture).unwrap().lodMaxClamp).not.toBe(0);
  texture.minFilter = NearestFilter;
  expect(projectSampler(texture).unwrap().lodMaxClamp).toBeUndefined();
  texture.mipmaps[1] = { width: 1, height: 2, data: new Uint8Array(8) };
  expect(() => projectTexture(texture).unwrap()).toThrow('Texture mip extent');
});

it('rejects extra mip levels, wrong typed storage and unsupported texture channels', () => {
  const texture = new DataTexture(new Uint8Array(4), 1, 1);
  const level = { width: 1, height: 1, data: new Uint8Array(4) };
  texture.mipmaps = [level, level];
  expect(() => projectTexture(texture).unwrap()).toThrow('Texture mip count');
  texture.mipmaps = [];
  texture.type = HalfFloatType;
  expect(() => projectTexture(texture).unwrap()).toThrow('DataTexture storage');
  texture.type = UnsignedByteType;
  for (const channel of [0, 1, 2, 3]) {
    texture.channel = channel;
    expect(validateTexture(texture).ok).toBe(true);
  }
  texture.channel = 4;
  expect(() => validateTexture(texture).unwrap()).toThrow('Texture.channel');
});

it('maps trilinear anisotropy and preserves upstream inactive filter cases', () => {
  const texture = new DataTexture(new Uint8Array(4), 1, 1);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  expect(projectSampler(texture).unwrap()).toMatchObject({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    maxAnisotropy: 8,
  });
  texture.anisotropy = 64;
  expect(() => projectSampler(texture).unwrap()).toThrow('maximum 16');
  texture.magFilter = NearestFilter;
  expect(projectSampler(texture).unwrap().maxAnisotropy ?? 1).toBe(1);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.anisotropy = 8;
  expect(projectSampler(texture).unwrap().maxAnisotropy).toBe(8);
  texture.minFilter = NearestMipmapLinearFilter;
  expect(projectSampler(texture).unwrap()).toMatchObject({
    minFilter: 'nearest',
    mipmapFilter: 'nearest',
  });
  expect(projectSampler(texture).unwrap().maxAnisotropy ?? 1).toBe(1);
});

it('allocates dataReady=false images without publishing their CPU bytes', () => {
  const texture = new DataTexture(new Uint8Array(4 * 3 * 4).fill(255), 4, 3);
  texture.source.dataReady = false;
  texture.needsUpdate = true;
  const pending = projectTextureUpload(texture, undefined).unwrap();
  expect(pending.shape.extent).toEqual({ width: 4, height: 3 });
  expect(pending.data).toEqual(new Uint8Array(4 * 3 * 4));
  texture.source.dataReady = true;
  texture.needsUpdate = true;
  expect(projectTextureUpload(texture, pending).unwrap().data).toEqual(texture.image.data);
});

it('retains compressed storage and allocates a complete zero block while pending', () => {
  const texture = new CompressedTexture([], 4, 4, RGBA_S3TC_DXT5_Format);
  const pending = projectTextureUpload(texture, undefined).unwrap();
  expect(pending.format).toBe('bc3-rgba-unorm');
  expect(pending.shape.extent).toEqual({ width: 4, height: 4 });
  expect(pending.data).toEqual(new Uint8Array(16));
  texture.source.dataReady = false;
  texture.image = { width: 8, height: 4 };
  texture.needsUpdate = true;
  expect(projectTextureUpload(texture, undefined).unwrap().data).toEqual(new Uint8Array(32));
});
