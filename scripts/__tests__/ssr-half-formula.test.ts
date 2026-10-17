import { expect, it } from 'vitest';
import {
  decodeSsrNormalRoughness,
  decodeSsrReadback,
  decodeSsrReflectance,
  reflectionFormulaError,
  reflectionTexelCoordinate,
} from '../../apps/hello/ssr/scripts/inspect-ssr-tape.mjs';

it('decodes packed G-buffer pixels before selecting reflection mips', () => {
  // Actual bootstrap words from the failing 256x256 r32uint capture: +Z,
  // +Y floor and +X. The last word exercises the folded -Z/roughness-1 edge.
  const packed = new Uint32Array([0xe6800800, 0x14fff800, 0x59800fff, 0xffffffff]);
  const read = decodeSsrReadback({
    kind: 'texture',
    resourceId: 'normal',
    format: 'r32uint',
    width: 2,
    height: 2,
    bytes: new Uint8Array(packed.buffer),
  });
  expect(read.values).toEqual(Array.from(packed));
  const normal = decodeSsrNormalRoughness(read);
  expect(normal.values).toHaveLength(16);
  for (const [pixel, axis] of [
    [0, 2],
    [1, 1],
    [2, 0],
  ]) {
    for (let channel = 0; channel < 3; channel++) {
      expect(normal.values[pixel * 4 + channel] * 2 - 1).toBeCloseTo(channel === axis ? 1 : 0, 3);
    }
  }
  expect(normal.values.slice(12, 16)).toEqual([0.5, 0.5, 0, 1]);
  expect(normal.values[3]).toBe(230 / 255);
  expect(normal.values[7]).toBe(20 / 255);
  // The original packed word interpreted as f32 produced LOD 6.397e47.
  // Every actual decoded roughness addresses the captured eight-level chain.
  for (let pixel = 0; pixel < 4; pixel++) {
    const lod = normal.values[pixel * 4 + 3] ** 2 * 7;
    expect(lod).toBeGreaterThanOrEqual(0);
    expect(lod).toBeLessThanOrEqual(7);
  }
});

it('decodes packed albedo independently of normal bits and retains metallic', () => {
  const packed = new Uint32Array([0xff804000, 0x7f800000]);
  const material = decodeSsrReflectance(
    decodeSsrReadback({
      kind: 'texture',
      resourceId: 'albedo',
      format: 'r32uint',
      width: 2,
      height: 1,
      bytes: new Uint8Array(packed.buffer),
    }),
  );
  expect(material.values).toEqual([
    0,
    (64 / 255) ** 2,
    (128 / 255) ** 2,
    1,
    0,
    0,
    (128 / 255) ** 2,
    127 / 255,
  ]);
});

it('decodes the captured View channel mask as u32 while rejecting non-finite floats', () => {
  // Original work 29 bound 1280 bytes of buffer:3359, not its 66560-byte
  // allocation. WGSL View word 19 is lightingChannels: u32 = 0xffffffff.
  const allocation = new Uint8Array(66560);
  const bytes = allocation.subarray(1280, 2560);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  data.setUint32(76, 0xffffffff, true);
  data.setFloat32(176, 1, true);
  data.setFloat32(944, 0.25, true);
  const read = { kind: 'buffer', resourceId: 'buffer:3359', bytes };
  const decoded = decodeSsrReadback(read, [19]);
  expect(decoded.values).toHaveLength(320);
  expect(decoded.values[19]).toBe(0xffffffff);
  expect(decoded.values[44]).toBe(1);
  expect(decoded.values[236]).toBe(0.25);
  expect(() => decodeSsrReadback(read)).toThrow('non-finite buffer:3359');
  for (const mask of [0x7f800000, 0xff800000, 0x7fc00000]) {
    data.setUint32(76, mask, true);
    expect(decodeSsrReadback(read, [19]).values[19]).toBe(mask);
  }
  for (const offset of [0, 72, 80, 944, 1276]) {
    data.setFloat32(offset, Number.NaN, true);
    expect(() => decodeSsrReadback(read, [19])).toThrow('non-finite buffer:3359');
    data.setFloat32(offset, 0, true);
  }
});

it('retains finite checks for SSR floating-point texture readbacks', () => {
  for (const [format, bits] of [
    ['r32float', 0x7fc00000],
    ['rgba16float', 0x7e00],
  ] as const) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, bits, true);
    expect(() =>
      decodeSsrReadback({ kind: 'texture', resourceId: 'texture:1', format, bytes }, [0]),
    ).toThrow('non-finite texture:1');
  }
});

it('accounts for the captured HDR attachment conversion without hiding wrong composition', () => {
  // Object fixture, work 36, pixel (518,850), green channel. The unrounded
  // error is 0.03096, larger than the old 0.005 arithmetic tolerance.
  const expected = 46.93720761354871;
  expect(reflectionFormulaError(expected, 46.90625)).toBe(0);
  expect(reflectionFormulaError(expected, 46.9375)).toBe(0);
  expect(reflectionFormulaError(expected, 46.875)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(expected, 46.96875)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(1, 1.02)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(-expected, -46.90625)).toBe(0);
  expect(reflectionFormulaError(2 ** -25, 0)).toBe(0);
  expect(reflectionFormulaError(2 ** -25, 2 ** -24)).toBe(0);
  expect(reflectionFormulaError(0, 0)).toBe(0);
  expect(() => reflectionFormulaError(Number.NaN, 0)).toThrow();
});

it('accounts for f32 reciprocal UV evaluation before the FP16 output conversion', () => {
  // Recorded work 34, pixel (390,638). The diagnostic compute invocation
  // returns this coordinate and sum from the same captured input textures.
  expect(reflectionTexelCoordinate(390, 768, 384, true)).toBe(195.00001525878906);
  expect(reflectionTexelCoordinate(390, 768, 384, false)).toBe(195);
  const reference = 15.148440708157434;
  const gpuSum = 15.148287773132324;
  expect(reflectionFormulaError(reference, 15.140625)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(reference, 15.140625, gpuSum)).toBe(0);
  // The next unsupported FP16 value and an actual wrong reflection stay red.
  expect(reflectionFormulaError(reference, 15.1328125, gpuSum)).toBeGreaterThan(0.005);
  expect(reflectionFormulaError(reference, 15.171875, gpuSum)).toBeGreaterThan(0.005);
});
