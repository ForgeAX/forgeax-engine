import { describe, expect, it } from 'vitest';
import * as halfFloat from '../f32-to-f16-bytes';

describe('halfFloat.f16ToF32', () => {
  it('round-trips every finite binary16 value and signed infinity through the encoder', () => {
    const values = Float32Array.from({ length: 65536 }, (_, bits) => halfFloat.f16ToF32(bits));
    const encoded = halfFloat.f32ToF16Bytes(new Uint8Array(values.buffer));
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    for (let bits = 0; bits < values.length; bits++) {
      if (Number.isNaN(values[bits])) {
        expect(bits & 0x7c00).toBe(0x7c00);
        expect(bits & 0x03ff).not.toBe(0);
      } else {
        expect(view.getUint16(bits * 2, true)).toBe(bits);
      }
    }
    expect(Object.is(halfFloat.f16ToF32(0x8000), -0)).toBe(true);
  });
});
