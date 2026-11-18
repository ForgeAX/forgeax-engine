import { DataTexture, HalfFloatType, RedFormat } from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { expandScalarTexture } from '../scalar-texture';
import { projectTexture } from '../texture';

it('splats scalar bytes with role-correct alpha and no source mutation', () => {
  const bytes = new Uint8Array([99, 32, 128, 7]);
  const raw = projectTexture(new DataTexture(bytes.subarray(1, 3), 2, 1, RedFormat)).unwrap();
  const color = expandScalarTexture(raw, true),
    data = expandScalarTexture(raw, false);
  expect(color.format).toBe('rgba8unorm');
  expect([...color.data]).toEqual([32, 32, 32, 255, 128, 128, 128, 255]);
  expect([...data.data]).toEqual([32, 32, 32, 32, 128, 128, 128, 128]);
  expect([...bytes]).toEqual([99, 32, 128, 7]);
  expect(raw.format).toBe('r8unorm');
  expect(expandScalarTexture(color, true)).toBe(color);
});

it('retains half-float bits and packs every authored scalar mip independently', () => {
  const values = new Uint16Array([0x3800, 0x3400]);
  const half = projectTexture(new DataTexture(values, 2, 1, RedFormat, HalfFloatType)).unwrap();
  const projected = expandScalarTexture(half, true);
  expect(projected.format).toBe('rgba16float');
  expect([...new Uint16Array(projected.data.buffer)]).toEqual([
    0x3800, 0x3800, 0x3800, 0x3c00, 0x3400, 0x3400, 0x3400, 0x3c00,
  ]);
  const levelZero = new Uint8Array(4).fill(40);
  const texture = new DataTexture(levelZero, 2, 2, RedFormat);
  texture.mipmaps = [
    { width: 2, height: 2, data: levelZero },
    { width: 1, height: 1, data: new Uint8Array([70]) },
  ];
  const packed = expandScalarTexture(projectTexture(texture).unwrap(), false);
  expect([...packed.data]).toEqual([...new Array(16).fill(40), 70, 70, 70, 70]);
});
