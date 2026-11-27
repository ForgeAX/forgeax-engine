import { expect, it } from 'vitest';
import { packSampledField } from '../../raytracing/sdf-field-storage';

function dyadic(value: number): bigint {
  const word = new Uint32Array(new Float32Array([value]).buffer)[0] ?? 0,
    exponent = (word >>> 23) & 255,
    fraction = word & 0x7fffff;
  if (exponent === 255) throw Error('Finite f32 required');
  const magnitude = exponent
    ? BigInt(fraction | 0x800000) << BigInt(exponent - 1)
    : BigInt(fraction);
  return word >>> 31 ? -magnitude : magnitude;
}
it('bounds actual nearest SNORM magnitude with one exact rational code unit at float and sign boundaries', () => {
  let tested = 0;
  for (const band of [2 ** -126, 2 ** -40, 0.25, 1, 4, 2 ** 40, Math.fround(3.4028234e38)]) {
    const values = new Float32Array(64);
    for (let code = 0; code <= 32767; code += 257) {
      const center = Math.fround(((code + 0.5) / 32767) * band);
      for (const sign of [-1, 1]) {
        const value = Math.fround(sign * Math.min(center, band));
        values.fill(value);
        const packed = packSampledField(values, new Uint32Array([0]), band, 33);
        expect(packed).not.toBeNull();
        if (!packed) continue;
        const raw = (packed[1] ?? 0) & 65535,
          magnitude = BigInt(Math.min(raw, 65536 - raw)),
          source = dyadic(Math.abs(value)),
          error = magnitude * dyadic(band) - source * 32767n,
          absolute = error < 0n ? -error : error;
        expect(absolute).toBeLessThan(dyadic(band));
        tested++;
      }
    }
  }
  expect(tested).toBe(1792);
});
it('rejects unqualified encoder sources instead of manufacturing a certified zero', () => {
  const values = new Float32Array(64);
  for (const band of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(packSampledField(values, new Uint32Array([0]), band, 33)).toBeNull();
  expect(packSampledField(values, new Uint32Array([1]), 1, 33)).toBeNull();
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2]) {
    values[0] = bad;
    expect(packSampledField(values, new Uint32Array([0]), 1, 33)).toBeNull();
  }
});
